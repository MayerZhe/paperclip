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

        let vzConfig = try VmConfigParser.buildConfiguration(from: config)
        let vm = VZVirtualMachine(configuration: vzConfig)
        vm.delegate = self
        self.virtualMachine = vm

        // Start listening on vsock host port for guest communication
        let port = config.vsockPort
        let listener = VsockListener(port: port) { [weak self] data in
            self?.handleGuestMessage(data)
        }
        do {
            try listener.start()
            self.vsockListener = listener
        } catch {
            fputs("[supernode-vm] Warning: vsock listener start failed: \(error)\n", stderr)
            // Non-fatal: VM can still run without vsock
        }

        // Start the VM
        vm.start { [weak self] result in
            guard let self = self else { return }
            switch result {
            case .success:
                self.setState(.running)
                fputs("[supernode-vm] VM started successfully\n", stderr)
            case .failure(let error):
                self.setState(.idle)
                fputs("[supernode-vm] VM start failed: \(error)\n", stderr)
            }
        }
    }

    /// Block until the VM signals "Ready" (guest agent connects via vsock) or timeout.
    /// Returns true if ready was received, false on timeout.
    func waitForReady(timeoutSeconds: TimeInterval) -> Bool {
        let semaphore = DispatchSemaphore(value: 0)
        var didBecomeReady = false

        readyContinuation = { ready in
            didBecomeReady = ready
            semaphore.signal()
        }

        // If the guest agent already connected, signal immediately
        if state == .running && vsockListener?.isGuestConnected == true {
            readyContinuation?(true)
        }

        let waitResult = semaphore.wait(timeout: .now() + timeoutSeconds)
        return waitResult == .success && didBecomeReady
    }

    // ─── Stop VM ───

    /// Stop the running VM.
    /// Requests a graceful guest shutdown via vsock, then force-stops after a timeout.
    func stop() {
        guard state == .running || state == .starting else {
            setState(.idle)
            return
        }

        setState(.stopping)

        // Send shutdown request to guest agent via vsock
        sendShutdownToGuest()

        // Give guest 5 seconds to shut down gracefully, then force-stop
        DispatchQueue.global().asyncAfter(deadline: .now() + 5.0) { [weak self] in
            guard let self = self else { return }
            if self.state == .stopping {
                fputs("[supernode-vm] Guest shutdown timeout, force-stopping VM\n", stderr)
                self.virtualMachine?.requestStop()
            }
        }
    }

    private func sendShutdownToGuest() {
        guard let listener = vsockListener, listener.isGuestConnected else {
            fputs("[supernode-vm] No guest vsock connection, cannot send shutdown request\n", stderr)
            return
        }
        // Send shutdown command as JSON message over vsock
        let shutdownMsg = #"{"method":"shutdown","params":{}}"#
        if let data = shutdownMsg.data(using: .utf8) {
            listener.sendToGuest(data)
        }
    }

    // ─── Guest message handling ───

    private func handleGuestMessage(_ data: Data) {
        guard let message = String(data: data, encoding: .utf8) else {
            fputs("[supernode-vm] Received non-UTF8 data from guest\n", stderr)
            return
        }

        fputs("[supernode-vm] Guest message: \(message)\n", stderr)

        // Parse as JSON to check event type
        guard let jsonData = message.data(using: .utf8),
              let json = try? JSONSerialization.jsonObject(with: jsonData) as? [String: Any] else {
            return
        }

        if let eventType = json["type"] as? String, eventType == "Ready" {
            // Guest agent has signaled readiness
            let timestamp = json["timestamp"] as? String ?? ISO8601DateFormatter().string(from: Date())

            // Emit Ready event to parent process
            let event = JsonRpcEvent(
                method: "event",
                params: .dictionary([
                    "type": .string("Ready"),
                    "timestamp": .string(timestamp),
                ])
            )
            emitEvent(event)

            // Resolve any waiting waitForReady callers
            readyContinuation?(true)
            readyContinuation = nil
        }
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
