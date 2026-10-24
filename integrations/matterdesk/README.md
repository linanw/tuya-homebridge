# MatterDesk metadata adapter / MatterDesk 元数据适配

This is an independent CommonJS client and planning library for **Metadata Sync
v1**. It uses Node's HTTP(S), filesystem and crypto modules and does not load
Homebridge, Matter SDK internals or Mijia vendor clusters. Native Matter pairing
and device controls continue to use the controller's existing implementation.

这是独立的 Metadata Sync v1 客户端、绑定存储和三方比较库。它不会更改 MatterDesk 的
本地别名、现有房间、米家元数据或 Matter 配对。默认模式为 `manual`，获取数据不会自动
写入任何一端。应用必须为一个明确的源配置启用跟随或双向同步。

**Integration status:** the Node transport is tested against the actual metadata
coordinator using local HTTP fixtures. The Qt integrations for **MatterDesk and
MatterCamViewer** live in [linanw/MatterDesk](https://github.com/linanw/MatterDesk)
and use this same contract directly through Qt Network. Live account/device
interoperability still requires runtime validation. The Node handoff below is an
explicit optional controller integration port, not a supplied OHF method.

## Beta source and capabilities

This source adapter accompanies plugin **2.7.0-beta.1** and is **not included in the npm package**. Fetch [the matching GitHub source tag](https://github.com/linanw/tuya-homebridge/tree/v2.7.0-beta.1/integrations/matterdesk) before using the repository-relative import below. The native Qt applications use their own Qt Network client: [MatterDesk 0.7.0-beta.1 / MatterCamViewer 2.5.0-beta.1 setup](https://github.com/linanw/MatterDesk/blob/matterdesk-v0.7.0-beta.1/docs/TUYA_METADATA_SYNC.md). Pre-release packages are being prepared; the linked release pages determine actual availability.

With server-side `allowWrites: true`, PaaS supports device-name and room-name writes, while Custom supports device-name writes only. `moveDevice` remains false for both. The public contracts are documented in [Tuya API contracts](https://github.com/linanw/tuya-homebridge/blob/v2.7.0-beta.1/docs/metadata-sync/TUYA_API_CONTRACTS.md); real account permissions are still unverified. Read the current capabilities rather than inferring support from the project type. Start with one explicit binding and a read-only service before enabling writes.

此适配器需从对应源码标签另外获取，npm 包不包含它。PaaS 可在服务端明确开启后写设备名和房间名，Custom 仅设备名；设备移动仍禁用。先从一个设备只读绑定开始，再核对能力及实际账号权限。

## Exports

```js
const {
  MetadataClient, MetadataClientError, BindingStore,
  matchMatterBindings, planField, ohfEndpointIdentity,
} = require('./integrations/matterdesk');
```

- `MetadataClient({baseUrl, token, timeoutMs=5000, pollIntervalMs=250,
  receiptTimeoutMs=15000})`: `getCapabilities()`, `getSnapshot()`,
  `getCommand(commandId)`, `submitCommand(snapshot, operation, options)`,
  `executeCommand(snapshot, operation, options)` and
  `waitForCommand(commandId, snapshot, options)`. Options accept `commandId` for
  submission and `signal`; receipt polling also accepts `timeoutMs`.
- `BindingStore({directory})`: `open()`, synchronous `getProfile(id)`,
  `saveProfile(config)`, `observeEpoch(id, snapshot)`,
  `recordPending(id, {commandId, sourceEpoch})`, `finishPending(id, receipt)`,
  `markUncertain(id, commandId)`, `acknowledgeUncertain(id, commandId)`,
  `confirmBaseline(id, confirmation)` and
  `close()`. Mutating methods return Promises. Await a mutation before reading it.
- `matchMatterBindings(snapshot, endpoints, {sourceHomeId})`: exact and unique
  matches only; unmatched/ambiguous entries require explicit user binding.
- `planField(options)`: returns advice and performs no I/O or mutations.
- `ohfEndpointIdentity({nodeId, endpointId, uniqueId})`: creates a namespaced local
  endpoint reference without shortening its 64-bit node ID.

Supply a token from the application's secure credential storage. This library
does not store it in the binding file. Do not put it in a URL, profile, process
command line, error report or diagnostic log. HTTPS is mandatory outside the
literal loopback hosts `localhost`, `127.0.0.1` and `[::1]`. HTTP redirects are
rejected; TLS certificate verification remains enabled.

## Concrete OHF handoff

In the controller's existing completed attribute-read/report handler, read
`BridgedDeviceBasicInformation.uniqueId`: **cluster `0x0039`, attribute `0x0012`**
on the bridged endpoint. Do not use root BasicInformation, nodeLabel,
ConfiguredName, endpoint number, serial number or display-name similarity as an
automatic identity substitute. Convert the already-read value into the port:

```js
// Your Qt/OHF IPC invokes this function after its existing attribute read.
// This function makes no assumption about an unavailable Qt/OHF SDK signature.
function onOhfBridgedInfoRead({ nodeIdDecimal, endpointId, uniqueIdValue }) {
  return ohfEndpointIdentity({
    nodeId: nodeIdDecimal, // keep a decimal/string ID, never a JSON number
    endpointId,
    uniqueId: uniqueIdValue,
  });
}

const client = new MetadataClient({
  baseUrl: configuredMetadataOrigin,
  token: tokenLoadedFromSecureStorage,
});
const snapshot = await client.getSnapshot();
const endpoints = completedOhfReads.map(onOhfBridgedInfoRead);
const candidates = matchMatterBindings(snapshot, endpoints, {
  sourceHomeId: explicitlySelectedSourceHomeId,
});
// Show candidates.unresolved to the user. Never bind them by name.
```

Source homes and rooms are source-scoped opaque IDs. A Custom-project name-only
profile explicitly uses `sourceHomeId: null` and
`sourceKind: 'tuya-project-custom'`; it must not pretend that Custom assets are
Smart Home App rooms. PaaS profiles require one explicit source home.

Create one **separate Tuya metadata overlay** in the controller integration. Read
and write its complete names/room bindings through application-provided hooks
such as `readTuyaOverlay`, `writeTuyaOverlay` and `readBackTuyaOverlay`. Those names
are integration ports to implement, not supplied Qt/OHF APIs. Do not route these
writes through the application's existing local-alias or Mijia settings handlers.
A user editing those independent settings must not submit a cloud command.

## Profiles, full names and conflict plans

```js
const store = new BindingStore({ directory: applicationProfileDirectory });
await store.open();
await store.saveProfile({
  id: 'selected-tuya-profile',
  serverId: snapshot.serverId,
  sourceKind: snapshot.sourceKind,
  sourceHomeId: explicitlySelectedSourceHomeId, // null only for Custom names
  mode: 'manual', // explicitly change to followSource or bidirectional
  bindings: candidates.matches,
  roomBindings: [], // explicit {controllerRoomId, sourceRoomId} pairs only
});
await store.observeEpoch('selected-tuya-profile', snapshot);
```

`saveProfile` accepts only the configuration fields shown; `sourceKind` defaults
to `tuya-project-paas` when omitted. It preserves a pending ledger for an unchanged
profile and rejects profile changes while a command remains unresolved. Changing
bindings with no pending command clears the old baselines. The dedicated
`tuya-metadata-bindings-v1.json` file is written atomically with mode `0600`.
Corrupt files are preserved and reported rather than overwritten.

For each explicitly bound field, compare the full source value, full Tuya-overlay
value and last confirmed full baseline:

```js
const advice = planField({
  baseline: storedBaseline?.value,
  source: device.name,
  controller: readTuyaOverlay(binding.endpointId).fullName,
  mode: profile.mode,
  capability: snapshot.capabilities.renameDevice,
  available: snapshot.available,
  roomsAvailable: snapshot.roomsAvailable,
});
```

Possible actions: `disabled`, `blocked`, `needs_baseline`, `none`,
`apply_controller`, `submit_source`, `adopt_baseline` and `conflict`. With no
baseline, require explicit initial resolution, even when two values happen to
match. Divergent edits preserve drafts for user resolution. A source-only change
can update the separate overlay; a controller-only change can request a declared
cloud operation only in `bidirectional` mode. False write capabilities block that
operation. Set `isRoomField: true` for room membership or room names: incomplete
room data blocks room writes, while an explicitly supported Custom device-name
rename remains possible without App rooms. Never create/delete rooms, unassign
all devices or replace a whole home from an incomplete snapshot.

**Do not pass a short Matter nodeLabel as a full controller name.** A 40-character
Chinese name can project to only 10 characters at the Matter UTF-8 label limit.
That projection is not a user rename. If the integration must consume a protocol
label, set `controllerIsProjection: true` and pass the exact trusted tuple saved
when this binding's label was projected:

```js
recordedProjection: {
  sourceValue: fullConfirmedSourceName,
  controllerValue: exactLabelWrittenForThatSource,
}
```

Only a tuple matching the full baseline and current controller label establishes
equivalence. Prefix similarity is never used. Unknown projections remain blocked
for explicit resolution. Persist this provenance via `confirmBaseline`'s
`recordedProjection` option after actual read-back.

## Apply once, then confirm both sides

Persist the command ID before sending a cloud mutation. A received HTTP 202 means
queued, not confirmed. `executeCommand` sends **one POST**, then polls the receipt
using GET. Redirects are never followed. A timeout, lost response or `uncertain`
receipt is never retried as another POST.

```js
const { randomUUID } = require('node:crypto');
const commandId = randomUUID();
await store.recordPending(profile.id, {
  commandId,
  sourceEpoch: snapshot.sourceEpoch,
});
let receipt;
try {
  receipt = await client.executeCommand(snapshot, {
    type: 'device.rename', targetId: device.id, name: advice.value,
  }, { commandId });
} catch (error) {
  // Keep the ledger and the user's draft. Display a safe code, not the request.
  // On write_uncertain, reconcile by GET/fresh snapshot or explicit user action.
  // Do not call executeCommand again automatically, even with the same ID.
  await store.markUncertain(profile.id, commandId);
  throw error;
}
await store.finishPending(profile.id, receipt);
if (receipt.status === 'confirmed') {
  // This hook writes only the integration's Tuya overlay, never local aliases.
  await writeTuyaOverlay(binding.endpointId, receipt.snapshot.devices.find(d => d.id === device.id));
  const readBack = await readBackTuyaOverlay(binding.endpointId);
  await store.confirmBaseline(profile.id, {
    endpointId: binding.endpointId, field: 'name',
    sourceValue: receipt.snapshot.devices.find(d => d.id === device.id).name,
    controllerValue: readBack.fullName,
    sourceConfirmed: true, controllerConfirmed: true,
  });
}
```

Room-name writes use explicit source room IDs and `room.rename` only when declared
by the current provider. Current PaaS supports this with `allowWrites: true`;
Custom does not. Both current providers keep `device.move` disabled: do not
substitute POST-add or full membership replacement. Map controller room IDs
through the profile's explicit room bindings before planning; never send private
controller home/room IDs to Tuya.

On restart, pending entries become uncertain, profiles require a fresh read, and
no stored command is replayed. A new source epoch invalidates old queued work but
retains its uncertainty ledger. Resolve the outcome with an authoritative receipt
or, after a fresh read, explicit `acknowledgeUncertain(profileId, commandId)`.
Do not silently discard the entry and submit the same intent as a new command.
Only `confirmBaseline` with both authoritative confirmations and matching full
values advances a baseline. Standard Matter pairing alone does not grant this
metadata channel or any controller's private room graph.

## Run tests

```sh
node --test test/matterdesk_metadata.test.js
```

Tests cover the real coordinator HTTP path, conflict planning, known truncation
provenance, room/capability checks, redirects, response bounds, lost writes,
source epochs, pending-ledger recovery and local-alias/Mijia file isolation.
