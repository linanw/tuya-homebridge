# Changelog / 更新日志

Release notes are available in English and Simplified Chinese. Homebridge UI's **What's New / Notes** displays the matching [GitHub Release](https://github.com/linanw/tuya-homebridge/releases). The changelog is also included in future npm packages.

以下提供英文和简体中文更新说明。Homebridge 插件管理的 **What's New / 更新说明** 读取对应版本的 [GitHub Release](https://github.com/linanw/tuya-homebridge/releases)；后续 npm 包也会包含本更新日志。

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
