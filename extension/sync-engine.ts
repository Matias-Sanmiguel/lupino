import {
  StaleListingError,
  MAX_FILE,
  fileUrl,
  type FolderLocation,
  type PageTask,
  type Listing,
  type RemoteEntry,
} from './sharepoint';
export interface SyncLink extends FolderLocation {
  id: string;
  subject: string;
  paused: boolean;
}
interface Cursor {
  tasks: PageTask[];
  files: RemoteEntry[];
  folders: string[];
  pages: string[];
  count: number;
  seen: string[];
}
export interface SyncState {
  status: 'idle' | 'pending' | 'running' | 'error';
  versions: Record<string, string>;
  cursor?: Cursor;
  lastAttempt?: number;
  lastCompleted?: number;
  error?: string;
  stats: { sent: number; unchanged: number; skipped: number };
  issues: string[];
}
export interface FilePayload {
  type: 'file';
  name: string;
  subject: string;
  originUrl: string;
  remote: { id: string; path: string; modifiedAt: string };
  data: string;
}
export interface SyncIO {
  listPage: (task: PageTask) => Promise<Listing>;
  download: (file: RemoteEntry) => Promise<Uint8Array>;
  send: (payload: FilePayload) => Promise<{ ok: boolean; queued?: boolean; error?: string }>;
  checkpoint: (state: SyncState) => Promise<void>;
  now: () => number;
  signal: AbortSignal;
}
export function initialState(): SyncState {
  return { status: 'idle', versions: {}, stats: { sent: 0, unchanged: 0, skipped: 0 }, issues: [] };
}
function base64(bytes: Uint8Array) {
  let text = '';
  for (let i = 0; i < bytes.length; i += 8192)
    text += String.fromCharCode(...bytes.subarray(i, i + 8192));
  return btoa(text);
}
export async function syncSlice(
  link: SyncLink,
  previous: SyncState,
  io: SyncIO,
): Promise<SyncState> {
  const state = structuredClone(previous),
    start = io.now();
  state.lastAttempt = start;
  state.error = undefined;
  state.status = 'running';
  if (!state.cursor) {
    state.cursor = {
      tasks: [
        { kind: 'files', path: link.folderPath },
        { kind: 'folders', path: link.folderPath },
      ],
      files: [],
      folders: [link.folderPath],
      pages: [],
      count: 0,
      seen: [],
    };
    state.stats = { sent: 0, unchanged: 0, skipped: 0 };
    state.issues = [];
  }
  const cursor = state.cursor;
  try {
    await io.checkpoint(state);
    while (cursor.tasks.length || cursor.files.length) {
      io.signal.throwIfAborted();
      if (io.now() - start >= 60000) {
        state.status = 'pending';
        await io.checkpoint(state);
        return state;
      }
      if (cursor.files.length) {
        const file = cursor.files[0];
        const digest = await crypto.subtle.digest(
          'SHA-256',
          new TextEncoder().encode(JSON.stringify([file.version, file.path, file.size])),
        );
        const fingerprint = Array.from(new Uint8Array(digest), (n) =>
          n.toString(16).padStart(2, '0'),
        ).join('');
        if (state.versions[file.id] === fingerprint) {
          state.stats.unchanged++;
        } else if (
          !/\.(pdf|docx|pptx|txt|md|markdown)$/i.test(file.name) ||
          file.size > MAX_FILE ||
          new TextEncoder().encode(file.name).length > 255 ||
          file.name.includes(':')
        ) {
          state.stats.skipped++;
          if (state.issues.length < 20)
            state.issues.push(
              `${file.name}: ${file.size > MAX_FILE ? 'supera 20 MB' : 'formato o nombre no compatible'}.`,
            );
        } else {
          const bytes = await io.download(file);
          io.signal.throwIfAborted();
          if (bytes.length > MAX_FILE) throw new Error('El archivo supera 20 MB.');
          const rootName = link.folderPath.split('/').pop()!;
          const path = rootName + file.path.slice(link.folderPath.length);
          const result = await io.send({
            type: 'file',
            name: file.name,
            subject: link.subject,
            originUrl: fileUrl(link, file.path),
            remote: { id: file.id, path, modifiedAt: file.modifiedAt },
            data: base64(bytes),
          });
          if (!result.ok || !result.queued)
            throw new Error(
              result.error || 'Lupino no confirmó la recepción del archivo. Abrí la app.',
            );
          state.versions[file.id] = fingerprint;
          state.stats.sent++;
        }
        cursor.files.shift();
        await io.checkpoint(state);
        continue;
      }
      const task = cursor.tasks[0],
        pageKey = JSON.stringify(task);
      if (cursor.pages.includes(pageKey))
        throw new Error('SharePoint repitió una página. No se completó la revisión.');
      const page = await io.listPage(task);
      io.signal.throwIfAborted();
      if (task.kind === 'files') {
        const files = page.entries as RemoteEntry[];
        if (cursor.count + files.length > 5000)
          throw new Error('La carpeta supera 5.000 archivos. Vinculá subcarpetas más pequeñas.');
        cursor.count += files.length;
        cursor.files.push(...files);
        cursor.seen.push(...files.map((f) => f.id));
      } else {
        for (const folder of page.entries) {
          if (cursor.folders.includes(folder.path)) continue;
          if (cursor.folders.length >= 1000)
            throw new Error(
              'La carpeta supera 1.000 subcarpetas. Vinculá una carpeta más pequeña.',
            );
          cursor.folders.push(folder.path);
          cursor.tasks.push(
            { kind: 'files', path: folder.path },
            { kind: 'folders', path: folder.path },
          );
        }
      }
      cursor.pages.push(pageKey);
      cursor.tasks.shift();
      if (page.next) cursor.tasks.unshift({ ...task, next: page.next });
      await io.checkpoint(state);
    }
    // Only prune the browser cache after a complete listing. Local documents are never removed.
    const seen = new Set(cursor.seen);
    state.versions = Object.fromEntries(
      Object.entries(state.versions).filter(([id]) => seen.has(id)),
    );
    state.cursor = undefined;
    state.status = 'idle';
    state.lastCompleted = io.now();
  } catch (error) {
    if (error instanceof StaleListingError) state.cursor = undefined;
    state.status = io.signal.aborted ? 'pending' : 'error';
    state.error = io.signal.aborted
      ? undefined
      : error instanceof Error
        ? error.message
        : String(error);
  }
  await io.checkpoint(state);
  return state;
}
