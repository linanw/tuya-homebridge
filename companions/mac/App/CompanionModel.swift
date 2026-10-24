import Foundation
import Combine
import TuyaMetadataCore

struct ReviewItem: Identifiable {
    var id: String
    var title: String
    var sourceValue: String
    var appleValue: String
    var reason: String
    var canKeepSource: Bool
    var canKeepApple: Bool
    var field: SyncField = .deviceName
    var expectedSource: String? = nil
    var expectedLocal: String? = nil
}

private struct PendingWrite: Codable {
    var command: MetadataCommand?
    var change: SyncChange?
    var startedAt: Date
}

private struct SavedCompanionState: Codable {
    var serverURL = ""
    var bindings: ProfileBindings?
    var baselines: [String: FieldBaseline] = [:]
    var blockedFields: Set<String> = []
    var unknownFields: Set<String> = []
    var confirmedEpoch: String?
    var pending: PendingWrite?
}

@MainActor
final class CompanionModel: ObservableObject {
    static let nameOnlySelection = "__server_device_names_only__"
    let homeKit = HomeKitStore()
    @Published var serverURL = ""
    @Published var tokenInput = ""
    @Published var appleHomeID = ""
    @Published var sourceHomeID = ""
    @Published var deviceDrafts: [String: String] = [:]
    @Published var roomDrafts: [String: String] = [:]
    @Published var projectionDrafts: [String: Bool] = [:]
    @Published private(set) var snapshot: MetadataSnapshot?
    @Published private(set) var local: LocalSnapshot?
    @Published private(set) var connected = false
    @Published private(set) var busy = false
    @Published private(set) var running = false
    @Published private(set) var status = "Connect, authorize HomeKit, and confirm explicit bindings."
    @Published private(set) var reviews: [ReviewItem] = []
    @Published private(set) var receiptUnavailable = false
    @Published private var saved = SavedCompanionState()
    private var client: MetadataHTTPClient?
    private var loop: Task<Void, Never>?
    private var restored = false

    var sourceHomes: [SourceHome] { snapshot?.homes ?? [] }
    var supportsNameOnlyProfile: Bool { snapshot?.sourceKind == "tuya-project-custom" && (snapshot?.homes.isEmpty ?? false) }
    var sourceDevices: [SourceDevice] {
        guard let snapshot else { return [] }
        if sourceHomeID == Self.nameOnlySelection && supportsNameOnlyProfile { return snapshot.devices }
        return snapshot.devices.filter { $0.homeId == sourceHomeID }
    }
    var sourceRooms: [SourceRoom] { snapshot?.rooms.filter { $0.homeId == sourceHomeID } ?? [] }
    var appleDevices: [LocalDevice] { local?.devices ?? [] }
    var appleRooms: [LocalRoom] { local?.rooms ?? [] }
    var hasPendingReceipt: Bool { saved.pending != nil }
    private var activeConnection: Bool { connected && serverURL == saved.serverURL && tokenInput.isEmpty }
    var profileReady: Bool {
        guard let binding = saved.bindings else { return false }
        return binding.homeKitHomeID == appleHomeID &&
            (binding.deviceNameOnly ? Self.nameOnlySelection : binding.sourceHomeID ?? "") == sourceHomeID &&
            binding.deviceBindings == deviceDrafts.filter { !$0.value.isEmpty } &&
            binding.roomBindings == roomDrafts.filter { !$0.value.isEmpty } &&
            Set(binding.nameProjections.keys) == Set(projectionDrafts.filter { $0.value }.keys)
    }
    var canStart: Bool { activeConnection && homeKit.authorized && profileReady && !busy && !running && saved.pending == nil }
    var capabilitySummary: String {
        guard let snapshot else { return "HTTPS required; exact loopback HTTP is for development only. Tokens stay in this device's Keychain." }
        let caps = snapshot.capabilities
        return "\(snapshot.sourceKind) · names: \(snapshot.namesAuthoritative ? "available" : "unavailable") · cloud rename: \(caps.renameDevice ? "enabled" : "unavailable") · room writes: \(caps.moveDevice || caps.renameRoom ? "declared" : "unavailable")"
    }

