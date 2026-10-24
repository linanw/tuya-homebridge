### Plugin Name

@linanw/homebridge-tuya-platform

### Link To GitHub Repo

https://github.com/linanw/tuya-homebridge

### Plugin Icon (Optional)

No custom icon requested.

### The plugin does not offer the same nor less functionality than that of any existing verified plugin.

🟠 No (please explain in the more information box at the end)

### The plugin successfully installs and does not start unless it is configured.

🟢 Yes

### The plugin does not require the user to run Homebridge in a TTY or with non-standard startup parameters, even for initial configuration.

🟢 Yes

### The plugin does not contain any analytics or calls that enable you to track the user.

🟢 Yes

### If the plugin needs to write files to disk (cache, keys, etc.), it stores them inside the Homebridge storage directory.

🟢 Yes

### The plugin does not throw unhandled exceptions, the plugin must catch and log its own errors.

🟢 Yes

### More Information

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
