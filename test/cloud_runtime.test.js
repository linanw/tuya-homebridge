const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const crypto = require('node:crypto');
const http = require('node:http');
const path = require('node:path');
const test = require('node:test');
const axios = require('axios').default;
const CryptoJS = require('crypto-js');
const mqtt = require('mqtt');
const LogUtil = require('../util/logutil');
const TuyaOpenAPI = require('../lib/tuyaopenapi');
const TuyaSHOpenAPI = require('../lib/tuyashopenapi');
const TuyaOpenMQ = require('../lib/tuyamqttapi');

const credentials = {
  accessId: 'fixture-access-id-private', accessKey: 'fixture-access-key-private',
  username: 'fixture-account-private', password: 'fixture-password-private',
  accessToken: 'fixture-access-token-private', refreshToken: 'fixture-refresh-token-private',
};

function logger(debug = true) {
  const records = [];
  const log = new LogUtil(debug, {
    debug: (...values) => records.push(['debug', ...values]),
    error: (...values) => records.push(['error', ...values]),
  });
  return { log, records };
}

function custom(log) {
  return new TuyaOpenAPI('https://fixture.invalid', credentials.accessId, credentials.accessKey, log);
}

function paas(log) {
  return new TuyaSHOpenAPI(credentials.accessId, credentials.accessKey,
    credentials.username, credentials.password, 86, 'tuyaSmart', log);
}

function tokenResult() {
  return { access_token: credentials.accessToken, refresh_token: credentials.refreshToken,
    uid: 'fixture-user-id', expire: 7200, expire_time: 7200 };
}

function respond(config, data) {
  return { status: 200, statusText: 'OK', headers: {}, config, data };
}

function mockAdapter(t, implementation) {
  const previous = axios.defaults.adapter;
  axios.defaults.adapter = implementation;
  t.after(() => { axios.defaults.adapter = previous; });
}

function assertNoCredentials(value) {
  const output = JSON.stringify(value);
  for (const secret of [...Object.values(credentials),
    CryptoJS.MD5(credentials.password).toString(), CryptoJS.SHA256(credentials.password).toString()]) {
    assert.ok(!output.includes(secret), 'logs and public errors must not contain authentication material');
  }
}

test('errors remain visible with debugging disabled and use the provided logger', () => {
  const { log, records } = logger(false);
  log.log('optional diagnostic');
  log.error('Device command failed');
  assert.deepEqual(records, [['error', 'Device command failed']]);
});

test('logging redacts known secrets, nested authentication and Axios error configuration', () => {
  const { log, records } = logger();
  log.addSecrets(...Object.values(credentials));
  const error = new Error(`Request failed for ${credentials.username}`);
  error.isAxiosError = true;
  error.response = { status: 401, data: { access_token: credentials.accessToken } };
  error.config = { headers: { Authorization: `Bearer ${credentials.accessToken}` }, password: credentials.password };
  log.error('Cloud failure:', error);
  log.log({ headers: error.config.headers, username: credentials.username, nested: { accessKey: credentials.accessKey } });
  log.error(`password=${credentials.password} token: ${credentials.accessToken}`);
  assertNoCredentials(records);
  assert.match(JSON.stringify(records), /status 401/);
  assert.equal(LogUtil.safeErrorMessage(error), 'HTTP request failed (status 401)');
});

test('broker errors redact encoded URI credentials for every supported transport and generic query tokens', () => {
  const { log, records } = logger();
  log.addSecrets('fixture@example.invalid', 'fixture password');
  for (const scheme of ['https', 'mqtt', 'mqtts', 'ws', 'wss', 'ssl', 'tcp', 'tls']) {
    log.error(new Error(`connect failed ${scheme}://fixture%40example.invalid:fixture%20password@broker.invalid/socket?token=temporary-fixture-token`));
  }
  const output = JSON.stringify(records);
  for (const secret of ['fixture%40example.invalid', 'fixture%20password', 'temporary-fixture-token']) {
    assert.ok(!output.includes(secret));
  }
});

