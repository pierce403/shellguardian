// Real Tauri/WebKit/OpenSSH acceptance against the existing read-only local gateway.
// Embedded frontend: node scripts/native-ssh-smoke.mjs target/debug/shellguardian
// Plain cargo build: SHELLGUARDIAN_NATIVE_DEV=1 node scripts/native-ssh-smoke.mjs
// Creates private Xvfb/driver/sshd processes, and cleans up only those processes.
import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import net from 'node:net';
import { startSshFixture } from './ssh-fixture.mjs';

const application = resolve(process.argv[2] ?? 'target/debug/shellguardian');
const driverPath = resolve(process.env.TAURI_DRIVER ?? '.cache/tauri-driver/bin/tauri-driver');
const webkitPath = resolve(
  process.env.WEBKIT_DRIVER ?? '.cache/native/sysroot/usr/bin/WebKitWebDriver',
);
const ownedChildren = [];
const ownedConnections = [];
const pause = (ms) => new Promise((done) => setTimeout(done, ms));
let fixture;
let endpoint;
let session;
let cleanupPromise;

function cleanupOwnedProcesses() {
  cleanupPromise ??= (async () => {
    await stopChildren();
    await fixture?.cleanup();
  })();
  return cleanupPromise;
}

for (const [signal, exitCode] of [
  ['SIGINT', 130],
  ['SIGTERM', 143],
]) {
  process.once(signal, () => {
    void cleanupOwnedProcesses().finally(() => process.exit(exitCode));
  });
}

function desktopIdentity(environment) {
  const tree = execFileSync('xwininfo', ['-root', '-tree'], { env: environment, encoding: 'utf8' });
  const windows = [...tree.matchAll(/(0x[0-9a-f]+) "ShellGuardian"/g)].map((match) => match[1]);
  assert.ok(windows.length > 0, 'The native ShellGuardian window must exist.');
  for (const window of windows) {
    const properties = execFileSync('xprop', ['-id', window, 'WM_CLASS', '_GTK_APPLICATION_ID'], {
      env: environment,
      encoding: 'utf8',
    });
    const classes = properties.match(/WM_CLASS\(STRING\) = "([^"]+)", "([^"]+)"/);
    if (!classes || !classes.slice(1).includes('bot.recurse.shellguardian')) continue;
    const applicationId = properties.match(/_GTK_APPLICATION_ID\([^)]*\) = "([^"]+)"/)?.[1] ?? null;
    if (applicationId) assert.equal(applicationId, 'bot.recurse.shellguardian');
    return { wmClass: classes.slice(1), gtkApplicationId: applicationId };
  }
  throw new Error('The native WM_CLASS must match the installed desktop launcher.');
}

function gateways() {
  return JSON.parse(
    execFileSync('openshell', ['gateway', 'list', '--output', 'json'], { encoding: 'utf8' }),
  );
}

async function unusedPort() {
  const server = net.createServer();
  await new Promise((done, fail) => server.once('error', fail).listen(0, '127.0.0.1', done));
  const port = server.address().port;
  await new Promise((done) => server.close(done));
  return port;
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

function child(file, args, options = {}) {
  const result = spawn(file, args, {
    detached: true,
    stdio: ['ignore', 'ignore', 'pipe'],
    ...options,
  });
  let diagnostics = '';
  result.stderr?.on('data', (data) => {
    diagnostics = (diagnostics + data.toString()).slice(-3000);
  });
  result.on('error', (error) => {
    diagnostics = error.message;
  });
  ownedChildren.push(result);
  return { process: result, diagnostic: () => diagnostics };
}

async function stopChildren() {
  for (const process of ownedChildren.reverse()) {
    if (!process.pid) continue;
    try {
      globalThis.process.kill(-process.pid, 'SIGTERM');
    } catch (error) {
      if (error.code !== 'ESRCH') throw error;
    }
    await pause(100);
    if (process.exitCode === null && process.signalCode === null) {
      try {
        globalThis.process.kill(-process.pid, 'SIGKILL');
      } catch (error) {
        if (error.code !== 'ESRCH') throw error;
      }
    }
  }
}

async function until(work, predicate, label, seconds = 35) {
  const deadline = Date.now() + seconds * 1000;
  let value;
  while (Date.now() < deadline) {
    value = await work();
    if (predicate(value)) return value;
    await pause(150);
  }
  throw new Error(`Timed out: ${label}: ${JSON.stringify(value)}`);
}

async function request(path, method = 'GET', body) {
  const response = await fetch(endpoint + path, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(45_000),
  });
  const result = await response.json();
  if (!response.ok || result.value?.error) {
    throw new Error(
      `WebDriver: ${result.value?.error ?? response.status}: ${result.value?.message ?? ''}`,
    );
  }
  return result.value;
}

const execute = (script, args = []) =>
  request(`/session/${session}/execute/sync`, 'POST', { script, args });