    func restoreSelection() async {
        guard !restored else { return }; restored = true
        do {
            let data = try Data(contentsOf: stateURL())
            saved = try JSONDecoder().decode(SavedCompanionState.self, from: data)
            serverURL = saved.serverURL
            if let binding = saved.bindings {
                appleHomeID = binding.homeKitHomeID.lowercased()
                sourceHomeID = binding.deviceNameOnly ? Self.nameOnlySelection : binding.sourceHomeID ?? ""
                deviceDrafts = binding.deviceBindings; roomDrafts = binding.roomBindings
                projectionDrafts = binding.nameProjections.mapValues { _ in true }
            }
            if saved.pending?.command == nil, let change = saved.pending?.change {
                // A crash after a local command has an unknown outcome; compare fresh states before explicit review.
                saved.blockedFields.insert(change.id); saved.pending = nil
                try persist()
            }
            status = saved.pending == nil ? "Saved bindings loaded. Connect and authorize HomeKit to review them." :
                "A prior cloud command needs receipt review. It will not be resent."
        } catch let error as CocoaError where error.code == .fileReadNoSuchFile { }
        catch { status = "Saved state could not be read. Review bindings before starting; no synchronization has begun." }
    }

    func connect() async {
        guard !busy, !running else { return }; busy = true; defer { busy = false }
        do {
            let address = try ServerAddress(serverURL)
            let token: String
            if !tokenInput.isEmpty { token = tokenInput }
            else if let existing = try KeychainTokenStore.read(for: address) { token = existing }
            else { throw MetadataError.invalidToken }
            let candidate = try MetadataHTTPClient(address: address, token: token)
            let caps = try await candidate.capabilities()
            let current = try await candidate.snapshot()
            guard caps.serverId == current.serverId else { throw MetadataError.wrongSource }
            guard ["tuya-project-paas", "tuya-project-custom"].contains(current.sourceKind) else { throw MetadataError.unsupportedOperation }
            if let binding = saved.bindings, binding.serverID != current.serverId { throw MetadataError.wrongSource }
            if let pending = saved.pending, let command = pending.command {
                guard command.expected.serverId == current.serverId else { throw MetadataError.wrongSource }
                if command.expected.sourceEpoch != current.sourceEpoch {
                    if let id = pending.change?.id { saved.blockedFields.insert(id) }
                    saved.pending = nil; saved.confirmedEpoch = nil
                }
            }
            try KeychainTokenStore.save(token, for: address)
            tokenInput = ""; serverURL = address.credentialScope
            saved.serverURL = serverURL
            client = candidate; snapshot = current; connected = true
            try persist()
            if saved.pending != nil {
                do { try await recoverPending(using: candidate) }
                catch MetadataError.commandNotFound {
                    receiptUnavailable = true
                    status = "The saved receipt is no longer available. Explicitly acknowledge it to resume other fields; its field will remain blocked."
                    return
                }
            }
            if saved.pending == nil {
                try await refreshForCurrentEpoch(using: candidate)
            }
            status = "Connected. Confirm the selected home and stable device/room bindings before starting."
        } catch { connected = false; client = nil; show(error) }
    }

    func forgetToken() {
        guard !busy, !running else { return }
        do {
            try KeychainTokenStore.delete(for: ServerAddress(serverURL))
            tokenInput = ""; connected = false; client = nil
            status = "The local Keychain token was removed. Server credentials were not changed."
        } catch { show(error) }
    }

    func selectionChanged() {
        guard !running else { stop(); return }
        if local?.homeID != appleHomeID { local = nil }
        reviews = []
    }
    func mappingChanged() { if running { stop() }; reviews = [] }
    func connectionEdited() {
        guard serverURL != saved.serverURL || !tokenInput.isEmpty else { return }
        if running { stop() }
        connected = false; client = nil; reviews = []
        status = "Connection settings changed. Reconnect before reviewing or sending changes."
    }
    func resetBindings() {
        guard !busy, !running, saved.pending == nil else { return }
        saved.bindings = nil; saved.baselines = [:]; saved.blockedFields = []
        deviceDrafts = [:]; roomDrafts = [:]; projectionDrafts = [:]; reviews = []
        do { try persist(); status = "Local bindings reset. Select and confirm the intended source and Apple home." }
        catch { show(error) }
    }

