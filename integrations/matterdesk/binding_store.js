'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { MetadataClientError, isRecord, isUuid, text, clone, snapshot, receipt: validateReceipt } = require('./protocol');

const FILE_NAME = 'tuya-metadata-bindings-v1.json';
const MAX_BYTES = 2 * 1024 * 1024;
const MODES = new Set(['manual', 'followSource', 'bidirectional']);
const error = () => new MetadataClientError('invalid_binding_store');
const exact = (object, keys) => isRecord(object) && Object.keys(object).length === keys.length
  && keys.every(key => Object.hasOwn(object, key));

function binding(value) {
  if (!exact(value, ['endpointId', 'deviceId', 'uniqueId']) || !text(value.endpointId)
    || !text(value.deviceId) || (value.uniqueId !== null && !text(value.uniqueId))) throw error();
  return clone(value);
}

function roomBinding(value) {
  if (!exact(value, ['controllerRoomId', 'sourceRoomId']) || !text(value.controllerRoomId)
    || !text(value.sourceRoomId)) throw error();
  return clone(value);
}

function configuration(value) {
  const keys = ['id', 'serverId', 'sourceHomeId', 'mode', 'bindings', 'roomBindings'];
  if (isRecord(value) && Object.hasOwn(value, 'sourceKind')) keys.push('sourceKind');
  if (!exact(value, keys)
    || !text(value.id, 128) || !isUuid(value.serverId)
    || (value.sourceHomeId !== null && !text(value.sourceHomeId))
    || (value.sourceKind !== undefined && !['tuya-project-paas', 'tuya-project-custom'].includes(value.sourceKind))
    || (value.sourceHomeId === null && value.sourceKind !== 'tuya-project-custom')
    || !MODES.has(value.mode) || !Array.isArray(value.bindings) || value.bindings.length > 2000
    || !Array.isArray(value.roomBindings) || value.roomBindings.length > 2000) throw error();
  const bindings = value.bindings.map(binding);
  const roomBindings = value.roomBindings.map(roomBinding);
  if (new Set(bindings.map(item => item.endpointId)).size !== bindings.length
    || new Set(roomBindings.map(item => item.controllerRoomId)).size !== roomBindings.length
    || new Set(roomBindings.map(item => item.sourceRoomId)).size !== roomBindings.length) throw error();
  if (value.sourceHomeId === null && roomBindings.length !== 0) throw error();
  return { id: value.id, serverId: value.serverId, sourceHomeId: value.sourceHomeId,
    sourceKind: value.sourceKind || 'tuya-project-paas',
    mode: value.mode, bindings, roomBindings };
}

function document(value) {
  if (!exact(value, ['schemaVersion', 'profiles']) || value.schemaVersion !== 1
    || !Array.isArray(value.profiles) || value.profiles.length > 64) throw error();
  const ids = new Set();
  for (const profile of value.profiles) {
    const config = Object.fromEntries(['id', 'serverId', 'sourceHomeId', 'sourceKind', 'mode', 'bindings', 'roomBindings'].map(key => [key, profile[key]]));
    configuration(config);
    if (!exact(profile, [...Object.keys(config), 'sourceEpoch', 'fresh', 'baselines', 'pending'])
      || ids.has(profile.id) || (profile.sourceEpoch !== null && !isUuid(profile.sourceEpoch))
      || typeof profile.fresh !== 'boolean' || !Array.isArray(profile.baselines) || profile.baselines.length > 4000
      || !Array.isArray(profile.pending) || profile.pending.length > 32) throw error();
    ids.add(profile.id);
    const baselines = new Set();
    for (const baseline of profile.baselines) {
      if (!exact(baseline, ['endpointId', 'field', 'value', 'projection']) || !text(baseline.endpointId)
        || !['name', 'roomId'].includes(baseline.field)
        || (baseline.value !== null && !text(baseline.value, 8192))
        || !profile.bindings.some(item => item.endpointId === baseline.endpointId)
        || baselines.has(`${baseline.endpointId}:${baseline.field}`)) throw error();
      baselines.add(`${baseline.endpointId}:${baseline.field}`);
      if (baseline.projection !== null && (!exact(baseline.projection, ['sourceValue', 'controllerValue'])
        || baseline.projection.sourceValue !== baseline.value || !text(baseline.projection.controllerValue, 8192))) throw error();
    }
    const pending = new Set();
    for (const item of profile.pending) {
      if (!exact(item, ['commandId', 'sourceEpoch', 'status']) || !isUuid(item.commandId)
        || !isUuid(item.sourceEpoch) || !['queued', 'uncertain'].includes(item.status)
        || pending.has(item.commandId)) throw error();
      pending.add(item.commandId);
    }
  }
  return clone(value);
}

