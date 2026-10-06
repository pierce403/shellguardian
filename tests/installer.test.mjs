import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync, spawnSync } from 'node:child_process';
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  statSync,
  symlinkSync,
  rmSync,
  existsSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const taskDir = mkdtempSync(join(tmpdir(), 'shellguardian-installer-'));
const mocks = join(taskDir, 'mocks');
mkdirSync(mocks);
const image = '#!/bin/sh\nprintf "fixture only\\n"\n';
const checksum = createHash('sha256').update(image).digest('hex');
const asset = 'ShellGuardian_0.2.0_amd64.AppImage';
const installer = resolve('install.sh');
const baseEnv = {
  ...process.env,
  PATH: `${mocks}:${process.env.PATH}`,
  SG_TEST_IMAGE: image,
  SG_TEST_CHECKSUM: checksum,
};
for (const [name, body] of Object.entries({
  id: 'process.stdout.write((process.env.SG_TEST_ROOT === "1" ? "0" : "1000") + "\\n");',
  uname:
    'process.stdout.write((process.argv[2] === "-s" ? process.env.SG_TEST_OS || "Linux" : process.env.SG_TEST_ARCH || "x86_64") + "\\n");',
  curl: `
    const fs = require('node:fs');
    const args = process.argv.slice(2);
    for (const flag of ['--fail', '--proto', '--proto-redir', '--tlsv1.2', '--max-time'])
      if (!args.includes(flag)) process.exit(90);
    const url = args.find(x => x.startsWith('https://'));
    if (!url?.startsWith('https://github.com/pierce403/shellguardian/releases/')) process.exit(91);
    const output = args[args.indexOf('--output') + 1];
    if (process.env.SG_TEST_FAILURE === 'network') process.exit(22);
    let bytes = url.endsWith('version.txt') ? process.env.SG_TEST_VERSION || '0.2.0\\n'
      : url.endsWith('SHA256SUMS') ? process.env.SG_TEST_MANIFEST || process.env.SG_TEST_CHECKSUM + '  ${asset}\\n'
      : process.env.SG_TEST_IMAGE;
    fs.writeFileSync(output, bytes);
  `,
}))
  writeFileSync(join(mocks, name), `#!/usr/bin/env node\n${body}\n`, { mode: 0o755 });

