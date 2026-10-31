const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const path = require('node:path');
const test = require('node:test');
const MatterBridge = require('../lib/matter_bridge');

class Characteristic extends EventEmitter {
  constructor(value, readValue = value) {
    super();
    this.UUID = 'power';
    this.value = value;
    this.readValue = readValue;
    this.props = { perms: ['pr', 'pw', 'ev'] };
  }

  getValue(callback) {
    callback(null, this.readValue);
  }

  setValue(value, callback) {
    if (this.error) return callback(this.error);
    this.value = value;
    this.emit('change', { newValue: value });
    if (this.finishSet) this.finishSet(callback);
    else callback();
  }
}

function factory(api, accessory, service) {
  if (service.UUID !== 'switch') return;
  const characteristic = service.characteristics[0];
  const write = value => new Promise((resolve, reject) => {
    characteristic.setValue(value, error => error ? reject(error) : resolve());
  });
  return {
    deviceType: api.matter.deviceTypes.OnOffSwitch,
    getState: () => ({ onOff: { onOff: !!characteristic.value, globalSceneControl: true } }),
    handlers: { onOff: { on: () => write(true), off: () => write(false) } },
  };
}

function fixture() {
  const calls = { registered: [], updated: [], removed: [], errors: [] };
  const states = new Map();
  const power = new Characteristic(false);
  const service = { UUID: 'switch', displayName: 'Outlet 1', subtype: '1', characteristics: [power] };
  const accessory = { UUID: 'tuya-device', displayName: 'Power strip', context: { deviceId: 'device-1' }, services: [service] };
  const api = {
    hap: { Service: { AccessoryInformation: { UUID: 'info' } }, Characteristic: {} },
    isMatterEnabled: () => true,
    matter: {
      uuid: { generate: value => `matter:${value}` },
      deviceTypes: { OnOffSwitch: 'OnOffSwitch' },
      registerPlatformAccessories: async (plugin, platform, descriptors) => {
        calls.registered.push({ plugin, platform, descriptors });
        for (const descriptor of descriptors) states.set(descriptor.UUID, structuredClone(descriptor.clusters));
      },
      updateAccessoryState: async (uuid, cluster, attributes) => {
        calls.updated.push({ uuid, cluster, attributes });
        Object.assign(states.get(uuid)[cluster], attributes);
      },
      unregisterPlatformAccessories: async (plugin, platform, descriptors) => {
        calls.removed.push({ plugin, platform, descriptors });
        for (const descriptor of descriptors) states.delete(descriptor.UUID);
      },
      getAccessoryState: async (uuid, cluster) => states.get(uuid)?.[cluster],
    },
  };
  const bridge = new MatterBridge(api, { error: message => calls.errors.push(message) }, factory);
  return { api, bridge, calls, power, service, accessory, states };
}

async function flush(bridge) {
  await new Promise(resolve => setImmediate(resolve));
  await bridge.queue;
}

function presenceFixture() {
  const context = fixture();
  const { bridge, power, accessory, service } = context;
  let valid = true;
  service.UUID = 'presence';
  context.api.hap.Service.OccupancySensor = { UUID: service.UUID };
  power.value = power.readValue = 1;
  const features = { other: true, passiveInfrared: false, occupancyEvent: true };
  const info = { id: 'bridgedDeviceBasicInformation', set: defaults => ({ id: 'bridgedDeviceBasicInformation', defaults }) };
  context.api.matter.deviceTypes.BridgedNode = { behaviors: { bridgedDeviceBasicInformation: info } };
  const type = { name: 'PresenceSensor', with: behavior => ({ name: 'PresenceSensor', composed: behavior }) };
  const register = context.api.matter.registerPlatformAccessories;
  context.api.matter.registerPlatformAccessories = async (...args) => {
    await register(...args);
    for (const descriptor of args[2]) {
      context.states.get(descriptor.UUID).occupancySensing.featureMap = { ...features };
    }
  };
  bridge.deviceFactory = () => ({
    deviceType: type,
    occupancySensingFeatures: features,
    getState: () => valid ? { occupancySensing: {
      occupancy: { occupied: power.value === 1 }, occupancySensorType: 0,
      occupancySensorTypeBitmap: { pir: false, ultrasonic: false, physicalContact: false },
    } } : {},
    handlers: {},
  });
  return { ...context, features, setValid: value => { valid = value; }, uuid: bridge.uuid(accessory, service) };
}

