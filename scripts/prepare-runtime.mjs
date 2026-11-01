import { prepareNode, NODE_VERSION } from './node-runtime.mjs';
import { cp, mkdir, readFile, writeFile, access, chmod, rm } from 'node:fs/promises';
import { resolve, join, dirname, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const resources = join(root, 'src-tauri/resources');
const run = (exe, args) => {
  const r = spawnSync(exe, args, { cwd: root, stdio: 'inherit', shell: false });
  if (r.error) throw r.error;
  if (r.status !== 0) throw new Error(`${exe} terminó con código ${r.status}`);
};
if (
  !['linux', 'darwin', 'win32'].includes(process.platform) ||
  !['x64', 'arm64'].includes(process.arch)
)
  throw new Error('Plataforma no soportada. Empaquetá en el sistema de destino.');
run(process.execPath, [join(root, 'node_modules/typescript/bin/tsc'), '-p', 'agent/tsconfig.json']);
run(process.execPath, [join(root, 'scripts/build-extension.mjs')]);
for (const dir of ['runtime', 'agent', 'codex', 'extension']) {
  await rm(join(resources, dir), { recursive: true, force: true });
  await mkdir(join(resources, dir), { recursive: true });
  await writeFile(
    join(resources, dir, 'development.txt'),
    'Generated at package time; not needed in development.\n',
  );
}
const node = join(resources, 'runtime', process.platform === 'win32' ? 'node.exe' : 'node');
await prepareNode(root, join(resources, 'runtime'));
await chmod(node, 0o755);
await cp(join(root, 'dist/agent'), join(resources, 'agent'), { recursive: true });
await writeFile(
  join(resources, 'agent/package.json'),
  JSON.stringify({ private: true, type: 'module' }),
);
await cp(join(root, 'dist/extension'), join(resources, 'extension'), { recursive: true });
async function locate(name, from) {
  let at = from;
  while (true) {
    const dir = join(at, 'node_modules', name);
    try {
      await access(join(dir, 'package.json'));
      return dir;
    } catch {}
    const parent = dirname(at);
    if (parent === at) return null;
    at = parent;
  }
}
async function copyTree(names, destination) {
  const seen = new Set();
  const queue = names.map((name) => ({ name, from: root, optional: false }));
  while (queue.length) {
    const { name, from, optional } = queue.shift();
    const path = await locate(name, from);
    if (!path) {
      if (optional) continue;
      throw new Error(`Falta ${name}. Ejecutá npm ci.`);
    }
    if (seen.has(path)) continue;
    seen.add(path);
    const manifest = JSON.parse(await readFile(join(path, 'package.json'), 'utf8'));
    await cp(path, join(destination, relative(root, path)), { recursive: true, dereference: true });
    for (const dependency of new Set([
      ...Object.keys(manifest.dependencies ?? {}),
      ...Object.keys(manifest.peerDependencies ?? {}),
      ...Object.keys(manifest.optionalDependencies ?? {}),
    ])) {
      queue.push({
        name: dependency,
        from: path,
        optional:
          dependency in (manifest.optionalDependencies ?? {}) ||
          !!manifest.peerDependenciesMeta?.[dependency]?.optional,
      });
    }
  }
  return [...seen].map((p) => relative(root, p));
}
const packages = await copyTree(
  ['@anthropic-ai/claude-agent-sdk', '@cursor/sdk', 'zod'],
  join(resources, 'agent'),
);
packages.push(...(await copyTree(['@openai/codex'], join(resources, 'codex'))));
// Smoke-test the actual copied layout, including provider native binaries, with no account or inference.
run(node, ['--version']);
run(node, [join(resources, 'codex/node_modules/@openai/codex/bin/codex.js'), '--version']);
run(node, [
  '--input-type=module',
  '-e',
  `await import(${JSON.stringify(new URL('../src-tauri/resources/agent/node_modules/@anthropic-ai/claude-agent-sdk/sdk.mjs', import.meta.url).href)}); await import(${JSON.stringify(new URL('../src-tauri/resources/agent/node_modules/@cursor/sdk/dist/esm/index.js', import.meta.url).href)});`,
]);
const claudeName = `@anthropic-ai/claude-agent-sdk-${process.platform}-${process.arch}`;
const claude = join(
  resources,
  'agent/node_modules',
  claudeName,
  process.platform === 'win32' ? 'claude.exe' : 'claude',
);
run(claude, ['--version']);
await writeFile(
  join(resources, 'runtime/build-info.json'),
  JSON.stringify(
    { node: NODE_VERSION, platform: process.platform, arch: process.arch, packages },
    null,
    2,
  ),
);
console.log(`Runtime preparado para ${process.platform}/${process.arch}.`);
