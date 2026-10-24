import Foundation

public struct LocalDevice: Codable, Equatable, Identifiable, Sendable {
    public var id: String
    public var name: String
    public var roomID: String?
    public var serialNumber: String?
    public init(id: String, name: String, roomID: String? = nil, serialNumber: String? = nil) {
        self.id = id; self.name = name; self.roomID = roomID; self.serialNumber = serialNumber
    }
}

public struct LocalRoom: Codable, Equatable, Identifiable, Sendable {
    public var id: String
    public var name: String
    public init(id: String, name: String) { self.id = id; self.name = name }
}

public struct LocalSnapshot: Codable, Equatable, Sendable {
    public var homeID: String
    public var name: String
    public var devices: [LocalDevice]
    public var rooms: [LocalRoom]
    public init(homeID: String, name: String = "", devices: [LocalDevice], rooms: [LocalRoom]) {
        self.homeID = homeID; self.name = name; self.devices = devices; self.rooms = rooms
    }
}

/// Recorded provenance, never inferred from a coincidental name prefix.
public struct NameProjection: Codable, Equatable, Sendable {
    public var sourceValue: String
    public var localValue: String
    public init(sourceValue: String, localValue: String) {
        self.sourceValue = sourceValue; self.localValue = localValue
    }
}

public struct ProfileBindings: Codable, Equatable, Sendable {
    public var serverID: String
    public var homeKitHomeID: String
    public var sourceHomeID: String?
    public var deviceNameOnly: Bool
    public var deviceBindings: [String: String]
    public var roomBindings: [String: String]
    public var nameProjections: [String: NameProjection]
    public init(serverID: String, homeKitHomeID: String, sourceHomeID: String? = nil,
                deviceNameOnly: Bool = false, deviceBindings: [String: String] = [:],
                roomBindings: [String: String] = [:], nameProjections: [String: NameProjection] = [:]) {
        self.serverID = serverID; self.homeKitHomeID = homeKitHomeID; self.sourceHomeID = sourceHomeID
        self.deviceNameOnly = deviceNameOnly; self.deviceBindings = deviceBindings
        self.roomBindings = roomBindings; self.nameProjections = nameProjections
    }
}

public typealias SyncProfile = ProfileBindings

/// These are the two authoritative values observed at the last agreement.
/// Room values use source room IDs on both sides; nil means known unassigned.
public struct FieldBaseline: Codable, Equatable, Sendable {
    public var sourceValue: String?
    public var localValue: String?
    public init(sourceValue: String?, localValue: String?) {
        self.sourceValue = sourceValue; self.localValue = localValue
    }
}

public enum SyncField: String, Codable, Equatable, Sendable { case deviceName, deviceRoom, roomName }
public enum SyncDirection: String, Codable, Equatable, Sendable { case toLocal, toSource }

public struct SyncChange: Codable, Equatable, Identifiable, Sendable {
    public var id: String
    public var field: SyncField
    public var direction: SyncDirection
    public var sourceTargetID: String
    public var localTargetID: String
    public var expectedSource: String?
    /// A HomeKit name or native HomeKit room UUID, checked again before apply.
    public var expectedLocal: String?
    /// Destination-native value: HomeKit room UUID for toLocal, source room ID for toSource.
    public var value: String?
    public init(id: String, field: SyncField, direction: SyncDirection, sourceTargetID: String,
                localTargetID: String, expectedSource: String?, expectedLocal: String?, value: String?) {
        self.id = id; self.field = field; self.direction = direction
        self.sourceTargetID = sourceTargetID; self.localTargetID = localTargetID
        self.expectedSource = expectedSource; self.expectedLocal = expectedLocal; self.value = value
    }
}

public struct SyncConflict: Codable, Equatable, Identifiable, Sendable {
    public var id: String
    public var field: SyncField
    public var sourceTargetID: String
    public var localTargetID: String
    public var sourceValue: String?
    public var localValue: String?
    public var expectedSource: String?
    public var expectedLocal: String?
    public var reason: String
    public var canUseSource: Bool
    public var canUseLocal: Bool
    public init(id: String, field: SyncField, sourceTargetID: String, localTargetID: String,
                sourceValue: String?, localValue: String?, reason: String,
                canUseSource: Bool, canUseLocal: Bool,
                expectedSource: String? = nil, expectedLocal: String? = nil) {
        self.id = id; self.field = field; self.sourceTargetID = sourceTargetID; self.localTargetID = localTargetID
        self.sourceValue = sourceValue; self.localValue = localValue; self.reason = reason
        self.canUseSource = canUseSource; self.canUseLocal = canUseLocal
        self.expectedSource = expectedSource; self.expectedLocal = expectedLocal
    }
}

