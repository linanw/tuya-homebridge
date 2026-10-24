const TuyaOpenAPI = require("./lib/tuyaopenapi");
const TuyaSHOpenAPI = require("./lib/tuyashopenapi");
const TuyaOpenMQ = require("./lib/tuyamqttapi");
const OutletAccessory = require("./lib/outlet_accessory");
const LightAccessory = require("./lib/light_accessory");
const SwitchAccessory = require("./lib/switch_accessory");
const SmokeSensorAccessory = require("./lib/smokesensor_accessory");
const Fanv2Accessory = require("./lib/fanv2_accessory");
const HeaterAccessory = require("./lib/heater_accessory");
const GarageDoorAccessory = require("./lib/garagedoor_accessory");
const AirPurifierAccessory = require("./lib/air_purifier_accessory");
const WindowCoveringAccessory = require("./lib/window_covering_accessory");
const DoorAccessory = require("./lib/door_accessory");
const ContactSensorAccessory = require("./lib/contactsensor_accessory");
const WirelessSwitchAccessory = require("./lib/wirelessswitch_accessory");
const LeakSensorAccessory = require("./lib/leak_sensor_accessory");
const MatterBridge = require("./lib/matter_bridge");
const { startMetadataSync, stopMetadataSync, invalidateMetadata } = require("./lib/metadata_sync/platform_sync");
const PLUGIN_NAME = require("./package.json").name;

const LogUtil = require("./util/logutil");
const DataUtil = require("./util/datautil");

module.exports = function (homebridge) {
  // registerAccessory' three parameters is plugin-name, accessory-name, constructor-name
  homebridge.registerPlatform(
    PLUGIN_NAME,
    "TuyaPlatform",
    TuyaPlatform,
    true
  );
};

// Accessory constructor
class TuyaPlatform {
  constructor(log, config, api) {
    this.logger = log;
    this.log = new LogUtil(config && config.options && config.options.debug, log);
    this.config = config;
    const options = config && config.options;
    this.specifiedAccessoryTypes = options && Array.isArray(options.accessoryType) ? options.accessoryType : [];
    this.deviceAccessories = new Map();
    this.accessories = new Map();
    this.api = api;
    this.matterBridge = new MatterBridge(api, log);
    if (options) this.log.addSecrets(options.accessId, options.accessKey, options.username, options.password);
    const missing = this.configurationErrors(options);
    this.configured = missing.length === 0;
    if (!this.configured) {
      const message = `TuyaPlatform is not configured; set ${missing.join(", ")} in the plugin settings. No Tuya connection was started.`;
      if (log && typeof log.warn === "function") log.warn(message);
      return;
    }

    if (api) {
      // Save the API object as plugin needs to register new accessory via this object
      this.api = api;
      this.api.on("shutdown", () => {
        if (this.tuyaOpenMQ) this.tuyaOpenMQ.stop();
        this.matterBridge.close();
        stopMetadataSync(this).catch(() => this.logger?.error?.("[Metadata] Could not close sync service."));
      });
      // Listen to event "didFinishLaunching", this means homebridge already finished loading cached accessories.
      // Platform Plugin should only register new accessory that doesn't exist in homebridge after this event.
      // Or start discover new accessories.
      this.api.on(
        "didFinishLaunching",
        function () {
          this.log.log("Initializing TuyaPlatform...");
          this.initTuyaSDK(config).catch(error => {
            this.reportError("initialize TuyaPlatform", error);
          });
        }.bind(this)
      );
    }
  }

  configurationErrors(options) {
    if (!options || typeof options !== "object") return ["options"];
    const errors = ["username", "password", "accessId", "accessKey"].filter(key =>
      typeof options[key] !== "string" || !options[key].trim()
    );
    const projectType = String(options.projectType || "2");
    if (!["1", "2"].includes(projectType)) errors.push("projectType (1 or 2)");
    if (projectType === "1") {
      try {
        const endpoint = new URL(options.endPoint);
        if (endpoint.protocol !== "https:" || endpoint.username || endpoint.password) throw new Error();
      } catch {
        errors.push("endPoint (HTTPS URL for a Custom project)");
      }
    } else if (projectType === "2") {
      if (typeof options.appSchema !== "string" || !["tuyasmart", "smartlife"].includes(options.appSchema.toLowerCase())) errors.push("appSchema (tuyaSmart or smartlife)");
      const countryCode = Number(options.countryCode);
      if (!["string", "number"].includes(typeof options.countryCode) || !Number.isInteger(countryCode) || countryCode < 1) errors.push("countryCode");
    }
    return errors;
  }

