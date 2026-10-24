import Combine
import Foundation
@preconcurrency import HomeKit
import TuyaMetadataCore

enum HomeKitStoreError: Error, LocalizedError, Sendable, Equatable {
    case unavailable, homeMissing, targetMissing, staleState, unsupportedChange
    case operationFailed, outcomeUnknown, operationInProgress

    var errorDescription: String? {
        switch self {
        case .unavailable: return "Allow Home access and wait for the selected home to load."
        case .homeMissing: return "The selected Apple home is no longer available. Review its binding."
        case .targetMissing: return "The bound Apple accessory or room is no longer available. Review its binding."
        case .staleState: return "Apple Home changed while this action was being prepared. Refresh and review it again."
        case .unsupportedChange: return "This action requires one existing accessory or room in the selected home."
        case .operationFailed: return "Apple Home did not complete the change. Refresh before trying another action."
        case .outcomeUnknown: return "The Apple Home result is unknown. Check the current value; do not automatically resend the action."
        case .operationInProgress: return "An Apple Home change is already in progress."
        }
    }
}

// HomeKit completion handlers need not run on the main actor. They only signal
// this gate; no HomeKit object is read or carried into another actor.
private final class HomeKitCompletion: @unchecked Sendable {
    private let lock = NSLock()
    private var continuation: CheckedContinuation<Void, Error>?

    init(_ continuation: CheckedContinuation<Void, Error>) {
        self.continuation = continuation
    }

    func finish(_ error: HomeKitStoreError?) {
        lock.lock()
        let pending = continuation
        continuation = nil
        lock.unlock()
        guard let pending else { return }
        if let error { pending.resume(throwing: error) }
        else { pending.resume() }
    }
}

/// HomeKit is available to this iOS app running with Mac Catalyst, not a native
/// macOS target. Creating the manager is deliberately a user-initiated action.
@MainActor
final class HomeKitStore: NSObject, ObservableObject {
    @Published private(set) var homes: [HMHome] = []
    @Published private(set) var authorized = false
    @Published private(set) var status = "Home access is off. Choose Allow Home access to continue."

    private var manager: HMHomeManager?
    private var graphReady = false
    private var pollTask: Task<Void, Never>?
    private var mutationInProgress = false
    // A timeout can leave an underlying HomeKit action unresolved. Keep writes
    // blocked until its callback arrives instead of overlapping another action.
    private var unresolvedMutation: UUID?

    override init() {
        super.init()
    }

    deinit { pollTask?.cancel() }

    func authorize() {
        if manager == nil {
            status = "Requesting Home access…"
            let newManager = HMHomeManager()
            manager = newManager
            newManager.delegate = self
            beginPolling()
        }
        refreshGraph()
    }

    func refresh() {
        // A refresh never creates a manager or triggers an authorization prompt.
        refreshGraph()
    }

    private func beginPolling() {
        guard pollTask == nil else { return }
        pollTask = Task { @MainActor [weak self] in
            while !Task.isCancelled {
                do { try await Task.sleep(nanoseconds: 15_000_000_000) }
                catch { return }
                guard let self else { return }
                self.refreshGraph()
            }
        }
    }

    private func refreshGraph() {
        guard let manager else { return }
        let authorization = manager.authorizationStatus
        authorized = authorization.contains(.authorized)
        guard authorized else {
            homes = []
            if authorization.contains(.restricted) {
                status = "Home access is restricted by the system."
            } else if authorization.contains(.determined) {
                status = "Home access was not granted. Enable it in System Settings to continue."
            } else {
                status = "Waiting for your Home access decision…"
            }
            return
        }
        guard graphReady else {
            status = "Home access allowed. Loading homes…"
            return
        }
        let currentHomes = manager.homes
        for home in currentHomes {
            home.delegate = self
            for accessory in home.accessories { accessory.delegate = self }
        }
        // Publishing a fresh array also refreshes views after HomeKit mutates an
        // existing HMHome/HMAccessory/HMRoom instance in place.
        homes = currentHomes
        status = currentHomes.isEmpty ? "Home access allowed. No Apple homes are available."
            : "Home access allowed. Keep this app running and your Mac awake to synchronize."
    }

