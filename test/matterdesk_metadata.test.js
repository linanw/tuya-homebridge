const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const test = require('node:test');
const { MetadataClient, BindingStore, matchMatterBindings, planField, ohfEndpointIdentity } = require('../integrations/matterdesk');
const { MetadataHttpServer } = require('../lib/metadata_sync/http_server');
const { MetadataCoordinator } = require('../lib/metadata_sync/coordinator');
const example = require('../protocol/metadata-sync/v1/snapshot.json');
const copy = value => JSON.parse(JSON.stringify(value));
const TOKEN = 'fixture-companion-token-000000000000000000';

function source(writable = false) {
  const value = copy(example);
  value.capabilities = { read: true, renameDevice: writable, moveDevice: writable, renameRoom: writable };
  return value;
}

function json(response, status, value) {
  response.writeHead(status, { 'Content-Type': 'application/json' });
  response.end(JSON.stringify(value));
}

async function fakeServer(t, handler) {
  const server = http.createServer(handler);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }));
  return `http://127.0.0.1:${server.address().port}`;
}

async function body(request) {
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  return JSON.parse(Buffer.concat(chunks).toString());
}

test('MatterDesk requires HTTPS outside exact loopback and rejects credential-bearing base URLs', () => {
  for (const baseUrl of ['http://192.168.1.1', 'http://127.1', 'http://2130706433',
    'http://localhost.', 'https://fixture-user:fixture-password@example.invalid',
    'http://localhost/?token=x', 'http://localhost/#x', 'http://localhost/?',
    'ftp://localhost', 'http://localhost/%76proxy']) {
    assert.throws(() => new MetadataClient({ baseUrl, token: TOKEN }), error =>
      error.code === 'invalid_base_url' && !error.message.includes('fixture-password'));
  }
  for (const baseUrl of ['http://127.0.0.1:1234', 'http://localhost', 'http://[::1]', 'https://proxy.example.invalid/metadata/']) {
    assert.ok(new MetadataClient({ baseUrl, token: TOKEN }));
  }
  assert.throws(() => new MetadataClient({ baseUrl: 'http://localhost', token: 'short' }), /invalid_token/);
});

test('the independent client uses the real coordinator for one conditional write and authoritative receipt', async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'matterdesk-client-'));
  let remote = source(true);
  let writes = 0;
  const provider = {
    sourceKind: 'tuya-project-paas',
    async read() { return copy(remote); },
    async apply(operation) {
      writes++;
      remote.devices.find(item => item.id === operation.targetId).name = operation.name;
    },
  };
  const coordinator = new MetadataCoordinator({ provider, storagePath: directory, accountKey: 'fixture-account' });
  await coordinator.start();
  const server = new MetadataHttpServer({ coordinator, token: TOKEN });
  const address = await server.start();
  t.after(async () => { await server.close(); await coordinator.close(); await fs.rm(directory, { recursive: true, force: true }); });
  const client = new MetadataClient({ baseUrl: `http://127.0.0.1:${address.port}`, token: TOKEN, pollIntervalMs: 10 });
  const current = await client.getSnapshot();
  assert.equal((await client.getCapabilities()).serverId, current.serverId);
  const commandId = randomUUID();
  const result = await client.executeCommand(current, {
    type: 'device.rename', targetId: current.devices[0].id, name: '书房新灯 💡',
  }, { commandId });
  assert.equal(result.status, 'confirmed');
  assert.equal(result.snapshot.devices[0].name, '书房新灯 💡');
  assert.equal(writes, 1);
  assert.equal((await client.getCommand(commandId)).status, 'confirmed');
});

test('false capabilities, incomplete rooms, unknown operations and cross-home moves never POST', async t => {
  let requests = 0;
  const baseUrl = await fakeServer(t, (request, response) => { requests++; json(response, 500, {}); });
  const client = new MetadataClient({ baseUrl, token: TOKEN });
  const current = source();
  await assert.rejects(client.submitCommand(current, { type: 'device.rename', targetId: current.devices[0].id, name: 'New' }), { code: 'unsupported_operation' });
  current.capabilities.renameDevice = true;
  current.capabilities.moveDevice = true;
  current.roomsAvailable = false;
  await assert.rejects(client.submitCommand(current, { type: 'device.move', targetId: current.devices[0].id, roomId: current.rooms[0].id }), { code: 'source_unavailable' });
  await assert.rejects(client.submitCommand(source(true), { type: 'http.request', url: 'https://other.invalid' }), { code: 'unsupported_operation' });
  const differentHome = source(true);
  differentHome.rooms[0].homeId = 'another-home';
  await assert.rejects(client.submitCommand(differentHome, { type: 'device.move', targetId: differentHome.devices[0].id, roomId: differentHome.rooms[0].id }), { code: 'invalid_response' });
  const extra = { type: 'device.rename', targetId: source().devices[0].id, name: 'New', url: 'https://other.invalid' };
  await assert.rejects(client.submitCommand(source(true), extra), { code: 'invalid_request' });
  assert.equal(requests, 0);
});

