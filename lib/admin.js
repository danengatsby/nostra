'use strict';
// Pagina de statistici / administrare (/admin): bugetul de azi, istoricul costurilor, plățile, întrebările,
// ultimele previziuni și erorile. Acces: contul de administrare (ADMIN_USER + parola, formular sau HTTP Basic)
// sau cookie primit prin linkul de pe email (ADMIN_EMAILS).

const crypto = require('node:crypto');
const store = require('./store');
const cost = require('./cost');
const events = require('./events');
const verify = require('./verify');
const orders = require('./orders');
const { DOMAIN, HORIZON } = require('./catalog');
const adminauth = require('./adminauth');

const esc = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const usd = (n) => `$${(Number(n) || 0).toFixed(2)}`;
const hash = (s) => crypto.createHash('sha256').update(String(s)).digest();

/** Lasă să treacă cererile cu sesiune validă (cont sau link pe email); altfel arată pagina de acces. */
function auth(req, res, next) {
  if (!adminauth.accountConfigured() && !process.env.ADMIN_EMAILS) return res.status(404).end();
  if (adminauth.sessionEmail(req)) return next();
  const m = /^Basic (.+)$/.exec(req.get('authorization') || '');
  if (m) {
    const decoded = Buffer.from(m[1], 'base64').toString();
    const sep = decoded.indexOf(':');
    const key = adminauth.ipKey(req);
    if (!adminauth.passwordAllowed(key)) return loginPage(res.status(429), '', 'Prea multe încercări.');
    if (sep > 0 && adminauth.credentialsOk(decoded.slice(0, sep), decoded.slice(sep + 1))) return next();
    adminauth.passwordFailed(key);
  }
  res.status(401);
  loginPage(res);
}

/** Pagina de acces: contul (utilizator + parolă) și, fără parolă, linkul pe email. */
function loginPage(res, notice = '', error = '') {
  res.set({ 'Cache-Control': 'no-store', 'X-Robots-Tag': 'noindex' }).type('html').send(`<!doctype html>
<html lang="ro"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow"><title>Statistici — Nostradamus</title>
<link rel="icon" href="/icon.svg" type="image/svg+xml"><link rel="stylesheet" href="/admin.css"></head>
<body><main class="login">
<h1>Statistici Nostradamus</h1>
${notice ? `<p class="notice">${esc(notice)}</p>` : ''}${error ? `<p class="error">${esc(error)}</p>` : ''}
${adminauth.accountConfigured() ? `<form method="post" action="/admin/parola" class="box">
  <label>Utilizator<input name="user" required autocomplete="username" autocapitalize="none" spellcheck="false" maxlength="100"></label>
  <label>Parola<input type="password" name="password" required autocomplete="current-password" maxlength="200"></label>
  <button type="submit">Intră</button>
  <p class="muted">Browserul acesta rămâne conectat 180 de zile (până la „Ieșire”).</p>
</form>` : ''}
${process.env.ADMIN_EMAILS ? `<details class="box"${adminauth.accountConfigured() ? '' : ' open'}><summary>Fără parolă: primește un link pe email</summary>
<form method="post" action="/admin/link">
  <label>Adresa ta de email<input type="email" name="email" required autocomplete="email" maxlength="254"></label>
  <button type="submit">Trimite-mi linkul de acces</button>
  <p class="muted">Primești pe email un link valabil ${adminauth.LINK_MINUTES} de minute. După ce îl deschizi, browserul acesta rămâne recunoscut 180 de zile.</p>
</form></details>` : ''}
<p><a href="/">← Înapoi la site</a></p>
</main></body></html>`);
}

function table(head, rows, empty = 'Nimic încă.') {
  if (!rows.length) return `<p class="muted">${empty}</p>`;
  return `<div class="scroll"><table><thead><tr>${head.map((h) => `<th>${h}</th>`).join('')}</tr></thead><tbody>${
    rows.map((r) => `<tr>${r.map((c) => `<td>${c}</td>`).join('')}</tr>`).join('')}</tbody></table></div>`;
}

const fmt = (iso) => new Date(iso).toLocaleString('ro-RO', { timeZone: 'Europe/Bucharest', day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });

