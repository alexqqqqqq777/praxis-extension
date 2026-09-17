/* Чи доносить транспорт до панелі все, що віддає вітрина.
 *
 * Навіщо. Вітрина рахувала справи ЄСПЛ на кожну статтю й чесно віддавала їх
 * у /articles. А `counts()` у src/api.js складав відповідь із двох полів —
 * articles і zir — і `ecthr` мовчки викидав. Панель не мала чого показати,
 * і кнопки «ЄСПЛ» не було в ЖОДНІЙ статті: розділ, зроблений за день, просто
 * не існував для юриста.
 *
 * Маршрути я перевіряв curl-ом, панель — очима, а от цей проміжок між ними —
 * ніяк. Тут він і перевіряється: підсовуємо api.js несправжній fetch і
 * дивимося, що з відповіді вітрини дійшло до панелі.
 *
 *     node tools/check-panel.mjs
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
// За замовчуванням перевіряємо вихідний файл; аргументом можна дати будь-який
// інший — наприклад, той, що вже лежить у зібраному розширенні.
const target = process.argv[2] || path.join(ROOT, 'src', 'api.js');
const src = fs.readFileSync(target, 'utf8');

// відповідь вітрини: по одній статті в кожному лічильнику
const PAYLOAD = {
  '/articles': {
    act: '435-15', law: 'ЦК', law_title: 'Цивільний кодекс України', since: 2022,
    articles: { '388': [2205, 47] }, zir: { '164': [8, 1] }, ecthr: { '388': 24 }
  },
  // лічильники по нормах статті: ВС і ДПС тим самим ключем
  '/norms': {
    act: '2755-17', article: '164', total: 119,
    norms: { '164.2': 89 }, zir: { '164.2': [487, 143, 155] }
  }
};

const win = {
  __PRAXIS_API_BASE__: 'http://127.0.0.1:8787',
  fetch: async (url) => {
    const p = new URL(url).pathname;
    if (!(p in PAYLOAD)) throw new Error('несподіваний маршрут ' + p);
    return { ok: true, status: 200, json: async () => PAYLOAD[p] };
  }
};
const sandbox = { window: win, fetch: win.fetch, chrome: undefined,
                  URL, URLSearchParams, AbortController, setTimeout, clearTimeout,
                  Map, JSON, Error, console };

new Function(...Object.keys(sandbox), src)(...Object.values(sandbox));
const API = win.__PRAXIS_API__;
if (!API || typeof API.counts !== 'function') {
  console.error('api.js не віддав назовні counts() — перевірку не запущено');
  process.exit(1);
}

const bad = [];
const d = await API.counts('435-15');
for (const [field, art] of [['articles', '388'], ['zir', '164'], ['ecthr', '388']]) {
  const m = d[field];
  if (!(m instanceof Map) || !m.has(art)) {
    bad.push(`${field}: вітрина віддала, до панелі не дійшло`);
  }
}
// Бейдж ДПС біля пункту: вітрина віддавала zir у /norms від самого початку,
// а norms() його викидав — бейдж стояв лише в заголовку статті на десять екранів.
const nm = await API.norms('2755-17', '164');
if (!(nm.map instanceof Map) || !nm.map.has('164.2')) bad.push('norms: лічильники ВС по нормах не дійшли');
if (!(nm.zir instanceof Map) || (nm.zir.get('164.2') || [])[2] !== 155) bad.push('norms.zir: лічильники ДПС по нормах не дійшли');

if (bad.length) {
  for (const b of bad) console.error('  ЗБІЙ ' + b);
  process.exit(1);
}
console.log('  ok   лічильники доходять до панелі: articles, zir, ecthr, norms.zir  ·  ' + target);
