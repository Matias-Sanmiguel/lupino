import { channelTitle, extractTeams } from './extract';
const win = window as Window & { __lupinoCapture?: boolean };
if (!win.__lupinoCapture) {
  win.__lupinoCapture = true;
  let observer: MutationObserver | null = null;
  let timer: ReturnType<typeof setTimeout>;
  let busy = false;
  let lastPayload = '';
  let scope = '';
  let subject = '';
  const stop = () => {
    observer?.disconnect();
    observer = null;
    clearTimeout(timer);
  };
  const capture = async (selected = false) => {
    const data = extractTeams(document, location.href, subject, selected);
    if (!data.messages.length)
      throw new Error(
        'No reconocí mensajes en esta vista. Probá seleccionar el texto y usar «Guardar selección».',
      );
    const signature = JSON.stringify(data.messages);
    if (observer && signature === lastPayload) return { ok: true, count: 0 };
    if (observer) data.coverage = 'observed';
    const response = await chrome.runtime.sendMessage({
      type: 'native',
      payload: { type: 'capture', capture: data },
    });
    if (!response?.ok) throw new Error(response?.error || 'No se pudo guardar la captura.');
    lastPayload = signature;
    return { ok: true, count: data.messages.length };
  };
  chrome.runtime.onMessage.addListener((msg, _sender, reply) => {
    if (msg.type !== 'lupino') return false;
    if (msg.action === 'status') {
      reply({ ok: true, observing: !!observer });
      return false;
    }
    if (msg.action === 'stop') {
      stop();
      reply({ ok: true, observing: false });
      return false;
    }
    subject = String(msg.subject ?? '').slice(0, 256);
    capture(msg.action === 'selection')
      .then((result) => {
        if (msg.action === 'observe') {
          stop();
          scope = location.href + channelTitle(document);
          observer = new MutationObserver(() => {
            clearTimeout(timer);
            timer = setTimeout(async () => {
              if (scope !== location.href + channelTitle(document)) {
                stop();
                chrome.storage.local.set({
                  observationError:
                    'Cambiaste de canal. Volvé a activar la captura para la nueva materia.',
                });
                return;
              }
              if (busy) return;
              busy = true;
              try {
                await capture();
              } catch (e) {
                stop();
                chrome.storage.local.set({ observationError: String(e) });
              } finally {
                busy = false;
              }
            }, 1500);
          });
          observer.observe(document.body, { subtree: true, childList: true, characterData: true });
        }
        reply({ ...result, observing: !!observer });
      })
      .catch((e) => reply({ ok: false, error: e instanceof Error ? e.message : String(e) }));
    return true;
  });
}