function render() {
  const st = cost.status();
  const recs = store.all().map((s) => store.get(s.id)).filter(Boolean);
  const totalCost = recs.reduce((a, r) => a + (r.meta?.costUsd ?? cost.costUsd(r.meta?.usage, r.meta?.model)), 0);
  const durations = recs.map((r) => r.meta?.durationMs).filter(Boolean);
  const avgSec = durations.length ? Math.round(durations.reduce((a, b) => a + b, 0) / durations.length / 1000) : 0;
  const count = (fn) => Object.entries(recs.reduce((m, r) => { const k = fn(r); m[k] = (m[k] || 0) + 1; return m; }, {})).sort((a, b) => b[1] - a[1]);
  const tr = verify.trackRecord();
  const errors = events.recent(30, 'error');
  const pay = orders.summary();
  const metrics = require('./operations').today();
  const cohort = pay.checkoutToday;
  const percentage = cohort.total ? Math.round(100 * cohort.paid / cohort.total) + '%' : '–';
  const STATUS = { pending: 'în așteptare', paid: 'plătită, în lucru', done: 'generată', email_pending: 'email în așteptare', delivery_failed: 'livrare eșuată', delivered: 'trimisă prin email', refund_pending: 'restituire în curs', refunded: 'restituită', refund_failed: 'RESTITUIRE EȘUATĂ', expired: 'expirată' };
  const eur = (n) => `${n.toFixed(2).replace('.', ',')} €`;
  const days = [{ date: `${st.date} (azi)`, spentUsd: st.spentUsd, verifySpentUsd: st.verifySpentUsd, fallbackSpentUsd: st.fallbackSpentUsd, predictions: st.predictions, verifications: st.verifications, fallbacks: st.fallbacks },
    ...[...(st.history || [])].reverse().slice(0, 30)];

  return `<!doctype html>
<html lang="ro"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow"><title>Administrare — Nostradamus</title>
<link rel="icon" href="/icon.svg" type="image/svg+xml"><link rel="stylesheet" href="/admin.css"></head>
<body><main>
<p class="top"><a href="/">← Site</a> · <a href="/admin/iesire">Ieșire</a></p>
<h1>Nostradamus — statistici</h1>

<section class="tiles">
  <div class="tile"><strong>${usd(st.spentUsd)}</strong><span>cheltuit azi din ${st.budgetUsd ? usd(st.budgetUsd) : 'fără limită'}</span></div>
  <div class="tile"><strong>${st.predictions}</strong><span>previziuni noi azi</span></div>
  <div class="tile"><strong>${st.verifications}</strong><span>verificări azi (${usd(st.verifySpentUsd)})</span></div>
  <div class="tile"><strong>${st.fallbacks || 0}</strong><span>cu modelul rapid azi (${usd(st.fallbackSpentUsd)} din ${usd(st.fallbackBudgetUsd)})</span></div>
  <div class="tile"><strong>${usd(st.estimateUsd)}</strong><span>cost mediu al unei previziuni</span></div>
  <div class="tile"><strong>${recs.length}</strong><span>previziuni în total (${usd(totalCost)})</span></div>
  <div class="tile"><strong>${avgSec ? `${Math.floor(avgSec / 60)}:${String(avgSec % 60).padStart(2, '0')}` : '–'}</strong><span>durată medie</span></div>
  <div class="tile"><strong>${tr.resolved ? `${Math.round((100 * tr.correct) / tr.resolved)}%` : '–'}</strong><span>corecte (${tr.correct}/${tr.resolved}), ${tr.pending} în așteptare</span></div>
</section>
<p class="muted">Ziua de buget este ziua UTC: se resetează la 00:00 UTC (02:00 iarna, 03:00 vara, ora României). Când bugetul principal (<code>DAILY_BUDGET_USD</code>) se epuizează, oracolul continuă cu modelul rapid, din bugetul <code>FALLBACK_DAILY_USD</code>. Previziunile plătite folosesc mereu modelul principal.</p>

<h2>Conversie azi (UTC)</h2>
<p>Afișări gratuite solicitate: ${metrics.screen || 0} · Plăți inițiate: ${metrics.checkout || 0} · Plăți confirmate: ${metrics.paid || 0} · Emailuri trimise: ${metrics.delivered || 0}</p>
<p>Din cele ${cohort.total} comenzi inițiate azi, ${cohort.paid} au o plată confirmată (${percentage}).</p>
<h2>De la formular la raport · ultimele 30 de zile UTC</h2>
<p>Proporția vizitelor pe formular în care s-a afișat raportul cerut. Fiecare vizită contează o singură dată. Categoria de ecran este cea de la deschiderea formularului.</p>
${table(['Ecran', 'Email pentru lectură', 'Vizite', 'Rapoarte afișate', 'Conversie'], require('./operations').formConversion().map(row => [
    row.device === 'mobile' ? 'Mobil (≤ 640 px)' : 'Desktop (> 640 px)', row.email_required ? 'Obligatoriu' : 'Fără câmp',
    row.visits, row.reports, (100 * row.reports / row.visits).toLocaleString('ro-RO', { maximumFractionDigits: 1 }) + '%',
  ]), 'Încă nu s-au înregistrat vizite pe formular.')}
<h2>Plăți</h2>
${pay.emailsFailed ? '<p role="alert">Livrări sau notificări eșuate. Verifică comenzile și jurnalul SMTP.</p>' : ''}
${pay.mode === 'off'
    ? '<p class="muted">Plățile sunt oprite: previziunile sunt gratuite. Se activează cu <code>STRIPE_SECRET_KEY</code> în <code>.env</code>.</p>'
    : `<section class="tiles">
  <div class="tile"><strong>${eur(pay.revenueEur)}</strong><span>încasări nete (${pay.price} / previziune${pay.mode === 'demo' ? ', DEMO' : ''})</span></div>
  <div class="tile"><strong>${pay.paid}</strong><span>comenzi plătite</span></div>
  <div class="tile"><strong>${pay.refunded}</strong><span>restituite automat</span></div>
  <div class="tile"><strong>${pay.pending}</strong><span>în așteptarea plății</span></div>
  ${pay.refundFailed ? `<div class="tile"><strong>${pay.refundFailed}</strong><span>restituiri nefinalizate — reîncercare automată, cel mult 5 încercări</span></div>` : ''}
</section>
${pay.refundNeedsAttention ? `<p class="notice" role="alert"><strong>${pay.refundNeedsAttention} restituiri necesită intervenție în Stripe.</strong> Cele 5 încercări automate s-au epuizat. Verifică plata și restituirile existente înainte de a interveni.</p>` : ''}
${table(['Când', 'Stare', 'Întrebare', 'Previziune', 'Motiv restituire'],
      pay.recent.map((o) => [
        fmt(o.createdAt), esc(STATUS[o.status === 'done' ? orders.deliveryStatus(o) : o.status] || o.status),
        esc(o.request.question || `(${DOMAIN[o.request.domain]?.ro || o.request.domain})`),
        o.predictionId ? `<a href="/p/${esc(o.predictionId)}">${esc(o.predictionId)}</a>` : '',
        esc({ failed: 'eroare', declined: 'întrebare refuzată', delivery_failed: 'email netrimis' }[o.refundReason] || ''),
      ]), 'Nicio comandă încă.')}`}

<h2>Costuri pe zile</h2>
${table(['Ziua', 'Buget principal', 'Din care verificări', 'Model rapid', 'Previziuni', 'Cu modelul rapid', 'Verificări'],
    days.map((d) => [esc(d.date), usd(d.spentUsd), usd(d.verifySpentUsd), usd(d.fallbackSpentUsd), d.predictions, d.fallbacks || 0, d.verifications]))}

<div class="cols">
<section><h2>Domenii</h2>${table(['Domeniu', 'Previziuni'], count((r) => DOMAIN[r.request.domain]?.ro || r.request.domain).map(([k, v]) => [esc(k), v]))}</section>
<section><h2>Perioade</h2>${table(['Perioada', 'Previziuni'], count((r) => HORIZON[r.request.horizon]?.ro || r.request.horizon).map(([k, v]) => [esc(k), v]))}</section>
</div>

<h2>Ultimele previziuni</h2>
${table(['Când', 'Titlu / întrebare', 'Domeniu', 'Limba', 'Efort', 'Cost', 'Durată', 'Căutări'],
    recs.slice(0, 40).map((r) => [
      fmt(r.createdAt),
      `<a href="/p/${esc(r.id)}">${esc(r.prediction.title || '(refuzată)')}</a>${r.request.private ? ' <span class="tag">privată</span>' : ''}${r.request.question ? `<div class="muted">„${esc(r.request.question)}”</div>` : ''}`,
      `${esc(DOMAIN[r.request.domain]?.ro)} · ${esc(HORIZON[r.request.horizon]?.ro)}`,
      esc(r.request.lang),
      `${esc(r.meta?.effort || 'high')}${r.meta?.tier === 'lite' ? ' · rapid' : ''}`, // cele dinainte de 18.11.2026: „high”
      usd(r.meta?.costUsd ?? cost.costUsd(r.meta?.usage, r.meta?.model)),
      r.meta?.durationMs ? `${Math.round(r.meta.durationMs / 1000)}s` : '–',
      r.meta?.searches ?? '–',
    ]))}

<h2>Erori recente</h2>
${table(['Când', 'Unde', 'Cod', 'Mesaj', 'Cost'],
    errors.map((e) => [fmt(e.at), esc(e.where), esc(e.status ?? ''), esc(e.message) + (e.question ? `<div class="muted">„${esc(e.question)}”</div>` : ''), e.costUsd ? usd(e.costUsd) : '']),
    'Nicio eroare.')}
</main></body></html>`;
}

function page(req, res) {
  res.set({ 'Cache-Control': 'no-store', 'X-Robots-Tag': 'noindex' }).type('html').send(render());
}

module.exports = { auth, page, loginPage };
