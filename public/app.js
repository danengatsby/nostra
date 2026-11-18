'use strict';
// Interfața Nostradamus: formular → flux de progres (SSE) → previziune. Tot conținutul venit de la
// server este inserat cu textContent (niciodată ca HTML). Interfața e în română sau engleză.

(() => {
  const $ = (sel) => document.querySelector(sel);
  const views = ['form', 'progress', 'result', 'error'];
  let catalog = null;
  let source = null; // EventSource activ
  let timer = null;
  let current = null; // previziunea afișată
  let eta = 120; // durata estimată a unei previziuni, în secunde

  // ---------- limba interfeței ----------
  const U = {
    ro: {
      tagline: 'Previziuni construite din ce se întâmplă acum în lume',
      install: 'Instalează aplicația', stats: '📊 Statistici', stepDomain: 'Domeniul', stepQuestion: 'Întrebarea ta', optional: '(opțional)',
      questionPh: 'Ex.: Va scădea inflația din România sub 5% până la finalul perioadei?', examples: 'Exemple de întrebări',
      questionHint: 'Fără întrebare, oracolul îți spune ce e cel mai important de așteptat în domeniul și regiunea aleasă.',
      stepHorizon: 'Perioada', region: 'Regiunea', answerLang: 'Limba răspunsului', effort: 'Efortul oracolului',
      private: 'Previziune privată', privateHint: 'Nu apare în lista publică și nu e indexată de motoarele de căutare. O vede doar cine are linkul.',
      submit: 'Consultă oracolul', submitPaid: (p) => `Consultă oracolul — ${p}`,
      payHint: (p) => `Plătești ${p} pe pagina securizată Stripe, apoi oracolul începe lucrul. Dacă nu poate răspunde, banii se returnează automat.`,
      toPayment: 'Te ducem la pagina de plată…', confirming: 'Confirmăm plata…',
      consent: 'Sunt de acord cu Termenii și confidențialitatea și cer furnizarea imediată a previziunii; înțeleg că, odată furnizată, nu mai pot cere retragerea din contract.',
      readTerms: 'Citește termenii', termsLink: 'Termeni și confidențialitate', contact: 'Contact',
      emailLabel: 'Adresa de email la care primești previziunea', emailPh: 'nume@exemplu.ro',
      emailMissing: 'Scrie adresa de email la care să primești previziunea.', emailInvalid: 'Adresa de email nu pare corectă.',
      consentMissing: 'Bifează acordul cu termenii înainte de plată.',
      payPending: 'Plata nu a fost confirmată încă. Dacă ai plătit, previziunea pornește automat — poți reveni la acest link.',
      payExpired: 'Plata nu a fost finalizată, iar pagina de plată a expirat. Nu ți s-a luat niciun ban.',
      payCanceled: 'Plata a fost anulată. Nu ți s-a luat niciun ban.',
      refundedNote: 'Plata pentru această previziune a fost returnată automat.',
      duration: 'Durează de obicei 1–3 minute: oracolul caută și citește surse actuale înainte să răspundă.',
      trackTitle: 'Palmaresul oracolului', loading: 'Se încarcă…', recentTitle: 'Previziuni recente',
      recentEmpty: 'Încă nu există previziuni. Fii primul care consultă oracolul.',
      preparing: 'Oracolul se pregătește…', notify: '🔔 Anunță-mă când e gata', notifyOn: '🔔 Te anunțăm când e gata',
      leaveHint: 'Poți lăsa pagina deschisă sau poți reveni mai târziu la același link: previziunea se termină oricum.',
      share: 'Distribuie', copyLink: 'Copiază linkul', pdf: 'Salvează PDF', newForecast: 'O nouă previziune',
      errorTitle: 'Oracolul a tăcut', tryAgain: 'Încearcă din nou',
      disclaimer: 'Previziunile sunt estimări probabilistice generate automat de inteligență artificială pe baza surselor publice găsite la momentul cererii. Nu sunt certitudini și nu reprezintă consultanță financiară, medicală sau juridică.',
      phases: { queued: 'Aștepți la rând…', research: 'Oracolul caută pe internet…', writing: 'Oracolul scrie previziunea…', repair: 'Oracolul își pune gândurile în ordine…', fallback: 'Oracolul continuă cu modelul rapid…' },
      queuePos: (n) => `Ești al ${n}-lea la rând.`,
      searches: (n) => `${n} ${n === 1 ? 'căutare' : 'căutări'}`, found: (n) => `${n} surse găsite`,
      searching: (q) => `Caută: „${q}”`, reading: (h) => `Citește: ${h}`,
      etaLeft: (m) => (m <= 1 ? '· mai puțin de un minut' : `· încă ~${m} minute`), etaAlmost: '· aproape gata…',
      lost: 'Legătura cu serverul s-a întrerupt. Reîncarcă pagina pentru a vedea previziunea.',
      missing: 'Previziunea nu există sau nu mai este disponibilă.', network: 'Eroare de rețea. Încearcă din nou.',
      loadFail: 'Aplicația nu s-a putut încărca. Reîncarcă pagina.', copied: 'Linkul a fost copiat',
      readyTitle: 'Previziunea e gata', defaultTitle: 'Nostradamus — previziuni din datele de azi',
      track: {
        intro: 'Oracolul își verifică singur previziunile: după data fiecărei afirmații, caută ce s-a întâmplat de fapt și o marchează ca adevărată sau falsă. Aici se va vedea cât de des are dreptate.',
        waiting: (n, d) => `${n} afirmații așteaptă verificarea. Primele rezultate: după ${d}.`, none: 'Încă nu există afirmații de verificat.',
        correct: (c, n) => `previziuni corecte (${c} din ${n})`, brier: 'scor Brier (0 = perfect, 0,25 = cu banul)', pending: 'afirmații încă în așteptare',
        calibration: 'Calibrare', said: (r) => `Spus ${r}`, happened: (a, n) => `s-a întâmplat ${a}% (${n})`, latest: 'Ultimele verificări',
      },
      examplesBy: {
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
      },
    },
    en: {
      tagline: 'Forecasts built from what is happening in the world right now',
      install: 'Install the app', stats: '📊 Statistics', stepDomain: 'Domain', stepQuestion: 'Your question', optional: '(optional)',
      questionPh: 'E.g.: Will euro area inflation fall below 2% by the end of the period?', examples: 'Example questions',
      questionHint: 'Without a question, the oracle tells you what matters most to expect in the chosen domain and region.',
      stepHorizon: 'Period', region: 'Region', answerLang: 'Answer language', effort: 'Oracle effort',
      private: 'Private forecast', privateHint: 'Not shown in the public list and not indexed by search engines. Only people with the link can see it.',
      submit: 'Consult the oracle', submitPaid: (p) => `Consult the oracle — ${p}`,
      payHint: (p) => `You pay ${p} on Stripe’s secure page, then the oracle starts working. If it cannot answer, you are refunded automatically.`,
      toPayment: 'Taking you to the payment page…', confirming: 'Confirming your payment…',
      consent: 'I agree to the Terms and privacy policy and request immediate supply of the forecast; I understand that once it is supplied I can no longer withdraw from the contract.',
      readTerms: 'Read the terms', termsLink: 'Terms and privacy', contact: 'Contact',
      emailLabel: 'Email address to receive your forecast', emailPh: 'name@example.com',
      emailMissing: 'Enter the email address where you want to receive the forecast.', emailInvalid: 'This email address does not look right.',
      consentMissing: 'Please tick the box accepting the terms before paying.',
      payPending: 'The payment has not been confirmed yet. If you paid, the forecast will start automatically — you can come back to this link.',
      payExpired: 'The payment was not completed and the payment page has expired. You have not been charged.',
      payCanceled: 'The payment was canceled. You have not been charged.',
      refundedNote: 'The payment for this forecast was refunded automatically.',
      duration: 'Usually takes 1–3 minutes: the oracle searches and reads current sources before answering.',
      trackTitle: 'The oracle’s track record', loading: 'Loading…', recentTitle: 'Recent forecasts',
      recentEmpty: 'No forecasts yet. Be the first to consult the oracle.',
      preparing: 'The oracle is getting ready…', notify: '🔔 Notify me when it’s ready', notifyOn: '🔔 We’ll notify you when it’s ready',
      leaveHint: 'You can keep this page open or come back later to the same link: the forecast will finish anyway.',
      share: 'Share', copyLink: 'Copy link', pdf: 'Save as PDF', newForecast: 'New forecast',
      errorTitle: 'The oracle fell silent', tryAgain: 'Try again',
      disclaimer: 'Forecasts are probabilistic estimates generated automatically by artificial intelligence from public sources found at the time of the request. They are not certainties and are not financial, medical or legal advice.',
      phases: { queued: 'Waiting in line…', research: 'The oracle is searching the web…', writing: 'The oracle is writing the forecast…', repair: 'The oracle is putting its thoughts in order…', fallback: 'The oracle continues with the fast model…' },
      queuePos: (n) => `You are number ${n} in line.`,
      searches: (n) => `${n} ${n === 1 ? 'search' : 'searches'}`, found: (n) => `${n} sources found`,
      searching: (q) => `Searching: “${q}”`, reading: (h) => `Reading: ${h}`,
      etaLeft: (m) => (m <= 1 ? '· less than a minute left' : `· about ${m} minutes left`), etaAlmost: '· almost done…',
      lost: 'The connection to the server was lost. Reload the page to see the forecast.',
      missing: 'This forecast does not exist or is no longer available.', network: 'Network error. Please try again.',
      loadFail: 'The app could not load. Please reload the page.', copied: 'Link copied',
      readyTitle: 'Your forecast is ready', defaultTitle: 'Nostradamus — forecasts from today’s data',
      track: {
        intro: 'The oracle checks its own forecasts: after each claim’s date, it looks up what actually happened and marks it true or false. This is where you will see how often it is right.',
        waiting: (n, d) => `${n} claims are waiting to be checked. First results: after ${d}.`, none: 'There are no claims to check yet.',
        correct: (c, n) => `correct forecasts (${c} of ${n})`, brier: 'Brier score (0 = perfect, 0.25 = coin flip)', pending: 'claims still pending',
        calibration: 'Calibration', said: (r) => `Said ${r}`, happened: (a, n) => `happened ${a}% (${n})`, latest: 'Latest checks',
      },
      examplesBy: {
        economie: ['Will the euro area enter a recession?', 'Will the Fed cut interest rates?'],
        piete: ['Where will EUR/USD trade?', 'Will Bitcoin hit a new all-time high?'],
        tehnologie: ['Which major AI launches will happen?', 'How will the smartphone market evolve?'],
        politica: ['Who will win the next election?', 'Will the current government survive?'],
        geopolitica: ['Will there be a ceasefire in Ukraine?', 'How will US–China relations evolve?'],
        energie: ['What will a barrel of Brent cost?', 'Will European gas prices fall?'],
        imobiliare: ['Will house prices rise in my city?', 'Will mortgage rates go down?'],
        clima: ['Will this winter be warmer than average?', 'Will this be the hottest year on record?'],
        sanatate: ['How will the flu season evolve?', 'Which new treatments will be approved in the EU?'],
        sport: ['Who will win the Champions League?', 'Who will win the next Grand Slam?'],
        stiinta: ['Will a crewed mission land on the Moon?', 'Which major discoveries are expected?'],
        societate: ['Will unemployment rise in the EU?', 'How will migration trends change?'],
        divertisment: ['Which film will win the Oscar?', 'What will be the year’s biggest box office hit?'],
      },
    },
  };

  // Etichetele rezultatului urmează limba previziunii (conținutul), nu a interfeței.
  const L = {
    ro: {
      scenarios: 'Scenarii', predictions: 'Previziuni verificabile', now: 'Unde ne aflăm acum', drivers: 'Factori-cheie',
      watch: 'De urmărit', wildcards: 'Surprize posibile', sources: 'Surse consultate', confidence: 'Încrederea oracolului', conf1: 'Încredere',
      conf: { low: 'scăzută', medium: 'medie', high: 'ridicată' }, imp: { positive: 'favorabil', negative: 'nefavorabil', uncertain: 'incert' },
      made: 'Previziune făcută la', research: (s, c) => `${s} căutări pe internet, ${c} surse găsite`,
      declinedTitle: 'Oracolul nu răspunde la această întrebare', horizon: 'Perioada', privateTag: 'privată', effort: 'Efort',
      liteTag: 'model rapid', liteNote: 'Previziune făcută cu modelul rapid al oracolului (analiză mai scurtă, cu mai puține căutări).',
      check: { pending: 'Se verifică după', true: 'S-a adeverit', false: 'Nu s-a adeverit', unresolved: 'Încă nelămurit — se reverifică' },
      source: 'sursa', history: 'Cum s-a schimbat prognoza', historyHint: 'Aceeași întrebare, pusă la momente diferite — probabilitatea scenariului de bază:',
      thisOne: 'aceasta', refresh: 'Actualizează previziunea cu datele de azi',
    },
    en: {
      scenarios: 'Scenarios', predictions: 'Verifiable predictions', now: 'Where things stand', drivers: 'Key drivers',
      watch: 'What to watch', wildcards: 'Possible surprises', sources: 'Sources consulted', confidence: 'Oracle confidence', conf1: 'Confidence',
      conf: { low: 'low', medium: 'medium', high: 'high' }, imp: { positive: 'favourable', negative: 'unfavourable', uncertain: 'uncertain' },
      made: 'Forecast made on', research: (s, c) => `${s} web searches, ${c} sources found`,
      declinedTitle: 'The oracle will not answer this question', horizon: 'Horizon', privateTag: 'private', effort: 'Effort',
      liteTag: 'fast model', liteNote: 'Forecast made with the oracle’s fast model (a shorter analysis with fewer searches).',
      check: { pending: 'Checked after', true: 'Came true', false: 'Did not come true', unresolved: 'Not settled yet — will recheck' },
      source: 'source', history: 'How the forecast changed', historyHint: 'The same question asked at different times — probability of the base scenario:',
      thisOne: 'this one', refresh: 'Update the forecast with today’s data',
    },
  };

  const store = {
    get: (k) => { try { return localStorage.getItem(k); } catch { return null; } },
    set: (k, v) => { try { localStorage.setItem(k, v); } catch { /* stocare indisponibilă */ } },
  };
  const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

  const sessionStore = {
    get: (k) => { try { return sessionStorage.getItem(k); } catch { return null; } },
    set: (k, v) => { try { sessionStorage.setItem(k, v); } catch { /* indisponibil */ } },
    del: (k) => { try { sessionStorage.removeItem(k); } catch { /* indisponibil */ } },
  };
  eta = Number(sessionStore.get('eta')) || eta;
  let ui = store.get('ui') || ((navigator.language || 'ro').toLowerCase().startsWith('ro') ? 'ro' : 'en');
  const tr = (key) => U[ui][key];

  function applyUi() {
    document.documentElement.lang = ui;
    document.querySelectorAll('[data-i18n]').forEach((n) => { n.textContent = tr(n.dataset.i18n); });
    const pay = catalog?.payment;
    if (pay?.required) {
      $('#submit').textContent = tr('submitPaid')(pay.price);
      $('#pay-hint').textContent = tr('payHint')(pay.price);
    }
    $('#pay-hint').hidden = !pay?.required;
    $('#consent-row').hidden = !pay?.required;
    $('#email-row').hidden = !pay?.required;
    if (catalog?.contact) $('#contact-link').href = `mailto:${catalog.contact}`;
    document.querySelectorAll('[data-i18n-ph]').forEach((n) => { n.placeholder = tr(n.dataset.i18nPh); });
    document.querySelectorAll('[data-i18n-aria]').forEach((n) => n.setAttribute('aria-label', tr(n.dataset.i18nAria)));
    const btn = $('#ui-lang');
    btn.textContent = ui === 'ro' ? 'EN' : 'RO';
    btn.setAttribute('aria-label', ui === 'ro' ? 'Change language to English' : 'Schimbă limba în română');
  }

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
    const tst = $('#toast');
    tst.textContent = msg;
    tst.hidden = false;
    clearTimeout(toast.t);
    toast.t = setTimeout(() => { tst.hidden = true; }, 2200);
  }

  const label = (list, id, lang = ui) => (list.find((x) => x.id === id) || {})[lang] || id;
  const hostOf = (u) => { try { return new URL(u).hostname.replace(/^www\./, ''); } catch { return ''; } };
  const fmtDate = (iso, lang = ui) => new Date(iso).toLocaleDateString(lang === 'en' ? 'en-GB' : 'ro-RO', { day: 'numeric', month: 'long', year: 'numeric' });
  const fmtShort = (iso, lang = ui) => new Date(iso).toLocaleDateString(lang === 'en' ? 'en-GB' : 'ro-RO', { day: 'numeric', month: 'short', year: 'numeric' });

  async function api(url, opts) {
    const res = await fetch(url, opts);
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || tr('network'));
    return data;
  }

  // ---------- formular ----------
  function buildForm() {
    const domains = $('#domains');
    const checkedDomain = currentDomain() || catalog.domains[0].id;
    domains.replaceChildren(...catalog.domains.map((d) => {
      const id = `d-${d.id}`;
      return el('div', { class: 'chip' },
        el('input', { type: 'radio', name: 'domain', id, value: d.id, checked: d.id === checkedDomain }),
        el('label', { for: id }, el('span', { class: 'ico', 'aria-hidden': 'true', text: d.icon }), d[ui]));
    }));
    const checkedHorizon = (document.querySelector('input[name=horizon]:checked') || {}).value || '3m';
    $('#horizons').replaceChildren(...catalog.horizons.map((h) => {
      const id = `h-${h.id}`;
      return el('div', { class: 'seg' },
        el('input', { type: 'radio', name: 'horizon', id, value: h.id, checked: h.id === checkedHorizon }),
        el('label', { for: id, text: h[ui] }));
    }));
    const checkedEffort = currentEffort() || catalog.defaultEffort;
    $('#efforts').replaceChildren(...catalog.efforts.map((x) => {
      const id = `e-${x.id}`;
      return el('div', { class: 'seg' },
        el('input', { type: 'radio', name: 'effort', id, value: x.id, checked: x.id === checkedEffort }),
        el('label', { for: id, text: x[ui] }));
    }));
    renderEffortHint();
    const region = $('#region');
    const reg = region.value || 'global';
    region.replaceChildren(...catalog.regions.map((r) => el('option', { value: r.id, text: r[ui] })));
    region.value = reg;
    renderExamples();
  }

  function currentEffort() {
    return (document.querySelector('input[name=effort]:checked') || {}).value;
  }

  function renderEffortHint() {
    const x = catalog.efforts.find((e) => e.id === currentEffort());
    $('#effort-hint').textContent = x ? x[ui === 'en' ? 'hintEn' : 'hintRo'] : '';
  }

  function currentDomain() {
    return (document.querySelector('input[name=domain]:checked') || {}).value;
  }

  function renderExamples() {
    const box = $('#examples');
    box.replaceChildren();
    (tr('examplesBy')[currentDomain()] || []).forEach((text) => {
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

  async function startPrediction(body) {
    const res = await api('/api/predict', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ...body, ui }),
    });
    if (res.etaSec) { eta = res.etaSec; sessionStore.set('eta', String(eta)); }
    if (res.checkoutUrl) {
      // Plata: formularul se păstrează, ca vizitatorul să-l regăsească dacă anulează plata.
      sessionStore.set('form', JSON.stringify(body));
      toast(tr('toPayment'));
      location.assign(res.checkoutUrl);
      return;
    }
    history.pushState({}, '', `/p/${res.id}`);
    follow(res.id);
  }

  /** Întoarcerea de pe pagina de plată: confirmăm plata, apoi urmărim previziunea. */
  async function confirmPayment(orderId) {
    show('progress');
    $('#log').replaceChildren();
    $('#phase').textContent = tr('confirming');
    $('#progress-sub').textContent = '';
    $('#eta-text').textContent = '';
    $('#elapsed').textContent = '';
    $('#notify').hidden = true;
    for (let attempt = 0; attempt < 40; attempt++) {
      let st;
      try {
        st = await api(`/api/orders/${encodeURIComponent(orderId)}/confirm`, {
          method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ui }),
        });
      } catch (ex) {
        return fail(ex.message);
      }
      if (location.pathname !== `/pay/${orderId}`) return; // vizitatorul a plecat între timp
      if (st.predictionId) {
        sessionStore.del('form');
        history.replaceState({}, '', `/p/${st.predictionId}`);
        return follow(st.predictionId);
      }
      if (st.status === 'expired') return fail(tr('payExpired'));
      await new Promise((r) => setTimeout(r, 3000)); // plata poate fi confirmată cu câteva secunde întârziere
    }
    fail(tr('payPending'));
  }

  function restoreForm() {
    let body = null;
    try { body = JSON.parse(sessionStore.get('form') || 'null'); } catch { /* ignorăm */ }
    if (!body) return;
    const check = (name, value) => { const i = document.querySelector(`input[name=${name}][value="${value}"]`); if (i) i.checked = true; };
    check('domain', body.domain);
    check('horizon', body.horizon);
    check('effort', body.effort);
    if (body.region) $('#region').value = body.region;
    if (body.lang) $('#lang').value = body.lang;
    $('#question').value = body.question || '';
    $('#question').dispatchEvent(new Event('input'));
    $('#private').checked = !!body.private;
    if (body.email) $('#email').value = body.email;
    renderExamples();
    renderEffortHint();
  }

  async function onSubmit(e) {
    e.preventDefault();
    const err = $('#form-error');
    err.hidden = true;
    if (catalog.payment?.required) {
      const email = $('#email').value.trim();
      const problem = !email ? 'emailMissing' : !EMAIL_RE.test(email) ? 'emailInvalid' : !$('#consent').checked ? 'consentMissing' : null;
      if (problem) {
        err.textContent = tr(problem);
        err.hidden = false;
        (problem === 'consentMissing' ? $('#consent') : $('#email')).focus();
        return;
      }
    }
    const btn = $('#submit');
    btn.disabled = true;
    try {
      await startPrediction({
        consent: $('#consent').checked,
        email: catalog.payment?.required ? $('#email').value.trim() : undefined,
        domain: currentDomain(),
        horizon: (document.querySelector('input[name=horizon]:checked') || {}).value,
        region: $('#region').value,
        lang: $('#lang').value,
        question: $('#question').value.trim(),
        private: $('#private').checked,
        effort: currentEffort(),
      });
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
      const clock = `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
      $('#elapsed').textContent = clock;
      // Bara se apropie de capăt fără să-l atingă; „aproape gata” după durata obișnuită.
      $('#eta-bar').style.width = `${Math.min(96, (s / eta) * 90)}%`;
      const left = Math.ceil((eta - s) / 60);
      $('#eta-text').textContent = s < eta ? tr('etaLeft')(left) : tr('etaAlmost');
      document.title = `⏳ ${clock} · Nostradamus`;
    };
    tick();
    timer = setInterval(tick, 1000);
  }

  function logLine(icon, text, cls) {
    const log = $('#log');
    log.append(el('li', { class: cls }, el('span', { class: 'k', 'aria-hidden': 'true', text: icon }), el('span', { text })));
    while (log.children.length > 14) log.firstElementChild.remove();
  }

  // Notificare în browser când previziunea e gata (doar dacă utilizatorul a cerut-o și pagina nu e în față).
  let wantNotify = false;
  function setupNotify() {
    const btn = $('#notify');
    const supported = 'Notification' in window && Notification.permission !== 'denied';
    btn.hidden = !supported;
    btn.disabled = false;
    btn.textContent = tr(wantNotify ? 'notifyOn' : 'notify');
  }

  function notifyDone(title, id) {
    if (!wantNotify || !document.hidden || !('Notification' in window) || Notification.permission !== 'granted') return;
    const n = new Notification(tr('readyTitle'), { body: title, icon: '/icons/icon-192.png', tag: id });
    n.onclick = () => { window.focus(); n.close(); };
  }

  function follow(id) {
    if (source) source.close();
    $('#log').replaceChildren();
    $('#phase').textContent = tr('preparing');
    $('#progress-sub').textContent = '';
    setupNotify();
    let searches = 0;
    let settled = false;
    let gotEvent = false;

    source = new EventSource(`/api/predict/${encodeURIComponent(id)}/events?ui=${ui}`);
    source.addEventListener('status', (e) => {
      if (!gotEvent) { gotEvent = true; show('progress'); startTimer(); }
      const d = JSON.parse(e.data);
      $('#phase').textContent = tr('phases')[d.phase] || tr('phases').research;
      if (d.phase === 'queued') $('#progress-sub').textContent = tr('queuePos')(d.position);
      else if (d.phase === 'research') $('#progress-sub').textContent = '';
    });
    source.addEventListener('search', (e) => {
      searches++;
      logLine('🔎', tr('searching')(JSON.parse(e.data).query));
      $('#progress-sub').textContent = tr('searches')(searches);
    });
    source.addEventListener('results', (e) => {
      const d = JSON.parse(e.data);
      $('#progress-sub').textContent = `${tr('searches')(searches)} · ${tr('found')(d.sources)}`;
    });
    source.addEventListener('fetch', (e) => logLine('📖', tr('reading')(JSON.parse(e.data).host)));
    source.addEventListener('thought', (e) => logLine('💭', JSON.parse(e.data).text, 'thought'));
    source.addEventListener('done', (e) => {
      settled = true;
      source.close();
      clearInterval(timer);
      loadPrediction(JSON.parse(e.data).id, gotEvent);
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
        fail(tr(gotEvent ? 'lost' : 'missing'));
      }
      // altfel: EventSource se reconectează singur
    });
  }

  function fail(msg) {
    $('#error-msg').textContent = msg;
    document.title = tr('defaultTitle');
    show('error');
  }

  // ---------- rezultat ----------
  async function loadPrediction(id, fresh = false) {
    try {
      const rec = await api(`/api/p/${encodeURIComponent(id)}?ui=${ui}`);
      current = rec;
      renderPrediction(rec);
      setupShare(rec);
      show('result');
      document.title = `${rec.prediction.title || 'Nostradamus'} — Nostradamus`;
      if (fresh) notifyDone(rec.prediction.title, id);
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
    const text = c.status === 'pending' ? `${t.check.pending} ${fmtDate(c.resolveBy, lang)}` : t.check[c.status];
    return el('div', { class: `check check-${c.status}` },
      el('span', { class: 'check-label' }, el('span', { 'aria-hidden': 'true', text: `${icon} ` }), text),
      c.evidence ? el('span', { class: 'check-evidence', text: c.evidence }) : null,
      c.url ? el('a', { href: c.url, target: '_blank', rel: 'noopener noreferrer nofollow', text: `${t.source}: ${hostOf(c.url)}` }) : null);
  }

  /** Evoluția scenariului de bază pentru aceeași întrebare, plus butonul de actualizare. */
  function historyCard(rec, t, lang) {
    const rows = (rec.history || []).filter((h) => h.base).map((h) => {
      const bar = el('b');
      bar.style.width = `${h.base.probability}%`;
      const isThis = h.id === rec.id;
      return el('li', { class: isThis ? 'this' : null },
        isThis ? el('span', { class: 'h-date', text: `${fmtShort(h.createdAt, lang)} (${t.thisOne})` })
          : el('a', { class: 'h-date', href: `/p/${h.id}`, 'data-nav': true, text: fmtShort(h.createdAt, lang) }),
        el('span', { class: 'bar' }, bar),
        el('span', { class: 'pct', text: `${h.base.probability}%` }));
    });
    let refresh = null;
    if (rec.refreshable && !rec.prediction.declined) {
      refresh = el('button', { type: 'button', class: 'btn-ghost btn-compact', text: t.refresh });
      refresh.addEventListener('click', async () => {
        refresh.disabled = true;
        try {
          const { domain, horizon, region, lang: l, question, effort } = rec.request;
          if (catalog.payment?.required) {
            // Cu plată, acordul se dă în formular: îl precompletăm și ducem vizitatorul acolo.
            sessionStore.set('form', JSON.stringify({ domain, horizon, region, lang: l, question, effort, private: rec.request.private === true }));
            history.pushState({}, '', '/?refresh=1');
            route();
            restoreForm();
            $('#consent').focus();
            return;
          }
          await startPrediction({ domain, horizon, region, lang: l, question, effort, private: rec.request.private === true });
        } catch (ex) {
          toast(ex.message);
          refresh.disabled = false;
        }
      });
    }
    if (!rows.length && !refresh) return null;
    return card(rows.length ? t.history : null,
      rows.length ? el('p', { class: 'muted', text: t.historyHint }) : null,
      rows.length ? el('ul', { class: 'history' }, rows) : null,
      refresh);
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
      el('span', { class: 'tag', text: label(catalog.regions, rq.region, lang) }),
      rq.effort ? el('span', { class: 'tag', text: `${t.effort}: ${label(catalog.efforts, rq.effort, lang).toLowerCase()}` }) : null,
      rq.private ? el('span', { class: 'tag', text: `🔒 ${t.privateTag}` }) : null,
      meta.tier === 'lite' ? el('span', { class: 'tag', title: t.liteNote, text: `⚡ ${t.liteTag}` }) : null);

    if (p.declined) {
      root.append(el('section', { class: 'card declined' }, tags, el('h1', { text: t.declinedTitle }), el('p', { text: p.declined_reason || p.summary }),
        rec.refunded ? el('p', { class: 'muted', text: tr('refundedNote') }) : null));
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
          el('p', { class: 'pred-meta', text: [x.timeframe, `${t.conf1}: ${t.conf[x.confidence]}`].filter(Boolean).join(' · ') }),
          el('p', { class: 'pred-why', text: x.rationale }),
          checkBadge((rec.checks || [])[i], t, lang)));
      }))));
    }

    const hist = historyCard(rec, t, lang);
    if (hist) root.append(hist);

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

    root.append(el('p', { class: 'r-foot', text: [`${t.made} ${fmtDate(rec.createdAt, lang)}`, t.research(meta.searches || 0, meta.consulted || 0), meta.tier === 'lite' ? t.liteNote : ''].filter(Boolean).join(' · ') }));
  }

  // ---------- distribuire ----------
  function setupShare(rec) {
    const url = `${location.origin}/p/${rec.id}`;
    const text = rec.prediction.title || 'Nostradamus';
    const enc = encodeURIComponent;
    $('#share-wa').href = `https://wa.me/?text=${enc(`${text} ${url}`)}`;
    $('#share-fb').href = `https://www.facebook.com/sharer/sharer.php?u=${enc(url)}`;
    $('#share-x').href = `https://x.com/intent/post?text=${enc(text)}&url=${enc(url)}`;
    $('#share-tg').href = `https://t.me/share/url?url=${enc(url)}&text=${enc(text)}`;
    $('#share').hidden = !navigator.share;
  }

  // ---------- palmares ----------
  async function loadTrack() {
    const box = $('#track');
    const T = tr('track');
    try {
      const data = await api('/api/track-record');
      if (!data.resolved) {
        box.replaceChildren(
          el('p', { text: T.intro }),
          el('p', { class: 'muted', text: data.pending ? T.waiting(data.pending, fmtDate(data.nextCheck)) : T.none }));
        return;
      }
      const pct = Math.round((100 * data.correct) / data.resolved);
      const brier = ui === 'ro' ? String(data.brier).replace('.', ',') : String(data.brier);
      const stats = el('div', { class: 'stats' },
        el('div', { class: 'stat' }, el('strong', { text: `${pct}%` }), el('span', { text: T.correct(data.correct, data.resolved) })),
        el('div', { class: 'stat' }, el('strong', { text: brier }), el('span', { text: T.brier })),
        el('div', { class: 'stat' }, el('strong', { text: String(data.pending) }), el('span', { text: T.pending })));
      const rows = data.buckets.filter((b) => b.count).map((b) => {
        const bar = el('b');
        bar.style.width = `${b.actual}%`;
        return el('li', {}, el('span', { class: 'cal-range', text: T.said(b.range) }),
          el('span', { class: 'bar' }, bar),
          el('span', { class: 'cal-actual', text: T.happened(b.actual, b.count) }));
      });
      box.replaceChildren(stats,
        rows.length ? el('div', {}, el('h3', { text: T.calibration }), el('ul', { class: 'calibration' }, rows)) : null,
        data.recent.length ? el('div', {}, el('h3', { text: T.latest }), el('ul', { class: 'checked-list' }, data.recent.map((r) => el('li', {},
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
      $('#recent').replaceChildren(...list.map((r) => el('li', {}, el('a', { href: `/p/${r.id}`, 'data-nav': true },
        el('span', { class: 'r-title', text: r.title }),
        el('span', { class: 'r-meta', text: `${label(catalog.horizons, r.horizon)} · ${fmtShort(r.createdAt)}` })))));
      $('#recent-empty').hidden = list.length > 0;
    } catch { /* lista recentă e opțională */ }
  }

  // ---------- navigare ----------
  function route() {
    if (source) { source.close(); source = null; }
    clearInterval(timer);
    const m = /^\/p\/([A-Za-z0-9_-]{8,32})\/?$/.exec(location.pathname);
    const pay = /^\/pay\/([A-Za-z0-9_-]{16,40})\/?$/.exec(location.pathname);
    if (m) {
      follow(m[1]);
    } else if (pay) {
      confirmPayment(pay[1]);
    } else {
      if (new URLSearchParams(location.search).has('anulat')) {
        history.replaceState({}, '', '/');
        restoreForm();
        toast(tr('payCanceled'));
      }
      document.title = tr('defaultTitle');
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

  $('#ui-lang').addEventListener('click', () => {
    ui = ui === 'ro' ? 'en' : 'ro';
    store.set('ui', ui);
    $('#lang').value = ui;
    applyUi();
    buildForm();
    if (!$('#view-form').hidden) { loadTrack(); loadRecent(); document.title = tr('defaultTitle'); }
    if (!$('#view-progress').hidden) setupNotify();
  });

  $('#notify').addEventListener('click', async () => {
    const perm = await Notification.requestPermission();
    wantNotify = perm === 'granted';
    $('#notify').textContent = tr(wantNotify ? 'notifyOn' : 'notify');
    $('#notify').disabled = wantNotify;
    if (perm === 'denied') $('#notify').hidden = true;
  });

  $('#copy-link').addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText(location.href);
      toast(tr('copied'));
    } catch {
      toast(location.href);
    }
  });

  $('#share').addEventListener('click', () => {
    if (!current) return;
    navigator.share({ title: current.prediction.title, url: `${location.origin}/p/${current.id}` }).catch(() => {});
  });

  $('#print').addEventListener('click', () => window.print());

  // ---------- aplicație instalabilă (PWA) ----------
  let installPrompt = null;
  window.addEventListener('beforeinstallprompt', (e) => {
    e.preventDefault();
    installPrompt = e;
    $('#install').hidden = false;
  });
  $('#install').addEventListener('click', async () => {
    if (!installPrompt) return;
    installPrompt.prompt();
    await installPrompt.userChoice.catch(() => {});
    installPrompt = null;
    $('#install').hidden = true;
  });
  window.addEventListener('appinstalled', () => { $('#install').hidden = true; });
  if ('serviceWorker' in navigator) {
    window.addEventListener('load', () => navigator.serviceWorker.register('/sw.js').catch(() => {}));
  }

  // ---------- pornire ----------
  $('#lang').value = ui;
  applyUi();
  $('#domains').addEventListener('change', renderExamples);
  $('#efforts').addEventListener('change', renderEffortHint);
  $('#question').addEventListener('input', () => { $('#qcount').textContent = `${$('#question').value.length}/500`; });
  $('#form').addEventListener('submit', onSubmit);

  // Butonul „Statistici” din antet: în browserele care au deschis deja statisticile.
  api('/api/me').then((me) => { $('#stats').hidden = !me.admin; }).catch(() => {});

  // Butonul „Statistici” de sub câmpul de email: apare când adresa scrisă are acces la statistici.
  // Lista adreselor nu e în pagină; serverul spune doar dacă adresa scrisă e una dintre ele.
  let statsTimer = null;
  let statsAsked = '';
  $('#email').addEventListener('input', () => {
    clearTimeout(statsTimer);
    const email = $('#email').value.trim().toLowerCase();
    if (!EMAIL_RE.test(email)) { $('#stats-inline').hidden = true; return; }
    statsTimer = setTimeout(async () => {
      if (email === statsAsked) return;
      statsAsked = email;
      try {
        const r = await api('/api/admin/check', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email }) });
        if ($('#email').value.trim().toLowerCase() === email) $('#stats-inline').hidden = !r.admin;
      } catch { /* fără buton */ }
    }, 500);
  });
  $('#stats-inline').addEventListener('click', () => {
    // Formular obișnuit (POST), ca serverul să pună accesul în browser și să deschidă statisticile.
    const f = el('form', { method: 'post', action: '/admin/email-acces' }, el('input', { type: 'hidden', name: 'email', value: $('#email').value.trim() }));
    document.body.append(f);
    f.submit();
  });

  api('/api/catalog').then((c) => {
    catalog = c;
    applyUi();
    buildForm();
    route();
  }).catch(() => fail(tr('loadFail')));
})();
