# Changelog / 更新日志

Release notes are available in English and Simplified Chinese. Homebridge UI's **What's New / Notes** displays the matching [GitHub Release](https://github.com/linanw/tuya-homebridge/releases). The changelog is also included in future npm packages.

以下提供英文和简体中文更新说明。Homebridge 插件管理的 **What's New / 更新说明** 读取对应版本的 [GitHub Release](https://github.com/linanw/tuya-homebridge/releases)；后续 npm 包也会包含本更新日志。

## [2.8.0] - 2026-10-31

### English

- Add automatic support for Tuya's standard `hps` human-presence category through read-only HomeKit `OccupancySensor` and Matter `OccupancySensing`.
- Read the standard Enum `presence_state`: `none` means unoccupied; `presence`, `peaceful`, `small_move` and `large_move` mean occupied. Stationary occupancy persists until the device reports `none`, without a synthetic clearing timer.
- Publish a new sensor after its first valid reading; retain its last confirmed state and mark HomeKit inactive/faulted on invalid reports, including full accessory-list reads.
- Exclude Boolean self-test values from occupancy interpretation. Other vendor datapoints/types are not automatically inferred. Driver overrides `HumanPresenceSensor`, `OccupancySensor` and `hps` still require the standard Enum; no sensitivity, distance, delay, self-test or battery features are added.
- Use the generic Matter `Other` detector feature with occupancy events. Rebuild incompatible cached feature layouts with the same accessory UUID and endpoint number, preserving pairing storage.
- Update the stable installation guide to 2.8.0, including Docker Homebridge UI upgrades. The metadata service, schema version 1 and opt-in write scope are unchanged; Mac and desktop clients remain test versions. See the [presence setup](README.md#human-presence-sensors) and [official Tuya standard](https://developer.tuya.com/en/docs/iot/s?id=K9j2w4p710ge9).

### 简体中文

- 新增涂鸦标准 `hps` 人体存在类别的自动适配，以只读方式映射到 HomeKit `OccupancySensor` 与 Matter `OccupancySensing`。
- 读取标准 Enum 枚举 `presence_state`：`none` 表示无人，`presence`、`peaceful`、`small_move`、`large_move` 均表示有人。人员静止时持续保持有人，直到设备报告 `none`，不以定时器伪造清除。
- 新传感器首次有效读取后才发布；无效上报时保留最后确认值并标记 HomeKit 非活动／故障，包含完整配件列表读取场景。
- 布尔自检值不参与占用判断，不自动猜测其他厂商数据点或类型。`HumanPresenceSensor`、`OccupancySensor`、`hps` 驱动覆盖仍要求标准枚举；不新增灵敏度、距离、延时、自检或电池功能。
- Matter 使用通用 `Other` 检测特性与占用事件。旧缓存特性不兼容时以相同配件 UUID 和端点号重建，保留配对存储。
- 正式版安装指引更新为 2.8.0，包含 Docker Homebridge UI 升级方式。元数据服务、schema version 1 和写入范围不变，Mac 与桌面客户端仍为测试版。详见[人体存在配置](README.zh-CN.md#人体存在传感器)及[涂鸦官方标准](https://developer.tuya.com/en/docs/iot/s?id=K9j2w4p710ge9)。

## [2.7.0] - 2026-10-24

### English

- Promote the beta.3 runtime to the stable npm `latest` channel without new runtime changes. Homebridge What's New uses the matching `v2.7.0` GitHub Release; beta tags remain available as history.
- Fix query signing present in 2.6.2 that could cause `1004 sign invalid`, including comma-separated batch device IDs: sort query keys, use RFC 3986 transport encoding and decode the canonical URL once.
- Fix Matter window-covering confirmation timeouts and stale cached movement at the target. Let Homebridge derive motion while preserving exact position/configuration checks, Tuya datapoints, endpoints and pairings.
- Show the actual failed HAP characteristic and add static operation labels plus a safe `2001` hint: **Tuya API reports device offline**. Lighting command payloads are unchanged.
- Add an optional authenticated metadata service for names and App homes/rooms. It starts disabled; cloud writes require separate `allowWrites`. PaaS supports device and room rename, Custom supports device rename only, and device moves remain disabled. Ordinary Matter pairing does not expose Apple/Google private home data.
- Keep the Mac companion and MatterDesk 0.7.0-beta.1 / MatterCamViewer 2.5.0-beta.1 clients as test versions. 171 automated tests pass, with successful physical smoke validation reported for beta.3; permissions and behavior have not been verified for every Tuya account. Homebridge verification remains pending.

### 简体中文

- 将 beta.3 运行代码提升为 npm `latest` 正式版，不新增运行逻辑。Homebridge 更新说明读取对应 `v2.7.0` GitHub Release，原 beta 标签保留历史。
- 修复 2.6.2 中已存在、可能触发 `1004 sign invalid` 的 query 签名，包括逗号分隔批量设备 ID：按键排序、RFC 3986 编码传输、canonical URL 解码一次。
- 修复 Matter 窗帘状态确认超时及到位后的旧缓存运动状态。由 Homebridge 派生运动状态，继续精确确认位置与配置，保留涂鸦数据点、端点和配对。
- HAP 错误显示实际失败的特征，增加静态操作标签及 `2001` 的**涂鸦 API 报告设备离线**提示，照明指令内容保持不变。
- 新增默认关闭、需要令牌的元数据服务，读取名称及 App 家庭/房间。云写入另需开启 `allowWrites`：PaaS 支持设备与房间改名，Custom 仅设备改名；设备移房保持禁用。普通 Matter 配对不会授予 Apple/Google 私有家庭数据访问权。
- Mac 伴侣及 MatterDesk 0.7.0-beta.1 / MatterCamViewer 2.5.0-beta.1 客户端仍为测试版。171 项自动化测试通过，beta.3 的实机冒烟验证已获正常反馈；未验证所有涂鸦账号的权限与行为，Homebridge 认证仍待评审。

## [2.7.0-beta.3] - 2026-10-24

### English

- Fix Matter window-covering confirmation timeouts reproduced with Homebridge 2.4. The HAP `PositionState` default is not physical motion feedback; let the native server derive motion and continue confirming target/current positions exactly.
- On registration, correct legacy cached movement when confirmed target/current positions coincide, without operating the motor or replacing the endpoint.
- Preserve Tuya datapoint commands, position/configuration checks and pairing data. Restore the physical target after native initialization as before.
- Report the actual failed lighting characteristic instead of always saying `Brightness`. Add a static `device command` label and the hint **Tuya API reports device offline** for `2001`. Command payloads are unchanged.
- The API rejection is not resolved by this diagnostic change. If App control works over mobile data, check the same device's cloud-project `online` status, account linkage and data center.
- Publish through `beta`; stable `latest` stays at 2.6.2. Desktop versions remain MatterDesk 0.7.0-beta.1 and MatterCamViewer 2.5.0-beta.1.

### 简体中文

- 修复已在 Homebridge 2.4 复现的 Matter 窗帘状态确认超时。HAP `PositionState` 默认值并非真实运动反馈，改由原生服务派生运动状态，继续精确确认目标与当前位置。
- 注册时，对已确认目标与当前位置相等的窗帘，一次性修正旧缓存残留的运动状态，不操作电机或替换端点。
- 保留涂鸦数据点指令、位置与配置检查、配对数据；原生初始化后仍恢复设备目标位置。
- 照明错误日志显示实际失败的特征，不再固定写成 `Brightness`；新增静态 `device command` 标签及 `2001` 的**涂鸦 API 报告设备离线**提示，本次不修改指令内容。
- 诊断改进不代表解决 API 拒绝。即使 App 通过移动数据仍可控，也需核对云项目中同一设备的 `online` 状态、关联账号与数据中心。
- 通过 `beta` 发布，稳定 `latest` 保持 2.6.2；桌面版本仍为 MatterDesk 0.7.0-beta.1、MatterCamViewer 2.5.0-beta.1。

## [2.7.0-beta.2] - 2026-10-24

### English

- Fix query signing in both API clients: sort keys, send RFC 3986-encoded values and decode the canonical URL once, following the [official SDK](https://github.com/tuya/tuya-connector-nodejs/blob/master/src/core/client.ts).
- Correct comma-separated batch `device_ids` signing that can cause `1004 sign invalid`. The defect also exists in 2.6.2 and is independent of metadata sync.
- Add static error `operation` labels such as `account login`, `associated device list` and `batch device functions`, without device IDs or URLs.
- For `1004`, upgrade to this beta and restart Homebridge, preserving credentials, storage and pairings. If it persists, share sanitized operation/error-code lines and version details.
- Offer this fix through `beta` first; stable `latest` stays at 2.6.2. Desktop AppImages remain MatterDesk 0.7.0-beta.1 and MatterCamViewer 2.5.0-beta.1.
- Offline regression tests cover sorting, encoding and batch IDs; live Tuya validation remains pending.

### 简体中文

- 修复两种 Tuya API 客户端的 query 签名：按[官方 SDK](https://github.com/tuya/tuya-connector-nodejs/blob/master/src/core/client.ts)规则对键排序，以 RFC 3986 编码传输，对 canonical URL 解码一次。
- 修正逗号分隔的批量 `device_ids` 签名可能触发 `1004 sign invalid` 的问题。此缺陷在 2.6.2 中也已存在，与元数据同步无关。
- 错误中新增静态 `operation` 标签，如 `account login`、`associated device list`、`batch device functions`，不包含设备 ID 或 URL。
- 遇到 `1004` 时先升级本 beta 并重启 Homebridge，保留凭据、存储与配对。若仍报错，提供脱敏的 operation/错误码日志及版本信息。
- 本修复先进入 `beta`，稳定 `latest` 保持 2.6.2。桌面 AppImage 仍为 MatterDesk 0.7.0-beta.1、MatterCamViewer 2.5.0-beta.1。
- 离线回归覆盖排序、编码及批量 ID；真实涂鸦联调仍待验证。

## [2.7.0-beta.1] - 2026-10-24

### English

- Add an opt-in, authenticated metadata service with source-scoped identities, conditional commands, persistent receipts and explicit provider capabilities.
- Add a Mac Catalyst HomeKit companion and shared MatterDesk/MatterCamViewer integration for explicit bindings and conflict-aware synchronization. Keep device pairings, Matter endpoints and existing controller aliases intact.
- Add opt-in device renaming for PaaS and Custom projects and room renaming for PaaS, using documented Tuya APIs. Device moves remain disabled because an incremental move contract has not been verified. Tuya API permissions and physical account/device behavior still require runtime validation. See the [beta setup](docs/metadata-sync/SETUP.md).
- Coalesce native command echoes while retaining physical-state reconciliation, including fan current speed. Verify both supported Node versions, the native Matter runtime, Mac Catalyst compilation and both Linux applications.
- Publish this version through the npm `beta` channel and a matching GitHub prerelease for Homebridge What's New. The stable `latest` channel remains on 2.6.2.

### 简体中文

- 新增默认关闭、需要令牌的元数据服务，提供来源身份隔离、条件命令、持久化回执及明确的云端能力声明。
- 新增 Mac Catalyst HomeKit 伴侣与 MatterDesk/MatterCamViewer 共享接入，通过明确绑定和冲突处理执行同步，保留设备配对、Matter 端点及原有控制器别名。
- 使用官方文档明确的接口，支持单独开启 PaaS/Custom 设备改名及 PaaS 房间改名。单设备增量移房语义尚未核实，保持禁用。真实涂鸦账号权限与设备行为仍需运行验证。详见[测试版配置](docs/metadata-sync/SETUP.md)。
- 合并原生命令自身的状态回声，保留风扇当前速度等物理状态回流；验证受支持 Node 版本、原生 Matter、Mac Catalyst 及两个 Linux 应用。
- 通过 npm `beta` 渠道发布，并提供对应 GitHub 预发布供 Homebridge 显示更新说明；稳定 `latest` 渠道保持 2.6.2。

## [2.6.2] - 2026-10-24

### English

- Declare both HomeKit (`supports-hap`) and native Matter transports, so Homebridge UI does not classify the plugin as Matter-only.
- Validate credentials and project-specific settings before starting cloud login, device discovery, or MQTT. Pass the selected language to both Tuya clients.
- Improve the settings GUI with masked password/access-secret inputs, valid project/app defaults, HTTPS Custom-project endpoints, and existing device override/disable options.
- Omit authentication payloads from diagnostics, redact known credentials, bound HTTP requests, and reject cloud command failures instead of reporting false success.
- Handle MQTT connection, decoding, and listener failures; cancel renewal timers and close connections on shutdown. Verify MQTT GCM authentication tags.
- Return an immediate communication error for unavailable accessory state instead of leaving HomeKit reads waiting indefinitely, and recover on subsequent device updates.
- Update Axios, use Node's built-in UUID generation, and remove unused production dependencies. Add supported-Node CI and verification readiness checks.
- Prepare an honest Homebridge verification request, including comparison with existing verified Tuya plugins. This release is **not certified or approved**; verification is decided by the Homebridge team.

### 简体中文

- 同时声明 HomeKit（`supports-hap`）和原生 Matter 协议，避免 Homebridge 插件管理误判为仅支持 Matter。
- 在启动云端登录、设备发现和 MQTT 前校验账号及项目专用配置；向两种涂鸦客户端传递所选语言。
- 完善设置界面：密码和 Access Secret 掩码、有效的项目/应用默认值、Custom 项目 HTTPS 端点，以及现有设备禁用和类型覆盖选项。
- 诊断信息不再输出鉴权请求内容，并对已知凭据脱敏；限制 HTTP 请求等待时间，云端控制失败时明确报错。
- 捕获 MQTT 连接、解密和消息回调错误，关闭时取消续期定时器并结束连接；校验 MQTT GCM 认证标签。
- 配件状态不可用时立即返回通信错误，避免 HomeKit 读取一直等待；收到后续设备状态后可恢复。
- 更新 Axios，使用 Node 内置 UUID，移除未使用的生产依赖；增加 Node 兼容性 CI 和认证准备检查。
- 准备如实说明同类已认证插件差异的 Homebridge 认证申请。此版本**尚未认证或获批**，最终由 Homebridge 团队评审决定。

## [2.6.1] - 2026-10-24

### English

- Fix startup crashes in wireless switches when battery or configuration datapoints were mistaken for button events.
- Reuse existing button services and datapoint subtypes when migrating from `@0x5e/homebridge-tuya-platform`, including single-button and four-button remotes. Preserve your Homebridge storage, cache, and pairings.
- Send only live button events, without replaying the last press during startup. Repeated identical presses still produce separate notifications. Wireless buttons remain available through HomeKit.
- Isolate device initialization and MQTT update failures so a failing device does not stop other devices from loading. Keep cached Matter endpoints when discovery is incomplete and report errors even when debug logging is disabled.
- Add English and Chinese setup guides, migration instructions, and versioned release notes for Homebridge UI.
- The complete suite passes 56 offline tests. Wireless-switch and error-handling regressions also pass on Homebridge 1.11.4 and 2.0.2. Physical devices and LAN commissioning have not been tested in the cloud environment.

**Updating:** Update `@linanw/homebridge-tuya-platform` to `2.6.1` in Homebridge UI and restart the Tuya child bridge. Do not clear accessory storage or reset pairings. Node.js 22+ and Homebridge 1.11.4+ are required; complete Matter support requires Homebridge **2.4+**. Homebridge 2.0.2 lacks some Matter battery and smoke-alarm capabilities.

### 简体中文

- 修复无线开关将电池、配置等非按键数据当作按键处理，导致插件启动崩溃的问题。
- 从 `@0x5e/homebridge-tuya-platform` 迁移时，复用原有按键服务和数据点 subtype，兼容单键、四键遥控器。请保留 Homebridge 存储目录、缓存及配对数据。
- 仅上报实时按键事件，启动时不回放上一次按键；连续相同按键仍分别发送通知。无线按键继续通过 HomeKit 提供。
- 隔离单个设备初始化和 MQTT 状态更新错误，避免影响其他设备加载；设备发现不完整时保留已缓存的 Matter 端点，关闭调试日志时仍显示错误。
- 补充中英文安装指南、迁移说明，以及供 Homebridge 插件管理显示的版本更新说明。
- 全部 56 项离线测试通过；无线开关和错误处理回归测试还在 Homebridge 1.11.4、2.0.2 上通过。云环境未验证真实设备和家庭局域网配对。

**升级方式：** 在 Homebridge 插件管理中更新 `@linanw/homebridge-tuya-platform` 至 `2.6.1`，然后重启涂鸦子桥，无需清空配件缓存或重新配对。要求 Node.js 22+、Homebridge 1.11.4+；完整 Matter 支持要求 Homebridge **2.4+**。Homebridge 2.0.2 缺少部分 Matter 电池和烟感能力。

## [2.6.0] - 2026-10-24

### English

- Add optional native Matter support alongside HomeKit using Homebridge 2.4+, reusing existing Tuya commands and MQTT updates.
- Map supported lights, switch/outlet channels, contact sensors, smoke alarms, fans, and window coverings. Unsupported services continue through HomeKit; gas alarms are not presented as water-leak sensors.
- Synchronize initial state, live updates, command failures, and restored caches while avoiding fan feedback loops. Keep existing commissioning storage to retain pairings.
- Publish under the standard Homebridge package name `@linanw/homebridge-tuya-platform` for automatic plugin discovery. Users of `@linanw/tuya-homebridge` should remove the old package and its custom `-P` entry before installing this package, preserving their storage and `TuyaPlatform` configuration.
- Require Node.js 22+ and Homebridge 1.11.4+ for HomeKit; Matter requires Homebridge 2.4+. Tuya communication remains cloud-dependent. Matter pairing requires a controller on the same LAN with IPv6 and multicast DNS.

### 简体中文

- 基于 Homebridge 2.4+ 原生 Matter 接口，新增可选 Matter 桥接，可与 HomeKit 同时使用，复用已有涂鸦控制指令和 MQTT 状态更新。
- 支持具备相应能力的灯、多路开关/插座、门磁、烟感、风扇和窗帘。不支持的服务继续通过 HomeKit 提供；燃气报警器不会被误标为水浸传感器。
- 同步初始状态、实时变化、控制错误及恢复后的缓存，避免风扇状态反馈循环；保留配对存储以维持已有配对。
- 使用符合 Homebridge 命名规则的 `@linanw/homebridge-tuya-platform`，支持插件自动发现。旧包 `@linanw/tuya-homebridge` 用户应先移除旧包及其自定义 `-P` 路径，保留存储目录和 `TuyaPlatform` 配置后再安装新包。
- HomeKit 要求 Node.js 22+、Homebridge 1.11.4+；Matter 要求 Homebridge 2.4+。设备通信仍依赖涂鸦云；Matter 配对需要控制器与 Homebridge 位于同一局域网，并支持 IPv6 和组播 DNS。
