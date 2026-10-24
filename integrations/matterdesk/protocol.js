'use strict';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const REVISION = /^(0|[1-9][0-9]{0,39})$/;
const STATUSES = new Set(['queued', 'running', 'confirmed', 'conflict', 'failed', 'uncertain']);
const ERROR_CODES = new Set(['stale_revision', 'wrong_source', 'unsupported_operation',
  'source_unavailable', 'permission_denied', 'confirmation_failed', 'write_uncertain',
  'invalid_request', 'queue_full', 'not_found', 'request_too_large', 'request_timeout']);
const isRecord = value => value !== null && typeof value === 'object' && !Array.isArray(value)
  && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
const text = (value, limit = 256) => typeof value === 'string' && value.length > 0
  && value.length <= limit && !/[\u0000-\u001f\u007f-\u009f\uD800-\uDFFF]/u.test(value);
const isUuid = value => typeof value === 'string' && UUID.test(value);
const clone = value => JSON.parse(JSON.stringify(value));

class MetadataClientError extends Error {
  constructor(code, statusCode = 0, commandId) {
    super(`Metadata request failed (${code})`);
    this.name = 'MetadataClientError';
    this.code = code;
    this.statusCode = statusCode;
    if (commandId) this.commandId = commandId;
  }
}

function invalid() { throw new MetadataClientError('invalid_response'); }
function nameIsWritable(value) {
  return text(value, 320) && value.trim().length > 0 && [...value].length <= 50
    && Buffer.byteLength(value, 'utf8') <= 160;
}

function capabilities(value) {
  if (!isRecord(value) || value.schemaVersion !== 1 || !isUuid(value.serverId)
    || !isUuid(value.sourceEpoch) || typeof value.revision !== 'string' || !REVISION.test(value.revision)
    || (value.observedAt !== null && (typeof value.observedAt !== 'string' || !Number.isFinite(Date.parse(value.observedAt))))
    || !text(value.sourceKind, 80) || typeof value.available !== 'boolean'
    || typeof value.roomsAvailable !== 'boolean' || !isRecord(value.capabilities)) invalid();
  const supported = {};
  const limitations = {};
  for (const key of ['read', 'renameDevice', 'moveDevice', 'renameRoom']) {
    if (typeof value.capabilities[key] !== 'boolean') invalid();
    supported[key] = value.capabilities[key];
    const reason = value.limitations && value.limitations[key];
    if (typeof reason === 'string' && /^[a-z][a-z0-9_]{0,79}$/.test(reason)) limitations[key] = reason;
  }
  return { schemaVersion: 1, serverId: value.serverId, sourceEpoch: value.sourceEpoch,
    revision: value.revision, observedAt: value.observedAt, sourceKind: value.sourceKind,
    available: value.available, roomsAvailable: value.roomsAvailable,
    capabilities: supported, limitations };
}

function snapshot(value) {
  const result = capabilities(value);
  if (!Array.isArray(value.homes) || !Array.isArray(value.rooms) || !Array.isArray(value.devices)) invalid();
  const record = item => {
    if (!isRecord(item) || !text(item.id) || !text(item.name, 8192)) invalid();
    return { id: item.id, name: item.name };
  };
  result.homes = value.homes.map(record);
  result.rooms = value.rooms.map(item => {
    const room = record(item);
    if (!text(item.homeId)) invalid();
    return { ...room, homeId: item.homeId };
  });
  const nullable = value => { if (value !== null && !text(value)) invalid(); return value; };
  result.devices = value.devices.map(item => {
    const device = record(item);
    if (!['assigned', 'unassigned', 'unknown', 'unsupported'].includes(item.roomStatus)
      || !isRecord(item.bindings) || !Array.isArray(item.bindings.matterUniqueIds)
      || item.bindings.matterUniqueIds.length > 64
      || !item.bindings.matterUniqueIds.every(id => text(id))) invalid();
    return { ...device, homeId: nullable(item.homeId), roomId: nullable(item.roomId), roomStatus: item.roomStatus,
      bindings: { hapSerialNumber: nullable(item.bindings.hapSerialNumber),
        hapAccessoryUuid: nullable(item.bindings.hapAccessoryUuid),
        matterUniqueIds: [...new Set(item.bindings.matterUniqueIds)] } };
  });
  for (const records of [result.homes, result.rooms, result.devices]) {
    if (new Set(records.map(item => item.id)).size !== records.length) invalid();
  }
  if (result.devices.some(device =>
    (device.roomStatus === 'assigned' && (device.homeId === null || device.roomId === null))
    || (device.roomStatus === 'unassigned' && device.roomId !== null))) invalid();
  if (result.roomsAvailable) {
    const homes = new Set(result.homes.map(home => home.id));
    const rooms = new Map(result.rooms.map(room => [room.id, room]));
    if (result.rooms.some(room => !homes.has(room.homeId)) || result.devices.some(device =>
      (device.homeId !== null && !homes.has(device.homeId))
      || (device.roomStatus === 'assigned' && rooms.get(device.roomId)?.homeId !== device.homeId))) invalid();
  }
  return result;
}

function receipt(value, expectedId) {
  if (!isRecord(value) || value.schemaVersion !== 1 || !isUuid(value.commandId)
    || value.commandId !== expectedId || !STATUSES.has(value.status)
    || (value.code !== null && typeof value.code !== 'string')) invalid();
  const current = value.snapshot == null ? null : snapshot(value.snapshot);
  if (value.status === 'confirmed' && (!current || !current.available || !current.capabilities.read
    || current.observedAt === null || value.code !== null)) invalid();
  return { schemaVersion: 1, commandId: value.commandId, status: value.status,
    code: ERROR_CODES.has(value.code) ? value.code : value.code === null ? null : 'request_failed',
    snapshot: current };
}

function operation(value, source) {
  const bad = () => { throw new MetadataClientError('invalid_request'); };
  const keys = names => isRecord(value) && Object.keys(value).length === names.length
    && names.every(name => Object.hasOwn(value, name));
  if (!isRecord(value) || typeof value.type !== 'string') bad();
  if (value.type === 'refresh') {
    if (!keys(['type'])) bad();
    return { type: 'refresh' };
  }
  const capability = { 'device.rename': 'renameDevice', 'device.move': 'moveDevice', 'room.rename': 'renameRoom' }[value.type];
  if (!capability) throw new MetadataClientError('unsupported_operation');
  if (!source.capabilities[capability]) throw new MetadataClientError('unsupported_operation');
  if (!source.available || !source.capabilities.read
    || (value.type !== 'device.rename' && !source.roomsAvailable)) {
    throw new MetadataClientError('source_unavailable');
  }
  if (value.type === 'device.move') {
    if (!keys(['type', 'targetId', 'roomId']) || !text(value.targetId) || !text(value.roomId)) bad();
    const device = source.devices.find(item => item.id === value.targetId);
    const room = source.rooms.find(item => item.id === value.roomId);
    if (!device || !room || !['assigned', 'unassigned'].includes(device.roomStatus)
      || device.homeId !== room.homeId) bad();
  } else {
    if (!keys(['type', 'targetId', 'name']) || !text(value.targetId) || !nameIsWritable(value.name)) bad();
    const records = value.type === 'room.rename' ? source.rooms : source.devices;
    if (!records.some(item => item.id === value.targetId)) bad();
  }
  return clone(value);
}

module.exports = { MetadataClientError, ERROR_CODES, STATUSES, isRecord, isUuid, text,
  nameIsWritable, capabilities, snapshot, receipt, operation, clone };
