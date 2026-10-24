const test = require('node:test');
const assert = require('node:assert/strict');
const { createMatterDevice } = require('../lib/matter_devices');

const serviceNames = ['Lightbulb', 'Switch', 'Outlet', 'ContactSensor', 'LeakSensor', 'SmokeSensor', 'Fanv2', 'WindowCovering', 'HeaterCooler', 'AirPurifier', 'GarageDoorOpener', 'StatelessProgrammableSwitch'];
const characteristicNames = ['On', 'Brightness', 'Hue', 'Saturation', 'ColorTemperature', 'ContactSensorState', 'LeakDetected', 'SmokeDetected', 'StatusLowBattery', 'BatteryLevel', 'Active', 'TargetFanState', 'RotationSpeed', 'TargetPosition', 'CurrentPosition', 'PositionState', 'HoldPosition'];
const deviceTypeNames = ['OnOffLight', 'DimmableLight', 'ColorTemperatureLight', 'ExtendedColorLight', 'OnOffSwitch', 'OnOffOutlet', 'ContactSensor', 'LeakSensor', 'SmokeSensor', 'Fan', 'WindowCovering'];

function fixture(type, values, accessory = {}) {
  const writes = [];
  const api = {
    hap: {
      Service: Object.fromEntries(serviceNames.map(name => [name, { UUID: `service:${name}` }])),
      Characteristic: Object.fromEntries(characteristicNames.map(name => [name, { UUID: name }])),
    },
    matter: {
      deviceTypes: Object.fromEntries(deviceTypeNames.map(name => [name, { name }])),
      status: { ConstraintError: class ConstraintError extends Error {}, InvalidAction: class InvalidAction extends Error {} },
    },
  };
  const characteristics = new Map(Object.entries(values).map(([name, value]) => [name, {
    value,
    props: {},
    error: null,
    listenerCount(event) { return event === 'set' ? 1 : 0; },
    setValue(next, callback) {
      writes.push([name, next]);
      queueMicrotask(() => {
        if (!this.error) this.value = next;
        callback(this.error);
      });
    },
  }]));
  const service = {
    UUID: api.hap.Service[type].UUID,
    testCharacteristic(characteristic) { return characteristics.has(characteristic.UUID); },
    getCharacteristic(characteristic) {
      assert.ok(characteristics.has(characteristic.UUID), `must not create missing ${characteristic.UUID}`);
      return characteristics.get(characteristic.UUID);
    },
  };
  return { api, service, accessory, characteristics, writes, mapping: () => createMatterDevice(api, accessory, service) };
}

test('on/off controls reuse the HAP setter and reflect externally changed state', async () => {
  const context = fixture('Switch', { On: false });
  const mapping = context.mapping();
  assert.equal(mapping.deviceType, context.api.matter.deviceTypes.OnOffSwitch);
  assert.deepEqual(mapping.getState(), { onOff: { onOff: false } });
  await mapping.handlers.onOff.on();
  assert.deepEqual(context.writes, [['On', true]]);
  assert.equal(mapping.getState().onOff.onOff, true);
  await mapping.handlers.onOff.toggle();
  assert.equal(mapping.getState().onOff.onOff, false);
  context.characteristics.get('On').value = true;
  assert.equal(mapping.getState().onOff.onOff, true);
  await mapping.handlers.onOff.off();
  assert.equal(mapping.getState().onOff.onOff, false);
});

test('outlets remain distinct native Matter outlet devices', () => {
  const context = fixture('Outlet', { On: true });
  assert.equal(context.mapping().deviceType, context.api.matter.deviceTypes.OnOffOutlet);
});

test('physical command errors reject rather than reporting local-only success', async () => {
  const context = fixture('Switch', { On: false });
  const error = new Error('Tuya device offline');
  context.characteristics.get('On').error = error;
  await assert.rejects(context.mapping().handlers.onOff.on(), actual => actual === error);
  assert.equal(context.mapping().getState().onOff.onOff, false);
});

