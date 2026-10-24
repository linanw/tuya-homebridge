# Metadata Sync v1 (implementation contract)

This contract is implemented by plugin **2.7.0-beta.1**, published through npm's separate `beta` channel; stable `latest` remains **2.6.2**. Release availability is determined by the registry and matching GitHub pre-release. Native Matter continues to control devices; the authenticated metadata service is a separate integration for the Mac HomeKit companion and compatible Matter controllers. It does not obtain Apple/Google private home information through Matter. See [installation and single-device testing](SETUP.md).

## Transport

- Base URL has no query, fragment or userinfo. HTTPS is required except exact loopback development addresses (`localhost`, `127.0.0.1`, `::1`). Clients reject redirects rather than forwarding credentials across origins.
- Every endpoint requires `Authorization: Bearer <configured token>`; tokens have at least 32 characters. Never put credentials in URLs, logs, snapshots or command receipts.
- The server is disabled by default. Default bind is loopback. Binding a non-loopback interface requires configured TLS; an HTTPS reverse proxy may forward to the loopback server.
- Responses use JSON. Version 1 clients ignore unknown snapshot fields but never execute unknown operations. Commands reject unknown fields. Request bodies are at most 16 KiB; client snapshot responses at most 4 MiB.
- No Homebridge private APIs, extra Matter SDK instance, generic `ConfiguredName` hack, or reuse of Mijia vendor IDs is needed.

## API

| Request | Result |
| --- | --- |
| `GET /v1/capabilities` | Identity, protocol and supported operations |
| `GET /v1/metadata` | Current cached snapshot; does not poll the cloud per client |
| `POST /v1/metadata/commands` | Conditional command; returns HTTP 202 and a receipt |
| `GET /v1/metadata/commands/{commandId}` | Receipt: queued, running, confirmed, conflict, failed or uncertain |

`GET /v1/capabilities` returns `{schemaVersion:1, serverId, sourceEpoch, revision, observedAt, sourceKind, available, roomsAvailable, capabilities:{read,renameDevice,moveDevice,renameRoom}, limitations}`. Identity, availability, revision and capability values match the cached snapshot; clients ignore unknown response fields.

All reads and writes use the same server identity. Provider polling is performed by one coordinator, with coalesced refresh and a configurable interval of at least 60 seconds. Client polling consumes the cache only. Source failures must not be interpreted as empty homes, deleted rooms or an unassigned device.

## Current beta provider capabilities

The metadata service and cloud writes are disabled by default. With `metadataSync.allowWrites: true`, authoritative reads and explicit bindings, Smart Home PaaS supports `device.rename` and `room.rename`; Custom supports `device.rename` only and exposes no App room graph. PaaS sends name-only `PUT /v1.0/devices/{device_id}` or `PUT /v1.0/homes/{home_id}/rooms/{room_id}` requests. Actual project/account permissions remain subject to Tuya authorization and must be checked on the intended account; documentation verification alone is not a successful live write.

`moveDevice` is **false** for both current providers. The protocol retains the operation shape for a future provider with a verified atomic move, but current clients must keep it disabled. POST-add semantics do not establish atomic movement, and PUT room-member replacement is prohibited. Room-name editing does not change membership. See [official API contracts and remaining verification](TUYA_API_CONTRACTS.md).

## Snapshot

The canonical example is `protocol/metadata-sync/v1/snapshot.json`.

- `schemaVersion`: integer `1`.
- `serverId`: stable UUID scoped to this bridge/account; stored inside Homebridge storage.
- `sourceEpoch`: UUID for the current coordinator lifetime.
- `revision`: nonnegative decimal string, incremented only when metadata/capabilities change, never for ordinary power/speed updates.
- `observedAt`: ISO UTC time of the last successful authoritative read, or null before one exists.
- `available`: whether current device/name metadata is usable.
- `roomsAvailable`: whether room membership is authoritative. False is not equivalent to no assigned room.
- `sourceKind`: `tuya-project-paas`, `tuya-project-custom`, or another explicitly implemented authentication model.
- `capabilities`: `read`, `renameDevice`, `moveDevice`, `renameRoom` booleans; `limitations` maps unavailable operations to safe reason codes.
- `homes`: `{id, name}` records; `rooms`: `{id, homeId, name}` records.
- `devices`: `{id, name, homeId, roomId, roomStatus, bindings}`. `roomStatus` is `assigned`, `unassigned`, `unknown` or `unsupported`. IDs may be null only for non-assigned states. `bindings` contains `hapSerialNumber`, `hapAccessoryUuid` and `matterUniqueIds`.
- All home/room/device IDs are opaque, stable, source-scoped identifiers. No raw account IDs, access keys, passwords, local keys, endpoint URLs with credentials, or auth tokens are exposed.
- Names preserve their full Unicode value. Write limits: nonblank, no control characters or unpaired surrogates, at most 50 Unicode scalars and 160 UTF-8 bytes. Protocol label projections may be shorter; a truncated HAP/Matter label is not a change to the full cloud name.

## Commands

```json
{
  "schemaVersion": 1,
  "commandId": "b120b841-12a3-477f-b112-3d58e8c752a2",
  "expected": {
    "serverId": "8c4eec7f-7f15-4507-b7ac-5189b3b821a0",
    "sourceEpoch": "6b25f764-1d0e-43c0-a129-4ab09b158c83",
    "revision": "1"
  },
  "operation": {
    "type": "device.rename",
    "targetId": "d_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    "name": "Study light"
  }
}
```

