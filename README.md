# Nostradamus

Aplicație web care face previziuni în diverse domenii și pe diverse perioade, pe baza informațiilor
găsite pe internet **în momentul cererii**. Utilizatorul alege domeniul, perioada (o săptămână → 10 ani),
regiunea și, opțional, pune o întrebare. Oracolul caută pe web, citește sursele importante și întoarce:

- un rezumat cu probabilitatea principală și nivelul de încredere;
- 3 scenarii (de bază, optimist, pesimist) care însumează 100%, cu semnale timpurii;
- 4–7 previziuni concrete și verificabile, fiecare cu probabilitate, termen și argument;
- situația actuală, factorii-cheie, ce trebuie urmărit și surprizele posibile;
- lista surselor consultate (doar URL-uri primite efectiv de la căutare, nu inventate);
- un catren în stilul lui Nostradamus.

Fiecare previziune are un link permanent (`/p/<id>`) care se poate distribui; linkul arată în WhatsApp,
Facebook etc. titlul, rezumatul și o imagine proprie previziunii.

După data fiecărei afirmații, oracolul **își verifică singur previziunile**: caută ce s-a întâmplat de fapt și
marchează afirmația ca adevărată, falsă sau încă nelămurită, cu dovada și sursa. Prima pagină arată palmaresul:
procentul de previziuni corecte, scorul Brier și calibrarea (dintre afirmațiile date cu 70–79%, câte s-au adeverit).

**Previziunea rapidă, gratuită:** butonul „Vezi gratuit previziunea rapidă” generează raportul complet cu modelul
rapid (Claude Haiku 5.5, ~0,05 $, ~35 s), pe ecran, fără email, acord sau plată, din bugetul zilnic
`FALLBACK_DAILY_USD`. Se aplică limitele de cereri. Când bugetul gratuit de azi s-a epuizat, mesajul amintește
de analiza plătită, disponibilă oricând. (`FREE_TIER=main` revine la vechiul mod: gratuit pe modelul principal
cât permite `DAILY_BUDGET_USD`; `FREE_SCREEN_EMAIL_REQUIRED=1` cere din nou emailul, doar pentru validare.)

**Analiza aprofundată, plătită (2,99 €):** cu `STRIPE_SECRET_KEY` în `.env`, o generare nouă cu modelul principal
(Claude Opus 5.5) și efort înalt (`PAID_EFFORT`), afișată pe ecran și trimisă pe email. Se cere din formular sau,
pentru aceeași întrebare, de pe pagina unei previziuni rapide (butonul „Analiză aprofundată”; la anularea plății
vizitatorul revine la previziunea rapidă). Cere email și acordul cu termenii; nu depinde de bugetul zilnic.
Plata, livrarea și recuperarea după restart folosesc comenzile persistente. Erorile de generare sau refuzul
declanșează restituirea automată. Fără configurarea plăților, opțiunea este ascunsă.

Mai are: interfață în română și engleză, previziuni **private** (în afara listelor publice și a indexării),
istoricul aceleiași întrebări puse la momente diferite (cum s-a schimbat probabilitatea scenariului de bază),
timp estimat și notificare în browser când previziunea e gata, distribuire (WhatsApp, Facebook, X, Telegram),
export PDF (tipărire) și instalare ca aplicație pe telefon sau calculator (PWA).

Cache-ul și lucrările private sunt separate pe sesiune printr-un cookie HttpOnly (Secure pe HTTPS),
fără a folosi IP-ul sau emailul ca identificator. Fără cookie, cererile private primesc spații separate.
Identificatorul intern nu este expus în API; comenzile plătite îl păstrează pe disc pentru recuperare după
restart. Previziunile private vechi nu se reutilizează în noul cache. Linkurile rămân accesibile oricui le
primește. Paginile, API-ul, progresul SSE și imaginile private trimit `Cache-Control: private, no-store`;
service worker-ul exclude paginile previziunilor și răspunsurile care interzic stocarea.

