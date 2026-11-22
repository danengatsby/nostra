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
    ...(order.email ? { customer_email: order.email } : {}),
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
        product_data: { name: order.deliveryPredictionId ? (lang === 'en' ? 'Nostradamus forecast — email delivery' : 'Previziune Nostradamus — trimitere pe email') : product.name, description: product.description(order.request.private ? null : order.request.question) },
      },
    }],
    success_url: `${baseUrl}/pay/${order.id}?session_id={CHECKOUT_SESSION_ID}`,
    cancel_url: `${baseUrl}${order.deliveryPredictionId ? `/p/${order.deliveryPredictionId}` : '/'}?anulat=${order.id}`,
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
  if (mode() === 'demo') return { paid: true, paymentIntent: null, expired: false, email: process.env.PAYMENT_DEMO_EMAIL || null };
  if (mode() !== 'stripe' || !order.session) return { paid: false, paymentIntent: null, expired: false, email: null };
  const s = await client().checkout.sessions.retrieve(order.session);
  const ours = s.client_reference_id === order.id && s.amount_total === (order.amountCents ?? PRICE_CENTS) && s.currency === CURRENCY;
  return {
    paid: ours && s.payment_status === 'paid',
    paymentIntent: typeof s.payment_intent === 'string' ? s.payment_intent : s.payment_intent?.id || null,
    expired: s.status === 'expired',
    // Adresa introdusă de client pe pagina de plată: acolo îi trimitem linkul previziunii.
    email: s.customer_details?.email || s.customer_email || null,
  };
}

/** Returnează banii pentru o comandă plătită (de ex. când previziunea nu a putut fi făcută). */
async function refund(order) {
  if (mode() === 'demo') return { id: 'demo-refund', status: 'succeeded' };
  if (mode() !== 'stripe' || !order.paymentIntent) throw new Error('Nu există o plată de returnat.');
  return client().refunds.create({ payment_intent: order.paymentIntent, metadata: { order_id: order.id } }, { idempotencyKey: `refund-${order.id}` });
}

function webhookEvent(rawBody, signature) {
  const secret = process.env.STRIPE_WEBHOOK_SECRET;
  if (mode() !== 'stripe' || !secret) throw new Error('Webhook neconfigurat.');
  return client().webhooks.constructEvent(rawBody, signature, secret);
}

module.exports = {
  _setClient: (c) => { stripe = c; }, // pentru teste
  getRefund: id => client().refunds.retrieve(id), mode, priceLabel, PRICE_CENTS, CURRENCY, createCheckout, checkPaid, refund, webhookEvent };
