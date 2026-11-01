import https from 'node:https';
import { spawn, execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync, mkdirSync, cpSync, openSync, mkdtempSync } from 'node:fs';
import { createHash, X509Certificate } from 'node:crypto';
import { resolve, join } from 'node:path';
import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
// Isolated integration check: never reads the user's Brave profile or library.
const root = resolve('.'),
  tmp = mkdtempSync(join(tmpdir(), 'lupino-folder-smoke-')),
  profile = join(tmp, 'brave-' + Date.now()),
  data = join(tmp, 'data-' + Date.now()),
  ext = join(tmp, 'extension-' + Date.now());
execFileSync(
  'openssl',
  [
    'req',
    '-x509',
    '-newkey',
    'rsa:2048',
    '-nodes',
    '-keyout',
    join(tmp, 'key.pem'),
    '-out',
    join(tmp, 'cert.pem'),
    '-days',
    '1',
    '-subj',
    '/CN=lupino-fixture.sharepoint.com',
    '-addext',
    'subjectAltName=DNS:lupino-fixture.sharepoint.com',
  ],
  { stdio: 'ignore' },
);
const executable = resolve(process.env.LUPINO_SMOKE_EXE || 'target/debug/lupino-desktop');
const host = 'lupino-fixture.sharepoint.com',
  origin = 'https://' + host,
  id = 'jlnclpnokcbfghobgoiilagpdgepemdb';
const folder = '/sites/class/Documentos/Materiales',
  page = origin + '/sites/class/Documentos/Forms/AllItems.aspx?id=' + encodeURIComponent(folder);
mkdirSync(profile, { recursive: true });
mkdirSync(data, { recursive: true });
cpSync(join(root, 'dist/extension'), ext, { recursive: true });
// Grant only the fake fixture site in the TEST COPY. The shipped manifest keeps permissions optional.
const manifest = JSON.parse(readFileSync(join(ext, 'manifest.json'), 'utf8'));
manifest.host_permissions = [origin + '/*'];
writeFileSync(join(ext, 'manifest.json'), JSON.stringify(manifest));
mkdirSync(join(profile, 'NativeMessagingHosts'), { recursive: true });
writeFileSync(
  join(profile, 'NativeMessagingHosts/app.lupino.capture.json'),
  JSON.stringify({
    name: 'app.lupino.capture',
    description: 'Lupino isolated test',
    path: executable,
    type: 'stdio',
    allowed_origins: [`chrome-extension://${id}/`],
  }),
);
let version = 1,
  downloads = 0,
  authenticatedRequests = 0;
const guid = '12345678-1234-4234-8234-123456789abc';
const server = https.createServer(
  { key: readFileSync(join(tmp, 'key.pem')), cert: readFileSync(join(tmp, 'cert.pem')) },
  (req, res) => {
    const url = new URL(req.url, origin),
      path = decodeURIComponent(url.pathname);
    if (!path.includes('/_api/')) {
      res.writeHead(200, {
        'content-type': 'text/html',
        'Set-Cookie': 'fixture=ready; Path=/; Secure; SameSite=Strict',
      });
      res.end('<title>Lupino fixture</title><h1>Materiales de clase</h1>');
      return;
    }
    if (!req.headers.cookie?.includes('fixture=ready')) {
      res.writeHead(401);
      res.end('no session');
      return;
    }
    authenticatedRequests++;
    if (path.endsWith('/$value')) {
      downloads++;
      res.writeHead(200, { 'content-type': 'text/plain' });
      res.end(
        version === 1
          ? 'Matrices originales. Parcial el 12/11/2026.'
          : 'Determinantes actualizados. Parcial el 19/11/2026.',
      );
      return;
    }
    res.writeHead(200, { 'content-type': 'application/json' });
    if (path.endsWith('/Folders')) res.end(JSON.stringify({ value: [] }));
    else
      res.end(
        JSON.stringify({
          value: [
            {
              Name: 'guia.txt',
              ServerRelativeUrl: folder + '/guia.txt',
              UniqueId: guid,
              Length: '80',
              TimeLastModified: `2026-11-0${version}T12:00:00Z`,
              ETag: String(version),
            },
          ],
        }),
      );
  },
);
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const port = server.address().port;
const cert = new X509Certificate(readFileSync(join(tmp, 'cert.pem')));
const spki = createHash('sha256')
  .update(cert.publicKey.export({ type: 'spki', format: 'der' }))
  .digest('base64');
const log = openSync(join(tmp, 'browser.log'), 'a');
const app = spawn(executable, [], {
  env: { ...process.env, LUPINO_DATA_DIR: data, GDK_BACKEND: 'x11' },
  stdio: ['ignore', 'ignore', openSync(join(tmp, 'desktop.log'), 'a')],
});
const browser = spawn(
  '/opt/brave-bin/brave',
  [
    `--user-data-dir=${profile}`,
    `--load-extension=${ext}`,
    `--host-resolver-rules=MAP ${host} 127.0.0.1:${port}`,
    `--ignore-certificate-errors-spki-list=${spki}`,
    '--remote-debugging-pipe',
    '--no-proxy-server',
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-sync',
    page,
  ],
  {
    env: { ...process.env, LUPINO_DATA_DIR: data },
    stdio: ['ignore', 'ignore', log, 'pipe', 'pipe'],
  },
);
let seq = 0,
  buffer = '';
