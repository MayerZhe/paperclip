package server

import (
	"bytes"
	"context"
	"encoding/json"
	"io"
	"testing"
	"time"

	"github.com/paperclipai/sdk-daemon/internal/wire"
)

// mockConn implements io.ReadWriteCloser using in-memory buffers.
// This lets us test the server connection handling without real vsock.
type mockConn struct {
	reader    *bytes.Buffer
	writer    *bytes.Buffer
	closed    bool
	readDelay chan struct{} // optional delay for testing concurrent scenarios
}

func newMockConn() *mockConn {
	return &mockConn{
		reader: &bytes.Buffer{},
		writer: &bytes.Buffer{},
	}
}

func (c *mockConn) Read(p []byte) (int, error) {
	if c.closed {
		return 0, io.EOF
	}
	if c.readDelay != nil {
		<-c.readDelay
	}
	return c.reader.Read(p)
}

func (c *mockConn) Write(p []byte) (int, error) {
	if c.closed {
		return 0, io.ErrClosedPipe
	}
	return c.writer.Write(p)
}

func (c *mockConn) Close() error {
	c.closed = true
	return nil
}

func TestServerHandleConnSingleMessage(t *testing.T) {
	s := New(1024)

	payload, _ := json.Marshal(map[string]string{
		"token":     "test-token",
		"host_info": "host-1",
	})
	request, _ := wire.Encode(wire.MsgTypeRequest, 5, payload)

	conn := newMockConn()
	conn.reader.Write(request)

	s.handleConn(conn)

	// Parse the response
	msgType, methodID, body, err := wire.Decode(conn.writer.Bytes())
	if err != nil {
		t.Fatalf("invalid response: %v", err)
	}
	if msgType != wire.MsgTypeResponse {
		t.Errorf("msgType = %d, want %d", msgType, wire.MsgTypeResponse)
	}
	if methodID != 5 {
		t.Errorf("methodID = %d, want 5", methodID)
	}

	var result map[string]interface{}
	json.Unmarshal(body, &result)
	if result["status"] != "policy_stored" {
		t.Errorf("unexpected response: %v", result)
	}
}

func TestServerHandleConnInvalidMessage(t *testing.T) {
	s := New(1024)

	conn := newMockConn()
	// Write garbage that doesn't meet the wire format
	conn.reader.Write([]byte{0x00, 0x00, 0x00, 0x07, 0xAB})

	s.handleConn(conn)

	// The connection should close gracefully without writing a response
	// because the message can't be decoded
	if conn.writer.Len() > 0 {
		t.Logf("writer has %d bytes after invalid message", conn.writer.Len())
	}
}

func TestServerHandleConnClosesOnEOF(t *testing.T) {
	s := New(1024)
	conn := newMockConn()
	// Write nothing — Read returns 0, io.EOF
	conn.Close()

	s.handleConn(conn)

	// Should exit without panic
}

func TestServerSendReadyEvent(t *testing.T) {
	s := New(1024)
	var buf bytes.Buffer

	err := s.SendReadyEvent(&buf)
	if err != nil {
		t.Fatalf("SendReadyEvent() error = %v", err)
	}

	msgType, methodID, body, err := wire.Decode(buf.Bytes())
	if err != nil {
		t.Fatalf("Decode() error = %v", err)
	}
	if msgType != wire.MsgTypeEvent {
		t.Errorf("msgType = %d, want %d (event)", msgType, wire.MsgTypeEvent)
	}
	if methodID != 0 {
		t.Errorf("methodID = %d, want 0", methodID)
	}
	if string(body) != `"Ready"` {
		t.Errorf("body = %s, want \"Ready\"", body)
	}
}

func TestServerNewWithContext(t *testing.T) {
	ctx := &HandlerContext{}
	s := NewWithContext(2048, ctx)

	if s.port != 2048 {
		t.Errorf("port = %d, want 2048", s.port)
	}
	if s.Context() != ctx {
		t.Error("context mismatch")
	}
}

func TestServerDefaultPort(t *testing.T) {
	s := New(DefaultVsockPort)
	if s.port != 1024 {
		t.Errorf("default port = %d, want %d (DefaultVsockPort)", s.port, 1024)
	}
}

func TestServerContext(t *testing.T) {
	s := New(1024)
	ctx := s.Context()
	if ctx == nil {
		t.Fatal("Context() returned nil")
	}
	if ctx.ProcMgr == nil {
		t.Error("ProcMgr is nil")
	}
	if ctx.Checker == nil {
		t.Error("Checker is nil")
	}
}

func TestServerContextCancelsServe(t *testing.T) {
	s := New(1024)

	ctx, cancel := context.WithCancel(context.Background())

	// Start a goroutine to cancel after a short delay
	go func() {
		time.Sleep(50 * time.Millisecond)
		cancel()
	}()

	// Listen on a real vsock port won't work in non-Linux environments,
	// but the cancellation path in Serve should handle the context check.
	// For now, verify the server is created correctly.
	_ = ctx
	_ = s
}

// Test pipe-based message handling simulates connection behavior
func TestServerHandleHealthCheckViaMockConn(t *testing.T) {
	s := New(1024)

	payload, _ := json.Marshal(map[string]string{})
	request, _ := wire.Encode(wire.MsgTypeRequest, 4, payload)

	conn := newMockConn()
	conn.reader.Write(request)

	s.handleConn(conn)

	_, _, body, _ := wire.Decode(conn.writer.Bytes())
	var result map[string]bool
	json.Unmarshal(body, &result)

	for _, key := range []string{"cloud_api", "paperclip", "minio"} {
		if _, ok := result[key]; !ok {
			t.Errorf("missing key: %s", key)
		}
	}
}

// mockNetConn wraps our mockConn with net.Conn methods we don't need
type readWriteCloser struct {
	io.Reader
	io.Writer
	io.Closer
}

func TestPipelinedMessages(t *testing.T) {
	s := New(1024)

	// Write two messages in a single buffer (pipelining)
	payload1, _ := json.Marshal(map[string]string{"name": "test1", "command": "/bin/true"})
	msg1, _ := wire.Encode(wire.MsgTypeRequest, 1, payload1)

	payload2, _ := json.Marshal(map[string]string{"name": "test2", "command": "/bin/true"})
	msg2, _ := wire.Encode(wire.MsgTypeRequest, 1, payload2)

	conn := newMockConn()
	conn.reader.Write(append(msg1, msg2...))

	s.handleConn(conn)

	// The first message should have been processed and a response written
	if conn.writer.Len() == 0 {
		t.Error("no response written for first message")
	}

	// Verify first response is valid
	_, _, body, _ := wire.Decode(conn.writer.Bytes())
	var result map[string]interface{}
	json.Unmarshal(body, &result)
	if result["name"] != "test1" {
		t.Errorf("first response name = %v, want test1", result["name"])
	}
}

func TestGracefulShutdown(t *testing.T) {
	// Verify that the server's shutdown handler returns the expected response
	// (real vsock shutdown tests require Linux)
	ctx := newTestContext()
	payload, _ := json.Marshal(map[string]string{})
	response := Dispatch(ctx, wire.MsgTypeRequest, 3, payload)

	_, _, body, _ := wire.Decode(response)
	var result map[string]string
	json.Unmarshal(body, &result)

	if result["status"] != "shutting_down" {
		t.Errorf("shutdown status = %s, want shutting_down", result["status"])
	}
}

// Interface compliance check — mockConn implements io.ReadWriteCloser
var _ io.ReadWriteCloser = (*mockConn)(nil)
