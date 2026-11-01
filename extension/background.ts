import { isTeamsUrl } from './extract';
import { syncMessage } from './sync-runtime';
const HOST = 'app.lupino.capture';
chrome.runtime.onMessage.addListener((message, sender, reply) => {
  const fromPopup =
    sender.id === chrome.runtime.id && sender.url === chrome.runtime.getURL('popup.html');
  const fromTeams =
    sender.id === chrome.runtime.id &&
    !!sender.tab &&
    isTeamsUrl(sender.url ?? '') &&
    sender.frameId === 0;
  if (!fromPopup && !fromTeams) {
    reply({ ok: false, error: 'Origen no autorizado.' });
    return false;
  }
  if (fromPopup && typeof message?.type === 'string' && message.type.startsWith('sync-')) {
    syncMessage(message)
      .then(reply)
      .catch((error) =>
        reply({ ok: false, error: error instanceof Error ? error.message : String(error) }),
      );
    return true;
  }
  if (message?.type !== 'native' || !['ping', 'capture', 'file'].includes(message.payload?.type)) {
    reply({ ok: false, error: 'Mensaje no válido.' });
    return false;
  }
  if (
    fromTeams &&
    (message.payload.type !== 'capture' || !isTeamsUrl(message.payload.capture?.pageUrl ?? ''))
  ) {
    reply({ ok: false, error: 'Captura no válida.' });
    return false;
  }
  chrome.runtime.sendNativeMessage(HOST, message.payload, (response) => {
    const error = chrome.runtime.lastError?.message;
    const result = error
      ? {
          ok: false,
          error:
            'No se pudo conectar con Lupino. Abrí la app y vinculá la extensión desde Conexiones.',
        }
      : response;
    if (result?.ok && message.payload.type === 'capture')
      chrome.storage.local.set({
        lastCapture: {
          at: new Date().toISOString(),
          count: message.payload.capture.messages.length,
          title: message.payload.capture.title,
        },
      });
    reply(result);
  });
  return true;
});
