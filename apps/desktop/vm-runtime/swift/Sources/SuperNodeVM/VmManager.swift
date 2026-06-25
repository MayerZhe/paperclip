import Foundation
import Virtualization

// VmManager — manages the VZVirtualMachine lifecycle.
//
// State transitions:
//   idle → starting → running → stopping → idle
//
// The manager owns the VZVirtualMachine instance and its delegate.
// Only one VM can be running at a time (enforced by state machine).

enum VmState: String {
    case idle
    case starting
    case running
    case stopping
}

class VmManager: NSObject, VZVirtualMachineDelegate {

    // ─── Internal state ───

    private var _state: VmState = .idle
    private let stateLock = NSLock()
    private var virtualMachine: VZVirtualMachine?
    private var config: VmConfig?
    private var vsockListener: VsockListener?
    private var readyContinuation: ((Bool) -> Void)?

    // Binary protocol reassembly buffer for guest messages
    private var vsockBuffer = Data()

    var state: VmState {
        stateLock.lock()
        defer { stateLock.unlock() }
        return _state
    }

    private func setState(_ newState: VmState) {
        stateLock.lock()
        let oldState = _state
        _state = newState
        stateLock.unlock()

        fputs("[supernode-vm] State: \(oldState.rawValue) → \(newState.rawValue)\n", stderr)
    }

    // ─── Start VM ───

    /// Start a VM with the given configuration.
    /// Throws if a VM is already running or if configuration fails.
    func start(config: VmConfig) throws {
        guard state == .idle else {
            throw VmManagerError.alreadyRunning
        }

        self.config = config
        setState(.starting)

        let vzConfig: VZVirtualMachineConfiguration
        do {
            vzConfig = try VmConfigParser.buildConfiguration(from: config)
            fputs("[supernode-vm] Configuration built and validated\n", stderr)
        } catch {
            fputs("[supernode-vm] Configuration error: \(error)\n", stderr)
            throw error
        }
        fputs("[supernode-vm] Creating VZVirtualMachine...\n", stderr)
        let vm = VZVirtualMachine(configuration: vzConfig)
        fputs("[supernode-vm] VZVirtualMachine created\n", stderr)

        // delegateQueue was removed in macOS 26 SDK — delegate callbacks and
        // completion handlers now always fire on the main queue.  This is safe
        // because main.swift runs the stdin read loop on a background queue,
        // leaving the main thread free to service DispatchQueue.main.
        vm.delegate = self
        self.virtualMachine = vm

        // Create vsock listener (host side — accepts connections from guest).
        // The guest agent (sdk-daemon) connects to CID=2 on this port.
        let port = config.vsockPort
        let listener = VsockListener(port: port) { [weak self] data in
            self?.handleGuestMessage(data)
        }
        self.vsockListener = listener

        // Start the VM — completion handler called on delegateQueue
        vm.start { [weak self] result in
            guard let self = self else { return }
            switch result {
            case .success:
                self.setState(.running)
                fputs("[supernode-vm] VM started successfully\n", stderr)

                // Now that the VM is running, start the vsock listener.
                if let socketDevice = vm.socketDevices.compactMap({ $0 as? VZVirtioSocketDevice }).first {
                    do {
                        try listener.start(on: socketDevice)
                    } catch {
                        fputs("[supernode-vm] Warning: vsock listener start failed: \(error)\n", stderr)
                    }
                } else {
                    fputs("[supernode-vm] Warning: no VZVirtioSocketDevice found\n", stderr)
                }

                // Emit "VMStarted" event so the host knows the VM is truly running.
                let event = JsonRpcEvent(
                    method: "event",
                    params: .dictionary([
                        "type": .string("VMStarted"),
                        "timestamp": .string(ISO8601DateFormatter().string(from: Date())),
                    ])
                )
                emitEvent(event)

            case .failure(let error):
                self.setState(.idle)
                fputs("[supernode-vm] VM start failed: \(error)\n", stderr)

                let event = JsonRpcEvent(
                    method: "event",
                    params: .dictionary([
                        "type": .string("VMError"),
                        "error": .string(error.localizedDescription),
                    ])
                )
                emitEvent(event)
            }
        }
    }

    /// Block until the VM signals "Ready" (guest agent connects via vsock) or timeout.
    func waitForReady(timeoutSeconds: TimeInterval) -> Bool {
        let semaphore = DispatchSemaphore(value: 0)
        var didBecomeReady = false

        readyContinuation = { ready in
            didBecomeReady = ready
            semaphore.signal()
        }

        if state == .running && vsockListener?.isGuestConnected == true {
            readyContinuation?(true)
        }

        let waitResult = semaphore.wait(timeout: .now() + timeoutSeconds)
        return waitResult == .success && didBecomeReady
    }

    // ─── Stop VM ───

    func stop() {
        guard state == .running || state == .starting else {
            setState(.idle)
            return
        }

        setState(.stopping)

        sendShutdownToGuest()

        DispatchQueue.global().asyncAfter(deadline: .now() + 5.0) { [weak self] in
            guard let self = self else { return }
            if self.state == .stopping {
                fputs("[supernode-vm] Guest shutdown timeout, pausing VM\n", stderr)
                self.virtualMachine?.pause { result in
                    if case .failure(let error) = result {
                        fputs("[supernode-vm] VM pause failed: \(error)\n", stderr)
                    }
                    self.cleanup()
                }
            }
        }
    }

    private func sendShutdownToGuest() {
        guard let listener = vsockListener, listener.isGuestConnected else {
            fputs("[supernode-vm] No guest vsock connection, cannot send shutdown request\n", stderr)
            return
        }
        // Send shutdown command as binary wire format
        let payload = "{}".data(using: .utf8)!
        let shutdownMsg = GuestComms.encodeMessage(type: .request, methodId: 3, payload: payload)
        listener.sendToGuest(shutdownMsg)
    }

