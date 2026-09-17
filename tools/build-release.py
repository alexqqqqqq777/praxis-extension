#!/usr/bin/env python3
"""Збирає dist/ — те, що йде в Chrome Web Store.

Відмінності від робочої теки, кожна з причиною:

  • немає src/data.js — це демонстраційний набір із **вигаданими** номерами
    справ. У продукті для юриста вигаданої практики бути не може: коли вітрина
    мовчить, розширення каже «немає звʼязку» і не показує нічого;
  • немає дозволів на 127.0.0.1 і localhost — вони потрібні лише розробнику,
    а рецензента магазину змушують питати, навіщо розширення ходить у локальну
    мережу;
  • connect-src у CSP звужено до єдиної адреси вітрини;
  • у збірку вшивається ключ доступу до вітрини — без нього свіжа установка
    отримує 401 і не працює взагалі.

Про ключ прямо. Вшитий у розширення ключ **не є секретом**: будь-хто
розпакує пакет і прочитає його за хвилину. Він робить рівно дві речі —
не дає адресі вітрини бути відкритою навстіж для випадкового сканера і
дає змогу відкликати доступ, перевидавши розширення. Секретом його ніде
не називаємо.

Ключ спільний для всіх установок — і це навмисно. «Ключ на встановлення»
перетворив би його на стійкий ідентифікатор користувача, тобто на те
саме, чого ми пообіцяли не мати (див. docs/PRIVACY-AUDIT.md, B5).

Ключ у репозиторії не лежить: береться з PRAXIS_TOKEN або з --key.

Перед збіркою — чотири перевірки, і кожна колись була дефектом: замикання
(`nph`, 500 на кожен запит), компіляція на найстаршому обіцяному Python
(`str | None` на 3.9), цілість фікстури і димовий прогін на ній.

Запуск: PRAXIS_TOKEN=… python3 tools/build-release.py [--base https://…]
"""
import argparse, json, os, pathlib, shutil, subprocess, sys, urllib.error, urllib.request

ROOT = pathlib.Path(__file__).resolve().parent.parent
DIST = ROOT / 'dist'
DEFAULT_BASE = 'https://praxis.51-83-129-254.sslip.io'

# те, що фізично потрапляє в пакет
KEEP_SRC = ['api.js', 'background.js', 'content.js', 'page.css', 'popup.html',
            'popup.css', 'popup.js', 'rail.css']

# Найстарший Python, на якому обіцяно, що запуститься публічний сервер.
# Обіцянка не абстрактна: `praxis_http.py` місяць не імпортувався на 3.9 через
# `str | None` у підписі — на моїй машині 3.14 працювало бездоганно.
OLDEST = (3, 9)
PUBLIC_PY = ['server/cards_api.py', 'server/praxis_http.py']


