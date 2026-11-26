'use strict';
// Exemplu editorial fix: nu apelează modelul, nu creează comenzi și nu intră în palmares.
function example(lang = 'ro') {
  const en = lang === 'en';
  const pick = (ro, english) => en ? english : ro;
  const sources = [
    { title: pick('Raport lunar Exemplu — sursă fictivă', 'Example monthly report — fictional source'), url: 'https://example.org/monthly-report', published_at: '2026-01-12' },
    { title: pick('Buletin economic Exemplu — sursă fictivă', 'Example economic bulletin — fictional source'), url: 'https://example.org/economic-bulletin', published_at: '2026-01-14' },
  ];
  const claims = [
    [pick('Indicele Exemplu scade sub 5% în februarie.', 'The Example index falls below 5% in February.'), 60, pick('Ritmul lunar încetinește în scenariul central.', 'Monthly growth slows in the base case.'), 0],
    [pick('Indicele Exemplu rămâne peste 3%.', 'The Example index remains above 3%.'), 80, pick('Ajustarea costurilor are loc treptat.', 'Costs adjust gradually.'), 0],
    [pick('Dobânda Exemplu rămâne la 6%.', 'The Example interest rate stays at 6%.'), 70, pick('Instituția fictivă așteaptă o confirmare a tendinței.', 'The fictional institution waits for confirmation of the trend.'), 1],
    [pick('Raportul Exemplu este publicat până la 15 martie.', 'The Example report is published by 15 March.'), 85, pick('Aceasta este data din calendarul ilustrativ.', 'This is the date in the illustrative calendar.'), 1],
  ];
  return {
    id: 'example', example: true, forecastStart: '2026-01-15', forecastEnd: '2026-02-14', createdAt: '2026-01-15T12:00:00Z',
    request: { domain: 'economie', horizon: '1m', region: 'global', lang: en ? 'en' : 'ro', effort: 'medium', question: pick('Va scădea indicele fictiv Exemplu sub 5%?', 'Will the fictional Example index fall below 5%?') },
    prediction: {
      declined: false, declined_reason: '', title: pick('Exemplu: o încetinire treptată a indicelui Exemplu', 'Example: a gradual slowdown in the Example index'),
      summary: pick('Exemplu ilustrativ cu date și surse fictive, fără valoare de prognoză actuală. Scenariul de bază are 60% probabilitate: indicele Exemplu scade sub 5%, în timp ce dobânda se menține. Probabilitatea exprimă incertitudinea, nu o garanție.', 'Illustrative example with fictional data and sources, not a current forecast. The base case has a 60% probability: the Example index falls below 5% while the interest rate stays unchanged. Probability expresses uncertainty, not a guarantee.'),
      current_state: pick('În universul acestui exemplu, indicele este 5,4%, iar dobânda este 6%. Rapoartele și instituțiile menționate sunt fictive.', 'In this example, the index is 5.4% and the interest rate is 6%. The reports and institutions mentioned are fictional.'),
      confidence: 'medium',
      scenarios: [
        { name: pick('Scenariul de bază', 'Base case'), probability: 60, description: pick('Indicele scade treptat, fără schimbări bruște ale dobânzii.', 'The index falls gradually, without sudden interest-rate changes.'), signals: [pick('Două publicări lunare cu ritm în scădere', 'Two monthly releases showing a slower pace')] },
        { name: pick('Scenariul optimist', 'Upside'), probability: 25, description: pick('Costurile scad mai repede și accelerează ajustarea.', 'Costs fall faster and accelerate the adjustment.'), signals: [pick('Reducerea costurilor energiei', 'Lower energy costs')] },
        { name: pick('Scenariul pesimist', 'Downside'), probability: 15, description: pick('Un șoc de ofertă amână scăderea indicelui.', 'A supply shock delays the decline.'), signals: [pick('Creșterea prețurilor de import', 'Rising import prices')] },
      ],
      predictions: claims.map(([claim, probability, rationale, source], index) => ({
        claim, probability, timeframe: pick('Februarie 2026; date publicate până la 15 martie', 'February 2026; data published by 15 March'), resolve_by: '2026-03-15', confidence: 'medium', rationale,
        resolution_criteria: pick(`Afirmația ${index + 1} este adevărată numai dacă raportul fictiv indicat confirmă exact pragul sau data; egalitatea nu satisface un prag strict. În lipsa datelor, rezultatul rămâne nelămurit.`, `Claim ${index + 1} is true only if the indicated fictional report confirms the exact threshold or date; equality does not satisfy a strict threshold. Missing data leaves the outcome unresolved.`),
        sources: [sources[source]],
      })),
      drivers: [
        { name: pick('Costurile energiei', 'Energy costs'), impact: 'positive', explanation: pick('O scădere a costurilor reduce presiunea asupra indicelui.', 'Lower costs reduce pressure on the index.') },
        { name: pick('Cererea internă', 'Domestic demand'), impact: 'uncertain', explanation: pick('O revenire rapidă poate întârzia ajustarea.', 'A rapid recovery could delay the adjustment.') },
        { name: pick('Importurile', 'Imports'), impact: 'negative', explanation: pick('Prețurile de import pot aduce un șoc neașteptat.', 'Import prices could produce an unexpected shock.') },
      ],
      watch: [{ indicator: pick('Publicarea următorului raport ilustrativ', 'Release of the next illustrative report'), when: '2026-03-15' }],
      wildcards: [pick('O întrerupere a aprovizionării ar inversa tendința.', 'A supply disruption would reverse the trend.'), pick('O inovație ar putea reduce costurile mult mai repede.', 'An innovation could reduce costs much faster.')],
      quatrain: pick('Când prețul lasă din povară,\nTrei drumuri se deschid spre vară;\nPe cel de mijloc, pas domol,\nRămâne semnul de control.', 'When prices shed their heavy load,\nThree paths unfold along the road;\nThe middle path moves slow and clear,\nWhile patient watchers persevere.'),
      sources,
    },
    meta: { tier: 'main', searches: 0, consulted: 0, durationMs: 0 }, history: [], refreshable: false,
    checks: claims.map(() => ({ status: 'unresolved', evidence: pick('Exemplul nu este verificat automat.', 'This example is not automatically verified.'), url: null, resolveBy: '2026-03-15' })),
  };
}

module.exports = { example };
