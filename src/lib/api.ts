import { invoke } from '@tauri-apps/api/core';
import { openUrl } from '@tauri-apps/plugin-opener';
import type { Snapshot } from './types';
export const isDesktop = '__TAURI_INTERNALS__' in window;
export async function command<T>(name: string, args: Record<string, unknown> = {}): Promise<T> {
  if (!isDesktop) {
    if (name === 'snapshot')
      return { sources: [], events: [], conversations: [], inboxErrors: [] } as Snapshot as T;
    if (name === 'providers_status') return [] as T;
    throw new Error('Abrí Lupino en el escritorio para usar esta función.');
  }
  return invoke<T>(name, args);
}
export async function openExternal(url: string) {
  if (!/^https:\/\//i.test(url)) throw new Error('El enlace debe usar HTTPS.');
  if (isDesktop) await openUrl(url);
  else window.open(url, '_blank', 'noopener,noreferrer');
}
export function dateLabel(date: string) {
  return new Date(date.length === 10 ? `${date}T12:00:00` : date).toLocaleDateString('es-AR', {
    day: 'numeric',
    month: 'short',
  });
}
export function errorText(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}
