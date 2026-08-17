import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import zlib from 'node:zlib';
import { createMacosArchive } from '../scripts/create-macos-archive.mjs';

function archiveEntries(filename) {
  const tar = zlib.gunzipSync(fs.readFileSync(filename));
  const entries = [];
  for (let offset = 0; offset + 512 <= tar.length;) {
    const header = tar.subarray(offset, offset + 512);
    if (header.every(value => value === 0)) break;
    const text = (start, length) => header.subarray(start, start + length).toString('utf8').replace(/\0.*$/, '');
    const name = text(0, 100);
    const prefix = text(345, 155);
    const size = Number.parseInt(text(124, 12).trim() || '0', 8);
    entries.push(prefix ? `${prefix}/${name}` : name);
    offset += 512 + Math.ceil(size / 512) * 512;
  }
  return entries;
}

test('macOS archives are deterministic and preserve long ustar paths', t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'ccswitch-macos-archive-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const appRoot = path.join(directory, 'CodexCCSwitchUsage-macOS-arm64.app');
  const relative = path.join('Contents', 'Resources', 'app', 'browser-companion', 'session-state.js');
  fs.mkdirSync(path.dirname(path.join(appRoot, relative)), { recursive: true });
  fs.writeFileSync(path.join(appRoot, relative), 'export const stable = true;\n');
  const first = path.join(directory, 'first.tar.gz');
  const second = path.join(directory, 'second.tar.gz');

  createMacosArchive(appRoot, first);
  fs.utimesSync(path.join(appRoot, relative), new Date(), new Date());
  createMacosArchive(appRoot, second);

  const digest = filename => crypto.createHash('sha256').update(fs.readFileSync(filename)).digest('hex');
  assert.equal(digest(first), digest(second));
  assert.ok(archiveEntries(first).includes(`${path.basename(appRoot)}/${relative.replaceAll(path.sep, '/')}`));
});

test('macOS build uses a persistent verified download cache and an explicit payload allowlist', () => {
  const source = fs.readFileSync(new URL('../scripts/build-macos-package.ps1', import.meta.url), 'utf8');
  assert.match(source, /\[string\]\$DownloadRoot/);
  assert.match(source, /LocalApplicationData/);
  assert.match(source, /if \(Test-Path -LiteralPath \$buildRoot\).*Remove-Item/);
  assert.doesNotMatch(source, /Copy-Item[^\r\n]*\(Join-Path \$root 'src'\)[^\r\n]*-Recurse/);
  assert.doesNotMatch(source, /Copy-Item[^\r\n]*\(Join-Path \$root 'browser-companion'\)[^\r\n]*-Recurse/);
  assert.match(source, /\.orig\$/);
  for (const required of ['src\\host.mjs', 'src\\secure-files.mjs', 'src\\companion-auth.mjs', 'browser-companion\\auth.js']) {
    assert.ok(source.includes(`'${required}'`), `${required} is missing from the macOS allowlist`);
  }
  for (const legacy of ['src\\usage-client.mjs', 'src\\evaluator.mjs', 'src\\evaluator-worker.mjs']) {
    assert.equal(source.includes(`'${legacy}'`), false, `${legacy} must not ship in the v3 macOS payload`);
  }
});
