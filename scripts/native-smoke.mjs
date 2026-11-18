// Read-only native smoke test through tauri-driver/WebKitWebDriver.
// Run the driver under a private Xvfb display before invoking this script.
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { execFileSync } from 'node:child_process';

const endpoint = 'http://127.0.0.1:4544';
const application = resolve(process.argv[2] ?? 'target/debug/shellguardian');
// Optional read-only Hermes card check: 'absent' or 'detected'. For 'detected',
// put an isolated Hermes wrapper on the driver's PATH; never a real profile.
const expectHermes = process.env.SHELLGUARDIAN_SMOKE_HERMES;
if (expectHermes && !['absent', 'detected'].includes(expectHermes)) {
  throw new Error('SHELLGUARDIAN_SMOKE_HERMES must be absent or detected');
}
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
  let hermes = null;
  if (expectHermes) {
    const foot = await until(
      `return document.querySelector('.hermes-foot')?.getAttribute('aria-label') ?? ''`,
      (value) =>
        expectHermes === 'detected'
          ? /^Hermes supervisor: Gateway (stopped|running)$/.test(value)
          : value === 'Hermes supervisor: Not detected',
      `native Hermes sidebar status reports ${expectHermes}`,
    );
    await execute(
      `Array.from(document.querySelectorAll('nav button')).find(button => button.textContent.trim() === 'Supervisor').click(); return true;`,
    );
    const region = expectHermes === 'detected' ? 'Hermes agents' : 'Install Hermes';
    hermes = await until(
      `return document.querySelector('[aria-label="${region}"]')?.innerText ?? ''`,
      (value) =>
        expectHermes === 'detected'
          ? value.includes('default') && value.includes('Create agent')
          : value.includes('Installation guide'),
      `native Supervisor page reports ${expectHermes}`,
    );
    assert.ok(!hermes.includes('Sample preview'));
    assert.ok(!hermes.includes('Unsupported'));
    await new Promise((resolve) => setTimeout(resolve, 500));
    const shot = await request(`/session/${session}/screenshot`);
    await writeFile(
      `test-results/native-supervisor-${expectHermes}.png`,
      Buffer.from(shot, 'base64'),
    );
    if (expectHermes === 'detected') {
      // Open the real in-app setup terminal for the isolated wrapper's
      // default profile, confirm Hermes renders, then close it (killing it).
      await execute(
        `Array.from(document.querySelectorAll('[aria-label="Hermes agents"] button')).find(button => button.textContent.trim() === 'Configure').click(); return true;`,
      );
      const output = await until(
        `return document.querySelector('dialog[aria-label="Configure default"] .xterm-rows')?.innerText ?? ''`,
        (value) => /hermes|setup|provider|model/i.test(value),
        'Hermes setup output in the in-app terminal',
      );
      assert.ok(output.length > 0);
      const terminalShot = await request(`/session/${session}/screenshot`);
      await writeFile(
        'test-results/native-hermes-setup-terminal.png',
        Buffer.from(terminalShot, 'base64'),
      );
      await execute(
        `Array.from(document.querySelectorAll('dialog[aria-label="Configure default"] button')).find(button => button.textContent.includes('Close terminal')).click(); return true;`,
      );
      await until(
        `return document.querySelector('dialog[aria-label="Configure default"]') === null`,
        Boolean,
        'setup terminal closed',
      );
    }
    hermes = foot;
  }
  console.log(
    JSON.stringify(
      {
        native: true,
        installedVersion: expectedVersion,
        gatewayConnected: true,
        releaseChecked: true,
        hermes: expectHermes ?? 'not checked',
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