async function ipc(command, args = {}) {
  return request(`/session/${session}/execute/async`, 'POST', {
    script:
      'const done = arguments[arguments.length - 1]; window.__TAURI_INTERNALS__.invoke(arguments[0], arguments[1]).then(done, error => done({ipcError: error?.message ?? String(error)}));',
    args: [command, args],
  });
}

async function start() {
  const result = await request('/session', 'POST', {
    capabilities: { alwaysMatch: { 'tauri:options': { application } } },
  });
  session = result.sessionId;
  await request(`/session/${session}/timeouts`, 'POST', { script: 40000 });
  await until(
    () => execute('return document.body.innerText'),
    (text) => text.includes('OpenShell & settings'),
    'native frontend',
  );
  assert.equal(await execute('return window.isTauri === true'), true);
}

async function stop() {
  if (session) await request(`/session/${session}`, 'DELETE').catch(() => {});
  session = undefined;
}

async function connect(gateway, throughForm) {
  if (throughForm) {
    await execute(
      'Array.from(document.querySelectorAll("button")).find(button => button.textContent.trim() === "OpenShell & settings").click(); return true;',
    );
    await until(
      () =>
        execute(
          'return !!document.querySelector("#ssh-gateway option[value=" + JSON.stringify(arguments[0]) + "]")',
          [gateway],
        ),
      Boolean,
      'native SSH form',
    );
    await execute(
      `
      const fields = { 'ssh-destination': arguments[0], 'ssh-port': String(arguments[1]), 'ssh-remote-port': '17670', 'ssh-gateway': arguments[2] };
      for (const [id, value] of Object.entries(fields)) {
        const element = document.getElementById(id);
        const prototype = element.tagName === 'SELECT' ? HTMLSelectElement.prototype : HTMLInputElement.prototype;
        Object.getOwnPropertyDescriptor(prototype, 'value').set.call(element, value);
        element.dispatchEvent(new Event(element.tagName === 'SELECT' ? 'change' : 'input', { bubbles: true }));
      }
      return true;`,
      [fixture.alias, fixture.port, gateway],
    );
    await execute('document.querySelector(".ssh-form").requestSubmit(); return true;');
  } else {
    const result = await ipc('connect_ssh_gateway', {
      request: { gateway, destination: fixture.alias, remotePort: 17670, sshPort: fixture.port },
    });
    assert.ok(!result.ipcError, result.ipcError);
  }
  const connections = await until(
    () => ipc('get_ssh_connections'),
    (items) => Array.isArray(items) && items.some((item) => item.status === 'connected'),
    'authenticated SSH connection',
  );
  const connection = connections.find((item) => item.status === 'connected');
  ownedConnections.push(connection);
  assert.equal(connection.gateway, gateway);
  assert.equal(connection.destination, fixture.alias);
  assert.equal(connection.remotePort, 17670);
  assert.equal(connection.sshPort, fixture.port);
  assert.ok(Number.isInteger(connection.localPort) && connection.localPort > 0);
  assert.equal(await portOpen(connection.localPort), true);
  const snapshot = await ipc('get_snapshot', {
    selection: { gateway, workspace: 'default', connectionId: connection.id },
  });
  assert.ok(!snapshot.ipcError, snapshot.ipcError);
  assert.equal(snapshot.scope.connectionId, connection.id);
  assert.equal(snapshot.scope.gateway, gateway);
  assert.equal(snapshot.status.status, 'connected');
  assert.equal(snapshot.status.authentication.status, 'authenticated');
  if (throughForm) {
    await until(
      () => execute('return document.querySelector("#gateway-selector").value'),
      (value) => value === `ssh:${connection.id}`,
      'UI-selected SSH connection',
    );
  }
  return connection;
}

