const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const http = require('node:http');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { HomebridgeAPI } = require(path.join(path.dirname(require.resolve('homebridge')), 'api.js'));
const { startMetadataSync, stopMetadataSync, projectSnapshot, bindingsForDevice } = require('../lib/metadata_sync/platform_sync');
const { MetadataHttpServer } = require('../lib/metadata_sync/http_server');
const TuyaOpenAPI = require('../lib/tuyaopenapi');

function setToken(t, value) {
  const key = 'TUYA_METADATA_PLATFORM_TEST_TOKEN';
  const previous = process.env[key];
  process.env[key] = value;
  t.after(() => { if (previous === undefined) delete process.env[key]; else process.env[key] = previous; });
}

function fixture(t) {
  const api = new HomebridgeAPI();
  let Platform;
  api.once('registerPlatform', (name, constructor) => { Platform = constructor; });
  require('../index')(api);
  const errors = [];
  const platform = new Platform({ warn() {}, error: text => errors.push(text) }, { options: {} }, api);
  platform.tuyaOpenApi = { async sendCommand() {} };
  t.after(async () => {
    await stopMetadataSync(platform);
    await platform.matterBridge.close();
  });
  return { api, platform, errors };
}

test('name projections preserve multi-channel DP keys, UUIDs, commands and cached pairing objects', async t => {
  const { api, platform } = fixture(t);
  const writes = [];
  platform.tuyaOpenApi.sendCommand = async (id, params) => { writes.push({ id, params }); };
  const device = { id: 'fixture-strip', name: 'Old strip', category: 'kg', status: [
    { code: 'switch_1', value: false }, { code: 'switch_2', value: true },
  ] };
  await platform.addAccessory(device);
  const uuid = api.hap.uuid.generate(device.id);
  const driver = platform.deviceAccessories.get(uuid);
  const accessory = driver.homebridgeAccessory;
  const services = accessory.services.filter(s => s.UUID === api.hap.Service.Switch.UUID);
  const identifiers = services.map(s => [s.UUID, s.subtype, s.displayName]);
  const snapshot = { available: true, devices: [{ name: '新名字 💡', bindings: { hapAccessoryUuid: uuid } }] };
  await projectSnapshot(platform, snapshot);
  assert.equal(platform.accessories.get(uuid), accessory);
  assert.equal(accessory.UUID, uuid);
  assert.equal(driver.deviceConfig.name, snapshot.devices[0].name);
  assert.equal(accessory.displayName, snapshot.devices[0].name);
  assert.deepEqual(services.map(s => [s.UUID, s.subtype, s.displayName]), identifiers);
  await services[1].getCharacteristic(api.hap.Characteristic.On).handleSetRequest(false);
  assert.deepEqual(writes, [{ id: device.id, params: { commands: [{ code: 'switch_2', value: false }] } }]);
  assert.equal(await services[1].getCharacteristic(api.hap.Characteristic.On).handleGetRequest(), false);
  await projectSnapshot(platform, { ...snapshot, available: false, devices: [{ ...snapshot.devices[0], name: 'Unavailable source must not apply' }] });
  assert.equal(accessory.displayName, snapshot.devices[0].name);
});

test('full Unicode cloud names remain intact while HAP labels fit byte limits', async t => {
  const { api, platform } = fixture(t);
  const device = { id: 'fixture-light', name: 'Old light', category: 'dj', status: [{ code: 'switch_led', value: true }] };
  await platform.addAccessory(device);
  const uuid = api.hap.uuid.generate(device.id);
  const name = '灯'.repeat(40);
  const accessory = platform.accessories.get(uuid);
  await projectSnapshot(platform, { available: true, devices: [{ name, bindings: { hapAccessoryUuid: uuid } }] });
  assert.equal(platform.deviceAccessories.get(uuid).deviceConfig.name, name);
  assert.equal(accessory.displayName, '灯'.repeat(21));
  assert.ok(Buffer.byteLength(accessory.displayName) <= 64);
  const bindings = await bindingsForDevice(platform, device.id);
  assert.equal(bindings.hapSerialNumber, null, 'default/nonunique serials cannot automatically match HomeKit devices');
  assert.deepEqual(bindings.matterUniqueIds, []);
});

