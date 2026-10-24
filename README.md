# @linanw/homebridge-tuya-platform

English | [简体中文](README.zh-CN.md)

[![npm](https://img.shields.io/npm/v/@linanw/homebridge-tuya-platform.svg)](https://www.npmjs.com/package/@linanw/homebridge-tuya-platform)
[![npm](https://img.shields.io/npm/dt/@linanw/homebridge-tuya-platform.svg)](https://www.npmjs.com/package/@linanw/homebridge-tuya-platform)

A Homebridge plugin maintained by linanw for controlling Tuya devices through HAP (HomeKit) and optional Matter. Both transports can operate together. It uses [Tuya Open API](https://developer.tuya.com/en/docs/cloud/) and builds on the upstream Tuya Homebridge plugin.

## What's New

**2.7.0** promotes the beta.3 runtime to the stable `latest` channel. Since 2.6.2, it fixes query signing that could cause `1004 sign invalid`, Matter window-covering confirmation timeouts and stale cached movement after a covering reaches its target. Device commands, endpoints and pairings are preserved.

Lighting errors now identify the actual failed characteristic. Tuya `2001` is reported as **Tuya API reports device offline**, without changing command payloads. Successful physical smoke validation was reported for beta.3.

The optional [metadata service](docs/metadata-sync/SETUP.md) starts disabled. With `allowWrites` separately enabled, PaaS supports device-name and room-name writes; Custom supports device-name writes only. Device moves remain disabled. The Mac companion and [MatterDesk 0.7.0-beta.1 / MatterCamViewer 2.5.0-beta.1 clients](https://github.com/linanw/MatterDesk/blob/matterdesk-v0.7.0-beta.1/docs/TUYA_METADATA_SYNC.md) remain test versions, and account permissions vary.

Read the [2.7.0 release](https://github.com/linanw/tuya-homebridge/releases/tag/v2.7.0) and [changelog](CHANGELOG.md) for upgrade notes. The npm `beta` tag retains the beta.3 history; stable installation uses `latest`.

Version **2.6.2** prepares the plugin for Homebridge verification review, with validated account settings, an improved settings form, and explicit support for both HAP and Matter.

Version **2.6.1** fixes wireless-switch startup crashes when Tuya reports battery or other non-button datapoints. Cached button service identities are retained, and startup does not replay a previous button press. See the [migration notes](#wireless-switches-migrated-from-0x5ehomebridge-tuya-platform).

### Homebridge verification

Status: **preparation for review**. This update addresses the [Homebridge verification criteria](https://github.com/homebridge/plugins/wiki/Verified-Plugins). Verification requires review by the Homebridge team; approval has not been granted.

See the [readiness assessment and comparison with existing verified Tuya plugins](https://github.com/linanw/tuya-homebridge/blob/linanw-package/docs/VERIFICATION.md). The non-duplication requirement needs individual review; the prepared application explicitly discloses overlapping functionality.

## Preparation

Link your Tuya Smart or Smart Life app account and devices to your Tuya cloud project, and authorize the APIs it needs. Account region, cloud data center, country code, and app schema must match. These upstream guides explain the account setup and original device drivers:

1. [Tuya IoT Platform Configuration](https://github.com/tuya/tuya-homebridge/wiki/Tuya-IoT-Platform-Configuration-Guide-Using-Smart-Home-PaaS)
2. [Use the Tuya Homebridge Plugin](https://github.com/tuya/tuya-homebridge/wiki/How-to-Use-Tuya-Homebridge-Plugin)
3. [Develop a New Driver](https://github.com/tuya/tuya-homebridge/wiki/How-to-Develop-a-New-Driver)
4. [How to Get Logs](https://github.com/tuya/tuya-homebridge/wiki/How-To-Get-Logs)
5. [Upstream supported device categories](https://github.com/tuya/tuya-homebridge/wiki/Supported-Tuya-Device-Types)

## Installation

Use a supported Node.js LTS line: Node 22 (22.13.1 or later) or Node 24. HomeKit requires Homebridge 1.11.4 or later; Matter requires Homebridge 2.4 or later. Install `@linanw/homebridge-tuya-platform` through the Homebridge UI's Plugins page, or install it globally alongside Homebridge:

```sh
npm install -g @linanw/homebridge-tuya-platform@latest
```

Homebridge discovers the installed plugin automatically. Start it with your existing storage directory:

```sh
homebridge -U /path/to/local/homebridge-storage
```

Replace the storage path with your existing Homebridge directory containing `config.json`, Tuya account settings, and pairing data. Keep the existing `TuyaPlatform` configuration alias and storage when updating. No separate `homebridge/` entry or custom plugin path is needed for an installed package.

### Update to 2.7.0

Update the plugin normally in Homebridge UI, or select **2.7.0** under **⋮ → Manage Versions**. Beta users can use the same flow to switch to the stable release. For CLI installs, use the same Node/npm installation or container that runs your Homebridge service:

```sh
npm install -g @linanw/homebridge-tuya-platform@latest
# Pin the stable version:
npm install -g @linanw/homebridge-tuya-platform@2.7.0
```

Restart the existing Homebridge service with its existing storage. Keep the platform configuration, child bridge identity, Matter storage and pairings. No cache reset or re-pairing is needed.

The metadata service starts disabled. Follow the [setup guide](docs/metadata-sync/SETUP.md) to configure its separate token through the Homebridge process environment and HTTPS for remote clients. Start with one explicitly bound device and reads before enabling cloud writes. The npm package contains the server and protocol docs; the Mac companion and optional Node adapter are fetched separately from the matching GitHub source tag.

### Configure your Tuya account

Use the plugin settings in Homebridge UI, or add a `TuyaPlatform` entry to the `platforms` array in your local `config.json`. This Smart Home PaaS example uses placeholders; supply your own account details and select the correct country code and app schema:

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

Use `tuyaSmart` for the Tuya Smart app and `smartlife` for Smart Life. Keep credentials in your local configuration and do not commit them to Git. `options.debug` is disabled by default; enable it temporarily when diagnosing a problem. Diagnostic logging omits authentication payloads and redacts known credentials, but device names, identifiers, and state may still appear. Review logs before sharing them.

Installing the plugin alone does not start a Tuya connection. Missing or invalid required options leave the platform inactive; complete its settings and restart Homebridge to enable login, device discovery, and MQTT.

### Project types and optional device settings

The Homebridge UI settings expose these options under `options`:

| Option | When to use it |
| --- | --- |
| `projectType` | `"2"` for Smart Home PaaS, or `"1"` for a Custom project. Both require the account and cloud project credentials. |
| `appSchema`, `countryCode` | Required for PaaS; select the actual app and account country. There is no assumed country-code default. |
| `endPoint` | Required for Custom projects; use the HTTPS API endpoint of your cloud project. Leave it blank for PaaS. |
| `disabledDevice` | An array of `{ "id": "TUYA_DEVICE_ID" }` entries to exclude devices from both HomeKit and Matter. |
| `accessoryType` | An array of `{ "id": "TUYA_DEVICE_ID", "type": "Switch" }` entries to override a driver when category detection is incorrect. Select a driver supported by the device's actual datapoints. |
| `listDeviceId` | Temporarily list discovered device names and IDs to configure exclusions or overrides; turn it off afterward. |
| `lang` | Two-letter language code for Tuya API requests, for example `en` or `zh`. |
| `debug` | Diagnostic logging, disabled by default. |

### Migrate from `@linanw/tuya-homebridge`

Stop Homebridge, then replace the old package in the same npm installation used by your Homebridge service:

```sh
npm uninstall -g @linanw/tuya-homebridge
npm install -g @linanw/homebridge-tuya-platform
```

Remove the old `-P .../@linanw/tuya-homebridge/homebridge` argument from your startup command and restart Homebridge with the same storage directory. Preserve your `TuyaPlatform` configuration, account options, child bridge settings, and pairing files. The plugin identifier remains `@linanw/homebridge-tuya-platform`, so these existing settings and accessory identities can be reused.

Install only one of these packages to avoid duplicate platform registration. Previously published versions of `@linanw/tuya-homebridge` remain on npm; the standard Homebridge package for new installations and updates is `@linanw/homebridge-tuya-platform`.

### Wireless switches migrated from `@0x5e/homebridge-tuya-platform`

Stop Homebridge, uninstall the old fork, and install this package in the same npm installation:

```sh
npm uninstall -g @0x5e/homebridge-tuya-platform
npm install -g @linanw/homebridge-tuya-platform
```

Keep the existing storage directory, `TuyaPlatform` configuration, and child bridge settings. Do not install both forks together. Device coverage and optional settings can differ between forks; review the [Matter device coverage](#device-coverage) before switching.

Version 2.6.1 fixes startup crashes caused by battery and other non-button status datapoints when restoring wireless switches. Existing button services reuse their original datapoint subtypes, preserving their identities. Keep your existing storage and pairing data; no cache deletion or pairing reset is needed.

Wireless buttons remain available through HomeKit only. Startup restores their services without replaying the last button press.

## Set up the development environment

Use Node 22 (22.13.1 or later) or Node 24 LTS. HomeKit operation requires Homebridge 1.11.4 or later; Matter requires Homebridge 2.4 or later. The development dependencies include a compatible Homebridge and test runner.

```sh
npm install
npm test
```

`npm test` runs the offline utility and Matter tests. The existing Tuya API and MQTT test files contain placeholder account details and are excluded from this command; live integration requires your own Tuya account, linked devices, and network access.

To run the plugin, put your Homebridge configuration and Tuya account settings in a separate local storage directory, then run:

```sh
npx homebridge -D -U /path/to/local/homebridge-storage -P .
```

`npm run dev` uses the repository's `config/` directory instead. Its sample account fields are empty. Keep real account credentials in external configuration rather than committing them to this repository.

## Matter support

The plugin can expose existing Tuya devices to Apple Home, Google Home, Amazon Alexa, and other Matter controllers through Homebridge's native Matter bridge. HomeKit can run alongside Matter. The Matter controls reuse the existing Tuya commands, and device updates received through MQTT update both protocols. Tuya communication still depends on the Tuya cloud; enabling Matter does not make these devices work offline.

Matter is optional. With no Matter configuration on the relevant Homebridge bridge, the plugin continues to provide HomeKit accessories only. No separate Matter service or additional plugin runtime dependency is needed.

### Enable and pair a bridge

Install Homebridge 2.4 or later on a supported Node.js LTS version. To enable Matter on the main bridge, merge this fragment into your existing Homebridge `config.json`, preserving the other `bridge` fields and your existing `TuyaPlatform` entry and its `options`:

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

For a Tuya child bridge, merge this `_bridge` object into the existing `TuyaPlatform` entry instead. Keep its account `options` unchanged, preserve an existing child bridge's `username`, and choose unused ports:

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

Restart Homebridge and use its generated **Matter** QR code or setup code in your controller's add-device flow. The HomeKit PIN is a separate pairing code. To add another controller, use the existing controller's Matter sharing or commissioning flow. Some controllers may display an uncertified-accessory prompt for Homebridge's community Matter implementation.

The controller and Homebridge must be on the same local network with working IPv6 and multicast DNS. Allow mDNS on UDP port 5353 and the configured Matter UDP port, such as 5540. Preserve Homebridge's storage directory, including Matter commissioning data, across restarts and upgrades to retain pairings. A cloud development environment cannot verify pairing with controllers on your home LAN.

### Device coverage

| Existing device capability | Matter support |
| --- | --- |
| Lights | On/off, brightness, color temperature, and color when the device exposes those capabilities |
| Switches and outlets | Independent control for each channel |
| Contact sensors | Open/closed state |
| Smoke sensors | Smoke alarm state |
| Fans | Power and speed |
| Window coverings | Position and supported movement controls |

Unsupported services remain available through HomeKit. This includes heaters/HVAC, air purifiers, garage doors, stateless wireless buttons, and gas alarms. In particular, gas alarms represented by the existing driver as HomeKit leak sensors are not advertised as Matter water-leak detectors. Availability and presentation of supported device types also depend on the Matter controller.

### Publish release notes

Add an English and Chinese entry to `CHANGELOG.md` matching `package.json`, commit the changes, and push the matching tag. Stable 2.7.0 uses `v2.7.0` and npm's `latest` tag; retain existing beta tags as history. The release workflow runs tests and prepares the corresponding GitHub Release. Homebridge UI reads the `v2.7.0` release body for **What's New / Notes** and the tagged changelog for its changelog view. npm publication and release-asset upload are separate steps.

## Tuya OpenApi Login Error Code

| Error code | Error message | Troubleshooting |
|:----|:----|:----|
| 1004 | sign invalid | First install **2.7.0** and restart the existing service; keep your credentials, storage and pairings. If it persists, report versions and sanitized error lines. Static `operation` labels such as `account login`, `associated device list` and `batch device functions` locate the failing step without URLs or device IDs. Review logs before sharing. |
| 2001 | device is offline | Tuya API reports device offline; see the [official error codes](https://developer.tuya.com/en/docs/iot/error-code?id=K989ruxx88swc). App control, including over mobile data, may still work. Check the same device's `online` status in the cloud project, account linkage and data center. The plugin adds the static `device command` label and clearer errors; it does not change brightness commands. |
| 1106 | permission deny | <ul><li> Your app account is not linked with your cloud project: Link devices by using the Tuya Smart or Smart Life app with your cloud project on the [Tuya IoT Platform](https://iot.tuya.com/cloud/). For more information, see [Link devices by app account](https://developer.tuya.com/en/docs/iot/Platform_Configuration_smarthome?id=Kamcgamwoevrx#title-3-Link%20devices%20by%20app%20account).</li><li>The **TuyaSmart** or **SmartLife** app account which registered using **Google** or **Apple ID** email need to link your phone number and use the linked phone number as **username** to login. </li><li> Incorrect username or password: Enter the correct account and password of the Tuya Smart or Smart Life app in the **Account** and **Password** fields. Note that the app account must be the one you used to link devices with your cloud project on the [Tuya IoT Platform](https://iot.tuya.com/cloud/).</li><li>Incorrect endpoint: See [Endpoint](https://developer.tuya.com/en/docs/iot/Tuya_Homebridge_Plugin?id=Kamcldj76lhzt#endpoint) and enter the correct endpoint.</li><li>Incorrect countryCode: Enter the [code of the country](https://countrycode.org/) you select on logging in to the Tuya Smart or Smart Life app.</li><li>Incorrect **schema** (case insensitive). Currently only **tuyaSmart** and **smartlife** are supported.</li></ul> |
| 1100 | param is empty | `username` or `appSchema` is empty: See [Edit config.json](https://developer.tuya.com/en/docs/iot/Tuya_Homebridge_Plugin?id=Kamcldj76lhzt#config) file and enter the correct parameter. |
| 2017 | schema does not exist | Incorrect `appSchema` in `config.json`: See [Edit config.json](https://developer.tuya.com/en/docs/iot/Tuya_Homebridge_Plugin?id=Kamcldj76lhzt#config) file and enter the correct parameter. |
| 2406 | skill id invalid | <ul><li>Make sure you use the Tuya Smart or SmartLife app account to log in. Also, choose the right data center endpoint related to your country region. For more details, please check [Countries/Regions and Data Center](https://github.com/tuya/tuya-home-assistant/blob/master/docs/regions_dataCenters.md).</li><li>Your cloud project on the [Tuya IoT Development Platform](https://iot.tuya.com/?_source=a4c65f56395e05cf64cc8d4abb7396b6) should be created after May 25, 2021. Otherwise, you need to create a new project. </li></ul> |
| 28841105 | No permissions. This project is not authorized to call this API | You have not authorized your cloud project to use the required APIs. Subscribe to the following required [API products](https://developer.tuya.com/en/docs/iot/applying-for-api-group-permissions?id=Ka6vf012u6q76#title-2-Subscribe%20to%20cloud%20products) and [authorize your project to use them](https://developer.tuya.com/en/docs/iot/applying-for-api-group-permissions?id=Ka6vf012u6q76#title-3-Authorize%20projects%20to%20call%20the%20cloud%20product).   <ul><li>Authorization</li><li>Smart Home Devices Management</li><li>Smart Home Family Management</li><li>Smart Home Scene Linkage</li><li>Smart Home Data Service</li><li>Device Status Notification</li></ul> |

## Feedback and upstream projects

Report plugin issues in [this repository](https://github.com/linanw/tuya-homebridge/issues), including the plugin, Homebridge, and Node.js versions and relevant logs. Redact account details, access keys, tokens, and device identifiers before sharing logs.

This fork builds on [Tuya's original plugin](https://github.com/tuya/tuya-homebridge). The separate [0x5e fork](https://github.com/0x5e/homebridge-tuya-platform) is also referenced by the migration guidance above.

## License

For more information, see the [LICENSE](LICENSE) file.