test('lighting capabilities are selected from existing HAP characteristics only', () => {
  for (const [values, expected] of [
    [{ On: false }, 'OnOffLight'],
    [{ On: true, Brightness: 50 }, 'DimmableLight'],
    [{ On: true, Brightness: 50, ColorTemperature: 250 }, 'ColorTemperatureLight'],
    [{ On: true, Brightness: 50, Hue: 180, Saturation: 50 }, 'ExtendedColorLight'],
  ]) {
    const context = fixture('Lightbulb', values);
    const mapping = context.mapping();
    assert.equal(mapping.deviceType.name, expected);
    assert.equal(context.characteristics.size, Object.keys(values).length);
    assert.equal('colorControl' in mapping.getState(), ['ColorTemperatureLight', 'ExtendedColorLight'].includes(expected));
  }
});

test('dimming converts Matter 1..254 levels and handles power only for with-on-off commands', async () => {
  const context = fixture('Lightbulb', { On: false, Brightness: 50 });
  const mapping = context.mapping();
  assert.equal(mapping.getState().levelControl.currentLevel, 127);
  assert.equal(mapping.getState().levelControl.minLevel, 1);
  await mapping.handlers.levelControl.moveToLevel({ level: 254 });
  assert.deepEqual(context.writes, [['Brightness', 100]]);
  assert.equal(context.characteristics.get('On').value, false);
  await mapping.handlers.levelControl.moveToLevelWithOnOff({ level: 127 });
  assert.deepEqual(context.writes.slice(-2), [['Brightness', 50], ['On', true]]);
  await mapping.handlers.levelControl.moveToLevelWithOnOff({ level: 0 });
  assert.deepEqual(context.writes.at(-1), ['On', false]);
  await assert.rejects(async () => mapping.handlers.levelControl.moveToLevel({ level: 255 }), /Level/);
  await assert.rejects(async () => mapping.handlers.levelControl.moveToLevel({ level: NaN }), /Level/);
});

test('zero brightness does not produce an invalid Matter currentLevel of zero', () => {
  const mapping = fixture('Lightbulb', { On: false, Brightness: 0 }).mapping();
  assert.equal(mapping.getState().levelControl.currentLevel, 1);
});

test('color temperatures stay in mireds and respect physical HAP limits', async () => {
  const context = fixture('Lightbulb', { On: true, Brightness: 75, ColorTemperature: 300 });
  context.characteristics.get('ColorTemperature').props = { minValue: 160, maxValue: 450 };
  const mapping = context.mapping();
  assert.equal(mapping.getState().colorControl.colorTemperatureMireds, 300);
  assert.equal(mapping.getState().colorControl.colorTempPhysicalMinMireds, 160);
  assert.equal(mapping.getState().colorControl.colorTempPhysicalMaxMireds, 450);
  await mapping.handlers.colorControl.moveToColorTemperatureLogic({ colorTemperatureMireds: 400 });
  assert.deepEqual(context.writes, [['ColorTemperature', 400]]);
  await assert.rejects(async () => mapping.handlers.colorControl.moveToColorTemperatureLogic({ colorTemperatureMireds: 500 }), /Color temperature/);
});

test('HS color commands write saturation before hue to send one complete Tuya color command', async () => {
  const context = fixture('Lightbulb', { On: true, Brightness: 50, Hue: 0, Saturation: 0 });
  const mapping = context.mapping();
  await mapping.handlers.colorControl.moveToHueAndSaturationLogic({ hue: 127, saturation: 127 });
  assert.deepEqual(context.writes, [['Saturation', 50], ['Hue', 180]]);
  assert.equal(mapping.getState().colorControl.currentHue, 127);
  assert.equal(mapping.getState().colorControl.currentSaturation, 127);
  assert.equal('colorTemperatureMireds' in mapping.getState().colorControl, false);
  await mapping.handlers.colorControl.moveToSaturationLogic({ targetSaturation: 254 });
  assert.deepEqual(context.writes.slice(-2), [['Saturation', 100], ['Hue', 180]]);
  await mapping.handlers.colorControl.moveToHueLogic({ targetHue: 65535, isEnhancedHue: true });
  assert.deepEqual(context.writes.slice(-2), [['Saturation', 100], ['Hue', 360]]);
});

