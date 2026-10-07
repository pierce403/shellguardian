// Real Tauri/WebKit/PTy acceptance against one explicitly supplied disposable sandbox.
// Root/operator creates and deletes it; this script never provisions or stops a sandbox.
// node scripts/native-interaction-smoke.mjs target/debug/shellguardian sg-term-1006-a
// For a plain cargo build, set SHELLGUARDIAN_NATIVE_DEV=1 to own a Vite dev server.
// Evidence defaults outside Playwright's cleared test-results directory; override
// SHELLGUARDIAN_INTERACTION_EVIDENCE for a specific release acceptance run.
import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { mkdir, readdir, readFile, readlink, symlink, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { basename, resolve, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import net from 'node:net';
import { startSshFixture } from './ssh-fixture.mjs';

const application = resolve(process.argv[2] ?? 'target/debug/shellguardian');
const evidenceDirectory = resolve(
  process.env.SHELLGUARDIAN_INTERACTION_EVIDENCE ?? '.cache/native-interaction',
);
const sandboxName = process.argv[3];
const gateway = 'openshell';
const scope = { gateway, workspace: 'default' };
const systemGatewayDirectory = resolve(
  process.env.SHELLGUARDIAN_FIXTURE_GATEWAYS ?? '/home/pierce/.config/openshell',
);
const driverPath = resolve(process.env.TAURI_DRIVER ?? '.cache/tauri-driver/bin/tauri-driver');
const webkitPath = resolve(
  process.env.WEBKIT_DRIVER ?? '.cache/native/sysroot/usr/bin/WebKitWebDriver',
);
const ownedChildren = [];
const ownedConnections = [];
const ownedTerminals = new Set();
const runNonce = randomUUID().slice(0, 8);
const pause = (ms) => new Promise((done) => setTimeout(done, ms));
let fixture;
let environment;
let displayEnvironment;
let closeWindowHelper;
let endpoint;
let session;
let cleanupPromise;
let nativePid;

async function cleanup() {
  cleanupPromise ??= (async () => {
    if (session) {
      for (const sessionId of ownedTerminals)
        await ipc('close_agent_terminal', { sessionId }).catch(() => {});
      for (const connection of ownedConnections)
        await ipc('disconnect_ssh_gateway', { connectionId: connection.id }).catch(() => {});
      if (closeWindowHelper && displayEnvironment) {
        try {
          execFileSync(closeWindowHelper, [], { env: displayEnvironment, stdio: 'pipe' });
          await pause(500);
        } catch {
          // It may already have closed normally.
        }
      }
      await request(`/session/${session}`, 'DELETE').catch(() => {});
      session = undefined;
    }
    for (const process of ownedChildren.reverse()) {
      if (!process.pid) continue;
      if (process.exitCode !== null || process.signalCode !== null) continue;
      for (const signal of ['SIGTERM', 'SIGKILL']) {
        try {
          globalThis.process.kill(-process.pid, signal);
        } catch (error) {
          if (error.code !== 'ESRCH') throw error;
        }
        await pause(100);
        if (process.exitCode !== null || process.signalCode !== null) break;
      }
    }
    // Includes only the private XDG tree, its mTLS symlink, and private SSH files.
    await fixture?.cleanup();
  })();
  return cleanupPromise;
}

for (const [signal, exitCode] of [
  ['SIGINT', 130],
  ['SIGTERM', 143],
])
  process.once(signal, () => void cleanup().finally(() => process.exit(exitCode)));

function child(file, args, options = {}) {
  const process = spawn(file, args, {
    detached: true,
    stdio: ['ignore', 'ignore', 'ignore'],
    ...options,
  });
  // Do not capture native/terminal output in fixture diagnostics.
  process.on('error', () => {});
  ownedChildren.push(process);
  return process;
}

async function until(work, predicate, label, seconds = 35) {
  const deadline = Date.now() + seconds * 1000;
  while (Date.now() < deadline) {
    const value = await work();
    if (predicate(value)) return value;
    await pause(100);
  }
  // Never append the last value: it can contain terminal output.
  throw new Error(`Timed out: ${label}`);
}

async function unusedPort() {
  const server = net.createServer();
  await new Promise((done, fail) => server.once('error', fail).listen(0, '127.0.0.1', done));
  const port = server.address().port;
  await new Promise((done) => server.close(done));
  return port;
}

async function processIdentity(pid) {
  try {
    const stat = await readFile(`/proc/${pid}/stat`, 'utf8');
    const fields = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
    return { pid, started: fields[19] };
  } catch (error) {
    if (error.code === 'ENOENT' || error.code === 'ESRCH') return null;
    throw error;
  }
}

async function descendants(pid) {
  let children;
  try {
    const threads = await readdir(`/proc/${pid}/task`);
    const childLists = await Promise.all(
      threads.map((thread) =>
        readFile(`/proc/${pid}/task/${thread}/children`, 'utf8').catch(() => ''),
      ),
    );
    children = [...new Set(childLists.join(' ').trim().split(/\s+/).filter(Boolean).map(Number))];
  } catch (error) {
    if (error.code === 'ENOENT' || error.code === 'ESRCH') return [];
    throw error;
  }
  const result = [];
  for (const child of children) {
    const identity = await processIdentity(child);
    if (identity) result.push(identity, ...(await descendants(child)));
  }
  return result;
}

async function interactiveProcesses() {
  const result = [];
  // Only inspect this fixture app's descendants. No machine-wide command scan,
  // command-line credentials, or signals to these observed PIDs are needed.
  for (const identity of await descendants(nativePid)) {
    const command = await readFile(`/proc/${identity.pid}/comm`, 'utf8').catch(() => '');
    if (/^(?:openshell|ssh)\n$/.test(command)) result.push(identity);
  }
  assert.ok(result.length > 0, 'The fixture must observe its real CLI/SSH children.');
  return result;
}

async function processesEnded(identities, label) {
  await until(
    async () => {
      for (const identity of identities) {
        const current = await processIdentity(identity.pid);
        if (current?.started === identity.started) return false;
      }
      return true;
    },
    Boolean,
    label,
    10,
  );
}

async function portOpen(port) {
  return new Promise((done) => {
    const socket = net.connect({ host: '127.0.0.1', port });
    const finish = (open) => {
      socket.destroy();
      done(open);
    };
    socket.once('connect', () => finish(true));
    socket.once('error', () => finish(false));
    socket.setTimeout(500, () => finish(false));
  });
}

function cli(args) {
  try {
    return JSON.parse(
      execFileSync('openshell', ['--color', 'never', ...args], {
        env: environment,
        encoding: 'utf8',
        timeout: 20_000,
        stdio: ['ignore', 'pipe', 'pipe'],
      }),
    );
  } catch {
    throw new Error('Fixture OpenShell metadata check failed; command output withheld.');
  }
}

function sandbox() {
  return cli([
    '--gateway',
    gateway,
    '--workspace',
    'default',
    'sandbox',
    'get',
    sandboxName,
    '--output',
    'json',
  ]);
}

function checkOwnedSandbox() {
  const current = sandbox();
  assert.equal(current.name, sandboxName);
  assert.equal(current.workspace, 'default');
  assert.equal(
    current.labels?.['managed-by'],
    'shellguardian-terminal-smoke',
    'Refusing to attach a sandbox that lacks the exact disposable-fixture label.',
  );
  assert.equal(current.phase, 'Ready', 'The disposable sandbox main process must remain Ready.');
  return current.id;
}

function checkNoProviders() {
  const result = cli([
    '--gateway',
    gateway,
    '--workspace',
    'default',
    'sandbox',
    'provider',
    'list',
    sandboxName,
    '--output',
    'json',
  ]);
  const providers = Array.isArray(result) ? result : result.providers;
  assert.ok(
    Array.isArray(providers) && providers.length === 0,
    'The disposable terminal fixture must have no attached credential providers.',
  );
}

async function request(path, method = 'GET', body) {
  const response = await fetch(endpoint + path, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(45_000),
  }).catch(() => {
    throw new Error(`WebDriver request timed out or failed: ${method} ${path}`);
  });
  const result = await response.json();
  if (!response.ok || result.value?.error)
    throw new Error(
      `WebDriver failed (${result.value?.error ?? response.status}); details withheld.`,
    );
  return result.value;
}

const execute = (script, args = []) =>
  request(`/session/${session}/execute/sync`, 'POST', { script, args });
const ipc = (command, args = {}) =>
  request(`/session/${session}/execute/async`, 'POST', {
    script:
      'const done = arguments[arguments.length - 1]; window.__TAURI_INTERNALS__.invoke(arguments[0], arguments[1]).then(done, error => done({ipcError: error?.message ?? String(error)}));',
    args: [command, args],
  });
function ipcSucceeded(result, label) {
  assert.ok(!result?.ipcError, `${label} failed; native error withheld.`);
  return result;
}

async function uiOpen(kind) {
  await until(
    () =>
      execute(
        `return Array.from(document.querySelectorAll('button')).some(b => b.getAttribute('aria-label') === arguments[0])`,
        [`Inspect ${sandboxName}`],
      ),
    Boolean,
    'fixture agent card',
  );
  const drawerOpen = await execute(
    `return !!document.querySelector('dialog[open][aria-label=' + JSON.stringify(arguments[0]) + ']')`,
    [`Agent details for ${sandboxName}`],
  );
  if (!drawerOpen)
    await execute(
      `Array.from(document.querySelectorAll('button')).find(b => b.getAttribute('aria-label') === arguments[0]).click(); return true`,
      [`Inspect ${sandboxName}`],
    );
  const buttonText = kind === 'agent' ? 'Talk to agent' : 'Open terminal';
  await until(
    () =>
      execute(
        `const d = document.querySelector('dialog[open][aria-label=' + JSON.stringify(arguments[0]) + ']'); return !!d && Array.from(d.querySelectorAll('button')).some(b => b.textContent.trim() === arguments[1] && !b.disabled)`,
        [`Agent details for ${sandboxName}`, buttonText],
      ),
    Boolean,
    'fixture interaction button',
  );
  await execute(
    `const d = document.querySelector('dialog[open][aria-label=' + JSON.stringify(arguments[0]) + ']'); Array.from(d.querySelectorAll('button')).find(b => b.textContent.trim() === arguments[1]).click(); return true`,
    [`Agent details for ${sandboxName}`, buttonText],
  );
  await until(
    () => execute(`return document.querySelector('.agent-terminal-status')?.textContent ?? ''`),
    (text) => /(?:Connected\.|Terminal open\.)/.test(text),
    'native interactive terminal',
  );
  assert.equal(
    await execute(
      `return document.querySelector('.agent-terminal-dialog')?.getAttribute('aria-label')`,
    ),
    `${kind === 'agent' ? 'Talk to agent' : 'Terminal'}: ${sandboxName}`,
  );
  if (kind === 'terminal')
    await until(uiOutput, (text) => /\$\s*(?:\n\s*)*$/.test(text), 'fixture shell prompt');
}

async function uiType(text) {
  const element = await request(`/session/${session}/element`, 'POST', {
    using: 'css selector',
    value: 'dialog[open].agent-terminal-dialog .xterm-helper-textarea',
  });
  const id = element['element-6066-11e4-a52e-4f735466cecf'];
  assert.ok(id, 'xterm must expose its keyboard input textarea.');
  await request(`/session/${session}/element/${id}/value`, 'POST', { text, value: [...text] });
}

const uiOutput = () =>
  execute(
    String.raw`return Array.from(document.querySelectorAll('dialog[open].agent-terminal-dialog .xterm-rows > div')).map(row => row.textContent).join('\n')`,
  );

async function uiClose(kind) {
  await execute(
    `Array.from(document.querySelectorAll('dialog[open].agent-terminal-dialog button')).find(b => b.textContent.trim() === arguments[0]).click(); return true`,
    [kind === 'agent' ? 'Detach agent' : 'Close terminal'],
  );
  await until(
    () => execute(`return !document.querySelector('dialog[open].agent-terminal-dialog')`),
    Boolean,
    'terminal UI detached',
  );
  checkOwnedSandbox();
}

async function openTerminal(kind, connectionId) {
  checkOwnedSandbox();
  const result = ipcSucceeded(
    await ipc('open_agent_terminal', {
      scope: { ...scope, connectionId },
      name: sandboxName,
      kind,
      cols: 100,
      rows: 31,
    }),
    `Open ${kind}`,
  );
  assert.equal(result.kind, kind);
  assert.equal(typeof result.id, 'string');
  ownedTerminals.add(result.id);
  return result.id;
}

async function terminalOutput(sessionId, predicate, label) {
  let output = '';
  return until(
    async () => {
      const frame = ipcSucceeded(await ipc('read_agent_terminal', { sessionId }), 'Read terminal');
      assert.ok(!frame.error, 'Interactive transport unexpectedly failed; output withheld.');
      assert.ok(Array.isArray(frame.data) && frame.data.length <= 65536);
      output = (output + Buffer.from(frame.data).toString('utf8')).slice(-65536);
      return predicate(output);
    },
    Boolean,
    label,
  );
}

async function closeTerminal(sessionId) {
  ipcSucceeded(await ipc('close_agent_terminal', { sessionId }), 'Close terminal');
  ownedTerminals.delete(sessionId);
  checkOwnedSandbox();
}

async function connect() {
  const result = ipcSucceeded(
    await ipc('connect_ssh_gateway', {
      request: { gateway, destination: fixture.alias, remotePort: 17670, sshPort: fixture.port },
    }),
    'Connect SSH',
  );
  assert.equal(result.status, 'connected');
  assert.equal(result.gateway, gateway);
  ownedConnections.push(result);
  assert.equal(await portOpen(result.localPort), true);
  return result;
}

try {
  assert.match(
    sandboxName ?? '',
    /^sg-term-[a-z0-9-]{1,11}$/,
    'Supply the exact, already-created disposable sg-term-* sandbox (maximum 19 characters).',
  );
  assert.ok(
    existsSync(application) && existsSync(driverPath) && existsSync(webkitPath),
    'Build the current native application and prepare WebDriver dependencies first.',
  );
  fixture = await startSshFixture();
  const configDirectory = join(fixture.directory, 'xdg-config');
  const gatewayDirectory = join(configDirectory, 'openshell/gateways', gateway);
  await mkdir(gatewayDirectory, { recursive: true, mode: 0o700 });
  // 0.1.2 supports system metadata fallback, but resolves mTLS under user XDG.
  // Link only its existing credential directory, never copy/read credential files
  // or link the whole gateway directory (last_sandbox must stay fixture-owned).
  await symlink(
    join(systemGatewayDirectory, 'gateways', gateway, 'mtls'),
    join(gatewayDirectory, 'mtls'),
    'dir',
  );
  environment = {
    ...fixture.env,
    XDG_CONFIG_HOME: configDirectory,
    OPENSHELL_SYSTEM_GATEWAY_DIR: systemGatewayDirectory,
  };
  for (const name of [
    'OPENSHELL_GATEWAY',
    'OPENSHELL_WORKSPACE',
    'OPENSHELL_GATEWAY_ENDPOINT',
    'OPENSHELL_GATEWAY_INSECURE',
    'OPENSHELL_SANDBOX',
  ])
    delete environment[name];
  const status = cli([
    '--gateway',
    gateway,
    '--workspace',
    'default',
    'status',
    '--output',
    'json',
  ]);
  assert.equal(status.status, 'connected');
  assert.equal(status.authentication.status, 'authenticated');
  const inventoryBefore = cli(['gateway', 'list', '--output', 'json']);
  const originalSandboxId = checkOwnedSandbox();
  checkNoProviders();
  console.log('Verified isolated OpenShell profile and owned disposable sandbox.');
  if (process.env.SHELLGUARDIAN_NATIVE_DEV === '1') {
    assert.equal(await portOpen(1420), false, 'Port 1420 must be free for fixture-owned Vite.');
    child(resolve('node_modules/.bin/vite'), [
      '--host',
      '127.0.0.1',
      '--port',
      '1420',
      '--strictPort',
    ]);
    await until(
      () =>
        fetch('http://127.0.0.1:1420')
          .then((r) => r.ok)
          .catch(() => false),
      Boolean,
      'fixture Vite',
    );
  }
  const display = child(
    '/usr/bin/Xvfb',
    ['-displayfd', '3', '-screen', '0', '1440x1000x24', '-nolisten', 'tcp'],
    { stdio: ['ignore', 'ignore', 'ignore', 'pipe'] },
  );
  let displayNumber = '';
  display.stdio[3].on('data', (data) => {
    displayNumber += data.toString();
  });
  await until(
    async () => displayNumber,
    (value) => /^\d+\n$/.test(value),
    'private Xvfb',
  );
  displayEnvironment = { ...environment, DISPLAY: `:${displayNumber.trim()}`, GDK_BACKEND: 'x11' };
  closeWindowHelper = join(fixture.directory, 'native-close-window');
  execFileSync(
    'cc',
    [
      '-Wall',
      '-Wextra',
      '-Werror',
      resolve('scripts/native-close-window.c'),
      '-lX11',
      '-o',
      closeWindowHelper,
    ],
    { stdio: 'pipe' },
  );
  const port = await unusedPort();
  const nativePort = await unusedPort();
  endpoint = `http://127.0.0.1:${port}`;
  const driverProcess = child(
    driverPath,
    [
      '--port',
      String(port),
      '--native-port',
      String(nativePort),
      '--native-host',
      '127.0.0.1',
      '--native-driver',
      webkitPath,
    ],
    { env: displayEnvironment },
  );
  await until(
    () =>
      fetch(endpoint + '/status')
        .then((r) => r.ok)
        .catch(() => false),
    Boolean,
    'native driver',
  );
  const started = await request('/session', 'POST', {
    capabilities: { alwaysMatch: { 'tauri:options': { application } } },
  });
  session = started.sessionId;
  for (const candidate of await descendants(driverProcess.pid)) {
    const executable = await readlink(`/proc/${candidate.pid}/exe`).catch(() => '');
    // AppImages run their shellguardian payload from an ephemeral mount. The
    // candidate still must be a descendant of this exact fixture-owned driver.
    if (executable === application || basename(executable) === 'shellguardian') {
      nativePid = candidate.pid;
      break;
    }
  }
  assert.ok(nativePid, 'The native app must be a descendant of this fixture driver.');
  console.log('Started native WebDriver session.');
  await request(`/session/${session}/timeouts`, 'POST', { script: 40000 });
  await until(
    () => execute('return !!document.querySelector("#gateway-selector")'),
    Boolean,
    'native frontend',
  );
  assert.equal(await execute('return window.isTauri === true'), true);
  const version = ipcSucceeded(await ipc('get_shellguardian_update'), 'Read app version');
  assert.equal(typeof version.appVersion, 'string');
  await execute(
    `const s = document.querySelector('#gateway-selector'); Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set.call(s, arguments[0]); s.dispatchEvent(new Event('change', { bubbles: true })); return true`,
    [gateway],
  );
  await uiOpen('agent');
  console.log('Opened canonical agent attachment in native UI.');
  const uiMarker = `SHELLGUARDIAN_UI_${runNonce}`;
  await uiType(`${uiMarker}\uE007`);
  await until(
    uiOutput,
    (text) => text.includes(`SHELLGUARDIAN_MAIN_REPLY:${uiMarker}`),
    'canonical agent reply rendered',
  );
  await mkdir(evidenceDirectory, { recursive: true });
  await writeFile(
    join(evidenceDirectory, 'native-interaction-agent.png'),
    Buffer.from(await request(`/session/${session}/screenshot`), 'base64'),
  );
  await uiClose('agent');
  console.log('Verified main-process reply and non-destructive detach.');

  await uiOpen('terminal');
  await uiType(
    "printf 'SHELLGUARDIAN_SHELL_%s\\n' 'OK'; printf 'SHELLGUARDIAN_PWD:'; pwd; printf 'SHELLGUARDIAN_SIZE:'; stty size; printf '\\033[32mSHELLGUARDIAN_ANSI_%s\\033[0m\\n' 'OK'\uE007",
  );
  await until(
    uiOutput,
    (text) =>
      text.includes('SHELLGUARDIAN_SHELL_OK') &&
      /SHELLGUARDIAN_PWD:\//.test(text) &&
      /SHELLGUARDIAN_SIZE:\d+ \d+/.test(text) &&
      text.includes('SHELLGUARDIAN_ANSI_OK'),
    'independent shell pwd, TTY size, ANSI output',
  );
  const ansi = await execute(
    `return Array.from(document.querySelectorAll('.xterm-rows span')).filter(s => s.textContent.includes('SHELLGUARDIAN_ANSI_OK')).some(s => getComputedStyle(s).color !== getComputedStyle(document.querySelector('.xterm-rows')).color)`,
  );
  assert.equal(ansi, true, 'ANSI color must be rendered by xterm, not printed as escape text.');
  await writeFile(
    join(evidenceDirectory, 'native-interaction-terminal.png'),
    Buffer.from(await request(`/session/${session}/screenshot`), 'base64'),
  );
  await uiClose('terminal');
  console.log('Verified native independent shell, TTY size, and ANSI rendering.');

  const connection = await connect();
  const agent = await openTerminal('agent', connection.id);
  const sshMarker = `SHELLGUARDIAN_SSH_${runNonce}`;
  ipcSucceeded(
    await ipc('write_agent_terminal', { sessionId: agent, data: `${sshMarker}\r` }),
    'Write agent',
  );
  await terminalOutput(
    agent,
    (text) => text.includes(`SHELLGUARDIAN_MAIN_REPLY:${sshMarker}`),
    'SSH-scoped canonical agent reply',
  );
  await closeTerminal(agent);
  const shell = await openTerminal('terminal', connection.id);
  ipcSucceeded(
    await ipc('resize_agent_terminal', { sessionId: shell, cols: 111, rows: 37 }),
    'Resize terminal',
  );
  ipcSucceeded(
    await ipc('write_agent_terminal', {
      sessionId: shell,
      data: "printf 'SHELLGUARDIAN_SSH_%s\\n' 'OK'; stty size\r",
    }),
    'Write shell',
  );
  await terminalOutput(
    shell,
    (text) => text.includes('SHELLGUARDIAN_SSH_OK') && /(?:^|[\r\n])37 111[\r\n]/.test(text),
    'SSH shell resize and output',
  );
  const disconnectProcesses = await interactiveProcesses();
  const disconnectStarted = Date.now();
  ipcSucceeded(
    await ipc('disconnect_ssh_gateway', { connectionId: connection.id }),
    'Disconnect with open PTY',
  );
  assert.ok(
    Date.now() - disconnectStarted < 5_000,
    'Disconnect must promptly close active PTYs before taking the transport write lease.',
  );
  await until(
    () => portOpen(connection.localPort),
    (open) => !open,
    'disconnected tunnel listener closed',
  );
  await processesEnded(disconnectProcesses, 'disconnect reaped owned CLI and SSH children');
  const closedPty = await ipc('read_agent_terminal', { sessionId: shell });
  assert.ok(closedPty.ipcError || closedPty.exited, 'Disconnect must close the owned PTY.');
  ownedTerminals.delete(shell);
  const stale = await ipc('open_agent_terminal', {
    scope: { ...scope, connectionId: connection.id },
    name: sandboxName,
    kind: 'terminal',
    cols: 80,
    rows: 24,
  });
  assert.ok(stale.ipcError, 'A stale SSH ID must never fall back to the healthy direct gateway.');
  const direct = ipcSucceeded(await ipc('get_snapshot', { selection: scope }), 'Direct snapshot');
  assert.equal(direct.status.status, 'connected');
  assert.equal(checkOwnedSandbox(), originalSandboxId);
  assert.deepEqual(
    cli(['gateway', 'list', '--output', 'json']),
    inventoryBefore,
    'OpenShell gateway inventory and active context must remain unchanged.',
  );
  assert.deepEqual(await execute('return [localStorage.length, sessionStorage.length]'), [0, 0]);

  const closeConnection = await connect();
  const closePty = await openTerminal('terminal', closeConnection.id);
  ipcSucceeded(
    await ipc('write_agent_terminal', {
      sessionId: closePty,
      data: "printf 'SHELLGUARDIAN_CLOSE_%s\\n' 'READY'\r",
    }),
    'Write close fixture',
  );
  await terminalOutput(
    closePty,
    (text) => text.includes('SHELLGUARDIAN_CLOSE_READY'),
    'active PTY before normal close',
  );
  const closeProcesses = await interactiveProcesses();
  closeProcesses.push(await processIdentity(nativePid));
  execFileSync(closeWindowHelper, [], { env: displayEnvironment, stdio: 'pipe' });
  await until(
    () => portOpen(closeConnection.localPort),
    (open) => !open,
    'normal native close cleans active PTY and tunnel',
  );
  await processesEnded(closeProcesses, 'normal native close reaped owned app/CLI/SSH processes');
  ownedTerminals.clear();
  await request(`/session/${session}`, 'DELETE').catch(() => {});
  session = undefined;
  assert.equal(checkOwnedSandbox(), originalSandboxId);
  assert.deepEqual(cli(['gateway', 'list', '--output', 'json']), inventoryBefore);
  checkNoProviders();
  const receipt = {
    native: true,
    appVersion: version.appVersion,
    sandbox: sandboxName,
    nativeKeyboard: true,
    canonicalAgentReply: true,
    mainSurvivesDetach: true,
    independentShell: true,
    ansiRendered: true,
    ttyResizeVerified: true,
    sshAgentAndTerminal: true,
    disconnectWithOpenPty: true,
    staleConnectionRejected: true,
    normalCloseCleanup: true,
    ownedInteractiveProcessesReaped: true,
    activeOpenShellGatewayUnchanged: true,
    isolatedOpenShellCursor: true,
    noCredentialProvidersAttached: true,
    browserStorageEntries: 0,
    sandboxCreatedOrDeletedByTest: false,
  };
  await mkdir(evidenceDirectory, { recursive: true });
  await writeFile(
    join(evidenceDirectory, 'native-interaction.json'),
    JSON.stringify(receipt, null, 2) + '\n',
  );
  console.log(JSON.stringify(receipt, null, 2));
} catch (error) {
  if (session) {
    await mkdir(evidenceDirectory, { recursive: true });
    const screenshot = await request(`/session/${session}/screenshot`).catch(() => null);
    if (screenshot)
      await writeFile(
        join(evidenceDirectory, 'native-interaction-failure.png'),
        Buffer.from(screenshot, 'base64'),
      );
  }
  throw error;
} finally {
  await cleanup();
}
