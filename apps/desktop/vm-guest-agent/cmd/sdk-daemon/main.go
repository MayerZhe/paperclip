// sdk-daemon is the PaperClip VM guest agent.
//
// It connects to the host's vsock listener at CID=2 and processes RPC
// requests for spawning/killing child processes and health checks.
//
// Usage:
//
//	sdk-daemon --version          Print version and exit
//	sdk-daemon                     Connect to host on vsock port 1024 (default)
//	sdk-daemon --port 9999         Connect to host on vsock port 9999
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

const version = "v0.2.0"

func main() {
	showVersion := flag.Bool("version", false, "print version and exit")
	port := flag.Uint("port", uint(server.DefaultVsockPort), "vsock port to connect to on host (CID=2)")
	flag.Parse()

	if *showVersion {
		fmt.Printf("sdk-daemon %s\n", version)
		return
	}

	vsockPort := uint32(*port)
	log.Printf("[sdk-daemon] starting %s", version)

	srv := server.New(vsockPort)

	// Configure the health checker with a reasonable timeout
	srv.Context().Checker.Host = "127.0.0.1"
	srv.Context().Checker.Timeout = 2 * time.Second

	// Connect to host's vsock listener at CID=2
	// Retry up to 3 times with a 2-second delay (the host vsock listener
	// may not be ready immediately after VM boot).
	var connErr error
	for attempt := 1; attempt <= 3; attempt++ {
		connErr = srv.Connect()
		if connErr == nil {
			break
		}
		if attempt < 3 {
			log.Printf("[sdk-daemon] connect attempt %d/3 failed: %v — retrying in 2s", attempt, connErr)
			time.Sleep(2 * time.Second)
		}
	}
	if connErr != nil {
		log.Fatalf("[sdk-daemon] failed to connect to host after 3 attempts: %v", connErr)
	}
	log.Printf("[sdk-daemon] connected to host on vsock port %d", vsockPort)

	// Immediately send Ready event with guest IP so the host knows how
	// to reach VM services (HTTP health checks need the guest IP).
	conn := srv.Connection()
	if conn == nil {
		log.Fatalf("[sdk-daemon] connection not available after Connect")
	}
	// Detect guest IP — DHCP may not have completed yet.
	// Try a few times with a short delay to get the non-loopback address.
	var guestIP string
	for attempt := 1; attempt <= 10; attempt++ {
		guestIP = server.DetectGuestIP()
		if guestIP != "127.0.0.1" {
			break
		}
		if attempt < 10 {
			time.Sleep(500 * time.Millisecond)
		}
	}
	log.Printf("[sdk-daemon] guest IP: %s", guestIP)
	if err := srv.SendReadyEvent(conn, guestIP); err != nil {
		log.Fatalf("[sdk-daemon] failed to send Ready event: %v", err)
	}
	log.Printf("[sdk-daemon] Ready event sent to host")

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

	log.Printf("[sdk-daemon] ready")

	// Serve RPC requests until cancelled
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