function run(name, extra = {}, args = []) {
  const folder = join(taskDir, name);
  mkdirSync(folder, { recursive: true });
  const env = {
    ...baseEnv,
    SHELLGUARDIAN_INSTALL_DIR: join(folder, 'app'),
    SHELLGUARDIAN_BIN_DIR: join(folder, 'bin'),
    XDG_DATA_HOME: join(folder, 'data'),
    ...extra,
  };
  const result = spawnSync('bash', [installer, ...args], { env, encoding: 'utf8' });
  return {
    ...result,
    folder,
    env,
    imagePath: join(env.SHELLGUARDIAN_INSTALL_DIR, 'ShellGuardian.AppImage'),
  };
}
let passed = 0;
function check(name, work) {
  work();
  passed++;
  console.log(`PASS ${name}`);
}
try {
  check('latest install verifies bytes, integrates desktop, and enables app updates', () => {
    const result = run('normal');
    assert.equal(result.status, 0, result.stderr);
    assert.equal(readFileSync(result.imagePath, 'utf8'), image);
    assert.equal(statSync(result.imagePath).mode & 0o777, 0o755);
    const wrapper = readFileSync(join(result.folder, 'bin/shellguardian'), 'utf8');
    assert.ok(wrapper.includes('APPIMAGE_EXTRACT_AND_RUN=1'));
    assert.ok(wrapper.includes('# ShellGuardian managed launcher'));
    const config = JSON.parse(readFileSync('src-tauri/tauri.conf.json', 'utf8'));
    const desktopPath = join(result.folder, `data/applications/${config.identifier}.desktop`);
    const desktop = readFileSync(desktopPath, 'utf8');
    assert.equal(config.app.enableGTKAppId, true);
    assert.ok(desktop.includes(`Icon=${config.identifier}\n`));
    assert.ok(desktop.includes('StartupWMClass=shellguardian\n'));
    assert.ok(desktop.includes('StartupNotify=true\n'));
    assert.ok(desktop.includes(`Exec="${join(result.folder, 'bin/shellguardian')}"\n`));
    const iconPath = join(
      result.folder,
      `data/icons/hicolor/scalable/apps/${config.identifier}.svg`,
    );
    assert.equal(readFileSync(iconPath, 'utf8'), readFileSync('public/mark.svg', 'utf8'));
    assert.equal(statSync(iconPath).mode & 0o777, 0o644);
    const desktopValidation = spawnSync('desktop-file-validate', [desktopPath], {
      encoding: 'utf8',
    });
    if (desktopValidation.error?.code !== 'ENOENT') {
      assert.equal(desktopValidation.status, 0, desktopValidation.stderr);
    }
    assert.ok(result.stdout.includes('ON by default'));
    assert.ok(!existsSync(join(result.folder, 'data/preferences.json')));
  });
  check('reinstall is atomic and keeps a rollback copy', () => {
    const result = run('normal', {}, ['--version', '0.2.0']);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(
      readFileSync(join(result.folder, 'app/ShellGuardian.previous.AppImage'), 'utf8'),
      image,
    );
    assert.equal(
      readFileSync(
        join(result.folder, 'data/icons/hicolor/scalable/apps/bot.recurse.shellguardian.svg'),
        'utf8',
      ),
      readFileSync('public/mark.svg', 'utf8'),
    );
  });
  check('tampered bytes leave existing installation untouched', () => {
    const result = run('normal', { SG_TEST_IMAGE: 'tampered' });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /Checksum mismatch/);
    assert.equal(readFileSync(result.imagePath, 'utf8'), image);
  });
  check('missing or duplicate checksums are rejected', () => {
    for (const manifest of [
      'abc  unrelated\\n',
      `${checksum}  ${asset}\n${checksum}  ${asset}\n`,
    ]) {
      const result = run('checksums', { SG_TEST_MANIFEST: manifest });
      assert.notEqual(result.status, 0);
      assert.ok(!existsSync(result.imagePath));
    }
  });
  check('untrusted versions and arguments cannot become paths or commands', () => {
    for (const version of ['../../etc/passwd', '0.2.0;id', '0.2.0-beta', '0.2.0\n0.1.0']) {
      const result = run('versions', { SG_TEST_VERSION: version });
      assert.notEqual(result.status, 0);
      assert.ok(!existsSync(result.imagePath));
    }
    assert.notEqual(run('arguments', {}, ['--unknown']).status, 0);
  });
  check('network failure never creates installation files', () => {
    const result = run('offline', { SG_TEST_FAILURE: 'network' });
    assert.notEqual(result.status, 0);
    assert.ok(!existsSync(result.imagePath));
  });
  check('unsupported platforms and root installs stop clearly', () => {
    for (const env of [
      { SG_TEST_ARCH: 'aarch64' },
      { SG_TEST_OS: 'Darwin' },
      { SG_TEST_ROOT: '1' },
    ]) {
      const result = run('unsupported', env);
      assert.notEqual(result.status, 0);
      assert.ok(!existsSync(result.imagePath));
    }
  });
  check('spaces in per-user install paths are safe and desktop integration is optional', () => {
    const result = run('space path', {}, ['--no-desktop']);
    assert.equal(result.status, 0, result.stderr);
    execFileSync('bash', ['-n', join(result.folder, 'bin/shellguardian')]);
    assert.ok(!existsSync(join(result.folder, 'data/applications')));
    assert.ok(!existsSync(join(result.folder, 'data/icons')));
  });
  check('desktop and icon symlinks are refused before replacing any installation', () => {
    for (const relative of [
      'data/applications/bot.recurse.shellguardian.desktop',
      'data/icons/hicolor/scalable/apps/bot.recurse.shellguardian.svg',
    ]) {
      const folder = join(taskDir, relative.includes('/icons/') ? 'icon-link' : 'desktop-link');
      const target = join(folder, relative);
      mkdirSync(join(target, '..'), { recursive: true });
      const original = join(folder, 'user-file');
      writeFileSync(original, 'keep this file');
      symlinkSync(original, target);
      const result = run(relative.includes('/icons/') ? 'icon-link' : 'desktop-link');
      assert.notEqual(result.status, 0);
      assert.match(result.stderr, /symbolic desktop entry or icon link/);
      assert.equal(readFileSync(original, 'utf8'), 'keep this file');
      assert.ok(!existsSync(result.imagePath));
    }
  });
  check('symbolic links and unmanaged executables are never overwritten', () => {
    const path = join(taskDir, 'unmanaged/app');
    mkdirSync(path, { recursive: true });
    writeFileSync(join(path, 'ShellGuardian.AppImage'), 'not ours');
    assert.notEqual(run('unmanaged').status, 0);
    assert.equal(readFileSync(join(path, 'ShellGuardian.AppImage'), 'utf8'), 'not ours');
    const linkPath = join(taskDir, 'symlink/app');
    mkdirSync(linkPath, { recursive: true });
    symlinkSync(join(path, 'ShellGuardian.AppImage'), join(linkPath, 'ShellGuardian.AppImage'));
    assert.notEqual(run('symlink').status, 0);
    assert.equal(readFileSync(join(path, 'ShellGuardian.AppImage'), 'utf8'), 'not ours');
  });
  console.log(`${passed} installer checks passed.`);
} finally {
  rmSync(taskDir, { recursive: true, force: true });
}
