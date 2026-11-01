import { parseFolderUrl } from './sharepoint';
import { initialState, type SyncLink, type SyncState } from './sync-engine';
export interface SyncPlatform {
  get: (key: string) => Promise<any>;
  set: (key: string, value: unknown) => Promise<void>;
  remove: (key: string) => Promise<void>;
  hasPermission: (origin: string) => Promise<boolean>;
  ensureAlarm: () => Promise<void>;
  now: () => number;
  run: (
    link: SyncLink,
    state: SyncState,
    signal: AbortSignal,
    save: (state: SyncState) => Promise<void>,
  ) => Promise<SyncState>;
}
export class SyncService {
  private jobs = new Map<string, { controller: AbortController; promise: Promise<void> }>();
  private changes: Promise<unknown> = Promise.resolve();
  constructor(private platform: SyncPlatform) {}
  private async links(): Promise<SyncLink[]> {
    return (await this.platform.get('sync-links')) || [];
  }
  private change<T>(operation: () => Promise<T>): Promise<T> {
    const next = this.changes.then(operation, operation);
    this.changes = next.catch(() => {});
    return next;
  }
  async list() {
    return Promise.all(
      (await this.links()).map(async (link) => ({
        link,
        state: (await this.platform.get('sync-state:' + link.id)) || initialState(),
      })),
    );
  }
  async start() {
    await this.platform.ensureAlarm();
    await this.tick();
  }
  async tick() {
    for (const link of await this.links()) await this.run(link.id);
  }
  async link(pageUrl: string, subject: string) {
    const location = parseFolderUrl(pageUrl);
    subject = subject.trim();
    if (!subject || new TextEncoder().encode(subject).length > 256)
      throw new Error('Completá una materia de hasta 256 bytes.');
    if (!(await this.platform.hasPermission(location.origin)))
      throw new Error('Falta el permiso para este sitio de SharePoint.');
    return this.change(async () => {
      const links = await this.links(),
        existing = links.find(
          (l) =>
            l.origin === location.origin &&
            l.folderPath === location.folderPath &&
            l.subject === subject,
        );
      if (existing) return existing.id;
      if (links.length >= 10)
        throw new Error('Podés vincular hasta 10 carpetas. Cada una incluye sus subcarpetas.');
      const id = crypto.randomUUID();
      links.push({ ...location, id, subject, paused: false });
      await this.platform.set('sync-links', links);
      return id;
    });
  }
  async pause(id: string, paused: boolean) {
    await this.change(async () => {
      const links = await this.links(),
        link = links.find((l) => l.id === id);
      if (!link) throw new Error('La carpeta ya no está vinculada.');
      link.paused = paused;
      await this.platform.set('sync-links', links);
    });
    if (paused) {
      const job = this.jobs.get(id);
      job?.controller.abort();
      await job?.promise;
    }
  }
  async remove(id: string) {
    await this.change(async () => {
      await this.platform.set(
        'sync-links',
        (await this.links()).filter((l) => l.id !== id),
      );
    });
    const job = this.jobs.get(id);
    job?.controller.abort();
    await job?.promise;
    await this.platform.remove('sync-state:' + id);
  }
  run(id: string, force = false): Promise<void> {
    const active = this.jobs.get(id);
    if (active) return active.promise;
    const controller = new AbortController();
    const job = { controller, promise: Promise.resolve() };
    this.jobs.set(id, job);
    job.promise = Promise.resolve()
      .then(async () => {
        const link = (await this.links()).find((l) => l.id === id);
        if (!link || link.paused) return;
        let state: SyncState = (await this.platform.get('sync-state:' + id)) || initialState();
        const now = this.platform.now();
        if (
          !force &&
          !['pending', 'running'].includes(state.status) &&
          state.lastAttempt !== undefined &&
          now - state.lastAttempt < 15 * 60000
        )
          return;
        if (force && state.status === 'error') state = { ...state, cursor: undefined };
        const save = async (value: SyncState) => {
          await this.platform.set('sync-state:' + id, value);
        };
        try {
          if (!(await this.platform.hasPermission(link.origin)))
            throw new Error(
              'Falta el permiso de SharePoint. Volvé a vincular la carpeta para concederlo.',
            );
          controller.signal.throwIfAborted();
          await this.platform.run(link, state, controller.signal, save);
        } catch (error) {
          state = (await this.platform.get('sync-state:' + id)) || state;
          await save({
            ...state,
            status: controller.signal.aborted ? 'pending' : 'error',
            lastAttempt: now,
            error: controller.signal.aborted
              ? undefined
              : error instanceof Error
                ? error.message
                : String(error),
          });
        }
      })
      .finally(() => {
        if (this.jobs.get(id) === job) this.jobs.delete(id);
      });
    return job.promise;
  }
}
