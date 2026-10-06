// Briefly opens its own native test window on the current Wayland display.
// Usage: node scripts/native-wayland-identity.mjs [binary] [expected-app-id]
// A private D-Bus session and temporary XDG directories keep real app state alone.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const canonicalId = 'bot.recurse.shellguardian';
const application = resolve(process.argv[2] ?? 'target/debug/shellguardian');
const expectedId = process.argv[3] ?? canonicalId;
const xdgAppIds = new Set();
const gtkApplicationIds = new Set();
const pause = (ms) => new Promise((done) => setTimeout(done, ms));
let directory;
let child;
let childClosed;
let timeout;
let settling;
let interrupt;
let interruption;

const signalHandlers = new Map(
  ['SIGINT', 'SIGTERM'].map((signal) => [
    signal,
    () => {
      interruption = signal;
      interrupt?.(new Error(`Interrupted by ${signal}.`));
    },
  ]),
);
for (const [signal, handler] of signalHandlers) process.once(signal, handler);

function stopOwnedGroup(signal) {
  if (!child?.pid) return;
  try {
    process.kill(-child.pid, signal);
  } catch (error) {
    if (error.code !== 'ESRCH') throw error;
  }
}

function metadata(line) {
  // Do not retain or print full Wayland traces, window titles, or other stderr.
  for (const [pattern, values] of [
    [/\b(?:xdg_toplevel|zxdg_toplevel_v6)[@#]\d+\.set_app_id\(("(?:\\.|[^"\\])*")/, xdgAppIds],
    [/\bgtk_surface1[@#]\d+\.set_dbus_properties\(("(?:\\.|[^"\\])*")/, gtkApplicationIds],
  ]) {
    const value = line.match(pattern)?.[1];
    if (value && value.length <= 512 && values.size < 16) values.add(JSON.parse(value));
  }
}

try {
  assert.ok(process.env.WAYLAND_DISPLAY, 'Run this check inside a Wayland session.');
  assert.ok(process.env.XDG_RUNTIME_DIR, 'The Wayland runtime directory must be available.');
  assert.match(expectedId, /^[A-Za-z_][A-Za-z0-9_.-]*$/, 'Supply a valid expected application ID.');
  directory = await mkdtemp(join(tmpdir(), 'shellguardian-wayland-'));
  const config = join(directory, 'config');
  await mkdir(join(config, canonicalId), { recursive: true, mode: 0o700 });
  await writeFile(join(config, canonicalId, 'preferences.json'), '{"autoUpdate":false}\n', {
    mode: 0o600,
  });
  if (interruption) throw new Error(`Interrupted by ${interruption}.`);

  await new Promise((done, fail) => {
    interrupt = fail;
    child = spawn('dbus-run-session', ['--', application], {
      detached: true,
      stdio: ['ignore', 'ignore', 'pipe'],
      env: {
        ...process.env,
        APPIMAGE_EXTRACT_AND_RUN: '1',
        GDK_BACKEND: 'wayland',
        WAYLAND_DEBUG: 'client',
        XDG_CONFIG_HOME: config,
        XDG_DATA_HOME: join(directory, 'data'),
        XDG_CACHE_HOME: join(directory, 'cache'),
        GSETTINGS_BACKEND: 'memory',
      },
    });
    childClosed = new Promise((closed) => child.once('close', closed));
    child.once('error', (error) =>
      fail(new Error(`Could not launch test process: ${error.code}.`)),
    );
    child.once('close', (code, signal) => {
      fail(new Error(`Test process exited before verification (${signal ?? code}).`));
    });
    timeout = setTimeout(
      () => fail(new Error('Wayland identity was not verified within 10 seconds.')),
      10_000,
    );
    let pending = '';
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk) => {
      pending += chunk;
      const lines = pending.split('\n');
      pending = lines.pop().slice(-16_384);
      try {
        for (const line of lines) metadata(line);
        if (xdgAppIds.size && gtkApplicationIds.size && !settling) {
          // Allow one second for a late identity change before accepting startup.
          settling = setTimeout(() => {
            try {
              assert.deepEqual([...xdgAppIds], [expectedId], 'Wayland app_id does not match.');
              assert.deepEqual(
                [...gtkApplicationIds],
                [expectedId],
                'GTK application ID does not match.',
              );
              done();
            } catch (error) {
              fail(error);
            }
          }, 1_000);
        }
      } catch {
        fail(new Error('Could not parse the native identity metadata.'));
      }
    });
  });
  console.log(
    JSON.stringify(
      {
        verified: true,
        expectedId,
        xdgAppIds: [...xdgAppIds],
        gtkApplicationIds: [...gtkApplicationIds],
      },
      null,
      2,
    ),
  );
} catch (error) {
  console.error(
    JSON.stringify(
      {
        verified: false,
        error: error.message,
        xdgAppIds: [...xdgAppIds],
        gtkApplicationIds: [...gtkApplicationIds],
      },
      null,
      2,
    ),
  );
  process.exitCode = interruption === 'SIGINT' ? 130 : interruption === 'SIGTERM' ? 143 : 1;
} finally {
  clearTimeout(timeout);
  clearTimeout(settling);
  interrupt = undefined;
  try {
    stopOwnedGroup('SIGTERM');
    await pause(250);
    stopOwnedGroup('SIGKILL');
    if (childClosed) await Promise.race([childClosed, pause(1_000)]);
  } finally {
    if (directory) await rm(directory, { recursive: true, force: true });
    for (const [signal, handler] of signalHandlers) process.off(signal, handler);
  }
}