test('Custom and PaaS debug output omit signed requests and authentication responses', async t => {
  const { log, records } = logger();
  const requests = [];
  mockAdapter(t, async config => {
    requests.push(config);
    return respond(config, { success: true, result: tokenResult() });
  });
  const api = custom(log);
  await api.login(credentials.username, credentials.password);
  await paas(log).get('/fixture');
  assert.equal(requests.length, 3);
  assert.ok(requests.every(config => config.timeout === 15000), 'HTTP operations must have a finite timeout');
  assertNoCredentials(records);
  assert.ok(!JSON.stringify(records).includes('headers'));
  assert.ok(!JSON.stringify(records).includes('body'));
  assert.ok(api.tokenInfo.expire > Date.now() + 7000000, 'token lifetimes use seconds, not milliseconds');
});

test('missing Custom or PaaS account settings never call the network adapter', async t => {
  let requests = 0;
  mockAdapter(t, async config => {
    requests++;
    return respond(config, { success: true });
  });
  const { log } = logger();
  await assert.rejects(new TuyaOpenAPI(undefined, '', '', log).get('/fixture'), /configured/);
  await assert.rejects(new TuyaSHOpenAPI('', '', '', '', undefined, '', log).get('/fixture'), /configured/);
  await assert.rejects(custom(log).login('', ''), /required/);
  assert.equal(requests, 0);
});

test('PaaS login rejection propagates and stops the dependent request', async t => {
  const { log, records } = logger();
  const requests = [];
  mockAdapter(t, async config => {
    requests.push(config);
    return respond(config, { success: false, code: 1106, msg: credentials.password });
  });
  await assert.rejects(paas(log).get('/fixture/devices'), /code 1106/);
  assert.equal(requests.length, 1);
  assert.match(requests[0].url, /authorized-login/);
  assertNoCredentials(records);
});

test('malformed HTTP success bodies reject before drivers can report false success', async t => {
  const { log } = logger();
  let data;
  mockAdapter(t, async config => respond(config, data));
  for (const api of [custom(log), paas(log)]) {
    api.tokenInfo = { ...tokenResult(), expire: Date.now() + 7200000 };
    for (data of [null, 'not JSON', {}, []]) {
      await assert.rejects(api.get('/fixture'), /invalid response/);
    }
  }
});

test('HTTP transport failures reject with safe errors and PaaS can retry later', async t => {
  const { log, records } = logger();
  let failing = true;
  mockAdapter(t, async config => {
    if (!failing) return respond(config, { success: true, result: tokenResult() });
    const error = new Error(`Connection failed with ${credentials.accessKey}`);
    error.code = 'ECONNABORTED';
    error.config = config;
    throw error;
  });
  const api = paas(log);
  await assert.rejects(api.get('/fixture'), error => {
    assertNoCredentials(error.message);
    assert.match(error.message, /ECONNABORTED/);
    return true;
  });
  failing = false;
  assert.equal((await api.get('/fixture')).success, true);
  assertNoCredentials(records);
});

test('concurrent PaaS requests share one token renewal and use its authenticated token', async t => {
  const { log } = logger();
  let logins = 0;
  const tokens = [];
  mockAdapter(t, async config => {
    if (config.url.includes('authorized-login')) {
      logins++;
      await new Promise(resolve => setImmediate(resolve));
      return respond(config, { success: true, result: tokenResult() });
    }
    tokens.push(config.headers.access_token);
    return respond(config, { success: true, result: [] });
  });
  const api = paas(log);
  await Promise.all([api.get('/one'), api.get('/two')]);
  assert.equal(logins, 1);
  assert.deepEqual(tokens, [credentials.accessToken, credentials.accessToken]);
});

test('Custom token refresh uses refresh_token once and does not clear another request token', async t => {
  const { log } = logger();
  let refreshes = 0;
  const tokens = [];
  mockAdapter(t, async config => {
    if (config.url.startsWith('/v1.0/token/')) {
      refreshes++;
      assert.equal(config.url, `/v1.0/token/${credentials.refreshToken}`);
      assert.equal(config.headers.access_token, '');
      await new Promise(resolve => setImmediate(resolve));
      return respond(config, { success: true, result: tokenResult() });
    }
    tokens.push(config.headers.access_token);
    return respond(config, { success: true, result: [] });
  });
  const api = custom(log);
  api.tokenInfo = { ...tokenResult(), expire: 1 };
  assert.equal(api.isLogin(), true);
  await Promise.all([api.get('/one'), api.get('/two')]);
  assert.equal(refreshes, 1);
  assert.deepEqual(tokens, [credentials.accessToken, credentials.accessToken]);
});