    private func home(withID id: String) throws -> HMHome {
        guard let manager, manager.authorizationStatus.contains(.authorized), graphReady else {
            throw HomeKitStoreError.unavailable
        }
        guard let uuid = UUID(uuidString: id),
              let home = manager.homes.first(where: { $0.uniqueIdentifier == uuid }) else {
            throw HomeKitStoreError.homeMissing
        }
        return home
    }

    private func accessory(withID id: String, in home: HMHome) throws -> HMAccessory {
        guard let uuid = UUID(uuidString: id),
              let accessory = home.accessories.first(where: { $0.uniqueIdentifier == uuid }) else {
            throw HomeKitStoreError.targetMissing
        }
        return accessory
    }

    private func room(withID id: String, in home: HMHome) throws -> HMRoom {
        guard let uuid = UUID(uuidString: id),
              let room = home.rooms.first(where: { $0.uniqueIdentifier == uuid }),
              room.uniqueIdentifier != home.roomForEntireHome().uniqueIdentifier else {
            throw HomeKitStoreError.targetMissing
        }
        return room
    }

    private func roomID(of accessory: HMAccessory, in home: HMHome) -> String? {
        let currentRoom: HMRoom? = accessory.room
        guard let room = currentRoom,
              room.uniqueIdentifier != home.roomForEntireHome().uniqueIdentifier else { return nil }
        return room.uniqueIdentifier.uuidString.lowercased()
    }

    private func cachedSerialNumber(of accessory: HMAccessory) -> String? {
        // A missing cached serial requires explicit binding. Never substitute an
        // HMAccessory UUID, display name or Homebridge UUID as identity proof.
        for service in accessory.services {
            for characteristic in service.characteristics where characteristic.characteristicType == HMCharacteristicTypeSerialNumber {
                guard let serial = characteristic.value as? String,
                      !serial.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty,
                      !serial.hasPrefix("Default-") else { continue }
                return serial
            }
        }
        return nil
    }

    func snapshot(homeID: String) throws -> LocalSnapshot {
        let home = try home(withID: homeID)
        let devices = home.accessories.map { accessory in
            LocalDevice(id: accessory.uniqueIdentifier.uuidString.lowercased(), name: accessory.name,
                        roomID: roomID(of: accessory, in: home), serialNumber: cachedSerialNumber(of: accessory))
        }.sorted { $0.id < $1.id }
        let rooms = home.rooms.filter { $0.uniqueIdentifier != home.roomForEntireHome().uniqueIdentifier }
            .map { LocalRoom(id: $0.uniqueIdentifier.uuidString.lowercased(), name: $0.name) }
            .sorted { $0.id < $1.id }
        return LocalSnapshot(homeID: home.uniqueIdentifier.uuidString.lowercased(), name: home.name,
                             devices: devices, rooms: rooms)
    }

    private func localValue(for change: SyncChange, in home: HMHome) throws -> String? {
        switch change.field {
        case .deviceName: return try accessory(withID: change.localTargetID, in: home).name
        case .deviceRoom: return roomID(of: try accessory(withID: change.localTargetID, in: home), in: home)
        case .roomName: return try room(withID: change.localTargetID, in: home).name
        }
    }

    private func sameValue(_ left: String?, _ right: String?) -> Bool {
        switch (left, right) {
        case (nil, nil): return true
        case (.some(let left), .some(let right)): return left.utf8.elementsEqual(right.utf8)
        default: return false
        }
    }