    func readAppleSelection() async {
        guard !busy, !running else { return }; busy = true; defer { busy = false }
        do { local = try homeKit.snapshot(homeID: appleHomeID); status = "Apple home read. Select each binding explicitly." }
        catch { show(error) }
    }

    /// This is a suggestion only. A separate explicit confirmation records provenance.
    func projectionSuggestion(for sourceID: String) -> Bool {
        guard let source = sourceDevices.first(where: { $0.id == sourceID }),
              let localID = deviceDrafts[sourceID], let device = appleDevices.first(where: { $0.id == localID }),
              source.name.utf8.count > 64 else { return false }
        return hapProjection(source.name).utf8.elementsEqual(device.name.utf8)
    }
    private func hapProjection(_ name: String) -> String {
        var prefix = ""
        for scalar in name.unicodeScalars {
            let piece = String(scalar)
            if prefix.utf8.count + piece.utf8.count > 64 { break }
            prefix += piece
        }
        return prefix
    }

    func confirmBindings() async {
        guard !busy, !running, saved.pending == nil else { return }
        busy = true; defer { busy = false }
        do {
            guard let snapshot, connected, homeKit.authorized else { throw MetadataError.unsupportedOperation }
            let apple = try homeKit.snapshot(homeID: appleHomeID)
            let nameOnly = sourceHomeID == Self.nameOnlySelection && supportsNameOnlyProfile
            guard nameOnly || snapshot.homes.contains(where: { $0.id == sourceHomeID }) else { throw MetadataError.wrongSource }
            let devices = deviceDrafts.filter { !$0.value.isEmpty }
            let rooms = nameOnly ? [:] : roomDrafts.filter { !$0.value.isEmpty }
            guard !devices.isEmpty, Set(devices.values).count == devices.count,
                  Set(rooms.values).count == rooms.count,
                  devices.allSatisfy({ pair in sourceDevices.contains { $0.id == pair.key } && apple.devices.contains { $0.id == pair.value } }),
                  rooms.allSatisfy({ pair in sourceRooms.contains { $0.id == pair.key } && apple.rooms.contains { $0.id == pair.value } }) else {
                throw MetadataError.invalidResponse
            }
            var binding = ProfileBindings(serverID: snapshot.serverId, homeKitHomeID: appleHomeID,
                sourceHomeID: nameOnly ? nil : sourceHomeID, deviceNameOnly: nameOnly,
                deviceBindings: devices, roomBindings: rooms)
            for (sourceID, confirmed) in projectionDrafts where confirmed && projectionSuggestion(for: sourceID) {
                if let source = snapshot.devices.first(where: { $0.id == sourceID }),
                   let device = apple.devices.first(where: { $0.id == devices[sourceID] }),
                   hapProjection(source.name).utf8.elementsEqual(device.name.utf8) {
                    binding.nameProjections[sourceID] = NameProjection(sourceValue: source.name, localValue: device.name)
                }
            }
            if binding != saved.bindings { saved.baselines = [:]; saved.blockedFields = [] }
            saved.bindings = binding; roomDrafts = rooms; local = apple
            projectionDrafts = binding.nameProjections.mapValues { _ in true }
            try persist()
            try await cycle(applyAutomatic: false)
            status = "Bindings confirmed. Review initial differences; automatic writes require an agreed baseline."
        } catch { show(error) }
    }

    func start() {
        guard canStart else { return }
        running = true
        loop = Task { [weak self] in
            while !Task.isCancelled {
                guard let self, self.running else { break }
                if !self.busy {
                    self.busy = true
                    do { try await self.cycle(applyAutomatic: true) }
                    catch { self.show(error); self.running = false }
                    self.busy = false
                }
                do { try await Task.sleep(nanoseconds: 15_000_000_000) } catch { break }
            }
        }
    }

