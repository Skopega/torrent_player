// VpnManager: конфиг подписки (data/vpn.json), ноды, пинг до rutracker,
// выбор активной ноды, подъём xray, undici ProxyAgent для HttpClient/браузера.

import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { ProxyAgent, fetch as ufetch } from 'undici';
import { DATA_DIR } from '../store.js';
import { log } from '../logger.js';
import { XrayManager } from './xray.js';
import { fetchVlessNodes, extractVlessNodes, isPlaceholderNode } from './subscription.js';
import { parseNode } from './vless.js';
import type { VpnProxy, VpnStatus, VpnNodeInfo } from './types.js';

const RUTRACKER_PROBE = 'https://rutracker.org/forum/';
// Проверка нод идёт через ipinfo: виден ip выхода и страна (для rutracker нужен не-RU).
const IPINFO_PROBE = 'https://ipinfo.io/json';
const HEALTH_INTERVAL_MS = 30_000;
const CHECK_CONCURRENCY = 3;
const PROBE_TIMEOUT_MS = 8000;

interface PersistedNode {
  name: string;
  uri: string;
  pingMs: number | null;
  ok: boolean;
  country: string;
  error: string;
}

interface VpnConfigFile {
  subscriptionUrl: string;
  hwid: string;
  enabled: boolean;
  selectedName: string | null;
  // Ноды из подписки (перезаписываются при refresh).
  nodes: PersistedNode[];
  // Ноды, вставленные пользователем вручную (vless:// строки).
  manualNodes: PersistedNode[];
  lastCheckedAt: number;
  error: string;
}

function readJson<T>(file: string, fallback: T): T {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf-8')) as T;
  } catch {
    return fallback;
  }
}

function writeJson(file: string, data: unknown): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf-8');
  fs.renameSync(tmp, file);
}

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.once('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const addr = srv.address() as net.AddressInfo;
      srv.close(() => resolve(addr.port));
    });
  });
}

export class VpnManager implements VpnProxy {
  private readonly cfgPath: string;
  private cfg: VpnConfigFile;
  private active: XrayManager | null = null;
  private agent: ProxyAgent | null = null;
  private healthTimer: NodeJS.Timeout | null = null;
  private healthFails = 0;
  private checking = false;
  private readonly httpPort: number;

  constructor() {
    this.cfgPath = path.join(DATA_DIR, 'vpn.json');
    this.cfg = readJson<VpnConfigFile>(this.cfgPath, {
      subscriptionUrl: '',
      hwid: '',
      enabled: false,
      selectedName: null,
      nodes: [],
      manualNodes: [],
      lastCheckedAt: 0,
      error: '',
    });
    // Нормализация старого файла конфига (поля могли отсутствовать).
    if (!Array.isArray(this.cfg.nodes)) this.cfg.nodes = [];
    if (!Array.isArray(this.cfg.manualNodes)) this.cfg.manualNodes = [];
    if (!this.cfg.hwid || this.cfg.hwid.length < 10) {
      this.cfg.hwid = randomUUID();
      this.save();
    }
    this.httpPort = Number(process.env.XRAY_HTTP_PORT) || 10809;
  }

  private save(): void {
    writeJson(this.cfgPath, this.cfg);
  }

  private proxyUrl(): string {
    return `http://127.0.0.1:${this.httpPort}`;
  }

  isEnabled(): boolean {
    return this.cfg.enabled;
  }

  getDispatcher(): unknown {
    return this.agent;
  }

  httpProxyUrl(): string | null {
    return this.cfg.enabled && this.active?.running ? this.proxyUrl() : null;
  }

  // Общий список: ручные конфиги сверху, затем из подписки. Дедуп по имени.
  private allNodes(): PersistedNode[] {
    const seen = new Set<string>();
    const out: PersistedNode[] = [];
    for (const n of [...this.cfg.manualNodes, ...this.cfg.nodes]) {
      if (seen.has(n.name)) continue;
      seen.add(n.name);
      out.push(n);
    }
    return out;
  }

