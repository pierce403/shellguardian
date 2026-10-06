import assert from 'node:assert/strict';
import worker from './worker.js';

let requests = 0;
const assets = {
  fetch: async (request) => {
    requests++;
    return new Response(new URL(request.url).pathname);
  },
};
const env = { ASSETS: assets };
const redirect = await worker.fetch(
  new Request('http://shellguardian.org/install.sh?version=0.2.0'),
  env,
);
assert.equal(redirect.status, 308);
assert.equal(
  redirect.headers.get('location'),
  'https://shellguardian.org/install.sh?version=0.2.0',
);
assert.equal(requests, 0);
const asset = await worker.fetch(new Request('https://shellguardian.org/style.css'), env);
assert.equal(await asset.text(), '/style.css');
assert.equal(requests, 1);
const untrustedHost = await worker.fetch(new Request('http://untrusted.example/path'), env);
assert.equal(untrustedHost.headers.get('location'), 'https://shellguardian.org/path');
console.log('PASS HTTPS redirect, static passthrough, and fixed canonical host');