test('CIE xy controllers control real HSV-backed lights', async () => {
  const context = fixture('Lightbulb', { On: true, Brightness: 100, Hue: 0, Saturation: 100 });
  const mapping = context.mapping();
  const red = mapping.getState().colorControl;
  assert.ok(Math.abs(red.currentX / 65535 - 0.64) < 0.002);
  assert.ok(Math.abs(red.currentY / 65535 - 0.33) < 0.002);
  await mapping.handlers.colorControl.moveToColorLogic({ targetX: red.currentX, targetY: red.currentY });
  assert.ok(context.characteristics.get('Hue').value < 1 || context.characteristics.get('Hue').value > 359);
  assert.ok(context.characteristics.get('Saturation').value > 99);
  assert.equal(mapping.getState().colorControl.colorMode, 1);
  await assert.rejects(async () => mapping.handlers.colorControl.moveToColorLogic({ targetX: 100, targetY: 0 }), /Invalid CIE/);
  await assert.rejects(async () => mapping.handlers.colorControl.moveToColorLogic({ targetX: 65000, targetY: 65000 }), /Invalid CIE/);
});

test('failed color writes restore the previous declared color mode', async () => {
  const context = fixture('Lightbulb', { On: true, Brightness: 80, Hue: 0, Saturation: 100, ColorTemperature: 300 });
  const mapping = context.mapping();
  context.characteristics.get('ColorTemperature').error = new Error('device offline');
  await assert.rejects(mapping.handlers.colorControl.moveToColorTemperatureLogic({ colorTemperatureMireds: 350 }), /device offline/);
  assert.equal(mapping.getState().colorControl.colorMode, 0);
});

test('initial physical white mode and MQTT mode-only updates select the correct Matter color mode', () => {
  const accessory = { controller: { workMode: { code: 'work_mode', value: 'white' } } };
  const context = fixture('Lightbulb', { On: true, Brightness: 75, Hue: 0, Saturation: 100, ColorTemperature: 300 }, accessory);
  const mapping = context.mapping();
  assert.equal(mapping.getState().colorControl.colorMode, 2);
  accessory.controller.workMode = { code: 'work_mode', value: 'colour' };
  assert.equal(mapping.getState().colorControl.colorMode, 0);
  accessory.controller.workMode = { code: 'work_mode', value: 'light_white' };
  assert.equal(mapping.getState().colorControl.colorMode, 2);
  accessory.controller.workMode = { code: 'work_mode', value: 'light_color' };
  assert.equal(mapping.getState().colorControl.colorMode, 0);
});

test('requested HS, XY, and color-temperature modes survive unchanged physical work-mode snapshots', async () => {
  const accessory = { controller: { workMode: { value: 'white' } } };
  const context = fixture('Lightbulb', { On: true, Brightness: 75, Hue: 0, Saturation: 100, ColorTemperature: 300 }, accessory);
  const mapping = context.mapping();
  await mapping.handlers.colorControl.moveToHueAndSaturationLogic({ hue: 0, saturation: 254 });
  assert.equal(mapping.getState().colorControl.colorMode, 0);
  const red = mapping.getState().colorControl;
  await mapping.handlers.colorControl.moveToColorLogic({ targetX: red.currentX, targetY: red.currentY });
  assert.equal(mapping.getState().colorControl.colorMode, 1);
  // A new status object carrying the same old value is not a new mode change.
  accessory.controller.workMode = { value: 'white' };
  assert.equal(mapping.getState().colorControl.colorMode, 1);
  accessory.controller.workMode = { value: 'colour' };
  assert.equal(mapping.getState().colorControl.colorMode, 0);
  await mapping.handlers.colorControl.moveToColorTemperatureLogic({ colorTemperatureMireds: 350 });
  assert.equal(mapping.getState().colorControl.colorMode, 2);
  accessory.controller.workMode = { value: 'colour' };
  assert.equal(mapping.getState().colorControl.colorMode, 2);
  accessory.controller.workMode = { value: 'white' };
  assert.equal(mapping.getState().colorControl.colorMode, 2);
});

