// Real Tauri IPC and persisted opt-out, against an isolated updater fixture only.
// The fixture is a release-mode 0.1.0 executable; APPIMAGE points to its writable
// cache copy. A published, signed AppImage replaces it on normal window close.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

const application = resolve(process.argv[2] ?? '.cache/shellguardian-update-fixture.AppImage');
const preferencePath = resolve(
  process.argv[3] ?? '.cache/native-update-test/config/bot.recurse.shellguardian/preferences.json',
);
const mode = process.argv[4] ?? 'preferences';
const endpoint = 'http://127.0.0.1:4544';
let session;
const digest = async (file) =>
  createHash('sha256')
    .update(await readFile(file))
    .digest('hex');
async function request(path, method = 'GET', body) {
  const response = await fetch(endpoint + path, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(40_000),
  });
  const result = await response.json();
  if (!response.ok || result.value?.error)
    throw new Error(`WebDriver: ${result.value?.error ?? response.status}`);
  return result.value;
}
const execute = (script) =>
  request(`/session/${session}/execute/sync`, 'POST', { script, args: [] });
async function ipc(command, args = {}) {
  return request(`/session/${session}/execute/async`, 'POST', {
    script: `const done = arguments[arguments.length - 1]; window.__TAURI_INTERNALS__.invoke(${JSON.stringify(command)}, ${JSON.stringify(args)}).then(done, e => done({ipcError:String(e)}));`,
    args: [],
  });
}
async function until(work, predicate, label, seconds = 40) {
  const deadline = Date.now() + seconds * 1000;
  let value;
  while (Date.now() < deadline) {
    value = await work();
    if (predicate(value)) return value;
    await new Promise((done) => setTimeout(done, 250));
  }
  throw new Error(`Timed out: ${label}: ${JSON.stringify(value)}`);
}
async function start() {
  const result = await request('/session', 'POST', {
    capabilities: { alwaysMatch: { 'tauri:options': { application } } },
  });
  session = result.sessionId;
  await until(
    () => execute('return document.body.innerText'),
    (text) => text.includes('OpenShell & settings'),
    'native frontend',
  );
  assert.equal(await execute('return window.isTauri === true'), true);
  await execute(
    'Array.from(document.querySelectorAll("button")).find(b => b.textContent.trim() === "OpenShell & settings").click(); return true;',
  );
}
async function stop() {
  if (session) await request(`/session/${session}`, 'DELETE').catch(() => {});
  session = undefined;
}
try {
  const originalHash = await digest(application);
  await start();
  let status = await ipc('get_shellguardian_update');
  assert.equal(
    status.appVersion,
    '0.1.0',
    'The native old-version fixture must really report 0.1.0',
  );
  assert.equal(status.supported, true);
  if (mode === 'preferences') {
    assert.equal(status.enabled, true, 'First launch defaults on');
    await execute('document.querySelector("#auto-update").click(); return true;');
    await until(
      () => ipc('get_shellguardian_update'),
      (value) => value.enabled === false,
      'opt-out acknowledged',
    );
    assert.deepEqual(JSON.parse(await readFile(preferencePath, 'utf8')), { autoUpdate: false });
    await stop();
    await start();
    status = await ipc('get_shellguardian_update');
    assert.equal(status.enabled, false, 'Opt-out persists across a real native restart');
    assert.equal(await execute('return document.querySelector("#auto-update").checked'), false);
    assert.equal(await digest(application), originalHash);
    await execute('document.querySelector("#auto-update").click(); return true;');
    await until(
      () => ipc('get_shellguardian_update'),
      (value) => value.enabled === true,
      're-enable acknowledged',
    );
    assert.deepEqual(JSON.parse(await readFile(preferencePath, 'utf8')), { autoUpdate: true });
    console.log(
      JSON.stringify({
        native: true,
        firstLaunchEnabled: true,
        persistedOptOut: true,
        reenabled: true,
        openshellMutations: false,
      }),
    );
  } else if (mode === 'update') {
    status = await until(
      () => ipc('get_shellguardian_update'),
      (value) => value.phase === 'ready',
      'published signed update staged',
      180,
    );
    assert.equal(status.enabled, true);
    assert.equal(status.latestVersion, '0.2.0');
    assert.equal(await digest(application), originalHash, 'Download alone does not install');
    assert.equal(await execute('return localStorage.length + sessionStorage.length'), 0);
    await mkdir('test-results', { recursive: true });
    await writeFile(
      'test-results/native-auto-updates.png',
      Buffer.from(await request(`/session/${session}/screenshot`), 'base64'),
    );
    const published = resolve('.cache/public-release/ShellGuardian_0.2.0_amd64.AppImage');
    const expectedHash = await digest(published);
    // This is the same core-window close used by the user, not a forced process kill.
    const closed = await ipc('plugin:window|close', { label: 'main' }).catch(() => null);
    assert.ok(!closed?.ipcError, `Close did not reach the native window: ${closed?.ipcError}`);
    const actualHash = await until(
      async () => {
        try {
          return await digest(application);
        } catch {
          return '';
        }
      },
      (hash) => hash === expectedHash,
      'normal-close installation',
      25,
    );
    assert.notEqual(actualHash, originalHash);
    console.log(
      JSON.stringify({
        native: true,
        fromVersion: '0.1.0',
        signedRelease: status.latestVersion,
        stagedBeforeClose: true,
        installedOnNormalClose: true,
        matchesPublicAppImage: true,
        sha256: actualHash,
        openshellMutations: false,
      }),
    );
  } else throw new Error('Use preferences or update mode.');
} finally {
  await stop();
}
