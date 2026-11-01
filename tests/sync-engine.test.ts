import { describe, it, expect } from 'vitest';
import { initialState, syncSlice, type SyncIO } from '../extension/sync-engine';
import { parseFolderUrl, type RemoteEntry } from '../extension/sharepoint';
const location = parseFolderUrl(
  'https://facu.sharepoint.com/sites/algebra/Documentos/Forms/AllItems.aspx?id=%2Fsites%2Falgebra%2FDocumentos%2FMateriales',
);
const link = { ...location, id: 'test', subject: 'Álgebra', paused: false };
const file = (name = 'guia.txt', version = '1'): RemoteEntry => ({
  id: '12345678-1234-4234-8234-123456789abc',
  name,
  path: location.folderPath + '/' + name,
  version,
  size: 10,
  modifiedAt: '2026-11-01T12:00:00Z',
});
function fixture() {
  const sent: unknown[] = [],
    downloaded: RemoteEntry[] = [],
    checkpoints: any[] = [];
  const io: SyncIO = {
    listPage: async (task) => ({ entries: task.kind === 'files' ? [file()] : [] }),
    download: async (entry) => {
      downloaded.push(entry);
      return new TextEncoder().encode('Matrices');
    },
    send: async (payload) => {
      sent.push(payload);
      return { ok: true, queued: true };
    },
    checkpoint: async (state) => {
      checkpoints.push(structuredClone(state));
    },
    now: () => 1000,
    signal: new AbortController().signal,
  };
  return { io, sent, downloaded, checkpoints };
}
describe('automatic folder sync', () => {
  it('imports nested folders and pages with provenance, skipping unchanged files on the next scan', async () => {
    const f = fixture();
    f.io.listPage = async (task) => {
      if (task.kind === 'folders')
        return {
          entries:
            task.path === location.folderPath
              ? [{ name: 'Unidad', path: location.folderPath + '/Unidad' }]
              : [],
        };
      if (task.path.endsWith('/Unidad'))
        return {
          entries: [
            {
              ...file('ejercicio.md'),
              id: '22345678-1234-4234-8234-123456789abc',
              path: task.path + '/ejercicio.md',
            },
          ],
        };
      return task.next ? { entries: [] } : { entries: [file()], next: 'page2' };
    };
    const first = await syncSlice(link, initialState(), f.io);
    expect(first.status).toBe('idle');
    expect(first.stats.sent).toBe(2);
    expect(f.sent[1]).toMatchObject({
      subject: 'Álgebra',
      remote: { path: 'Materiales/Unidad/ejercicio.md' },
      originUrl:
        'https://facu.sharepoint.com/sites/algebra/Documentos/Materiales/Unidad/ejercicio.md',
    });
    await syncSlice(link, first, f.io);
    expect(f.downloaded).toHaveLength(2);
  });
  it('resumes checkpoint after a failed receipt and updates changed versions', async () => {
    const f = fixture();
    f.io.send = async () => ({ ok: false, error: 'host desconectado' });
    const failed = await syncSlice(link, initialState(), f.io);
    expect(failed.status).toBe('error');
    expect(Object.keys(failed.versions)).toHaveLength(0);
    expect(failed.lastCompleted).toBeUndefined();
    f.io.send = async (p) => {
      f.sent.push(p);
      return { ok: true, queued: true };
    };
    const done = await syncSlice(link, failed, f.io);
    expect(done.stats.sent).toBe(1);
    f.io.listPage = async (task) => ({
      entries: task.kind === 'files' ? [file('guia.txt', '2')] : [],
    });
    await syncSlice(link, done, f.io);
    expect(f.sent).toHaveLength(2);
  });
  it('keeps traversal progress across time slices and skips unsupported/large files explicitly', async () => {
    const f = fixture();
    let clock = 0;
    f.io.now = () => clock++ * 20000;
    const partial = await syncSlice(link, initialState(), f.io);
    expect(partial.status).toBe('pending');
    expect(partial.cursor).toBeDefined();
    f.io.now = () => 0;
    const done = await syncSlice(link, partial, f.io);
    expect(done.stats.sent).toBe(1);
    f.io.listPage = async (task) => ({
      entries:
        task.kind === 'files'
          ? [file('video.mp4'), { ...file('gigante.pdf'), size: 21 * 1024 * 1024 }]
          : [],
    });
    const skipped = await syncSlice(link, done, f.io);
    expect(skipped.stats.skipped).toBe(2);
    expect(skipped.issues).toHaveLength(2);
  });
  it('does not mark incomplete/cyclic traversal complete, nor checkpoint on cancelled download', async () => {
    const f = fixture();
    f.io.listPage = async () => ({ entries: [], next: 'again' });
    const loop = await syncSlice(link, initialState(), f.io);
    expect(loop.status).toBe('error');
    expect(loop.lastCompleted).toBeUndefined();
    const cancel = fixture(),
      controller = new AbortController();
    cancel.io.signal = controller.signal;
    cancel.io.download = async () => {
      controller.abort();
      return new Uint8Array([1]);
    };
    const result = await syncSlice(link, initialState(), cancel.io);
    expect(cancel.sent).toHaveLength(0);
    expect(Object.keys(result.versions)).toHaveLength(0);
  });
  it('refuses an oversized listing without marking the scan complete', async () => {
    const f = fixture();
    f.io.listPage = async () => ({ entries: Array.from({ length: 5001 }, () => file()) });
    const result = await syncSlice(link, initialState(), f.io);
    expect(result.status).toBe('error');
    expect(result.error).toContain('5.000');
    expect(result.lastCompleted).toBeUndefined();
    expect(f.sent).toHaveLength(0);
  });
});