public struct SyncPlan: Codable, Equatable, Sendable {
    public var changes: [SyncChange]
    public var conflicts: [SyncConflict]
    public var agreements: [String: FieldBaseline]
    public var blockedReasons: [String]
    public var baselineCandidates: [String: FieldBaseline] { agreements }
    public init(changes: [SyncChange] = [], conflicts: [SyncConflict] = [],
                agreements: [String: FieldBaseline] = [:], blockedReasons: [String] = []) {
        self.changes = changes; self.conflicts = conflicts; self.agreements = agreements
        self.blockedReasons = blockedReasons
    }
}

public enum SyncPlanner {
    private struct Field {
        var id: String
        var kind: SyncField
        var sourceID: String
        var localID: String
        var source: String?
        var local: String?
        var nativeLocal: String?
        var destinationLocal: String?
        var canUseSource: Bool
        var canUseLocal: Bool
        var equivalent: Bool
        var comparable: Bool = true
    }

    private static func equal(_ left: String?, _ right: String?) -> Bool {
        switch (left, right) {
        case (nil, nil): return true
        case (.some(let left), .some(let right)): return left.utf8.elementsEqual(right.utf8)
        default: return false
        }
    }

    private static func validName(_ value: String) -> Bool { (try? NamePolicy.validate(value)) != nil }

    public static func fieldID(_ field: SyncField, sourceID: String) -> String {
        "\(field.rawValue):\(sourceID)"
    }

    private static func check(snapshot: MetadataSnapshot, local: LocalSnapshot,
                              bindings: ProfileBindings) -> String? {
        guard (try? snapshot.validate()) != nil else { return "invalid_source" }
        guard ["tuya-project-paas", "tuya-project-custom"].contains(snapshot.sourceKind) else { return "unsupported_source" }
        guard snapshot.serverId == bindings.serverID, local.homeID == bindings.homeKitHomeID else { return "wrong_source" }
        guard snapshot.namesAuthoritative else { return "source_unavailable" }
        guard Set(local.devices.map(\.id)).count == local.devices.count,
              Set(local.rooms.map(\.id)).count == local.rooms.count,
              Set(bindings.deviceBindings.values).count == bindings.deviceBindings.count else { return "ambiguous_binding" }
        if let home = bindings.sourceHomeID {
            guard !home.isEmpty else { return "wrong_source" }
            if snapshot.roomsAvailable && !snapshot.homes.contains(where: { $0.id == home }) { return "wrong_source" }
        } else if !(bindings.deviceNameOnly && snapshot.sourceKind == "tuya-project-custom") {
            return "missing_home_binding"
        }
        return nil
    }

    private static func fields(snapshot: MetadataSnapshot, local: LocalSnapshot,
                               bindings: ProfileBindings) -> [Field] {
        let sourceDevices = Dictionary(uniqueKeysWithValues: snapshot.devices.map { ($0.id, $0) })
        let localDevices = Dictionary(uniqueKeysWithValues: local.devices.map { ($0.id, $0) })
        let sourceRooms = Dictionary(uniqueKeysWithValues: snapshot.rooms.map { ($0.id, $0) })
        let localRooms = Dictionary(uniqueKeysWithValues: local.rooms.map { ($0.id, $0) })
        let roomCounts = Dictionary(grouping: bindings.roomBindings.values, by: { $0 }).mapValues(\.count)
        let roomBindings = bindings.roomBindings.filter { entry in
            guard let sourceRoom = sourceRooms[entry.key], let selectedHome = bindings.sourceHomeID else { return false }
            return roomCounts[entry.value] == 1 && localRooms[entry.value] != nil
                && sourceRoom.homeId == selectedHome
        }
        let sourceRoomForLocal = Dictionary(uniqueKeysWithValues: roomBindings.map { ($0.value, $0.key) })
        var result: [Field] = []
        for sourceID in bindings.deviceBindings.keys.sorted() {
            guard let localID = bindings.deviceBindings[sourceID], let source = sourceDevices[sourceID],
                  let target = localDevices[localID] else { continue }
            if snapshot.roomsAvailable, let selected = bindings.sourceHomeID,
               let actual = source.homeId, actual != selected { continue }
            let projection = bindings.nameProjections[sourceID]
            let projectedEqual = projection.map {
                equal($0.sourceValue, source.name) && equal($0.localValue, target.name)
            } ?? false
            result.append(Field(id: fieldID(.deviceName, sourceID: sourceID), kind: .deviceName,
                sourceID: sourceID, localID: localID, source: source.name, local: target.name,
                nativeLocal: target.name, destinationLocal: source.name,
                canUseSource: validName(source.name), canUseLocal: snapshot.capabilities.renameDevice && validName(target.name),
                equivalent: equal(source.name, target.name) || projectedEqual))
            guard !bindings.deviceNameOnly, snapshot.roomsAvailable,
                  source.roomStatus == .assigned || source.roomStatus == .unassigned else { continue }
            let localRoom = target.roomID.flatMap { sourceRoomForLocal[$0] }
            let comparable = target.roomID == nil || localRoom != nil
            let destinationLocal = source.roomId.flatMap { roomBindings[$0] }
            result.append(Field(id: fieldID(.deviceRoom, sourceID: sourceID), kind: .deviceRoom,
                sourceID: sourceID, localID: localID, source: source.roomId, local: localRoom,
                nativeLocal: target.roomID, destinationLocal: destinationLocal,
                canUseSource: source.roomId != nil && destinationLocal != nil,
                canUseLocal: snapshot.capabilities.moveDevice && localRoom != nil,
                equivalent: comparable && equal(source.roomId, localRoom), comparable: comparable))
        }
        if !bindings.deviceNameOnly && snapshot.roomsAvailable {
            for sourceID in roomBindings.keys.sorted() {
                guard let localID = roomBindings[sourceID], let source = sourceRooms[sourceID],
                      let target = localRooms[localID] else { continue }
                result.append(Field(id: fieldID(.roomName, sourceID: sourceID), kind: .roomName,
                    sourceID: sourceID, localID: localID, source: source.name, local: target.name,
                    nativeLocal: target.name, destinationLocal: source.name,
                    canUseSource: validName(source.name), canUseLocal: snapshot.capabilities.renameRoom && validName(target.name),
                    equivalent: equal(source.name, target.name)))
            }
        }
        return result
    }