test('physical mode data never invents missing light color capabilities', () => {
  const colorOnly = fixture('Lightbulb', { On: true, Brightness: 75, Hue: 0, Saturation: 100 }, { controller: { workMode: { value: 'white' } } }).mapping();
  assert.equal(colorOnly.getState().colorControl.colorMode, 0);
  const temperatureOnly = fixture('Lightbulb', { On: true, Brightness: 75, ColorTemperature: 300 }, { controller: { workMode: { value: 'colour' } } }).mapping();
  assert.equal(temperatureOnly.getState().colorControl.colorMode, 2);
});

test('native color-mode changes can stop Matter transitions without sending a fake physical command', async () => {
  for (const values of [
    { On: true, Brightness: 50, ColorTemperature: 300 },
    { On: true, Brightness: 50, Hue: 120, Saturation: 75 },
    { On: true, Brightness: 50, Hue: 120, Saturation: 75, ColorTemperature: 300 },
  ]) {
    const context = fixture('Lightbulb', values);
    const mapping = context.mapping();
    const before = mapping.getState();
    assert.equal(await mapping.handlers.colorControl.stopAllColorMovement(), undefined);
    assert.deepEqual(mapping.getState(), before);
    assert.deepEqual(context.writes, []);
  }
});

test('contact sensors invert HAP open/closed state for Matter BooleanState', () => {
  const context = fixture('ContactSensor', { ContactSensorState: 0 });
  const mapping = context.mapping();
  assert.equal(mapping.getState().booleanState.stateValue, true);
  context.characteristics.get('ContactSensorState').value = 1;
  assert.equal(mapping.getState().booleanState.stateValue, false);
  assert.deepEqual(mapping.handlers, {});
});

test('water leaks and smoke retain alarm semantics and do not invent CO detection', () => {
  const leak = fixture('LeakSensor', { LeakDetected: 1 }).mapping();
  assert.equal(leak.getState().booleanState.stateValue, true);
  const context = fixture('SmokeSensor', { SmokeDetected: 0, StatusLowBattery: 1 });
  const smoke = context.mapping();
  assert.equal(smoke.getState().smokeCoAlarm.smokeState, 0);
  assert.equal(smoke.getState().smokeCoAlarm.batteryAlert, 1);
  context.characteristics.get('SmokeDetected').value = 1;
  assert.equal(smoke.getState().smokeCoAlarm.smokeState, 2);
  assert.equal(smoke.getState().smokeCoAlarm.expressedState, 1);
  assert.equal('coState' in smoke.getState().smokeCoAlarm, false);
});

test('legacy combustible gas alarms are not exposed as water-leak sensors', () => {
  for (const deviceConfig of [
    { category: 'rqbj' },
    { category: 'jwbj' },
    { category: 'LeakSensor', status: [{ code: 'gas_sensor_state', value: '1' }] },
    { status: [{ code: 'gas_sensor_status', value: 'alarm' }] },
    { status: [{ code: 'ch4_sensor_state', value: 'alarm' }] },
  ]) {
    assert.equal(fixture('LeakSensor', { LeakDetected: 1 }, { controller: { deviceConfig } }).mapping(), undefined);
  }
});

test('battery clusters are included only when reported and use Matter half-percent units', () => {
  const context = fixture('ContactSensor', { ContactSensorState: 0, BatteryLevel: 75, StatusLowBattery: 0 });
  const mapping = context.mapping();
  assert.equal(mapping.getState().powerSource.batPercentRemaining, 150);
  assert.equal(mapping.getState().powerSource.status, 1);
  assert.equal(mapping.getState().powerSource.batChargeLevel, 0);
  context.characteristics.get('StatusLowBattery').value = 1;
  assert.equal(mapping.getState().powerSource.batChargeLevel, 1);
  assert.equal(mapping.getState().powerSource.batReplacementNeeded, true);
  assert.equal('powerSource' in fixture('ContactSensor', { ContactSensorState: 0 }).mapping().getState(), false);
});

