import Foundation

// GuestComms — handles guest IP detection and protocol framing for host↔guest communication.
//
// The guest VM communicates with the host via vsock (CID=2 on host, CID=3 on guest).
// After the VM boots and the guest agent (sdk-daemon) starts, it connects to CID=2:9999
// and sends a "Ready" event over vsock indicating all services are up.
//
// Binary wire format used by the guest agent (Go wire.Encode):
//   [4 bytes msg_len (big-endian, TOTAL frame size = 7 + payload_len)]
//   [1 byte msg_type (0=request, 1=response, 2=event)]
//   [2 bytes method_id (big-endian)]
//   [JSON payload]
//
// IMPORTANT: msg_len is the total frame size including the 7-byte header.
//             It is NOT the payload-only length.

struct GuestComms {

    /// Frame types used in the binary wire protocol between host and guest.
    enum MessageType: UInt8 {
        case request = 0x00
        case response = 0x01
        case event = 0x02
        case error = 0x04
    }

    /// Protocol constants.
    enum WireProtocol {
        /// Length of the frame header in bytes (4 bytes length + 1 byte type + 2 bytes method_id).
        static let headerLength = 7

        /// Maximum message payload length (1 MB).
        static let maxPayloadLength = 1_048_576
    }

    /// Extract complete messages from a stream buffer using the binary wire format.
    /// Returns an array of (messageType, methodId, payload) tuples for each complete message,
    /// and any remaining incomplete data.
    static func extractMessages(from buffer: Data) -> (messages: [(MessageType, UInt16, Data)], remainder: Data) {
        var messages: [(MessageType, UInt16, Data)] = []
        var offset = 0

        while offset + WireProtocol.headerLength <= buffer.count {
            // Read 4-byte big-endian message length (TOTAL frame size = header + payload)
            let msgLength = Int(buffer.withUnsafeBytes { ptr in
                UInt32(bigEndian: ptr.load(fromByteOffset: offset, as: UInt32.self))
            })

            // Validate: must be at least header length, at most header + maxPayload
            guard msgLength >= WireProtocol.headerLength,
                  msgLength <= WireProtocol.maxPayloadLength + WireProtocol.headerLength else {
                fputs("[supernode-vm] Invalid message length: \(msgLength), discarding byte\n", stderr)
                offset += 1
                continue
            }

            // msgLength IS the total frame length (Go wire.Encode semantics)
            guard offset + msgLength <= buffer.count else {
                // Incomplete message — wait for more data
                break
            }

            // Read message type (byte 4 in the frame)
            let msgTypeRaw = buffer[offset + 4]
            let msgType = MessageType(rawValue: msgTypeRaw)

            // Read 2-byte big-endian method ID (bytes 5-6)
            let methodId = buffer.withUnsafeBytes { ptr in
                UInt16(bigEndian: ptr.load(fromByteOffset: offset + 5, as: UInt16.self))
            }

            // Extract payload (everything after 7-byte header)
            let payloadStart = offset + WireProtocol.headerLength
            let payloadEnd = offset + msgLength
            let payload = buffer.subdata(in: payloadStart..<payloadEnd)

            if let type = msgType {
                messages.append((type, methodId, payload))
            } else {
                fputs("[supernode-vm] Unknown message type: \(msgTypeRaw)\n", stderr)
            }

            offset += msgLength
        }

        let remainder = buffer.subdata(in: offset..<buffer.count)
        return (messages, remainder)
    }

    /// Encode a message into the binary wire format.
    static func encodeMessage(type: MessageType, methodId: UInt16, payload: Data) -> Data {
        let totalLen = WireProtocol.headerLength + payload.count
        var data = Data(capacity: totalLen)

        // 4 bytes: TOTAL message length (big-endian), including header
        var length = UInt32(totalLen).bigEndian
        data.append(Data(bytes: &length, count: 4))

        // 1 byte: message type
        data.append(type.rawValue)

        // 2 bytes: method ID (big-endian)
        var mid = methodId.bigEndian
        data.append(Data(bytes: &mid, count: 2))

        // Payload
        data.append(payload)

        return data
    }