  // Вставляет вручную введённые vless:// строки (по одной на строку).
  // Возвращает число добавленных; уже существующие пропускаются.
  addManualConfigs(text: string): number {
    const known = new Set<string>();
    for (const n of this.allNodes()) {
      known.add(n.uri);
      known.add(n.name);
    }
    let added = 0;
    const fresh: PersistedNode[] = [];
    for (const uri of extractVlessNodes(text)) {
      if (!uri.toLowerCase().startsWith('vless://')) continue;
      if (isPlaceholderNode(uri)) continue;
      if (known.has(uri)) continue;
      const p = parseNode(uri);
      if (!p) continue;
      if (known.has(p.name)) continue;
      known.add(uri);
      known.add(p.name);
      fresh.push({ name: p.name, uri, pingMs: null, ok: false, country: '', error: '' });
      added++;
    }
    if (added > 0) {
      this.cfg.manualNodes = [...this.cfg.manualNodes, ...fresh];
      this.cfg.error = '';
      this.save();
    }
    return added;
  }

  // Удаляет ноду (ручную или из подписки). true, если нода была удалена.
  removeNode(name: string): boolean {
    let idx = this.cfg.manualNodes.findIndex((n) => n.name === name);
    if (idx >= 0) {
      this.cfg.manualNodes.splice(idx, 1);
    } else {
      idx = this.cfg.nodes.findIndex((n) => n.name === name);
      if (idx < 0) return false;
      this.cfg.nodes.splice(idx, 1);
    }
    if (this.cfg.selectedName === name) {
      // Активная нода удалена — глушим прокси и выключаем её.
      this.cfg.selectedName = null;
      this.cfg.enabled = false;
      void this.stopActive();
    }
    this.cfg.error = '';
    this.save();
    return true;
  }

  // ---------- жизненный цикл активной прокси ----------

  async ensureReady(): Promise<boolean> {
    if (!this.cfg.enabled) return true;
    if (this.active?.running) return true;
    const node = this.selectedNode() ?? this.bestNode() ?? this.allNodes()[0] ?? null;
    if (!node) {
      this.cfg.error = 'Нет нод. Добавьте подписку или вставьте vless-конфиги.';
      this.save();
      return false;
    }
    try {
      await this.startActive(node);
      return true;
    } catch (e) {
      this.cfg.error = e instanceof Error ? e.message : String(e);
      this.save();
      log.error(`[vpn] proxy start failed: ${this.cfg.error}`);
      return false;
    }
  }

  private async startActive(node: PersistedNode): Promise<void> {
    await this.stopActive();
    const parsed = parseNode(node.uri);
    if (!parsed) throw new Error(`Нераспознанная нода: ${node.name}`);
    const xr = new XrayManager(this.httpPort);
    await xr.start(parsed, node.name);
    this.active = xr;
    this.agent?.close().catch(() => {});
    this.agent = new ProxyAgent(this.proxyUrl());
    this.cfg.selectedName = node.name;
    this.cfg.error = '';
    this.healthFails = 0;
    this.save();
    this.startHealth();
  }

  private async stopActive(): Promise<void> {
    if (this.healthTimer) {
      clearInterval(this.healthTimer);
      this.healthTimer = null;
    }
    if (this.agent) {
      this.agent.close().catch(() => {});
      this.agent = null;
    }
    const xr = this.active;
    this.active = null;
    if (xr) await xr.stop();
  }

  private startHealth(): void {
    if (this.healthTimer) clearInterval(this.healthTimer);
    this.healthTimer = setInterval(() => {
      void this.healthCheck();
    }, HEALTH_INTERVAL_MS);
    this.healthTimer.unref?.();
  }

