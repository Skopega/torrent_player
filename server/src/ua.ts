import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

// Нативный User-Agent, собранный из реальной версии Chrome/Chromium на машине.
// Cloudflare отслеживает согласованность строки UA с W3C-клиент-хинтами
// (navigator.userAgentData / Sec-CH-UA), поэтому нельзя хардкодить версию:
// расхождение (например «Chrome/151» при установленном 152) детектится как бот.

const UA_PLATFORM: Record<string, string> = {
  win32: 'Windows NT 10.0; Win64; x64',
  linux: 'X11; Linux x86_64',
  darwin: 'Macintosh; Intel Mac OS X 10_15_7',
};

function chromeCandidates(): string[] {
  return [
    process.env.TP_CHROME_PATH,
    '/usr/bin/google-chrome',
    '/usr/bin/google-chrome-stable',
    '/usr/bin/google-chrome-beta',
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
    path.join(process.env.LOCALAPPDATA ?? '', 'Google', 'Chrome', 'Application', 'chrome.exe'),
  ].filter((p): p is string => Boolean(p));
}

export function findChrome(): string | null {
  for (const p of chromeCandidates()) {
    if (fs.existsSync(p)) return p;
  }
  return null;
}

// Windows: версия Chrome = имя версионированной папки рядом с chrome.exe
// (например «C:\...\Application\152.0.7977.75\»). Это надёжнее `--version`,
// который на Windows открывает окно и не возвращает строку.
function windowsVersionFromDir(exe: string): string | null {
  if (process.platform !== 'win32') return null;
  const dir = path.dirname(exe);
  try {
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    let best: string | null = null;
    for (const e of entries) {
      if (!e.isDirectory()) continue;
      if (!/^\d+\.\d+\.\d+\.\d+$/.test(e.name)) continue;
      if (!best || e.name > best) best = e.name;
    }
    return best;
  } catch {
    return null;
  }
}

function unixVersionFromBinary(exe: string): string | null {
  try {
    const res = spawnSync(exe, ['--version'], {
      encoding: 'utf8',
      timeout: 5000,
      killSignal: 'SIGKILL',
      windowsHide: true,
    });
    if (res.status !== 0 || !res.stdout) return null;
    const m = /\b(\d+)\.(\d+)\.(\d+)\.(\d+)\b/.exec(res.stdout);
    if (m) return `${m[1]}.${m[2]}.${m[3]}.${m[4]}`;
  } catch {
    /* ignore */
  }
  return null;
}

function detectVersion(exe: string): string | null {
  return windowsVersionFromDir(exe) ?? unixVersionFromBinary(exe);
}

// Превращаем «152.0.7977.75» в «152.0.0.0»: в нативном UA Google Chrome мажорная
// версия всегда «<major>.0.0.0», совпадающая с клиент-хинтами.
function uaVersion(v: string): string {
  const m = /^(\d+)\./.exec(v);
  return m ? `${m[1]}.0.0.0` : v;
}

let cached: string | null = null;

export function resolveUserAgent(): string {
  if (cached) return cached;
  const platform = UA_PLATFORM[process.platform] ?? UA_PLATFORM.win32;
  const exe = findChrome();
  let version = '152.0.0.0'; // разумный фолбэк, если не удалось определить
  if (exe) {
    const v = detectVersion(exe);
    if (v) version = uaVersion(v);
  }
  cached = `Mozilla/5.0 (${platform}) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${version} Safari/537.36`;
  return cached;
}

export function resetUserAgentCache(): void {
  cached = null;
}
