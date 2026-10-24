# Homebridge verification readiness / Homebridge 认证准备

This is a readiness record for `@linanw/homebridge-tuya-platform` 2.6.2, not a certification badge or approval. The Homebridge team makes the verification decision. Submit only after the release is public on npm and its GitHub Release and CI checks are available.

本文记录 2.6.2 的技术准备情况，不表示已认证或已获批。最终由 Homebridge 团队决定；应在 npm 版本、GitHub Release 和 CI 检查可公开访问后提交申请。

Official criteria: [Verified Plugins](https://github.com/homebridge/plugins/wiki/Verified-Plugins), updated 2026-05-05. Official application: [homebridge/plugins](https://github.com/homebridge/plugins/issues/new/choose).

| Requirement / 要求 | Implementation and evidence / 实现与依据 |
| --- | --- |
| Dynamic platform / 动态平台 | Uses the host's injected API, `configureAccessory`, `registerPlatformAccessories`, and the optional native Matter API. Homebridge/HAP are development dependencies only. |
| Distinct functionality / 功能差异 | **Individual review requested.** Existing verified Tuya plugins overlap. See the comparison below; do not assert that this fork is a superset. / **需个案评审。** 不宣称本分支全面超过已有认证插件。 |
| Public npm and GitHub, issues enabled / npm、源码与问题跟踪 | [npm package](https://www.npmjs.com/package/@linanw/homebridge-tuya-platform), [GitHub source and issues](https://github.com/linanw/tuya-homebridge). |
| Versioned release notes / 各版本更新说明 | [Releases](https://github.com/linanw/tuya-homebridge/releases), bilingual `CHANGELOG.md`, tag-triggered release workflow. |
| Supported Node LTS / Node LTS | Node 22 (22.13.1+) and 24; `ci.yml` installs and tests both versions. |
| Install and remain idle until configured / 正常安装、配置完整后才启动 | No Tuya login, discovery, or MQTT until credentials and project-specific settings validate. Covered by `test/verification.test.js`. |
| No system-modifying install hooks / 不通过安装钩子修改用户系统 | No `preinstall`, `install`, or `postinstall` scripts. No privileged installation actions. |
| No runtime TTY or custom startup / 无需 TTY 或特殊启动参数 | Installed package is discovered through its standard scoped Homebridge name. `-P .` is only for source development. |
| Settings GUI / 设置界面 | Root `config.schema.json`, masked password/secret inputs, project-specific settings and existing advanced options. |
| No analytics / 无用户追踪 | No maintainer analytics or tracking requests. Required Tuya cloud requests are documented; diagnostics omit authentication payloads and redact known credentials. |
| Homebridge storage / 存储目录 | The plugin has no independent runtime file writes. Homebridge owns HAP/Matter cache and commissioning storage. Development/test temporary files are not runtime plugin writes. |
| Catch and log failures / 捕获并记录错误 | Bounded HTTP requests, failed-command propagation, safe logging, MQTT retry/message/shutdown boundaries, per-device isolation, and prompt failed HomeKit reads. Tests cover real HAP/Matter stacks with simulated devices. |

## Comparison for the reviewers / 供评审参考的功能对比

The official form allows a **No** answer with an explanation. The prepared application uses that answer for the non-duplication condition and asks the team to judge these differences. The other technical answers describe the tested release; they do not promise the absence of every possible runtime defect.

官方表单允许选择 **No** 并说明原因。准备的申请会对功能不重复项作此说明，请团队判断以下差异是否足够；其他技术项反映已验证的实现，不保证绝无任何运行缺陷。

- `@0x5e/homebridge-tuya-platform` 1.7.0-beta.58 and `@homebridge-plugins/homebridge-tuya` 2.7.1 provide broader HAP device coverage, scenes, and datapoint overrides. This fork does not claim all those features.
- `homebridge-tuya-matter` 1.0.9 already offers HAP, native Matter, Custom and Smart Home cloud projects, and more Matter device categories. Native Matter alone is not a unique feature.
- In that release, its Matter fan driver maps to an On/Off switch. This fork registers a native Matter `Fan` with `FanControl`, including speed percentage, modes, and Auto only when the physical HAP driver supports it.
- Its Matter contact driver exposes `BooleanState` without `PowerSource`. This fork maps actual HAP battery/low-battery data into Matter `PowerSource` when available.
- Homebridge itself can also bridge HAP accessories into Matter. The reviewers should determine whether the native capabilities above justify separate verification. We do not request removal of another maintained plugin's verification.

Differences were checked against public npm source at the versions above on 2026-10-24. Device categories supported by this fork are listed in the English and Chinese README.

## Validation limits / 验证范围

Automated tests cover real Homebridge/HAP and native Matter endpoints, simulated cloud responses, request signing, failed and malformed messages, shutdown, restored caches, and configuration. Production dependencies are audited with `npm audit --omit=dev`.

Physical Tuya accounts/devices and Apple Home/Google Home commissioning have not been tested from this cloud environment. The supplied user log confirms registration of lights and a covering, but is not a complete physical-device test report. Do not check unperformed hardware tests as completed or add a Verified badge before approval.

自动化测试覆盖真实 Homebridge/HAP、原生 Matter 端点及模拟云响应，不等于真实设备与家庭局域网配对测试。用户日志仅证明部分灯和窗帘曾成功注册；申请会如实披露这些限制，获批前不展示 Verified 徽章。