Formularul are opțiunile de efort și limbă într-o secțiune pliabilă. Un exemplu complet, bilingv și marcat
ca fictiv poate fi consultat gratuit la `/exemplu`, fără apel AI și fără comandă. Formularul se salvează
automat în `sessionStorage`, fără acordul bifat; rămâne disponibil la reîncărcare și după revenirea de la plată.
La pierderea conexiunii apare un mesaj explicit, iar progresul se recuperează prin SSE și verificarea stării.

Formularul începe cu exemplul complet, apoi prezintă grila de domenii, întrebarea și perioada. „Alt domeniu” include categoriile suplimentare. Regiunea se alege sub perioadă, iar efortul și limba se aleg din „Opțiuni avansate”. După plată, linkul comenzii afișează
confirmarea, starea livrării actualizată automat și accesul la previziune. Raportul prezintă
afirmațiile imediat după rezumat și acțiunile la final. Trimiterile
numerotate leagă afirmațiile de sursele lor; sursele generale fără asociere sunt marcate ca informații de
context. Istoricul etichetează probabilitatea scenariului de bază și păstrează numele acestuia când e disponibil.

„Istoricul meu” păstrează până la 100 de previziuni în browser (`localStorage`), cu ștergere individuală.
Întrebările urmărite își actualizează verificările când utilizatorul revine pe prima pagină sau cere o
actualizare; pentru cele publice se preia și ultima versiune din istoric. Nu se generează automat previziuni
noi și nu se fac plăți pentru urmărire. Lista arată următorul termen eligibil și câte verdicte finale au apărut după ultima deschidere. Nu există sincronizare între dispozitive.

Afirmațiile noi au surse proprii, filtrate după URL-urile primite de la instrumente. Datele de publicare
disponibile sunt afișate; lipsa datei sau a surselor pe afirmație este indicată explicit. Rezultatele vechi
nu primesc automat surse generale ca și cum ar susține fiecare afirmație. Palmaresul permite filtre combinate
după domeniu, perioadă și model principal/rapid și arată numărul afirmațiilor rezolvate.

## Pornire rapidă

```bash
npm install
cp .env.example .env        # apoi completează ANTHROPIC_API_KEY
npm start                   # http://127.0.0.1:3200
npm run dev                 # mod demonstrativ: rezultate simulate, fără cheie API și fără costuri
npm test                    # nu încarcă .env: testele nu ating Stripe, emailul sau API-ul real
```

## Cum funcționează

- **Oracolul** (`lib/oracle.js`) – un singur apel către Claude (`claude-opus-5-5`) cu instrumentele
  `web_search` și `web_fetch`, care rulează pe serverele Anthropic. Modelul caută de mai multe ori, citește
  1–2 pagini importante, apoi raționează ca un „superforecaster” (rate de bază, tendințe, probabilități
  calibrate) și scrie rezultatul ca JSON. Dacă JSON-ul iese invalid, este reformatat printr-un al doilea apel
  scurt cu ieșire structurată. Dacă modelul refuză o cerere din motive de siguranță, aceasta este reîncercată
  automat pe un model de rezervă (`ORACLE_FALLBACKS=1`).
- **Modelul rapid** – previziunile gratuite se fac cu Claude Haiku 5.5 (căutare web de bază, cel mult
  `FALLBACK_MAX_SEARCHES` căutări), din bugetul zilnic `FALLBACK_DAILY_USD`. Rezultatele lui au cache separat și
  eticheta „model rapid”; o cerere gratuită identică cu o analiză aprofundată publică recentă primește analiza
  din cache. Cu `FREE_TIER=main`, modelul rapid preia previziunile gratuite după epuizarea bugetului principal sau
  când modelul principal dă eroare. Comenzile plătite folosesc mereu modelul principal și nu depind de bugetul zilnic.
