import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { createInterface } from 'node:readline';
import { EventEmitter } from 'node:events';
import { mkdir } from 'node:fs/promises';
import { INSTRUCTIONS, makePrompt, type Request } from './protocol.js';
import { schemas, descriptions, jsonSchema, type ToolName, type ToolCall } from './tools.js';

export class Rpc extends EventEmitter {
  child: ChildProcessWithoutNullStreams;
  next = 1;
  failure?: Error;
  pending = new Map<
    number,
    { resolve: (v: any) => void; reject: (e: Error) => void; timer: NodeJS.Timeout }
  >();
  constructor(executable: string, args: string[], env = process.env) {
    super();
    this.child = spawn(executable, args, { env, stdio: 'pipe', windowsHide: true });
    this.child.stderr.resume();
    this.child.stdin.on('error', () =>
      this.fail(new Error('Se cerró el canal del runtime Codex.')),
    );
    createInterface({ input: this.child.stdout }).on('line', (line) => {
      try {
        const m = JSON.parse(line);
        if (m.method) {
          this.emit('notification', m);
          return;
        }
        const p = this.pending.get(m.id);
        if (p) {
          clearTimeout(p.timer);
          this.pending.delete(m.id);
          m.error ? p.reject(new Error(m.error.message)) : p.resolve(m.result);
        }
      } catch {
        this.fail(new Error('Respuesta inválida del proceso Codex.'));
      }
    });
    this.child.on('error', () =>
      this.fail(new Error('No se pudo iniciar el runtime oficial de Codex.')),
    );
    this.child.on('exit', () =>
      this.fail(new Error('El proceso Codex se cerró antes de terminar.')),
    );
  }
  fail(error: Error) {
    if (this.failure) return;
    this.failure = error;
    for (const p of this.pending.values()) {
      clearTimeout(p.timer);
      p.reject(error);
    }
    this.pending.clear();
    this.emit('closed', error);
  }
  send(value: object) {
    if (!this.child.stdin.destroyed) this.child.stdin.write(JSON.stringify(value) + '\n');
  }
  request(method: string, params: object = {}, timeout = 30000): Promise<any> {
    if (this.failure) return Promise.reject(this.failure);
    const id = this.next++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Codex no respondió a ${method}.`));
      }, timeout);
      this.pending.set(id, { resolve, reject, timer });
      this.send({ id, method, params });
    });
  }
  close() {
    this.child.kill();
    this.fail(new Error('Proceso finalizado.'));
  }
}

export async function codex(
  r: Request,
  call: ToolCall,
  emit: (v: object) => void,
  abort: AbortController,
) {
  abort.signal.throwIfAborted();
  if (!process.env.CODEX_HOME) throw new Error('Falta el perfil privado de Codex de Lupino.');
  await mkdir(process.env.CODEX_HOME, { recursive: true, mode: 0o700 });
  const disabled = [
    'shell_tool',
    'unified_exec',
    'view_image',
    'multi_agent',
    'apps',
    'plugins',
    'hooks',
    'browser_use',
    'computer_use',
    'code_mode',
    'code_mode_host',
    'image_generation',
    'memories',
  ];
  const args = [
    'app-server',
    '--listen',
    'stdio://',
    '-c',
    'web_search="disabled"',
    '-c',
    'cli_auth_credentials_store="keyring"',
  ];
  for (const feature of disabled) args.push('-c', `features.${feature}=false`);
  const rpc = process.env.LUPINO_CODEX_ENTRY
    ? new Rpc(process.execPath, [process.env.LUPINO_CODEX_ENTRY, ...args])
    : new Rpc(process.env.LUPINO_CODEX_BIN || 'codex', args);
  let turnId = '';
  let threadId = '';
  const cancel = () => {
    if (threadId && turnId)
      rpc.send({ id: 999999, method: 'turn/interrupt', params: { threadId, turnId } });
    rpc.close();
  };
  abort.signal.addEventListener('abort', cancel, { once: true });
  try {
    await rpc.request('initialize', {
      clientInfo: { name: 'lupino', title: 'Lupino', version: '0.1.0' },
      capabilities: { experimentalApi: true },
    });
    rpc.send({ method: 'initialized' });
    if (r.action === 'logout') {
      await rpc.request('account/logout');
      return { connected: false, detail: 'Sesión cerrada', models: [] };
    }
    if (r.action === 'login') {
      const done = new Promise<void>((resolve, reject) => {
        rpc.on('notification', (m) => {
          if (m.method === 'account/login/completed') {
            m.params.success
              ? resolve()
              : reject(new Error(m.params.error || 'No se pudo iniciar sesión.'));
          }
        });
        rpc.once('closed', reject);
      });
      void done.catch(() => {});
      const login = await rpc.request('account/login/start', { type: 'chatgpt' });
      if (login.authUrl) emit({ type: 'auth', url: login.authUrl });
      await done;
    }
    const account = await rpc.request('account/read', { refreshToken: false });
    if (r.action !== 'chat') {
      const catalog = account.account ? await rpc.request('model/list', {}) : { data: [] };
      return {
        connected: !!account.account,
        detail:
          account.account?.email ||
          (account.account ? 'Cuenta ChatGPT conectada' : 'Iniciá sesión con ChatGPT'),
        models: (catalog.data ?? []).map((m: any) => m.model || m.id),
      };
    }
    if (!account.account) throw new Error('Conectá tu cuenta ChatGPT primero.');
    const completed = new Promise<string>((resolve, reject) => {
      let text = '';
      rpc.on('notification', async (m) => {
        if (m.method === 'item/agentMessage/delta') {
          text += m.params.delta;
          emit({ type: 'delta', delta: m.params.delta });
        }
        if (m.method === 'turn/started') turnId = m.params.turn.id;
        if (m.method === 'turn/completed') {
          const t = m.params.turn;
          t.status === 'completed'
            ? resolve(text)
            : reject(new Error(t.error?.message || 'Codex no completó la respuesta.'));
        }
        if (m.id !== undefined) {
          if (m.method === 'item/tool/call') {
            try {
              const value = await call(m.params.tool as ToolName, m.params.arguments);
              rpc.send({
                id: m.id,
                result: {
                  contentItems: [{ type: 'inputText', text: JSON.stringify(value) }],
                  success: true,
                },
              });
            } catch (e) {
              rpc.send({
                id: m.id,
                result: { contentItems: [{ type: 'inputText', text: String(e) }], success: false },
              });
            }
          } else if (m.method.includes('requestApproval'))
            rpc.send({ id: m.id, result: { decision: 'decline' } });
          else
            rpc.send({
              id: m.id,
              error: { code: -32601, message: 'Lupino no permite esta operación.' },
            });
        }
      });
      rpc.once('closed', reject);
    });
    void completed.catch(() => {});
    const thread = await rpc.request('thread/start', {
      model: r.model || undefined,
      cwd: process.env.LUPINO_AGENT_WORKSPACE,
      ephemeral: true,
      approvalPolicy: 'untrusted',
      sandbox: 'read-only',
      baseInstructions: INSTRUCTIONS,
      dynamicTools: (Object.keys(schemas) as ToolName[]).map((name) => ({
        type: 'function',
        name,
        description: descriptions[name],
        inputSchema: jsonSchema(name),
      })),
    });
    threadId = thread.thread.id;
    const started = await rpc.request('turn/start', {
      threadId,
      input: [{ type: 'text', text: makePrompt(r) }],
    });
    turnId = started.turn.id;
    return { text: await completed };
  } finally {
    abort.signal.removeEventListener('abort', cancel);
    rpc.close();
  }
}
