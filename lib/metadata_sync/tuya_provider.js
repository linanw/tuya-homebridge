const { createHash } = require('node:crypto');

const MAX_BATCH_SIZE = 20;
const MAX_SOURCE_RECORDS = 10000;
const PERMISSION_CODES = new Set(['1106', '28841105', '403', 'permission_denied', 'PERMISSION_DENIED', 'FORBIDDEN']);

function safeError(code) {
  const error = new Error({
    invalid_request: 'Invalid metadata request.',
    unsupported_operation: 'This source does not support the requested metadata operation.',
    wrong_source: 'The metadata target is not a currently managed device.',
    source_unavailable: 'Authoritative source metadata is unavailable.',
    permission_denied: 'The source denied permission for this operation.',
    write_uncertain: 'The source write could not be confirmed; do not automatically retry it.',
  }[code] || 'Metadata operation failed.');
  error.code = code;
  return error;
}

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isName(value) {
  if (typeof value !== 'string' || !value.trim() || /[\u0000-\u001f\u007f-\u009f]/u.test(value)) return false;
  const characters = [...value];
  return characters.length <= 50 && Buffer.byteLength(value, 'utf8') <= 160
    && characters.every(character => {
      const scalar = character.codePointAt(0);
      return scalar < 0xd800 || scalar > 0xdfff;
    });
}

function identifier(value) {
  if (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0) return String(value);
  if (typeof value !== 'string' || !value || value.trim() !== value || value.length > 512
    || /[\u0000-\u001f\u007f-\u009f]/u.test(value)) throw safeError('source_unavailable');
  return value;
}

function recordId(record, aliases) {
  if (!isObject(record)) throw safeError('source_unavailable');
  const ids = aliases.filter(key => record[key] !== undefined && record[key] !== null)
    .map(key => identifier(record[key]));
  if (!ids.length || ids.some(id => id !== ids[0])) throw safeError('source_unavailable');
  return ids[0];
}

function isPermissionError(error) {
  if (PERMISSION_CODES.has(String(error && error.code)) || error && error.response && error.response.status === 403) return true;
  const message = error && typeof error.message === 'string' ? error.message : '';
  const match = message.match(/Tuya API rejected the request \(code ([A-Za-z0-9_-]{1,40})\)/);
  return Boolean(match && PERMISSION_CODES.has(match[1]))
    || /\b(?:HTTP(?:\s+status)?|status)\s*:?\s*403\b/i.test(message);
}

function sourceError(error) {
  return safeError(isPermissionError(error) ? 'permission_denied' : 'source_unavailable');
}

function listResult(response, key) {
  if (!isObject(response) || response.success !== true) throw sourceError(response);
  const result = response.result;
  if (response.has_more === true || response.hasMore === true
    || isObject(result) && (result.has_more === true || result.hasMore === true)) throw safeError('source_unavailable');
  const records = Array.isArray(result) ? result : isObject(result) ? result[key] : undefined;
  if (!Array.isArray(records) || records.length > MAX_SOURCE_RECORDS) throw safeError('source_unavailable');
  return records;
}

function clone(value) {
  return structuredClone(value);
}

function sorted(records) {
  return records.sort((left, right) => left.id.localeCompare(right.id));
}

/**
 * Project-authenticated Tuya metadata only. Raw cloud identifiers and the API
 * client never become part of the public graph or a command error.
 *
 * A future App SDK / end-user provider implements the same read/apply contract
 * separately; cloud project tokens must not silently fall back to another auth
 * model, or turn Custom assets into Smart Home App homes and rooms.
 */
class TuyaMetadataProvider {
  #api;
  #kind;
  #getManagedDevices;
  #bindingForDevice;
  #salt;
  #allowWrites;
  #log;
  #devices = new Map();
  #lastGraph = null;
  #namesAvailable = false;
  #readPromise = null;

