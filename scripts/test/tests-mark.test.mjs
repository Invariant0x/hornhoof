import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createServer } from 'node:http';
import { fileURLToPath, URL } from 'node:url';

const SCRIPT = fileURLToPath(new URL('../tests-mark.mjs', import.meta.url));
const SHA = 'a'.repeat(40);

/* A GitHub that remembers what it was sent and answers with the given status code. */
async function github(code) {
  const sent = [];
  const server = createServer((req, res) => {
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', () => {
      sent.push({ method: req.method, url: req.url, auth: req.headers.authorization, body: body ? JSON.parse(body) : null });
      res.writeHead(code, { 'content-type': 'application/json' }).end('{}');
    });
  });
  await new Promise(done => server.listen(0, '127.0.0.1', done));
  return { sent, url: `http://127.0.0.1:${server.address().port}`, close: () => new Promise(done => server.close(done)) };
}

function leave(api) {
  const env = { ...process.env, GITHUB_API_URL: api, GITHUB_SERVER_URL: 'https://github.example', GITHUB_REPOSITORY: 'owner/repo', GITHUB_TOKEN: 'token-1', GITHUB_SHA: SHA, GITHUB_RUN_ID: '77' };
  return new Promise(done => execFile(process.execPath, [SCRIPT, '--leave'], { env }, (error, stdout, stderr) => done({ code: error ? error.code : 0, stdout, stderr })));
}

test('--leave sets hornhoof/tests to success on the commit, linking the run that passed', async () => {
  const gh = await github(201);
  try {
    const out = await leave(gh.url);
    assert.equal(out.code, 0, out.stderr);
    assert.deepEqual(gh.sent, [{
      method: 'POST',
      url: `/repos/owner/repo/statuses/${SHA}`,
      auth: 'Bearer token-1',
      body: { state: 'success', context: 'hornhoof/tests', description: 'GitHub ran the full tests and they passed.', target_url: 'https://github.example/owner/repo/actions/runs/77' },
    }]);
  } finally { await gh.close(); }
});

test('--leave fails when GitHub does not take the mark', async () => {
  const gh = await github(403);
  try {
    const out = await leave(gh.url);
    assert.notEqual(out.code, 0);
    assert.match(out.stderr, /GitHub answered 403/);
  } finally { await gh.close(); }
});
