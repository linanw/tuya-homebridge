const http = require('node:http');
const https = require('node:https');
const crypto = require('node:crypto');

const MAX_BODY_BYTES = 16 * 1024;
const MAX_RESPONSE_BYTES = 4 * 1024 * 1024;
const REQUEST_TIMEOUT_MS = 10000;
const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '::1']);
const COMMAND_PATH = /^\/v1\/metadata\/commands\/([0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})$/i;
const SAFE_CODES = new Set([
  'stale_revision', 'wrong_source', 'unsupported_operation', 'source_unavailable',
  'permission_denied', 'confirmation_failed', 'write_uncertain', 'invalid_request',
  'queue_full', 'not_found', 'command_not_found', 'command_conflict',
  'idempotency_conflict', 'command_id_reused', 'unknown_command',
]);

function failure(statusCode, code) {
  return { statusCode, code };
}

function isPem(value, expression) {
  return (typeof value === 'string' || Buffer.isBuffer(value)) && expression.test(value.toString());
}

/** Authenticated, opt-in transport for the Metadata Sync v1 coordinator. */
class MetadataHttpServer {
  constructor({ coordinator, token, host = '127.0.0.1', port = 0, tls, log } = {}) {
    if (!coordinator || ['getCapabilities', 'getSnapshot', 'submit', 'getCommand']
      .some(method => typeof coordinator[method] !== 'function')) {
      throw new Error('Metadata HTTP server requires a coordinator');
    }
    if (typeof token !== 'string' || token.length < 32 || /[^\x21-\x7e]/.test(token)) {
      throw new Error('Metadata HTTP token must contain at least 32 visible ASCII characters without spaces');
    }
    if (typeof host !== 'string' || !host || host.trim() !== host) {
      throw new Error('Metadata HTTP bind host is invalid');
    }
    if (!Number.isInteger(port) || port < 0 || port > 65535) {
      throw new Error('Metadata HTTP port must be an integer between 0 and 65535');
    }
    if (tls !== undefined && (!tls ||
      !isPem(tls.cert, /-----BEGIN CERTIFICATE-----/) ||
      !isPem(tls.key, /-----BEGIN (?:RSA |EC |ENCRYPTED )?PRIVATE KEY-----/))) {
      throw new Error('Metadata HTTPS requires a PEM certificate and private key');
    }
    if (!LOOPBACK_HOSTS.has(host) && !tls) {
      throw new Error('Metadata HTTP requires TLS when binding outside exact loopback addresses');
    }
    this.coordinator = coordinator;
    this.host = host;
    this.port = port;
    this.tls = tls;
    this.log = log;
    this._tokenDigest = crypto.createHash('sha256').update(token).digest();
    this._server = null;
    this._starting = null;
    this._closing = null;
    this._closed = false;
  }

  async start() {
    if (this._closed) throw new Error('Metadata HTTP server is closed');
    if (this._starting) return this._starting;
    if (this._server && this._server.listening) return this._server.address();
    this._starting = this._listen();
    try {
      return await this._starting;
    } finally {
      this._starting = null;
    }
  }

  async _listen() {
    const handler = (request, response) => {
      // IncomingMessage and ServerResponse can emit late socket errors after a
      // peer disconnects. Neither is a reason to reject a background task.
      request.on('error', () => {});
      response.on('error', () => {});
      this._handle(request, response).catch(() => {
        this._send(request, response, 500, { schemaVersion: 1, code: 'internal_error' }, true);
      });
    };
    let server;
    try {
      server = this.tls
        ? https.createServer({ cert: this.tls.cert, key: this.tls.key, minVersion: 'TLSv1.2' }, handler)
        : http.createServer(handler);
    } catch {
      throw new Error('Could not initialize metadata HTTPS server');
    }
    this._server = server;
    server.requestTimeout = REQUEST_TIMEOUT_MS;
    server.headersTimeout = 5000;
    server.keepAliveTimeout = 1000;
    server.timeout = REQUEST_TIMEOUT_MS;
    server.maxRequestsPerSocket = 100;
    server.on('checkContinue', handler);
    server.on('clientError', (error, socket) => {
      if (socket.writable && !socket.destroyed) {
        socket.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\nContent-Length: 0\r\n\r\n');
      }
    });
    // Errors after listening must have a handler too. Deliberately omit the
    // error object, which can include certificate or connection details.
    server.on('error', () => this._report('Metadata HTTP server encountered a transport error'));
    return new Promise((resolve, reject) => {
      const failed = () => {
        server.removeListener('listening', listening);
        this._server = null;
        reject(new Error('Could not start metadata HTTP server'));
      };
      const listening = () => {
        server.removeListener('error', failed);
        resolve(server.address());
      };
      server.once('error', failed);
      server.once('listening', listening);
      server.listen({ host: this.host, port: this.port });
    });
  }

  async close() {
    if (this._closing) return this._closing;
    this._closed = true;
    this._closing = (async () => {
      if (this._starting) {
        try { await this._starting; } catch { /* Failed starts have no listening socket. */ }
      }
      const server = this._server;
      this._server = null;
      if (!server) return;
      await new Promise(resolve => {
        server.close(() => resolve());
        // Do not let a partial body or persistent idle connection hold shutdown.
        server.closeAllConnections();
      });
    })();
    return this._closing;
  }

  _authorized(request) {
    const header = request.headers.authorization;
    const match = typeof header === 'string' && /^Bearer ([^\s]+)$/i.exec(header);
    let count = 0;
    for (let index = 0; index < request.rawHeaders.length; index += 2) {
      if (request.rawHeaders[index].toLowerCase() === 'authorization') count++;
    }
    const digest = crypto.createHash('sha256').update(match ? match[1] : '').digest();
    const equal = crypto.timingSafeEqual(this._tokenDigest, digest);
    return Boolean(match && count === 1 && equal);
  }