test('metadata service is opt-in and rejects a LAN bind without TLS without disrupting the plugin', async t => {
  const { api, platform, errors } = fixture(t);
  await Promise.all([startMetadataSync(platform), startMetadataSync(platform)]);
  assert.equal(platform.metadataCoordinator, undefined);
  setToken(t, 'test-metadata-token-'.repeat(3));
  platform.config.options.metadataSync = { enabled: true, host: '0.0.0.0', tokenEnv: 'TUYA_METADATA_PLATFORM_TEST_TOKEN' };
  let storageTouched = false;
  t.mock.method(api.user, 'storagePath', () => { storageTouched = true; return '/unreachable-test-storage'; });
  await startMetadataSync(platform);
  assert.equal(platform.metadataServer, undefined);
  assert.equal(platform.metadataCoordinator, undefined);
  assert.equal(errors.length, 1);
  assert.ok(!errors.join('').includes(process.env.TUYA_METADATA_PLATFORM_TEST_TOKEN));
  assert.equal(storageTouched, true, 'storage path is resolved but no source poll starts before transport validation');
});

test('platform wiring starts a real authenticated service and projects authoritative reads without device rediscovery', async t => {
  const { api, platform, errors } = fixture(t);
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'tuya-platform-sync-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  t.mock.method(api.user, 'storagePath', () => directory);
  const reserve = net.createServer();
  await new Promise(resolve => reserve.listen(0, '127.0.0.1', resolve));
  const port = reserve.address().port;
  await new Promise(resolve => reserve.close(resolve));
  const token = 'fixture-metadata-platform-token-'.repeat(2);
  setToken(t, token);
  const device = { id: 'private-managed-switch', name: 'Initial switch', category: 'kg', status: [{ code: 'switch', value: true }] };
  await platform.addAccessory(device);
  let reads = 0;
  let sourceName = 'Authoritative cloud name';
  platform.tuyaOpenApi = {
    endpoint: 'https://example.invalid', tokenInfo: { uid: 'private-user' },
    async getDeviceListInfo(ids) {
      reads++;
      assert.deepEqual(ids, [device.id]);
      return [{ id: device.id, name: sourceName }];
    },
  };
  platform.config.options.projectType = '1';
  platform.config.options.username = 'private-account';
  platform.config.options.accessId = 'private-project';
  platform.config.options.metadataSync = { enabled: true, port, tokenEnv: 'TUYA_METADATA_PLATFORM_TEST_TOKEN' };
  await startMetadataSync(platform);
  assert.deepEqual(errors, []);
  assert.ok(platform.metadataServer);
  await platform.metadataProjectionTail;
  const url = `http://127.0.0.1:${port}/v1/metadata`;
  assert.equal((await fetch(url)).status, 401);
  const read = () => fetch(url, { headers: { Authorization: `Bearer ${token}` } }).then(r => r.json());
  const first = await read();
  assert.equal(first.devices[0].name, sourceName);
  assert.equal(first.devices[0].roomStatus, 'unsupported');
  assert.equal(first.capabilities.renameDevice, false);
  assert.equal(reads, 1);
  await Promise.all([read(), read()]);
  assert.equal(reads, 1, 'client polling must only read the shared cache');
  const accessory = platform.accessories.get(api.hap.uuid.generate(device.id));
  assert.equal(accessory.displayName, sourceName);
  sourceName = 'New authoritative cloud name';
  await platform.metadataCoordinator.refresh();
  await platform.metadataProjectionTail;
  assert.equal(accessory.displayName, sourceName);
  const serialized = JSON.stringify(await read());
  for (const secret of [token, 'private-account', 'private-project', 'private-user', device.id]) assert.ok(!serialized.includes(secret));
  await stopMetadataSync(platform);
  await assert.rejects(fetch(url));
});

test('shutdown during the first cloud read waits for cleanup and never opens a late listener', async t => {
  const { api, platform } = fixture(t);
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'tuya-platform-shutdown-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  t.mock.method(api.user, 'storagePath', () => directory);
  setToken(t, 'fixture-shutdown-token-'.repeat(3));
  const device = { id: 'shutdown-switch', name: 'Switch', category: 'kg', status: [{ code: 'switch', value: true }] };
  await platform.addAccessory(device);
  let entered;
  let release;
  const reading = new Promise(resolve => { entered = resolve; });
  const blocked = new Promise(resolve => { release = resolve; });
  platform.tuyaOpenApi = {
    endpoint: 'https://example.invalid', tokenInfo: { uid: 'fixture-account' },
    async getDeviceListInfo() { entered(); await blocked; return [device]; },
  };
  platform.config.options.projectType = '1';
  platform.config.options.metadataSync = { enabled: true, tokenEnv: 'TUYA_METADATA_PLATFORM_TEST_TOKEN' };
  let listens = 0;
  t.mock.method(MetadataHttpServer.prototype, 'start', async () => { listens++; throw new Error('late listener'); });
  const first = startMetadataSync(platform);
  assert.equal(startMetadataSync(platform), first, 'repeated startup shares one in-flight lifetime');
  await reading;
  const stopping = stopMetadataSync(platform);
  assert.equal(platform.metadataStopped, true);
  release();
  await Promise.all([first, stopping]);
  assert.equal(listens, 0);
  assert.equal(platform.metadataServer, undefined);
  assert.equal(platform.metadataStartingCoordinator, undefined);
});

