'use strict';
// Mesajele serverului către utilizator, în română și engleză.

const M = {
  ro: {
    pickDomain: 'Alege un domeniu.',
    pickHorizon: 'Alege perioada previziunii.',
    questionTooLong: 'Întrebarea poate avea cel mult 500 de caractere.',
    otherNeedsQuestion: 'Pentru „Alt domeniu” scrie întrebarea ta.',
    badRequest: 'Cerere invalidă.',
    internal: 'Eroare internă. Încearcă din nou.',
    notFound: 'Previziunea nu există.',
    perHour: (n, mins) => `Ai atins limita de ${n} previziuni pe oră. Mai poți cere una peste ${mins} min.`,
    tired: 'Oracolul s-a odihnit pentru azi (limita zilnică a fost atinsă). Revino mâine — previziunile deja făcute rămân disponibile.',
    queueFull: 'Sunt prea multe cereri în așteptare. Încearcă din nou în câteva minute.',
    refused: 'Oracolul a refuzat această întrebare. Încearcă o formulare diferită.',
    timeout: 'Previziunea a durat prea mult și a fost oprită. Încearcă din nou.',
    misconfigured: 'Oracolul nu este configurat corect (cheia API). Anunță administratorul.',
    overloaded: 'Oracolul este suprasolicitat acum. Încearcă din nou peste un minut.',
    unavailable: 'Serviciul de inteligență artificială nu răspunde momentan. Încearcă din nou puțin mai târziu.',
    resting: 'Oracolul este temporar indisponibil. Revino puțin mai târziu.',
    rephrase: 'Cererea nu a putut fi procesată. Reformulează întrebarea și încearcă din nou.',
    failed: 'Previziunea nu a putut fi generată. Încearcă din nou.',
    refunded: 'Plata ți-a fost returnată automat (banii revin pe card în câteva zile lucrătoare).',
    refundFailed: 'Plata va fi returnată; dacă nu o vezi pe card în câteva zile, scrie-ne.',
    orderNotFound: 'Comanda nu există.',
    paymentError: 'Pagina de plată nu a putut fi deschisă. Încearcă din nou.',
  },
  en: {
    pickDomain: 'Choose a domain.',
    pickHorizon: 'Choose the forecast period.',
    questionTooLong: 'The question can be at most 500 characters long.',
    otherNeedsQuestion: 'For “Other” please write your question.',
    badRequest: 'Invalid request.',
    internal: 'Internal error. Please try again.',
    notFound: 'This forecast does not exist.',
    perHour: (n, mins) => `You have reached the limit of ${n} forecasts per hour. You can ask again in ${mins} min.`,
    tired: 'The oracle is resting for today (the daily limit has been reached). Come back tomorrow — existing forecasts stay available.',
    queueFull: 'Too many requests are waiting. Please try again in a few minutes.',
    refused: 'The oracle declined this question. Try a different wording.',
    timeout: 'The forecast took too long and was stopped. Please try again.',
    misconfigured: 'The oracle is not configured correctly (API key). Please tell the administrator.',
    overloaded: 'The oracle is overloaded right now. Please try again in a minute.',
    unavailable: 'The AI service is not responding right now. Please try again a little later.',
    resting: 'The oracle is temporarily unavailable. Please come back a little later.',
    rephrase: 'The request could not be processed. Rephrase your question and try again.',
    failed: 'The forecast could not be generated. Please try again.',
    refunded: 'Your payment has been refunded automatically (it reaches your card within a few business days).',
    refundFailed: 'Your payment will be refunded; if you do not see it on your card within a few days, contact us.',
    orderNotFound: 'This order does not exist.',
    paymentError: 'The payment page could not be opened. Please try again.',
  },
};

/** Mesajul `key` în limba `lang` (implicit română); `args` pentru mesajele cu parametri. */
function t(key, lang, ...args) {
  const dict = M[lang === 'en' ? 'en' : 'ro'];
  const v = dict[key] ?? M.ro[key] ?? key;
  return typeof v === 'function' ? v(...args) : v;
}

module.exports = { t };
