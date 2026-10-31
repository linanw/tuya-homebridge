'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { randomUUID } = require('node:crypto');
const { MetadataCoordinator } = require('../lib/metadata_sync/coordinator');
const { MetadataHttpServer } = require('../lib/metadata_sync/http_server');
const { MetadataStore } = require('../lib/metadata_sync/store');
const { validateCommand, normalizeSource } = require('../lib/metadata_sync/validation');

const copy = value => JSON.parse(JSON.stringify(value));
const TOKEN = 'fixture-local-pairing-token-32-characters';
const fixture = () => ({
    sourceKind: 'tuya-project-custom', available: true, roomsAvailable: true,
    capabilities: { read: true, renameDevice: true, moveDevice: false, renameRoom: false },
    limitations: { moveDevice: 'unverified_tuya_room_write_contract', renameRoom: 'unverified_tuya_room_write_contract' },
    homes: [{ id: 'h_home', name: '家庭' }],
    rooms: [{ id: 'r_study', homeId: 'h_home', name: '书房' }],
    devices: [{ id: 'd_light', name: '书房灯', homeId: 'h_home', roomId: 'r_study', roomStatus: 'assigned',
        bindings: { hapSerialNumber: 'fixture-serial', hapAccessoryUuid: randomUUID(), matterUniqueIds: ['fixture-matter'] } }],
});

async function until(check, timeout = 5000) {
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) {
        const value = await check();
        if (value) return value;
        await new Promise(resolve => setTimeout(resolve, 5));
    }
    assert.fail('Timed out waiting for the metadata operation');
}

async function setup(t, options = {}) {
    const directory = options.directory ?? await fs.mkdtemp(path.join(os.tmpdir(), 'tuya-metadata-test-'));
    const state = options.state ?? fixture();
    const calls = { read: 0, writes: [], logs: [] };
    const provider = options.provider ?? {
        sourceKind: state.sourceKind,
        read: async () => { calls.read++; return copy(state); },
        apply: async operation => {
            calls.writes.push(copy(operation));
            if (operation.type === 'device.rename') state.devices.find(device => device.id === operation.targetId).name = operation.name;
            if (operation.type === 'room.rename') state.rooms.find(room => room.id === operation.targetId).name = operation.name;
            if (operation.type === 'device.move') state.devices.find(device => device.id === operation.targetId).roomId = operation.roomId;
        },
    };
    const coordinator = new MetadataCoordinator({ provider, storagePath: directory,
        accountKey: 'private-test-account', pollIntervalSeconds: 60,
        log: { error: message => calls.logs.push(message) }, onSnapshot: options.onSnapshot });
    await coordinator.start();
    t.after(async () => { await coordinator.close(); if (!options.keep) await fs.rm(directory, { recursive: true, force: true }); });
    return { directory, state, calls, provider, coordinator };
}

function command(coordinator, operation = { type: 'device.rename', targetId: 'd_light', name: '阅读灯 🌙' }) {
    const snapshot = coordinator.getSnapshot();
    return { schemaVersion: 1, commandId: randomUUID(), expected: {
        serverId: snapshot.serverId, sourceEpoch: snapshot.sourceEpoch, revision: snapshot.revision,
    }, operation };
}

async function completed(coordinator, id, timeout) {
    return until(() => {
        const receipt = coordinator.getCommand(id);
        return ['queued', 'running'].includes(receipt.status) ? null : receipt;
    }, timeout);
}

