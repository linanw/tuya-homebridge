# Tuya metadata API contracts / 涂鸦元数据接口依据

The following official Cloud API contracts were checked on **2026-10-24**. Documentation verification establishes request shape, not permission for a particular project, linked account, role or data center. No live account/device write is claimed by this document.

以下官方云 API 文档已于 **2026-10-24** 核实。文档证明请求格式，不代表当前项目、关联账号、角色或数据中心具有权限；本文不声称已在真实账号或设备上验证写入。

## Implemented name writes / 已实现的名称写入

| Provider / 来源 | Request / 请求 | Body / 请求体 | Official contract / 官方文档 |
| --- | --- | --- | --- |
| Smart Home PaaS device | `PUT /v1.0/devices/{device_id}` | `{"name":"..."}` | [Modify Device Name](https://developer.tuya.com/en/docs/cloud/a358769080?id=Ka7kjxvo4fcck) |
| Smart Home PaaS room | `PUT /v1.0/homes/{home_id}/rooms/{room_id}` | `{"name":"..."}` | [Modify Room Name](https://developer.tuya.com/en/docs/cloud/04635dba27?id=Kawfjgribi8tq) |
| Custom project device | `PUT /v1.0/iot-03/devices/{device_id}` | `{"name":"..."}` | Uses the plugin's existing Custom IoT-03 device model; it is a separate authentication/resource scope from App rooms. |

PaaS name endpoints are listed under [Smart Home Basic Service](https://developer.tuya.com/en/docs/cloud/smart-home-basic-service?id=Kconis1yii4be). [Cloud authorization](https://developer.tuya.com/en/docs/cloud/authorization-management?id=Kaiuy9cjp8kr2) describes Access ID/Secret and access tokens. A documented endpoint still needs the correct service subscription, project authorization and account/resource ownership. An App SDK login session or a successful API Explorer call with another token model cannot establish the plugin's current associated-user token permissions.

All writes additionally require `metadataSync.allowWrites: true`, current source capabilities and availability, explicit target binding and a fresh revision guard. The server sends only the named field and confirms through an authoritative read. A Boolean acknowledgement alone is not metadata synchronization success. Custom assets are never relabeled as Smart Home App rooms.

名称写回还需管理员开启 `allowWrites`、当前能力与数据可用、明确绑定及新版本校验。只发送名称字段，并通过权威读回确认；布尔成功回执不等于同步完成。Custom assets 不会转换成 App 房间。

## Device movement remains disabled / 设备移动仍禁用

- [Add Devices to Room](https://developer.tuya.com/en/docs/cloud/580cf6d356?id=Kawfjhifn3l0x): `POST /v1.0/homes/{home_id}/rooms/{room_id}/devices` accepts `device_ids`. The documentation does not establish whether an already assigned device moves atomically, is rejected or retains another relationship.
- [Modify Devices in Room](https://developer.tuya.com/cn/docs/cloud/ecdaced5c6?id=Kawfjhri0bzhd): `PUT` at the same devices path replaces membership. The field is described as **“房间最后保留的设备 ID”**. Sending only one ID would risk removing unrelated members, so the plugin never uses it for a move.
- Combining DELETE and POST introduces a partial-failure window and is not an atomic move.
- The official [Android room SDK](https://developer.tuya.com/en/docs/app-development/room-information-management?id=Kaiy7xla9is7e) and [iOS room SDK](https://developer.tuya.com/en/docs/app-development/iOS-room?id=Kaixll0l9ue4t) provide room-name and single-device-add methods through App SDK user authentication. Their existence does not establish a REST equivalent or authorize the current Cloud Project provider.

因此 `moveDevice` 始终为 false，不进行全量成员替换或先删后加。房间名称更新与房间成员移动是两种不同能力。

## Evidence needed for a future move capability / 后续移房能力的依据

In the same project, region, linked account and role as the plugin, API Explorer or an official support response must establish the exact single-device move contract: method, path, required/optional fields, authorization model, atomic removal from the old room and addition to the target in the same home, with all other members preserved. A user-selected test target also needs authoritative old/new room reads and app verification before/after. Do not send a replacement list or delete membership as a probe. Permission errors establish missing access, not movement semantics.

Any shared evidence must redact Access Secrets, passwords, access/bearer tokens, signatures and raw authentication headers. No secret value is needed in chat or an issue. Until this contract and runtime authorization are verified, unsupported clients must follow `moveDevice: false` rather than infer support from a room list or an SDK method.
