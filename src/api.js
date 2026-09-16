/* Praxis — шар даних. Говорить із локальним cards_api.py і приводить
 * його відповідь до моделі картки, яку малює content.js.
 *
 *   GET /articles?act=435-15           → {act, law, law_title, articles:{"625":[всього, ВП]}}
 *   GET /cards?act=435-15&article=625  → {found, cards:[…]}
 */
(function () {
  'use strict';

  // у розширенні адресу підставляє service worker (налаштування в попапі);
  // тут — лише для прев'ю, яке ходить у API напряму
  const BASE = window.__PRAXIS_API_BASE__ || 'http://127.0.0.1:8787';
  // Холодний агрегат по акту ≈ 8 с. Історія ст. 14 ПКУ — 73 редакції з дифами,
  // на холодну це десятки секунд; далі вітрина віддає з кешу за чверть секунди.
  const TIMEOUT = { counts: 12000, cards: 8000, history: 30000 };

  const cache = new Map();

  /** Адреса вітрини без ключа — усе, що можна показувати на екрані. */
  function safeShow(u) {
    try { const x = new URL(u); x.search = ''; return x.origin + x.pathname.replace(/\/$/, ''); }
    catch (e) { return String(u).split('?')[0]; }
  }

  async function call(path, params, ms) {
    const qs = new URLSearchParams(params).toString();

    // 1) через service worker — єдиний шлях зі сторінки zakon.rada.gov.ua
    if (typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.id) {
      const r = await chrome.runtime.sendMessage({ praxis: 'fetch', path, qs, ms });
      if (r && r.ok) return r.data;
      throw new Error((r && r.error) || 'немає відповіді від service worker');
    }

    // 2) прямий запит — для локального прев'ю, де розширення не встановлене
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), ms);
    try {
      // Ключ іде ЗАГОЛОВКОМ і тут теж. Раніше ця гілка копіювала ?key= з
      // адреси прямо в URL запиту — і ключ разом із номером статті осідав у
      // журналі кожного проміжного вузла. Гілка здавалася «лише для прев'ю»,
      // але вона спрацьовує і в розширенні, коли content script лишився без
      // chrome.runtime після оновлення.
      const b = new URL(BASE);
      const key = b.searchParams.get('key') || '';
      const url = new URL(path, b.origin);
      new URLSearchParams(qs).forEach((v, k) => url.searchParams.set(k, v));
      const res = await fetch(url.toString(), {
        signal: ctl.signal, cache: 'no-store',
        credentials: 'omit', referrerPolicy: 'no-referrer',
        headers: key ? { 'X-Praxis-Key': key } : undefined
      });
      if (!res.ok) throw new Error('HTTP ' + res.status);
      return await res.json();
    } catch (e) {
      throw new Error(e && e.name === 'AbortError' ? 'timeout' : String(e && e.message || e));
    } finally {
      clearTimeout(timer);
    }
  }

  // «відступ» показуємо окремою позначкою на картці, тут дублювати не треба
  const KIND_TAG = {
    departure: 'висновок суду',
    position: 'висновок суду',
    clarification: 'мотивування'
  };

  /** Картка ЄДРСР → модель, яку малює панель. */
  function toCard(c) {
    const tags = [];
    if (c.part) tags.push((c.part.includes('.') ? 'п. ' : 'ч. ') + c.part);
    tags.push(KIND_TAG[c.kind] || 'мотивування');

    const full = [];
    if (c.context && c.context.length > (c.snippet || '').length + 40) full.push(c.context);

    return {
      court: c.court_name || c.court,
      caseNo: c.cause_num || '—',
      date: c.date || '',
      kind: c.kind || 'clarification',
      thesis: c.snippet || '',
      full,
      tags,
      relevance: null,                 // ранжування за релевантністю — наступний шар
      applied: c.cited_by,             // скільки рішень послалися на цю справу
      appliedGc: c.cited_by_gc,        // з них Великою Палатою
      inPosition: c.cited_in_position, // з них у мотивувальній частині
      negative: c.cited_negative,      // від цього висновку відступили / звузили
      affirmed: c.cited_affirmed,      // підтвердили
      justice: c.justice_kind,
      status: c.status,                // overruled / overruled_gc / narrowed / affirmed
      overruledGc: c.overruled_gc,     // від висновку відступила саме Велика Палата
      note: c.authority_note,          // «Великою Палатою, справа 916/4093/21 від 2024-04-03»
      form: c.form,                    // 10 — окрема думка судді
      via: c.via || null,              // kind: 'formal' — посилання витягли окремим проходом;
                                       //       'context' — підпункт виведено з терміна поруч
      link: c.edrsr_url,
      raw: c.raw,
      law: c.law_version || null,      // редакція статті, чинна на дату рішення
      part: c.part,                   // норма, до якої привʼязана картка
      docId: c.doc_id
    };
  }

  window.__PRAXIS_API__ = {
    // назовні віддаємо адресу БЕЗ ключа: цим полем панель підписує помилки,
    // і ключ опинявся на екрані поверх тексту закону
    base: safeShow(BASE),

    /** {articles: Map номер → [усього рішень, з них Великої Палати], law} */
    async counts(act) {
      const key = 'counts:' + act;
      if (cache.has(key)) return cache.get(key);
      const d = await call('/articles', { act }, TIMEOUT.counts);
      const out = {
        law: d.law || null,
        lawTitle: d.law_title || null,
        articles: new Map(Object.entries(d.articles || {}))
      };
      cache.set(key, out);
      return out;
    },

    /** {ключ норми: скільки рішень} для всіх рівнів статті — під бейджі в тексті */
    async norms(act, article) {
      const key = `norms:${act}:${article}`;
      if (cache.has(key)) return cache.get(key);
      const d = await call('/norms', { act, article }, TIMEOUT.cards);
      const out = { total: d.total || 0, map: new Map(Object.entries(d.norms || {})) };
      cache.set(key, out);
      return out;
    },

    /** {found, items:[картка]} */
    async cards(act, article, limit, part, opts) {
      const o = opts || {};
      const key = ['cards', act, article, limit || 20, part == null ? '*' : part,
                   o.sort || 'fresh', (o.jk || []).join('+'), (o.courts || []).join('+'),
                   (o.forms || []).join('+'), o.flag || '', o.cat || '',
                   o.since || '', o.q || ''].join(':');
      if (cache.has(key)) return cache.get(key);
      const params = { act, article, limit: limit || 20 };
      if (part != null) params.part = part;
      if (o.sort) params.sort = o.sort;
      if (o.jk && o.jk.length) params.jk = o.jk.join(',');
      if (o.courts && o.courts.length) params.courts = o.courts.join(',');
      if (o.forms && o.forms.length) params.forms = o.forms.join(',');
      if (o.flag) params.flag = [].concat(o.flag).join(',');
      if (o.cat) params.cat = o.cat;
      if (o.since) params.since = o.since;
      if (o.q) params.q = o.q;
      const d = await call('/cards', params, TIMEOUT.cards);
      const out = {
        found: d.found || 0,
        parts: d.parts || [],
        path: d.part_path || [],
        facets: d.facets || {},
        versions: d.versions || [],
        items: (d.cards || []).map(toCard)
      };
      cache.set(key, out);
      return out;
    },

    /** {стаття: скільки редакцій} — під бейдж історії; лише там, де >1 */
    async versions(act) {
      const key = 'vers:' + act;
      if (cache.has(key)) return cache.get(key);
      const d = await call('/versions', { act }, TIMEOUT.counts);
      const out = { counts: new Map(Object.entries(d.articles || {})),
                    future: new Map(Object.entries(d.future || {})) };
      cache.set(key, out);
      return out;
    },

    /** Історія редакцій статті (або однієї її норми) */
    /** Сторінка історії. Ст. 14 ПКУ — 73 редакції; усі одразу ніхто не читає,
     *  а рахувати їх — десятки секунд, тож беремо вікнами. */
    async history(act, article, part, offset = 0, limit = 6) {
      const key = `hist:${act}:${article}:${part == null ? '*' : part}:${offset}:${limit}`;
      if (cache.has(key)) return cache.get(key);
      const params = { act, article, offset, limit };
      if (part != null) params.part = part;
      const d = await call('/history', params, TIMEOUT.history);
      d.unverified = d.unverified || [];
      cache.set(key, d);
      return d;
    },

    /** Різниця між редакціями, чинними на дві довільні дати */
    async compare(act, article, from_, to, part) {
      const key = `cmp:${act}:${article}:${from_}:${to}:${part == null ? '*' : part}`;
      if (cache.has(key)) return cache.get(key);
      const params = { act, article, from: from_, to };
      if (part != null) params.part = part;
      const d = await call('/compare', params, TIMEOUT.cards);
      cache.set(key, d);
      return d;
    },

    /** Текст статті в редакції на задану дату */
    async textOn(act, article, on) {
      const key = `text:${act}:${article}:${on}`;
      if (cache.has(key)) return cache.get(key);
      const d = await call('/text', { act, article, on }, TIMEOUT.cards);
      cache.set(key, d);
      return d;
    },

    forget(act, article) {
      for (const k of [...cache.keys()]) {
        if (k.startsWith(`cards:${act}:${article}:`)) cache.delete(k);
      }
    }
  };
})();
