# sdk-daemon — PaperClip VM Guest Agent

Go guest agent that runs inside the AgentHubs VM, providing a vsock RPC server for host communication.

## Architecture

```
Host (CID=2)                              Guest VM (CID=3)
    │                                          │
    │  vsock connection                        │
    │────────────────────────────────────────► │
    │            port 1024                     │
    │                                          ├── sdk-daemon (vsock RPC)
    │                                          │   ├── Spawn → cloud-api (:4000)
    │                                          │   ├── Spawn → paperclip (:3200)
    │                                          │   └── Spawn → MinIO (:9000)
    │                                          │
    │  "Ready" event ◄─────────────────────────┤ (on boot)
```

## RPC Methods

| Method | ID | Description |
|--------|----|-------------|
| Spawn | 1 | Start a child process (cloud-api, paperclip, MinIO) |
| Kill | 2 | Terminate a named child process (SIGTERM) |
| Shutdown | 3 | Initiate graceful VM shutdown |
| HealthCheck | 4 | TCP port check for all services |
| SetSecurityPolicy | 5 | Inject security token/host_info |

## Wire Format

```
4 bytes msg_len (big-endian, total message length)
1 byte  msg_type (0=request, 1=response, 2=event)
2 bytes method_id (big-endian)
JSON payload (remaining bytes)
```

## Build

```sh
# Cross-compile for Linux ARM64
make build

# Verify binary
file bin/sdk-daemon  # → ELF 64-bit LSB executable, ARM aarch64
./bin/sdk-daemon --version  # → sdk-daemon v0.1.0
```

## Development

```sh
# Run tests
make test

# Format and vet
make check
```

## Project Structure

```
apps/desktop/vm-guest-agent/
├── cmd/sdk-daemon/main.go       # Entry point
├── internal/
│   ├── server/server.go         # vsock RPC server
│   ├── server/handlers.go       # 5 method handlers
│   ├── server/listener_linux.go # Linux vsock listener (github.com/mdlayher/vsock)
│   ├── server/listener_stub.go  # Non-Linux stub
│   ├── process/manager.go       # Child process spawn/kill
│   ├── wire/protocol.go         # Wire format encode/decode
│   └── health/checker.go        # TCP port health check
├── Makefile
├── go.mod
└── README.md
```

## Dependencies

- Go 1.22+
- `github.com/mdlayher/vsock` (Linux only, for vsock socket support)
- Standard library: `net`, `encoding/json`, `sync`, `flag`, `log`
