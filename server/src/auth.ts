import { Store } from './store.js';
import { BrowserManager } from './browser.js';
import { log } from './logger.js';
import type { AuthStatus } from './types.js';

export interface LoginResult {
  ok: boolean;
  captcha?: boolean;
  username?: string;
  error?: string;
}

export class Auth {
  private loggedInCache: boolean | null = null;

  constructor(
    private store: Store,
    private browser: BrowserManager,
  ) {}

  async verify(): Promise<AuthStatus> {
    try {
      const username = await this.browser.currentUsername();
      this.loggedInCache = !!username;
      return { loggedIn: !!username, username };
    } catch {
      return { loggedIn: false, username: null };
    }
  }

  async login(username: string, password: string): Promise<LoginResult> {
    const result = await this.browser.login(username, password);

    if (result.ok) {
      const cookies = await this.browser.getCookies();
      this.store.setSession({
        username: result.username ?? username,
        password,
        cookies,
      });
      this.loggedInCache = true;
      log.info(`[auth] login ok as "${result.username}"`);
      return { ok: true, username: result.username ?? username };
    }

    this.loggedInCache = false;
    log.warn(`[auth] login failed: ${result.error ?? 'unknown'}`);
    return {
      ok: false,
      captcha: result.captcha,
      error: result.error,
    };
  }

  async loginWithCookie(cookie: string): Promise<LoginResult> {
    const cookies = cookie
      .split(/[;\n]/)
      .map((c) => c.trim())
      .filter((c) => c.includes('='));

    await this.browser.setCookies(cookies);

    const status = await this.verify();
    if (!status.loggedIn) {
      return { ok: false, error: 'Не удалось войти по cookie.' };
    }

    const session = this.store.getSession();
    this.store.setSession({
      username: session?.username ?? status.username ?? '',
      password: session?.password ?? '',
      cookies: await this.browser.getCookies(),
    });
    return { ok: true, username: status.username ?? undefined };
  }

  async logout(): Promise<void> {
    this.loggedInCache = false;
    this.store.clearSession();
    await this.browser.clearCookies();
    await this.browser.close();
  }

  async ensureLoggedIn(): Promise<boolean> {
    if (this.loggedInCache === true) return true;

    const session = this.store.getSession();
    // После рестарта/холодного старта Chrome-профиль пустой (cf_clearance живёт в нём),
    // а куки сессии хранятся в session.json. Восстанавливаем их в браузер, чтобы
    // index.php открылся без повторного Cloudflare-челленджа.
    if (session?.cookies?.length) {
      await this.browser.restoreSession(session.cookies);
    }

    if (await this.browser.isLoggedIn()) {
      this.loggedInCache = true;
      return true;
    }

    this.loggedInCache = false;
    if (session && session.username && session.password) {
      const res = await this.login(session.username, session.password);
      return res.ok;
    }
    return false;
  }
}
