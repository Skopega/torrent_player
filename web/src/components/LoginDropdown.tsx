import { useEffect, useRef, useState } from 'react';
import { api } from '../api';
import type { AuthStatus } from '../types';

export function LoginDropdown({
  auth,
  onAuth,
}: {
  auth: AuthStatus;
  onAuth: (a: AuthStatus) => void;
}) {
  const [open, setOpen] = useState(false);
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [cookie, setCookie] = useState('');
  const [mode, setMode] = useState<'login' | 'cookie'>('login');
  const [busy, setBusy] = useState(false);
  const [phase, setPhase] = useState<'idle' | 'cloudflare' | 'login'>('idle');
  const [error, setError] = useState<string | null>(null);
  const ref = useRef<HTMLDivElement>(null);

  // Пока идёт логин, опрашиваем фазу, чтобы кнопка показывала «Проходим Cloudflare…»
  // или «Логинимся…» по мере исполнения.
  useEffect(() => {
    if (!busy) {
      setPhase('idle');
      return;
    }
    let stop = false;
    const poll = async () => {
      if (stop) return;
      try {
        const p = await api.authProgress();
        if (!stop) setPhase(p);
      } catch {
        /* ignore */
      }
      if (!stop) timer = setTimeout(poll, 400);
    };
    let timer = setTimeout(poll, 300);
    return () => {
      stop = true;
      clearTimeout(timer);
    };
  }, [busy]);

  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', onDoc);
    return () => document.removeEventListener('mousedown', onDoc);
  }, [open]);

  const submitLogin = async () => {
    setBusy(true);
    setError(null);
    try {
      const res = await api.login(username, password);
      if (res.ok) {
        onAuth({ loggedIn: true, username: res.username ?? username });
        setOpen(false);
        setPassword('');
      } else if (res.captcha) {
        setError('Требуется капча. Вставьте cookie-строку ниже.');
        setMode('cookie');
      } else {
        setError(res.error ?? 'Ошибка входа');
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Ошибка входа');
    } finally {
      setBusy(false);
    }
  };

  const submitCookie = async () => {
    setBusy(true);
    setError(null);
    try {
      const res = await api.loginWithCookie(cookie);
      if (res.ok) {
        onAuth({ loggedIn: true, username: res.username ?? auth.username });
        setOpen(false);
        setCookie('');
      } else {
        setError(res.error ?? 'Ошибка входа');
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Ошибка входа');
    } finally {
      setBusy(false);
    }
  };

  const logout = async () => {
    await api.logout();
    onAuth({ loggedIn: false, username: null });
    setOpen(false);
  };

  const initial = auth.username ? auth.username[0].toUpperCase() : '?';

  return (
    <div className="login" ref={ref}>
      <button
        className={`login-btn ${auth.loggedIn ? 'logged' : ''}`}
        onClick={() => setOpen((v) => !v)}
        title={auth.username ?? 'Войти'}
      >
        <span className="avatar">{auth.loggedIn ? initial : '?'}</span>
      </button>

      {open && (
        <div className="dropdown">
          {auth.loggedIn ? (
            <>
              <h3>{auth.username}</h3>
              <button className="btn ghost" onClick={logout}>
                Выйти
              </button>
            </>
          ) : mode === 'login' ? (
            <>
              <h3>Вход на rutracker.org</h3>
              <label>Логин</label>
              <input
                value={username}
                onChange={(e) => setUsername(e.target.value)}
                autoComplete="username"
              />
              <label>Пароль</label>
              <input
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                autoComplete="current-password"
                onKeyDown={(e) => e.key === 'Enter' && submitLogin()}
              />
              {error && <p className="error">{error}</p>}
              <button className="btn" onClick={submitLogin} disabled={busy}>
                {busy
                  ? phase === 'login'
                    ? 'Логинимся…'
                    : 'Проходим Cloudflare…'
                  : 'Войти'}
              </button>
              <p className="hint">
                Капча?{' '}
                <span className="linklike" onClick={() => setMode('cookie')}>
                  Вставить cookie
                </span>
              </p>
            </>
          ) : (
            <>
              <h3>Вход по cookie</h3>
              <label>Cookie-строка (bb_data / bb_session)</label>
              <textarea
                value={cookie}
                onChange={(e) => setCookie(e.target.value)}
                style={{
                  width: '100%',
                  minHeight: 70,
                  resize: 'vertical',
                  background: 'var(--bg-elevated)',
                  border: '1px solid var(--border)',
                  color: 'var(--text)',
                  borderRadius: 8,
                  padding: 8,
                }}
              />
              {error && <p className="error">{error}</p>}
              <button className="btn" onClick={submitCookie} disabled={busy}>
                {busy ? '…' : 'Войти'}
              </button>
              <p className="hint">
                <span className="linklike" onClick={() => setMode('login')}>
                  Назад к логину
                </span>
              </p>
            </>
          )}
        </div>
      )}
    </div>
  );
}
