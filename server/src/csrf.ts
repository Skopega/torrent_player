import type { NextFunction, Request, Response } from 'express';

// CSRF-защита «деструктивных» эндпоинтов (shutdown/чистка кеша): браузер не должен
// позволять чужому сайту дёргать их через cross-origin POST. CLI/curl и панель
// (не браузер, заголовков Origin/Sec-Fetch-Site не шлют) продолжают работать —
// отклоняем только явно кросс-сайтовые браузерные запросы.
export function sameOriginGuard(req: Request, res: Response, next: NextFunction): void {
  const method = (req.method ?? '').toUpperCase();
  if (method === 'GET' || method === 'HEAD' || method === 'OPTIONS') {
    next();
    return;
  }

  // Браузеры шлют Sec-Fetch-Site для fetch и для обычного form POST. cross-site —
  // запрос инициирован чужой страницей (атака). same-origin/same-site/none — легитимно.
  const fetchSite = req.headers['sec-fetch-site'];
  if (typeof fetchSite === 'string' && fetchSite.trim().toLowerCase() === 'cross-site') {
    res.status(403).json({ error: 'forbidden' });
    return;
  }

  // Для браузеров без Sec-Fetch-* сверяем Origin с Host запроса. `null`-origin
  // (data:/sandbox-iframe) и несовпадение хостов считаем внешним запросом.
  const origin = req.headers.origin;
  if (typeof origin === 'string' && origin) {
    let originHost = '';
    try {
      originHost = new URL(origin).hostname.toLowerCase();
    } catch {
      originHost = '';
    }
    const hostHeader = String(req.headers.host ?? '');
    const hostHost = hostHeader.split(':')[0].toLowerCase();
    if (!originHost || originHost !== hostHost) {
      res.status(403).json({ error: 'forbidden' });
      return;
    }
  }

  next();
}
