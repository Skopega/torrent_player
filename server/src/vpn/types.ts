// Общие интерфейсы VPN-модуля: контракт для HttpClient/браузера + статусы.

// Минимальный интерфейс прокси, которым пользуются HttpClient и BrowserManager.
export interface VpnProxy {
  // Включён ли прокси в конфиге (не проверяет, поднялся ли xray).
  isEnabled(): boolean;
  // Поднять активный прокси (xray на выбранной ноде), если нужно. true — готово.
  ensureReady(): Promise<boolean>;
  // undici ProxyAgent для активного прокси (null — если не активен).
  getDispatcher(): unknown;
  // URL http-прокси для Chrome (http://127.0.0.1:<port>) либо null.
  httpProxyUrl(): string | null;
}

export interface VpnNodeInfo {
  name: string;
  pingMs: number | null;
  ok: boolean;
  country: string;
  error: string;
}

export interface VpnStatus {
  subscriptionUrl: string;
  enabled: boolean;
  selectedName: string | null;
  checking: boolean;
  proxyUp: boolean;
  error: string;
  nodes: VpnNodeInfo[];
}
