const assert = require('node:assert/strict');
const path = require('node:path');
const { test } = require('node:test');
const DataUtil = require('../util/datautil');
const homebridgeDist = path.dirname(require.resolve('homebridge'));
const { HomebridgeAPI } = require(path.join(homebridgeDist, 'api.js'));

function createPlatform(t) {
  const api = new HomebridgeAPI();
  let Platform;
  api.once('registerPlatform', (name, Constructor) => { Platform = Constructor; });
  require('../index')(api);
  const log = { error() {}, warn() {}, info() {}, debug() {} };
  const platform = new Platform(log, { options: { debug: false } }, api);
  t.after(() => platform.matterBridge.close());
  return { api, platform };
}

function buttonServices(api, accessory) {
  return accessory.services.filter(service => service.UUID === api.hap.Service.StatelessProgrammableSwitch.UUID);
}

test('wireless channel discovery excludes battery and configuration datapoints for both category names', () => {
  const status = [
    { code: 'switch_mode1', value: 'single_click' },
    { code: 'switch_mode2', value: 'double_click' },
    { code: 'switch1_value', value: 1 },
    { code: 'switch_3', value: 'unknown' },
    { code: 'switch', value: 'click' },
    { code: 'battery_percentage', value: 85 },
    { code: 'battery_state', value: 'high' },
    { code: 'switch_backlight', value: true },
    { code: 'switch_mode', value: 'command' },
  ];
  for (const category of ['wxkg', 'WirelessSwitch']) {
    assert.deepEqual(new DataUtil().getSubService(status, category).subType,
      ['switch_mode1', 'switch_mode2', 'switch1_value', 'switch_3', 'switch']);
  }
  assert.deepEqual(new DataUtil().getSubService(status).subType, ['switch_backlight']);
});

test('a restored four-button accessory ignores unrelated datapoints and preserves each cached button service', async t => {
  const { api, platform } = createPlatform(t);
  const { Service, Characteristic } = api.hap;
  const device = { id: 'restored-four-buttons', name: 'Study four button remote', category: 'wxkg', status: [
    ...[1, 2, 3, 4].map(channel => ({ code: `switch_mode${channel}`, value: 'single_click' })),
    { code: 'battery_percentage', value: 85 }, { code: 'mode', value: 'scene' },
  ] };
  const old = new api.platformAccessory(device.name, api.hap.uuid.generate(device.id));
  old.context.deviceID = device.id; // The former @0x5e plugin's spelling.
  old._associatedPlugin = '@0x5e/homebridge-tuya-platform';
  old._associatedPlatform = 'TuyaPlatform';
  for (let channel = 1; channel <= 4; channel++) {
    old.addService(Service.StatelessProgrammableSwitch, `Renamed button ${channel}`, `switch_mode${channel}`)
      .setCharacteristic(Characteristic.ServiceLabelIndex, channel);
  }
  old.addService(Service.Battery, 'Battery')
    .setCharacteristic(Characteristic.BatteryLevel, 85);
  const cached = api.platformAccessory.deserialize(api.platformAccessory.serialize(old));
  const original = buttonServices(api, cached);
  const events = [];
  original.forEach(service => service.getCharacteristic(Characteristic.ProgrammableSwitchEvent)
    .on('change', event => events.push({ code: service.subtype, value: event.newValue })));
  platform.configureAccessory(cached);
  await platform.addAccessory(device);
  assert.equal(platform.accessories.get(cached.UUID), cached);
  assert.deepEqual(buttonServices(api, cached), original, 'cached services must be reused, including their subtypes');
  assert.equal(cached.context.deviceId, device.id);
  assert.deepEqual(events, [], 'restoring the last reported press must not fire an automation');

  await platform.onMQTTMessage({ devId: device.id, status: [
    { code: 'battery_percentage', value: 84 },
    { code: 'switch_mode2', value: 'double_click' },
    { code: 'switch_mode4', value: 'press' },
    { code: 'switch_mode3', value: 'unrecognized' },
  ] });
  assert.deepEqual(events, [
    { code: 'switch_mode2', value: 1 }, { code: 'switch_mode4', value: 2 },
  ]);
});

test('fresh and restored single-button remotes resolve services whose display name differs from the datapoint', async t => {
  for (const restored of [false, true]) {
    const { api, platform } = createPlatform(t);
    const device = { id: `single-${restored}`, name: 'Single remote', category: 'WirelessSwitch', status: [
      { code: 'switch1_value', value: 12 }, { code: 'battery_state', value: 'high' },
    ] };
    let original;
    if (restored) {
      const cached = new api.platformAccessory(device.name, api.hap.uuid.generate(device.id));
      original = cached.addService(api.hap.Service.StatelessProgrammableSwitch, device.name, 'switch1_value');
      platform.configureAccessory(cached);
    }
    await platform.addAccessory(device);
    const accessory = platform.accessories.get(api.hap.uuid.generate(device.id));
    const services = buttonServices(api, accessory);
    assert.equal(services.length, 1);
    if (original) assert.equal(services[0], original);
    const characteristic = services[0].getCharacteristic(api.hap.Characteristic.ProgrammableSwitchEvent);
    const events = [];
    characteristic.on('change', event => events.push(event.newValue));
    for (const value of ['single_click', 'single_click', 'double_click', 'long_press', '1', 13]) {
      await platform.onMQTTMessage({ devId: device.id, status: [{ code: 'switch1_value', value }] });
    }
    assert.deepEqual(events, [0, 0, 1, 2, 0, 0], 'each real press reaches HomeKit independently');
    assert.equal(await characteristic.handleGetRequest(), null, 'reads must never replay a previous event');
    for (const value of ['unknown', 0, false, null]) {
      await platform.onMQTTMessage({ devId: device.id, status: [{ code: 'switch1_value', value }] });
    }
    assert.equal(events.length, 6);
  }
});

test('wireless devices tolerate missing status updates without manufacturing events', async t => {
  const { api, platform } = createPlatform(t);
  const device = { id: 'partial-button-update', name: 'Button', category: 'wxkg', status: [
    { code: 'switch', value: 'none' },
  ] };
  await platform.addAccessory(device);
  const accessory = platform.accessories.get(api.hap.uuid.generate(device.id));
  const events = [];
  buttonServices(api, accessory)[0].getCharacteristic(api.hap.Characteristic.ProgrammableSwitchEvent)
    .on('change', event => events.push(event.newValue));
  for (const message of [{ devId: device.id }, { devId: device.id, status: null }, { devId: device.id, status: [] }]) {
    await platform.onMQTTMessage(message);
  }
  assert.deepEqual(events, []);
});
