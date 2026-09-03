// Скачивание xray-core с GitHub в runtime/xray/ под текущую платформу.
// Использование: node scripts/fetch-xray.cjs [версия]
//   (версия по умолчанию — latest релиз).
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const outDir = path.join(root, 'runtime', 'xray');

function platformName() {
  const os = process.platform;
  const arch = process.arch;
  if (os === 'win32') return arch === 'arm64' ? 'windows-arm64-v8a' : 'windows-64';
  if (os === 'linux') return arch === 'arm64' ? 'linux-arm64-v8a' : arch === 'arm' ? 'linux-arm32-v7a' : 'linux-64';
  if (os === 'darwin') return arch === 'arm64' ? 'macos-arm64-v8a' : 'macos-64';
  throw new Error('Неподдерживаемая платформа: ' + os + ' / ' + arch);
}

function extract(zipPath) {
  fs.mkdirSync(outDir, { recursive: true });
  if (process.platform === 'win32') {
    const r = spawnSync('powershell', [
      '-NoProfile',
      '-Command',
      `Expand-Archive -LiteralPath '${zipPath}' -DestinationPath '${outDir}' -Force`,
    ], { stdio: 'inherit', encoding: 'utf8' });
    if (r.status !== 0) throw new Error('Expand-Archive не сработал (код ' + r.status + ')');
    return;
  }
  // Linux/macOS: bsdtar умеет читать zip (есть в Debian/TrueNAS), иначе unzip.
  const t = spawnSync('tar', ['-xf', zipPath, '-C', outDir], { stdio: 'inherit', encoding: 'utf8' });
  if (t.status === 0) return;
  const u = spawnSync('unzip', ['-o', zipPath, '-d', outDir], { stdio: 'inherit', encoding: 'utf8' });
  if (u.status !== 0) throw new Error('Не удалось распаковать архив (tar и unzip недоступны)');
}

async function main() {
  const version = process.argv[2] || 'latest';
  const name = platformName();
  const url =
    version === 'latest'
      ? `https://github.com/XTLS/Xray-core/releases/latest/download/Xray-${name}.zip`
      : `https://github.com/XTLS/Xray-core/releases/download/${version}/Xray-${name}.zip`;
  const bin = path.join(outDir, process.platform === 'win32' ? 'xray.exe' : 'xray');
  if (fs.existsSync(bin)) {
    console.log(`xray уже есть: ${bin}`);
    return;
  }
  console.log('Качаю xray: ' + url);
  const res = await fetch(url, { redirect: 'follow', signal: AbortSignal.timeout(180000) });
  if (!res.ok) throw new Error('HTTP ' + res.status + ' для ' + url);
  fs.mkdirSync(outDir, { recursive: true });
  const zipPath = path.join(outDir, 'xray.zip');
  fs.writeFileSync(zipPath, Buffer.from(await res.arrayBuffer()));
  console.log('Распаковываю...');
  extract(zipPath);
  fs.rmSync(zipPath, { force: true });
  if (!fs.existsSync(bin)) throw new Error('Бинарь не найден после распаковки: ' + bin);
  console.log('Готово: ' + bin);
}

main().catch((e) => {
  console.error('[fetch-xray]', e && e.message ? e.message : e);
  process.exit(1);
});
