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

**Plata:** cu `STRIPE_SECRET_KEY` în `.env`, butonul „Consultă oracolul — 1 €” duce vizitatorul pe pagina de
plată Stripe, iar previziunea pornește doar după ce plata e confirmată. Dacă oracolul nu poate face previziunea
(eroare) sau refuză întrebarea, banii se returnează automat. Fără cheie, previziunile sunt gratuite.

Mai are: interfață în română și engleză, previziuni **private** (în afara listelor publice și a indexării),
istoricul aceleiași întrebări puse la momente diferite (cum s-a schimbat probabilitatea scenariului de bază),
timp estimat și notificare în browser când previziunea e gata, distribuire (WhatsApp, Facebook, X, Telegram),
export PDF (tipărire) și instalare ca aplicație pe telefon sau calculator (PWA).

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
- **Modelul rapid de rezervă** – când bugetul principal de azi s-a epuizat, previziunile noi se fac cu Claude Haiku 5.5
  (căutare web de bază, cel mult `FALLBACK_MAX_SEARCHES` căutări), din bugetul separat `FALLBACK_DAILY_USD`; tot el
  preia o previziune când modelul principal dă eroare. Rezultatele lui au cache separat și eticheta „model rapid”.
  Mesajul „oracolul s-a odihnit” apare doar când s-au epuizat ambele bugete. Previziunile plătite folosesc mereu
  modelul principal și nu depind de bugetul zilnic.
- **Progres în timp real** (`lib/jobs.js`) – fiecare cerere rulează în fundal; pagina primește prin
  Server-Sent Events ce caută oracolul, ce pagini citește și ce gândește. Dacă utilizatorul închide pagina,
  previziunea se termină oricum și o găsește la același link.
- **Previziuni salvate** (`lib/store.js`) – ca fișiere JSON în `data/predictions/`. O cerere identică
  (aceeași întrebare, chiar scrisă diferit, cu aceleași opțiuni) primește rezultatul existent, fără un nou apel,
  pentru o durată care crește cu perioada previziunii. Răspunsul brut al modelului se păstrează în `data/raw/`.
- **Domenii și perioade** (`lib/catalog.js`) – 14 domenii (economie, burse și cripto, tehnologie și AI,
  politică, geopolitică, energie, imobiliare, climă, sănătate, sport, știință, societate, divertisment, altul),
  8 orizonturi și 8 regiuni. Fiecare domeniu îi spune modelului ce fel de surse contează (sondaje și piețe de
  predicții la politică, cote la sport, prognoze sezoniere la climă etc.).
- **Verificarea** (`lib/verify.js`) – o dată pe oră, previziunile cu afirmații ajunse la termen (data de
  verificare dată de model + 2 zile) sunt verificate cu căutare web, cele mai vechi întâi, cât permite cota
  `VERIFY_DAILY_USD`. O afirmație nelămurită (de ex. datele oficiale încă nepublicate) se reverifică săptămânal,
  de cel mult 4 ori. Rezultatul se salvează în fișierul previziunii.
- **Previzualizări și indexare** (`lib/seo.js`) – serverul pune în pagina `/p/<id>` titlul, rezumatul și imaginea
  1200×630 (desenată ca SVG, rasterizată cu ffmpeg și salvată în `data/og/`). Există și `sitemap.xml`, `robots.txt`.
- **Plata** (`lib/payments.js`, `lib/orders.js`) – Stripe Checkout, prețul fixat pe server (`PRICE_EUR_CENTS`).
  Limitele (bugetul zilnic, cererile pe oră) se verifică înainte de plată, ca nimeni să nu plătească pentru o
  previziune pe care n-o mai putem face. Plata se confirmă pe trei căi, toate fără dubluri: întoarcerea de pe
  Stripe (`/pay/<comandă>`), webhook-ul `/api/stripe/webhook` (opțional) și o verificare la 2 minute a comenzilor
  în așteptare. Comenzile se salvează în `data/orders/`. Previziunile plătite rulează chiar dacă bugetul zilnic
  s-a epuizat între timp.