test('both API clients sign exactly the query that Axios sends, including escaped values', async t => {
  const { log } = logger();
  const requests = [];
  mockAdapter(t, async config => {
    requests.push(config);
    const actual = new URL(axios.getUri(config), config.baseURL);
    assert.equal(actual.search, '?query=a%2Bb+%26%E8%8C%B6&ids=one%2Ctwo');
    const body = typeof config.data === 'string' ? config.data : '';
    const stringToSign = `${config.method.toUpperCase()}\n${CryptoJS.SHA256(body)}\nclient_id:${credentials.accessId}\n\n${actual.pathname}${actual.search}`;
    const prefix = `${credentials.accessId}${credentials.accessToken}${config.headers.t}${config.headers.nonce}`;
    const expected = CryptoJS.HmacSHA256(prefix + stringToSign, credentials.accessKey).toString().toUpperCase();
    assert.equal(config.headers.sign, expected);
    assert.match(config.headers.nonce, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);
    return respond(config, { success: true, result: { accepted: true } });
  });
  for (const api of [custom(log), paas(log)]) {
    api.tokenInfo = { ...tokenResult(), expire: Date.now() + 7200000 };
    const response = await api.get('/fixture', { query: 'a+b &茶', ids: 'one,two', absent: null, unset: undefined });
    assert.equal(response.result.accepted, true);
  }
  assert.equal(requests.length, 2);
});

test('real HTTP requests preserve the signed URL and JSON body and sanitize an HTTP failure', { timeout: 5000 }, async t => {
  const received = [];
  const server = http.createServer((request, response) => {
    const chunks = [];
    request.on('data', chunk => chunks.push(chunk));
    request.on('end', () => {
      received.push({ method: request.method, url: request.url, headers: request.headers,
        body: Buffer.concat(chunks).toString() });
      response.writeHead(request.url === '/failure' ? 503 : 200, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify({ success: request.url !== '/failure', result: true,
        password: credentials.password, access_token: credentials.accessToken }));
    });
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }));
  const proxy = axios.defaults.proxy;
  axios.defaults.proxy = false; // The fixture is a local server, not an external cloud destination.
  t.after(() => { axios.defaults.proxy = proxy; });
  const { log, records } = logger();
  for (const api of [custom(log), paas(log)]) {
    api.endpoint = `http://127.0.0.1:${server.address().port}`;
    api.tokenInfo = { ...tokenResult(), expire: Date.now() + 7200000 };
    await api.request('post', '/fixture', { query: 'a+b &茶', ids: 'one,two', absent: null },
      { commands: [{ code: 'switch', value: true }] });
    const sent = received.at(-1);
    assert.equal(sent.url, '/fixture?query=a%2Bb+%26%E8%8C%B6&ids=one%2Ctwo');
    assert.deepEqual(JSON.parse(sent.body), { commands: [{ code: 'switch', value: true }] });
    const signed = `${sent.method}\n${CryptoJS.SHA256(sent.body)}\nclient_id:${credentials.accessId}\n\n${sent.url}`;
    const prefix = `${credentials.accessId}${credentials.accessToken}${sent.headers.t}${sent.headers.nonce}`;
    assert.equal(sent.headers.sign, CryptoJS.HmacSHA256(prefix + signed, credentials.accessKey).toString().toUpperCase());
    await assert.rejects(api.get('/failure'), /HTTP request failed \(status 503\)/);
  }
  assert.equal(received.length, 4);
  assertNoCredentials(records);
});

test('a Tuya application failure reaches a real HomeKit setter callback without hanging', { timeout: 3000 }, async t => {
  mockAdapter(t, async config => respond(config, { success: false, code: 1106 }));
  const { HomebridgeAPI } = require(path.join(path.dirname(require.resolve('homebridge')), 'api.js'));
  const SwitchAccessory = require('../lib/switch_accessory');
  const api = new HomebridgeAPI();
  const { log, records } = logger(false);
  const platform = { api, log, registerPlatformAccessory() {}, tuyaOpenApi: custom(log) };
  const driver = new SwitchAccessory(platform, undefined, { id: 'fixture-switch', name: 'Fixture switch',
    status: [{ code: 'switch', value: false }] }, { subType: ['switch'] });
  const characteristic = driver.homebridgeAccessory.getService(api.hap.Service.Switch)
    .getCharacteristic(api.hap.Characteristic.On);
  await assert.rejects(characteristic.handleSetRequest(true));
  assert.ok(records.some(([level]) => level === 'error'), 'a failed command must be visible with debug disabled');
  assertNoCredentials(records);
});

