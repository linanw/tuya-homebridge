// Native Homebridge Matter descriptors reuse the existing HomeKit handlers so
// Tuya datapoint conversion and command errors stay the same for both protocols.
function createMatterDevice(api, accessory, service) {
  if (!api.matter || !api.hap) return;
  const { Characteristic: C, Service: S } = api.hap;
  const types = api.matter.deviceTypes;
  const matches = name => S[name] && service.UUID === S[name].UUID;
  const has = name => C[name] && service.testCharacteristic(C[name]);
  const characteristic = name => service.getCharacteristic(C[name]);
  const writable = name => {
    if (!has(name)) return false;
    const item = characteristic(name);
    return typeof item.setHandler === 'function' ||
      (typeof item.listenerCount === 'function' && item.listenerCount('set') > 0);
  };
  const read = (name, fallback = 0) => {
    if (!has(name)) return fallback;
    const value = characteristic(name).value;
    return value === null || value === undefined ? fallback : value;
  };
  const numeric = (name, min, max, fallback = min) => {
    const value = read(name, fallback);
    return Number.isFinite(value) ? Math.max(min, Math.min(max, value)) : fallback;
  };
  const fail = (kind, message) => {
    const ErrorClass = api.matter.status && api.matter.status[kind];
    throw ErrorClass ? new ErrorClass(message) : new Error(message);
  };
  const range = (value, min, max, label) => {
    if (!Number.isFinite(value) || value < min || value > max) {
      fail('ConstraintError', `${label} must be between ${min} and ${max}`);
    }
    return value;
  };
  const write = (name, value) => new Promise((resolve, reject) => {
    if (!writable(name)) {
      reject(new Error(`HomeKit characteristic ${name} has no physical-device setter`));
      return;
    }
    // setValue invokes the existing physical-device setter. updateValue would
    // only change the local HomeKit value, without controlling the Tuya device.
    characteristic(name).setValue(value, error => error ? reject(error) : resolve());
  });
  const onOff = () => ({
    on: () => write('On', true),
    off: () => write('On', false),
    toggle: () => write('On', !read('On', false)),
  });

  let mapping;
  if (matches('Lightbulb') && writable('On')) {
    const dimmable = writable('Brightness');
    const color = dimmable && writable('Hue') && writable('Saturation');
    const temperature = dimmable && writable('ColorTemperature');
    const type = color ? 'ExtendedColorLight' : temperature ? 'ColorTemperatureLight' : dimmable ? 'DimmableLight' : 'OnOffLight';
    let colorMode = color ? 0 : 2;
    const physicalColorMode = () => {
      const mode = accessory.controller && accessory.controller.workMode;
      return mode && typeof mode.value === 'string' ? mode.value.toLowerCase() : undefined;
    };
    let lastPhysicalColorMode;
    const syncColorMode = () => {
      const mode = physicalColorMode();
      if (mode === lastPhysicalColorMode) return;
      lastPhysicalColorMode = mode;
      if (temperature && ['white', 'light_white'].includes(mode)) colorMode = 2;
      else if (color && ['colour', 'color', 'light_colour', 'light_color'].includes(mode)) colorMode = 0;
    };
    syncColorMode();
    const withColorMode = async (mode, action) => {
      const previous = colorMode;
      colorMode = mode;
      try {
        await action();
      } catch (error) {
        colorMode = previous;
        throw error;
      }
    };
    const setColor = (hue, saturation, mode = 0) => withColorMode(mode, async () => {
      // The existing Tuya light caches Saturation and sends the actual color
      // command when Hue is set. Reapply Hue for saturation-only commands too.
      await write('Saturation', saturation);
      await write('Hue', hue);
    });
    const handlers = { onOff: onOff() };
    if (dimmable) {
      const setLevel = async (request, withOnOff) => {
        const level = range(request.level, 0, 254, 'Level');
        if (withOnOff && level === 0) {
          await write('On', false);
          return;
        }
        await write('Brightness', Math.round(level * 100 / 254));
        if (withOnOff && !read('On', false)) await write('On', true);
      };
      handlers.levelControl = {
        moveToLevel: request => setLevel(request, false),
        moveToLevelWithOnOff: request => setLevel(request, true),
      };
    }
    if (color || temperature) handlers.colorControl = {
      // Tuya setters apply their target immediately and start no physical
      // fades. Homebridge still invokes this hook before switching color mode;
      // its native super implementation stops the Matter-side transition.
      stopAllColorMovement: async () => {},
    };
    if (color) {
      handlers.colorControl.moveToHueAndSaturationLogic = request => setColor(
        range(request.hue, 0, 254, 'Hue') * 360 / 254,
        range(request.saturation, 0, 254, 'Saturation') * 100 / 254,
      );
      handlers.colorControl.moveToHueLogic = request => setColor(
        range(request.targetHue, 0, request.isEnhancedHue ? 65535 : 254, 'Hue') * 360 / (request.isEnhancedHue ? 65535 : 254),
        numeric('Saturation', 0, 100),
      );
      handlers.colorControl.moveToSaturationLogic = request => setColor(
        numeric('Hue', 0, 360),
        range(request.targetSaturation, 0, 254, 'Saturation') * 100 / 254,
      );
      handlers.colorControl.moveToColorLogic = request => {
        const x = range(request.targetX, 0, 65535, 'Color X') / 65535;
        const y = range(request.targetY, 0, 65535, 'Color Y') / 65535;
        if (y === 0 || x + y > 1) fail('ConstraintError', 'Invalid CIE xy color');
        const converted = xyToHueSaturation(x, y);
        return setColor(converted.hue, converted.saturation, 1);
      };
    }
    if (temperature) {
      const props = characteristic('ColorTemperature').props || {};
      const min = Number.isFinite(props.minValue) ? props.minValue : 140;
      const max = Number.isFinite(props.maxValue) ? props.maxValue : 500;
      handlers.colorControl.moveToColorTemperatureLogic = request => withColorMode(2, () => write(
        'ColorTemperature', Math.round(range(request.colorTemperatureMireds, min, max, 'Color temperature')),
      ));
    }
    mapping = {
      deviceType: types[type],
      handlers,
      getState: () => {
        // MQTT can change only work_mode, without changing any HAP color
        // characteristic. Follow physical transitions while preserving an XY
        // or HS command until the device actually reports a different mode.
        syncColorMode();
        const state = { onOff: { onOff: Boolean(read('On', false)) } };
        if (dimmable) state.levelControl = {
          currentLevel: Math.max(1, Math.round(numeric('Brightness', 0, 100) * 254 / 100)),
          minLevel: 1,
          maxLevel: 254,
        };
        if (color || temperature) state.colorControl = { colorMode };
        if (color) {
          const hue = numeric('Hue', 0, 360);
          const saturation = numeric('Saturation', 0, 100);
          const xy = hueSaturationToXy(hue, saturation);
          Object.assign(state.colorControl, {
            currentHue: Math.round(hue * 254 / 360),
            currentSaturation: Math.round(saturation * 254 / 100),
            currentX: Math.round(xy.x * 65535),
            currentY: Math.round(xy.y * 65535),
          });
        }
        if (temperature) {
          const props = characteristic('ColorTemperature').props || {};
          const min = Number.isFinite(props.minValue) ? props.minValue : 140;
          const max = Number.isFinite(props.maxValue) ? props.maxValue : 500;
          Object.assign(state.colorControl, {
            colorTemperatureMireds: Math.round(numeric('ColorTemperature', min, max)),
            colorTempPhysicalMinMireds: min,
            colorTempPhysicalMaxMireds: max,
            coupleColorTempToLevelMinMireds: min,
          });
        }
        return state;
      },
    };
  } else if ((matches('Switch') || matches('Outlet')) && writable('On')) {
    mapping = {
      deviceType: types[matches('Outlet') ? 'OnOffOutlet' : 'OnOffSwitch'],
      getState: () => ({ onOff: { onOff: Boolean(read('On', false)) } }),
      handlers: { onOff: onOff() },
    };
  } else if (matches('ContactSensor') && has('ContactSensorState')) {
    mapping = {
      deviceType: types.ContactSensor,
      getState: () => ({ booleanState: { stateValue: read('ContactSensorState') === 0 } }),
      handlers: {},
    };
  } else if (matches('OccupancySensor') && has('OccupancyDetected')) {
    // Homebridge's friendly MotionSensor type is an OccupancySensor, but its
    // default detector feature is PIR. The presence DP does not establish the
    // physical detection technology, so explicitly select Other instead.
    const base = types.MotionSensor;
    const sensing = api.matter.deviceRequirements?.MotionSensor?.OccupancySensingServer;
    if (typeof base?.with !== 'function' || typeof sensing?.with !== 'function') return;
    mapping = {
      deviceType: base.with(sensing.with('Other', 'OccupancyEvent')),
      occupancySensingFeatures: {
        other: true, passiveInfrared: false, ultrasonic: false, physicalContact: false,
        activeInfrared: false, radar: false, rfSensing: false, vision: false, occupancyEvent: true,
      },
      handlers: {},
      getState: () => {
        const controller = accessory.controller;
        if (typeof controller?.hasValidCache === 'function' && !controller.hasValidCache()) return {};
        const value = characteristic('OccupancyDetected').value;
        if (value !== 0 && value !== 1) return {};
        return { occupancySensing: {
          occupancy: { occupied: value === 1 },
          // This frozen legacy enum has no Other value. New cluster revisions
          // identify detector technology through the features above; keep all
          // legacy modality bits false rather than advertising PIR hardware.
          occupancySensorType: 0,
          occupancySensorTypeBitmap: { pir: false, ultrasonic: false, physicalContact: false },
        } };
      },
    };
  } else if (matches('LeakSensor') && has('LeakDetected')) {
    // The legacy plugin also represents combustible-gas alarms as HAP leak
    // sensors. Advertising those as Matter water-leak detectors is incorrect.
    const device = accessory.controller && accessory.controller.deviceConfig;
    if (device && (['rqbj', 'jwbj'].includes(device.category) || (device.status || []).some(item =>
      ['gas_sensor_status', 'gas_sensor_state', 'ch4_sensor_state'].includes(item.code)))) return;
    mapping = {
      deviceType: types.LeakSensor,
      getState: () => ({ booleanState: { stateValue: read('LeakDetected') === 1 } }),
      handlers: {},
    };
  } else if (matches('SmokeSensor') && has('SmokeDetected')) {
    mapping = {
      deviceType: types.SmokeSensor,
      getState: () => {
        const detected = read('SmokeDetected') === 1;
        return { smokeCoAlarm: {
          smokeState: detected ? 2 : 0,
          expressedState: detected ? 1 : 0,
          batteryAlert: has('StatusLowBattery') && read('StatusLowBattery') === 1 ? 1 : 0,
          deviceMuted: 0,
          testInProgress: false,
          hardwareFaultAlert: false,
          endOfServiceAlert: 0,
          interconnectSmokeAlarm: 0,
          contaminationState: 0,
          smokeSensitivityLevel: 1,
        } };
      },
      handlers: {},
    };
  } else if (matches('Fanv2') && writable('Active')) {
    const variableSpeed = writable('RotationSpeed');
    // TargetFanState is a mandatory HAP service characteristic, even when the
    // physical device has no mode datapoint. Its presence alone is not Auto.
    const automatic = writable('TargetFanState');
    const fanState = () => {
      const active = read('Active') === 1;
      const percent = active ? variableSpeed ? Math.round(numeric('RotationSpeed', 0, 100)) : 100 : 0;
      return {
        fanMode: !active ? 0 : automatic && read('TargetFanState') === 1 ? 5 : percent <= 33 ? 1 : percent <= 67 ? 2 : 3,
        fanModeSequence: automatic ? variableSpeed ? 2 : 4 : variableSpeed ? 0 : 5,
        percentSetting: percent,
        percentCurrent: percent,
      };
    };
    const writeChanged = (name, value) => read(name) === value ? Promise.resolve() : write(name, value);
    const manualMode = () => automatic ? writeChanged('TargetFanState', 0) : Promise.resolve();
    // Native FanControl also calls its attribute handlers when a physical-state
    // update is mirrored to Matter. Recognize those already-applied values so
    // an MQTT notification never becomes a new command back to the same fan.
    // Serialize related mode/percentage callbacks from one native transaction.
    let fanQueue = Promise.resolve();
    const fanCommand = operation => {
      const pending = fanQueue.then(operation);
      fanQueue = pending.catch(() => {});
      return pending;
    };
    const setPercent = async (percent, enforceManualMode = false) => {
      const value = range(percent === null ? 0 : percent, 0, 100, 'Fan speed');
      if (!variableSpeed && value !== 0 && value !== 100) fail('InvalidAction', 'Fan does not support variable speed');
      if (fanState().percentSetting === value && (!enforceManualMode ||
        ((read('Active') === 1) === (value > 0) && (!automatic || read('TargetFanState') === 0)))) return;
      await manualMode();
      if (value > 0 && variableSpeed) await writeChanged('RotationSpeed', value);
      await writeChanged('Active', value === 0 ? 0 : 1);
    };
    const fanHandlers = {
      fanModeChange: request => fanCommand(async () => {
        const mode = range(request.fanMode, 0, 6, 'Fan mode');
        if (fanState().fanMode === mode) return;
        if (mode === 5 && automatic) {
          await writeChanged('TargetFanState', 1);
          await writeChanged('Active', 1);
          return;
        }
        if (![0, 1, 2, 3, 4].includes(mode)) fail('InvalidAction', 'Fan mode is not supported');
        if (!variableSpeed && [1, 2].includes(mode)) fail('InvalidAction', 'Fan does not support Low or Medium speed');
        await setPercent(mode === 0 ? 0 : mode === 1 ? 33 : mode === 2 ? 67 : mode === 4 && variableSpeed ? numeric('RotationSpeed', 1, 100, 100) : 100, true);
      }),
    };
    if (variableSpeed) fanHandlers.percentSettingChange = request => fanCommand(() => setPercent(request.percentSetting));
    mapping = {
      deviceType: types.Fan,
      handlers: { fanControl: fanHandlers },
      getState: () => ({ fanControl: fanState() }),
    };
  } else if (matches('WindowCovering') && writable('TargetPosition') && has('CurrentPosition')) {
    mapping = {
      deviceType: types.WindowCovering,
      handlers: { windowCovering: {
        upOrOpen: () => write('TargetPosition', 100),
        downOrClose: () => write('TargetPosition', 0),
        goToLiftPercentage: request => write('TargetPosition', Math.round(
          100 - range(request.liftPercent100thsValue, 0, 10000, 'Lift position') / 100,
        )),
        stopMotion: () => {
          if (!writable('HoldPosition')) fail('InvalidAction', 'This covering does not support stopping motion');
          return write('HoldPosition', true);
        },
      } },
      getState: () => {
        return { windowCovering: {
          targetPositionLiftPercent100ths: Math.round((100 - numeric('TargetPosition', 0, 100)) * 100),
          currentPositionLiftPercent100ths: Math.round((100 - numeric('CurrentPosition', 0, 100)) * 100),
          // The Tuya driver does not report PositionState. Its mandatory HAP
          // default is not physical motion data. Native Matter derives its
          // operationalStatus from positions and owns that attribute.
          endProductType: 0,
          configStatus: {
            operational: true,
            onlineReserved: true,
            liftMovementReversed: false,
            liftPositionAware: true,
            tiltPositionAware: false,
            liftEncoderControlled: true,
            tiltEncoderControlled: false,
          },
        } };
      },
    };
  }

  if (!mapping || !mapping.deviceType) return;
  if (has('StatusLowBattery') || has('BatteryLevel')) {
    const originalState = mapping.getState;
    mapping.getState = () => {
      const state = originalState();
      const low = has('StatusLowBattery') && read('StatusLowBattery') === 1;
      state.powerSource = {
        status: 1,
        order: 0,
        description: 'Battery',
        batChargeLevel: low ? 1 : 0,
        batReplacementNeeded: low,
        batReplaceability: 0,
      };
      if (has('BatteryLevel')) state.powerSource.batPercentRemaining = Math.round(numeric('BatteryLevel', 0, 100) * 2);
      return state;
    };
  }
  return mapping;
}

