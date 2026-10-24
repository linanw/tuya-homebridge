'use strict';

const { randomUUID } = require('node:crypto');
const { MetadataStore } = require('./store');
const { MetadataError, validateCommand, normalizeSource, canonical, REVISION } = require('./validation');

const HISTORY_LIMIT = 200;
const QUEUE_LIMIT = 32;
const OPERATION_TIMEOUT_MS = 15000;
const TERMINAL = new Set(['confirmed', 'conflict', 'failed', 'uncertain']);
const CAPABILITY = { 'device.rename': 'renameDevice', 'device.move': 'moveDevice', 'room.rename': 'renameRoom' };
const clone = value => JSON.parse(JSON.stringify(value));

class MetadataCoordinator {
    constructor(options = {}) {
        if (!options.provider) throw new MetadataError('invalid_request');
        this._options = options;
        this._store = new MetadataStore({ storagePath: options.storagePath, accountKey: options.accountKey });
        this._sourceEpoch = randomUUID();
        this._tail = Promise.resolve();
        this._projectionTail = Promise.resolve();
        this._records = [];
        this._refreshPromise = null;
        this._closing = false;
        const interval = options.pollIntervalSeconds ?? 300;
        if (!Number.isFinite(interval) || interval < 60) throw new MetadataError('invalid_request');
        this._pollInterval = interval * 1000;
    }

    _log(message) {
        try { this._options.log?.error?.(`[Metadata Sync] ${message}`); } catch (_) { /* Logging cannot interrupt synchronization. */ }
    }

    async start() {
        if (this._closing) throw new MetadataError('source_unavailable', 503);
        if (!this._startPromise) this._startPromise = this._start();
        return this._startPromise;
    }

    async _start() {
        this._state = await this._store.open();
        this._provider = typeof this._options.provider === 'function'
            ? await this._options.provider({ serverId: this._state.serverId, identitySalt: this._state.identitySalt })
            : this._options.provider;
        if (!this._provider || typeof this._provider.read !== 'function') throw new MetadataError('invalid_request');
        const previous = this._state.snapshot;
        let source = {
            sourceKind: typeof this._provider.sourceKind === 'string' ? this._provider.sourceKind : 'unavailable',
            available: false, roomsAvailable: false,
            capabilities: { read: false, renameDevice: false, moveDevice: false, renameRoom: false },
            limitations: { read: 'source_unavailable' }, homes: [], rooms: [], devices: [],
        };
        if (previous) source = normalizeSource(previous);
        this._snapshot = {
            schemaVersion: 1, serverId: this._state.serverId, sourceEpoch: this._sourceEpoch,
            revision: previous && typeof previous.revision === 'string' && REVISION.test(previous.revision) ? previous.revision : '0',
            observedAt: typeof previous?.observedAt === 'string' ? previous.observedAt : null,
            ...source, available: false, roomsAvailable: false,
        };
        this._records = this._state.commands.map(record => {
            const validated = validateCommand(record.command);
            if (validated.fingerprint !== record.fingerprint || !['queued', 'running', ...TERMINAL].includes(record.status)) {
                throw new MetadataError('source_unavailable', 503);
            }
            return { command: validated.command, fingerprint: validated.fingerprint,
                status: TERMINAL.has(record.status) ? record.status : 'uncertain',
                code: TERMINAL.has(record.status) ? record.code ?? null : 'write_uncertain' };
        });
        await this._persist();
        this._started = true;
        await this.refresh();
        if (!this._closing) {
            this._timer = setInterval(() => { this.refresh().catch(() => this._log('Source refresh failed.')); }, this._pollInterval);
            this._timer.unref?.();
        }
        return this.getSnapshot();
    }

    _enqueue(task) {
        const pending = this._tail.then(task);
        this._tail = pending.catch(() => this._log('Background synchronization failed.'));
        return pending;
    }

    async _persist() {
        await this._store.save({ ...this._state, snapshot: this._snapshot, commands: this._records });
    }

    _requireStarted() {
        if (!this._started || this._closing) throw new MetadataError('source_unavailable', 503);
    }

    getSnapshot() {
        this._requireStarted();
        return clone(this._snapshot);
    }

    getCapabilities() {
        const snapshot = this.getSnapshot();
        const { schemaVersion, serverId, sourceEpoch, revision, observedAt, sourceKind,
            available, roomsAvailable, capabilities, limitations } = snapshot;
        return { schemaVersion, serverId, sourceEpoch, revision, observedAt, sourceKind,
            available, roomsAvailable, capabilities, limitations };
    }

