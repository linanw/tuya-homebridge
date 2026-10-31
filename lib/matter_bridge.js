const { isDeepStrictEqual } = require('util');
const { AsyncLocalStorage } = require('async_hooks');
const { createMatterDevice } = require('./matter_devices');
const PLUGIN_NAME = require('../package.json').name;
const PLATFORM_NAME = 'TuyaPlatform';
const READ_TIMEOUT_MS = 5000;
const NATIVE_TIMEOUT_MS = 5000;
const NATIVE_POLL_MS = 20;

function utf8Prefix(value, maxBytes) {
  let result = '';
  for (const scalar of String(value)) {
    if (Buffer.byteLength(result + scalar, 'utf8') > maxBytes) break;
    result += scalar;
  }
  return result;
}

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

function hasOccupancyFeatures(state, features) {
  return Boolean(state?.featureMap && Object.entries(features).every(([feature, enabled]) =>
    (state.featureMap[feature] ?? false) === enabled));
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
    this.commandUpdates = new AsyncLocalStorage();
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

  /** Stable controller-visible identities; never synthesize them from labels. */
  async getMetadataBindings(homebridgeUUID) {
    if (!this.matter || this.closed) return [];
    const ids = [];
    for (const entry of this.accessories.values()) {
      if (entry.removed || entry.homebridgeAccessory.UUID !== homebridgeUUID) continue;
      const state = await this.matter.getAccessoryState(entry.descriptor.UUID, 'bridgedDeviceBasicInformation');
      if (typeof state?.uniqueId === 'string' && state.uniqueId) ids.push(state.uniqueId);
    }
    return [...new Set(ids)];
  }

  /** Update metadata in place, preserving endpoint UUIDs, handlers and pairings. */
  updateAccessoryMetadata(accessory, name) {
    return this.enqueue(async () => {
      const entries = [...this.accessories.values()].filter(entry =>
        !entry.removed && entry.homebridgeAccessory.UUID === accessory.UUID);
      for (const entry of entries) {
        // Keep multi-channel identifiers intact and visible. service.displayName
        // is also an internal DP/cache key and must never be renamed here.
        const suffix = entries.length > 1 ? ` ${utf8Prefix(entry.service.displayName || entry.service.subtype || '', 16)}` : '';
        const label = utf8Prefix(name, 32 - Buffer.byteLength(suffix, 'utf8')) + suffix;
        if (entry.descriptor.displayName === label) {
          // The public facade acknowledges before the native cache processes an
          // update, and a first registration may not yet have reached that cache.
          // Republish metadata on source observations so the next cache save can
          // converge; unchanged labels never start another live transaction.
          await this.matter.updatePlatformAccessories([entry.descriptor]);
          continue;
        }
        const attributes = { nodeLabel: label };
        await this.matter.updateAccessoryState(entry.descriptor.UUID, 'bridgedDeviceBasicInformation', attributes);
        await this.waitForState(entry.descriptor.UUID, 'bridgedDeviceBasicInformation', state => contains(state, attributes), 'metadata update');
        const updated = { ...entry.descriptor, displayName: label };
        await this.matter.updatePlatformAccessories([updated]);
        entry.descriptor.displayName = label;
      }
    });
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
        // A fresh unknown presence driver withholds its HAP service so HAP
        // cannot serialize the mandatory default as vacancy. It still owns the
        // sensor identity: keep any existing Matter cache until a valid reading
        // reattaches that same service, without publishing a new endpoint now.
        const pending = accessory.controller;
        const detached = pending?.service;
        const occupancy = this.api.hap?.Service?.OccupancySensor;
        if (pending?.serviceDetached === true
          && occupancy && detached?.UUID === occupancy.UUID
          && this.deviceFactory(this.api, accessory, detached)?.occupancySensingFeatures) {
          expected.add(this.uuid(accessory, detached));
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
        // A presence service remains part of the expected device identity while
        // its source is unknown, but must not register HAP's default "vacant".
        if (device.occupancySensingFeatures && !device.getState().occupancySensing) continue;
        await this.readCharacteristics(service);
        if (this.closed) return;
        const descriptor = this.descriptor(accessory, service, uuid, device);
        if (device.occupancySensingFeatures && !descriptor.clusters.occupancySensing) continue;
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
        await this.prepareCachedPresence(entry);
        if (this.closed) return;
        if (device.occupancySensingFeatures && !device.getState().occupancySensing) continue;
        // Re-registering a restored endpoint reconnects its command handlers.
        await this.matter.registerPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [descriptor]);
        this.accessories.set(uuid, entry);
        this.cachedAccessories.delete(uuid);
        await this.activate(entry);
        if (this.closed) return;
        // Initial clusters are ignored for restored endpoints; explicitly refresh
        // their persisted state from the newly discovered physical device.
        await this.sync(entry);
        await this.normalizeCoveringOnRegistration(entry);
      } catch (error) {
        this.report(`Could not bridge ${accessory.displayName || accessory.UUID}`, error);
      }
    }
  }

  async prepareCachedPresence(entry) {
    const { descriptor, device } = entry;
    if (!device.occupancySensingFeatures || !this.cachedAccessories.has(descriptor.UUID)) return;
    const native = await this.matter.getAccessoryState(descriptor.UUID, 'occupancySensing');
    // Homebridge 2.4 persists only the endpoint type name and restores its
    // friendly MotionSensor default (PIR). Its in-place handler reattachment
    // does not compare detector features. Explicitly composing the bridged-info
    // behavior (already mandatory on bridged sensors) makes native registration
    // await its own structural replacement in one operation. Separate public
    // unregister/register calls cannot provide that barrier: a closing endpoint
    // can already have unreadable state before native unregister has finished.
    if (!native?.featureMap || !device.getState().occupancySensing) return;
    if (hasOccupancyFeatures(native, device.occupancySensingFeatures)) return;
    const info = this.matter.deviceTypes?.BridgedNode?.behaviors?.bridgedDeviceBasicInformation;
    if (!info || typeof descriptor.deviceType.with !== 'function') {
      throw new Error('Homebridge cannot safely restore presence detector features');
    }
    const identity = await this.matter.getAccessoryState(descriptor.UUID, 'bridgedDeviceBasicInformation');
    if (typeof identity?.uniqueId === 'string' && identity.uniqueId) {
      // Preserve the native identity as a behavior default before construction.
      // Homebridge replaces the descriptor's info-cluster options, while an
      // after-registration update would briefly expose a newly generated ID.
      if (typeof info.set !== 'function') {
        throw new Error('Homebridge cannot preserve the presence endpoint identity');
      }
      descriptor.deviceType = descriptor.deviceType.with(info.set({ uniqueId: identity.uniqueId }));
    } else {
      descriptor.deviceType = descriptor.deviceType.with(info);
    }
  }

  async activate(entry) {
    if (entry.ready || this.closed) return;
    const features = entry.device.occupancySensingFeatures;
    const firstCluster = features ? 'occupancySensing' : Object.keys(entry.descriptor.clusters)[0];
    // Homebridge's bridged API emits an event and resolves before the
    // native manager has finished constructing the endpoint.
    await this.waitForState(entry.descriptor.UUID, firstCluster, state => state !== undefined
      && (!features || hasOccupancyFeatures(state, features)), 'registration');
    if (this.closed) return;
    for (const characteristic of entry.service.characteristics || []) {
      const listener = () => {
        // Coalesce a command's own characteristic writes at handler completion.
        // The native behavior updates its command attributes, while physical
        // attributes such as FanControl.percentCurrent still need reconciliation.
        if (this.commandUpdates.getStore()?.entry === entry) return;
        this.scheduleSync(entry);
      };
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
    if (entry.commandDepth) return;
    const current = entry.device.getState();
    for (const [cluster, attributes] of Object.entries(current)) {
      // Native commands change their own state without passing through this
      // cache. Comparing the public current state avoids an unnecessary second
      // native transaction and still reflects a physical return to an old value.
      const previous = Object.hasOwn(entry.state, cluster)
        ? await this.matter.getAccessoryState(entry.descriptor.UUID, cluster) || {}
        : {};
      if (entry.commandDepth) return;
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

  async normalizeCoveringOnRegistration(entry) {
    // Older plugin versions persisted HAP's unreported PositionState default
    // as closing. Native initialization does not recompute that cached motion
    // when target and current positions are already equal. Repair only this
    // reached-target case, once after registration and physical reconciliation.
    const physical = entry.state.windowCovering;
    const target = physical?.targetPositionLiftPercent100ths;
    const current = physical?.currentPositionLiftPercent100ths;
    if (!Number.isFinite(target) || !Number.isFinite(current) || target !== current
      || this.closed || entry.removed || entry.commandDepth) return;
    const cluster = 'windowCovering';
    const native = await this.matter.getAccessoryState(entry.descriptor.UUID, cluster);
    // A controller command may have started while the public state was read.
    if (this.closed || entry.removed || entry.commandDepth
      || native?.targetPositionLiftPercent100ths !== target
      || native?.currentPositionLiftPercent100ths !== current) return;
    // OperationalStatus is a bitmap whose omitted numeric fields default to 0.
    const stopped = state => state && ['global', 'lift', 'tilt'].every(field =>
      (state.operationalStatus?.[field] ?? 0) === 0);
    if (stopped(native)) return;
    await this.stateUpdates.run({ entry, cluster }, async () => {
      await this.matter.updateAccessoryState(entry.descriptor.UUID, cluster, {
        operationalStatus: { global: 0, lift: 0, tilt: 0 },
      });
      await this.waitForState(entry.descriptor.UUID, cluster, state => stopped(state)
        && state.targetPositionLiftPercent100ths === target
        && state.currentPositionLiftPercent100ths === current, 'covering cache update');
    });
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
          return await this.commandUpdates.run({ entry }, () => handler(...args));
        } finally {
          entry.commandDepth--;
          this.scheduleSync(entry);
        }
      }])),
    ]));
  }

  scheduleSync(entry) {
    if (this.closed || entry.removed || entry.commandDepth || entry.scheduledSync) return;
    // Coalesce observations and post-command reconciliation. The live-state
    // comparison skips attributes already updated by the native behavior; this
    // event-loop yield alone is not a native commit barrier.
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
