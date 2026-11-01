import { build } from 'esbuild';
import { mkdir, readFile, writeFile, copyFile } from 'node:fs/promises';
await mkdir('dist/extension', { recursive: true });
await build({
  entryPoints: ['extension/popup.ts', 'extension/content.ts', 'extension/background.ts'],
  outdir: 'dist/extension',
  bundle: true,
  format: 'iife',
  target: 'chrome120',
  minify: true,
});
const manifest = JSON.parse(await readFile('extension/manifest.json', 'utf8'));
const identity = JSON.parse(await readFile('extension/identity.json', 'utf8'));
await writeFile(
  'dist/extension/manifest.json',
  JSON.stringify({ ...manifest, key: identity.key }, null, 2),
);
await copyFile('extension/popup.html', 'dist/extension/popup.html');
console.log(`Extensión: dist/extension (${identity.extensionId})`);
