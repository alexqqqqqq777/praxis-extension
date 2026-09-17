const D = { open: true, theme: 'auto', apiBase: 'http://127.0.0.1:8787' };
const openEl = document.getElementById('open');
const themeEl = document.getElementById('theme');
const apiEl = document.getElementById('api');
const dotEl = document.getElementById('dot');
const stateEl = document.getElementById('apiState');
const buildEl = document.getElementById('buildInfo');

/** Адреса без ключа — те, що показуємо на екрані. */
function shown(raw) {
  try {
    const u = new URL(raw);
    u.search = '';
    return u.origin + u.pathname.replace(/\/$/, '');
  } catch (e) { return String(raw || '').split('?')[0]; }
}

/** Ключ, збережений для цієї адреси. */
function keyOf(raw) {
  try { return new URL(raw).searchParams.get('key') || ''; } catch (e) { return ''; }
}

/** Ключ для цієї адреси: збережений, а як його немає — вшитий у збірку,
 *  але лише коли вітрина та сама. Дзеркало тієї ж логіки в service worker. */
function keyFor(raw) {
  const own = keyOf(raw);
  if (own) return own;
  try {
    return new URL(raw).origin === new URL(D.apiBase).origin ? keyOf(D.apiBase) : '';
  } catch (e) { return ''; }
}

/** Звідки взявся ключ — словами, для рядка стану.
 *
 *  Досі цього не було видно ніде: ні в панелі, ні тут. Через це 401 двічі
 *  пояснювали не тим — «немає звʼязку», «змініть адресу», — хоча звʼязок був,
 *  а адреса правильна. Стан, від якого залежить робота, має бути на екрані. */
function keySource(raw) {
  if (keyOf(raw)) return 'збережений';
  try {
    const remote = new URL(raw).protocol === 'https:';
    if (new URL(raw).origin === new URL(D.apiBase).origin && keyOf(D.apiBase)) return 'вшитий у збірку';
    return remote ? '' : 'не потрібен';
  } catch (e) { return ''; }
}

function paint(s) {
  openEl.checked = !!s.open;
  [...themeEl.children].forEach(b => b.classList.toggle('on', b.dataset.v === s.theme));
  // У полі — адреса без ключа. Показувати ключ ні до чого: він однаковий у
  // всіх і нічого не каже юристові, зате потрапляє в перший-ліпший знімок
  // екрана. Зберігається він окремо, див. обробник нижче.
  if (document.activeElement !== apiEl) apiEl.value = shown(s.apiBase || '');

  // Яка це збірка — видно одразу. Інакше «розпаковане з dist» і «розпаковане
  // з теки розробника» на вигляд однакові, а поводяться по-різному: у першій
  // ключ вшитий, у другій його немає взагалі.
  const built = shown(D.apiBase);
  buildEl.textContent = keyOf(D.apiBase)
    ? `збірка: ${built}, ключ усередині`
    : `збірка для розробки: ${built}, ключа немає — до чужої вітрини допишіть ?key=…`;
  buildEl.style.display = shown(s.apiBase || D.apiBase) === built && keyOf(D.apiBase) ? 'none' : '';

  probe(s.apiBase || D.apiBase);
}

