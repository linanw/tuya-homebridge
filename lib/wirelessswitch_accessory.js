const BaseAccessory = require('./base_accessory');

const BUTTON_EVENTS = new Map([
  ['single_click', 0],
  ['click', 0],
  ['1', 0],
  ['double_click', 1],
  ['long_press', 2],
  ['press', 2],
]);

class WirelessSwitchAccessory extends BaseAccessory {
  constructor(platform, homebridgeAccessory, deviceConfig, deviceData) {
    const { Categories, Characteristic, Service } = platform.api.hap;
    const buttonCodes = deviceData.subType;
    super(
      platform,
      homebridgeAccessory,
      deviceConfig,
      Categories.SWITCH,
      Service.StatelessProgrammableSwitch,
      buttonCodes
    );
    this.buttonServices = new Map();
    for (const [index, code] of buttonCodes.entries()) {
      // Older plugins use the datapoint as subtype, including single buttons
      // whose display name is the device name. Preserve cached service IDs.
      const service = this.homebridgeAccessory.getServiceById(Service.StatelessProgrammableSwitch, code)
        || this.homebridgeAccessory.getService(code)
        || (buttonCodes.length === 1 ? this.service : undefined);
      if (!service) continue;
      this.buttonServices.set(code, service);
      const channelNumber = Number((code.match(/\d+/) || [index + 1])[0]);
      service.setCharacteristic(Characteristic.ServiceLabelIndex, Math.max(1, channelNumber));
    }
    // Stateless snapshots describe past presses. Only live updates emit events.
  }

  //init Or refresh AccessoryService
  refreshAccessoryServiceIfNeed(statusArr, isRefresh) {
    if (!isRefresh || !Array.isArray(statusArr)) return;
    const { Characteristic } = this.platform.api.hap;
    for (const status of statusArr) {
      const service = this.buttonServices.get(status.code);
      if (!service) continue;
      const event = BUTTON_EVENTS.get(status.value)
        ?? (Number.isInteger(status.value) && status.value > 0 ? 0 : undefined);
      if (event === undefined) continue;
      // Each press is an event, including consecutive identical presses.
      service.getCharacteristic(Characteristic.ProgrammableSwitchEvent).sendEventNotification(event);
    }
  }

  //update device status
  updateState(data) {
    this.refreshAccessoryServiceIfNeed(data && data.status, true);
  }
}

module.exports = WirelessSwitchAccessory;
