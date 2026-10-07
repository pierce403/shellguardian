import assert from 'node:assert/strict';
import { access, readFile } from 'node:fs/promises';
import { runInNewContext } from 'node:vm';

const html = await readFile(new URL('./dist/index.html', import.meta.url), 'utf8');
const helper = await readFile(new URL('./dist/site.js', import.meta.url), 'utf8');
const headers = await readFile(new URL('./dist/_headers', import.meta.url), 'utf8');
assert.match(headers, /Cache-Control: public, max-age=0, must-revalidate, no-transform/);
const ids = new Set([...html.matchAll(/\bid="([^"]+)"/g)].map((match) => match[1]));
const links = [...html.matchAll(/\bhref="([^"]+)"/g)].map((match) => match[1]);
const repo = 'https://github.com/pierce403/shellguardian';

assert.match(html, /^<!doctype html>/i);
assert.equal([...html.matchAll(/<h1\b/g)].length, 1);
for (const section of ['about', 'install', 'releases']) {
  assert.ok(ids.has(section), `Missing static ${section} section`);
  assert.ok(links.includes(`#${section}`));
}
for (const path of ['', '/releases', '/issues', '/blob/main/README.md']) {
  assert.ok(links.includes(`${repo}${path}`), `Missing project link: ${path}`);
}
for (const link of links.filter((value) => value.startsWith('#'))) {
  assert.ok(ids.has(link.slice(1)), `Broken page anchor: ${link}`);
}
for (const match of html.matchAll(/\b(?:src|href)="(\/[^"#]+)"/g)) {
  await access(new URL(`./dist${match[1]}`, import.meta.url));
}

const version = html.match(/id="release-[^"]+">v([\d.]+)/)?.[1];
assert.ok(version, 'A static release entry is required');
for (const file of [
  `ShellGuardian_${version}_amd64.AppImage`,
  'install.sh',
  'SHA256SUMS',
  `ShellGuardian_${version}_amd64.AppImage.sig`,
]) {
  assert.ok(links.includes(`${repo}/releases/download/v${version}/${file}`));
}
assert.match(html, /This website only\s+provides project information and downloads/);
assert.match(html, /Static screenshot with sample agents/);
assert.match(html, /Automatic updates are on by default/);
assert.match(html, /Talk to your agent/);
assert.match(html, /sandbox's existing main process/);
assert.match(html, /separate interactive shell inside the selected sandbox, not on your host/);
assert.match(html, /Provider panels show metadata, never\s+credential values/);
assert.match(html, /Interactive terminal output can contain sensitive information/);
assert.match(html, /Session\s+output\s+stays\s+in\s+memory/);
assert.ok(
  links.includes(`${repo}/releases/tag/v0.3.2`),
  'Keep the prior launcher fix in release history',
);
assert.match(html, /OpenShell upgrades remain\s+separate and explicit/);
assert.doesNotMatch(html, /\u2014/);
assert.match(html, /id="copy-install"[^>]*\bhidden/);
assert.equal([...html.matchAll(/<script\b/g)].length, 1);
assert.match(html, /<script type="module" src="\/site.js"><\/script>/);
assert.doesNotMatch(
  helper,
  /\b(?:fetch|WebSocket|EventSource|localStorage|sessionStorage|indexedDB|invoke)\b/,
);

const commandText = html.match(/id="install-command">([^<]+)<\/code>/)?.[1];
assert.equal(commandText, 'curl -fsSL https://shellguardian.org/install.sh | bash');

async function checkCopy(clipboardAvailable) {
  let click;
  let resetLabel;
  let clipboardText;
  let selections = 0;
  const copy = {
    hidden: true,
    textContent: 'Copy command',
    addEventListener: (event, handler) => {
      assert.equal(event, 'click');
      click = handler;
    },
  };
  const command = { textContent: commandText };
  const status = { textContent: '' };
  const elements = { '#copy-install': copy, '#install-command': command, '#copy-status': status };
  runInNewContext(helper, {
    document: {
      querySelector: (selector) => elements[selector],
      createRange: () => ({ selectNodeContents: (node) => assert.equal(node, command) }),
    },
    navigator: {
      clipboard: {
        writeText: async (value) => {
          if (!clipboardAvailable) throw new Error('Clipboard unavailable');
          clipboardText = value;
        },
      },
    },
    window: {
      setTimeout: (callback) => {
        resetLabel = callback;
      },
      getSelection: () => ({
        removeAllRanges() {},
        addRange: () => {
          selections++;
        },
      }),
    },
  });
  assert.equal(copy.hidden, false);
  assert.equal(status.textContent, '');
  assert.equal(clipboardText, undefined);
  await click();
  if (clipboardAvailable) {
    assert.equal(clipboardText, commandText);
    assert.equal(copy.textContent, 'Copied');
    assert.match(status.textContent, /Command copied/);
    resetLabel();
    assert.equal(copy.textContent, 'Copy command');
  } else {
    assert.equal(clipboardText, undefined);
    assert.equal(selections, 1);
    assert.match(status.textContent, /copy it manually/);
  }
}

await checkCopy(true);
await checkCopy(false);
console.log('PASS static project/release content, asset links, and optional copy helper');
