# @linanw/homebridge-tuya-platform

English | [简体中文](README.zh-CN.md)

[![npm](https://img.shields.io/npm/v/@linanw/homebridge-tuya-platform.svg)](https://www.npmjs.com/package/@linanw/homebridge-tuya-platform)
[![npm](https://img.shields.io/npm/dt/@linanw/homebridge-tuya-platform.svg)](https://www.npmjs.com/package/@linanw/homebridge-tuya-platform)

A Homebridge plugin maintained by linanw for controlling Tuya devices through HomeKit and optional Matter. It uses [Tuya Open API](https://developer.tuya.com/en/docs/cloud/) and builds on the upstream Tuya Homebridge plugin.

## What's New

Read the [changelog](CHANGELOG.md) and [GitHub Releases](https://github.com/linanw/tuya-homebridge/releases) for version details and upgrade notes.

Version **2.6.1** fixes wireless-switch startup crashes when Tuya reports battery or other non-button datapoints. Cached button service identities are retained, and startup does not replay a previous button press. See the [migration notes](#wireless-switches-migrated-from-0x5ehomebridge-tuya-platform).

## Preparation

Link your Tuya Smart or Smart Life app account and devices to your Tuya cloud project, and authorize the APIs it needs. Account region, cloud data center, country code, and app schema must match. These upstream guides explain the account setup and original device drivers:

1. [Tuya IoT Platform Configuration](https://github.com/tuya/tuya-homebridge/wiki/Tuya-IoT-Platform-Configuration-Guide-Using-Smart-Home-PaaS)
2. [Use the Tuya Homebridge Plugin](https://github.com/tuya/tuya-homebridge/wiki/How-to-Use-Tuya-Homebridge-Plugin)
3. [Develop a New Driver](https://github.com/tuya/tuya-homebridge/wiki/How-to-Develop-a-New-Driver)
4. [How to Get Logs](https://github.com/tuya/tuya-homebridge/wiki/How-To-Get-Logs)
5. [Upstream supported device categories](https://github.com/tuya/tuya-homebridge/wiki/Supported-Tuya-Device-Types)

## Installation

Use Node.js 22 or later with Homebridge 1.11.4 or later. Matter requires Homebridge 2.4 or later. Install `@linanw/homebridge-tuya-platform` through the Homebridge UI's Plugins page, or install it globally alongside Homebridge:

```sh
npm install -g @linanw/homebridge-tuya-platform
```

Homebridge discovers the installed plugin automatically. Start it with your existing storage directory:

```sh
homebridge -U /path/to/local/homebridge-storage
```

Replace the storage path with your existing Homebridge directory containing `config.json`, Tuya account settings, and pairing data. Keep the existing `TuyaPlatform` configuration alias and storage when updating. No separate `homebridge/` entry or custom plugin path is needed for an installed package.

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

Use `tuyaSmart` for the Tuya Smart app and `smartlife` for Smart Life. Keep credentials in your local configuration and do not commit them to Git. Leave `options.debug` disabled with real credentials: verbose Tuya request logs can contain account data and authentication information.

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

Use Node.js 22 or later. HomeKit operation requires Homebridge 1.11.4 or later; Matter requires Homebridge 2.4 or later. The development dependencies include a compatible Homebridge and test runner.

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

Install Homebridge 2.4 or later on Node.js 22 or later. To enable Matter on the main bridge, merge this fragment into your existing Homebridge `config.json`, preserving the other `bridge` fields and your existing `TuyaPlatform` entry and its `options`:

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

## Tuya OpenApi Login Error Code

| Error code | Error message | Troubleshooting |
|:----|:----|:----|
| 1004 | sign invalid | <ul><li> Incorrect `accessId` or `accessKey`. To fix the error, see [Edit config.json](https://developer.tuya.com/en/docs/iot/Tuya_Homebridge_Plugin?id=Kamcldj76lhzt#config) file.</li><li> Due to the new signature verification mode, the server will have the cache of the old mode. Please create a Github Issue to inform us. |
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
