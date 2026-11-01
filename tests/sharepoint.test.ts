import { describe, it, expect } from 'vitest';
import { parseFolderUrl, resourceUrl, SharePointClient } from '../extension/sharepoint';
const page =
  'https://facu.sharepoint.com/sites/algebra/Documentos/Forms/AllItems.aspx?id=%2Fsites%2Falgebra%2FDocumentos%2FMateriales%20de%20clase';
describe('SharePoint scope and transport', () => {
  it('can request files from a library at the tenant root', async () => {
    const location = parseFolderUrl(
      'https://facu.sharepoint.com/Shared%20Documents/Forms/AllItems.aspx',
    );
    let calls = 0;
    const client = new SharePointClient(location, async () => {
      calls++;
      return new Response('{"value":[]}', { headers: { 'content-type': 'application/json' } });
    });
    await client.listPage({ kind: 'files', path: location.folderPath });
    expect(calls).toBe(1);
  });
  it('invokes browser fetch with its WindowOrWorkerGlobalScope receiver', async () => {
    const browserFetch: typeof fetch = async function (this: unknown) {
      if (this !== globalThis) throw new TypeError('Illegal invocation');
      return new Response('{"value":[]}', { headers: { 'content-type': 'application/json' } });
    };
    const location = parseFolderUrl(page);
    await expect(
      new SharePointClient(location, browserFetch).listPage({
        kind: 'files',
        path: location.folderPath,
      }),
    ).resolves.toEqual({ entries: [], next: undefined });
  });
  it('reads selected folders, library roots and nested site libraries without double decoding', () => {
    expect(parseFolderUrl(page)).toMatchObject({
      origin: 'https://facu.sharepoint.com',
      webUrl: 'https://facu.sharepoint.com/sites/algebra',
      folderPath: '/sites/algebra/Documentos/Materiales de clase',
    });
    expect(parseFolderUrl(page.split('?')[0]).folderPath).toBe('/sites/algebra/Documentos');
    expect(
      parseFolderUrl(page.replace('/Documentos/Forms', '/subsitio/Documentos/Forms').split('?')[0])
        .webUrl,
    ).toBe('https://facu.sharepoint.com/sites/algebra/subsitio');
    expect(
      parseFolderUrl(
        page.replace('Materiales%20de%20clase', '100%2525%20%23%20O%27Brien'),
      ).folderPath.endsWith("100%25 # O'Brien"),
    ).toBe(true);
    for (const url of [
      page.replace('.com/', '.com.evil.test/'),
      page.replace('https:', 'http:'),
      page + '&RootFolder=%2Fevil',
      page.replace('%2FDocumentos%2FMateriales', '%2FOtro%2FMateriales'),
    ])
      expect(() => parseFolderUrl(url)).toThrow();
  });
  it('uses ResourcePath OData literals for percent, hash and apostrophes', () => {
    const loc = parseFolderUrl(page),
      path = loc.folderPath + "/100% # O'Brien.pdf";
    const url = new URL(resourceUrl(loc, 'file', path));
    expect(url.hash).toBe('');
    expect(decodeURIComponent(url.pathname)).toContain(
      "decodedurl='/sites/algebra/Documentos/Materiales de clase/100% # O''Brien.pdf'",
    );
    expect(url.pathname.endsWith('/$value')).toBe(true);
  });
  it('reads paginated metadata and downloads with browser credentials', async () => {
    const loc = parseFolderUrl(page),
      calls: RequestInit[] = [];
    const client = new SharePointClient(loc, async (_url, init) => {
      calls.push(init!);
      return new Response(
        JSON.stringify({
          value: [],
          '@odata.nextLink': resourceUrl(loc, 'files', loc.folderPath) + '&$skiptoken=2',
        }),
        { headers: { 'content-type': 'application/json' } },
      );
    });
    const result = await client.listPage({ kind: 'files', path: loc.folderPath });
    expect(result.next).toContain('$skiptoken=2');
    expect(calls[0]).toMatchObject({ method: 'GET', credentials: 'include', redirect: 'error' });
  });
  it('rejects unauthorized/HTML responses, pagination escapes and oversized streams', async () => {
    const loc = parseFolderUrl(page),
      task = { kind: 'files' as const, path: loc.folderPath };
    for (const response of [
      new Response('login', { status: 401 }),
      new Response('<html>login</html>', { headers: { 'content-type': 'text/html' } }),
      new Response(JSON.stringify({ value: [], '@odata.nextLink': 'https://evil.test/steal' }), {
        headers: { 'content-type': 'application/json' },
      }),
    ]) {
      await expect(
        new SharePointClient(loc, async () => response).listPage(task),
      ).rejects.toThrow();
    }
    const client = new SharePointClient(
      loc,
      async () =>
        new Response('x'.repeat(2 * 1024 * 1024 + 1), {
          headers: { 'content-type': 'application/json' },
        }),
    );
    await expect(client.listPage(task)).rejects.toThrow(/límite/);
    await expect(client.listPage({ ...task, next: 'https://evil.test/' })).rejects.toThrow(
      /alcance|sitio/,
    );
  });
});
