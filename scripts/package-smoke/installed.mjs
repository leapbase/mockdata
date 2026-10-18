import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { writeFileSync, realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { generate } from '@mockdata/core';
import { generateWithLlm } from '@mockdata/llm';
import { inferFromSource } from '@mockdata/inputs';
import { startServer } from '@mockdata/server';
import { createServer } from '@mockdata/mcp';

// This file is copied to the isolated installation; imports must resolve there.
for (const pkg of ['core', 'llm', 'inputs', 'cli', 'mcp', 'server']) {
  assert(realpathSync(fileURLToPath(import.meta.resolve(`@mockdata/${pkg}`))).startsWith(realpathSync(process.cwd()) + '/'));
}
const schema = { tables: { people: { rows: 3, columns: { id: { type: 'integer', primaryKey: true } } } } };
assert.equal(generate(schema).people.length, 3);
assert.equal(typeof generateWithLlm, 'function');
assert.equal(typeof inferFromSource, 'function');
const mcp = createServer({ root: process.cwd() });
await mcp.close();
writeFileSync('schema.json', JSON.stringify(schema));
const bin = (pkg, args) => execFileSync(process.execPath, [`node_modules/@mockdata/${pkg}/dist/bin.js`, ...args], { encoding: 'utf8', timeout: 20_000 });
assert.match(bin('cli', ['validate', 'schema.json']), /OK/);
assert.equal(JSON.parse(bin('cli', ['generate', 'schema.json'])).people.length, 3);
assert.match(bin('mcp', ['--help']), /mockdata-mcp/);
assert.match(bin('server', ['--help']), /mockdata-ui/);
const { server, url } = await startServer({ root: process.cwd(), env: {}, port: 0, workers: { size: 1, maxQueue: 2, jobTimeoutSecs: 20, heapMb: 256 } });
try {
  const request = (path, opts) => fetch(url + path, { ...opts, signal: AbortSignal.timeout(20_000) });
  assert.equal((await request('/healthz')).status, 200);
  const page = await request('/');
  assert.equal(page.status, 200, 'installed server must serve the bundled UI');
  const html = await page.text();
  const assets = [...html.matchAll(/(?:src|href)="(\/assets\/[^"?#]+)[^"]*"/g)].map(m => m[1]);
  assert(assets.some(p => p.endsWith('.js')), 'UI must reference built JavaScript');
  for (const asset of assets) assert.equal((await request(asset)).status, 200, asset);
  const preview = await request('/api/generate', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ text: JSON.stringify(schema) }) });
  assert.equal(preview.status, 200, await preview.clone().text());
  const result = await preview.json();
  assert.equal(result.counts.people, 3);
  assert.equal(result.tables.people.rows.length, 3);
} finally {
  server.closeAllConnections();
  await new Promise(resolve => server.close(resolve));
}
console.log('Standalone imports, CLI, MCP, UI assets and worker generation passed.');
