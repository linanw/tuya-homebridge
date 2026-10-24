import Foundation
#if canImport(FoundationNetworking)
import FoundationNetworking
#endif
#if canImport(Darwin)
import Darwin
#elseif canImport(Glibc)
import Glibc
#endif
import XCTest
@testable import TuyaMetadataCore

private final class LoopbackMetadataFixture {
    static let token = "SYNTHETIC-XCTEST-SESSION-TOKEN-0123456789"
    let process: Process
    let directory: URL
    let root: URL

    init() throws {
        let environmentPath = ProcessInfo.processInfo.environment["PATH"] ?? ""
        let search = environmentPath.split(separator: ":").map(String.init) + ["/usr/bin", "/usr/local/bin", "/opt/homebrew/bin"]
        guard let python = search.map({ URL(fileURLWithPath: $0).appendingPathComponent("python3") })
            .first(where: { FileManager.default.isExecutableFile(atPath: $0.path) }) else {
            throw XCTSkip("Python 3 is unavailable for the loopback HTTP fixture.")
        }
        guard let script = Bundle.module.url(forResource: "http_server", withExtension: "py", subdirectory: "Fixtures"),
              let snapshot = Bundle.module.url(forResource: "snapshot", withExtension: "json", subdirectory: "Fixtures") else {
            throw MetadataError.invalidResponse
        }
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent("tuya-http-xctest-" + UUID().uuidString, isDirectory: true)
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true,
                                                attributes: [.posixPermissions: 0o700])
        let info = directory.appendingPathComponent("server.json")
        let process = Process()
        process.executableURL = python
        process.arguments = ["-u", script.path, info.path, snapshot.path]
        process.standardOutput = FileHandle.nullDevice
        process.standardError = FileHandle.nullDevice
        do { try process.run() }
        catch {
            try? FileManager.default.removeItem(at: directory)
            throw MetadataError.network
        }
        let deadline = Date().addingTimeInterval(4)
        var port: Int?
        while process.isRunning && Date() < deadline {
            if let data = try? Data(contentsOf: info),
               let json = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any],
               let value = json["port"] as? Int, (1...65535).contains(value) {
                port = value; break
            }
            Thread.sleep(forTimeInterval: 0.01)
        }
        guard let port, let url = URL(string: "http://127.0.0.1:\(port)") else {
            if process.isRunning { process.terminate() }
            try? FileManager.default.removeItem(at: directory)
            throw MetadataError.network
        }
        self.process = process
        self.directory = directory
        root = url
    }

    deinit { stop() }

    func stop() {
        if process.isRunning {
            process.terminate()
            let deadline = Date().addingTimeInterval(2)
            while process.isRunning && Date() < deadline { Thread.sleep(forTimeInterval: 0.01) }
            if process.isRunning { _ = kill(process.processIdentifier, SIGKILL) }
        }
        if !process.isRunning { process.waitUntilExit() }
        try? FileManager.default.removeItem(at: directory)
    }

    func client(_ prefix: String) throws -> MetadataHTTPClient {
        try MetadataHTTPClient(address: ServerAddress(root.appendingPathComponent(prefix).absoluteString), token: Self.token)
    }

    func state() async throws -> [String: Any] {
        var request = URLRequest(url: root.appendingPathComponent("fixture/state"))
        request.timeoutInterval = 3
        let (data, response) = try await URLSession.shared.data(for: request)
        guard (response as? HTTPURLResponse)?.statusCode == 200,
              let value = try JSONSerialization.jsonObject(with: data) as? [String: Any] else {
            throw MetadataError.invalidResponse
        }
        return value
    }
}

final class MetadataHTTPClientTests: XCTestCase {
    func testTypedReadsAndQueuedCommandUseBearerHeadersAndExactlyOnePOST() async throws {
        let fixture = try LoopbackMetadataFixture(); defer { fixture.stop() }
        let client = try fixture.client("ok")
        let capabilities = try await client.capabilities()
        let snapshot = try await client.snapshot()
        XCTAssertEqual(capabilities.serverId, snapshot.serverId)
        XCTAssertEqual(capabilities.sourceEpoch, snapshot.sourceEpoch)
        XCTAssertTrue(capabilities.capabilities.renameDevice)
        let command = try MetadataCommand(snapshot: snapshot, operation: .deviceRename(
            targetId: try XCTUnwrap(snapshot.devices.first?.id), name: "完整名称 💡"))
        let accepted = try await client.submit(command)
        XCTAssertEqual(accepted.commandId, command.commandId)
        XCTAssertEqual(accepted.status, .queued)
        XCTAssertNil(accepted.snapshot)
        let confirmed = try await client.awaitReceipt(accepted, serverID: snapshot.serverId,
                                                       sourceEpoch: snapshot.sourceEpoch, timeout: 8)
        XCTAssertEqual(confirmed.commandId, command.commandId)
        XCTAssertEqual(confirmed.status, .confirmed)
        XCTAssertEqual(confirmed.snapshot?.devices.first?.name, "完整名称 💡")
        let state = try await fixture.state()
        XCTAssertEqual(state["posts"] as? Int, 1)
        XCTAssertEqual(state["receiptGets"] as? Int, 1)
        XCTAssertEqual(state["lastCommandId"] as? String, command.commandId)
        XCTAssertEqual(state["lastOperationType"] as? String, "device.rename")
        XCTAssertEqual(state["lastExpectedRevision"] as? String, snapshot.revision)
        XCTAssertEqual(state["authorizationValid"] as? Bool, true)
        XCTAssertEqual(state["jsonAcceptValid"] as? Bool, true)
        XCTAssertEqual(state["jsonContentTypeValid"] as? Bool, true)
    }

    func testRedirectsAreRejectedWithoutContactingTheTarget() async throws {
        let fixture = try LoopbackMetadataFixture(); defer { fixture.stop() }
        for status in [301, 302] {
            let client = try fixture.client("redirect\(status)")
            do {
                _ = try await client.snapshot()
                XCTFail("A metadata redirect must not be followed.")
            } catch let error as MetadataError {
                XCTAssertEqual(error, .http(status))
            } catch {
                XCTFail("Expected a safe typed redirect rejection.")
            }
        }
        let state = try await fixture.state()
        XCTAssertEqual(state["redirectTargets"] as? Int, 0)
        XCTAssertEqual(state["posts"] as? Int, 0)
    }

    func testOversizedContentLengthAndChunkedResponsesAreRejectedAtFourMiB() async throws {
        let fixture = try LoopbackMetadataFixture(); defer { fixture.stop() }
        for prefix in ["oversize", "chunked"] {
            let client = try fixture.client(prefix)
            do {
                _ = try await client.snapshot()
                XCTFail("An oversized response must be rejected before decoding.")
            } catch let error as MetadataError {
                XCTAssertEqual(error, .responseTooLarge)
            } catch {
                XCTFail("Expected a safe typed response-size rejection.")
            }
        }
        let state = try await fixture.state()
        XCTAssertEqual(state["posts"] as? Int, 0)
    }
}
