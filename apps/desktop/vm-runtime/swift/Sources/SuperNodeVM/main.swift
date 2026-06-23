import Foundation

// SuperNodeVM — CLI entry point for VZVirtualMachine manager
//
// Communicates with the parent Electron process via JSON-RPC 2.0 over stdin/stdout.
// Each JSON-RPC message is a single line (line-delimited JSON).
//
// Protocol:
//   ← {"jsonrpc":"2.0","id":1,"method":"start","params":{...}}
//   → {"jsonrpc":"2.0","id":1,"result":{"status":"running","pid":12345}}
//   ← {"jsonrpc":"2.0","id":2,"method":"stop","params":{}}
//   → {"jsonrpc":"2.0","id":2,"result":{"status":"stopped"}}
//   → {"jsonrpc":"2.0","method":"event","params":{"type":"Ready","timestamp":"..."}}

// ─── Signal handling: gracefully shut down VM on SIGTERM ───

let vmManager = VmManager()

// Set up signal handler for graceful shutdown
signal(SIGTERM) { _ in
    fputs("[supernode-vm] Received SIGTERM, shutting down VM...\n", stderr)
    vmManager.stop()
    exit(0)
}

signal(SIGINT) { _ in
    fputs("[supernode-vm] Received SIGINT, shutting down VM...\n", stderr)
    vmManager.stop()
    exit(0)
}

// Ignore SIGPIPE — writing to a closed stdin pipe should not crash us
signal(SIGPIPE, SIG_IGN)

// ─── JSON-RPC dispatch table ───

func handleRequest(_ request: JsonRpcRequest) -> JsonRpcResponse {
    switch request.method {
    case "start":
        return handleStart(request)
    case "stop":
        return handleStop(request)
    case "status":
        return handleStatus(request)
    case "ping":
        return JsonRpcResponse(id: request.id, result: .string("pong"))
    default:
        return JsonRpcResponse(
            id: request.id,
            error: JsonRpcError(
                code: -32601,
                message: "Method not found: \(request.method)"
            )
        )
    }
}

func handleStart(_ request: JsonRpcRequest) -> JsonRpcResponse {
    // Parse VM configuration from params
    guard let params = request.params else {
        return JsonRpcResponse(
            id: request.id,
            error: JsonRpcError(code: -32602, message: "Missing params: vm configuration required")
        )
    }

    let configResult = VmConfigParser.parse(json: params)
    switch configResult {
    case .failure(let error):
        return JsonRpcResponse(
            id: request.id,
            error: JsonRpcError(code: -32602, message: "Invalid config: \(error)")
        )
    case .success(let config):
        do {
            try vmManager.start(config: config)
            // Send "Ready" event asynchronously after VM is running
            DispatchQueue.global(qos: .default).async {
                // VM needs a moment to boot — Ready event will be sent
                // when the guest agent connects via vsock (handled in VmManager)
                _ = vmManager.waitForReady(timeoutSeconds: 30)
            }
            return JsonRpcResponse(
                id: request.id,
                result: .dictionary([
                    "status": .string("running"),
                    "pid": .number(Double(ProcessInfo.processInfo.processIdentifier)),
                ])
            )
        } catch {
            return JsonRpcResponse(
                id: request.id,
                error: JsonRpcError(code: -32000, message: "VM start failed: \(error.localizedDescription)")
            )
        }
    }
}

func handleStop(_ request: JsonRpcRequest) -> JsonRpcResponse {
    vmManager.stop()
    return JsonRpcResponse(
        id: request.id,
        result: .dictionary([
            "status": .string("stopped"),
        ])
    )
}

func handleStatus(_ request: JsonRpcRequest) -> JsonRpcResponse {
    let state = vmManager.state
    return JsonRpcResponse(
        id: request.id,
        result: .dictionary([
            "status": .string(state.rawValue),
            "pid": .number(Double(ProcessInfo.processInfo.processIdentifier)),
        ])
    )
}

// ─── Event emission ───

/// Send an asynchronous JSON-RPC notification (event) to the parent process.
/// Events have no `id` field (they are notifications per JSON-RPC 2.0 spec).
func emitEvent(_ event: JsonRpcEvent) {
    let encoder = JSONEncoder()
    encoder.outputFormatting = []
    do {
        let data = try encoder.encode(event)
        guard let line = String(data: data, encoding: .utf8) else { return }
        // Events are sent on a dedicated serial queue to avoid interleaving
        DispatchQueue.main.async {
            print(line)
            fflush(stdout)
        }
    } catch {
        fputs("[supernode-vm] Failed to encode event: \(error)\n", stderr)
    }
}

// ─── Main loop: read JSON-RPC lines from stdin ───

fputs("[supernode-vm] Starting JSON-RPC listener on stdin/stdout\n", stderr)

let stdin = FileHandle.standardInput
var buffer = ""

while true {
    guard let availableData = try? stdin.read(upToCount: 4096) else {
        // EOF or read error — parent process closed pipe
        fputs("[supernode-vm] stdin closed, shutting down\n", stderr)
        vmManager.stop()
        exit(0)
    }

    guard !availableData.isEmpty else {
        // Graceful EOF
        vmManager.stop()
        exit(0)
    }

    buffer.append(contentsOf: String(decoding: availableData, as: UTF8.self))

    // Process complete lines
    while let newlineIndex = buffer.firstIndex(of: "\n") {
        let line = String(buffer[..<newlineIndex])
        buffer.removeSubrange(...newlineIndex)

        guard !line.trimmingCharacters(in: .whitespaces).isEmpty else { continue }

        // Parse JSON-RPC request
        guard let lineData = line.data(using: .utf8) else {
            fputs("[supernode-vm] Invalid UTF-8 in input line\n", stderr)
            continue
        }

        do {
            let decoder = JSONDecoder()
            let request = try decoder.decode(JsonRpcRequest.self, from: lineData)

            // Dispatch on background queue so VM operations don't block stdin reads
            let response = handleRequest(request)

            let encoder = JSONEncoder()
            encoder.outputFormatting = []
            let responseData = try encoder.encode(response)
            if let responseLine = String(data: responseData, encoding: .utf8) {
                print(responseLine)
                fflush(stdout)
            }
        } catch {
            fputs("[supernode-vm] Failed to parse request: \(error)\n", stderr)
            // Send parse error response if we can extract an id
            let parseError = JsonRpcResponse(
                id: nil,
                error: JsonRpcError(code: -32700, message: "Parse error: \(error.localizedDescription)")
            )
            if let errorData = try? JSONEncoder().encode(parseError),
               let errorLine = String(data: errorData, encoding: .utf8) {
                print(errorLine)
                fflush(stdout)
            }
        }
    }
}
