'use strict';
// Pagina „Termeni și confidențialitate” (/termeni), în română și engleză. Datele firmei vin din .env
// (COMPANY_NAME, COMPANY_CUI, CONTACT_EMAIL), iar prețul din configurarea plăților.
// Textul e un model de bază: trebuie verificat de un jurist înainte de a fi considerat final.

const payments = require('./payments');

const esc = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const VERSION = '2026-11-18b'; // se salvează în comandă, ca dovadă a variantei acceptate

function company() {
  return {
    name: process.env.COMPANY_NAME || '[denumirea firmei]',
    cui: process.env.COMPANY_CUI || '[CUI]',
    email: process.env.CONTACT_EMAIL || '[email de contact]',
  };
}

function ro(c, price, paid) {
  const mail = `<a href="mailto:${esc(c.email)}">${esc(c.email)}</a>`;
  return `
<h1>Termeni și confidențialitate</h1>
<p class="muted">Ultima actualizare: 18 noiembrie 2026</p>

<h2>Cine furnizează serviciul</h2>
<p>Nostradamus (nostradamus.my) este furnizat de <strong>${esc(c.name)}</strong>, CUI ${esc(c.cui)}. Contact: ${mail}.</p>

<h2>Ce primești</h2>
<p>Pentru întrebarea, domeniul, perioada și regiunea alese, oracolul caută informații actuale pe internet și generează automat, cu inteligență artificială, o previziune: scenarii cu probabilități, afirmații verificabile, factori-cheie și sursele consultate. ${paid
    ? `Fiecare previziune costă <strong>${esc(price)}</strong> (plată unică, fără abonament). Previziunea pornește după confirmarea plății, apare pe ecran în câteva minute și primești linkul ei pe adresa de email pe care o scrii în formular.`
    : 'Previziunile sunt gratuite.'}</p>

<h2>Natura serviciului</h2>
<p>Previziunile sunt <strong>estimări probabilistice generate automat</strong> din surse publice găsite la momentul cererii. Pot conține erori sau informații depășite și nu sunt certitudini. Nu reprezintă consultanță financiară, de investiții, medicală, psihologică sau juridică; nu lua hotărâri importante exclusiv pe baza lor. Oracolul refuză întrebările despre persoane private, despre decesul sau sănătatea cuiva, numerele la loterie și orice ar putea face rău.</p>

${paid ? `<h2>Plata, livrarea și dreptul de retragere</h2>
<p>Plata este procesată de Stripe; noi nu vedem și nu stocăm datele cardului. Previziunea este <strong>conținut digital furnizat imediat</strong> după plată. Prin bifa din formular, înainte de plată, ceri începerea imediată a serviciului și iei la cunoștință că, odată furnizat conținutul, pierzi dreptul de retragere din contract (OUG 34/2014, art. 16 lit. m).</p>
<p><strong>Restituire automată:</strong> dacă previziunea nu poate fi realizată (eroare tehnică) sau oracolul refuză întrebarea, banii îți sunt returnați automat pe card, de obicei în 5–10 zile lucrătoare. Pentru orice altă problemă cu o comandă, scrie-ne la ${mail}.</p>` : ''}

<h2>Previziuni publice și private</h2>
<p>Previziunile apar în lista „Previziuni recente” de pe site și pot fi găsite de motoarele de căutare, cu întrebarea ta cu tot. Dacă bifezi <strong>„Previziune privată”</strong>, previziunea nu apare în listă și nu este indexată; o poate vedea doar cine are linkul. <strong>Nu include în întrebare date personale</strong> (nume, adrese, date de contact) despre tine sau despre alții.</p>

<h2>Datele tale</h2>
<p>Prelucrăm doar ce e necesar pentru serviciu:</p>
<ul>
  <li><strong>întrebarea și opțiunile alese</strong> — pentru a genera previziunea; sunt trimise furnizorului de inteligență artificială Anthropic (SUA), care le prelucrează în numele nostru;</li>
  ${paid ? '<li><strong>adresa de email</strong> scrisă în formular (o transmitem și către Stripe, pentru plată) — pentru confirmarea plății, trimiterea linkului previziunii și, dacă e cazul, anunțul de restituire; emailurile pleacă prin Google (Gmail);</li>' : ''}
  <li><strong>adresa IP</strong> — doar sub formă de amprentă criptografică, ținută în memorie cel mult o oră, pentru limita de cereri pe oră; nu o salvăm.</li>
</ul>
<p>Temeiul legal este executarea contractului și interesul nostru legitim de a preveni abuzurile (art. 6 alin. 1 lit. b și f din GDPR). Nu vindem datele și nu le folosim pentru publicitate.</p>
<p>Previziunile rămân pe site cât timp serviciul funcționează, ca linkurile să rămână valabile. ${paid ? 'Comenzile (data, starea plății, adresa de email, întrebarea) se păstrează cât este necesar pentru evidența contabilă și pentru eventuale reclamații.' : ''} Poți cere oricând accesul la date, rectificarea sau ștergerea lor (inclusiv ștergerea unei previziuni făcute de tine) la ${mail}. Ai dreptul să depui plângere la Autoritatea Națională de Supraveghere a Prelucrării Datelor cu Caracter Personal (<a href="https://www.dataprotection.ro/" rel="noopener">dataprotection.ro</a>).</p>
<p>Aplicația salvează în browserul tău (stocare locală) limba aleasă și, pe durata plății, datele din formular. Nu folosim cookie-uri de urmărire. Pagina de plată Stripe are propriile reguli de confidențialitate.</p>

<h2>Reclamații și soluționarea litigiilor</h2>
<p>Pentru orice reclamație scrie-ne la ${mail}; răspundem în cel mult 15 zile. Te poți adresa și Autorității Naționale pentru Protecția Consumatorilor (<a href="https://anpc.ro/" rel="noopener">anpc.ro</a>) sau procedurii de soluționare alternativă a litigiilor (<a href="https://anpc.ro/ce-este-sal/" rel="noopener">ANPC – SAL</a>).</p>`;
}