  async _handle(request, response) {
    if (!this._authorized(request)) {
      response.setHeader('WWW-Authenticate', 'Bearer realm="metadata-sync"');
      this._send(request, response, 401, { schemaVersion: 1, code: 'permission_denied' }, true);
      return;
    }
    if (this._closed) {
      this._send(request, response, 503, { schemaVersion: 1, code: 'source_unavailable' }, true);
      return;
    }
    try {
      const target = request.url;
      if (typeof target !== 'string' || !target.startsWith('/') || /[%?#\\]/.test(target)) {
        throw failure(400, 'invalid_request');
      }
      const command = COMMAND_PATH.exec(target);
      let method;
      if (target === '/v1/capabilities' || target === '/v1/metadata' || command) method = 'GET';
      else if (target === '/v1/metadata/commands') method = 'POST';
      else throw failure(404, 'not_found');
      if (request.method !== method) {
        response.setHeader('Allow', method);
        throw failure(405, 'method_not_allowed');
      }
      if (method === 'GET') {
        if (request.headers['transfer-encoding'] ||
          (request.headers['content-length'] !== undefined && request.headers['content-length'] !== '0')) {
          throw failure(400, 'invalid_request');
        }
        let result;
        if (command) result = this.coordinator.getCommand(command[1]);
        else if (target === '/v1/capabilities') result = this.coordinator.getCapabilities();
        else result = this.coordinator.getSnapshot();
        if (command && (result === undefined || result === null)) throw failure(404, 'not_found');
        this._send(request, response, 200, result);
      } else {
        const contentType = request.headers['content-type'];
        if (typeof contentType !== 'string' ||
          !/^application\/json(?:\s*;\s*charset\s*=\s*"?utf-8"?)?\s*$/i.test(contentType)) {
          throw failure(415, 'unsupported_media_type');
        }
        const length = request.headers['content-length'];
        if (length !== undefined && (!/^\d+$/.test(length) || Number(length) > MAX_BODY_BYTES)) {
          throw failure(Number(length) > MAX_BODY_BYTES ? 413 : 400,
            Number(length) > MAX_BODY_BYTES ? 'request_too_large' : 'invalid_request');
        }
        if (request.headers.expect && request.headers.expect.toLowerCase() === '100-continue') response.writeContinue();
        const body = await this._readObject(request);
        const receipt = this.coordinator.submit(body);
        this._send(request, response, 202, receipt);
      }
    } catch (error) {
      const status = Number.isInteger(error && error.statusCode) && error.statusCode >= 400 && error.statusCode <= 599
        ? error.statusCode : 500;
      const localCode = error && error.code;
      const transportCodes = ['method_not_allowed', 'request_too_large', 'unsupported_media_type', 'request_timeout'];
      const code = SAFE_CODES.has(localCode) || transportCodes.includes(localCode) ? localCode : 'internal_error';
      this._send(request, response, status, { schemaVersion: 1, code }, true);
    }
  }

  _readObject(request) {
    return new Promise((resolve, reject) => {
      const chunks = [];
      let size = 0;
      let finished = false;
      const complete = (error, result) => {
        if (finished) return;
        finished = true;
        clearTimeout(timer);
        request.removeListener('data', data);
        request.removeListener('end', end);
        request.removeListener('aborted', aborted);
        request.removeListener('error', aborted);
        if (error) reject(error);
        else resolve(result);
      };
      const data = chunk => {
        size += chunk.length;
        if (size > MAX_BODY_BYTES) complete(failure(413, 'request_too_large'));
        else chunks.push(chunk);
      };
      const aborted = () => complete(failure(400, 'invalid_request'));
      const end = () => {
        try {
          const text = new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks));
          const object = JSON.parse(text);
          if (!object || typeof object !== 'object' || Array.isArray(object)) throw failure(400, 'invalid_request');
          complete(null, object);
        } catch {
          complete(failure(400, 'invalid_request'));
        }
      };
      const timer = setTimeout(() => complete(failure(408, 'request_timeout')), REQUEST_TIMEOUT_MS);
      timer.unref();
      request.on('data', data);
      request.once('end', end);
      request.once('aborted', aborted);
      request.once('error', aborted);
      if (request.aborted || request.destroyed) aborted();
    });
  }

  _send(request, response, status, payload, close = false) {
    if (response.destroyed || response.writableEnded) return;
    if (response.headersSent) {
      response.destroy();
      return;
    }
    let body;
    try {
      if (payload && typeof payload.then === 'function') throw new Error('Coordinator methods must be synchronous');
      body = JSON.stringify(payload);
      if (typeof body !== 'string' || Buffer.byteLength(body) > MAX_RESPONSE_BYTES) throw new Error('Invalid response');
    } catch {
      status = 500;
      body = '{"schemaVersion":1,"code":"internal_error"}';
      close = true;
    }
    response.statusCode = status;
    response.setHeader('Content-Type', 'application/json; charset=utf-8');
    response.setHeader('Cache-Control', 'no-store');
    response.setHeader('X-Content-Type-Options', 'nosniff');
    response.setHeader('Content-Length', Buffer.byteLength(body));
    if (close) response.setHeader('Connection', 'close');
    response.end(body);
    if (!request.complete) request.resume();
  }

  _report(message) {
    try {
      if (this.log && typeof this.log.error === 'function') this.log.error(message);
    } catch { /* Logging must not create an unhandled server error. */ }
  }
}

module.exports = { MetadataHttpServer };
