'use strict';
// Interfața Nostradamus: formular → flux de progres (SSE) → previziune. Tot conținutul venit de la
// server este inserat cu textContent (niciodată ca HTML).

(() => {
  const $ = (sel) => document.querySelector(sel);
  const views = ['form', 'progress', 'result', 'error'];
  let catalog = null;
  let source = null; // EventSource activ
  let timer = null;

  const EXAMPLES = {
    economie: ['Va scădea inflația din România sub 5%?', 'Va intra zona euro în recesiune?'],
    piete: ['Unde va fi cursul EUR/RON?', 'Va depăși Bitcoin maximul istoric?'],
    tehnologie: ['Ce lansări importante în AI vor avea loc?', 'Cum va evolua piața smartphone-urilor?'],
    politica: ['Cine va câștiga următoarele alegeri?', 'Va rămâne coaliția actuală la guvernare?'],
    geopolitica: ['Va exista un armistițiu în Ucraina?', 'Cum vor evolua relațiile SUA–China?'],
    energie: ['Cât va costa barilul de petrol Brent?', 'Vor scădea facturile la energie în România?'],
    imobiliare: ['Vor crește prețurile apartamentelor în București?', 'Vor scădea dobânzile la creditele ipotecare?'],
    clima: ['Va fi iarna mai caldă decât media?', 'Va fi acest an cel mai cald înregistrat?'],
    sanatate: ['Cum va evolua sezonul de gripă?', 'Ce tratamente noi vor fi aprobate în UE?'],
    sport: ['Cine va câștiga Liga Campionilor?', 'Se va califica România la Campionatul Mondial?'],
    stiinta: ['Va ateriza o misiune cu echipaj pe Lună?', 'Ce descoperiri importante sunt așteptate?'],
    societate: ['Va crește salariul minim în România?', 'Cum va evolua șomajul în UE?'],
    divertisment: ['Ce film va câștiga Oscarul?', 'Care va fi cel mai vizionat film al anului?'],
    altul: ['Scrie aici orice întrebare despre viitor…'],
  };

  const L = {
    ro: {
      scenarios: 'Scenarii', predictions: 'Previziuni verificabile', now: 'Unde ne aflăm acum', drivers: 'Factori-cheie',
      watch: 'De urmărit', wildcards: 'Surprize posibile', sources: 'Surse consultate', confidence: 'Încrederea oracolului',
      conf: { low: 'scăzută', medium: 'medie', high: 'ridicată' }, imp: { positive: 'favorabil', negative: 'nefavorabil', uncertain: 'incert' },
      until: 'până la', made: 'Previziune făcută la', research: (s, c) => `${s} căutări pe internet, ${c} surse găsite`,
      declinedTitle: 'Oracolul nu răspunde la această întrebare', horizon: 'Perioada',
      check: { pending: 'Se verifică după', true: 'S-a adeverit', false: 'Nu s-a adeverit', unresolved: 'Încă nelămurit — se reverifică' },
      source: 'sursa',
    },
    en: {
      scenarios: 'Scenarios', predictions: 'Verifiable predictions', now: 'Where things stand', drivers: 'Key drivers',
      watch: 'What to watch', wildcards: 'Possible surprises', sources: 'Sources consulted', confidence: 'Oracle confidence',
      conf: { low: 'low', medium: 'medium', high: 'high' }, imp: { positive: 'favourable', negative: 'unfavourable', uncertain: 'uncertain' },
      until: 'until', made: 'Forecast made on', research: (s, c) => `${s} web searches, ${c} sources found`,
      declinedTitle: 'The oracle will not answer this question', horizon: 'Horizon',
      check: { pending: 'Checked after', true: 'Came true', false: 'Did not come true', unresolved: 'Not settled yet — will recheck' },
      source: 'source',
    },
  };

  const PHASES = {
    queued: 'Aștepți la rând…',
    research: 'Oracolul caută pe internet…',
    writing: 'Oracolul scrie previziunea…',
    repair: 'Oracolul își pune gândurile în ordine…',
  };

  // ---------- utilitare DOM ----------
  function el(tag, attrs = {}, ...children) {
    const node = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs)) {
      if (v == null || v === false) continue;
      if (k === 'class') node.className = v;
      else if (k === 'text') node.textContent = v;
      else node.setAttribute(k, v === true ? '' : v);
    }
    for (const c of children.flat()) if (c != null && c !== false) node.append(c instanceof Node ? c : document.createTextNode(String(c)));
    return node;
  }

  function show(name) {
    views.forEach((v) => { $(`#view-${v}`).hidden = v !== name; });
    window.scrollTo({ top: 0 });
  }

  function toast(msg) {
    const t = $('#toast');
    t.textContent = msg;
    t.hidden = false;
    clearTimeout(toast.t);
    toast.t = setTimeout(() => { t.hidden = true; }, 2200);
  }

  const label = (list, id, lang = 'ro') => (list.find((x) => x.id === id) || {})[lang] || id;
  const hostOf = (u) => { try { return new URL(u).hostname.replace(/^www\./, ''); } catch { return ''; } };
  const fmtDate = (iso, lang) => new Date(iso).toLocaleDateString(lang === 'en' ? 'en-GB' : 'ro-RO', { day: 'numeric', month: 'long', year: 'numeric' });

  async function api(url, opts) {
    const res = await fetch(url, opts);
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || 'Eroare de rețea. Încearcă din nou.');
    return data;
  }

  // ---------- formular ----------
  function buildForm() {
    const domains = $('#domains');
    catalog.domains.forEach((d, i) => {
      const id = `d-${d.id}`;
      domains.append(el('div', { class: 'chip' },
        el('input', { type: 'radio', name: 'domain', id, value: d.id, checked: i === 0 }),
        el('label', { for: id }, el('span', { class: 'ico', 'aria-hidden': 'true', text: d.icon }), d.ro)));
    });
    const horizons = $('#horizons');
    catalog.horizons.forEach((h) => {
      const id = `h-${h.id}`;
      horizons.append(el('div', { class: 'seg' },
        el('input', { type: 'radio', name: 'horizon', id, value: h.id, checked: h.id === '3m' }),
        el('label', { for: id, text: h.ro })));
    });
    const region = $('#region');
    catalog.regions.forEach((r) => region.append(el('option', { value: r.id, text: r.ro })));

    domains.addEventListener('change', renderExamples);
    renderExamples();

    const q = $('#question');
    q.addEventListener('input', () => { $('#qcount').textContent = `${q.value.length}/500`; });
    $('#form').addEventListener('submit', onSubmit);
  }

  function currentDomain() {
    return (document.querySelector('input[name=domain]:checked') || {}).value;
  }

  function renderExamples() {
    const box = $('#examples');
    box.replaceChildren();
    const d = currentDomain();
    if (d === 'altul') return;
    (EXAMPLES[d] || []).forEach((text) => {
      const b = el('button', { type: 'button', class: 'example', text });
      b.addEventListener('click', () => {
        const q = $('#question');
        q.value = text;
        q.dispatchEvent(new Event('input'));
        q.focus();
      });
      box.append(b);
    });
  }

  async function onSubmit(e) {
    e.preventDefault();
    const err = $('#form-error');
    err.hidden = true;
    const body = {
      domain: currentDomain(),
      horizon: (document.querySelector('input[name=horizon]:checked') || {}).value,
      region: $('#region').value,
      lang: $('#lang').value,
      question: $('#question').value.trim(),
    };
    const btn = $('#submit');
    btn.disabled = true;
    try {
      const { id } = await api('/api/predict', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
      });
      history.pushState({}, '', `/p/${id}`);
      follow(id);
    } catch (ex) {
      err.textContent = ex.message;
      err.hidden = false;
    } finally {
      btn.disabled = false;
    }
  }

  // ---------- progres ----------
  function startTimer() {
    const started = Date.now();
    clearInterval(timer);
    const tick = () => {
      const s = Math.floor((Date.now() - started) / 1000);
      $('#elapsed').textContent = `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
    };
    tick();
    timer = setInterval(tick, 1000);
  }

  function logLine(icon, text, cls) {
    const log = $('#log');
    log.append(el('li', { class: cls }, el('span', { class: 'k', 'aria-hidden': 'true', text: icon }), el('span', { text })));
    while (log.children.length > 14) log.firstElementChild.remove();
  }

  function follow(id) {
    if (source) source.close();
    $('#log').replaceChildren();
    $('#phase').textContent = 'Oracolul se pregătește…';
    $('#progress-sub').textContent = '';
    let searches = 0;
    let settled = false;
    let gotEvent = false;

    source = new EventSource(`/api/predict/${encodeURIComponent(id)}/events`);
    source.addEventListener('status', (e) => {
      if (!gotEvent) { gotEvent = true; show('progress'); startTimer(); }
      const d = JSON.parse(e.data);
      $('#phase').textContent = PHASES[d.phase] || PHASES.research;
      if (d.phase === 'queued') $('#progress-sub').textContent = `Ești al ${d.position}-lea la rând.`;
      else if (d.phase === 'research') $('#progress-sub').textContent = '';
    });
    source.addEventListener('search', (e) => {
      searches++;
      logLine('🔎', `Caută: „${JSON.parse(e.data).query}”`);
      $('#progress-sub').textContent = `${searches} ${searches === 1 ? 'căutare' : 'căutări'}`;
    });
    source.addEventListener('results', (e) => {
      const d = JSON.parse(e.data);
      $('#progress-sub').textContent = `${searches} ${searches === 1 ? 'căutare' : 'căutări'} · ${d.sources} surse găsite`;
    });
    source.addEventListener('fetch', (e) => logLine('📖', `Citește: ${JSON.parse(e.data).host}`));
    source.addEventListener('thought', (e) => logLine('💭', JSON.parse(e.data).text, 'thought'));
    source.addEventListener('done', (e) => {
      settled = true;
      source.close();
      clearInterval(timer);
      loadPrediction(JSON.parse(e.data).id);
    });
    source.addEventListener('error', (e) => {
      // Eveniment „error” trimis de server (cu mesaj) sau eroare de conexiune (fără date).
      if (e.data) {
        settled = true;
        source.close();
        clearInterval(timer);
        fail(JSON.parse(e.data).message);
      } else if (source.readyState === EventSource.CLOSED && !settled) {
        clearInterval(timer);
        fail(gotEvent
          ? 'Legătura cu serverul s-a întrerupt. Reîncarcă pagina pentru a vedea previziunea.'
          : 'Previziunea nu există sau nu mai este disponibilă.');
      }
      // altfel: EventSource se reconectează singur
    });
  }

  function fail(msg) {
    $('#error-msg').textContent = msg;
    show('error');
  }

  // ---------- rezultat ----------
  async function loadPrediction(id) {
    try {
      const rec = await api(`/api/p/${encodeURIComponent(id)}`);
      renderPrediction(rec);
      show('result');
      document.title = `${rec.prediction.title || 'Previziune'} — Nostradamus`;
    } catch (ex) {
      fail(ex.message);
    }
  }

  function card(title, ...content) {
    return el('section', { class: 'card' }, title ? el('h3', { text: title }) : null, ...content);
  }

  function confidenceDots(level, t) {
    const n = { low: 1, medium: 2, high: 3 }[level] || 2;
    return el('span', { class: 'conf' }, `${t.confidence}: ${t.conf[level] || level}`,
      el('span', { class: 'dots', 'aria-hidden': 'true' }, [1, 2, 3].map((i) => el('i', { class: i <= n ? 'on' : null }))));
  }

  /** Rezultatul verificării unei afirmații: în așteptare, adevărată, falsă sau nelămurită. */
  function checkBadge(c, t, lang) {
    if (!c) return null;
    const icon = { pending: '⏳', true: '✓', false: '✗', unresolved: '…' }[c.status] || '⏳';
    const label = c.status === 'pending' ? `${t.check.pending} ${fmtDate(c.resolveBy, lang)}` : t.check[c.status];
    return el('div', { class: `check check-${c.status}` },
      el('span', { class: 'check-label' }, el('span', { 'aria-hidden': 'true', text: `${icon} ` }), label),
      c.evidence ? el('span', { class: 'check-evidence', text: c.evidence }) : null,
      c.url ? el('a', { href: c.url, target: '_blank', rel: 'noopener noreferrer nofollow', text: `${t.source}: ${hostOf(c.url)}` }) : null);
  }

  function renderPrediction(rec) {
    const { request: rq, prediction: p, meta } = rec;
    const lang = rq.lang === 'en' ? 'en' : 'ro';
    const t = L[lang];
    const root = $('#result');
    root.replaceChildren();

    const dom = catalog.domains.find((d) => d.id === rq.domain);
    const tags = el('div', { class: 'r-tags' },
      el('span', { class: 'tag', text: `${dom ? dom.icon : ''} ${label(catalog.domains, rq.domain, lang)}` }),
      el('span', { class: 'tag', text: `${t.horizon}: ${label(catalog.horizons, rq.horizon, lang)}` }),
      el('span', { class: 'tag', text: label(catalog.regions, rq.region, lang) }));

    if (p.declined) {
      root.append(el('section', { class: 'card declined' }, tags, el('h1', { text: t.declinedTitle }), el('p', { text: p.declined_reason || p.summary })));
      return;
    }

    root.append(el('section', { class: 'card r-head' },
      tags,
      el('h1', { text: p.title }),
      rq.question ? el('p', { class: 'muted', text: `„${rq.question}”` }) : null,
      el('p', { class: 'r-summary', text: p.summary }),
      confidenceDots(p.confidence, t),
      p.quatrain ? el('blockquote', { class: 'quatrain', text: p.quatrain }) : null));

    if (p.scenarios.length) {
      root.append(card(t.scenarios, el('div', { class: 'scenarios' }, p.scenarios.map((s) => {
        const bar = el('b');
        bar.style.width = `${s.probability}%`;
        return el('div', { class: 'scenario' },
          el('div', { class: 'scenario-head' }, el('strong', { text: s.name }), el('span', { class: 'pct', text: `${s.probability}%` })),
          el('div', { class: 'bar', role: 'img', 'aria-label': `${s.probability}%` }, bar),
          el('p', { text: s.description }),
          s.signals.length ? el('ul', { class: 'signals' }, s.signals.map((x) => el('li', { text: x }))) : null);
      }))));
    }

    if (p.predictions.length) {
      root.append(card(t.predictions, el('ul', { class: 'preds' }, p.predictions.map((x, i) => {
        const ring = el('div', { class: 'ring', role: 'img', 'aria-label': `${x.probability}%` }, el('span', { text: `${x.probability}%` }));
        ring.style.setProperty('--p', x.probability);
        return el('li', { class: 'pred' }, ring, el('div', {},
          el('p', { class: 'pred-claim', text: x.claim }),
          el('p', { class: 'pred-meta', text: [x.timeframe, `${t.confidence.split(' ')[0]}: ${t.conf[x.confidence]}`].filter(Boolean).join(' · ') }),
          el('p', { class: 'pred-why', text: x.rationale }),
          checkBadge((rec.checks || [])[i], t, lang)));
      }))));
    }

    if (p.current_state) root.append(card(t.now, el('p', { class: 'text-block', text: p.current_state })));

    if (p.drivers.length) {
      root.append(card(t.drivers, el('ul', { class: 'drivers' }, p.drivers.map((d) => el('li', { class: d.impact },
        el('strong', { text: d.name }), el('span', { class: 'imp', text: t.imp[d.impact] }), el('p', { text: d.explanation }))))));
    }

    const two = [];
    if (p.watch.length) {
      two.push(card(t.watch, el('ul', { class: 'plain' }, p.watch.map((w) => el('li', {}, w.indicator, w.when ? el('div', { class: 'when', text: w.when }) : null)))));
    }
    if (p.wildcards.length) two.push(card(t.wildcards, el('ul', { class: 'plain' }, p.wildcards.map((w) => el('li', { text: w })))));
    if (two.length) root.append(el('div', { class: two.length === 2 ? 'two' : '' }, two));

    if (p.sources.length) {
      root.append(card(t.sources, el('ol', { class: 'sources' }, p.sources.map((s) => el('li', {},
        el('a', { href: s.url, target: '_blank', rel: 'noopener noreferrer nofollow', text: s.title || hostOf(s.url) }),
        el('span', { class: 'host', text: hostOf(s.url) }))))));
    }

    root.append(el('p', { class: 'r-foot', text: `${t.made} ${fmtDate(rec.createdAt, lang)} · ${t.research(meta.searches || 0, meta.consulted || 0)}` }));
  }

  // ---------- palmares ----------
  async function loadTrack() {
    const box = $('#track');
    try {
      const tr = await api('/api/track-record');
      if (!tr.resolved) {
        box.replaceChildren(
          el('p', { text: 'Oracolul își verifică singur previziunile: după data fiecărei afirmații, caută ce s-a întâmplat de fapt și o marchează ca adevărată sau falsă. Aici se va vedea cât de des are dreptate.' }),
          el('p', { class: 'muted', text: tr.pending
            ? `${tr.pending} afirmații așteaptă verificarea. Primele rezultate: după ${fmtDate(tr.nextCheck, 'ro')}.`
            : 'Încă nu există afirmații de verificat.' }));
        return;
      }
      const pct = Math.round((100 * tr.correct) / tr.resolved);
      const stats = el('div', { class: 'stats' },
        el('div', { class: 'stat' }, el('strong', { text: `${pct}%` }), el('span', { text: `previziuni corecte (${tr.correct} din ${tr.resolved})` })),
        el('div', { class: 'stat' }, el('strong', { text: String(tr.brier).replace('.', ',') }), el('span', { text: 'scor Brier (0 = perfect, 0,25 = cu banul)' })),
        el('div', { class: 'stat' }, el('strong', { text: String(tr.pending) }), el('span', { text: 'afirmații încă în așteptare' })));
      const rows = tr.buckets.filter((b) => b.count).map((b) => {
        const bar = el('b');
        bar.style.width = `${b.actual}%`;
        return el('li', {}, el('span', { class: 'cal-range', text: `Spus ${b.range}` }),
          el('span', { class: 'bar' }, bar),
          el('span', { class: 'cal-actual', text: `s-a întâmplat ${b.actual}% (${b.count})` }));
      });
      box.replaceChildren(stats,
        rows.length ? el('div', {}, el('h3', { text: 'Calibrare' }), el('ul', { class: 'calibration' }, rows)) : null,
        tr.recent.length ? el('div', {}, el('h3', { text: 'Ultimele verificări' }), el('ul', { class: 'checked-list' }, tr.recent.map((r) => el('li', {},
          el('span', { class: r.outcome ? 'ok' : 'ko', text: r.outcome ? '✓ ' : '✗ ' }),
          el('a', { href: `/p/${r.id}`, 'data-nav': true, text: r.claim }),
          el('span', { class: 'muted', text: ` — ${r.probability}%` }))))) : null);
    } catch {
      box.closest('section').hidden = true;
    }
  }

  // ---------- recente ----------
  async function loadRecent() {
    try {
      const list = await api('/api/recent');
      const ul = $('#recent');
      ul.replaceChildren(...list.map((r) => el('li', {}, el('a', { href: `/p/${r.id}`, 'data-nav': true },
        el('span', { class: 'r-title', text: r.title }),
        el('span', { class: 'r-meta', text: `${label(catalog.horizons, r.horizon)} · ${fmtDate(r.createdAt, 'ro')}` })))));
      $('#recent-empty').hidden = list.length > 0;
    } catch { /* lista recentă e opțională */ }
  }

  // ---------- navigare ----------
  function route() {
    if (source) { source.close(); source = null; }
    clearInterval(timer);
    const m = /^\/p\/([A-Za-z0-9_-]{8,32})\/?$/.exec(location.pathname);
    if (m) {
      follow(m[1]);
    } else {
      document.title = 'Nostradamus — previziuni din datele de azi';
      show('form');
      loadTrack();
      loadRecent();
    }
  }

  document.addEventListener('click', (e) => {
    const a = e.target.closest('a[data-nav]');
    if (!a || e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return;
    e.preventDefault();
    history.pushState({}, '', a.getAttribute('href'));
    route();
  });
  window.addEventListener('popstate', route);

  $('#copy-link').addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText(location.href);
      toast('Linkul a fost copiat');
    } catch {
      toast(location.href);
    }
  });

  api('/api/catalog').then((c) => {
    catalog = c;
    buildForm();
    route();
  }).catch(() => fail('Aplicația nu s-a putut încărca. Reîncarcă pagina.'));
})();
