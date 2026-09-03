import { spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { chromium, type Browser, type BrowserContext, type Page } from 'playwright-core';
import { log } from './logger.js';
import { DATA_DIR } from './store.js';
import { BASE_URL, USER_AGENT } from './http.js';
import { findChrome } from './ua.js';
import type { VpnProxy } from './vpn/types.js';

const PROFILE_DIR = path.join(DATA_DIR, 'chrome-profile');
const LOGIN_URL = BASE_URL + 'login.php';
const INDEX_URL = BASE_URL + 'index.php';

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

// Headed/headless: RUTRACKER_HEADED=1 принудительно headed, =0 — headless.
// По умолчанию (сервер) — headless: Cloudflare проходит и в headless при нативном
// UA, а отдельная ручная капча не нужна. headed нужен только для отладки.
function wantHeaded(): boolean {
  const e = process.env.RUTRACKER_HEADED;
  if (e === '1') return true;
  if (e === '0') return false;
  return false;
}

export interface BrowserLoginResult {
  ok: boolean;
  username?: string;
  captcha?: boolean;
  error?: string;
}

export class BrowserManager {
  private browser: Browser | null = null;
  private context: BrowserContext | null = null;
  private chromeProc: ChildProcess | null = null;
  private chain: Promise<unknown> = Promise.resolve();
  private ensurePromise: Promise<void> | null = null;
  // Флаг: восстановили ли куки из session.json в контекст (только раз за запуск).
  private sessionRestored = false;
  // Фаза логина для UI: 'cloudflare' (проходим капчу) | 'login' (сабмитим форму).
  private loginPhase: 'idle' | 'cloudflare' | 'login' = 'idle';

  constructor(private vpn: VpnProxy | null = null) {}

  // Все навигации в одном браузере идут через одну страницу, поэтому
  // сериализуем их, чтобы параллельные запросы не конфликтовали.
  private serialize<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.chain.then(fn, fn);
    this.chain = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  private ensure(): Promise<void> {
    if (this.browser && this.context) return Promise.resolve();
    if (!this.ensurePromise) {
      this.ensurePromise = this.launch().finally(() => {
        this.ensurePromise = null;
      });
    }
    return this.ensurePromise;
  }

  private async launch(): Promise<void> {
    // Если включён vless-прокси — сначала поднимаем его, чтобы Chrome стартовал
    // уже с рабочим --proxy-server (иначе он не дотянется до rutracker).
    if (this.vpn?.isEnabled()) {
      const ok = await this.vpn.ensureReady();
      if (!ok) {
        throw new Error('Прокси включён, но не поднят. Проверьте статус VPN в веб-интерфейсе.');
      }
    }

    const chromePath = findChrome();
    if (!chromePath) {
      throw new Error('Google Chrome не найден (нужен для обхода Cloudflare).');
    }

    const basePort = Number(process.env.RUTRACKER_CDP_PORT) || 9222;
    let lastErr: unknown = new Error('Chrome launch failed');

    for (let i = 0; i < 12; i++) {
      const port = basePort + i;
      fs.mkdirSync(PROFILE_DIR, { recursive: true });
      const proc = spawn(chromePath, this.args(port), { stdio: 'ignore' });
      try {
        const browser = await this.connect(port);
        this.browser = browser;
        this.context = browser.contexts()[0];
        this.chromeProc = proc;
        log.info(
          `[browser] Chrome запущен через CDP (порт ${port}, headless=${!wantHeaded()})`,
        );
        return;
      } catch (e) {
        lastErr = e;
        try {
          proc.kill();
        } catch {
          /* ignore */
        }
      }
    }

    throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
  }

  private args(port: number): string[] {
    const a = [
      `--remote-debugging-port=${port}`,
      `--user-data-dir=${PROFILE_DIR}`,
      `--user-agent=${USER_AGENT}`,
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-features=Translate,MediaRouter',
      '--window-size=1280,800',
    ];
    // Песочница отключается только на Linux/в контейнере (root). На Windows
    // используется системный Chrome с целой песочницей — `--no-sandbox` не нужен.
    if (process.platform === 'linux') {
      a.splice(a.length - 1, 0, '--no-sandbox', '--disable-dev-shm-usage', '--disable-gpu');
    }
    if (!wantHeaded()) a.unshift('--headless=new');
    const proxy = this.vpn?.httpProxyUrl();
    if (proxy) {
      a.push(`--proxy-server=${proxy}`, '--proxy-bypass-list=<-loopback>');
    }
    a.push('about:blank');
    return a;
  }

  private async connect(port: number, timeoutMs = 20000): Promise<Browser> {
    const deadline = Date.now() + timeoutMs;
    let lastErr: unknown;
    while (Date.now() < deadline) {
      try {
        return await chromium.connectOverCDP(`http://127.0.0.1:${port}`);
      } catch (e) {
        lastErr = e;
        await sleep(400);
      }
    }
    throw lastErr instanceof Error ? lastErr : new Error('CDP timeout');
  }

  private async page(): Promise<Page> {
    const pages = this.context!.pages();
    const p = pages.find((pg) => !pg.isClosed());
    if (p) return p;
    return this.context!.newPage();
  }

  private async isChallenged(page: Page): Promise<boolean> {
    try {
      const t = await page.title();
      return t === 'Just a moment...' || t === 'Один момент…' || t === 'Loading';
    } catch {
      return false;
    }
  }

  // Если челлендж не решился за 60с — выходим с понятной ошибкой. Обычно при
  // нативном UA Cloudflare отрабатывает за ~5-10с без клика.
  private async waitChallengeClear(page: Page, seconds = 60): Promise<boolean> {
    for (let t = 0; t <= seconds; t += 5) {
      if (t > 0) await sleep(5000);
      if (!(await this.isChallenged(page))) return true;
    }
    return false;
  }

  private async username(page: Page): Promise<string | null> {
    try {
      const t = await page.textContent('#logged-in-username');
      return (t ?? '').trim() || null;
    } catch {
      return null;
    }
  }

  async currentUsername(): Promise<string | null> {
    await this.ensure();
    return this.serialize(async () => {
      const page = await this.page();
      await page.goto(INDEX_URL, { waitUntil: 'domcontentloaded', timeout: 60000 });
      await this.waitChallengeClear(page);
      return this.username(page);
    });
  }

  async isLoggedIn(): Promise<boolean> {
    return (await this.currentUsername()) !== null;
  }

  async login(username: string, password: string): Promise<BrowserLoginResult> {
    await this.ensure();
    return this.serialize(async () => {
      this.loginPhase = 'cloudflare';
      const page = await this.page();
      await page.goto(LOGIN_URL, { waitUntil: 'domcontentloaded', timeout: 60000 });
      await this.waitChallengeClear(page);

      const uname = page.locator('input[name="login_username"]:not([id])');
      if ((await uname.count()) === 0) {
        const name = await this.username(page);
        this.loginPhase = 'idle';
        if (name) return { ok: true, username: name };
        return { ok: false, error: 'Форма входа не найдена.' };
      }

      // Собственная phpBB-капча rutracker (не Cloudflare).
      if (await page.$('input[name="cap_sid"]')) {
        this.loginPhase = 'idle';
        return { ok: false, captcha: true, error: 'Требуется капча rutracker.org.' };
      }

      await uname.waitFor({ state: 'visible', timeout: 20000 });
      await uname.fill(username);
      await page.locator('input[name="login_password"]:not([id])').fill(password);

      // Форма заполнена, жмём вход — переключаем статус на «логинимся».
      this.loginPhase = 'login';

      // Критерий успеха — смена/появление сессионной куки bb_session (или bb_uid),
      // а не чтение #logged-in-username после слепого sleep. Реактивно и не зависит
      // от рендера шапки/скорости ноды.
      const prevSession = await this.sessionValue('bb_session');
      await Promise.all([
        page.waitForLoadState('domcontentloaded', { timeout: 60000 }).catch(() => {}),
        page.locator('input[name="login"]:not([id])').click(),
      ]);

      const ok = await this.waitForLoginCookie(page, prevSession, 15000);
      this.loginPhase = 'idle';
      if (ok) {
        const name = (await this.username(page)) ?? username;
        return { ok: true, username: name };
      }
      return { ok: false, error: 'Не удалось войти. Проверьте логин/пароль.' };
    });
  }

  private async sessionValue(name: string): Promise<string | null> {
    try {
      const c = await this.context!.cookies();
      return c.find((x) => x.name === name)?.value ?? null;
    } catch {
      return null;
    }
  }

  // Ждёт появления/смены сессионной куки (bb_session/bb_uid) — это и есть успешный
  // вход. Если вернулась форма (неверный пароль) или таймаут — false.
  private async waitForLoginCookie(
    page: Page,
    prevSession: string | null,
    timeoutMs: number,
  ): Promise<boolean> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const session = await this.sessionValue('bb_session');
      const uid = await this.sessionValue('bb_uid');
      const newSession = session !== null && session !== prevSession;
      if (newSession || uid !== null) return true;
      // Пароль неверный: форма вернулась, а кука не сменилась.
      if (await page.$('input[name="login_password"]').catch(() => null)) return false;
      await sleep(300);
    }
    return false;
  }

  async fetchHtml(url: string, signal?: AbortSignal, waitFor?: string): Promise<string> {
    await this.ensure();
    if (signal?.aborted) throw new Error('Aborted');
    return this.serialize(async () => {
      if (signal?.aborted) throw new Error('Aborted');
      const page = await this.page();
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });
      if (signal?.aborted) throw new Error('Aborted');

      const cleared = await this.waitChallengeClear(page);
      if (signal?.aborted) throw new Error('Aborted');
      if (!cleared) {
        throw new Error('Cloudflare challenge не пройден (таймаут).');
      }

      if (waitFor) {
        await page.waitForSelector(waitFor, { timeout: 15000 }).catch(() => {});
        if (signal?.aborted) throw new Error('Aborted');
      }

      for (let attempt = 0; attempt < 4; attempt++) {
        if (signal?.aborted) throw new Error('Aborted');
        try {
          const p = await this.page();
          return await p.content();
        } catch (e) {
          if (signal?.aborted) throw new Error('Aborted');
          if (attempt === 3) throw e;
          await sleep(3000);
        }
      }
      throw new Error('unreachable');
    });
  }

  // Качает бинарный файл через сетевой стек браузера (Cloudflare-совместимо).
  async downloadFile(url: string): Promise<Buffer> {
    await this.ensure();
    return this.serialize(async () => {
      const page = await this.page();
      if (!page.url().startsWith(BASE_URL)) {
        await page.goto(INDEX_URL, { waitUntil: 'domcontentloaded', timeout: 60000 });
        await this.waitChallengeClear(page);
      }
      const bytes = await page.evaluate(async (u) => {
        const res = await fetch(u, { credentials: 'include' });
        const ct = res.headers.get('content-type') ?? '';
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        if (ct.includes('text/html')) throw new Error('challenge-html');
        const buf = await res.arrayBuffer();
        return Array.from(new Uint8Array(buf));
      }, url);
      return Buffer.from(bytes);
    });
  }

  isReady(): boolean {
    return !!(this.browser && this.context);
  }

  // Фаза логина для UI: 'cloudflare' | 'login' | 'idle'.
  getLoginPhase(): 'idle' | 'cloudflare' | 'login' {
    return this.loginPhase;
  }

  async getCookies(): Promise<string[]> {
    await this.ensure();
    const cookies = await this.context!.cookies();
    return cookies.map((c) => `${c.name}=${c.value}`);
  }

  async setCookies(cookies: string[]): Promise<void> {
    await this.ensure();
    const parsed = cookies
      .map((c) => {
        const i = c.indexOf('=');
        if (i < 0) return null;
        return {
          name: c.slice(0, i).trim(),
          value: c.slice(i + 1).trim(),
          domain: '.rutracker.org',
          path: '/',
        };
      })
      .filter((c): c is { name: string; value: string; domain: string; path: string } => c !== null);
    if (parsed.length) await this.context!.addCookies(parsed);
  }

  // Восстанавливает куки из session.json в живой контекст браузера (один раз за
  // запуск). Благодаря cf_clearance (живёт ~30 мин и привязан к IP+UA) после
  // рестарта index.php открывается без повторного Cloudflare-челленджа, и авто-логин
  // с профиля не тратит ~40с на решение капчи.
  async restoreSession(cookies: string[]): Promise<void> {
    if (this.sessionRestored) return;
    await this.setCookies(cookies);
    this.sessionRestored = true;
  }

  async clearCookies(): Promise<void> {
    if (!this.context) return;
    await this.context.clearCookies();
  }

  async close(): Promise<void> {
    try {
      await this.browser?.close();
    } catch {
      /* ignore */
    }
    this.browser = null;
    this.context = null;
    try {
      this.chromeProc?.kill();
    } catch {
      /* ignore */
    }
    this.chromeProc = null;
  }
}

export const browserManager = new BrowserManager();
