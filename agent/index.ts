import { createInterface } from 'node:readline';
import { parseRequest, safeFinal } from './protocol.js';
import { schemas, type ToolName } from './tools.js';
const emit = (v: object) => process.stdout.write(JSON.stringify(v) + '\n');
// SDK diagnostics must never corrupt the host's framed protocol.
console.log = () => {};
const lines = createInterface({ input: process.stdin });
const abort = new AbortController();
const pending = new Map<
  string,
  { resolve: (v: unknown) => void; reject: (e: Error) => void; timer: NodeJS.Timeout }
>();
let started = false;
let steps = 0;
let citationCount = 0;
const timeout = setTimeout(() => abort.abort(), 10 * 60 * 1000);
lines.on('close', () => abort.abort());
process.on('SIGTERM', () => abort.abort());
abort.signal.addEventListener('abort', () => {
  for (const p of pending.values()) {
    clearTimeout(p.timer);
    p.reject(new Error('Consulta cancelada.'));
  }
  pending.clear();
  setTimeout(() => {
    emit({ type: 'error', message: 'Consulta cancelada.' });
    process.exit(1);
  }, 3000).unref();
});
async function call(name: ToolName, args: unknown): Promise<unknown> {
  if (!(name in schemas)) throw new Error('Herramienta no permitida.');
  if (++steps > 16) throw new Error('Se alcanzó el límite de búsquedas por consulta.');
  const parsed = schemas[name].parse(args);
  const id = crypto.randomUUID();
  emit({
    type: 'status',
    message: name === 'propose_event' ? 'Proponiendo una fecha…' : 'Consultando tu biblioteca…',
  });
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error('La biblioteca no respondió.'));
    }, 30000);
    pending.set(id, { resolve, reject, timer });
    emit({ type: 'tool_call', id, name, args: parsed });
  });
}
lines.on('line', (line) => {
  if (line.length > 2_000_000) {
    emit({ type: 'error', message: 'Solicitud demasiado grande.' });
    process.exit(1);
  }
  let value: any;
  try {
    value = JSON.parse(line);
  } catch {
    emit({ type: 'error', message: 'Solicitud inválida.' });
    process.exit(1);
  }
  if (value.type === 'cancel') {
    abort.abort();
    return;
  }
  if (value.type === 'tool_result') {
    const p = pending.get(value.id);
    if (p) {
      pending.delete(value.id);
      clearTimeout(p.timer);
      citationCount = Math.max(citationCount, value.citationCount || 0);
      value.error ? p.reject(new Error(value.error)) : p.resolve(value.result);
    }
    return;
  }
  if (started) return;
  started = true;
  (async () => {
    const request = parseRequest(value);
    citationCount = Array.isArray(request.context) ? request.context.length : 0;
    const module = await (request.provider === 'claude'
      ? import('./claude.js')
      : request.provider === 'cursor'
        ? import('./cursor.js')
        : import('./codex.js'));
    const fn =
      'claude' in module ? module.claude : 'cursor' in module ? module.cursor : module.codex;
    const result = await fn(request, call, emit, abort);
    if (abort.signal.aborted) throw new Error('Consulta cancelada.');
    if ('text' in result)
      emit({ type: 'result', text: safeFinal(String(result.text), citationCount) });
    else emit({ type: 'result', data: result });
  })()
    .catch((e) =>
      emit({
        type: 'error',
        message: abort.signal.aborted
          ? 'Consulta cancelada.'
          : e instanceof Error
            ? e.message
            : String(e),
      }),
    )
    .finally(() => {
      clearTimeout(timeout);
      lines.close();
      setTimeout(() => process.exit(0), 50);
    });
});
