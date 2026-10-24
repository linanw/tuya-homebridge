const assert = require('node:assert/strict');
const { test } = require('node:test');
const TuyaMetadataProvider = require('../lib/metadata_sync/tuya_provider');

const IDENTITY_SALT = 'a'.repeat(64);
const RAW_UID = 'private-cloud-user-id';
const PRIVATE_VALUE = 'private-credential-must-not-leave-the-provider';

function fixture(options = {}) {
  const records = options.records || [{ id: 'private-device-1', name: 'Study light' }];
  const state = {
    managed: options.managed || records.map(record => ({ id: record.id })),
    records: new Map(records.map(record => [record.id, record])),
    detailCalls: [],
    getCalls: [],
    writes: [],
    logs: [],
    replies: new Map(),
  };
  const api = {
    tokenInfo: { uid: RAW_UID, access_token: PRIVATE_VALUE },
    async getDeviceListInfo(ids) {
      state.detailCalls.push([...ids]);
      if (state.detailReply) return state.detailReply(ids);
      return ids.map(id => state.records.get(id)).filter(Boolean).map(record => ({ ...record }));
    },
    async get(path) {
      state.getCalls.push(path);
      if (state.getReply) return state.getReply(path);
      if (state.replies.has(path)) return state.replies.get(path);
      throw new Error(`Unexpected fixture request: ${path}`);
    },
    async request(...args) {
      state.writes.push(args);
      if (state.writeReply) return state.writeReply(...args);
      return { success: true, result: true };
    },
  };
  const provider = new TuyaMetadataProvider({
    api,
    projectType: options.projectType || '1',
    getManagedDevices: () => state.managed,
    identitySalt: options.identitySalt || IDENTITY_SALT,
    allowWrites: options.allowWrites === true,
    ...(options.bindingForDevice ? { bindingForDevice: options.bindingForDevice } : {}),
    log: {
      error: (...args) => state.logs.push(args),
      warn: (...args) => state.logs.push(args),
      debug: (...args) => state.logs.push(args),
    },
  });
  return { state, api, provider };
}

function reply(result) {
  return { success: true, result };
}

function publicGraphOnly(snapshot, privateValues = []) {
  const serialized = JSON.stringify(snapshot);
  for (const value of [RAW_UID, PRIVATE_VALUE, ...privateValues]) {
    assert.ok(!serialized.includes(value), `snapshot disclosed private value: ${value}`);
  }
  for (const device of snapshot.devices) assert.match(device.id, /^d_[a-f0-9]{64}$/);
  for (const home of snapshot.homes) assert.match(home.id, /^h_[a-f0-9]{64}$/);
  for (const room of snapshot.rooms) assert.match(room.id, /^r_[a-f0-9]{64}$/);
}

function assertCode(code) {
  return error => {
    assert.equal(error.code, code);
    assert.ok(!JSON.stringify(error).includes(PRIVATE_VALUE));
    assert.ok(!String(error.message).includes(PRIVATE_VALUE));
    return true;
  };
}

function simplePaasGraph(state, records) {
  const homePath = `/v1.0/users/${RAW_UID}/homes`;
  state.replies.set(homePath, reply([{ id: 'private-home-1', name: 'Home' }]));
  state.replies.set('/v1.0/homes/private-home-1/rooms', reply([{ id: 'private-room-1', name: 'Study' }]));
  state.replies.set('/v1.0/homes/private-home-1/devices', reply(records));
  state.replies.set('/v1.0/homes/private-home-1/rooms/private-room-1/devices', reply(records));
}

test('exports the provider class under the documented default and named exports', () => {
  assert.equal(TuyaMetadataProvider.TuyaMetadataProvider, TuyaMetadataProvider);
});