  async initTuyaSDK(config) {
    if (!this.configured) return;
    let devices;
    let api;
    if (config.options.projectType == "1") {
      api = new TuyaOpenAPI(
        config.options.endPoint,
        config.options.accessId,
        config.options.accessKey,
        this.log,
        config.options.lang || "en"
      );
      this.tuyaOpenApi = api;
      //login before everything start
      await api.login(config.options.username, config.options.password);
      //init Mqtt service and register some Listener
      try {
        devices = await api.getDeviceList();
      } catch (e) {
        this.reportError("get device information", e);
        return;
      }
    } else {
      api = new TuyaSHOpenAPI(
        config.options.accessId,
        config.options.accessKey,
        config.options.username,
        config.options.password,
        config.options.countryCode,
        config.options.appSchema.toLowerCase() === "tuyasmart" ? "tuyaSmart" : "smartlife",
        this.log,
        config.options.lang || "en"
      );
      this.tuyaOpenApi = api;

      try {
        devices = await api.getDevices();
      } catch (e) {
        this.reportError("get device information", e);
        return;
      }
    }

    let disableDevice = config.options.disabledDevice;
    let initializationFailed = false;
    for (const device of devices) {
      try {
        let isDeviceDisabled = false;
        if (
          disableDevice &&
          disableDevice.length > 0 &&
          disableDevice.filter((item) => {
            return item.id == device.id;
          }).length > 0
        ) {
          isDeviceDisabled = true;
        }
        if (config.options.listDeviceId) {
          console.log(
            "id: %s, name: %s%s",
            device.id,
            device.name,
            isDeviceDisabled ? " [DISABLED]" : ""
          );
        }
        if (!isDeviceDisabled) {
          await this.addAccessory(device);
        } else {
          const uuid = this.api.hap.uuid.generate(device.id);
          const accessory = this.accessories.get(uuid);
          await this.removeAccessory(accessory);
        }
      } catch (error) {
        initializationFailed = true;
        this.reportError("initialize device", error, device);
      }
    }
    // An incomplete discovery must not make a failed device's cached Matter
    // endpoints look deleted. Successful devices have already been bridged.
    if (!initializationFailed) {
      await this.matterBridge.reconcileAccessories(
        Array.from(this.deviceAccessories.values(), driver => driver.homebridgeAccessory)
      );
    }

    const type = config.options.projectType == "1" ? "2.0" : "1.0";
    let mq = new TuyaOpenMQ(api, type, this.log);
    this.tuyaOpenMQ = mq;
    this.tuyaOpenMQ.start();
    this.tuyaOpenMQ.addMessageListener(message => this.onMQTTMessage(message).catch(error => {
      this.reportError("handle device message", error, message);
    }));
    await startMetadataSync(this);
  }

  reportError(action, error, device) {
    const detail = this.log.safeErrorMessage(error);
    let identity = "";
    if (device) {
      const id = device.id || device.devId || (device.bizData && device.bizData.devId) || "unknown";
      const accessory = typeof id === "string" && this.api && this.accessories
        ? this.accessories.get(this.api.hap.uuid.generate(id)) : undefined;
      const name = device.name || (accessory && accessory.displayName) || "unnamed";
      identity = ` ${name} (${id})`;
    }
    const message = `Failed to ${action}${identity}: ${detail}`;
    if (this.logger && typeof this.logger.error === "function") {
      this.logger.error(message);
    } else if (typeof this.logger === "function") {
      this.logger(message);
    }
  }