test('fans convert mode, active, and rotation-speed commands through existing HAP setters', async () => {
  const context = fixture('Fanv2', { Active: 1, RotationSpeed: 50 });
  const mapping = context.mapping();
  assert.equal(mapping.getState().fanControl.percentCurrent, 50);
  await mapping.handlers.fanControl.percentSettingChange({ percentSetting: 75 });
  assert.deepEqual(context.writes, [['RotationSpeed', 75]]);
  await mapping.handlers.fanControl.fanModeChange({ fanMode: 0 });
  assert.equal(mapping.getState().fanControl.fanMode, 0);
  assert.equal(mapping.getState().fanControl.percentCurrent, 0);
  await assert.rejects(mapping.handlers.fanControl.percentSettingChange({ percentSetting: 101 }), /Fan speed/);
  await assert.rejects(mapping.handlers.fanControl.fanModeChange({ fanMode: 5 }), /not supported/);
});

test('fans expose automatic mode only when the existing service supports it', async () => {
  const context = fixture('Fanv2', { Active: 0, RotationSpeed: 50, TargetFanState: 0 });
  const mapping = context.mapping();
  await mapping.handlers.fanControl.fanModeChange({ fanMode: 5 });
  assert.deepEqual(context.writes, [['TargetFanState', 1], ['Active', 1]]);
  assert.equal(mapping.getState().fanControl.fanMode, 5);
  await mapping.handlers.fanControl.percentSettingChange({ percentSetting: null });
  assert.deepEqual(context.writes.slice(-2), [['TargetFanState', 0], ['Active', 0]]);
  await mapping.handlers.fanControl.fanModeChange({ fanMode: 1 });
  assert.deepEqual(context.writes.slice(-2), [['RotationSpeed', 33], ['Active', 1]]);
  assert.equal(mapping.getState().fanControl.fanModeSequence, 2);
});

test('mirroring a physical fan speed or mode update never sends commands back to Tuya', async () => {
  for (const values of [
    { Active: 1, RotationSpeed: 100 },
    { Active: 1, RotationSpeed: 33 },
    { Active: 0, RotationSpeed: 66 },
    { Active: 1, RotationSpeed: 66, TargetFanState: 1 },
    { Active: 0, RotationSpeed: 66, TargetFanState: 1 },
  ]) {
    const context = fixture('Fanv2', values);
    const mapping = context.mapping();
    const state = mapping.getState().fanControl;
    await Promise.all([
      mapping.handlers.fanControl.fanModeChange({ fanMode: state.fanMode }),
      mapping.handlers.fanControl.percentSettingChange({ percentSetting: state.percentSetting }),
    ]);
    assert.deepEqual(context.writes, [], JSON.stringify(values));
  }
});

test('related native fan mode and speed callbacks apply the physical change once', async () => {
  const context = fixture('Fanv2', { Active: 1, RotationSpeed: 50, TargetFanState: 0 });
  const mapping = context.mapping();
  await Promise.all([
    mapping.handlers.fanControl.fanModeChange({ fanMode: 3 }),
    mapping.handlers.fanControl.percentSettingChange({ percentSetting: 100 }),
  ]);
  assert.deepEqual(context.writes, [['RotationSpeed', 100]]);
  assert.equal(mapping.getState().fanControl.fanMode, 3);
});

test('a failed fan command does not block subsequent native commands', async () => {
  const context = fixture('Fanv2', { Active: 1, RotationSpeed: 50 });
  const mapping = context.mapping();
  context.characteristics.get('RotationSpeed').error = new Error('offline');
  await assert.rejects(mapping.handlers.fanControl.percentSettingChange({ percentSetting: 75 }), /offline/);
  context.characteristics.get('RotationSpeed').error = null;
  await mapping.handlers.fanControl.percentSettingChange({ percentSetting: 100 });
  assert.equal(mapping.getState().fanControl.percentCurrent, 100);
});