    _receipt(record) {
        return { schemaVersion: 1, commandId: record.command.commandId,
            status: record.status, code: record.code ?? null, snapshot: clone(this._snapshot) };
    }

    getCommand(id) {
        this._requireStarted();
        const record = this._records.find(item => item.command.commandId === id);
        if (!record) throw new MetadataError('not_found', 404);
        return this._receipt(record);
    }

    _guard(command) {
        const expected = command.expected;
        if (expected.serverId !== this._snapshot.serverId || expected.sourceEpoch !== this._sourceEpoch) {
            throw new MetadataError('wrong_source', 409);
        }
        if (expected.revision !== this._snapshot.revision) throw new MetadataError('stale_revision', 409);
    }

    _checkOperation(operation) {
        if (operation.type === 'refresh') return;
        if (!this._snapshot.capabilities[CAPABILITY[operation.type]] || typeof this._provider.apply !== 'function') {
            throw new MetadataError('unsupported_operation', 422);
        }
        if (!this._snapshot.available) throw new MetadataError('source_unavailable', 503);
        if (operation.type === 'room.rename') {
            if (!this._snapshot.roomsAvailable) throw new MetadataError('source_unavailable', 503);
            if (!this._snapshot.rooms.some(room => room.id === operation.targetId)) throw new MetadataError('invalid_request');
            return;
        }
        const device = this._snapshot.devices.find(item => item.id === operation.targetId);
        if (!device) throw new MetadataError('invalid_request');
        if (operation.type === 'device.move') {
            if (!this._snapshot.roomsAvailable || !['assigned', 'unassigned'].includes(device.roomStatus)) {
                throw new MetadataError('source_unavailable', 503);
            }
            const room = this._snapshot.rooms.find(item => item.id === operation.roomId);
            if (!room || room.homeId !== device.homeId) throw new MetadataError('invalid_request');
        }
    }

    submit(input) {
        this._requireStarted();
        const { command, fingerprint } = validateCommand(input);
        const previous = this._records.find(record => record.command.commandId === command.commandId);
        if (previous) {
            if (previous.fingerprint !== fingerprint) throw new MetadataError('invalid_request', 409);
            return this._receipt(previous);
        }
        this._guard(command);
        this._checkOperation(command.operation);
        if (this._records.filter(record => !TERMINAL.has(record.status)).length >= QUEUE_LIMIT) {
            throw new MetadataError('queue_full', 429);
        }
        while (this._records.length >= HISTORY_LIMIT) {
            const index = this._records.findIndex(record => TERMINAL.has(record.status));
            if (index === -1) throw new MetadataError('queue_full', 429);
            this._records.splice(index, 1);
        }
        const record = { command, fingerprint, status: 'queued', code: null };
        this._records.push(record);
        // The queue persists this record before any source write. The HTTP receipt
        // acknowledges acceptance, never durable cloud completion.
        this._enqueue(() => this._execute(record)).catch(() => {});
        return this._receipt(record);
    }

    refresh() {
        this._requireStarted();
        if (!this._refreshPromise) {
            this._refreshPromise = this._enqueue(() => this._readSource()).finally(() => { this._refreshPromise = null; });
        }
        return this._refreshPromise.then(() => clone(this._snapshot));
    }

    async _withTimeout(promise) {
        let timer;
        try {
            return await Promise.race([promise, new Promise((_, reject) => {
                timer = setTimeout(() => reject(new MetadataError('write_uncertain', 504)), OPERATION_TIMEOUT_MS);
            })]);
        } finally { clearTimeout(timer); }
    }

    async _readSource() {
        let source;
        try {
            // A timed-out provider request may still be running. Reuse it until
            // it settles instead of starting overlapping polls on every timer.
            if (!this._sourceRead) {
                const read = Promise.resolve().then(() => this._provider.read());
                this._sourceRead = read;
                const release = () => { if (this._sourceRead === read) this._sourceRead = null; };
                read.then(release, release);
            }
            source = normalizeSource(await this._withTimeout(this._sourceRead));
            if (!source.available || !source.capabilities.read) throw new MetadataError('source_unavailable', 503);
        } catch (_) {
            this._log('Source metadata is unavailable; retaining the last known values.');
            await this._replaceSnapshot({ ...this._snapshot, available: false, roomsAvailable: false });
            return false;
        }
        if (!source.roomsAvailable) {
            // Preserve the last authoritative graph while explicitly making room
            // membership unusable for writes. An empty partial response is no deletion.
            const previousDevices = new Map(this._snapshot.devices.map(device => [device.id, device]));
            source.homes = this._snapshot.homes.length ? this._snapshot.homes : source.homes;
            source.rooms = this._snapshot.rooms.length ? this._snapshot.rooms : source.rooms;
            source.devices = source.devices.map(device => {
                const previous = previousDevices.get(device.id);
                return { ...device, homeId: device.homeId ?? previous?.homeId ?? null,
                    roomId: previous?.roomId ?? device.roomId,
                    roomStatus: device.roomStatus === 'unsupported' ? 'unsupported' : 'unknown' };
            });
        }
        await this._replaceSnapshot({ ...this._snapshot, ...source, observedAt: new Date().toISOString() });
        return true;
    }

