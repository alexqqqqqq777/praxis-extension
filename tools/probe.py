#!/usr/bin/env python3
"""Синтетична перевірка вітрини: жива чи ні, і скільки думає.

Ставиться на шлюзі (VPS), бо саме звідти видно те саме, що й юристові.
Три цілі, і кожна відповідає на своє питання:

  public  — https через nginx. Це те, що бачить юрист. Червоне тут = «не працює»
  adv     — основний вузол по tailnet. Червоне = «лежить основний»
  studio  — запасний вузол по tailnet. Червоне = «запасного немає»

Різниця між ними і робить сповіщення осмисленим: «лежить adv, працюємо на
Studio» замість «щось не так».

## Чого тут немає

Запитів юриста. Взагалі. Пишемо лише власні синтетичні звернення: мітку часу,
код відповіді й мілісекунди. Ні адрес, ні шляхів, ні заголовків, ні тіл — і це
не тому, що ліньки, а тому, що обіцяно в PRIVACY.md. `/health` ключа не
потребує; додаткова перевірка картки бере спільний ключ вітрини (він і так
лежить у кожному розширенні).

## Сповіщення

Про ЗМІНУ СТАНУ, а не про кожну невдачу: впало — після двох поспіль, піднялось —
з першої вдалої. Інакше перше ж мережеве тремтіння навчить не читати сповіщень.

Канал — рішення власника; конструкція від нього не залежить. Команда з
PRAXIS_NOTIFY отримує текст останнім аргументом:

    PRAXIS_NOTIFY='/usr/local/bin/tg-send'   # бот, вебхук, mail — байдуже

Без неї зміни стану лишаються в базі й ідуть у stderr (тобто в journal).

    python3 tools/probe.py --once            # один прохід, для таймера
    python3 tools/probe.py --report          # p50/p95 за добу, день окремо від ночі
    python3 tools/probe.py --report --days 7
"""
import argparse
import datetime
import json
import os
import shlex
import sqlite3
import ssl
import subprocess
import sys
import time
import urllib.error
import urllib.request

DB = os.environ.get('PRAXIS_PROBE_DB', '/var/lib/praxis/probe.db')
PUBLIC = os.environ.get('PRAXIS_PUBLIC', 'https://praxis.51-83-129-254.sslip.io')
TARGETS = {
    'public': PUBLIC + '/health',
    'adv':    'http://100.70.93.113:8788/health',
    'studio': 'http://100.118.205.24:8788/health',
}
TIMEOUT = 10
DOWN_AFTER = 2          # невдач поспіль до сповіщення «впало»
KEEP_DAYS = 30
# «Ніч» — коли на Studio працюють нічні конвеєри (02:30–07:00) плюс запас.
# Ділити доба навпіл треба саме тут: інакше зайнятий диск розмиє денні числа.
NIGHT = (0, 8)          # [00:00, 08:00) за київським часом

SCHEMA = """
CREATE TABLE IF NOT EXISTS samples(
  ts INTEGER NOT NULL,          -- unix, секунди
  target TEXT NOT NULL,
  code INTEGER,                 -- HTTP-код або 0, якщо звʼязку немає
  ms INTEGER);
CREATE INDEX IF NOT EXISTS samples_i ON samples(target, ts);
CREATE TABLE IF NOT EXISTS state(
  target TEXT PRIMARY KEY,
  up INTEGER,                   -- 1 живий, 0 лежить
  fails INTEGER DEFAULT 0,
  since TEXT);
CREATE TABLE IF NOT EXISTS events(
  ts TEXT, target TEXT, up INTEGER, note TEXT);
"""


def kyiv(ts):
    """Київський час без залежностей: узимку +2, улітку +3.

    zoneinfo на голому сервері іноді без tzdata, а нам треба лише поділити добу
    на день і ніч — похибка в годину на межі переходу тут нічого не вирішує.
    """
    try:
        from zoneinfo import ZoneInfo
        return datetime.datetime.fromtimestamp(ts, ZoneInfo('Europe/Kyiv'))
    except Exception:                                          # noqa: BLE001
        d = datetime.datetime.utcfromtimestamp(ts)
        return d + datetime.timedelta(hours=3 if 3 <= d.month <= 10 else 2)


def db():
    os.makedirs(os.path.dirname(DB), exist_ok=True)
    conn = sqlite3.connect(DB, timeout=10)
    conn.executescript(SCHEMA)
    return conn


def hit(url):
    """(код, мілісекунди). Код 0 — звʼязку немає; тіло не читаємо далі за перевірку."""
    ctx = ssl.create_default_context()
    t0 = time.monotonic()
    try:
        req = urllib.request.Request(url, headers={'User-Agent': 'praxis-probe'})
        with urllib.request.urlopen(req, timeout=TIMEOUT, context=ctx) as r:
            body = r.read(4096)
            ms = int((time.monotonic() - t0) * 1000)
            try:
                ok = json.loads(body.decode('utf-8')).get('ok') is True
            except ValueError:
                ok = False
            return (r.status if ok else -r.status), ms
    except urllib.error.HTTPError as e:
        return e.code, int((time.monotonic() - t0) * 1000)
    except Exception:                                          # noqa: BLE001
        return 0, int((time.monotonic() - t0) * 1000)


def notify(text):
    cmd = os.environ.get('PRAXIS_NOTIFY', '').strip()
    print(text, file=sys.stderr)
    if not cmd:
        return
    try:
        subprocess.run(shlex.split(cmd) + [text], timeout=30, check=False)
    except Exception as e:                                     # noqa: BLE001
        print(f'сповіщення не пішло: {type(e).__name__}', file=sys.stderr)


