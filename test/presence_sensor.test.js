const assert = require('node:assert/strict');
const path = require('node:path');
const test = require('node:test');
const { HomebridgeAPI } = require(path.join(path.dirname(require.resolve('homebridge')), 'api.js'));
const PresenceSensorAccessory = require('../lib/presence_sensor_accessory');
const schema = require('../config.schema.json');

function fixture(t, overrides = []) {
  const api = new HomebridgeAPI();
  let Platform;
  api.once('registerPlatform', (name, Constructor) => { Platform = Constructor; });
  require('../index')(api);
  const errors = [];
  const commands = [];
  const registrations = [];
  const removals = [];
  api.on('registerPlatformAccessories', accessories => registrations.push(...accessories));
  api.on('unregisterPlatformAccessories', accessories => removals.push(...accessories));
  const log = { error(message) { errors.push(message); }, warn() {}, debug() {} };
  const platform = new Platform(log, { options: { debug: false, accessoryType: overrides } }, api);
  platform.tuyaOpenApi = { async sendCommand(...args) { commands.push(args); } };
  t.after(() => platform.matterBridge.close());
  return { api, platform, commands, errors, registrations, removals };
}

function device(id, value, category = 'hps') {
  return { id, name: 'Human presence sensor', category,
    status: value === undefined ? [] : [{ code: 'presence_state', value }] };
}

function occupancy(api, platform, id) {
  const uuid = api.hap.uuid.generate(id);
  const service = platform.accessories.get(uuid).getService(api.hap.Service.OccupancySensor)
    || platform.deviceAccessories.get(uuid).service;
  return service.getCharacteristic(api.hap.Characteristic.OccupancyDetected);
}

function unavailable(api, characteristic) {
  return assert.rejects(characteristic.handleGetRequest(),
    error => error === api.hap.HAPStatus.SERVICE_COMMUNICATION_FAILURE);
}

async function sensorStatus(api, service) {
  const { Characteristic } = api.hap;
  return {
    fault: await service.getCharacteristic(Characteristic.StatusFault).handleGetRequest(),
    active: await service.getCharacteristic(Characteristic.StatusActive).handleGetRequest(),
  };
}

async function hapSnapshot(api, service, contactGetHandlers = true) {
  // Homebridge assigns IDs before serving /accessories. Supply only those IDs;
  // the real HAP serializers and GET handlers run unchanged in this fixture.
  service.iid = 1;
  service.characteristics.forEach((characteristic, index) => { characteristic.iid = index + 2; });
  const json = await service.toHAP(undefined, contactGetHandlers);
  const value = name => json.characteristics.find(item =>
    item.iid === service.getCharacteristic(api.hap.Characteristic[name]).iid).value;
  return { occupancy: value('OccupancyDetected'), fault: value('StatusFault'), active: value('StatusActive') };
}

test('hps maps all standard presence states to read-only HomeKit occupancy', async t => {
  const { api, platform, commands, errors } = fixture(t);
  for (const [value, expected] of [
    ['none', 0], ['presence', 1], ['peaceful', 1], ['small_move', 1], ['large_move', 1],
  ]) {
    const id = `standard-presence-${value}`;
    await platform.addAccessory(device(id, value));
    const characteristic = occupancy(api, platform, id);
    assert.equal(characteristic.value, expected, 'initial state is published without a preceding read');
    assert.equal(await characteristic.handleGetRequest(), expected, value);
    assert.ok(!characteristic.props.perms.includes('pw'));
    assert.equal(characteristic.setHandler, undefined);
    assert.equal(characteristic.listenerCount('set'), 0);
  }
  assert.deepEqual(commands, [], 'read-only sensors must never send cloud commands');
  assert.deepEqual(errors, []);
});

test('HumanPresenceSensor and OccupancySensor overrides select the same presence driver', async t => {
  const types = schema.schema.properties.options.properties.accessoryType.items.properties.type.enum;
  for (const type of ['hps', 'HumanPresenceSensor', 'OccupancySensor']) {
    assert.ok(types.includes(type));
    const id = `presence-override-${type}`;
    const { api, platform, commands } = fixture(t, [{ id, type }]);
    await platform.addAccessory(device(id, 'peaceful', 'vendor-specific'));
    assert.ok(platform.deviceAccessories.get(api.hap.uuid.generate(id)) instanceof PresenceSensorAccessory);
    assert.equal(await occupancy(api, platform, id).handleGetRequest(), 1);
    assert.deepEqual(commands, []);
  }
});

