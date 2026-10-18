import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const root = fileURLToPath(new URL('../', import.meta.url));
export const packages = ['core', 'llm', 'inputs', 'cli', 'mcp', 'server'];
export function packPackages(destination) {
  mkdirSync(destination, { recursive: true });
  const result = execFileSync('npm', ['pack', ...packages.flatMap(p => ['--workspace', `@mockdata/${p}`]), '--json', '--pack-destination', destination], { cwd: root, encoding: 'utf8', maxBuffer: 10 * 1024 * 1024 });
  const packs = JSON.parse(result);
  if (packs.length !== packages.length) throw new Error('Expected all six publishable packages.');
  for (const pack of packs) {
    const manifest = JSON.parse(readFileSync(path.join(root, 'packages', pack.name.split('/')[1], 'package.json'), 'utf8'));
    const requiredFiles = ['README.md', 'LICENSE', 'package.json', manifest.main, manifest.types, ...Object.values(manifest.bin ?? {})];
    if (pack.name === '@mockdata/server') requiredFiles.push('dist/web/index.html');
    for (const required of requiredFiles) {
      if (!pack.files.some(f => f.path === required)) throw new Error(`${pack.name} is missing ${required}`);
    }
  }
  return packs.map(p => path.join(destination, p.filename));
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  console.log(packPackages(path.resolve(process.argv[2] ?? path.join(root, 'artifacts'))).join('\n'));
}