  async addAccessory(device) {
    var deviceType = device.category;
    if (this.specifiedAccessoryTypes.length > 0) {
      const specifiedDevice = this.specifiedAccessoryTypes.filter((item) => {
        return item.id == device.id;
      });
      if (specifiedDevice.length > 0) {
        deviceType = specifiedDevice[0].type;
      }
    }
    this.log.log(
      `Adding: ${device.name || "unnamed"} (${deviceType} / ${device.id})`
    );
    // Get UUID
    const uuid = this.api.hap.uuid.generate(device.id);
    const homebridgeAccessory = this.accessories.get(uuid);

    // Construct new accessory
    let deviceAccessory;
    switch (deviceType) {
      case "kj":
      case "AirPurifier":
        deviceAccessory = new AirPurifierAccessory(
          this,
          homebridgeAccessory,
          device
        );
        this.accessories.set(uuid, deviceAccessory.homebridgeAccessory);
        this.deviceAccessories.set(uuid, deviceAccessory);
        break;
      case "dj":
      case "dd":
      case "fwd":
      case "tgq":
      case "xdd":
      case "dc":
      case "tgkg":
      case "Light":
        deviceAccessory = new LightAccessory(this, homebridgeAccessory, device);
        this.accessories.set(uuid, deviceAccessory.homebridgeAccessory);
        this.deviceAccessories.set(uuid, deviceAccessory);
        break;
      case "cz":
      case "pc":
      case "Outlet":
        var deviceData = new DataUtil().getSubService(device.status);
        deviceAccessory = new OutletAccessory(
          this,
          homebridgeAccessory,
          device,
          deviceData
        );
        this.accessories.set(uuid, deviceAccessory.homebridgeAccessory);
        this.deviceAccessories.set(uuid, deviceAccessory);
        break;
      case "kg":
      case "tdq":
      case "Switch":
        var deviceData = new DataUtil().getSubService(device.status);
        deviceAccessory = new SwitchAccessory(
          this,
          homebridgeAccessory,
          device,
          deviceData
        );
        this.accessories.set(uuid, deviceAccessory.homebridgeAccessory);
        this.deviceAccessories.set(uuid, deviceAccessory);
        break;
      case "fs":
      case "fskg":
      case "Fanv2":
        deviceAccessory = new Fanv2Accessory(this, homebridgeAccessory, device);
        this.accessories.set(uuid, deviceAccessory.homebridgeAccessory);
        this.deviceAccessories.set(uuid, deviceAccessory);
        break;
      case "ywbj":
      case "SmokeSensor":
        deviceAccessory = new SmokeSensorAccessory(
          this,
          homebridgeAccessory,
          device
        );
        this.accessories.set(uuid, deviceAccessory.homebridgeAccessory);
        this.deviceAccessories.set(uuid, deviceAccessory);
        break;
      case "qn":
      case "Heater":
        deviceAccessory = new HeaterAccessory(
          this,
          homebridgeAccessory,
          device
        );
        this.accessories.set(uuid, deviceAccessory.homebridgeAccessory);
        this.deviceAccessories.set(uuid, deviceAccessory);
        break;
      case "ckmkzq": //garage_door_opener
      case "GarageDoor":
        deviceAccessory = new GarageDoorAccessory(
          this,
          homebridgeAccessory,
          device
        );
        this.accessories.set(uuid, deviceAccessory.homebridgeAccessory);
        this.deviceAccessories.set(uuid, deviceAccessory);
        break;
      case "cl":
      case "WindowCovering":
        deviceAccessory = new WindowCoveringAccessory(
          this,
          homebridgeAccessory,
          device
        );
        this.accessories.set(uuid, deviceAccessory.homebridgeAccessory);
        this.deviceAccessories.set(uuid, deviceAccessory);
        break;
      case "mcs":
      case "ContactSensor":
        deviceAccessory = new ContactSensorAccessory(
          this,
          homebridgeAccessory,
          device
        );
        this.accessories.set(uuid, deviceAccessory.homebridgeAccessory);
        this.deviceAccessories.set(uuid, deviceAccessory);
        break;
      case "rqbj":
      case "jwbj":
      case "LeakSensor":
        deviceAccessory = new LeakSensorAccessory(
          this,
          homebridgeAccessory,
          device
        );
        this.accessories.set(uuid, deviceAccessory.homebridgeAccessory);
        this.deviceAccessories.set(uuid, deviceAccessory);
        break;
      case "wxkg":
      case "WirelessSwitch":
        var deviceData = new DataUtil().getSubService(
          device.status,
          deviceType
        );
        deviceAccessory = new WirelessSwitchAccessory(
          this,
          homebridgeAccessory,
          device,
          deviceData
        );
        this.accessories.set(uuid, deviceAccessory.homebridgeAccessory);
        this.deviceAccessories.set(uuid, deviceAccessory);
        break;
      case "Door":
        deviceAccessory = new DoorAccessory(this, homebridgeAccessory, device);
        this.accessories.set(uuid, deviceAccessory.homebridgeAccessory);
        this.deviceAccessories.set(uuid, deviceAccessory);
        break;
      default:
        break;
    }
    if (deviceAccessory) {
      await this.matterBridge.addAccessory(deviceAccessory.homebridgeAccessory);
    }
  }

