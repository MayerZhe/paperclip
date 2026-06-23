.PHONY: build test clean lint

BINARY = bin/sdk-daemon
GOOS = linux
GOARCH = arm64
CGO_ENABLED = 0
LDFLAGS = -s -w

# Build for Linux ARM64 (static binary)
build:
	GOOS=$(GOOS) GOARCH=$(GOARCH) CGO_ENABLED=$(CGO_ENABLED) go build -ldflags "$(LDFLAGS)" -o $(BINARY) ./cmd/sdk-daemon/

# Run all tests
test:
	go test ./... -v

# Run tests with race detector
test-race:
	go test -race ./... -v

# Clean build artifacts
clean:
	rm -rf bin/

# Format code
fmt:
	go fmt ./...

# Vet code
vet:
	go vet ./...

# Lint (requires golangci-lint)
lint:
	golangci-lint run ./...

# Quick check: fmt + vet + test
check: fmt vet test
	@echo "All checks passed"
