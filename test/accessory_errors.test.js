const assert = require('node:assert/strict');
const path = require('node:path');
const test = require('node:test');
const util = require('node:util');
const { HomebridgeAPI } = require(path.join(path.dirname(require.resolve('homebridge')), 'api.js'));

async function promptly(operation) {
  let timer;
  try {
    return await Promise.race([
      operation,
      new Promise((resolve, reject) => {
        timer = setTimeout(() => reject(new Error('Characteristic callback did not complete')), 250);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

const cases = [
  {
    driver: 'switch_accessory', characteristic: 'On', initial: 0, recovered: 1,
    status: [{ code: 'switch', value: false }], update: [{ code: 'switch', value: true }],
    subTypes: ['switch'], write: ['On', true], command: { code: 'switch', value: true },
  },
  {
    driver: 'outlet_accessory', characteristic: 'On', service: 'switch_1', initial: 0, recovered: 1,
    status: [{ code: 'switch_1', value: false }, { code: 'switch_2', value: true }],
    update: [{ code: 'switch_1', value: true }, { code: 'switch_2', value: false }],
    subTypes: ['switch_1', 'switch_2'], write: ['On', true], command: { code: 'switch_1', value: true },
  },
  {
    driver: 'light_accessory', characteristic: 'On', initial: 0, recovered: 1,
    status: [{ code: 'switch_led', value: false }], update: [{ code: 'switch_led', value: true }],
    write: ['On', true], command: { code: 'switch_led', value: true },
  },
  {
    driver: 'fanv2_accessory', characteristic: 'Active', initial: 1, recovered: 0,
    status: [{ code: 'switch', value: true }], update: [{ code: 'switch', value: false }],
    write: ['Active', 0], command: { code: 'switch', value: false },
  },
  {
    driver: 'heater_accessory', characteristic: 'Active', initial: 1, recovered: 0,
    status: [{ code: 'switch', value: true }], update: [{ code: 'switch', value: false }],
    write: ['Active', 0], command: { code: 'switch', value: false },
  },
  {
    driver: 'air_purifier_accessory', characteristic: 'CurrentAirPurifierState', initial: 2, recovered: 0,
    status: [{ code: 'switch', value: true }], update: [{ code: 'switch', value: false }],
    write: ['Active', 0], command: { code: 'switch', value: false },
  },
  {
    driver: 'garagedoor_accessory', characteristic: 'TargetDoorState', initial: 1, recovered: 0,
    status: [{ code: 'switch_1', value: false }], update: [{ code: 'switch_1', value: true }],
    write: ['TargetDoorState', 0], command: { code: 'switch_1', value: true },
  },
  {
    driver: 'window_covering_accessory', characteristic: 'TargetPosition', initial: 25, recovered: 75,
    status: [{ code: 'situation_set', value: 'fully_open' }, { code: 'percent_control', value: 25 }],
    update: [{ code: 'percent_control', value: 75 }],
    write: ['TargetPosition', 50], command: { code: 'percent_control', value: 50 },
  },
  {
    driver: 'door_accessory', characteristic: 'TargetPosition', initial: 25, recovered: 75,
    status: [{ code: 'percent_state', value: 25 }], update: [{ code: 'percent_state', value: 75 }],
    write: ['TargetPosition', 50], command: { code: 'percent_control', value: 50 },
  },
  {
    driver: 'contactsensor_accessory', characteristic: 'ContactSensorState', initial: 0, recovered: 1,
    status: [{ code: 'doorcontact_state', value: false }], update: [{ code: 'doorcontact_state', value: true }],
  },
  {
    driver: 'smokesensor_accessory', characteristic: 'SmokeDetected', initial: 0, recovered: 1,
    status: [{ code: 'smoke_sensor_status', value: 'normal' }], update: [{ code: 'smoke_sensor_status', value: 'alarm' }],
  },
  {
    driver: 'leak_sensor_accessory', characteristic: 'LeakDetected', initial: 0, recovered: 1,
    status: [{ code: 'gas_sensor_status', value: 'normal' }], update: [{ code: 'gas_sensor_status', value: 'alarm' }],
  },
];

for (const scenario of cases) {
  test(`${scenario.driver} finishes cached reads, reports unavailable state, and recovers from MQTT updates`, async () => {
    const api = new HomebridgeAPI();
    const commands = [];
    const errors = [];
    const platform = {
      api,
      log: { log() {}, error(...values) { errors.push(util.format(...values)); } },
      registerPlatformAccessory() {},
      tuyaOpenApi: { async sendCommand(id, body) {
        commands.push({ id, body });
        throw new Error('Tuya command unavailable');
      } },
    };
    const Driver = require(`../lib/${scenario.driver}`);
    const device = { id: scenario.driver, name: 'Read recovery fixture', status: scenario.status, functions: [] };
    const driver = new Driver(platform, undefined, device, { subType: scenario.subTypes || [] });
    const service = scenario.service ? driver.homebridgeAccessory.getService(scenario.service) : driver.service;
    const characteristic = service.getCharacteristic(api.hap.Characteristic[scenario.characteristic]);
    assert.equal(Number(await promptly(characteristic.handleGetRequest())), scenario.initial);
    if (scenario.write) {
      const setter = service.getCharacteristic(api.hap.Characteristic[scenario.write[0]]);
      await assert.rejects(promptly(setter.handleSetRequest(scenario.write[1])));
      assert.deepEqual(commands, [{ id: device.id, body: { commands: [scenario.command] } }]);
      if (['switch_accessory', 'outlet_accessory', 'heater_accessory', 'air_purifier_accessory', 'garagedoor_accessory'].includes(scenario.driver)) {
        assert.ok(errors.some(message => message.includes(`Characteristic.${setter.displayName} Error`)),
          'failed setters must identify the actual HAP characteristic');
        assert.ok(errors.every(message => !message.includes('Characteristic.Brightness')),
          'an On, Active, or door-state failure must not be labeled as brightness');
      }
      await new Promise(resolve => setTimeout(resolve, 10));
      assert.equal(commands.length, 1, 'a rejected device command must not be automatically retried');
    } else {
      // Read-only sensor state may be invalidated after an upstream failure too.
      driver.invalidateCache();
    }
    assert.equal(driver.hasValidCache(), false);
    await assert.rejects(promptly(characteristic.handleGetRequest()),
      error => error === api.hap.HAPStatus.SERVICE_COMMUNICATION_FAILURE);
    driver.updateState({ status: scenario.update });
    assert.equal(Number(await promptly(characteristic.handleGetRequest())), scenario.recovered);
  });
}

test('a missing channel cache entry fails promptly even when another channel is valid', async () => {
  const api = new HomebridgeAPI();
  const Driver = require('../lib/outlet_accessory');
  const platform = { api, log: { log() {}, error() {} }, registerPlatformAccessory() {} };
  const device = { id: 'partially-cached-outlet', name: 'Power strip', status: [
    { code: 'switch_1', value: true }, { code: 'switch_2', value: false },
  ] };
  const driver = new Driver(platform, undefined, device, { subType: ['switch_1', 'switch_2'] });
  driver.cachedState.delete('switch_2');
  assert.equal(driver.hasValidCache(), true);
  const first = driver.homebridgeAccessory.getService('switch_1').getCharacteristic(api.hap.Characteristic.On);
  const second = driver.homebridgeAccessory.getService('switch_2').getCharacteristic(api.hap.Characteristic.On);
  assert.equal(await promptly(first.handleGetRequest()), true);
  await assert.rejects(promptly(second.handleGetRequest()),
    error => error === api.hap.HAPStatus.SERVICE_COMMUNICATION_FAILURE);
  driver.updateState({ status: [{ code: 'switch_2', value: false }] });
  assert.equal(await promptly(second.handleGetRequest()), false);
});