test('redirects are refused without forwarding Authorization to another origin', async t => {
  let forwarded = 0;
  const destination = await fakeServer(t, (request, response) => { forwarded++; json(response, 200, source()); });
  const baseUrl = await fakeServer(t, (request, response) => {
    response.writeHead(302, { Location: destination + '/v1/metadata' }); response.end();
  });
  await assert.rejects(new MetadataClient({ baseUrl, token: TOKEN }).getSnapshot(), { code: 'redirect_refused' });
  assert.equal(forwarded, 0);
});

test('response limits and malformed errors do not leak server payloads or tokens', async t => {
  let route = 'huge';
  const baseUrl = await fakeServer(t, (request, response) => {
    if (route === 'huge') json(response, 200, { padding: 'x'.repeat(4 * 1024 * 1024) });
    else json(response, 500, { code: TOKEN, message: `Authorization: Bearer ${TOKEN}` });
  });
  const client = new MetadataClient({ baseUrl, token: TOKEN });
  await assert.rejects(client.getSnapshot(), { code: 'response_too_large' });
  route = 'error';
  await assert.rejects(client.getSnapshot(), error => error.code === 'request_failed'
    && !error.message.includes(TOKEN) && !JSON.stringify(error).includes(TOKEN));
});

test('a POST timeout is uncertain and is never retried', { timeout: 3000 }, async t => {
  let posts = 0;
  const baseUrl = await fakeServer(t, async (request, response) => {
    if (request.method === 'POST') { await body(request); posts++; return; }
    json(response, 404, { code: 'not_found' });
  });
  const client = new MetadataClient({ baseUrl, token: TOKEN, timeoutMs: 50 });
  const commandId = randomUUID();
  await assert.rejects(client.executeCommand(source(true), {
    type: 'device.rename', targetId: source().devices[0].id, name: 'New name',
  }, { commandId }), error => error.code === 'write_uncertain' && error.commandId === commandId);
  await new Promise(resolve => setTimeout(resolve, 75));
  assert.equal(posts, 1);
});

test('an uncertain receipt is terminal and a new epoch invalidates polling without another POST', async t => {
  let posts = 0;
  let gets = 0;
  let status = 'uncertain';
  let command;
  const baseUrl = await fakeServer(t, async (request, response) => {
    if (request.method === 'POST') {
      posts++; command = await body(request);
      json(response, 202, { schemaVersion: 1, commandId: command.commandId, status,
        code: status === 'uncertain' ? 'write_uncertain' : null, snapshot: source(true) });
    } else {
      gets++;
      const changed = source(true); changed.sourceEpoch = randomUUID();
      json(response, 200, { schemaVersion: 1, commandId: command.commandId,
        status: 'running', code: null, snapshot: changed });
    }
  });
  const client = new MetadataClient({ baseUrl, token: TOKEN, pollIntervalMs: 5 });
  const operation = { type: 'device.rename', targetId: source().devices[0].id, name: 'New' };
  assert.equal((await client.executeCommand(source(true), operation)).status, 'uncertain');
  assert.equal(gets, 0);
  status = 'queued';
  await assert.rejects(client.executeCommand(source(true), operation), { code: 'wrong_source' });
  assert.equal(posts, 2);
  assert.equal(gets, 1);
});

test('receipt deadlines stop GET polling without ever retrying a queued POST', { timeout: 3000 }, async t => {
  let posts = 0;
  let gets = 0;
  let commandId;
  const baseUrl = await fakeServer(t, async (request, response) => {
    if (request.method === 'POST') {
      posts++; commandId = (await body(request)).commandId;
      json(response, 202, { schemaVersion: 1, commandId, status: 'queued', code: null, snapshot: source(true) });
    } else { gets++; /* Deliberately never finish this GET. */ }
  });
  const client = new MetadataClient({ baseUrl, token: TOKEN, timeoutMs: 500, receiptTimeoutMs: 50 });
  await assert.rejects(client.executeCommand(source(true), {
    type: 'device.rename', targetId: source().devices[0].id, name: 'New',
  }), { code: 'write_uncertain' });
  assert.equal(posts, 1);
  assert.equal(gets, 1);
});

