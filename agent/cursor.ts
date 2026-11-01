import { Agent, Cursor, emptyFs, type SDKCustomTool } from '@cursor/sdk';
import { schemas, descriptions, jsonSchema, type ToolName, type ToolCall } from './tools.js';
import { makePrompt, type Request } from './protocol.js';
export async function cursor(
  r: Request,
  call: ToolCall,
  emit: (v: object) => void,
  abort: AbortController,
) {
  if (r.action === 'login') {
    const login = await Cursor.auth.login({
      store: null,
      openBrowser: false,
      onLoginUrl: (url) => emit({ type: 'auth', url }),
      signal: abort.signal,
      apiKeyName: 'Lupino escritorio',
    });
    emit({ type: 'credential', provider: 'cursor', value: login.apiKey });
    return {
      connected: true,
      detail: login.email || 'Cuenta Cursor conectada',
      models: (await Cursor.models.list({ apiKey: login.apiKey })).map((m) => m.id),
    };
  }
  const key = process.env.CURSOR_API_KEY;
  if (!key)
    return r.action === 'chat'
      ? Promise.reject(new Error('Conectá tu cuenta Cursor primero.'))
      : { connected: false, detail: 'Iniciá sesión con Cursor', models: [] };
  if (r.action !== 'chat') {
    await Cursor.me({ apiKey: key });
    return {
      connected: true,
      detail: 'Cuenta Cursor conectada',
      models: (await Cursor.models.list({ apiKey: key })).map((m) => m.id),
    };
  }
  const models = r.model ? [] : await Cursor.models.list({ apiKey: key });
  const model = r.model || models[0]?.id;
  if (!model) throw new Error('Cursor no devolvió modelos disponibles para tu cuenta.');
  const customTools: Record<string, SDKCustomTool> = Object.fromEntries(
    (Object.keys(schemas) as ToolName[]).map((name) => [
      name,
      {
        description: descriptions[name],
        inputSchema: jsonSchema(name),
        execute: async (args) => JSON.stringify(await call(name, args)),
      },
    ]),
  );
  const agent = await Agent.create({
    apiKey: key,
    model: { id: model },
    tools: ['mcp'],
    local: {
      cwd: process.env.LUPINO_AGENT_WORKSPACE,
      fs: emptyFs(),
      settingSources: [],
      customTools,
    },
  });
  try {
    const run = await agent.send(makePrompt(r));
    const cancel = () => {
      void run.cancel().catch(() => {});
    };
    abort.signal.addEventListener('abort', cancel, { once: true });
    try {
      for await (const message of run.stream()) {
        if (message.type === 'assistant') {
          const text = message.message.content
            .filter((b) => b.type === 'text')
            .map((b) => b.text)
            .join('');
          if (text) emit({ type: 'delta', delta: text });
        }
      }
      const result = await run.wait();
      if (result.status !== 'finished')
        throw new Error(result.error?.message || 'Cursor no completó la consulta.');
      return { text: result.result || run.result || '' };
    } finally {
      abort.signal.removeEventListener('abort', cancel);
    }
  } finally {
    agent.close();
  }
}
