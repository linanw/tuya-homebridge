let PlatformAccessory;
let Service;
let Characteristic;
let UUIDGen;
const pendingRegistrations = new WeakSet();

//Base class of Accessory
class BaseAccessory {
  constructor(platform, homebridgeAccessory, deviceConfig, categoryType, serviceType, subServices = [], { deferRegistration = false } = {}) {
    this.platform = platform;
    this.deviceId = deviceConfig.id;
    this.categoryType = categoryType;
    PlatformAccessory = platform.api.platformAccessory;

    ({ Service, Characteristic, uuid: UUIDGen } = platform.api.hap);

    this.log = platform.log;
    this.homebridgeAccessory = homebridgeAccessory;
    this.deviceConfig = deviceConfig;

    // Setup caching
    this.cachedState = new Map();
    this.validCache = false;

    //Accessory Service
    this.serviceType = serviceType;

    //Accessory subServices
    this.subServices = subServices;

    //Accessory
    if (this.homebridgeAccessory) {
      this.homebridgeAccessory.controller = this;
      if (!this.homebridgeAccessory.context.deviceId) {
        this.homebridgeAccessory.context.deviceId = this.deviceConfig.id;
      }

      this.log.log(`Existing Accessory found ${homebridgeAccessory.displayName}  ${homebridgeAccessory.context.deviceId} ${homebridgeAccessory.UUID}`);
      this.homebridgeAccessory.displayName = this.deviceConfig.name;
    }
    else {
      // Create new Accessory
      this.log.log(`Creating New Accessory ${this.deviceConfig.id}`);
      this.homebridgeAccessory = new PlatformAccessory(
        this.deviceConfig.name,
        UUIDGen.generate(this.deviceConfig.id),
        categoryType);
      this.homebridgeAccessory.context.deviceId = this.deviceConfig.id;
      this.homebridgeAccessory.controller = this;
      pendingRegistrations.add(this.homebridgeAccessory);
    }
    if (!deferRegistration) this.registerIfNeeded();

    // Service
    if (this.subServices.length == 0 || this.subServices.length == 1) {
      // Service
      this.service = this.homebridgeAccessory.getService(this.serviceType);
      if (this.service) {
        this.service.setCharacteristic(Characteristic.Name, this.deviceConfig.name);
      }
      else {
        // add new service
        this.service = this.homebridgeAccessory.addService(this.serviceType, this.deviceConfig.name);
      }
    } else {
      // SubService
      var i = 1;
      for (const subService of this.subServices) {
        var service = this.homebridgeAccessory.getServiceById(this.serviceType, subService)
          || this.homebridgeAccessory.getService(subService);
        if (service) {
          service.setCharacteristic(Characteristic.Name, subService);
        } else {
          // add new subService
          service = this.homebridgeAccessory.addService(this.serviceType, subService, subService);
          if (this.serviceType.UUID === Service.StatelessProgrammableSwitch.UUID) {
            service.getCharacteristic(Characteristic.ServiceLabelIndex).setValue(i);
          }
        }
        i++;
      }
    }

    this.homebridgeAccessory.on('identify', (paired, callback) => {
      callback();
    });
  }

  get registrationPending() {
    return pendingRegistrations.has(this.homebridgeAccessory);
  }

  registerIfNeeded() {
    if (!this.registrationPending) return false;
    this.platform.registerPlatformAccessory(this.homebridgeAccessory);
    pendingRegistrations.delete(this.homebridgeAccessory);
    return true;
  }

  updateAccessory(device) {
    // Update general accessory information
    if (device.name) {
      this.homebridgeAccessory.displayName = device.name;
      this.homebridgeAccessory._associatedHAPAccessory.displayName = device.name;
      var accessoryInformationService = (
        this.homebridgeAccessory.getService(Service.AccessoryInformation) ||
        this.homebridgeAccessory.addService(Service.AccessoryInformation));
      var characteristicName = (
        accessoryInformationService.getCharacteristic(Characteristic.Name) ||
        accessoryInformationService.addCharacteristic(Characteristic.Name));
      if (characteristicName) {
        characteristicName.setValue(device.name);
      }
    }

    if (typeof this.homebridgeAccessory.updateReachability === 'function') {
      this.homebridgeAccessory.updateReachability(device.online);
    }
    // Update device specific state
    this.updateState(device);
  }

  setCachedState(characteristic, value) {
    this.cachedState.set(characteristic, value);
    this.validCache = true;
  }

  getCachedState(characteristic) {
    return this.cachedState.get(characteristic);
  }

  readCachedState(characteristic, callback) {
    if (!this.hasValidCache() || !this.cachedState.has(characteristic)
      || this.cachedState.get(characteristic) === undefined) {
      callback(new Error('Device state is unavailable; waiting for a status update'));
      return;
    }
    callback(null, this.getCachedState(characteristic));
  }

  hasValidCache() {
    return this.validCache && this.cachedState.size > 0;
  }

  invalidateCache() {
    this.validCache = false;
  }
}

module.exports = BaseAccessory;