test('explicit manual fan modes still change Auto and power when percentage already matches', async () => {
  const automatic = fixture('Fanv2', { Active: 1, RotationSpeed: 100, TargetFanState: 1 });
  await automatic.mapping().handlers.fanControl.fanModeChange({ fanMode: 3 });
  assert.deepEqual(automatic.writes, [['TargetFanState', 0]]);
  const idle = fixture('Fanv2', { Active: 1, RotationSpeed: 0 });
  await idle.mapping().handlers.fanControl.fanModeChange({ fanMode: 0 });
  assert.deepEqual(idle.writes, [['Active', 0]]);
});

test('mandatory HAP TargetFanState without a physical setter does not advertise Auto', () => {
  const context = fixture('Fanv2', { Active: 1, TargetFanState: 1 });
  context.characteristics.get('TargetFanState').listenerCount = () => 0;
  const mapping = context.mapping();
  assert.equal(mapping.getState().fanControl.fanModeSequence, 5);
  assert.equal(mapping.getState().fanControl.fanMode, 3);
  assert.equal('percentSettingChange' in mapping.handlers.fanControl, false);
});

test('HAP onSet handlers are recognized without legacy set listeners', async () => {
  const context = fixture('Switch', { On: false });
  context.characteristics.get('On').listenerCount = () => 0;
  context.characteristics.get('On').setHandler = () => {};
  await context.mapping().handlers.onOff.on();
  assert.deepEqual(context.writes, [['On', true]]);
});

test('a HAP characteristic with no physical setter is not exposed as controllable', () => {
  const context = fixture('Switch', { On: false });
  context.characteristics.get('On').listenerCount = () => 0;
  assert.equal(context.mapping(), undefined);
});

test('coverings invert lift position and reject unsupported physical stop', async () => {
  const context = fixture('WindowCovering', { TargetPosition: 75, CurrentPosition: 50, PositionState: 1 });
  const mapping = context.mapping();
  assert.equal(mapping.getState().windowCovering.targetPositionLiftPercent100ths, 2500);
  assert.equal(mapping.getState().windowCovering.currentPositionLiftPercent100ths, 5000);
  assert.deepEqual(mapping.getState().windowCovering.operationalStatus, { global: 1, lift: 1, tilt: 0 });
  await mapping.handlers.windowCovering.goToLiftPercentage({ liftPercent100thsValue: 2500 });
  await mapping.handlers.windowCovering.upOrOpen();
  await mapping.handlers.windowCovering.downOrClose();
  assert.deepEqual(context.writes, [['TargetPosition', 75], ['TargetPosition', 100], ['TargetPosition', 0]]);
  await assert.rejects(async () => mapping.handlers.windowCovering.stopMotion(), /does not support stopping/);
  await assert.rejects(async () => mapping.handlers.windowCovering.goToLiftPercentage({ liftPercent100thsValue: 10001 }), /Lift position/);
});

test('coverings forward stop only if a HAP HoldPosition characteristic exists', async () => {
  const context = fixture('WindowCovering', { TargetPosition: 0, CurrentPosition: 0, HoldPosition: false });
  await context.mapping().handlers.windowCovering.stopMotion();
  assert.deepEqual(context.writes, [['HoldPosition', true]]);
});

test('unsupported services and missing native device types are skipped', () => {
  for (const type of ['HeaterCooler', 'AirPurifier', 'GarageDoorOpener', 'StatelessProgrammableSwitch']) {
    assert.equal(fixture(type, {}).mapping(), undefined);
  }
  assert.equal(fixture('Switch', {}).mapping(), undefined);
  const context = fixture('Switch', { On: true });
  delete context.api.matter.deviceTypes.OnOffSwitch;
  assert.equal(context.mapping(), undefined);
  delete context.api.matter;
  assert.equal(context.mapping(), undefined);
});
