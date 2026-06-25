package server

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"log"
	"net"

	"github.com/paperclipai/sdk-daemon/internal/health"
	"github.com/paperclipai/sdk-daemon/internal/process"
	"github.com/paperclipai/sdk-daemon/internal/wire"
)

const (
	// DefaultVsockPort is the vsock port the daemon connects to on the host (CID=2).
	DefaultVsockPort = 1024
)

// Server is the vsock RPC server.
type Server struct {
	port   uint32
	ctx    *HandlerContext
	ln     Listener
}

// Listener is the interface for accepting connections.
// On Linux, this is backed by a single vsock connection to CID=2.
type Listener interface {
	Accept() (io.ReadWriteCloser, error)
	Close() error
}

// New creates a new vsock RPC client with default dependencies.
// The client connects to the host (CID=2) on the given port.
func New(port uint32) *Server {
	return &Server{
		port: port,
		ctx: &HandlerContext{
			ProcMgr: process.NewManager(),
			Checker: &health.TCPChecker{
				Host:    "127.0.0.1",
				Timeout: 0, // will be set in Start
			},
		},
	}
}

// NewWithContext creates a server with a pre-configured handler context.
func NewWithContext(port uint32, ctx *HandlerContext) *Server {
	return &Server{
		port: port,
		ctx:  ctx,
	}
}

// SetListener sets a custom listener for the server (used for testing or
// for binding the real vsock connection prior to Serve).
func (s *Server) SetListener(ln Listener) {
	s.ln = ln
}

// Connection returns the underlying vsock connection for sending events
// (e.g., the Ready event) before or during Serve().
// Returns nil if the server hasn't connected yet (Connect() not called).
func (s *Server) Connection() io.Writer {
	if s.ln == nil {
		return nil
	}
	// Both vsockConnListener and test mocks can implement this via type assertion
	type connProvider interface {
		Connection() io.Writer
	}
	if cp, ok := s.ln.(connProvider); ok {
		return cp.Connection()
	}
	return nil
}

// Serve accepts connections in a loop. Blocks until ctx is cancelled or
// an irrecoverable error occurs.
// The caller must call Connect, SetListener, or Listen before Serve.
func (s *Server) Serve(ctx context.Context) error {
	if s.ln == nil {
		return fmt.Errorf("listener not set; call Connect or SetListener first")
	}

	for {
		select {
		case <-ctx.Done():
			return s.ln.Close()
		default:
		}

		conn, err := s.ln.Accept()
		if err != nil {
			select {
			case <-ctx.Done():
				return nil
			default:
				return fmt.Errorf("accept: %w", err)
			}
		}

		go s.handleConn(conn)
	}
}

// handleConn processes a single vsock client connection.
func (s *Server) handleConn(conn io.ReadWriteCloser) {
	defer conn.Close()

	buf := make([]byte, 65536)
	for {
		n, err := conn.Read(buf)
		if err != nil {
			if err != io.EOF {
				log.Printf("[vsock] read error: %v", err)
			}
			return
		}

		msgType, methodID, payload, remainder, err := wire.ReadMessage(buf[:n])
		if err != nil {
			log.Printf("[vsock] invalid message: %v", err)
			continue
		}

		response := Dispatch(s.ctx, msgType, methodID, payload)
		if _, err := conn.Write(response); err != nil {
			log.Printf("[vsock] write error: %v", err)
			return
		}

		// If there's remaining data in the buffer (pipelined messages),
		// copy it to the start of buf for the next iteration.
		if len(remainder) > 0 {
			copy(buf[:len(remainder)], remainder)
			// Continue reading to process the pipelined message
			continue
		}
	}
}

// SendReadyEvent sends a "Ready" event to the given writer.
// The guestIP is included so the host knows how to reach VM services.
func (s *Server) SendReadyEvent(conn io.Writer, guestIP string) error {
	payload, err := json.Marshal(map[string]string{
		"type": "Ready",
		"ip":   guestIP,
	})
	if err != nil {
		return fmt.Errorf("marshal ready event: %w", err)
	}
	data, err := wire.Encode(wire.MsgTypeEvent, 0, payload)
	if err != nil {
		return fmt.Errorf("encode ready event: %w", err)
	}
	_, err = conn.Write(data)
	return err
}

// DetectGuestIP returns the primary non-loopback IPv4 address of the guest.
func DetectGuestIP() string {
	addrs, err := net.InterfaceAddrs()
	if err != nil {
		return "127.0.0.1"
	}
	for _, addr := range addrs {
		if ipnet, ok := addr.(*net.IPNet); ok && !ipnet.IP.IsLoopback() && ipnet.IP.To4() != nil {
			return ipnet.IP.String()
		}
	}
	return "127.0.0.1"
}

// Context returns the handler context (for testing).
func (s *Server) Context() *HandlerContext {
	return s.ctx
}