function request(address, { method = 'GET', target = '/v1/metadata', token = TOKEN, body, headers = {}, chunks } = {}) {
    return new Promise((resolve, reject) => {
        const data = body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body);
        const outgoing = { ...(token === null ? {} : { authorization: `Bearer ${token}` }), ...headers };
        if (data !== undefined) {
            outgoing['content-type'] ??= 'application/json';
            outgoing['content-length'] ??= Buffer.byteLength(data);
        }
        const req = http.request({ host: '127.0.0.1', port: address.port, method, path: target, headers: outgoing }, response => {
            const buffers = [];
            response.on('data', chunk => buffers.push(chunk));
            response.on('end', () => {
                const text = Buffer.concat(buffers).toString();
                resolve({ status: response.statusCode, headers: response.headers, text, json: text ? JSON.parse(text) : null });
            });
        });
        req.on('error', reject);
        if (chunks) chunks.forEach(chunk => req.write(chunk));
        req.end(data);
    });
}

test('authenticated HTTP uses cached snapshots and confirms one conditional cloud write', async t => {
    const { coordinator, calls, directory } = await setup(t);
    const server = new MetadataHttpServer({ coordinator, token: TOKEN });
    const address = await server.start();
    t.after(() => server.close());
    assert.deepEqual(await server.start(), address);
    assert.equal((await request(address, { token: null })).status, 401);
    assert.equal((await request(address, { token: 'wrong-token', target: '/secret-path' })).status, 401);
    const capabilities = (await request(address, { target: '/v1/capabilities' })).json;
    assert.equal(capabilities.schemaVersion, 1);
    assert.equal(capabilities.capabilities.moveDevice, false);
    const reads = calls.read;
    await Promise.all(Array.from({ length: 8 }, () => request(address)));
    assert.equal(calls.read, reads, 'client polling must not poll the provider');
    const operation = command(coordinator);
    const accepted = await request(address, { method: 'POST', target: '/v1/metadata/commands', body: operation });
    assert.equal(accepted.status, 202);
    const receipt = await completed(coordinator, operation.commandId);
    assert.equal(receipt.status, 'confirmed');
    assert.equal(receipt.snapshot.devices[0].name, '阅读灯 🌙');
    assert.equal(calls.writes.length, 1);
    const queried = await request(address, { target: `/v1/metadata/commands/${operation.commandId}` });
    assert.equal(queried.json.status, 'confirmed');
    assert.equal((await request(address, { method: 'POST', target: '/v1/metadata/commands', body: operation })).status, 202);
    assert.equal(calls.writes.length, 1);
    const changed = copy(operation); changed.operation.name = 'Another name';
    assert.equal((await request(address, { method: 'POST', target: '/v1/metadata/commands', body: changed })).status, 409);
    // A confirmed in-memory receipt may precede the final atomic disk rename.
    // Drain the coordinator before asserting the completed storage contents.
    await coordinator.close();
    const files = await fs.readdir(directory);
    assert.equal(files.length, 1);
    const persisted = JSON.parse(await fs.readFile(path.join(directory, files[0]), 'utf8'));
    assert.equal(persisted.commands[0].status, 'confirmed');
    assert.equal((await fs.stat(path.join(directory, files[0]))).mode & 0o777, 0o600);
    assert.equal(JSON.stringify(persisted).includes(TOKEN), false);
});

test('HTTP rejects invalid paths, methods, bodies, oversized requests and unknown fields', async t => {
    const { coordinator, calls } = await setup(t);
    const server = new MetadataHttpServer({ coordinator, token: TOKEN });
    const address = await server.start();
    t.after(() => server.close());
    for (const target of ['/v1/metadata?read=cloud', '/v1/%6detadata', '/v1/metadata#x']) {
        assert.equal((await request(address, { target })).status, 400);
    }
    assert.equal((await request(address, { target: '/not-found' })).status, 404);
    assert.equal((await request(address, { method: 'DELETE' })).status, 405);
    for (const body of ['{bad json', '[]', 'null']) {
        assert.equal((await request(address, { method: 'POST', target: '/v1/metadata/commands', body })).status, 400);
    }
    assert.equal((await request(address, { method: 'POST', target: '/v1/metadata/commands',
        body: 'x'.repeat(16385) })).status, 413);
    assert.equal((await request(address, { method: 'POST', target: '/v1/metadata/commands',
        chunks: ['x'.repeat(9000), 'x'.repeat(9000)], headers: { 'content-type': 'application/json' } })).status, 413);
    const input = command(coordinator); input.password = 'must-never-appear';
    const rejected = await request(address, { method: 'POST', target: '/v1/metadata/commands', body: input });
    assert.equal(rejected.status, 400);
    assert.equal(rejected.text.includes('must-never-appear'), false);
    assert.equal(rejected.headers['access-control-allow-origin'], undefined);
    assert.equal(calls.writes.length, 0);
    assert.throws(() => new MetadataHttpServer({ coordinator, token: TOKEN, host: '0.0.0.0' }), /TLS/);
    assert.throws(() => new MetadataHttpServer({ coordinator, token: 'short' }), /token/);
});