test('reads only managed Custom device names in batches of at most twenty', async () => {
  const records = Array.from({ length: 23 }, (_, index) => ({
    id: `private-managed-device-${index}`,
    name: `Lamp ${index}`,
    local_key: PRIVATE_VALUE,
    access_token: PRIVATE_VALUE,
    endpoint: `https://${PRIVATE_VALUE}@example.invalid`,
    status: [{ code: 'private-status', value: PRIVATE_VALUE }],
  }));
  const { provider, state } = fixture({ records, allowWrites: true });
  const snapshot = await provider.read();
  assert.equal(snapshot.sourceKind, 'tuya-project-custom');
  assert.equal(snapshot.available, true);
  assert.equal(snapshot.roomsAvailable, false);
  assert.deepEqual(snapshot.capabilities, {
    read: true, renameDevice: true, moveDevice: false, renameRoom: false,
  });
  assert.equal(snapshot.devices.length, records.length);
  assert.ok(state.detailCalls.every(ids => ids.length > 0 && ids.length <= 20));
  assert.deepEqual(state.detailCalls.flat().sort(), records.map(record => record.id).sort());
  assert.deepEqual(state.getCalls, [], 'Custom assets must not be queried as Smart Home App rooms');
  assert.deepEqual(snapshot.homes, []);
  assert.deepEqual(snapshot.rooms, []);
  for (const device of snapshot.devices) {
    assert.equal(device.roomStatus, 'unsupported');
    assert.equal(device.homeId, null);
    assert.equal(device.roomId, null);
    assert.deepEqual(device.bindings, {
      hapSerialNumber: null, hapAccessoryUuid: null, matterUniqueIds: [],
    });
  }
  publicGraphOnly(snapshot, records.map(record => record.id));
});

test('explicit approved bindings are copied through an allowlist without raw cloud fields', async () => {
  const rawId = 'private-device-1';
  const hapUuid = '9da87c3d-30e8-4aa4-a8b8-8646241e83cf';
  const requested = [];
  const { provider } = fixture({ async bindingForDevice(id) {
    requested.push(id);
    return {
      hapSerialNumber: 'APPROVED-SERIAL',
      hapAccessoryUuid: hapUuid,
      matterUniqueIds: ['APPROVED-MATTER-ID'],
      local_key: PRIVATE_VALUE,
      rawDeviceId: rawId,
      access_token: PRIVATE_VALUE,
    };
  } });
  const snapshot = await provider.read();
  assert.deepEqual(requested, [rawId]);
  assert.deepEqual(snapshot.devices[0].bindings, {
    hapSerialNumber: 'APPROVED-SERIAL',
    hapAccessoryUuid: hapUuid,
    matterUniqueIds: ['APPROVED-MATTER-ID'],
  });
  publicGraphOnly(snapshot, [rawId]);
});

test('an unexpected cloud response cannot export a device outside the managed set', async () => {
  const { provider, state } = fixture();
  state.detailReply = () => [
    { id: 'private-device-1', name: 'Study light' },
    { id: 'unmanaged-cloud-device', name: 'Unmanaged device must not appear', local_key: PRIVATE_VALUE },
  ];
  const snapshot = await provider.read();
  assert.ok(snapshot.devices.length <= 1);
  assert.ok(!JSON.stringify(snapshot).includes('Unmanaged device must not appear'));
  publicGraphOnly(snapshot, ['private-device-1', 'unmanaged-cloud-device']);
});

test('malformed or excessive platform bindings cannot invalidate otherwise usable source metadata', async () => {
  const { normalizeSource } = require('../lib/metadata_sync/validation');
  const { provider } = fixture({ bindingForDevice() {
    return {
      hapSerialNumber: '\ud800',
      hapAccessoryUuid: '9da87c3d-30e8-4aa4-a8b8-8646241e83cf',
      matterUniqueIds: ['\udc00', ...Array.from({ length: 70 }, (_, index) => `endpoint-${index}`)],
    };
  } });
  const snapshot = await provider.read();
  assert.equal(snapshot.available, true);
  assert.equal(snapshot.devices[0].bindings.hapSerialNumber, null);
  assert.equal(snapshot.devices[0].bindings.matterUniqueIds.length, 64);
  assert.doesNotThrow(() => normalizeSource(snapshot));
});

