'use strict';
// Domeniile, orizonturile de timp și regiunile pe care le poate alege utilizatorul.
// `hint` ghidează cercetarea: ce fel de surse sunt cele mai utile în domeniul respectiv.

const DOMAINS = [
  { id: 'economie', icon: '📈', ro: 'Economie', en: 'Economy',
    hint: 'inflation, GDP, interest rates, central bank guidance, IMF/World Bank/EC forecasts, official statistics' },
  { id: 'piete', icon: '💹', ro: 'Burse, valute și cripto', en: 'Markets, FX & crypto',
    hint: 'current prices and levels, analyst consensus, futures/options-implied expectations, ETF flows, scheduled catalysts' },
  { id: 'tehnologie', icon: '🤖', ro: 'Tehnologie și AI', en: 'Technology & AI',
    hint: 'product roadmaps, announced launches, research trends, adoption data, regulation in progress' },
  { id: 'politica', icon: '🏛️', ro: 'Politică și alegeri', en: 'Politics & elections',
    hint: 'latest polls and poll averages, prediction markets (Polymarket, Kalshi, Metaculus), electoral calendar, coalition math' },
  { id: 'geopolitica', icon: '🌍', ro: 'Geopolitică și conflicte', en: 'Geopolitics & conflicts',
    hint: 'state of negotiations, front lines, sanctions, think-tank assessments (ISW, CSIS, Chatham House), scheduled summits' },
  { id: 'energie', icon: '⚡', ro: 'Energie și materii prime', en: 'Energy & commodities',
    hint: 'oil/gas/electricity prices, OPEC+ decisions, IEA/EIA outlooks, storage levels, futures curves' },
  { id: 'imobiliare', icon: '🏠', ro: 'Imobiliare', en: 'Real estate',
    hint: 'price indices, mortgage rates, transaction volumes, construction permits, supply pipeline' },
  { id: 'clima', icon: '🌦️', ro: 'Climă și vreme', en: 'Climate & weather',
    hint: 'seasonal outlooks (Copernicus, NOAA, national meteorological services), ENSO state, climate trend data' },
  { id: 'sanatate', icon: '🩺', ro: 'Sănătate', en: 'Health',
    hint: 'WHO/ECDC/CDC surveillance data, epidemiological trends, approvals pipeline (EMA/FDA), health policy' },
  { id: 'sport', icon: '⚽', ro: 'Sport', en: 'Sports',
    hint: 'standings, form, injuries, bookmaker odds and implied probabilities, fixtures calendar, Elo-style ratings' },
  { id: 'stiinta', icon: '🔭', ro: 'Știință și spațiu', en: 'Science & space',
    hint: 'scheduled missions and launches, peer-reviewed results, major experiments, funding decisions' },
  { id: 'societate', icon: '👥', ro: 'Societate și muncă', en: 'Society & labour',
    hint: 'demographics, labour market, migration, wages, surveys and official statistics' },
  { id: 'divertisment', icon: '🎬', ro: 'Cultură și divertisment', en: 'Culture & entertainment',
    hint: 'release calendars, box office tracking, award-season predictions and betting odds, streaming data' },
  { id: 'altul', icon: '✨', ro: 'Alt domeniu', en: 'Other',
    hint: 'whatever sources are most authoritative for the user question' },
];

// Orizonturi: `days` dă data-țintă trimisă modelului; `cacheHours` cât timp o cerere identică primește
// rezultatul deja calculat (o prognoză pe 10 ani nu se schimbă de la o oră la alta, una pe o săptămână da).
const HORIZONS = [
  { id: '1w', days: 7, cacheHours: 3, ro: 'o săptămână', en: 'one week' },
  { id: '1m', days: 30, cacheHours: 6, ro: 'o lună', en: 'one month' },
  { id: '3m', days: 91, cacheHours: 12, ro: '3 luni', en: '3 months' },
  { id: '6m', days: 182, cacheHours: 24, ro: '6 luni', en: '6 months' },
  { id: '1y', days: 365, cacheHours: 24, ro: 'un an', en: 'one year' },
  { id: '3y', days: 1096, cacheHours: 72, ro: '3 ani', en: '3 years' },
  { id: '5y', days: 1826, cacheHours: 168, ro: '5 ani', en: '5 years' },
  { id: '10y', days: 3652, cacheHours: 168, ro: '10 ani', en: '10 years' },
];

const REGIONS = [
  { id: 'global', ro: 'Global', en: 'Global' },
  { id: 'ro', ro: 'România', en: 'Romania' },
  { id: 'md', ro: 'Republica Moldova', en: 'Republic of Moldova' },
  { id: 'eu', ro: 'Uniunea Europeană', en: 'European Union' },
  { id: 'us', ro: 'SUA', en: 'United States' },
  { id: 'cn', ro: 'China', en: 'China' },
  { id: 'ua', ro: 'Ucraina și Rusia', en: 'Ukraine & Russia' },
  { id: 'me', ro: 'Orientul Mijlociu', en: 'Middle East' },
];

const LANGS = ['ro', 'en'];

// Cât de temeinic caută și gândește oracolul (parametrul `effort` al modelului). Implicit: ORACLE_EFFORT din .env.
const EFFORTS = [
  { id: 'low', ro: 'Scăzut', en: 'Low',
    hintRo: 'Cel mai rapid și mai ieftin: mai puține căutări, analiză mai sumară.',
    hintEn: 'Fastest and cheapest: fewer searches, a briefer analysis.' },
  { id: 'medium', ro: 'Mediu', en: 'Medium',
    hintRo: 'Echilibrat între temeinicie și timp de așteptare.',
    hintEn: 'A balance between thoroughness and waiting time.' },
  { id: 'high', ro: 'Înalt', en: 'High',
    hintRo: 'Cel mai temeinic: cercetare și raționament mai ample, dar durează mai mult.',
    hintEn: 'Most thorough: deeper research and reasoning, but takes longer.' },
];
const EFFORT_IDS = EFFORTS.map((e) => e.id);
const defaultEffort = () => (EFFORT_IDS.includes(process.env.ORACLE_EFFORT) ? process.env.ORACLE_EFFORT : 'medium');

const byId = (list) => Object.fromEntries(list.map((x) => [x.id, x]));
const DOMAIN = byId(DOMAINS);
const HORIZON = byId(HORIZONS);
const REGION = byId(REGIONS);

/** Varianta publică (fără indicațiile interne) pentru interfață. */
function publicCatalog() {
  return {
    domains: DOMAINS.map(({ id, icon, ro, en }) => ({ id, icon, ro, en })),
    horizons: HORIZONS.map(({ id, ro, en }) => ({ id, ro, en })),
    regions: REGIONS,
    efforts: EFFORTS,
    defaultEffort: defaultEffort(),
  };
}

module.exports = { DOMAINS, HORIZONS, REGIONS, LANGS, EFFORTS, EFFORT_IDS, defaultEffort, DOMAIN, HORIZON, REGION, publicCatalog };