test('missing and unknown initial states remain unpublished until a valid MQTT presence report arrives', async t => {
  const { api, platform, commands, registrations } = fixture(t);
  for (const value of [undefined, 'unknown', '', true, false, 0, 1, null]) {
    const id = `unavailable-presence-${typeof value}-${String(value)}`;
    await platform.addAccessory(device(id, value));
    const characteristic = occupancy(api, platform, id);
    const driver = platform.deviceAccessories.get(api.hap.uuid.generate(id));
    assert.equal(driver.hasValidCache(), false);
    assert.equal(driver.registrationPending, true);
    assert.equal(driver.homebridgeAccessory.getService(api.hap.Service.OccupancySensor), undefined);
    assert.ok(!registrations.includes(driver.homebridgeAccessory));
    await unavailable(api, characteristic);
    await platform.onMQTTMessage({ devId: id, status: [{ code: 'presence_state', value: 'presence' }] });
    assert.equal(await characteristic.handleGetRequest(), 1);
    assert.equal(driver.hasValidCache(), true);
    assert.equal(driver.registrationPending, false);
    assert.equal(driver.homebridgeAccessory.getService(api.hap.Service.OccupancySensor), driver.service);
    assert.equal(registrations.filter(accessory => accessory === driver.homebridgeAccessory).length, 1);
    assert.deepEqual(await hapSnapshot(api, driver.service), { occupancy: 1, fault: 0, active: 1 });
  }
  assert.deepEqual(commands, []);
});

test('MQTT occupancy changes reuse one getter and keep still occupants occupied', async t => {
  const { api, platform, commands } = fixture(t);
  const id = 'incremental-presence';
  await platform.addAccessory(device(id, 'none'));
  const characteristic = occupancy(api, platform, id);
  const handler = characteristic.getHandler;
  const events = [];
  characteristic.on('change', event => events.push(event.newValue));
  for (const value of ['presence', 'presence', 'peaceful', 'small_move', 'large_move', 'none']) {
    await platform.onMQTTMessage({ devId: id, status: [{ code: 'presence_state', value }] });
    assert.equal(await characteristic.handleGetRequest(), value === 'none' ? 0 : 1);
    assert.equal(characteristic.getHandler, handler);
    assert.equal(characteristic.listenerCount('get'), 0);
  }
  assert.equal(events.at(-1), 0);
  assert.ok(events.slice(0, -1).every(value => value === 1), 'stillness must never emit an unoccupied event');
  assert.deepEqual(commands, []);
});

test('unrelated and malformed MQTT updates preserve a valid occupancy reading', async t => {
  const { api, platform } = fixture(t);
  const id = 'partial-presence';
  await platform.addAccessory(device(id, 'peaceful'));
  const characteristic = occupancy(api, platform, id);
  for (const message of [
    { devId: id }, { devId: id, status: null }, { devId: id, status: {} },
    { devId: id, status: 'none' }, { devId: id, status: [] },
    { devId: id, status: [null, false, 'none', [], { code: 'presence_state' }] },
    { devId: id, status: [{ code: 'presence_state', value: {} }, { code: 'presence_state', value: [] }] },
    { devId: id, status: [{ code: 'self_checking', value: false }, { code: 'motion_state', value: 'none' }] },
    { devId: id, status: [{ code: 'battery_percentage', value: 0 }, { code: 'sensitivity', value: 'none' }] },
  ]) {
    await platform.onMQTTMessage(message);
    assert.equal(await characteristic.handleGetRequest(), 1);
    assert.equal(characteristic.value, 1);
  }
});

