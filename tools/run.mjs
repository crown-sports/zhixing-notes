import { readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const root = fileURLToPath(new URL('../', import.meta.url));
const plugins = ['review-workbench', 'pdf-location-bookmarks'];
const python = process.platform === 'win32' ? 'python' : 'python3';
function run(executable, args, cwd = root) {
  const result = spawnSync(executable, args, { cwd, stdio: 'inherit' });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}
function files(path) {
  return readdirSync(path, { withFileTypes: true }).flatMap(entry => {
    const child = resolve(path, entry.name);
    if (entry.isSymbolicLink()) throw new Error('Symbolic links are not release inputs');
    return entry.isDirectory() ? files(child) : [child];
  });
}
const source = plugins.flatMap(name => files(resolve(root, 'plugins', name)));
switch (process.argv[2]) {
  case 'build':
    for (const name of plugins) run(process.execPath, ['build.js'], resolve(root, 'plugins', name));
    break;
  case 'test':
    run(process.execPath, ['--test', ...source.filter(path => path.endsWith('.test.js'))]);
    run(python, ['-m', 'unittest', 'discover', '-s', 'tests', '-p', 'test_*.py']);
    break;
  case 'check':
    for (const path of source.filter(path => path.endsWith('.js'))) run(process.execPath, ['--check', path]);
    run(python, ['tools/package.py', '--check']);
    break;
  case 'package':
    run(python, ['tools/package.py']);
    break;
  default:
    throw new Error('Choose build, test, check or package');
}