def oldest_python():
    """Найстарший інтерпретатор, який є на машині, і його версія.

    Шукаємо саме найстарший, а не «якийсь третій пайтон»: перевірка має сенс
    лише тоді, коли компілює той, у кого найменше синтаксису. Системний
    /usr/bin/python3 на macOS буває старшим за все, що лежить у PATH, і саме
    на ньому колись не запустився публічний сервер, — тому він теж у переліку.
    """
    cands = ['/usr/bin/python3']
    for minor in range(OLDEST[1], sys.version_info.minor + 1):
        cands += [f'python3.{minor}', f'/usr/bin/python3.{minor}',
                  f'/opt/homebrew/bin/python3.{minor}']
    found = {}
    for cand in cands:
        exe = cand if cand.startswith('/') else shutil.which(cand)
        if not exe or not os.path.exists(exe):
            continue
        exe = os.path.realpath(exe)
        if exe in found:
            continue
        try:
            v = subprocess.run([exe, '-c', 'import sys;print("%d.%d" % sys.version_info[:2])'],
                               capture_output=True, text=True, timeout=20)
        except OSError:
            continue
        if v.returncode == 0:
            found[exe] = tuple(int(x) for x in v.stdout.strip().split('.'))
    if not found:
        return None, ''
    exe, ver = min(found.items(), key=lambda kv: kv[1])
    return exe, '.'.join(str(x) for x in ver)


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument('--base', default=DEFAULT_BASE, help='адреса вітрини')
    ap.add_argument('--key', default=os.environ.get('PRAXIS_TOKEN', ''),
                    help='ключ доступу до вітрини (або змінна PRAXIS_TOKEN)')
    ap.add_argument('--skip-checks', action='store_true',
                    help='без перевірок — лише коли зрізу немає під рукою')
    ap.add_argument('--dry-run', action='store_true',
                    help='лише перевірки, dist/ не чіпати')
    a = ap.parse_args()

    base = a.base.rstrip('/')
    if not base.startswith('https://'):
        print('вітрина має бути https: інакше запити юриста підуть відкритим текстом',
              file=sys.stderr)
        return 1

    # Без ключа збірка безглузда: вітрина віддасть 401, і свіжа установка не
    # покаже жодної картки. Краще не зібратися зовсім, ніж зібрати зламане.
    key = a.key.strip()
    if '?key=' in base or '&key=' in base:
        print('ключ передавайте через --key або PRAXIS_TOKEN, а не в --base',
              file=sys.stderr)
        return 1
    if not key:
        print('немає ключа: задайте PRAXIS_TOKEN або --key.\n'
              'Без нього вітрина віддасть 401 і свіжа установка не працюватиме.',
              file=sys.stderr)
        return 1
    if not key.isascii() or not key.isalnum():
        print('ключ має бути з латинських літер і цифр', file=sys.stderr)
        return 1
    base = base + '?key=' + key
    # Адресу можна передати разом із ключем (…?key=…) — його підхопить
    # service worker і надішле заголовком. Але в host_permissions і CSP
    # має йти чисте походження: рядок запиту там неприпустимий, і Chrome
    # відхиляє такий маніфест.
    origin = base.split('?', 1)[0].split('#', 1)[0].rstrip('/')
    host = origin + '/*'

    # Перед збіркою — дві перевірки, і без них релізу немає.
    #
    # Причина конкретна: помилка з `nph` у вкладеній функції віддавала б 500 на
    # кожен запит карток, а синтаксис при цьому бездоганний. Спіймали її
    # увагою; увага закінчується.
    # У відкритому репозиторії лежить лише транспорт: ядро з корпусом — ні.
    # Тому перевірку, якій нема на чому працювати, пропускаємо ВГОЛОС, а не
    # тихо: мовчазний пропуск — це той самий нічний реліз без перевірок.
    def present(*rel):
        return [str(ROOT / r) for r in rel if (ROOT / r).exists()]

    if not a.skip_checks:
        py = present('server/cards_api.py', 'server/praxis_http.py')
        rc = subprocess.call([sys.executable, str(ROOT / 'tools' / 'check-closures.py'), *py])
        if rc:
            print('замикання: реліз не збирається', file=sys.stderr)
            return 1
        print('· замикання перевірено:', ', '.join(os.path.basename(f) for f in py))

        # Публічний сервер має запускатися там, де його поставлять, а не лише
        # там, де його писали. Компіляція — найдешевша перевірка цієї обіцянки.
        exe, ver = oldest_python()
        if not exe:
            print(f'немає інтерпретатора {OLDEST[0]}.{OLDEST[1]} для перевірки сумісності',
                  file=sys.stderr)
            return 1
        rc = subprocess.call([exe, '-m', 'py_compile', *present(*PUBLIC_PY)])
        if rc:
            print(f'публічний сервер не компілюється на {ver}: реліз не збирається',
                  file=sys.stderr)
            return 1
        promised = '.'.join(str(x) for x in OLDEST)
        note = '' if tuple(int(x) for x in ver.split('.')) <= OLDEST else \
               f' — обіцяно {promised}, але старшого за {ver} тут немає'
        print(f'· сумісність: публічний сервер компілюється на {ver}{note}')

        # Чи доносить транспорт до панелі те, що віддає вітрина. Через цей
        # проміжок розділ ЄСПЛ не існував для юриста: лічильники приходили,
        # api.js їх викидав, кнопки не було в жодній статті.
        node = shutil.which('node')
        if not node:
            print('· панель НЕ перевірено: немає node')
        elif subprocess.call([node, str(ROOT / 'tools' / 'check-panel.mjs')]):
            print('транспорт губить лічильники: реліз не збирається', file=sys.stderr)
            return 1

        # Дим — на замороженій фікстурі, і лише на ній. Золоті числа на живому
        # зрізі червоніли б від кожної нової редакції закону, тобто від справних
        # даних; тут червоне означає рівно одне — зламався код.
        if not (ROOT / 'tools' / 'smoke.py').exists():
            print('· дим пропущено: тут немає ядра (воно в закритому репозиторії)')
        else:
            rc = subprocess.call([sys.executable, str(ROOT / 'tools' / 'make-fixture.py'), '--check'])
            if rc:
                print('фікстура не та або її немає: реліз не збирається', file=sys.stderr)
                return 1
            smoke = subprocess.run([sys.executable, str(ROOT / 'tools' / 'smoke.py'),
                                    '--mode', 'release'], capture_output=True, text=True)
            tail = (smoke.stdout or '').strip().splitlines()[-1:] or ['']
            if smoke.returncode:
                print(smoke.stdout, smoke.stderr, file=sys.stderr)
                print('дим червоний: реліз не збирається', file=sys.stderr)
                return 1
            print('· дим:', tail[0].strip())

    # Ключ має бути ТОЙ, який вітрина приймає. Перевіряємо до збірки.
    #
    # Історія коротка й дорога. Щоб подивитися, як реліз поводиться без ядра,
    # я двічі зібрав dist із ключем `testkey123` — у відкритому репозиторії.
    # Саме звідти Chrome власника вантажив розширення. Панель писала «немає
    # звʼязку», вітрина віддавала 401, і три мої пояснення поспіль були про
    # інше: збережену адресу, /health, кеш браузера. Збірка з ключем, якого
    # вітрина не приймає, — це мертва збірка, і дізнаватися про це має не
    # юрист із порожньою панеллю.
    if not a.skip_checks:
        probe = origin + '/act?nreg=435-15'
        try:
            req = urllib.request.Request(probe, headers={'X-Praxis-Key': key})
            with urllib.request.urlopen(req, timeout=15) as r:
                r.read(64)
            print('· ключ: вітрина приймає')
        except urllib.error.HTTPError as e:
            if e.code == 401:
                print(f'вітрина {origin} НЕ приймає цей ключ (401).\n'
                      'Зібрана з ним збірка не покаже жодної картки.', file=sys.stderr)
                return 1
            print(f'· ключ перевірити не вдалося: вітрина відповіла {e.code}')
        except OSError as e:
            # Збирати без мережі можна — але мовчки вдавати, що перевірили, ні.
            print(f'· ключ НЕ перевірено: вітрина недоступна ({type(e).__name__})')

    if a.dry_run:
        # Саме цього мені бракувало, коли я перевіряв поведінку збірки без ядра
        # й переписав чужу робочу теку тестовим ключем.
        print(f'сухий прогін: перевірки пройдено, {DIST} не чіпали')
        return 0

    if DIST.exists():
        shutil.rmtree(DIST)
    (DIST / 'src').mkdir(parents=True)
    for name in KEEP_SRC:
        shutil.copy2(ROOT / 'src' / name, DIST / 'src' / name)
    shutil.copytree(ROOT / 'icons', DIST / 'icons')
    for doc in ('LICENSE', 'PRIVACY.md'):
        if (ROOT / doc).exists():
            shutil.copy2(ROOT / doc, DIST / doc)

    # Стилі панелі вшиваємо в content.js, а web_accessible_resources прибираємо.
    #
    # Інакше rail.css лежить за постійною адресою chrome-extension://<id>/…,
    # і будь-який скрипт на сторінці Ради одним fetch() дізнається, що в цього
    # відвідувача стоїть Praxis. На zakon.rada.gov.ua уже працює лічильник
    # Google — тобто факт «цей юрист користується Praxis» їхав би третій
    # стороні без жодного запиту до вітрини. PRIVACY.md обіцяє протилежне.
    css = (ROOT / 'src' / 'rail.css').read_text(encoding='utf-8')
    cj = DIST / 'src' / 'content.js'
    cj.write_text('window.__PRAXIS_CSS__ = ' + json.dumps(css, ensure_ascii=False) + ';\n'
                  + cj.read_text(encoding='utf-8'), encoding='utf-8')
    (DIST / 'src' / 'rail.css').unlink(missing_ok=True)

    m = json.loads((ROOT / 'manifest.json').read_text(encoding='utf-8'))
    m.pop('web_accessible_resources', None)
    m['host_permissions'] = ['https://zakon.rada.gov.ua/*', host]
    m['content_security_policy'] = {'extension_pages':
        "script-src 'self'; object-src 'none'; "
        f"connect-src {origin}; "
        "img-src 'self'; style-src 'self'; base-uri 'none'; form-action 'none'"}
    m['content_scripts'][0]['js'] = [f'src/{n}' for n in ('api.js', 'content.js')]
    (DIST / 'manifest.json').write_text(
        json.dumps(m, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')

    # адреса вітрини за замовчуванням — та сама, що в маніфесті
    for name in ('background.js', 'popup.js', 'api.js', 'content.js'):
        f = DIST / 'src' / name
        t = f.read_text(encoding='utf-8')
        t = t.replace("'http://127.0.0.1:8787'", f"'{base}'")
        # у релізі нема чого «запускати сервіс»: вітрина не на машині користувача
        t = t.replace('Перевірте, чи запущений сервіс.',
                      'Спробуйте пізніше або перевірте адресу в налаштуваннях.')
        f.write_text(t, encoding='utf-8')

    size = sum(p.stat().st_size for p in DIST.rglob('*') if p.is_file())
    print(f'dist/ — {len(list(DIST.rglob("*")))} файлів, {size // 1024} КБ, вітрина {base}')
    print('без src/data.js (вигадані номери справ), без дозволів на localhost')
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