    // ─── Guest message handling (binary wire protocol) ───

    private func handleGuestMessage(_ data: Data) {
        vsockBuffer.append(data)

        let result = GuestComms.extractMessages(from: vsockBuffer)
        vsockBuffer = result.remainder

        for (msgType, methodId, payload) in result.messages {
            fputs("[supernode-vm] Guest msg: type=\(msgType.rawValue) methodId=\(methodId) payloadLen=\(payload.count)\n", stderr)

            switch msgType {
            case .event:
                // Check for Ready event (may include guest IP)
                if GuestComms.isReadyEvent(payload: payload) {
                    let (_, timestamp) = GuestComms.parseReadyEvent(payload: payload)
                    let ts = timestamp ?? ISO8601DateFormatter().string(from: Date())

                    // Extract guest IP from Ready event if present
                    var guestIP: String? = nil
                    if let json = try? JSONSerialization.jsonObject(with: payload) as? [String: Any] {
                        guestIP = json["ip"] as? String
                    }

                    fputs("[supernode-vm] Guest agent signaled Ready\(guestIP.map { " (ip: \($0))" } ?? "")\n", stderr)

                    // Emit Ready event to parent process (TypeScript), including guest IP
                    var eventParams: [String: JsonRpcValue] = [
                        "type": .string("Ready"),
                        "timestamp": .string(ts),
                    ]
                    if let ip = guestIP {
                        eventParams["ip"] = .string(ip)
                    }
                    let event = JsonRpcEvent(
                        method: "event",
                        params: .dictionary(eventParams)
                    )
                    emitEvent(event)

                    // Resolve any waiting waitForReady callers
                    readyContinuation?(true)
                    readyContinuation = nil
                }

            case .response:
                // Guest sent a response to a forwarded RPC request
                if let jsonStr = String(data: payload, encoding: .utf8) {
                    fputs("[supernode-vm] Guest response (methodId=\(methodId)): \(jsonStr)\n", stderr)
                }

            case .request:
                // Guest sent an RPC request (unusual, but handle gracefully)
                fputs("[supernode-vm] Guest sent request methodId=\(methodId), ignoring\n", stderr)

            default:
                fputs("[supernode-vm] Unknown msg type: \(msgType.rawValue)\n", stderr)
            }
        }
    }

    // ─── RPC Forwarding: host → guest ───

    /// Known RPC method IDs (must match Go sdk-daemon handlers.go Dispatch table).
    private enum GuestMethodId: UInt16 {
        case spawn            = 1
        case kill             = 2
        case shutdown         = 3
        case healthCheck      = 4
        case setSecurityPolicy = 5
    }

    /// Forward a JSON-RPC request from the host (TypeScript) to the guest agent via vsock.
    /// Returns a JSON-RPC response to send back to TypeScript.
    /// For now this is fire-and-forget for SetSecurityPolicy/Shutdown;
    /// Spawn/Kill/HealthCheck need response correlation (future work).
    func forwardToGuest(method: String, paramsJSON: Data) -> JsonRpcResponse? {
        guard let listener = vsockListener, listener.isGuestConnected else {
            return JsonRpcResponse(
                id: nil,
                error: JsonRpcError(code: -32000, message: "Guest not connected")
            )
        }

        // Map method name to numeric ID
        let methodId: GuestMethodId?
        switch method {
        case "Spawn":             methodId = .spawn
        case "Kill":              methodId = .kill
        case "Shutdown":          methodId = .shutdown
        case "HealthCheck":       methodId = .healthCheck
        case "SetSecurityPolicy": methodId = .setSecurityPolicy
        default:                  methodId = nil
        }

        guard let mid = methodId else {
            return JsonRpcResponse(
                id: nil,
                error: JsonRpcError(code: -32601, message: "Method not found: \(method)")
            )
        }

        // Encode with binary wire format
        let wireData = GuestComms.encodeMessage(type: .request, methodId: mid.rawValue, payload: paramsJSON)
        listener.sendToGuest(wireData)

        fputs("[supernode-vm] Forwarded RPC '\(method)' (methodId=\(mid.rawValue)) to guest\n", stderr)

        // Fire-and-forget: return success immediately.
        return JsonRpcResponse(
            id: nil,
            result: .dictionary(["status": .string("forwarded")])
        )
    }

    // ─── VZVirtualMachineDelegate ───

    func virtualMachine(_ virtualMachine: VZVirtualMachine, didStopWithError error: Error) {
        fputs("[supernode-vm] VM stopped with error: \(error)\n", stderr)
        cleanup()
    }

    func guestDidStop(_ virtualMachine: VZVirtualMachine) {
        fputs("[supernode-vm] Guest did stop\n", stderr)
        cleanup()
    }

    func virtualMachine(_ virtualMachine: VZVirtualMachine, didStopGuestWithError error: Error) {
        fputs("[supernode-vm] Guest stopped with error: \(error)\n", stderr)
        cleanup()
    }

    // ─── Cleanup ───

    private func cleanup() {
        vsockListener?.stop()
        vsockListener = nil
        virtualMachine = nil
        config = nil
        vsockBuffer.removeAll()
        readyContinuation?(false)
        readyContinuation = nil
        setState(.idle)
    }
}

// ─── Error type ───

enum VmManagerError: Error, CustomStringConvertible {
    case alreadyRunning

    var description: String {
        switch self {
        case .alreadyRunning:
            return "A VM is already running. Stop it before starting a new one."
        }
    }
}
