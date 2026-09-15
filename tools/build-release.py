#!/usr/bin/env python3
"""Збирає dist/ — те, що йде в Chrome Web Store.

Відмінності від робочої теки, кожна з причиною:

  • немає src/data.js — це демонстраційний набір із **вигаданими** номерами
    справ. У продукті для юриста вигаданої практики бути не може: коли вітрина
    мовчить, розширення каже «немає звʼязку» і не показує нічого;
  • немає дозволів на 127.0.0.1 і localhost — вони потрібні лише розробнику,
    а рецензента магазину змушують питати, навіщо розширення ходить у локальну
    мережу;
  • connect-src у CSP звужено до єдиної адреси вітрини.

Запуск: python3 tools/build-release.py [--base https://…]
"""
import argparse, json, pathlib, shutil, sys

ROOT = pathlib.Path(__file__).resolve().parent.parent
DIST = ROOT / 'dist'
DEFAULT_BASE = 'https://praxis.51-83-129-254.sslip.io'

# те, що фізично потрапляє в пакет
KEEP_SRC = ['api.js', 'background.js', 'content.js', 'page.css', 'popup.html',
            'popup.js', 'rail.css']


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument('--base', default=DEFAULT_BASE, help='адреса вітрини')
    a = ap.parse_args()

    base = a.base.rstrip('/')
    if not base.startswith('https://'):
        print('вітрина має бути https: інакше запити юриста підуть відкритим текстом',
              file=sys.stderr)
        return 1
    host = base + '/*'

    if DIST.exists():
        shutil.rmtree(DIST)
    (DIST / 'src').mkdir(parents=True)
    for name in KEEP_SRC:
        shutil.copy2(ROOT / 'src' / name, DIST / 'src' / name)
    shutil.copytree(ROOT / 'icons', DIST / 'icons')
    for doc in ('LICENSE', 'PRIVACY.md'):
        if (ROOT / doc).exists():
            shutil.copy2(ROOT / doc, DIST / doc)

    m = json.loads((ROOT / 'manifest.json').read_text(encoding='utf-8'))
    m['host_permissions'] = ['https://zakon.rada.gov.ua/*', host]
    m['content_security_policy'] = {'extension_pages':
        "script-src 'self'; object-src 'none'; "
        f"connect-src {base}; "
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
