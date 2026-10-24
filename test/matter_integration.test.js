const assert = require('node:assert/strict');
const { test } = require('node:test');
const { mkdtemp, rm } = require('node:fs/promises');
const { tmpdir } = require('node:os');
const path = require('node:path');

// Test against the real Homebridge/HAP and Matter implementations supplied as
// development dependencies; production code only uses the injected plugin API.
const homebridgeDist = path.dirname(require.resolve('homebridge'));
const { HomebridgeAPI } = require(path.join(homebridgeDist, 'api.js'));
const { User } = require(path.join(homebridgeDist, 'user.js'));
const pluginName = require('../package.json').name;

function createPlatform(api) {
  let Platform;
  api.once('registerPlatform', (name, constructor, identifier) => {
    assert.equal(name, 'TuyaPlatform');
    assert.equal(identifier, pluginName);
    Platform = constructor;
  });
  require('../index')(api);
  const errors = [];
  const log = { error: message => errors.push(message), warn() {}, info() {}, debug() {} };
  const platform = new Platform(log, { options: { debug: false } }, api);
  const commands = [];
  platform.tuyaOpenApi = {
    async sendCommand(id, body) {
      commands.push({ id, body });
      return true;
    },
  };
  return { platform, commands, errors };
}

async function eventually(check) {
  for (let attempt = 0; attempt < 100; attempt++) {
    if (check()) return;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  assert.ok(check(), 'expected state was not propagated');
}

test('HomeKit still controls Tuya devices when the Matter API is absent', async t => {
  const api = new HomebridgeAPI();
  assert.equal(api.matter, undefined);
  const { platform, commands } = createPlatform(api);
  t.after(() => platform.matterBridge.close());
  await platform.addAccessory({
    id: 'homekit-only', name: 'HomeKit switch', category: 'kg',
    status: [{ code: 'switch', value: false }],
  });
  const accessory = platform.accessories.get(api.hap.uuid.generate('homekit-only'));
  const characteristic = accessory.getService(api.hap.Service.Switch)
    .getCharacteristic(api.hap.Characteristic.On);
  await characteristic.handleSetRequest(true);
  assert.deepEqual(commands, [{ id: 'homekit-only', body: {
    commands: [{ code: 'switch', value: true }],
  } }]);
  await platform.onMQTTMessage({ devId: 'homekit-only', status: [{ code: 'switch', value: false }] });
  assert.equal(characteristic.value, false);
  await platform.onMQTTMessage({ devId: 'homekit-only', bizCode: 'delete' });
  assert.equal(platform.accessories.size, 0);
  assert.equal(platform.deviceAccessories.size, 0);
});

test('native Matter endpoints control Tuya drivers and receive MQTT state', { timeout: 30000 }, async t => {
  const storage = await mkdtemp(path.join(tmpdir(), 'tuya-matter-test-'));
  User.setStoragePath(storage);
  const { MatterServer } = require(path.join(homebridgeDist, 'matter/server.js'));
  const serverConfig = {
    uniqueId: 'tuya-integration-test',
    storagePath: path.join(storage, 'matter'),
    displayName: 'Tuya integration test',
    port: 15540,
    // Build real Matter endpoints without advertising a test bridge on the LAN.
    deferOnline: true,
    networkInterfaces: ['lo'],
  };
  let server = new MatterServer(serverConfig);
  const api = new HomebridgeAPI();
  await api.loadMatterAPI();
  // Preserve the actual asynchronous event contract of Homebridge's Matter
  // facade. Its Promise-returning methods emit events before the manager's
  // endpoint registration/state writes finish.
  api._matterServer = server;
  api._matterManager = {
    hasActiveMatter: () => true,
    isBridgeServerStarting: () => false,
    getExternalServer: () => undefined,
  };
  const pending = new Set();
  const nativeFailures = [];
  const track = operation => {
    pending.add(operation);
    operation.then(() => pending.delete(operation), error => {
      nativeFailures.push(error);
      pending.delete(operation);
    });
  };
  const drain = async () => {
    while (pending.size) await Promise.allSettled(Array.from(pending));
  };
  // Network invokes acquire the behavior's asynchronous transaction lock before
  // calling the handler. Homebridge's offline triggerCommand helper omits that
  // pre-lock and can race a legitimate external state update in this fixture.
  const invoke = async (uuid, cluster, command, args) => {
    const endpoint = server.accessories.get(uuid).endpoint;
    return endpoint.act(`test invoke ${cluster}.${command}`, async agent => {
      const behavior = agent[cluster];
      const tx = agent.context.transaction;
      await tx.addResources(behavior);
      await tx.begin();
      return args === undefined ? behavior[command]() : behavior[command](args);
    });
  };
  api.on('registerMatterPlatformAccessories', (...args) => track(server.registerPlatformAccessories(...args)));
  api.on('unregisterMatterPlatformAccessories', (...args) => track(server.unregisterPlatformAccessories(...args)));
  api.on('updateMatterAccessoryState', (...args) => track(server.updateAccessoryState(...args)));
  api.on('updateMatterPlatformAccessories', descriptors => track(server.updatePlatformAccessories(descriptors)));
  const { platform, commands, errors } = createPlatform(api);
  let restoredPlatform;
  t.after(async () => {
    await platform.matterBridge.close();
    if (restoredPlatform) await restoredPlatform.matterBridge.close();
    await drain();
    await server.stop();
    await rm(storage, { recursive: true, force: true });
  });
  await server.start();

  const devices = [
    { id: 'multi-switch', name: 'Two channel switch', category: 'kg', status: [
      { code: 'switch_1', value: false }, { code: 'switch_2', value: true },
    ] },
    { id: 'outlet', name: 'Outlet', category: 'cz', status: [{ code: 'switch', value: true }] },
    { id: 'light', name: 'Color light', category: 'dj', status: [
      { code: 'work_mode', value: 'white' },
      { code: 'switch_led', value: false },
      { code: 'bright_value_v2', value: 505 },
      { code: 'temp_value_v2', value: 500 },
      { code: 'colour_data_v2', value: JSON.stringify({ h: 180, s: 500, v: 505 }) },
    ] },
    { id: 'contact', name: 'Contact sensor', category: 'mcs', status: [
      { code: 'doorcontact_state', value: false }, { code: 'battery_percentage', value: 80 },
    ] },
    { id: 'smoke', name: 'Smoke sensor', category: 'ywbj', status: [
      { code: 'smoke_sensor_status', value: 'normal' }, { code: 'battery_state', value: 'high' },
    ] },
    { id: 'fan', name: 'Fan', category: 'fs', status: [
      { code: 'switch', value: true }, { code: 'fan_speed', value: '2' },
    ] },
    { id: 'cover', name: 'Window covering', category: 'cl', status: [
      { code: 'percent_control', value: 30 }, { code: 'percent_state', value: 30 },
    ] },
  ];
  for (const device of devices) await platform.addAccessory(device);
  await drain();
  assert.deepEqual(errors, [], 'every supported descriptor must be accepted by the native Matter server');
  assert.deepEqual(nativeFailures, []);
  assert.equal(server.getAccessories().length, 8, 'multi-channel switches expose independent endpoints');
  const endpoint = (id, subtype = '') => server.getAccessories().find(accessory =>
    accessory.context.deviceId === id && accessory.context.serviceSubtype === subtype);

  const outlet = endpoint('outlet');
  const outletAccessory = platform.accessories.get(api.hap.uuid.generate('outlet'));
  const nativeInfo = server.getAccessoryState(outlet.UUID, 'bridgedDeviceBasicInformation');
  assert.deepEqual(await platform.matterBridge.getMetadataBindings(outletAccessory.UUID),
    typeof nativeInfo.uniqueId === 'string' && nativeInfo.uniqueId ? [nativeInfo.uniqueId] : [],
    'an omitted optional native uniqueId must require explicit binding, never a fabricated identity');
  const pairingBeforeRename = server.getCommissioningInfo().manualPairingCode;
  await platform.matterBridge.updateAccessoryMetadata(outletAccessory, '灯'.repeat(40));
  await drain();
  assert.equal(server.getAccessoryState(outlet.UUID, 'bridgedDeviceBasicInformation').nodeLabel, '灯'.repeat(10));
  // Homebridge 2.4's public cache API only updates entries restored from cache;
  // the live standard cluster must still update on a first registration.
  assert.equal(endpoint('outlet').UUID, outlet.UUID);
  assert.equal(server.getCommissioningInfo().manualPairingCode, pairingBeforeRename);

  const channel = endpoint('multi-switch', 'switch_1');
  assert.equal(server.getAccessoryState(channel.UUID, 'onOff').onOff, false);
  assert.equal(server.getAccessoryState(endpoint('multi-switch', 'switch_2').UUID, 'onOff').onOff, true);
  await invoke(channel.UUID, 'onOff', 'on');
  assert.deepEqual(commands.at(-1), { id: 'multi-switch', body: {
    commands: [{ code: 'switch_1', value: true }],
  } });
  assert.equal(server.getAccessoryState(channel.UUID, 'onOff').onOff, true);
  await platform.onMQTTMessage({ devId: 'multi-switch', status: [{ code: 'switch_1', value: false }] });
  await eventually(() => server.getAccessoryState(channel.UUID, 'onOff').onOff === false);
  const concurrentCommandCount = commands.length;
  await Promise.all([
    platform.onMQTTMessage({ devId: 'multi-switch', status: [{ code: 'switch_1', value: false }] }),
    invoke(channel.UUID, 'onOff', 'on'),
  ]);
  await platform.matterBridge.queue;
  await drain();
  const switchAccessory = platform.accessories.get(api.hap.uuid.generate('multi-switch'));
  const currentSwitch = switchAccessory.getServiceById(api.hap.Service.Switch, 'switch_1')
    .getCharacteristic(api.hap.Characteristic.On);
  assert.equal(server.getAccessoryState(channel.UUID, 'onOff').onOff, await currentSwitch.handleGetRequest(),
    'a source observation concurrent with a native command must converge without another physical command');
  assert.equal(commands.length, concurrentCommandCount + 1);

  // A failing cloud command must fail the Matter request without claiming the
  // device changed. Restoring the sender must permit the next command.
  const sender = platform.tuyaOpenApi.sendCommand;
  const beforeFailure = server.getAccessoryState(channel.UUID, 'onOff').onOff;
  platform.tuyaOpenApi.sendCommand = async () => { throw new Error('cloud unavailable'); };
  await assert.rejects(invoke(channel.UUID, 'onOff', beforeFailure ? 'off' : 'on'));
  assert.equal(server.getAccessoryState(channel.UUID, 'onOff').onOff, beforeFailure);
  assert.equal(errors.length, 1, 'the failed cloud command must be logged even without debug mode');
  assert.match(errors.shift(), /\[SET\]/);
  platform.tuyaOpenApi.sendCommand = sender;
  await invoke(channel.UUID, 'onOff', 'on');

  const contact = endpoint('contact');
  assert.equal(server.getAccessoryState(contact.UUID, 'booleanState').stateValue, true);
  await platform.onMQTTMessage({ devId: 'contact', status: [{ code: 'doorcontact_state', value: true }] });
  await eventually(() => server.getAccessoryState(contact.UUID, 'booleanState').stateValue === false);

  const smoke = endpoint('smoke');
  await platform.onMQTTMessage({ devId: 'smoke', status: [{ code: 'smoke_sensor_status', value: 'alarm' }] });
  await eventually(() => server.getAccessoryState(smoke.UUID, 'smokeCoAlarm').smokeState === 2);

  const fan = endpoint('fan');
  const commandCount = commands.length;
  await platform.onMQTTMessage({ devId: 'fan', status: [{ code: 'fan_speed', value: '3' }] });
  await eventually(() => server.getAccessoryState(fan.UUID, 'fanControl').percentCurrent === 100);
  await new Promise(resolve => setImmediate(resolve));
  await platform.matterBridge.queue;
  assert.equal(commands.length, commandCount, 'MQTT fan reports must not send control commands back to Tuya');
  await server.accessories.get(fan.UUID).endpoint.set({ fanControl: { percentSetting: 33 } });
  await eventually(() => commands.some(command => command.id === 'fan'));
  assert.ok(commands.some(command => command.id === 'fan'
    && command.body.commands.some(item => item.code === 'fan_speed' && String(item.value) === '1')),
  'native Matter fan writes must control the Tuya speed datapoint');
  await new Promise(resolve => setImmediate(resolve));
  await platform.matterBridge.queue;
  await drain();
  assert.equal(server.getAccessoryState(fan.UUID, 'fanControl').percentCurrent, 33);
  assert.equal(server.getAccessoryState(fan.UUID, 'fanControl').fanMode, 1);

  const light = endpoint('light');
  assert.equal(server.getAccessoryState(light.UUID, 'colorControl').colorMode, 2);
  await platform.onMQTTMessage({ devId: 'light', status: [{ code: 'work_mode', value: 'colour' }] });
  await eventually(() => server.getAccessoryState(light.UUID, 'colorControl').colorMode === 0);
  await platform.onMQTTMessage({ devId: 'light', status: [{ code: 'work_mode', value: 'white' }] });
  await invoke(light.UUID, 'levelControl', 'moveToLevelWithOnOff', { level: 127, transitionTime: 0 });
  assert.ok(commands.some(command => command.id === 'light'
    && command.body.commands[0].code === 'bright_value_v2'
    && command.body.commands[0].value === 505));
  await invoke(light.UUID, 'colorControl', 'moveToHueAndSaturation', {
    hue: 127, saturation: 254, transitionTime: 0,
    optionsMask: { executeIfOff: false }, optionsOverride: { executeIfOff: false },
  });
  assert.deepEqual(commands.at(-1), { id: 'light', body: {
    commands: [{ code: 'colour_data_v2', value: { h: 180, s: 1000, v: 505 } }],
  } });

  const covering = endpoint('cover');
  assert.equal(server.getAccessoryState(covering.UUID, 'windowCovering').currentPositionLiftPercent100ths, 3000);
  await invoke(covering.UUID, 'windowCovering', 'goToLiftPercentage', { liftPercent100thsValue: 7500 });
  assert.deepEqual(commands.at(-1), { id: 'cover', body: { commands: [{ code: 'percent_control', value: 75 }] } });

  // Re-discovery must not duplicate endpoints; deleted/disabled endpoints must
  // be removed without purging unrelated channels or the bridge's pairing data.
  await platform.matterBridge.reconcileAccessories(platform.accessories.values());
  await drain();
  assert.equal(server.getAccessories().length, 8);
  await platform.onMQTTMessage({ devId: 'multi-switch', bizCode: 'delete' });
  await drain();
  assert.equal(server.getAccessories().length, 6);
  assert.deepEqual(errors, []);
  assert.deepEqual(nativeFailures, []);

  const outletUUID = endpoint('outlet').UUID;
  const pairingCode = server.getCommissioningInfo().manualPairingCode;
  await platform.matterBridge.close();
  await drain();
  // Flush the real native cache explicitly: this test builds the server without
  // advertising it, so the runtime's normal online-shutdown flush does not run.
  await server.accessoryCache.save(server.accessories);
  await server.stop();
  server = new MatterServer(serverConfig);
  api._matterServer = server;
  await server.start();
  assert.equal(server.getAccessories().length, 6);
  assert.equal(server.getCommissioningInfo().manualPairingCode, pairingCode);
  const restored = createPlatform(api);
  restoredPlatform = restored.platform;
  for (const cached of server.getAccessories()) restored.platform.configureMatterAccessory(cached);
  await restored.platform.addAccessory(devices.find(device => device.id === 'outlet'));
  await restored.platform.matterBridge.reconcileAccessories(restored.platform.accessories.values());
  await drain();
  assert.equal(server.getAccessories().length, 1, 'stale cached endpoints are pruned after discovery');
  assert.equal(server.getAccessories()[0].UUID, outletUUID, 'restored endpoints retain their identity');
  await restored.platform.matterBridge.updateAccessoryMetadata(
    restored.platform.accessories.get(api.hap.uuid.generate('outlet')), 'Restored renamed outlet');
  await drain();
  assert.equal(server.getAccessoryState(outletUUID, 'bridgedDeviceBasicInformation').nodeLabel, 'Restored renamed outlet');
  assert.equal(server.getAccessories()[0].displayName, 'Restored renamed outlet',
    'the public metadata update must refresh a restored native descriptor without replacing its endpoint');
  await invoke(outletUUID, 'onOff', 'off');
  assert.deepEqual(restored.commands.at(-1), { id: 'outlet', body: { commands: [{ code: 'switch', value: false }] } });
  assert.deepEqual(restored.errors, []);
  assert.deepEqual(nativeFailures, []);
});
