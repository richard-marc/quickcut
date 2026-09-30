import { copyFile, mkdir, writeFile, readdir, access } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { resolve, dirname, join } from 'node:path';

// Distribution binaries are copied only on demand; development resolves tools from PATH.
const windows = process.platform === 'win32';
const find = name => {
  const override = process.env[`QUICKCUT_${name.toUpperCase()}`];
  if (override) return override;
  return execFileSync(windows ? 'where.exe' : 'which', [name], { encoding: 'utf8' }).trim().split(/\r?\n/)[0];
};
await mkdir('src-tauri/binaries', { recursive: true });
for (const name of ['ffmpeg', 'ffprobe']) {
  const source = find(name);
  await copyFile(source, resolve('src-tauri/binaries', `${name}${windows ? '.exe' : ''}`));
  for (const file of await readdir(dirname(source))) {
    if (windows && file.toLowerCase().endsWith('.dll')) await copyFile(join(dirname(source),file), resolve('src-tauri/binaries',file));
  }
  if (name === 'ffmpeg') {
    const distribution = dirname(dirname(source));
    for (const [from,to] of [['LICENSE','FFmpeg-LICENSE.txt'],['README.txt','FFmpeg-BUILD.txt']]) {
      try { await access(join(distribution,from)); await copyFile(join(distribution,from),resolve('src-tauri/binaries',to)); } catch { /* Distribution layouts vary. */ }
    }
  }
}
await writeFile('src-tauri/tauri.bundle-media.json', JSON.stringify({ bundle: { resources: ['binaries/*'] } }, null, 2) + '\n');
console.log('Media tools copied. Build with npm run desktop:build -- --config src-tauri/tauri.bundle-media.json');
console.log('Include the notices and source obligations required by your chosen FFmpeg distribution.');