try {
  assert.ok(existsSync(application), 'Build the current native application first.');
  assert.ok(
    existsSync(driverPath) && existsSync(webkitPath),
    'Native WebDriver dependencies are required.',
  );
  const before = gateways();
  const gateway = before.find(
    (item) => item.active && item.auth === 'mtls' && item.endpoint === 'https://127.0.0.1:17670',
  );
  assert.ok(
    gateway,
    'This acceptance test needs an already registered active mTLS gateway on localhost:17670.',
  );
  fixture = await startSshFixture();
  if (process.env.SHELLGUARDIAN_NATIVE_DEV === '1') {
    assert.equal(
      await portOpen(1420),
      false,
      'Port 1420 must be free for the fixture-owned Vite server.',
    );
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
          .then((response) => response.ok)
          .catch(() => false),
      Boolean,
      'fixture-owned frontend',
    );
  }
  const display = child(
    '/usr/bin/Xvfb',
    ['-displayfd', '3', '-screen', '0', '1440x1000x24', '-nolisten', 'tcp'],
    { stdio: ['ignore', 'ignore', 'pipe', 'pipe'] },
  );
  let displayNumber = '';
  display.process.stdio[3].on('data', (data) => {
    displayNumber += data.toString();
  });
  await until(
    async () => displayNumber,
    (value) => /^\d+\n$/.test(value),
    `private Xvfb: ${display.diagnostic()}`,
  );
  const closeWindowHelper = resolve(fixture.directory, 'native-close-window');
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
  const displayEnvironment = {
    ...fixture.env,
    DISPLAY: `:${displayNumber.trim()}`,
    GDK_BACKEND: 'x11',
  };
  const port = await unusedPort();
  const nativePort = await unusedPort();
  endpoint = `http://127.0.0.1:${port}`;
  const driver = child(
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
    {
      env: displayEnvironment,
    },
  );
  await until(
    () =>
      fetch(endpoint + '/status')
        .then((result) => result.ok)
        .catch(() => false),
    Boolean,
    `native driver: ${driver.diagnostic()}`,
  );
  await start();
  const identity =
    process.env.SHELLGUARDIAN_VERIFY_DESKTOP_IDENTITY === '1'
      ? desktopIdentity(displayEnvironment)
      : null;
  if (process.env.SHELLGUARDIAN_EXPECT_VERSION) {
    const update = await ipc('get_shellguardian_update');
    assert.equal(update.appVersion, process.env.SHELLGUARDIAN_EXPECT_VERSION);
    assert.equal(
      update.supported,
      true,
      'The installed AppImage must retain native update support.',
    );
  }
  const theme = await ipc('plugin:window|theme', { label: 'main' });
  assert.ok(theme === 'light' || theme === 'dark');
  await until(
    () => execute('return document.documentElement.dataset.theme'),
    (value) => value === theme,
    'current native OS theme',
  );
  assert.equal(
    await execute('return getComputedStyle(document.documentElement).colorScheme'),
    theme,
  );
  const first = await connect(gateway.name, true);
  await mkdir('test-results', { recursive: true });
  await writeFile(
    'test-results/native-ssh-connected.png',
    Buffer.from(await request(`/session/${session}/screenshot`), 'base64'),
  );
  await ipc('disconnect_ssh_gateway', { connectionId: first.id });
  await until(
    () => portOpen(first.localPort),
    (open) => !open,
    'disconnected tunnel closed',
  );
  const ended = await ipc('get_snapshot', {
    selection: { gateway: gateway.name, workspace: 'default', connectionId: first.id },
  });
  assert.match(ended.ipcError ?? '', /SSH.*(?:no longer available|disconnected)/);
  const closeConnection = await connect(gateway.name, false);
  // WebDriver's close-window endpoint only closes its WebKit browsing context.
  // A native WM_DELETE_WINDOW message exercises GTK/Tauri's normal close path.
  execFileSync(closeWindowHelper, [], { env: displayEnvironment, stdio: 'pipe' });
  await until(
    () => portOpen(closeConnection.localPort),
    (open) => !open,
    'app close released its SSH listener',
  );
  await stop();

  await start();
  const failed = await connect(gateway.name, false);
  await fixture.stopServer();
  await until(
    () => ipc('get_ssh_connections'),
    (items) =>
      Array.isArray(items) &&
      items.some((item) => item.id === failed.id && item.status === 'disconnected'),
    'daemon exit reported disconnected',
  );
  const lost = await ipc('get_snapshot', {
    selection: { gateway: gateway.name, workspace: 'default', connectionId: failed.id },
  });
  assert.match(lost.ipcError ?? '', /SSH.*(?:no longer available|disconnected)/);
  const direct = await ipc('get_snapshot', {
    selection: { gateway: gateway.name, workspace: 'default' },
  });
  assert.equal(
    direct.status.status,
    'connected',
    'The underlying gateway remains available; failed SSH IDs must not fall back to it.',
  );
  assert.equal(direct.scope.connectionId ?? null, null);
  assert.deepEqual(gateways(), before, 'No OpenShell registration or active gateway change.');
  assert.deepEqual(await execute('return [localStorage.length, sessionStorage.length]'), [0, 0]);
  await stop();
  for (const connection of ownedConnections)
    assert.equal(await portOpen(connection.localPort), false);
  console.log(
    JSON.stringify(
      {
        native: true,
        realSsh: true,
        uiFormConnected: true,
        mtlsAuthenticated: true,
        scopeConnectionIdVerified: true,
        disconnectClosesListener: true,
        endedIdRejected: true,
        daemonDeathReported: true,
        noDirectFallback: true,
        appCloseCleansTunnel: true,
        activeOpenShellGatewayUnchanged: true,
        nativeTheme: theme,
        themeMatchesOS: true,
        desktopIdentity: identity,
        browserStorageEntries: 0,
        openshellMutations: false,
      },
      null,
      2,
    ),
  );
} finally {
  if (session) {
    for (const connection of ownedConnections)
      await ipc('disconnect_ssh_gateway', { connectionId: connection.id }).catch(() => {});
  }
  await stop();
  await cleanupOwnedProcesses();
}