// Use the sRGB/D65 color space for controllers that send XY instead of HS.
function hueSaturationToXy(hue, saturation) {
  const h = ((hue % 360) + 360) % 360 / 60;
  const s = saturation / 100;
  const x = s * (1 - Math.abs(h % 2 - 1));
  const values = h < 1 ? [s, x, 0] : h < 2 ? [x, s, 0] : h < 3 ? [0, s, x] : h < 4 ? [0, x, s] : h < 5 ? [x, 0, s] : [s, 0, x];
  const [r, g, b] = values.map(value => {
    const v = value + 1 - s;
    return v > 0.04045 ? Math.pow((v + 0.055) / 1.055, 2.4) : v / 12.92;
  });
  const X = 0.4124 * r + 0.3576 * g + 0.1805 * b;
  const Y = 0.2126 * r + 0.7152 * g + 0.0722 * b;
  const Z = 0.0193 * r + 0.1192 * g + 0.9505 * b;
  return { x: X / (X + Y + Z), y: Y / (X + Y + Z) };
}

function xyToHueSaturation(x, y) {
  const X = x / y;
  const Z = (1 - x - y) / y;
  let rgb = [3.2406 * X - 1.5372 - 0.4986 * Z, -0.9689 * X + 1.8758 + 0.0415 * Z, 0.0557 * X - 0.2040 + 1.0570 * Z].map(value => Math.max(0, value));
  const normalization = Math.max(1, ...rgb);
  rgb = rgb.map(value => {
    const v = value / normalization;
    return v <= 0.0031308 ? 12.92 * v : 1.055 * Math.pow(v, 1 / 2.4) - 0.055;
  });
  const [r, g, b] = rgb;
  const max = Math.max(...rgb);
  const min = Math.min(...rgb);
  const delta = max - min;
  let hue = 0;
  if (delta > 0) {
    hue = max === r ? (g - b) / delta : max === g ? (b - r) / delta + 2 : (r - g) / delta + 4;
    hue = (hue * 60 + 360) % 360;
  }
  return { hue, saturation: max === 0 ? 0 : delta / max * 100 };
}

module.exports = { createMatterDevice };
