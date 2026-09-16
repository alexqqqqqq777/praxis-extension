const D = { open: true, theme: 'auto', apiBase: 'http://127.0.0.1:8787' };
const openEl = document.getElementById('open');
const themeEl = document.getElementById('theme');
const apiEl = document.getElementById('api');
const dotEl = document.getElementById('dot');
const stateEl = document.getElementById('apiState');

function paint(s) {
  openEl.checked = !!s.open;
  [...themeEl.children].forEach(b => b.classList.toggle('on', b.dataset.v === s.theme));
  if (document.activeElement !== apiEl) apiEl.value = s.apiBase || '';
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
    const key = u.searchParams.get('key') || '';
    const url = new URL('/health', u.origin + u.pathname.replace(/\/$/, ''));
    const r = await fetch(url.toString(), {
      signal: ctl.signal, cache: 'no-store', credentials: 'omit',
      referrerPolicy: 'no-referrer',
      headers: key ? { 'X-Praxis-Key': key } : undefined
    });
    const d = await r.json();
    if (my !== probeSeq) return;
    dotEl.className = 'dot ' + (d.ok ? 'ok' : 'bad');
    stateEl.textContent = d.ok
      ? (d.norm_refs
          ? `на звʼязку · ${Number(d.norm_refs).toLocaleString('uk')} посилань на норми`
          : 'на звʼязку')
      : 'сервіс відповідає, але база недоступна';
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
    put({ apiBase: v });
  }, 500);
});
themeEl.addEventListener('click', e => {
  const b = e.target.closest('button[data-v]');
  if (b) put({ theme: b.dataset.v });
});
