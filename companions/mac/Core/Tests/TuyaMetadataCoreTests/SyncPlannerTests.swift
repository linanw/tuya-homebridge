import Foundation
import XCTest
@testable import TuyaMetadataCore

final class SyncPlannerTests: XCTestCase {
    private func source() throws -> MetadataSnapshot {
        let url = try XCTUnwrap(Bundle.module.url(forResource: "snapshot", withExtension: "json", subdirectory: "Fixtures"))
        return try MetadataSnapshot.decode(Data(contentsOf: url))
    }

    private func local(_ snapshot: MetadataSnapshot) -> LocalSnapshot {
        LocalSnapshot(homeID: "apple-home", name: "Apple Home", devices: [
            LocalDevice(id: "apple-device", name: snapshot.devices[0].name, roomID: "apple-room", serialNumber: "unique-serial")
        ], rooms: [LocalRoom(id: "apple-room", name: snapshot.rooms[0].name)])
    }

    private func bindings(_ snapshot: MetadataSnapshot) -> ProfileBindings {
        ProfileBindings(serverID: snapshot.serverId, homeKitHomeID: "apple-home", sourceHomeID: snapshot.homes[0].id,
            deviceBindings: [snapshot.devices[0].id: "apple-device"], roomBindings: [snapshot.rooms[0].id: "apple-room"])
    }

    private func nameID(_ snapshot: MetadataSnapshot) -> String { SyncPlanner.fieldID(.deviceName, sourceID: snapshot.devices[0].id) }
    private func roomID(_ snapshot: MetadataSnapshot) -> String { SyncPlanner.fieldID(.deviceRoom, sourceID: snapshot.devices[0].id) }

    func testCanonicalProtocolFixtureDecodesAndIgnoresFutureSnapshotFields() throws {
        let snapshot = try source()
        XCTAssertEqual(snapshot.schemaVersion, 1)
        XCTAssertTrue(snapshot.namesAuthoritative)
        XCTAssertEqual(snapshot.devices[0].roomStatus, .assigned)
        var json = try XCTUnwrap(JSONSerialization.jsonObject(with: JSONEncoder().encode(snapshot)) as? [String: Any])
        json["futureField"] = ["ignored": true]
        XCTAssertEqual(try MetadataSnapshot.decode(JSONSerialization.data(withJSONObject: json)), snapshot)
    }

    func testNoncanonicalRevisionsAndInvalidGraphReferencesAreRejected() throws {
        let original = try source()
        for revision in ["", "01", "-1", String(repeating: "1", count: 41)] {
            var invalid = original; invalid.revision = revision
            XCTAssertThrowsError(try invalid.validate())
        }
        var invalid = original; invalid.rooms[0].homeId = "missing-home"
        XCTAssertThrowsError(try invalid.validate())
        invalid = original; invalid.devices[0].roomId = "missing-room"
        XCTAssertThrowsError(try invalid.validate())
        invalid = original; invalid.devices[0].roomStatus = .unassigned
        XCTAssertThrowsError(try invalid.validate())
    }

    func testUnicodeNameLimitsPreserveScalarsAndCombiningCharacters() throws {
        for name in [String(repeating: "灯", count: 50), String(repeating: "💡", count: 40), "Cafe\u{301}", "家👨‍👩‍👧"] {
            XCTAssertNoThrow(try NamePolicy.validate(name))
        }
        for name in ["", " \t ", "bad\u{0}name", "bad\u{7f}name", String(repeating: "x", count: 51), String(repeating: "💡", count: 41)] {
            XCTAssertThrowsError(try NamePolicy.validate(name))
        }
    }

    func testInitialExactAgreementIsTheOnlyAutomaticBaselineCandidate() throws {
        let snapshot = try source(); let local = self.local(snapshot); let profile = bindings(snapshot)
        let plan = SyncPlanner.plan(snapshot: snapshot, local: local, bindings: profile, baselines: [:])
        XCTAssertTrue(plan.changes.isEmpty); XCTAssertTrue(plan.conflicts.isEmpty)
        XCTAssertEqual(plan.agreements.count, 3)
        XCTAssertEqual(plan.agreements[nameID(snapshot)], FieldBaseline(sourceValue: snapshot.devices[0].name, localValue: local.devices[0].name))
        XCTAssertEqual(plan.baselineCandidates, plan.agreements)
    }