    async _replaceSnapshot(next) {
        const comparable = snapshot => {
            const { revision, observedAt, serverId, sourceEpoch, schemaVersion, ...metadata } = snapshot;
            return canonical(metadata);
        };
        const changed = comparable(next) !== comparable(this._snapshot);
        next.revision = changed ? String(BigInt(this._snapshot.revision) + 1n) : this._snapshot.revision;
        this._snapshot = next;
        await this._persist();
        // Projections are downstream observers. A projection failure must not
        // turn an authoritative cloud confirmation into another attempted write.
        if (typeof this._options.onSnapshot === 'function') {
            const snapshot = clone(next);
            this._projectionTail = this._projectionTail.then(() => this._options.onSnapshot(snapshot))
                .catch(() => this._log('A metadata projection could not be updated.'));
        }
    }

    _matches(operation) {
        if (!this._snapshot.available) return false;
        if (operation.type === 'device.rename') return this._snapshot.devices.find(device => device.id === operation.targetId)?.name === operation.name;
        if (operation.type === 'room.rename') return this._snapshot.roomsAvailable
            && this._snapshot.rooms.find(room => room.id === operation.targetId)?.name === operation.name;
        if (operation.type === 'device.move') return this._snapshot.roomsAvailable
            && this._snapshot.devices.find(device => device.id === operation.targetId)?.roomId === operation.roomId;
        return false;
    }

    async _execute(record) {
        try {
            await this._persist();
            if (this._closing) throw new MetadataError('write_uncertain', 503);
            if (record.command.operation.type === 'refresh') {
                const read = await this._readSource();
                record.status = read ? 'confirmed' : 'failed';
                record.code = read ? null : 'source_unavailable';
            } else {
                if (this._unsettledWrite) throw new MetadataError('write_uncertain', 503);
                if (!await this._readSource()) throw new MetadataError('source_unavailable', 503);
                this._guard(record.command);
                this._checkOperation(record.command.operation);
                if (this._matches(record.command.operation)) {
                    record.status = 'confirmed';
                } else {
                    record.status = 'running';
                    await this._persist();
                    const marker = {};
                    this._unsettledWrite = marker;
                    const application = Promise.resolve().then(() => this._provider.apply(clone(record.command.operation)));
                    application.then(() => {
                        if (this._unsettledWrite === marker) this._unsettledWrite = null;
                    }, () => {
                        if (this._unsettledWrite === marker) this._unsettledWrite = null;
                    });
                    let failure;
                    try { await this._withTimeout(application); } catch (error) { failure = error; }
                    const readable = await this._readSource();
                    if (readable && this._matches(record.command.operation)) {
                        record.status = 'confirmed';
                    } else if (failure && ['permission_denied', 'unsupported_operation', 'invalid_request'].includes(failure.code)) {
                        record.status = 'failed';
                        record.code = failure.code;
                    } else {
                        record.status = 'uncertain';
                        record.code = !readable || failure ? 'write_uncertain' : 'confirmation_failed';
                    }
                }
            }
        } catch (error) {
            const code = error instanceof MetadataError ? error.code : 'source_unavailable';
            record.status = ['wrong_source', 'stale_revision'].includes(code) ? 'conflict'
                : record.status === 'running' || code === 'write_uncertain' ? 'uncertain' : 'failed';
            record.code = record.status === 'uncertain' ? 'write_uncertain' : code;
            this._log('A metadata command could not be completed.');
        }
        try { await this._persist(); } catch (_) { this._log('Command status could not be persisted.'); }
    }

    async close() {
        if (this._closePromise) return this._closePromise;
        this._closing = true;
        clearInterval(this._timer);
        this._closePromise = (async () => {
            if (this._startPromise) await this._startPromise.catch(() => {});
            await this._tail;
            await this._withTimeout(this._projectionTail).catch(() => this._log('A metadata projection did not finish before shutdown.'));
            await this._store.close();
        })();
        return this._closePromise;
    }
}

module.exports = { MetadataCoordinator };