test('opaque device identity is stable across renames but scoped by source and salt', async () => {
  const first = fixture();
  const original = await first.provider.read();
  first.state.records.get('private-device-1').name = '客厅 💡 Cafe\u0301';
  const renamed = await first.provider.read();
  assert.equal(renamed.devices[0].id, original.devices[0].id);
  assert.equal(renamed.devices[0].name, '客厅 💡 Cafe\u0301');
  const second = fixture({ identitySalt: 'b'.repeat(64) });
  assert.notEqual((await second.provider.read()).devices[0].id, original.devices[0].id);
  const paas = fixture({ projectType: '2' });
  simplePaasGraph(paas.state, [{ id: 'private-device-1' }]);
  const paasSnapshot = await paas.provider.read();
  assert.notEqual(paasSnapshot.devices[0].id, original.devices[0].id);
  publicGraphOnly(renamed, ['private-device-1']);
});

test('PaaS rooms use home-scoped IDs and explicit membership rather than matching names', async () => {
  const records = [
    { id: 'private-device-a', name: 'Same device name' },
    { id: 'private-device-b', name: 'Same device name' },
    { id: 'private-device-c', name: 'Unassigned lamp' },
  ];
  const { provider, state } = fixture({ projectType: '2', records });
  state.replies.set(`/v1.0/users/${RAW_UID}/homes`, reply({ homes: [
    { id: 'private-home-a', name: 'Same home name', owner_secret: PRIVATE_VALUE },
    { home_id: 'private-home-b', name: 'Same home name' },
  ] }));
  for (const home of ['a', 'b']) {
    state.replies.set(`/v1.0/homes/private-home-${home}/rooms`, reply({ rooms: [
      { room_id: 'private-reused-room-id', name: 'Same room name', token: PRIVATE_VALUE },
    ] }));
  }
  state.replies.set('/v1.0/homes/private-home-a/devices', reply([
    { id: 'private-device-a' }, { device_id: 'private-device-c' },
  ]));
  state.replies.set('/v1.0/homes/private-home-b/devices', reply([{ id: 'private-device-b' }]));
  state.replies.set('/v1.0/homes/private-home-a/rooms/private-reused-room-id/devices', reply({ devices: [
    { device_id: 'private-device-a' }, { id: 'unmanaged-room-device', local_key: PRIVATE_VALUE },
  ] }));
  state.replies.set('/v1.0/homes/private-home-b/rooms/private-reused-room-id/devices', reply([
    { id: 'private-device-b' },
  ]));
  const snapshot = await provider.read();
  assert.equal(snapshot.available, true);
  assert.equal(snapshot.roomsAvailable, true);
  assert.equal(snapshot.sourceKind, 'tuya-project-paas');
  assert.equal(snapshot.homes.length, 2);
  assert.equal(snapshot.rooms.length, 2);
  assert.notEqual(snapshot.rooms[0].id, snapshot.rooms[1].id);
  assert.notEqual(snapshot.rooms[0].homeId, snapshot.rooms[1].homeId);
  const assigned = snapshot.devices.filter(device => device.roomStatus === 'assigned');
  assert.equal(assigned.length, 2);
  assert.notEqual(assigned[0].roomId, assigned[1].roomId);
  const unassigned = snapshot.devices.find(device => device.name === 'Unassigned lamp');
  assert.equal(unassigned.roomStatus, 'unassigned');
  assert.equal(unassigned.roomId, null);
  assert.ok(assigned.some(device => device.homeId === unassigned.homeId));
  assert.equal(snapshot.devices.length, 3, 'a room lookup must not introduce unmanaged devices');
  publicGraphOnly(snapshot, [
    ...records.map(record => record.id),
    'private-home-a', 'private-home-b', 'private-reused-room-id', 'unmanaged-room-device',
  ]);
});

test('a partial room permission failure leaves names usable and membership unknown', async () => {
  const { provider, state } = fixture({ projectType: '2' });
  simplePaasGraph(state, [{ id: 'private-device-1' }]);
  const complete = await provider.read();
  assert.equal(complete.roomsAvailable, true);
  state.replies.set('/v1.0/homes/private-home-1/rooms/private-room-1/devices', {
    success: false, code: 28841105, msg: PRIVATE_VALUE,
  });
  const failed = await provider.read();
  assert.equal(failed.available, true);
  assert.equal(failed.roomsAvailable, false);
  assert.equal(failed.devices[0].name, 'Study light');
  assert.equal(failed.devices[0].roomStatus, 'unknown');
  assert.equal(failed.devices[0].roomId, null);
  publicGraphOnly(failed, ['private-device-1', 'private-home-1', 'private-room-1']);
});