  //Handle device deletion, addition, status update
  async onMQTTMessage(message) {
    if (message.bizCode) {
      if (["nameUpdate", "roomCreate", "roomDelete", "roomNameUpdate", "roomSort", "homeUpdate", "delete", "bindUser"].includes(message.bizCode)) {
        invalidateMetadata(this);
      }
      if (message.bizCode == "delete") {
        const uuid = this.api.hap.uuid.generate(message.devId);
        const homebridgeAccessory = this.accessories.get(uuid);
        await this.removeAccessory(homebridgeAccessory);
      } else if (message.bizCode == "bindUser") {
        let deviceInfo = await this.tuyaOpenApi.getDeviceInfo(
          message.bizData.devId
        );
        let functions = await this.tuyaOpenApi.getDeviceFunctions(
          message.bizData.devId
        );
        let device = Object.assign(deviceInfo, functions);
        await this.addAccessory(device);
      }
    } else {
      await this.refreshDeviceStates(message);
    }
  }

  //refresh Accessorie status
  async refreshDeviceStates(message) {
    const uuid = this.api.hap.uuid.generate(message.devId);
    const deviceAccessorie = this.deviceAccessories.get(uuid);
    if (deviceAccessorie) {
      deviceAccessorie.updateState(message);
      // Some datapoints, such as a light's work_mode, change device metadata
      // without changing a HAP characteristic. Reconcile those Matter states too.
      await this.matterBridge.addAccessory(deviceAccessorie.homebridgeAccessory);
    }
  }

  // Called from device classes
  registerPlatformAccessory(platformAccessory) {
    this.log.log(
      `Register Platform Accessory ${platformAccessory.displayName}`
    );
    this.api.registerPlatformAccessories(
      PLUGIN_NAME,
      "TuyaPlatform",
      [platformAccessory]
    );
  }

  // Function invoked when homebridge tries to restore cached accessory.
  // Developer can configure accessory at here (like setup event handler).
  // Update current value.
  configureAccessory(accessory) {
    // this.log("Configuring cached accessory [%s]", accessory.displayName, accessory.context.deviceId, accessory.UUID);
    // Set the accessory to reachable if plugin can currently process the accessory,
    // otherwise set to false and update the reachability later by invoking
    // accessory.updateReachability()
    accessory.reachable = true;
    accessory.on("identify", function (paired, callback) {
      // this.log.debug('[IDENTIFY][%s]', accessory.displayName);
      callback();
    });
    this.accessories.set(accessory.UUID, accessory);
  }

  configureMatterAccessory(accessory) {
    this.matterBridge.configureAccessory(accessory);
  }

  // Sample function to show how developer can remove accessory dynamically from outside event
  async removeAccessory(accessory) {
    if (accessory) {
      this.log.log(`Remove Accessory ${accessory}`);
      this.api.unregisterPlatformAccessories(
        PLUGIN_NAME,
        "TuyaPlatform",
        [accessory]
      );
      this.accessories.delete(accessory.UUID);
      this.deviceAccessories.delete(accessory.UUID);
      await this.matterBridge.removeAccessory(accessory);
    }
  }
}
