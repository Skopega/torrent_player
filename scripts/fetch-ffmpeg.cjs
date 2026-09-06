// Скачивание QSV-совместимого ffmpeg/ffprobe в runtime/ffmpeg/.
// ffmpeg-static из npm собран БЕЗ Intel QSV (libmfx/libvpl), поэтому на машинах
// с iGPU (i3-9100 UHD 630) транскод падал бы в libx264. Здесь берём статическую
// gpl-сборку BtbN, которая включает libmfx/libvpl (QSV).
// Сборка залочена на конкретный autobuild-релиз BtbN + SHA-256 (не «master-latest»,
// чтобы транскод не менялся молча при повторной установке).
// Использование: node scripts/fetch-ffmpeg.cjs
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const root = path.resolve(__dirname, '..');
const outDir = path.join(root, 'runtime', 'ffmpeg');
const tmpDir = path.join(outDir, '.tmp');

// Залоченный autobuild-релиз BtbN + SHA-256 архивов.
const BTBN_TAG = 'autobuild-2026-09-05-13-10';
const ASSETS = {
  win32: { name: 'ffmpeg-N-126416-g9997fd0606-win64-gpl.zip', sha256: '27331240365996c1e702541ea26749941734bf53b3209845f9a1b42c6be196b1' },
  linux: { name: 'ffmpeg-N-126416-g9997fd0606-linux64-gpl.tar.xz', sha256: '13c82fe68c401eb3f3ae2e402beb480fdd384b4de7222ae368bdbab36e949ab6' },
};

function sha256(buf) {
  return crypto.createHash('sha256').update(buf).digest('hex');
}

function assetFor() {
  const a = ASSETS[process.platform];
  if (!a) throw new Error('Неподдерживаемая платформа: ' + process.platform);
  return a;
}

function extract(archivePath) {
  fs.mkdirSync(tmpDir, { recursive: true });
  if (process.platform === 'win32') {
    const r = spawnSync('powershell', [
      '-NoProfile',
      '-Command',
      `Expand-Archive -LiteralPath '${archivePath}' -DestinationPath '${tmpDir}' -Force`,
    ], { stdio: 'inherit', encoding: 'utf8' });
    if (r.status !== 0) throw new Error('Expand-Archive не сработал (код ' + r.status + ')');
    return;
  }
  const t = spawnSync('tar', ['-xf', archivePath, '-C', tmpDir], { stdio: 'inherit', encoding: 'utf8' });
  if (t.status !== 0) throw new Error('tar не сработал (код ' + t.status + ')');
}

// Находит бинарь в распакованном дереве (BtbN кладёт их в bin/).
function locateBin(name) {
  const stack = [tmpDir];
  while (stack.length) {
    const dir = stack.pop();
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) {
        stack.push(p);
      } else if (e.name === name) {
        return p;
      }
    }
  }
  return null;
}

async function main() {
  const asset = assetFor();
  const url = `https://github.com/BtbN/FFmpeg-Builds/releases/download/${BTBN_TAG}/${asset.name}`;
  const exe = process.platform === 'win32' ? '.exe' : '';
  const ffmpegBin = path.join(outDir, `ffmpeg${exe}`);
  const ffprobeBin = path.join(outDir, `ffprobe${exe}`);

  if (fs.existsSync(ffmpegBin) && fs.existsSync(ffprobeBin)) {
    console.log(`ffmpeg уже есть: ${ffmpegBin}`);
    return;
  }

  console.log('Качаю ffmpeg (QSV): ' + url);
  const res = await fetch(url, { redirect: 'follow', signal: AbortSignal.timeout(600000) });
  if (!res.ok) throw new Error('HTTP ' + res.status + ' для ' + url);

  const buf = Buffer.from(await res.arrayBuffer());
  const actual = sha256(buf);
  if (actual !== asset.sha256) {
    throw new Error(`SHA-256 не совпал для ${asset.name}: ожидалось ${asset.sha256}, получено ${actual}`);
  }
  console.log(`SHA-256 ok (${actual})`);

  fs.mkdirSync(tmpDir, { recursive: true });
  const archivePath = path.join(tmpDir, asset.name);
  fs.writeFileSync(archivePath, buf);
  console.log('Распаковываю...');
  extract(archivePath);
  fs.rmSync(archivePath, { force: true });

  const srcFfmpeg = locateBin(`ffmpeg${exe}`);
  const srcFfprobe = locateBin(`ffprobe${exe}`);
  if (!srcFfmpeg || !srcFfprobe) {
    throw new Error('Бинари ffmpeg/ffprobe не найдены в архиве');
  }

  fs.mkdirSync(outDir, { recursive: true });
  fs.renameSync(srcFfmpeg, ffmpegBin);
  fs.renameSync(srcFfprobe, ffprobeBin);
  fs.rmSync(tmpDir, { recursive: true, force: true });
  console.log('Готово: ' + ffmpegBin);
}

main().catch((e) => {
  console.error('[fetch-ffmpeg]', e && e.message ? e.message : e);
  process.exit(1);
});