/** Owns only its dedicated Tuya metadata file, never MatterDesk alias/Mijia data. */
class BindingStore {
  constructor({ directory } = {}) {
    if (typeof directory !== 'string' || !directory) throw error();
    this.directory = directory;
    this.filePath = path.join(directory, FILE_NAME);
    this._queue = Promise.resolve();
    this._opening = null;
    this._closed = false;
    this._closing = null;
  }

  async open() {
    if (this._closed) throw error();
    if (!this._opening) this._opening = this._load();
    await this._opening;
    return clone(this._state);
  }

  async _load() {
    try {
      await fs.promises.mkdir(this.directory, { recursive: true, mode: 0o700 });
      let handle;
      try { handle = await fs.promises.open(this.filePath, fs.constants.O_RDONLY
        | (fs.constants.O_NOFOLLOW || 0) | (fs.constants.O_NONBLOCK || 0)); }
      catch (failure) { if (failure.code !== 'ENOENT') throw failure; }
      if (handle) {
        try {
          const info = await handle.stat();
          if (!info.isFile() || info.size > MAX_BYTES) throw error();
          const buffer = Buffer.alloc(MAX_BYTES + 1);
          let length = 0;
          while (length < buffer.length) {
            const { bytesRead } = await handle.read(buffer, length, buffer.length - length, null);
            if (!bytesRead) break;
            length += bytesRead;
          }
          if (length > MAX_BYTES) throw error();
          this._state = document(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(buffer.subarray(0, length))));
        } finally { await handle.close(); }
      } else this._state = { schemaVersion: 1, profiles: [] };
      for (const profile of this._state.profiles) {
        profile.fresh = false; // Every process requires a fresh authenticated read.
        for (const item of profile.pending) item.status = 'uncertain';
      }
      await this._persist(this._state);
    } catch { this._state = null; throw error(); }
  }

  getProfile(id) {
    if (!this._state || this._closed) throw error();
    const profile = this._state.profiles.find(item => item.id === id);
    return profile ? clone(profile) : null;
  }

  _mutate(action) {
    if (this._closed) return Promise.reject(error());
    const pending = this._queue.then(async () => {
      if (!this._opening) this._opening = this._load();
      await this._opening;
      const next = clone(this._state);
      const result = action(next);
      document(next);
      await this._persist(next);
      this._state = next;
      return clone(result);
    });
    this._queue = pending.catch(() => {});
    return pending;
  }

  saveProfile(input) {
    const config = configuration(input);
    return this._mutate(state => {
      const previous = state.profiles.find(item => item.id === config.id);
      const unchangedBindings = previous && previous.serverId === config.serverId
        && previous.sourceHomeId === config.sourceHomeId
        && previous.sourceKind === config.sourceKind
        && JSON.stringify(previous.bindings) === JSON.stringify(config.bindings)
        && JSON.stringify(previous.roomBindings) === JSON.stringify(config.roomBindings);
      const unchanged = unchangedBindings && previous.mode === config.mode;
      if (previous?.pending.length && !unchanged) throw new MetadataClientError('write_uncertain');
      const profile = { ...config, sourceEpoch: unchangedBindings ? previous.sourceEpoch : null,
        fresh: false, baselines: unchangedBindings ? previous.baselines : [],
        pending: unchanged ? previous.pending : [] };
      state.profiles = state.profiles.filter(item => item.id !== config.id).concat(profile);
      return profile;
    });
  }

  observeEpoch(id, current) {
    const source = snapshot(current);
    return this._mutate(state => {
      const profile = this._profile(state, id);
      if (profile.serverId !== source.serverId || profile.sourceKind !== source.sourceKind) throw new MetadataClientError('wrong_source');
      if (profile.sourceHomeId !== null && source.available
        && !source.homes.some(home => home.id === profile.sourceHomeId)) throw new MetadataClientError('missing_binding');
      if (profile.sourceEpoch !== source.sourceEpoch) {
        for (const pending of profile.pending) pending.status = 'uncertain';
      }
      profile.sourceEpoch = source.sourceEpoch;
      profile.fresh = source.available && source.capabilities.read;
      return profile;
    });
  }

  recordPending(id, { commandId, sourceEpoch } = {}) {
    if (!isUuid(commandId) || !isUuid(sourceEpoch)) throw error();
    return this._mutate(state => {
      const profile = this._profile(state, id);
      if (!profile.fresh || profile.sourceEpoch !== sourceEpoch || profile.mode !== 'bidirectional') {
        throw new MetadataClientError('wrong_source');
      }
      if (profile.pending.some(item => item.status === 'uncertain' || item.commandId === commandId)) {
        throw new MetadataClientError('write_uncertain');
      }
      if (!profile.pending.some(item => item.commandId === commandId)) {
        if (profile.pending.length >= 32) throw new MetadataClientError('queue_full');
        profile.pending.push({ commandId, sourceEpoch, status: 'queued' });
      }
      return profile;
    });
  }

  finishPending(id, receipt) {
    if (!isRecord(receipt) || !isUuid(receipt.commandId)
      || !['confirmed', 'failed', 'conflict', 'uncertain'].includes(receipt.status)) throw error();
    const result = validateReceipt(receipt, receipt.commandId);
    return this._mutate(state => {
      const profile = this._profile(state, id);
      if (result.snapshot && result.snapshot.serverId !== profile.serverId) throw new MetadataClientError('wrong_source');
      if (receipt.status === 'uncertain') {
        const pending = profile.pending.find(item => item.commandId === receipt.commandId);
        if (pending) pending.status = 'uncertain';
      } else profile.pending = profile.pending.filter(item => item.commandId !== receipt.commandId);
      return profile;
    });
  }

  markUncertain(id, commandId) {
    if (!isUuid(commandId)) throw error();
    return this.finishPending(id, { schemaVersion: 1, commandId,
      status: 'uncertain', code: 'write_uncertain', snapshot: null });
  }

  /** Explicit human acknowledgement after reconciling a lost write's outcome. */
  acknowledgeUncertain(id, commandId) {
    if (!isUuid(commandId)) throw error();
    return this._mutate(state => {
      const profile = this._profile(state, id);
      if (!profile.fresh) throw new MetadataClientError('source_unavailable');
      const pending = profile.pending.find(item => item.commandId === commandId);
      if (!pending || pending.status !== 'uncertain') throw new MetadataClientError('invalid_request');
      profile.pending = profile.pending.filter(item => item.commandId !== commandId);
      return profile;
    });
  }

  confirmBaseline(id, { endpointId, field, sourceValue, controllerValue,
    sourceConfirmed, controllerConfirmed, recordedProjection = null } = {}) {
    if (!text(endpointId) || !['name', 'roomId'].includes(field)
      || sourceConfirmed !== true || controllerConfirmed !== true
      || (sourceValue !== null && !text(sourceValue, 8192))
      || (field === 'name' && sourceValue === null)) throw error();
    const projected = recordedProjection && exact(recordedProjection, ['sourceValue', 'controllerValue'])
      && recordedProjection.sourceValue === sourceValue && recordedProjection.controllerValue === controllerValue
      && text(controllerValue, 8192);
    if (sourceValue !== controllerValue && !projected) throw new MetadataClientError('confirmation_failed');
    return this._mutate(state => {
      const profile = this._profile(state, id);
      if (!profile.fresh || !profile.bindings.some(item => item.endpointId === endpointId)) throw new MetadataClientError('missing_binding');
      const baseline = { endpointId, field, value: sourceValue,
        projection: projected ? clone(recordedProjection) : null };
      profile.baselines = profile.baselines.filter(item => item.endpointId !== endpointId || item.field !== field).concat(baseline);
      return profile;
    });
  }

  _profile(state, id) {
    const profile = state.profiles.find(item => item.id === id);
    if (!profile) throw new MetadataClientError('missing_binding');
    return profile;
  }

  async _persist(state) {
    const body = JSON.stringify(document(state)) + '\n';
    if (Buffer.byteLength(body) > MAX_BYTES) throw error();
    const temporary = this.filePath + '.tmp-' + randomUUID();
    let handle;
    try {
      handle = await fs.promises.open(temporary, 'wx', 0o600);
      await handle.writeFile(body);
      await handle.sync();
      await handle.close(); handle = null;
      await fs.promises.rename(temporary, this.filePath);
    } catch { throw error(); }
    finally {
      if (handle) await handle.close().catch(() => {});
      await fs.promises.unlink(temporary).catch(() => {});
    }
  }

  close() {
    if (!this._closing) {
      this._closed = true;
      this._closing = (async () => {
        if (this._opening) await this._opening;
        await this._queue;
      })();
    }
    return this._closing;
  }
}

module.exports = { BindingStore };