test('uniqueId matching is exact and unique on both source and controller sides', () => {
  const current = source();
  const id = current.devices[0].bindings.matterUniqueIds[0];
  const endpoints = [{ id: 'endpoint-a', uniqueId: id, name: 'Anything' },
    { id: 'endpoint-no-id', name: current.devices[0].name },
    { id: 'endpoint-unknown', uniqueId: 'another-id', serialNumber: current.devices[0].bindings.hapSerialNumber }];
  assert.deepEqual(matchMatterBindings(current, endpoints).matches, [{ endpointId: 'endpoint-a', deviceId: current.devices[0].id, uniqueId: id }]);
  assert.equal(matchMatterBindings(current, endpoints.concat({ id: 'duplicate', uniqueId: id })).matches.length, 0);
  const duplicate = copy(current.devices[0]); duplicate.id = 'another-device'; current.devices.push(duplicate);
  assert.equal(matchMatterBindings(current, endpoints).matches.length, 0);
  assert.equal(matchMatterBindings(source(), endpoints, { sourceHomeId: 'different-home' }).matches.length, 0);
  const identities = source();
  identities.devices[0].bindings.matterUniqueIds.push('second-unique-id');
  assert.equal(matchMatterBindings(identities, [{ id: 'same-local-id', uniqueId: id },
    { id: 'same-local-id', uniqueId: 'second-unique-id' }]).matches.length, 0);
});

test('the OHF handoff preserves a 64-bit node ID and never substitutes names or serials for uniqueId', () => {
  const record = ohfEndpointIdentity({ nodeId: '18446744073709551614', endpointId: 3, uniqueId: 'exact-unique-id' });
  assert.deepEqual(JSON.parse(record.id), ['18446744073709551614', 3]);
  assert.equal(record.uniqueId, 'exact-unique-id');
  const missing = ohfEndpointIdentity({ nodeId: '18446744073709551614', endpointId: 3,
    name: 'Same friendly name', serialNumber: 'shared-power-strip-serial' });
  assert.equal(missing.uniqueId, null);
  assert.throws(() => ohfEndpointIdentity({ nodeId: 18446744073709551614, endpointId: 3 }));
});

test('three-way plans require an explicit mode and baseline, and preserve divergent drafts', () => {
  const base = { baseline: 'Old', source: 'Old', controller: 'Old', available: true, roomsAvailable: true, capability: true };
  assert.equal(planField({ ...base, controller: 'User' }).action, 'disabled');
  assert.equal(planField({ ...base, mode: 'bidirectional', baseline: undefined }).action, 'needs_baseline');
  assert.deepEqual(planField({ ...base, mode: 'bidirectional', controller: 'User' }), { action: 'submit_source', value: 'User' });
  assert.deepEqual(planField({ ...base, mode: 'followSource', source: 'Cloud' }), { action: 'apply_controller', value: 'Cloud' });
  assert.equal(planField({ ...base, mode: 'bidirectional', source: 'Cloud', controller: 'User' }).action, 'conflict');
  assert.equal(planField({ ...base, mode: 'followSource', controller: 'User' }).action, 'conflict');
  assert.equal(planField({ ...base, mode: 'bidirectional', controller: 'User', capability: false }).code, 'unsupported_operation');
  assert.equal(planField({ ...base, mode: 'bidirectional', controller: 'User', roomsAvailable: false, isRoomField: true }).code, 'source_unavailable');
  assert.equal(planField({ ...base, mode: 'bidirectional', controller: 'User', roomsAvailable: false }).action, 'submit_source');
  assert.deepEqual(planField({ ...base, mode: 'bidirectional', source: 'Same', controller: 'Same' }), { action: 'adopt_baseline', value: 'Same' });
});