test('unknown presence keeps its expected identity without registering a default vacant state', async () => {
  const { bridge, calls, power, accessory, states, setValid, uuid } = presenceFixture();
  setValid(false);
  let reads = 0;
  const read = power.getValue;
  power.getValue = callback => { reads++; read.call(power, callback); };
  await bridge.reconcileAccessories([accessory]);
  assert.equal(reads, 0, 'an unknown source must not invoke a getter that cannot return physical state');
  assert.equal(calls.registered.length, 0);
  setValid(true);
  await bridge.addAccessory(accessory);
  assert.equal(states.get(uuid).occupancySensing.occupancy.occupied, true);
  setValid(false);
  power.value = 0; // Even a stale/default HAP value must not replace native truth.
  power.emit('change');
  await flush(bridge);
  await bridge.reconcileAccessories([accessory]);
  assert.equal(states.get(uuid).occupancySensing.occupancy.occupied, true);
  assert.equal(calls.removed.length, 0);
  assert.equal(calls.registered.length, 1);
  setValid(true);
  power.emit('change');
  await flush(bridge);
  assert.equal(states.get(uuid).occupancySensing.occupancy.occupied, false);
  assert.deepEqual(calls.errors, []);
  await bridge.close();
});

test('waits for the corrected presence features during an atomic native cached replacement', async () => {
  const { api, bridge, calls, accessory, service, states, setValid, features, uuid } = presenceFixture();
  const cached = { UUID: uuid, context: { homebridgeUUID: accessory.UUID }, clusters: { occupancySensing: {} } };
  bridge.configureAccessory(cached);
  states.set(uuid, { occupancySensing: {
    featureMap: { passiveInfrared: true, occupancyEvent: true }, occupancy: { occupied: false },
  }, bridgedDeviceBasicInformation: { uniqueId: 'native-presence-identity' } });
  setValid(false);
  accessory.controller = { service, serviceDetached: true };
  accessory.services = [];
  await bridge.reconcileAccessories([accessory]);
  assert.equal(calls.removed.length, 0, 'unknown source must retain a cached endpoint until valid data arrives');
  assert.equal(calls.registered.length, 0);
  api.matter.registerPlatformAccessories = async (plugin, platform, descriptors) => {
    calls.registered.push({ plugin, platform, descriptors });
    assert.equal(descriptors[0].deviceType.composed.id, 'bridgedDeviceBasicInformation');
    assert.deepEqual(descriptors[0].deviceType.composed.defaults, { uniqueId: 'native-presence-identity' },
      'the observed native identity must be supplied before the replacement is constructed');
    // Native registration must finish closing the old endpoint and compose
    // the corrected features; the public facade returns before this happens.
    setTimeout(() => states.set(uuid, { occupancySensing: {
      ...structuredClone(descriptors[0].clusters.occupancySensing), featureMap: { ...features },
    } }), 25);
  };
  const update = api.matter.updateAccessoryState;
  api.matter.updateAccessoryState = async (...args) => {
    assert.equal(states.get(uuid).occupancySensing.featureMap.other, true,
      'source synchronization must not race the old PIR endpoint during replacement');
    return update(...args);
  };
  setValid(true);
  accessory.controller.serviceDetached = false;
  accessory.services = [service];
  await bridge.addAccessory(accessory);
  assert.equal(calls.removed.length, 0, 'replacement must use one native registration, not two fire-and-forget lifecycle calls');
  assert.equal(calls.registered[0].descriptors[0].UUID, uuid);
  assert.equal(states.get(uuid).occupancySensing.occupancy.occupied, true);
  await bridge.addAccessory(accessory);
  assert.equal(calls.removed.length, 0, 'normal observations must never rebuild a live endpoint');
  assert.equal(calls.registered.length, 1);
  assert.deepEqual(calls.errors, []);
  await bridge.close();
});

test('does not rebuild matching presence features or infer a mismatch from unavailable native state', async () => {
  for (const map of [{ other: true, occupancyEvent: true }, undefined]) {
    const { bridge, calls, accessory, states, uuid } = presenceFixture();
    bridge.configureAccessory({ UUID: uuid, context: { homebridgeUUID: accessory.UUID } });
    states.set(uuid, { occupancySensing: { featureMap: map } });
    await bridge.addAccessory(accessory);
    assert.equal(calls.removed.length, 0);
    assert.equal(calls.registered.length, 1);
    assert.deepEqual(calls.errors, []);
    await bridge.close();
  }
});

