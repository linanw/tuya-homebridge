# @linanw/homebridge-tuya-platform

[English](README.md) | 简体中文

[![npm](https://img.shields.io/npm/v/@linanw/homebridge-tuya-platform.svg)](https://www.npmjs.com/package/@linanw/homebridge-tuya-platform)
[![npm](https://img.shields.io/npm/dt/@linanw/homebridge-tuya-platform.svg)](https://www.npmjs.com/package/@linanw/homebridge-tuya-platform)

由 linanw 维护的 Homebridge 涂鸦插件，通过 Tuya Open API 将设备接入 HAP（HomeKit），并可使用 Homebridge 的原生 Matter 桥接接入 Apple Home、Google Home 等平台。HAP 与 Matter 可同时使用。该项目基于涂鸦原始 Homebridge 插件开发。

## What's New / 更新日志

**2.8.0** 新增涂鸦标准 `hps` 类别的人体存在传感器，以只读方式映射到 HomeKit `OccupancySensor` 与 Matter `OccupancySensing`。人员静止时仍保持有人，直到设备报告 `none`，不会用定时器自动清除。详见[支持的状态与驱动覆盖](#人体存在传感器)。

可选[元数据服务](docs/metadata-sync/SETUP.md)默认关闭。另行开启 `allowWrites` 后，PaaS 可写设备名和房间名，Custom 仅可写设备名；设备移房仍禁用。Mac 伴侣及 [MatterDesk 0.7.0-beta.1 / MatterCamViewer 2.5.0-beta.1 客户端](https://github.com/linanw/MatterDesk/blob/matterdesk-v0.7.0-beta.1/docs/TUYA_METADATA_SYNC.md)仍为测试版，实际账号权限可能不同。

升级说明见 [2.8.0 正式 Release](https://github.com/linanw/tuya-homebridge/releases/tag/v2.8.0) 与 [CHANGELOG.md](CHANGELOG.md)。npm `beta` 标签保留 beta.3 历史，正式安装使用 `latest`。

**2.6.2** 为 Homebridge 认证评审做准备，完善账号配置校验和设置界面，并明确声明同时支持 HAP 与 Matter。

**2.6.1** 修复了无线开关上报电池等非按键数据时导致的启动崩溃。迁移缓存时保留原按键服务标识，启动时不回放上一次按键事件。具体步骤见下方的旧插件迁移说明。

### Homebridge 认证状态

状态：**认证准备，待评审**。本次更新按 [Homebridge 认证要求](https://github.com/homebridge/plugins/wiki/Verified-Plugins) 整理插件。是否通过由 Homebridge 团队审核决定，目前尚未获得认证。

详见[技术准备评估及同类已认证插件对比](https://github.com/linanw/tuya-homebridge/blob/linanw-package/docs/VERIFICATION.md)。功能不重复这一项需要个案评审，准备的申请会明确说明已有同类功能的重叠。

## 运行要求

| 功能 | 最低要求 |
| --- | --- |
| Node.js | Node 22 LTS（22.13.1 起），或 Node 24 LTS |
| HomeKit | Homebridge 1.11.4 或更高版本 |
| Matter | Homebridge 2.4 或更高版本 |

Tuya 设备的控制和状态通知仍依赖涂鸦云服务。启用 Matter 不会将这些设备转换为完全离线的本地设备，也不会让设备本身获得原生 Matter 固件。

## 更新至 2.8.0 正式版

在 Homebridge UI 正常更新插件，或通过 **⋮ → 管理版本**选择 **2.8.0**；beta 用户也可通过此入口切回正式版。CLI 必须在实际运行 Homebridge 的同一套 Node/npm 环境或容器中执行：

```sh
npm install -g @linanw/homebridge-tuya-platform@latest
# 固定正式版本：
npm install -g @linanw/homebridge-tuya-platform@2.8.0
```

随后重启现有 Homebridge 服务，保留配置、子桥身份、存储和配对，无需清空缓存或重新配对。Docker Homebridge 请通过原容器的 UI 更新，或在该容器内执行 npm；在 Docker 宿主机安装不会更新容器内插件。

元数据服务默认关闭。按[联调指南](docs/metadata-sync/SETUP.md)将独立令牌配置到 Homebridge 服务进程环境；跨机器访问使用受客户端信任的 HTTPS。先选一个设备完成读取、绑定，再决定是否开启写入。npm 包包含服务与协议文档，Mac 伴侣和可选 Node 适配器需从对应 GitHub 标签另外获取。

## 安装与账户配置

在 Homebridge UI 的插件页面搜索并安装 `@linanw/homebridge-tuya-platform`，或在运行 Homebridge 的同一 npm 环境中安装：

```sh
npm install -g @linanw/homebridge-tuya-platform@latest
```

Homebridge 会自动发现已安装的插件。使用已有的配置和存储目录启动：

```sh
homebridge -U /path/to/local/homebridge-storage
```

将路径替换为实际的 Homebridge 存储目录。目录中应保留现有的 `config.json`、设备缓存及配对数据。已安装的标准插件包不需要额外的 `homebridge/` 子入口或自定义 `-P` 参数。

### 准备涂鸦云项目

将 Tuya Smart 或 Smart Life 应用账号及设备关联到自己的涂鸦云项目，并为项目授权所需 API。账号地区、云项目数据中心、国家代码和应用类型应一致。以下上游文档可用于配置账户和了解原有设备驱动：

1. [涂鸦 IoT 平台配置](https://github.com/tuya/tuya-homebridge/wiki/Tuya-IoT-Platform-Configuration-Guide-Using-Smart-Home-PaaS)
2. [使用涂鸦 Homebridge 插件](https://github.com/tuya/tuya-homebridge/wiki/How-to-Use-Tuya-Homebridge-Plugin)
3. [开发设备驱动](https://github.com/tuya/tuya-homebridge/wiki/How-to-Develop-a-New-Driver)
4. [获取日志](https://github.com/tuya/tuya-homebridge/wiki/How-To-Get-Logs)
5. [上游支持的设备分类](https://github.com/tuya/tuya-homebridge/wiki/Supported-Tuya-Device-Types)

### 填写插件配置

可直接通过 Homebridge UI 配置插件，也可在本地 `config.json` 的 `platforms` 数组中加入以下 Smart Home PaaS 配置。示例中的账号字段都是占位内容，国家代码 `86` 也应按自己的账号地区修改：

```json
{
  "platform": "TuyaPlatform",
  "name": "TuyaPlatform",
  "options": {
    "username": "YOUR_TUYA_APP_ACCOUNT",
    "password": "YOUR_TUYA_APP_PASSWORD",
    "accessId": "YOUR_CLOUD_PROJECT_ACCESS_ID",
    "accessKey": "YOUR_CLOUD_PROJECT_ACCESS_SECRET",
    "projectType": "2",
    "appSchema": "smartlife",
    "countryCode": 86,
    "lang": "en",
    "debug": false
  }
}
```

Tuya Smart 使用 `appSchema: "tuyaSmart"`，Smart Life 使用 `appSchema: "smartlife"`。不要将真实账号、密码或 Access Secret 提交到 Git。`options.debug` 默认关闭，排查问题时可临时开启。诊断日志不输出认证请求内容，并会脱敏已知凭据；设备名称、ID 和状态仍可能出现在日志中，分享前请先检查。

仅安装插件不会连接涂鸦云。必填配置缺失或无效时，平台保持未启动状态；补全配置并重启 Homebridge 后，才会进行登录、设备发现和 MQTT 连接。

### 项目类型与可选设备设置

Homebridge UI 可编辑 `options` 下的以下设置：

| 选项 | 用途 |
| --- | --- |
| `projectType` | `"2"` 表示 Smart Home PaaS，`"1"` 表示自定义项目。两者都需要账号和云项目凭据。 |
| `appSchema`、`countryCode` | PaaS 必填，按实际应用和账号所在国家填写；国家代码不设默认值。 |
| `endPoint` | 自定义项目必填，使用云项目的 HTTPS API 端点；PaaS 留空。 |
| `disabledDevice` | 通过 `{ "id": "TUYA_DEVICE_ID" }` 条目数组，从 HomeKit 与 Matter 中排除设备。 |
| `accessoryType` | 通过 `{ "id": "TUYA_DEVICE_ID", "type": "Switch" }` 条目数组修正错误的设备分类；所选驱动必须符合设备实际 datapoint 能力。 |
| `listDeviceId` | 临时列出设备名称和 ID，便于配置排除项或驱动覆盖；用完后关闭。 |
| `lang` | Tuya API 请求的双字母语言代码，例如 `en` 或 `zh`。 |
| `debug` | 诊断日志，默认关闭。 |

### 人体存在传感器

按[涂鸦官方标准](https://developer.tuya.com/en/docs/iot/s?id=K9j2w4p710ge9)，类别为 `hps` 时自动选择人体存在驱动，读取 **Enum 枚举**数据点 `presence_state`：

| 值 | HomeKit / Matter 占用状态 |
| --- | --- |
| `none` | 无人 |
| `presence`、`peaceful`、`small_move`、`large_move` | 有人 |

人员静止时保持有人，直到收到有效的 `none`，不使用定时器伪造无人。布尔类型的自检结果不会被当作存在状态。采用其他数据点或值类型的厂商变体不保证支持，也不会自动猜测。

新传感器在首次有效上报后加入家庭平台。后续无效上报会保留最后确认的占用值，并将 HomeKit 状态标记为非活动／故障，不生成新的无人状态；有效上报后自动恢复。

其他类别若仍提供这个标准枚举数据点，可在 Homebridge UI 的驱动覆盖中选择 `HumanPresenceSensor`、`OccupancySensor` 或 `hps`。使用 JSON 时，将以下片段合并到原平台的 `options`，替换占位设备 ID：

```json
{
  "accessoryType": [
    { "id": "TUYA_DEVICE_ID", "type": "HumanPresenceSensor" }
  ]
}
```

覆盖只选择驱动，不转换厂商专用数据点。本版仅上报占用状态，不提供灵敏度、距离、延时、自检控制或电池上报。Matter 要求 Homebridge 2.4+，使用通用 `Other` 检测特性并提供占用事件。若旧缓存的占用集群特性不兼容，会以原配件 UUID 和端点号重建，保留已有配对存储即可。

## 从旧包迁移

迁移前停止 Homebridge，并保留原存储目录、`TuyaPlatform` 配置、账户选项、子桥设置和配对文件。在 Homebridge 服务实际使用的 npm 环境中替换插件，避免同时安装两个版本造成重复注册。

### 从 `@linanw/tuya-homebridge` 迁移

```sh
npm uninstall -g @linanw/tuya-homebridge
npm install -g @linanw/homebridge-tuya-platform
```

从启动命令中移除旧的 `-P .../@linanw/tuya-homebridge/homebridge` 参数，然后使用原存储目录重启 Homebridge。插件标识仍为 `@linanw/homebridge-tuya-platform`，配置中的平台名称仍为 `TuyaPlatform`。

旧包 `@linanw/tuya-homebridge` 已发布的版本继续保留在 npm；新安装和后续更新使用 `@linanw/homebridge-tuya-platform`。

### 从 `@0x5e/homebridge-tuya-platform` 迁移

```sh
npm uninstall -g @0x5e/homebridge-tuya-platform
npm install -g @linanw/homebridge-tuya-platform
```

不同分支的设备覆盖和可选配置可能有所不同，切换前请核对下方设备支持范围。对于支持的无线开关，**2.6.1** 会跳过电池等非按键状态，复用缓存中原有的按键服务及 datapoint subtype，避免重新创建按键服务。

无需为此修复清空缓存或重置配对。无线按键继续通过 HomeKit 使用，暂不桥接为 Matter 按钮；启动或恢复缓存时不会重放历史按键事件。

## Matter 配置与配对

Matter 是可选功能，需要 Homebridge **2.4 或更高版本**。未在相应桥中配置 Matter 时，插件继续提供 HomeKit 配件。Matter 复用现有设备控制逻辑，MQTT 状态通知会同步到 HomeKit 和 Matter，不需要另行运行 Matter 服务。

### 主桥

将以下片段合并到已有 `config.json` 的 `bridge` 对象中。保留原来的桥名称、用户名、端口、PIN 以及 `TuyaPlatform` 配置，不要用这个片段覆盖整个配置文件：

```json
{
  "bridge": {
    "matter": {
      "port": 5540,
      "name": "Tuya Matter Bridge"
    }
  }
}
```

### 涂鸦子桥

若使用子桥，将以下 `_bridge` 对象合并到已有的 `TuyaPlatform` 条目中。保留账号 `options`，已经创建的子桥应继续使用原来的 `username`，并选择未被占用的端口：

```json
{
  "_bridge": {
    "username": "0E:7A:74:23:10:01",
    "port": 51827,
    "matter": {
      "port": 5541,
      "name": "Tuya Matter Bridge"
    }
  }
}
```

### 添加到家庭平台

重启 Homebridge 后，在 Apple Home、Google Home 等控制器的添加设备流程中使用 Homebridge 生成的 **Matter 二维码或设置码**。Matter 配对码与 HomeKit PIN 不同。需要加入第二个平台时，使用已配对控制器提供的 Matter 共享或再次配对流程。

Homebridge 与控制器应处于同一局域网，并具有可用的 IPv6 和 mDNS。允许 UDP 5353 及配置的 Matter UDP 端口，例如主桥的 5540。升级或迁移时保留整个 Homebridge 存储目录，包括 Matter 配对数据。

部分控制器可能对 Homebridge 的社区 Matter 实现显示未认证配件提示。云开发环境中的测试无法验证家庭局域网内的真实控制器配对。

### 设备支持范围

| 现有设备能力 | Matter 支持 |
| --- | --- |
| 灯 | 按设备实际能力提供开关、亮度、色温和彩色控制 |
| 开关、插座 | 多通道分别控制 |
| 门窗接触传感器 | 打开、关闭状态 |
| 人体存在（`hps`） | 只读占用状态，包含静止有人 |
| 烟雾传感器 | 烟雾报警状态 |
| 风扇 | 电源和风速 |
| 窗帘 | 位置及设备支持的移动控制 |

暂不映射到 Matter 的服务仍可通过现有 HomeKit 驱动使用，包括加热器/HVAC、空气净化器、车库门、无线按键和燃气报警器。旧驱动中以 HomeKit 漏水传感器表示的燃气报警器不会被误报为 Matter 水浸传感器。不同 Matter 控制器对设备类型的呈现和可用功能也可能不同。

## 开发、测试与排错

在仓库根目录执行：

```sh
npm install
npm test
```

开发依赖包含 Homebridge 和测试工具。`npm test` 运行离线工具、Matter 映射与状态同步、缓存迁移及启动错误处理等测试。现有 Tuya API 和 MQTT 测试文件含占位账号，不包含在该命令中；真实云服务、设备控制和家庭平台配对需在具备相应账号与网络的环境中另行验证。

将自己的 Homebridge 配置放在仓库之外的本地存储目录，然后启动开发实例：

```sh
npx homebridge -D -U /path/to/local/homebridge-storage -P .
```

源码开发需要 `-P .` 指向仓库；通过 npm 安装后的插件可自动发现。`npm run dev` 默认使用仓库内的 `config/` 目录，其账号示例为空。真实凭据应放在外部配置中。

分享日志前，请遮蔽账号、密码、Access Secret、token 以及设备标识。提交问题时提供插件、Homebridge、Node.js 的版本和相关错误日志。

### 发布更新说明

在 `CHANGELOG.md` 中添加与 `package.json` 版本一致的中英文条目，提交后推送对应标签。正式版 2.8.0 使用 `v2.8.0` 和 npm `latest` 标签，原 beta 标签保留历史。Release 工作流会运行测试并创建对应 GitHub Release。Homebridge 插件管理通过 `v2.8.0` Release 正文显示 **What's New / 更新说明**，通过对应标签内的更新日志显示 Changelog。npm 发布与附件上传是独立步骤。

### 常见 Tuya Open API 错误

| 错误码 | 含义 | 排查方向 |
| --- | --- | --- |
| `1004` | `sign invalid` | 先升级 **2.8.0** 并重启现有服务，保留凭据、存储与配对。若仍报错，提供版本及脱敏错误行。静态 `operation` 标签如 `account login`（登录）、`associated device list`（设备列表）、`batch device functions`（批量功能）用于定位步骤，不含 URL 或设备 ID。分享前检查日志。 |
| `2001` | `device is offline` | 涂鸦 API 报告设备离线，见[官方错误码](https://developer.tuya.com/en/docs/iot/error-code?id=K989ruxx88swc)。即使 App 通过移动数据仍可控，也应核对云项目中同一设备的 `online` 状态、关联账号与数据中心。插件增加静态 `device command` 标签与清晰错误，不修改亮度指令。 |
| `1106` | `permission deny` | 检查应用账号与云项目的关联、账号密码、数据中心、国家代码及 `appSchema`；第三方登录账号请参考涂鸦的账号关联要求。 |
| `1100` | `param is empty` | 检查 `username`、`appSchema` 等必填字段。 |
| `2017` | `schema does not exist` | 使用正确的 `tuyaSmart` 或 `smartlife` 应用类型。 |
| `2406` | `skill id invalid` | 核对应用账号、项目和数据中心，参考[上游配置说明](https://github.com/tuya/tuya-homebridge/wiki/Tuya-IoT-Platform-Configuration-Guide-Using-Smart-Home-PaaS)。 |
| `28841105` | 项目未获得接口权限 | 检查云项目对授权、智能设备管理、家庭管理、场景、数据服务和设备状态通知等 API 的订阅与授权，参考[涂鸦 API 授权文档](https://developer.tuya.com/en/docs/iot/applying-for-api-group-permissions?id=Ka6vf012u6q76)。 |

## 反馈与上游项目

请在[本仓库 Issues](https://github.com/linanw/tuya-homebridge/issues) 中反馈问题。版本更新请查看 [CHANGELOG.md](CHANGELOG.md) 和 [GitHub Releases](https://github.com/linanw/tuya-homebridge/releases)。

本分支基于[涂鸦原始插件](https://github.com/tuya/tuya-homebridge)；迁移文档也涉及独立的 [0x5e 分支](https://github.com/0x5e/homebridge-tuya-platform)。

## 许可证

采用 [MIT 许可证](LICENSE)。
