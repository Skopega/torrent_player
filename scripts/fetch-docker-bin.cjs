// Скачивание Linux-бинарей для docker-сборки в docker/bin/:
//   - Chrome .deb (для Cloudflare-обхода)
//   - ffmpeg/ffprobe (BtbN static gpl, с QSV)
//   - xray-core (для vless-прокси)
// Бинари загитигнорены — для воспроизводимого `docker build` их нужно получить явно.
// Использование: node scripts/fetch-docker-bin.cjs
// Работает и на Windows (сборка идёт на хосте), и на Linux.
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const root = path.resolve(__dirname, '..');
const outRoot = path.join(root, 'docker', 'bin');
const tmpDir = path.join(outRoot, '.tmp');

// Залоченные версии + SHA-256 (для архивов, где сумма известна).
const BTBN_TAG = 'autobuild-2026-09-05-13-10';
const FFMPEG_ASSET = 'ffmpeg-N-126416-g9997fd0606-linux64-gpl.tar.xz';
const FFMPEG_SHA256 = '13c82fe68c401eb3f3ae2e402beb480fdd384b4de7222ae368bdbab36e949ab6';
const XRAY_VERSION = '26.3.27';
const XRAY_SHA256 = '23cd9af937744d97776ee35ecad4972cf4b2109d1e0fe6be9930467608f7c8ae';
const CHROME_URL = 'https://dl.google.com/linux/direct/google-chrome-stable_current_amd64.deb';

function sha256(buf) {
  return crypto.createHash('sha256').update(buf).digest('hex');
}

async function download(url, timeoutMs) {
  const res = await fetch(url, { redirect: 'follow', signal: AbortSignal.timeout(timeoutMs) });
  if (!res.ok) throw new Error('HTTP ' + res.status + ' для ' + url);
  return Buffer.from(await res.arrayBuffer());
}

function verify(name, buf, expected) {
  const actual = sha256(buf);
  if (actual !== expected) {
    throw new Error(`SHA-256 не совпал для ${name}: ожидалось ${expected}, получено ${actual}`);
  }
  console.log(`  SHA-256 ok (${actual})`);
}

function extractTar(archive, dest) {
  fs.mkdirSync(dest, { recursive: true });
  const r = spawnSync('tar', ['-xf', archive, '-C', dest], { stdio: 'inherit' });
  if (r.status !== 0) throw new Error('tar не сработал (код ' + r.status + ')');
}

function extractZip(archive, dest) {
  fs.mkdirSync(dest, { recursive: true });
  // На Windows встроенный tar (bsdtar) умеет читать zip; на Linux — тоже.
  const t = spawnSync('tar', ['-xf', archive, '-C', dest], { stdio: 'inherit' });
  if (t.status === 0) return;
  const u = spawnSync('unzip', ['-o', archive, '-d', dest], { stdio: 'inherit' });
  if (u.status !== 0) throw new Error('Не удалось распаковать zip (tar и unzip недоступны)');
}

// Находит файл по имени в дереве каталогов.
function locate(dir, name) {
  const stack = [dir];
  while (stack.length) {
    const cur = stack.pop();
    let entries;
    try {
      entries = fs.readdirSync(cur, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      const p = path.join(cur, e.name);
      if (e.isDirectory()) stack.push(p);
      else if (e.name === name) return p;
    }
  }
  return null;
}

async function ensureChrome() {
  const dest = path.join(outRoot, 'chrome');
  const deb = path.join(dest, 'google-chrome-stable_current_amd64.deb');
  if (fs.existsSync(deb)) {
    console.log('Chrome .deb уже есть: ' + deb);
    return;
  }
  console.log('Качаю Chrome .deb: ' + CHROME_URL);
  const buf = await download(CHROME_URL, 600000);
  // Google не публикует стабильную контрольную сумму для «current» .deb — сверки нет.
  fs.mkdirSync(dest, { recursive: true });
  fs.writeFileSync(deb, buf);
  console.log('  готово (' + (buf.length / 1048576).toFixed(0) + ' МБ)');
}

async function ensureFfmpeg() {
  const dest = path.join(outRoot, 'ffmpeg');
  if (fs.existsSync(path.join(dest, 'ffmpeg')) && fs.existsSync(path.join(dest, 'ffprobe'))) {
    console.log('ffmpeg/ffprobe уже есть: ' + dest);
    return;
  }
  const url = `https://github.com/BtbN/FFmpeg-Builds/releases/download/${BTBN_TAG}/${FFMPEG_ASSET}`;
  console.log('Качаю ffmpeg/ffprobe (Linux, QSV): ' + url);
  const buf = await download(url, 600000);
  verify(FFMPEG_ASSET, buf, FFMPEG_SHA256);
  const extractDir = path.join(tmpDir, 'ffmpeg');
  fs.mkdirSync(extractDir, { recursive: true });
  const archive = path.join(tmpDir, FFMPEG_ASSET);
  fs.writeFileSync(archive, buf);
  extractTar(archive, extractDir);
  fs.rmSync(archive, { force: true });
  const ffmpeg = locate(extractDir, 'ffmpeg');
  const ffprobe = locate(extractDir, 'ffprobe');
  if (!ffmpeg || !ffprobe) throw new Error('ffmpeg/ffprobe не найдены в архиве');
  fs.mkdirSync(dest, { recursive: true });
  fs.copyFileSync(ffmpeg, path.join(dest, 'ffmpeg'));
  fs.copyFileSync(ffprobe, path.join(dest, 'ffprobe'));
  fs.rmSync(extractDir, { recursive: true, force: true });
  console.log('  готово: ' + dest);
}

async function ensureXray() {
  const dest = path.join(outRoot, 'xray');
  const bin = path.join(dest, 'xray');
  if (fs.existsSync(bin)) {
    console.log('xray уже есть: ' + bin);
    return;
  }
  const url = `https://github.com/XTLS/Xray-core/releases/download/v${XRAY_VERSION}/Xray-linux-64.zip`;
  console.log('Качаю xray (Linux): ' + url);
  const buf = await download(url, 180000);
  verify('Xray-linux-64.zip', buf, XRAY_SHA256);
  const zipPath = path.join(tmpDir, 'xray.zip');
  fs.mkdirSync(tmpDir, { recursive: true });
  fs.writeFileSync(zipPath, buf);
  const extractDir = path.join(tmpDir, 'xray');
  fs.mkdirSync(extractDir, { recursive: true });
  extractZip(zipPath, extractDir);
  fs.rmSync(zipPath, { force: true });
  const src = locate(extractDir, 'xray');
  if (!src) throw new Error('xray не найден в архиве');
  fs.mkdirSync(dest, { recursive: true });
  fs.copyFileSync(src, bin);
  fs.rmSync(extractDir, { recursive: true, force: true });
  console.log('  готово: ' + bin);
}

async function main() {
  fs.mkdirSync(outRoot, { recursive: true });
  await ensureChrome();
  await ensureFfmpeg();
  await ensureXray();
  fs.rmSync(tmpDir, { recursive: true, force: true });
  console.log('Все docker-бинари на месте в docker/bin/. Запустите build-docker.bat.');
}

main().catch((e) => {
  console.error('[fetch-docker-bin]', e && e.message ? e.message : e);
  process.exit(1);
});