test('recorded Matter label projections cannot become accidental reverse renames', () => {
  const full = '灯'.repeat(40);
  const label = '灯'.repeat(10);
  const base = { baseline: full, source: full, controller: label, mode: 'bidirectional',
    capability: true, available: true, roomsAvailable: true, controllerIsProjection: true };
  assert.equal(planField({ ...base, recordedProjection: { sourceValue: full, controllerValue: label } }).action, 'none');
  assert.equal(planField(base).code, 'unverified_projection', 'prefix similarity alone proves nothing');
  assert.equal(planField({ ...base, baseline: undefined,
    recordedProjection: { sourceValue: full, controllerValue: label } }).action, 'needs_baseline');
  assert.equal(planField({ ...base, controller: '灯'.repeat(9),
    recordedProjection: { sourceValue: full, controllerValue: label } }).code, 'unverified_projection');
  assert.deepEqual(planField({ ...base, source: 'New cloud full name',
    recordedProjection: { sourceValue: full, controllerValue: label } }), { action: 'apply_controller', value: 'New cloud full name' });
});

function profile(snapshot) {
  return { id: 'tuya-profile', serverId: snapshot.serverId, sourceHomeId: snapshot.homes[0].id,
    mode: 'bidirectional', bindings: [{ endpointId: 'endpoint-a', deviceId: snapshot.devices[0].id,
      uniqueId: snapshot.devices[0].bindings.matterUniqueIds[0] }], roomBindings: [] };
}

test('bindings and confirmed baselines use a separate private file without touching aliases or Mijia', async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'matterdesk-bindings-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  await fs.writeFile(path.join(directory, 'aliases.json'), '{"localAlias":"Keep me"}');
  await fs.writeFile(path.join(directory, 'mijia.json'), '{"vendor":"unchanged"}');
  const store = new BindingStore({ directory });
  await store.open();
  const current = source(true);
  await store.saveProfile(profile(current));
  await store.observeEpoch('tuya-profile', current);
  assert.equal(store.getProfile('tuya-profile').baselines.length, 0);
  await assert.rejects(async () => store.confirmBaseline('tuya-profile', {
    endpointId: 'endpoint-a', field: 'name', sourceValue: 'Cloud', controllerValue: 'User',
    sourceConfirmed: true, controllerConfirmed: true,
  }), { code: 'confirmation_failed' });
  await assert.rejects(async () => store.confirmBaseline('tuya-profile', {
    endpointId: 'endpoint-a', field: 'name', sourceValue: 'Cloud', controllerValue: 'Cloud',
    sourceConfirmed: false, controllerConfirmed: true,
  }), { code: 'invalid_binding_store' });
  await store.confirmBaseline('tuya-profile', { endpointId: 'endpoint-a', field: 'name',
    sourceValue: current.devices[0].name, controllerValue: current.devices[0].name,
    sourceConfirmed: true, controllerConfirmed: true });
  assert.equal(store.getProfile('tuya-profile').baselines[0].value, current.devices[0].name);
  await assert.rejects(async () => store.saveProfile({ ...profile(current), token: TOKEN }));
  assert.equal((await fs.stat(store.filePath)).mode & 0o777, 0o600);
  assert.ok(!(await fs.readFile(store.filePath, 'utf8')).includes(TOKEN));
  assert.equal(await fs.readFile(path.join(directory, 'aliases.json'), 'utf8'), '{"localAlias":"Keep me"}');
  assert.equal(await fs.readFile(path.join(directory, 'mijia.json'), 'utf8'), '{"vendor":"unchanged"}');
  await store.close();
});

test('restart and a new epoch retain uncertain commands until explicit acknowledgement, without replay', async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'matterdesk-pending-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const first = new BindingStore({ directory });
  const current = source(true);
  await first.open(); await first.saveProfile(profile(current));
  await first.observeEpoch('tuya-profile', current);
  const commandId = randomUUID();
  await first.recordPending('tuya-profile', { commandId, sourceEpoch: current.sourceEpoch });
  await first.close();
  const restored = new BindingStore({ directory });
  await restored.open();
  assert.equal(restored.getProfile('tuya-profile').fresh, false);
  assert.equal(restored.getProfile('tuya-profile').pending[0].status, 'uncertain');
  await assert.rejects(restored.recordPending('tuya-profile', { commandId: randomUUID(), sourceEpoch: current.sourceEpoch }), { code: 'wrong_source' });
  const changed = copy(current); changed.sourceEpoch = randomUUID();
  await restored.observeEpoch('tuya-profile', changed);
  assert.equal(restored.getProfile('tuya-profile').pending[0].status, 'uncertain');
  await assert.rejects(restored.recordPending('tuya-profile', { commandId: randomUUID(), sourceEpoch: changed.sourceEpoch }), { code: 'write_uncertain' });
  await restored.acknowledgeUncertain('tuya-profile', commandId);
  assert.deepEqual(restored.getProfile('tuya-profile').pending, []);
  await restored.close();
});

