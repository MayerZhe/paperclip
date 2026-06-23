// sdk-daemon is the PaperClip VM guest agent.
//
// It provides a vsock RPC server with 5 methods for managing child processes
// and health checking services inside a VM.
//
// Usage:
//
//	sdk-daemon --version    Print version and exit
//	sdk-daemon               Start the vsock RPC server on port 1024
package main

import (
	"context"
	"flag"
	"fmt"
	"log"
	"os"
	"os/signal"
	"syscall"
	"time"

	"github.com/paperclipai/sdk-daemon/internal/server"
)

const version = "v0.1.0"

func main() {
	showVersion := flag.Bool("version", false, "print version and exit")
	flag.Parse()

	if *showVersion {
		fmt.Printf("sdk-daemon %s\n", version)
		return
	}

	log.Printf("[sdk-daemon] starting %s", version)

	srv := server.New(server.DefaultVsockPort)

	// Configure the health checker with a reasonable timeout
	srv.Context().Checker.Host = "127.0.0.1"
	srv.Context().Checker.Timeout = 2 * time.Second

	// Listen on vsock port (Linux only; testable via SetListener on other platforms)
	if err := srv.Listen(); err != nil {
		log.Fatalf("[sdk-daemon] failed to listen: %v", err)
	}
	log.Printf("[sdk-daemon] listening on vsock port %d", server.DefaultVsockPort)

	// Setup signal handling for graceful shutdown
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	sigCh := make(chan os.Signal, 1)
	signal.Notify(sigCh, syscall.SIGTERM, syscall.SIGINT)
	go func() {
		sig := <-sigCh
		log.Printf("[sdk-daemon] received signal %v, shutting down", sig)
		cancel()
	}()

	// Report readiness
	log.Printf("[sdk-daemon] ready")

	// Serve until cancelled
	if err := srv.Serve(ctx); err != nil {
		log.Printf("[sdk-daemon] server exited: %v", err)
	}

	// Graceful shutdown: kill all managed child processes
	log.Printf("[sdk-daemon] stopping managed processes")
	errs := srv.Context().ProcMgr.StopAll()
	for _, err := range errs {
		log.Printf("[sdk-daemon] stop error: %v", err)
	}

	log.Printf("[sdk-daemon] shutdown complete")
}
