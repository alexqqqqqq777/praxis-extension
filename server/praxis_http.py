#!/usr/bin/env python3
"""praxis_http — транспортний шар вітрини Praxis.

Це єдиний код на сервері, який торкається запиту користувача: приймає його,
перевіряє ключ, віддає JSON. Він винесений в окремий файл навмисно — щоб усе,
що стосується приватності, читалося за десять хвилин і не губилося серед
півтори тисячі рядків вибірки.

Три речі, заради яких цей файл існує:

  1. **Журналу немає.** `log_message` і `log_error` порожні. Не «рівень
     логування вимкнено», не «пишемо без IP» — запис не формується взагалі.
     Перевірити можна так:

         >>> Handler.log_message(fake, '"%s" %s', 'GET /cards?article=625', '200')
         (у stderr 0 символів)

  2. **IP користувача сюди не доходить.** TLS термінує nginx, у його
     конфігурації `access_log off` і порожні `X-Real-IP` / `X-Forwarded-For`
     (див. deploy/nginx-praxis.conf). Записати те, чого не бачив, неможливо —
     це властивість схеми, а не обіцянка.

  3. **Ключ читається із заголовка**, а не з рядка запиту: у рядку він осідав
     би в журналі будь-якого проміжного вузла. `?key=` лишено тільки для
     локального прев'ю без розширення.

Модуль із вибіркою карток (`core`) передається сюди параметром і про запит
нічого не знає: він отримує вже розібрані аргументи — акт, статтю, фільтри.

Контракт core описаний у README.
"""
import argparse
import datetime
import hmac
import json
import os
import re
import sys
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlparse, parse_qs


def allow_origin(origin: str, allowed: list[str]) -> str | None:
    """Ехо дозволеного походження або None, якщо цьому сайту відповідати не можна.

    Без списку пускаємо розширення браузера й локальне прев'ю: звичайний сайт,
    відкритий у тій самій вкладці, вітрину опитати не зможе.
    """
    if not origin:
        return None                      # запит не з браузера — CORS не потрібен
    if origin in allowed:
        return origin
    if allowed:
        return None                      # явний список — і тільки він
    if origin.startswith('chrome-extension://') or origin.startswith('moz-extension://'):
        return origin
    if re.match(r'^http://(127\.0\.0\.1|localhost)(:\d+)?$', origin):
        return origin
    return None