function en(c, price, paid) {
  const mail = `<a href="mailto:${esc(c.email)}">${esc(c.email)}</a>`;
  return `
<h1 id="en">Terms and privacy</h1>
<p class="muted">Last updated: 18 November 2026. The Romanian version above prevails.</p>

<h2>Who provides the service</h2>
<p>Nostradamus (nostradamus.my) is provided by <strong>${esc(c.name)}</strong>, Romanian company registration number (CUI) ${esc(c.cui)}. Contact: ${mail}.</p>

<h2>What you receive</h2>
<p>For the question, domain, period and region you choose, the oracle searches the web for current information and generates a forecast automatically with artificial intelligence: scenarios with probabilities, verifiable claims, key drivers and the sources consulted. ${paid
    ? `Each forecast costs <strong>${esc(price)}</strong> (a one-off payment, no subscription). The forecast starts once the payment is confirmed, appears on screen within a few minutes, and its link is sent to the email address you enter in the form.`
    : 'Forecasts are free.'}</p>

<h2>Nature of the service</h2>
<p>Forecasts are <strong>automatically generated probabilistic estimates</strong> based on public sources found at the time of the request. They may contain errors or outdated information and are not certainties. They are not financial, investment, medical, psychological or legal advice. The oracle declines questions about private individuals, anyone's death or health, lottery numbers and anything that could cause harm.</p>

${paid ? `<h2>Payment, delivery and right of withdrawal</h2>
<p>Payments are processed by Stripe; we never see or store your card details. A forecast is <strong>digital content supplied immediately</strong> after payment. By ticking the box before paying, you request immediate performance and acknowledge that you lose your right of withdrawal once the content has been supplied.</p>
<p><strong>Automatic refund:</strong> if the forecast cannot be produced (technical error) or the oracle declines the question, you are refunded automatically, usually within 5–10 business days. For any other issue with an order, write to ${mail}.</p>` : ''}

<h2>Public and private forecasts</h2>
<p>Forecasts appear in the “Recent forecasts” list and may be indexed by search engines, including your question. If you tick <strong>“Private forecast”</strong>, it is not listed or indexed; only people with the link can see it. <strong>Do not include personal data</strong> about yourself or others in your question.</p>

<h2>Your data</h2>
<p>We process your question and chosen options to generate the forecast (sent to our AI provider Anthropic, USA, which processes them on our behalf)${paid ? ', the email address you enter in the form (also passed to Stripe for the payment) to confirm the payment and send you the forecast link (emails are sent via Google Gmail)' : ''}, and your IP address only as a cryptographic fingerprint kept in memory for at most one hour for rate limiting. Legal basis: performance of the contract and our legitimate interest in preventing abuse (GDPR art. 6(1)(b) and (f)). We do not sell data or use it for advertising. You can request access, correction or deletion at any time at ${mail}, and you may complain to the Romanian data protection authority (dataprotection.ro). The app stores your language choice and, during payment, the form data in your browser; we use no tracking cookies.</p>

<h2>Complaints</h2>
<p>Write to ${mail}; we reply within 15 days. You may also contact the Romanian consumer protection authority (<a href="https://anpc.ro/" rel="noopener">anpc.ro</a>).</p>`;
}

function render() {
  const c = company();
  const paid = payments.mode() !== 'off';
  const price = payments.priceLabel();
  return `<!doctype html>
<html lang="ro"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Termeni și confidențialitate — Nostradamus</title>
<meta name="description" content="Termenii de utilizare și politica de confidențialitate Nostradamus.">
<link rel="icon" href="/icon.svg" type="image/svg+xml"><link rel="stylesheet" href="/style.css">
</head><body>
<main class="legal">
  <p><a href="/">← Nostradamus</a> · <a href="#en">English</a></p>
  <article class="card">${ro(c, price, paid)}</article>
  <article class="card">${en(c, price, paid)}</article>
</main>
</body></html>`;
}

module.exports = { render, VERSION, company };