- **Termeni, acord, emailuri** (`lib/legal.js`, `lib/mail.js`) – pagina `/termeni` (română și engleză) se generează din
  `COMPANY_NAME`, `COMPANY_CUI`, `CONTACT_EMAIL`. Cu plata activă, formularul cere bifa de acord (termeni + furnizarea
  imediată a conținutului digital, OUG 34/2014 art. 16 lit. m); fără ea serverul nu deschide plata, iar acordul se
  salvează în comandă. După plată, clientul primește pe emailul folosit la Stripe linkul previziunii (sau anunțul de
  restituire), prin SMTP (`SMTP_*`, `MAIL_FROM`); dacă trimiterea eșuează, se reîncearcă la verificarea periodică.
- **Administrare** (`/admin`, `lib/admin.js`) – protejată cu parola `ADMIN_PASSWORD` din `.env` (orice nume de
  utilizator): bugetul de azi, costurile pe zile, domeniile și perioadele cerute, ultimele previziuni (inclusiv
  întrebările private) și erorile recente (`data/events.json`).
- **Ce refuză oracolul** – întrebări despre persoane private, decese sau sănătatea cuiva, numere la loterie
  și orice ar putea face rău. Previziunile despre sănătate, bani sau drept sunt informative, nu sfaturi.

## Costuri și limite

O previziune nouă costă în practică 0,33–0,53 $ (tokenii modelului + căutările web la 10 $ / 1000) și durează
~2 minute. Costul fiecărei cereri apare în jurnal (`journalctl -u nostra`) și se adună în bugetul zilnic.
Cererile care eșuează din cauza serviciului nu consumă din limita vizitatorului. Limite din `.env`:

| Variabilă | Implicit | Rol |
|---|---|---|
| `DAILY_BUDGET_USD` | 1 | cât se poate cheltui pe zi (UTC); registrul e în `data/budget.json` |
| `FALLBACK_DAILY_USD` | 1 | bugetul zilnic separat al modelului rapid (Claude Haiku 5.5), folosit după epuizarea bugetului principal sau când modelul principal nu răspunde |
| `VERIFY_DAILY_USD` | 0.25 | cât din bugetul zilnic pot folosi verificările |
| `RATE_PER_HOUR` | 6 | previziuni noi pe oră de la același vizitator |
| `DAILY_LIMIT` | 300 | previziuni noi pe zi, în total |
| `MAX_CONCURRENT` / `MAX_QUEUE` | 3 / 20 | câte rulează simultan / câte așteaptă la rând |
| `CACHE_ENABLED` | 1 | refolosirea previziunilor identice: 3 ore (o săptămână) … 7 zile (5–10 ani) |
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
| `GET` | `/api/catalog` | domenii, orizonturi, regiuni, eforturi și dacă se cere plata (`payment`) |
| `POST` | `/api/predict` | `{domain, horizon, region, lang, question, effort?, private?, ui?}` → `{id, cached, etaSec}` sau, cu plată, `{orderId, checkoutUrl}` |
| `POST` | `/api/orders/:id/confirm` | verifică plata la Stripe și pornește previziunea → `{status, predictionId}` |
| `POST` | `/api/stripe/webhook` | confirmarea plății trimisă de Stripe (semnătură verificată) |
| `GET` | `/api/predict/:id/events` | flux SSE: `status`, `search`, `results`, `fetch`, `thought`, `done`, `error` |
| `GET` | `/api/p/:id` | previziunea completă, cu verificarea fiecărei afirmații (`checks`), istoricul întrebării (`history`) și dacă se poate actualiza (`refreshable`) |
| `GET` | `/api/recent` | ultimele previziuni |
| `GET` | `/api/track-record` | palmaresul: afirmații verificate, procent corect, Brier, calibrare |
| `GET` | `/og/<id>.png` | imaginea de previzualizare a linkului |
