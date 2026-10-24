const assert = require('node:assert/strict');
const path = require('node:path');
const test = require('node:test');
const TuyaSHOpenAPI = require('../lib/tuyashopenapi');
const TuyaOpenAPI = require('../lib/tuyaopenapi');
const TuyaOpenMQ = require('../lib/tuyamqttapi');
const { HomebridgeAPI } = require(path.join(path.dirname(require.resolve('homebridge')), 'api.js'));

function fixture(t, options = {}) {
  const api = new HomebridgeAPI();
  let Platform;
  api.once('registerPlatform', (name, constructor) => { Platform = constructor; });
  require('../index')(api);
  const errors = [];
  const config = { options: {
    debug: false,
    accessId: 'fixture-access-id-not-to-log',
    accessKey: 'fixture-access-key-not-to-log',
    username: 'fixture-account-not-to-log',
    password: 'fixture-password-not-to-log',
    ...options,
  } };
  const platform = new Platform({ error: message => errors.push(message) }, config, api);
  const started = [];
  t.mock.method(TuyaOpenMQ.prototype, 'start', function () { started.push(this); });
  t.after(async () => {
    api.emit('shutdown');
    await platform.matterBridge.close();
  });
  return { api, platform, config, errors, started };
}

async function eventually(check) {
  for (let attempt = 0; attempt < 100; attempt++) {
    if (check()) return;
    await new Promise(resolve => setImmediate(resolve));
  }
  assert.ok(check(), 'expected the asynchronous platform operation to complete');
}

function assertSafeErrors(errors, config) {
  const output = errors.join('\n');
  for (const name of ['accessId', 'accessKey', 'username', 'password']) {
    assert.ok(!output.includes(config.options[name]), `logs must not contain ${name}`);
  }
  assert.ok(!output.includes('Authorization'));
}

test('a failed cached device does not stop discovery or MQTT or delete cached endpoints', async t => {
  const { api, platform, config, errors, started } = fixture(t);
  // A malformed cloud response exercises an actual driver constructor failure.
  const badDevice = { id: 'bad-contact', name: 'Cached contact', category: 'mcs' };
  const goodDevice = { id: 'good-switch', name: 'Working switch', category: 'kg', status: [{ code: 'switch', value: true }] };
  t.mock.method(TuyaSHOpenAPI.prototype, 'getDevices', async () => [badDevice, goodDevice]);
  const cached = new api.platformAccessory(badDevice.name, api.hap.uuid.generate(badDevice.id));
  cached.context.deviceId = badDevice.id;
  cached.addService(api.hap.Service.ContactSensor, badDevice.name);
  platform.configureAccessory(cached);
  const savedMatter = { UUID: 'cached-matter-contact', context: { homebridgeUUID: cached.UUID } };
  platform.matterBridge.cachedAccessories.set(savedMatter.UUID, savedMatter);
  let pruned = false;
  t.mock.method(platform.matterBridge, 'reconcileAccessories', async () => {
    pruned = true;
    platform.matterBridge.cachedAccessories.clear();
  });
  const removed = [];
  api.on('unregisterPlatformAccessories', accessories => removed.push(...accessories));
  api.emit('didFinishLaunching');
  await eventually(() => started.length === 1);
  assert.equal(platform.accessories.get(cached.UUID), cached);
  assert.ok(platform.deviceAccessories.has(api.hap.uuid.generate(goodDevice.id)));
  assert.equal(platform.deviceAccessories.has(cached.UUID), false);
  assert.equal(platform.tuyaOpenMQ.message_listeners.size, 1);
  assert.equal(pruned, false);
  assert.equal(platform.matterBridge.cachedAccessories.get(savedMatter.UUID), savedMatter);
  assert.deepEqual(removed, []);
  assert.equal(errors.length, 1);
  assert.match(errors[0], /initialize device Cached contact \(bad-contact\)/);
  assertSafeErrors(errors, config);
});

test('MQTT device-update and bind errors are caught while later healthy updates still work', async t => {
  const { api, platform, config, errors, started } = fixture(t);
  const devices = [
    { id: 'contact', name: 'Contact sensor', category: 'mcs', status: [{ code: 'doorcontact_state', value: false }] },
    { id: 'switch', name: 'Working switch', category: 'kg', status: [{ code: 'switch', value: true }] },
  ];
  t.mock.method(TuyaSHOpenAPI.prototype, 'getDevices', async () => devices);
  let reconciled = false;
  t.mock.method(platform.matterBridge, 'reconcileAccessories', async () => { reconciled = true; });
  api.emit('didFinishLaunching');
  await eventually(() => started.length === 1);
  assert.equal(reconciled, true, 'a complete discovery should still reconcile stale endpoints');
  const listener = [...platform.tuyaOpenMQ.message_listeners][0];
  const accessory = platform.accessories.get(api.hap.uuid.generate('switch'));
  const on = accessory.getService(api.hap.Service.Switch).getCharacteristic(api.hap.Characteristic.On);
  assert.equal(await on.handleGetRequest(), true);
  await assert.doesNotReject(listener({ devId: 'contact', status: null }));
  await assert.doesNotReject(listener({ devId: 'switch', status: [{ code: 'switch', value: false }] }));
  assert.equal(on.value, false);
  platform.tuyaOpenApi.getDeviceInfo = async id => {
    assert.equal(id, 'joining-device');
    const error = new Error('Cloud lookup unavailable');
    error.config = { headers: { Authorization: config.options.accessKey } };
    throw error;
  };
  await assert.doesNotReject(listener({ bizCode: 'bindUser', bizData: { devId: 'joining-device' } }));
  await assert.doesNotReject(listener({ devId: 'switch', status: [{ code: 'switch', value: true }] }));
  assert.equal(on.value, true);
  assert.equal(errors.length, 2);
  assert.match(errors[0], /handle device message Contact sensor \(contact\)/);
  assert.match(errors[1], /handle device message unnamed \(joining-device\): Cloud lookup unavailable/);
  assertSafeErrors(errors, config);
});

test('a project login rejection is handled at the launch boundary without logging credentials', async t => {
  const { api, config, errors, started } = fixture(t, { projectType: '1' });
  t.mock.method(TuyaOpenAPI.prototype, 'login', async () => {
    const error = new Error('Project login unavailable');
    error.config = { password: config.options.password, accessKey: config.options.accessKey };
    throw error;
  });
  t.mock.method(TuyaOpenAPI.prototype, 'getDeviceList', async () => assert.fail('login failure must stop cloud discovery'));
  api.emit('didFinishLaunching');
  await eventually(() => errors.length === 1);
  assert.equal(started.length, 0);
  assert.equal(errors[0], 'Failed to initialize TuyaPlatform: Project login unavailable');
  assertSafeErrors(errors, config);
});

test('a cloud discovery rejection is visible even with debug logging disabled', async t => {
  const { api, config, errors, started } = fixture(t);
  t.mock.method(TuyaSHOpenAPI.prototype, 'getDevices', async () => { throw new Error('Device discovery unavailable'); });
  api.emit('didFinishLaunching');
  await eventually(() => errors.length === 1);
  assert.equal(started.length, 0);
  assert.equal(errors[0], 'Failed to get device information: Device discovery unavailable');
  assertSafeErrors(errors, config);
});