test('queued writes are serialized and refresh guards reject a concurrent stale command', async t => {
    const { coordinator, calls } = await setup(t);
    const first = command(coordinator);
    const second = command(coordinator, { type: 'device.rename', targetId: 'd_light', name: 'Second change' });
    coordinator.submit(first);
    coordinator.submit(second);
    assert.equal((await completed(coordinator, first.commandId)).status, 'confirmed');
    const conflict = await completed(coordinator, second.commandId);
    assert.equal(conflict.status, 'conflict');
    assert.equal(conflict.code, 'stale_revision');
    assert.equal(calls.writes.length, 1);
});

test('an external cloud change between acceptance and the write prevents overwrite', async t => {
    const { coordinator, state, calls } = await setup(t);
    const input = command(coordinator);
    state.devices[0].name = 'Changed in Tuya App';
    coordinator.submit(input);
    const receipt = await completed(coordinator, input.commandId);
    assert.equal(receipt.status, 'conflict');
    assert.equal(receipt.code, 'stale_revision');
    assert.equal(calls.writes.length, 0);
    assert.equal(receipt.snapshot.devices[0].name, 'Changed in Tuya App');
});

test('a persistence failure before a cloud write fails closed', async t => {
    const { coordinator, calls } = await setup(t);
    const save = coordinator._store.save.bind(coordinator._store);
    coordinator._store.save = async () => { throw new Error('credential-like filesystem detail'); };
    const input = command(coordinator);
    coordinator.submit(input);
    const receipt = await completed(coordinator, input.commandId);
    assert.equal(receipt.status, 'failed');
    assert.equal(receipt.code, 'source_unavailable');
    assert.equal(calls.writes.length, 0);
    assert.equal(calls.logs.join('').includes('credential-like'), false);
    coordinator._store.save = save;
});

test('explicit permission denial is safely reported without retrying the write', async t => {
    const { coordinator, provider, calls } = await setup(t);
    provider.apply = async operation => {
        calls.writes.push(operation);
        throw Object.assign(new Error('access_token=never-show-this'), { code: 'permission_denied' });
    };
    const input = command(coordinator);
    coordinator.submit(input);
    const receipt = await completed(coordinator, input.commandId);
    assert.equal(receipt.status, 'failed');
    assert.equal(receipt.code, 'permission_denied');
    assert.equal(JSON.stringify(receipt).includes('never-show-this'), false);
    coordinator.submit(input);
    assert.equal(calls.writes.length, 1);
});

