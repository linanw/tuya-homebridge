# Mac and MatterDesk metadata sync preview / 元数据同步预览

This feature branch adds a separate authenticated metadata service, a Mac Catalyst HomeKit companion, and a MatterDesk controller adapter. It is not part of the published npm **2.6.2** package. Ordinary Matter pairing continues to provide device control; it does not expose Apple Home or Google Home private room and alias databases.

本功能分支新增独立的元数据服务、Mac Catalyst HomeKit 伴侣 App 和 MatterDesk 控制器适配器，尚未包含在 npm **2.6.2** 中。普通 Matter 配对继续提供设备控制；家庭平台的私有房间和自定义名称需要另外授权的适配器读取。

## Implemented provider capabilities / 实际云端能力

| Current project / 当前项目 | Read names / 读取名称 | Read Tuya app rooms / 读取 App 房间 | Write device name / 写回名称 | Move device / 移动设备 | Rename room / 修改房间名 |
| --- | --- | --- | --- | --- | --- |
| Smart Home PaaS | Yes / 支持 | Yes, subject to account/API permission / 取决于账号及 API 权限 | Disabled: write contract not verified / 接口未核实，禁用 | Disabled / 禁用 | Disabled / 禁用 |
| Custom | Yes / 支持 | Unsupported: assets are not app rooms / assets 不等于 App 房间 | Opt-in / 可单独开启 | Disabled / 禁用 | Disabled / 禁用 |

The Mac can follow available Tuya names and explicitly mapped rooms in Apple Home. Bidirectional device-name sync is possible with a Custom project that permits the verified rename operation and has writes enabled. Full bidirectional room sync is **not implemented**: a documented, authorized Tuya delta room-write API is still required. No guessed replacement request is sent. A room-read permission failure preserves the last known room graph and disables room operations; it never means “move everything to the default room.”

Mac 可将可读的涂鸦名称及明确映射的房间同步到 Apple Home。Custom 项目具有对应 API 权限并开启写入后，可使用设备名称双向同步。完整房间双向同步**尚未实现**，仍需要核实并获得涂鸦增量房间写入接口的权限。房间读取失败时保留旧数据并暂停房间操作，避免误判为未分房间。

## Homebridge service / Homebridge 服务

Keep your existing Tuya account, bridge identity, storage and pairings. Add this object under the platform's existing `options`:

保留现有涂鸦账号、桥接身份、存储和配对，在平台现有 `options` 中添加：

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

Generate a separate random access token, for example with `openssl rand -hex 32`, and set `TUYA_METADATA_TOKEN` in the environment of the **Homebridge service process**. An export in a different terminal does not change an already running service. Keep the token out of Git, URLs and logs. Restart the Tuya child bridge after changing its environment or settings. This token is unrelated to npm, Tuya access keys or Apple credentials.

可用 `openssl rand -hex 32` 生成独立令牌，将 `TUYA_METADATA_TOKEN` 写入实际运行 **Homebridge 服务进程**的环境中。在另一个终端中临时 export 不会改变已启动的服务。修改后重启涂鸦子桥。令牌不要提交 Git 或放入 URL；它与 npm、涂鸦密钥和 Apple 账号无关。

For a Mac or MatterDesk on another machine, configure HTTPS with a certificate trusted by that client. Either put an administrator-managed HTTPS reverse proxy in front of the loopback service, or set a LAN bind address and both `tlsCertPath` and `tlsKeyPath` to readable PEM files. Binding beyond exact loopback without TLS is rejected. Clients do not bypass certificate validation or follow redirects. No public internet exposure is required.

Mac 或 MatterDesk 在另一台电脑时，需要使用客户端信任的 HTTPS 证书。可以自行配置 HTTPS 反向代理转发至回环服务，也可以设置局域网监听地址及 `tlsCertPath`、`tlsKeyPath` 两个 PEM 文件路径。非回环地址不允许明文 HTTP。客户端保留证书校验并拒绝跳转，无需将服务开放到公网。

Only devices already managed by this plugin are exported. Disabled devices and unsupported drivers are excluded. The coordinator polls Tuya once for all clients, at least 60 seconds apart for scheduled polls; client snapshot reads use the cache. Selected Tuya MQTT metadata notifications invalidate this cache with burst throttling. Power/speed updates keep their existing control path.

只导出本插件实际管理的设备，排除已禁用设备及不支持的驱动。多个客户端共用一次云端轮询；计划轮询间隔至少 60 秒，客户端读取缓存。已确认类型的 MQTT 元数据通知会节流刷新。开关、速度等控制继续走原有逻辑。

## Companion and controller / 伴侣与控制器

- [Mac companion build and setup / Mac 构建与使用](../../companions/mac/README.md)
- [MatterDesk integration / MatterDesk 接入](../../integrations/matterdesk/README.md)
- [Metadata Sync v1 protocol / 协议](PROTOCOL.md)

Enable following/sync only after selecting the source and local home and explicitly binding the devices and rooms. Automatic sync requires a previously agreed baseline. Divergent changes appear as a conflict; a user can explicitly choose which current value to keep. A source epoch change requires a fresh read. A queued HTTP receipt is not a successful cloud write: only an authoritative read confirming the desired value can advance the baseline. Uncertain writes are not automatically retried.

先选择来源和本地家庭，并明确绑定设备、房间，再开启跟随或同步。自动同步需要已确认的基线。两端同时改成不同值时展示冲突，由用户选择保留哪一端。服务重新启动后需要重新读取数据。排队回执不代表写入成功；只有双方读取确认目标值后才更新基线，结果未知时不会自动重发。

The Mac companion needs HomeKit entitlement, valid signing and the user's home permission. It must remain running and the Mac awake. The companion integration for **MatterDesk and MatterCamViewer** is maintained in [linanw/MatterDesk](https://github.com/linanw/MatterDesk), using the same HTTP contract. Its existing local aliases, room store, Mijia camera metadata, controller fabric and pairings must be preserved. Integration builds and account/device checks must pass before claiming runtime compatibility. There is no generic API for synchronizing every Matter hub's private home database; additional hubs need their own authorized metadata adapter. Google Home's private room graph is not covered by the Mac HomeKit app.

Mac 伴侣需要 HomeKit entitlement、有效签名和家庭数据授权，并需保持 App 运行及 Mac 唤醒。**MatterDesk 和 MatterCamViewer** 的共享协议接入维护在 [linanw/MatterDesk](https://github.com/linanw/MatterDesk)，需通过实际构建及账号、设备联调后才能确认运行时兼容。必须保留本地别名、房间存储、米家摄像头元数据、Matter fabric 与配对。其他 Matter 中枢需要各自授权的元数据适配器，Mac HomeKit App 不覆盖 Google Home 私有房间数据。

## Validation / 验证

Node tests cover the HTTP service, source normalization, conflict guards, persistent command receipts and metadata projection without changing endpoint identities. The Mac workflow builds for Mac Catalyst and runs the Foundation core tests. Neither proves real Apple Home authorization, Tuya account permissions, physical device pairing or integration with the user's local MatterDesk build. Those checks require the corresponding Mac, account, LAN and source checkout.

Node 测试覆盖服务、来源归一化、冲突校验、持久化回执及保留端点身份的名称投影；Mac 工作流负责 Catalyst 编译和 Foundation 核心测试。它们不能替代 Apple Home 实际授权、涂鸦账号权限、真实配对和本地 MatterDesk 联调。
