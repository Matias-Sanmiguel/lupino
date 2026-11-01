export const MAX_FILE = 20 * 1024 * 1024;
export interface FolderLocation {
  origin: string;
  webUrl: string;
  folderPath: string;
  pageUrl: string;
}
export interface FolderEntry {
  name: string;
  path: string;
}
export interface RemoteEntry extends FolderEntry {
  id: string;
  version: string;
  size: number;
  modifiedAt: string;
}
export class StaleListingError extends Error {
  constructor() {
    super('Un archivo o carpeta cambió de ubicación. Se volverá a recorrer automáticamente.');
  }
}
export interface PageTask {
  kind: 'files' | 'folders';
  path: string;
  next?: string;
}
export interface Listing {
  entries: (FolderEntry | RemoteEntry)[];
  next?: string;
}
export function isSharePoint(url: URL) {
  return (
    url.protocol === 'https:' &&
    /^[a-z0-9-]+\.sharepoint\.com$/i.test(url.hostname) &&
    !url.username &&
    !url.password &&
    !url.port
  );
}
function validPath(path: string) {
  return (
    path.startsWith('/') &&
    !path.includes('\\') &&
    !/[\x00-\x1f]/.test(path) &&
    path.length <= 4096 &&
    !path
      .slice(1)
      .split('/')
      .some((p) => !p || p === '.' || p === '..')
  );
}
export function inFolder(path: string, root: string) {
  return validPath(path) && (path === root || path.startsWith(root + '/'));
}
export function parseFolderUrl(input: string): FolderLocation {
  const url = new URL(input);
  if (!isSharePoint(url)) throw new Error('Abrí la carpeta con «Abrir en SharePoint» desde Teams.');
  const pathname = decodeURIComponent(url.pathname),
    form = pathname.toLowerCase().indexOf('/forms/');
  if (form < 1 || !/\/forms\/[^/]+\.aspx$/i.test(pathname))
    throw new Error(
      'Abrí la lista de archivos de la carpeta en SharePoint; no la vista previa de un documento.',
    );
  const library = pathname.slice(0, form),
    webPath = library.slice(0, library.lastIndexOf('/'));
  const id = url.searchParams.get('id'),
    root = url.searchParams.get('RootFolder');
  if (id && root && id !== root) throw new Error('La dirección contiene dos carpetas diferentes.');
  const folderPath = id || root || library;
  if (!inFolder(folderPath, library))
    throw new Error('La carpeta está fuera del alcance de esta biblioteca.');
  const canonical = new URL(url.origin + url.pathname);
  canonical.searchParams.set('id', folderPath);
  return { origin: url.origin, webUrl: url.origin + webPath, folderPath, pageUrl: canonical.href };
}
export function resourceUrl(
  location: FolderLocation,
  kind: 'file' | 'files' | 'folders',
  path: string,
) {
  if (!inFolder(path, location.folderPath))
    throw new Error('Ruta fuera del alcance de la carpeta.');
  const literal = encodeURIComponent(path.replaceAll("'", "''")).replaceAll("'", '%27');
  const resource =
    kind === 'file' ? 'GetFileByServerRelativePath' : 'GetFolderByServerRelativePath';
  const suffix = kind === 'file' ? '$value' : kind === 'files' ? 'Files' : 'Folders';
  const select =
    kind === 'files'
      ? 'Name,ServerRelativeUrl,UniqueId,TimeLastModified,Length,ETag'
      : 'Name,ServerRelativeUrl';
  return `${location.webUrl}/_api/web/${resource}(decodedurl='${literal}')/${suffix}${kind === 'file' ? '' : `?$select=${select}&$top=200`}`;
}
export function fileUrl(location: FolderLocation, path: string) {
  if (!inFolder(path, location.folderPath)) throw new Error('Archivo fuera de la carpeta.');
  return (
    location.origin +
    path
      .split('/')
      .map((p) => encodeURIComponent(p))
      .join('/')
  );
}
async function boundedBody(response: Response, limit: number, signal: AbortSignal) {
  if (Number(response.headers.get('content-length')) > limit)
    throw new Error('La respuesta supera el límite de tamaño.');
  const reader = response.body?.getReader();
  if (!reader) throw new Error('SharePoint devolvió una respuesta vacía.');
  const parts: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      signal.throwIfAborted();
      const { done, value } = await reader.read();
      if (done) break;
      size += value.length;
      if (size > limit) throw new Error('La respuesta supera el límite de tamaño.');
      parts.push(value);
    }
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
  const all = new Uint8Array(size);
  let offset = 0;
  for (const p of parts) {
    all.set(p, offset);
    offset += p.length;
  }
  return all;
}
export class SharePointClient {
  constructor(
    readonly location: FolderLocation,
    private fetcher: typeof fetch = fetch,
    private signal: AbortSignal = new AbortController().signal,
  ) {}
  private async request(url: string, limit: number, json: boolean) {
    const target = new URL(url);
    if (
      target.origin !== this.location.origin ||
      target.username ||
      target.password ||
      !target.pathname.startsWith(
        new URL(this.location.webUrl).pathname.replace(/\/$/, '') + '/_api/web/',
      )
    )
      throw new Error('Enlace fuera del sitio autorizado.');
    const signal = AbortSignal.any([this.signal, AbortSignal.timeout(25000)]);
    const response = await this.fetcher.call(globalThis, url, {
      method: 'GET',
      credentials: 'include',
      redirect: 'error',
      headers: { Accept: json ? 'application/json;odata=nometadata' : 'application/octet-stream' },
      signal,
    });
    if (response.status === 404 || response.status === 410) throw new StaleListingError();
    if (response.status === 401 || response.status === 403)
      throw new Error(
        'Abrí SharePoint e iniciá sesión con tu cuenta de la facultad. Comprobá el permiso para leer esta carpeta.',
      );
    if (response.status === 429 || response.status === 503)
      throw new Error('SharePoint pidió esperar. Se reintentará en la próxima revisión.');
    if (!response.ok) throw new Error(`SharePoint respondió ${response.status}.`);
    if (
      response.redirected ||
      (response.url && new URL(response.url).origin !== this.location.origin)
    )
      throw new Error('SharePoint redirigió la solicitud. Volvé a iniciar sesión.');
    const type = response.headers.get('content-type') || '';
    if ((json && !type.includes('application/json')) || type.includes('text/html'))
      throw new Error(
        'SharePoint devolvió una página de inicio de sesión en lugar del archivo. Abrí la carpeta e iniciá sesión.',
      );
    return boundedBody(response, limit, signal);
  }
  async listPage(task: PageTask): Promise<Listing> {
    const first = resourceUrl(this.location, task.kind, task.path);
    const checkNext = (value: string) => {
      const next = new URL(value, this.location.webUrl + '/');
      const base = new URL(first);
      if (
        next.origin !== base.origin ||
        decodeURIComponent(next.pathname) !== decodeURIComponent(base.pathname) ||
        next.username ||
        next.password ||
        next.hash
      )
        throw new Error('La página siguiente está fuera del alcance de la carpeta.');
      // Keep the original projection: a server link may only change pagination parameters.
      for (const key of next.searchParams.keys())
        if (!['$select', '$top', '$skiptoken', '$skip'].includes(key))
          throw new Error('Paginación de SharePoint no reconocida.');
      return next.href;
    };
    const url = task.next ? checkNext(task.next) : first;
    const data = JSON.parse(
      new TextDecoder().decode(await this.request(url, 2 * 1024 * 1024, true)),
    );
    const rows = data.value ?? data.d?.results;
    if (!Array.isArray(rows) || rows.length > 5000)
      throw new Error('Listado de SharePoint inválido o demasiado grande.');
    const entries = rows.map((row): FolderEntry | RemoteEntry => {
      const path = row.ServerRelativePath?.DecodedUrl ?? row.ServerRelativeUrl,
        name = row.Name;
      if (
        typeof name !== 'string' ||
        typeof path !== 'string' ||
        !inFolder(path, task.path) ||
        path === task.path ||
        path.slice(task.path.length + 1).includes('/') ||
        path.split('/').pop() !== name
      )
        throw new Error('SharePoint devolvió un archivo fuera de la carpeta solicitada.');
      if (task.kind === 'folders') return { name, path };
      if (
        typeof row.UniqueId !== 'string' ||
        !/^[a-f\d]{8}(-[a-f\d]{4}){3}-[a-f\d]{12}$/i.test(row.UniqueId) ||
        !Number.isSafeInteger(Number(row.Length)) ||
        Number(row.Length) < 0 ||
        typeof row.TimeLastModified !== 'string'
      )
        throw new Error('Metadatos de archivo incompletos.');
      return {
        name,
        path,
        id: row.UniqueId.toLowerCase(),
        size: Number(row.Length),
        modifiedAt: row.TimeLastModified,
        version: JSON.stringify([
          row.ETag ?? row['@odata.etag'] ?? '',
          row.TimeLastModified,
          row.Length,
          path,
        ]),
      };
    });
    const next = data['@odata.nextLink'] ?? data['odata.nextLink'] ?? data.d?.__next;
    if (next !== undefined && typeof next !== 'string') throw new Error('Paginación inválida.');
    return { entries, next: next ? checkNext(next) : undefined };
  }
  async download(entry: RemoteEntry) {
    return this.request(resourceUrl(this.location, 'file', entry.path), MAX_FILE, false);
  }
}
