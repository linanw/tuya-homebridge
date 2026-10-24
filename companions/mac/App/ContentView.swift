import SwiftUI

@MainActor
struct ContentView: View {
    @ObservedObject var model: CompanionModel
    @ObservedObject private var homeKit: HomeKitStore

    init(model: CompanionModel) {
        self.model = model
        _homeKit = ObservedObject(wrappedValue: model.homeKit)
    }

    var body: some View {
        NavigationStack {
            Form {
                Section("Metadata server / 元数据服务") {
                    TextField("https://bridge.example:8443", text: $model.serverURL)
                        .textInputAutocapitalization(.never).autocorrectionDisabled()
                        .disabled(model.running || model.busy)
                    SecureField("Bearer token (saved only in Keychain)", text: $model.tokenInput)
                        .textInputAutocapitalization(.never).autocorrectionDisabled()
                        .disabled(model.running || model.busy)
                    HStack {
                        Button("Connect / 连接") { Task { await model.connect() } }
                            .disabled(model.busy || model.running)
                        Button("Forget token / 删除令牌") { model.forgetToken() }
                            .disabled(model.busy || model.running)
                        if model.busy { ProgressView() }
                    }
                    Text(model.capabilitySummary).font(.caption).foregroundStyle(.secondary)
                }

                Section("Apple Home / Apple 家庭") {
                    Button("Authorize HomeKit / 授权家庭访问") { homeKit.authorize() }
                    Text(homeKit.status).font(.caption)
                    Picker("Apple home", selection: $model.appleHomeID) {
                        Text("Select explicitly / 请选择").tag("")
                        ForEach(homeKit.homes, id: \.uniqueIdentifier) { home in
                            Text(home.name).tag(home.uniqueIdentifier.uuidString.lowercased())
                        }
                    }.disabled(model.running || model.busy)
                    Picker("Source home / 源家庭", selection: $model.sourceHomeID) {
                        Text("Select explicitly / 请选择").tag("")
                        ForEach(model.sourceHomes) { home in Text(home.name).tag(home.id) }
                        if model.supportsNameOnlyProfile {
                            Text("This server — device names only / 仅设备名").tag(CompanionModel.nameOnlySelection)
                        }
                    }.disabled(model.running || model.busy)
                    Button("Read Apple selection / 读取所选家庭") { Task { await model.readAppleSelection() } }
                        .disabled(model.appleHomeID.isEmpty || model.running || model.busy)
                    Text("Bind stable IDs explicitly. A HAP UUID is not an Apple Home UUID. Matching names are not identity proof.")
                        .font(.caption).foregroundStyle(.secondary)
                }

                Section("Device bindings / 设备映射") {
                    ForEach(model.sourceDevices) { source in
                        VStack(alignment: .leading) {
                            Text(source.name)
                            Text(source.id).font(.caption2).foregroundStyle(.secondary).textSelection(.enabled)
                            Picker("Apple accessory", selection: deviceBinding(source.id)) {
                                Text("Not bound / 未绑定").tag("")
                                ForEach(model.appleDevices) { local in
                                    Text("\(local.name) · \(local.id.prefix(8))").tag(local.id)
                                }
                            }
                            if model.projectionSuggestion(for: source.id) {
                                Toggle("I confirm this Apple name is the known HAP label projection / 确认这是协议截断名称",
                                    isOn: Binding(get: { model.projectionDrafts[source.id] ?? false },
                                        set: { model.projectionDrafts[source.id] = $0 }))
                                    .font(.caption)
                            }
                        }
                    }
                    if model.sourceDevices.isEmpty { Text("Connect and select a source profile first.").foregroundStyle(.secondary) }
                }.disabled(model.running || model.busy)

                Section("Room bindings / 房间映射") {
                    ForEach(model.sourceRooms) { source in
                        VStack(alignment: .leading) {
                            Text(source.name)
                            Picker("Apple room", selection: roomBinding(source.id)) {
                                Text("Not bound / 未绑定").tag("")
                                ForEach(model.appleRooms) { local in Text(local.name).tag(local.id) }
                            }
                        }
                    }
                    Text("No rooms are created or deleted. Incomplete room reads disable room operations. Custom profiles synchronize names only.")
                        .font(.caption).foregroundStyle(.secondary)
                }.disabled(model.running || model.busy || model.sourceHomeID == CompanionModel.nameOnlySelection)

                Section("Synchronization / 同步") {
                    Button("Confirm these bindings / 确认以上映射") { Task { await model.confirmBindings() } }
                        .disabled(model.running || model.busy || !model.connected || model.hasPendingReceipt)
                    Button("Reset local bindings / 重设本地映射", role: .destructive) { model.resetBindings() }
                        .disabled(model.running || model.busy || model.hasPendingReceipt)
                    HStack {
                        Button("Start / 开始") { model.start() }.disabled(!model.canStart)
                        Button("Stop / 停止") { model.stop() }.disabled(!model.running)
                        Button("Refresh and review / 刷新检查") { Task { await model.review() } }
                            .disabled(model.busy || !model.profileReady)
                    }
                    Text(model.status).textSelection(.enabled)
                    Text("Keep this app running and your Mac awake. Quit, sleep, lost access or connectivity pauses progress.")
                        .font(.caption).foregroundStyle(.secondary)
                    if model.hasPendingReceipt {
                        Text("A previous write needs receipt review. It will never be resent automatically.").foregroundStyle(.orange)
                        Button("Check existing receipt / 检查已有回执") { Task { await model.checkPendingReceipt() } }
                            .disabled(model.busy || !model.connected)
                        if model.receiptUnavailable {
                            Button("Acknowledge missing receipt; keep its field blocked / 确认回执丢失并锁定该字段") {
                                Task { await model.acknowledgeMissingReceipt() }
                            }.disabled(model.busy || !model.connected)
                        }
                    }
                }

                Section("Review differences / 差异确认") {
                    ForEach(model.reviews) { item in
                        VStack(alignment: .leading, spacing: 7) {
                            Text(item.title).font(.headline)
                            Text("Tuya: \(model.displayValue(item.sourceValue, field: item.field))")
                            Text("Apple: \(model.displayValue(item.appleValue, field: item.field))")
                            Text(item.reason).font(.caption).foregroundStyle(.secondary)
                            HStack {
                                Button("Keep Tuya / 保留涂鸦") { Task { await model.resolve(item.id, keepSource: true) } }
                                    .disabled(model.busy || !item.canKeepSource)
                                Button("Keep Apple / 保留 Apple") { Task { await model.resolve(item.id, keepSource: false) } }
                                    .disabled(model.busy || !item.canKeepApple)
                            }
                        }.padding(.vertical, 4)
                    }
                    if model.reviews.isEmpty { Text("No unresolved differences in the latest review.").foregroundStyle(.secondary) }
                }
            }
            .formStyle(.grouped)
            .navigationTitle("Tuya Metadata Companion")
            .task { await model.restoreSelection() }
            .onChange(of: model.appleHomeID) { _, _ in model.selectionChanged() }
            .onChange(of: model.sourceHomeID) { _, _ in model.selectionChanged() }
            .onChange(of: model.deviceDrafts) { _, _ in model.mappingChanged() }
            .onChange(of: model.roomDrafts) { _, _ in model.mappingChanged() }
            .onChange(of: model.projectionDrafts) { _, _ in model.mappingChanged() }
            .onChange(of: model.serverURL) { _, _ in model.connectionEdited() }
            .onChange(of: model.tokenInput) { _, _ in model.connectionEdited() }
        }
    }

    private func deviceBinding(_ id: String) -> Binding<String> {
        Binding(get: { model.deviceDrafts[id] ?? "" }, set: { model.deviceDrafts[id] = $0 })
    }
    private func roomBinding(_ id: String) -> Binding<String> {
        Binding(get: { model.roomDrafts[id] ?? "" }, set: { model.roomDrafts[id] = $0 })
    }
}
