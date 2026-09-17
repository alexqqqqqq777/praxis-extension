#!/usr/bin/env python3
"""Ловить помилку, через яку /cards віддавав би 500 на кожен запит.

Вкладена функція присвоїла `nph` — те саме імʼя, що й список норм у зовнішній.
Python від цього робить імʼя локальним для ВСІЄЇ вкладеної функції, разом із
рядками вище, які читають його раніше. Виходить UnboundLocalError, і побачити
це можна лише виконанням: синтаксис бездоганний.

Правило тут вузьке навмисно, щоб не кричати на кожне затінення:

    у вкладеній функції імʼя ЧИТАЄТЬСЯ раніше, ніж присвоюється,
    і це імʼя існує в зовнішній функції.

Саме так виглядав `nph`: читання в рядку 866, присвоєння в 890. Параметри й
змінні включень не рахуємо — вони звʼязані до першого читання за визначенням.

## Чого це правило НЕ бачить — і це свідомо

Ширше правило («будь-яке затінення») дало на чистому коді пʼятнадцять хибних
знахідок, усі до одної безпечні. Інструмент, який кричить дарма, навчає себе
ігнорувати, тому межі такі:

  • присвоєння під умовою (`if …: x = 1`) — до читання воно може й не статися,
    але статичне «читається раніше» тут не спрацює;
  • `nonlocal x` — навмисне звʼязування із зовнішнім імʼям, пропускаємо;
  • спискові та інші включення — власна область, своє імʼя;
  • `for x in …:` у вкладеній функції, де `x` є і в зовнішній: цикл присвоює
    перед тілом, тому за нашим правилом це «присвоєно раніше»;
  • глобальні імена модуля — дивимося лише пари «вкладена / зовнішня функція»;
  • `del x`, `except … as x`, `with … as x` після читання.

Усе це — той самий клас помилки. Ловиться воно виконанням: димовим прогоном
на фікстурі, а не тут.

Чому не ruff: проєкт навмисно на stdlib, а лінтера в системі немає.

    python3 tools/check-closures.py server/cards_api.py
"""
import ast
import sys


def own_scope(fn):
    """Що ця функція присвоює й читає у власному тілі, без вкладених.

    Повертає (перше присвоєння, перше читання, параметри, nonlocal).
    """
    first_set, first_get = {}, {}
    params = {a.arg for a in fn.args.args + fn.args.kwonlyargs + fn.args.posonlyargs}
    if fn.args.vararg:
        params.add(fn.args.vararg.arg)
    if fn.args.kwarg:
        params.add(fn.args.kwarg.arg)
    nonlocals = set()

    class V(ast.NodeVisitor):
        def visit_FunctionDef(self, n):
            if n is fn:
                for c in n.body:
                    self.visit(c)
            else:
                first_set.setdefault(n.name, n.lineno)   # саме визначення — присвоєння
        visit_AsyncFunctionDef = visit_FunctionDef
        visit_Lambda = lambda self, n: None

        def _comp(self, n):
            # у включень власна область: їхні цілі не роблять імʼя локальним
            for g in n.generators:
                self.visit(g.iter)
            for part in ('elt', 'key', 'value'):
                if getattr(n, part, None) is not None:
                    self.visit(getattr(n, part))
        visit_ListComp = visit_SetComp = visit_GeneratorExp = visit_DictComp = _comp

        def visit_Nonlocal(self, n):
            nonlocals.update(n.names)

        def visit_Name(self, n):
            box = first_set if isinstance(n.ctx, ast.Store) else first_get
            box.setdefault(n.id, n.lineno)

    V().visit(fn)
    return first_set, first_get, params, nonlocals


def check(path):
    tree = ast.parse(open(path, encoding='utf-8').read(), path)
    bad = []

    def walk(node, outer):
        for child in ast.iter_child_nodes(node):
            if isinstance(child, (ast.FunctionDef, ast.AsyncFunctionDef)):
                sets, gets, params, nl = own_scope(child)
                for name, set_line in sets.items():
                    if name in params or name in nl or name not in outer:
                        continue
                    get_line = gets.get(name)
                    if get_line is not None and get_line < set_line:
                        bad.append((get_line, set_line, child.name, name))
                walk(child, outer | set(sets) | params)
            else:
                walk(child, outer)

    for node in tree.body:
        if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)):
            sets, _, params, _ = own_scope(node)
            walk(node, set(sets) | params)
    return bad


def main(argv):
    total = 0
    for path in argv:
        for get_line, set_line, fn, name in sorted(check(path)):
            total += 1
            print(f'{path}:{get_line}: «{name}» читається тут, а присвоюється нижче '
                  f'(рядок {set_line}) у тій самій вкладеній {fn}(). '
                  f'Python зробить імʼя локальним для всієї функції — '
                  f'UnboundLocalError на кожному виклику.')
    if total:
        print(f'\nзнайдено {total}. Перейменуйте локальну змінну або оголосіть nonlocal.',
              file=sys.stderr)
    return 1 if total else 0


if __name__ == '__main__':
    sys.exit(main(sys.argv[1:] or ['server/cards_api.py']))
