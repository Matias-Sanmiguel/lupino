import { describe, it, expect } from 'vitest';
import { SyncService, type SyncPlatform } from '../extension/sync-service';
import { initialState, syncSlice } from '../extension/sync-engine';
import { StaleListingError } from '../extension/sharepoint';
const url =
  'https://facu.sharepoint.com/sites/algebra/Documentos/Forms/AllItems.aspx?id=%2Fsites%2Falgebra%2FDocumentos%2FMateriales';
function fixture() {
  const values: Record<string, any> = {};
  let runs = 0,
    alarms = 0,
    permission = true;
  const platform: SyncPlatform = {
    get: async (key) => structuredClone(values[key]),
    set: async (key, value) => {
      values[key] = structuredClone(value);
    },
    remove: async (key) => {
      delete values[key];
    },
    hasPermission: async () => permission,
    ensureAlarm: async () => {
      alarms++;
    },
    now: () => 10000000,
    run: async (_link, state, _signal, save) => {
      runs++;
      const result = {
        ...state,
        status: 'idle' as const,
        lastCompleted: 10000000,
        lastAttempt: 10000000,
      };
      await save(result);
      return result;
    },
  };
  return {
    values,
    platform,
    get runs() {
      return runs;
    },
    get alarms() {
      return alarms;
    },
    deny() {
      permission = false;
    },
  };
}
describe('sync scheduling', () => {
  it('automatically relists after a file disappears before its download', async () => {
    const f = fixture(),
      service = new SyncService(f.platform),
      id = await service.link(url, 'Álgebra');
    let gone = false,
      listings = 0,
      sent = 0;
    f.platform.run = (link, state, signal, checkpoint) =>
      syncSlice(link, state, {
        signal,
        checkpoint,
        now: () => f.platform.now(),
        listPage: async (task) => {
          if (task.kind === 'folders') return { entries: [] };
          listings++;
          return {
            entries: [
              {
                id: '12345678-1234-4234-8234-123456789abc',
                path: link.folderPath + (gone ? '/new.txt' : '/old.txt'),
                name: gone ? 'new.txt' : 'old.txt',
                version: '1',
                modifiedAt: '2026-11-01T12:00:00Z',
                size: 4,
              },
            ],
          };
        },
        download: async (file) => {
          if (file.name === 'old.txt') {
            gone = true;
            throw new StaleListingError();
          }
          return new Uint8Array([1]);
        },
        send: async () => {
          sent++;
          return { ok: true, queued: true };
        },
      });
    await service.run(id);
    expect((await service.list())[0].state.status).toBe('error');
    f.platform.now = () => 10000000 + 15 * 60000;
    await service.tick();
    expect(listings).toBe(2);
    expect(sent).toBe(1);
    expect((await service.list())[0].state.status).toBe('idle');
  });
  it('restores the alarm and syncs a newly linked folder once, then waits 15 minutes', async () => {
    const f = fixture(),
      service = new SyncService(f.platform);
    await service.start();
    expect(f.alarms).toBe(1);
    const id = await service.link(url, 'Álgebra');
    await service.run(id);
    expect(f.runs).toBe(1);
    await service.tick();
    expect(f.runs).toBe(1);
    expect((await service.list())[0].state.lastCompleted).toBe(10000000);
    f.platform.now = () => 10000000 + 15 * 60000;
    await service.tick();
    expect(f.runs).toBe(2);
  });
  it('refuses a link without site permission and deduplicates same folder and subject', async () => {
    const f = fixture(),
      service = new SyncService(f.platform);
    f.deny();
    await expect(service.link(url, 'Álgebra')).rejects.toThrow(/permiso/);
    f.platform.hasPermission = async () => true;
    const first = await service.link(url, 'Álgebra');
    expect(await service.link(url, 'Álgebra')).toBe(first);
    expect(await service.list()).toHaveLength(1);
  });
  it('prevents duplicate workers and pauses/removes without resurrecting progress', async () => {
    const f = fixture(),
      service = new SyncService(f.platform),
      id = await service.link(url, 'Álgebra');
    let starts = 0;
    f.platform.run = async (_link, state, signal, save) => {
      starts++;
      await new Promise<void>((resolve) =>
        signal.addEventListener('abort', () => resolve(), { once: true }),
      );
      const result = { ...state, status: 'pending' as const };
      await save(result);
      return result;
    };
    const a = service.run(id),
      b = service.run(id);
    await new Promise((r) => setTimeout(r, 10));
    expect(starts).toBe(1);
    await service.pause(id, true);
    await Promise.all([a, b]);
    await service.tick();
    expect(starts).toBe(1);
    await service.remove(id);
    expect(await service.list()).toHaveLength(0);
    expect(f.values['sync-state:' + id]).toBeUndefined();
  });
  it('resumes interrupted work after service-worker restart and reports revoked permission', async () => {
    const f = fixture(),
      first = new SyncService(f.platform),
      id = await first.link(url, 'Álgebra');
    f.values['sync-state:' + id] = { ...initialState(), status: 'running', lastAttempt: 10000000 };
    await new SyncService(f.platform).start();
    expect(f.runs).toBe(1);
    f.deny();
    await first.run(id, true);
    expect((await first.list())[0].state.error).toMatch(/permiso/);
  });
});