test('saving a profile cannot silently discard a queued or uncertain command ledger', async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'matterdesk-profile-pending-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const store = new BindingStore({ directory });
  const current = source(true);
  await store.open(); await store.saveProfile(profile(current));
  await store.observeEpoch('tuya-profile', current);
  const commandId = randomUUID();
  await store.recordPending('tuya-profile', { commandId, sourceEpoch: current.sourceEpoch });
  await store.saveProfile(profile(current));
  assert.equal(store.getProfile('tuya-profile').pending[0].commandId, commandId);
  await assert.rejects(store.saveProfile({ ...profile(current), mode: 'manual' }), { code: 'write_uncertain' });
  assert.equal(store.getProfile('tuya-profile').pending.length, 1);
  await store.markUncertain('tuya-profile', commandId);
  await store.observeEpoch('tuya-profile', current);
  await assert.rejects(store.recordPending('tuya-profile', {
    commandId: randomUUID(), sourceEpoch: current.sourceEpoch,
  }), { code: 'write_uncertain' });
  await store.close();
});

test('Custom name-only profiles can rename devices without inventing App homes or allowing room writes', async t => {
  const current = source(true);
  current.sourceKind = 'tuya-project-custom';
  current.roomsAvailable = false;
  current.homes = []; current.rooms = [];
  current.devices[0].homeId = null; current.devices[0].roomId = null; current.devices[0].roomStatus = 'unsupported';
  let posts = 0;
  const baseUrl = await fakeServer(t, async (request, response) => {
    assert.equal(request.method, 'POST'); posts++;
    const command = await body(request);
    const result = copy(current); result.devices[0].name = command.operation.name;
    json(response, 202, { schemaVersion: 1, commandId: command.commandId, status: 'confirmed', code: null, snapshot: result });
  });
  const client = new MetadataClient({ baseUrl, token: TOKEN });
  assert.equal((await client.executeCommand(current, { type: 'device.rename', targetId: current.devices[0].id, name: 'Custom new name' })).status, 'confirmed');
  await assert.rejects(client.submitCommand(current, { type: 'device.move', targetId: current.devices[0].id, roomId: 'some-room' }), { code: 'source_unavailable' });
  assert.equal(posts, 1);
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'matterdesk-custom-profile-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const store = new BindingStore({ directory });
  await store.open();
  const config = { ...profile(source(true)), sourceHomeId: null, sourceKind: 'tuya-project-custom' };
  await store.saveProfile(config);
  await store.observeEpoch(config.id, current);
  assert.equal(store.getProfile(config.id).fresh, true);
  await store.recordPending(config.id, { commandId: randomUUID(), sourceEpoch: current.sourceEpoch });
  assert.equal(store.getProfile(config.id).pending.length, 1);
  await assert.rejects(async () => store.saveProfile({ ...config, id: 'unsafe-paas', sourceKind: 'tuya-project-paas' }));
  await store.close();
});

test('a confirmed receipt without authoritative metadata is rejected rather than accepted as a baseline', async t => {
  const baseUrl = await fakeServer(t, async (request, response) => {
    const command = await body(request);
    json(response, 202, { schemaVersion: 1, commandId: command.commandId, status: 'confirmed', code: null, snapshot: null });
  });
  const client = new MetadataClient({ baseUrl, token: TOKEN });
  await assert.rejects(client.submitCommand(source(true), { type: 'device.rename', targetId: source().devices[0].id, name: 'New' }), { code: 'invalid_response' });
});

test('authoritative room references must resolve in the declared home', async t => {
  let current = source();
  const baseUrl = await fakeServer(t, (request, response) => json(response, 200, current));
  const client = new MetadataClient({ baseUrl, token: TOKEN });
  for (const change of [
    item => { item.devices[0].roomId = null; },
    item => { item.rooms[0].homeId = 'other-home'; },
    item => { item.devices[0].roomId = 'unknown-room'; },
    item => { item.devices[0].homeId = 'unknown-home'; },
  ]) {
    current = source(); change(current);
    await assert.rejects(client.getSnapshot(), { code: 'invalid_response' });
  }
});

test('corrupt binding files are preserved rather than overwritten with empty profiles', async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'matterdesk-corrupt-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const store = new BindingStore({ directory });
  await fs.writeFile(store.filePath, 'corrupt fixture data');
  await assert.rejects(store.open(), { code: 'invalid_binding_store' });
  assert.equal(await fs.readFile(store.filePath, 'utf8'), 'corrupt fixture data');
});