    private static func change(_ field: Field, direction: SyncDirection) -> SyncChange {
        SyncChange(id: field.id, field: field.kind, direction: direction, sourceTargetID: field.sourceID,
            localTargetID: field.localID, expectedSource: field.source, expectedLocal: field.nativeLocal,
            value: direction == .toLocal ? field.destinationLocal : field.local)
    }

    private static func conflict(_ field: Field, reason: String) -> SyncConflict {
        SyncConflict(id: field.id, field: field.kind, sourceTargetID: field.sourceID,
            localTargetID: field.localID, sourceValue: field.source, localValue: field.local,
            reason: reason, canUseSource: field.canUseSource, canUseLocal: field.canUseLocal,
            expectedSource: field.source, expectedLocal: field.nativeLocal)
    }

    public static func plan(snapshot: MetadataSnapshot, local: LocalSnapshot, bindings: ProfileBindings,
                            baselines: [String: FieldBaseline]) -> SyncPlan {
        if let reason = check(snapshot: snapshot, local: local, bindings: bindings) {
            return SyncPlan(blockedReasons: [reason])
        }
        var plan = SyncPlan()
        for field in fields(snapshot: snapshot, local: local, bindings: bindings) {
            if !field.comparable {
                plan.conflicts.append(conflict(field, reason: "missing_room_binding"))
            } else if field.equivalent {
                plan.agreements[field.id] = FieldBaseline(sourceValue: field.source, localValue: field.local)
            } else if let previous = baselines[field.id] {
                let sourceChanged = !equal(field.source, previous.sourceValue)
                let localChanged = !equal(field.local, previous.localValue)
                if sourceChanged && !localChanged && field.canUseSource {
                    plan.changes.append(change(field, direction: .toLocal))
                } else if localChanged && !sourceChanged && field.canUseLocal {
                    plan.changes.append(change(field, direction: .toSource))
                } else {
                    let reason = sourceChanged && localChanged ? "divergent_changes" :
                        (!field.canUseSource || !field.canUseLocal ? "unsupported_operation" : "unconfirmed_baseline")
                    plan.conflicts.append(conflict(field, reason: reason))
                }
            } else {
                plan.conflicts.append(conflict(field, reason: "missing_baseline"))
            }
        }
        return plan
    }

    public static func plan(snapshot: MetadataSnapshot, local: LocalSnapshot, profile: SyncProfile,
                            baseline: [String: FieldBaseline]) -> SyncPlan {
        plan(snapshot: snapshot, local: local, bindings: profile, baselines: baseline)
    }

    /// Explicit one-shot conflict resolution. The caller must fetch both sides
    /// again and enforce the expected values and protocol epoch before applying.
    public static func resolve(fieldID: String, preferSource: Bool, snapshot: MetadataSnapshot,
                               local: LocalSnapshot, bindings: ProfileBindings,
                               baselines: [String: FieldBaseline] = [:]) throws -> SyncChange {
        if let reason = check(snapshot: snapshot, local: local, bindings: bindings) {
            throw reason == "wrong_source" ? MetadataError.wrongSource : MetadataError.staleState
        }
        guard let field = fields(snapshot: snapshot, local: local, bindings: bindings).first(where: { $0.id == fieldID }),
              !field.equivalent else { throw MetadataError.staleState }
        guard preferSource ? field.canUseSource : field.canUseLocal else { throw MetadataError.unsupportedOperation }
        return change(field, direction: preferSource ? .toLocal : .toSource)
    }
}
