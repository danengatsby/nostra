'use strict';
// Pagina „Termeni și confidențialitate” (/termeni), în română și engleză. Datele firmei vin din .env
// (COMPANY_NAME, COMPANY_CUI, CONTACT_EMAIL), iar prețul din configurarea plăților.
// Textul e un model de bază: trebuie verificat de un jurist înainte de a fi considerat final.

const payments = require('./payments');
const { screenEmailRequired } = require('./catalog');

const esc = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const VERSION = '2026-11-19'; // se salvează în comandă, ca dovadă a variantei acceptate

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
<p class="muted">Ultima actualizare: 19 noiembrie 2026</p>

<h2>Cine furnizează serviciul</h2>
<p>Nostradamus (nostradamus.my) este furnizat de <strong>${esc(c.name)}</strong>, CUI ${esc(c.cui)}. Contact: ${mail}.</p>

<h2>Ce primești</h2>
<p>Pentru întrebarea, domeniul, perioada și regiunea alese, oracolul caută informații actuale pe internet și generează automat, cu inteligență artificială, o previziune: scenarii cu probabilități, afirmații verificabile, factori-cheie și sursele consultate. ${paid
    ? `Poți citi raportul complet <strong>gratuit pe ecran, fără cont</strong>, în limitele de utilizare și buget afișate la cerere. Opțional, trimiterea linkului pe email costă <strong>${esc(price)}</strong> (plată unică, fără abonament). Dacă alegi direct opțiunea plătită, generarea începe după confirmarea plății. Dacă ai citit deja rezultatul gratuit, trimitem linkul aceleiași previziuni, fără o nouă generare.`
    : 'Previziunile se citesc gratuit pe ecran, fără cont, în limitele de utilizare și buget ale serviciului.'}</p>

<h2>Natura serviciului</h2>
<p>Previziunile sunt <strong>estimări probabilistice generate automat</strong> din surse publice găsite la momentul cererii. Pot conține erori sau informații depășite și nu sunt certitudini. Nu reprezintă consultanță financiară, de investiții, medicală, psihologică sau juridică; nu lua hotărâri importante exclusiv pe baza lor. Oracolul refuză întrebările despre persoane private, despre decesul sau sănătatea cuiva, numerele la loterie și orice ar putea face rău.</p>

${paid ? `<h2>Plata, livrarea și dreptul de retragere</h2>
<p>Plata este procesată de Stripe; noi nu vedem și nu stocăm datele cardului. Lectura pe ecran este gratuită și nu cere acord de livrare. Pentru opțiunea plătită, linkul previziunii este <strong>trimis pe email după confirmarea plății</strong>. Prin bifa din formular, înainte de plată, ceri începerea imediată a serviciului și iei la cunoștință că, odată furnizat conținutul, pierzi dreptul de retragere din contract (OUG 34/2014, art. 16 lit. m).</p>
<p><strong>Restituire automată:</strong> dacă previziunea nu poate fi realizată (eroare tehnică) sau oracolul refuză întrebarea, banii îți sunt returnați automat pe card, de obicei în 5–10 zile lucrătoare. Pentru orice altă problemă cu o comandă, scrie-ne la ${mail}.</p>` : ''}

<h2>Previziuni publice și private</h2>
<p>Bifa „Previziune privată” este selectată inițial. Oricine are linkul poate vedea întrebarea și raportul. Dacă debifezi „Previziune privată”, acestea pot apărea în lista publică și în motoarele de căutare. <strong>Nu include în întrebare date personale</strong> (nume, adrese, date de contact) despre tine sau despre alții.</p>

<h2>Datele tale</h2>
<p>${screenEmailRequired() ? 'Lectura gratuită cere o adresă de email pentru validare.' : 'Lectura gratuită este disponibilă fără adresă de email.'} Pentru lectura gratuită, adresa nu este salvată pe server, publicată în previziune sau trimisă furnizorului AI. Trimiterea pe email rămâne o opțiune plătită separată.</p>
<p>Măsurăm câte vizite pe formular duc la afișarea raportului. Păstrăm timp de 30 de zile un identificator aleator al vizitei, ziua, categoria de ecran și varianta formularului, fără email sau textul întrebării.</p>
<p>Prelucrăm doar ce e necesar pentru serviciu:</p>
<ul>
  <li><strong>întrebarea și opțiunile alese</strong> — pentru a genera previziunea; sunt trimise furnizorului de inteligență artificială Anthropic (SUA), care le prelucrează în numele nostru;</li>
  ${paid ? '<li><strong>adresa de email</strong> scrisă în formular (o transmitem și către Stripe, pentru plată) — numai când alegi trimiterea plătită pe email: pentru confirmarea plății, trimiterea linkului previziunii și, dacă e cazul, anunțul de restituire; emailurile pleacă prin Google (Gmail);</li>' : ''}
  <li><strong>adresa IP</strong> — doar sub formă de amprentă criptografică, ținută în memorie cel mult o oră, pentru limita de cereri pe oră; nu o salvăm.</li>
