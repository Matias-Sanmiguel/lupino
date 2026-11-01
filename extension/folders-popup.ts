import { parseFolderUrl, type FolderLocation } from './sharepoint';
import type { SyncLink, SyncState } from './sync-engine';
type Summary = { link: SyncLink; state: Omit<SyncState, 'versions' | 'cursor'> };
export function setupFolderSync(subject: HTMLInputElement) {
  const button = document.querySelector<HTMLButtonElement>('#link-folder')!;
  const description = document.querySelector<HTMLElement>('#folder-location')!;
  const list = document.querySelector<HTMLElement>('#folder-list')!;
  const notice = document.querySelector<HTMLElement>('#folder-notice')!;
  let location: FolderLocation | undefined,
    last = '';
  function show(text: string, error = false) {
    notice.textContent = text;
    notice.classList.toggle('error', error);
  }
  async function message(value: unknown) {
    const result = await chrome.runtime.sendMessage(value);
    if (!result?.ok) throw new Error(result?.error || 'No se pudo actualizar la sincronización.');
    return result;
  }
  async function refresh() {
    const { folders } = (await message({ type: 'sync-list' })) as { folders: Summary[] };
    const encoded = JSON.stringify(folders);
    if (encoded === last) return;
    last = encoded;
    const focused = document.activeElement as HTMLElement | null;
    const focusKey = focused?.dataset.syncKey;
    list.replaceChildren();
    if (!folders.length) {
      const p = document.createElement('p');
      p.textContent = 'Todavía no hay carpetas vinculadas.';
      list.append(p);
      return;
    }
    for (const { link, state } of folders) {
      const row = document.createElement('article');
      row.className = 'sync-folder';
      const title = document.createElement('strong');
      title.textContent = link.subject;
      const path = document.createElement('p');
      path.className = 'folder-path';
      path.textContent = link.folderPath;
      const status = document.createElement('p');
      status.textContent = link.paused
        ? 'Pausada'
        : state.status === 'error'
          ? state.error || 'No se completó la revisión.'
          : state.status === 'running'
            ? 'Revisando archivos…'
            : state.status === 'pending'
              ? 'Continuará automáticamente en un minuto.'
              : state.lastCompleted
                ? `Última revisión: ${new Date(state.lastCompleted).toLocaleString()}`
                : 'Esperando la primera revisión.';
      if (state.status === 'error') status.className = 'error';
      const stats = document.createElement('p');
      stats.textContent = `${state.stats.sent} enviados · ${state.stats.unchanged} sin cambios · ${state.stats.skipped} omitidos`;
      row.append(title, path, status, stats);
      if (state.issues.length) {
        const details = document.createElement('details'),
          summary = document.createElement('summary'),
          items = document.createElement('p');
        summary.textContent = 'Ver archivos omitidos';
        items.textContent = state.issues.join('\n');
        details.append(summary, items);
        row.append(details);
      }
      const controls = document.createElement('div');
      controls.className = 'sync-actions';
      const action = (
        label: string,
        name: string,
        handler: () => Promise<unknown>,
        disabled = false,
      ) => {
        const b = document.createElement('button');
        b.textContent = label;
        b.disabled = disabled;
        b.dataset.syncKey = link.id + ':' + name;
        b.onclick = async () => {
          b.disabled = true;
          try {
            await handler();
            await refresh();
          } catch (e) {
            show(e instanceof Error ? e.message : String(e), true);
          } finally {
            b.disabled = disabled;
          }
        };
        controls.append(b);
      };
      action(
        'Revisar ahora',
        'run',
        () => message({ type: 'sync-run', id: link.id }),
        link.paused || state.status === 'running',
      );
      action(link.paused ? 'Reanudar' : 'Pausar', 'pause', () =>
        message({ type: 'sync-pause', id: link.id, paused: !link.paused }),
      );
      action('Abrir carpeta', 'open', () => chrome.tabs.create({ url: link.pageUrl }));
      action('Desvincular', 'remove', () => message({ type: 'sync-remove', id: link.id }));
      row.append(controls);
      list.append(row);
    }
    if (focusKey) {
      const next = [...list.querySelectorAll<HTMLElement>('[data-sync-key]')].find(
        (e) => e.dataset.syncKey === focusKey,
      );
      next?.focus();
    }
  }
  button.onclick = async () => {
    if (!location) return;
    if (!subject.value.trim()) {
      show('Escribí la materia antes de vincular esta carpeta.', true);
      subject.focus();
      return;
    }
    button.disabled = true;
    try {
      // Must happen directly in the click gesture: ask for this tenant, never all SharePoint sites.
      const granted = await chrome.permissions.request({ origins: [location.origin + '/*'] });
      if (!granted) throw new Error('No se concedió el permiso. La carpeta no quedó vinculada.');
      await chrome.storage.local.set({ subject: subject.value });
      await message({ type: 'sync-link', pageUrl: location.pageUrl, subject: subject.value });
      show('Carpeta vinculada. La primera revisión empezó; después se revisa cada 15 minutos.');
      await refresh();
    } catch (e) {
      show(e instanceof Error ? e.message : String(e), true);
    } finally {
      button.disabled = false;
    }
  };
  void chrome.tabs.query({ active: true, currentWindow: true }).then(([tab]) => {
    try {
      location = parseFolderUrl(tab?.url || '');
      description.textContent = location.folderPath;
      button.disabled = false;
    } catch {
      description.textContent =
        'Una sola vez: en Teams, abrí Materiales de clase → Abrir en SharePoint. Desde esa carpeta, abrí esta extensión y vinculá la materia.';
    }
  });
  void refresh().catch((e) => show(String(e), true));
  const timer = setInterval(() => {
    void refresh().catch((e) => show(String(e), true));
  }, 2500);
  window.addEventListener('pagehide', () => clearInterval(timer), { once: true });
}
