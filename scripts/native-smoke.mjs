// Read-only native smoke test through tauri-driver/WebKitWebDriver.
// Run the driver under a private Xvfb display before invoking this script.
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';

const endpoint = 'http://127.0.0.1:4544';
const application = resolve(process.argv[2] ?? 'target/debug/shellguardian');
// Screenshots default outside Playwright's test-results directory, which every
// Playwright run clears. Override with SHELLGUARDIAN_SMOKE_EVIDENCE.
const evidence = resolve(process.env.SHELLGUARDIAN_SMOKE_EVIDENCE ?? '.cache/native-smoke');
// Optional Supervisor check: 'absent', 'detected', or 'live'.
// - detected: put an isolated Hermes wrapper on the driver's PATH. Walks every
//   tab and opens (then closes) the setup terminal for the wrapper's profile.
// - live: the real installed Hermes. Strictly read-only: walks every tab and
//   takes screenshots; never sends a message, opens a terminal, or starts a gateway.
const expectHermes = process.env.SHELLGUARDIAN_SMOKE_HERMES;
const skipUpdate = process.env.SHELLGUARDIAN_SMOKE_SKIP_UPDATE === '1';
if (expectHermes && !['absent', 'detected', 'live'].includes(expectHermes)) {
  throw new Error('SHELLGUARDIAN_SMOKE_HERMES must be absent, detected, or live');
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
  let last;
  while (Date.now() < deadline) {
    last = await execute(script);
    if (predicate(last)) return last;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  // What the page showed helps tell a slow network from a real regression.
  const seen = typeof last === 'string' ? last.replace(/\s+/g, ' ').slice(-400) : String(last);
  throw new Error(`Native check timed out: ${description}. Last seen: ${seen}`);
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
  await mkdir(evidence, { recursive: true });
  const overview = await request(`/session/${session}/screenshot`);
  await writeFile(join(evidence, 'native-overview.png'), Buffer.from(overview, 'base64'));

  // The update check calls GitHub, which rate-limits unauthenticated clients.
  // SHELLGUARDIAN_SMOKE_SKIP_UPDATE=1 skips only that step and says so below.
  if (!skipUpdate) {
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
    await writeFile(join(evidence, 'native-settings.png'), Buffer.from(screenshot, 'base64'));
  }
  if (expectHermes) {
    const live = expectHermes !== 'absent';
    await until(
      `return document.querySelector('.hermes-foot')?.getAttribute('aria-label') ?? ''`,
      (value) =>
        live
          ? /^Hermes supervisor: Gateway (stopped|running)$/.test(value)
          : value === 'Hermes supervisor: Not detected',
      `native Hermes sidebar status reports ${expectHermes}`,
    );
    await execute(
      `Array.from(document.querySelectorAll('nav button')).find(button => button.textContent.trim() === 'Supervisor').click(); return true;`,
    );
    const shot = async (name) => {
      await new Promise((resolve) => setTimeout(resolve, 600));
      const image = await request(`/session/${session}/screenshot`);
      await writeFile(
        join(evidence, `native-supervisor-${name}.png`),
        Buffer.from(image, 'base64'),
      );
    };
    const panel = `document.querySelector('#supervisor-panel')?.innerText ?? ''`;
    const openTab = (name) =>
      execute(`document.querySelector('#supervisor-tab-${name}').click(); return true;`);
    if (!live) {
      const card = await until(
        `return document.querySelector('[aria-label="Install Hermes"]')?.innerText ?? ''`,
        (value) => value.includes('Installation guide'),
        'native Supervisor page offers the installer',
      );
      assert.ok(!card.includes('Sample preview'));
      await shot('absent');
    } else {
      // Read-only pass over every tab. Nothing here sends a message, starts a
      // gateway, or changes a profile.
      await until(
        `return Boolean(document.querySelector('[aria-label="Supervisor chat"] textarea'))`,
        Boolean,
        'native chat composer renders',
      );
      const chat = await until(
        `return ${panel}`,
        (value) => !value.includes('Checking usage'),
        'native usage limits settle',
      );
      assert.ok(!chat.includes('Sample preview'));
      await shot(`${expectHermes}-chat`);

      await openTab('board');
      await until(
        `return [Boolean(document.querySelector('.sv-board')), ${panel}]`,
        ([board, text]) =>
          text.includes('New task') && (board || text.includes('No tasks on this board yet')),
        'native board renders columns or its empty state',
      );
      await shot(`${expectHermes}-board`);

      await openTab('agents');
      const agents = await until(
        `return document.querySelector('[aria-label="Hermes agents"]')?.innerText ?? ''`,
        (value) => value.includes('default') && value.includes('New agent'),
        'native agent cards render',
      );
      assert.ok(!agents.includes('Sample preview'));
      await until(
        `return ${panel}`,
        (value) =>
          value.includes('Use this model') || value.includes('gateway, which is not running'),
        'native provider panel reports providers or asks to start the gateway',
      );
      await shot(`${expectHermes}-agents`);

      await openTab('sessions');
      await until(
        `return [document.querySelectorAll('[aria-label="Hermes sessions"] .sv-list-item').length, document.querySelector('[aria-label="Hermes sessions"]')?.innerText ?? '']`,
        ([rows, text]) => rows > 0 || text.includes('No sessions here yet'),
        'native sessions list renders rows or its empty state',
      );
      await shot(`${expectHermes}-sessions`);

      await openTab('schedules');
      await until(
        `return [document.querySelectorAll('[aria-label="Hermes schedules"] .sv-schedule').length, document.querySelector('[aria-label="Hermes schedules"]')?.innerText ?? '']`,
        ([rows, text]) =>
          rows > 0 ||
          text.includes('No scheduled jobs') ||
          text.includes('gateway, which is not running'),
        'native schedules render jobs, an empty state, or the gateway notice',
      );
      await shot(`${expectHermes}-schedules`);

      if (expectHermes === 'detected') {
        // Isolated wrapper only: open the real in-app setup terminal for its
        // default profile, confirm Hermes renders, then close it (killing it).
        await openTab('agents');
        await until(
          `return Boolean(document.querySelector('button[aria-label="Open setup for default"]'))`,
          Boolean,
          'setup button renders',
        );
        await execute(
          `document.querySelector('button[aria-label="Open setup for default"]').click(); return true;`,
        );
        const output = await until(
          `return document.querySelector('dialog[aria-label="Configure default"] .xterm-rows')?.innerText ?? ''`,
          (value) => /hermes|setup|provider|model/i.test(value),
          'Hermes setup output in the in-app terminal',
        );
        assert.ok(output.length > 0);
        await shot('setup-terminal');
        await execute(
          `Array.from(document.querySelectorAll('dialog[aria-label="Configure default"] button')).find(button => button.textContent.includes('Close terminal')).click(); return true;`,
        );
        await until(
          `return document.querySelector('dialog[aria-label="Configure default"]') === null`,
          Boolean,
          'setup terminal closed',
        );
      }
    }
  }
  console.log(
    JSON.stringify(
      {
        native: true,
        installedVersion: expectedVersion,
        gatewayConnected: true,
        releaseChecked: !skipUpdate,
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
