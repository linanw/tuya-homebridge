import Foundation
import XCTest
@testable import TuyaMetadataCore

final class ConnectionPolicyTests: XCTestCase {
    private func source() throws -> MetadataSnapshot {
        let url = try XCTUnwrap(Bundle.module.url(forResource: "snapshot", withExtension: "json", subdirectory: "Fixtures"))
        return try MetadataSnapshot.decode(Data(contentsOf: url))
    }

    func testHTTPSAndExactLoopbackAreTheOnlySupportedAddresses() throws {
        for address in ["https://example.test", "http://localhost:8787", "http://127.0.0.1:8787", "http://[::1]:8787"] {
            XCTAssertNoThrow(try ServerAddress(address))
        }
        for address in ["http://example.test", "http://127.0.0.2", "http://localhost.example.test", "http://2130706433", "ftp://localhost"] {
            XCTAssertThrowsError(try ServerAddress(address))
        }
    }

    func testAddressRejectsCredentialURLsQueryFragmentsAndTraversal() throws {
        for address in ["https://user:secret@example.test", "https://example.test?token=secret", "https://example.test#secret",
                        "https://example.test/a/../b", "https://example.test:0", "https://example.test:65536"] {
            XCTAssertThrowsError(try ServerAddress(address))
        }
        let address = try ServerAddress("https://example.test:443/proxy/")
        XCTAssertEqual(address.endpoint("v1/metadata").absoluteString, "https://example.test/proxy/v1/metadata")
    }

    func testBearerTokenPolicyRejectsShortOrHeaderInjectingValues() throws {
        XCTAssertNoThrow(try ServerAddress.validateToken(String(repeating: "a", count: 32)))
        for token in ["short", String(repeating: "a", count: 32) + "\nInjected: true", String(repeating: "a", count: 32) + " ", String(repeating: "密", count: 32)] {
            XCTAssertThrowsError(try ServerAddress.validateToken(token))
        }
    }

    func testOperationsRejectUnknownFieldsAndCapabilitiesRemainExplicit() throws {
        let bad = Data("{\"type\":\"device.rename\",\"targetId\":\"device\",\"name\":\"Name\",\"url\":\"https://example.test\"}".utf8)
        XCTAssertThrowsError(try JSONDecoder().decode(MetadataOperation.self, from: bad))
        let snapshot = try source()
        XCTAssertFalse(MetadataOperation.deviceMove(targetId: snapshot.devices[0].id, roomId: snapshot.rooms[0].id).isSupported(by: snapshot))
        let command = try MetadataCommand(snapshot: snapshot, operation: .deviceRename(targetId: snapshot.devices[0].id, name: "书房 💡"))
        let encoded = try JSONEncoder().encode(command)
        XCTAssertEqual(try JSONDecoder().decode(MetadataCommand.self, from: encoded), command)
        let json = try XCTUnwrap(JSONSerialization.jsonObject(with: encoded) as? [String: Any])
        XCTAssertEqual(Set(json.keys), Set(["schemaVersion", "commandId", "expected", "operation"]))
        let expected = try XCTUnwrap(json["expected"] as? [String: String])
        XCTAssertEqual(expected["sourceEpoch"], snapshot.sourceEpoch)
        XCTAssertEqual(expected["revision"], snapshot.revision)
        var unknownOuter = json; unknownOuter["url"] = "https://example.test"
        XCTAssertThrowsError(try JSONDecoder().decode(MetadataCommand.self,
            from: JSONSerialization.data(withJSONObject: unknownOuter)))
        var unknownExpected = json; var extraExpected = expected; extraExpected["token"] = "not-a-command-field"
        unknownExpected["expected"] = extraExpected
        XCTAssertThrowsError(try JSONDecoder().decode(MetadataCommand.self,
            from: JSONSerialization.data(withJSONObject: unknownExpected)))
    }

    func testPendingAndUncertainReceiptsNeverBecomeConfirmedWithoutAuthoritativeSnapshot() throws {
        let snapshot = try source(); let id = UUID().uuidString.lowercased()
        var receipt = CommandReceipt(schemaVersion: 1, commandId: id, status: .queued, code: nil, snapshot: nil)
        XCTAssertFalse(receipt.status.isTerminal)
        XCTAssertNoThrow(try receipt.validate(commandId: id, serverId: snapshot.serverId, sourceEpoch: snapshot.sourceEpoch))
        receipt.status = .uncertain
        XCTAssertTrue(receipt.status.isTerminal)
        receipt.status = .confirmed
        XCTAssertThrowsError(try receipt.validate(commandId: id, serverId: snapshot.serverId, sourceEpoch: snapshot.sourceEpoch))
        receipt.snapshot = snapshot
        XCTAssertNoThrow(try receipt.validate(commandId: id, serverId: snapshot.serverId, sourceEpoch: snapshot.sourceEpoch))
        XCTAssertThrowsError(try receipt.validate(commandId: UUID().uuidString, serverId: snapshot.serverId))
        XCTAssertThrowsError(try receipt.validate(commandId: id, serverId: UUID().uuidString))
        XCTAssertThrowsError(try receipt.validate(commandId: id, serverId: snapshot.serverId, sourceEpoch: UUID().uuidString))
    }
}
