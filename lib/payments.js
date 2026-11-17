'use strict';
// Plata unei previziuni prin Stripe Checkout (implicit 1 €). Modul de lucru:
//   stripe – există STRIPE_SECRET_KEY: vizitatorul plătește pe pagina Stripe înainte de previziune;
//   demo   – PAYMENT_DEMO=1 (doar pentru probe): plata e simulată, fără Stripe;
//   off    – nicio configurare: previziunile sunt gratuite (comportamentul de dinainte).

const PRICE_CENTS = Number(process.env.PRICE_EUR_CENTS || 100);
const CURRENCY = 'eur';
// Ce apare pe extrasul de card după prefixul contului Stripe (cel mult 10 caractere).
const STATEMENT_SUFFIX = 'NOSTRADAMU';

let stripe = null;
const mode = () => {
  if (process.env.STRIPE_SECRET_KEY) return 'stripe';
  return process.env.PAYMENT_DEMO === '1' ? 'demo' : 'off';
};

function client() {
  if (!stripe) {
    const lib = require('stripe');
    const Stripe = lib.default || lib;
    stripe = new Stripe(process.env.STRIPE_SECRET_KEY);
  }
  return stripe;
}

const priceLabel = () => `${(PRICE_CENTS / 100).toLocaleString('ro-RO', { minimumFractionDigits: PRICE_CENTS % 100 ? 2 : 0 })} €`;

const PRODUCT = {
  ro: { name: 'Previziune Nostradamus', description: (q) => (q ? `„${q.slice(0, 200)}”` : 'Previziune argumentată, cu probabilități și surse') },
  en: { name: 'Nostradamus forecast', description: (q) => (q ? `“${q.slice(0, 200)}”` : 'A reasoned forecast with probabilities and sources') },
};

/** Creează pagina de plată pentru comandă. Întoarce { url, session }. */
async function createCheckout(order, baseUrl) {
  if (mode() === 'demo') return { url: `${baseUrl}/pay/${order.id}?session_id=demo`, session: 'demo' };
  if (mode() !== 'stripe') throw new Error('Plățile nu sunt configurate.');
  const lang = order.ui === 'en' ? 'en' : 'ro';
  const product = PRODUCT[lang];
  const session = await client().checkout.sessions.create({
    mode: 'payment',
    locale: lang,
    client_reference_id: order.id,
    metadata: { order_id: order.id },
    payment_intent_data: {
      description: product.name,
      statement_descriptor_suffix: STATEMENT_SUFFIX,
      metadata: { order_id: order.id },
    },
    line_items: [{
      quantity: 1,
      price_data: {
        currency: CURRENCY,
        unit_amount: PRICE_CENTS,
        product_data: { name: product.name, description: product.description(order.request.question) },
      },
    }],
    success_url: `${baseUrl}/pay/${order.id}?session_id={CHECKOUT_SESSION_ID}`,
    cancel_url: `${baseUrl}/?anulat=${order.id}`,
    // Pagina de plată expiră după o oră; o comandă abandonată nu mai poate fi plătită după aceea.
    expires_at: Math.floor(Date.now() / 1000) + 3600,
  });
  return { url: session.url, session: session.id };
}

/**
 * Verifică la Stripe dacă sesiunea comenzii a fost plătită (și chiar e a ei, cu suma corectă).
 * Întoarce { paid, paymentIntent, expired }.
 */
async function checkPaid(order) {
  if (mode() === 'demo') return { paid: true, paymentIntent: null, expired: false };
  if (mode() !== 'stripe' || !order.session) return { paid: false, paymentIntent: null, expired: false };
  const s = await client().checkout.sessions.retrieve(order.session);
  const ours = s.client_reference_id === order.id && s.amount_total === PRICE_CENTS && s.currency === CURRENCY;
  return {
    paid: ours && s.payment_status === 'paid',
    paymentIntent: typeof s.payment_intent === 'string' ? s.payment_intent : s.payment_intent?.id || null,
    expired: s.status === 'expired',
  };
}

/** Returnează banii pentru o comandă plătită (de ex. când previziunea nu a putut fi făcută). */
async function refund(order) {
  if (mode() === 'demo') return { id: 'demo-refund' };
  if (mode() !== 'stripe' || !order.paymentIntent) throw new Error('Nu există o plată de returnat.');
  return client().refunds.create({ payment_intent: order.paymentIntent, metadata: { order_id: order.id } }, { idempotencyKey: `refund-${order.id}` });
}

/**
 * Validează semnătura unui webhook Stripe. Întoarce id-ul comenzii pentru evenimentele de plată
 * finalizată, sau null pentru celelalte evenimente. Aruncă eroare dacă semnătura nu e validă.
 */
function webhookOrderId(rawBody, signature) {
  const secret = process.env.STRIPE_WEBHOOK_SECRET;
  if (mode() !== 'stripe' || !secret) throw new Error('Webhook neconfigurat.');
  const event = client().webhooks.constructEvent(rawBody, signature, secret);
  if (event.type !== 'checkout.session.completed' && event.type !== 'checkout.session.async_payment_succeeded') return null;
  return event.data.object.client_reference_id || null;
}

module.exports = {
  _setClient: (c) => { stripe = c; }, // pentru teste
  mode, priceLabel, PRICE_CENTS, CURRENCY, createCheckout, checkPaid, refund, webhookOrderId };
