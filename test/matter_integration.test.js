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

  // The actual Tuya covering driver never sets HAP PositionState, whose
  // mandatory default is DECREASING. Native Matter derives motion from the
  // positions and resets target=current during initialization, so mismatched
  // targets must be restored without forcing that unrelated HAP default back.
  const coveringCases = [
    { id: 'cover-opening', target: 10, current: 70, nativeTarget: 1000, nativeCurrent: 7000, movement: 1 },
    { id: 'cover-closing', target: 90, current: 30, nativeTarget: 9000, nativeCurrent: 3000, movement: 2 },
    { id: 'cover-equal', target: 60, current: 60, nativeTarget: 6000, nativeCurrent: 6000, movement: 0 },
    { id: 'cover-reversed', target: 75, current: 30, nativeTarget: 2500, nativeCurrent: 7000, movement: 1, fullyOpen: true },
  ];
  const coveringCommands = commands.length;
  for (const item of coveringCases) {
    await platform.addAccessory({ id: item.id, name: item.id, category: 'cl', status: [
      ...(item.fullyOpen ? [{ code: 'situation_set', value: 'fully_open' }] : []),
      { code: 'percent_control', value: item.target }, { code: 'percent_state', value: item.current },
    ] });
    const state = server.getAccessoryState(endpoint(item.id).UUID, 'windowCovering');
    assert.equal(state.targetPositionLiftPercent100ths, item.nativeTarget);
    assert.equal(state.currentPositionLiftPercent100ths, item.nativeCurrent);
    // OperationalStatus is a bitmap with default numeric value zero. Native
    // Matter may expose zero-valued fields as absent until the first movement.
    assert.equal(state.operationalStatus.lift ?? 0, item.movement);
    const hap = platform.accessories.get(api.hap.uuid.generate(item.id));
    assert.equal(hap.getService(api.hap.Service.WindowCovering)
      .getCharacteristic(api.hap.Characteristic.PositionState).value, 0);
  }
  const movingCover = endpoint('cover-opening');
  await platform.onMQTTMessage({ devId: 'cover-opening', status: [{ code: 'percent_state', value: 10 }] });
  assert.equal(server.getAccessoryState(movingCover.UUID, 'windowCovering').currentPositionLiftPercent100ths, 1000);
  assert.equal(server.getAccessoryState(movingCover.UUID, 'windowCovering').operationalStatus.lift, 0);
  await platform.onMQTTMessage({ devId: 'cover-opening', status: [
    { code: 'percent_control', value: 90 }, { code: 'percent_state', value: 40 },
  ] });
  assert.equal(server.getAccessoryState(movingCover.UUID, 'windowCovering').targetPositionLiftPercent100ths, 9000);
  assert.equal(server.getAccessoryState(movingCover.UUID, 'windowCovering').currentPositionLiftPercent100ths, 4000);
  assert.equal(server.getAccessoryState(movingCover.UUID, 'windowCovering').operationalStatus.lift, 2);
  await platform.onMQTTMessage({ devId: 'cover-opening', status: [{ code: 'percent_state', value: 90 }] });
  assert.equal(server.getAccessoryState(movingCover.UUID, 'windowCovering').operationalStatus.lift, 0);
  assert.equal(commands.length, coveringCommands, 'initial and MQTT positions must not send covering commands');
  await invoke(movingCover.UUID, 'windowCovering', 'goToLiftPercentage', { liftPercent100thsValue: 2500 });
  await new Promise(resolve => setImmediate(resolve));
  await platform.matterBridge.queue;
  await drain();
  assert.equal(server.getAccessoryState(movingCover.UUID, 'windowCovering').targetPositionLiftPercent100ths, 2500);
  assert.equal(server.getAccessoryState(movingCover.UUID, 'windowCovering').currentPositionLiftPercent100ths, 9000,
    'a command acknowledgement must not replace the last physical position');
  assert.deepEqual(commands.at(-1), { id: 'cover-opening', body: { commands: [{ code: 'percent_control', value: 25 }] } });
  await platform.onMQTTMessage({ devId: 'cover-opening', status: [{ code: 'percent_state', value: 25 }] });
  assert.equal(server.getAccessoryState(movingCover.UUID, 'windowCovering').currentPositionLiftPercent100ths, 2500);
  assert.equal(server.getAccessoryState(movingCover.UUID, 'windowCovering').operationalStatus.lift, 0);
  assert.equal(commands.length, coveringCommands + 1, 'covering readback must not echo another cloud command');
  await drain();
  for (const item of coveringCases) await platform.onMQTTMessage({ devId: item.id, bizCode: 'delete' });
  await drain();
  assert.equal(server.getAccessories().length, 8);
  assert.deepEqual(errors, []);
  assert.deepEqual(nativeFailures, []);

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

  await platform.addAccessory({ id: 'cover-restored-moving', name: 'Cached moving covering', category: 'cl', status: [
    { code: 'percent_control', value: 70 }, { code: 'percent_state', value: 40 },
  ] });
  const movingCoverUUID = endpoint('cover-restored-moving').UUID;
  const outletUUID = endpoint('outlet').UUID;
  const pairingCode = server.getCommissioningInfo().manualPairingCode;
  await platform.onMQTTMessage({ devId: 'cover', status: [
    { code: 'percent_control', value: 30 }, { code: 'percent_state', value: 30 },
  ] });
  // Simulate the old mapper persisting HAP's mandatory DECREASING default even
  // when the covering has reached its target. Equal positions do not trigger a
  // native change reactor when this state is restored after a real restart.
  await api.matter.updateAccessoryState(covering.UUID, 'windowCovering', {
    operationalStatus: { global: 2, lift: 2, tilt: 0 },
  });
  await drain();
  assert.equal(server.getAccessoryState(covering.UUID, 'windowCovering').operationalStatus.lift, 2);
  await platform.matterBridge.close();
  await drain();
  // Flush the real native cache explicitly: this test builds the server without
  // advertising it, so the runtime's normal online-shutdown flush does not run.
  await server.accessoryCache.save(server.accessories);
  await server.stop();
  server = new MatterServer(serverConfig);
  api._matterServer = server;
  await server.start();
  assert.equal(server.getAccessories().length, 7);
  assert.equal(server.getCommissioningInfo().manualPairingCode, pairingCode);
  assert.equal(server.getAccessoryState(covering.UUID, 'windowCovering').operationalStatus.lift, 2,
    'the legacy incorrect movement must actually survive the persisted restart');
  const restored = createPlatform(api);
  restoredPlatform = restored.platform;
  for (const cached of server.getAccessories()) restored.platform.configureMatterAccessory(cached);
  await restored.platform.addAccessory({ id: 'cover', name: 'Restored covering', category: 'cl', status: [
    { code: 'percent_control', value: 30 }, { code: 'percent_state', value: 30 },
  ] });
  assert.equal(endpoint('cover').UUID, covering.UUID, 'covering cache restoration retains the endpoint identity');
  let restoredCover = server.getAccessoryState(covering.UUID, 'windowCovering');
  assert.equal(restoredCover.targetPositionLiftPercent100ths, 3000);
  assert.equal(restoredCover.currentPositionLiftPercent100ths, 3000);
  assert.equal(restoredCover.operationalStatus.lift ?? 0, 0,
    'a legacy moving cache must be normalized once when physical positions are equal');
  assert.equal(restoredCover.operationalStatus.global ?? 0, 0);
  assert.equal(server.getCommissioningInfo().manualPairingCode, pairingCode);
  // A fresh physical observation after restoration must still use the native
  // movement reactor, including a target that differs from current position.
  await restored.platform.onMQTTMessage({ devId: 'cover', status: [
    { code: 'percent_control', value: 20 }, { code: 'percent_state', value: 80 },
  ] });
  restoredCover = server.getAccessoryState(covering.UUID, 'windowCovering');
  assert.equal(restoredCover.targetPositionLiftPercent100ths, 2000);
  assert.equal(restoredCover.currentPositionLiftPercent100ths, 8000);
  assert.equal(restoredCover.operationalStatus.lift, 1);
  assert.equal(restored.commands.length, 0, 'restoring stale covering state must not operate the motor');
  await restored.platform.addAccessory({ id: 'cover-restored-moving', name: 'Restored moving covering', category: 'cl', status: [
    { code: 'percent_control', value: 20 }, { code: 'percent_state', value: 80 },
  ] });
  assert.equal(endpoint('cover-restored-moving').UUID, movingCoverUUID);
  const restoredMoving = server.getAccessoryState(movingCoverUUID, 'windowCovering');
  assert.equal(restoredMoving.targetPositionLiftPercent100ths, 2000);
  assert.equal(restoredMoving.currentPositionLiftPercent100ths, 8000);
  assert.equal(restoredMoving.operationalStatus.lift, 1);
  assert.equal(restored.commands.length, 0, 'restoring unequal positions must not operate the motor');
  assert.equal(server.getCommissioningInfo().manualPairingCode, pairingCode);
  await drain();
  await restored.platform.onMQTTMessage({ devId: 'cover', bizCode: 'delete' });
  await restored.platform.onMQTTMessage({ devId: 'cover-restored-moving', bizCode: 'delete' });
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
