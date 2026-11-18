'use strict';
// Emailurile către clienți: linkul previziunii după plată și anunțul de restituire. Se trimit prin SMTP
// (SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASS, MAIL_FROM din .env). Fără SMTP configurat, nu se trimite nimic.
// În teste (MAIL_CAPTURE=1) mesajele se păstrează în memorie în loc să fie trimise.

const { company } = require('./legal');

const esc = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const sent = []; // doar pentru teste
let transport = null;

const configured = () => process.env.MAIL_CAPTURE === '1' || !!(process.env.SMTP_HOST && process.env.SMTP_USER && process.env.SMTP_PASS);

function getTransport() {
  if (!transport) {
    const nodemailer = require('nodemailer');
    const port = Number(process.env.SMTP_PORT || 587);
    transport = nodemailer.createTransport({
      host: process.env.SMTP_HOST, port, secure: port === 465,
      auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS },
    });
  }
  return transport;
}

async function send({ to, subject, text, html }) {
  if (process.env.MAIL_CAPTURE === '1') { sent.push({ to, subject, text, html }); return; }
  if (!configured()) throw new Error('SMTP neconfigurat');
  await getTransport().sendMail({ from: process.env.MAIL_FROM || process.env.SMTP_USER, to, subject, text, html });
}

const T = {
  ro: {
    readySubject: (title) => `Previziunea ta Nostradamus: ${title}`,
    readyIntro: 'Îți mulțumim pentru plată. Previziunea ta este gata:',
    open: 'Deschide previziunea',
    keep: 'Păstrează acest email: linkul de mai sus este felul în care îți regăsești previziunea.',
    refundSubject: 'Nostradamus: plata ți-a fost returnată',
    refundBody: (reason) => `${reason === 'declined'
      ? 'Oracolul nu poate răspunde la întrebarea ta (de exemplu, privește o persoană privată sau un rezultat pur întâmplător).'
      : 'Din cauza unei erori tehnice, previziunea ta nu a putut fi realizată.'} Plata de ${'{price}'} ți-a fost returnată automat; banii revin pe card, de obicei, în 5–10 zile lucrătoare.`,
    question: 'Întrebarea',
    footer: (c) => `${c.name} · CUI ${c.cui} · ${c.email}`,
  },
  en: {
    readySubject: (title) => `Your Nostradamus forecast: ${title}`,
    readyIntro: 'Thank you for your payment. Your forecast is ready:',
    open: 'Open the forecast',
    keep: 'Keep this email: the link above is how you find your forecast again.',
    refundSubject: 'Nostradamus: your payment has been refunded',
    refundBody: (reason) => `${reason === 'declined'
      ? 'The oracle cannot answer your question (for example, it concerns a private person or a purely random outcome).'
      : 'Because of a technical error, your forecast could not be produced.'} Your payment of ${'{price}'} has been refunded automatically; it usually reaches your card within 5–10 business days.`,
    question: 'Question',
    footer: (c) => `${c.name} · CUI ${c.cui} · ${c.email}`,
  },
};

function layout(body, c) {
  return `<!doctype html><html><body style="margin:0;padding:24px;background:#f6f3ea;font-family:Georgia,serif;color:#1d1b2e">
<div style="max-width:560px;margin:0 auto;background:#fffdf7;border:1px solid #ddd3bb;border-radius:12px;padding:28px">
<p style="margin:0 0 18px;font-size:20px;letter-spacing:3px;color:#9a6f12"><strong>NOSTRADAMUS</strong></p>
${body}
<p style="margin:28px 0 0;font-size:12px;color:#5e5a72;font-family:Arial,sans-serif">${esc(T.ro.footer(c))}</p>
</div></body></html>`;
}

/** Linkul previziunii, după o comandă plătită și livrată. */
async function sendReady(order, rec, baseUrl) {
  const lang = order.ui === 'en' ? 'en' : 'ro';
  const t = T[lang];
  const c = company();
  const url = `${baseUrl}/p/${rec.id}`;
  const title = rec.prediction.title || 'Nostradamus';
  const q = order.request.question;
  const text = [t.readyIntro, '', title, q ? `${t.question}: ${q}` : '', '', url, '', rec.prediction.summary || '', '', t.keep, '', t.footer(c)].join('\n');
  const html = layout(`<p style="margin:0 0 12px;font-family:Arial,sans-serif">${esc(t.readyIntro)}</p>
<h1 style="font-size:22px;line-height:1.3;margin:0 0 10px">${esc(title)}</h1>
${q ? `<p style="margin:0 0 12px;color:#5e5a72;font-family:Arial,sans-serif">${esc(t.question)}: „${esc(q)}”</p>` : ''}
<p style="margin:0 0 20px;font-family:Arial,sans-serif;line-height:1.5">${esc(rec.prediction.summary || '')}</p>
<p style="margin:0 0 20px"><a href="${esc(url)}" style="display:inline-block;background:#9a6f12;color:#fffaf0;text-decoration:none;padding:12px 20px;border-radius:8px;font-family:Arial,sans-serif;font-weight:bold">${esc(t.open)}</a></p>
<p style="margin:0;font-size:13px;color:#5e5a72;font-family:Arial,sans-serif">${esc(t.keep)}<br><a href="${esc(url)}" style="color:#9a6f12">${esc(url)}</a></p>`, c);
  await send({ to: order.email, subject: t.readySubject(title), text, html });
}

/** Anunțul că plata a fost returnată (eroare sau întrebare refuzată). */
async function sendRefund(order, price) {
  const lang = order.ui === 'en' ? 'en' : 'ro';
  const t = T[lang];
  const c = company();
  const body = t.refundBody(order.refundReason).replace('{price}', price);
  const q = order.request.question;
  const text = [body, q ? `\n${t.question}: ${q}` : '', '', t.footer(c)].join('\n');
  const html = layout(`<p style="margin:0 0 12px;font-family:Arial,sans-serif;line-height:1.5">${esc(body)}</p>
${q ? `<p style="margin:0;color:#5e5a72;font-family:Arial,sans-serif">${esc(t.question)}: „${esc(q)}”</p>` : ''}`, c);
  await send({ to: order.email, subject: t.refundSubject, text, html });
}

/** Verifică legătura cu serverul SMTP (fără să trimită nimic). */
const verify = () => getTransport().verify();

/** Linkul de acces la statistici, pentru adresele de administrator. */
async function sendAdminLink(email, url, minutes) {
  const c = company();
  const text = `Linkul tău de acces la statisticile Nostradamus (valabil ${minutes} de minute, o singură dată):\n\n${url}\n\nDacă nu tu l-ai cerut, ignoră acest email.`;
  const html = layout(`<p style="margin:0 0 16px;font-family:Arial,sans-serif">Linkul tău de acces la statisticile Nostradamus. E valabil ${minutes} de minute și poate fi folosit o singură dată.</p>
<p style="margin:0 0 20px"><a href="${esc(url)}" style="display:inline-block;background:#9a6f12;color:#fffaf0;text-decoration:none;padding:12px 20px;border-radius:8px;font-family:Arial,sans-serif;font-weight:bold">Deschide statisticile</a></p>
<p style="margin:0;font-size:13px;color:#5e5a72;font-family:Arial,sans-serif">Dacă nu tu l-ai cerut, ignoră acest email.</p>`, c);
  await send({ to: email, subject: 'Nostradamus: linkul de acces la statistici', text, html });
}

module.exports = { configured, sendReady, sendRefund, sendAdminLink, verify, _sent: sent };
