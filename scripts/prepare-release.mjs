// Generate stable release assets from the signed Tauri build, never from source alone.
import { createHash } from 'node:crypto';
import { copyFile, mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import assert from 'node:assert/strict';

const pkg = JSON.parse(await readFile('package.json', 'utf8'));
const config = JSON.parse(await readFile('src-tauri/tauri.conf.json', 'utf8'));
assert.match(pkg.version, /^\d+\.\d+\.\d+$/);
assert.equal(config.version, pkg.version);
const bundle = resolve(process.argv[2] ?? 'target/release/bundle/appimage');
const output = resolve(process.argv[3] ?? '.cache/release');
const images = (await readdir(bundle)).filter((name) => name.endsWith('.AppImage'));
assert.equal(images.length, 1, 'Release must contain exactly one AppImage');
const signature = (await readFile(join(bundle, `${images[0]}.sig`), 'utf8')).trim();
const trustedComment = Buffer.from(signature, 'base64')
  .toString('utf8')
  .split('\n')
  .find((line) => line.startsWith('trusted comment: '));
assert.ok(
  trustedComment?.split('\t').includes(`version:${pkg.version}`),
  'Signature must bind the version',
);
const name = `ShellGuardian_${pkg.version}_amd64.AppImage`;
await mkdir(output, { recursive: true });
await copyFile(join(bundle, images[0]), join(output, name));
await writeFile(join(output, `${name}.sig`), `${signature}\n`);
await copyFile('install.sh', join(output, 'install.sh'));
await writeFile(join(output, 'version.txt'), `${pkg.version}\n`);
await writeFile(
  join(output, 'latest.json'),
  `${JSON.stringify(
    {
      version: pkg.version,
      notes:
        'Signed ShellGuardian release. Automatic app updates install on normal close; OpenShell is unchanged.',
      pub_date: new Date().toISOString(),
      platforms: {
        'linux-x86_64': {
          signature,
          url: `https://github.com/pierce403/shellguardian/releases/download/v${pkg.version}/${name}`,
        },
      },
    },
    null,
    2,
  )}\n`,
);
const files = [name, `${name}.sig`, 'install.sh', 'version.txt', 'latest.json'];
const checksums = await Promise.all(
  files.map(async (file) => {
    const bytes = await readFile(join(output, file));
    return `${createHash('sha256').update(bytes).digest('hex')}  ${file}\n`;
  }),
);
await writeFile(join(output, 'SHA256SUMS'), checksums.join(''));
console.log(
  `Prepared ${pkg.version}: ${files.length + 1} assets with version-bound signatures and checksums.`,
);
