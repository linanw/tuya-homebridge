'use strict';

const http = require('node:http');
const https = require('node:https');
const { randomUUID } = require('node:crypto');
const { MetadataClientError, ERROR_CODES, isUuid, capabilities, snapshot, receipt, operation, clone } = require('./protocol');

const MAX_RESPONSE_BYTES = 4 * 1024 * 1024;
const MAX_COMMAND_BYTES = 16 * 1024;

class MetadataClient {
  #token;
  #baseUrl;
  constructor({ baseUrl, token, timeoutMs = 5000, pollIntervalMs = 250, receiptTimeoutMs = 15000 } = {}) {
    let url;
    try { url = new URL(baseUrl); } catch { throw new MetadataClientError('invalid_base_url'); }
    const authority = typeof baseUrl === 'string' && /^[a-z][a-z0-9+.-]*:\/\/([^/?#]+)/i.exec(baseUrl);
    const loopback = authority && /^(?:localhost|127\.0\.0\.1|\[::1\])(?::\d+)?$/.test(authority[1]);
    if (!['http:', 'https:'].includes(url.protocol) || (url.protocol === 'http:' && !loopback)
      || url.username || url.password || url.search || url.hash
      || typeof baseUrl !== 'string' || /[?#]/.test(baseUrl) || /[%\\]/.test(url.pathname)) {
      throw new MetadataClientError('invalid_base_url');
    }
    if (typeof token !== 'string' || token.length < 32 || /[^\x21-\x7e]/.test(token)) throw new MetadataClientError('invalid_token');
    for (const value of [timeoutMs, pollIntervalMs, receiptTimeoutMs]) {
      if (!Number.isFinite(value) || value <= 0 || value > 0x7fffffff) throw new MetadataClientError('invalid_request');
    }
    this.#baseUrl = url;
    this.#token = token;
    this.timeoutMs = timeoutMs;
    this.pollIntervalMs = pollIntervalMs;
    this.receiptTimeoutMs = receiptTimeoutMs;
  }

  _url(route) {
    const url = new URL(this.#baseUrl);
    url.pathname = url.pathname.replace(/\/+$/, '') + route;
    return url;
  }

  _request(method, route, body, status = 200, signal) {
    let encoded;
    if (body !== undefined) {
      encoded = Buffer.from(JSON.stringify(body));
      if (encoded.length > MAX_COMMAND_BYTES) return Promise.reject(new MetadataClientError('request_too_large'));
    }
    const url = this._url(route);
    return new Promise((resolve, reject) => {
      let settled = false;
      let request;
      const done = (error, value) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        signal?.removeEventListener('abort', aborted);
        if (error) reject(error); else resolve(value);
      };
      const aborted = () => { done(new MetadataClientError('request_aborted')); request?.destroy(); };
      const timer = setTimeout(() => {
        done(new MetadataClientError('request_timeout'));
        request?.destroy();
      }, this.timeoutMs);
      try {
        request = (url.protocol === 'https:' ? https : http).request(url, {
          method,
          headers: { Authorization: `Bearer ${this.#token}`, Accept: 'application/json',
            ...(encoded ? { 'Content-Type': 'application/json', 'Content-Length': encoded.length } : {}) },
        }, response => {
          const fail = code => { done(new MetadataClientError(code, response.statusCode || 0)); response.destroy(); };
          response.on('error', () => done(new MetadataClientError('network_error')));
          response.on('aborted', () => done(new MetadataClientError('network_error')));
          if (response.statusCode >= 300 && response.statusCode < 400) { fail('redirect_refused'); return; }
          const length = response.headers['content-length'];
          if (length && (!/^\d+$/.test(length) || Number(length) > MAX_RESPONSE_BYTES)) { fail('response_too_large'); return; }
          if (typeof response.headers['content-type'] !== 'string'
            || response.headers['content-type'].split(';')[0].trim().toLowerCase() !== 'application/json') {
            fail('invalid_response'); return;
          }
          const chunks = [];
          let size = 0;
          response.on('data', chunk => {
            size += chunk.length;
            if (size > MAX_RESPONSE_BYTES) fail('response_too_large');
            else chunks.push(chunk);
          });
          response.on('end', () => {
            if (settled) return;
            let parsed;
            try { parsed = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks))); }
            catch { done(new MetadataClientError('invalid_response', response.statusCode)); return; }
            if (response.statusCode !== status) {
              const code = ERROR_CODES.has(parsed && parsed.code) ? parsed.code : 'request_failed';
              done(new MetadataClientError(code, response.statusCode));
            } else done(null, parsed);
          });
        });
        request.on('error', () => done(new MetadataClientError('network_error')));
        if (signal) {
          signal.addEventListener('abort', aborted, { once: true });
          if (signal.aborted) { aborted(); return; }
        }
        request.end(encoded);
      } catch {
        done(new MetadataClientError('network_error'));
        request?.destroy();
      }
    });
  }

