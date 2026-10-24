const fs = require('node:fs/promises');
const path = require('node:path');
const TuyaMetadataProvider = require('./tuya_provider');
const { MetadataCoordinator } = require('./coordinator');
const { MetadataHttpServer } = require('./http_server');

// Projected labels are not the authoritative cloud name. Keep the full name in
// the source snapshot and driver config; never reverse-sync this truncation.
function utf8Prefix(value, maxBytes) {
  let result = '';
  for (const scalar of String(value)) {
    if (Buffer.byteLength(result + scalar, 'utf8') > maxBytes) break;
    result += scalar;
  }
  return result;
}

async function bindingsForDevice(platform, rawId) {
  const uuid = platform.api.hap.uuid.generate(rawId);
  const accessory = platform.accessories.get(uuid);
  if (!accessory) return { hapSerialNumber: null, hapAccessoryUuid: null, matterUniqueIds: [] };
  const { Service, Characteristic } = platform.api.hap;
  const serialOf = candidate => {
    const info = candidate.getService(Service.AccessoryInformation);
    const serial = info && info.characteristics.find(c => c.UUID === Characteristic.SerialNumber.UUID)?.value;
    return typeof serial === 'string' && serial && !/^Default-/.test(serial) ? serial : null;
  };
  const serial = serialOf(accessory);
  const unique = serial && [...platform.accessories.values()].filter(a => serialOf(a) === serial).length === 1;
  return {
    hapSerialNumber: unique ? serial : null,
    // Informational Homebridge UUID, not an HMAccessory UUID on the Mac.
    hapAccessoryUuid: uuid,
    matterUniqueIds: await platform.matterBridge.getMetadataBindings(uuid),
  };
}

async function projectSnapshot(platform, snapshot) {
  if (!snapshot.available) return;
  const { Service, Characteristic } = platform.api.hap;
  const changed = [];
  for (const device of snapshot.devices) {
    const uuid = device.bindings?.hapAccessoryUuid;
    const driver = uuid && platform.deviceAccessories.get(uuid);
    if (!driver || !device.name) continue;
    const accessory = driver.homebridgeAccessory;
    const label = utf8Prefix(device.name, 64);
    driver.deviceConfig.name = device.name;
    const info = accessory.getService(Service.AccessoryInformation);
    const primaryServices = accessory.services.filter(service => service.UUID !== Service.AccessoryInformation.UUID);
    if (accessory.displayName !== label || info?.getCharacteristic(Characteristic.Name).value !== label) {
      accessory.updateDisplayName(label);
      info?.updateCharacteristic(Characteristic.Name, label);
      changed.push(accessory);
    }
    // Multi-channel Switch/Outlet service.displayName is the DP/cache key in
    // legacy drivers. Preserve it (and UUID/subtype) through every rename.
    if (primaryServices.length === 1) primaryServices[0].updateCharacteristic(Characteristic.Name, label);
    await platform.matterBridge.updateAccessoryMetadata(accessory, device.name);
  }
  if (changed.length) platform.api.updatePlatformAccessories(changed);
}

function startMetadataSync(platform) {
  const options = platform.config?.options?.metadataSync;
  if (!options?.enabled || platform.metadataStopped) return Promise.resolve();
  if (!platform.metadataStartPromise) platform.metadataStartPromise = startMetadataSyncOnce(platform, options);
  return platform.metadataStartPromise;
}