    func testDifferentInitialNamesRequireExplicitResolution() throws {
        let snapshot = try source(); var local = self.local(snapshot); let profile = bindings(snapshot)
        local.devices[0].name = "Apple alias"
        let plan = SyncPlanner.plan(snapshot: snapshot, local: local, bindings: profile, baselines: [:])
        XCTAssertTrue(plan.changes.isEmpty)
        XCTAssertEqual(plan.conflicts.first?.reason, "missing_baseline")
        XCTAssertNil(plan.agreements[nameID(snapshot)])
        let keepTuya = try SyncPlanner.resolve(fieldID: nameID(snapshot), preferSource: true, snapshot: snapshot, local: local, bindings: profile)
        XCTAssertEqual(keepTuya.direction, .toLocal); XCTAssertEqual(keepTuya.value, snapshot.devices[0].name)
        XCTAssertEqual(keepTuya.expectedLocal, "Apple alias")
        let keepApple = try SyncPlanner.resolve(fieldID: nameID(snapshot), preferSource: false, snapshot: snapshot, local: local, bindings: profile)
        XCTAssertEqual(keepApple.direction, .toSource); XCTAssertEqual(keepApple.value, "Apple alias")
    }

    func testOneSidedSourceRenamePlansLocalWriteWithoutAdvancingBaseline() throws {
        var snapshot = try source(); let local = self.local(snapshot); let profile = bindings(snapshot)
        let id = nameID(snapshot)
        let baseline = [id: FieldBaseline(sourceValue: snapshot.devices[0].name, localValue: local.devices[0].name)]
        snapshot.devices[0].name = "Tuya changed"
        let plan = SyncPlanner.plan(snapshot: snapshot, local: local, bindings: profile, baselines: baseline)
        XCTAssertEqual(plan.changes.count, 1); XCTAssertEqual(plan.changes[0].direction, .toLocal)
        XCTAssertEqual(plan.changes[0].expectedSource, "Tuya changed")
        XCTAssertEqual(plan.changes[0].expectedLocal, local.devices[0].name)
        XCTAssertNil(plan.agreements[id], "a planned command is not a confirmed agreement")
    }

    func testOneSidedLocalRenamePlansCloudWriteOnlyWithCapability() throws {
        let snapshot = try source(); var local = self.local(snapshot); let profile = bindings(snapshot)
        let baseline = [nameID(snapshot): FieldBaseline(sourceValue: snapshot.devices[0].name, localValue: local.devices[0].name)]
        local.devices[0].name = "Apple changed"
        let plan = SyncPlanner.plan(snapshot: snapshot, local: local, bindings: profile, baselines: baseline)
        XCTAssertEqual(plan.changes.count, 1); XCTAssertEqual(plan.changes[0].direction, .toSource)
        XCTAssertEqual(plan.changes[0].value, "Apple changed")
        XCTAssertNil(plan.agreements[nameID(snapshot)])
    }

    func testDivergentChangesConflictAndEqualChangesConverge() throws {
        var snapshot = try source(); var local = self.local(snapshot); let profile = bindings(snapshot)
        let baseline = [nameID(snapshot): FieldBaseline(sourceValue: snapshot.devices[0].name, localValue: local.devices[0].name)]
        snapshot.devices[0].name = "Tuya changed"; local.devices[0].name = "Apple changed"
        var plan = SyncPlanner.plan(snapshot: snapshot, local: local, bindings: profile, baselines: baseline)
        XCTAssertTrue(plan.changes.isEmpty); XCTAssertEqual(plan.conflicts.first?.reason, "divergent_changes")
        local.devices[0].name = "Tuya changed"
        plan = SyncPlanner.plan(snapshot: snapshot, local: local, bindings: profile, baselines: baseline)
        XCTAssertTrue(plan.changes.isEmpty); XCTAssertTrue(plan.conflicts.isEmpty)
        XCTAssertEqual(plan.agreements[nameID(snapshot)]?.sourceValue, "Tuya changed")
    }

    func testUnsupportedCloudWritesStayBlockedButFollowingSourceRemainsPossible() throws {
        var snapshot = try source(); var local = self.local(snapshot); let profile = bindings(snapshot)
        let baseline = [nameID(snapshot): FieldBaseline(sourceValue: snapshot.devices[0].name, localValue: local.devices[0].name)]
        snapshot.capabilities.renameDevice = false; local.devices[0].name = "Apple changed"
        let plan = SyncPlanner.plan(snapshot: snapshot, local: local, bindings: profile, baselines: baseline)
        XCTAssertTrue(plan.changes.isEmpty)
        XCTAssertEqual(plan.conflicts.first?.canUseLocal, false)
        XCTAssertEqual(plan.conflicts.first?.canUseSource, true)
        XCTAssertThrowsError(try SyncPlanner.resolve(fieldID: nameID(snapshot), preferSource: false, snapshot: snapshot, local: local, bindings: profile))
        XCTAssertNoThrow(try SyncPlanner.resolve(fieldID: nameID(snapshot), preferSource: true, snapshot: snapshot, local: local, bindings: profile))
    }

