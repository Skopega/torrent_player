// Диагностика окружения: версии и наличие нужных бинарей.
//   node scripts/check-env.cjs
// Печатает: node, chrome (резолв как в browser.ts), xray, ffmpeg (+ какие
// аппаратные энкодеры собраны: qsv/nvenc/vaapi), ffprobe.
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const root = path.resolve(__dirname, '..');
const bin = (cmd, args, timeout = 20000) => {
  if (!cmd || !fs.existsSync(cmd)) return { missing: true };
  const r = spawnSync(cmd, args, { encoding: 'utf8', timeout });
  return { ok: r.status === 0, out: (r.stdout || '').trim(), err: (r.stderr || '').trim() };
};

function bundledChrome() {
  const exe = process.platform === 'win32' ? 'chrome.exe' : 'chrome';
  const dir = path.join(root, 'runtime', 'chrome');
  const cur = path.join(dir, 'current.txt');
  try {
    if (fs.existsSync(cur)) {
      const p = fs.readFileSync(cur, 'utf8').trim();
      if (p) return p;
    }
  } catch { /* ignore */ }
  return path.join(dir, exe);
}

function resolveChrome() {
  const candidates = [
    process.env.TP_CHROME_PATH,
    bundledChrome(),
    '/usr/bin/google-chrome',
    '/usr/bin/google-chrome-stable',
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
    path.join(process.env.LOCALAPPDATA || '', 'Google', 'Chrome', 'Application', 'chrome.exe'),
  ].filter(Boolean);
  for (const c of candidates) if (c && fs.existsSync(c)) return c;
  return null;
}

function resolveXray() {
  if (process.env.XRAY_BIN && fs.existsSync(process.env.XRAY_BIN)) return process.env.XRAY_BIN;
  const exe = process.platform === 'win32' ? 'xray.exe' : 'xray';
  const p = path.join(root, 'runtime', 'xray', exe);
  return fs.existsSync(p) ? p : null;
}

function ffmpegDefault() {
  try {
    if (process.env.FFMPEG_PATH && fs.existsSync(process.env.FFMPEG_PATH)) return process.env.FFMPEG_PATH;
    const p = require('ffmpeg-static');
    return p && fs.existsSync(p) ? p : null;
  } catch {
    return null;
  }
}

function ffprobeDefault() {
  try {
    if (process.env.FFPROBE_PATH && fs.existsSync(process.env.FFPROBE_PATH)) return process.env.FFPROBE_PATH;
    const p = require('ffprobe-static');
    return p && p.path && fs.existsSync(p.path) ? p.path : null;
  } catch {
    return null;
  }
}

const line = (label, value) => console.log((label + ':').padEnd(12) + value);

console.log('platform:', process.platform + '/' + process.arch, '| node', process.version);
console.log('');

function chromeVersion(chromePath) {
  if (process.platform === 'win32') {
    // GUI-приложение: не запускаем его, читаем версию из PE-ресурса.
    const r = spawnSync('powershell', [
      '-NoProfile', '-Command',
      `(Get-Item -LiteralPath '${chromePath}').VersionInfo.ProductVersion`,
    ], { encoding: 'utf8', timeout: 15000 });
    return (r.stdout || '').trim() || (r.stderr || '').trim();
  }
  const v = bin(chromePath, ['--version'], 8000);
  return v.out || v.err || '';
}

const chrome = resolveChrome();
line('chrome', chrome || 'НЕ НАЙДЕН');
if (chrome) {
  line('  версия', chromeVersion(chrome));
}
console.log('');

const xray = resolveXray();
line('xray', xray || 'НЕ НАЙДЕН');
if (xray) {
  const v = bin(xray, ['version']);
  line('  версия', (v.out || v.err || '').split('\n')[0]);
}
console.log('');

const ffmpeg = ffmpegDefault();
line('ffmpeg', ffmpeg || 'НЕ НАЙДЕН');
if (ffmpeg) {
  const v = bin(ffmpeg, ['-version']);
  line('  версия', (v.out || '').split('\n')[0]);
  const enc = bin(ffmpeg, ['-hide_banner', '-encoders']);
  if (enc.ok) {
    const hw = (enc.out || '')
      .split('\n')
      .filter((l) => /(qsv|nvenc|vaapi|libx264|h264_v4l2m2m)/.test(l))
      .map((l) => l.trim());
    console.log('  hw/ключевые энкодеры:');
    hw.forEach((l) => console.log('    ' + l));
    if (!hw.length) console.log('    (нет qsv/nvenc/vaapi в этой сборке)');
  }
}
console.log('');

const ffprobe = ffprobeDefault();
line('ffprobe', ffprobe || 'НЕ НАЙДЕН');
if (ffprobe) {
  const v = bin(ffprobe, ['-version']);
  line('  версия', (v.out || '').split('\n')[0]);
}