  constructor({ api, projectType, getManagedDevices, bindingForDevice, identitySalt, allowWrites = false, log } = {}) {
    if (!api || typeof api.getDeviceListInfo !== 'function' || typeof getManagedDevices !== 'function'
      || typeof identitySalt !== 'string' || !identitySalt.trim()
      || !['1', '2'].includes(String(projectType))) throw safeError('invalid_request');
    this.#api = api;
    this.#kind = String(projectType) === '1' ? 'tuya-project-custom' : 'tuya-project-paas';
    this.#getManagedDevices = getManagedDevices;
    this.#bindingForDevice = typeof bindingForDevice === 'function' ? bindingForDevice : () => null;
    this.#salt = identitySalt;
    this.#allowWrites = allowWrites === true;
    this.#log = log;
  }

  get sourceKind() {
    return this.#kind;
  }

  #id(kind, ...raw) {
    return `${kind}_${createHash('sha256')
      .update(JSON.stringify([this.#salt, this.#kind, kind, ...raw])).digest('hex')}`;
  }

  async #inventory() {
    const records = await this.#getManagedDevices();
    if (!Array.isArray(records) || records.length > MAX_SOURCE_RECORDS) throw safeError('source_unavailable');
    return new Set(records.map(record => recordId(record, ['id'])));
  }

  #describe(available, failureCode) {
    const custom = this.#kind === 'tuya-project-custom';
    const renameDevice = custom && this.#allowWrites && available && typeof this.#api.request === 'function';
    const limitations = {
      moveDevice: custom ? 'custom_assets_are_not_app_rooms' : 'unverified_tuya_room_write_contract',
      renameRoom: custom ? 'custom_assets_are_not_app_rooms' : 'unverified_tuya_room_write_contract',
    };
    if (!renameDevice) limitations.renameDevice = !custom ? 'unverified_tuya_device_write_contract'
      : !this.#allowWrites ? 'writes_disabled' : failureCode || 'source_unavailable';
    if (!available) limitations.read = failureCode || 'source_unavailable';
    return { capabilities: { read: available, renameDevice, moveDevice: false, renameRoom: false }, limitations };
  }

  read() {
    if (!this.#readPromise) {
      this.#readPromise = this.#read().finally(() => { this.#readPromise = null; });
    }
    // Give each caller its own copy, including when cloud reads are coalesced.
    return this.#readPromise.then(clone);
  }

  async #read() {
    let managed;
    try {
      managed = await this.#inventory();
      const names = new Map();
      const ids = [...managed];
      for (let offset = 0; offset < ids.length; offset += MAX_BATCH_SIZE) {
        const batch = ids.slice(offset, offset + MAX_BATCH_SIZE);
        const result = await this.#api.getDeviceListInfo(batch);
        if (!Array.isArray(result) || result.length > MAX_SOURCE_RECORDS) throw sourceError(result);
        const expected = new Set(batch);
        for (const record of result) {
          const rawId = recordId(record, ['id', 'device_id']);
          if (!expected.has(rawId)) continue;
          if (!isName(record.name) || names.has(rawId)) throw safeError('source_unavailable');
          names.set(rawId, record.name);
        }
        if (batch.some(id => !names.has(id))) throw safeError('source_unavailable');
      }
      const current = await this.#inventory();
      if (current.size !== managed.size || [...current].some(id => !managed.has(id))) {
        managed = current;
        throw safeError('source_unavailable');
      }
      const devices = [];
      const targets = new Map();
      for (const rawId of managed) {
        const id = this.#id('d', rawId);
        targets.set(id, rawId);
        devices.push({
          id, name: names.get(rawId), homeId: null, roomId: null,
          roomStatus: this.#kind === 'tuya-project-custom' ? 'unsupported' : 'unknown',
          bindings: await this.#bindings(rawId),
        });
      }
      this.#devices = targets;
      this.#namesAvailable = true;
      let homes = [];
      let rooms = [];
      let roomsAvailable = false;
      let roomsFailure;
      if (this.#kind === 'tuya-project-paas') {
        try {
          const graph = await this.#readRooms(managed);
          homes = graph.homes;
          rooms = graph.rooms;
          for (const device of devices) Object.assign(device, graph.memberships.get(targets.get(device.id)) || {});
          roomsAvailable = true;
        } catch (error) {
          roomsFailure = sourceError(error).code;
          homes = clone(this.#lastGraph && this.#lastGraph.homes || []);
          rooms = clone(this.#lastGraph && this.#lastGraph.rooms || []);
          this.#report('Room information unavailable', roomsFailure);
        }
      }
      const description = this.#describe(true);
      if (roomsFailure) description.limitations.rooms = roomsFailure;
      this.#lastGraph = {
        sourceKind: this.#kind, available: true, roomsAvailable, ...description,
        homes: sorted(homes), rooms: sorted(rooms), devices: sorted(devices),
      };
      return this.#lastGraph;
    } catch (error) {
      this.#namesAvailable = false;
      this.#devices.clear();
      const code = sourceError(error).code;
      const previous = this.#lastGraph || { homes: [], rooms: [], devices: [] };
      const currentIds = managed && new Set([...managed].map(rawId => this.#id('d', rawId)));
      const devices = clone(previous.devices).filter(device => !currentIds || currentIds.has(device.id)).map(device => ({
        ...device, homeId: null, roomId: null,
        roomStatus: this.#kind === 'tuya-project-custom' ? 'unsupported' : 'unknown',
      }));
      this.#report('Device information unavailable', code);
      return {
        sourceKind: this.#kind, available: false, roomsAvailable: false,
        ...this.#describe(false, code),
        homes: clone(previous.homes), rooms: clone(previous.rooms), devices,
      };
    }
  }

  async #bindings(rawId) {
    const empty = { hapSerialNumber: null, hapAccessoryUuid: null, matterUniqueIds: [] };
    try {
      const value = await this.#bindingForDevice(rawId);
      if (!isObject(value)) return empty;
      const label = item => typeof item === 'string' && item.length <= 256 && item.trim()
        && !/[\u0000-\u001f\u007f-\u009f\ud800-\udfff]/u.test(item) ? item : null;
      return {
        hapSerialNumber: label(value.hapSerialNumber),
        hapAccessoryUuid: label(value.hapAccessoryUuid),
        matterUniqueIds: Array.isArray(value.matterUniqueIds)
          ? [...new Set(value.matterUniqueIds.slice(0, 256).map(label).filter(Boolean))].sort().slice(0, 64) : [],
      };
    } catch {
      this.#report('Platform bindings unavailable', 'source_unavailable');
      return empty;
    }
  }

  async #readRooms(managed) {
    if (typeof this.#api.get !== 'function') throw safeError('source_unavailable');
    const uid = identifier(this.#api.tokenInfo && this.#api.tokenInfo.uid);
    const homeRecords = listResult(await this.#api.get(`/v1.0/users/${encodeURIComponent(uid)}/homes`), 'homes');
    const homes = [];
    const rooms = [];
    const memberships = new Map();
    const homeForDevice = new Map();
    const roomForDevice = new Map();
    const homeIds = new Set();
    for (const home of homeRecords) {
      const rawHome = recordId(home, ['home_id', 'id']);
      if (homeIds.has(rawHome) || !isName(home.name)) throw safeError('source_unavailable');
      homeIds.add(rawHome);
      const homeId = this.#id('h', rawHome);
      homes.push({ id: homeId, name: home.name });
      const base = `/v1.0/homes/${encodeURIComponent(rawHome)}`;
      const homeDevices = listResult(await this.#api.get(`${base}/devices`), 'devices');
      for (const device of homeDevices) {
        const rawDevice = recordId(device, ['id', 'device_id']);
        if (!managed.has(rawDevice)) continue;
        if (homeForDevice.has(rawDevice) && homeForDevice.get(rawDevice) !== rawHome) throw safeError('source_unavailable');
        homeForDevice.set(rawDevice, rawHome);
        memberships.set(rawDevice, { homeId, roomId: null, roomStatus: 'unassigned' });
      }
      const roomRecords = listResult(await this.#api.get(`${base}/rooms`), 'rooms');
      const roomIds = new Set();
      for (const room of roomRecords) {
        const rawRoom = recordId(room, ['room_id', 'id']);
        if (roomIds.has(rawRoom) || !isName(room.name)
          || room.home_id !== undefined && identifier(room.home_id) !== rawHome) throw safeError('source_unavailable');
        roomIds.add(rawRoom);
        const roomId = this.#id('r', rawHome, rawRoom);
        rooms.push({ id: roomId, homeId, name: room.name });
        const roomDevices = listResult(await this.#api.get(
          `${base}/rooms/${encodeURIComponent(rawRoom)}/devices`,
        ), 'devices');
        for (const device of roomDevices) {
          const rawDevice = recordId(device, ['id', 'device_id']);
          if (!managed.has(rawDevice)) continue;
          if (homeForDevice.get(rawDevice) !== rawHome
            || roomForDevice.has(rawDevice) && roomForDevice.get(rawDevice) !== roomId) throw safeError('source_unavailable');
          roomForDevice.set(rawDevice, roomId);
          memberships.set(rawDevice, { homeId, roomId, roomStatus: 'assigned' });
        }
      }
    }
    return { homes, rooms, memberships };
  }

  async apply(operation) {
    if (!isObject(operation) || typeof operation.type !== 'string') throw safeError('invalid_request');
    const allowed = {
      refresh: ['type'],
      'device.rename': ['type', 'targetId', 'name'],
      'device.move': ['type', 'targetId', 'roomId'],
      'room.rename': ['type', 'targetId', 'name'],
    }[operation.type];
    if (!allowed) throw safeError('unsupported_operation');
    if (Object.keys(operation).some(key => !allowed.includes(key))) throw safeError('invalid_request');
    if (operation.type === 'refresh') {
      if (!(await this.read()).available) throw safeError('source_unavailable');
      return;
    }
    if (operation.type !== 'device.rename' || this.#kind !== 'tuya-project-custom'
      || !this.#allowWrites || typeof this.#api.request !== 'function') throw safeError('unsupported_operation');
    if (typeof operation.targetId !== 'string' || !isName(operation.name)) throw safeError('invalid_request');
    if (!this.#namesAvailable) throw safeError('source_unavailable');
    const rawId = this.#devices.get(operation.targetId);
    let managed;
    try {
      managed = await this.#inventory();
    } catch (error) {
      throw sourceError(error);
    }
    if (!rawId || !managed.has(rawId)) throw safeError('wrong_source');
    let response;
    try {
      response = await this.#api.request('put',
        `/v1.0/iot-03/devices/${encodeURIComponent(rawId)}`, null, { name: operation.name });
    } catch (error) {
      if (isPermissionError(error)) throw safeError('permission_denied');
      if (error && /Tuya API rejected the request \(code [A-Za-z0-9_-]{1,40}\)/.test(error.message || '')) {
        throw safeError('source_unavailable');
      }
      throw safeError('write_uncertain');
    }
    if (isObject(response) && response.success === false) throw sourceError(response);
    if (!isObject(response) || response.success !== true || response.result !== true) throw safeError('write_uncertain');
    // A successful request is deliberately not a confirmation. The coordinator
    // must read the source again and compare the full requested name.
  }

  #report(message, code) {
    if (!this.#log) return;
    const output = typeof this.#log.warn === 'function' ? this.#log.warn : this.#log.error;
    if (typeof output === 'function') {
      try { output.call(this.#log, `[Metadata] ${message} (${code}).`); } catch {}
    }
  }
}

module.exports = TuyaMetadataProvider;
module.exports.TuyaMetadataProvider = TuyaMetadataProvider;
