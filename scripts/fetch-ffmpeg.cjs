// Скачивание QSV-совместимого ffmpeg/ffprobe в runtime/ffmpeg/.
// ffmpeg-static из npm собран БЕЗ Intel QSV (libmfx/libvpl), поэтому на машинах
// с iGPU (i3-9100 UHD 630) транскод падал бы в libx264. Здесь берём статическую
// gpl-сборку BtbN, которая включает libmfx/libvpl (QSV).
// Использование: node scripts/fetch-ffmpeg.cjs
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const outDir = path.join(root, 'runtime', 'ffmpeg');
const tmpDir = path.join(outDir, '.tmp');

function assetName() {
  if (process.platform === 'win32') return 'ffmpeg-master-latest-win64-gpl.zip';
  if (process.platform === 'linux') return 'ffmpeg-master-latest-linux64-gpl.tar.xz';
  throw new Error('Неподдерживаемая платформа: ' + process.platform);
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
  const url = `https://github.com/BtbN/FFmpeg-Builds/releases/latest/download/${assetName()}`;
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

  fs.mkdirSync(tmpDir, { recursive: true });
  const archivePath = path.join(tmpDir, assetName());
  fs.writeFileSync(archivePath, Buffer.from(await res.arrayBuffer()));
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