    func stop() {
        running = false; loop?.cancel(); loop = nil
        status = saved.pending == nil ? "Synchronization stopped." : "Stopped. An accepted command still needs receipt review; it will not be resent."
    }

    func review() async {
        guard !busy, profileReady else { return }; busy = true; defer { busy = false }
        do { try await cycle(applyAutomatic: false) } catch { show(error) }
    }

    private func cycle(applyAutomatic: Bool) async throws {
        guard activeConnection, let client, let binding = saved.bindings, profileReady else { throw MetadataError.unsupportedOperation }
        guard saved.pending == nil else { status = "An existing command needs receipt review before any new write."; return }
        let remote = try await client.snapshot()
        guard remote.serverId == binding.serverID else { throw MetadataError.wrongSource }
        guard remote.sourceEpoch == saved.confirmedEpoch else {
            running = false; saved.confirmedEpoch = nil; snapshot = remote; try persist()
            throw MetadataError.staleState // Explicit reconnect performs an authoritative refresh for the new epoch.
        }
        let apple = try homeKit.snapshot(homeID: binding.homeKitHomeID)
        snapshot = remote; local = apple
        let plan = SyncPlanner.plan(snapshot: remote, local: apple, bindings: binding, baselines: saved.baselines)
        for (id, baseline) in plan.agreements {
            saved.baselines[id] = baseline; saved.blockedFields.remove(id); saved.unknownFields.remove(id)
        }
        reviews = plan.conflicts.map(reviewItem)
        for change in plan.changes where saved.blockedFields.contains(change.id) {
            var item = reviewItem(change)
            item.reason = "A prior operation failed or was uncertain. Automatic retry is blocked; review fresh values explicitly."
            item.canKeepSource = canResolve(change.id, preferSource: true, remote: remote, apple: apple, binding: binding)
            item.canKeepApple = canResolve(change.id, preferSource: false, remote: remote, apple: apple, binding: binding)
            if saved.unknownFields.contains(change.id) {
                item.reason = "A previous result is unknown. This field stays blocked until fresh observations show both sides agree; no retry is offered."
                item.canKeepSource = false; item.canKeepApple = false
            }
            reviews.append(item)
        }
        try persist()
        if applyAutomatic, let change = plan.changes.first(where: { !saved.blockedFields.contains($0.id) }) {
            try Task.checkCancellation()
            guard running else { return }
            try await execute(change, using: client)
        } else {
            status = remote.namesAuthoritative ? "Reviewed \(binding.deviceBindings.count) device bindings; \(reviews.count) differences need attention." :
                "Source names are unavailable. No changes were sent."
        }
    }

    func resolve(_ fieldID: String, keepSource: Bool) async {
        guard activeConnection, !busy, saved.pending == nil, profileReady, !saved.unknownFields.contains(fieldID) else { return }
        busy = true; defer { busy = false }
        do {
            guard let client, let binding = saved.bindings else { throw MetadataError.unsupportedOperation }
            let remote = try await client.snapshot()
            guard remote.serverId == binding.serverID, remote.sourceEpoch == saved.confirmedEpoch else { throw MetadataError.staleState }
            let apple = try homeKit.snapshot(homeID: binding.homeKitHomeID)
            // The visible review must still describe both current values. Never apply a stale user choice.
            guard let old = reviews.first(where: { $0.id == fieldID }) else { throw MetadataError.staleState }
            let current = SyncPlanner.plan(snapshot: remote, local: apple, bindings: binding, baselines: saved.baselines)
            let all = current.conflicts.map(reviewItem) + current.changes.map(reviewItem)
            guard let now = all.first(where: { $0.id == fieldID }),
                  exact(old.expectedSource, now.expectedSource), exact(old.expectedLocal, now.expectedLocal) else {
                throw MetadataError.staleState
            }
            let change = try SyncPlanner.resolve(fieldID: fieldID, preferSource: keepSource,
                snapshot: remote, local: apple, bindings: binding, baselines: saved.baselines)
            try await execute(change, using: client)
            try await cycle(applyAutomatic: false)
        } catch { show(error) }
    }