    func testPartialRoomInformationDisablesOnlyRoomPlanning() throws {
        var snapshot = try source(); let local = self.local(snapshot); let profile = bindings(snapshot)
        let baseline = [nameID(snapshot): FieldBaseline(sourceValue: snapshot.devices[0].name, localValue: local.devices[0].name)]
        snapshot.devices[0].name = "Name still authoritative"
        snapshot.roomsAvailable = false; snapshot.homes = []; snapshot.rooms = []
        snapshot.devices[0].homeId = nil; snapshot.devices[0].roomId = nil; snapshot.devices[0].roomStatus = .unknown
        let plan = SyncPlanner.plan(snapshot: snapshot, local: local, bindings: profile, baselines: baseline)
        XCTAssertTrue(plan.blockedReasons.isEmpty)
        XCTAssertEqual(plan.changes.count, 1); XCTAssertEqual(plan.changes[0].field, .deviceName)
        XCTAssertTrue(plan.agreements.isEmpty)
    }

    func testSourceIdentityLocalHomeAndExplicitBindingsAreRequired() throws {
        var snapshot = try source(); let local = self.local(snapshot); var profile = bindings(snapshot)
        profile.serverID = UUID().uuidString
        XCTAssertEqual(SyncPlanner.plan(snapshot: snapshot, local: local, bindings: profile, baselines: [:]).blockedReasons, ["wrong_source"])
        profile = bindings(snapshot); profile.homeKitHomeID = "other-apple-home"
        XCTAssertEqual(SyncPlanner.plan(snapshot: snapshot, local: local, bindings: profile, baselines: [:]).blockedReasons, ["wrong_source"])
        profile = bindings(snapshot); profile.deviceBindings = [:]
        let unbound = SyncPlanner.plan(snapshot: snapshot, local: local, bindings: profile, baselines: [:])
        XCTAssertFalse(unbound.agreements.keys.contains(nameID(snapshot)), "matching names are not identity proof")
        snapshot.sourceKind = "unimplemented-authentication-model"
        XCTAssertEqual(SyncPlanner.plan(snapshot: snapshot, local: local, bindings: profile, baselines: [:]).blockedReasons, ["unsupported_source"])
    }

    func testDuplicateDeviceBindingsCannotTargetOneLocalAccessoryTwice() throws {
        let snapshot = try source(); let local = self.local(snapshot); var profile = bindings(snapshot)
        profile.deviceBindings["another-source-device"] = "apple-device"
        XCTAssertEqual(SyncPlanner.plan(snapshot: snapshot, local: local, bindings: profile, baselines: [:]).blockedReasons, ["ambiguous_binding"])
    }

    func testCustomNamesOnlyProfileDoesNotInventAnAppHome() throws {
        var snapshot = try source(); var local = self.local(snapshot)
        snapshot.sourceKind = "tuya-project-custom"; snapshot.roomsAvailable = false
        snapshot.homes = []; snapshot.rooms = []; snapshot.devices[0].homeId = nil
        snapshot.devices[0].roomId = nil; snapshot.devices[0].roomStatus = .unsupported
        local.devices[0].name = "Local name"
        var profile = ProfileBindings(serverID: snapshot.serverId, homeKitHomeID: local.homeID,
            deviceNameOnly: true, deviceBindings: [snapshot.devices[0].id: local.devices[0].id])
        XCTAssertEqual(SyncPlanner.plan(snapshot: snapshot, local: local, bindings: profile, baselines: [:]).conflicts.count, 1)
        profile.deviceNameOnly = false
        XCTAssertEqual(SyncPlanner.plan(snapshot: snapshot, local: local, bindings: profile, baselines: [:]).blockedReasons, ["missing_home_binding"])
    }

