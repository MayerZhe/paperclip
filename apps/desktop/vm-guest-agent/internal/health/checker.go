// Package health provides TCP port health checking for guest services.
package health

import (
	"fmt"
	"net"
	"sync"
	"time"
)

// CheckPort attempts a TCP connection to the specified host:port and returns
// true if the connection succeeds within the given timeout.
func CheckPort(host string, port int, timeout time.Duration) bool {
	addr := net.JoinHostPort(host, fmt.Sprintf("%d", port))
	conn, err := net.DialTimeout("tcp", addr, timeout)
	if err != nil {
		return false
	}
	conn.Close()
	return true
}

// TCPChecker runs concurrent TCP port checks against a set of named services.
type TCPChecker struct {
	Host    string
	Timeout time.Duration
}

// CheckAll checks multiple services concurrently and returns a map of
// service name to health status (true = reachable, false = unreachable).
func (c *TCPChecker) CheckAll(services map[string]int) map[string]bool {
	if len(services) == 0 {
		return map[string]bool{}
	}

	results := make(map[string]bool, len(services))
	var mu sync.Mutex
	var wg sync.WaitGroup

	for name, port := range services {
		wg.Add(1)
		go func(name string, port int) {
			defer wg.Done()
			ok := CheckPort(c.Host, port, c.Timeout)
			mu.Lock()
			results[name] = ok
			mu.Unlock()
		}(name, port)
	}

	wg.Wait()
	return results
}