test('source failure and partial room data retain known metadata without unassigning devices', async t => {
    const { coordinator, state, provider, calls } = await setup(t);
    const before = coordinator.getSnapshot();
    provider.read = async () => { throw new Error('access_token=very-private password=secret'); };
    await coordinator.refresh();
    let snapshot = coordinator.getSnapshot();
    assert.equal(snapshot.available, false);
    assert.equal(snapshot.roomsAvailable, false);
    assert.equal(snapshot.devices[0].name, before.devices[0].name);
    assert.equal(snapshot.devices[0].roomId, 'r_study');
    assert.deepEqual(snapshot.rooms, before.rooms);
    assert.equal(calls.logs.join('').includes('very-private'), false);
    provider.read = async () => ({ ...copy(state), roomsAvailable: false, homes: [], rooms: [],
        devices: state.devices.map(device => ({ ...copy(device), name: 'New cloud name', homeId: null, roomId: null, roomStatus: 'unknown' })) });
    await coordinator.refresh();
    snapshot = coordinator.getSnapshot();
    assert.equal(snapshot.available, true);
    assert.equal(snapshot.roomsAvailable, false);
    assert.equal(snapshot.devices[0].name, 'New cloud name');
    assert.equal(snapshot.devices[0].roomStatus, 'unknown');
    assert.equal(snapshot.devices[0].roomId, 'r_study');
    assert.deepEqual(snapshot.rooms, before.rooms);
    state.available = false; state.devices = []; state.rooms = []; state.homes = [];
    provider.read = async () => copy(state);
    await coordinator.refresh();
    assert.equal(coordinator.getSnapshot().devices[0].name, 'New cloud name');
});

test('unsupported capabilities, cross-home moves, stale identity and unsafe names never write', async t => {
    const { coordinator, state, calls } = await setup(t);
    assert.throws(() => coordinator.submit(command(coordinator, { type: 'device.move', targetId: 'd_light', roomId: 'r_study' })),
        { code: 'unsupported_operation' });
    for (const name of ['', ' ', 'x\n', '\uD800', '🌙'.repeat(41), 'a'.repeat(51)]) {
        assert.throws(() => coordinator.submit(command(coordinator, { type: 'device.rename', targetId: 'd_light', name })), { code: 'invalid_request' });
    }
    const wrong = command(coordinator); wrong.expected.sourceEpoch = randomUUID();
    assert.throws(() => coordinator.submit(wrong), { code: 'wrong_source' });
    state.capabilities.moveDevice = true;
    state.homes.push({ id: 'h_other', name: 'Other home' });
    state.rooms.push({ id: 'r_other', homeId: 'h_other', name: 'Other room' });
    await coordinator.refresh();
    assert.throws(() => coordinator.submit(command(coordinator, { type: 'device.move', targetId: 'd_light', roomId: 'r_other' })), { code: 'invalid_request' });
    assert.equal(calls.writes.length, 0);
});

test('read-only refreshes coalesce and stable metadata does not increment revision', async t => {
    const { coordinator, provider, state, calls } = await setup(t);
    let release;
    provider.read = () => { calls.read++; return new Promise(resolve => { release = resolve; }); };
    const before = coordinator.getSnapshot();
    const pending = Array.from({ length: 10 }, () => coordinator.refresh());
    await until(() => release);
    assert.equal(calls.read, 2);
    release(copy(state));
    await Promise.all(pending);
    assert.equal(coordinator.getSnapshot().revision, before.revision);
    assert.notEqual(coordinator.getSnapshot(), before);
});

test('the command queue is bounded while a provider read is pending', async t => {
    const { coordinator, provider, state } = await setup(t);
    let release;
    const read = provider.read;
    provider.read = () => new Promise(resolve => { release = () => { provider.read = read; resolve(copy(state)); }; });
    const inputs = Array.from({ length: 32 }, (_, index) => command(coordinator,
        { type: 'device.rename', targetId: 'd_light', name: `Change ${index}` }));
    inputs.forEach(input => coordinator.submit(input));
    assert.throws(() => coordinator.submit(command(coordinator)), { code: 'queue_full' });
    await until(() => release);
    release();
    await Promise.all(inputs.map(input => completed(coordinator, input.commandId)));
});

