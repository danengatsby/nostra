'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { create, questionKey } = require('../public/client-state');
const storage = () => {
  const values = new Map();
  return { getItem: key => values.get(key), setItem: (key, value) => values.set(key, value), values };
};
const record = (id = 'forecast0001', extra = {}) => ({
  id, createdAt: '2026-11-01T12:00:00Z', request: { domain: 'economie', horizon: '1m', region: 'ro', lang: 'ro', question: 'Inflația < 5%?', effort: 'medium', email: 'secret@example.com', consent: true },
  privateScope: 'secret-scope', prediction: { title: 'Titlu', scenarios: [{ name: 'Scădere treptată', probability: 60 }], predictions: [{ claim: 'Pragul este depășit', probability: 40 }] }, checks: [{ status: 'true' }], ...extra,
});

test('istoricul se păstrează în browser fără email, acord sau identificator privat', () => {
  const disk = storage();
  const library = create(disk);
  library.remember(record());
  const reloaded = create(disk);
  assert.equal(reloaded.list().length, 1);
  assert.equal(reloaded.get('forecast0001').resolved, 1);
  assert.equal(reloaded.get('forecast0001').base, 60);
  assert.equal(reloaded.get('forecast0001').baseName, 'Scădere treptată', 'istoricul identifică scenariul căruia îi aparține probabilitatea');
  const serialized = [...disk.values.values()].join('');
  assert.doesNotMatch(serialized, /secret@example|secret-scope|consent|privateScope/);
});

test('o întrebare refuzată păstrează cererea pentru reformulare și iese din urmărire', () => {
  const disk = storage();
  const library = create(disk);
  const rec = record();
  library.pending(rec.id, rec.request);
  library.toggle(rec.id);
  library.remember({ ...rec, prediction: { declined: true, predictions: [], scenarios: [] } });
  library.toggle(rec.id);
  const entry = create(disk).get(rec.id);
  assert.equal(entry.status, 'declined');
  assert.equal(entry.request.question, rec.request.question);
  assert.equal(entry.watched, false);
});

test('urmărirea trece la versiunea nouă fără să piardă istoricul sau să confunde operatorii', () => {
  const library = create(storage());
  library.remember(record());
  library.toggle('forecast0001');
  library.remember(record('forecast0002', { createdAt: '2026-11-02T12:00:00Z', history: [{ base: { probability: 55 } }, { base: { probability: 60 } }] }));
  assert.equal(library.get('forecast0001').watched, false);
  assert.equal(library.get('forecast0002').watched, true);
  library.remember(record());
  assert.equal(library.get('forecast0002').watched, true, 'vizitarea versiunii vechi nu mută urmărirea înapoi');
  assert.deepEqual(library.get('forecast0002').trend, [55, 60]);
  assert.notEqual(questionKey(record().request), questionKey({ ...record().request, question: 'Inflația > 5%?' }));
  assert.equal(questionKey(record().request), questionKey({ ...record().request, question: ' INFLAȚIA  < 5%? ' }));
  library.remove('forecast0002');
  assert.equal(library.get('forecast0002'), undefined);
});

test('exemplul și ID-urile invalide nu intră în istoric; lipsa stocării nu blochează utilizarea', () => {
  const library = create({ getItem() { throw new Error('blocked'); }, setItem() { throw new Error('blocked'); } });
  library.remember(record('example', { example: true }));
  library.remember({ request: {} });
  assert.equal(library.list().length, 0);
  library.pending('forecast0001', record().request);
  assert.equal(library.persistent, false);
  assert.equal(library.get('forecast0001').status, 'pending');
  library.failed('forecast0001');
  assert.equal(library.get('forecast0001').status, 'error');
});

test('intrările deteriorate sunt ignorate, iar istoricul este limitat la 100 de rezultate', () => {
  const disk = storage();
  disk.setItem('nostra-library-v1', JSON.stringify({ version: 1, entries: [null, {}, { id: 'bad' }, { id: 'forecast0001', request: {}, trend: [] }] }));
  const library = create(disk);
  assert.equal(library.list().length, 1);
  assert.equal(library.get('forecast0001').baseName, '', 'intrările vechi fără numele scenariului rămân compatibile');
  for (let i = 0; i < 105; i++) library.remember(record(`forecast${String(i).padStart(5, '0')}`));
  assert.equal(library.list().length, 100);
});

test('rezultatele noi supraviețuiesc reîncărcării și sunt citite numai la deschiderea raportului', () => {
  const disk = storage();
  const lib = create(disk);
  const nextCheckAt = '2027-01-04T00:00:00.000Z';
  lib.remember(record('forecast0001', { checks: [{ status: 'pending' }], nextCheckAt }));
  lib.toggle('forecast0001');
  assert.equal(lib.get('forecast0001').nextCheck, nextCheckAt);
  lib.remember(record(), { viewed: false });
  const restored = create(disk);
  restored.remember(record(), { viewed: false });
  assert.equal(restored.get('forecast0001').seenResolved, 0);
  assert.equal(restored.get('forecast0001').resolved, 1);
  assert.equal(restored.get('forecast0001').checkedBefore, true);
  restored.remember(record());
  assert.equal(create(disk).get('forecast0001').seenResolved, 1);
});

test('comanda confirmată păstrează accesul la raport în toate etapele livrării', () => {
  const { orderPresentation } = require('../public/client-state');
  for (const [status, deliveryStatus, message, finished] of [
    ['paid', null, 'generating', false], ['done', 'email_pending', 'sendingEmail', false],
    ['done', 'delivered', 'emailConfirmed', true], ['done', 'delivery_failed', 'deliveryFailed', false],
  ]) {
    const view = orderPresentation({ status, deliveryStatus, predictionId: 'forecast0001' });
    assert.equal(view.title, 'paidTitle');
    assert.equal(view.message, message);
    assert.equal(view.canOpen, true);
    assert.equal(view.finished, finished);
  }
  for (const [status, message, finished] of [
    ['pending', 'payPending', false], ['expired', 'payExpired', true],
    ['refund_pending', 'refundPending', false], ['refund_failed', 'refundFailed', false], ['refunded', 'refundDone', true],
  ]) {
    const view = orderPresentation({ status });
    assert.equal(view.message, message);
    assert.equal(view.canOpen, false);
    assert.equal(view.finished, finished);
  }
});
