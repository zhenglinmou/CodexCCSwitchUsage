import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import test from 'node:test';
import path from 'node:path';
import { EdgeSession, findEdgeExecutable, parseBrowserJson } from '../src/edge-session.mjs';

test('Edge discovery checks machine and user installation locations', () => {
  const environment = {
    PROGRAMFILES: 'C:\\Program Files',
    'PROGRAMFILES(X86)': 'C:\\Program Files (x86)',
    LOCALAPPDATA: 'C:\\Users\\Tester\\AppData\\Local',
  };
  const expected = path.join(environment.LOCALAPPDATA, 'Microsoft', 'Edge', 'Application', 'msedge.exe');
  assert.equal(findEdgeExecutable(environment, candidate => candidate === expected), expected);
});

test('browser JSON parsing accepts raw and Chromium viewer text without HTML', () => {
  assert.deepEqual(parseBrowserJson('{"success":true}'), { success: true });
  assert.deepEqual(parseBrowserJson('response\n{"data":{"quota":1}}\n'), { data: { quota: 1 } });
  assert.equal(parseBrowserJson('<html>WAF challenge</html>'), null);
  assert.equal(parseBrowserJson('x'.repeat(2_000_001)), null);
});

test('Edge login intent is tracked per provider origin instead of per browser profile', t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-edge-state-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const session = new EdgeSession(directory, { edgeExecutable: 'unused.exe' });

  assert.equal(session.hasLoginState('https://agentrouter.org'), false);
  session.noteLoginOpened('https://agentrouter.org/login');
  assert.equal(session.hasLoginState('https://agentrouter.org'), true);
  assert.equal(session.hasLoginState('https://chatgpt.com'), false);
});