test('the running command is durable before apply and a restart never resends it', async t => {
    const first = await setup(t, { keep: true });
    const { coordinator, provider, directory, calls } = first;
    let release;
    let persisted;
    provider.apply = async operation => {
        calls.writes.push(operation);
        const [file] = await fs.readdir(directory);
        persisted = JSON.parse(await fs.readFile(path.join(directory, file), 'utf8'));
        return new Promise(resolve => { release = resolve; });
    };
    const input = command(coordinator);
    coordinator.submit(input);
    await until(() => release);
    assert.equal(persisted.commands[0].status, 'running');
    const restartedDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'tuya-metadata-restart-'));
    const [file] = await fs.readdir(directory);
    await fs.copyFile(path.join(directory, file), path.join(restartedDirectory, file));
    const second = await setup(t, { directory: restartedDirectory, state: first.state });
    const receipt = second.coordinator.getCommand(input.commandId);
    assert.equal(receipt.status, 'uncertain');
    assert.equal(receipt.code, 'write_uncertain');
    assert.equal(second.calls.writes.length, 0);
    assert.equal(second.coordinator.getSnapshot().serverId, coordinator.getSnapshot().serverId);
    assert.notEqual(second.coordinator.getSnapshot().sourceEpoch, coordinator.getSnapshot().sourceEpoch);
    assert.equal(second.coordinator.submit(input).status, 'uncertain', 'identical old command is only looked up');
    const freshId = copy(input); freshId.commandId = randomUUID();
    assert.throws(() => second.coordinator.submit(freshId), { code: 'wrong_source' });
    release();
    assert.equal((await completed(coordinator, input.commandId)).status, 'uncertain');
    await coordinator.close();
    await fs.rm(directory, { recursive: true, force: true });
});

test('cloud acknowledgement without read confirmation is uncertain and is never retried', async t => {
    const { coordinator, provider, calls } = await setup(t);
    provider.apply = async operation => { calls.writes.push(operation); };
    const input = command(coordinator);
    coordinator.submit(input);
    const receipt = await completed(coordinator, input.commandId);
    assert.equal(receipt.status, 'uncertain');
    assert.equal(receipt.code, 'confirmation_failed');
    await coordinator.refresh();
    coordinator.submit(input);
    assert.equal(calls.writes.length, 1);
});

test('post-write disconnect is uncertain, and projection failures do not undo confirmed truth', async t => {
    const { coordinator, provider, state, calls } = await setup(t, { onSnapshot: async () => { throw new Error('private projection detail'); } });
    const read = provider.read;
    provider.apply = async operation => { calls.writes.push(operation); provider.read = async () => { throw new Error('token=private'); }; };
    const input = command(coordinator);
    coordinator.submit(input);
    assert.equal((await completed(coordinator, input.commandId)).status, 'uncertain');
    provider.read = read;
    await coordinator.refresh();
    provider.apply = async operation => { calls.writes.push(operation); state.devices[0].name = operation.name; };
    const second = command(coordinator);
    coordinator.submit(second);
    assert.equal((await completed(coordinator, second.commandId)).status, 'confirmed');
    assert.equal(calls.logs.join('').includes('private'), false);
});

test('a timed out write stays uncertain, blocks overlapping writes and is not retried', { timeout: 20000 }, async t => {
    const { coordinator, provider, state, calls } = await setup(t);
    let release;
    provider.apply = operation => {
        calls.writes.push(operation);
        return new Promise(resolve => { release = resolve; });
    };
    const input = command(coordinator);
    coordinator.submit(input);
    const receipt = await completed(coordinator, input.commandId, 17000);
    assert.equal(receipt.status, 'uncertain');
    assert.equal(receipt.code, 'write_uncertain');
    const second = command(coordinator, { type: 'device.rename', targetId: 'd_light', name: 'Do not overlap' });
    coordinator.submit(second);
    assert.equal((await completed(coordinator, second.commandId)).status, 'uncertain');
    assert.equal(calls.writes.length, 1);
    state.devices[0].name = input.operation.name;
    release();
    await coordinator.refresh();
    assert.equal(coordinator.getCommand(input.commandId).status, 'uncertain', 'a late completion is not an automatic retry');
});

