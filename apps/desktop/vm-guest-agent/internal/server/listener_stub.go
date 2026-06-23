//go:build !linux
// +build !linux

package server

import (
	"fmt"
)

// Listen is a no-op on non-Linux platforms.
// vsock is only available on Linux.
func (s *Server) Listen() error {
	return fmt.Errorf("vsock is only supported on Linux; use SetListener for testing")
}
