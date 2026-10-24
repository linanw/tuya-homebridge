import Foundation

private struct ProtocolCodingKey: CodingKey {
    var stringValue: String
    var intValue: Int? { nil }
    init?(stringValue: String) { self.stringValue = stringValue }
    init?(intValue: Int) { return nil }
}

public enum MetadataError: Error, LocalizedError, Equatable {
    case invalidURL, insecureURL, invalidToken, invalidResponse, unsupportedVersion
    case invalidName, unsupportedOperation, wrongSource, staleState
    case http(Int), responseTooLarge, receiptTimeout, commandNotFound, network

    public var errorDescription: String? {
        switch self {
        case .invalidURL: return "Use a server URL without credentials, query, or fragment."
        case .insecureURL: return "HTTPS is required. HTTP is allowed only for exact loopback development addresses."
        case .invalidToken: return "The bearer token must contain at least 32 characters and no whitespace."
        case .invalidResponse: return "The metadata server returned an invalid response."
        case .unsupportedVersion: return "This server uses an unsupported metadata protocol version."
        case .invalidName: return "Names must be nonblank, contain no control characters, and fit 50 Unicode scalars / 160 UTF-8 bytes."
        case .unsupportedOperation: return "The selected operation is unavailable."
        case .wrongSource: return "The server identity changed. Reconnect and review the bindings."
        case .staleState: return "Metadata changed while preparing this operation. Refresh and review it again."
        case .http(let status): return "The metadata request failed (HTTP \(status))."
        case .responseTooLarge: return "The metadata response exceeded the 4 MiB limit."
        case .receiptTimeout: return "The write outcome is unknown. Check its receipt; do not resend it."
        case .commandNotFound: return "The server no longer has this command receipt. Its outcome must be reviewed."
        case .network: return "The metadata connection failed. Check connectivity and the server's trusted TLS certificate."
        }
    }
}

public struct Capabilities: Codable, Equatable, Sendable {
    public var read: Bool
    public var renameDevice: Bool
    public var moveDevice: Bool
    public var renameRoom: Bool
    public init(read: Bool, renameDevice: Bool, moveDevice: Bool, renameRoom: Bool) {
        self.read = read; self.renameDevice = renameDevice
        self.moveDevice = moveDevice; self.renameRoom = renameRoom
    }
}

public struct SourceHome: Codable, Equatable, Identifiable, Sendable {
    public var id: String
    public var name: String
}

public struct SourceRoom: Codable, Equatable, Identifiable, Sendable {
    public var id: String
    public var homeId: String
    public var name: String
}

public enum RoomStatus: String, Codable, Sendable {
    case assigned, unassigned, unknown, unsupported
}

public struct DeviceIdentities: Codable, Equatable, Sendable {
    public var hapSerialNumber: String?
    public var hapAccessoryUuid: String?
    public var matterUniqueIds: [String]
}

public struct SourceDevice: Codable, Equatable, Identifiable, Sendable {
    public var id: String
    public var name: String
    public var homeId: String?
    public var roomId: String?
    public var roomStatus: RoomStatus
    public var bindings: DeviceIdentities
}

public struct MetadataSnapshot: Codable, Equatable, Sendable {
    public var schemaVersion: Int
    public var serverId: String
    public var sourceEpoch: String
    public var revision: String
    public var observedAt: String?
    public var available: Bool
    public var roomsAvailable: Bool
    public var sourceKind: String
    public var capabilities: Capabilities
    public var limitations: [String: String]
    public var homes: [SourceHome]
    public var rooms: [SourceRoom]
    public var devices: [SourceDevice]

    public var namesAuthoritative: Bool {
        available && capabilities.read && observedAt != nil
    }

    public func validate() throws {
        guard schemaVersion == 1 else { throw MetadataError.unsupportedVersion }
        guard UUID(uuidString: serverId) != nil, UUID(uuidString: sourceEpoch) != nil,
              Self.validRevision(revision),
              Set(homes.map(\.id)).count == homes.count,
              Set(rooms.map(\.id)).count == rooms.count,
              Set(devices.map(\.id)).count == devices.count else { throw MetadataError.invalidResponse }
        for device in devices where device.roomStatus == .assigned {
            guard device.homeId != nil, device.roomId != nil else { throw MetadataError.invalidResponse }
        }
        guard homes.allSatisfy({ !$0.id.isEmpty }), rooms.allSatisfy({ !$0.id.isEmpty && !$0.homeId.isEmpty }),
              devices.allSatisfy({ !$0.id.isEmpty }) else { throw MetadataError.invalidResponse }
        if roomsAvailable {
            let homeIDs = Set(homes.map(\.id))
            let byRoom = Dictionary(uniqueKeysWithValues: rooms.map { ($0.id, $0) })
            guard rooms.allSatisfy({ homeIDs.contains($0.homeId) }) else { throw MetadataError.invalidResponse }
            for device in devices {
                if let home = device.homeId, !homeIDs.contains(home) { throw MetadataError.invalidResponse }
                if device.roomStatus == .assigned {
                    guard let room = device.roomId, let record = byRoom[room], record.homeId == device.homeId else {
                        throw MetadataError.invalidResponse
                    }
                } else if device.roomStatus == .unassigned && device.roomId != nil {
                    throw MetadataError.invalidResponse
                }
            }
        }
        if let observedAt {
            let fractional = ISO8601DateFormatter()
            fractional.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
            guard fractional.date(from: observedAt) != nil || ISO8601DateFormatter().date(from: observedAt) != nil
            else { throw MetadataError.invalidResponse }
        }
    }

