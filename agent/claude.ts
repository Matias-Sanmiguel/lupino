import { query, tool, createSdkMcpServer } from '@anthropic-ai/claude-agent-sdk';
import { schemas, descriptions, type ToolName, type ToolCall } from './tools.js';
import { INSTRUCTIONS, makePrompt, type Request } from './protocol.js';
export async function claude(
  r: Request,
  call: ToolCall,
  emit: (v: object) => void,
  abort: AbortController,
) {
  if (!process.env.ANTHROPIC_API_KEY)
    throw new Error('Agregá tu API key de Anthropic en Conexiones.');
  if (r.action !== 'chat') {
    const response = await fetch('https://api.anthropic.com/v1/models', {
      headers: { 'x-api-key': process.env.ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01' },
      signal: abort.signal,
    });
    if (!response.ok)
      throw new Error(
        `Anthropic no pudo validar la cuenta (${response.status}). Revisá la API key.`,
      );
    const data = (await response.json()) as { data: { id: string }[] };
    return {
      connected: true,
      detail: 'API de Anthropic conectada',
      models: data.data.map((m) => m.id),
    };
  }
  const names = Object.keys(schemas) as ToolName[];
  const server = createSdkMcpServer({
    name: 'lupino',
    version: '1.0.0',
    tools: names.map((name) =>
      tool(name, descriptions[name], schemas[name].shape, async (args) => ({
        content: [{ type: 'text' as const, text: JSON.stringify(await call(name, args)) }],
      })),
    ),
  });
  const run = query({
    prompt: makePrompt(r),
    options: {
      model: r.model || 'sonnet',
      cwd: process.env.LUPINO_AGENT_WORKSPACE,
      systemPrompt: INSTRUCTIONS,
      tools: [],
      allowedTools: names.map((n) => `mcp__lupino__${n}`),
      mcpServers: { lupino: server },
      settingSources: [],
      persistSession: false,
      maxTurns: 20,
      includePartialMessages: true,
      abortController: abort,
      canUseTool: async (name, input) =>
        name.startsWith('mcp__lupino__') &&
        names.includes(name.replace('mcp__lupino__', '') as ToolName)
          ? { behavior: 'allow', updatedInput: input }
          : { behavior: 'deny', message: 'Lupino sólo permite herramientas de su biblioteca.' },
    },
  });
  let final = '';
  let completed = false;
  try {
    for await (const item of run) {
      if (
        item.type === 'stream_event' &&
        item.event.type === 'content_block_delta' &&
        item.event.delta.type === 'text_delta'
      )
        emit({ type: 'delta', delta: item.event.delta.text });
      if (item.type === 'result') {
        if (item.subtype !== 'success' || item.is_error)
          throw new Error(
            'Claude no pudo completar la consulta. Revisá el límite de uso o la conexión.',
          );
        final = item.result;
        completed = true;
      }
    }
  } finally {
    run.close();
  }
  if (!completed) throw new Error('Claude terminó sin completar la respuesta.');
  return { text: final };
}
