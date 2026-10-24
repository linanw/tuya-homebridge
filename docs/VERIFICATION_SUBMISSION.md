# 提交 Homebridge 认证申请

当前状态：**申请材料准备完成，尚未成功提交**。GitHub API 返回了 HTTP 403；这不是 Homebridge 对插件认证的评审结果。当前插件不使用 Verified 徽章。

发布版本 [2.6.2](https://www.npmjs.com/package/@linanw/homebridge-tuya-platform)、[GitHub Release](https://github.com/linanw/tuya-homebridge/releases/tag/v2.6.2) 和 [Node 22/24 CI](https://github.com/linanw/tuya-homebridge/actions/runs/40070701629) 均已公开。96 项测试通过，生产依赖审计为零已知漏洞；真实设备及家庭局域网配对的测试限制已在申请中披露。

## 在手机上完成提交

1. 打开[官方认证申请表](https://github.com/homebridge/plugins/issues/new?template=1_verification-request.yml&title=Verification+Request%3A+%40linanw%2Fhomebridge-tuya-platform&plugin-name=%40linanw%2Fhomebridge-tuya-platform)，使用 `linanw` 账号登录。链接预填了标题和插件名；如浏览器没有保留预填内容，请使用下方信息。
2. 填写仓库链接，图标可以留空。
3. 功能不重复这一项选 **🟠 No**；后面的五项技术条件选 **🟢 Yes**。More Information 中已如实说明同类插件和原生 FanControl、PowerSource 差异，请官方个案评审。
4. 将本文末尾代码框内的完整内容复制到表单 **More Information**。也可使用[纯正文文件](VERIFICATION_Please review `@linanw/homebridge-tuya-platform` version **2.6.2** on an individual basis. This is an MIT-licensed Tuya Open API dynamic platform with HomeKit and optional native Matter support. I am not claiming that this fork is a superset of the existing verified Tuya plugins, nor asking to remove verification from another maintained plugin.

**Why the first answer is No:** `@0x5e/homebridge-tuya-platform` 1.7.0-beta.58 and `@homebridge-plugins/homebridge-tuya` 2.7.1 offer broader HAP category, scene, and datapoint support. `homebridge-tuya-matter` 1.0.9 already supports native Matter, HAP, and both Tuya cloud project types, with more Matter device categories than this plugin. "Adds Matter" alone would not establish distinct functionality.

There are two specific native Matter differences compared with `homebridge-tuya-matter` 1.0.9 that I would like the team to assess:

- Its Matter fan driver creates an On/Off switch. This plugin creates a native `Fan` / `FanControl` endpoint with percentage speed, modes, and Auto only when the physical driver supports it.
- Its Matter contact sensor exposes `BooleanState` without `PowerSource`. This plugin mirrors actual HAP battery and low-battery state into Matter `PowerSource` when provided by the device.

Homebridge can itself bridge HAP accessories into Matter, so I would appreciate your judgment on whether these differences justify separate verification. This plugin retains its documented, narrower device coverage.

**Technical readiness:** Injected Homebridge API only; both `supports-hap` and `supports-matter` are declared; configuration GUI included; incomplete configurations never initiate Tuya login/discovery/MQTT; no privileged or system-modifying install hooks; no TTY/custom startup required for npm installations; no maintainer analytics; cache/commissioning storage is owned by Homebridge. HTTP calls have bounded timeouts and safe errors, diagnostics redact known secrets, MQTT parsing/listeners/retries/shutdown have error boundaries, and unavailable HomeKit state fails promptly and recovers on later updates.

**Validation:** Node 22/24 CI runs the offline test suite, including actual HAP and native Matter endpoint integration, request signing against a local HTTP fixture, malformed and rejected cloud responses, failed commands, cache migration, unconfigured startup, privacy, and shutdown. Production dependencies are checked with `npm audit --omit=dev`.

**Limits:** No live Tuya account/device or home-LAN Apple Home/Google Home commissioning was exercised in this cloud environment. User logs showed successful registration of lights and a covering; these are not presented as a complete physical-device test report. No Verified badge is displayed before approval.

- npm: https://www.npmjs.com/package/@linanw/homebridge-tuya-platform
- Release: https://github.com/linanw/tuya-homebridge/releases/tag/v2.6.2
- Node CI: https://github.com/linanw/tuya-homebridge/actions/workflows/ci.yml
- Readiness and comparison: https://github.com/linanw/tuya-homebridge/blob/linanw-package/docs/VERIFICATION.md
- English setup: https://github.com/linanw/tuya-homebridge/blob/linanw-package/README.md
- Chinese setup: https://github.com/linanw/tuya-homebridge/blob/linanw-package/README.zh-CN.md
RMATION.md)。
5. 点击表单的 **Create / Submit new issue**。官方模板会自动附加 `request-verification` 和 `pending` 标签，供认证流程分派。
6. 保存生成的 Issue 链接。提交申请不等于认证通过；后续以 Homebridge 团队回复为准。

## 表单信息

**Title**

```text
Verification Request: @linanw/homebridge-tuya-platform
```

**Plugin Name**

```text
@linanw/homebridge-tuya-platform
```

**Link To GitHub Repo**

```text
https://github.com/linanw/tuya-homebridge
```

| 条件 | 选择 |
| --- | --- |
| 不与现有认证插件提供相同或更少功能 | 🟠 No，请求个案评审 |
| 可以安装，配置完整后才启动 | 🟢 Yes |
| 无需 TTY 或非标准启动参数 | 🟢 Yes |
| 不包含分析或用户追踪 | 🟢 Yes |
| 运行时文件使用 Homebridge 存储目录 | 🟢 Yes |
| 捕获并记录插件错误 | 🟢 Yes |

## More Information：复制以下完整正文

```markdown
Please review `@linanw/homebridge-tuya-platform` version **2.6.2** on an individual basis. This is an MIT-licensed Tuya Open API dynamic platform with HomeKit and optional native Matter support. I am not claiming that this fork is a superset of the existing verified Tuya plugins, nor asking to remove verification from another maintained plugin.

**Why the first answer is No:** `@0x5e/homebridge-tuya-platform` 1.7.0-beta.58 and `@homebridge-plugins/homebridge-tuya` 2.7.1 offer broader HAP category, scene, and datapoint support. `homebridge-tuya-matter` 1.0.9 already supports native Matter, HAP, and both Tuya cloud project types, with more Matter device categories than this plugin. "Adds Matter" alone would not establish distinct functionality.

There are two specific native Matter differences compared with `homebridge-tuya-matter` 1.0.9 that I would like the team to assess:

- Its Matter fan driver creates an On/Off switch. This plugin creates a native `Fan` / `FanControl` endpoint with percentage speed, modes, and Auto only when the physical driver supports it.
- Its Matter contact sensor exposes `BooleanState` without `PowerSource`. This plugin mirrors actual HAP battery and low-battery state into Matter `PowerSource` when provided by the device.

Homebridge can itself bridge HAP accessories into Matter, so I would appreciate your judgment on whether these differences justify separate verification. This plugin retains its documented, narrower device coverage.

**Technical readiness:** Injected Homebridge API only; both `supports-hap` and `supports-matter` are declared; configuration GUI included; incomplete configurations never initiate Tuya login/discovery/MQTT; no privileged or system-modifying install hooks; no TTY/custom startup required for npm installations; no maintainer analytics; cache/commissioning storage is owned by Homebridge. HTTP calls have bounded timeouts and safe errors, diagnostics redact known secrets, MQTT parsing/listeners/retries/shutdown have error boundaries, and unavailable HomeKit state fails promptly and recovers on later updates.

**Validation:** Node 22/24 CI runs the offline test suite, including actual HAP and native Matter endpoint integration, request signing against a local HTTP fixture, malformed and rejected cloud responses, failed commands, cache migration, unconfigured startup, privacy, and shutdown. Production dependencies are checked with `npm audit --omit=dev`.

**Limits:** No live Tuya account/device or home-LAN Apple Home/Google Home commissioning was exercised in this cloud environment. User logs showed successful registration of lights and a covering; these are not presented as a complete physical-device test report. No Verified badge is displayed before approval.

- npm: https://www.npmjs.com/package/@linanw/homebridge-tuya-platform
- Release: https://github.com/linanw/tuya-homebridge/releases/tag/v2.6.2
- Node CI: https://github.com/linanw/tuya-homebridge/actions/workflows/ci.yml
- Readiness and comparison: https://github.com/linanw/tuya-homebridge/blob/linanw-package/docs/VERIFICATION.md
- English setup: https://github.com/linanw/tuya-homebridge/blob/linanw-package/README.md
- Chinese setup: https://github.com/linanw/tuya-homebridge/blob/linanw-package/README.zh-CN.md
```