test('unknown presence retains the last reading with an explicit fault in reads and real HAP serialization', async t => {
  const { api, platform, commands } = fixture(t);
  const id = 'unknown-presence-recovery';
  await platform.addAccessory(device(id, 'presence'));
  const characteristic = occupancy(api, platform, id);
  const driver = platform.deviceAccessories.get(api.hap.uuid.generate(id));
  for (const value of ['unknown', null, false, 0]) {
    await platform.onMQTTMessage({ devId: id, status: [{ code: 'presence_state', value }] });
    assert.equal(characteristic.value, 1);
    assert.equal(driver.getCachedState(api.hap.Characteristic.OccupancyDetected), 1);
    assert.equal(driver.hasValidCache(), false);
    assert.equal(await characteristic.handleGetRequest(), 1);
    assert.deepEqual(await sensorStatus(api, driver.service), { fault: 1, active: false });
    assert.deepEqual(await hapSnapshot(api, driver.service), { occupancy: 1, fault: 1, active: 0 });
    assert.deepEqual(await hapSnapshot(api, driver.service, false), { occupancy: 1, fault: 1, active: 0 });
    await platform.onMQTTMessage({ devId: id, status: [{ code: 'self_checking', value: true }] });
    assert.deepEqual(await hapSnapshot(api, driver.service), { occupancy: 1, fault: 1, active: 0 });
    await platform.onMQTTMessage({ devId: id, status: [{ code: 'presence_state', value: 'peaceful' }] });
    assert.equal(await characteristic.handleGetRequest(), 1);
    assert.deepEqual(await hapSnapshot(api, driver.service), { occupancy: 1, fault: 0, active: 1 });
  }
  await platform.onMQTTMessage({ devId: id, status: [{ code: 'presence_state', value: 'none' }] });
  assert.equal(await characteristic.handleGetRequest(), 0);
  assert.deepEqual(await hapSnapshot(api, driver.service), { occupancy: 0, fault: 0, active: 1 });
  assert.deepEqual(commands, []);
});

test('cached accessories retain their UUID and occupancy service when the presence driver is restored or rebound', async t => {
  const { api, platform, registrations } = fixture(t);
  const id = 'restored-human-presence';
  const prior = new api.platformAccessory('Renamed sensor', api.hap.uuid.generate(id));
  prior.context.deviceID = id;
  prior._associatedPlugin = '@0x5e/homebridge-tuya-platform';
  prior._associatedPlatform = 'TuyaPlatform';
  prior.addService(api.hap.Service.OccupancySensor, 'Existing occupancy', 'persisted-occupancy')
    .setCharacteristic(api.hap.Characteristic.OccupancyDetected, 1);
  const cached = api.platformAccessory.deserialize(api.platformAccessory.serialize(prior));
  const service = cached.getService(api.hap.Service.OccupancySensor);
  platform.configureAccessory(cached);
  await platform.addAccessory(device(id, undefined));
  assert.equal(platform.accessories.get(cached.UUID), cached);
  assert.equal(cached.context.deviceId, id);
  assert.equal(cached.getService(api.hap.Service.OccupancySensor), service);
  const characteristic = occupancy(api, platform, id);
  assert.equal(await characteristic.handleGetRequest(), 1);
  assert.deepEqual(await hapSnapshot(api, service), { occupancy: 1, fault: 1, active: 0 });
  await platform.addAccessory(device(id, 'none'));
  assert.equal(platform.accessories.get(cached.UUID), cached);
  assert.equal(cached.getService(api.hap.Service.OccupancySensor), service);
  assert.equal(cached.services.filter(item => item.UUID === api.hap.Service.OccupancySensor.UUID).length, 1);
  assert.equal(characteristic.listenerCount('get'), 0);
  assert.equal(await characteristic.handleGetRequest(), 0, 'the getter reads the replacement driver');
  assert.deepEqual(registrations, [], 'cached accessories are already registered');
});

test('repeated unknown discovery keeps registration pending and registers exactly once after confirmation', async t => {
  const { api, platform, registrations } = fixture(t);
  const id = 'repeated-pending-presence';
  await platform.addAccessory(device(id, 'unknown'));
  const accessory = platform.accessories.get(api.hap.uuid.generate(id));
  await platform.addAccessory(device(id, undefined));
  await platform.addAccessory(device(id, 'unknown'));
  const driver = platform.deviceAccessories.get(accessory.UUID);
  assert.equal(driver.homebridgeAccessory, accessory);
  assert.equal(driver.registrationPending, true);
  assert.equal(driver.getCachedState(api.hap.Characteristic.OccupancyDetected), undefined);
  assert.equal(accessory.getService(api.hap.Service.OccupancySensor), undefined);
  assert.deepEqual(registrations, []);
  await platform.onMQTTMessage({ devId: id, status: [{ code: 'presence_state', value: 'none' }] });
  await platform.onMQTTMessage({ devId: id, status: [{ code: 'presence_state', value: 'none' }] });
  assert.equal(driver.registrationPending, false);
  assert.equal(await occupancy(api, platform, id).handleGetRequest(), 0);
  assert.deepEqual(registrations, [accessory]);
});