test('provider output is whitelisted and snapshots cannot mutate coordinator state', async t => {
    const state = fixture();
    state.password = 'private-account-password';
    state.devices[0].localKey = 'private-device-key';
    state.devices[0].bindings.accessToken = 'private-token';
    const { coordinator } = await setup(t, { state });
    const snapshot = coordinator.getSnapshot();
    assert.equal(JSON.stringify(snapshot).includes('private-'), false);
    snapshot.devices[0].name = 'Tampered';
    assert.equal(coordinator.getSnapshot().devices[0].name, '书房灯');
    assert.equal(normalizeSource(state).devices[0].bindings.accessToken, undefined);
    const reordered = command(coordinator);
    const canonical = validateCommand(reordered);
    const same = { operation: reordered.operation, expected: reordered.expected, commandId: reordered.commandId, schemaVersion: 1 };
    assert.equal(validateCommand(same).fingerprint, canonical.fingerprint);
    for (const id of [['123e4567-e89b-42d3-a456-426614174000'], '00000000-0000-0000-0000-000000000000']) {
        const invalid = copy(reordered); invalid.commandId = id;
        assert.throws(() => validateCommand(invalid), { code: 'invalid_request' });
    }
});

test('asynchronous projections stay ordered without delaying cloud confirmation', async t => {
    let release;
    const projected = [];
    const { coordinator, state } = await setup(t, { onSnapshot: async snapshot => {
        if (!release) await new Promise(resolve => { release = resolve; });
        projected.push(snapshot.devices[0].name);
    } });
    await until(() => release);
    state.devices[0].name = 'Newer metadata';
    await coordinator.refresh();
    assert.deepEqual(projected, []);
    release();
    await until(() => projected.length === 2);
    assert.deepEqual(projected, ['书房灯', 'Newer metadata']);
});

test('store preserves identity across reopen and refuses corrupt state without replacing it', async t => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'tuya-metadata-store-'));
    t.after(() => fs.rm(directory, { recursive: true, force: true }));
    const store = new MetadataStore({ storagePath: directory, accountKey: 'private-account' });
    const state = await store.open();
    await store.close();
    const next = new MetadataStore({ storagePath: directory, accountKey: 'private-account' });
    assert.deepEqual(await next.open(), state);
    await next.close();
    const [file] = await fs.readdir(directory);
    const corrupt = '{"token":"private-secret", broken';
    await fs.writeFile(path.join(directory, file), corrupt);
    const broken = new MetadataStore({ storagePath: directory, accountKey: 'private-account' });
    await assert.rejects(broken.open(), error => !error.message.includes('private-secret'));
    assert.equal(await fs.readFile(path.join(directory, file), 'utf8'), corrupt);
});

test('terminal history is bounded and old records are evicted before accepting new work', async t => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'tuya-metadata-history-'));
    const store = new MetadataStore({ storagePath: directory, accountKey: 'private-test-account' });
    const persisted = await store.open();
    const epoch = randomUUID();
    persisted.commands = Array.from({ length: 200 }, () => {
        const validated = validateCommand({ schemaVersion: 1, commandId: randomUUID(),
            expected: { serverId: persisted.serverId, sourceEpoch: epoch, revision: '0' }, operation: { type: 'refresh' } });
        return { ...validated, status: 'failed', code: 'source_unavailable' };
    });
    const oldest = persisted.commands[0].command.commandId;
    await store.save(persisted);
    await store.close();
    const { coordinator } = await setup(t, { directory });
    const input = command(coordinator, { type: 'refresh' });
    coordinator.submit(input);
    assert.equal((await completed(coordinator, input.commandId)).status, 'confirmed');
    assert.throws(() => coordinator.getCommand(oldest), { code: 'not_found' });
    const [file] = await fs.readdir(directory);
    assert.equal(JSON.parse(await fs.readFile(path.join(directory, file), 'utf8')).commands.length, 200);
});
