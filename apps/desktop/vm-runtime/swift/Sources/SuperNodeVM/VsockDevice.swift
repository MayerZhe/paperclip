import Foundation
import Virtualization

// VsockDevice — manages VZVirtioSocketDevice communication between host and guest.
//
// Architecture:
//   - Guest CID = 3 (configured in VmConfigParser via VZVirtioSocketDeviceConfiguration)
//   - Host side listens on a local TCP port, forwarding to/from the vsock guest port.
//   - The guest agent (sdk-daemon) listens on vsock CID=3 port=1024 using binary wire format.
//
// Binary wire format (4 bytes msg_len + 1 byte msg_type + 2 bytes method_id + JSON payload):
//   This file handles the low-level vsock stream; GuestComms handles protocol framing.
//
// Note: VZVirtioSocketDevice provides VZVirtioSocketPort for host↔guest communication.
// The host creates a VZVirtioSocketListener on a port, and the guest connects to it.

/// Manages a host-side listener that accepts connections from the guest VM via vsock.
/// The guest connects to CID=2 (host) on the configured port.
class VsockListener {
    private let port: UInt32
    private var listener: VZVirtioSocketListener?
    private var connections: [VZVirtioSocketConnection] = []
    private let connectionLock = NSLock()
    private let onMessage: (Data) -> Void

    /// Strong references to delegate objects to prevent deallocation
    /// (VZVirtioSocketListener.delegate and VZVirtioSocketConnection.delegate are weak).
    private var retainedListenerDelegate: ListenerDelegate?
    private var retainedConnectionDelegates: [ObjectIdentifier: ConnectionDelegate] = [:]

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
    func start() throws {
        // VZVirtioSocketListener listens on a specific port on the host side (CID=2).
        // The guest connects to CID=2 on the port configured in the VM.
        let vzListener = VZVirtioSocketListener(port: port)
        let delegate = ListenerDelegate(parent: self)
        vzListener.delegate = delegate
        retainedListenerDelegate = delegate  // Retain strongly to prevent deallocation
        self.listener = vzListener
        fputs("[supernode-vm] Vsock listener started on port \(port)\n", stderr)
    }

    /// Stop the listener and close all connections.
    func stop() {
        connectionLock.lock()
        for conn in connections {
            conn.disconnect()
        }
        connections.removeAll()
        connectionLock.unlock()
        retainedConnectionDelegates.removeAll()
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
            // VZVirtioSocketConnection uses a file descriptor for the data channel
            // We write the data to the connection's underlying fd
            do {
                try conn.write(data)
            } catch {
                fputs("[supernode-vm] Write to guest failed: \(error)\n", stderr)
            }
        }
    }

    // ─── Delegate: handles incoming guest connections ───

    fileprivate class ListenerDelegate: NSObject, VZVirtioSocketListenerDelegate {
        weak var parent: VsockListener?

        init(parent: VsockListener) {
            self.parent = parent
        }

        func listener(_ listener: VZVirtioSocketListener, shouldAcceptNewConnection connection: VZVirtioSocketConnection, from sourcePort: UInt32) -> Bool {
            fputs("[supernode-vm] Guest connected on vsock from port \(sourcePort)\n", stderr)

            guard let parent = parent else { return false }

            parent.connectionLock.lock()
            parent.connections.append(connection)
            parent.connectionLock.unlock()

            // Set up a read loop on this connection.
            // Retain the delegate strongly since VZVirtioSocketConnection.delegate is weak.
            let connDelegate = ConnectionDelegate(parent: parent, connection: connection)
            connection.delegate = connDelegate
            parent.retainedConnectionDelegates[ObjectIdentifier(connection)] = connDelegate

            return true
        }
    }

    // ─── Connection delegate: handles data from guest ───

    fileprivate class ConnectionDelegate: NSObject, VZVirtioSocketConnectionDelegate {
        weak var parent: VsockListener?
        weak var connection: VZVirtioSocketConnection?

        init(parent: VsockListener, connection: VZVirtioSocketConnection) {
            self.parent = parent
            self.connection = connection
        }

        func connection(_ connection: VZVirtioSocketConnection, didDisconnectWithError error: Error?) {
            fputs("[supernode-vm] Guest disconnected from vsock: \(error?.localizedDescription ?? "clean disconnect")\n", stderr)
            parent?.connectionLock.lock()
            parent?.connections.removeAll { $0 === connection }
            parent?.connectionLock.unlock()
            parent?.retainedConnectionDelegates.removeValue(forKey: ObjectIdentifier(connection))
        }

        func connection(_ connection: VZVirtioSocketConnection, didReceiveData data: Data) {
            parent?.onMessage(data)

            // Continue reading — stream-based protocol
            // VZVirtioSocketConnection is stream-oriented; we keep the delegate registered
            // and receive data in chunks. GuestComms handles reassembly.
        }
    }
}

// ─── VZVirtioSocketConnection write helper ───

extension VZVirtioSocketConnection {
    /// Write data to the vsock connection.
    /// VZVirtioSocketConnection writes to the underlying file descriptor.
    func write(_ data: Data) throws {
        // VZVirtioSocketConnection uses its internal file descriptor for data transfer.
        // The `write` method on the connection sends data to the guest.
        // Note: VZVirtioSocketConnection.write is available on macOS 14+.
        // For macOS 13, we use the file descriptor directly.

        // Access the underlying file descriptor through the connection
        // VZVirtioSocketConnection exposes `fileDescriptor` in macOS 13+
        let fd = self.fileDescriptor
        let bytesWritten = data.withUnsafeBytes { ptr in
            Darwin.write(fd, ptr.baseAddress!, data.count)
        }
        if bytesWritten < 0 {
            throw NSError(
                domain: NSPOSIXErrorDomain,
                code: Int(errno),
                userInfo: [NSLocalizedDescriptionKey: "vsock write failed: \(String(cString: strerror(errno)))"]
            )
        }
    }
}
