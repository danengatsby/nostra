'use strict';
// Logica istoricului este independentă de DOM și nu salvează emailuri, acorduri sau sesiuni private.
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.NostraLibrary = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  const ID = /^[A-Za-z0-9_-]{8,32}$/;
  const validId = value => typeof value === 'string' && ID.test(value);
  const KEY = 'nostra-library-v1';
  const text = (v, max = 500) => typeof v === 'string' ? v.slice(0, max) : '';
  function requestOf(v = {}) {
    if (!v || typeof v !== 'object') v = {};
    const r = {};
    for (const k of ['domain', 'horizon', 'region', 'lang', 'effort']) r[k] = text(v[k], 64);
    return { ...r, question: text(v.question), private: v.private === true };
  }
  function questionKey(request) {
    const r = requestOf(request);
    return JSON.stringify([r.domain, r.horizon, r.region, r.lang, r.effort, r.private,
      r.question.toLowerCase().normalize('NFC').replace(/\s+/gu, ' ').trim()]);
  }
  function orderPresentation({ status, deliveryStatus, predictionId, declined, unavailable }) {
    if (unavailable) return { title: 'orderUnavailable', contact: true, finished: true };
    const refunds = { refunded: 'refundDone', refund_pending: 'refundPending', refund_failed: 'refundFailed' };
    const delivery = { delivered: 'emailConfirmed', email_pending: 'sendingEmail', delivery_failed: 'deliveryFailed' };
    let title = 'confirming';
    let message = 'orderLoading';
    if (status === 'pending') {
      title = 'orderWaiting'; message = 'payPending';
    } else if (status === 'expired') {
      title = 'expiredTitle'; message = 'payExpired';
    } else if (refunds[status]) {
      title = 'refundTitle'; message = refunds[status];
    } else if (status === 'paid' || status === 'done') {
      title = 'paidTitle'; message = delivery[deliveryStatus] || (status === 'done' ? 'deliveryUnknown' : 'generating');
    }
    return {
      title, message,
      canOpen: Boolean(predictionId && (status === 'paid' || status === 'done' || deliveryStatus === 'delivery_failed' || declined)),
      retryStatus: status === 'refund_failed' || (status === 'done' && deliveryStatus === 'delivery_failed'),
      contact: status === 'refund_failed' || deliveryStatus === 'delivery_failed',
      finished: status === 'refunded' || status === 'expired' || deliveryStatus === 'delivered',
    };
  }

  function create(storage) {
    let persistent = true;
    let entries = [];
    try {
      const saved = JSON.parse(storage.getItem(KEY) || 'null');
      if (saved?.version === 1 && Array.isArray(saved.entries)) entries = saved.entries.filter(e => validId(e?.id)).slice(0, 100).map(e => ({
        id: e.id, title: text(e.title, 160), request: requestOf(e.request), createdAt: text(e.createdAt, 40), lastViewedAt: Number(e.lastViewedAt) || 0,
        watched: e.watched === true, status: ['pending', 'done', 'declined', 'error'].includes(e.status) ? e.status : 'pending',
        base: Number.isFinite(e.base) ? e.base : null, baseName: text(e.baseName, 160), resolved: Number(e.resolved) || 0, total: Number(e.total) || 0,
        seenResolved: Number.isInteger(e.seenResolved) ? e.seenResolved : Number(e.resolved) || 0,
        checkedBefore: e.checkedBefore === true, nextCheck: text(e.nextCheck, 40),
        trend: Array.isArray(e.trend) ? e.trend.filter(Number.isFinite).slice(-8) : [],
      }));
    } catch { persistent = false; }
    function save() {
      entries.sort((a, b) => b.lastViewedAt - a.lastViewedAt);
      entries = entries.slice(0, 100);
      try { storage.setItem(KEY, JSON.stringify({ version: 1, entries })); persistent = true; }
      catch { persistent = false; }
    }
    function remember(rec, { viewed = true } = {}) {
      if (!rec || rec.example || !validId(rec.id)) return;
      const old = entries.find(e => e.id === rec.id);
      if (rec.pending && old && old.status !== 'error') return;
      const checks = rec.checks || [];
      const resolved = checks.filter(c => c.status === 'true' || c.status === 'false').length;
      const request = requestOf(rec.request);
      const group = questionKey(request);
      const watched = entries.find(e => e.watched && questionKey(e.request) === group);
      const createdAt = text(rec.createdAt, 40) || old?.createdAt || new Date().toISOString();
      const inheritWatch = watched && Date.parse(createdAt) >= Date.parse(watched.createdAt);
      const item = {
        id: rec.id, title: text(rec.prediction?.title || request.question, 160), request, createdAt,
        lastViewedAt: viewed ? Date.now() : old?.lastViewedAt || Date.now(), watched: old?.watched || !!inheritWatch,
        status: rec.pending ? 'pending' : rec.prediction?.declined ? 'declined' : 'done',
        base: Number.isFinite(rec.prediction?.scenarios?.[0]?.probability) ? rec.prediction.scenarios[0].probability : null,
        baseName: text(rec.prediction?.scenarios?.[0]?.name, 160),
        total: rec.prediction?.predictions?.length || 0,
        resolved, seenResolved: viewed ? resolved : Math.min(resolved, old?.seenResolved || 0),
        nextCheck: text(rec.nextCheckAt, 40), checkedBefore: checks.some(c => c.status !== 'pending'),
        trend: (rec.history || []).map(h => h.base?.probability).filter(Number.isFinite).slice(-8),
      };
      if (inheritWatch) for (const e of entries) if (questionKey(e.request) === group) e.watched = false;
      entries = entries.filter(e => e.id !== item.id);
      entries.push(item);
      save();
    }
    return {
      list: () => entries.map(e => ({ ...e, request: { ...e.request }, trend: [...e.trend] })),
      get: (id) => entries.find(e => e.id === id),
      remember,
      pending: (id, request) => remember({ id, request, pending: true }),
      toggle(id) {
        const entry = entries.find(e => e.id === id);
        if (!entry) return;
        const enable = !entry.watched;
        if (enable) for (const e of entries) if (questionKey(e.request) === questionKey(entry.request)) e.watched = false;
        entry.watched = enable;
        save();
      },
      remove(id) { entries = entries.filter(e => e.id !== id); save(); },
      failed(id) { const e = entries.find(e => e.id === id); if (e) { e.status = 'error'; save(); } },
      get persistent() { return persistent; },
    };
  }
  return { create, questionKey, orderPresentation };
});
