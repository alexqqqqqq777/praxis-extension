/* Praxis — service worker. Єдине місце, звідки розширення виходить у мережу.
 *
 * Чому взагалі воркер: сторінка Ради працює по https, а локальний API — по
 * http; запит із фонового воркера йде від походження розширення й не впирається
 * ані в mixed-content, ані в Private Network Access.
 *
 * Що звідси йде назовні: назва акта, номер статті (і, якщо юрист шукає всередині
 * карток, — його текст запиту). Нічого про самого юриста тут не додається:
 * ні ідентифікатора, ні лічильника, ні часу встановлення. Ключ доступу до
 * вітрини передається заголовком, а не в адресі, щоб не осідати в журналах
 * проміжних вузлів.
 */
const DEFAULT_BASE = 'http://127.0.0.1:8787';

/** Адреса вітрини має бути або https, або локальною: інакше запит піде відкритим
 *  текстом крізь чужу мережу. Чужий http приймати не можна. */
function safeBase(raw) {
  let u;
  try {
    u = new URL(raw);
  } catch (e) {
    return null;
  }
  const local = u.hostname === '127.0.0.1' || u.hostname === 'localhost' || u.hostname === '[::1]';
  if (u.protocol === 'https:' || (u.protocol === 'http:' && local)) return u;
  return null;
}

async function settings() {
  try {
    const r = await chrome.storage.local.get('praxis');
    const raw = (r.praxis && r.praxis.apiBase) || DEFAULT_BASE;
    const u = safeBase(raw) || safeBase(DEFAULT_BASE);
    const key = u.searchParams.get('key') || '';
    u.search = '';                     // ключ в адресі не лишаємо
    return { base: u, key };
  } catch (e) {
    return { base: new URL(DEFAULT_BASE), key: '' };
  }
}

chrome.runtime.onMessage.addListener((msg, sender, reply) => {
  if (!msg || msg.praxis !== 'fetch') return undefined;
  (async () => {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), msg.ms || 6000);
    try {
      const { base, key } = await settings();
      const url = new URL(msg.path, base.origin + base.pathname.replace(/\/$/, ''));
      new URLSearchParams(msg.qs || '').forEach((v, k) => url.searchParams.set(k, v));
      const res = await fetch(url.toString(), {
        signal: ctl.signal,
        cache: 'no-store',
        credentials: 'omit',           // жодних кук до вітрини
        referrerPolicy: 'no-referrer',
        headers: key ? { 'X-Praxis-Key': key } : undefined
      });
      if (!res.ok) throw new Error('HTTP ' + res.status);
      reply({ ok: true, data: await res.json() });
    } catch (e) {
      reply({ ok: false, error: e && e.name === 'AbortError' ? 'timeout' : String(e && e.message || e) });
    } finally {
      clearTimeout(timer);
    }
  })();
  return true;                         // відповідь буде асинхронною
});
