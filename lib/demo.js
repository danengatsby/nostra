'use strict';
// Mod demonstrativ (DEMO_MODE=1): simulează cercetarea și întoarce o previziune fictivă, fără apeluri
// către API. Util pentru dezvoltarea interfeței și pentru teste. Nu se folosește în producție.

const { DOMAIN, HORIZON, REGION } = require('./catalog');
const { horizonEnd } = require('./oracle');

const wait = (ms, signal) => new Promise((resolve, reject) => {
  const t = setTimeout(resolve, ms);
  signal?.addEventListener('abort', () => { clearTimeout(t); reject(Object.assign(new Error('aborted'), { name: 'AbortError' })); }, { once: true });
});

async function runDemo(req, emit, signal, { tier = 'main' } = {}) {
  const step = Number(process.env.DEMO_STEP_MS ?? 400);
  const domain = DOMAIN[req.domain];
  const horizon = HORIZON[req.horizon];
  const region = REGION[req.region];
  const en = req.lang === 'en';
  const topic = req.question || `${en ? domain.en : domain.ro} — ${en ? region.en : region.ro}`;

  emit('status', { phase: 'research' });
  for (const q of [`${topic} latest news`, `${topic} forecast ${new Date().getFullYear()}`, `${topic} expert outlook`]) {
    await wait(step, signal);
    emit('search', { query: q });
    await wait(step / 2, signal);
    emit('results', { count: 10, sources: 10 });
  }
  emit('fetch', { host: 'example.org' });
  await wait(step, signal);
  emit('thought', { text: en ? 'Weighing base rates against the latest data (demo).' : 'Cântăresc ratele de bază față de cele mai noi date (demo).' });
  emit('status', { phase: 'writing' });
  await wait(step, signal);

  const end = horizonEnd(horizon.days);
  return {
    prediction: {
      declined: false,
      declined_reason: '',
      title: `${en ? 'Demo forecast' : 'Previziune demonstrativă'}: ${topic}`.slice(0, 160),
      summary: en
        ? `This is a demonstration result generated without contacting the AI service. With DEMO_MODE=0 and an API key, Nostradamus researches the web and forecasts until ${end}.`
        : `Acesta este un rezultat demonstrativ, generat fără serviciul de inteligență artificială. Cu DEMO_MODE=0 și o cheie API, Nostradamus caută pe internet și face previziunea până la ${end}.`,
      current_state: en ? 'Demo mode: no real data was collected.' : 'Mod demonstrativ: nu s-au colectat date reale.',
      confidence: 'low',
      scenarios: [
        { name: en ? 'Base case' : 'Scenariul de bază', probability: 55, description: en ? 'Current trends continue.' : 'Tendințele actuale continuă.', signals: [en ? 'Stable indicators' : 'Indicatori stabili'] },
        { name: en ? 'Upside' : 'Scenariul optimist', probability: 25, description: en ? 'Things improve faster than expected.' : 'Lucrurile se îmbunătățesc mai repede decât se așteaptă.', signals: [en ? 'Positive surprises' : 'Surprize pozitive'] },
        { name: en ? 'Downside' : 'Scenariul pesimist', probability: 20, description: en ? 'A shock reverses the trend.' : 'Un șoc inversează tendința.', signals: [en ? 'Negative surprises' : 'Surprize negative'] },
      ],
      predictions: [
        { claim: en ? 'The main indicator stays within its current range.' : 'Indicatorul principal rămâne în intervalul actual.', probability: 65, timeframe: end, confidence: 'medium', rationale: en ? 'Demo rationale.' : 'Argument demonstrativ.' },
        { claim: en ? 'A major announcement takes place before the target date.' : 'Are loc un anunț major înainte de data-țintă.', probability: 30, timeframe: end, confidence: 'low', rationale: en ? 'Demo rationale.' : 'Argument demonstrativ.' },
      ],
      drivers: [{ name: en ? 'Momentum' : 'Inerția tendinței', impact: 'positive', explanation: en ? 'Demo.' : 'Demonstrativ.' }],
      watch: [{ indicator: en ? 'Next official data release' : 'Următoarea publicare de date oficiale', when: end }],
      wildcards: [en ? 'An unexpected external shock.' : 'Un șoc extern neașteptat.'],
      quatrain: en
        ? 'When frost is kept in silent jars,\nThe merchant counts beneath the stars;\nThree roads diverge, the middle wide,\nAnd patient hands will choose the tide.'
        : 'Când bruma doarme-n vase mute,\nNegustorul numără sub stele multe;\nTrei drumuri se despart, cel din mijloc lat,\nIar mâna răbdătoare alege ce-i de dat.',
      sources: [{ title: 'Example source (demo)', url: 'https://example.org/' }],
    },
    meta: { model: tier === 'lite' ? 'demo-lite' : 'demo', tier, effort: req.effort || 'medium', searches: 3, fetches: 1, consulted: 10, usage: {} },
  };
}

module.exports = { runDemo };
