const { isDeepStrictEqual } = require('util');
const { AsyncLocalStorage } = require('async_hooks');
const { createMatterDevice } = require('./matter_devices');
const PLUGIN_NAME = require('../package.json').name;
const PLATFORM_NAME = 'TuyaPlatform';
const READ_TIMEOUT_MS = 5000;
const NATIVE_TIMEOUT_MS = 5000;
const NATIVE_POLL_MS = 20;

function copy(value) {
  if (Array.isArray(value)) return value.map(copy);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, copy(item)]));
  }
  return value;
}

function contains(actual, expected) {
  if (isDeepStrictEqual(actual, expected)) return true;
  if (!actual || !expected || typeof actual !== 'object' || typeof expected !== 'object') return false;
  return Object.entries(expected).every(([key, value]) => contains(actual[key], value));
}

/** Mirrors the existing HomeKit drivers through Homebridge's optional Matter API. */
class MatterBridge {
  constructor(api, logger, deviceFactory = createMatterDevice) {
    this.api = api;
    this.log = logger;
    this.matter = api && api.matter;
    if (api && typeof api.isMatterEnabled === 'function' && !api.isMatterEnabled()) {
      this.matter = undefined;
    }
    this.deviceFactory = deviceFactory;
    this.accessories = new Map();
    this.cachedAccessories = new Map();
    this.queue = Promise.resolve();
    this.stateUpdates = new AsyncLocalStorage();
    this.closed = false;
  }

  configureAccessory(accessory) {
    if (this.matter && accessory && accessory.UUID) {
      this.cachedAccessories.set(accessory.UUID, accessory);
    }
  }

  addAccessory(accessory) {
    return this.enqueue(() => this.add(accessory));
  }

  removeAccessory(accessory) {
    return this.enqueue(async () => {
      if (!accessory) return;
      const ids = new Set();
      for (const [uuid, entry] of this.accessories) {
        if (entry.homebridgeAccessory.UUID === accessory.UUID) ids.add(uuid);
      }
      for (const [uuid, cached] of this.cachedAccessories) {
        if (cached.context && cached.context.homebridgeUUID === accessory.UUID) ids.add(uuid);
      }
      for (const uuid of ids) await this.remove(uuid);
    });
  }

  /** Run after a successful discovery, so disabled/deleted devices leave no cached endpoints. */
  reconcileAccessories(accessories) {
    const active = Array.from(accessories || []);
    return this.enqueue(async () => {
      const expected = new Set();
      for (const accessory of active) {
        for (const service of accessory.services || []) {
          if (this.deviceFactory(this.api, accessory, service)) {
            expected.add(this.uuid(accessory, service));
          }
        }
        await this.add(accessory);
      }
      const known = new Set([...this.cachedAccessories.keys(), ...this.accessories.keys()]);
      for (const uuid of known) {
        if (!expected.has(uuid)) {
          try {
            await this.remove(uuid);
          } catch (error) {
            this.report('Could not remove a stale accessory', error);
          }
        }
      }
    });
  }

  close() {
    this.closed = true;
    for (const entry of this.accessories.values()) this.detach(entry);
    // Keep native accessories and pairing data cached across a normal shutdown.
    return this.queue.then(() => {
      for (const entry of this.accessories.values()) this.detach(entry);
    });
  }

  enqueue(operation) {
    if (!this.matter || this.closed) return Promise.resolve();
    this.queue = this.queue.then(async () => {
      if (!this.closed) await operation();
    }).catch(error => this.report('Accessory operation failed', error));
    return this.queue;
  }

  uuid(accessory, service) {
    return this.matter.uuid.generate(`${accessory.UUID}:${service.UUID}:${service.subtype || ''}`);
  }

