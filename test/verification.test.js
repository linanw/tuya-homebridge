const assert = require('node:assert/strict');
const path = require('node:path');
const test = require('node:test');
const { HomebridgeAPI } = require(path.join(path.dirname(require.resolve('homebridge')), 'api.js'));
const TuyaSHOpenAPI = require('../lib/tuyashopenapi');
const TuyaOpenAPI = require('../lib/tuyaopenapi');
const TuyaOpenMQ = require('../lib/tuyamqttapi');
const manifest = require('../package.json');
const schema = require('../config.schema.json');

const credentials = {
  accessId: 'private-fixture-access-id', accessKey: 'private-fixture-access-key',
  username: 'private-fixture-username', password: 'private-fixture-password',
};

function fixture(config) {
  const api = new HomebridgeAPI();
  let Platform;
  api.once('registerPlatform', (name, Constructor) => { Platform = Constructor; });
  require('../index')(api);
  const errors = [];
  const warnings = [];
  const logger = { error: message => errors.push(message), warn: message => warnings.push(message), debug() {} };
  const platform = new Platform(logger, config, api);
  return { api, platform, errors, warnings };
}

test('missing or invalid configuration never starts Tuya login, discovery, or MQTT', async t => {
  t.mock.method(TuyaSHOpenAPI.prototype, 'getDevices', () => assert.fail('unconfigured discovery'));
  t.mock.method(TuyaOpenAPI.prototype, 'login', () => assert.fail('unconfigured login'));
  t.mock.method(TuyaOpenMQ.prototype, 'start', () => assert.fail('unconfigured MQTT'));
  for (const config of [undefined, null, {}, { options: {} }, { options: credentials },
    { options: { ...credentials, projectType: '1', endPoint: 'http://openapi.tuyaus.com' } },
    { options: { ...credentials, projectType: '1', endPoint: 'https://user:secret@openapi.tuyaus.com' } },
    { options: { ...credentials, projectType: '2', countryCode: true, appSchema: 'smartlife' } },
    { options: { ...credentials, projectType: 'invalid', countryCode: 86, appSchema: 'smartlife' } },
  ]) {
    const { api, platform, warnings } = fixture(config);
    assert.equal(platform.configured, false);
    assert.equal(api.listenerCount('didFinishLaunching'), 0);
    api.emit('didFinishLaunching');
    await platform.initTuyaSDK(config);
    assert.equal(platform.tuyaOpenApi, undefined);
    assert.equal(platform.tuyaOpenMQ, undefined);
    assert.equal(warnings.length, 1);
    await platform.matterBridge.close();
  }
});

test('a complete configuration starts normally and passes its language to the API', async t => {
  t.mock.method(TuyaSHOpenAPI.prototype, 'getDevices', async () => []);
  t.mock.method(TuyaOpenAPI.prototype, 'login', async () => ({}));
  t.mock.method(TuyaOpenAPI.prototype, 'getDeviceList', async () => []);
  let starts = 0;
  t.mock.method(TuyaOpenMQ.prototype, 'start', () => { starts++; });
  for (const options of [
    { ...credentials, projectType: '2', countryCode: 86, appSchema: 'SMARTLIFE', lang: 'zh' },
    { ...credentials, projectType: '1', endPoint: 'https://openapi.tuyaus.com', lang: 'en' },
  ]) {
    const config = { options };
    const { api, platform, errors } = fixture(config);
    assert.equal(platform.configured, true);
    await platform.initTuyaSDK(config);
    assert.equal(platform.tuyaOpenApi.lang, options.lang);
    if (options.projectType === '2') assert.equal(platform.tuyaOpenApi.appSchema, 'smartlife');
    assert.deepEqual(errors, []);
    api.emit('shutdown');
    await platform.matterBridge.close();
  }
  assert.equal(starts, 2);
});

test('device type overrides remain isolated between platform instances', async t => {
  const first = fixture({ options: { accessoryType: [{ id: 'override-device', type: 'Switch' }] } });
  const second = fixture({ options: {} });
  t.after(() => Promise.all([first.platform.matterBridge.close(), second.platform.matterBridge.close()]));
  const device = { id: 'override-device', name: 'Override fixture', category: 'unknown', status: [{ code: 'switch', value: true }] };
  await first.platform.addAccessory(device);
  await second.platform.addAccessory(device);
  assert.equal(first.platform.deviceAccessories.size, 1);
  assert.equal(second.platform.deviceAccessories.size, 0);
});

test('platform errors redact known credentials and Axios request configuration', async t => {
  const { platform, errors } = fixture({ options: { ...credentials, appSchema: 'smartlife', countryCode: 86 } });
  t.after(() => platform.matterBridge.close());
  platform.reportError('initialize', new Error(Object.values(credentials).join(' ')));
  const axiosError = new Error('Request URL contains private data');
  axiosError.config = { auth: credentials };
  axiosError.response = { status: 401 };
  platform.reportError('initialize', axiosError);
  for (const value of Object.values(credentials)) assert.ok(!errors.join('\n').includes(value));
  assert.match(errors[1], /401/);
  assert.ok(!errors.join('\n').includes('Request URL'));
});

test('GUI and npm metadata advertise both transports without install-time system hooks', () => {
  assert.ok(manifest.keywords.includes('supports-hap'));
  assert.ok(manifest.keywords.includes('supports-matter'));
  for (const hook of ['preinstall', 'install', 'postinstall']) assert.equal(manifest.scripts[hook], undefined);
  assert.equal(manifest.dependencies.homebridge, undefined);
  assert.equal(manifest.dependencies['hap-nodejs'], undefined);
  assert.equal(manifest.dependencies['@homebridge/hap-nodejs'], undefined);
  const properties = schema.schema.properties.options.properties;
  assert.equal(properties.password.password, true);
  assert.equal(properties.accessKey.password, true);
  assert.equal(properties.projectType.default, '2');
  assert.equal(properties.appSchema.default, 'smartlife');
});
