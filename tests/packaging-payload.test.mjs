import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

test('EXE payload includes every relative module imported by packaged sources', () => {
  const buildScript = fs.readFileSync(path.join(root, 'scripts', 'build-exe.ps1'), 'utf8');
  const payloadBlock = /\$payloadFiles\s*=\s*@\(([\s\S]*?)\r?\n\)/.exec(buildScript)?.[1];
  assert.ok(payloadBlock, 'build-exe.ps1 payload list was not found');

  const payload = new Set(
    [...payloadBlock.matchAll(/'([^']+)'/g)]
      .map((match) => match[1].replaceAll('\\', '/')),
  );

  for (const relativeFile of payload) {
    if (!relativeFile.startsWith('src/') || !relativeFile.endsWith('.mjs')) continue;
    const source = fs.readFileSync(path.join(root, relativeFile), 'utf8');
    for (const match of source.matchAll(/\bfrom\s+['"](\.[^'"]+)['"]/g)) {
      const imported = path.posix.normalize(path.posix.join(path.posix.dirname(relativeFile), match[1]));
      assert.ok(payload.has(imported), `${relativeFile} imports ${imported}, but the EXE payload omits it`);
    }
  }
});