test('leaves Homebridge 1 and Matter-disabled bridges operational', async () => {
  const first = new MatterBridge({}, { error: assert.fail }, () => assert.fail('unexpected mapping'));
  await first.addAccessory({});
  await first.reconcileAccessories([{}]);
  await first.removeAccessory({});
  await first.close();
  const { api, calls, accessory } = fixture();
  api.isMatterEnabled = () => false;
  const disabled = new MatterBridge(api, { error: assert.fail }, factory);
  await disabled.addAccessory(accessory);
  assert.equal(calls.registered.length, 0);
});

test('reads cached physical state before registration and refreshes restored native state', async () => {
  const { bridge, calls, power, accessory } = fixture();
  power.readValue = true;
  bridge.configureAccessory({ UUID: 'matter:tuya-device:switch:1', context: { homebridgeUUID: accessory.UUID } });
  await bridge.addAccessory(accessory);
  const registration = calls.registered[0];
  const descriptor = registration.descriptors[0];
  assert.equal(registration.plugin, '@linanw/homebridge-tuya-platform');
  assert.equal(registration.platform, 'TuyaPlatform');
  assert.equal(descriptor.UUID, 'matter:tuya-device:switch:1');
  assert.equal(descriptor.context.homebridgeUUID, accessory.UUID);
  assert.equal(descriptor.context.deviceId, 'device-1');
  assert.equal(descriptor.clusters.onOff.onOff, true);
  assert.deepEqual(calls.updated[0].attributes, { onOff: true, globalSceneControl: true });
  assert.equal(bridge.cachedAccessories.size, 0);
  assert.equal(power.listenerCount('change'), 1);
  await bridge.close();
});

test('deduplicates discovery and sends only changed cluster attributes', async () => {
  const { bridge, calls, power, accessory } = fixture();
  await bridge.addAccessory(accessory);
  await bridge.addAccessory(accessory);
  assert.equal(calls.registered.length, 1);
  assert.equal(power.listenerCount('change'), 1);
  power.value = true;
  power.emit('change', { newValue: true });
  await flush(bridge);
  assert.deepEqual(calls.updated[1].attributes, { onOff: true });
  power.emit('change', { newValue: true });
  await flush(bridge);
  assert.equal(calls.updated.length, 2);
  await bridge.close();
});

test('metadata renames update the live label and cache in place and export only actual Matter unique IDs', async () => {
  const { api, bridge, calls, accessory, service, states } = fixture();
  const cached = [];
  api.matter.updatePlatformAccessories = async descriptors => cached.push(...descriptors);
  await bridge.addAccessory(accessory);
  const uuid = calls.registered[0].descriptors[0].UUID;
  states.get(uuid).bridgedDeviceBasicInformation = { uniqueId: 'actual-native-unique-id', nodeLabel: service.displayName };
  assert.deepEqual(await bridge.getMetadataBindings(accessory.UUID), ['actual-native-unique-id']);
  await bridge.updateAccessoryMetadata(accessory, '灯'.repeat(30));
  const label = states.get(uuid).bridgedDeviceBasicInformation.nodeLabel;
  assert.equal(label, '灯'.repeat(10));
  assert.equal(cached[0].displayName, label);
  assert.equal(cached[0].UUID, uuid);
  assert.equal(service.displayName, 'Outlet 1');
  assert.equal(calls.registered.length, 1);
  assert.equal(calls.removed.length, 0);
  assert.equal(states.get(uuid).bridgedDeviceBasicInformation.uniqueId, 'actual-native-unique-id');
  await bridge.updateAccessoryMetadata(accessory, '灯'.repeat(30));
  assert.equal(cached.length, 2, 'source observations republish metadata for a cache that may still be initializing');
  assert.equal(calls.updated.filter(call => call.cluster === 'bridgedDeviceBasicInformation').length, 1,
    'an unchanged label must not repeat the live Matter transaction');
  await bridge.close();
});

test('replaces generic HAP metadata and bounds Matter identity fields', async () => {
  const { api, bridge, calls, accessory } = fixture();
  api.hap.Characteristic = {
    Manufacturer: { UUID: 'manufacturer' }, Model: { UUID: 'model' }, SerialNumber: { UUID: 'serial' },
  };
  accessory.UUID = '12345678-abcd-ef01-2345-6789abcdef01';
  accessory.controller = { deviceConfig: { product_name: 'Tuya product '.repeat(5), category: 'kg' } };
  accessory.services.push({
    UUID: 'info',
    characteristics: [
      { UUID: 'manufacturer', value: 'Default-Manufacturer' },
      { UUID: 'model', value: 'Default-Model' },
      { UUID: 'serial', value: 'Default-SerialNumber' },
    ],
  });
  await bridge.addAccessory(accessory);
  const descriptor = calls.registered[0].descriptors[0];
  assert.equal(descriptor.manufacturer, 'Tuya');
  assert.equal(descriptor.model, accessory.controller.deviceConfig.product_name.slice(0, 32));
  assert.equal(descriptor.serialNumber, '12345678abcdef0123456789abcdef01');
  assert.equal(descriptor.serialNumber.length, 32);
  await bridge.close();
});

