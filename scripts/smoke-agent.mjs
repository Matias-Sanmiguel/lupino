import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { mkdtemp, rm, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import assert from 'node:assert/strict';
const root = await mkdtemp(join(tmpdir(), 'lupino-agent-smoke-'));

await mkdir(join(root, 'workspace'));
const entry = resolve(process.argv[2] || 'dist/agent/index.js');
const env = {
  PATH: process.env.PATH,
  HOME: root,
  USERPROFILE: root,
  SystemRoot: process.env.SystemRoot,
  TEMP: root,
  TMPDIR: root,
  CODEX_HOME: join(root, 'codex'),
  CLAUDE_CONFIG_DIR: join(root, 'claude'),
  LUPINO_AGENT_WORKSPACE: join(root, 'workspace'),
};
if (process.env.LUPINO_CODEX_ENTRY) env.LUPINO_CODEX_ENTRY = process.env.LUPINO_CODEX_ENTRY;
async function request(payload, cancel = false) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [entry], { env, stdio: ['pipe', 'pipe', 'pipe'] });
    const output = [];
    let errors = '';
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error('El bridge no terminó a tiempo'));
    }, 45000);
    child.stderr.on('data', (b) => (errors += b));
    child.on('error', reject);
    createInterface({ input: child.stdout }).on('line', (line) => {
      try {
        output.push(JSON.parse(line));
      } catch {
        reject(new Error('Salida fuera del protocolo'));
      }
    });
    child.on('close', () => {
      clearTimeout(timer);
      if (!output.length) reject(new Error(`Sin resultado: ${errors}`));
      else resolve(output);
    });
    child.stdin.write(
      typeof payload === 'string' ? payload + '\n' : JSON.stringify(payload) + '\n',
    );
    if (cancel) child.stdin.write('{"type":"cancel"}\n');
  });
}
try {
  for (const provider of ['chatgpt', 'cursor']) {
    const events = await request({ action: 'status', provider });
    const result = events.find((e) => e.type === 'result');
    assert.ok(result, JSON.stringify(events));
    assert.equal(result.data.connected, false);
    console.log(`${provider}: runtime responde; cuenta deliberadamente desconectada`);
  }
  const claude = await request({
    action: 'chat',
    provider: 'claude',
    prompt: 'No llamar al modelo',
  });
  assert.ok(claude.some((e) => e.type === 'error' && e.message.includes('API key')));
  console.log('claude: rechaza consulta sin clave, sin consumo');
  assert.ok((await request('invalid-json')).some((e) => e.type === 'error'));
  assert.ok(
    (await request({ action: 'chat', provider: 'chatgpt', prompt: 'cancelar' }, true)).some(
      (e) => e.type === 'error' && e.message.includes('cancelada'),
    ),
  );
  console.log('JSON inválido y cancelación: sin éxito falso.');
} finally {
  await rm(root, { recursive: true, force: true });
}
