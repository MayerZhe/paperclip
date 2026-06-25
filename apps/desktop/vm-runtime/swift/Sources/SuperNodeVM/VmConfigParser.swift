import Foundation
import Virtualization

// VmConfigParser — validates and converts JSON config to VZVirtualMachineConfiguration.
//
// Expected JSON params for "start" method:
// {
//   "kernelPath": "/path/to/vmlinuz",
//   "initrdPath": "/path/to/initramfs",
//   "rootfsImage": "/path/to/rootfs.img",
//   "sessionImage": "/path/to/session.img",
//   "agentImage": "/path/to/agent.img",
//   "memoryMB": 2048,
//   "cpuCount": 2,
//   "vsockPort": 1024
// }

struct VmConfig {
    let kernelPath: String
    let initrdPath: String?
    let rootfsImage: String
    let sessionImage: String
    let agentImage: String?
    let memoryBytes: UInt64
    let cpuCount: Int
    let vsockPort: UInt32

    // Derived disk image paths
    var diskImagePaths: [String] {
        var paths = [rootfsImage, sessionImage]
        if let agent = agentImage { paths.append(agent) }
        return paths
    }
}

enum VmConfigParseError: Error, CustomStringConvertible {
    case missingField(String)
    case invalidValue(String)
    case fileNotFound(String)

    var description: String {
        switch self {
        case .missingField(let field):
            return "Missing required field: \(field)"
        case .invalidValue(let message):
            return "Invalid value: \(message)"
        case .fileNotFound(let path):
            return "File not found: \(path)"
        }
    }
}

struct VmConfigParser {

    /// Parse VM configuration from a JSON-RPC params value.
    /// Returns `.success(VmConfig)` on valid input, `.failure(VmConfigParseError)` otherwise.
    static func parse(json: JsonRpcValue) -> Result<VmConfig, VmConfigParseError> {
        guard let dict = json.dictionaryValue else {
            return .failure(.invalidValue("params must be a JSON object"))
        }

        // ── Required fields ──

        guard let kernelPath = dict["kernelPath"]?.stringValue, !kernelPath.isEmpty else {
            return .failure(.missingField("kernelPath"))
        }

        guard let rootfsImage = dict["rootfsImage"]?.stringValue, !rootfsImage.isEmpty else {
            return .failure(.missingField("rootfsImage"))
        }

        guard let sessionImage = dict["sessionImage"]?.stringValue, !sessionImage.isEmpty else {
            return .failure(.missingField("sessionImage"))
        }

        // ── Optional fields with defaults ──

        let initrdPath = dict["initrdPath"]?.stringValue
        let agentImage = dict["agentImage"]?.stringValue

        let memoryMB = dict["memoryMB"]?.numberValue ?? 2048
        guard memoryMB >= 512 && memoryMB <= 65536 else {
            return .failure(.invalidValue("memoryMB must be between 512 and 65536, got \(memoryMB)"))
        }

        let cpuCount = dict["cpuCount"]?.numberValue.flatMap(Int.init) ?? 2
        guard cpuCount >= 1 && cpuCount <= 64 else {
            return .failure(.invalidValue("cpuCount must be between 1 and 64, got \(cpuCount)"))
        }

        let vsockPort = dict["vsockPort"]?.numberValue.flatMap(UInt32.init) ?? 1024
        guard vsockPort > 0 && vsockPort <= 65535 else {
            return .failure(.invalidValue("vsockPort must be between 1 and 65535, got \(vsockPort)"))
        }

        // ── Validate file existence ──

        let fm = FileManager.default
        guard fm.fileExists(atPath: kernelPath) else {
            return .failure(.fileNotFound(kernelPath))
        }
        guard fm.fileExists(atPath: rootfsImage) else {
            return .failure(.fileNotFound(rootfsImage))
        }
        guard fm.fileExists(atPath: sessionImage) else {
            return .failure(.fileNotFound(sessionImage))
        }
        if let initrd = initrdPath, !initrd.isEmpty {
            guard fm.fileExists(atPath: initrd) else {
                return .failure(.fileNotFound(initrd))
            }
        }
        if let agent = agentImage, !agent.isEmpty {
            guard fm.fileExists(atPath: agent) else {
                return .failure(.fileNotFound(agent))
            }
        }

        return .success(VmConfig(
            kernelPath: kernelPath,
            initrdPath: initrdPath,
            rootfsImage: rootfsImage,
            sessionImage: sessionImage,
            agentImage: agentImage,
            memoryBytes: UInt64(memoryMB) * 1024 * 1024,
            cpuCount: Int(cpuCount),
            vsockPort: UInt32(vsockPort)
        ))
    }