const mqConfig = {
  url: 'mqtts://fixture.invalid:8883', client_id: 'fixture-client-private',
  username: 'fixture-mqtt-user-private', password: 'abcdefgh0123456789abcdefijklmnop',
  expire_time: 7200, source_topic: { device: 'fixture/device' },
};

function mqFixture(log, post = async () => ({ success: true, result: mqConfig })) {
  return new TuyaOpenMQ({ tokenInfo: { uid: 'fixture-user' }, post }, '2.0', log);
}

function fakeClient() {
  const client = new EventEmitter();
  client.subscriptions = [];
  client.ended = [];
  client.subscribe = topic => client.subscriptions.push(topic);
  client.end = force => client.ended.push(force);
  return client;
}

function encryptedMessage(data, corrupted = false) {
  const timestamp = 1700000000000;
  const iv = Buffer.from('00112233445566778899aabb', 'hex');
  const cipher = crypto.createCipheriv('aes-128-gcm', Buffer.from(mqConfig.password.substring(8, 24)), iv);
  const aad = Buffer.alloc(6);
  aad.writeUIntBE(timestamp, 0, 6);
  cipher.setAAD(aad);
  const ciphertext = Buffer.concat([cipher.update(JSON.stringify(data)), cipher.final()]);
  const header = Buffer.alloc(4);
  header.writeUInt32BE(iv.length);
  const frame = Buffer.concat([header, iv, ciphertext, cipher.getAuthTag()]);
  if (corrupted) frame[frame.length - 1] ^= 1;
  return Buffer.from(JSON.stringify({ t: timestamp, data: frame.toString('base64') }));
}

test('MQTT missing login never requests cloud settings or opens a socket', async t => {
  let posts = 0;
  let connects = 0;
  t.mock.method(mqtt, 'connect', () => { connects++; return fakeClient(); });
  const { log, records } = logger(false);
  const mq = new TuyaOpenMQ({ tokenInfo: {}, async post() { posts++; } }, '2.0', log);
  await mq.start();
  assert.equal(posts, 0);
  assert.equal(connects, 0);
  assert.ok(records.some(([level]) => level === 'error'));
});

test('MQTT duplicate start shares a loop and stopping releases its renewal timer', async t => {
  const client = fakeClient();
  let connections = 0;
  t.mock.method(mqtt, 'connect', () => { connections++; return client; });
  const { log } = logger();
  const mq = mqFixture(log);
  const first = mq.start();
  assert.equal(mq.start(), first);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(connections, 1);
  assert.deepEqual(client.subscriptions, ['fixture/device']);
  assert.ok(mq._timer);
  mq.stop();
  await first;
  assert.equal(mq._timer, null);
  assert.equal(mq._wake, null);
  assert.deepEqual(client.ended, [true]);
});

test('stop during an in-flight MQTT credential request cannot create a later socket', async t => {
  let complete;
  let connections = 0;
  t.mock.method(mqtt, 'connect', () => { connections++; return fakeClient(); });
  const { log } = logger();
  const mq = mqFixture(log, () => new Promise(resolve => { complete = resolve; }));
  const loop = mq.start();
  mq.stop();
  complete({ success: true, result: mqConfig });
  await loop;
  assert.equal(connections, 0);
});

test('retired or stopped MQTT clients cannot dispatch late duplicate device events', async t => {
  const clients = [];
  t.mock.method(mqtt, 'connect', () => {
    const client = fakeClient();
    clients.push(client);
    return client;
  });
  const { log } = logger();
  const mq = mqFixture(log);
  const received = [];
  mq.addMessageListener(data => received.push(data));
  const loop = mq.start();
  await new Promise(resolve => setImmediate(resolve));
  mq._wake(); // Renew now rather than waiting for the fixture's two-hour expiry.
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(clients.length, 2);
  const message = encryptedMessage({ devId: 'fixture-device', status: [] });
  clients[0].emit('message', mqConfig.source_topic.device, message);
  clients[1].emit('message', mqConfig.source_topic.device, message);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(received.length, 1);
  mq.stop();
  await loop;
  clients[1].emit('message', mqConfig.source_topic.device, message);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(received.length, 1);
});