    private func perform(_ action: (@escaping @Sendable (Error?) -> Void) -> Void) async throws {
        try Task.checkCancellation()
        let mutationID = UUID()
        unresolvedMutation = mutationID
        var timeout: Task<Void, Never>?
        defer { timeout?.cancel() }
        do {
            try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<Void, Error>) in
                let gate = HomeKitCompletion(continuation)
                timeout = Task {
                    do { try await Task.sleep(nanoseconds: 30_000_000_000) }
                    catch { return }
                    gate.finish(.outcomeUnknown)
                }
                action { [weak self] error in
                    gate.finish(error == nil ? nil : .operationFailed)
                    // Carry only a UUID and the actor-isolated store across this
                    // boundary. Fresh HomeKit reads happen after awaiting the gate.
                    Task { @MainActor [weak self] in
                        if self?.unresolvedMutation == mutationID { self?.unresolvedMutation = nil }
                    }
                }
            }
        } catch {
            if (error as? HomeKitStoreError) != .outcomeUnknown, unresolvedMutation == mutationID {
                unresolvedMutation = nil
            }
            throw error
        }
        if unresolvedMutation == mutationID { unresolvedMutation = nil }
    }

    func apply(change: SyncChange, homeID: String) async throws {
        guard change.direction == .toLocal else { throw HomeKitStoreError.unsupportedChange }
        guard !mutationInProgress, unresolvedMutation == nil else { throw HomeKitStoreError.operationInProgress }
        let currentHome = try home(withID: homeID)
        guard sameValue(try localValue(for: change, in: currentHome), change.expectedLocal) else { throw HomeKitStoreError.staleState }
        guard let value = change.value else { throw HomeKitStoreError.unsupportedChange }
        mutationInProgress = true
        defer { mutationInProgress = false }

        switch change.field {
        case .deviceName:
            try NamePolicy.validate(value)
            let target = try accessory(withID: change.localTargetID, in: currentHome)
            try await perform { completion in target.updateName(value, completionHandler: completion) }
        case .roomName:
            try NamePolicy.validate(value)
            let target = try room(withID: change.localTargetID, in: currentHome)
            try await perform { completion in target.updateName(value, completionHandler: completion) }
        case .deviceRoom:
            let target = try accessory(withID: change.localTargetID, in: currentHome)
            let destination = try room(withID: value, in: currentHome)
            try await perform { completion in currentHome.assignAccessory(target, to: destination, completionHandler: completion) }
        }

        // A successful callback alone is insufficient. Resolve the current home
        // and target again, then verify the actual field before confirming it.
        refreshGraph()
        let freshHome = try home(withID: homeID)
        guard sameValue(try localValue(for: change, in: freshHome), value) else { throw HomeKitStoreError.outcomeUnknown }
    }

    nonisolated private func scheduleRefresh(homesLoaded: Bool = false) {
        Task { @MainActor [weak self] in
            guard let self else { return }
            if homesLoaded { self.graphReady = true }
            self.refreshGraph()
        }
    }
}

extension HomeKitStore: HMHomeManagerDelegate, HMHomeDelegate, HMAccessoryDelegate {
    nonisolated func homeManagerDidUpdateHomes(_ manager: HMHomeManager) { scheduleRefresh(homesLoaded: true) }
    nonisolated func homeManager(_ manager: HMHomeManager, didUpdate status: HMHomeManagerAuthorizationStatus) { scheduleRefresh() }
    nonisolated func homeManager(_ manager: HMHomeManager, didAdd home: HMHome) { scheduleRefresh() }
    nonisolated func homeManager(_ manager: HMHomeManager, didRemove home: HMHome) { scheduleRefresh() }
    nonisolated func homeDidUpdateName(_ home: HMHome) { scheduleRefresh() }
    nonisolated func home(_ home: HMHome, didAdd accessory: HMAccessory) { scheduleRefresh() }
    nonisolated func home(_ home: HMHome, didRemove accessory: HMAccessory) { scheduleRefresh() }
    nonisolated func home(_ home: HMHome, didAdd room: HMRoom) { scheduleRefresh() }
    nonisolated func home(_ home: HMHome, didRemove room: HMRoom) { scheduleRefresh() }
    nonisolated func home(_ home: HMHome, didUpdateNameFor room: HMRoom) { scheduleRefresh() }
    nonisolated func home(_ home: HMHome, didUpdate room: HMRoom, for accessory: HMAccessory) { scheduleRefresh() }
    nonisolated func accessoryDidUpdateName(_ accessory: HMAccessory) { scheduleRefresh() }
    nonisolated func accessoryDidUpdateServices(_ accessory: HMAccessory) { scheduleRefresh() }
    nonisolated func accessory(_ accessory: HMAccessory, didUpdateValueFor characteristic: HMCharacteristic) { scheduleRefresh() }
}
