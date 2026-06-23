# SuperNodeVM Makefile
# Builds the supernode-vm Swift CLI universal binary (arm64 + x86_64).

# ─── Configuration ───

SWIFT_BUILD_FLAGS = -c release --arch arm64 --arch x86_64
BUILD_DIR = .build
PRODUCT_DIR = $(BUILD_DIR)/apple/Products/Release
BINARY_NAME = supernode-vm
OUTPUT_DIR ?= ../../bin

# ─── Default target ───

.PHONY: all
all: build

# ─── Build ───

.PHONY: build
build:
	swift build $(SWIFT_BUILD_FLAGS)
	@echo ""
	@echo "Build complete. Binary: $(PRODUCT_DIR)/$(BINARY_NAME)"
	@file $(PRODUCT_DIR)/$(BINARY_NAME) 2>/dev/null || true
	@echo ""

# ─── Build and copy to output directory ───

.PHONY: install
install: build
	@mkdir -p $(OUTPUT_DIR)
	cp "$(PRODUCT_DIR)/$(BINARY_NAME)" "$(OUTPUT_DIR)/"
	@echo "Installed to $(OUTPUT_DIR)/$(BINARY_NAME)"

# ─── Clean ───

.PHONY: clean
clean:
	rm -rf $(BUILD_DIR)
	@echo "Cleaned build artifacts"

# ─── Verify (check that the binary is universal) ───

.PHONY: verify
verify: build
	@echo "=== Binary info ==="
	@file $(PRODUCT_DIR)/$(BINARY_NAME)
	@echo ""
	@echo "=== Architectures ==="
	@lipo -info $(PRODUCT_DIR)/$(BINARY_NAME) 2>/dev/null || echo "lipo not available (single-arch build?)"
	@echo ""
	@echo "=== Codesign ==="
	@codesign -dvvv $(PRODUCT_DIR)/$(BINARY_NAME) 2>/dev/null || echo "Not codesigned (expected in development)"

# ─── Resolve dependencies without building ───

.PHONY: resolve
resolve:
	swift package resolve

# ─── Help ───

.PHONY: help
help:
	@echo "SuperNodeVM Makefile targets:"
	@echo "  make build     — Build universal binary (arm64 + x86_64)"
	@echo "  make install   — Build and copy to $(OUTPUT_DIR)/"
	@echo "  make clean     — Remove build artifacts"
	@echo "  make verify    — Build and show binary architecture info"
	@echo "  make resolve   — Resolve Swift package dependencies"
	@echo "  make help      — Show this help"