    /// Build a VZVirtualMachineConfiguration from a parsed VmConfig.
    /// Throws on configuration errors (invalid images, unsupported hardware, etc.).
    static func buildConfiguration(from config: VmConfig) throws -> VZVirtualMachineConfiguration {
        let vzConfig = VZVirtualMachineConfiguration()

        // ── CPU count ──
        vzConfig.cpuCount = max(1, min(config.cpuCount, VZVirtualMachineConfiguration.maximumAllowedCPUCount))

        // ── Memory ──
        vzConfig.memorySize = min(config.memoryBytes, VZVirtualMachineConfiguration.maximumAllowedMemorySize)

        // ── Boot loader: Linux kernel + optional initrd ──
        // Note: macOS 26 (SDK 15.2+) removed `initialRamdiskURL` from the
        // VZLinuxBootLoader initializer.  The initrd is now set via the
        // `.initialRamdiskURL` property after construction.
        let kernelURL = URL(fileURLWithPath: config.kernelPath)
        let bootLoader = VZLinuxBootLoader(kernelURL: kernelURL)
        if let initrdPath = config.initrdPath, !initrdPath.isEmpty {
            let initrdURL = URL(fileURLWithPath: initrdPath)
            bootLoader.initialRamdiskURL = initrdURL
        }
        // Set kernel command line for vsock and console
        bootLoader.commandLine = "console=hvc0 earlyprintk=serial"
        vzConfig.bootLoader = bootLoader

        // ── Storage devices: VZVirtioBlockDeviceConfiguration for each disk image ──
        // Attach order: rootfs (read-only), session (read-write), agent (read-only)
        var blockDevices: [VZVirtioBlockDeviceConfiguration] = []

        // Rootfs — read-only
        let rootfsAttachment = try VZDiskImageStorageDeviceAttachment(
            url: URL(fileURLWithPath: config.rootfsImage),
            readOnly: true
        )
        blockDevices.append(VZVirtioBlockDeviceConfiguration(attachment: rootfsAttachment))

        // Session — read-write
        let sessionAttachment = try VZDiskImageStorageDeviceAttachment(
            url: URL(fileURLWithPath: config.sessionImage),
            readOnly: false
        )
        blockDevices.append(VZVirtioBlockDeviceConfiguration(attachment: sessionAttachment))

        // Agent image (optional) — read-only
        if let agentPath = config.agentImage, !agentPath.isEmpty {
            let agentAttachment = try VZDiskImageStorageDeviceAttachment(
                url: URL(fileURLWithPath: agentPath),
                readOnly: true
            )
            blockDevices.append(VZVirtioBlockDeviceConfiguration(attachment: agentAttachment))
        }

        vzConfig.storageDevices = blockDevices

        // ── Entropy device ──
        vzConfig.entropyDevices = [VZVirtioEntropyDeviceConfiguration()]

        // ── Serial port: guest console to host stderr ──
        // macOS 26 SDK: VZFileHandleSerialPortAttachment rejects
        // FileHandle.standardInput as a reading handle.  We pass nil for
        // reading (guest serial input not needed) and stderr for writing
        // so kernel messages are visible in the host's log stream.
        let serialPort = VZVirtioConsoleDeviceSerialPortConfiguration()
        let serialAttachment = VZFileHandleSerialPortAttachment(
            fileHandleForReading: nil,
            fileHandleForWriting: FileHandle.standardError
        )
        serialPort.attachment = serialAttachment
        vzConfig.serialPorts = [serialPort]

        // ── Network: virtio (NAT) for internet access ──
        let networkDevice = VZVirtioNetworkDeviceConfiguration()
        networkDevice.attachment = VZNATNetworkDeviceAttachment()
        vzConfig.networkDevices = [networkDevice]

        // ── Socket device: VZVirtioSocketDevice for vsock (Guest CID=3) ──
        let socketDevice = VZVirtioSocketDeviceConfiguration()
        vzConfig.socketDevices = [socketDevice]

        // ── Validate ──
        try vzConfig.validate()

        return vzConfig
    }
}