test('MQTT setup failures retry with a delay and recover without rejecting the background task', async t => {
  const client = fakeClient();
  let posts = 0;
  t.mock.method(mqtt, 'connect', () => client);
  const { log, records } = logger(false);
  const mq = mqFixture(log, async () => {
    if (++posts === 1) throw new Error('fixture cloud unavailable');
    return { success: true, result: mqConfig };
  });
  const delays = [];
  mq._wait = async delay => { delays.push(delay); if (mq.client) mq.stop(); };
  await assert.doesNotReject(mq.start());
  assert.equal(posts, 2);
  assert.equal(delays[0], 5000);
  assert.equal(delays[1], 7140000);
  assert.ok(records.some(([level]) => level === 'error'));
});

test('invalid MQTT responses cannot cause an expiry busy loop or leak a half-created client', async t => {
  let connections = 0;
  t.mock.method(mqtt, 'connect', () => { connections++; return fakeClient(); });
  const { log } = logger(false);
  for (const response of [undefined, { success: false }, { success: true, result: { ...mqConfig, expire_time: 60 } }]) {
    const mq = mqFixture(log, async () => response);
    const delays = [];
    mq._wait = async delay => { delays.push(delay); mq.stop(); };
    await mq.start();
    assert.deepEqual(delays, [5000]);
  }
  assert.equal(connections, 0);
  const client = fakeClient();
  client.subscribe = () => { throw new Error('subscription unavailable'); };
  t.mock.method(mqtt, 'connect', () => client);
  const mq = mqFixture(log);
  mq._wait = async () => mq.stop();
  await mq.start();
  assert.deepEqual(client.ended, [true]);
});

test('MQTT logger instances remain isolated and connection errors omit signed credentials', async t => {
  const first = logger();
  const second = logger();
  const client = fakeClient();
  t.mock.method(mqtt, 'connect', () => client);
  const mq = mqFixture(first.log);
  mqFixture(second.log);
  const loop = mq.start();
  await new Promise(resolve => setImmediate(resolve));
  client.emit('error', new Error(`Broker rejected ${mqConfig.username} ${mqConfig.password}`));
  mq.stop();
  await loop;
  assert.equal(second.records.length, 0);
  const output = JSON.stringify(first.records);
  assert.ok(!output.includes(mqConfig.username));
  assert.ok(!output.includes(mqConfig.password));
  assert.ok(!output.includes(mqConfig.url));
});

test('malformed or tampered MQTT frames are rejected and healthy listeners survive sync and async errors', async () => {
  const { log, records } = logger(false);
  const mq = mqFixture(log);
  mq.deviceTopic = mqConfig.source_topic.device;
  const received = [];
  mq.addMessageListener(() => { throw new Error('fixture listener failed'); });
  mq.addMessageListener(async () => { throw new Error('fixture async listener failed'); });
  mq.addMessageListener(message => received.push(message));
  await mq._onMessage(null, mqConfig, mq.deviceTopic, Buffer.from('not JSON'));
  await mq._onMessage(null, mqConfig, mq.deviceTopic, encryptedMessage({ devId: 'fixture-device', status: [] }, true));
  assert.deepEqual(received, []);
  const update = { devId: 'fixture-device', status: [{ code: 'switch', value: true }] };
  await mq._onMessage(null, mqConfig, mq.deviceTopic, encryptedMessage(update));
  assert.deepEqual(received, [update]);
  assert.equal(records.filter(([level]) => level === 'error').length, 4);
  await mq._onMessage(null, mqConfig, 'unrelated/topic', Buffer.from('not JSON'));
  assert.equal(records.length, 4, 'unsubscribed traffic is ignored before parsing');
});

test('legacy encrypted MQTT 1.0 updates retain their existing decoding format', async () => {
  const { log } = logger(false);
  const mq = mqFixture(log);
  mq.type = '1.0';
  mq.deviceTopic = mqConfig.source_topic.device;
  const update = { devId: 'fixture-device', status: [] };
  const encrypted = CryptoJS.AES.encrypt(JSON.stringify(update), CryptoJS.enc.Utf8.parse(mqConfig.password.substring(8, 24)),
    { mode: CryptoJS.mode.ECB, padding: CryptoJS.pad.Pkcs7 }).toString();
  const received = [];
  mq.addMessageListener(message => received.push(message));
  await mq._onMessage(null, mqConfig, mq.deviceTopic, Buffer.from(JSON.stringify({ data: encrypted })));
  assert.deepEqual(received, [update]);
});
