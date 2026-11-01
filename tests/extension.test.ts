import { describe, it, expect } from 'vitest';
import { JSDOM } from 'jsdom';
import { extractTeams, isTeamsUrl } from '../extension/extract';

describe('Teams capture', () => {
  it('requires a stable identity for automatic captures and keeps selection explicit', () => {
    const dom = new JSDOM(
      '<div data-tid="chat-pane-message"><div data-tid="message-body">Parcial el viernes</div></div>',
    );
    expect(() =>
      extractTeams(dom.window.document, 'https://teams.microsoft.com/v2/', 'Álgebra'),
    ).toThrow(/identificar|selección/);
  });
  it('captures messages with provenance and deduplicates nested message containers', () => {
    const dom = new JSDOM(
      `<main><h1>Álgebra</h1><div data-message-id="m1"><span data-tid="message-author-name">Profesora</span><time datetime="2026-11-01T10:00:00Z"></time><div data-tid="message-body">El parcial es el 12/11/2026.<a href="https://facu.sharepoint.com/guia.pdf">Guía</a></div></div></main>`,
    );
    const result = extractTeams(dom.window.document, 'https://teams.microsoft.com/v2/', 'Álgebra');
    expect(result.messages).toHaveLength(1);
    expect(result.messages[0].author).toBe('Profesora');
    expect(result.messages[0].attachments[0].name).toBe('Guía');
    expect(result.coverage).toBe('visible');
  });
  it('rejects host lookalikes and preserves unsupported layout as empty', () => {
    expect(isTeamsUrl('https://teams.microsoft.com.evil.test/')).toBe(false);
    expect(isTeamsUrl('https://teams.cloud.microsoft/')).toBe(true);
    expect(
      extractTeams(
        new JSDOM('<main>No messages</main>').window.document,
        'https://teams.microsoft.com/',
        '',
      ).messages,
    ).toEqual([]);
  });
});
