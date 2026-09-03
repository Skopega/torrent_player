import { useCallback, useEffect, useRef, useState } from 'react';
import type { CSSProperties } from 'react';
import { api } from '../api';
import type { VpnStatus } from '../types';

// Выпадающее меню vless-прокси в шапке: подписка по ссылке и/или вставка
// конфигов вручную, пинг до ipinfo (страна выхода) по каждой ноде, выбор ноды.
export function ProxyDropdown() {
  const [status, setStatus] = useState<VpnStatus | null>(null);
  const [open, setOpen] = useState(false);
  const [url, setUrl] = useState('');
  const [confText, setConfText] = useState('');
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const ref = useRef<HTMLDivElement>(null);
  const pollRef = useRef<number>(0);

  const refresh = useCallback(async () => {
    try {
      const s = await api.vpnStatus();
      setStatus(s);
      setUrl((prev) => prev || s.subscriptionUrl);
    } catch {
      /* ignore */
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', onDoc);
    return () => document.removeEventListener('mousedown', onDoc);
  }, [open]);

  // Пока идёт проверка пингов — опрашиваем статус.
  useEffect(() => {
    if (!status?.checking) return;
    pollRef.current = window.setInterval(() => void refresh(), 1500);
    return () => {
      if (pollRef.current) {
        window.clearInterval(pollRef.current);
        pollRef.current = 0;
      }
    };
  }, [status?.checking, refresh]);

  const parseSub = async () => {
    setBusy(true);
    setActionError(null);
    try {
      const s = await api.vpnConfig(url);
      setStatus(s);
      if (s.nodes.length) await api.vpnCheck();
      await refresh();
    } catch (e) {
      setActionError(e instanceof Error ? e.message : 'Ошибка');
    } finally {
      setBusy(false);
    }
  };

  const addConfigs = async () => {
    setBusy(true);
    setActionError(null);
    try {
      const s = await api.vpnAddConfigs(confText);
      setConfText('');
      setStatus(s);
      if (s.nodes.length) await api.vpnCheck();
      await refresh();
    } catch (e) {
      setActionError(e instanceof Error ? e.message : 'Ошибка');
    } finally {
      setBusy(false);
    }
  };

  const pingAll = async () => {
    setActionError(null);
    try {
      await api.vpnCheck();
      await refresh();
    } catch (e) {
      setActionError(e instanceof Error ? e.message : 'Ошибка');
    }
  };

  const select = async (name: string) => {
    setActionError(null);
    try {
      let s = await api.vpnSelect(name);
      if (!s.enabled) s = await api.vpnEnable(true);
      setStatus(s);
    } catch (e) {
      setActionError(e instanceof Error ? e.message : 'Ошибка');
    }
  };

  const toggle = async () => {
    setActionError(null);
    try {
      setStatus(await api.vpnEnable(!(status?.enabled ?? false)));
    } catch (e) {
      setActionError(e instanceof Error ? e.message : 'Ошибка');
    }
  };

  const remove = async (name: string) => {
    setActionError(null);
    try {
      setStatus(await api.vpnRemove(name));
    } catch (e) {
      setActionError(e instanceof Error ? e.message : 'Ошибка');
    }
  };

  const enabled = status?.enabled ?? false;
  const up = status?.proxyUp ?? false;
  const selected = status?.nodes.find((n) => n.name === status?.selectedName);

  const label = enabled
    ? up
      ? selected
        ? `VPN ${selected.name}${selected.pingMs != null ? ` · ${selected.pingMs}мс` : ''}`
        : 'VPN вкл'
      : 'VPN (вкл)'
    : 'VPN выкл';

  return (
    <div className="login" ref={ref}>
      <button
        className={`login-btn ${enabled && up ? 'logged' : ''}`}
        onClick={() => setOpen((v) => !v)}
        title={label}
      >
        <span className="avatar">{enabled ? 'V' : '—'}</span>
      </button>

      {open && (
        <div className="dropdown wide">
          <h3>Прокси (vless)</h3>

          <label>Ссылка на подписку</label>
          <textarea
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            placeholder="https://…/sub"
            style={textareaStyle}
          />
          <button
            className="btn"
            onClick={parseSub}
            disabled={busy || !url.trim() || status?.checking}
          >
            {busy ? 'Парсим…' : 'Парсить подписку'}
          </button>

          <label>Или вставьте конфиги vless:// (по одному на строку)</label>
          <textarea
            value={confText}
            onChange={(e) => setConfText(e.target.value)}
            placeholder={'vless://uuid@host:443?security=reality&…#Название'}
            style={{ ...textareaStyle, minHeight: 70, fontFamily: 'monospace', fontSize: 11 }}
          />
          <button
            className="btn"
            onClick={addConfigs}
            disabled={busy || !confText.trim() || status?.checking}
          >
            {busy ? 'Добавляем…' : 'Добавить конфиги'}
          </button>

          {status && status.nodes.length > 0 && (
            <button className="btn ghost" onClick={pingAll} disabled={status.checking || busy}>
              {status.checking ? 'Проверяем пинг…' : 'Проверить пинг всех'}
            </button>
          )}

          {actionError && <p className="error">{actionError}</p>}
          {status?.error && !actionError && <p className="error">{status.error}</p>}
          {!status?.error && !enabled && status && status.nodes.length > 0 && (
            <p className="hint">Rutracker не пускает с RU IP — выберите конфиг.</p>
          )}

          {status && status.nodes.length > 0 && (
            <div className="vpn-nodes">
              {status.nodes.map((n) => (
                <div
                  key={n.name}
                  className={`vpn-node ${status.selectedName === n.name ? 'sel' : ''}`}
                >
                  <button
                    className="vpn-node-main"
                    onClick={() => select(n.name)}
                    disabled={status.checking}
                    title={n.error || n.name}
                  >
                    <span className="vpn-node-name">{n.name}</span>
                    <span className="vpn-node-meta">
                      {n.country ? (
                        <span
                          className={`vpn-node-country${n.country === 'RU' ? ' ru' : ''}`}
                        >
                          {n.country}
                        </span>
                      ) : null}
                      <span className="vpn-node-ping">
                        {n.pingMs != null ? `${n.pingMs} мс` : n.ok ? '…' : '—'}
                      </span>
                    </span>
                  </button>
                  <button
                    className="vpn-node-x"
                    onClick={() => remove(n.name)}
                    disabled={status.checking}
                    title="Удалить конфиг"
                    aria-label="Удалить конфиг"
                  >
                    ×
                  </button>
                </div>
              ))}
            </div>
          )}

          <button className="btn ghost" onClick={toggle}>
            {enabled ? 'Отключить прокси' : 'Включить прокси'}
          </button>
        </div>
      )}
    </div>
  );
}

const textareaStyle: CSSProperties = {
  width: '100%',
  minHeight: 54,
  resize: 'vertical',
  background: 'var(--bg-elevated)',
  border: '1px solid var(--border)',
  color: 'var(--text)',
  borderRadius: 8,
  padding: 8,
  fontSize: 13,
  fontFamily: 'inherit',
};
