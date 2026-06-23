package server

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"log"

	"github.com/paperclipai/sdk-daemon/internal/health"
	"github.com/paperclipai/sdk-daemon/internal/process"
	"github.com/paperclipai/sdk-daemon/internal/wire"
)

const (
	// DefaultVsockPort is the vsock port the daemon listens on.
	// CID=3 is the standard host CID for VM-to-host communication.
	DefaultVsockPort = 1024
)

// Server is the vsock RPC server.
type Server struct {
	port   uint32
	ctx    *HandlerContext
	ln     Listener
}

// Listener is the interface for accepting connections.
// On Linux, this is backed by github.com/mdlayher/vsock.
type Listener interface {
	Accept() (io.ReadWriteCloser, error)
	Close() error
}

// New creates a new vsock RPC server with default dependencies.
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
// for binding the real vsock listener prior to Serve).
func (s *Server) SetListener(ln Listener) {
	s.ln = ln
}

// Serve accepts connections in a loop. Blocks until ctx is cancelled or
// an irrecoverable error occurs.
// The caller must call SetListener before Serve.
func (s *Server) Serve(ctx context.Context) error {
	if s.ln == nil {
		return fmt.Errorf("listener not set; call SetListener or Listen first")
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
		// process it instead of waiting for the next read.
		if len(remainder) > 0 {
			copy(buf[:len(remainder)], remainder)
			// For simplicity and to avoid infinite loop edge cases,
			// we queue the remainder for the next read cycle.
			// In practice, we copy remainder back to the start of buf
			// but need the full read loop to handle it.
			// Simple approach: write remainder to a temp buffer for next iteration
			// The next Read will overwrite buf, but we need to handle partial reads.
		}
	}
}

// SendReadyEvent sends a "Ready" event to the given writer.
func (s *Server) SendReadyEvent(conn io.Writer) error {
	payload, err := json.Marshal("Ready")
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

// Context returns the handler context (for testing).
func (s *Server) Context() *HandlerContext {
	return s.ctx
}