- **Progres în timp real** (`lib/jobs.js`) – fiecare cerere rulează în fundal; pagina primește prin
  Server-Sent Events ce caută oracolul, ce pagini citește și ce gândește. Dacă utilizatorul închide pagina,
  previziunea se termină oricum și o găsește la același link.
- **Previziuni salvate** (`lib/store.js`) – ca fișiere JSON în `data/predictions/`. O cerere identică
  (aceeași întrebare și opțiuni, indiferent de majuscule sau spații suplimentare) primește rezultatul existent,
  fără un nou apel, pentru o durată care crește cu perioada previziunii. Simbolurile, punctuația și diacriticele
  se păstrează: întrebările cu `<` și `>` sau `+` și `-` au cache separat. Cheile v2 invalidează cache-ul vechi;
  previziunile existente rămân accesibile prin link, iar istoricul se grupează după cererea originală.
  Răspunsul brut al modelului se păstrează în `data/raw/`.
- **Domenii și perioade** (`lib/catalog.js`) – 26 de domenii (economie, burse și cripto, tehnologie și AI,
  politică, geopolitică, energie, imobiliare, climă, sănătate, sport, știință, societate, divertisment,
  afaceri, agricultură și alimentație, educație, turism, transport și infrastructură, mediu, securitate
  cibernetică, justiție și reglementări, auto și mobilitate, industrie, comerț și consum, telecomunicații, altul),
  8 orizonturi și 8 regiuni. Fiecare domeniu îi spune modelului ce fel de surse contează (sondaje și piețe de
  predicții la politică, cote la sport, prognoze sezoniere la climă etc.).
- **Verificarea** (`lib/verify.js`) – o dată pe oră, previziunile cu afirmații ajunse la termen (data de
  verificare dată de model + 2 zile) sunt verificate cu căutare web, cele mai vechi întâi, cât permite cota
  `VERIFY_DAILY_USD`. O afirmație nelămurită (de ex. datele oficiale încă nepublicate) se reverifică săptămânal,
  cu cel mult 4 încercări în total. Un verdict adevărat/fals necesită o dovadă textuală și un URL găsit
  efectiv de instrumentele verificatorului în apelul curent; în lipsa lor rămâne nelămurit. Verdictele
  vechi fără dovadă sau URL sunt excluse din palmares și afișate ca nelămurite; se reverifică în aceleași
  limite de timp, încercări și buget. Afirmațiile noi includ un criteriu explicit de rezolvare, stabilit la
  generare, afișat lângă afirmație și folosit ulterior de verificator. Rezultatul se salvează în fișierul previziunii.
- **Previzualizări și indexare** (`lib/seo.js`) – serverul pune în pagina `/p/<id>` titlul, rezumatul și imaginea
  1200×630 (desenată ca SVG, rasterizată cu ffmpeg și salvată în `data/og/`). Există și `sitemap.xml`, `robots.txt`.
- **Plata** (`lib/payments.js`, `lib/orders.js`) – Stripe Checkout, prețul fixat pe server (`PRICE_EUR_CENTS`).
  Limitele (bugetul zilnic, cererile pe oră) se verifică înainte de plată, ca nimeni să nu plătească pentru o
  previziune pe care n-o mai putem face. Plata se confirmă pe trei căi, toate fără dubluri: întoarcerea de pe
  Stripe (`/pay/<comandă>`), webhook-ul `/api/stripe/webhook` (opțional) și o verificare la 2 minute a comenzilor
  în așteptare. Comenzile se salvează în `data/orders/`. Previziunile plătite rulează chiar dacă bugetul zilnic
  s-a epuizat între timp.
  După o întrerupere, plata se verifică la Stripe indiferent de vechimea comenzii; expirarea este confirmată
  de Stripe. Rezultatele deja salvate finalizează comenzile și declanșează emailul, iar lucrările pierdute
  sunt reluate. Restituirile eșuate se reîncearcă de cel mult 5 ori în total, la intervale de 2, 4, 8 și
  16 minute (la următoarea verificare periodică), cu aceeași cheie de idempotency. Încercările rezistă la
  restart; după epuizarea lor apare o alertă în administrare pentru intervenție în Stripe.