test('an invalid PaaS response is not interpreted as an empty list of homes', async () => {
  for (const malformed of [
    { success: true, result: { unrelated: [] } },
    { result: [] },
    { success: 'true', result: [] },
  ]) {
    const { provider, state } = fixture({ projectType: '2' });
    state.replies.set(`/v1.0/users/${RAW_UID}/homes`, malformed);
    const snapshot = await provider.read();
    assert.equal(snapshot.available, true);
    assert.equal(snapshot.roomsAvailable, false);
    assert.equal(snapshot.devices[0].roomStatus, 'unknown');
  }
});

test('PaaS does not request a home graph without an authenticated associated user ID', async () => {
  const { provider, state, api } = fixture({ projectType: '2' });
  delete api.tokenInfo.uid;
  const snapshot = await provider.read();
  assert.equal(snapshot.available, true);
  assert.equal(snapshot.roomsAvailable, false);
  assert.equal(snapshot.devices[0].roomStatus, 'unknown');
  assert.deepEqual(state.getCalls, []);
});

test('failed or incomplete fresh device reads do not report successful empty metadata', async () => {
  for (const detailReply of [
    () => [],
    () => ({ success: true, result: [] }),
    () => { throw new Error(PRIVATE_VALUE); },
  ]) {
    const { provider, state } = fixture({ allowWrites: true });
    const prior = await provider.read();
    assert.equal(prior.available, true);
    state.detailReply = detailReply;
    const failed = await provider.read();
    assert.equal(failed.available, false);
    await assert.rejects(provider.apply({
      type: 'device.rename', targetId: prior.devices[0].id, name: 'New name',
    }), error => ['wrong_source', 'source_unavailable'].includes(error.code));
    assert.equal(state.writes.length, 0, 'failed reads must clear authority to write through stale targets');
    publicGraphOnly(failed, ['private-device-1']);
    assert.ok(!JSON.stringify(state.logs).includes(PRIVATE_VALUE));
  }
});

test('a managed device removed after a read cannot be renamed through its old opaque ID', async () => {
  const { provider, state } = fixture({ allowWrites: true });
  const original = await provider.read();
  state.managed = [{ id: 'private-device-2' }];
  state.records.set('private-device-2', { id: 'private-device-2', name: 'Replacement device' });
  await assert.rejects(provider.apply({
    type: 'device.rename', targetId: original.devices[0].id, name: 'Unwanted rename',
  }), assertCode('wrong_source'));
  assert.equal(state.writes.length, 0);
  const current = await provider.read();
  assert.equal(current.available, true);
  assert.equal(current.devices.length, 1);
  assert.equal(current.devices[0].name, 'Replacement device');
  assert.notEqual(current.devices[0].id, original.devices[0].id);
  assert.deepEqual(state.detailCalls.at(-1), ['private-device-2']);
});

test('Custom rename uses only the documented iot-03 PUT name body and does not claim confirmation', async () => {
  const rawId = 'private-device/encoded?part';
  const { provider, state } = fixture({
    records: [{ id: rawId, name: 'Original' }], allowWrites: true,
  });
  const snapshot = await provider.read();
  const result = await provider.apply({
    type: 'device.rename', targetId: snapshot.devices[0].id, name: '书房 💡 Cafe\u0301',
  });
  assert.equal(result, undefined, 'only a post-write authoritative read may confirm a change');
  assert.deepEqual(state.writes, [[
    'put', `/v1.0/iot-03/devices/${encodeURIComponent(rawId)}`, null, { name: '书房 💡 Cafe\u0301' },
  ]]);
});

test('writes are disabled by default and PaaS does not claim an unverified rename endpoint', async () => {
  const custom = fixture();
  const customSnapshot = await custom.provider.read();
  assert.equal(customSnapshot.capabilities.renameDevice, false);
  await assert.rejects(custom.provider.apply({
    type: 'device.rename', targetId: customSnapshot.devices[0].id, name: 'New name',
  }), assertCode('unsupported_operation'));
  assert.equal(custom.state.writes.length, 0);
  const paas = fixture({ projectType: '2', allowWrites: true });
  simplePaasGraph(paas.state, [{ id: 'private-device-1' }]);
  const paasSnapshot = await paas.provider.read();
  assert.equal(paasSnapshot.capabilities.renameDevice, false);
  await assert.rejects(paas.provider.apply({
    type: 'device.rename', targetId: paasSnapshot.devices[0].id, name: 'New name',
  }), assertCode('unsupported_operation'));
  assert.equal(paas.state.writes.length, 0);
});