    private func execute(_ change: SyncChange, using client: MetadataHTTPClient) async throws {
        guard activeConnection, let binding = saved.bindings else { throw MetadataError.unsupportedOperation }
        // Re-read both sides immediately before issuing the single guarded operation.
        let fresh = try await client.snapshot()
        let apple = try homeKit.snapshot(homeID: binding.homeKitHomeID)
        guard fresh.serverId == binding.serverID, fresh.sourceEpoch == saved.confirmedEpoch else { throw MetadataError.staleState }
        let guarded = try SyncPlanner.resolve(fieldID: change.id, preferSource: change.direction == .toLocal,
            snapshot: fresh, local: apple, bindings: binding, baselines: saved.baselines)
        guard exact(guarded.expectedSource, change.expectedSource), exact(guarded.expectedLocal, change.expectedLocal),
              exact(guarded.value, change.value), guarded.direction == change.direction else { throw MetadataError.staleState }
        if change.direction == .toSource {
            let operation: MetadataOperation
            switch change.field {
            case .deviceName:
                guard let value = change.value else { throw MetadataError.invalidName }
                operation = .deviceRename(targetId: change.sourceTargetID, name: value)
            case .roomName:
                guard let value = change.value else { throw MetadataError.invalidName }
                operation = .roomRename(targetId: change.sourceTargetID, name: value)
            case .deviceRoom:
                guard let value = change.value else { throw MetadataError.unsupportedOperation }
                operation = .deviceMove(targetId: change.sourceTargetID, roomId: value)
            }
            guard operation.isSupported(by: fresh) else { throw MetadataError.unsupportedOperation }
            let command = try MetadataCommand(snapshot: fresh, operation: operation)
            saved.pending = PendingWrite(command: command, change: change, startedAt: Date())
            try persist() // A crash after POST must never cause an automatic resubmit.
            let initial = try await client.submit(command)
            let terminal = try await client.awaitReceipt(initial, serverID: binding.serverID, sourceEpoch: command.expected.sourceEpoch)
            try await finish(terminal, using: client)
        } else {
            saved.pending = PendingWrite(command: nil, change: change, startedAt: Date()); try persist()
            do {
                try await homeKit.apply(change: change, homeID: binding.homeKitHomeID)
                saved.blockedFields.insert(change.id); saved.pending = nil; try persist()
                try await confirmAgreement(change: change, using: client)
            } catch {
                saved.blockedFields.insert(change.id); saved.pending = nil; try persist(); throw error
            }
        }
    }

    private func refreshForCurrentEpoch(using client: MetadataHTTPClient) async throws {
        guard let snapshot else { throw MetadataError.invalidResponse }
        let command = try MetadataCommand(snapshot: snapshot, operation: .refresh)
        saved.pending = PendingWrite(command: command, change: nil, startedAt: Date()); try persist()
        let initial = try await client.submit(command)
        let result = try await client.awaitReceipt(initial, serverID: snapshot.serverId, sourceEpoch: command.expected.sourceEpoch)
        try await finish(result, using: client)
    }

    func checkPendingReceipt() async {
        guard !busy, let client else { return }; busy = true; defer { busy = false }
        do { try await recoverPending(using: client); receiptUnavailable = false }
        catch MetadataError.commandNotFound { receiptUnavailable = true; show(MetadataError.commandNotFound) }
        catch { show(error) }
    }

    /// Explicit acknowledgement clears only the unqueryable receipt, never resends
    /// its command, and keeps the affected field blocked until observed agreement.
    func acknowledgeMissingReceipt() async {
        guard !busy, activeConnection, receiptUnavailable, let client,
              let pending = saved.pending, let command = pending.command else { return }
        busy = true; defer { busy = false }
        do {
            let current = try await client.snapshot()
            guard current.serverId == command.expected.serverId else { throw MetadataError.wrongSource }
            if let id = pending.change?.id {
                saved.blockedFields.insert(id); saved.unknownFields.insert(id)
            }
            saved.pending = nil; receiptUnavailable = false; snapshot = current
            try persist()
            try await refreshForCurrentEpoch(using: client)
            if profileReady { try await cycle(applyAutomatic: false) }
            status = "Unavailable receipt acknowledged without resending it. Its field stays blocked until both sides are observed to agree."
        } catch { show(error) }
    }

