import { readdir, mkdir, copyFile, readFile, writeFile } from 'node:fs/promises';
import { join, extname } from 'node:path';
import { createHash } from 'node:crypto';
const platform = process.argv[2];
if (!['linux-x64', 'windows-x64', 'macos-arm64', 'macos-intel'].includes(platform)) throw Error('Unknown platform');
async function walk(dir) {
  const entries = await readdir(dir, { withFileTypes: true });
  return (await Promise.all(entries.map(e => e.isDirectory() ? walk(join(dir, e.name)) : join(dir, e.name)))).flat();
}
await mkdir('release-assets', { recursive: true });
const extensions = platform.startsWith('linux') ? ['.deb', '.AppImage'] : platform.startsWith('windows') ? ['.exe'] : ['.dmg'];
const files = await walk('target/release/bundle');
const sums = [];
for (const ext of extensions) {
  const source = files.find(f => extname(f) === ext);
  if (!source) throw Error(`Missing ${platform} ${ext}`);
  const name = `Lupino-${platform}${ext}`;
  await copyFile(source, join('release-assets', name));
  const hash = createHash('sha256').update(await readFile(source)).digest('hex');
  sums.push(`${hash}  ${name}`);
}
await writeFile(`release-assets/SHA256SUMS-${platform}.txt`, sums.join('\n') + '\n');
console.log('Release installers ready:', platform);
