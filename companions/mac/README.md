# Tuya Metadata Companion / 涂鸦元数据伴侣

This is an iPad / **Mac Catalyst** HomeKit app, not a native macOS HomeKit executable. It connects to the opt-in Metadata Sync v1 server in this repository. The Foundation-only `Core` package can also be tested on Linux. Apple Home access requires a signed app, the HomeKit entitlement, and the user's permission.

这是 iPad / **Mac Catalyst** HomeKit 应用，不是直接在原生 macOS 程序中导入 HomeKit。它连接本仓库可选的 Metadata Sync v1 服务。纯 Foundation 的 `Core` 可在 Linux 测试。访问 Apple 家庭必须正确签名、具备 HomeKit entitlement，并取得用户授权。

## Build and run / 构建运行

1. On a Mac with Xcode 16 or later, install XcodeGen (`brew install xcodegen`). Run `xcodegen generate --spec companions/mac/project.yml` from the repository root.
2. Open `companions/mac/TuyaMetadataCompanion.xcodeproj`. Select your development team under Signing & Capabilities. Use a bundle ID for which your team can enable HomeKit. Keep the HomeKit capability enabled. For a distributable build, configure the appropriate App ID, provisioning profile, and distribution signing with Apple.
3. Select **My Mac (Mac Catalyst)**, build, and run. Allow Home access when requested. Select the exact Apple home, source home (or the Custom device-name-only profile), and each device/room mapping. Names are never used to guess identity.
4. Enter your server's HTTPS base URL and bearer token. Only exact loopback hosts (`localhost`, `127.0.0.1`, `::1`) permit HTTP for development. A remote server needs a normally trusted HTTPS certificate. All HTTP redirects are rejected.
5. Review initial differences and explicitly select which value to keep. Start synchronization after checking the bindings. Stop synchronization before changing bindings.

在 Mac 上安装 Xcode 16+ 与 XcodeGen，生成并打开工程，选择自己的签名团队及可启用 HomeKit 的 bundle ID，选择 **My Mac (Mac Catalyst)** 运行并授权家庭。输入 HTTPS 服务地址和令牌，选择家庭并逐一确认设备、房间映射。第一次不同名需要手动选择保留哪一边。只允许精确 loopback 地址使用开发 HTTP；不接受重定向、跳过 TLS 验证或在 URL 中嵌入密码。

The app must remain running and the Mac awake. Minimizing its window is fine. Quitting the app, sleeping the Mac, revoking Home access, or losing connectivity stops progress. This is not a background daemon. iPad background suspension also prevents continuous synchronization. An unsigned CI build verifies compilation only; it cannot prove real HomeKit permission, signing, household access, or physical-device behavior.

应用必须保持运行，Mac 必须保持唤醒；可以最小化窗口。退出、睡眠、撤销授权或断网均会停止同步。这不是后台守护程序；iPad 被系统挂起后也不能持续同步。CI 无签名构建只能验证编译，不能代替真实签名、家庭授权及设备验证。

## What can synchronize / 当前能力

The server declares capabilities for the current Tuya authentication model. PaaS can read Tuya App homes, rooms and names; its cloud writes are disabled until a verified write contract is implemented. Custom projects expose device names, not Smart Home App rooms; `renameDevice` works only when explicitly enabled by the server administrator. A Custom profile can explicitly bind an Apple home to the server for **device names only**, even when the source home list is empty. Full bidirectional room synchronization is therefore unavailable with these current providers. Unsupported directions are shown as conflicts and never reported as successful.

服务端能力决定可同步方向：PaaS 可以读取涂鸦 App 家庭、房间、名称，当前不提供已验证的云写入；Custom 只提供设备名，且仅管理员明确开启时可改云端设备名，不提供 App 房间。Custom 可以显式选择 Apple 家庭并绑定到服务器，进行**仅设备名称**同步。当前 provider 不支持完整双向房间同步，应用不会伪造成功。

Mappings and last-agreed baselines stay in this app's local Application Support directory. Tokens are kept separately in a non-synchronizing `ThisDeviceOnly` Keychain item scoped to the normalized server URL. Removing a token does not change the server's configured token; rotate it at the server when necessary. No token belongs in a sample JSON file, screenshot, log, or Git commit.

Bindings use stable source IDs and the selected home's HomeKit UUIDs, with explicit confirmation. A HAP accessory UUID is not a HomeKit accessory UUID. Shared/default serial numbers are not identity proof. The app does not read Apple's private Home database, Google Home's private room graph, or other applications' local files. MatterDesk can implement the same public HTTP protocol independently; ordinary Matter pairing does not expose a controller's room database.

Three-way comparison advances a baseline only after both sides are observed to agree. Initial or divergent differences need review. Known protocol label truncation is not treated as a user rename. Missing/incomplete room information blocks room operations, not authoritative device-name reads. The app never creates/deletes rooms or treats missing data as a deletion. Failed/uncertain cloud writes are not resubmitted automatically; existing command receipts can be checked after reconnecting.

映射与基线仅存本地，令牌单独保存到按规范化服务地址隔离、不可同步的本机 Keychain。映射使用稳定 ID，不能把 HAP UUID 当作 Apple 家庭 UUID，也不能用名称相似度或重复序列号猜测设备。只在双方确认一致后推进基线；初次差异、冲突和不确定结果需人工处理。已知协议截断不应反向覆盖完整云名称。缺失房间信息不等于删除房间，失败或不确定写入不会自动重发。

## Checks / 检查

```sh
swift test --package-path companions/mac/Core
xcodegen generate --spec companions/mac/project.yml
xcodebuild -project companions/mac/TuyaMetadataCompanion.xcodeproj \
  -scheme TuyaMetadataCompanion -destination 'platform=macOS,variant=Mac Catalyst' \
  CODE_SIGNING_ALLOWED=NO build
```

The dedicated GitHub Actions workflow runs these portable Core tests and the unsigned Catalyst build. Real household authorization and runtime synchronization require testing a signed app on the intended Mac.