Supported operation shapes:

- `{type:"refresh"}`: an authoritative read, not a cloud mutation.
- `{type:"device.rename", targetId, name}`.
- `{type:"device.move", targetId, roomId}`: move to one existing room in the same home, only when the provider explicitly implements a verified delta operation.
- `{type:"room.rename", targetId, name}`: rename an explicitly bound source room, only when supported.

No room create/delete, whole-home replacement, unassign-all, arbitrary URL/method, DP command, or generic script operation is accepted. Never guess a cloud room-write endpoint or silently convert Custom assets into Smart Home App rooms.

The coordinator serializes changes, refreshes before writing, and rejects stale identity/epoch/revision with conflict. A command ID is idempotent only with the identical request; reusing it with a different payload is rejected. Persist the command record before attempting a write. A process restart marks previously queued/running writes uncertain and never resends them automatically.

An accepted HTTP request is not a confirmed cloud change. `confirmed` requires an authoritative post-write read matching the requested value. Failed/timeout/uncertain writes are not automatically retried, rolled back or reported as successful. Unknown/unsupported capabilities return a stable error rather than a placeholder success. History is bounded and contains no authentication values.

Receipt shape:

```json
{
  "schemaVersion": 1,
  "commandId": "b120b841-12a3-477f-b112-3d58e8c752a2",
  "status": "confirmed",
  "code": null,
  "snapshot": {}
}
```

`snapshot` is the full current snapshot when available. Safe codes include `stale_revision`, `wrong_source`, `unsupported_operation`, `source_unavailable`, `permission_denied`, `confirmation_failed`, `write_uncertain`, `invalid_request` and `queue_full`.

## Platform bindings and conflict handling

- Mac uses user-authorized HomeKit APIs. HomeKit Home/Accessory/Room UUIDs stay on the Mac; they are not sent to Tuya.
- Bind one selected Apple home to one explicit source home. Device bindings use a unique trustworthy serial when available, otherwise explicit user selection. Never guess by display-name similarity.
- MatterDesk/OHF matches native Matter endpoint `BridgedDeviceBasicInformation.uniqueId` against `bindings.matterUniqueIds`. Missing/duplicate IDs require explicit binding. Endpoint numbers, names and shared multi-channel serials are not automatic identity proof.
- Keep MatterDesk's local aliases/rooms and existing Mijia metadata completely separate. A local alias save never sends a cloud write. Following Tuya or enabling bidirectional sync is explicit per profile/binding.
- Three-way compare each field against the last agreed baseline. One-sided changes may propagate automatically; equal changes update the baseline; divergent changes require explicit conflict resolution. No baseline, incomplete room data, missing binding or unsupported capability means no write.
- Incomplete room data blocks room operations, but does not block device-name synchronization when names are authoritative. Custom projects with no App home/room graph can explicitly bind a selected HomeKit home to the server for device-name-only synchronization.
- A user may explicitly resolve an initial or divergent conflict by selecting the exact source/target value. That authorizes one guarded operation against freshly read snapshots, subject to the target's capabilities; automatic synchronization never writes without a baseline. Create or advance the baseline only after both sides confirm the chosen value, and never retry an uncertain receipt automatically.
- Only advance a baseline after both sides are authoritatively confirmed. Preserve drafts on conflict. A new epoch invalidates old pending intent and requires a fresh snapshot before any new write; preserve its uncertainty ledger and never replay it automatically.
- Mac Catalyst HomeKit requires signing, entitlement and user home permission. The app must remain running and the Mac awake; do not claim synchronization continues after quit/sleep. Other controllers need their own supported metadata adapter; ordinary Matter pairing does not grant their private room graph.

## Provider contract (Node, internal only)

`provider.read()` returns `{sourceKind, available, roomsAvailable, capabilities, limitations, homes, rooms, devices}` using opaque IDs and normalized fields as above. Raw identifiers stay in the provider's private mapping. `provider.apply(operation)` performs only a declared supported operation; it returns no confirmation claim. The coordinator always calls `read()` afterwards. The provider exposes no arbitrary cloud request facility to clients.

Coordinator constructor options: `{provider, storagePath, accountKey, pollIntervalSeconds, onSnapshot, log}`. `provider` may be the provider object or a factory receiving `{serverId, identitySalt}` after the store has opened. The store persists its stable `serverId`, a random identity salt for provider use, metadata and bounded command history under `storagePath`; `sourceEpoch` changes at process start. Public methods: `start()`, `close()`, `getCapabilities()`, `getSnapshot()`, `refresh()`, `submit(command)`, `getCommand(id)`. `submit` returns a receipt immediately; commands execute asynchronously on one queue. `onSnapshot(snapshot)` may return a Promise; projection failures are caught and reported without changing cloud confirmation into fake success.

HTTP server constructor options: `{coordinator, token, host, port, tls, log}`; `tls` is omitted for loopback only or `{cert,key}` PEM buffers from administrator-provided files. Methods: `start()` returns address, `close()`. Neither server nor companion installs trust certificates or alters the user's system.