    public static func decode(_ data: Data) throws -> MetadataSnapshot {
        let value = try JSONDecoder().decode(MetadataSnapshot.self, from: data)
        try value.validate()
        return value
    }

    public static func validRevision(_ value: String) -> Bool {
        !value.isEmpty && value.count <= 40 && (value == "0" || value.first != "0") &&
            value.utf8.allSatisfy({ (48...57).contains($0) })
    }
}

public struct CapabilitiesDocument: Codable, Equatable, Sendable {
    public var schemaVersion: Int
    public var serverId: String
    public var sourceEpoch: String
    public var revision: String
    public var observedAt: String?
    public var available: Bool
    public var roomsAvailable: Bool
    public var sourceKind: String
    public var capabilities: Capabilities
    public var limitations: [String: String]

    public func validate() throws {
        guard schemaVersion == 1 else { throw MetadataError.unsupportedVersion }
        guard UUID(uuidString: serverId) != nil, UUID(uuidString: sourceEpoch) != nil,
              MetadataSnapshot.validRevision(revision) else {
            throw MetadataError.invalidResponse
        }
    }
}

public struct ExpectedState: Codable, Equatable, Sendable {
    public var serverId: String
    public var sourceEpoch: String
    public var revision: String
    public init(snapshot: MetadataSnapshot) {
        serverId = snapshot.serverId; sourceEpoch = snapshot.sourceEpoch; revision = snapshot.revision
    }
    private enum CodingKeys: String, CodingKey { case serverId, sourceEpoch, revision }
    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        serverId = try container.decode(String.self, forKey: .serverId)
        sourceEpoch = try container.decode(String.self, forKey: .sourceEpoch)
        revision = try container.decode(String.self, forKey: .revision)
        let all = try decoder.container(keyedBy: ProtocolCodingKey.self)
        guard Set(all.allKeys.map(\.stringValue)) == Set(["serverId", "sourceEpoch", "revision"]),
              UUID(uuidString: serverId) != nil, UUID(uuidString: sourceEpoch) != nil,
              MetadataSnapshot.validRevision(revision) else { throw MetadataError.invalidResponse }
    }
    public func matches(_ snapshot: MetadataSnapshot) -> Bool {
        serverId == snapshot.serverId && sourceEpoch == snapshot.sourceEpoch && revision == snapshot.revision
    }
}

public enum MetadataOperation: Codable, Equatable, Sendable {
    case refresh
    case deviceRename(targetId: String, name: String)
    case deviceMove(targetId: String, roomId: String)
    case roomRename(targetId: String, name: String)

