# Metadata sync beta / 元数据同步 beta

This guide targets plugin **2.7.0-beta.3**, MatterDesk **0.7.0-beta.1** and MatterCamViewer **2.5.0-beta.1**. The plugin beta uses npm's `beta` dist-tag; `latest` remains **2.6.2**. Both desktop Linux AppImages and their SHA-256 files are published on the linked beta.1 pre-release pages. Their versions remain unchanged by these plugin fixes. A stable 2.6.2 installation does not include this metadata service.

本指南对应插件 **2.7.0-beta.3**、MatterDesk **0.7.0-beta.1** 与 MatterCamViewer **2.5.0-beta.1**。插件 beta 使用独立测试通道，正式版 `latest` 仍为 **2.6.2**。两个桌面 Linux AppImage 及 SHA-256 校验文件已发布在下方 beta.1 预发布页，本轮插件修复不改变桌面版本。

Native Matter still provides device control. This authenticated service supplies names and rooms to separately authorized clients; Matter pairing alone does not grant Apple Home or Google Home private room/alias access.

原生 Matter 继续负责设备控制。名称与房间通过独立授权的元数据服务同步，普通 Matter 配对不会授予 Apple Home 或 Google Home 私有家庭资料的访问权。

## 1. Install the plugin / 安装插件

In Homebridge UI, open the plugin card's **⋮ → Manage Versions / 管理版本 → beta / 2.7.0-beta.3**. Alternatively, run this in the same Node/npm environment or container as the Homebridge service:

```sh
npm install -g @linanw/homebridge-tuya-platform@beta
# Exact version for repeatable testing / 固定本轮版本：
npm install -g @linanw/homebridge-tuya-platform@2.7.0-beta.3
```

Keep your existing Tuya account settings, Homebridge storage, child bridge identity and Matter pairings. Restart the existing service after updating. Return to the stable channel with `npm install -g @linanw/homebridge-tuya-platform@latest`; do not delete storage or re-pair merely to change package versions.

保留现有账号配置、Homebridge 存储、子桥身份及 Matter 配对，更新后重启现有服务。需要退回正式版时安装 `@latest`，不要清空缓存或重新配对。恢复 2.6.2 后元数据服务不可用，已有普通 HAP / Matter 控制继续按稳定版能力运行。

### Matter window-covering confirmation / Matter 窗帘状态确认

Beta.3 fixes confirmation timeouts reproduced with Homebridge 2.4. The window-covering driver has no physical getter/update for HAP `PositionState`; its default `0` must not be treated as real motion. The adapter omits `operationalStatus` and lets Homebridge derive it from positions. Target/current positions, configuration and end-product type remain subject to exact confirmation; the timeout is not extended. Existing Tuya datapoints and pairing storage stay intact.

beta.3 修复已在 Homebridge 2.4 复现的确认超时。窗帘驱动没有 HAP `PositionState` 的物理读取或更新，默认值 `0` 不能当作真实运动状态。适配层不再提交 `operationalStatus`，改由 Homebridge 根据位置派生。目标与当前位置、配置和产品类型仍精确确认，不延长超时；保留原涂鸦数据点与配对存储。

### `2001`: Tuya API reports device offline / 涂鸦 API 报告设备离线