def once(conn):
    now = int(time.time())
    seen = {}
    for name, url in TARGETS.items():
        code, ms = hit(url)
        conn.execute('INSERT INTO samples VALUES(?,?,?,?)', (now, name, code, ms))
        seen[name] = (code == 200, code, ms)

    prev = {r[0]: (r[1], r[2], r[3])
            for r in conn.execute('SELECT target, up, fails, since FROM state')}
    stamp = kyiv(now).isoformat(timespec='seconds')
    for name, (ok, code, ms) in seen.items():
        was_up, fails, since = prev.get(name, (1, 0, stamp))
        fails = 0 if ok else fails + 1
        up, changed = was_up, False
        if ok and not was_up:
            up, changed = 1, True
        elif not ok and was_up and fails >= DOWN_AFTER:
            up, changed = 0, True
        if changed:
            since = stamp
            conn.execute('INSERT INTO events VALUES(?,?,?,?)',
                         (stamp, name, up, f'{ms} мс' if up else f'код {code}'))
            notify(_line(name, bool(up), seen))
        conn.execute('INSERT OR REPLACE INTO state VALUES(?,?,?,?)', (name, up, fails, since))

    conn.execute('DELETE FROM samples WHERE ts < ?', (now - KEEP_DAYS * 86400,))
    conn.commit()
    return seen


def _line(name, up, seen):
    """Сповіщення однією фразою — із контекстом, а не «щось не так»."""
    who = {'public': 'вітрина (публічна адреса)', 'adv': 'основний вузол adv',
           'studio': 'запасний вузол Studio'}[name]
    head = f'{who}: {"піднялось" if up else "ЛЕЖИТЬ"}'
    others = []
    for k in ('public', 'adv', 'studio'):
        if k == name:
            continue
        ok, code, ms = seen[k]
        others.append(f'{k} {"ok " + str(ms) + " мс" if ok else "код " + str(code)}')
    return f'Praxis · {head}. Поруч: {"; ".join(others)}'


def pct(xs, p):
    if not xs:
        return None
    xs = sorted(xs)
    i = min(len(xs) - 1, max(0, int(round((p / 100) * len(xs) + 0.5)) - 1))
    return xs[i]


def report(conn, days):
    since = int(time.time()) - days * 86400
    rows = conn.execute('SELECT ts, target, code, ms FROM samples WHERE ts >= ? ORDER BY ts',
                        (since,)).fetchall()
    if not rows:
        print('замірів ще немає')
        return 0
    buckets = {}
    for ts, target, code, ms in rows:
        h = kyiv(ts).hour
        part = 'ніч' if NIGHT[0] <= h < NIGHT[1] else 'день'
        for key in ((target, part), (target, 'доба')):
            b = buckets.setdefault(key, {'n': 0, 'ok': 0, 'ms': []})
            b['n'] += 1
            if code == 200:
                b['ok'] += 1
                b['ms'].append(ms)

    span = (kyiv(rows[0][0]).strftime('%d.%m %H:%M'), kyiv(rows[-1][0]).strftime('%d.%m %H:%M'))
    print(f'заміри з {span[0]} по {span[1]} ({len(rows)} звернень)\n')
    print(f'{"ціль":<8} {"коли":<6} {"замірів":>8} {"живих":>7} {"p50":>7} {"p95":>7} {"макс":>7}')
    for target in TARGETS:
        for part in ('доба', 'день', 'ніч'):
            b = buckets.get((target, part))
            if not b:
                continue
            print(f'{target:<8} {part:<6} {b["n"]:>8} {100 * b["ok"] / b["n"]:>6.1f}% '
                  f'{pct(b["ms"], 50) or 0:>6} {pct(b["ms"], 95) or 0:>6} '
                  f'{max(b["ms"]) if b["ms"] else 0:>6}')
    # Головне питання, заради якого це й міряється.
    day = {t: pct(buckets.get((t, 'день'), {'ms': []})['ms'], 95) for t in ('adv', 'studio')}
    if day['adv'] and day['studio']:
        print(f'\nудень p95: adv {day["adv"]} мс, Studio {day["studio"]} мс', end=' — ')
        if day['studio'] * 2 <= day['adv']:
            print('запасна швидша щонайменше вдвічі; є про що говорити з власником')
        elif day['adv'] * 2 <= day['studio']:
            print('основна швидша щонайменше вдвічі; ролі правильні')
        else:
            print('різниця не варта зміни ролей')
    ev = conn.execute('SELECT ts, target, up, note FROM events ORDER BY ts DESC LIMIT 10').fetchall()
    if ev:
        print('\nостанні зміни стану:')
        for ts, target, up, note in ev:
            print(f'  {ts}  {target:<7} {"піднялось" if up else "ЛЕЖИТЬ":<9} {note}')
    return 0


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--once', action='store_true', help='один прохід (для systemd-таймера)')
    ap.add_argument('--report', action='store_true')
    ap.add_argument('--days', type=int, default=1)
    a = ap.parse_args()
    conn = db()
    if a.report:
        return report(conn, a.days)
    seen = once(conn)
    print(' '.join(f'{k}={"ok" if v[0] else v[1]}/{v[2]}мс' for k, v in seen.items()))
    return 0


if __name__ == '__main__':
    sys.exit(main())
