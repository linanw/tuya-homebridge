'use strict';

const { createHash } = require('node:crypto');

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const REVISION = /^(0|[1-9][0-9]{0,39})$/;
const CONTROLS = /[\u0000-\u001f\u007f-\u009f]/u;
const CAPABILITIES = ['read', 'renameDevice', 'moveDevice', 'renameRoom'];

class MetadataError extends Error {
    constructor(code, statusCode = 400) {
        super(code);
        this.name = 'MetadataError';
        this.code = code;
        this.statusCode = statusCode;
    }
}

function object(value) {
    return value !== null && typeof value === 'object' && !Array.isArray(value)
        && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
}

function text(value, maximum = 256) {
    return typeof value === 'string' && value.length > 0 && value.length <= maximum
        && !CONTROLS.test(value) && !/[\uD800-\uDFFF]/u.test(value);
}

function exactKeys(value, keys) {
    return object(value) && Object.keys(value).length === keys.length
        && keys.every(key => Object.hasOwn(value, key));
}

function validName(value) {
    return text(value, 320) && value.trim().length > 0 && [...value].length <= 50
        && Buffer.byteLength(value, 'utf8') <= 160;
}

function canonical(value) {
    if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
    if (object(value)) return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`;
    return JSON.stringify(value);
}

function validateCommand(value) {
    const fail = () => { throw new MetadataError('invalid_request'); };
    if (!exactKeys(value, ['schemaVersion', 'commandId', 'expected', 'operation'])
        || value.schemaVersion !== 1 || typeof value.commandId !== 'string' || !UUID.test(value.commandId)
        || !exactKeys(value.expected, ['serverId', 'sourceEpoch', 'revision'])
        || typeof value.expected.serverId !== 'string' || !UUID.test(value.expected.serverId)
        || typeof value.expected.sourceEpoch !== 'string' || !UUID.test(value.expected.sourceEpoch)
        || typeof value.expected.revision !== 'string' || !REVISION.test(value.expected.revision)
        || !object(value.operation)) fail();
    const operation = value.operation;
    if (operation.type === 'refresh') {
        if (!exactKeys(operation, ['type'])) fail();
    } else if (operation.type === 'device.rename' || operation.type === 'room.rename') {
        if (!exactKeys(operation, ['type', 'targetId', 'name'])
            || !text(operation.targetId) || !validName(operation.name)) fail();
    } else if (operation.type === 'device.move') {
        if (!exactKeys(operation, ['type', 'targetId', 'roomId'])
            || !text(operation.targetId) || !text(operation.roomId)) fail();
    } else {
        throw new MetadataError('unsupported_operation', 422);
    }
    // The API is JSON only. Clone the validated envelope, retaining full names.
    const command = JSON.parse(JSON.stringify(value));
    return { command, fingerprint: createHash('sha256').update(canonical(command)).digest('hex') };
}

function normalizeSource(value) {
    const invalid = () => { throw new MetadataError('source_unavailable', 503); };
    if (!object(value) || typeof value.available !== 'boolean' || typeof value.roomsAvailable !== 'boolean'
        || !text(value.sourceKind, 80) || !object(value.capabilities)
        || !CAPABILITIES.every(key => typeof value.capabilities[key] === 'boolean')
        || !Array.isArray(value.homes) || !Array.isArray(value.rooms) || !Array.isArray(value.devices)) invalid();
    const capabilities = Object.fromEntries(CAPABILITIES.map(key => [key, value.capabilities[key]]));
    const limitations = {};
    if (value.limitations !== undefined && !object(value.limitations)) invalid();
    for (const key of CAPABILITIES) {
        const reason = value.limitations?.[key];
        if (typeof reason === 'string' && /^[a-z][a-z0-9_]{0,79}$/.test(reason)) limitations[key] = reason;
    }
    const seen = new Set();
    const identifier = (id, nullable = false) => {
        if (nullable && id === null) return null;
        if (!text(id)) invalid();
        return id;
    };
    const record = item => {
        if (!object(item) || !text(item.id) || !text(item.name, 8192) || seen.has(item.id)) invalid();
        seen.add(item.id);
        return { id: item.id, name: item.name };
    };
    const homes = value.homes.map(record);
    const rooms = value.rooms.map(item => ({ ...record(item), homeId: identifier(item.homeId) }));
    const devices = value.devices.map(item => {
        const base = record(item);
        if (!['assigned', 'unassigned', 'unknown', 'unsupported'].includes(item.roomStatus)
            || !object(item.bindings) || !Array.isArray(item.bindings.matterUniqueIds)
            || item.bindings.matterUniqueIds.length > 64) invalid();
        const nullable = input => input === null ? null : identifier(input);
        const device = {
            ...base,
            homeId: identifier(item.homeId, true),
            roomId: identifier(item.roomId, true),
            roomStatus: item.roomStatus,
            bindings: {
                hapSerialNumber: nullable(item.bindings.hapSerialNumber),
                hapAccessoryUuid: nullable(item.bindings.hapAccessoryUuid),
                matterUniqueIds: [...new Set(item.bindings.matterUniqueIds.map(id => identifier(id)))].sort(),
            },
        };
        if (device.roomStatus === 'assigned' && (device.homeId === null || device.roomId === null)) invalid();
        if (device.roomStatus === 'unassigned' && device.roomId !== null) invalid();
        return device;
    });
    if (value.roomsAvailable) {
        const homeIds = new Set(homes.map(home => home.id));
        const roomMap = new Map(rooms.map(room => [room.id, room]));
        if (rooms.some(room => !homeIds.has(room.homeId)) || devices.some(device =>
            (device.homeId !== null && !homeIds.has(device.homeId))
            || (device.roomStatus === 'assigned' && roomMap.get(device.roomId)?.homeId !== device.homeId))) invalid();
    }
    const byId = (left, right) => left.id < right.id ? -1 : left.id > right.id ? 1 : 0;
    const normalized = { sourceKind: value.sourceKind, available: value.available, roomsAvailable: value.roomsAvailable,
        capabilities, limitations, homes: homes.sort(byId), rooms: rooms.sort(byId), devices: devices.sort(byId) };
    if (Buffer.byteLength(JSON.stringify(normalized)) > 3 * 1024 * 1024) invalid();
    return normalized;
}

module.exports = { MetadataError, validateCommand, normalizeSource, canonical, UUID, REVISION };