test('preserves physical command errors and leaves command-driven state to the native behavior', async () => {
  const { bridge, calls, power, accessory, states } = fixture();
  await bridge.addAccessory(accessory);
  const handler = calls.registered[0].descriptors[0].handlers.onOff.on;
  power.error = new Error('Device offline');
  await assert.rejects(handler(), /Device offline/);
  await flush(bridge);
  assert.equal(calls.updated.length, 1);
  power.error = undefined;
  let complete;
  power.finishSet = callback => { complete = callback; };
  const command = handler();
  await flush(bridge);
  assert.equal(calls.updated.length, 1, 'must not update Matter while its command handler is active');
  complete();
  await command;
  const uuid = calls.registered[0].descriptors[0].UUID;
  // Native Homebridge updates the cluster after the plugin handler returns.
  states.get(uuid).onOff.onOff = true;
  await flush(bridge);
  assert.equal(calls.updated.length, 1, 'a native command must not trigger a second state transaction');
  power.value = false;
  power.emit('change');
  await flush(bridge);
  assert.deepEqual(calls.updated[1].attributes, { onOff: false },
    'an external return to the previously cached value must still reflect the current native state');
  await bridge.close();
});

test('reports registration/update failures without rejecting HomeKit lifecycle operations', async () => {
  const { api, bridge, calls, power, accessory } = fixture();
  const register = api.matter.registerPlatformAccessories;
  api.matter.registerPlatformAccessories = async () => { throw new Error('Matter registration failed'); };
  await bridge.addAccessory(accessory);
  assert.match(calls.errors[0], /Matter registration failed/);
  assert.equal(power.listenerCount('change'), 0);
  api.matter.registerPlatformAccessories = register;
  await bridge.addAccessory(accessory);
  const update = api.matter.updateAccessoryState;
  api.matter.updateAccessoryState = async () => { throw new Error('Matter update failed'); };
  power.value = true;
  power.emit('change');
  await flush(bridge);
  assert.match(calls.errors.at(-1), /Matter update failed/);
  api.matter.updateAccessoryState = update;
  power.emit('change');
  await flush(bridge);
  assert.deepEqual(calls.updated.at(-1).attributes, { onOff: true });
  await bridge.close();
});

test('serializes registration/removal and stops updates after removal', async () => {
  const { api, bridge, calls, power, accessory } = fixture();
  const register = api.matter.registerPlatformAccessories;
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  api.matter.registerPlatformAccessories = async (...args) => {
    await gate;
    return register(...args);
  };
  const added = bridge.addAccessory(accessory);
  const removed = bridge.removeAccessory(accessory);
  release();
  await Promise.all([added, removed]);
  assert.equal(calls.registered.length, 1);
  assert.equal(calls.removed.length, 1);
  assert.equal(power.listenerCount('change'), 0);
  const updates = calls.updated.length;
  power.emit('change');
  await flush(bridge);
  assert.equal(calls.updated.length, updates);
  await bridge.close();
});

