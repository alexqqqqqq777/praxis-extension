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

Запуск: PRAXIS_TOKEN=… python3 tools/build-release.py [--base https://…]
"""
import argparse, json, os, pathlib, shutil, sys

ROOT = pathlib.Path(__file__).resolve().parent.parent
DIST = ROOT / 'dist'
DEFAULT_BASE = 'https://praxis.51-83-129-254.sslip.io'

# те, що фізично потрапляє в пакет
KEEP_SRC = ['api.js', 'background.js', 'content.js', 'page.css', 'popup.html',
            'popup.js', 'rail.css']


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument('--base', default=DEFAULT_BASE, help='адреса вітрини')
    ap.add_argument('--key', default=os.environ.get('PRAXIS_TOKEN', ''),
                    help='ключ доступу до вітрини (або змінна PRAXIS_TOKEN)')
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