  async getCapabilities({ signal } = {}) {
    return capabilities(await this._request('GET', '/v1/capabilities', undefined, 200, signal));
  }

  async getSnapshot({ signal } = {}) {
    return snapshot(await this._request('GET', '/v1/metadata', undefined, 200, signal));
  }

  async getCommand(commandId, { signal } = {}) {
    if (!isUuid(commandId)) throw new MetadataClientError('invalid_request');
    return receipt(await this._request('GET', `/v1/metadata/commands/${commandId}`, undefined, 200, signal), commandId);
  }

  async submitCommand(current, requested, { commandId = randomUUID(), signal } = {}) {
    const source = snapshot(current);
    if (!isUuid(commandId)) throw new MetadataClientError('invalid_request');
    const command = { schemaVersion: 1, commandId,
      expected: { serverId: source.serverId, sourceEpoch: source.sourceEpoch, revision: source.revision },
      operation: operation(requested, source) };
    const result = receipt(await this._request('POST', '/v1/metadata/commands', command, 202, signal), commandId);
    this._sameSource(result, source, commandId);
    return result;
  }

  _sameSource(result, expected, commandId) {
    if (result.snapshot && (result.snapshot.serverId !== expected.serverId || result.snapshot.sourceEpoch !== expected.sourceEpoch)) {
      throw new MetadataClientError('wrong_source', 409, commandId);
    }
  }

  async waitForCommand(commandId, expected, { signal, timeoutMs = this.receiptTimeoutMs } = {}) {
    if (!isUuid(commandId) || !Number.isFinite(timeoutMs) || timeoutMs <= 0) throw new MetadataClientError('invalid_request');
    const source = snapshot(expected);
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      let result;
      const elapsed = AbortSignal.timeout(Math.max(1, Math.ceil(deadline - Date.now())));
      try { result = await this.getCommand(commandId, { signal: signal ? AbortSignal.any([signal, elapsed]) : elapsed }); }
      catch { throw new MetadataClientError('write_uncertain', 0, commandId); }
      this._sameSource(result, source, commandId);
      if (!['queued', 'running'].includes(result.status)) return result;
      await new Promise(resolve => setTimeout(resolve, Math.min(this.pollIntervalMs, Math.max(1, deadline - Date.now()))));
    }
    throw new MetadataClientError('write_uncertain', 0, commandId);
  }

  /** A write uses exactly one POST. Uncertain delivery is never retried. */
  async executeCommand(current, requested, options = {}) {
    const commandId = options.commandId || randomUUID();
    let result;
    try { result = await this.submitCommand(current, requested, { ...options, commandId }); }
    catch (error) {
      if (['network_error', 'request_timeout', 'request_aborted', 'invalid_response', 'redirect_refused'].includes(error.code)
        || error.statusCode >= 500) throw new MetadataClientError('write_uncertain', error.statusCode || 0, commandId);
      throw error;
    }
    if (!['queued', 'running'].includes(result.status)) return result;
    return this.waitForCommand(commandId, clone(current), options);
  }
}

module.exports = { MetadataClient, MetadataClientError };
