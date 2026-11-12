import { strict as assert } from 'node:assert';
import { join, normalize } from 'node:path';
import { test } from 'node:test';
import { forwardHeaders, isServicePath, resolveStatic, validateServer } from './routing';

const root = normalize(join(process.cwd(), 'web'));

test('backend paths are forwarded, everything else is the web app', () => {
  assert.equal(isServicePath('/api/v1/me'), true);
  assert.equal(isServicePath('/sync/v1/pull'), true);
  assert.equal(isServicePath('/ai/v1/jobs'), true);
  assert.equal(isServicePath('/agent'), false); // the AI page route, not the AI service
  assert.equal(isServicePath('/apiary'), false);
  assert.equal(isServicePath('/projects/123'), false);
});

test('server must be https except localhost', () => {
  assert.equal(validateServer('https://baheka-construct-os.com/some/path'), 'https://baheka-construct-os.com');
  assert.equal(validateServer('http://localhost:8088'), 'http://localhost:8088');
  assert.throws(() => validateServer('http://baheka-construct-os.com'), /https/);
  assert.throws(() => validateServer('file:///etc/passwd'), /https/);
});

test('static paths stay inside the web root', () => {
  assert.equal(resolveStatic(root, '/assets/index.js'), join(root, 'assets', 'index.js'));
  assert.equal(resolveStatic(root, '/'), root);
  assert.equal(resolveStatic(root, '/../../secret.txt'), null);
  assert.equal(resolveStatic(root, '/%2e%2e/%2e%2e/secret.txt'), null);
  assert.equal(resolveStatic(root, '/assets/%00.js'), null);
  assert.equal(resolveStatic(root, '/%E0%A4%A'), null); // malformed escape
});

test('origin, referer, host and cookies are not forwarded; the bearer token is', () => {
  const h = forwardHeaders(new Headers({ origin: 'app://constructos', referer: 'app://constructos/x', cookie: 'a=b', authorization: 'Bearer t', 'content-type': 'application/json' }));
  assert.equal(h.get('origin'), null);
  assert.equal(h.get('referer'), null);
  assert.equal(h.get('cookie'), null);
  assert.equal(h.get('authorization'), 'Bearer t');
  assert.equal(h.get('content-type'), 'application/json');
});
