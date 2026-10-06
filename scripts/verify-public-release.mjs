// Verify published bytes and an isolated per-user install, then exercise the
// shipped AppImage through the real native SSH acceptance harness.
// Usage: node scripts/verify-public-release.mjs 0.3.1
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { chmod, copyFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';

const version = process.argv[2];
assert.match(version ?? '', /^\d+\.\d+\.\d+$/, 'Supply an exact stable release version.');
const directory = resolve(`.cache/public-release-${version}`);
const imageName = `ShellGuardian_${version}_amd64.AppImage`;
const files = [imageName, `${imageName}.sig`, 'install.sh', 'version.txt', 'latest.json'];
const digest = async (path) =>
  createHash('sha256')
    .update(await readFile(path))
    .digest('hex');
await mkdir(directory, { recursive: true });
const metadata = JSON.parse(
  execFileSync(
    'gh',
    [
      'release',
      'view',
      `v${version}`,
      '--repo',
      'pierce403/shellguardian',
      '--json',
      'tagName,publishedAt,url,isDraft,assets',
    ],
    { encoding: 'utf8' },
  ),
);
assert.equal(metadata.tagName, `v${version}`);
assert.equal(metadata.isDraft, false);
for (const file of [...files, 'SHA256SUMS']) {
  assert.equal(
    metadata.assets.filter((asset) => asset.name === file).length,
    1,
    `Missing unique published asset: ${file}`,
  );
}
execFileSync(
  'gh',
  [
    'release',
    'download',
    `v${version}`,
    '--repo',
    'pierce403/shellguardian',
    '--dir',
    directory,
    '--clobber',
    ...[...files, 'SHA256SUMS'].flatMap((file) => ['--pattern', file]),
  ],
  { stdio: 'pipe' },
);
const checksums = new Map();
for (const line of (await readFile(join(directory, 'SHA256SUMS'), 'utf8')).trim().split('\n')) {
  const match = line.match(/^([a-f0-9]{64})  ([A-Za-z0-9_.-]+)$/);
  assert.ok(match, 'Malformed published checksum manifest.');
  assert.ok(!checksums.has(match[2]), 'Duplicate checksum manifest entry.');
  checksums.set(match[2], match[1]);
}
assert.deepEqual([...checksums.keys()].sort(), [...files].sort());
for (const file of files)
  assert.equal(
    await digest(join(directory, file)),
    checksums.get(file),
    `Published checksum: ${file}`,
  );
assert.equal((await readFile(join(directory, 'version.txt'), 'utf8')).trim(), version);
const update = JSON.parse(await readFile(join(directory, 'latest.json'), 'utf8'));
assert.equal(update.version, version);
assert.equal(
  update.platforms['linux-x86_64'].url,
  `https://github.com/pierce403/shellguardian/releases/download/v${version}/${imageName}`,
);
const signature = (await readFile(join(directory, `${imageName}.sig`), 'utf8')).trim();
assert.equal(update.platforms['linux-x86_64'].signature, signature);
assert.ok(
  Buffer.from(signature, 'base64')
    .toString('utf8')
    .split('\n')
    .some(
      (line) =>
        line.startsWith('trusted comment: ') && line.split('\t').includes(`version:${version}`),
    ),
  'Updater signature must bind the version.',
);
await chmod(join(directory, imageName), 0o755);

const dataDirectory = join(directory, 'installed-data');
const binDirectory = join(directory, 'installed-bin');
const installDirectory = join(dataDirectory, 'shellguardian');
const environment = {
  ...process.env,
  XDG_DATA_HOME: dataDirectory,
  SHELLGUARDIAN_BIN_DIR: binDirectory,
  SHELLGUARDIAN_INSTALL_DIR: installDirectory,
};
// Preserve HOME and XDG_CONFIG_HOME so the existing OpenShell profiles are read
// normally. No app preference writes or operating-system theme changes occur.
const installerOutput = execFileSync(
  'bash',
  [join(directory, 'install.sh'), '--version', version],
  { env: environment, encoding: 'utf8', timeout: 300000 },
);
await writeFile(join(directory, 'installer-output.txt'), installerOutput);
const installed = join(installDirectory, 'ShellGuardian.AppImage');
assert.equal(await digest(installed), checksums.get(imageName));
assert.equal(
  (await readFile(join(installDirectory, '.shellguardian-install'), 'utf8')).trim(),
  version,
);
const desktopPath = join(dataDirectory, 'applications/bot.recurse.shellguardian.desktop');
const desktop = await readFile(desktopPath, 'utf8');
assert.ok(desktop.includes(`Exec="${join(binDirectory, 'shellguardian')}"\n`));
assert.ok(desktop.includes('Icon=bot.recurse.shellguardian\n'));
assert.ok(desktop.includes('StartupWMClass=shellguardian\n'));
execFileSync('desktop-file-validate', [desktopPath], { stdio: 'pipe' });
const icon = await readFile(
  join(dataDirectory, 'icons/hicolor/scalable/apps/bot.recurse.shellguardian.svg'),
  'utf8',
);
assert.match(icon, /<svg[^>]+viewBox="0 0 512 512"/);

const nativeOutput = execFileSync(
  process.execPath,
  ['scripts/native-ssh-smoke.mjs', join(binDirectory, 'shellguardian')],
  {
    env: {
      ...environment,
      SHELLGUARDIAN_NATIVE_DEV: '',
      SHELLGUARDIAN_EXPECT_VERSION: version,
      SHELLGUARDIAN_VERIFY_DESKTOP_IDENTITY: '1',
    },
    encoding: 'utf8',
    timeout: 240000,
  },
);
const native = JSON.parse(nativeOutput);
assert.equal(native.native, true);
assert.equal(native.realSsh, true);
assert.equal(
  await digest(installed),
  checksums.get(imageName),
  'Acceptance must not replace the installed release.',
);
await copyFile(
  'test-results/native-ssh-connected.png',
  join(directory, 'native-ssh-connected.png'),
);
const report = {
  version,
  publishedAt: metadata.publishedAt,
  release: metadata.url,
  sha256: checksums.get(imageName),
  allAssetChecksumsVerified: true,
  versionBoundSignatureMetadata: true,
  isolatedInstallerVerified: true,
  desktopEntryValid: true,
  dockIconInstalled: true,
  native,
};
await writeFile(join(directory, 'verification.json'), `${JSON.stringify(report, null, 2)}\n`);
console.log(JSON.stringify(report, null, 2));
