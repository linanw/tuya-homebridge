// swift-tools-version: 5.9
import PackageDescription

let package = Package(
    name: "TuyaMetadataCore",
    platforms: [.macOS(.v13), .iOS(.v17), .macCatalyst(.v17)],
    products: [.library(name: "TuyaMetadataCore", targets: ["TuyaMetadataCore"])],
    targets: [
        .target(name: "TuyaMetadataCore"),
        .testTarget(name: "TuyaMetadataCoreTests", dependencies: ["TuyaMetadataCore"],
                    resources: [.copy("Fixtures")])
    ]
)
