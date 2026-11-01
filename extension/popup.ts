import { isTeamsUrl } from './extract';
import { setupFolderSync } from './folders-popup';
const subject = document.querySelector<HTMLInputElement>('#subject')!;
setupFolderSync(subject);
const status = document.querySelector<HTMLParagraphElement>('#status')!;
const observe = document.querySelector<HTMLButtonElement>('#observe')!;
let observing = false;
function show(message: string, error = false) {
  status.textContent = message;
  status.classList.toggle('error', error);
}
async function getTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id || !isTeamsUrl(tab.url ?? ''))
    throw new Error('Abrí Teams en teams.microsoft.com o teams.cloud.microsoft.');
  return tab;
}
async function action(action: string) {
  const buttons = [...document.querySelectorAll('button')];
  buttons.forEach((b) => (b.disabled = true));
  try {
    const tab = await getTab();
    await chrome.storage.local.set({ subject: subject.value });
    await chrome.scripting.executeScript({ target: { tabId: tab.id! }, files: ['content.js'] });
    const result = await chrome.tabs.sendMessage(tab.id!, {
      type: 'lupino',
      action,
      subject: subject.value,
    });
    if (!result?.ok) throw new Error(result?.error || 'La captura no se completó.');
    observing = result.observing;
    observe.textContent = observing ? 'Detener captura del canal' : 'Seguir capturando este canal';
    show(
      action === 'stop'
        ? 'Captura detenida.'
        : `${result.count} mensajes enviados a Lupino.${observing ? ' Se guardarán los nuevos mensajes que cargues en este canal.' : ''}`,
    );
  } catch (e) {
    show(e instanceof Error ? e.message : String(e), true);
  } finally {
    buttons.forEach((b) => (b.disabled = false));
  }
}
document.querySelector('#capture')!.addEventListener('click', () => action('capture'));
document.querySelector('#selection')!.addEventListener('click', () => action('selection'));
observe.addEventListener('click', () => action(observing ? 'stop' : 'observe'));
document.querySelector<HTMLInputElement>('#file')!.addEventListener('change', async (e) => {
  const input = e.currentTarget as HTMLInputElement;
  const file = input.files?.[0];
  if (!file) return;
  try {
    if (file.size > 20 * 1024 * 1024) throw new Error('El límite por archivo es 20 MB.');
    show('Enviando archivo…');
    const bytes = new Uint8Array(await file.arrayBuffer());
    let binary = '';
    for (let i = 0; i < bytes.length; i += 8192)
      binary += String.fromCharCode(...bytes.subarray(i, i + 8192));
    const result = await chrome.runtime.sendMessage({
      type: 'native',
      payload: { type: 'file', name: file.name, data: btoa(binary), subject: subject.value },
    });
    if (!result?.ok) throw new Error(result?.error || 'No se pudo enviar el archivo.');
    show('Archivo enviado. Lupino lo va a indexar al abrir la app.');
  } catch (e) {
    show(e instanceof Error ? e.message : String(e), true);
  } finally {
    input.value = '';
  }
});
(async () => {
  const saved = await chrome.storage.local.get(['subject', 'lastCapture', 'observationError']);
  subject.value = saved.subject ?? '';
  try {
    const result = await chrome.runtime.sendMessage({ type: 'native', payload: { type: 'ping' } });
    show(
      result?.ok ? 'Conectado con Lupino.' : result?.error || 'Abrí Lupino y vinculá la extensión.',
      !result?.ok,
    );
  } catch {
    show('Abrí Lupino y vinculá la extensión desde Conexiones.', true);
  }
  try {
    const tab = await getTab();
    const state = await chrome.tabs.sendMessage(tab.id!, { type: 'lupino', action: 'status' });
    observing = !!state.observing;
    if (observing) observe.textContent = 'Detener captura del canal';
  } catch {
    /* Content script has not been injected in this tab. */
  }
  if (saved.observationError) {
    show(saved.observationError, true);
    await chrome.storage.local.remove('observationError');
  }
})();