Tuya [defines `2001` as `device is offline`](https://developer.tuya.com/en/docs/iot/error-code?id=K989ruxx88swc). This is the API's response, not proof that the physical device is unreachable. App control can still work over mobile data. Check the **same device** in the linked cloud project: its `online` status, associated account and data center. Keep credentials private; share only versions, sanitized error codes and static `operation: device command` lines when troubleshooting.

Beta.3 reports the actual failed HAP characteristic (`On`, `Brightness`, etc.) rather than always saying `Brightness`. It adds the static operation label and a safe API-offline hint; it does not change lighting command payloads or resolve the cloud API rejection. Live API/device verification remains pending.

涂鸦[将 `2001` 定义为 `device is offline`](https://developer.tuya.com/en/docs/iot/error-code?id=K989ruxx88swc)。这是 API 返回的状态，不代表物理设备必然不可达；App 通过移动数据仍可能正常控制。请核对关联云项目中的**同一设备**：`online` 状态、关联账号及数据中心。不要提供凭据，排查时仅分享版本、脱敏错误码及静态 `operation: device command` 日志。

beta.3 让 HAP 错误日志显示实际失败的特征（如 `On`、`Brightness`），不再固定写成 `Brightness`，并增加静态操作标签和安全的 API 离线提示。本次不修改照明指令内容，也不代表解决云 API 拒绝；实际 API 与设备验证仍待完成。

### `1004 sign invalid`

First upgrade the plugin to **2.7.0-beta.3** and restart the existing service, keeping your access credentials, storage and pairings. This beta sorts query keys, uses RFC 3986 transport encoding and decodes the canonical signing URL once, following the [official SDK](https://github.com/tuya/tuya-connector-nodejs/blob/master/src/core/client.ts). It fixes comma-separated batch `device_ids` signing; the defect also exists in stable 2.6.2 and is unrelated to enabling metadata sync. Offline regression tests cover sorting, encoding and batch IDs; live Tuya validation remains pending.

If `1004` persists, provide the plugin, Homebridge and Node.js versions and sanitized error lines. The new static `operation` labels distinguish `account login`, `associated device list`, `batch device functions` and other steps without URLs or device IDs. Review logs and remove account/device identifiers, credentials, tokens, signed headers and authentication payloads before sharing. Do not reset keys, delete caches or re-pair devices as an initial workaround for this signing defect.

先将插件升级至 **2.7.0-beta.3** 并重启现有服务，保留 access 凭据、存储与配对。本 beta 按[官方 SDK](https://github.com/tuya/tuya-connector-nodejs/blob/master/src/core/client.ts)规则对 query 键排序，以 RFC 3986 编码传输，对 canonical URL 解码一次，修复逗号分隔批量 `device_ids` 的签名不一致。该缺陷在稳定版 2.6.2 中也已存在，与开启元数据同步无关。离线回归覆盖排序、编码及批量 ID；真实涂鸦联调仍待验证。

若 `1004` 持续，提供插件、Homebridge、Node.js 版本及脱敏错误行。新增的静态 `operation` 标签可区分 `account login`（登录）、`associated device list`（设备列表）、`batch device functions`（批量功能）等步骤，不包含 URL 或设备 ID。分享前检查并删除账号/设备标识、凭据、token、签名请求头及鉴权内容。不要先通过重置密钥、清空缓存或重新配对来绕过这个签名缺陷。

## 2. Start with read-only service access / 先开启只读服务

Merge this object under the platform's existing `options`, preserving the surrounding account and bridge configuration:

在现有平台的 `options` 中合并以下对象，保留账号和桥接配置：

```json
{
  "metadataSync": {
    "enabled": true,
    "tokenEnv": "TUYA_METADATA_TOKEN",
    "host": "127.0.0.1",
    "port": 8787,
    "pollIntervalSeconds": 300,
    "allowWrites": false
  }
}
```

Generate a separate random bearer token locally, for example with `openssl rand -hex 32`, and place it in `TUYA_METADATA_TOKEN` in the **Homebridge service process environment**. A different terminal's export does not update an already running service. Restart the Tuya child bridge after changing its environment or settings. Enter this same token in the client's dedicated token field. Do not put the value in JSON, URLs, screenshots, logs or Git; it is unrelated to npm tokens, Tuya Access Secrets and Apple passwords.

在本机生成独立随机令牌，并通过实际 **Homebridge 服务进程的环境**设置 `TUYA_METADATA_TOKEN`。其他终端临时 export 不会更新已经运行的服务。修改后重启涂鸦子桥，在客户端的独立令牌框中输入相同值。令牌不要写入 JSON、URL、截图、日志或 Git，也不要使用 npm token、涂鸦 Access Secret 或 Apple 密码代替。

For a client on another machine, use HTTPS with a certificate trusted by that client. Either configure an administrator-managed HTTPS reverse proxy in front of this loopback service, or bind a LAN address with readable PEM files set through **both** `tlsCertPath` and `tlsKeyPath`. Remote plaintext HTTP is rejected. Clients validate certificates and reject redirects. No public internet exposure is needed.

跨机器访问必须使用客户端信任的 HTTPS。可使用管理员管理的 HTTPS 反向代理转发到回环服务，或设置局域网监听地址，并同时配置可读的 `tlsCertPath`、`tlsKeyPath` PEM 文件。非回环地址拒绝明文 HTTP；客户端不会跳过证书验证或跟随重定向，无需开放公网。

Only devices already managed by this plugin are exported. Disabled devices and unsupported drivers are excluded. One coordinator polls Tuya for all clients; scheduled polling is at least 60 seconds apart. Client snapshot reads consume the cache. Supported MQTT metadata notifications trigger throttled refreshes; power and speed updates keep their existing control path.

只导出插件实际管理的设备，排除已禁用设备和不支持的驱动。多个客户端共用一次云端轮询；计划轮询间隔至少 60 秒。客户端读取缓存，已支持的 MQTT 元数据通知节流刷新；开关、速度等控制沿用原有路径。

### Docker Homebridge

Add the token to the **existing container's** environment. Keep its existing image, networking and persistent volumes. In Compose, add this under your existing service (use its actual name):

在**已有容器**的环境中加入令牌，保留原镜像、网络和持久卷。Compose 中仅添加以下字段，服务名按现有配置填写：

```yaml
services:
  homebridge:
    environment:
      TUYA_METADATA_TOKEN: "${TUYA_METADATA_TOKEN:?Set TUYA_METADATA_TOKEN in the Compose environment}"
```

Generate a separate token with `openssl rand -hex 32`, save it in the Compose environment or a protected `.env`, then run `docker compose up -d <service>` to recreate that service. A restart alone does not add environment variables. This value is separate from `NPM_TOKEN` and Tuya credentials.

生成令牌后写入 Compose 环境或受保护的 `.env`，用 `docker compose up -d <服务名>` 重建该服务；单纯重启旧容器不会增加环境变量。同步令牌与 `NPM_TOKEN`、涂鸦密钥各自独立。

For a client on another computer, use normally trusted HTTPS. Direct TLS needs mounted certificate/key files, `metadataSync.host: "0.0.0.0"`, and both TLS paths set to **container paths**. Host networking uses the host's LAN address; bridge networking needs the corresponding TCP port published. Publishing a port cannot expose a service still bound to `127.0.0.1` inside a bridge-networked container. An existing HTTPS proxy can instead forward to a service it can reach. Preserve the Homebridge data volume and pairing files.

跨机器连接使用客户端信任的 HTTPS。直接 TLS 需挂载证书/密钥，监听地址设为 `0.0.0.0`，TLS 路径填**容器内路径**；host 网络用宿主机局域网地址，bridge 网络映射相应 TCP 端口。容器内监听 `127.0.0.1` 时，仅增加端口映射无法让外部访问。已有 HTTPS 代理也可转发到它能够访问的服务。保留原 Homebridge 数据卷和配对文件。

## 3. Connect one client and one device / 从一个客户端、一个设备开始

- **MatterDesk:** use the `matterdesk-v0.7.0-beta.1` [pre-release](https://github.com/linanw/MatterDesk/releases/tag/matterdesk-v0.7.0-beta.1), then open **Settings → 涂鸦同步**.
- **MatterCamViewer:** use the `mattercamviewer-v2.5.0-beta.1` [pre-release](https://github.com/linanw/MatterDesk/releases/tag/mattercamviewer-v2.5.0-beta.1), then use its independent **涂** entry. It remains a viewer for actual camera endpoints; this feature adds no Tuya camera driver.
- **Mac HomeKit companion:** fetch and build the [companion at v2.7.0-beta.3](https://github.com/linanw/tuya-homebridge/blob/v2.7.0-beta.3/companions/mac/README.md). It needs valid signing, HomeKit entitlement and explicit user home access. No signed Mac installer is supplied here.
- **Optional Node adapter:** fetch the [source at v2.7.0-beta.3](https://github.com/linanw/tuya-homebridge/blob/v2.7.0-beta.3/integrations/matterdesk/README.md). It is an integration library, not an OHF plugin or a desktop application.

The npm package includes this guide, the service and the [protocol](PROTOCOL.md), but **does not include `companions/` or `integrations/`**. Their GitHub links are intentional. Download each desktop AppImage with its matching `.AppImage.sha256` from the linked pre-release and verify it with `sha256sum -c <checksum-file>` before running it. Source tags remain available for local builds.

npm 包包含服务、本指南和协议，**不包含 `companions/`、`integrations/`**，请通过上方 GitHub 链接获取对应源码。桌面预发布页已提供 AppImage 及对应 `.AppImage.sha256`，下载后先执行 `sha256sum -c <校验文件名>`；也可从相应标签构建。

1. Keep the existing OHF controller and Fabric directory for MatterDesk/MatterCamViewer. In the Mac app, authorize HomeKit and select one Apple home.
2. Enter the metadata service URL and token. Check that the source is available and the latest authoritative observation is present. Select the explicit Tuya home, or the Custom device-name-only profile.
3. Select one existing endpoint/accessory and confirm its source device binding. Native Matter `uniqueId` or a trustworthy unique HomeKit serial may suggest a match; missing or duplicate identities require explicit selection. Never match by similar names.
4. Enable following and explicitly adopt the source value to establish a baseline. Confirm a Tuya name change appears on this one bound target before adding further bindings. Local HomeStore aliases and Mijia metadata remain independent.
5. Map rooms explicitly before following room metadata. Unknown room data is not an unassigned room. The Mac app must remain running and the Mac awake; Qt clients must remain running and connected.

先保留控制器与配对，连接服务并确认可用、具有权威观测，再明确选择家庭和一个设备。确认绑定、启用跟随并采用来源建立基线，先检查单设备显示，再扩展范围。本机别名与米家资料不触发云写入；房间必须明确映射。Mac 伴侣需保持运行和唤醒，Qt 客户端需保持运行并连接。

## 4. Enable only supported writes / 再启用已支持的写入

| Provider / 来源 | Read / 读取 | Device rename / 设备改名 | Room rename / 房间改名 | Device move / 设备移动 |
| --- | --- | --- | --- | --- |
| Smart Home PaaS | Names and App homes/rooms, subject to permission / 名称及 App 家庭、房间，取决于权限 | Opt-in / 可开启 | Opt-in when room reads are authoritative / 房间读取完整时可开启 | Disabled / 禁用 |
| Custom | Device names; assets are not App rooms / 设备名，assets 不是 App 房间 | Opt-in / 可开启 | Unsupported / 不支持 | Unsupported / 不支持 |

Set `metadataSync.allowWrites` to **true** and restart the Tuya bridge only when you want source writes. The client additionally requires the matching capability, a fresh source snapshot, explicit binding/baseline and confirmation of the edit. PaaS uses the documented name-only requests `PUT /v1.0/devices/{device_id}` and `PUT /v1.0/homes/{home_id}/rooms/{room_id}`, each with `{"name":"..."}`. Custom device-name writes use the separate IoT-03 API. See [verified API contracts and remaining account checks](TUYA_API_CONTRACTS.md).

需要写回时，将 `metadataSync.allowWrites` 改为 **true** 并重启涂鸦桥。客户端仍需核对能力、权威观测、绑定、基线和草稿版本，明确确认后才写入。PaaS 已实现设备名称和房间名称的独立更新；Custom 仅设备名，不把 assets 当作 App 房间。接口文档核实不等于当前账号已获授权：权限不足、数据中心或关联账号不匹配时，操作会失败，不能算作同步成功。

In the Qt panel, device-name and room-name drafts have separate confirmation actions. Room-name editing targets the selected device's explicitly bound source room; it does not rename a local HomeStore room. Start with one noncritical name edit, then confirm the authoritative value and the Tuya app before testing more bindings. The Mac companion uses its existing explicit room mappings and capability checks; this beta does not add a new Mac room editor.

Qt 面板中的设备名与房间名分别编辑、分别确认。房间名只修改所选设备关联的来源房间，不修改本地 HomeStore 房间。先测试一个非关键名称，并在权威读取及涂鸦 App 中核对结果。Mac 伴侣沿用已有房间映射和能力检查，本轮未新增 Mac 房间编辑器。

`moveDevice` remains **false** for both providers. The documented POST adds devices to a room but does not prove atomic reassignment from another room. The PUT membership API replaces the entire list and is prohibited for a single-device move. No remove-then-add workaround, room create/delete or whole-home replacement is performed. Full bidirectional room-membership synchronization remains unavailable.

两个 provider 的 `moveDevice` 都保持 **false**。POST 添加设备尚未证实原子移房语义；PUT 房间成员接口是全量替换，禁止用于单设备移动。不会先移除再添加，也不会新建、删除房间或整屋覆盖；完整的房间归属双向同步仍不可用。

Queued receipts are not success. Only authoritative readback matching the requested value confirms a write and advances a baseline. Stale/different edits preserve drafts for review. Timeouts and uncertain outcomes are never automatically retried, including after restart; read the latest state and resolve the existing receipt before another write.

排队不代表成功。只有权威读回与目标一致才确认写入并更新基线。版本变化或冲突保留草稿，超时及未知结果在重启后也不会自动重发，需先读取现状并处理原回执。

## Validation / 验证边界

Offline Node/Qt tests and unsigned Mac Catalyst builds check protocol, guards, receipts, identity preservation and UI behavior. They do not prove live Tuya permissions, Apple Home authorization, home-LAN pairing, physical camera behavior or compatibility with every controller. Verify those on the intended account, device and client; no account secret needs to be shared in an issue or chat.

Homebridge 2.4's public metadata-cache API updates restored entries; a newly registered endpoint's cached UI name may lag its live standard `nodeLabel`. The metadata service preserves full Unicode names and updates live labels without rebuilding endpoints or pairings. Native protocol label truncation must never overwrite the full cloud name.

离线测试与无签名 Catalyst 构建覆盖协议及界面，不替代真实账号权限、家庭授权、局域网配对或物理设备验证。新建端点的 Homebridge 缓存名称可能暂时落后于实时 `nodeLabel`；完整名称保存在元数据服务中，不通过重建端点或重新配对强制更新，也不把截断标签反写云端。