test('an opted-in Custom rename crosses the actual Tuya HTTP transport and confirms by reading its list response', async t => {
  const { api, platform, errors } = fixture(t);
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'tuya-platform-transport-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  t.mock.method(api.user, 'storagePath', () => directory);
  setToken(t, 'metadata-custom-transport-token-'.repeat(2));
  const device = { id: 'fixture-custom-device', name: 'Cached switch', category: 'kg', status: [{ code: 'switch', value: true }] };
  await platform.addAccessory(device);
  let cloudName = 'Cloud switch';
  const mutations = [];
  const cloud = http.createServer(async (request, response) => {
    response.setHeader('content-type', 'application/json');
    const url = new URL(request.url, 'http://localhost');
    if (request.method === 'GET' && url.pathname === '/v1.0/iot-03/devices') {
      assert.equal(url.searchParams.get('device_ids'), device.id);
      response.end(JSON.stringify({ success: true, result: { list: [{ id: device.id, name: cloudName }] } }));
    } else if (request.method === 'PUT' && url.pathname === `/v1.0/iot-03/devices/${device.id}`) {
      let body = '';
      for await (const part of request) body += part;
      const fields = JSON.parse(body);
      assert.deepEqual(Object.keys(fields), ['name']);
      assert.ok(request.headers.sign, 'the existing authenticated Tuya transport must sign the mutation');
      assert.equal(request.headers.access_token, 'fixture-cloud-access-token');
      mutations.push({ method: request.method, path: url.pathname, fields });
      cloudName = fields.name;
      response.end(JSON.stringify({ success: true, result: true }));
    } else {
      response.statusCode = 404;
      response.end(JSON.stringify({ success: false }));
    }
  });
  await new Promise(resolve => cloud.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => { cloud.close(resolve); cloud.closeAllConnections(); }));
  // This is a loopback fixture, never a production Custom endpoint setting.
  platform.tuyaOpenApi = new TuyaOpenAPI(`http://127.0.0.1:${cloud.address().port}`, 'fixture-project-id', 'fixture-project-secret', platform.log);
  platform.tuyaOpenApi.tokenInfo = { access_token: 'fixture-cloud-access-token', expire: Date.now() + 3600000 };
  platform.config.options.projectType = '1';
  const reserve = net.createServer();
  await new Promise(resolve => reserve.listen(0, '127.0.0.1', resolve));
  const port = reserve.address().port;
  await new Promise(resolve => reserve.close(resolve));
  platform.config.options.metadataSync = { enabled: true, port, tokenEnv: 'TUYA_METADATA_PLATFORM_TEST_TOKEN', allowWrites: true };
  await startMetadataSync(platform);
  assert.deepEqual(errors, []);
  const coordinator = platform.metadataCoordinator;
  const snapshot = coordinator.getSnapshot();
  assert.equal(snapshot.capabilities.renameDevice, true);
  const commandId = 'f714e079-878b-4be0-91af-73a81090ada1';
  coordinator.submit({ schemaVersion: 1, commandId,
    expected: { serverId: snapshot.serverId, sourceEpoch: snapshot.sourceEpoch, revision: snapshot.revision },
    operation: { type: 'device.rename', targetId: snapshot.devices[0].id, name: '由控制器修改 💡' },
  });
  let receipt;
  for (let attempt = 0; attempt < 200; attempt++) {
    receipt = coordinator.getCommand(commandId);
    if (!['queued', 'running'].includes(receipt.status)) break;
    await new Promise(resolve => setTimeout(resolve, 5));
  }
  assert.equal(receipt.status, 'confirmed');
  await platform.metadataProjectionTail;
  assert.deepEqual(mutations, [{ method: 'PUT', path: `/v1.0/iot-03/devices/${device.id}`, fields: { name: '由控制器修改 💡' } }]);
  assert.equal(platform.accessories.get(api.hap.uuid.generate(device.id)).displayName, cloudName);
  assert.equal(receipt.snapshot.devices[0].name, cloudName);
  await stopMetadataSync(platform);
});