    private enum Keys: String, CodingKey { case type, targetId, name, roomId }
    private struct AnyKey: CodingKey {
        var stringValue: String
        var intValue: Int? { nil }
        init?(stringValue: String) { self.stringValue = stringValue }
        init?(intValue: Int) { return nil }
    }

    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: Keys.self)
        let type = try container.decode(String.self, forKey: .type)
        let allowed: Set<String>
        switch type {
        case "refresh": self = .refresh; allowed = ["type"]
        case "device.rename":
            self = .deviceRename(targetId: try container.decode(String.self, forKey: .targetId),
                                 name: try container.decode(String.self, forKey: .name))
            allowed = ["type", "targetId", "name"]
        case "device.move":
            self = .deviceMove(targetId: try container.decode(String.self, forKey: .targetId),
                               roomId: try container.decode(String.self, forKey: .roomId))
            allowed = ["type", "targetId", "roomId"]
        case "room.rename":
            self = .roomRename(targetId: try container.decode(String.self, forKey: .targetId),
                               name: try container.decode(String.self, forKey: .name))
            allowed = ["type", "targetId", "name"]
        default: throw MetadataError.unsupportedOperation
        }
        let all = try decoder.container(keyedBy: AnyKey.self)
        guard Set(all.allKeys.map(\.stringValue)).isSubset(of: allowed) else {
            throw MetadataError.invalidResponse
        }
        try validate()
    }

    public func encode(to encoder: Encoder) throws {
        var container = encoder.container(keyedBy: Keys.self)
        switch self {
        case .refresh: try container.encode("refresh", forKey: .type)
        case .deviceRename(let id, let name):
            try container.encode("device.rename", forKey: .type)
            try container.encode(id, forKey: .targetId); try container.encode(name, forKey: .name)
        case .deviceMove(let id, let room):
            try container.encode("device.move", forKey: .type)
            try container.encode(id, forKey: .targetId); try container.encode(room, forKey: .roomId)
        case .roomRename(let id, let name):
            try container.encode("room.rename", forKey: .type)
            try container.encode(id, forKey: .targetId); try container.encode(name, forKey: .name)
        }
    }

    public func validate() throws {
        switch self {
        case .refresh: break
        case .deviceRename(let id, let name), .roomRename(let id, let name):
            guard !id.isEmpty else { throw MetadataError.invalidResponse }
            try NamePolicy.validate(name)
        case .deviceMove(let id, let room):
            guard !id.isEmpty, !room.isEmpty else { throw MetadataError.invalidResponse }
        }
    }

    public func isSupported(by snapshot: MetadataSnapshot) -> Bool {
        if case .refresh = self { return snapshot.capabilities.read }
        guard snapshot.namesAuthoritative else { return false }
        switch self {
        case .refresh: return snapshot.capabilities.read
        case .deviceRename: return snapshot.capabilities.renameDevice
        case .deviceMove: return snapshot.roomsAvailable && snapshot.capabilities.moveDevice
        case .roomRename: return snapshot.roomsAvailable && snapshot.capabilities.renameRoom
        }
    }
}

public struct MetadataCommand: Codable, Equatable, Sendable {
    public var schemaVersion: Int = 1
    public var commandId: String
    public var expected: ExpectedState
    public var operation: MetadataOperation
    public init(snapshot: MetadataSnapshot, operation: MetadataOperation, commandId: String = UUID().uuidString.lowercased()) throws {
        try snapshot.validate()
        guard UUID(uuidString: commandId) != nil else { throw MetadataError.invalidResponse }
        try operation.validate()
        self.commandId = commandId; expected = ExpectedState(snapshot: snapshot); self.operation = operation
    }
    private enum CodingKeys: String, CodingKey { case schemaVersion, commandId, expected, operation }
    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        schemaVersion = try container.decode(Int.self, forKey: .schemaVersion)
        commandId = try container.decode(String.self, forKey: .commandId)
        expected = try container.decode(ExpectedState.self, forKey: .expected)
        operation = try container.decode(MetadataOperation.self, forKey: .operation)
        let all = try decoder.container(keyedBy: ProtocolCodingKey.self)
        guard schemaVersion == 1 else { throw MetadataError.unsupportedVersion }
        guard UUID(uuidString: commandId) != nil,
              Set(all.allKeys.map(\.stringValue)) == Set(["schemaVersion", "commandId", "expected", "operation"]) else {
            throw MetadataError.invalidResponse
        }
    }
}

public enum ReceiptStatus: String, Codable, Sendable {
    case queued, running, confirmed, conflict, failed, uncertain
    public var isTerminal: Bool { self != .queued && self != .running }
}

public struct CommandReceipt: Codable, Equatable, Sendable {
    public var schemaVersion: Int
    public var commandId: String
    public var status: ReceiptStatus
    public var code: String?
    public var snapshot: MetadataSnapshot?

    public func validate(commandId expectedID: String? = nil, serverId: String? = nil, sourceEpoch: String? = nil) throws {
        guard schemaVersion == 1 else { throw MetadataError.unsupportedVersion }
        guard UUID(uuidString: commandId) != nil, expectedID == nil || commandId == expectedID else {
            throw MetadataError.invalidResponse
        }
        if let snapshot {
            try snapshot.validate()
            guard serverId == nil || snapshot.serverId == serverId else { throw MetadataError.wrongSource }
            guard sourceEpoch == nil || snapshot.sourceEpoch == sourceEpoch else { throw MetadataError.staleState }
        }
        if status == .confirmed {
            guard let snapshot, snapshot.namesAuthoritative else { throw MetadataError.invalidResponse }
        }
    }
}

public enum NamePolicy {
    public static func validate(_ name: String) throws {
        guard !name.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty,
              name.unicodeScalars.count <= 50, name.utf8.count <= 160,
              !name.unicodeScalars.contains(where: { $0.value <= 0x1f || (0x7f...0x9f).contains($0.value) }) else {
            throw MetadataError.invalidName
        }
    }
}
