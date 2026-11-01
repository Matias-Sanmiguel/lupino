import { z } from 'zod';
export const schemas = {
  list_sources: z.object({}),
  search_sources: z.object({ query: z.string().min(1).max(1000) }),
  read_source: z.object({ id: z.string().max(128), offset: z.number().int().min(0).default(0) }),
  list_events: z.object({}),
  propose_event: z.object({
    title: z.string().min(1).max(300),
    kind: z.enum(['entrega', 'parcial', 'final']),
    date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    time: z
      .string()
      .regex(/^\d{2}:\d{2}$/)
      .nullable()
      .default(null),
    chunkId: z.string().min(1).max(128),
    evidence: z.string().min(1).max(2200),
    note: z.string().max(1000).default(''),
  }),
};
export type ToolName = keyof typeof schemas;
export const descriptions: Record<ToolName, string> = {
  list_sources:
    'Lista las fuentes de la materia seleccionada. Los adjuntos enlazados no implican contenido disponible.',
  search_sources:
    'Busca términos en los mensajes y documentos guardados; devuelve fragmentos con número citation y origen.',
  read_source:
    'Lee hasta ocho fragmentos de una fuente desde offset. Usar offsets sucesivos para páginas adicionales.',
  list_events: 'Lista las fechas académicas guardadas y su estado de confirmación.',
  propose_event:
    'Propone una fecha pendiente de revisión. evidence debe ser una cita exacta del fragmento chunkId leído.',
};
export type ToolCall = (name: ToolName, args: unknown) => Promise<unknown>;
export function jsonSchema(name: ToolName): Record<string, any> {
  const schema = z.toJSONSchema(schemas[name]);
  delete schema.$schema;
  return schema;
}
