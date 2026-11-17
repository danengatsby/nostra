'use strict';
// Logica oracolului cu un client API simulat: reluarea după pause_turn, filtrarea surselor,
// reformatarea unui răspuns invalid și refuzul.

const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');

delete process.env.DEMO_MODE;
const oracle = require('../lib/oracle');
const { sanitizePrediction, extractJson } = require('../lib/schema');

const VALID = {
  declined: false, declined_reason: '', title: 'Titlu', summary: 'Rezumat.', current_state: 'Acum.', confidence: 'medium',
  scenarios: [
    { name: 'Bază', probability: 60, description: 'd', signals: ['s'] },
    { name: 'Optimist', probability: 30, description: 'd', signals: [] },
    { name: 'Pesimist', probability: 30, description: 'd', signals: [] },
  ],
  predictions: [{ claim: 'Ceva se întâmplă', probability: 100, timeframe: '2027', confidence: 'high', rationale: 'r' }],
  drivers: [{ name: 'F', impact: 'positive', explanation: 'e' }],
  watch: [{ indicator: 'I', when: 'mai' }], wildcards: ['W'], quatrain: 'a\nb\nc\nd',
  sources: [
    { title: 'Real', url: 'https://real.example/a' },
    { title: 'Inventat', url: 'https://invented.example/x' },
    { title: 'Rău', url: 'javascript:alert(1)' },
  ],
};

/** Client fals: fiecare apel la stream() consumă următorul răspuns din listă. */
function fakeClient(responses, calls) {
  return {
    beta: {
      messages: {
        stream(params) {
          calls.push(params);
          const msg = responses.shift();
          const em = new EventEmitter();
          em.finalMessage = async () => {
            for (const b of msg.content) {
              if (b.type === 'text') em.emit('text', b.text);
              em.emit('contentBlock', b);
            }
            return msg;
          };
          return em;
        },
      },
    },
    messages: {
      async create(params) {
        calls.push(params);
        return { stop_reason: 'end_turn', content: [{ type: 'text', text: JSON.stringify(VALID) }], usage: {} };
      },
    },
  };
}

const REQ = { domain: 'economie', horizon: '1y', region: 'ro', lang: 'ro', question: 'Inflația?' };

test('reia după pause_turn, păstrează doar sursele consultate', async () => {
  const calls = [];
  const events = [];
  oracle._setClient(fakeClient([
    {
      stop_reason: 'pause_turn', model: 'claude-opus-5-5', usage: { input_tokens: 10, output_tokens: 5, server_tool_use: { web_search_requests: 1 } },
      content: [
        { type: 'server_tool_use', id: 's1', name: 'web_search', input: { query: 'inflatie romania 2026' } },
        { type: 'web_search_tool_result', tool_use_id: 's1', content: [{ type: 'web_search_result', url: 'https://real.example/a', title: 'Real', encrypted_content: '' }] },
      ],
    },
    {
      stop_reason: 'end_turn', model: 'claude-opus-5-5', usage: { input_tokens: 20, output_tokens: 50 },
      content: [
        { type: 'thinking', thinking: 'Analizez datele.', signature: 'x' },
        { type: 'text', text: 'Iată:\n<prediction>' },
        { type: 'text', text: JSON.stringify(VALID).slice(0, 40), citations: [{ type: 'web_search_result_location', url: 'https://cited.example/c', title: 'Citat' }] },
        { type: 'text', text: `${JSON.stringify(VALID).slice(40)}</prediction>` },
      ],
    },
  ], calls));

  const { prediction, meta } = await oracle.runOracle(REQ, (type, data) => events.push([type, data]));

  assert.equal(calls.length, 2);
  // A doua cerere continuă turul asistentului cu conținutul primit.
  assert.equal(calls[1].messages.length, 2);
  assert.equal(calls[1].messages[1].role, 'assistant');
  assert.equal(calls[0].tools[0].type, 'web_search_20260209');
  assert.deepEqual(calls[0].fallbacks, 'default');
  assert.match(calls[0].messages[0].content, /<question>Inflația\?<\/question>/);

  assert.deepEqual(prediction.sources.map((s) => s.url), ['https://real.example/a', 'https://cited.example/c']);
  assert.equal(prediction.predictions[0].probability, 99);
  assert.equal(prediction.scenarios.reduce((a, s) => a + s.probability, 0), 100);
  assert.equal(meta.searches, 1);
  assert.equal(meta.usage.input_tokens, 30);
  assert.ok(events.some(([t, d]) => t === 'search' && d.query === 'inflatie romania 2026'));
  assert.ok(!events.some(([t]) => t === 'thought'), 'fără gânduri în engleză pe previziunile în română');
});