test('waits for fire-and-forget native registration, commits, and removal before rebinding', async () => {
  const { api, bridge, calls, power, service, accessory, states } = fixture();
  const events = [];
  const failures = [];
  let activeWrites = 0;
  let maxWrites = 0;
  api.matter.registerPlatformAccessories = async (plugin, platform, descriptors) => {
    events.push('register requested');
    calls.registered.push({ plugin, platform, descriptors });
    setTimeout(() => {
      for (const descriptor of descriptors) {
        if (states.has(descriptor.UUID)) failures.push('registered before previous removal committed');
        states.set(descriptor.UUID, { onOff: { onOff: false, globalSceneControl: false } });
      }
      events.push('registration committed');
    }, 25);
  };
  api.matter.updateAccessoryState = async (uuid, cluster, attributes) => {
    if (!states.has(uuid)) {
      failures.push('updated before registration committed');
      return;
    }
    activeWrites++;
    maxWrites = Math.max(maxWrites, activeWrites);
    calls.updated.push({ uuid, cluster, attributes });
    setTimeout(() => {
      Object.assign(states.get(uuid)[cluster], attributes);
      activeWrites--;
    }, 25);
  };
  api.matter.unregisterPlatformAccessories = async (plugin, platform, descriptors) => {
    calls.removed.push({ plugin, platform, descriptors });
    setTimeout(() => {
      for (const descriptor of descriptors) states.delete(descriptor.UUID);
      events.push('removal committed');
    }, 25);
  };
  power.readValue = true;
  await bridge.addAccessory(accessory);
  const uuid = calls.registered[0].descriptors[0].UUID;
  assert.equal(states.get(uuid).onOff.onOff, true);
  power.value = false;
  power.emit('change');
  await new Promise(resolve => setImmediate(resolve));
  power.value = true;
  power.emit('change');
  await flush(bridge);
  assert.equal(states.get(uuid).onOff.onOff, true);
  assert.equal(maxWrites, 1, 'native writes must finish before the next queued write');
  accessory.services[0] = { ...service, characteristics: [new Characteristic(true)] };
  await bridge.addAccessory(accessory);
  assert.deepEqual(failures, []);
  assert.ok(events.indexOf('removal committed') < events.lastIndexOf('register requested'));
  await bridge.removeAccessory(accessory);
  assert.equal(states.has(uuid), false);
  await bridge.close();
});

test('suppresses only fan callbacks caused by state mirroring while allowing concurrent controller commands', async () => {
  const { api, bridge, calls, power, accessory, states } = fixture();
  let physicalWrites = 0;
  power.readValue = 0;
  let holdCommit = false;
  let started;
  let release;
  bridge.deviceFactory = () => ({
    deviceType: 'Fan',
    getState: () => ({ fanControl: { fanMode: power.value } }),
    handlers: { fanControl: { fanModeChange: async request => {
      physicalWrites++;
      power.value = request.fanMode;
      power.emit('change');
    } } },
  });
  api.matter.updateAccessoryState = async (uuid, cluster, attributes) => {
    calls.updated.push({ uuid, cluster, attributes });
    setImmediate(async () => {
      const descriptor = calls.registered[0].descriptors[0];
      await descriptor.handlers.fanControl.fanModeChange({ fanMode: attributes.fanMode });
      if (holdCommit) {
        started();
        await new Promise(resolve => { release = resolve; });
      }
      Object.assign(states.get(uuid)[cluster], attributes);
    });
  };
  await bridge.addAccessory(accessory);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(physicalWrites, 0);
  holdCommit = true;
  const mirrorStarted = new Promise(resolve => { started = resolve; });
  power.value = 1;
  power.emit('change');
  await mirrorStarted;
  const handler = calls.registered[0].descriptors[0].handlers.fanControl.fanModeChange;
  await handler({ fanMode: 2 });
  assert.equal(physicalWrites, 1, 'an independent controller command must reach the physical driver');
  holdCommit = false;
  release();
  await flush(bridge);
  assert.equal(physicalWrites, 1, 'mirror-generated callbacks must not produce additional physical writes');
  const uuid = calls.registered[0].descriptors[0].UUID;
  assert.equal(states.get(uuid).fanControl.fanMode, 2);
  await bridge.close();
});

test('reconciles physical fan attributes after a native setting change without cloud feedback', async () => {
  const { api, bridge, calls, power, accessory, states } = fixture();
  let physicalWrites = 0;
  power.readValue = 100;
  bridge.deviceFactory = () => ({
    deviceType: 'Fan',
    getState: () => ({ fanControl: {
      fanMode: power.value <= 33 ? 1 : power.value <= 66 ? 2 : 3,
      percentSetting: power.value, percentCurrent: power.value,
    } }),
    handlers: { fanControl: {
      fanModeChange: async () => { physicalWrites++; },
      percentSettingChange: async request => {
        physicalWrites++;
        power.value = request.percentSetting;
        power.emit('change');
      },
    } },
  });
  const update = api.matter.updateAccessoryState;
  api.matter.updateAccessoryState = async (uuid, cluster, attributes) => {
    await update(uuid, cluster, attributes);
    const handlers = calls.registered[0].descriptors[0].handlers.fanControl;
    if (Object.hasOwn(attributes, 'fanMode')) await handlers.fanModeChange({ fanMode: attributes.fanMode });
    if (Object.hasOwn(attributes, 'percentSetting')) await handlers.percentSettingChange({ percentSetting: attributes.percentSetting });
  };
  await bridge.addAccessory(accessory);
  const descriptor = calls.registered[0].descriptors[0];
  const native = states.get(descriptor.UUID).fanControl;
  assert.equal(native.percentCurrent, 100);
  assert.equal(physicalWrites, 0);
  // Native FanControl applies the requested setting before its plugin callback,
  // but does not automatically replace the last reported physical speed/mode.
  native.percentSetting = 33;
  await descriptor.handlers.fanControl.percentSettingChange({ percentSetting: 33 });
  await flush(bridge);
  assert.equal(native.percentSetting, 33);
  assert.equal(native.percentCurrent, 33);
  assert.equal(native.fanMode, 1);
  assert.deepEqual(calls.updated.at(-1).attributes, { fanMode: 1, percentCurrent: 33 });
  assert.equal(physicalWrites, 1, 'reflecting physical attributes must not issue another cloud command');
  await bridge.close();
});

