// Read-only native smoke test through tauri-driver/WebKitWebDriver.
// Run the driver under a private Xvfb display before invoking this script.
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { execFileSync } from 'node:child_process';

const endpoint = 'http://127.0.0.1:4544';
const application = resolve(process.argv[2] ?? 'target/debug/shellguardian');
let session;

async function request(path, method = 'GET', body) {
  const response = await fetch(`${endpoint}${path}`, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(40_000),
  });
  const result = await response.json();
  if (!response.ok || result.value?.error) {
    throw new Error(`Native WebDriver failed: ${result.value?.error ?? response.status}`);
  }
  return result.value;
}

async function execute(script) {
  return request(`/session/${session}/execute/sync`, 'POST', { script, args: [] });
}

async function until(script, predicate, description) {
  const deadline = Date.now() + 35_000;
  while (Date.now() < deadline) {
    const result = await execute(script);
    if (predicate(result)) return result;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`Native check timed out: ${description}`);
}

try {
  const started = await request('/session', 'POST', {
    capabilities: { alwaysMatch: { 'tauri:options': { application } } },
  });
  session = started.sessionId;
  const expectedVersion = execFileSync('openshell', ['--version'], { encoding: 'utf8' })
    .trim()
    .split(/\s+/)
    .at(-1);
  const body = await until(
    'return document.body.innerText',
    (value) =>
      value.includes('Connected to OpenShell') && value.includes(`OpenShell v${expectedVersion}`),
    'real gateway snapshot in the native webview',
  );
  assert.ok(!body.includes('Sample preview'));
  assert.ok(!body.includes('Illustrative agents only'));
  assert.equal(await execute('return window.isTauri'), true);
  assert.deepEqual(await execute('return [localStorage.length, sessionStorage.length]'), [0, 0]);
  await mkdir('test-results', { recursive: true });
  const overview = await request(`/session/${session}/screenshot`);
  await writeFile('test-results/native-overview.png', Buffer.from(overview, 'base64'));

  await execute(
    `Array.from(document.querySelectorAll('button')).find(button => button.textContent.includes('OpenShell & settings')).click(); return true;`,
  );
  const settings = await until(
    'return document.body.innerText',
    (value) =>
      value.includes('You’re on the latest stable release') ||
      value.includes('is available') ||
      value.includes('ahead of the stable release'),
    'official native update check',
  );
  assert.ok(settings.includes(expectedVersion));
  const screenshot = await request(`/session/${session}/screenshot`);
  await writeFile('test-results/native-settings.png', Buffer.from(screenshot, 'base64'));
  console.log(
    JSON.stringify(
      {
        native: true,
        installedVersion: expectedVersion,
        gatewayConnected: true,
        releaseChecked: true,
        storageEntries: 0,
        mutationsPerformed: false,
      },
      null,
      2,
    ),
  );
} finally {
  if (session) await request(`/session/${session}`, 'DELETE').catch(() => {});
}