- **Termeni, acord, emailuri** (`lib/legal.js`, `lib/mail.js`) – pagina `/termeni` (română și engleză) se generează din
  `COMPANY_NAME`, `COMPANY_CUI`, `CONTACT_EMAIL`. Numai analiza aprofundată plătită cere bifa de acord (termeni + furnizarea
  imediată a conținutului digital, OUG 34/2014 art. 16 lit. m); fără ea serverul nu deschide plata, iar acordul se
  salvează în comandă. După plată, clientul primește pe emailul folosit la Stripe linkul previziunii (sau anunțul de
  restituire), prin SMTP (`SMTP_*`, `MAIL_FROM`); dacă trimiterea eșuează, se reîncearcă la verificarea periodică.
- **Statistici / administrare** (`/admin`, `lib/admin.js`, `lib/adminauth.js`) – contul de administrare: pe /admin
  scrii utilizatorul și parola, iar browserul rămâne conectat 180 de zile (cookie semnat, HttpOnly), până la
  „Ieșire”. Pe site, linkul „Admin” din subsol duce la această pagină. Contul se creează sau se schimbă cu `npm run admin-cont`
  (sau `npm run admin-cont -- --generate` pentru o parolă generată, afișată o singură dată), care scrie în `.env`
  `ADMIN_USER` și `ADMIN_PASSWORD_HASH` (amprentă scrypt, nu parola) și șterge vechea `ADMIN_PASSWORD`; apoi
  `sudo systemctl restart nostra`. Schimbarea parolei închide sesiunile deschise cu cea veche. Accesul merge și
  prin HTTP Basic (`utilizator:parolă`). Fără parolă, adresele din `ADMIN_EMAILS` pot cere un link de unică
  folosință pe email (30 de minute). Formularul și HTTP Basic împart limita de zece încercări eșuate pe oră per IP. Conținut: bugetul de azi, costurile pe zile, domeniile și perioadele cerute, ultimele previziuni (inclusiv
  întrebările private) și erorile recente (`data/events.json`).
- **Ce refuză oracolul** – întrebări despre persoane private, decese sau sănătatea cuiva, numere la loterie
  și orice ar putea face rău. Previziunile despre sănătate, bani sau drept sunt informative, nu sfaturi.

## Costuri și limite

O previziune rapidă (gratuită) costă ~0,05 $ și durează ~35 s; o analiză aprofundată (plătită, Opus) costă în
practică 0,33–0,53 $ (tokenii modelului + căutările web la 10 $ / 1000) și durează ~2 minute. Costul fiecărei cereri apare în jurnal (`journalctl -u nostra`) și se adună în bugetul zilnic.
Cererile care eșuează din cauza serviciului nu consumă din limita vizitatorului. Limite din `.env`:

| Variabilă | Implicit | Rol |
|---|---|---|
| `DAILY_BUDGET_USD` | 1 | cât se poate cheltui pe zi (UTC); registrul e în `data/budget.json` |
| `FALLBACK_DAILY_USD` | 1 | bugetul zilnic al previziunilor gratuite, făcute cu modelul rapid (Claude Haiku 5.5): ~20 pe zi |
| `FREE_TIER` | lite | modelul previziunii gratuite; `main` = modelul principal cât permite `DAILY_BUDGET_USD`, apoi cel rapid |
| `PRICE_EUR_CENTS` / `PAID_EFFORT` | 299 / high | prețul și efortul analizei aprofundate plătite |
| `VERIFY_DAILY_USD` | 0.25 | cât din bugetul zilnic pot folosi verificările |
| `RATE_PER_HOUR` | 6 | previziuni noi pe oră de la același vizitator |
| `DAILY_LIMIT` | 300 | previziuni noi pe zi, în total |
| `MAX_CONCURRENT` / `MAX_QUEUE` | 3 / 20 | câte rulează simultan / câte așteaptă la rând |
| `CACHE_ENABLED` | 1 | refolosirea previziunilor identice: 3 ore (o săptămână) … 7 zile (5–10 ani) |
| `FREE_SCREEN_EMAIL_REQUIRED` | 0 | 1 = previziunea gratuită cere din nou o adresă de email (doar validată, nesalvată) |
| `ORACLE_EFFORT` | medium | efortul selectat implicit în formular (vizitatorul alege între scăzut, mediu și înalt) |
| `ORACLE_MAX_SEARCHES` / `ORACLE_MAX_FETCHES` | 12 / 4 | câte căutări / pagini citite la o previziune |