</ul>
<p>Temeiul legal este executarea contractului și interesul nostru legitim de a preveni abuzurile (art. 6 alin. 1 lit. b și f din GDPR). Nu vindem datele și nu le folosim pentru publicitate.</p>
<p>Previziunile rămân pe site cât timp serviciul funcționează, ca linkurile să rămână valabile. ${paid ? 'Comenzile (data, starea plății, adresa de email, întrebarea) se păstrează cât este necesar pentru evidența contabilă și pentru eventuale reclamații.' : ''} Poți cere oricând accesul la date, rectificarea sau ștergerea lor (inclusiv ștergerea unei previziuni făcute de tine) la ${mail}. Ai dreptul să depui plângere la Autoritatea Națională de Supraveghere a Prelucrării Datelor cu Caracter Personal (<a href="https://www.dataprotection.ro/" rel="noopener">dataprotection.ro</a>).</p>
<p>Aplicația salvează în browserul tău (stocare locală) limba aleasă și, pe durata plății, datele din formular. Nu folosim cookie-uri de urmărire. Pagina de plată Stripe are propriile reguli de confidențialitate.</p>
<p>Pentru previziunile private folosim un cookie funcțional de sesiune, care împiedică reutilizarea rezultatelor între vizitatori. Linkul unei previziuni private poate fi deschis în continuare de oricine îl primește.</p>
<p>Istoricul consultărilor și întrebările urmărite sunt păstrate local în acest browser, fără sincronizare între dispozitive. Poți elimina fiecare intrare din secțiunea „Istoricul meu”. Ciorna formularului este salvată pe durata filei, inclusiv înainte de plată; acordul cu termenii trebuie bifat din nou pentru o comandă nouă.</p>

<h2>Reclamații și soluționarea litigiilor</h2>
<p>Pentru orice reclamație scrie-ne la ${mail}; răspundem în cel mult 15 zile. Te poți adresa și Autorității Naționale pentru Protecția Consumatorilor (<a href="https://anpc.ro/" rel="noopener">anpc.ro</a>) sau procedurii de soluționare alternativă a litigiilor (<a href="https://anpc.ro/ce-este-sal/" rel="noopener">ANPC – SAL</a>).</p>`;
}

function en(c, price, paid) {
  const mail = `<a href="mailto:${esc(c.email)}">${esc(c.email)}</a>`;
  return `
<h1 id="en">Terms and privacy</h1>
<p class="muted">Last updated: 19 November 2026. The Romanian version above prevails.</p>

<h2>Who provides the service</h2>
<p>Nostradamus (nostradamus.my) is provided by <strong>${esc(c.name)}</strong>, Romanian company registration number (CUI) ${esc(c.cui)}. Contact: ${mail}.</p>

<h2>What you receive</h2>
<p>For the question, domain, period and region you choose, the oracle searches the web for current information and generates a forecast automatically with artificial intelligence: scenarios with probabilities, verifiable claims, key drivers and the sources consulted. ${paid
    ? `You can read the complete report <strong>on screen for free, without an account</strong>, within the service’s usage and budget limits. Optional email delivery of its link costs <strong>${esc(price)}</strong> (a one-off payment, no subscription). If you choose paid delivery directly, generation starts after payment confirmation. If you have already read a free forecast, we send the link to that same result without generating a new one.`
    : 'Forecasts can be read on screen for free, without an account, within the service’s usage and budget limits.'}</p>

<h2>Nature of the service</h2>
<p>Forecasts are <strong>automatically generated probabilistic estimates</strong> based on public sources found at the time of the request. They may contain errors or outdated information and are not certainties. They are not financial, investment, medical, psychological or legal advice. The oracle declines questions about private individuals, anyone's death or health, lottery numbers and anything that could cause harm.</p>

${paid ? `<h2>Payment, delivery and right of withdrawal</h2>
<p>Payments are processed by Stripe; we never see or store your card details. Reading on screen is free and does not require delivery consent. For the paid option, the forecast link is <strong>emailed after payment confirmation</strong>. By ticking the box before paying, you request immediate performance and acknowledge that you lose your right of withdrawal once the content has been supplied.</p>
<p><strong>Automatic refund:</strong> if the forecast cannot be produced (technical error) or the oracle declines the question, you are refunded automatically, usually within 5–10 business days. For any other issue with an order, write to ${mail}.</p>` : ''}

<h2>Public and private forecasts</h2>
<p>The “Private forecast” box is checked by default. Anyone who has that link can read your question and forecast. Unchecking “Private forecast” makes them available in the public list and to search engines. <strong>Do not include personal data</strong> about yourself or others in your question.</p>

<h2>Your data</h2>
<p>${screenEmailRequired() ? 'Free viewing requires an email address for validation.' : 'Free viewing is available without an email address.'} For free viewing, the address is not stored on the server, published with the forecast or sent to the AI provider. Email delivery remains a separate paid option.</p>
<p>To measure form visits that lead to a displayed report, we keep a random visit ID, day, screen category and form variant for 30 days, without the email address or question.</p>
<p>Private forecasts use a functional session cookie to prevent results from being reused across visitors. Anyone who receives a private forecast link can still open it.</p>
<p>Your consultation history and followed questions are stored locally in this browser, without syncing across devices. You can remove each entry from “My history”. Form drafts are saved for the lifetime of the tab, including before payment; consent must be given again for each new order.</p>
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