test('queued source synchronization waits for active commands and retains independent source observations', async () => {
  const { bridge, calls, power, accessory, states } = fixture();
  await bridge.addAccessory(accessory);
  const descriptor = calls.registered[0].descriptors[0];
  let releaseQueue;
  bridge.enqueue(() => new Promise(resolve => { releaseQueue = resolve; }));
  await Promise.resolve();
  power.value = true;
  power.emit('change');
  await new Promise(resolve => setImmediate(resolve));
  let finishCommand;
  power.finishSet = callback => { finishCommand = callback; };
  const command = descriptor.handlers.onOff.on();
  // This observation has an independent origin while the native command's
  // driver request is outstanding; it must survive the suppressed command echo.
  power.value = false;
  power.emit('change');
  releaseQueue();
  await bridge.queue;
  assert.equal(calls.updated.length, 1, 'a queued mirror must not run while a command handler is active');
  finishCommand();
  await command;
  states.get(descriptor.UUID).onOff.onOff = true;
  await flush(bridge);
  assert.deepEqual(calls.updated.at(-1).attributes, { onOff: false });
  assert.equal(states.get(descriptor.UUID).onOff.onOff, false);
  await bridge.close();
});

test('reconciles cached disabled endpoints and keeps channel identities distinct', async () => {
  const { bridge, calls, accessory, service } = fixture();
  bridge.configureAccessory({ UUID: 'stale', context: { homebridgeUUID: 'removed-device' } });
  accessory.services.push({ ...service, subtype: '2', characteristics: [new Characteristic(true)] });
  await bridge.reconcileAccessories([accessory]);
  assert.equal(calls.registered.length, 2);
  assert.notEqual(calls.registered[0].descriptors[0].UUID, calls.registered[1].descriptors[0].UUID);
  assert.equal(calls.removed[0].descriptors[0].UUID, 'stale');
  await bridge.reconcileAccessories([]);
  assert.equal(calls.removed.length, 3);
  assert.equal(bridge.accessories.size, 0);
  await bridge.close();
});

test('shutdown detaches subscriptions while preserving native pairing cache', async () => {
  const { bridge, calls, power, accessory } = fixture();
  await bridge.addAccessory(accessory);
  power.emit('change');
  await bridge.close();
  assert.equal(power.listenerCount('change'), 0);
  assert.equal(calls.removed.length, 0);
  await bridge.addAccessory(accessory);
  assert.equal(calls.registered.length, 1);
});

test('seeds initial values through the real Homebridge 2 HAP get handler', async () => {
  const { HomebridgeAPI } = require(path.join(path.dirname(require.resolve('homebridge')), 'api.js'));
  const homebridge = new HomebridgeAPI();
  const { api, bridge, calls } = fixture();
  api.hap = homebridge.hap;
  const accessory = new homebridge.platformAccessory('Tuya switch', homebridge.hap.uuid.generate('real-tuya-switch'));
  const service = accessory.addService(homebridge.hap.Service.Switch, 'Tuya switch');
  const on = service.getCharacteristic(homebridge.hap.Characteristic.On);
  on.on('get', callback => callback(null, true));
  bridge.deviceFactory = (unused, hapAccessory, hapService) => {
    if (hapService !== service) return;
    return {
      deviceType: 'OnOffSwitch',
      getState: () => ({ onOff: { onOff: on.value } }),
      handlers: {},
    };
  };
  await bridge.addAccessory(accessory);
  assert.equal(calls.errors.length, 0);
  assert.equal(calls.registered[0].descriptors[0].clusters.onOff.onOff, true);
  await bridge.close();
});