## Punerea în producție

1. `cp .env.example .env`, completează `ANTHROPIC_API_KEY`, lasă `DEMO_MODE=0`.
2. Serviciul systemd:
   ```bash
   sudo cp deploy/nostra.service /etc/systemd/system/nostra.service
   sudo systemctl daemon-reload && sudo systemctl enable --now nostra
   ```
3. nginx + HTTPS: vezi `deploy/nginx.conf.example` (înlocuiește `DOMENIU.RO`, apoi `certbot --nginx`).
   Ruta `/api/predict/<id>/events` are nevoie de `proxy_buffering off` și un timeout lung — sunt deja în exemplu.

## Backup și versiuni

- Codul e în git (`main`); `.env` și `data/` nu intră în repository.
- `deploy/backup.sh` rulează zilnic la 03:30 (crontab-ul utilizatorului `ubuntu`) și păstrează ultimele 14 arhive
  cu `data/` și `.env` în `/home/ubuntu/backups/nostra/`. Sunt pe același disc: pentru siguranță deplină, copiază-le
  periodic și în altă parte. Restaurare: `tar -xzf <arhivă> -C /var/www/nostra` și `sudo systemctl restart nostra`.

## API

| Metodă | Rută | Descriere |
|---|---|---|
| `GET` | `/api/catalog` | domenii, orizonturi, regiuni, eforturi, afișare gratuită (`freeDisplay`), email obligatoriu (`emailRequired`) și configurarea plății opționale (`payment`) |
| `POST` | `/api/predict` | `{domain, horizon, region, lang, question, email, effort?, private?, ui?, delivery?}` → `{id, cached, etaSec}` sau, cu plată, `{orderId, checkoutUrl}` |
| `POST` | `/api/p/:id/upgrade` | `{email, consent: true, ui?}` → plata pentru analiza aprofundată a aceleiași întrebări (doar de la o previziune rapidă) → `{orderId, checkoutUrl}` |
| `POST` | `/api/orders/:id/confirm` | verifică plata la Stripe și pornește previziunea → `{status, predictionId}` |
| `POST` | `/api/stripe/webhook` | confirmarea plății trimisă de Stripe (semnătură verificată) |
| `GET` | `/api/predict/:id/events` | flux SSE: `status`, `search`, `results`, `fetch`, `thought`, `done`, `error` |
| `GET` | `/api/p/:id` | previziunea completă, cu verificarea fiecărei afirmații (`checks`), istoricul întrebării (`history`) și dacă se poate actualiza (`refreshable`) |
| `GET` | `/api/recent` | ultimele previziuni |
| `GET` | `/api/track-record` | palmaresul: afirmații verificate, procent corect, Brier, calibrare |
| `GET` | `/api/track-record?domain=economie&horizon=1m&tier=main` | filtre combinate opționale (`tier`: `main` sau `lite`) |
| `GET` | `/api/example?lang=ro` | exemplu ilustrativ complet, gratuit și exclus din palmares |
| `GET` | `/api/predict/:id/status` | starea lucrării pentru recuperarea conexiunii, fără date interne |
| `GET` | `/og/<id>.png` | imaginea de previzualizare a linkului |

