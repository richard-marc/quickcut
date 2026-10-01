import { existsSync, readdirSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { run } from '@tauri-apps/cli';

const root = resolve(import.meta.dirname, '..');
process.chdir(root);
const localCargo = join(root, '.tools', 'cargo');
if (existsSync(localCargo)) {
  process.env.CARGO_HOME = localCargo;
  process.env.RUSTUP_HOME = join(root, '.tools', 'rustup');
  process.env.PATH = `${join(localCargo, 'bin')}${process.platform === 'win32' ? ';' : ':'}${process.env.PATH}`;
}
const localMsvc = join(root, '.tools', 'msvc');
if (process.platform === 'win32' && existsSync(localMsvc)) {
  const compilerBase = join(localMsvc, 'VC', 'Tools', 'MSVC');
  const compiler = join(compilerBase, readdirSync(compilerBase)[0]);
  const sdkBase = join(localMsvc, 'Windows Kits', '10');
  const sdkVersion = readdirSync(join(sdkBase, 'Lib'))[0];
  process.env.PATH = `${join(compiler, 'bin', 'Hostx64', 'x64')};${join(sdkBase, 'bin', sdkVersion, 'x64')};${process.env.PATH}`;
  process.env.LIB = [join(compiler, 'lib', 'x64'), join(sdkBase, 'Lib', sdkVersion, 'um', 'x64'), join(sdkBase, 'Lib', sdkVersion, 'ucrt', 'x64')].join(';');
  process.env.INCLUDE = [join(compiler, 'include'), ...['ucrt', 'shared', 'um'].map(dir => join(sdkBase, 'Include', sdkVersion, dir))].join(';');
}
const [action = 'dev', ...args] = process.argv.slice(2);
if (action === 'test' || action === 'desktop-test' || action === 'check' || action === 'fmt') {
  const result = spawnSync('cargo', [action === 'desktop-test' ? 'test' : action, '--manifest-path', action === 'test' ? 'src-tauri/media-core/Cargo.toml' : 'src-tauri/Cargo.toml', ...args], { stdio: 'inherit', windowsHide: true });
  if (result.error) { console.error(result.error.message); process.exit(1); }
  process.exit(result.status ?? 1);
}
run([action, ...args], 'tauri', (error, success) => { if (error) console.error(error.message); process.exit(error || !success ? 1 : 0); });