  async add(accessory) {
    if (!accessory || this.closed) return;
    for (const service of accessory.services || []) {
      try {
        const device = this.deviceFactory(this.api, accessory, service);
        if (!device) continue;
        const uuid = this.uuid(accessory, service);
        const existing = this.accessories.get(uuid);
        if (existing && !existing.removed && existing.service === service) {
          await this.activate(existing);
          await this.sync(existing);
          continue;
        }
        if (existing) await this.remove(uuid);
        await this.readCharacteristics(service);
        if (this.closed) return;
        const descriptor = this.descriptor(accessory, service, uuid, device);
        const entry = {
          descriptor,
          homebridgeAccessory: accessory,
          service,
          device,
          state: {},
          listeners: [],
          removed: false,
          ready: false,
          commandDepth: 0,
          scheduledSync: undefined,
        };
        descriptor.handlers = this.wrapHandlers(entry, device.handlers);
        // Re-registering a restored endpoint reconnects its command handlers.
        await this.matter.registerPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [descriptor]);
        this.accessories.set(uuid, entry);
        this.cachedAccessories.delete(uuid);
        await this.activate(entry);
        if (this.closed) return;
        // Initial clusters are ignored for restored endpoints; explicitly refresh
        // their persisted state from the newly discovered physical device.
        await this.sync(entry);
      } catch (error) {
        this.report(`Could not bridge ${accessory.displayName || accessory.UUID}`, error);
      }
    }
  }

  async activate(entry) {
    if (entry.ready || this.closed) return;
    const firstCluster = Object.keys(entry.descriptor.clusters)[0];
    // Homebridge's bridged API emits an event and resolves before the
    // native manager has finished constructing the endpoint.
    await this.waitForState(entry.descriptor.UUID, firstCluster, state => state !== undefined, 'registration');
    if (this.closed) return;
    for (const characteristic of entry.service.characteristics || []) {
      const listener = () => this.scheduleSync(entry);
      characteristic.on('change', listener);
      entry.listeners.push([characteristic, listener]);
    }
    entry.ready = true;
  }

  descriptor(accessory, service, uuid, device) {
    const Characteristic = this.api.hap.Characteristic;
    const physicalDevice = accessory.controller && accessory.controller.deviceConfig || {};
    const information = (accessory.services || []).find(item =>
      this.api.hap.Service.AccessoryInformation
      && item.UUID === this.api.hap.Service.AccessoryInformation.UUID);
    const metadata = type => {
      const characteristic = information && type && (information.characteristics || [])
        .find(item => item.UUID === type.UUID);
      const value = characteristic && characteristic.value;
      if (value === null || value === undefined || /^Default-(Manufacturer|Model|SerialNumber)$/.test(String(value))) return;
      return value;
    };
    const bounded = value => String(value).slice(0, 32);
    return {
      UUID: uuid,
      displayName: service.displayName || accessory.displayName || 'Tuya device',
      deviceType: device.deviceType,
      manufacturer: bounded(metadata(Characteristic.Manufacturer) || physicalDevice.manufacturer || 'Tuya'),
      model: bounded(metadata(Characteristic.Model) || physicalDevice.product_name || physicalDevice.category || 'Tuya device'),
      serialNumber: bounded(metadata(Characteristic.SerialNumber) || String(accessory.UUID).replace(/-/g, '')),
      context: {
        homebridgeUUID: accessory.UUID,
        deviceId: accessory.context && accessory.context.deviceId,
        serviceUUID: service.UUID,
        serviceSubtype: service.subtype || '',
      },
      clusters: copy(device.getState()),
      handlers: device.handlers,
    };
  }

  async readCharacteristics(service) {
    await Promise.all((service.characteristics || []).filter(characteristic =>
      (typeof characteristic.handleGetRequest === 'function' || typeof characteristic.getValue === 'function')
      && (!characteristic.props || !characteristic.props.perms
        || characteristic.props.perms.includes('pr'))).map(characteristic => new Promise((resolve, reject) => {
      let finished = false;
      const complete = (error, value) => {
        if (finished) return;
        finished = true;
        clearTimeout(timer);
        if (error) reject(error);
        else {
          if (value !== undefined) characteristic.value = value;
          resolve();
        }
      };
      const timer = setTimeout(() => complete(new Error(
        `Timed out reading ${characteristic.displayName || characteristic.UUID}`)), READ_TIMEOUT_MS);
      try {
        if (typeof characteristic.handleGetRequest === 'function') {
          Promise.resolve(characteristic.handleGetRequest()).then(value => complete(null, value), complete);
        } else {
          characteristic.getValue(complete);
        }
      } catch (error) {
        complete(error);
      }
    })));
  }

  async sync(entry) {
    if (this.closed || entry.removed || this.accessories.get(entry.descriptor.UUID) !== entry) return;
    const current = entry.device.getState();
    for (const [cluster, attributes] of Object.entries(current)) {
      const previous = entry.state[cluster] || {};
      const changes = Object.fromEntries(Object.entries(attributes)
        .filter(([key, value]) => !isDeepStrictEqual(previous[key], value)));
      if (!Object.keys(changes).length) continue;
      await this.stateUpdates.run({ entry, cluster }, async () => {
        await this.matter.updateAccessoryState(entry.descriptor.UUID, cluster, copy(changes));
        // The facade also resolves state updates before the native transaction
        // commits. Do not cache success or start another update prematurely.
        await this.waitForState(entry.descriptor.UUID, cluster,
          state => contains(state, changes), 'state update');
      });
      if (!this.closed) entry.state[cluster] = copy(attributes);
    }
  }

  wrapHandlers(entry, handlers) {
    return Object.fromEntries(Object.entries(handlers || {}).map(([cluster, commands]) => [
      cluster,
      Object.fromEntries(Object.entries(commands).map(([name, handler]) => [name, async (...args) => {
        const update = this.stateUpdates.getStore();
        if (update && update.entry === entry && update.cluster === cluster
          && cluster === 'fanControl' && ['fanModeChange', 'percentSettingChange'].includes(name)) {
          // Native FanControl invokes attribute handlers while reflecting
          // external state. Preserve independently arriving controller commands
          // by identifying only this asynchronous update's own callbacks.
          return;
        }
        entry.commandDepth++;
        try {
          return await handler(...args);
        } finally {
          entry.commandDepth--;
          this.scheduleSync(entry);
        }
      }])),
    ]));
  }

  scheduleSync(entry) {
    if (this.closed || entry.removed || entry.commandDepth || entry.scheduledSync) return;
    // Give Homebridge's Matter command transaction time to finish before
    // reflecting characteristic changes, including changes to other clusters.
    entry.scheduledSync = setImmediate(() => {
      entry.scheduledSync = undefined;
      if (!entry.commandDepth) this.enqueue(() => this.sync(entry));
    });
  }

  async remove(uuid) {
    const entry = this.accessories.get(uuid);
    const descriptor = entry ? entry.descriptor : this.cachedAccessories.get(uuid);
    if (!descriptor) return;
    if (entry) {
      entry.removed = true;
      this.detach(entry);
    }
    await this.matter.unregisterPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [descriptor]);
    const cluster = Object.keys(descriptor.clusters || {})[0] || 'bridgedDeviceBasicInformation';
    await this.waitForState(uuid, cluster, state => state === undefined, 'removal');
    this.accessories.delete(uuid);
    this.cachedAccessories.delete(uuid);
  }

  async waitForState(uuid, cluster, ready, operation) {
    const deadline = Date.now() + NATIVE_TIMEOUT_MS;
    while (!this.closed) {
      const state = await this.matter.getAccessoryState(uuid, cluster);
      if (ready(state)) return;
      if (Date.now() >= deadline) {
        throw new Error(`Timed out waiting for Matter ${operation} (${uuid}, ${cluster})`);
      }
      await new Promise(resolve => setTimeout(resolve, NATIVE_POLL_MS));
    }
  }

  detach(entry) {
    if (entry.scheduledSync) clearImmediate(entry.scheduledSync);
    entry.scheduledSync = undefined;
    for (const [characteristic, listener] of entry.listeners) {
      characteristic.removeListener('change', listener);
    }
    entry.listeners = [];
  }

  report(message, error) {
    if (this.log && typeof this.log.error === 'function') {
      this.log.error(`[Matter] ${message}: ${error.message || error}`);
    }
  }
}

module.exports = MatterBridge;
