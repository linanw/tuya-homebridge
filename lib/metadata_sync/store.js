'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { TextDecoder } = require('node:util');
const promises = fs.promises;

const MAX_FILE_BYTES = 8 * 1024 * 1024;
const MAX_COMMANDS = 200;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SALT = /^[0-9a-f]{64}$/i;

function storageError() {
  // File contents, provider identifiers and filesystem errors may contain
  // sensitive information. None of them belong in a public error message.
  return new Error('Metadata sync storage is unavailable or invalid.');
}

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    && (Object.getPrototypeOf(value) === Object.prototype
      || Object.getPrototypeOf(value) === null);
}

function validate(state) {
  if (!isRecord(state) || state.formatVersion !== 1
    || typeof state.serverId !== 'string' || !UUID.test(state.serverId)
    || typeof state.identitySalt !== 'string' || !SALT.test(state.identitySalt)
    || (state.snapshot !== null && !isRecord(state.snapshot))
    || !Array.isArray(state.commands) || state.commands.length > MAX_COMMANDS
    || !state.commands.every(isRecord)) {
    throw storageError();
  }
}

function serialize(state) {
  try {
    validate(state);
    const data = JSON.stringify(state) + '\n';
    if (Buffer.byteLength(data, 'utf8') > MAX_FILE_BYTES) {
      throw storageError();
    }
    // Verify the actual JSON representation too: toJSON methods must not
    // transform a valid-looking state into an invalid persisted document.
    validate(JSON.parse(data));
    return data;
  } catch (_) {
    throw storageError();
  }
}

class MetadataStore {
  constructor({ storagePath, accountKey } = {}) {
    if (typeof storagePath !== 'string' || storagePath.length === 0
      || typeof accountKey !== 'string' || accountKey.trim().length === 0
      || accountKey.length > 4096) {
      throw storageError();
    }
    this.storagePath = storagePath;
    const accountHash = crypto.createHash('sha256').update(String(accountKey)).digest('hex');
    this.filePath = path.join(storagePath, `metadata-sync-${accountHash}.json`);
    this._opening = null;
    this._queue = Promise.resolve();
    this._closing = false;
    this._closePromise = null;
    this._state = null;
  }

  async open() {
    if (this._closing) {
      throw storageError();
    }
    await this._ensureOpen();
    // The coordinator owns its mutable working state; the store keeps an
    // independent copy of the last successfully persisted state.
    return JSON.parse(JSON.stringify(this._state));
  }

  _ensureOpen() {
    if (!this._opening) {
      this._opening = this._initialize();
    }
    return this._opening;
  }

  async _initialize() {
    try {
      await promises.mkdir(this.storagePath, { recursive: true, mode: 0o700 });
      let handle;
      try {
        // Refuse a symlink at the account file rather than following it to an
        // unrelated document. The read is bounded even if its size changes.
        handle = await promises.open(this.filePath,
          fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0)
          | (fs.constants.O_NONBLOCK || 0));
      } catch (error) {
        if (error.code !== 'ENOENT') {
          throw error;
        }
      }

      if (handle) {
        try {
          const stat = await handle.stat();
          if (!stat.isFile() || stat.size > MAX_FILE_BYTES) {
            throw storageError();
          }
          const buffer = Buffer.alloc(MAX_FILE_BYTES + 1);
          let length = 0;
          while (length < buffer.length) {
            const result = await handle.read(buffer, length, buffer.length - length, null);
            if (result.bytesRead === 0) {
              break;
            }
            length += result.bytesRead;
          }
          if (length > MAX_FILE_BYTES) {
            throw storageError();
          }
          const text = new TextDecoder('utf-8', { fatal: true }).decode(buffer.subarray(0, length));
          this._state = JSON.parse(text);
          validate(this._state);
        } finally {
          await handle.close();
        }
      } else {
        this._state = {
          formatVersion: 1,
          serverId: crypto.randomUUID(),
          identitySalt: crypto.randomBytes(32).toString('hex'),
          snapshot: null,
          commands: [],
        };
        // Identity must reach durable storage before it can escape to a
        // provider or client. Corrupt existing state is never replaced here.
        await this._persist(serialize(this._state));
      }
      this._serverId = this._state.serverId;
      this._identitySalt = this._state.identitySalt;
    } catch (_) {
      this._state = null;
      throw storageError();
    }
  }

  async save(state) {
    if (this._closing) {
      throw storageError();
    }
    // Capture before queueing, so caller mutations cannot reorder or change
    // the contents of writes that have already been submitted.
    const data = serialize(state);
    const captured = JSON.parse(data);
    const operation = this._queue.then(async () => {
      await this._ensureOpen();
      if (captured.serverId !== this._serverId || captured.identitySalt !== this._identitySalt) {
        throw storageError();
      }
      await this._persist(data);
      this._state = captured;
    });
    // A rejected save is returned to its caller without preventing later
    // correctly formed saves from draining their turn in the queue.
    this._queue = operation.catch(() => {});
    return operation;
  }

  async _persist(data) {
    const temporaryPath = `${this.filePath}.tmp-${crypto.randomUUID()}`;
    let temporary;
    let renamed = false;
    try {
      temporary = await promises.open(temporaryPath,
        fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL,
        0o600);
      await temporary.writeFile(data, { encoding: 'utf8' });
      await temporary.sync();
      await temporary.close();
      temporary = null;
      await promises.rename(temporaryPath, this.filePath);
      renamed = true;
      const directory = await promises.open(this.storagePath,
        fs.constants.O_RDONLY | (fs.constants.O_DIRECTORY || 0));
      try {
        await directory.sync();
      } finally {
        await directory.close();
      }
    } catch (_) {
      throw storageError();
    } finally {
      if (temporary) {
        await temporary.close().catch(() => {});
      }
      if (!renamed) {
        await promises.unlink(temporaryPath).catch(() => {});
      }
    }
  }

  close() {
    if (!this._closePromise) {
      this._closing = true;
      this._closePromise = (async () => {
        // Opening may itself be persisting a newly generated identity. Saves
        // queued before close remain authorized to finish through _ensureOpen.
        if (this._opening) {
          await this._opening;
        }
        await this._queue;
      })();
    }
    return this._closePromise;
  }
}

module.exports = { MetadataStore };