test('deleting an unconfirmed pending sensor clears both maps without unregistering an unpublished accessory', async t => {
  const { api, platform, registrations, removals } = fixture(t);
  const id = 'deleted-pending-presence';
  await platform.addAccessory(device(id, 'unknown'));
  const uuid = api.hap.uuid.generate(id);
  assert.equal(platform.deviceAccessories.get(uuid).registrationPending, true);
  await platform.onMQTTMessage({ devId: id, bizCode: 'delete' });
  assert.equal(platform.accessories.has(uuid), false);
  assert.equal(platform.deviceAccessories.has(uuid), false);
  assert.deepEqual(registrations, []);
  assert.deepEqual(removals, []);
});

test('a pending sensor changed to a normal driver registers without an unconfirmed occupancy service', async t => {
  const id = 'pending-presence-override';
  const { api, platform, registrations } = fixture(t);
  await platform.addAccessory(device(id, 'unknown'));
  const accessory = platform.accessories.get(api.hap.uuid.generate(id));
  platform.specifiedAccessoryTypes = [{ id, type: 'Switch' }];
  await platform.addAccessory({ id, name: 'Reconfigured switch', category: 'hps', status: [{ code: 'switch', value: true }] });
  assert.equal(platform.accessories.get(accessory.UUID), accessory);
  assert.equal(platform.deviceAccessories.get(accessory.UUID).registrationPending, false);
  assert.equal(accessory.getService(api.hap.Service.OccupancySensor), undefined);
  assert.ok(accessory.getService(api.hap.Service.Switch));
  assert.deepEqual(registrations, [accessory]);
});

test('cached accessories without a previous occupancy reading hide the new service until confirmation', async t => {
  const { api, platform, registrations, removals } = fixture(t);
  const id = 'cached-different-driver';
  const cached = new api.platformAccessory('Existing switch', api.hap.uuid.generate(id));
  const original = cached.addService(api.hap.Service.Switch, 'Existing switch');
  platform.configureAccessory(cached);
  await platform.addAccessory(device(id, 'unknown'));
  const driver = platform.deviceAccessories.get(cached.UUID);
  const hidden = driver.service;
  assert.equal(driver.registrationPending, false, 'the existing accessory stays registered');
  assert.equal(cached.getService(api.hap.Service.OccupancySensor), undefined);
  assert.equal(driver.getCachedState(api.hap.Characteristic.OccupancyDetected), undefined);
  assert.equal(cached.getService(api.hap.Service.Switch), original);
  await platform.onMQTTMessage({ devId: id, status: [{ code: 'presence_state', value: 'presence' }] });
  assert.equal(cached.getService(api.hap.Service.OccupancySensor), hidden);
  assert.deepEqual(await hapSnapshot(api, hidden), { occupancy: 1, fault: 0, active: 1 });
  assert.deepEqual(registrations, []);
  assert.deepEqual(removals, []);
});

test('a cached confirmed empty room remains zero with a fault until a fresh physical reading arrives', async t => {
  const { api, platform, registrations } = fixture(t);
  const id = 'cached-empty-room';
  const cached = new api.platformAccessory('Empty room sensor', api.hap.uuid.generate(id));
  const service = cached.addService(api.hap.Service.OccupancySensor, 'Empty room sensor');
  service.updateCharacteristic(api.hap.Characteristic.OccupancyDetected, 0);
  platform.configureAccessory(cached);
  await platform.addAccessory(device(id, 'unknown'));
  assert.deepEqual(await hapSnapshot(api, service), { occupancy: 0, fault: 1, active: 0 });
  await platform.onMQTTMessage({ devId: id, status: [{ code: 'presence_state', value: 'none' }] });
  assert.deepEqual(await hapSnapshot(api, service), { occupancy: 0, fault: 0, active: 1 });
  assert.deepEqual(registrations, []);
});
