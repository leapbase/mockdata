import { cpSync, existsSync, rmSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const source = fileURLToPath(new URL('../packages/web/dist/', import.meta.url));
const destination = fileURLToPath(new URL('../packages/server/dist/web/', import.meta.url));
if (!existsSync(new URL('../packages/web/dist/index.html', import.meta.url))) {
  throw new Error('Build @mockdata/web before bundling the UI.');
}
// Replace the entire bundle so old hashed assets are never shipped in the next release.
rmSync(destination, { recursive: true, force: true });
cpSync(source, destination, { recursive: true });
console.log('Bundled web assets into @mockdata/server.');
