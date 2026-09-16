/* Praxis — content script.
 * Зсуває текст закону вліво і тримає праворуч панель із практикою ВС
 * для статті, яку читає користувач.
 *
 * Дані: локальний cards_api.py (src/api.js). Якщо бекенд не відповідає —
 * панель відкочується на демо-набір із src/data.js і чесно про це каже.
 */
(async function () {
  'use strict';

  const DEMO = window.__PRAXIS_DATA__ || { articles: {}, order: [], lawShort: '' };
  // Версія застереження. Якщо текст зміниться по суті — підняти число,
  // і згода спитається ще раз. Косметичні правки версію не міняють.
  const DISCLAIMER_V = 1;
  const DISCLAIMER_URL = 'https://github.com/alexqqqqqq777/praxis-extension/blob/main/DISCLAIMER.md';

  /** Налаштування з локального сховища. Читаються один раз і ДО першого
   *  мережевого запиту: у них лежить і згода на застереження. */
  function readPrefs() {
    return new Promise(res => {
      try {
        if (typeof chrome !== 'undefined' && chrome.storage && chrome.storage.local)
          chrome.storage.local.get('praxis', r => res((r && r.praxis) || {}));
        else res({});
      } catch (e) { res({}); }
    });
  }
  const API = window.__PRAXIS_API__;
  if (document.getElementById('praxis-host')) return;

  const RAIL_W = 404;
  const SPY_OFFSET = 150;
  let CARD_LIMIT = 20;

  /* ── дрібні утиліти ───────────────────────────────────────────────── */
  const esc = s => String(s == null ? '' : s).replace(/[&<>"]/g, c =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const h = html => { const t = document.createElement('template'); t.innerHTML = html.trim(); return t.content.firstElementChild; };
  const fmtDate = iso => { if (!iso) return ''; const [y, m, d] = iso.split('-'); return `${d}.${m}.${y}`; };
  const fmtNum = n => String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ' ');
  const courtKind = c => /^ВП/.test(c) ? 'vp' : /^ОП/.test(c) ? 'op' : 'k';
  const artKey = n => parseFloat(String(n).replace('-', '.')) || 0;

  /** 843 → «843», 6145 → «6,1 тис.» — число в заголовку статті має бути коротким */
  const fmtCompact = n => {
    if (n == null) return '';
    if (n < 1000) return String(n);
    if (n < 10000) return (n / 1000).toFixed(1).replace('.', ',') + ' тис.';
    return Math.round(n / 1000) + ' тис.';
  };

  /** nreg акта з адреси: /laws/show/435-15#Text → 435-15 */
  function actFromUrl() {
    const m = /\/laws\/show\/([^/#?]+)/.exec(location.pathname);
    return m ? decodeURIComponent(m[1]) : null;
  }

  const ICON = {
    close: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"><path d="M4 4l8 8M12 4l-8 8"/></svg>',
    theme: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5"><circle cx="8" cy="8" r="4.2"/><path d="M8 3.8V1M8 15v-2.8M12.2 8H15M1 8h2.8M11 5l1.9-1.9M3.1 12.9L5 11M11 11l1.9 1.9M3.1 3.1L5 5" stroke-linecap="round"/></svg>',
    search: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6"><circle cx="7" cy="7" r="4.3"/><path d="M10.3 10.3L14 14" stroke-linecap="round"/></svg>',
    copy: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4"><rect x="5.5" y="5.5" width="8" height="8" rx="2"/><path d="M10.5 3.2A2 2 0 008.6 2H4.5a2.5 2.5 0 00-2.5 2.5v4.1c0 .9.6 1.6 1.4 1.9"/></svg>',
    ext: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"><path d="M9.5 2.5H13v3.6M12.8 2.8L7.4 8.2"/><path d="M12.4 9.6V12a1.6 1.6 0 01-1.6 1.6H4A1.6 1.6 0 012.4 12V5.2A1.6 1.6 0 014 3.6h2.5"/></svg>',
    jump: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"><path d="M8 2.6v10M4.4 9l3.6 3.6L11.6 9"/></svg>',
    empty: '<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.3"><path d="M4 4.5h12M4 8h9M4 11.5h12M4 15h6" stroke-linecap="round"/></svg>',
    retry: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"><path d="M13.5 8a5.5 5.5 0 11-1.9-4.2"/><path d="M13.7 2.4v3.3h-3.3"/></svg>'
  };

  /* ── 1. розбір тексту закону ──────────────────────────────────────── */
  let root = document.getElementById('article');

  const ACT = actFromUrl() || window.__PRAXIS_ACT__ || (window.__PRAXIS_FORCE__ ? DEMO.lawId : null);
  if (!ACT) return;

  function collectArticles() {
    const out = [];
    if (!root) return out;
    root.querySelectorAll('a[data-tree]').forEach(a => {
      if (!/^st[\d-]+$/.test(a.getAttribute('data-tree') || '')) return;
      const p = a.closest('p');
      if (!p) return;
      const m = /^Стаття\s+(\d+(?:-\d+)?)\s*\.\s*(.*)$/s.exec((p.textContent || '').trim());
      if (!m) return;
      out.push({ num: m[1], title: m[2].trim(), el: p, top: 0, height: 0 });
    });
    for (let i = 0; i < out.length; i++) out[i].nextEl = out[i + 1] ? out[i + 1].el : null;
    return out;
  }

  /* Великі кодекси Рада домальовує вже після завантаження сторінки: у ПКУ
     (#article — 6,8 МБ) на document_idle немає ні заголовків, ні самого
     контейнера. Тому спостерігаємо за документом, а не за #article. */
  function waitForArticles(ms = 30000) {
    return new Promise(resolve => {
      const ready = () => {
        if (!root || !root.isConnected) root = document.getElementById('article');
        return collectArticles().length;
      };
      if (ready()) return resolve(true);

      let done = false, deb;
      const finish = ok => {
        if (done) return;
        done = true;
        obs.disconnect(); clearTimeout(cap);
        resolve(ok);
      };
      const obs = new MutationObserver(() => {
        clearTimeout(deb);
        deb = setTimeout(() => { if (ready()) finish(true); }, 250);
      });
      obs.observe(document.documentElement, { childList: true, subtree: true });
      const cap = setTimeout(() => finish(ready() > 0), ms);
    });
  }

  // Лічильники не залежать від DOM — тягнемо їх, поки Рада малює текст
  // (API.counts кешує, тож пізніший loadCounts() візьме готове). Але тільки
  // якщо застереження вже прийнято: до згоди розширення в мережу не виходить
  // взагалі, інакше галочка була б формальністю.
  const prefs = await readPrefs();
  if (API && prefs.agreed === DISCLAIMER_V) API.counts(ACT).catch(() => null);

  if (!await waitForArticles()) return;
  const arts = collectArticles();
  if (!arts.length) return;
  const byNum = new Map(arts.map(a => [a.num, a]));

  /* Якорі окремих норм усередині статті.
     ЦКУ: pu1:st625 → частина «1». ПКУ: pp140.5:st140 → пункт «140.5».
     У ПКУ стаття буває на десять екранів, тож одиниця читання — пункт,
     а не стаття: інакше панель показує те саме на всю статтю. */
  function collectNorms() {
    const out = [];
    let cur = null;                       // стаття, всередині якої йдемо
    const walk = root.querySelectorAll('p');

    const headKey = new Map();            // елемент заголовка → номер статті
    for (const a of arts) headKey.set(a.el, a.num);

    for (const el of walk) {
      if (headKey.has(el)) { cur = headKey.get(el); continue; }
      if (!cur) continue;

      const txt = (el.textContent || '').trim();
      if (txt.startsWith('{')) continue;              // примітка про зміни

      // 1) якір Ради: ЦКУ pu1:st625, ПКУ pp140.5:st140 (лише 1-й рівень)
      let part = null;
      for (const a of el.querySelectorAll('a[data-tree]')) {
        const m = /(?:^|:)(?:pp|pu)([\d.]+):st([\d-]+)$/.exec(a.getAttribute('data-tree') || '');
        if (m && m[2] === cur) { part = m[1]; break; }
      }

      // 2) нумерація на початку абзацу — єдиний шлях до підпунктів,
      //    бо 140.5.11 у розмітці Ради окремим якорем не позначений
      const dotted = new RegExp('^(' + cur.replace(/[-]/g, '\\-') + '(?:\\.\\d+)+)\\.');
      const md = dotted.exec(txt);
      if (md) part = md[1];
      else if (!part) {
        const mf = /^(\d+)\.\s/.exec(txt);           // ЦКУ: «2. Боржник…»
        if (mf) part = mf[1];
      }

      if (part) out.push({ art: cur, part, el, top: 0 });
    }
    return out;
  }

  const norms = collectNorms();

  function measure() {
    const sy = window.scrollY;
    for (const n of norms) n.top = n.el.getBoundingClientRect().top + sy;
    const artTop = root.getBoundingClientRect().top + sy;
    for (const a of arts) {
      a.top = a.el.getBoundingClientRect().top + sy;
      a.rel = a.top - artTop;
    }
    for (let i = 0; i < arts.length; i++) {
      const end = arts[i].nextEl
        ? arts[i].nextEl.getBoundingClientRect().top + sy
        : root.getBoundingClientRect().bottom + sy;
      arts[i].height = Math.max(24, end - arts[i].top - 10);
    }
  }

  /* ── 2. стан ──────────────────────────────────────────────────────── */
  const S = {
    open: true,
    theme: 'auto',
    source: 'demo',          // 'live' — вітрина, 'demo' — набір із data.js, 'offline' — вітрина мовчить
    offlineReason: '',
    agreed: 0,               // версія прийнятого застереження
    lawShort: DEMO.lawShort || '',
    active: null,
    peek: null,
    pinned: null,
    filter: 'all',
    sort: 'fresh',           // свіжі зверху — типове для практика
    jk: [],                  // юрисдикції (цивільне / господарське / …)
    courts: [],              // ВП ВС, КЦС, КГС …
    cat: null,               // категорія справи
    flags: [],               // 'departure' — сама відступила; 'actual' — від неї не відступали
    opinions: false,         // додати окремі думки суддів до постанов
    since: null,             // рік, від якого брати рішення
    currentOnly: false,      // ховати рішення по нечинній редакції статті
    filtersOpen: false,
    mode: 'practice',        // 'history' — режим редакцій статті
    onDate: '',              // «покажи редакцію на цю дату»
    showRedundant: false,    // редакції-дублікати, де текст норми не змінився
    onlyReal: true,          // ховати редакції без змістовних змін
    cmpDate: '',             // друга дата — порівняти дві редакції
    part: null,              // null — уся стаття; '' — посилання без вказівки частини
    partManual: false,       // користувач сам обрав частину — не перебивати скролом
    partsOpen: false,        // показати всі чипи, а не перші вісім
    query: '',
    searchOn: false,
    expanded: new Set()
  };
  const shown = () => S.peek || S.pinned || S.active;

  /** номер статті → [усього рішень ВС, з них Великої Палати] */
  const COUNTS = new Map();
  /** `стаття|частина` → {state:'loading'|'ready'|'error', items, found, error} */
  const store = new Map();
  /** номер статті → [{part, label, count, has_children}] — рівень, що показуємо */
  const partsOf = new Map();
  /** `стаття|частина` → ланцюг предків для крихт */
  const pathOf = new Map();
  /** номер статті → фасети (розподіл за юрисдикцією) */
  const facetsOf = new Map();
  const qopts = () => ({
    sort: S.sort, jk: S.jk, courts: S.courts, cat: S.cat,
    flag: S.flags.length ? S.flags : null,
    forms: S.opinions ? [2, 3, 10] : null,
    since: S.since, q: S.query.trim() || null
  });
  const pk = (num, part) => [num, part == null ? '*' : part, S.sort, S.jk.join('+'),
                             S.courts.join('+'), S.cat || '', S.flags.join('+'),
                             S.opinions ? 'op' : '', S.since || '', S.query.trim()].join('|');

  /** Скільки фільтрів відхилено від типових — цифра на лійці. */
  const activeFilters = () =>
    S.jk.length + S.courts.length + (S.cat ? 1 : 0) + S.flags.length
    + (S.opinions ? 1 : 0) + (S.since ? 1 : 0) + (S.currentOnly ? 1 : 0);

  function resetFilters() {
    S.jk = []; S.courts = []; S.cat = null; S.flags = [];
    S.opinions = false; S.since = null; S.currentOnly = false;
  }
  let withPractice = [];

  /* ── 3. каркас панелі ─────────────────────────────────────────────── */
  const host = document.createElement('div');
  host.id = 'praxis-host';
  const sh = host.attachShadow({ mode: 'open' });
  document.documentElement.appendChild(host);

  const style = document.createElement('style');
  sh.appendChild(style);
  (async () => {
    let css = window.__PRAXIS_CSS__ || '';
    if (!css && typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.getURL) {
      try { css = await (await fetch(chrome.runtime.getURL('src/rail.css'))).text(); } catch (e) { }
    }
    style.textContent = css;
  })();

  const rail = h(`
    <aside class="rail" role="complementary" aria-label="Практика Верховного Суду">
      <div class="hd">
        <div class="hd__top">
          <div class="brand">
            <span class="brand__mark"></span>
            <span class="brand__name">Praxis</span>
            <span class="chip--src" data-slot="src"></span>
          </div>
          <div class="hd__tools">
            <button class="ico" data-act="search" title="Пошук у завантажених висновках">${ICON.search}</button>
            <button class="ico" data-act="theme" title="Тема">${ICON.theme}</button>
            <button class="ico" data-act="close" title="Сховати панель (Alt+P)">${ICON.close}</button>
          </div>
        </div>

        <div class="ctx">
          <button class="ctx__nav" data-act="prev" title="Попередня стаття з практикою">‹</button>
          <div class="ctx__main">
            <div class="ctx__art"><button class="ctx__jump" data-act="jump" title="перейти до статті за номером">⌕</button><span data-slot="art">—</span><span class="ctx__law" data-slot="law"></span><span data-slot="norm"></span></div>
            <div class="ctx__title" data-slot="title">Прокрутіть текст — панель слідує за статтею, яку ви читаєте</div>
          </div>
          <button class="ctx__nav" data-act="next" title="Наступна стаття з практикою">›</button>
        </div>

        <div class="jumpbox" hidden>
          <input type="text" inputmode="numeric" placeholder="номер статті, напр. 625" spellcheck="false">
          <div class="jumpbox__hint"></div>
        </div>

        <div class="searchbox" hidden>
          <input type="search" placeholder="Пошук у текстах рішень по цій нормі…" spellcheck="false">
        </div>

        <div class="bar">
          <div class="sorts"></div>
          <button class="funnel" data-act="filters">Фільтри</button>
        </div>
        <div class="panel" hidden></div>
        <div class="active" hidden></div>

        <div class="mode" hidden>
          <span data-slot="mode-text">Закріплено</span>
          <button data-act="unpin">слідувати за текстом</button>
        </div>
      </div>

      <div class="list"></div>

      <div class="ft">
        <span>Бейдж <kbd>ВС</kbd> біля статті · <kbd>Alt</kbd><kbd>P</kbd></span>
        <span class="ft__count" data-slot="count"></span>
      </div>
    </aside>`);
  /* Скрол-мапа на лівому краю панелі.
   *
   *  Дві причини. Перша: у Chrome на macOS смуга прокрутки накладна — вона
   *  малюється поверх правого краю вікна, тобто під панеллю, і дотягтися до
   *  неї неможливо. Друга: ПКУ це 383 екрани, і рідна смуга там усе одно
   *  марна — піксель тяги дорівнює трьомстам пікселям тексту.
   *
   *  Замість неї — доріжка з позначками статей, де є практика: видно не лише
   *  «де я», а й де в документі щось є.
   */
  const mapEl = h(`<div class="map" title="прокрутка документа · позначки — статті з практикою">
      <div class="map__ticks"></div><div class="map__thumb"></div>
      <div class="map__tip" hidden></div></div>`);

  /* Екран згоди. Показується один раз.
   *
   * Сенс не в тому, щоб зняти з себе відповідальність, а в тому, щоб сказати
   * вголос дві речі, які юрист має знати до першого запиту: що номер статті
   * і пошуковий рядок ідуть на сервер, і що першоджерело завжди поруч.
   * Журналів ми не ведемо — але «не ведемо» це обіцянка, а те, що сервер у
   * момент запиту бачить звернення, — факт. Про факти попереджають заздалегідь.
   */
  const gate = h(`
    <div class="gate" hidden>
      <div class="gate__box" role="dialog" aria-modal="true" aria-labelledby="gate-t">
        <h2 class="gate__t" id="gate-t">Перш ніж почати</h2>

        <p class="gate__p"><b>Що йде на сервер.</b> Щоб показати практику, розширення
        питає вітрину даних: номер кодексу, номер статті чи її частини, обрані
        фільтри — і пошуковий рядок, якщо ви ним скористаєтесь. Більше нічого:
        ні імені, ні ідентифікатора, ні міток про вас.</p>

        <p class="gate__p"><b>Чого ми не робимо.</b> Не ведемо журналу запитів, не
        збираємо аналітики, не зберігаємо історію переглянутих статей. Код
        відкритий — це можна перевірити, а не прийняти на віру.</p>

        <p class="gate__p"><b>Про що варто знати чесно.</b> Будь-який сервер у момент
        обробки запиту бачить звернення. Ми його нікуди не записуємо, але сама
        можливість існує, поки дані лежать не у вас на комп'ютері. Якщо справа
        чутлива — тримайте це на увазі.</p>

        <p class="gate__p"><b>Praxis не замінює першоджерело.</b> Кожна картка веде на
        оригінал рішення в ЄДРСР, кожна редакція статті — на закон-підставу на
        сайті Ради. Посилайтеся в процесі на них, а не на нас.</p>

        <label class="gate__ok">
          <input type="checkbox" data-act="gate-check">
          <span>Прочитав і розумію</span>
        </label>

        <div class="gate__acts">
          <button class="gate__go" data-act="gate-accept" disabled>Далі</button>
          <a class="gate__link" href="${DISCLAIMER_URL}" target="_blank" rel="noopener noreferrer">повний текст ↗</a>
          <button class="gate__link gate__no" data-act="close">не зараз</button>
        </div>
      </div>
    </div>`);
  rail.appendChild(gate);

  rail.appendChild(mapEl);
  sh.appendChild(rail);

  const fab = h(`<button class="fab is-hidden" title="Показати практику (Alt+P)">
      <span class="fab__mark"></span>Практика ВС</button>`);
  sh.appendChild(fab);

  const toastEl = h('<div class="toast"></div>');
  sh.appendChild(toastEl);

  const $ = s => rail.querySelector(s);
  const listEl = $('.list');
  const sortEl = $('.sorts');
  const funnelEl = $('.funnel');
  const panelEl = $('.panel');
  const activeEl = $('.active');
  const normEl = $('[data-slot="norm"]');
  const jumpBox = $('.jumpbox');
  const jumpInput = $('.jumpbox input');
  const jumpHint = $('.jumpbox__hint');
  const searchBox = $('.searchbox');
  const searchInput = $('.searchbox input');
  const modeEl = $('.mode');

  const marker = document.createElement('div');
  marker.className = 'praxis-marker';
  root.appendChild(marker);

  let toastT;
  function toast(msg) {
    toastEl.textContent = msg;
    toastEl.classList.add('is-on');
    clearTimeout(toastT);
    toastT = setTimeout(() => toastEl.classList.remove('is-on'), 2600);
  }

  /* ── 4. завантаження даних ────────────────────────────────────────── */
  async function loadCounts() {
    if (API) {
      try {
        const d = await API.counts(ACT);
        if (d.articles && d.articles.size) {
          S.source = 'live';
          S.lawShort = d.law || S.lawShort;
          for (const [num, pair] of d.articles) COUNTS.set(num, pair);
          return;
        }
      } catch (e) {
        S.offlineReason = e.message;
      }
    }
    // Демо-набір є лише у збірці для розробки: у ньому вигадані номери справ,
    // тож у релізі його немає — і тоді чесно кажемо, що вітрина не відповідає.
    const hasDemo = ACT === DEMO.lawId || window.__PRAXIS_FORCE__;
    if (!hasDemo) { S.source = 'offline'; return; }
    S.source = 'demo';
    S.lawShort = DEMO.lawShort || '';
    for (const num of DEMO.order) COUNTS.set(num, [DEMO.articles[num].items.length, 0]);
  }

  /** Підвантажує картки статті (або окремої її частини), якщо їх ще немає. */
  function ensure(num, part) {
    if (!num || !COUNTS.has(num)) return;
    if (part === undefined) part = S.part;
    const key = pk(num, part);
    const rec = store.get(key);
    if (rec && rec.state !== 'error') return;

    if (S.source === 'offline') return;
    if (S.source === 'demo') {
      const d = DEMO.articles[num];
      store.set(key, { state: 'ready', items: d ? d.items.slice() : [], found: d ? d.items.length : 0 });
      return;
    }

    store.set(key, { state: 'loading' });
    API.cards(ACT, num, CARD_LIMIT, part, qopts()).then(r => {
      store.set(key, { state: 'ready', items: r.items, found: r.found });
      partsOf.set(num, r.parts || []);
      pathOf.set(key, r.path || []);
      facetsOf.set(num, r.facets || {});
      if (shown() === num) render();
    }).catch(e => {
      store.set(key, { state: 'error', error: e.message });
      if (shown() === num) render();
    });
  }

  /** Змінилися серверні параметри — перезапитуємо поточну статтю. */
  function refetch() {
    S.expanded.clear();
    ensure(shown());
    render();
    listEl.scrollTo({ top: 0, behavior: 'smooth' });
  }

  function retry(num) {
    store.delete(pk(num, S.part));
    if (API) API.forget(ACT, num);
    ensure(num);
    render();
  }

  /* ── 5. бейджі в заголовках ───────────────────────────────────────── */
  function mountBadges() {
    withPractice = [...COUNTS.keys()]
      .filter(n => byNum.has(n))
      .sort((a, b) => artKey(a) - artKey(b));

    for (const num of withPractice) {
      const a = byNum.get(num);
      const [total, vp] = COUNTS.get(num);
      if (!total) continue;

      const b = h(`<span class="praxis-badge${vp ? ' has-departure' : ''}" data-praxis-art="${esc(num)}"
          role="button" tabindex="0"
          title="${fmtNum(total)} рішень ВС тлумачать цю статтю${vp ? `, з них ${vp} — Великої Палати` : ''} · клік — закріпити">
          <span class="praxis-badge__dot"></span>ВС · ${fmtCompact(total)}</span>`);
      a.el.appendChild(document.createTextNode(' '));
      a.el.appendChild(b);
      a.badge = b;

      b.addEventListener('mouseenter', () => { S.peek = num; ensure(num); ensureNorms(num); render(); });
      b.addEventListener('mouseleave', () => { S.peek = null; render(); });
      b.addEventListener('click', e => {
        e.preventDefault(); e.stopPropagation();
        S.pinned = S.pinned === num ? null : num;
        S.peek = null;
        if (!S.open) setOpen(true);
        ensure(S.pinned || shown());
        render();
        listEl.scrollTo({ top: 0, behavior: 'smooth' });
      });
      b.addEventListener('keydown', e => {
        if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); b.click(); }
      });
    }
  }

  /** номер статті → Map(ключ норми → скільки рішень) */
  const normsOf = new Map();
  /** номер статті → {count, versions} */
  const histOf = new Map();
  /** Map(стаття → скільки редакцій), лише де більше однієї */
  let versionsMap = null;
  let futureMap = new Map();

  /** Бейдж біля КОЖНОЇ норми просто в тексті закону.
   *
   *  Структура статті вже намальована в тексті — дублювати її списком чипів
   *  у панелі шириною 404 px безглуздо: у ст. 14 ПКУ таких вузлів 120.
   *  Навігація живе там, де юрист і так дивиться: біля «14.1.257.» стоїть
   *  число рішень саме по цьому підпункту.
   */
  function ensureNorms(num) {
    if (!num || normsOf.has(num) || S.source !== 'live' || !API) return;
    normsOf.set(num, new Map());                 // щоб не смикати бекенд двічі
    API.norms(ACT, num).then(r => {
      normsOf.set(num, r.map);
      mountNormBadges(num, r.map);
    }).catch(() => normsOf.delete(num));
  }

  function mountNormBadges(num, map) {
    if (!map || !map.size) return;
    const seen = new Set();
    for (const n of norms) {
      if (n.art !== num || seen.has(n.part)) continue;
      seen.add(n.part);
      const count = map.get(n.part);
      if (!count || n.el.querySelector('.praxis-badge')) continue;

      const b = h(`<span class="praxis-badge praxis-badge--part" data-praxis-part="${esc(n.part)}"
          role="button" tabindex="0"
          title="${fmtNum(count)} рішень ВС по цій нормі · клік — показати">
          <span class="praxis-badge__dot"></span>ВС · ${fmtCompact(count)}</span>`);
      n.el.appendChild(document.createTextNode(' '));
      n.el.appendChild(b);

      const pick = e => {
        e.preventDefault(); e.stopPropagation();
        S.part = n.part; S.partManual = true;
        S.filter = 'all'; S.expanded.clear();
        if (!S.open) setOpen(true);
        ensure(num); render();
        listEl.scrollTo({ top: 0, behavior: 'smooth' });
      };
      b.addEventListener('click', pick);
      b.addEventListener('keydown', e => { if (e.key === 'Enter' || e.key === ' ') pick(e); });
    }
    root.querySelectorAll('.praxis-badge--part').forEach(x =>
      x.classList.toggle('is-pinned', x.dataset.praxisPart === S.part));
  }

  /** Скільки разів статтю переписували. Бейдж зʼявляється лише там, де
   *  редакцій більше однієї: 870 із 1383 статей ЦКУ не мінялися ніколи. */
  async function loadVersions() {
    if (versionsMap || S.source !== 'live' || !API) return;
    try {
      const v = await API.versions(ACT);
      versionsMap = v.counts; futureMap = v.future;
    } catch (e) { versionsMap = new Map(); }
    for (const art of arts) {
      const n = versionsMap.get(art.num);
      if (!n || art.histBadge) continue;
      const fut = futureMap.get(art.num);
      const b = h(`<span class="praxis-badge praxis-badge--hist${fut ? ' has-future' : ''}" data-praxis-hist="${esc(art.num)}"
          role="button" tabindex="0"
          title="Статтю змінювали: ${n} редакці${n < 5 ? 'ї' : 'й'}.${fut
            ? ` З ${fmtDate(fut)} набирає чинності нова редакція.` : ''} Клік — історія змін і текст на будь-яку дату.">
          ред. ${n}${fut ? ' ⚠' : ''}</span>`);
      art.el.appendChild(document.createTextNode(' '));
      art.el.appendChild(b);
      art.histBadge = b;
      const open = e => {
        e.preventDefault(); e.stopPropagation();
        // натиснули бейдж СТАТТІ — отже й історію показуємо статті цілком.
        // Раніше лишалася норма, обрана колись раніше, і панель мовчки
        // фільтрувала: «ця редакція не торкнулася обраної норми» при тому,
        // що нічого не обиралося.
        S.pinned = art.num; S.peek = null; S.mode = 'history';
        S.part = null; S.partManual = true;
        if (!S.open) setOpen(true);
        ensureHistory(art.num); render();
        listEl.scrollTo({ top: 0 });
      };
      b.addEventListener('click', open);
      b.addEventListener('keydown', e => { if (e.key === 'Enter' || e.key === ' ') open(e); });
    }
  }

  /** Порівняння двох довільних дат — юрист звіряє «на дату договору» проти
      «на дату спору», а між ними може лежати кілька поправок. */
  const cmpOf = new Map();
  function cmpKey(num) {
    return [num, S.part == null ? '*' : S.part, S.onDate, S.cmpDate].join('|');
  }
  function ensureCompare(num) {
    const key = cmpKey(num);
    if (!num || !S.onDate || !S.cmpDate || cmpOf.has(key) || !API) return;
    cmpOf.set(key, { state: 'loading' });
    API.compare(ACT, num, S.onDate, S.cmpDate, S.part).then(d => {
      cmpOf.set(key, { state: 'ready', ...d });
      if (shown() === num) render();
    }).catch(() => cmpOf.delete(key));
  }

  const HIST_PAGE = 6;

  function histKey(num) { return num + '|' + (S.part == null ? '*' : S.part); }

  function ensureHistory(num) {
    const key = histKey(num);
    if (!num || histOf.has(key) || !API) return;
    histOf.set(key, { state: 'loading' });
    API.history(ACT, num, S.part, 0, HIST_PAGE).then(d => {
      histOf.set(key, { state: 'ready', ...d });
      if (shown() === num) render();
    }).catch(e => {
      histOf.set(key, { state: 'error', error: e.message });
      if (shown() === num) render();
    });
  }

  /** Догрузка наступного вікна редакцій — при дотику до кінця списку. */
  function moreHistory(num) {
    const key = histKey(num);
    const rec = histOf.get(key);
    if (!rec || rec.state !== 'ready' || !rec.has_more || rec.more || !API) return;
    rec.more = true;
    if (shown() === num) render();
    API.history(ACT, num, S.part, rec.versions.length, HIST_PAGE).then(d => {
      const cur = histOf.get(key);
      if (!cur) return;
      // може приїхати повторно після швидкої прокрутки — зшиваємо за датою
      const seen = new Set(cur.versions.map(v => v.valid_from));
      cur.versions = cur.versions.concat((d.versions || []).filter(v => !seen.has(v.valid_from)));
      cur.has_more = d.has_more;
      cur.more = false;
      if (shown() === num) render();
    }).catch(() => {
      const cur = histOf.get(key);
      if (cur) { cur.more = false; cur.moreError = true; }
      if (shown() === num) render();
    });
  }

  /* ── 6. рендер ────────────────────────────────────────────────────── */
  function visibleItems(num) {
    const rec = store.get(pk(num, S.part));
    if (!rec || rec.state !== 'ready') return [];
    let items = rec.items.slice();
    if (S.currentOnly) items = items.filter(i => !(i.law && i.law.stale));
    return items;
  }

  /** Ієрархія статусів: картка отримує РІВНО ОДНУ позначку — найважчу.
   *
   * Питання, на яке відповідає картка, одне: «чи можна на це послатися
   * сьогодні». Якщо від висновку вже відступили, байдуже, що свого часу він
   * сам змінив практику, — відповідь усе одно «ні». Тому позначки не
   * додаються одна до одної, а витісняють: червона > бурштинова > зелена.
   * Повний розклад лишається в розгорнутій картці.
   */
  function statusOf(it) {
    const lv = it.law;
    // Відступ Великої Палати — найважчий сигнал з усіх: це остаточна зміна
    // практики, а не позиція однієї касації.
    if (it.overruledGc || it.status === 'overruled_gc') {
      return {
        cls: 'neg', label: 'відступила ВП',
        title: 'Від висновку цієї справи відступила Велика Палата Верховного Суду. '
          + 'Посилатися на нього як на чинну позицію не можна.'
          + (it.note ? ' ' + it.note : '')
      };
    }
    if (it.negative || it.status === 'overruled' || it.status === 'narrowed') {
      return {
        cls: 'neg', label: `неактуальне${it.negative ? ' · ' + it.negative : ''}`,
        title: `Від висновку цієї справи відступили пізніші рішення ВС`
          + `${it.negative ? ` — ${it.negative} раз` : ''}. Посилатися як на чинну позицію ризиковано.`
          + (it.note ? ' ' + it.note : '')
      };
    }
    if (lv && lv.stale) {
      const n = lv.changes_since;
      return {
        cls: 'stale', label: `ред. статті ${fmtDate(lv.valid_from)}`, goHistory: it.date,
        title: `Рішення тлумачить редакцію статті від ${fmtDate(lv.valid_from)}; після нього статтю `
          + `змінювали ${n} ${n === 1 ? 'раз' : n < 5 ? 'рази' : 'разів'}. Позначка стосується статті `
          + `загалом — історії окремих частин і пунктів у базі немає.`
      };
    }
    if (it.kind === 'departure') {
      return {
        cls: 'chg', label: 'змінило практику',
        title: 'У цьому рішенні суд сам відступив від попереднього висновку — це нова, змінена позиція.'
      };
    }
    return null;
  }

  /** Повний розклад — у розгорнутій картці, де є місце пояснити. */
  function statusLines(it) {
    const out = [];
    if (it.overruledGc) out.push(['neg', 'від висновку відступила Велика Палата']);
    if (it.negative) out.push(['neg', `від висновку відступили: ${it.negative}`]);
    if (it.note) out.push(['note', it.note.replace(/^[a-z_]+:\s*/, '')]);
    if (it.status === 'overruled' && !it.negative) out.push(['neg', 'висновок скасовано пізнішою практикою']);
    if (it.law && it.law.stale) out.push(['stale', `рішення про редакцію статті від ${fmtDate(it.law.valid_from)}`]);
    if (it.kind === 'departure') out.push(['chg', 'саме відступило від попереднього висновку']);
    if (it.affirmed) out.push(['ok', `висновок підтверджено: ${it.affirmed}`]);
    return out;
  }

  function cardHTML(it, num, idx, q) {
    const id = num + ':' + (it.docId || it.caseNo);
    const open = S.expanded.has(id);
    let thesis = esc(it.thesis);
    // те, через що картка тут, має кидатися в очі першим
    if (it.raw) {
      const r = esc(it.raw).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      thesis = thesis.replace(new RegExp(r, 'gi'), m => `<b class="hit">${m}</b>`);
    }
    if (q) {
      const re = new RegExp('(' + q.trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + ')', 'gi');
      thesis = thesis.replace(re, '<mark>$1</mark>');
    }
    const stats = [];
    if (it.applied) stats.push(`<span>цитують <b>${fmtNum(it.applied)}</b> рішень`
      + (it.inPosition ? `, у мотивувальній <b>${fmtNum(it.inPosition)}</b>` : '')
      + (it.appliedGc ? `, з них ВП <b>${it.appliedGc}</b>` : '') + `</span>`);
    if (it.affirmed) stats.push(`<span>підтвердили <b>${it.affirmed}</b></span>`);
    if (it.via && it.via.kind === 'context') {
      stats.push(`<span>виведено з контексту: термін <b>«${esc(it.via.term)}»</b> `
        + `за ${it.via.distance} знаків від цитати</span>`);
    } else if (it.via) {
      stats.push(`<span>посилання на <b>п. ${esc(it.via.point)}</b> відновлено з тексту рішення</span>`);
    }
    else if (it.raw) stats.push(`<span>згадка: <b>${esc(it.raw)}</b></span>`);
    if (it.relevance != null) stats.push(`<span>релевантність <b>${Math.round(it.relevance * 100)}%</b></span>`);

    return `
      <article class="card${open ? ' is-open' : ''} lvl-${(statusOf(it) || {}).cls || 'none'}" data-kind="${esc(it.kind)}" data-id="${esc(id)}" data-art="${esc(num)}"
               style="animation-delay:${Math.min(idx, 6) * 28}ms">
        <div class="card__head">
          <span class="court" data-c="${courtKind(it.court)}">${esc(it.court)}</span>
          ${it.form === 10 ? `<span class="opin" title="окрема думка судді — це не позиція суду">окрема думка</span>` : ''}
          <span class="card__date">${fmtDate(it.date)}</span>
          ${it.applied ? `<span class="cites" title="скільки рішень послалися на цю справу">${fmtCompact(it.applied)} ↩</span>` : ''}
          ${(st => !st ? '' : st.goHistory
              ? `<button class="${st.cls} mark mark--go" data-act="to-history" data-on="${esc(st.goHistory)}"`
                + ` title="${esc(st.title)} Натисніть, щоб побачити редакцію, чинну на дату рішення.">${esc(st.label)}</button>`
              : `<span class="${st.cls} mark" title="${esc(st.title)}">${esc(st.label)}</span>`)(statusOf(it))}
        </div>
        <div class="card__case">справа № ${esc(it.caseNo)}</div>
        <p class="card__thesis">${thesis}</p>
        <div class="card__more"><div class="card__more-in">
          ${it.full.map(p => `<p>${esc(p)}</p>`).join('')}
          ${(ls => ls.length ? `<div class="card__flags">` + ls.map(([c, t]) =>
              `<span class="${c} mark">${esc(t)}</span>`).join('') + `</div>` : '')(statusLines(it))}
          ${stats.length ? `<div class="card__stat">${stats.join('')}</div>` : ''}
        </div></div>
        <div class="card__foot">
          <div class="tags">${!it.via ? '' : it.via.kind === 'context'
            ? `<span class="tag tag--ctx" title="Суд не назвав цей підпункт прямо. Звʼязок виведено з контексту: поруч (${it.via.distance} знаків) вжито термін «${esc(it.via.term)}», який визначає саме його.${it.via.confidence === 'medium' ? ' Термін загальний — перевірте.' : ''}">з контексту${it.via.confidence === 'medium' ? ' ?' : ''}</span>`
            : `<span class="tag tag--rec" title="Суд назвав цей підпункт у тексті рішення, але основний розбір посилань його не витяг. Звʼязок відновлено окремим проходом — це повноцінне посилання суду.">відновлене</span>`}${it.tags.map(t =>
            `<span class="tag${/відступ/i.test(t) ? ' tag--dep' : ''}">${esc(t)}</span>`).join('')}</div>
          <div class="acts">
            <button class="act" data-act="copy" title="Скопіювати посилання на справу">${ICON.copy}</button>
            <button class="act" data-act="goto" title="Перейти до статті в тексті">${ICON.jump}</button>
            <button class="act" data-act="ext" title="Відкрити рішення в ЄДРСР">${ICON.ext}</button>
          </div>
        </div>
      </article>`;
  }

  function skeletonHTML(n = 3) {
    return Array.from({ length: n }, (_, i) => `
      <div class="skel" style="animation-delay:${i * 90}ms">
        <div class="skel__row" style="width:46%"></div>
        <div class="skel__row" style="width:32%"></div>
        <div class="skel__row skel__row--tall"></div>
      </div>`).join('');
  }

  const SRC_FALLBACK = ['—', 'is-demo', ''];

  function emptyHTML(title, sub, near, action) {
    return `<div class="empty">
      <div class="empty__ico">${action === 'retry' ? ICON.retry : ICON.empty}</div>
      <div class="empty__t">${esc(title)}</div>
      <div class="empty__s">${esc(sub)}</div>
      ${near ? `<button class="empty__jump" data-goto="${esc(near)}">Стаття ${esc(near)} →</button>` : ''}
      ${action === 'retry' ? '<button class="empty__jump" data-act="retry">Спробувати ще раз</button>' : ''}
      ${action === 'retry-history' ? '<button class="empty__jump" data-act="retry-history">Спробувати ще раз</button>' : ''}
      ${action === 'reset' ? '<button class="empty__jump" data-act="reset-all">Скинути всі фільтри</button>' : ''}
    </div>`;
  }

  const CHIP_CAP = 8;

  /** Поточна норма — чипом у рядку статті, а не окремим рядом крихт.
   *  Вибір норми робиться бейджем у тексті, тож тут потрібно лише показати,
   *  що саме звужено, і дати це зняти.
   */
  function renderParts(num) {
    const path = pathOf.get(pk(num, S.part)) || [];
    if (!path.length) {
      normEl.innerHTML = '';
      return;
    }
    const last = path[path.length - 1];
    const full = path.map(x => x.label).join(' › ');
    normEl.innerHTML = `<button class="normchip" data-p="*"`
      + ` title="Показано практику по ${esc(full)}. Натисніть, щоб повернутися до всієї статті.">`
      + `${esc(last.label)}<span class="normchip__x">✕</span></button>`;
  }

  const SORTS = [
    ['authority', 'Авторитет', 'Велика Палата і об’єднані палати попереду'],
    ['cited', 'Цитовані', 'на які найчастіше посилаються інші рішення']
  ];
  const STAIRS = {
    fresh: '<svg viewBox="0 0 16 16" fill="currentColor"><rect x="2" y="9" width="3" height="5" rx="1"/>'
      + '<rect x="6.5" y="6" width="3" height="8" rx="1"/><rect x="11" y="2.5" width="3" height="11.5" rx="1"/></svg>',
    oldest: '<svg viewBox="0 0 16 16" fill="currentColor"><rect x="2" y="2.5" width="3" height="11.5" rx="1"/>'
      + '<rect x="6.5" y="6" width="3" height="8" rx="1"/><rect x="11" y="9" width="3" height="5" rx="1"/></svg>'
  };

  function renderFilters(num) {
    const rec = store.get(pk(num, S.part));
    const ready = rec && rec.state === 'ready';
    $('.bar').hidden = !ready && !activeFilters() && !S.query.trim();
    if ($('.bar').hidden) return;

    if (S.mode === 'history') {
      sortEl.innerHTML = `<button class="s" data-act="to-practice" title="повернутися до практики">‹ Практика</button>`
        + `<span class="s is-on">Історія</span>`;
      funnelEl.classList.remove('is-on');
      const hasDates = !!(S.onDate || S.cmpDate);
      // Перемикач «лише суттєві» — тут, а не лише в кінці списку: історія
      // ст. 14 ПКУ це 73 редакції, і кнопку внизу юрист побачить нескоро.
      funnelEl.hidden = false;
      funnelEl.className = 'funnel funnel--plain';   // у режимі історії це ряд чипів, не кнопка
      funnelEl.innerHTML =
        `<button class="s${S.showRedundant ? '' : ' is-on'}" data-act="show-redundant"`
        + ` title="сховати редакції, де змінилося лише оформлення, нумерація або підстава">`
        + `лише суттєві</button>`
        + (hasDates ? `<button class="s" data-act="clear-dates">скинути дати</button>` : '');
      // дати — окремим рядом: два поля в один рядок із перемикачем не влазять
      panelEl.hidden = false;
      panelEl.className = 'panel panel--dates';
      panelEl.innerHTML =
        `<label class="dlab">на дату<input class="ondate" type="date" value="${esc(S.onDate)}"`
        + ` data-role="on" title="показати редакцію, чинну на цю дату"></label>`
        + `<span class="ondate__vs" title="порівняти дві редакції">↔</span>`
        + `<label class="dlab">порівняти з<input class="ondate" type="date" value="${esc(S.cmpDate)}"`
        + ` data-role="cmp" title="друга дата: різниця між двома редакціями"></label>`;
      activeEl.hidden = true;
      return;
    }

    funnelEl.className = 'funnel';
    const byDate = S.sort === 'fresh' || S.sort === 'oldest';
    sortEl.innerHTML =
      `<button class="stairs${byDate ? ' is-on' : ''}" data-act="stairs"`
      + ` title="${byDate && S.sort === 'oldest'
            ? 'Спочатку старі — натисніть, щоб перевернути на свіжі'
            : 'Спочатку свіжі — натисніть, щоб перевернути на старі'}">`
      + `${STAIRS[S.sort === 'oldest' ? 'oldest' : 'fresh']}`
      + `<span>${S.sort === 'oldest' ? 'старі' : 'свіжі'}</span></button>`
      + SORTS.map(([k, label, hint]) =>
          `<button class="s${S.sort === k ? ' is-on' : ''}" data-s="${k}" title="${esc(hint)}">${label}</button>`).join('');

    const n = activeFilters();
    funnelEl.hidden = false;
    funnelEl.classList.toggle('is-on', S.filtersOpen || !!n);
    funnelEl.innerHTML = `Фільтри${n ? `<span class="funnel__n">${n}</span>` : ''}`;

    // Активні фільтри видно завжди, навіть коли панель згорнута: інакше
    // юрист дивиться на звужений список і не розуміє, чому він такий короткий.
    const f = facetsOf.get(num) || {};
    const nameOf = (grp, code) => ((f[grp] || []).find(x => x.code === code) || {}).name || code;
    const act = [];
    S.courts.forEach(c => act.push(['court:' + c, nameOf('court', c)]));
    S.jk.forEach(c => act.push(['jk:' + c, nameOf('justice', c)]));
    if (S.cat) act.push(['cat', nameOf('category', S.cat)]);
    if (S.flags.includes('actual')) act.push(['flag:actual', 'лише актуальні']);
    if (S.flags.includes('departure')) act.push(['flag:departure', 'змінили практику']);
    if (S.opinions) act.push(['opinions', 'з окремими думками']);
    if (S.since) act.push(['since', 'за 3 роки']);
    if (S.currentOnly) act.push(['current', 'чинна редакція']);
    if (S.query.trim()) act.push(['query', '«' + S.query.trim() + '»']);

    activeEl.hidden = !act.length;
    activeEl.innerHTML = act.map(([k, label]) =>
      `<button class="chip" data-drop="${esc(k)}" title="прибрати фільтр">`
      + `<span class="f__l">${esc(label.length > 26 ? label.slice(0, 25) + '…' : label)}</span>✕</button>`).join('');

    panelEl.className = 'panel';
    panelEl.hidden = !S.filtersOpen;
    if (panelEl.hidden) return;
    const chips = (list, key, sel, attr) => (list || []).map(x =>
      `<button class="f${(Array.isArray(sel) ? sel.includes(x.code) : sel === x.code) ? ' is-on' : ''}"`
      + ` data-${attr}="${esc(x.code)}" title="${esc(x.name)}">`
      + `<span class="f__l">${esc(x.name.length > 30 ? x.name.slice(0, 29).trimEnd() + '…' : x.name)}</span>`
      + `<span class="f__n">${fmtCompact(x.count)}</span></button>`).join('');

    const group = (title, body) => body
      ? `<div class="grp"><div class="grp__t">${title}</div><div class="grp__b">${body}</div></div>` : '';

    const stale = ready ? rec.items.filter(i => i.law && i.law.stale).length : 0;

    panelEl.innerHTML =
      group('Суд', chips(f.court, 'court', S.courts, 'court'))
      + group('Судочинство', chips(f.justice, 'jk', S.jk, 'jk'))
      + group('Категорія справи', chips(f.category, 'cat', S.cat, 'cat'))
      + group('Статус висновку',
          `<button class="f${S.flags.includes('actual') ? ' is-on' : ''}" data-act="flag-actual"`
          + ` title="сховати справи, від висновку яких уже відступили пізніші рішення ВС">лише актуальні</button>`
          + `<button class="f${S.flags.includes('departure') ? ' is-on' : ''}" data-act="flag-departure"`
          + ` title="рішення, у яких суд САМ відступив від попереднього висновку і змінив практику">змінили практику</button>`
          + `<button class="f${S.opinions ? ' is-on' : ''}" data-act="opinions"`
          + ` title="окрема думка — позиція судді, а не суду; типово прихована">окремі думки</button>`)
      + group('Час і редакція',
          `<button class="f${S.since ? ' is-on' : ''}" data-act="since" title="лише рішення останніх трьох років">за 3 роки</button>`
          + (stale || S.currentOnly
              ? `<button class="f${S.currentOnly ? ' is-on' : ''}" data-act="current"`
                + ` title="сховати рішення, ухвалені до останньої зміни статті">чинна редакція</button>` : ''))
      + (n ? `<button class="reset" data-act="reset">Скинути ${n}</button>` : '');
  }

  const RADA = 'https://zakon.rada.gov.ua/laws/show/';
  // скликання ВР у номері акта: № 71-VIII → nreg 71-19
  const CONV = { I: 12, II: 13, III: 14, IV: 15, V: 16, VI: 17, VII: 18, VIII: 19, IX: 20, X: 21 };
  const nregOf = num => {
    const m = /^(\d+[а-яa-z\-\d]*)-([IVX]+)$/i.exec(num || '');
    return m && CONV[m[2].toUpperCase()] ? `${m[1]}-${CONV[m[2].toUpperCase()]}` : null;
  };

  /** Зміни, згадані примітками Ради просто в тексті статті.
   *  Виявилося, що вони повніші за article_versions: по ст. 8 ПКУ примітка
   *  називає Закон № 71-VIII, а редакції за ним у базі немає. */
  function articleNotes(num) {
    const a = byNum.get(num);
    if (!a) return [];
    const out = [];
    let el = a.el.nextElementSibling;
    while (el && el !== a.nextEl) {
      const t = (el.textContent || '').trim();
      if (t.startsWith('{')) {
        // у примітці зазвичай є пряме посилання на закон — беремо nreg звідти,
        // це надійніше за перетворення «№ 71-VIII» → 71-19 вручну
        const hrefs = [...el.querySelectorAll('a[href*="/laws/show/"]')]
          .map(x => (/\/laws\/show\/([^/#?]+)/.exec(x.getAttribute('href') || '') || [])[1])
          .filter(Boolean);
        const acts = [...t.matchAll(/№\s*([\dа-яa-z\-]+-[IVXІ]+)\s+від\s+(\d{2})\.(\d{2})\.(\d{4})/gi)]
          .map((m, i) => ({ num: m[1], date: `${m[4]}-${m[3]}-${m[2]}`,
                            nreg: hrefs[i] || nregOf(m[1]) }));
        if (acts.length) out.push({ text: t.replace(/^\{|\}$/g, ''), acts });
      }
      el = el.nextElementSibling;
    }
    return out;
  }

  /** Фрагмент зміни клікабельний: веде до цієї норми в тексті закону.
   *  Для вилучених норм вести нікуди — кажемо про це прямо. */
  /* Диф як режим рецензування у Word.
   *
   *  Сервер віддає зміну, розкладену по нормах, а всередині норми — речення.
   *  Змінене речення показуємо ЦІЛКОМ, із закресленим старим і підкресленим
   *  новим усередині. Саме цього бракувало: раніше юрист бачив «було:
   *  затвердженого · стало: та/або до Переліку лікарських засобів…» і не
   *  розумів, звідки в статті про податкові різниці взялися договори.
   *
   *  Незмінені речення лишаємо як контекст, але згортаємо довгі прогони —
   *  інакше норма на три тисячі знаків витісняє саму правку.
   */
  const CTX_KEEP = 1;          // скільки незмінних речень лишати обабіч правки

  function sentHTML(s) {
    if (s.op === 'equal') return `<span class="sx">${esc(s.text)}</span>`;
    if (s.op === 'insert') return `<ins class="sx">${esc(s.text)}</ins>`;
    if (s.op === 'delete') return `<del class="sx">${esc(s.text)}</del>`;
    return '<span class="sx">' + (s.parts || []).map(([op, t]) =>
      op === '-' ? `<del>${esc(t)}</del>`
        : op === '+' ? `<ins>${esc(t)}</ins>` : esc(t)).join('') + '</span>';
  }

  /** Згортає довгі прогони незмінного тексту в «…». */
  function trimContext(sents) {
    const keep = sents.map(s => s.op !== 'equal');
    for (let i = 0; i < sents.length; i++) {
      if (!keep[i]) continue;
      for (let d = 1; d <= CTX_KEEP; d++) { keep[i - d] = keep[i - d] || i - d >= 0; keep[i + d] = keep[i + d] || i + d < sents.length; }
    }
    const out = [];
    let skipped = 0;
    sents.forEach((s, i) => {
      if (keep[i]) {
        if (skipped) { out.push({ op: 'gap', n: skipped }); skipped = 0; }
        out.push(s);
      } else skipped++;
    });
    if (skipped) out.push({ op: 'gap', n: skipped });
    return out;
  }

  function normChangeHTML(ch, num) {
    const label = ch.norm ? normLabel(num, ch.norm) : '';
    if (ch.op === 'article_gone')
      return `<div class="nev nev--gone"><b>Статтю виключено</b> з кодексу</div>`;
    if (ch.op === 'article_back')
      return `<div class="nev nev--new"><b>Статтю відновлено</b> в кодексі</div>`;
    if (ch.op === 'new')
      return `<div class="nchg nchg--new"><div class="nchg__h"><b>${esc(label)}</b> — норми не було, додано</div>
                <div class="nchg__b"><ins class="sx">${esc(ch.text || '')}</ins></div></div>`;
    if (ch.op === 'gone')
      return `<div class="nchg nchg--gone"><div class="nchg__h"><b>${esc(label)}</b> — норму виключено</div>
                <div class="nchg__b"><del class="sx">${esc(ch.text || '')}</del></div></div>`;
    const body = trimContext(ch.sentences || []).map(s =>
      s.op === 'gap'
        ? `<span class="sx sx--gap" title="${s.n} речень без змін">…</span>`
        : sentHTML(s)).join(' ');
    return `<div class="nchg"><div class="nchg__h"><b>${esc(label)}</b></div>
              <div class="nchg__b">${body}</div></div>`;
  }

  function diffHTML(ch, num) {
    if (ch.sentences || ch.op === 'new' || ch.op === 'gone'
        || ch.op === 'article_gone' || ch.op === 'article_back')
      return normChangeHTML(ch, num);
    const del = ch.was ? `<del>${esc(ch.was)}</del>` : '';
    const ins = ch.now ? `<ins>${esc(ch.now)}</ins>` : '';
    // «ч. 2», а не голе «2», інакше маркер зливається з текстом фрагмента
    const chip = ch.norm
      ? `<span class="hunk__n">${esc(num ? normLabel(num, ch.norm) : ch.norm)}</span>` : '';
    return `<div class="hunk" data-hunk="${esc(ch.norm || '')}" data-op="${esc(ch.op)}"`
      + ` title="${ch.op === 'delete' ? 'норму вилучено з тексту' : 'показати цю норму в тексті'}">`
      + `${chip}${del}${ins}</div>`;
  }

  /* Роловер: коли хвіст списку входить у видиму частину панелі — тягнемо
   * наступне вікно. Кнопка лишається для тих, хто прокручує ривками, і як
   * запасний шлях, якщо спостерігач недоступний. */
  let tailObs = null;

  function watchTail() {
    if (!tailObs) {
      try {
        tailObs = new IntersectionObserver(es => {
          for (const e of es) {
            if (!e.isIntersecting) continue;
            const num = e.target.dataset.tail;
            if (num) moreHistory(num);
          }
        }, { root: listEl, rootMargin: '400px 0px' });
      } catch (err) { return; }
    }
    tailObs.disconnect();
    const t = listEl.querySelector('.tail[data-tail]');
    if (t) tailObs.observe(t);
  }

  /** Прокрутка до норми без зміни того, що показує панель. */
  function scrollToNorm(num, part, op) {
    const a = byNum.get(num);
    if (!a) return;
    measure();
    const n = part && norms.find(x => x.art === num && x.part === part);
    if (!n && op === 'delete') {
      toast(`Норму ${part.includes('.') ? 'п. ' : 'ч. '}${part} вилучено — `
        + 'у чинному тексті її немає');
    }
    const el = n ? n.el : a.el;
    const top = n ? n.top : a.top;
    window.scrollTo({ top: Math.max(0, top - window.innerHeight / 3), behavior: 'smooth' });
    flash(el);
  }

  /** Людський підпис норми: ЦКУ «ч. 2», ПКУ «п. 140.5». */
  function normLabel(num, part) {
    if (part === '') return 'посилань без частини';
    return (String(part).includes('.') ? 'п. ' : 'ч. ') + part;
  }

  /** Чому в редакції нічого не показано — трьома різними причинами. */
  const TECH_WHY = {
    numbering: 'нумерація й пунктуація',
    refs: 'оформлення посилань на акти',
    symbols: 'заміна знаків — § замість «параграф», № замість N',
    glyphs: 'апострофи, тире й лапки іншого накреслення',
    format: 'оформлення тексту'
  };

  /** «лише технічні» — але які саме. Юрист має розуміти, чого не побачив. */
  function techWhy(v) {
    const k = (v.tech_kinds || []).map(x => TECH_WHY[x]).filter(Boolean);
    return k.length ? k.join(' і ') : 'службові правки';
  }

  /** Технічні правки: згорнуті, але доступні.
   *
   *  Ховати їх зовсім не можна — це текст закону, і юрист має право
   *  переконатися сам, що ми відкинули саме дрібниці. Але й показувати
   *  завжди не можна: у ст. 14 ПКУ їх вісімдесят дві на одну редакцію.
   */
  function techBlock(v, num) {
    const n = v.technical;
    const word = n === 1 ? 'технічна правка' : n < 5 ? 'технічні правки' : 'технічних правок';
    const list = (v.tech_changes || []).map(ch => diffHTML(ch, num)).join('');
    return `<div class="tech">
        <button class="tech__t" data-act="tech" aria-expanded="false">
          <span class="tech__ico">›</span>+ ${n} ${word}
          <span class="ver__hint">${esc(techWhy(v))}</span>
        </button>
        ${list ? `<div class="tech__body" hidden>${list}</div>` : ''}
      </div>`;
  }

  function emptyVer(v, num) {
    if (S.part != null) {
      return `${normLabel(num, S.part)} у цій редакції не змінювалася`;
    }
    if (v.same_text) {
      return 'текст норми той самий — змінилося лише оформлення';
    }
    if (v.technical) {
      return `змінилося лише ${techWhy(v)} — текст норми той самий`;
    }
    return 'текст статті не змінився — редакцію створено через правки в інших '
      + 'частинах акта або через переоформлення приміток';
  }

  function renderHistory(num) {
    const rec = histOf.get(num + '|' + (S.part == null ? '*' : S.part));
    const countEl = $('[data-slot="count"]');

    if (!rec || rec.state === 'loading') {
      countEl.textContent = 'завантаження…';
      listEl.innerHTML = skeletonHTML();
      return;
    }
    // Не змогли завантажити — це не те саме, що «редакцій немає».
    // Стаття 14 ПКУ має 73 редакції, і саме на ній запит найчастіше не встигає.
    if (rec.state === 'error') {
      countEl.textContent = '';
      listEl.innerHTML = emptyHTML('Не вдалося завантажити історію',
        rec.error === 'timeout'
          ? 'Стаття велика, відповідь не встигла прийти. Спробуйте ще раз — '
            + 'наступного разу буде швидше, вітрина її вже порахувала.'
          : `Вітрина відповіла: ${rec.error}.`,
        null, 'retry-history');
      return;
    }
    if (!rec.versions || !rec.versions.length) {
      countEl.textContent = '';
      listEl.innerHTML = emptyHTML('Історії немає',
        'У базі законів немає редакцій цієї статті.', null);
      return;
    }

    countEl.textContent = `${rec.count} редакці${rec.count < 5 ? 'ї' : 'й'}`;

    // Звуження до норми має бути видно: інакше половина карток порожня
    // без видимої причини
    const scope = S.part != null
      ? `<div class="scope">Показано лише зміни <b>${esc(normLabel(num, S.part))}</b>
           <button data-act="scope-all">усі зміни статті ${esc(num)}</button></div>`
      : '';

    // Майбутня редакція — попередження, якого немає в жодному сервісі.
    // Порад про те, що юристові робити зі своїми справами, тут не даємо:
    // він читає і податковий, і цивільний кодекс, і що саме йому звіряти —
    // не наша справа. Наша справа — сказати, що зміниться, і показати це.
    let banner = '';
    const fut = rec.versions.find(v => v.future);
    if (fut) {
      const n = (fut.changes || []).length;
      const what = n
        ? `<button class="onmark__go" data-act="to-version" data-from="${esc(fut.valid_from)}">
             показати ${n} ${n === 1 ? 'зміну' : n < 5 ? 'зміни' : 'змін'} →</button>`
        : fut.technical
          ? `<div class="onmark__s">Лише технічні правки — нумерація й пунктуація</div>`
          : '';
      banner += `<div class="onmark onmark--warn">З <b>${fmtDate(fut.valid_from)}</b> набирає`
        + ` чинності нова редакція.${what ? ' ' + what : ''}</div>`;
    }

    // порівняння двох дат
    const cmp = cmpOf.get(cmpKey(num));
    if (cmp && cmp.state === 'ready' && cmp.found) {
      banner += cmp.same
        ? `<div class="onmark">Між ${fmtDate(cmp.from)} і ${fmtDate(cmp.to)} стаття не змінювалася —
             діяла та сама редакція від <b>${fmtDate(cmp.a.valid_from)}</b>.</div>`
        : `<div class="onmark onmark--cmp">
             <div class="onmark__t">Різниця між ${fmtDate(cmp.from)} і ${fmtDate(cmp.to)}</div>
             <div class="onmark__s">редакції ${fmtDate(cmp.a.valid_from)} → ${fmtDate(cmp.b.valid_from)},
               поправок між ними: ${cmp.steps}</div>
             ${cmp.changes.length ? cmp.changes.map(ch => diffHTML(ch, num)).join('')
               : '<div class="ver__note">змістовних змін немає</div>'}
             ${cmp.technical ? `<div class="ver__tech">+ ${cmp.technical} технічних</div>` : ''}
           </div>`;
    }

    // «покажи редакцію на дату» — головний сценарій: не перемикати весь кодекс
    if (S.onDate && !S.cmpDate) {
      const hit = rec.versions.find(v => v.valid_from <= S.onDate
        && (!v.valid_to || S.onDate <= v.valid_to));
      banner += hit
        ? `<div class="onmark">На <b>${fmtDate(S.onDate)}</b> діяла редакція від
             <b>${fmtDate(hit.valid_from)}</b>${hit.valid_to ? ` (до ${fmtDate(hit.valid_to)})` : ''}
             <button class="onmark__btn" data-act="show-text">показати текст статті</button></div>`
        : `<div class="onmark">На ${fmtDate(S.onDate)} редакції не знайдено — стаття могла ще не діяти.</div>`;
    }

    // Редакції-дублікати ховаємо: корпус позначає їх сам, і по ст. 1029 ЦКУ
    // це три рядки з пʼяти. Чинну, майбутню й первинну не чіпаємо ніколи.
    // Редакція без змістовних змін: сам текст норми той самий, а відрізняється
    // лише оформленням, нумерацією чи підставою. Таких у ЦКУ близько чверті —
    // юрист гортає історію й бачить одне «змінилося лише оформлення».
    //
    // Чинну, майбутню й первинну не ховаємо ніколи: вони потрібні як опори,
    // навіть якщо самі по собі нічого не змінили.
    const empty = v => !v.first && !v.current && !v.future
      && (v.redundant || v.same_text || (!(v.changes || []).length && !v.diff_skipped));
    const hidden = rec.versions.filter(v => empty(v) && !S.showRedundant);
    const shownVers = rec.versions.filter(v => !hidden.includes(v));

    listEl.innerHTML = scope + banner + shownVers.map((v, i) => {
      const onDateHit = S.onDate && v.valid_from <= S.onDate && (!v.valid_to || S.onDate <= v.valid_to);
      const tag = v.current ? '<span class="chg mark">чинна</span>'
        : v.future ? '<span class="stale mark">набирає чинності</span>'
        : v.first ? '<span class="opin">первинна</span>' : '';
      const excl = v.excl_kind ? `<span class="neg mark">${esc(v.excl_kind)}</span>` : '';
      const conflict = v.conflict
        ? `<span class="stale mark" title="У базі законів на цю дату є дві різні версії статті. Джерело — edition_conflicts; порівнюйте з обережністю.">конфлікт версій</span>` : '';
      const redundant = v.redundant
        ? `<span class="opin" title="Корпус позначив цю редакцію як дублікат: текст норми не змінився.">дублікат</span>` : '';

      // Підстава згорнута: юрист відкриває історію заради змін, а не заради
      // номера закону. Розгортається, коли треба процитувати або подивитися,
      // що ще той закон зачепив.
      const meta = v.basis_meta || {};
      const basis = (v.basis || []).map(b => {
        const m = meta[b] || {};
        const cite = m.num ? `№ ${m.num}${m.date ? ' від ' + fmtDate(m.date) : ''}` : b;
        return `<div class="bas">
            <button class="bas__t" data-act="basis" data-nreg="${esc(b)}">Закон ${esc(cite)}</button>
            <div class="bas__body" hidden>
              ${m.name ? `<div class="bas__name">${esc(m.name)}</div>` : ''}
              <div class="bas__acts">
                <button class="bas__btn" data-act="cite" data-cite="${esc('в редакції Закону ' + cite)}">копіювати цитату</button>
                <a class="bas__btn" href="${RADA}${esc(b)}" target="_blank" rel="noopener noreferrer">відкрити на Раді ↗</a>
                ${m.changed > 1 ? `<span class="bas__more">цей закон змінив ще ${m.changed - 1} стат${m.changed - 1 === 1 ? 'тю' : 'ей'} цього кодексу</span>` : ''}
              </div>
            </div>
          </div>`;
      }).join('');

      // Поява й зникнення норми — це не «вставлено текст», а окрема подія.
      // Кажемо про неї один раз, навіть якщо вилучення розсипалося на фрагменти.
      // У структурному дифі подія приходить самим фрагментом і малюється
      // разом із текстом норми; окремі чипи потрібні лише плоскому запобіжнику.
      const structural = (v.changes || []).some(c => c.sentences || c.op);
      const ev = structural ? '' : [
        ...(v.new_norms || []).map(k =>
          `<div class="nev nev--new"><b>${esc(normLabel(num, k))}</b> — норми не було, додано</div>`),
        ...(v.gone_norms || []).map(k =>
          `<div class="nev nev--gone"><b>${esc(normLabel(num, k))}</b> — норму виключено</div>`)
      ].join('');

      // З чим порівняно. Без цього рядка «було → стало» висить у повітрі:
      // незрозуміло, чи це різниця з попередньою редакцією, чи з першою.
      const base = v.diff_from
        ? `<div class="ver__base">зміни проти редакції від <b>${fmtDate(v.diff_from)}</b></div>`
        : '';

      return `
        <article class="ver${onDateHit ? ' is-hit' : ''}" data-from="${esc(v.valid_from)}"
                 style="animation-delay:${Math.min(i, 6) * 26}ms">
          <div class="ver__head">
            <span class="ver__date">${fmtDate(v.valid_from)}</span>
            <span class="ver__to">${v.valid_to ? '— ' + fmtDate(v.valid_to)
              : v.future ? '— без кінцевої дати' : '— чинна досі'}</span>
            ${tag}${excl}${conflict}${redundant}
          </div>
          ${v.first
            ? '<div class="ver__note">первинна редакція, з якої почалася стаття</div>'
            : v.diff_skipped
              ? '<div class="ver__note">порівняння не рахували — це глибина понад 60 редакцій. Текст редакції можна відкрити за датою.</div>'
              : v.changes.length
                ? base + ev + v.changes.map(ch => diffHTML(ch, num)).join('')
                : `<div class="ver__note">${v.diff_from
                      ? `проти редакції від <b>${fmtDate(v.diff_from)}</b>: ${emptyVer(v, num)}`
                      : emptyVer(v, num)}</div>`}
          ${v.technical ? techBlock(v, num) : ''}
          ${basis}
        </article>`;
    }).join('') + (hidden.length
      ? `<button class="more" data-act="show-redundant">Показати ще ${hidden.length}
           редакці${hidden.length === 1 ? 'ю' : hidden.length < 5 ? 'ї' : 'й'} без змістовних
           змін — оформлення, нумерація, підстава</button>`
      : S.showRedundant && rec.versions.some(v => empty(v))
        ? `<button class="more" data-act="show-redundant">Сховати редакції без змістовних змін</button>`
        : '')
      // Догрузка: ст. 14 ПКУ — 73 редакції, рахувати їх усі на холодну це
      // десятки секунд. Показуємо перші шість, решта підтягується, коли
      // юрист дочитав до кінця списку.
      + (rec.has_more
          ? `<div class="tail" data-tail="${esc(num)}">${rec.more
               ? skeletonHTML(1)
               : `<button class="more" data-act="more-history">Ще редакції
                    <span class="more__n">${rec.total - rec.versions.length}</span></button>`}</div>`
          : rec.moreError
            ? `<div class="tail"><button class="more" data-act="more-history">Не вдалося дозавантажити — ще раз</button></div>`
            : '');

    watchTail();

    // Примітки, позицію яких корпус не зміг підтвердити
    if (rec.unverified && rec.unverified.length) {
      listEl.insertAdjacentHTML('beforeend', `
        <div class="gap">
          <div class="gap__t">${rec.unverified.length} приміт${rec.unverified.length === 1 ? 'ка' : 'ок'}
            без підтвердженої прив'язки</div>
          <div class="gap__s">Корпус знайшов ці записи про зміни, але до якої саме норми вони
            належать — не підтвердив. Якщо зміна стосується вашої норми, звіряйте з текстом Ради.</div>
          ${rec.unverified.slice(0, 6).map(t =>
            `<div class="gap__u">${esc(t.replace(/\s+/g, ' ').slice(0, 160))}</div>`).join('')}
        </div>`);
    }

    // Те, що Рада згадує в тексті, але чого немає в базі редакцій
    const known = new Set();
    rec.versions.forEach(v => Object.values(v.basis_meta || {})
      .forEach(m => m.num && known.add(m.num)));
    const missing = [];
    for (const n of articleNotes(num)) {
      for (const a of n.acts) {
        if (!known.has(a.num) && !missing.some(x => x.num === a.num)) missing.push(a);
      }
    }
    if (missing.length) {
      listEl.insertAdjacentHTML('beforeend', `
        <div class="gap">
          <div class="gap__t">Ще ${missing.length} змін${missing.length === 1 ? 'а' : ''} за примітками Ради</div>
          <div class="gap__s">У тексті статті вони згадані, але окремої редакції в базі немає —
            перевірте на сайті Ради.</div>
          ${missing.map(a => `<a class="gap__a" href="${RADA}${esc(a.nreg || a.num)}"
             target="_blank" rel="noopener">№ ${esc(a.num)} від ${fmtDate(a.date)}</a>`).join('')}
        </div>`);
    }
  }

  let lastShown;
  function render() {
    const num = shown();
    if (num !== lastShown) {              // фільтр і розгорнуті картки — стан однієї статті
      lastShown = num;
      S.filter = 'all';
      S.partManual = false;
      S.partsOpen = false;
      S.expanded.clear();
    }

    const SRC = {
      live:    ['ЄДРСР', 'is-live', `Дані вітрини · акт ${ACT}. Кожне рішення відкривається в реєстрі — будь-яку картку можна звірити з оригіналом.`],
      demo:    ['демо-дані', 'is-demo', 'Вітрина не відповідає. Показано демонстраційний набір: номери справ і формулювання вигадані.'],
      offline: ['немає звʼязку', 'is-off', `Вітрина не відповідає${S.offlineReason ? ' — ' + S.offlineReason : ''}. Нічого не вигадуємо: практики не показуємо.`]
    }[S.source] || SRC_FALLBACK;
    $('[data-slot="src"]').textContent = SRC[0];
    $('[data-slot="src"]').className = 'chip--src ' + SRC[1];
    $('[data-slot="src"]').title = SRC[2];
    $('[data-slot="law"]').textContent = S.lawShort;

    $('[data-slot="art"]').textContent = num ? `Стаття ${num}` : '—';
    $('[data-slot="title"]').textContent = num
      ? ((byNum.get(num) || {}).title || '')
      : 'Прокрутіть текст — панель слідує за статтею, яку ви читаєте';

    modeEl.hidden = !S.pinned || S.mode === 'history';
    if (S.pinned) $('[data-slot="mode-text"]').textContent = `Закріплено статтю ${S.pinned}`;

    const key = artKey(num || 0);
    $('[data-act="prev"]').disabled = !withPractice.some(n => artKey(n) < key);
    $('[data-act="next"]').disabled = !withPractice.some(n => artKey(n) > key);

    renderParts(num);
    renderFilters(num);

    if (S.mode === 'history') {
      ensureHistory(num);
      renderHistory(num);
      for (const n of withPractice) {
        const b = byNum.get(n).badge;
        if (b) b.classList.toggle('is-active', n === num && !S.pinned);
      }
      positionMarker(num);
      return;
    }

    const rec = num ? store.get(pk(num, S.part)) : null;
    const countEl = $('[data-slot="count"]');

    if (S.source === 'offline') {
      countEl.textContent = '';
      listEl.innerHTML = emptyHTML('Вітрина не відповідає',
        `${API ? API.base : 'cards_api'} — ${S.offlineReason || 'немає звʼязку'}. `
        + 'Адресу вітрини можна змінити в налаштуваннях розширення.',
        null, 'retry');
    } else if (!num || !COUNTS.has(num)) {
      const near = nearestWithPractice(key);
      countEl.textContent = withPractice.length ? `${fmtNum(withPractice.length)} статей із практикою` : '';
      listEl.innerHTML = emptyHTML(
        num ? `До статті ${num} висновків немає` : 'Немає активної статті',
        num ? 'У базі немає рішень ВС, де цю статтю застосовано у мотивувальній частині.'
            : 'Прокрутіть текст закону нижче.',
        near);
    } else if (!rec || rec.state === 'loading') {
      countEl.textContent = 'завантаження…';
      listEl.innerHTML = skeletonHTML();
    } else if (rec.state === 'error') {
      countEl.textContent = '';
      listEl.innerHTML = emptyHTML('Бекенд не відповів',
        `${API ? API.base : 'вітрина'} — ${rec.error}. Перевірте, чи запущений сервіс.`,
        null, 'retry');
    } else {
      const items = visibleItems(num);
      countEl.textContent = rec.found
        ? `${fmtNum(rec.found)} рішень · показано ${items.length}`
        : `${items.length}`;
      listEl.innerHTML = items.length
        ? items.map((it, i) => cardHTML(it, num, i, S.query)).join('')
          + (rec.found > items.length && CARD_LIMIT < 100
              ? `<button class="more" data-act="more-cards">Показати ще ${Math.min(20, rec.found - items.length)}</button>`
              : '')
        : emptyHTML('Нічого не знайдено',
            activeFilters() || S.query.trim()
              ? 'Спробуйте зняти один із фільтрів угорі — вони показані чипами.'
              : 'До цієї норми висновків немає.',
            null, activeFilters() || S.query.trim() ? 'reset' : null);
    }

    for (const n of withPractice) {
      const b = byNum.get(n).badge;
      if (!b) continue;
      b.classList.toggle('is-active', n === num && !S.pinned);
      b.classList.toggle('is-pinned', n === S.pinned);
    }
    root.querySelectorAll('.praxis-badge--part').forEach(x =>
      x.classList.toggle('is-pinned', x.dataset.praxisPart === S.part));
    positionMarker(num);
  }

  function nearestWithPractice(key) {
    let best = null, bd = Infinity;
    for (const n of withPractice) {
      const d = Math.abs(artKey(n) - key);
      if (d < bd) { bd = d; best = n; }
    }
    return best;
  }

  function positionMarker(num) {
    const a = num ? byNum.get(num) : null;
    if (!a || !S.open) { marker.classList.remove('is-on'); return; }
    marker.classList.add('is-on');
    marker.classList.toggle('is-pinned', S.pinned === num);
    marker.style.transform = `translateY(${a.rel - 4}px)`;
    marker.style.height = a.height + 'px';
  }

  /* ── скрол-мапа ───────────────────────────────────────────────────── */
  const ticksEl = mapEl.querySelector('.map__ticks');
  const thumbEl = mapEl.querySelector('.map__thumb');
  const tipEl = mapEl.querySelector('.map__tip');

  function docH() {
    return Math.max(document.documentElement.scrollHeight, 1);
  }

  function buildTicks() {
    if (!withPractice.length) return;
    const H = docH();
    const max = Math.max(...withPractice.map(n => (COUNTS.get(n) || [0])[0] || 0), 1);
    ticksEl.innerHTML = withPractice.map(n => {
      const a = byNum.get(n);
      if (!a || !a.top) return '';
      const [total, vp] = COUNTS.get(n) || [0, 0];
      const op = 0.25 + 0.75 * Math.min(1, Math.log10(1 + total) / Math.log10(1 + max));
      // помаранчевим — лише там, де Велика Палата справді часто: інакше
      // позначку отримують майже всі статті і вона перестає щось означати
      return `<i style="top:${(a.top / H * 100).toFixed(3)}%;opacity:${op.toFixed(2)}"`
        + `${vp >= 10 ? ' class="vp"' : ''}></i>`;
    }).join('');
  }

  function drawThumb() {
    const H = docH();
    const vh = window.innerHeight;
    thumbEl.style.top = (window.scrollY / H * 100).toFixed(3) + '%';
    thumbEl.style.height = Math.max(1.2, vh / H * 100).toFixed(3) + '%';
  }

  function scrollToRatio(clientY) {
    const r = mapEl.getBoundingClientRect();
    const ratio = Math.min(1, Math.max(0, (clientY - r.top) / r.height));
    window.scrollTo({ top: ratio * docH() - window.innerHeight / 2 });
  }

  function nearestAt(clientY) {
    const r = mapEl.getBoundingClientRect();
    const y = ((clientY - r.top) / r.height) * docH();
    let best = null;
    for (const a of arts) {
      if (a.top <= y) best = a; else break;
    }
    return best;
  }

  let dragging = false;
  mapEl.addEventListener('pointerdown', e => {
    dragging = true;
    mapEl.setPointerCapture(e.pointerId);
    scrollToRatio(e.clientY);
  });
  mapEl.addEventListener('pointermove', e => {
    if (dragging) scrollToRatio(e.clientY);
    const a = nearestAt(e.clientY);
    if (a) {
      const [total] = COUNTS.get(a.num) || [];
      tipEl.hidden = false;
      tipEl.textContent = `ст. ${a.num}${total ? ' · ' + fmtCompact(total) : ''}`;
      tipEl.style.top = Math.max(6, e.clientY - mapEl.getBoundingClientRect().top - 9) + 'px';
    }
  });
  mapEl.addEventListener('pointerup', e => { dragging = false; mapEl.releasePointerCapture(e.pointerId); });
  mapEl.addEventListener('pointerleave', () => { tipEl.hidden = true; });

  /* ── 7. відкриття / тема / збереження ─────────────────────────────── */
  function setOpen(v) {
    S.open = v;
    document.documentElement.classList.toggle('praxis-open', v);
    rail.classList.toggle('is-open', v);
    fab.classList.toggle('is-hidden', v);
    save();
    setTimeout(() => { measure(); positionMarker(shown()); buildTicks(); drawThumb(); }, 360);
  }

  function applyTheme() {
    const dark = S.theme === 'dark' ||
      (S.theme === 'auto' && window.matchMedia('(prefers-color-scheme: dark)').matches);
    rail.dataset.theme = dark ? 'dark' : 'light';
    fab.dataset.theme = dark ? 'dark' : 'light';
    $('[data-act="theme"]').classList.toggle('is-on', S.theme !== 'auto');
  }

  function save() {
    try {
      if (typeof chrome !== 'undefined' && chrome.storage && chrome.storage.local)
        chrome.storage.local.get('praxis', r => {
          chrome.storage.local.set({ praxis: Object.assign({}, r.praxis, { open: S.open, theme: S.theme, agreed: S.agreed }) });
        });
    } catch (e) { }
  }

  /* ── 8. події ─────────────────────────────────────────────────────── */
  /** Текст статті в редакції на обрану дату — просто в панелі, без
      перемикання всього кодексу на сайті Ради. */
  function showVersionText() {
    const num = shown();
    if (!num || !S.onDate || !API) return;
    API.textOn(ACT, num, S.onDate).then(d => {
      if (!d.found) return toast('Редакції на цю дату немає');
      const box = rail.querySelector('.onmark');
      if (!box) return;
      box.insertAdjacentHTML('afterend',
        `<article class="ver"><div class="ver__head">
           <span class="ver__date">${fmtDate(d.valid_from)}</span>
           <span class="ver__to">${d.valid_to ? '— ' + fmtDate(d.valid_to) : '— чинна досі'}</span>
         </div><div class="ver__body">${esc(d.body)}</div></article>`);
      box.querySelector('.onmark__btn')?.remove();
    }).catch(() => toast('Не вдалося отримати текст'));
  }

  rail.addEventListener('click', e => {
    const act = e.target.closest('[data-act]');
    const so = e.target.closest('[data-s]');
    const jk = e.target.closest('[data-jk]');
    const ct = e.target.closest('[data-court]');
    const drop = e.target.closest('[data-drop]');
    const ca = e.target.closest('[data-cat]');
    const pchip = e.target.closest('[data-p]');
    const goto = e.target.closest('[data-goto]');
    const card = e.target.closest('.card');

    const hunk = e.target.closest('[data-hunk]');
    if (hunk) {
      const num = shown();
      const rel = hunk.dataset.hunk;
      // ключ норми в тексті: ЦКУ «2», ПКУ «140.5». Номер статті додаємо лише
      // там, де акт узагалі нумерує норми крапками, інакше вилучена ч. 4 ЦКУ
      // перетворювалася на неіснуючу «32.4»
      const dotted = norms.some(x => x.art === num && x.part.startsWith(num + '.'));
      const part = !rel ? null : (rel.includes('.') || !dotted) ? rel : `${num}.${rel}`;
      scrollToNorm(num, part || null, hunk.dataset.op);
      return;
    }
    if (goto) { jumpTo(goto.dataset.goto, goto.dataset.gotoPart || null); return; }
    if (pchip) {
      S.part = pchip.dataset.p === '*' ? null : pchip.dataset.p;
      S.partManual = true;
      S.partsOpen = false;
      S.filter = 'all';
      S.expanded.clear();
      ensure(shown());
      render();
      listEl.scrollTo({ top: 0, behavior: 'smooth' });
      return;
    }
    if (so) { S.sort = so.dataset.s; refetch(); return; }
    if (drop) {
      const [k, v] = drop.dataset.drop.split(':');
      if (k === 'court') S.courts = S.courts.filter(x => x !== v);
      else if (k === 'jk') S.jk = S.jk.filter(x => x !== v);
      else if (k === 'cat') S.cat = null;
      else if (k === 'flag') S.flags = S.flags.filter(x => x !== v);
      else if (k === 'opinions') S.opinions = false;
      else if (k === 'since') S.since = null;
      else if (k === 'current') { S.currentOnly = false; render(); return; }
      else if (k === 'query') { S.query = ''; searchInput.value = ''; }
      refetch(); return;
    }
    const toggle = (arr, v) => arr.includes(v) ? arr.filter(x => x !== v) : [...arr, v];
    if (jk) { S.jk = toggle(S.jk, jk.dataset.jk); refetch(); return; }
    if (ct) { S.courts = toggle(S.courts, ct.dataset.court); refetch(); return; }
    if (ca) { S.cat = S.cat === ca.dataset.cat ? null : ca.dataset.cat; refetch(); return; }

    if (act) {
      const a = act.dataset.act;
      if (a === 'close') { setOpen(false); return; }
      if (a === 'retry') { retry(shown()); return; }
      if (a === 'more') { S.partsOpen = true; render(); return; }
      if (a === 'since') {
        S.since = S.since ? null : String(new Date().getFullYear() - 3);
        refetch(); return;
      }
      if (a === 'current') { S.currentOnly = !S.currentOnly; render(); return; }
      if (a === 'jump') {
        jumpBox.hidden = !jumpBox.hidden;
        if (!jumpBox.hidden) { jumpInput.value = ''; jumpHint.textContent = ''; jumpInput.focus(); }
        return;
      }
      if (a === 'filters') { S.filtersOpen = !S.filtersOpen; render(); return; }
      if (a === 'to-practice') { S.mode = 'practice'; S.onDate = ''; S.cmpDate = ''; render(); return; }
      if (a === 'clear-dates') { S.onDate = ''; S.cmpDate = ''; render(); return; }
      if (a === 'show-redundant') { S.showRedundant = !S.showRedundant; render(); return; }
      if (a === 'scope-all') {
        S.part = null; S.partManual = true;
        ensureHistory(shown()); render(); return;
      }
      if (a === 'gate-accept') {
        S.agreed = DISCLAIMER_V;
        save();
        gate.hidden = true;
        start();
        return;
      }
      if (a === 'retry-history') {
        histOf.delete(shown() + '|' + (S.part == null ? '*' : S.part));
        ensureHistory(shown());
        render();
        return;
      }
      if (a === 'more-history') { moreHistory(shown()); return; }
      if (a === 'tech') {
        const body = act.parentElement.querySelector('.tech__body');
        if (!body) return;
        body.hidden = !body.hidden;
        act.setAttribute('aria-expanded', String(!body.hidden));
        act.classList.toggle('is-open', !body.hidden);
        return;
      }
      if (a === 'to-version') {
        const el = listEl.querySelector(`.ver[data-from="${act.dataset.from}"]`);
        if (el) {
          el.scrollIntoView({ block: 'center', behavior: 'smooth' });
          el.classList.add('is-hit');
          setTimeout(() => el.classList.remove('is-hit'), 1600);
        }
        return;
      }
      if (a === 'basis') {
        const body = act.parentElement.querySelector('.bas__body');
        body.hidden = !body.hidden;
        act.classList.toggle('is-open', !body.hidden);
        return;
      }
      if (a === 'cite') {
        navigator.clipboard.writeText(act.dataset.cite)
          .then(() => toast('Скопійовано: ' + act.dataset.cite), () => toast('Не вдалося скопіювати'));
        return;
      }
      if (a === 'to-history') {
        e.stopPropagation();
        S.mode = 'history'; S.onDate = act.dataset.on || '';
        S.pinned = shown();
        ensureHistory(shown()); render();
        listEl.scrollTo({ top: 0 });
        return;
      }
      if (a === 'show-text') { showVersionText(); return; }
      if (a === 'more-cards') {
        CARD_LIMIT = Math.min(100, CARD_LIMIT + 20);
        store.delete(pk(shown(), S.part));
        ensure(shown()); render(); return;
      }
      if (a === 'stairs') {
        S.sort = S.sort === 'fresh' ? 'oldest' : 'fresh';
        refetch(); return;
      }
      if (a === 'flag-departure' || a === 'flag-actual') {
        const v = a === 'flag-actual' ? 'actual' : 'departure';
        S.flags = S.flags.includes(v) ? S.flags.filter(x => x !== v) : [...S.flags, v];
        refetch(); return;
      }
      if (a === 'opinions') { S.opinions = !S.opinions; refetch(); return; }
      if (a === 'reset' || a === 'reset-all') {
        resetFilters();
        if (a === 'reset-all') { S.query = ''; searchInput.value = ''; }
        refetch(); return;
      }
      if (a === 'theme') {
        S.theme = S.theme === 'auto' ? 'dark' : S.theme === 'dark' ? 'light' : 'auto';
        applyTheme(); save();
        toast('Тема: ' + ({ auto: 'як у системі', dark: 'темна', light: 'світла' })[S.theme]);
        return;
      }
      if (a === 'search') {
        S.searchOn = !S.searchOn;
        searchBox.hidden = !S.searchOn;
        act.classList.toggle('is-on', S.searchOn);
        if (S.searchOn) searchInput.focus();
        else { S.query = ''; searchInput.value = ''; render(); }
        return;
      }
      if (a === 'unpin') { S.pinned = null; ensure(shown()); render(); return; }
      if (a === 'prev' || a === 'next') {
        const key = artKey(shown() || 0);
        const pool = withPractice.filter(n => a === 'prev' ? artKey(n) < key : artKey(n) > key);
        const target = a === 'prev' ? pool[pool.length - 1] : pool[0];
        if (target) jumpTo(target);
        return;
      }
      if (card && (a === 'copy' || a === 'ext' || a === 'goto')) {
        e.stopPropagation();
        const rec = store.get(pk(card.dataset.art, S.part));
        const it = rec && rec.items.find(x => card.dataset.id.endsWith(':' + (x.docId || x.caseNo)));
        if (!it) return;
        if (a === 'copy') {
          const txt = `${it.court}, постанова від ${fmtDate(it.date)} у справі № ${it.caseNo}`
            + (it.link ? ` — ${it.link}` : '');
          navigator.clipboard.writeText(txt).then(() => toast('Скопійовано: ' + txt), () => toast('Не вдалося скопіювати'));
        } else if (a === 'ext') {
          // noreferrer: реєстр не повинен дізнатися, з якої статті закону прийшов юрист
          if (it.link && S.source === 'live') window.open(it.link, '_blank', 'noopener,noreferrer');
          else toast('Демо-дані: посилання на ЄДРСР неактивне');
        } else {
          jumpTo(card.dataset.art, it.part || (it.via || {}).point || null);
        }
        return;
      }
    }

    if (card) {
      const id = card.dataset.id;
      if (S.expanded.has(id)) S.expanded.delete(id); else S.expanded.add(id);
      card.classList.toggle('is-open', S.expanded.has(id));
    }
  });

  let echoEl = null;
  listEl.addEventListener('mouseover', e => {
    const card = e.target.closest('.card, [data-goto]');
    if (!card) return;
    const a = byNum.get(card.dataset.art || card.dataset.goto);
    if (!a || a.el === echoEl) return;
    if (echoEl) echoEl.classList.remove('praxis-echo');
    echoEl = a.el; echoEl.classList.add('praxis-echo');
  });
  listEl.addEventListener('mouseleave', () => {
    if (echoEl) { echoEl.classList.remove('praxis-echo'); echoEl = null; }
  });

  // «перейти до статті» — те, чого не дає Ctrl+F: він шукає текст, а не норму
  jumpInput.addEventListener('input', () => {
    const q = jumpInput.value.trim();
    if (!q) { jumpHint.textContent = ''; return; }
    const exact = byNum.get(q);
    const near = arts.filter(a => a.num.startsWith(q)).slice(0, 6);
    jumpHint.innerHTML = exact
      ? `<button class="jumpbox__go" data-goto="${esc(q)}">Стаття ${esc(q)} — ${esc(exact.title.slice(0, 40))}</button>`
      : near.length
        ? near.map(a => `<button class="jumpbox__go" data-goto="${esc(a.num)}">ст. ${esc(a.num)}</button>`).join('')
        : '<span class="jumpbox__no">такої статті в документі немає</span>';
  });
  jumpInput.addEventListener('keydown', e => {
    if (e.key === 'Enter') {
      const first = jumpHint.querySelector('[data-goto]');
      if (first) { first.click(); jumpBox.hidden = true; }
    }
    if (e.key === 'Escape') jumpBox.hidden = true;
  });

  let searchT;
  rail.addEventListener('change', e => {
    const d = e.target.closest('.ondate');
    if (!d) return;
    if (d.dataset.role === 'cmp') S.cmpDate = d.value; else S.onDate = d.value;
    if (S.onDate && S.cmpDate) ensureCompare(shown());
    render();
  });

  searchInput.addEventListener('input', () => {
    clearTimeout(searchT);
    searchT = setTimeout(() => {          // пошук іде в текст рішень на сервері
      S.query = searchInput.value;
      refetch();
    }, 400);
  });
  searchInput.addEventListener('keydown', e => {
    if (e.key === 'Escape') { S.query = ''; searchInput.value = ''; refetch(); }
  });

  fab.addEventListener('click', () => setOpen(true));

  /** Перехід до норми, а не до початку статті.
   *
   *  Стаття 14 ПКУ — це десять екранів. Якщо картка стосується пп. 14.1.54,
   *  стрибок на заголовок статті лишає юриста за кілометр від потрібного
   *  абзацу. Тому ведемо до самої норми і ставимо її у верхню третину
   *  екрана — так видно і її, і те, що далі.
   */
  function jumpTo(num, part) {
    const a = byNum.get(num);
    if (!a) return;
    measure();

    let target = a.top, el = a.el;
    if (part) {
      const n = norms.find(x => x.art === num && x.part === part);
      if (n && n.top) { target = n.top; el = n.el; }
    }
    S.pinned = num; S.peek = null;
    if (part) { S.part = part; S.partManual = true; }

    window.scrollTo({ top: Math.max(0, target - window.innerHeight / 3), behavior: 'smooth' });
    flash(el);
    ensure(num);
    render();
    listEl.scrollTo({ top: 0, behavior: 'smooth' });
  }

  /** Коротке підсвічування, щоб око знайшло місце після стрибка. */
  let flashT;
  function flash(el) {
    if (!el) return;
    root.querySelectorAll('.praxis-flash').forEach(x => x.classList.remove('praxis-flash'));
    el.classList.add('praxis-flash');
    clearTimeout(flashT);
    flashT = setTimeout(() => el.classList.remove('praxis-flash'), 1600);
  }

  /* ── 9. скрол-стеження ────────────────────────────────────────────── */
  let ticking = false;
  function onScroll() {
    if (ticking) return;
    ticking = true;
    // rAF у прихованій вкладці не спрацьовує, і прапорець лишався зведеним
    // назавжди — скрол-стеження вмирало навіть після повернення на вкладку
    let done = false;
    const run = () => {
      if (done) return;
      done = true;
      ticking = false;
      if (S.pinned || S.peek) return;
      const y = window.scrollY + SPY_OFFSET;
      let cur = null;
      for (let i = 0; i < arts.length; i++) {
        if (arts[i].top <= y) cur = arts[i].num; else break;
      }
      if (!cur && arts.length) cur = arts[0].num;

      // яку саме норму статті зараз читають
      drawThumb();
      let curPart = null;
      if (cur && !S.partManual) {
        for (let i = 0; i < norms.length; i++) {
          if (norms[i].top > y) break;
          if (norms[i].art === cur) curPart = norms[i].part;
        }
      }

      if (cur !== S.active) {
        S.active = cur;
        ensureNorms(cur);
        S.part = S.partManual ? S.part : curPart;
        ensure(cur); render();
      } else if (!S.partManual && curPart !== S.part) {
        S.part = curPart;
        ensure(cur); render();
      } else positionMarker(shown());
    };
    requestAnimationFrame(run);
    setTimeout(run, 300);
  }

  let rt;
  window.addEventListener('scroll', onScroll, { passive: true });
  window.addEventListener('resize', () => {
    clearTimeout(rt);
    rt = setTimeout(() => { measure(); positionMarker(shown()); buildTicks(); drawThumb(); }, 120);
  });

  document.addEventListener('keydown', e => {
    if (e.altKey && (e.code === 'KeyP' || e.key === 'p' || e.key === 'з')) { e.preventDefault(); setOpen(!S.open); }
    if (e.key === 'Escape' && (S.pinned || S.query)) {
      S.pinned = null; S.query = ''; searchInput.value = ''; ensure(shown()); render();
    }
  });

  /* ── 10. старт ────────────────────────────────────────────────────── */
  gate.addEventListener('change', e => {
    if (!e.target.matches('[data-act="gate-check"]')) return;
    gate.querySelector('[data-act="gate-accept"]').disabled = !e.target.checked;
  });

  async function boot(saved) {
    if (saved && typeof saved.open === 'boolean') S.open = saved.open;
    if (saved && saved.theme) S.theme = saved.theme;
    if (saved && saved.agreed) S.agreed = saved.agreed;

    measure();
    applyTheme();
    document.documentElement.classList.toggle('praxis-open', S.open);
    rail.classList.toggle('is-open', S.open);
    fab.classList.toggle('is-hidden', S.open);
    render();

    // До згоди не йдемо в мережу взагалі: перший запит має бути вже після того,
    // як людина прочитала, що саме в ньому піде.
    if (S.agreed !== DISCLAIMER_V) {
      gate.hidden = false;
      return;
    }
    await start();
  }

  /** Усе, що працює з даними. Викликається після згоди — з boot або з кнопки. */
  /* ── примітки Ради ─────────────────────────────────────────────────
   *
   *  У тексті ПКУ 4 513 блоків у фігурних дужках виду «{Підпункт 134.1.1 …
   *  доповнено абзацом тринадцятим згідно із Законом № 4112-IX від
   *  04.12.2024}». Читати норму крізь них неможливо, але й викидати не можна:
   *  іноді саме вони й потрібні.
   *
   *  Розмітка Ради тут зручна: примітка — це окремий абзац, а не вставка
   *  всередині норми. Тож ми не чіпаємо текст статті взагалі — лише ховаємо
   *  цілі абзаци й лишаємо на їх місці дрібну позначку. Якорі `<a name>`
   *  всередині лишаються в DOM, тож посилання Ради не ламаються.
   *
   *  Три види, і поводитися з ними треба по-різному. Рішення Конституційного
   *  Суду ховати не можна — це найцінніше, що буває в примітці.
   */
  const ANN_KIND = [
    [/Конституційн/i,                          'court'],
    [/набирає чинності|набрання чинності|вводиться в дію/i, 'force'],
    [null,                                     'basis']
  ];

  const ANN_LABEL = {
    basis: 'підстава зміни',
    force: 'умова набрання чинності',
    court: 'Конституційний Суд'
  };

  function annKind(text) {
    for (const [rx, k] of ANN_KIND) if (!rx || rx.test(text)) return k;
    return 'basis';
  }

  /** Групує абзаци-примітки: примітка може тягнутися на кілька абзаців. */
  function annGroups() {
    if (!root) return [];
    const ps = [...root.querySelectorAll('p')];
    const out = [];
    let open = null;
    for (const p of ps) {
      const t = (p.textContent || '').trim();
      if (!t) continue;
      if (open) {
        open.els.push(p);
        open.text += ' ' + t;
        if (t.endsWith('}')) { out.push(open); open = null; }
        continue;
      }
      if (!t.startsWith('{')) continue;
      const g = { els: [p], text: t };
      if (t.endsWith('}')) out.push(g); else open = g;
    }
    if (open) out.push(open);            // незакрита дужка — краще згорнути, ніж лишити
    return out;
  }

  /** Сусідні примітки одного виду — під одну позначку.
   *  Інакше після абзацу виростає гребінець із трьох однакових чипів. */
  function mergeAdjacent(groups) {
    const out = [];
    for (const g of groups) {
      const prev = out[out.length - 1];
      const last = prev && prev.els[prev.els.length - 1];
      if (prev && prev.kind === g.kind && last && last.nextElementSibling === g.els[0]) {
        prev.els.push(...g.els);
        prev.text += ' ' + g.text;
        prev.n++;
      } else {
        out.push({ ...g, n: 1 });
      }
    }
    return out;
  }

  let annFolded = 0;

  function foldAnnotations() {
    if (annFolded) return;
    const groups = mergeAdjacent(annGroups().map(g => ({ ...g, kind: annKind(g.text) })));
    for (const g of groups) {
      const kind = g.kind;
      if (kind === 'court') {            // не ховаємо, а підсвічуємо
        g.els.forEach(el => el.classList.add('praxis-ann-court'));
        annFolded++;
        continue;
      }
      const tag = document.createElement('p');
      tag.className = 'praxis-ann-tag';
      tag.dataset.kind = kind;
      tag.textContent = g.n > 1
        ? `${g.n} ${kind === 'basis' ? 'підстави зміни' : ANN_LABEL[kind]}`
        : ANN_LABEL[kind];
      tag.title = g.text.length > 400 ? g.text.slice(0, 400) + '…' : g.text;
      tag.addEventListener('click', () => {
        const on = tag.classList.toggle('is-open');
        g.els.forEach(el => el.classList.toggle('praxis-ann-hidden', !on));
        measure(); buildTicks(); drawThumb();
      });
      g.els[0].parentNode.insertBefore(tag, g.els[0]);
      g.els.forEach(el => el.classList.add('praxis-ann-hidden'));
      annFolded++;
    }
  }

  async function start() {
    foldAnnotations();                   // до вимірювань: висота сторінки зміниться
    await loadCounts();
    mountBadges();
    loadVersions();
    measure();
    buildTicks();
    drawThumb();
    onScroll();
    render();
    setTimeout(() => { measure(); positionMarker(shown()); }, 400);
    window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', applyTheme);
  }

  boot(prefs);

  // налаштування можуть змінитися з попапа, поки сторінка відкрита
  try {
    if (typeof chrome !== 'undefined' && chrome.storage && chrome.storage.onChanged) {
      chrome.storage.onChanged.addListener(ch => {
        if (!ch.praxis) return;
        const v = ch.praxis.newValue || {};
        if (typeof v.open === 'boolean' && v.open !== S.open) setOpen(v.open);
        if (v.theme && v.theme !== S.theme) { S.theme = v.theme; applyTheme(); }
      });
    }
  } catch (e) { }

  window.__PRAXIS__ = {
    S, arts, COUNTS, store, render, setOpen, measure, jumpTo, ensure,
    setTheme: t => { S.theme = t; applyTheme(); }
  };
})();
