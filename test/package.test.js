const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const root = path.resolve(__dirname, '..');
const distribution = require('../package.json');
const homebridgePath = path.dirname(require.resolve('homebridge'));
const { HomebridgeAPI } = require(path.join(homebridgePath, 'api.js'));
const { PluginManager } = require(path.join(homebridgePath, 'pluginManager.js'));

test('the requested npm name is a valid Homebridge plugin identity at the package root', () => {
  assert.equal(distribution.name, '@linanw/homebridge-tuya-platform');
  assert.equal(PluginManager.isQualifiedPluginIdentifier(distribution.name), true);
  assert.equal(PluginManager.loadPackageJSON(root).name, distribution.name);
});

test('Homebridge discovers and initializes the scoped package from a node_modules directory', async t => {
  const installed = fs.mkdtempSync(path.join(os.tmpdir(), 'tuya-plugin-discovery-'));
  t.after(() => fs.rmSync(installed, { recursive: true, force: true }));
  const scope = path.join(installed, '@linanw');
  fs.mkdirSync(scope);
  fs.symlinkSync(root, path.join(scope, 'homebridge-tuya-platform'), 'dir');
  const api = new HomebridgeAPI();
  const manager = new PluginManager(api, { customPluginPath: installed, strictPluginResolution: true });
  await manager.initializeInstalledPlugins();
  assert.equal(manager.plugins.size, 1);
  const loaded = manager.getPlugin('@linanw/homebridge-tuya-platform');
  assert.ok(loaded, 'Homebridge must discover the installed package without a wrapper entry');
  assert.equal(loaded.version, distribution.version);
  assert.equal(typeof loaded.getPlatformConstructor('TuyaPlatform'), 'function');
  assert.equal(manager.getPluginForPlatform('TuyaPlatform'), loaded);
  assert.equal(manager.pluginIdentifierTranslation.size, 0, 'runtime registration must preserve the previous Homebridge identity');
});

test('the public npm archive contains working runtime imports and excludes local configuration and development files', () => {
  const cache = fs.mkdtempSync(path.join(os.tmpdir(), 'tuya-package-audit-'));
  try {
    const args = ['pack', '--dry-run', '--json', '--ignore-scripts', '--cache', cache];
    const npm = process.env.npm_execpath;
    const result = npm
      ? spawnSync(process.execPath, [npm, ...args], { cwd: root, encoding: 'utf8' })
      : spawnSync(process.platform === 'win32' ? 'npm.cmd' : 'npm', args, { cwd: root, encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr || result.error && result.error.message);
    const archive = JSON.parse(result.stdout)[0];
    assert.equal(archive.name, '@linanw/homebridge-tuya-platform');
    assert.equal(archive.version, distribution.version);
    for (const file of archive.files) {
      assert.equal(file.mode & 0o444, 0o444, `${file.path} must remain readable by the Homebridge service account after a global install`);
    }
    const files = new Set(archive.files.map(file => file.path));
    for (const required of ['index.js', 'package.json', 'lib/matter_bridge.js', 'lib/matter_devices.js', 'config.schema.json', 'README.md', 'README.zh-CN.md', 'CHANGELOG.md', 'LICENSE']) {
      assert.ok(files.has(required), `${required} is required in the published archive`);
    }
    const forbidden = [...files].filter(file => /^(test|config|homebridge|\.github|node_modules)\//.test(file)
      || /(?:^|\/)\.(?:env(?:\.|$)|npmrc$)/.test(file)
      || /\.(pem|key|log|tgz)$/.test(file));
    assert.deepEqual(forbidden, [], 'the release must exclude development files and credential/configuration paths');
    for (const file of files) {
      if (!file.endsWith('.js')) continue;
      const source = fs.readFileSync(path.join(root, file), 'utf8');
      for (const match of source.matchAll(/require\(\s*['"](\.[^'"]+)['"]\s*\)/g)) {
        const imported = path.posix.normalize(path.posix.join(path.posix.dirname(file), match[1]));
        assert.ok(!imported.startsWith('../'), `${file} must not import files outside the published package`);
        const candidates = [imported, `${imported}.js`, `${imported}.json`, `${imported}/index.js`, `${imported}/package.json`];
        assert.ok(candidates.some(candidate => files.has(candidate)), `${file} imports missing packaged module ${match[1]}`);
      }
    }
  } finally {
    fs.rmSync(cache, { recursive: true, force: true });
  }
});