    private func recoverPending(using client: MetadataHTTPClient) async throws {
        guard let command = saved.pending?.command else { return }
        let receipt = try await client.receipt(commandID: command.commandId, serverID: command.expected.serverId,
            sourceEpoch: command.expected.sourceEpoch)
        let result = try await client.awaitReceipt(receipt, serverID: command.expected.serverId, sourceEpoch: command.expected.sourceEpoch)
        try await finish(result, using: client)
    }

    private func finish(_ receipt: CommandReceipt, using client: MetadataHTTPClient) async throws {
        guard let pending = saved.pending, let command = pending.command else { throw MetadataError.invalidResponse }
        try receipt.validate(commandId: command.commandId, serverId: command.expected.serverId, sourceEpoch: command.expected.sourceEpoch)
        guard receipt.status.isTerminal else { throw MetadataError.receiptTimeout }
        if receipt.status != .confirmed {
            if let id = pending.change?.id { saved.blockedFields.insert(id) }
            if receipt.status == .uncertain, let id = pending.change?.id { saved.unknownFields.insert(id) }
            saved.pending = nil; try persist()
            status = "The command was \(receipt.status.rawValue). No retry was sent; review the current values."
            throw MetadataError.staleState
        }
        guard let confirmed = receipt.snapshot, confirmed.namesAuthoritative,
              confirmed.sourceEpoch == command.expected.sourceEpoch else { throw MetadataError.invalidResponse }
        snapshot = confirmed; saved.confirmedEpoch = confirmed.sourceEpoch
        if let id = pending.change?.id { saved.blockedFields.insert(id) }
        saved.pending = nil; try persist()
        if let change = pending.change { try await confirmAgreement(change: change, using: client) }
    }

    private func confirmAgreement(change: SyncChange, using client: MetadataHTTPClient) async throws {
        guard let binding = saved.bindings else { throw MetadataError.unsupportedOperation }
        let remote = try await client.snapshot()
        guard remote.serverId == binding.serverID, remote.sourceEpoch == saved.confirmedEpoch else { throw MetadataError.staleState }
        let apple = try homeKit.snapshot(homeID: binding.homeKitHomeID)
        let plan = SyncPlanner.plan(snapshot: remote, local: apple, bindings: binding, baselines: saved.baselines)
        snapshot = remote; local = apple
        guard matchesRequested(change, remote: remote, apple: apple, binding: binding),
              let baseline = plan.agreements[change.id] else {
            saved.blockedFields.insert(change.id); try persist(); throw MetadataError.staleState
        }
        saved.baselines[change.id] = baseline; saved.blockedFields.remove(change.id); try persist()
        status = "Both sides confirmed the selected value. Baseline updated."
    }

    private func matchesRequested(_ change: SyncChange, remote: MetadataSnapshot, apple: LocalSnapshot,
                                  binding: ProfileBindings) -> Bool {
        switch change.field {
        case .deviceName:
            guard let source = remote.devices.first(where: { $0.id == change.sourceTargetID }),
                  let local = apple.devices.first(where: { $0.id == change.localTargetID }) else { return false }
            return source.name.utf8.elementsEqual(change.value?.utf8 ?? "".utf8) &&
                local.name.utf8.elementsEqual(change.value?.utf8 ?? "".utf8)
        case .roomName:
            guard remote.roomsAvailable,
                  let source = remote.rooms.first(where: { $0.id == change.sourceTargetID }),
                  let local = apple.rooms.first(where: { $0.id == change.localTargetID }) else { return false }
            return source.name.utf8.elementsEqual(change.value?.utf8 ?? "".utf8) &&
                local.name.utf8.elementsEqual(change.value?.utf8 ?? "".utf8)
        case .deviceRoom:
            guard remote.roomsAvailable, let source = remote.devices.first(where: { $0.id == change.sourceTargetID }),
                  source.roomStatus == .assigned, let sourceRoom = source.roomId,
                  let local = apple.devices.first(where: { $0.id == change.localTargetID }),
                  let mapped = binding.roomBindings[sourceRoom], local.roomID == mapped else { return false }
            return change.direction == .toSource ? sourceRoom == change.value : mapped == change.value
        }
    }