    func testRoomChangesUseCommonSourceIDsButNativeLocalExpectedValues() throws {
        var snapshot = try source(); var local = self.local(snapshot); var profile = bindings(snapshot)
        snapshot.capabilities.moveDevice = true
        let oldRoom = snapshot.rooms[0].id
        let secondRoom = "r_" + String(repeating: "d", count: 64)
        snapshot.rooms.append(SourceRoom(id: secondRoom, homeId: snapshot.homes[0].id, name: "Kitchen"))
        local.rooms.append(LocalRoom(id: "apple-kitchen", name: "Kitchen"))
        profile.roomBindings[secondRoom] = "apple-kitchen"
        let baseline = [roomID(snapshot): FieldBaseline(sourceValue: oldRoom, localValue: oldRoom)]
        snapshot.devices[0].roomId = secondRoom
        var plan = SyncPlanner.plan(snapshot: snapshot, local: local, bindings: profile, baselines: baseline)
        var movement = try XCTUnwrap(plan.changes.first(where: { $0.field == .deviceRoom }))
        XCTAssertEqual(movement.direction, .toLocal); XCTAssertEqual(movement.value, "apple-kitchen")
        XCTAssertEqual(movement.expectedSource, secondRoom); XCTAssertEqual(movement.expectedLocal, "apple-room")
        snapshot.devices[0].roomId = oldRoom; local.devices[0].roomID = "apple-kitchen"
        plan = SyncPlanner.plan(snapshot: snapshot, local: local, bindings: profile, baselines: baseline)
        movement = try XCTUnwrap(plan.changes.first(where: { $0.field == .deviceRoom }))
        XCTAssertEqual(movement.direction, .toSource); XCTAssertEqual(movement.value, secondRoom)
        XCTAssertEqual(movement.expectedLocal, "apple-kitchen")
    }

    func testUnboundRoomAndUnassignmentNeverBecomeAutomaticLocalMoves() throws {
        var snapshot = try source(); var local = self.local(snapshot); let profile = bindings(snapshot)
        let baseline = [roomID(snapshot): FieldBaseline(sourceValue: snapshot.rooms[0].id, localValue: snapshot.rooms[0].id)]
        local.devices[0].roomID = "unbound-room"
        var plan = SyncPlanner.plan(snapshot: snapshot, local: local, bindings: profile, baselines: baseline)
        XCTAssertTrue(plan.changes.isEmpty)
        XCTAssertEqual(plan.conflicts.first?.reason, "missing_room_binding")
        XCTAssertEqual(plan.conflicts.first?.expectedLocal, "unbound-room")
        local = self.local(snapshot); snapshot.devices[0].roomStatus = .unassigned; snapshot.devices[0].roomId = nil
        plan = SyncPlanner.plan(snapshot: snapshot, local: local, bindings: profile, baselines: baseline)
        XCTAssertTrue(plan.changes.isEmpty)
        XCTAssertEqual(plan.conflicts.first?.canUseSource, false)
    }

    func testKnownProjectionRequiresRecordedFullSourceAndLocalValues() throws {
        var snapshot = try source(); var local = self.local(snapshot); var profile = bindings(snapshot)
        let full = String(repeating: "灯", count: 40)
        let short = String(repeating: "灯", count: 21)
        snapshot.devices[0].name = full; local.devices[0].name = short
        var plan = SyncPlanner.plan(snapshot: snapshot, local: local, bindings: profile, baselines: [:])
        XCTAssertNil(plan.agreements[nameID(snapshot)], "a coincidental prefix is not projection provenance")
        profile.nameProjections[snapshot.devices[0].id] = NameProjection(sourceValue: full, localValue: short)
        plan = SyncPlanner.plan(snapshot: snapshot, local: local, bindings: profile, baselines: [:])
        XCTAssertTrue(plan.conflicts.isEmpty); XCTAssertTrue(plan.changes.isEmpty)
        XCTAssertEqual(plan.agreements[nameID(snapshot)], FieldBaseline(sourceValue: full, localValue: short))
        snapshot.devices[0].name = String(repeating: "灯", count: 39) + "光"
        plan = SyncPlanner.plan(snapshot: snapshot, local: local, bindings: profile, baselines: [:])
        XCTAssertNil(plan.agreements[nameID(snapshot)])
    }

    func testDistinctUnicodeScalarSequencesAreNotSilentlyNormalized() throws {
        var snapshot = try source(); var local = self.local(snapshot); let profile = bindings(snapshot)
        snapshot.devices[0].name = "Caf\u{e9}"; local.devices[0].name = "Cafe\u{301}"
        let plan = SyncPlanner.plan(snapshot: snapshot, local: local, bindings: profile, baselines: [:])
        XCTAssertNil(plan.agreements[nameID(snapshot)])
        XCTAssertEqual(plan.conflicts.first?.reason, "missing_baseline")
    }

    func testUnavailableNamesNeverPlanOrAdvanceBaselines() throws {
        var snapshot = try source(); let local = self.local(snapshot); let profile = bindings(snapshot)
        snapshot.available = false
        let plan = SyncPlanner.plan(snapshot: snapshot, local: local, bindings: profile, baselines: [:])
        XCTAssertTrue(plan.changes.isEmpty); XCTAssertTrue(plan.agreements.isEmpty)
        XCTAssertEqual(plan.blockedReasons, ["source_unavailable"])
    }
}
