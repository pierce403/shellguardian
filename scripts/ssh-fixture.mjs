// Isolated real OpenSSH forwarding fixture. Never reads or changes ~/.ssh.
// Dependency: an installed sshd, or the official package extracted under
// .cache/ssh-fixture-deps/root (no system installation is necessary).
// Import startSshFixture(), pass fixture.env to the native test/driver, and
// always call fixture.cleanup() in a finally block.
import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { userInfo } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import net from 'node:net';
import tls from 'node:tls';

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const extractedRoot = join(projectRoot, '.cache/ssh-fixture-deps/root');
const realSsh = '/usr/bin/ssh';
const alias = 'shellguardian-fixture';
const delay = (ms) => new Promise((done) => setTimeout(done, ms));

function configPath(path) {
  if (/[\r\n\0]/.test(path)) throw new Error('Invalid fixture path.');
  return `"${path.replaceAll('\\', '\\\\').replaceAll('"', '\\"')}"`;
}

function shellQuote(value) {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

async function unusedPort() {
  const server = net.createServer();
  await new Promise((done, fail) => server.once('error', fail).listen(0, '127.0.0.1', done));
  const port = server.address().port;
  await new Promise((done) => server.close(done));
  return port;
}

async function acceptsConnections(port) {
  return new Promise((done) => {
    const socket = net.connect({ host: '127.0.0.1', port });
    const finish = (result) => {
      socket.destroy();
      done(result);
    };
    socket.once('connect', () => finish(true));
    socket.once('error', () => finish(false));
    socket.setTimeout(500, () => finish(false));
  });
}

async function stopChild(child) {
  if (!child.pid) return;
  // Only signal the fresh, detached process group created by this fixture.
  const signal = (name) => {
    try {
      process.kill(-child.pid, name);
    } catch (error) {
      if (error.code !== 'ESRCH') throw error;
    }
  };
  signal('SIGTERM');
  for (let attempt = 0; attempt < 20; attempt += 1) {
    if (child.exitCode !== null || child.signalCode !== null) return;
    await delay(25);
  }
  signal('SIGKILL');
}

async function descendantProcesses(pid) {
  const descendants = [];
  let children;
  try {
    children = (await readFile(`/proc/${pid}/task/${pid}/children`, 'utf8'))
      .trim()
      .split(/\s+/)
      .filter(Boolean);
  } catch (error) {
    if (error.code === 'ENOENT') return descendants;
    throw error;
  }
  for (const child of children) {
    const childPid = Number(child);
    descendants.push(...(await descendantProcesses(childPid)));
    try {
      const stat = await readFile(`/proc/${childPid}/stat`, 'utf8');
      descendants.push({
        pid: childPid,
        started: stat.slice(stat.lastIndexOf(')') + 2).split(' ')[19],
      });
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
  }
  return descendants;
}

async function signalOwnedProcess(owned, signal) {
  try {
    const stat = await readFile(`/proc/${owned.pid}/stat`, 'utf8');
    // Check process start time as well as the captured descendant PID.
    if (stat.slice(stat.lastIndexOf(')') + 2).split(' ')[19] === owned.started)
      process.kill(owned.pid, signal);
  } catch (error) {
    if (error.code !== 'ENOENT' && error.code !== 'ESRCH') throw error;
  }
}

/** Start a loopback-only SSH server and supply a private client configuration. */
export async function startSshFixture({
  targetPort = 17670,
  permittedPorts = [],
  sshdPath = process.env.SHELLGUARDIAN_TEST_SSHD ??
    (existsSync('/usr/sbin/sshd') ? '/usr/sbin/sshd' : join(extractedRoot, 'usr/sbin/sshd')),
} = {}) {
  if (process.getuid?.() === 0) throw new Error('Run the SSH fixture as an unprivileged user.');
  const ports = [...new Set([targetPort, ...permittedPorts])];
  if (ports.some((port) => !Number.isInteger(port) || port < 1 || port > 65535)) {
    throw new Error('Fixture forwarding ports must be valid TCP ports.');
  }
  if (!existsSync(sshdPath)) throw new Error('An installed or extracted OpenSSH sshd is required.');
  const cache = join(projectRoot, '.cache');
  await mkdir(cache, { recursive: true });
  const directory = await mkdtemp(join(cache, 'ssh-fixture-'));
  await chmod(directory, 0o700);
  const children = [];
  let stopServer = async () => {};
  let cleaned = false;
  const cleanup = async () => {
    if (cleaned) return;
    cleaned = true;
    await stopServer();
    for (const child of children.reverse()) await stopChild(child);
    await rm(directory, { recursive: true, force: true });
  };
  const startChild = (file, args, options = {}) => {
    const child = spawn(file, args, {
      detached: true,
      stdio: ['ignore', 'ignore', 'pipe'],
      ...options,
    });
    children.push(child);
    let diagnostic = '';
    child.stderr?.on('data', (chunk) => {
      diagnostic = (diagnostic + chunk.toString()).slice(-4096);
    });
    child.on('error', (error) => {
      diagnostic = error.message;
    });
    return { child, diagnostic: () => diagnostic };
  };
  const waitForListener = async (port, running) => {
    for (let attempt = 0; attempt < 100; attempt += 1) {
      if (running.child.exitCode !== null || running.child.signalCode !== null) {
        throw new Error(`Fixture process exited: ${running.diagnostic()}`);
      }
      if (await acceptsConnections(port)) return;
      await delay(50);
    }
    throw new Error(`Fixture listener did not start: ${running.diagnostic()}`);
  };

  try {
    const hostKey = join(directory, 'host_ed25519');
    const clientKey = join(directory, 'client_ed25519');
    const deniedKey = join(directory, 'denied_ed25519');
    for (const path of [hostKey, clientKey, deniedKey]) {
      execFileSync('/usr/bin/ssh-keygen', ['-q', '-t', 'ed25519', '-N', '', '-f', path], {
        stdio: 'ignore',
      });
    }
    const authorizedKeys = join(directory, 'authorized_keys');
    await writeFile(authorizedKeys, await readFile(`${clientKey}.pub`), { mode: 0o600 });
    const hostPublic = (await readFile(`${hostKey}.pub`, 'utf8'))
      .trim()
      .split(/\s+/)
      .slice(0, 2)
      .join(' ');
    const port = await unusedPort();
    const username = userInfo().username;
    if (!/^[a-zA-Z0-9_.-]+$/.test(username)) throw new Error('Unsupported fixture username.');
    const knownHosts = join(directory, 'known_hosts');
    await writeFile(knownHosts, `[127.0.0.1]:${port} ${hostPublic}\n`, { mode: 0o600 });
    const serverConfig = join(directory, 'sshd_config');
    const splitRoot = resolve(dirname(sshdPath), '../lib/openssh');
    const splitBinary = (name, option) =>
      existsSync(join(splitRoot, name)) ? `${option} ${configPath(join(splitRoot, name))}\n` : '';
    await writeFile(
      serverConfig,
      [
        `ListenAddress 127.0.0.1:${port}`,
        `HostKey ${configPath(hostKey)}`,
        `PidFile ${configPath(join(directory, 'sshd.pid'))}`,
        `AuthorizedKeysFile ${configPath(authorizedKeys)}`,
        `AllowUsers ${username}`,
        'AuthenticationMethods publickey',
        'PubkeyAuthentication yes',
        'PasswordAuthentication no',
        'KbdInteractiveAuthentication no',
        'UsePAM no',
        'StrictModes yes',
        'AllowTcpForwarding local',
        `PermitOpen ${ports.map((forwardPort) => `127.0.0.1:${forwardPort}`).join(' ')}`,
        'GatewayPorts no',
        'AllowAgentForwarding no',
        'AllowStreamLocalForwarding no',
        'X11Forwarding no',
        'PermitTTY no',
        'PermitUserRC no',
        'MaxSessions 0',
        'LogLevel VERBOSE',
        splitBinary('sshd-session', 'SshdSessionPath'),
        splitBinary('sshd-auth', 'SshdAuthPath'),
        '',
      ].join('\n'),
      { mode: 0o600 },
    );
    const makeClientConfig = (key) =>
      [
        `Host ${alias}`,
        '  HostName 127.0.0.1',
        `  Port ${port}`,
        `  User ${username}`,
        `  IdentityFile ${configPath(key)}`,
        'Host *',
        `  UserKnownHostsFile ${configPath(knownHosts)}`,
        '  GlobalKnownHostsFile /dev/null',
        '  StrictHostKeyChecking yes',
        '  UpdateHostKeys no',
        '  IdentitiesOnly yes',
        '  IdentityAgent none',
        '  BatchMode yes',
        '  ConnectTimeout 5',
        '  ProxyCommand none',
        '  ProxyJump none',
        '',
      ].join('\n');
    const clientConfig = join(directory, 'ssh_config');
    const deniedConfig = join(directory, 'ssh_denied_config');
    const mismatchedConfig = join(directory, 'ssh_mismatched_config');
    const mismatchedHosts = join(directory, 'mismatched_hosts');
    const unrelatedPublic = (await readFile(`${deniedKey}.pub`, 'utf8'))
      .trim()
      .split(/\s+/)
      .slice(0, 2)
      .join(' ');
    await writeFile(mismatchedHosts, `[127.0.0.1]:${port} ${unrelatedPublic}\n`, { mode: 0o600 });
    await writeFile(clientConfig, makeClientConfig(clientKey), { mode: 0o600 });
    await writeFile(deniedConfig, makeClientConfig(deniedKey), { mode: 0o600 });
    await writeFile(
      mismatchedConfig,
      makeClientConfig(clientKey).replace(configPath(knownHosts), configPath(mismatchedHosts)),
      { mode: 0o600 },
    );
    const wrapperDirectory = join(directory, 'bin');
    await mkdir(wrapperDirectory, { mode: 0o700 });
    await writeFile(
      join(wrapperDirectory, 'ssh'),
      `#!/bin/sh\nexec ${shellQuote(realSsh)} -F ${shellQuote(clientConfig)} "$@"\n`,
      { mode: 0o700 },
    );
    execFileSync(sshdPath, ['-t', '-f', serverConfig], { stdio: 'pipe' });
    const server = startChild(sshdPath, ['-D', '-e', '-f', serverConfig]);
    let serverStopped = false;
    stopServer = async () => {
      if (serverStopped) return;
      serverStopped = true;
      // sshd deliberately preserves established sessions when its listener exits.
      // Capture this fixture's descendants before stopping the parent, including
      // session children that created their own process group.
      const descendants = await descendantProcesses(server.child.pid);
      for (const owned of descendants) await signalOwnedProcess(owned, 'SIGTERM');
      await stopChild(server.child);
      for (const owned of descendants) await signalOwnedProcess(owned, 'SIGKILL');
    };
    await waitForListener(port, server);

    return {
      alias,
      port,
      username,
      targetPort,
      directory,
      clientConfig,
      deniedConfig,
      mismatchedConfig,
      knownHosts,
      wrapperDirectory,
      serverPid: server.child.pid,
      serverDiagnostic: server.diagnostic,
      stopServer,
      env: { ...process.env, PATH: `${wrapperDirectory}:${process.env.PATH}` },
      async startForward(remotePort = targetPort, config = clientConfig) {
        const localPort = await unusedPort();
        const running = startChild(realSsh, [
          '-F',
          config,
          '-N',
          '-T',
          '-o',
          'ExitOnForwardFailure=yes',
          '-L',
          `127.0.0.1:${localPort}:127.0.0.1:${remotePort}`,
          alias,
        ]);
        try {
          await waitForListener(localPort, running);
        } catch (error) {
          throw new Error(`${error.message}\n${server.diagnostic()}`);
        }
        return { localPort, ...running, stop: () => stopChild(running.child) };
      },
      cleanup,
    };
  } catch (error) {
    await cleanup();
    throw error;
  }
}

async function peerCertificate(port) {
  return new Promise((done, fail) => {
    // This compares the transport's peer certificate, not TLS trust/authentication.
    // No HTTP request, client key, or OpenShell mutation is sent.
    const socket = tls.connect({
      host: '127.0.0.1',
      port,
      servername: 'localhost',
      rejectUnauthorized: false,
    });
    socket.once('secureConnect', () => {
      const certificate = socket.getPeerCertificate().fingerprint256;
      socket.destroy();
      if (certificate) done(certificate);
      else fail(new Error('No TLS peer certificate.'));
    });
    socket.once('error', fail);
    socket.setTimeout(5000, () => {
      socket.destroy();
      fail(new Error('TLS fixture probe timed out.'));
    });
  });
}

async function selfTest() {
  const echo = net.createServer((socket) => socket.pipe(socket));
  await new Promise((done) => echo.listen(0, '127.0.0.1', done));
  const echoPort = echo.address().port;
  const closedPort = await unusedPort();
  let fixture;
  try {
    fixture = await startSshFixture({ permittedPorts: [echoPort, closedPort] });
    const tunnel = await fixture.startForward(echoPort);
    const payload = 'shellguardian-forwarding-proof';
    const roundtrip = await new Promise((done, fail) => {
      const socket = net.connect({ host: '127.0.0.1', port: tunnel.localPort }, () =>
        socket.write(payload),
      );
      socket.once('data', (data) => {
        socket.destroy();
        done(data.toString());
      });
      socket.once('error', fail);
      socket.setTimeout(5000, () => {
        socket.destroy();
        fail(new Error('Echo roundtrip timed out.'));
      });
    });
    assert.equal(roundtrip, payload);
    await assert.rejects(
      fixture.startForward(echoPort, fixture.deniedConfig),
      /Permission denied|publickey/,
    );
    await assert.rejects(
      fixture.startForward(echoPort, fixture.mismatchedConfig),
      /REMOTE HOST IDENTIFICATION HAS CHANGED|Host key verification failed/,
    );
    const failedForward = await fixture.startForward(closedPort);
    await new Promise((done, fail) => {
      const socket = net.connect({ host: '127.0.0.1', port: failedForward.localPort });
      socket.once('data', () => {
        socket.destroy();
        fail(new Error('Closed target unexpectedly returned data.'));
      });
      socket.once('close', done);
      socket.once('error', done);
      socket.setTimeout(5000, () => {
        socket.destroy();
        fail(new Error('Closed target did not close.'));
      });
    });
    assert.match(failedForward.diagnostic(), /connect failed: Connection refused/);
    let openShellTransport = false;
    if (await acceptsConnections(fixture.targetPort)) {
      const openShellTunnel = await fixture.startForward();
      assert.equal(
        await peerCertificate(openShellTunnel.localPort),
        await peerCertificate(fixture.targetPort),
      );
      openShellTransport = true;
    }
    const sshPort = fixture.port;
    const directory = fixture.directory;
    await fixture.cleanup();
    assert.equal(existsSync(directory), false);
    assert.equal(await acceptsConnections(sshPort), false);
    assert.equal(await acceptsConnections(tunnel.localPort), false);
    console.log(
      JSON.stringify(
        {
          actualSsh: true,
          strictKnownHosts: true,
          unprivileged: process.getuid() !== 0,
          echoRoundtrip: true,
          unauthorizedKeyRejected: true,
          changedHostKeyRejected: true,
          closedRemotePortRejected: true,
          openShellTransport,
          mutationsPerformed: false,
          temporaryKeysRemoved: true,
          ownedListenersClosed: true,
        },
        null,
        2,
      ),
    );
  } finally {
    await fixture?.cleanup();
    await new Promise((done) => echo.close(done));
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv[2] !== '--self-test')
    throw new Error('Usage: node scripts/ssh-fixture.mjs --self-test');
  await selfTest();
}