    private func reviewItem(_ item: SyncConflict) -> ReviewItem {
        ReviewItem(id: item.id, title: title(item.field, item.sourceTargetID),
            sourceValue: item.sourceValue ?? "Unassigned", appleValue: item.localValue ?? "Unassigned",
            reason: saved.unknownFields.contains(item.id) ? "A prior result is unknown. Wait for observed agreement; this field will not be retried." : item.reason,
            canKeepSource: item.canUseSource && !saved.unknownFields.contains(item.id),
            canKeepApple: item.canUseLocal && !saved.unknownFields.contains(item.id), field: item.field,
            expectedSource: item.expectedSource, expectedLocal: item.expectedLocal)
    }
    private func reviewItem(_ change: SyncChange) -> ReviewItem {
        var localValue = change.expectedLocal
        if change.field == .deviceRoom, let native = localValue {
            localValue = saved.bindings?.roomBindings.first(where: { $0.value == native })?.key ?? native
        }
        return ReviewItem(id: change.id, title: title(change.field, change.sourceTargetID),
            sourceValue: change.expectedSource ?? "Unassigned", appleValue: localValue ?? "Unassigned",
            reason: "", canKeepSource: true, canKeepApple: true, field: change.field,
            expectedSource: change.expectedSource, expectedLocal: change.expectedLocal)
    }
    func displayValue(_ value: String, field: SyncField) -> String {
        guard field == .deviceRoom else { return value }
        if let room = snapshot?.rooms.first(where: { $0.id == value }) { return room.name }
        if let room = local?.rooms.first(where: { $0.id == value }) { return room.name + " (not bound)" }
        return value
    }
    private func canResolve(_ id: String, preferSource: Bool, remote: MetadataSnapshot, apple: LocalSnapshot,
                            binding: ProfileBindings) -> Bool {
        (try? SyncPlanner.resolve(fieldID: id, preferSource: preferSource, snapshot: remote,
            local: apple, bindings: binding, baselines: saved.baselines)) != nil
    }
    private func title(_ field: SyncField, _ sourceID: String) -> String {
        let name = snapshot?.devices.first { $0.id == sourceID }?.name ?? snapshot?.rooms.first { $0.id == sourceID }?.name ?? sourceID
        switch field { case .deviceName: return "Device name · \(name)"
        case .deviceRoom: return "Device room · \(name)"
        case .roomName: return "Room name · \(name)" }
    }
    private func show(_ error: Error) {
        if let safe = error as? MetadataError { status = safe.localizedDescription }
        else if error is CancellationError { status = "Synchronization paused. Any accepted command remains available for receipt review." }
        else { status = "The operation could not be completed. Check Home permission, connectivity, and saved bindings. No automatic retry was sent." }
    }
    private func exact(_ left: String?, _ right: String?) -> Bool {
        switch (left, right) {
        case (nil, nil): return true
        case (.some(let left), .some(let right)): return left.utf8.elementsEqual(right.utf8)
        default: return false
        }
    }

    private func stateURL() throws -> URL {
        let root = try FileManager.default.url(for: .applicationSupportDirectory, in: .userDomainMask,
            appropriateFor: nil, create: true).appendingPathComponent("TuyaMetadataCompanion", isDirectory: true)
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true,
            attributes: [.posixPermissions: 0o700])
        return root.appendingPathComponent("bindings-v1.json")
    }
    private func persist() throws {
        let url = try stateURL()
        let data = try JSONEncoder().encode(saved)
        try data.write(to: url, options: .atomic)
        try FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: url.path)
    }
}