test('reformatează cu ieșire structurată când JSON-ul lipsește', async () => {
  const calls = [];
  oracle._setClient(fakeClient([
    { stop_reason: 'end_turn', usage: {}, content: [{ type: 'text', text: 'Previziune în proză, fără JSON.' }] },
  ], calls));
  const { prediction } = await oracle.runOracle(REQ, () => {});
  assert.equal(prediction.title, 'Titlu');
  assert.equal(calls[1].output_config.format.type, 'json_schema');
});

test('refuzul devine un mesaj pentru utilizator', async () => {
  oracle._setClient(fakeClient([{ stop_reason: 'refusal', usage: {}, content: [] }], []));
  await assert.rejects(oracle.runOracle(REQ, () => {}), (err) => {
    assert.match(oracle.friendlyError(err), /refuzat/);
    return true;
  });
});

test('extractJson și sanitizePrediction', () => {
  assert.equal(extractJson('```json\n{"a":1}\n```').a, 1);
  assert.equal(extractJson('bla <prediction>{"a":2}</prediction>').a, 2);
  assert.throws(() => extractJson('nimic'));
  assert.throws(() => sanitizePrediction({ title: '', summary: '' }));
  const declined = sanitizePrediction({ declined: true, declined_reason: 'Persoană privată' });
  assert.equal(declined.declined, true);
  const p = sanitizePrediction(VALID);
  assert.deepEqual(p.sources.map((s) => s.url), ['https://real.example/a', 'https://invented.example/x']);
});

test('mesajul către model conține data-țintă corectă', () => {
  const msg = oracle.buildUserMessage({ ...REQ, question: '' }, new Date('2026-11-17T10:00:00Z'));
  assert.match(msg, /from 2026-11-17 to 2027-11-17/);
  assert.match(msg, /did not ask a specific question/);
});

test('gândurile se transmit doar pentru previziunile în engleză', async () => {
  const msg = () => ({ stop_reason: 'end_turn', usage: {}, content: [
    { type: 'thinking', thinking: 'Weighing the data.', signature: 'x' },
    { type: 'text', text: `<prediction>${JSON.stringify(VALID)}</prediction>` },
  ] });
  oracle._setClient(fakeClient([msg()], []));
  const events = [];
  await oracle.runOracle({ ...REQ, lang: 'en' }, (type, data) => events.push([type, data]));
  assert.ok(events.some(([t, d]) => t === 'thought' && d.text === 'Weighing the data.'));
});

test('elementele venite ca obiecte nu se pierd', () => {
  const { asText, isoDate } = require('../lib/schema');
  assert.equal(asText({ event: 'Criză bancară', impact: 'mare', probability: 5 }), 'Criză bancară — mare (~5%)');
  assert.equal(asText(42), '');
  assert.equal(isoDate('2027-03-13'), '2027-03-13');
  assert.equal(isoDate('mijlocul lui martie'), '');
  const p = sanitizePrediction({ ...VALID, wildcards: [{ event: 'Război comercial', probability: 10 }, 'Text simplu'] });
  assert.deepEqual(p.wildcards, ['Război comercial (~10%)', 'Text simplu']);
});

test('consumul se atașează și erorilor, pentru buget', async () => {
  oracle._setClient({ beta: { messages: { stream() {
    const em = new EventEmitter();
    em.finalMessage = async () => { throw new Error('conexiune pierdută'); };
    return em;
  } } } });
  await assert.rejects(oracle.runOracle(REQ, () => {}), (err) => 'usage' in err);
});