    /// Check if a JSON payload represents a "Ready" event from the guest agent.
    static func isReadyEvent(payload: Data) -> Bool {
        guard let json = try? JSONSerialization.jsonObject(with: payload) as? [String: Any] else {
            return false
        }
        return (json["type"] as? String) == "Ready"
    }

    /// Parse the "Ready" event and extract the timestamp if present.
    static func parseReadyEvent(payload: Data) -> (ready: Bool, timestamp: String?) {
        guard let json = try? JSONSerialization.jsonObject(with: payload) as? [String: Any] else {
            return (false, nil)
        }
        if (json["type"] as? String) == "Ready" {
            let timestamp = json["timestamp"] as? String
            return (true, timestamp)
        }
        return (false, nil)
    }

    /// Detect the guest IP address.
    ///
    /// On macOS with VZVirtualMachine, the guest uses NAT networking (VZNATNetworkDeviceAttachment).
    /// The guest IP can be found by:
    ///   1. Parsing the DHCP lease file (typically /var/db/dhcpd_leases on macOS)
    ///   2. Running `arp -a` and matching the VM's MAC address
    ///   3. Reading from the guest agent's "Ready" event which includes the IP
    ///
    /// This function returns the guest IP if detectable, or nil if the IP cannot be determined.
    static func detectGuestIP(guestMACAddress: String?) -> String? {
        // Method 1: Check the DHCP lease file
        let dhcpLeasePath = "/var/db/dhcpd_leases"
        if let leaseIP = readDHCPLease(path: dhcpLeasePath, macAddress: guestMACAddress) {
            return leaseIP
        }

        // Method 2: Run `arp -a` and match by MAC address
        if let arpIP = readARPTable(macAddress: guestMACAddress) {
            return arpIP
        }

        // The most reliable method is for the guest agent to report its IP
        // in the "Ready" event over vsock. This is handled in VmManager.
        return nil
    }

    /// Read the DHCP lease file to find a guest IP by MAC address.
    private static func readDHCPLease(path: String, macAddress: String?) -> String? {
        guard FileManager.default.fileExists(atPath: path),
              let content = try? String(contentsOfFile: path, encoding: .utf8) else {
            return nil
        }

        let leases = content.components(separatedBy: "}\n")
        for lease in leases {
            guard lease.contains("ip_address=") else { continue }

            if let mac = macAddress {
                guard lease.localizedCaseInsensitiveContains(mac) else { continue }
            }

            for line in lease.components(separatedBy: "\n") {
                let trimmed = line.trimmingCharacters(in: .whitespaces)
                if trimmed.hasPrefix("ip_address=") {
                    let ip = String(trimmed.dropFirst("ip_address=".count))
                    if isValidIPv4(ip) {
                        return ip
                    }
                }
            }
        }

        return nil
    }

    /// Read the ARP table to find a guest IP by MAC address.
    private static func readARPTable(macAddress: String?) -> String? {
        let process = Process()
        process.executableURL = URL(fileURLWithPath: "/usr/sbin/arp")
        process.arguments = ["-a"]

        let pipe = Pipe()
        process.standardOutput = pipe

        do {
            try process.run()
            process.waitUntilExit()
        } catch {
            return nil
        }

        let data = pipe.fileHandleForReading.readDataToEndOfFile()
        guard let output = String(data: data, encoding: .utf8) else { return nil }

        for line in output.components(separatedBy: "\n") {
            if let mac = macAddress, !line.localizedCaseInsensitiveContains(mac) {
                continue
            }

            if let parenStart = line.firstIndex(of: "("),
               let parenEnd = line[parenStart...].firstIndex(of: ")") {
                let ipStart = line.index(after: parenStart)
                let ip = String(line[ipStart..<parenEnd])
                if isValidIPv4(ip) {
                    return ip
                }
            }
        }

        return nil
    }

    /// Check if a string is a valid IPv4 address.
    private static func isValidIPv4(_ ip: String) -> Bool {
        let parts = ip.components(separatedBy: ".")
        guard parts.count == 4 else { return false }
        return parts.allSatisfy { part in
            guard let num = Int(part), num >= 0, num <= 255 else { return false }
            return true
        }
    }
}