test('room writes are unsupported and unknown targets cannot issue arbitrary device mutations', async () => {
  const { provider, state } = fixture({ allowWrites: true });
  const snapshot = await provider.read();
  await assert.rejects(provider.apply({
    type: 'device.move', targetId: snapshot.devices[0].id, roomId: `r_${'c'.repeat(64)}`,
  }), assertCode('unsupported_operation'));
  await assert.rejects(provider.apply({
    type: 'room.rename', targetId: `r_${'c'.repeat(64)}`, name: 'New room',
  }), assertCode('unsupported_operation'));
  for (const targetId of ['private-device-1', `d_${'f'.repeat(64)}`]) {
    await assert.rejects(provider.apply({ type: 'device.rename', targetId, name: 'New name' }),
      assertCode('wrong_source'));
  }
  assert.equal(state.writes.length, 0);
});

test('rename validates the full Unicode name before making any cloud request', async () => {
  const { provider, state } = fixture({ allowWrites: true });
  const snapshot = await provider.read();
  for (const name of ['', ' \t ', 'bad\u0000name', 'bad\u007fname', '\ud800', 'x'.repeat(51), '💡'.repeat(41)]) {
    await assert.rejects(provider.apply({
      type: 'device.rename', targetId: snapshot.devices[0].id, name,
    }), assertCode('invalid_request'));
  }
  assert.equal(state.writes.length, 0);
  for (const name of ['房'.repeat(50), '💡'.repeat(40), '  Desk  ']) {
    await provider.apply({ type: 'device.rename', targetId: snapshot.devices[0].id, name });
    assert.equal(state.writes.at(-1)[3].name, name, 'names must not be silently truncated or normalized');
  }
});

test('malformed cloud names fail closed instead of exporting truncated or invalid Unicode', async () => {
  for (const name of ['', '   ', '\udc00', 'name\u0001', 'x'.repeat(51), '💡'.repeat(41)]) {
    const { provider } = fixture({ records: [{ id: 'private-device-1', name }] });
    const snapshot = await provider.read();
    assert.equal(snapshot.available, false);
    publicGraphOnly(snapshot, ['private-device-1']);
  }
});

test('permission failures and ambiguous writes return safe codes without retries or secret payloads', async () => {
  for (const writeReply of [
    () => ({ success: false, code: 28841105, msg: PRIVATE_VALUE }),
    () => { throw new Error('Tuya API rejected the request (code 28841105)'); },
    () => { throw Object.assign(new Error(PRIVATE_VALUE), { response: { status: 403, data: { token: PRIVATE_VALUE } } }); },
  ]) {
    const { provider, state } = fixture({ allowWrites: true });
    const snapshot = await provider.read();
    state.writeReply = writeReply;
    await assert.rejects(provider.apply({
      type: 'device.rename', targetId: snapshot.devices[0].id, name: 'New name',
    }), assertCode('permission_denied'));
    assert.equal(state.writes.length, 1);
    assert.ok(!JSON.stringify(state.logs).includes(PRIVATE_VALUE));
  }
  for (const writeReply of [
    () => { throw Object.assign(new Error(PRIVATE_VALUE), { code: 'ETIMEDOUT' }); },
    () => ({ success: true, result: false }),
    () => ({ result: true }),
  ]) {
    const { provider, state } = fixture({ allowWrites: true });
    const snapshot = await provider.read();
    state.writeReply = writeReply;
    await assert.rejects(provider.apply({
      type: 'device.rename', targetId: snapshot.devices[0].id, name: 'New name',
    }), assertCode('write_uncertain'));
    assert.equal(state.writes.length, 1, 'uncertain writes must never be automatically retried');
    assert.ok(!JSON.stringify(state.logs).includes(PRIVATE_VALUE));
  }
});