  private async healthCheck(): Promise<void> {
    if (!this.active?.running || !this.agent) return;
    try {
      const res = await ufetch(RUTRACKER_PROBE, {
        method: 'HEAD',
        dispatcher: this.agent,
        signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
      });
      if (res.status < 500) {
        this.healthFails = 0;
        return;
      }
    } catch {
      /* ниже считаем провал */
    }
    this.healthFails++;
    if (this.healthFails >= 2) {
      log.warn('[vpn] health check failed 2x — restarting xray');
      const node = this.selectedNode();
      if (node) {
        try {
          await this.startActive(node);
        } catch (e) {
          this.cfg.error = e instanceof Error ? e.message : String(e);
          this.save();
          log.error(`[vpn] restart failed: ${this.cfg.error}`);
        }
      }
    }
  }

  // ---------- управление конфигом ----------

  setEnabled(v: boolean): void {
    if (this.cfg.enabled === v) return;
    this.cfg.enabled = v;
    this.save();
    if (v) {
      void this.ensureReady().then((ok) => {
        if (!ok) log.warn(`[vpn] enable failed: ${this.cfg.error}`);
      });
    } else {
      void this.stopActive();
    }
  }

  setSubscription(url: string): void {
    this.cfg.subscriptionUrl = url.trim();
    this.save();
  }

  async refreshNodes(): Promise<number> {
    if (!this.cfg.subscriptionUrl) throw new Error('Нет ссылки на подписку.');
    this.cfg.error = '';
    this.save();
    const uris = await fetchVlessNodes(this.cfg.subscriptionUrl, this.cfg.hwid);
    if (!uris.length) throw new Error('В подписке нет vless-конфигов.');

    const prev = new Map(this.cfg.nodes.map((n) => [n.name, n]));
    const nodes: PersistedNode[] = [];
    for (const uri of uris) {
      const p = parseNode(uri);
      if (!p) continue;
      const entry: PersistedNode = { name: p.name, uri, pingMs: null, ok: false, country: '', error: '' };
      const old = prev.get(p.name);
      if (old) {
        entry.pingMs = old.pingMs;
        entry.ok = old.ok;
        entry.country = old.country;
        entry.error = old.error;
      }
      nodes.push(entry);
    }
    this.cfg.nodes = nodes;
    if (this.cfg.selectedName && !this.allNodes().some((n) => n.name === this.cfg.selectedName)) {
      this.cfg.selectedName = null;
    }
    this.save();
    return nodes.length;
  }

  // Фоновый пинг до rutracker по каждой ноде. Результаты пишутся по мере готовности.
  checkNodes(): void {
    if (this.checking) return;
    if (!this.allNodes().length) {
      this.cfg.error = 'Нет нод. Добавьте подписку или вставьте vless-конфиги.';
      this.save();
      return;
    }
    this.checking = true;
    this.save();
    void this.runCheck()
      .catch((e) => {
        this.cfg.error = e instanceof Error ? e.message : String(e);
      })
      .finally(() => {
        this.checking = false;
        this.cfg.lastCheckedAt = Date.now();
        this.save();
      });
  }

  private async runCheck(): Promise<void> {
    const nodes = this.allNodes();
    let cursor = 0;
    const workers = Array.from({ length: Math.min(CHECK_CONCURRENCY, nodes.length) }, async () => {
      while (cursor < nodes.length) {
        const node = nodes[cursor++];
        await this.probeNode(node);
      }
    });
    await Promise.all(workers);
  }