Pentru previziunea gratuită, `POST /api/predict` primește `delivery: "screen"`, fără email sau acord (un email trimis
totuși se validează, fără a fi salvat). `delivery: "email"` cere email și acord și deschide plata analizei aprofundate. Pentru compatibilitate,
cererile API fără `delivery` păstrează alegerea livrării anterioare (plată când este configurată), cu aceeași cerință de email ca pentru livrarea aleasă.
`POST /api/p/:id/upgrade`, cu `{email, consent: true, ui?}`, creează plata pentru o generare nouă a aceleiași cereri
pe modelul principal, cu efortul `PAID_EFFORT`; comanda păstrează previziunea rapidă de origine (`upgradeOf`).

În administrare, conversia formularului este proporția intrărilor pe formular care au dus la afișarea unui raport cerut în acea vizită. Un refresh al paginii sau o revenire la formular începe o vizită. Exemplele, refuzurile, deschiderile directe și recitirile nu adaugă conversii.
Fereastra este de 30 de zile UTC, grupată după lățimea inițială (mobil până la 640 px inclusiv) și varianta câmpului de email. Pentru o probă separată, setează `FREE_SCREEN_EMAIL_REQUIRED=0` pe instanța de test și repornește procesul. Adresa rămâne obligatorie la cumpărarea livrării.
Pentru cereri API noi, `private: false` alege publicarea. Dacă opțiunea lipsește, raportul este accesibil doar prin link.

## Operare și recuperare

Folosește Node 22.13 sau mai recent. Coada lucrărilor și contoarele zilnice folosesc SQLite în
`data/operations.sqlite`. La oprire (`systemctl restart` / `stop`), serverul nu mai pornește lucrări noi,
așteaptă terminarea previziunilor și a verificărilor deja pornite (cel mult `SHUTDOWN_TIMEOUT_MS`, implicit
9 minute; `TimeoutStopSec=600` în serviciu), apoi iese. Între timp site-ul răspunde normal, iar cererile noi
așteaptă în coadă și pornesc după repornire, cu același ID. Doar o oprire forțată (al doilea semnal, timp
depășit, cădere) întrerupe un apel AI, care poate fi facturat din nou la reluare.
Pe HTTPS, răspunsurile trimit `Strict-Transport-Security` (un an). Rezultatele și comenzile existente rămân în formatul JSON.
`GET /healthz` verifică accesul la SQLite și raportează numărul lucrărilor active.
În administrare, contoarele zilnice UTC arată cererile de afișare, checkouturile create, plățile confirmate
și emailurile acceptate de SMTP. Sunt volume de evenimente, inclusiv reveniri, nu utilizatori unici.

Pentru generări gratuite, `DAILY_LIMIT` include rezultatele ambelor modele și lucrările în curs.
Comenzile deja plătite sunt onorate. `CHECKOUT_PER_HOUR` limitează separat inițierile de plată per IP
(implicit `RATE_PER_HOUR`), inclusiv trimiterea unui rezultat existent.
Starea livrării în API este `deliveryStatus`. După trei erori de trimitere, reconcilierea pornește
restituirea. O restituire aflată în procesare se verifică la Stripe la ciclurile următoare. Activează
evenimentele Stripe `refund.updated` și `refund.failed` pentru actualizări imediate, inclusiv eșecuri ulterioare.

Pentru copia externă, setează în **mediul cron** `BACKUP_SSH_DEST` (alias SSH și director existent,
de exemplu `backup-host:/backups/nostra`) și `BACKUP_GPG_RECIPIENT` (amprenta verificată a cheii
publice de criptare). Sunt necesare GPG, Python 3 și acces SSH neinteractiv cu cheia gazdei cunoscută.
Cheia privată de decriptare se păstrează separat. Pentru restaurare, decriptează arhiva cu
`gpg --output backup.tar.gz --decrypt backup.tar.gz.gpg`, extrage într-un director gol și verifică
permisiunile înainte de pornirea serviciului. Testează restaurarea într-o instalare izolată.