let probeSeq = 0;
async function probe(base) {
  const my = ++probeSeq;
  dotEl.className = 'dot';
  stateEl.textContent = 'перевіряю…';
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), 2500);
  try {
    // адресу можна вписати разом із ключем (http://host:8788?key=…):
    // ключ відокремлюємо й надсилаємо заголовком, а не в рядку запиту
    const u = new URL(base);
    const key = keyFor(base);
    const url = new URL('/health', u.origin + u.pathname.replace(/\/$/, ''));
    const r = await fetch(url.toString(), {
      signal: ctl.signal, cache: 'no-store', credentials: 'omit',
      referrerPolicy: 'no-referrer',
      headers: key ? { 'X-Praxis-Key': key } : undefined
    });
    const d = await r.json();
    if (my !== probeSeq) return;
    if (!d.ok) {
      dotEl.className = 'dot bad';
      stateEl.textContent = 'сервіс відповідає, але база недоступна';
      return;
    }

    // /health ключа НЕ питає — навмисно, щоб перевірка живості нічого не
    // вимагала. Через це «на звʼязку» тут світилося зеленим і тоді, коли
    // ключа немає й жодної картки панель не покаже. Перевірка, яка не може
    // почервоніти від справжньої поломки, гірша за її відсутність, тому
    // питаємо ще й маршрут, який ключ вимагає.
    const probeUrl = new URL('/act', u.origin + u.pathname.replace(/\/$/, ''));
    probeUrl.searchParams.set('nreg', '435-15');
    const r2 = await fetch(probeUrl.toString(), {
      signal: ctl.signal, cache: 'no-store', credentials: 'omit',
      referrerPolicy: 'no-referrer',
      headers: key ? { 'X-Praxis-Key': key } : undefined
    });
    if (my !== probeSeq) return;
    if (r2.status === 401) {
      // Вітрина відповіла — і не прийняла ключ. Казати «не відповідає» тут
      // означає послати юриста лагодити мережу замість адреси.
      dotEl.className = 'dot bad';
      stateEl.textContent = key
        ? 'вітрина не прийняла ключ (401) — перевірте ?key=… в адресі'
        : 'вітрина вимагає ключ (401) — допишіть до адреси ?key=…';
      return;
    }
    const src = keySource(base);
    dotEl.className = 'dot ok';
    stateEl.textContent = (d.norm_refs
      ? `на звʼязку · ${Number(d.norm_refs).toLocaleString('uk')} посилань на норми`
      : 'на звʼязку · картки віддаються') + (src ? ` · ключ ${src}` : '');
  } catch (e) {
    if (my !== probeSeq) return;
    dotEl.className = 'dot bad';
    stateEl.textContent = 'не відповідає — панель скаже про це прямо';
  } finally {
    clearTimeout(t);
  }
}
function put(patch) {
  chrome.storage.local.get('praxis', r => {
    const next = Object.assign({}, D, r.praxis, patch);
    chrome.storage.local.set({ praxis: next }, () => paint(next));
  });
}
chrome.storage.local.get('praxis', r => paint(Object.assign({}, D, r.praxis)));
openEl.addEventListener('change', () => put({ open: openEl.checked }));
let apiT;
apiEl.addEventListener('input', () => {
  clearTimeout(apiT);
  apiT = setTimeout(() => {
    const v = apiEl.value.trim().replace(/\/$/, '') || D.apiBase;
    // дзеркало safeBase() із service worker: чужий http сюди не потрапить
    let ok = false;
    try {
      const u = new URL(v);
      const local = /^(127\.0\.0\.1|localhost|\[::1\])$/.test(u.hostname);
      ok = u.protocol === 'https:' || (u.protocol === 'http:' && local);
    } catch (e) { ok = false; }
    if (!ok) {
      dotEl.className = 'dot bad';
      stateEl.textContent = 'приймається лише https або локальна адреса';
      return;
    }
    // Ключ у полі не показується, тож сам собою він туди й не потрапить. Якщо
    // юрист лишив ту саму вітрину, ключ треба зберегти: інакше будь-яка правка
    // в цьому полі мовчки ламала б розширення — вітрина почала б віддавати 401.
    // Вписав іншу адресу — там діє її власний ключ (або ніякого).
    chrome.storage.local.get('praxis', r => {
      const cur = (r.praxis && r.praxis.apiBase) || D.apiBase;
      const keep = !keyOf(v) && shown(cur) === shown(v) ? keyFor(cur) : '';
      put({ apiBase: keep ? v + '?key=' + keep : v });
    });
  }, 500);
});
themeEl.addEventListener('click', e => {
  const b = e.target.closest('button[data-v]');
  if (b) put({ theme: b.dataset.v });
});
