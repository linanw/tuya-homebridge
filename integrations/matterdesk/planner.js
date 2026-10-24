'use strict';

/** Match only BridgedDeviceBasicInformation.uniqueId, never names or endpoint numbers. */
function matchMatterBindings(snapshot, endpoints, { sourceHomeId } = {}) {
  const matches = [];
  const unresolved = [];
  const source = new Map();
  const local = new Map();
  const endpointIds = new Map();
  for (const device of snapshot.devices || []) {
    if (sourceHomeId !== undefined && device.homeId !== sourceHomeId) continue;
    for (const uniqueId of device.bindings && device.bindings.matterUniqueIds || []) {
      if (!source.has(uniqueId)) source.set(uniqueId, new Set());
      source.get(uniqueId).add(device.id);
    }
  }
  for (const endpoint of endpoints) {
    endpointIds.set(endpoint.id, (endpointIds.get(endpoint.id) || 0) + 1);
    if (typeof endpoint.uniqueId !== 'string' || !endpoint.uniqueId) continue;
    if (!local.has(endpoint.uniqueId)) local.set(endpoint.uniqueId, []);
    local.get(endpoint.uniqueId).push(endpoint.id);
  }
  for (const endpoint of endpoints) {
    let reason;
    if (!snapshot.available || !snapshot.capabilities || !snapshot.capabilities.read) reason = 'source_unavailable';
    else if (typeof endpoint.id !== 'string' || !endpoint.id) reason = 'missing_controller_endpoint';
    else if (endpointIds.get(endpoint.id) !== 1) reason = 'duplicate_controller_endpoint';
    else if (typeof endpoint.uniqueId !== 'string' || !endpoint.uniqueId) reason = 'missing_unique_id';
    else if (local.get(endpoint.uniqueId).length !== 1) reason = 'duplicate_controller_id';
    else if (!source.has(endpoint.uniqueId)) reason = 'no_unique_id_match';
    else if (source.get(endpoint.uniqueId).size !== 1) reason = 'duplicate_source_id';
    if (reason) unresolved.push({ endpointId: endpoint.id, reason });
    else matches.push({ endpointId: endpoint.id, deviceId: [...source.get(endpoint.uniqueId)][0], uniqueId: endpoint.uniqueId });
  }
  return { matches, unresolved };
}

/** A plan is advice only. Calling this function never writes either metadata source. */
function planField({ baseline, source, controller, mode = 'manual', capability = false,
  available = false, roomsAvailable = false, isRoomField = false, recordedProjection,
  controllerIsProjection = false }) {
  if (!['manual', 'followSource', 'bidirectional'].includes(mode) || mode === 'manual') return { action: 'disabled' };
  if (!available || (isRoomField && !roomsAvailable)) return { action: 'blocked', code: 'source_unavailable' };
  if (source === undefined || controller === undefined) return { action: 'blocked', code: 'missing_binding' };
  if (baseline === undefined) return { action: 'needs_baseline' };
  // A proven, recorded projection of this exact full baseline is not a user
  // edit. Never infer this relationship from a shared string prefix or label.
  const knownProjection = recordedProjection && recordedProjection.sourceValue === baseline
    && recordedProjection.controllerValue === controller;
  if (controllerIsProjection && !knownProjection) return { action: 'blocked', code: 'unverified_projection' };
  if (knownProjection) {
    controller = baseline;
  }
  if (source === controller) return source === baseline ? { action: 'none' } : { action: 'adopt_baseline', value: source };
  const sourceChanged = source !== baseline;
  const controllerChanged = controller !== baseline;
  if (sourceChanged && controllerChanged) return { action: 'conflict', source, controller, baseline };
  if (sourceChanged) return { action: 'apply_controller', value: source };
  if (controllerChanged && mode === 'followSource') return { action: 'conflict', source, controller, baseline };
  if (controllerChanged && (!capability || (isRoomField && !roomsAvailable))) {
    return { action: 'blocked', code: !capability ? 'unsupported_operation' : 'source_unavailable' };
  }
  return controllerChanged ? { action: 'submit_source', value: controller } : { action: 'none' };
}

module.exports = { matchMatterBindings, planField };
