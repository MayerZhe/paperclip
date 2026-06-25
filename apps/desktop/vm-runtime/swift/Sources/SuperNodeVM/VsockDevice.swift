import Foundation
import Virtualization

// VsockDevice — manages VZVirtioSocketDevice communication between host and guest.
//
// Architecture (macOS 26 / Virtualization 210.x):
//   - Guest CID = 3 (configured via VZVirtioSocketDeviceConfiguration)
//   - Host side listens on the VZVirtioSocketDevice for guest connections
//   - The guest agent (sdk-daemon) connects to CID=2 on the configured port
//
// API changes from macOS 14 SDK:
//   1. VZVirtioSocketListener() no longer takes a port argument — the port is
//      registered via VZVirtioSocketDevice.setSocketListener(_:forPort:).
//   2. VZVirtioSocketConnectionDelegate no longer exists — connections are
//      monitored via DispatchSource.read on the connection's fileDescriptor.
//   3. VZVirtioSocketListenerDelegate.listener(_:shouldAcceptNewConnection:from:)
//      signature changed: `from` is now VZVirtioSocketDevice (not UInt32).
//   4. VZVirtioSocketConnection.disconnect() removed — use close() instead.
//
// Binary wire format (4 bytes msg_len + 1 byte msg_type + 2 bytes method_id + JSON payload):
//   GuestComms handles protocol framing; this file handles the low-level vsock stream.

/// Manages a host-side listener that accepts connections from the guest VM via vsock.
/// The guest connects to CID=2 (host) on the configured port.
class VsockListener {
    private let port: UInt32
    private var listener: VZVirtioSocketListener?
    private var connections: [VZVirtioSocketConnection] = []
    private var readSources: [ObjectIdentifier: DispatchSourceRead] = [:]
    private let connectionLock = NSLock()
    private let onMessage: (Data) -> Void
    private var retainedListenerDelegate: ListenerDelegate?

    /// Whether at least one guest connection is established.
    var isGuestConnected: Bool {
        connectionLock.lock()
        defer { connectionLock.unlock() }
        return !connections.isEmpty
    }

    init(port: UInt32, onMessage: @escaping (Data) -> Void) {
        self.port = port
        self.onMessage = onMessage
    }

    /// Start listening for guest connections on the specified vsock port.
    /// Must be called AFTER the VM is running so that the VZVirtioSocketDevice
    /// is available from vm.socketDevices.
    func start(on socketDevice: VZVirtioSocketDevice) throws {
        let vzListener = VZVirtioSocketListener()
        let delegate = ListenerDelegate(parent: self)
        vzListener.delegate = delegate
        retainedListenerDelegate = delegate
        self.listener = vzListener

        // Register the listener on the socket device for the configured port
        socketDevice.setSocketListener(vzListener, forPort: port)

        fputs("[supernode-vm] Vsock listener started on port \(port)\n", stderr)
    }

    /// Stop the listener and close all connections.
    func stop() {
        connectionLock.lock()
        for (_, source) in readSources {
            source.cancel()
        }
        readSources.removeAll()
        for conn in connections {
            // close() replaces the removed disconnect()
            conn.close()
        }
        connections.removeAll()
        connectionLock.unlock()
        retainedListenerDelegate = nil
        listener = nil
        fputs("[supernode-vm] Vsock listener stopped\n", stderr)
    }

    /// Send data to all connected guests.
    func sendToGuest(_ data: Data) {
        connectionLock.lock()
        let activeConnections = connections
        connectionLock.unlock()

        for conn in activeConnections {
            let fd = conn.fileDescriptor
            let bytesWritten = data.withUnsafeBytes { ptr in
                Darwin.write(fd, ptr.baseAddress!, data.count)
            }
            if bytesWritten < 0 {
                fputs("[supernode-vm] Write to guest failed: \(String(cString: strerror(errno)))\n", stderr)
            }
        }
    }

    // ─── Delegate: handles incoming guest connections ───
    //
    // The delegate method signature changed in macOS 26:
    //   Old: listener(_:shouldAcceptNewConnection:from: UInt32)
    //   New: listener(_:shouldAcceptNewConnection:from: VZVirtioSocketDevice)

    fileprivate class ListenerDelegate: NSObject, VZVirtioSocketListenerDelegate {
        weak var parent: VsockListener?

        init(parent: VsockListener) {
            self.parent = parent
        }

        func listener(_ listener: VZVirtioSocketListener,
                      shouldAcceptNewConnection connection: VZVirtioSocketConnection,
                      from socketDevice: VZVirtioSocketDevice) -> Bool {
            fputs("[supernode-vm] Guest connected on vsock from port \(connection.sourcePort)\n", stderr)

            guard let parent = parent else { return false }

            parent.connectionLock.lock()
            parent.connections.append(connection)
            let connId = ObjectIdentifier(connection)
            parent.connectionLock.unlock()

            // VZVirtioSocketConnectionDelegate no longer exists.
            // Instead we monitor the connection's fileDescriptor with a
            // DispatchSource.read to receive data asynchronously.
            let fd = connection.fileDescriptor
            let readSource = DispatchSource.makeReadSource(fileDescriptor: fd,
                                                            queue: DispatchQueue.global(qos: .default))
            readSource.setEventHandler { [weak parent, weak connection] in
                guard let parent = parent, let connection = connection else { return }
                let available = readSource.data
                guard available > 0 else {
                    // Zero bytes = EOF = guest disconnected
                    parent.handleDisconnect(connection, error: nil)
                    return
                }

                // Read up to 64 KiB at a time
                var buf = [UInt8](repeating: 0, count: min(Int(available), 65536))
                let bytesRead = Darwin.read(fd, &buf, buf.count)
                if bytesRead > 0 {
                    let data = Data(buf[0..<bytesRead])
                    parent.onMessage(data)
                } else if bytesRead == 0 {
                    parent.handleDisconnect(connection, error: nil)
                } else {
                    parent.handleDisconnect(connection,
                        error: NSError(domain: NSPOSIXErrorDomain, code: Int(errno),
                                       userInfo: [NSLocalizedDescriptionKey: "vsock read error"]))
                }
            }
            readSource.setCancelHandler { [weak connection] in
                // Best-effort cleanup of the fd on cancel
                if let conn = connection {
                    conn.close()
                }
            }
            readSource.resume()

            parent.connectionLock.lock()
            parent.readSources[connId] = readSource
            parent.connectionLock.unlock()

            return true
        }

        fileprivate func handleDisconnect(_ connection: VZVirtioSocketConnection, error: Error?) {
            guard let parent = parent else { return }
            fputs("[supernode-vm] Guest disconnected from vsock: \(error?.localizedDescription ?? "clean disconnect")\n", stderr)

            let connId = ObjectIdentifier(connection)
            parent.connectionLock.lock()
            if let source = parent.readSources.removeValue(forKey: connId) {
                source.cancel()
            }
            parent.connections.removeAll { $0 === connection }
            parent.connectionLock.unlock()
        }
    }

    // Called by ListenerDelegate to clean up a disconnected connection
    fileprivate func handleDisconnect(_ connection: VZVirtioSocketConnection, error: Error?) {
        retainedListenerDelegate?.handleDisconnect(connection, error: error)
    }
}