  private async probeNode(node: PersistedNode): Promise<void> {
    const parsed = parseNode(node.uri);
    if (!parsed) {
      node.ok = false;
      node.country = '';
      node.error = 'неверный формат';
      node.pingMs = null;
      return;
    }
    const port = await freePort();
    const xr = new XrayManager(port);
    const started = Date.now();
    try {
      await xr.start(parsed, node.name);
      const agent = new ProxyAgent(`http://127.0.0.1:${port}`);
      try {
        // Запрос к ipinfo через ноду: виден ip выхода и страна.
        const res = await ufetch(IPINFO_PROBE, {
          method: 'GET',
          dispatcher: agent,
          headers: { 'User-Agent': 'Mozilla/5.0', Accept: 'application/json' },
          signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
        });
        node.pingMs = Date.now() - started;
        if (res.ok) {
          const data = (await res.json()) as { country?: unknown };
          node.ok = true;
          node.country = typeof data.country === 'string' ? data.country : '';
          node.error = node.country ? '' : 'нет данных о стране';
        } else {
          node.ok = false;
          node.country = '';
          node.error = `HTTP ${res.status}`;
        }
      } finally {
        agent.close().catch(() => {});
      }
    } catch (e) {
      node.pingMs = Date.now() - started;
      node.ok = false;
      node.country = '';
      node.error = (e instanceof Error ? e.message : String(e)).slice(0, 200);
    } finally {
      await xr.stop().catch(() => {});
    }
  }

  selectNode(name: string): void {
    const node = this.allNodes().find((n) => n.name === name);
    if (!node) throw new Error(`Нода не найдена: ${name}`);
    this.cfg.selectedName = name;
    this.save();
    if (!this.cfg.enabled) return;
    if (this.active?.running) {
      void (async () => {
        try {
          await this.startActive(node);
        } catch (e) {
          this.cfg.error = e instanceof Error ? e.message : String(e);
          this.save();
        }
      })();
    } else {
      void this.ensureReady();
    }
  }

  // Проверка активного прокси (кнопка «Проверить» / отладка).
  async test(): Promise<{ ok: boolean; ms: number | null; error: string }> {
    if (!this.cfg.enabled) {
      if (!(await this.ensureReady())) {
        return { ok: false, ms: null, error: this.cfg.error || 'прокси не готов' };
      }
    }
    if (!this.agent || !this.active?.running) {
      return { ok: false, ms: null, error: 'прокси не поднят' };
    }
    const started = Date.now();
    try {
      const res = await ufetch(RUTRACKER_PROBE, {
        method: 'HEAD',
        dispatcher: this.agent,
        signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
      });
      return {
        ok: res.status < 500,
        ms: Date.now() - started,
        error: res.status < 500 ? '' : `HTTP ${res.status}`,
      };
    } catch (e) {
      return {
        ok: false,
        ms: Date.now() - started,
        error: e instanceof Error ? e.message : String(e),
      };
    }
  }

  status(): VpnStatus {
    const nodes: VpnNodeInfo[] = this.allNodes().map((n) => ({
      name: n.name,
      pingMs: n.pingMs,
      ok: n.ok,
      country: n.country ?? '',
      error: n.error,
    }));
    return {
      subscriptionUrl: this.cfg.subscriptionUrl,
      enabled: this.cfg.enabled,
      selectedName: this.cfg.selectedName,
      checking: this.checking,
      proxyUp: !!this.active?.running,
      error: this.cfg.error,
      nodes,
    };
  }

  private selectedNode(): PersistedNode | null {
    if (!this.cfg.selectedName) return null;
    return this.allNodes().find((n) => n.name === this.cfg.selectedName) ?? null;
  }

  private bestNode(): PersistedNode | null {
    let best: PersistedNode | null = null;
    let bestForeign: PersistedNode | null = null;
    for (const n of this.allNodes()) {
      if (!n.ok) continue;
      if (n.country !== 'RU') {
        if (!bestForeign || (n.pingMs != null && (bestForeign.pingMs == null || n.pingMs < bestForeign.pingMs))) {
          bestForeign = n;
        }
      }
      if (!best || (n.pingMs != null && (best.pingMs == null || n.pingMs < best.pingMs))) {
        best = n;
      }
    }
    // Для rutracker нужен не-российский выход.
    return bestForeign ?? best;
  }

  async close(): Promise<void> {
    if (this.healthTimer) {
      clearInterval(this.healthTimer);
      this.healthTimer = null;
    }
    await this.stopActive();
    this.save();
  }
}
