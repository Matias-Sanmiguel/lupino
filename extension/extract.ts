export type CapturedMessage = {
  id: string;
  text: string;
  author?: string;
  sentAt?: string;
  url?: string;
  attachments: { name: string; url: string }[];
};
export type Capture = {
  version: number;
  pageUrl: string;
  subject: string;
  title: string;
  capturedAt: string;
  coverage: string;
  messages: CapturedMessage[];
};
export function isTeamsUrl(value: string): boolean {
  try {
    const u = new URL(value);
    return (
      u.protocol === 'https:' &&
      !u.username &&
      !u.password &&
      ['teams.microsoft.com', 'teams.cloud.microsoft'].includes(u.hostname)
    );
  } catch {
    return false;
  }
}
function hash(value: string): string {
  let h = 2166136261;
  for (const c of value) h = Math.imul(h ^ c.charCodeAt(0), 16777619);
  return (h >>> 0).toString(16);
}
function text(el: Element | null) {
  return (el ? ((el as HTMLElement).innerText ?? el.textContent ?? '') : '').trim();
}
export function channelTitle(doc: Document): string {
  return (
    text(
      doc.querySelector(
        '[data-tid="channel-title"], [data-tid="chat-header-title"], main h1, [role="main"] h1',
      ),
    ) ||
    doc.title.replace(/\s*\|\s*Microsoft Teams.*$/, '') ||
    'Teams'
  );
}
export function extractTeams(
  doc: Document,
  url: string,
  subject: string,
  selection = false,
): Capture {
  if (!isTeamsUrl(url)) throw new Error('Abrí Teams web para capturar mensajes.');
  const result: Capture = {
    version: 1,
    pageUrl: url,
    subject: subject.trim() || 'Sin materia',
    title: channelTitle(doc),
    capturedAt: new Date().toISOString(),
    coverage: selection ? 'selection' : 'visible',
    messages: [],
  };
  if (selection) {
    const selected = doc.getSelection()?.toString().trim();
    if (!selected) throw new Error('Seleccioná primero el texto que querés guardar en Teams.');
    result.messages.push({
      id: `selection-${hash(url + selected)}`,
      text: selected,
      attachments: [],
    });
    return result;
  }
  const nodes = [
    ...doc.querySelectorAll(
      '[data-message-id], [data-tid="chat-pane-message"], [data-tid="channel-post"], [data-item-type="message"], [id^="message-"]',
    ),
  ];
  const roots = nodes.filter(
    (n) =>
      !nodes.some((p) => p !== n && p.contains(n)) && !n.closest('[hidden], [aria-hidden="true"]'),
  );
  const seen = new Set<string>();
  for (const node of roots) {
    const body = node.querySelector(
      '[data-tid="message-body"], [data-tid="chat-message-content"], .message-body, [data-tid="post-message-text"]',
    );
    if (!body) continue;
    const content = text(body);
    if (!content) continue;
    const author =
      text(
        node.querySelector(
          '[data-tid="message-author-name"], [data-tid="message-author"], .message-author',
        ),
      ) || undefined;
    const sentAt = node.querySelector('time[datetime]')?.getAttribute('datetime') || undefined;
    const permalink = [...node.querySelectorAll<HTMLAnchorElement>('a[href]')].find(
      (a) => isTeamsUrl(a.href) && /\/l\/message\/[^/]+\/[^/?]+/.test(a.href),
    )?.href;
    const identity = permalink
      ? new URL(permalink).pathname.match(/\/l\/message\/([^/]+)\/([^/?]+)/)
      : null;
    const id =
      node.getAttribute('data-message-id') ||
      node.id ||
      (identity ? `permalink:${identity[1]}:${identity[2]}` : '');
    if (!id)
      throw new Error(
        'No pude identificar un mensaje de forma estable. Usá Guardar selección para conservarlo como una captura manual.',
      );
    if (seen.has(id)) continue;
    seen.add(id);
    const attachments = [...node.querySelectorAll<HTMLAnchorElement>('a[href]')]
      .flatMap((a) => {
        try {
          const link = new URL(a.getAttribute('href')!, url);
          if (link.protocol !== 'https:' || link.username || link.password) return [];
          if (isTeamsUrl(link.href)) return [];
          return [
            {
              name: text(a) || link.pathname.split('/').at(-1) || 'Archivo enlazado',
              url: link.href,
            },
          ];
        } catch {
          return [];
        }
      })
      .slice(0, 50);
    result.messages.push({ id, text: content, author, sentAt, url: permalink, attachments });
  }
  if (result.messages.length > 1000 || JSON.stringify(result).length > 2_000_000)
    throw new Error('Hay demasiado texto. Seleccioná una parte más pequeña.');
  return result;
}