def make_handler(core, token: str, origins: list[str]):
    """Збирає обробник під конкретний модуль вибірки."""

    class Handler(BaseHTTPRequestHandler):
        protocol_version = 'HTTP/1.1'
        server_version = 'cards_api'     # без версії: менше підказок сканерам
        sys_version = ''                 # і без «Python/3.12.7» у заголовку

        # ── журналу немає ────────────────────────────────────────────────
        def log_message(self, fmt, *args):
            return

        def log_error(self, fmt, *args):
            return

        # ── відповідь ────────────────────────────────────────────────────
        def _cors(self):
            ok = allow_origin(self.headers.get('Origin', ''), origins)
            self.send_header('Vary', 'Origin')
            if ok:
                self.send_header('Access-Control-Allow-Origin', ok)
                # Private Network Access: без цього https-сторінка не дістане 127.0.0.1
                self.send_header('Access-Control-Allow-Private-Network', 'true')

        def _send(self, code: int, payload: dict):
            body = json.dumps(payload, ensure_ascii=False).encode('utf-8')
            self.send_response(code)
            self.send_header('Content-Type', 'application/json; charset=utf-8')
            self.send_header('Content-Length', str(len(body)))
            self._cors()
            self.send_header('Cache-Control', 'no-store')
            self.send_header('Referrer-Policy', 'no-referrer')
            self.end_headers()
            self.wfile.write(body)

        def do_OPTIONS(self):
            self.send_response(204)
            self._cors()
            self.send_header('Access-Control-Allow-Headers', 'X-Praxis-Key, Content-Type')
            self.send_header('Access-Control-Max-Age', '600')
            self.send_header('Content-Length', '0')
            self.end_headers()

        def _authorized(self, q: dict) -> bool:
            if not token:
                return True
            got = self.headers.get('X-Praxis-Key') or (q.get('key') or [''])[0]
            return hmac.compare_digest(got, token)

        # ── маршрути ─────────────────────────────────────────────────────
        def do_GET(self):
            u = urlparse(self.path)
            q = parse_qs(u.query)
            arg = lambda name: (q.get(name) or [''])[0].strip()
            try:
                if token and u.path != '/health' and not self._authorized(q):
                    return self._send(401, {'error': 'need key'})

                if u.path == '/health':
                    # без ключа — лише «живий/ні»: шлях до бази не показуємо нікому
                    h = core.health()
                    return self._send(200, h if self._authorized(q) else {'ok': h.get('ok', False)})

                if u.path == '/articles':
                    act = arg('act')
                    if not act:
                        return self._send(400, {'error': 'need act'})
                    return self._send(200, core.get_counts(act, refresh=bool(q.get('refresh'))))

                if u.path == '/versions':
                    act = arg('act')
                    if not act:
                        return self._send(400, {'error': 'need act'})
                    return self._send(200, core.versions_count(act))

                if u.path == '/history':
                    act, article = arg('act'), arg('article')
                    if not act or not article:
                        return self._send(400, {'error': 'need act and article'})
                    part = q.get('part')
                    # сторінками: ст. 14 ПКУ — 73 редакції, усі одразу ніхто не читає
                    def num(name, default, lo, hi):
                        try:
                            return max(lo, min(hi, int(arg(name) or default)))
                        except ValueError:
                            return default
                    return self._send(200, core.article_history(
                        act, article, part[0] if part else None,
                        offset=num('offset', 0, 0, 10000),
                        limit=num('limit', 12, 1, 60)))

                if u.path == '/act':
                    nreg = arg('nreg')
                    if not nreg:
                        return self._send(400, {'error': 'need nreg'})
                    return self._send(200, core.act_info(nreg, arg('in') or None))

                if u.path == '/compare':
                    act, article = arg('act'), arg('article')
                    fr, to = arg('from'), arg('to')
                    if not act or not article or not fr or not to:
                        return self._send(400, {'error': 'need act, article, from, to'})
                    part = q.get('part')
                    return self._send(200, core.compare_dates(act, article, fr, to,
                                                              part[0] if part else None))

                if u.path == '/text':
                    act, article = arg('act'), arg('article')
                    if not act or not article:
                        return self._send(400, {'error': 'need act and article'})
                    on = arg('on') or datetime.date.today().isoformat()
                    return self._send(200, core.version_text(act, article, on))

                if u.path == '/norms':
                    act, article = arg('act'), arg('article')
                    if not act or not article:
                        return self._send(400, {'error': 'need act and article'})
                    return self._send(200, core.norms_map(act, article))

                if u.path == '/cards':
                    act, article = arg('act'), arg('article')
                    if not act or not article:
                        return self._send(400, {'error': 'need act and article'})
                    try:
                        limit = max(1, min(100, int((q.get('limit') or ['20'])[0])))
                    except ValueError:
                        limit = 20
                    part = q.get('part')
                    sort = arg('sort') or 'fresh'
                    if sort not in core.SORTS:
                        sort = 'fresh'
                    csv = lambda name: [x for x in arg(name).split(',') if x]
                    forms = tuple(int(x) for x in csv('forms')
                                  if x.isdigit() and int(x) in core.FORM_NAMES) or None
                    return self._send(200, core.get_cards(
                        act, article, limit, part[0] if part else None,
                        sort=sort,
                        jk=[x for x in csv('jk') if x in core.JUSTICE],
                        since=arg('since') or None,
                        q=arg('q') or None,                 # пошуковий рядок юриста
                        current_only=bool(q.get('current_only')),
                        courts=[x for x in csv('courts') if x in core.COURTS],
                        forms=forms,
                        flag=[x for x in csv('flag') if x in ('departure', 'actual')],
                        cat=arg('cat') or None))

                self._send(404, {'error': 'not found'})
            except Exception as e:                            # noqa: BLE001
                # текст помилки описує стан бази, а не користувача
                self._send(500, {'error': f'{type(e).__name__}: {e}'})

    return Handler


def add_arguments(ap: argparse.ArgumentParser):
    """Спільні для CLI прапорці транспорту."""
    ap.add_argument('--serve', action='store_true')
    ap.add_argument('--host', default='127.0.0.1',
                    help='типово лише локально; назовні виставляє nginx із TLS')
    ap.add_argument('--port', type=int, default=8787)
    ap.add_argument('--token', default=None,
                    help='вимагати ключ (або змінна PRAXIS_TOKEN)')


def serve(core, host: str, port: int, token: str = '', origins: list[str] | None = None):
    if origins is None:
        origins = [o.strip() for o in os.environ.get('PRAXIS_ORIGINS', '').split(',') if o.strip()]
    srv = ThreadingHTTPServer((host, port), make_handler(core, token, origins))
    srv.daemon_threads = True
    # єдине, що взагалі друкується, — рядок запуску; про запити не друкується нічого
    print(f'cards_api → http://{host}:{port}', file=sys.stderr)
    try:
        srv.serve_forever()
    except KeyboardInterrupt:
        pass
