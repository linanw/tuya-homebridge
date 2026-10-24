const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '../..');
const tag = process.argv[2];
const match = /^v?(\d+\.\d+\.\d+)$/.exec(tag || '');
if (!match) throw new Error('Provide a stable version tag such as v2.6.1');
const version = match[1];
const manifest = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
if (manifest.version !== version) throw new Error(`Tag ${tag} does not match package version ${manifest.version}`);

const changelog = fs.readFileSync(path.join(root, 'CHANGELOG.md'), 'utf8').replace(/\r\n/g, '\n');
const lines = changelog.split('\n');
const start = lines.findIndex(line => line.startsWith(`## [${version}] `));
if (start < 0) throw new Error(`CHANGELOG.md has no release entry for ${version}`);
const next = lines.findIndex((line, index) => index > start && line.startsWith('## '));
const notes = lines.slice(start + 1, next < 0 ? undefined : next).join('\n').trim();
if (!notes.includes('### English') || !notes.includes('### 简体中文')) {
  throw new Error('Release notes must include both English and Simplified Chinese');
}
process.stdout.write(`${notes}\n`);
