const BaseAccessory = require('./base_accessory');

// Tuya's hps presence_state distinguishes still occupants from moving ones.
// All four occupied states must remain occupied for HomeKit automations.
// https://developer.tuya.com/en/docs/iot/s?id=K9j2w4p710ge9
const OCCUPIED_STATES = new Set(['presence', 'peaceful', 'small_move', 'large_move']);

class PresenceSensorAccessory extends BaseAccessory {
  constructor(platform, homebridgeAccessory, deviceConfig) {
    const { Categories, Characteristic, Service } = platform.api.hap;
    const previous = homebridgeAccessory && homebridgeAccessory.controller;
    const existing = homebridgeAccessory && homebridgeAccessory.getService(Service.OccupancySensor);
    // A pending accessory's default characteristic value is not a reading.
    // Existing, already published occupancy services can retain their last value.
    const lastKnown = previous?.registrationPending
      ? previous.getCachedState(Characteristic.OccupancyDetected)
      : existing?.testCharacteristic(Characteristic.OccupancyDetected)
        ? existing.getCharacteristic(Characteristic.OccupancyDetected).value : undefined;
    super(platform, homebridgeAccessory, deviceConfig, Categories.SENSOR, Service.OccupancySensor, [], { deferRegistration: true });

    if (lastKnown === 0 || lastKnown === 1) {
      this.cachedState.set(Characteristic.OccupancyDetected, lastKnown);
      this.service.getCharacteristic(Characteristic.OccupancyDetected).updateValue(lastKnown);
    } else {
      // Hide unconfirmed defaults, including when reusing an accessory that
      // previously used another driver or later switches to another driver.
      this.homebridgeAccessory.removeService(this.service);
      this.serviceDetached = true;
    }

    // onGet replaces the previous handler if a cached service is rebound.
    // Live updates only change its value; they never register more listeners.
    this.service.getCharacteristic(Characteristic.OccupancyDetected).onGet(() => {
      const { Characteristic: C, HapStatusError, HAPStatus } = this.platform.api.hap;
      if (this.getCachedState(C.OccupancyDetected) === undefined) {
        throw new HapStatusError(HAPStatus.SERVICE_COMMUNICATION_FAILURE);
      }
      return this.getCachedState(C.OccupancyDetected);
    });
    this.service.getCharacteristic(Characteristic.StatusFault).onGet(() => this.faultStatus());
    this.service.getCharacteristic(Characteristic.StatusActive).onGet(() => this.hasValidCache());
    this.updateAvailability();
    this.updateState(deviceConfig);
  }

  faultStatus() {
    const { StatusFault } = this.platform.api.hap.Characteristic;
    return this.hasValidCache() ? StatusFault.NO_FAULT : StatusFault.GENERAL_FAULT;
  }

  updateAvailability() {
    const { Characteristic } = this.platform.api.hap;
    this.service.getCharacteristic(Characteristic.StatusFault).updateValue(this.faultStatus());
    this.service.getCharacteristic(Characteristic.StatusActive).updateValue(this.hasValidCache());
  }

  invalidateCache() {
    super.invalidateCache();
    this.updateAvailability();
  }

  updateState(data) {
    if (!Array.isArray(data && data.status)) return;
    const { Characteristic } = this.platform.api.hap;
    for (const status of data.status) {
      if (!status || typeof status !== 'object' || Array.isArray(status)
        || status.code !== 'presence_state'
        || !Object.prototype.hasOwnProperty.call(status, 'value')) continue;
      // A malformed value is not a new physical reading. Unrelated partial
      // MQTT messages likewise leave the last valid occupancy untouched.
      if (status.value !== null && typeof status.value === 'object') continue;

      let value;
      if (status.value === 'none') {
        value = Characteristic.OccupancyDetected.OCCUPANCY_NOT_DETECTED;
      } else if (OCCUPIED_STATES.has(status.value)) {
        value = Characteristic.OccupancyDetected.OCCUPANCY_DETECTED;
      } else {
        // A failed GET is serialized as default zero by HAP /accessories.
        // Retain the last reading and expose the failure through sensor status.
        this.invalidateCache();
        continue;
      }
      this.setCachedState(Characteristic.OccupancyDetected, value);
      this.service.getCharacteristic(Characteristic.OccupancyDetected).updateValue(value);
      this.updateAvailability();
    }
    if (this.hasValidCache()) {
      if (this.serviceDetached) {
        this.homebridgeAccessory.addService(this.service);
        this.serviceDetached = false;
      }
      this.registerIfNeeded();
    }
  }
}

module.exports = PresenceSensorAccessory;
