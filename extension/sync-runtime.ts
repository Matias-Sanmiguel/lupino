import { SharePointClient } from './sharepoint';
import { syncSlice } from './sync-engine';
import { SyncService } from './sync-service';
const ALARM = 'lupino-folder-sync';
export const syncService = new SyncService({
  get: async (key) => (await chrome.storage.local.get(key))[key],
  set: async (key, value) => chrome.storage.local.set({ [key]: value }),
  remove: async (key) => chrome.storage.local.remove(key),
  hasPermission: (origin) => chrome.permissions.contains({ origins: [origin + '/*'] }),
  ensureAlarm: async () => {
    if (!(await chrome.alarms.get(ALARM)))
      await chrome.alarms.create(ALARM, { periodInMinutes: 1 });
  },
  now: () => Date.now(),
  run: async (link, state, signal, checkpoint) => {
    const client = new SharePointClient(link, fetch, signal);
    return syncSlice(link, state, {
      listPage: (task) => client.listPage(task),
      download: (file) => client.download(file),
      send: (payload) => chrome.runtime.sendNativeMessage('app.lupino.capture', payload),
      checkpoint,
      signal,
      now: () => Date.now(),
    });
  },
});
function report(error: unknown) {
  console.error('Lupino sync:', error instanceof Error ? error.message : String(error));
}
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === ALARM) void syncService.tick().catch(report);
});
chrome.runtime.onStartup.addListener(() => {
  void syncService.start().catch(report);
});
chrome.runtime.onInstalled.addListener(() => {
  void syncService.start().catch(report);
});
void syncService.start().catch(report);

export async function syncMessage(message: any) {
  switch (message.type) {
    case 'sync-list':
      return {
        ok: true,
        folders: (await syncService.list()).map(({ link, state }) => ({
          link,
          state: {
            status: state.status,
            lastCompleted: state.lastCompleted,
            lastAttempt: state.lastAttempt,
            error: state.error,
            stats: state.stats,
            issues: state.issues,
          },
        })),
      };
    case 'sync-link': {
      const id = await syncService.link(String(message.pageUrl), String(message.subject ?? ''));
      void syncService.run(id, true).catch(report);
      return { ok: true, id };
    }
    case 'sync-run':
      void syncService.run(String(message.id), true).catch(report);
      return { ok: true };
    case 'sync-pause':
      await syncService.pause(String(message.id), !!message.paused);
      if (!message.paused) void syncService.run(String(message.id), true).catch(report);
      return { ok: true };
    case 'sync-remove':
      await syncService.remove(String(message.id));
      return { ok: true };
    default:
      throw new Error('Acción de sincronización no reconocida.');
  }
}
