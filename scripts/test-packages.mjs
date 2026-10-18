import { execFileSync } from 'node:child_process';
import { copyFileSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { packPackages, root } from './pack-packages.mjs';

const temp = mkdtempSync(path.join(tmpdir(), 'mockdata-install-'));
try {
  const tarballs = packPackages(path.join(temp, 'tarballs'));
  const install = path.join(temp, 'consumer');
  mkdirSync(install);
  writeFileSync(path.join(install, 'package.json'), JSON.stringify({ private: true, type: 'module' }));
  // Install every unpublished workspace from its real tarball, never workspace links.
  execFileSync('npm', ['install', '--ignore-scripts', '--no-audit', '--no-fund', ...tarballs], { cwd: install, stdio: 'inherit', timeout: 180_000 });
  copyFileSync(path.join(root, 'scripts/package-smoke/installed.mjs'), path.join(install, 'smoke.mjs'));
  execFileSync(process.execPath, ['smoke.mjs'], { cwd: install, stdio: 'inherit', timeout: 90_000 });
} finally {
  rmSync(temp, { recursive: true, force: true });
}
