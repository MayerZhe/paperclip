//go:build linux
// +build linux

package server

import (
	"fmt"
	"io"
	"os"
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

// vsockListener implements our Listener interface using AF_VSOCK sockets.
type vsockListener struct {
	fd   int
	file *os.File
}

// Listen creates a vsock listener on the given port.
func (s *Server) Listen() error {
	if s.ln != nil {
		return fmt.Errorf("listener already set")
	}

	fd, err := unix.Socket(unix.AF_VSOCK, syscall.SOCK_STREAM, 0)
	if err != nil {
		return fmt.Errorf("socket(AF_VSOCK): %w", err)
	}

	// Allow address reuse
	if err := unix.SetsockoptInt(fd, unix.SOL_SOCKET, unix.SO_REUSEADDR, 1); err != nil {
		unix.Close(fd)
		return fmt.Errorf("setsockopt(SO_REUSEADDR): %w", err)
	}

	// Bind to VMADDR_CID_ANY on the specified port
	addr := &unix.SockaddrVM{
		CID:  unix.VMADDR_CID_ANY,
		Port: s.port,
	}
	if err := unix.Bind(fd, addr); err != nil {
		unix.Close(fd)
		return fmt.Errorf("bind(vsock:%d): %w", s.port, err)
	}

	// Listen with a reasonable backlog
	if err := unix.Listen(fd, 128); err != nil {
		unix.Close(fd)
		return fmt.Errorf("listen(vsock:%d): %w", s.port, err)
	}

	s.ln = &vsockListener{fd: fd, file: os.NewFile(uintptr(fd), "vsock-listener")}
	return nil
}

func (vl *vsockListener) Accept() (io.ReadWriteCloser, error) {
	nfd, _, err := unix.Accept(vl.fd)
	if err != nil {
		return nil, err
	}
	return newVsockConn(nfd), nil
}

func (vl *vsockListener) Close() error {
	return vl.file.Close()
}