const pending = new Map();
browser.stdio[4].on('data', (chunk) => {
  buffer += chunk;
  while (buffer.includes('\0')) {
    const at = buffer.indexOf('\0'),
      line = buffer.slice(0, at);
    buffer = buffer.slice(at + 1);
    if (!line) continue;
    const msg = JSON.parse(line),
      p = pending.get(msg.id);
    if (p) {
      pending.delete(msg.id);
      clearTimeout(p.timer);
      msg.error ? p.reject(Error(JSON.stringify(msg.error))) : p.resolve(msg.result);
    }
  }
});
function call(method, params = {}, sessionId) {
  return new Promise((resolve, reject) => {
    const id = ++seq,
      timer = setTimeout(() => {
        pending.delete(id);
        reject(Error('Timeout ' + method));
      }, 20000);
    pending.set(id, { resolve, reject, timer });
    browser.stdio[3].write(
      JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }) + '\0',
    );
  });
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function evaluate(sessionId, expression) {
  const r = await call(
    'Runtime.evaluate',
    { expression, awaitPromise: true, returnByValue: true, userGesture: true },
    sessionId,
  );
  if (r.exceptionDetails) throw Error(JSON.stringify(r.exceptionDetails));
  return r.result.value;
}
let popup, sessionId;
try {
  await call('Browser.getVersion');
  await sleep(2000);
  const target = await call('Target.createTarget', {
    url: `chrome-extension://${id}/popup.html`,
    background: true,
  });
  popup = target.targetId;
  ({ sessionId } = await call('Target.attachToTarget', { targetId: popup, flatten: true }));
  let status;
  for (let i = 0; i < 30; i++) {
    status = await evaluate(sessionId, 'document.querySelector("#status")?.textContent');
    if (status === 'Conectado con Lupino.') break;
    await sleep(200);
  }
  assert.equal(status, 'Conectado con Lupino.');
  const detected = await evaluate(
    sessionId,
    '({path:document.querySelector("#folder-location").textContent,disabled:document.querySelector("#link-folder").disabled})',
  );
  assert.equal(detected.path, folder);
  assert.equal(detected.disabled, false);
  await evaluate(
    sessionId,
    'document.querySelector("#subject").value="Prueba automática";document.querySelector("#link-folder").click()',
  );
  async function completed() {
    let result;
    for (let i = 0; i < 60; i++) {
      result = await evaluate(sessionId, 'chrome.runtime.sendMessage({type:"sync-list"})');
      const s = result.folders?.[0]?.state;
      if (s?.status === 'error') throw Error(s.error);
      if (s?.lastCompleted && s.status === 'idle') return result;
      await sleep(200);
    }
    throw Error(JSON.stringify(result));
  }
  let result = await completed();
  const link = result.folders[0].link;
  assert.equal(result.folders[0].state.stats.sent, 1);
  assert.equal(downloads, 1);
  await sleep(5500);
  await evaluate(
    sessionId,
    `chrome.runtime.sendMessage({type:'sync-run',id:${JSON.stringify(link.id)}})`,
  );
  await sleep(500);
  await completed();
  assert.equal(downloads, 1, 'unchanged file re-downloaded');
  version = 2;
  await evaluate(
    sessionId,
    `chrome.runtime.sendMessage({type:'sync-run',id:${JSON.stringify(link.id)}})`,
  );
  await sleep(500);
  result = await completed();
  assert.equal(downloads, 2);
  await sleep(5500);
  const rows = JSON.parse(
    execFileSync(
      'python3',
      [
        '-c',
        `import sqlite3,json; db=sqlite3.connect(${JSON.stringify(join(data, 'lupino.sqlite'))}); print(json.dumps({'sources':db.execute('select count(*) from sources').fetchone()[0],'revisions':db.execute('select count(*) from revisions').fetchone()[0],'latest':json.loads(db.execute('select data from sources').fetchone()[0])}))`,
      ],
      { encoding: 'utf8' },
    ),
  );
  assert.equal(rows.sources, 1);
  assert.equal(rows.revisions, 2);
  assert.equal(rows.latest.title, 'Materiales/guia.txt');
  await evaluate(
    sessionId,
    `chrome.runtime.sendMessage({type:'sync-pause',id:${JSON.stringify(link.id)},paused:true})`,
  );
  const screenshot = await call('Page.captureScreenshot', { format: 'png' }, sessionId);
  mkdirSync(join(root, 'artifacts'), { recursive: true });
  writeFileSync(
    join(root, 'artifacts/folder-sync-popup.png'),
    Buffer.from(screenshot.data, 'base64'),
  );
  const receipt = {
    result: 'PASS',
    authenticatedRequests,
    downloads,
    sources: rows.sources,
    revisions: rows.revisions,
    status: result.folders[0].state,
    scope:
      'isolated Brave + HTTPS fixture with SameSite=Strict cookie + native executable + real SQLite; not the university account',
  };
  writeFileSync(
    join(root, 'artifacts/folder-sync-verification.json'),
    JSON.stringify(receipt, null, 2),
  );
  console.log(JSON.stringify(receipt));
} finally {
  await call('Browser.close').catch(() => {});
  browser.stdio[3].end();
  app.kill('SIGTERM');
  await new Promise((r) => server.close(r));
}
