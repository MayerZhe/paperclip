// swift-tools-version:5.9
// SuperNodeVM — Swift CLI for managing VZVirtualMachine via JSON-RPC over stdin/stdout
//
// macOS 13+ required for VZVirtioSocketDevice API.
// Build: swift build -c release --arch arm64 --arch x86_64
// Output: .build/apple/Products/Release/supernode-vm

import PackageDescription

let package = Package(
    name: "SuperNodeVM",
    platforms: [
        .macOS(.v13),
    ],
    targets: [
        .executableTarget(
            name: "SuperNodeVM",
            path: "Sources/SuperNodeVM"
        ),
    ]
)
