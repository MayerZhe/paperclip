//go:build linux
// +build linux

package server

import (
	"fmt"
	"io"
	"os"
	"sync"
	"syscall"

	"golang.org/x/sys/unix"
)

// vsockConn wraps a vsock file descriptor as io.ReadWriteCloser.
type vsockConn struct {
	fd   int
	file *os.File
}

func newVsockConn(fd int) *vsockConn {
	return &vsockConn{fd: fd, file: os.NewFile(uintptr(fd), "vsock")}
}

func (c *vsockConn) Read(p []byte) (int, error)  { return c.file.Read(p) }
func (c *vsockConn) Write(p []byte) (int, error) { return c.file.Write(p) }
func (c *vsockConn) Close() error                { return c.file.Close() }

// vsockConnListener wraps a single connected vsock socket as a Listener.
// Accept() returns the same connection on the first call, then blocks indefinitely
// (or until Close() is called). This allows Serve() to work unchanged with a
// client-side connection.
type vsockConnListener struct {
	conn     io.ReadWriteCloser
	accepted bool
	mu       sync.Mutex
	closed   bool
}

func (l *vsockConnListener) Accept() (io.ReadWriteCloser, error) {
	l.mu.Lock()
	if l.closed {
		l.mu.Unlock()
		return nil, fmt.Errorf("listener closed")
	}
	if l.accepted {
		// Already returned the connection once — block until closed.
		// In practice the host only opens one connection, so Serve()
		// processes the first Accept and loops. We block here to
		// prevent a tight Accept loop.
		l.mu.Unlock()
		select {} // block forever (Serve() will cancel via ctx)
	}
	l.accepted = true
	l.mu.Unlock()
	return l.conn, nil
}

func (l *vsockConnListener) Close() error {
	l.mu.Lock()
	defer l.mu.Unlock()
	l.closed = true
	if l.conn != nil {
		return l.conn.Close()
	}
	return nil
}

// Connect connects to the host's vsock listener at CID=2 on the given port.
// On success the connection is stored as the server's listener so Serve()
// can accept and process RPC requests from the host.
func (s *Server) Connect() error {
	if s.ln != nil {
		return fmt.Errorf("listener already set")
	}

	fd, err := unix.Socket(unix.AF_VSOCK, syscall.SOCK_STREAM, 0)
	if err != nil {
		return fmt.Errorf("socket(AF_VSOCK): %w", err)
	}

	// Connect to CID=2 (VMADDR_CID_HOST) — the host is the vsock server.
	addr := &unix.SockaddrVM{
		CID:  2,
		Port: s.port,
	}
	if err := unix.Connect(fd, addr); err != nil {
		unix.Close(fd)
		return fmt.Errorf("connect(vsock CID=2 port=%d): %w", s.port, err)
	}

	s.ln = &vsockConnListener{conn: newVsockConn(fd)}
	return nil
}

// Connection implements the connProvider interface from server.go.
func (l *vsockConnListener) Connection() io.Writer {
	return l.conn
}
