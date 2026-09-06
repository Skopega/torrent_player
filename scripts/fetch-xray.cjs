// Скачивание xray-core с GitHub в runtime/xray/ под текущую платформу.
// Использование: node scripts/fetch-xray.cjs [версия]
//   (версия по умолчанию — залоченный релиз, с проверкой SHA-256).
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const root = path.resolve(__dirname, '..');
const outDir = path.join(root, 'runtime', 'xray');

// Залоченная версия + SHA-256 архивов (с релиза v26.3.27). При скачивании именно
// этой версии архив сверяется с суммой — подмена/порча прерывают установку.
const DEFAULT_VERSION = '26.3.27';
const CHECKSUMS = {
  'windows-64': 'd004c39288ce9ada487c6f398c7c545f7d749e44bdfdd59dbc9f865afba4e1ad',
  'windows-arm64-v8a': '35d4ed6ec21224fb22b07c2c3f672e2350cd536f2c74d309150175a76365ea88',
  'linux-64': '23cd9af937744d97776ee35ecad4972cf4b2109d1e0fe6be9930467608f7c8ae',
  'linux-arm64-v8a': '4d30283ae614e3057f730f67cd088a42be6fdf91f8639d82cb69e48cde80413c',
  'linux-arm32-v7a': 'c7265ae13c63ca0241a037df4ef960ad37938c8a67d984cc08834b2cfdf5654b',
  'macos-64': 'f5b0471d3459eff1b82e48af0aeac186abcc3298210070afbbbd8437a4e8b203',
  'macos-arm64-v8a': '2e93a67e8aa1936ecefb307e120830fcbd4c643ab9b1c46a2d0838d5f8409eaf',
};

function sha256(buf) {
  return crypto.createHash('sha256').update(buf).digest('hex');
}

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
  const version = process.argv[2] || DEFAULT_VERSION;
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
  const zipBuf = Buffer.from(await res.arrayBuffer());

  // Сверяем контрольную сумму только для залоченной версии (для произвольной
  // версии суммы заранее не известны — предупреждаем, но не блокируем).
  const expected = version === DEFAULT_VERSION ? CHECKSUMS[name] : undefined;
  const actual = sha256(zipBuf);
  if (expected) {
    if (actual !== expected) {
      throw new Error(`SHA-256 не совпал для ${name}: ожидалось ${expected}, получено ${actual}`);
    }
    console.log(`SHA-256 ok (${actual})`);
  } else if (version !== 'latest') {
    console.warn(`[warn] для версии ${version} контрольной суммы нет — проверка пропущена`);
  }

  fs.writeFileSync(zipPath, zipBuf);
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