async function startMetadataSyncOnce(platform, options) {
  let coordinator;
  let server;
  try {
    const envName = options.tokenEnv || 'TUYA_METADATA_TOKEN';
    if (typeof envName !== 'string' || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(envName)) throw new Error('invalid_config');
    const token = process.env[envName];
    if (typeof token !== 'string' || token.length < 32 || /\s/.test(token)) throw new Error('missing_token');
    platform.log.addSecrets(token);
    const host = options.host || '127.0.0.1';
    const port = options.port === undefined ? 8787 : options.port;
    if (typeof host !== 'string' || !Number.isInteger(port) || port < 1 || port > 65535) throw new Error('invalid_config');
    let tls;
    if (options.tlsCertPath || options.tlsKeyPath) {
      if (typeof options.tlsCertPath !== 'string' || typeof options.tlsKeyPath !== 'string') throw new Error('invalid_config');
      const [cert, key] = await Promise.all([fs.readFile(options.tlsCertPath), fs.readFile(options.tlsKeyPath)]);
      tls = { cert, key };
    }
    // No account information is placed in filenames or exported snapshots.
    const accountKey = JSON.stringify([
      platform.config.options.projectType || '2', platform.tuyaOpenApi.endpoint,
      platform.config.options.accessId, platform.config.options.username,
      String(platform.config.options.appSchema || '').toLowerCase(),
      String(platform.config.options.countryCode || ''),
      platform.tuyaOpenApi.tokenInfo?.uid || '',
    ]);
    coordinator = new MetadataCoordinator({
      storagePath: path.join(platform.api.user.storagePath(), 'tuya-metadata-sync'),
      accountKey,
      pollIntervalSeconds: options.pollIntervalSeconds ?? 300,
      provider: ({ identitySalt }) => new TuyaMetadataProvider({
        api: platform.tuyaOpenApi,
        projectType: platform.config.options.projectType || '2',
        getManagedDevices: () => [...platform.deviceAccessories.values()].map(driver => driver.deviceConfig),
        bindingForDevice: rawId => bindingsForDevice(platform, rawId),
        identitySalt,
        allowWrites: options.allowWrites === true,
        log: platform.logger,
      }),
      onSnapshot: snapshot => {
        const projection = (platform.metadataProjectionTail || Promise.resolve())
          .then(() => platform.metadataStopped ? undefined : projectSnapshot(platform, snapshot));
        platform.metadataProjectionTail = projection.catch(() => {});
        return projection;
      },
      log: platform.logger,
    });
    // Validate transport policy before starting a source poll.
    server = new MetadataHttpServer({ coordinator, token, host, port, tls, log: platform.logger });
    platform.metadataStartingCoordinator = coordinator;
    platform.metadataStartingServer = server;
    await coordinator.start();
    if (platform.metadataStopped) {
      await server.close();
      await coordinator.close();
      return;
    }
    const address = await server.start();
    if (platform.metadataStopped) {
      await server.close();
      await coordinator.close();
      return;
    }
    platform.metadataCoordinator = coordinator;
    platform.metadataServer = server;
    platform.metadataStopped = false;
    platform.logger?.info?.(`[Metadata] Sync service listening on ${tls ? 'HTTPS' : 'loopback HTTP'} port ${address.port}.`);
  } catch (error) {
    await server?.close().catch(() => {});
    await coordinator?.close().catch(() => {});
    if (platform.metadataStopped) return;
    const reason = error.message === 'missing_token' ? 'Set a separate access token of at least 32 characters in the configured environment variable.' :
      'Check the metadata settings, token, storage permissions, port and TLS configuration.';
    platform.logger?.error?.(`[Metadata] Sync service could not start. ${reason}`);
  } finally {
    platform.metadataStartingCoordinator = undefined;
    platform.metadataStartingServer = undefined;
  }
}

// Invalidation events are a hint only. Fetch the authoritative source without
// forwarding guessed event room IDs, and bound cloud traffic during bursts.
function invalidateMetadata(platform) {
  if (!platform.metadataCoordinator || platform.metadataStopped || platform.metadataRefreshTimer) return;
  const delay = Math.max(500, 60000 - (Date.now() - (platform.metadataLastEventRefresh || 0)));
  platform.metadataRefreshTimer = setTimeout(() => {
    platform.metadataRefreshTimer = undefined;
    if (platform.metadataStopped) return;
    platform.metadataLastEventRefresh = Date.now();
    platform.metadataCoordinator.refresh().catch(() => {});
  }, delay);
  platform.metadataRefreshTimer.unref?.();
}

async function stopMetadataSync(platform) {
  platform.metadataStopped = true;
  clearTimeout(platform.metadataRefreshTimer);
  platform.metadataRefreshTimer = undefined;
  await platform.metadataStartPromise;
  await platform.metadataServer?.close();
  await platform.metadataCoordinator?.close();
}

module.exports = { startMetadataSync, stopMetadataSync, invalidateMetadata, projectSnapshot, bindingsForDevice, utf8Prefix };
