import { mkdir, readFile, writeFile, cp, access } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
export const NODE_VERSION = 'v22.23.4';
export async function prepareNode(root, destination) {
  const platform = process.platform === 'win32' ? 'win' : process.platform;
  const stem = `node-${NODE_VERSION}-${platform}-${process.arch}`;
  const extension = platform === 'win' ? 'zip' : platform === 'linux' ? 'tar.xz' : 'tar.gz';
  const filename = `${stem}.${extension}`;
  const cache = join(root, '.runtime');
  await mkdir(cache, { recursive: true });
  const archive = join(cache, filename);
  const sumsFile = join(cache, `${NODE_VERSION}-SHASUMS256.txt`);
  async function download(file) {
    const response = await fetch(`https://nodejs.org/dist/${NODE_VERSION}/${file}`, {
      signal: AbortSignal.timeout(300000),
    });
    if (!response.ok) throw new Error(`No se pudo descargar Node (${response.status})`);
    return Buffer.from(await response.arrayBuffer());
  }
  let sums;
  try {
    sums = await readFile(sumsFile, 'utf8');
  } catch {
    sums = (await download('SHASUMS256.txt')).toString();
    await writeFile(sumsFile, sums);
  }
  const expected = sums
    .split('\n')
    .map((l) => l.trim().split(/\s+/))
    .find(([, name]) => name === filename)?.[0];
  if (!expected) throw new Error(`No hay checksum oficial para ${filename}`);
  let bytes;
  try {
    bytes = await readFile(archive);
  } catch {
    console.log(`Descargando Node oficial ${NODE_VERSION} (${platform}/${process.arch})…`);
    bytes = await download(filename);
  }
  if (createHash('sha256').update(bytes).digest('hex') !== expected)
    throw new Error('El checksum de Node no coincide con el publicado por nodejs.org');
  await writeFile(archive, bytes);
  const extracted = join(cache, stem);
  const executable = join(extracted, platform === 'win' ? 'node.exe' : 'bin/node');
  try {
    await access(executable);
  } catch {
    const result = spawnSync('tar', ['-xf', archive, '-C', cache], {
      stdio: 'inherit',
      shell: false,
    });
    if (result.error) throw result.error;
    if (result.status !== 0)
      throw new Error(
        'No se pudo extraer Node. Se necesita tar compatible con el archivo oficial.',
      );
  }
  await cp(executable, join(destination, platform === 'win' ? 'node.exe' : 'node'));
  await cp(join(extracted, 'LICENSE'), join(destination, 'Node-LICENSE.txt'));
}
