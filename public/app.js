'use strict';
// Interfața Nostradamus: formular → flux de progres (SSE) → previziune. Tot conținutul venit de la
// server este inserat cu textContent (niciodată ca HTML). Interfața e în română sau engleză.

(async () => {
  const $ = (sel) => document.querySelector(sel);
  // Un proces pornit înaintea actualizării poate servi încă șablonul HTML anterior.
  if (!$('#domains') || !$('#other-domain')) {
    try {
      const response = await fetch('/index.html', { cache: 'reload' });
      if (!response.ok) throw new Error('shell');
      const shell = new DOMParser().parseFromString(await response.text(), 'text/html');
      if (!shell.querySelector('#other-domain')) throw new Error('shell');
      for (const selector of ['header', 'main', 'footer']) $(selector).replaceWith(shell.querySelector(selector));
      if (!window.NostraLibrary?.orderPresentation) {
        await new Promise((resolve, reject) => {
          const script = document.createElement('script');
          script.onload = resolve; script.onerror = reject; script.src = '/client-state.js?v=8';
          document.head.append(script);
        });
      }
    } catch {
      const message = document.createElement('p');
      message.textContent = navigator.language.startsWith('ro') ? 'Reîncarcă pagina pentru a deschide formularul actualizat.' : 'Reload this page to open the updated form.';
      $('main').replaceChildren(message);
      return;
    }
  }
  const views = ['form', 'progress', 'result', 'order', 'error'];
  let catalog = null;
  let answerLangChosen = false;
  let source = null; // EventSource activ
  let timer = null;
  let current = null; // previziunea afișată
  let eta = 120; // durata estimată a unei previziuni, în secunde
  let followVersion = 0;
  let currentPredictionId = null;
  let connectionTimer = null;
  let networkState = navigator.onLine === false ? 'offline' : 'connected';
  let libraryFilter = 'all';
  let libraryRefreshing = false;
  let draftSaved = false;
  let restoringDraft = false;
  let trackRequest = 0;
  let submitting = false;
  let formVisit = null;
  let visitRegistration = Promise.resolve();
  let orderTimer = null;
  let orderState = null;

  // ---------- limba interfeței ----------
  const U = {
    ro: {
      checkOrder: 'Reverifică starea comenzii', advancedOptions: 'Opțiuni avansate', private: 'Previziune privată', exampleIntro: 'Vezi ce conține o previziune înainte să comanzi.', otherDomains: 'Alege un domeniu sau scrie propria întrebare',
      screenEmailMissing: 'Introdu o adresă de email validă pentru lectura gratuită.',
      openForecast: 'Deschide previziunea', systemShare: 'Alte opțiuni', orderLink: 'Vezi starea livrării',
      paidTitle: 'Plată confirmată', orderWaiting: 'Așteptăm confirmarea plății', expiredTitle: 'Plată expirată', refundTitle: 'Restituirea plății',
      orderLoading: 'Verificăm starea comenzii…', orderUnavailable: 'Comanda nu a fost găsită.', orderOffline: 'Starea comenzii nu s-a putut actualiza. Reîncercăm automat.',
      deliveryUnknown: 'Previziunea este gata. Așteptăm starea livrării pe email.',
      generating: 'Previziunea este în pregătire. Îți trimitem linkul pe email când este gata.',
      sendingEmail: 'Previziunea este gata. Emailul așteaptă trimiterea.',
      deliveryFailed: 'Trimiterea emailului a eșuat. Verificăm starea restituirii.',
      refundPending: 'Restituirea este în curs.', refundFailed: 'Restituirea nu a fost confirmată. Pentru ajutor, trimite-ne linkul acestei comenzi.',
      refundDone: 'Plata a fost restituită.',
      firstCheckAfter: 'Prima verificare după', nextCheckAfter: 'Următoarea verificare după',
      newChecks: n => n === 1 ? '1 rezultat nou' : `${n} rezultate noi`,
      tagline: 'Previziuni construite din ce se întâmplă acum în lume',
      viewExample: 'Vezi un exemplu complet',
      exampleLabel: 'Exemplu ilustrativ', exampleNote: 'Datele, instituțiile și sursele sunt fictive. Acest exemplu arată formatul rezultatului; nu este o prognoză actuală și nu necesită plată.',
      draftSaved: 'Formular salvat în această filă.', draftUnavailable: 'Browserul nu permite salvarea formularului.', clearDraft: 'Golește formularul',
      personalTitle: 'Istoricul meu', personalHint: 'Salvat în acest browser. Întrebările urmărite se actualizează când revii în aplicație.',
      historyAll: 'Toate', historyWatched: 'Întrebări urmărite', refreshChecks: 'Actualizează rezultatele', personalEmpty: 'Previziunile pe care le consulți vor apărea aici.', watchedEmpty: 'Urmărește o întrebare din pagina unei previziuni.',
      watchQuestion: 'Urmărește întrebarea', unwatchQuestion: 'Nu mai urmări', removeHistory: 'Elimină', pendingForecast: 'În lucru', failedForecast: 'Previziune nereușită',
      watchHint: 'Urmărirea este salvată în acest browser. Verificăm actualizările când revii; nu trimitem notificări și nu generăm previziuni noi automat.',
      baseProbability: 'Probabilitatea scenariului de bază',
      checkedCount: (n, total) => `${n}/${total} afirmații verificate`, historyUpdated: 'Rezultatele au fost actualizate.', historyOffline: 'Actualizarea nu a reușit. Istoricul salvat rămâne disponibil.', storageUnavailable: 'Istoricul nu poate fi păstrat în acest browser.',
      allDomains: 'Toate domeniile', allHorizons: 'Toate perioadele', allModels: 'Toate modelele', modelFilter: 'Modelul', mainModel: 'Principal', liteModel: 'Rapid', sampleSize: (n) => `Eșantion: ${n} afirmații rezolvate.`, smallSample: 'Eșantion mic: rezultatele pot varia mult.',
      retryConnection: 'Reîncearcă legătura', offline: 'Nu ai conexiune. Poți continua să completezi formularul; previziunile pornite continuă pe server.', reconnecting: 'Legătura cu serverul s-a întrerupt. Reîncercăm automat; previziunea continuă pe server.', connectionUnavailable: 'Legătura cu serverul s-a întrerupt. Poți reîncerca fără să reintroduci întrebarea.', trackUnavailable: 'Palmaresul nu a putut fi încărcat. Reîncearcă după restabilirea conexiunii.',
      install: 'Instalează aplicația', astroButton: 'ASTRO-HOROSCOP', stepDomain: 'Domeniul', stepQuestion: 'Întrebarea ta', optional: '(opțional)',
      questionPh: 'Ex.: Va scădea inflația din România sub 5% până la finalul perioadei?', examples: 'Exemple de întrebări',
      questionHint: 'Fără întrebare, oracolul îți spune ce e cel mai important de așteptat în domeniul și regiunea aleasă.',
      stepHorizon: 'Perioada', region: 'Regiunea', answerLang: 'Limba răspunsului', effort: 'Efortul oracolului',
      publicNotice: 'Întrebarea și rezultatul vor fi publice și pot apărea în motoarele de căutare.',
      privateNotice: 'Întrebarea și rezultatul nu apar în lista publică sau în motoarele de căutare. Oricine are linkul le poate vedea.',
      fixedPrice: (p) => `Efortul ales se aplică previziunii rapide gratuite; analiza aprofundată (${p}) folosește mereu efortul înalt.`,
      submit: 'Vezi gratuit previziunea rapidă', freeHint: 'Gratuit, pe ecran, fără email: raportul complet făcut de modelul rapid, în ~1 minut.',
      emailResult: (p) => `Analiză aprofundată — ${p}`,
      emailFee: (p) => `Plată unică: ${p}, fără abonament. Rezultatul apare pe ecran și îl primești și pe email.`,
      emailContinue: (p) => `Continuă către plată — ${p}`,
      emailExistingHint: 'Oracolul reface previziunea pentru aceeași întrebare cu modelul principal și efort înalt: mai multe căutări, pagini citite integral, ~2 minute. Dacă nu reușește, banii se returnează automat.',
      emailConfirmed: 'Emailul cu linkul previziunii a fost trimis.',
      payHint: (p) => `Modelul principal al oracolului, cu efort înalt: mai multe căutări, pagini citite integral, ~2 minute. Vezi rezultatul pe ecran și îl primești și pe email. Plată unică de ${p} pe pagina securizată Stripe, fără abonament. Dacă analiza nu poate fi făcută, banii se returnează automat.`,
      toPayment: 'Te ducem la pagina de plată…', confirming: 'Confirmăm plata…',
      consent: 'Sunt de acord cu Termenii și confidențialitatea și cer furnizarea imediată a analizei aprofundate (pe ecran și pe email); înțeleg că, după furnizarea serviciului plătit, nu mai pot cere retragerea din contract.',
      readTerms: 'Citește termenii', termsLink: 'Termeni și confidențialitate', contact: 'Contact',
      screenEmail: 'Email (obligatoriu și pentru afișarea gratuită)', deliveryOption: 'Analiză aprofundată (plătită)',
      emailLabel: 'Adresa de email la care primești previziunea', emailPh: 'nume@exemplu.ro',
      emailMissing: 'Scrie adresa de email la care să primești previziunea.', emailInvalid: 'Adresa de email nu pare corectă.',
      consentMissing: 'Bifează acordul cu termenii înainte de plată.',
      payPending: 'Plata nu a fost confirmată încă. Dacă ai plătit, previziunea pornește automat — poți reveni la acest link.',
      payExpired: 'Plata nu a fost finalizată, iar pagina de plată a expirat. Nu ți s-a luat niciun ban.',
      payCanceled: 'Plata a fost anulată. Nu ți s-a luat niciun ban.',
      refundedNote: 'Plata pentru această previziune a fost returnată automat.',
      duration: 'Durează de obicei 1–3 minute: oracolul caută și citește surse actuale înainte să răspundă.',
      trackTitle: 'Palmaresul oracolului', loading: 'Se încarcă…', recentTitle: 'Previziuni recente',
      recentEmpty: 'Încă nu există previziuni. Fii primul care consultă oracolul.',
      preparing: 'Oracolul se pregătește…', notify: '🔔 Anunță-mă când e gata', notifyOn: '🔔 Te anunțăm când e gata',
      leaveHint: 'Poți lăsa pagina deschisă sau poți reveni mai târziu la același link: previziunea se termină oricum.',
      share: 'Distribuie', copyLink: 'Copiază linkul', pdf: 'Salvează PDF', newForecast: 'O nouă previziune',
      errorTitle: 'Oracolul a tăcut', tryAgain: 'Încearcă din nou',
      disclaimer: 'Previziunile sunt estimări probabilistice generate automat de inteligență artificială pe baza surselor publice găsite la momentul cererii. Nu sunt certitudini și nu reprezintă consultanță financiară, medicală sau juridică.',
      phases: { queued: 'Aștepți la rând…', research: 'Oracolul caută pe internet…', writing: 'Oracolul scrie previziunea…', repair: 'Oracolul își pune gândurile în ordine…', fallback: 'Oracolul continuă cu modelul rapid…' },
      queuePos: (n) => `Ești al ${n}-lea la rând.`,
      searches: (n) => `${n} ${n === 1 ? 'căutare' : 'căutări'}`, found: (n) => `${n} surse găsite`,
      searching: (q) => `Caută: „${q}”`, reading: (h) => `Citește: ${h}`,
      etaLeft: (m) => (m <= 1 ? '· mai puțin de un minut' : `· încă ~${m} minute`), etaAlmost: '· aproape gata…',
      lost: 'Legătura cu serverul s-a întrerupt. Reîncarcă pagina pentru a vedea previziunea.',
      missing: 'Previziunea nu există sau nu mai este disponibilă.', network: 'Eroare de rețea. Încearcă din nou.',
      loadFail: 'Aplicația nu s-a putut încărca. Reîncarcă pagina.', copied: 'Linkul a fost copiat',
      readyTitle: 'Previziunea e gata', defaultTitle: 'Nostradamus — previziuni din datele de azi',
      track: {
        intro: 'Oracolul își verifică singur previziunile: după data fiecărei afirmații, caută ce s-a întâmplat de fapt și o marchează ca adevărată sau falsă. Aici se va vedea cât de des are dreptate.',
        waiting: (n, d) => `${n} afirmații așteaptă verificarea. Primele rezultate: după ${d}.`, none: 'Încă nu există afirmații de verificat.',
        correct: (c, n) => `previziuni corecte (${c} din ${n})`, brier: 'scor Brier (0 = perfect, 0,25 = cu banul)', pending: 'afirmații încă în așteptare',
        calibration: 'Calibrare', said: (r) => `Spus ${r}`, happened: (a, n) => `s-a întâmplat ${a}% (${n})`, latest: 'Ultimele verificări',
      },
      examplesBy: {
        economie: ['Va scădea inflația din România sub 5%?', 'Va intra zona euro în recesiune?'],
        piete: ['Unde va fi cursul EUR/RON?', 'Va depăși Bitcoin maximul istoric?'],
        tehnologie: ['Ce lansări importante în AI vor avea loc?', 'Cum va evolua piața smartphone-urilor?'],
        politica: ['Cine va câștiga următoarele alegeri?', 'Va rămâne coaliția actuală la guvernare?'],
        geopolitica: ['Va exista un armistițiu în Ucraina?', 'Cum vor evolua relațiile SUA–China?'],
        energie: ['Cât va costa barilul de petrol Brent?', 'Vor scădea facturile la energie în România?'],
        imobiliare: ['Vor crește prețurile apartamentelor în București?', 'Vor scădea dobânzile la creditele ipotecare?'],
        clima: ['Va fi iarna mai caldă decât media?', 'Va fi acest an cel mai cald înregistrat?'],
        sanatate: ['Cum va evolua sezonul de gripă?', 'Ce tratamente noi vor fi aprobate în UE?'],
        sport: ['Cine va câștiga Liga Campionilor?', 'Se va califica România la Campionatul Mondial?'],
        stiinta: ['Va ateriza o misiune cu echipaj pe Lună?', 'Ce descoperiri importante sunt așteptate?'],
        societate: ['Va crește salariul minim în România?', 'Cum va evolua șomajul în UE?'],
        divertisment: ['Ce film va câștiga Oscarul?', 'Care va fi cel mai vizionat film al anului?'],
        afaceri: ['Va crește numărul firmelor noi din România?', 'Cum va evolua finanțarea startup-urilor europene?'],
        agricultura: ['Cum va evolua recolta de grâu din România?', 'Vor crește prețurile alimentelor în UE?'],
        educatie: ['Va crește numărul studenților din România?', 'Cum va evolua cererea pentru cursuri de reconversie profesională?'],
        turism: ['Va crește numărul turiștilor străini în România?', 'Cum vor evolua tarifele de cazare pe litoral?'],
        transport: ['Ce tronsoane de autostradă ar putea fi deschise în România?', 'Va crește transportul feroviar de pasageri în UE?'],
        mediu: ['Se va îmbunătăți calitatea aerului în București?', 'Va crește rata de reciclare a deșeurilor din România?'],
        securitate_cibernetica: ['Cum va evolua numărul incidentelor ransomware raportate în UE?', 'Va crește adoptarea autentificării fără parolă?'],
        justitie: ['Ce reglementări europene privind AI vor intra în aplicare?', 'Cum ar putea evolua regulile pentru comerțul online în UE?'],
        auto: ['Va crește ponderea mașinilor electrice înmatriculate în România?', 'Cum va evolua rețeaua de stații de încărcare din UE?'],
        industrie: ['Va crește producția industrială din România?', 'Cum vor evolua comenzile fabricilor europene?'],
        comert: ['Vor crește vânzările online din România?', 'Cum va evolua încrederea consumatorilor din UE?'],
        telecom: ['Cum va evolua acoperirea 5G în România?', 'Va crește accesul la internet prin satelit în Europa?'],
      },
    },
    en: {
      checkOrder: 'Check order status again', advancedOptions: 'Advanced options', private: 'Private forecast', exampleIntro: 'See what a forecast contains before ordering.', otherDomains: 'Choose a topic or write your own question',
      screenEmailMissing: 'Enter a valid email address to read the forecast for free.',
      openForecast: 'Open forecast', systemShare: 'More options', orderLink: 'View delivery status',
      paidTitle: 'Payment confirmed', orderWaiting: 'Awaiting payment confirmation', expiredTitle: 'Payment expired', refundTitle: 'Payment refund',
      orderLoading: 'Checking your order…', orderUnavailable: 'Order not found.', orderOffline: 'Could not update the order status. We will check again automatically.',
      deliveryUnknown: 'Your forecast is ready. Waiting for the email delivery status.',
      generating: 'Your forecast is being prepared. We will email the link when it is ready.',
      sendingEmail: 'Your forecast is ready. Email delivery is pending.',
      deliveryFailed: 'Email delivery failed. We are checking the refund status.',
      refundPending: 'Your refund is being processed.', refundFailed: 'Your refund has not been confirmed. Contact us with this order link for help.',
      refundDone: 'Your payment has been refunded.',
      firstCheckAfter: 'First check after', nextCheckAfter: 'Next check after',
      newChecks: n => n === 1 ? '1 new result' : `${n} new results`,
      tagline: 'Forecasts built from what is happening in the world right now',
      viewExample: 'See a complete example',
      exampleLabel: 'Illustrative example', exampleNote: 'The data, institutions and sources are fictional. This example shows the result format; it is not a current forecast and requires no payment.',
      draftSaved: 'Form saved in this tab.', draftUnavailable: 'Your browser does not allow the form to be saved.', clearDraft: 'Clear form',
      personalTitle: 'My history', personalHint: 'Saved in this browser. Followed questions are updated when you return to the app.',
      historyAll: 'All', historyWatched: 'Followed questions', refreshChecks: 'Update results', personalEmpty: 'Forecasts you consult will appear here.', watchedEmpty: 'Follow a question from a forecast page.',
      watchQuestion: 'Follow this question', unwatchQuestion: 'Stop following', removeHistory: 'Remove', pendingForecast: 'In progress', failedForecast: 'Forecast failed',
      watchHint: 'Following is saved in this browser. We check for updates when you return; we do not send notifications or generate new forecasts automatically.',
      baseProbability: 'Base scenario probability',
      checkedCount: (n, total) => `${n}/${total} claims checked`, historyUpdated: 'Results have been updated.', historyOffline: 'Could not update. Your saved history is still available.', storageUnavailable: 'History cannot be saved in this browser.',
      allDomains: 'All domains', allHorizons: 'All periods', allModels: 'All models', modelFilter: 'Model', mainModel: 'Main', liteModel: 'Fast', sampleSize: (n) => `Sample: ${n} resolved claims.`, smallSample: 'Small sample: results may vary substantially.',
      retryConnection: 'Retry connection', offline: 'You are offline. You can keep filling in the form; forecasts already started continue on the server.', reconnecting: 'The server connection was interrupted. Retrying automatically; your forecast continues on the server.', connectionUnavailable: 'The server connection was interrupted. You can retry without entering your question again.', trackUnavailable: 'Could not load the track record. Retry when the connection is restored.',
      install: 'Install the app', astroButton: 'ASTRO-HOROSCOPE', stepDomain: 'Domain', stepQuestion: 'Your question', optional: '(optional)',
      questionPh: 'E.g.: Will euro area inflation fall below 2% by the end of the period?', examples: 'Example questions',
      questionHint: 'Without a question, the oracle tells you what matters most to expect in the chosen domain and region.',
      stepHorizon: 'Period', region: 'Region', answerLang: 'Answer language', effort: 'Oracle effort',
      publicNotice: 'Your question and forecast will be public and may appear in search engines.',
      privateNotice: 'Your question and forecast are not publicly listed or indexed by search engines. Anyone with the link can view them.',
      fixedPrice: (p) => `The selected effort applies to the free quick forecast; the in-depth analysis (${p}) always uses high effort.`,
      submit: 'Get the free quick forecast', freeHint: 'Free, on screen, no email: the complete report by the fast model, in about a minute.',
      emailResult: (p) => `In-depth analysis — ${p}`,
      emailFee: (p) => `One-off payment: ${p}, no subscription. The result appears on screen and is also emailed to you.`,
      emailContinue: (p) => `Continue to payment — ${p}`,
      emailExistingHint: 'The oracle redoes the forecast for the same question with its main model and high effort: more searches, pages read in full, about 2 minutes. If it fails, you are refunded automatically.',
      emailConfirmed: 'The email with your forecast link has been sent.',
      payHint: (p) => `The oracle’s main model with high effort: more searches, pages read in full, about 2 minutes. You see the result on screen and also receive it by email. One-off payment of ${p} on Stripe’s secure page, no subscription. If the analysis cannot be produced, you are refunded automatically.`,
      toPayment: 'Taking you to the payment page…', confirming: 'Confirming your payment…',
      consent: 'I agree to the Terms and privacy policy and request immediate supply of the in-depth analysis (on screen and by email); I understand that once the paid service is supplied I can no longer withdraw from the contract.',
      readTerms: 'Read the terms', termsLink: 'Terms and privacy', contact: 'Contact',
      screenEmail: 'Email (required for free viewing too)', deliveryOption: 'In-depth analysis (paid)',
      emailLabel: 'Email address to receive your forecast', emailPh: 'name@example.com',
      emailMissing: 'Enter the email address where you want to receive the forecast.', emailInvalid: 'This email address does not look right.',
      consentMissing: 'Please tick the box accepting the terms before paying.',
      payPending: 'The payment has not been confirmed yet. If you paid, the forecast will start automatically — you can come back to this link.',
      payExpired: 'The payment was not completed and the payment page has expired. You have not been charged.',
      payCanceled: 'The payment was canceled. You have not been charged.',
      refundedNote: 'The payment for this forecast was refunded automatically.',
      duration: 'Usually takes 1–3 minutes: the oracle searches and reads current sources before answering.',
      trackTitle: 'The oracle’s track record', loading: 'Loading…', recentTitle: 'Recent forecasts',
      recentEmpty: 'No forecasts yet. Be the first to consult the oracle.',
      preparing: 'The oracle is getting ready…', notify: '🔔 Notify me when it’s ready', notifyOn: '🔔 We’ll notify you when it’s ready',
      leaveHint: 'You can keep this page open or come back later to the same link: the forecast will finish anyway.',
      share: 'Share', copyLink: 'Copy link', pdf: 'Save as PDF', newForecast: 'New forecast',
      errorTitle: 'The oracle fell silent', tryAgain: 'Try again',
      disclaimer: 'Forecasts are probabilistic estimates generated automatically by artificial intelligence from public sources found at the time of the request. They are not certainties and are not financial, medical or legal advice.',
      phases: { queued: 'Waiting in line…', research: 'The oracle is searching the web…', writing: 'The oracle is writing the forecast…', repair: 'The oracle is putting its thoughts in order…', fallback: 'The oracle continues with the fast model…' },
      queuePos: (n) => `You are number ${n} in line.`,
      searches: (n) => `${n} ${n === 1 ? 'search' : 'searches'}`, found: (n) => `${n} sources found`,
      searching: (q) => `Searching: “${q}”`, reading: (h) => `Reading: ${h}`,
      etaLeft: (m) => (m <= 1 ? '· less than a minute left' : `· about ${m} minutes left`), etaAlmost: '· almost done…',
      lost: 'The connection to the server was lost. Reload the page to see the forecast.',
      missing: 'This forecast does not exist or is no longer available.', network: 'Network error. Please try again.',
      loadFail: 'The app could not load. Please reload the page.', copied: 'Link copied',
      readyTitle: 'Your forecast is ready', defaultTitle: 'Nostradamus — forecasts from today’s data',
      track: {
        intro: 'The oracle checks its own forecasts: after each claim’s date, it looks up what actually happened and marks it true or false. This is where you will see how often it is right.',
        waiting: (n, d) => `${n} claims are waiting to be checked. First results: after ${d}.`, none: 'There are no claims to check yet.',
        correct: (c, n) => `correct forecasts (${c} of ${n})`, brier: 'Brier score (0 = perfect, 0.25 = coin flip)', pending: 'claims still pending',
        calibration: 'Calibration', said: (r) => `Said ${r}`, happened: (a, n) => `happened ${a}% (${n})`, latest: 'Latest checks',
      },
      examplesBy: {
        economie: ['Will the euro area enter a recession?', 'Will the Fed cut interest rates?'],
        piete: ['Where will EUR/USD trade?', 'Will Bitcoin hit a new all-time high?'],
        tehnologie: ['Which major AI launches will happen?', 'How will the smartphone market evolve?'],
        politica: ['Who will win the next election?', 'Will the current government survive?'],
        geopolitica: ['Will there be a ceasefire in Ukraine?', 'How will US–China relations evolve?'],
        energie: ['What will a barrel of Brent cost?', 'Will European gas prices fall?'],
        imobiliare: ['Will house prices rise in my city?', 'Will mortgage rates go down?'],
        clima: ['Will this winter be warmer than average?', 'Will this be the hottest year on record?'],
        sanatate: ['How will the flu season evolve?', 'Which new treatments will be approved in the EU?'],
        sport: ['Who will win the Champions League?', 'Who will win the next Grand Slam?'],
        stiinta: ['Will a crewed mission land on the Moon?', 'Which major discoveries are expected?'],
        societate: ['Will unemployment rise in the EU?', 'How will migration trends change?'],
        divertisment: ['Which film will win the Oscar?', 'What will be the year’s biggest box office hit?'],
        afaceri: ['Will the number of new businesses in Romania rise?', 'How will funding for European startups evolve?'],
        agricultura: ['How will Romania’s wheat harvest evolve?', 'Will food prices rise in the EU?'],
        educatie: ['Will university enrolment in Romania increase?', 'How will demand for professional retraining courses evolve?'],
        turism: ['Will international tourist arrivals in Romania increase?', 'How will accommodation prices on the Romanian coast evolve?'],
        transport: ['Which motorway sections could open in Romania?', 'Will rail passenger traffic increase in the EU?'],
        mediu: ['Will air quality improve in Bucharest?', 'Will Romania’s waste recycling rate increase?'],
        securitate_cibernetica: ['How will reported ransomware incidents in the EU evolve?', 'Will adoption of passwordless authentication increase?'],
        justitie: ['Which European AI regulations will become applicable?', 'How might rules for online commerce in the EU evolve?'],
        auto: ['Will the share of electric vehicles registered in Romania increase?', 'How will the EU charging station network evolve?'],
        industrie: ['Will industrial production in Romania increase?', 'How will European manufacturing orders evolve?'],
        comert: ['Will online retail sales in Romania increase?', 'How will EU consumer confidence evolve?'],
        telecom: ['How will 5G coverage in Romania evolve?', 'Will satellite internet access expand in Europe?'],
      },
    },
  };

  // Etichetele rezultatului urmează limba previziunii (conținutul), nu a interfeței.
  const L = {
    ro: {
      scenarios: 'Scenarii', predictions: 'Previziuni verificabile', now: 'Unde ne aflăm acum', drivers: 'Factori-cheie',
      watch: 'De urmărit', wildcards: 'Surprize posibile', sources: 'Surse consultate', confidence: 'Încrederea oracolului', conf1: 'Încredere',
      conf: { low: 'scăzută', medium: 'medie', high: 'ridicată' }, imp: { positive: 'favorabil', negative: 'nefavorabil', uncertain: 'incert' },
      made: 'Previziune făcută la', research: (s, c) => `${s} căutări pe internet, ${c} surse găsite`,
      declinedTitle: 'Oracolul nu răspunde la această întrebare', horizon: 'Perioada', privateTag: 'privată', effort: 'Efort',
      liteTag: 'model rapid', liteNote: 'Previziune făcută cu modelul rapid al oracolului (analiză mai scurtă, cu mai puține căutări).',
      resolutionCriteria: 'Criteriu de verificare',
      published: 'Publicată la', dateUnknown: 'Dată de publicare neprecizată', noClaimSources: 'Nu sunt disponibile surse asociate acestei afirmații.',
      claimDetails: 'Argument și criteriu de verificare', claimSources: 'Surse pentru această afirmație',
      generalSources: 'Vezi sursele generale (neasociate acestei afirmații)',
      sourcesHint: 'Sursele de mai jos oferă context pentru analiză. Doar trimiterile de lângă fiecare afirmație indică sursele asociate acesteia; ele susțin argumentul, nu garantează rezultatul.',
      missingSources: (n) => `${n} afirmații nu au surse asociate. Lista generală nu dovedește automat fiecare afirmație.`,
      supportsClaims: 'Asociată afirmațiilor', contextOnly: 'Context general; fără asociere la o afirmație',
      quatrain: 'Catrenul oracolului',
      check: { pending: 'Se verifică după', true: 'S-a adeverit', false: 'Nu s-a adeverit', unresolved: 'Încă nelămurit' },
      source: 'sursa', history: 'Cum s-a schimbat prognoza', historyHint: 'Aceeași întrebare, pusă la momente diferite — probabilitatea scenariului de bază:',
      thisOne: 'aceasta', refresh: 'Actualizează previziunea cu datele de azi',
    },
    en: {
      scenarios: 'Scenarios', predictions: 'Verifiable predictions', now: 'Where things stand', drivers: 'Key drivers',
      watch: 'What to watch', wildcards: 'Possible surprises', sources: 'Sources consulted', confidence: 'Oracle confidence', conf1: 'Confidence',
      conf: { low: 'low', medium: 'medium', high: 'high' }, imp: { positive: 'favourable', negative: 'unfavourable', uncertain: 'uncertain' },
      made: 'Forecast made on', research: (s, c) => `${s} web searches, ${c} sources found`,
      declinedTitle: 'The oracle will not answer this question', horizon: 'Horizon', privateTag: 'private', effort: 'Effort',
      liteTag: 'fast model', liteNote: 'Forecast made with the oracle’s fast model (a shorter analysis with fewer searches).',
      resolutionCriteria: 'Resolution criteria',
      published: 'Published', dateUnknown: 'Publication date unavailable', noClaimSources: 'No sources are associated with this claim.',
      claimDetails: 'Reasoning and resolution criteria', claimSources: 'Sources for this claim',
      generalSources: 'View general sources (not linked to this claim)',
      sourcesHint: 'The sources below provide context for the analysis. Only references beside each claim identify sources associated with it; they support the reasoning, not a guaranteed outcome.',
      missingSources: (n) => `${n} claims have no associated sources. The general list does not automatically substantiate each claim.`,
      supportsClaims: 'Associated with claims', contextOnly: 'General context; not associated with a claim',
      quatrain: 'The oracle’s quatrain',
      check: { pending: 'Checked after', true: 'Came true', false: 'Did not come true', unresolved: 'Not settled yet' },
      source: 'source', history: 'How the forecast changed', historyHint: 'The same question asked at different times — probability of the base scenario:',
      thisOne: 'this one', refresh: 'Update the forecast with today’s data',
    },
  };

  const store = {
    get: (k) => { try { return localStorage.getItem(k); } catch { return null; } },
    set: (k, v) => { try { localStorage.setItem(k, v); } catch { /* stocare indisponibilă */ } },
  };
  const library = NostraLibrary.create({ getItem: k => localStorage.getItem(k), setItem: (k, v) => localStorage.setItem(k, v) });
  const EMAIL_RE = /^[^\s@<>",;]+@[^\s@<>",;]+\.[^\s@<>",;]{2,}$/;

  const sessionStore = {
    get: (k) => { try { return sessionStorage.getItem(k); } catch { return null; } },
    set: (k, v) => { try { sessionStorage.setItem(k, v); return true; } catch { return false; } },
    del: (k) => { try { sessionStorage.removeItem(k); } catch { /* indisponibil */ } },
  };
  eta = Number(sessionStore.get('eta')) || eta;
  let ui = store.get('ui') || ((navigator.language || 'ro').toLowerCase().startsWith('ro') ? 'ro' : 'en');
  const tr = (key) => U[ui][key];

  function applyUi() {
    document.documentElement.lang = ui;
    const astro = ui === 'en' ? 'https://astrohor.fun/?lang=en' : 'https://astrohor.fun/';
    for (const id of ['astro-switch', 'astro-header']) $(`#${id}`).href = astro;
    document.querySelectorAll('[data-i18n]').forEach((n) => { n.textContent = tr(n.dataset.i18n); });
    const pay = catalog?.payment;
    if (pay?.required) {
      $('#email-result').textContent = tr('emailResult')(pay.price);
      $('#result-email-label').textContent = tr('emailFee')(pay.price);
      for (const id of ['submit-email', 'result-submit-email']) $(`#${id}`).textContent = tr('emailContinue')(pay.price);
      $('#pay-hint').textContent = tr('payHint')(pay.price);
    }
    $('#email-options').hidden = !pay?.required;
    $('#submit-email').hidden = !pay?.required;
    renderEmailAction();
    $('#pay-hint').hidden = !pay?.required;
    $('#consent-row').hidden = !pay?.required;
    const requiresEmail = catalog?.emailRequired !== false;
    const emailRow = $('#email-row');
    (requiresEmail ? $('#form-error') : $('#consent-row')).before(emailRow);
    $('#email').required = requiresEmail || !!pay?.required;
    $('#email-label').textContent = tr(requiresEmail ? 'screenEmail' : 'emailLabel');
    $('#order-contact').href = EMAIL_RE.test(catalog?.contact || '') ? `mailto:${catalog.contact}` : '/termeni';
    if (catalog?.contact) $('#contact-link').href = `mailto:${catalog.contact}`;
    document.querySelectorAll('[data-i18n-ph]').forEach((n) => { n.placeholder = tr(n.dataset.i18nPh); });
    document.querySelectorAll('[data-i18n-aria]').forEach((n) => n.setAttribute('aria-label', tr(n.dataset.i18nAria)));
    const btn = $('#ui-lang');
    btn.textContent = ui === 'ro' ? 'EN' : 'RO';
    btn.setAttribute('aria-label', ui === 'ro' ? 'Change language to English' : 'Schimbă limba în română');
    renderConnection();
    renderVisibility();
    if (draftSaved) $('#draft-status').textContent = tr('draftSaved');
    if (catalog) { buildTrackFilters(); renderLibrary(); renderWatchButton(); }
  }

  // ---------- utilitare DOM ----------
  function el(tag, attrs = {}, ...children) {
    const node = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs)) {
      if (v == null || v === false) continue;
      if (k === 'class') node.className = v;
      else if (k === 'text') node.textContent = v;
      else node.setAttribute(k, v === true ? '' : v);
    }
    for (const c of children.flat()) if (c != null && c !== false) node.append(c instanceof Node ? c : document.createTextNode(String(c)));
    return node;
  }

  function show(name) {
    views.forEach((v) => { $(`#view-${v}`).hidden = v !== name; });
    if (name !== 'form') {
      const heading = document.querySelector(`#view-${name} h1, #view-${name} h2`);
      if (heading) { heading.tabIndex = -1; heading.focus({ preventScroll: true }); }
    }
    window.scrollTo({ top: 0 });
  }

  function toast(msg) {
    const tst = $('#toast');
    tst.textContent = msg;
    tst.hidden = false;
    clearTimeout(toast.t);
    toast.t = setTimeout(() => { tst.hidden = true; }, 2200);
  }

  const label = (list, id, lang = ui) => (list.find((x) => x.id === id) || {})[lang] || id;
  const hostOf = (u) => { try { return new URL(u).hostname.replace(/^www\./, ''); } catch { return ''; } };
  const fmtDate = (iso, lang = ui) => new Date(iso).toLocaleDateString(lang === 'en' ? 'en-GB' : 'ro-RO', { day: 'numeric', month: 'long', year: 'numeric' });
  const fmtShort = (iso, lang = ui) => new Date(iso).toLocaleDateString(lang === 'en' ? 'en-GB' : 'ro-RO', { day: 'numeric', month: 'short', year: 'numeric' });

  async function api(url, opts) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 15000);
    try {
      let res;
      try { res = await fetch(url, { ...opts, signal: controller.signal }); }
      catch { throw Object.assign(new Error(tr('network')), { network: true }); }
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw Object.assign(new Error(data.error || tr('network')), { status: res.status });
      return data;
    } finally { clearTimeout(timeout); }
  }

  function visitEvent(payload) {
    return fetch('/api/form-visits', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload), keepalive: true,
    });
  }

  // ---------- jurnalul accesărilor (tabelul „Accesări”, doar pentru administrator) ----------
  // Un identificator aleator al vizitei, păstrat cât fila e deschisă (sessionStorage). O vizită nouă începe după
  // 30 de minute de inactivitate sau 2 ore. La începutul vizitei se trimite și sursa (utm_source sau site-ul anterior).
  let visitMemory = null; // când sessionStorage nu e disponibil
  function visitId() {
    const now = Date.now();
    let v = visitMemory;
    try { v = JSON.parse(sessionStorage.getItem('nostra.visit') || 'null') || v; } catch { /* stocare indisponibilă */ }
    const fresh = !v || !/^[a-f0-9]{32}$/.test(v.id || '') || now - v.started > 2 * 3600000 || now - v.last > 30 * 60000;
    if (fresh) v = { id: Array.from(crypto.getRandomValues(new Uint8Array(16)), (b) => b.toString(16).padStart(2, '0')).join(''), started: now };
    visitMemory = { id: v.id, started: v.started, last: now };
    try { sessionStorage.setItem('nostra.visit', JSON.stringify(visitMemory)); } catch { /* stocare indisponibilă */ }
    return { id: v.id, fresh };
  }
  function trackVisit(payload) {
    const { id, fresh } = visitId();
    const body = { id, ...payload };
    if (fresh) {
      const params = new URLSearchParams(location.search);
      body.utm = params.get('utm_source') || (params.has('fbclid') ? 'facebook' : params.has('gclid') ? 'google' : '');
      try { body.ref = document.referrer ? new URL(document.referrer).hostname : ''; } catch { body.ref = ''; }
    }
    fetch('/api/visit', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), keepalive: true }).catch(() => {});
  }

  function startFormVisit() {
    if (!catalog.formConversionEnabled) return;
    const bytes = crypto.getRandomValues(new Uint8Array(16));
    formVisit = Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join('');
    const device = matchMedia('(max-width: 640px)').matches ? 'mobile' : 'desktop';
    visitRegistration = visitEvent({ event: 'visit', id: formVisit, device }).catch(() => {});
  }

  async function recordDisplay(id, visit) {
    try {
      if (visit === formVisit) await visitRegistration;
      const result = await visitEvent({ event: 'display', id: visit });
      if (result.ok && sessionStore.get('visit-report-' + id) === visit) sessionStore.del('visit-report-' + id);
    } catch { /* Reîncercăm la următoarea afișare a raportului. */ }
  }

  // ---------- formular ----------
  // Domeniile din grila originală. Cataloagele extinse apar la „Alt domeniu”.
  const gridDomains = new Set(['economie', 'piete', 'tehnologie', 'politica', 'geopolitica', 'energie',
    'imobiliare', 'clima', 'sanatate', 'sport', 'stiinta', 'societate', 'divertisment', 'altul']);

  function buildForm() {
    const domains = $('#domains');
    const checkedDomain = currentDomain() || catalog.domains[0].id;
    domains.replaceChildren(...catalog.domains.filter(d => gridDomains.has(d.id)).map((d) => {
      const id = `d-${d.id}`;
      return el('div', { class: 'chip' },
        el('input', { type: 'radio', name: 'domain', id, value: d.id, checked: d.id === checkedDomain }),
        el('label', { for: id }, el('span', { class: 'ico', 'aria-hidden': 'true', text: d.icon }), d[ui]));
    }));
    const other = catalog.domains.filter(d => d.id === 'altul' || !gridDomains.has(d.id));
    $('#other-domain').replaceChildren(...other.map(d => el('option', { value: d.id, text: d[ui] })));
    selectDomain(checkedDomain);
    const checkedHorizon = (document.querySelector('input[name=horizon]:checked') || {}).value || '3m';
    $('#horizons').replaceChildren(...catalog.horizons.map((h) => {
      const id = `h-${h.id}`;
      return el('div', { class: 'seg' },
        el('input', { type: 'radio', name: 'horizon', id, value: h.id, checked: h.id === checkedHorizon }),
        el('label', { for: id, text: h[ui] }));
    }));
    const checkedEffort = currentEffort() || catalog.defaultEffort;
    $('#efforts').replaceChildren(...catalog.efforts.map((x) => {
      const id = `e-${x.id}`;
      return el('div', { class: 'seg' },
        el('input', { type: 'radio', name: 'effort', id, value: x.id, checked: x.id === checkedEffort }),
        el('label', { for: id, text: x[ui] }));
    }));
    renderEffortHint();
    const region = $('#region');
    const reg = region.value || 'global';
    region.replaceChildren(...catalog.regions.map((r) => el('option', { value: r.id, text: r[ui] })));
    region.value = reg;
    renderAdvancedSummary();
    renderExamples();
  }

  function currentEffort() {
    return (document.querySelector('input[name=effort]:checked') || {}).value;
  }

  function renderEffortHint() {
    const x = catalog.efforts.find((e) => e.id === currentEffort());
    $('#effort-hint').textContent = x ? x[ui === 'en' ? 'hintEn' : 'hintRo'] : '';
    if (catalog.payment?.required) $('#effort-hint').append(` ${tr('fixedPrice')(catalog.payment.price)}`);
    renderAdvancedSummary();
  }

  function renderAdvancedSummary() {
    if (!catalog) return;
    const answer = $('#lang');
    $('#advanced-summary').textContent = `${label(catalog.efforts, currentEffort())} · ${answer.selectedOptions[0]?.textContent || answer.value}`;
  }

  function currentDomain() {
    const selected = document.querySelector('input[name=domain]:checked')?.value;
    return selected === 'altul' ? $('#other-domain').value || selected : selected;
  }

  function selectDomain(id) {
    const gridId = gridDomains.has(id) ? id : 'altul';
    const radio = document.getElementById('d-' + gridId);
    if (!radio) return;
    radio.checked = true;
    $('#other-domain').value = gridId === 'altul' ? id : 'altul';
    $('#other-domains').hidden = gridId !== 'altul';
  }

  function renderExamples() {
    const box = $('#examples');
    box.replaceChildren();
    (tr('examplesBy')[currentDomain()] || []).forEach((text) => {
      const b = el('button', { type: 'button', class: 'example', text });
      b.addEventListener('click', () => {
        const q = $('#question');
        q.value = text;
        q.dispatchEvent(new Event('input', { bubbles: true }));
        q.focus();
      });
      box.append(b);
    });
  }

  function renderVisibility() {
    $('#visibility-status').textContent = tr($('#private').checked ? 'privateNotice' : 'publicNotice');
  }

  async function startPrediction(body) {
    saveDraft(body);
    const { consent, ...screenBody } = body;
    const res = await api('/api/predict', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ...screenBody, email: catalog.emailRequired ? screenBody.email : undefined, delivery: 'screen', ui, visit: visitId().id }),
    });
    setConnection('connected');
    if (res.etaSec) { eta = res.etaSec; sessionStore.set('eta', String(eta)); }
    if (formVisit && !$('#view-form').hidden) sessionStore.set('visit-report-' + res.id, formVisit);
    library.pending(res.id, body);
    history.pushState({}, '', `/p/${res.id}`);
    follow(res.id);
  }

  function renderOrder() {
    const state = NostraLibrary.orderPresentation(orderState);
    const title = tr(state.title);
    $('#order-title').textContent = title;
    document.title = title + ' — Nostradamus';
    $('#order-message').textContent = state.message ? tr(state.message) : '';
    $('#order-connection').hidden = !orderState.interrupted;
    $('#order-connection').textContent = orderState.interrupted ? tr('orderOffline') : '';
    $('#order-contact').hidden = !state.contact;
    $('#order-refresh').hidden = !state.retryStatus;
    const link = $('#order-report');
    link.hidden = !state.canOpen;
    if (state.canOpen) link.href = '/p/' + encodeURIComponent(orderState.predictionId);
    else link.removeAttribute('href');
    return state;
  }

  async function confirmPayment(orderId) {
    const version = followVersion;
    orderState = {};
    renderOrder();
    show('order');
    let interval = 1500;
    $('#order-refresh').onclick = refresh;
    async function refresh() {
      clearTimeout(orderTimer);
      $('#order-refresh').disabled = true;
      try {
        const state = await api(`/api/orders/${encodeURIComponent(orderId)}/confirm`, {
          method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ui }),
        });
        if (version !== followVersion) return;
        orderState = state;
        if (state.predictionId && ['paid', 'done'].includes(state.status)) {
          sessionStore.set('delivery-' + state.predictionId, orderId);
          const visit = sessionStore.get('visit-order-' + orderId);
          if (visit && sessionStore.set('visit-report-' + state.predictionId, visit)) sessionStore.del('visit-order-' + orderId);
        }
      } catch (ex) {
        if (version !== followVersion) return;
        orderState.interrupted = ex.status !== 404;
        orderState.unavailable = ex.status === 404;
      }
      $('#order-refresh').disabled = false;
      if (renderOrder().finished) return;
      orderTimer = setTimeout(refresh, interval);
      interval = Math.min(interval * 1.5, 15000);
    }
    await refresh();
  }

  function restoreForm() {
    let body = null;
    try { body = JSON.parse(sessionStore.get('form') || 'null'); } catch { /* ignorăm */ }
    if (!body || typeof body !== 'object') return;
    restoringDraft = true;
    const check = (name, value) => { const i = [...document.getElementsByName(name)].find(input => input.value === value); if (i) i.checked = true; };
    if (catalog.domains.some(d => d.id === body.domain)) selectDomain(body.domain);
    check('horizon', body.horizon);
    check('effort', body.effort);
    if (body.region) $('#region').value = body.region;
    if (body.lang) { $('#lang').value = body.lang; answerLangChosen = true; }
    $('#question').value = body.question || '';
    $('#question').dispatchEvent(new Event('input'));
    $('#private').checked = body.visibilityChoice !== 'public';
    renderVisibility();
    if (body.email) $('#email').value = body.email;
    $('#consent').checked = false;
    $('#advanced-options').open = body.advancedOpen === true;
    renderExamples();
    renderEffortHint();
    restoringDraft = false;
    draftSaved = true;
    $('#draft-status').textContent = tr('draftSaved');
    $('#reset-form').hidden = false;
  }

  function formBody() {
    return {
      consent: $('#consent').checked, email: $('#email').value.trim(),
      domain: currentDomain(), horizon: document.querySelector('input[name=horizon]:checked')?.value,
      region: $('#region').value, lang: $('#lang').value, question: $('#question').value.trim(),
      private: $('#private').checked, effort: currentEffort(),
    };
  }

  function saveDraft(body = formBody()) {
    if (!catalog || restoringDraft) return;
    draftSaved = sessionStore.set('form', JSON.stringify({ ...body, consent: undefined, visibilityChoice: body.private === false ? 'public' : 'unlisted', advancedOpen: $('#advanced-options').open }));
    $('#draft-status').textContent = tr(draftSaved ? 'draftSaved' : 'draftUnavailable');
    $('#reset-form').hidden = !draftSaved;
  }

  async function onSubmit(e) {
    e.preventDefault();
    if (submitting) return;
    saveDraft();
    const err = $('#form-error');
    err.hidden = true;
    $('#email-error').hidden = true;
    const email = $('#email').value.trim();
    const problem = email ? 'emailInvalid' : 'screenEmailMissing';
    if (catalog?.emailRequired !== false && !EMAIL_RE.test(email)) {
      err.textContent = tr(problem); err.hidden = false;
      $('#email').focus();
      return;
    }
    setSubmitting(true);
    try {
      await startPrediction(formBody());
    } catch (ex) {
      if (ex.network) setConnection(navigator.onLine === false ? 'offline' : 'reconnecting');
      err.textContent = ex.message;
      err.hidden = false;
    } finally {
      setSubmitting(false);
    }
  }

  function setSubmitting(value) {
    submitting = value;
    for (const id of ['submit', 'submit-email', 'result-submit-email']) $(`#${id}`).disabled = value;
  }

  async function submitEmail(fromResult = false) {
    if (submitting || !catalog?.payment?.required) return;
    const rec = fromResult ? current : null;
    if (fromResult && (!rec || rec.example || rec.prediction.declined)) return;
    const prefix = fromResult ? 'result-' : '';
    const email = $(`#${prefix}email`).value.trim();
    const consent = $(`#${prefix}consent`).checked;
    const error = $(fromResult ? '#result-email-error' : '#email-error');
    error.hidden = true;
    if (!fromResult) $('#form-error').hidden = true;
    const problem = !email ? 'emailMissing' : !EMAIL_RE.test(email) ? 'emailInvalid' : !consent ? 'consentMissing' : null;
    if (problem) {
      error.textContent = tr(problem); error.hidden = false;
      $(`#${prefix}${problem === 'consentMissing' ? 'consent' : 'email'}`).focus();
      return;
    }
    setSubmitting(true);
    if (!fromResult) saveDraft();
    try {
      const res = await api(fromResult ? `/api/p/${encodeURIComponent(rec.id)}/upgrade` : '/api/predict', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...(fromResult ? {} : formBody()), delivery: 'email', email, consent, ui, visit: visitId().id }),
      });
      if (!res.checkoutUrl) throw new Error(tr('network'));
      if (!fromResult && formVisit) sessionStore.set('visit-order-' + res.orderId, formVisit);
      setConnection('connected'); toast(tr('toPayment'));
      location.assign(res.checkoutUrl);
    } catch (ex) {
      if (ex.network) setConnection(navigator.onLine === false ? 'offline' : 'reconnecting');
      error.textContent = ex.message; error.hidden = false;
    } finally { setSubmitting(false); }
  }

  // ---------- progres ----------
  function startTimer() {
    const started = Date.now();
    clearInterval(timer);
    const tick = () => {
      const s = Math.floor((Date.now() - started) / 1000);
      const clock = `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
      $('#elapsed').textContent = clock;
      // Bara se apropie de capăt fără să-l atingă; „aproape gata” după durata obișnuită.
      $('#eta-bar').style.width = `${Math.min(96, (s / eta) * 90)}%`;
      const left = Math.ceil((eta - s) / 60);
      $('#eta-text').textContent = s < eta ? tr('etaLeft')(left) : tr('etaAlmost');
      document.title = `⏳ ${clock} · Nostradamus`;
    };
    tick();
    timer = setInterval(tick, 1000);
  }

  function logLine(icon, text, cls) {
    const log = $('#log');
    log.append(el('li', { class: cls }, el('span', { class: 'k', 'aria-hidden': 'true', text: icon }), el('span', { text })));
    while (log.children.length > 14) log.firstElementChild.remove();
  }

  // Notificare în browser când previziunea e gata (doar dacă utilizatorul a cerut-o și pagina nu e în față).
  let wantNotify = false;
  function setupNotify() {
    const btn = $('#notify');
    const supported = 'Notification' in window && Notification.permission !== 'denied';
    btn.hidden = !supported;
    btn.disabled = false;
    btn.textContent = tr(wantNotify ? 'notifyOn' : 'notify');
  }

  function notifyDone(title, id) {
    if (!wantNotify || !document.hidden || !('Notification' in window) || Notification.permission !== 'granted') return;
    const n = new Notification(tr('readyTitle'), { body: title, icon: '/icons/icon-192.png', tag: id });
    n.onclick = () => { window.focus(); n.close(); };
  }

  function follow(id) {
    if (source) source.close();
    clearInterval(connectionTimer);
    clearInterval(timer);
    const version = ++followVersion;
    currentPredictionId = id;
    const active = () => version === followVersion;
    show('progress');
    $('#log').replaceChildren();
    $('#phase').textContent = tr('preparing');
    $('#progress-sub').textContent = '';
    setupNotify();
    let searches = 0;
    let settled = false;
    let gotEvent = false;

    const stream = new EventSource(`/api/predict/${encodeURIComponent(id)}/events?ui=${ui}`);
    source = stream;
    const finishStream = () => {
      stream.close(); clearInterval(timer); clearInterval(connectionTimer); connectionTimer = null;
    };
    const recover = async () => {
      if (!active() || settled || navigator.onLine === false) return;
      try {
        const status = await api(`/api/predict/${encodeURIComponent(id)}/status?ui=${ui}`);
        if (!active() || settled) return;
        if (status.status === 'done') {
          settled = true; finishStream(); setConnection('connected'); loadPrediction(id, true);
        } else if (status.status === 'error') {
          settled = true; finishStream(); library.failed(id); setConnection('connected'); fail(status.message);
        } else if (stream.readyState === EventSource.CLOSED) follow(id);
      } catch (ex) {
        if (!active() || settled) return;
        if (ex.status === 404) { settled = true; finishStream(); library.failed(id); setConnection('connected'); fail(tr('missing')); }
      }
    };
    stream.addEventListener('open', () => {
      if (!active()) return;
      setConnection('connected');
      clearInterval(connectionTimer); connectionTimer = null;
      searches = 0;
      $('#log').replaceChildren(); // la reconectare serverul retransmite evenimentele
    });
    stream.addEventListener('status', (e) => {
      if (!active()) return;
      if (!gotEvent) { gotEvent = true; show('progress'); startTimer(); }
      const d = JSON.parse(e.data);
      $('#phase').textContent = tr('phases')[d.phase] || tr('phases').research;
      if (d.phase === 'queued') $('#progress-sub').textContent = tr('queuePos')(d.position);
      else if (d.phase === 'research') $('#progress-sub').textContent = '';
    });
    stream.addEventListener('search', (e) => {
      if (!active()) return;
      searches++;
      logLine('🔎', tr('searching')(JSON.parse(e.data).query));
      $('#progress-sub').textContent = tr('searches')(searches);
    });
    stream.addEventListener('results', (e) => {
      if (!active()) return;
      const d = JSON.parse(e.data);
      $('#progress-sub').textContent = `${tr('searches')(searches)} · ${tr('found')(d.sources)}`;
    });
    stream.addEventListener('fetch', (e) => { if (active()) logLine('📖', tr('reading')(JSON.parse(e.data).host)); });
    stream.addEventListener('thought', (e) => { if (active()) logLine('💭', JSON.parse(e.data).text, 'thought'); });
    stream.addEventListener('done', (e) => {
      if (!active() || settled) return;
      settled = true;
      finishStream(); setConnection('connected');
      loadPrediction(JSON.parse(e.data).id, gotEvent);
    });
    stream.addEventListener('error', (e) => {
      if (!active() || settled) return;
      // Eveniment „error” trimis de server (cu mesaj) sau eroare de conexiune (fără date).
      if (e.data) {
        settled = true;
        finishStream(); library.failed(id); setConnection('connected');
        fail(JSON.parse(e.data).message);
      } else if (!settled) {
        setConnection(navigator.onLine === false ? 'offline' : 'reconnecting');
        if (!connectionTimer) { connectionTimer = setInterval(recover, 5000); recover(); }
      }
    });
  }

  function fail(msg) {
    $('#error-msg').textContent = msg;
    document.title = tr('defaultTitle');
    show('error');
  }

  // ---------- rezultat ----------
  async function loadPrediction(id, fresh = false) {
    try {
      const rec = await api(`/api/p/${encodeURIComponent(id)}?ui=${ui}`, { cache: 'no-store' });
      if (location.pathname.replace(/\/$/, '') !== `/p/${id}`) return;
      setConnection('connected');
      current = rec;
      renderPrediction(rec);
      library.remember(rec);
      setupShare(rec);
      show('result');
      const visit = sessionStore.get('visit-report-' + id);
      if (visit && !rec.prediction.declined) recordDisplay(id, visit);
      trackVisit({ step: 'report', detail: id });
      document.title = `${rec.prediction.title || 'Nostradamus'} — Nostradamus`;
      if (fresh) notifyDone(rec.prediction.title, id);
    } catch (ex) {
      if (location.pathname.replace(/\/$/, '') !== `/p/${id}`) return;
      if (ex.network) setConnection(navigator.onLine === false ? 'offline' : 'reconnecting');
      fail(ex.message);
    }
  }

  function card(title, ...content) {
    return el('section', { class: 'card' }, title ? el('h3', { text: title }) : null, ...content);
  }

  function confidenceDots(level, t) {
    const n = { low: 1, medium: 2, high: 3 }[level] || 2;
    return el('span', { class: 'conf' }, `${t.confidence}: ${t.conf[level] || level}`,
      el('span', { class: 'dots', 'aria-hidden': 'true' }, [1, 2, 3].map((i) => el('i', { class: i <= n ? 'on' : null }))));
  }

  /** Rezultatul verificării unei afirmații: în așteptare, adevărată, falsă sau nelămurită. */
  function checkBadge(c, t, lang) {
    if (!c) return null;
    const icon = { pending: '⏳', true: '✓', false: '✗', unresolved: '…' }[c.status] || '⏳';
    const text = c.status === 'pending' ? `${t.check.pending} ${fmtDate(c.resolveBy, lang)}` : t.check[c.status];
    return el('div', { class: `check check-${c.status}` },
      el('span', { class: 'check-label' }, el('span', { 'aria-hidden': 'true', text: `${icon} ` }), text),
      c.evidence ? el('span', { class: 'check-evidence', text: c.evidence }) : null,
      c.url ? el('a', { href: c.url, target: '_blank', rel: 'noopener noreferrer nofollow', text: `${t.source}: ${hostOf(c.url)}` }) : null);
  }

  /** Evoluția scenariului de bază pentru aceeași întrebare, plus butonul de actualizare. */
  function historyCard(rec, t, lang) {
    const rows = (rec.history || []).filter((h) => h.base).map((h) => {
      const bar = el('b');
      bar.style.width = `${h.base.probability}%`;
      const isThis = h.id === rec.id;
      return el('li', { class: isThis ? 'this' : null },
        isThis ? el('span', { class: 'h-date', text: `${fmtShort(h.createdAt, lang)} (${t.thisOne})` })
          : el('a', { class: 'h-date', href: `/p/${h.id}`, 'data-nav': true, text: fmtShort(h.createdAt, lang) }),
        el('span', { class: 'bar' }, bar),
        el('span', { class: 'pct', text: `${h.base.probability}%` }));
    });
    let refresh = null;
    if (rec.refreshable && !rec.prediction.declined) {
      refresh = el('button', { type: 'button', class: 'btn-ghost btn-compact', text: t.refresh });
      refresh.addEventListener('click', async () => {
        refresh.disabled = true;
        try {
          const { domain, horizon, region, lang: l, question, effort } = rec.request;
          const email = $('#email').value.trim();
          const body = { domain, horizon, region, lang: l, question, effort, private: rec.request.private === true, email };
          if (catalog.emailRequired && !EMAIL_RE.test(email)) {
            saveDraft(body);
            history.pushState({}, '', '/?refresh=1');
            route(); restoreForm(); $('#email').focus();
            $('#form-error').textContent = tr(email ? 'emailInvalid' : 'screenEmailMissing');
            $('#form-error').hidden = false;
            return;
          }
          await startPrediction(body);
        } catch (ex) {
          toast(ex.message);
          refresh.disabled = false;
        }
      });
    }
    if (!rows.length && !refresh) return null;
    return card(rows.length ? t.history : null,
      rows.length ? el('p', { class: 'muted', text: t.historyHint }) : null,
      rows.length ? el('ul', { class: 'history' }, rows) : null,
      refresh);
  }

  function foldCard(title, ...content) {
    return el('details', { class: 'card forecast-details' },
      el('summary', {}, el('span', { class: 'detail-title', text: title })),
      el('div', { class: 'detail-content' }, ...content));
  }

  const sourceKey = (url) => {
    try { const parsed = new URL(url); parsed.hash = ''; return parsed.href.replace(/\/$/, ''); }
    catch { return url; }
  };

  function sourceJump(text) {
    const link = el('a', { href: '#forecast-sources', class: 'source-jump', text });
    link.addEventListener('click', (event) => {
      event.preventDefault();
      const sources = $('#forecast-sources');
      if (!sources) return;
      sources.open = true;
      sources.scrollIntoView({ block: 'start' });
      sources.querySelector('summary').focus({ preventScroll: true });
    });
    return link;
  }

  function renderPrediction(rec) {
    const { request: rq, prediction: p, meta } = rec;
    const lang = rq.lang === 'en' ? 'en' : 'ro';
    const t = L[lang];
    const root = $('#result');
    // La alt rezultat închidem opțiunile și cerem din nou acordul de livrare.
    const tools = $('#result-tools');
    if (tools.dataset.prediction !== rec.id) {
      $('#result-email-form').reset();
      $('#result-email-options').hidden = true;
      $('#email-result').setAttribute('aria-expanded', 'false');
      $('#result-email-error').hidden = true;
      $('#share-options').open = false;
      tools.dataset.prediction = rec.id;
    }
    root.replaceChildren();
    if (rec.example) root.append(el('aside', { class: 'card example-banner' }, el('strong', { text: tr('exampleLabel') }), el('p', { text: tr('exampleNote') })));

    const dom = catalog.domains.find((d) => d.id === rq.domain);
    const tags = el('div', { class: 'r-tags' },
      el('span', { class: 'tag', text: `${dom ? dom.icon : ''} ${label(catalog.domains, rq.domain, lang)}` }),
      el('span', { class: 'tag', text: `${t.horizon}: ${label(catalog.horizons, rq.horizon, lang)}` }),
      el('span', { class: 'tag', text: label(catalog.regions, rq.region, lang) }),
      rq.effort ? el('span', { class: 'tag', text: `${t.effort}: ${label(catalog.efforts, rq.effort, lang).toLowerCase()}` }) : null,
      rq.private ? el('span', { class: 'tag', text: `🔒 ${t.privateTag}` }) : null,
      meta.tier === 'lite' ? el('span', { class: 'tag', title: t.liteNote, text: `⚡ ${t.liteTag}` }) : null);

    if (p.declined) {
      root.append(el('section', { class: 'card declined' }, tags, el('h1', { text: t.declinedTitle }), el('p', { text: p.declined_reason || p.summary }),
        rec.refunded ? el('p', { class: 'muted', text: tr('refundedNote') }) : null));
      return;
    }

    root.append(el('section', { class: 'card r-head' },
      tags,
      el('h1', { text: p.title }),
      rq.question ? el('p', { class: 'muted', text: `„${rq.question}”` }) : null,
      el('p', { class: 'r-summary', text: p.summary }),
      confidenceDots(p.confidence, t)));

    // Numerotare comună pentru trimiterile pe afirmații și lista generală, fără asocieri deduse.
    const sourceMap = new Map();
    for (const source of [...p.sources, ...p.predictions.flatMap(claim => claim.sources || [])]) {
      if (!sourceMap.has(sourceKey(source.url))) sourceMap.set(sourceKey(source.url), source);
    }
    const sources = [...sourceMap.values()];
    const missing = p.predictions.filter(claim => !claim.sources?.length).length;


    if (p.predictions.length) {
      root.append(card(t.predictions, el('ul', { class: 'preds' }, p.predictions.map((x, i) => {
        const ring = el('div', { class: 'ring', role: 'img', 'aria-label': `${x.probability}%` }, el('span', { text: `${x.probability}%` }));
        ring.style.setProperty('--p', x.probability);
        const details = el('details', { class: 'claim-details' },
          el('summary', { text: t.claimDetails }),
          el('div', { class: 'detail-content' },
            el('p', { class: 'pred-why', text: x.rationale }),
            x.resolution_criteria ? el('p', { class: 'pred-why' }, el('strong', { text: `${t.resolutionCriteria}: ` }), x.resolution_criteria) : null));
        return el('li', { class: 'pred', id: `claim-${i + 1}` }, ring, el('div', {},
          el('p', { class: 'pred-claim' }, el('span', { class: 'claim-number', text: `#${i + 1} ` }), x.claim),
          el('p', { class: 'pred-meta', text: [x.timeframe, `${t.conf1}: ${t.conf[x.confidence]}`].filter(Boolean).join(' · ') }),
          checkBadge((rec.checks || [])[i], t, lang),
          (x.sources || []).length
            ? el('div', { class: 'claim-evidence' }, el('strong', { class: 'hint', text: t.claimSources }), sourceList(x.sources, t, lang, sources))
            : el('p', { class: 'hint missing-claim-sources' }, t.noClaimSources, sources.length ? [' ', sourceJump(t.generalSources)] : null),
          details));
      }))));
    }

    if (missing) root.append(el('aside', { class: 'card evidence-notice' },
      el('p', { text: t.missingSources(missing) }), sources.length ? sourceJump(t.sources) : null));

    if (p.scenarios.length) {
      root.append(foldCard(t.scenarios, el('div', { class: 'scenarios' }, p.scenarios.map((s) => {
        const bar = el('b');
        bar.style.width = `${s.probability}%`;
        return el('div', { class: 'scenario' },
          el('div', { class: 'scenario-head' }, el('strong', { text: s.name }), el('span', { class: 'pct', text: `${s.probability}%` })),
          el('div', { class: 'bar', role: 'img', 'aria-label': `${s.probability}%` }, bar),
          el('p', { text: s.description }),
          s.signals.length ? el('ul', { class: 'signals' }, s.signals.map((x) => el('li', { text: x }))) : null);
      }))));
    }

    const hist = historyCard(rec, t, lang);
    if (hist) root.append(hist);
    if (p.current_state) root.append(foldCard(t.now, el('p', { class: 'text-block', text: p.current_state })));
    if (p.drivers.length) {
      root.append(foldCard(t.drivers, el('ul', { class: 'drivers' }, p.drivers.map((d) => el('li', { class: d.impact },
        el('strong', { text: d.name }), el('span', { class: 'imp', text: t.imp[d.impact] }), el('p', { text: d.explanation }))))));
    }
    if (p.watch.length) root.append(foldCard(t.watch, el('ul', { class: 'plain' }, p.watch.map((w) => el('li', {}, w.indicator, w.when ? el('div', { class: 'when', text: w.when }) : null)))));
    if (p.wildcards.length) root.append(foldCard(t.wildcards, el('ul', { class: 'plain' }, p.wildcards.map((w) => el('li', { text: w })))));

    if (sources.length) {
      const sourceCard = foldCard(t.sources, el('p', { class: 'hint', text: t.sourcesHint }),
        el('ol', { class: 'sources' }, sources.map((s, i) => {
          const claims = p.predictions.flatMap((claim, index) => (claim.sources || []).some(ref => sourceKey(ref.url) === sourceKey(s.url)) ? [index + 1] : []);
          return el('li', { id: `source-${i + 1}` },
            el('a', { href: s.url, target: '_blank', rel: 'noopener noreferrer nofollow', text: s.title || hostOf(s.url) }),
            el('span', { class: 'host', text: `${hostOf(s.url)} · ${sourceDate(s, t, lang)}` }),
            claims.length ? el('span', { class: 'source-claims' }, `${t.supportsClaims}: `, ...claims.map(n => el('a', { href: `#claim-${n}`, text: `#${n}` })))
              : el('span', { class: 'host', text: t.contextOnly }));
        })));
      sourceCard.id = 'forecast-sources';
      root.append(sourceCard);
    }
    if (p.quatrain) root.append(foldCard(t.quatrain, el('blockquote', { class: 'quatrain', text: p.quatrain })));
    if (!rec.example) root.append(el('p', { class: 'r-foot', text: [`${t.made} ${fmtDate(rec.createdAt, lang)}`, t.research(meta.searches || 0, meta.consulted || 0), meta.tier === 'lite' ? t.liteNote : ''].filter(Boolean).join(' · ') }));
  }

  function sourceDate(s, t, lang) {
    return s.published_at ? `${t.published} ${fmtDate(s.published_at, lang)}` : t.dateUnknown;
  }

  function sourceList(sources, t, lang, allSources = []) {
    return el('ul', { class: 'claim-sources' }, sources.map(s => {
      const number = allSources.findIndex(source => sourceKey(source.url) === sourceKey(s.url)) + 1;
      return el('li', {},
        el('a', { href: s.url, target: '_blank', rel: 'noopener noreferrer nofollow', text: `${number ? `[${number}] ` : ''}${s.title || hostOf(s.url)}` }),
        el('span', { class: 'muted', text: sourceDate(s, t, lang) }));
    }));
  }

  async function loadExample() {
    if (!catalog) return;
    const language = ui;
    try {
      const rec = await api(`/api/example?lang=${ui}`);
      if (location.pathname !== '/exemplu' || ui !== language) return;
      setConnection('connected');
      current = rec;
      renderPrediction(rec); setupShare(rec); show('result');
      document.title = `${tr('exampleLabel')} — Nostradamus`;
    } catch (ex) { if (location.pathname !== '/exemplu' || ui !== language) return; if (ex.network) setConnection('reconnecting'); fail(ex.message); }
  }

  function renderConnection() {
    $('#network-warning').hidden = networkState === 'connected';
    $('#network-message').textContent = networkState === 'connected' ? '' : tr(networkState === 'reconnecting' && !currentPredictionId ? 'connectionUnavailable' : networkState);
  }

  function setConnection(state) { networkState = state === 'connected' && navigator.onLine === false ? 'offline' : state; renderConnection(); }

  function renderWatchButton() {
    const button = $('#watch-result');
    button.hidden = !current || current.example || current.prediction.declined;
    const watched = current && library.get(current.id)?.watched;
    button.textContent = tr(watched ? 'unwatchQuestion' : 'watchQuestion');
    button.setAttribute('aria-pressed', String(!!watched));
    $('#watch-hint').hidden = button.hidden;
  }

  function renderLibrary() {
    if (!catalog) return;
    $('#library-all').setAttribute('aria-pressed', String(libraryFilter === 'all'));
    $('#library-watched').setAttribute('aria-pressed', String(libraryFilter === 'watched'));
    const entries = library.list().filter(e => libraryFilter !== 'watched' || e.watched);
    $('#personal-list').replaceChildren(...entries.map(e => {
      const followButton = el('button', { type: 'button', class: 'btn-small', text: tr(e.watched ? 'unwatchQuestion' : 'watchQuestion'), 'aria-pressed': String(e.watched) });
      followButton.addEventListener('click', () => { library.toggle(e.id); renderLibrary(); renderWatchButton(); });
      const remove = el('button', { type: 'button', class: 'btn-small', text: tr('removeHistory') });
      remove.addEventListener('click', () => { library.remove(e.id); renderLibrary(); renderWatchButton(); });
      const evolution = e.trend.length > 1 ? e.trend.map(p => `${p}%`).join(' → ') : e.base !== null ? `${e.base}%` : '';
      const state = e.status === 'pending' ? tr('pendingForecast') : e.status === 'error' ? tr('failedForecast') : tr('checkedCount')(e.resolved, e.total);
      return el('li', {}, el('a', { href: `/p/${e.id}`, 'data-nav': true, class: 'personal-title', text: e.title || label(catalog.domains, e.request.domain) }),
        el('p', { class: 'hint', text: [fmtShort(e.createdAt), e.request.private ? '🔒' : '', state].filter(Boolean).join(' · ') }),
        e.watched && e.nextCheck ? el('p', { class: 'hint', text: `${tr(e.checkedBefore ? 'nextCheckAfter' : 'firstCheckAfter')} ${fmtShort(e.nextCheck)}` }) : null,
        e.watched && e.resolved > e.seenResolved ? el('strong', { text: tr('newChecks')(e.resolved - e.seenResolved) }) : null,
        evolution ? el('p', { class: 'hint history-probability', text: `${tr('baseProbability')}: ${evolution}${e.baseName ? ` — ${e.baseName}` : ''}` }) : null,
        el('div', { class: 'personal-tools' }, followButton, remove));
    }));
    $('#personal-empty').hidden = entries.length > 0;
    $('#personal-empty').textContent = tr(libraryFilter === 'watched' ? 'watchedEmpty' : 'personalEmpty');
    if (!library.persistent) $('#library-status').textContent = tr('storageUnavailable');
  }

  async function refreshLibrary({ all = false } = {}) {
    if (libraryRefreshing) return;
    libraryRefreshing = true;
    $('#library-refresh').disabled = true;
    const entries = library.list().filter(e => all || e.watched || e.status === 'pending');
    const outcomes = await Promise.allSettled(entries.map(async entry => {
      let rec;
      try { rec = await api(`/api/p/${entry.id}?ui=${ui}`, { cache: 'no-store' }); }
      catch (ex) {
        if (ex.status !== 404) throw ex;
        try {
          const status = await api(`/api/predict/${entry.id}/status?ui=${ui}`);
          if (status.status === 'error') library.failed(entry.id);
        } catch (statusError) {
          if (statusError.status === 404) library.failed(entry.id);
          else throw statusError;
        }
        return;
      }
      const latest = !rec.request.private && entry.watched ? rec.history?.at(-1)?.id : null;
      if (latest && latest !== rec.id) rec = await api(`/api/p/${latest}?ui=${ui}`, { cache: 'no-store' });
      // O eliminare făcută în timpul actualizării nu trebuie anulată de răspunsul întârziat.
      if (library.get(entry.id)) library.remember(rec, { viewed: false });
    }));
    libraryRefreshing = false;
    $('#library-refresh').disabled = false;
    renderLibrary(); renderWatchButton();
    $('#library-status').textContent = !library.persistent ? tr('storageUnavailable') : outcomes.some(o => o.status === 'rejected') ? tr('historyOffline') : entries.length ? tr('historyUpdated') : '';
  }

  function buildTrackFilters() {
    const fill = (selector, values) => {
      const select = $(selector);
      const value = select.value;
      select.replaceChildren(...values.map(([id, name]) => el('option', { value: id, text: name })));
      select.value = value;
      if (select.selectedIndex < 0) select.value = '';
    };
    fill('#track-domain', [['', tr('allDomains')], ...catalog.domains.map(d => [d.id, d[ui]])]);
    fill('#track-horizon', [['', tr('allHorizons')], ...catalog.horizons.map(h => [h.id, h[ui]])]);
    fill('#track-tier', [['', tr('allModels')], ['main', tr('mainModel')], ['lite', tr('liteModel')]]);
  }

  // ---------- distribuire ----------
  function renderEmailAction() {
    const orderId = current && sessionStore.get('delivery-' + current.id);
    const statusLink = $('#delivery-status-link');
    statusLink.hidden = !orderId;
    if (orderId) statusLink.href = '/pay/' + encodeURIComponent(orderId);
    const available = !orderId && catalog?.payment?.required && current && !current.example && !current.prediction.declined && current.meta?.tier === 'lite';
    $('#email-result').hidden = !available;
    if (!available) {
      $('#result-email-options').hidden = true;
      $('#email-result').setAttribute('aria-expanded', 'false');
    }
  }

  function setupShare(rec) {
    renderEmailAction();
    $('#share-options').hidden = !!rec.example;
    renderWatchButton();
    if (rec.example) { $('#share').hidden = true; return; }
    const url = `${location.origin}/p/${rec.id}`;
    const text = rec.prediction.title || 'Nostradamus';
    const enc = encodeURIComponent;
    $('#share-wa').href = `https://wa.me/?text=${enc(`${text} ${url}`)}`;
    $('#share-fb').href = `https://www.facebook.com/sharer/sharer.php?u=${enc(url)}`;
    $('#share-x').href = `https://x.com/intent/post?text=${enc(text)}&url=${enc(url)}`;
    $('#share-tg').href = `https://t.me/share/url?url=${enc(url)}&text=${enc(text)}`;
    $('#share').hidden = !navigator.share;
  }

  // ---------- palmares ----------
  async function loadTrack() {
    const request = ++trackRequest;
    const box = $('#track');
    const T = tr('track');
    try {
      const params = new URLSearchParams();
      for (const name of ['domain', 'horizon', 'tier']) if ($(`#track-${name}`).value) params.set(name, $(`#track-${name}`).value);
      const data = await api(`/api/track-record?${params}`);
      if (request !== trackRequest) return;
      if (!$('#view-form').hidden) setConnection('connected');
      if (!data.resolved) {
        box.replaceChildren(
          el('p', { text: tr('sampleSize')(0) }), el('p', { text: T.intro }),
          el('p', { class: 'muted', text: data.pending ? T.waiting(data.pending, fmtDate(data.nextCheck)) : T.none }));
        return;
      }
      const pct = Math.round((100 * data.correct) / data.resolved);
      const brier = ui === 'ro' ? String(data.brier).replace('.', ',') : String(data.brier);
      const stats = el('div', { class: 'stats' },
        el('div', { class: 'stat' }, el('strong', { text: `${pct}%` }), el('span', { text: T.correct(data.correct, data.resolved) })),
        el('div', { class: 'stat' }, el('strong', { text: brier }), el('span', { text: T.brier })),
        el('div', { class: 'stat' }, el('strong', { text: String(data.pending) }), el('span', { text: T.pending })));
      const rows = data.buckets.filter((b) => b.count).map((b) => {
        const bar = el('b');
        bar.style.width = `${b.actual}%`;
        return el('li', {}, el('span', { class: 'cal-range', text: T.said(b.range) }),
          el('span', { class: 'bar' }, bar),
          el('span', { class: 'cal-actual', text: T.happened(b.actual, b.count) }));
      });
      box.replaceChildren(stats,
        el('p', { class: 'hint', text: `${tr('sampleSize')(data.resolved)}${data.resolved < 30 ? ` ${tr('smallSample')}` : ''}` }),
        rows.length ? el('div', {}, el('h3', { text: T.calibration }), el('ul', { class: 'calibration' }, rows)) : null,
        data.recent.length ? el('div', {}, el('h3', { text: T.latest }), el('ul', { class: 'checked-list' }, data.recent.map((r) => el('li', {},
          el('span', { class: r.outcome ? 'ok' : 'ko', text: r.outcome ? '✓ ' : '✗ ' }),
          el('a', { href: `/p/${r.id}`, 'data-nav': true, text: r.claim }),
          el('span', { class: 'muted', text: ` — ${r.probability}%` }))))) : null);
    } catch {
      if (request === trackRequest) box.replaceChildren(el('p', { class: 'muted', text: tr('trackUnavailable') }));
    }
  }

  // ---------- recente ----------
  async function loadRecent() {
    try {
      const list = await api('/api/recent');
      $('#recent').replaceChildren(...list.map((r) => el('li', {}, el('a', { href: `/p/${r.id}`, 'data-nav': true },
        el('span', { class: 'r-title', text: r.title }),
        el('span', { class: 'r-meta', text: `${label(catalog.horizons, r.horizon)} · ${fmtShort(r.createdAt)}` })))));
      $('#recent-empty').hidden = list.length > 0;
    } catch { /* lista recentă e opțională */ }
  }

  // ---------- navigare ----------
  function route() {
    trackVisit({ path: location.pathname, lang: ui });
    if (source) { source.close(); source = null; }
    clearInterval(timer);
    clearInterval(connectionTimer); connectionTimer = null;
    followVersion++;
    clearTimeout(orderTimer);
    formVisit = null;
    currentPredictionId = null;
    const m = /^\/p\/([A-Za-z0-9_-]{8,32})\/?$/.exec(location.pathname);
    const pay = /^\/pay\/([A-Za-z0-9_-]{16,40})\/?$/.exec(location.pathname);
    if (location.pathname === '/exemplu') {
      loadExample();
    } else if (m) {
      if (new URLSearchParams(location.search).has('anulat')) {
        history.replaceState({}, '', location.pathname);
        toast(tr('payCanceled'));
      }
      follow(m[1]);
    } else if (pay) {
      confirmPayment(pay[1]);
    } else {
      if (new URLSearchParams(location.search).has('anulat')) {
        history.replaceState({}, '', '/');
        restoreForm();
        toast(tr('payCanceled'));
      }
      document.title = tr('defaultTitle');
      show('form');
      startFormVisit();
      renderLibrary(); refreshLibrary();
      loadTrack();
      loadRecent();
    }
  }

  document.addEventListener('click', (e) => {
    const a = e.target.closest('a[data-nav]');
    if (!a || e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return;
    e.preventDefault();
    if (!$('#view-form').hidden) saveDraft();
    history.pushState({}, '', a.getAttribute('href'));
    route();
  });
  window.addEventListener('popstate', route);

  $('#ui-lang').addEventListener('click', () => {
    ui = ui === 'ro' ? 'en' : 'ro';
    store.set('ui', ui);
    if (!answerLangChosen) $('#lang').value = ui;
    applyUi();
    if (catalog) buildForm();
    if (current && !current.example && !$('#view-result').hidden) renderPrediction(current);
    if (!$('#view-form').hidden) { loadTrack(); loadRecent(); document.title = tr('defaultTitle'); }
    if (!$('#view-order').hidden) renderOrder();
    if (!$('#view-progress').hidden) setupNotify();
    if (current?.example && location.pathname === '/exemplu') loadExample();
    saveDraft();
  });

  $('#notify').addEventListener('click', async () => {
    const perm = await Notification.requestPermission();
    wantNotify = perm === 'granted';
    $('#notify').textContent = tr(wantNotify ? 'notifyOn' : 'notify');
    $('#notify').disabled = wantNotify;
    if (perm === 'denied') $('#notify').hidden = true;
  });

  $('#copy-link').addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText(location.href);
      toast(tr('copied'));
    } catch {
      toast(location.href);
    }
  });

  for (const network of ['wa', 'fb', 'x', 'tg']) $(`#share-${network}`).addEventListener('click', () => trackVisit({ step: 'share', detail: network }));
  $('#share').addEventListener('click', () => {
    if (!current) return;
    trackVisit({ step: 'share', detail: 'sistem' });
    navigator.share({ title: current.prediction.title, url: `${location.origin}/p/${current.id}` }).catch(() => {});
  });

  $('#print').addEventListener('click', () => window.print());
  let printDetails = [];
  window.addEventListener('beforeprint', () => {
    if (printDetails.length) return;
    printDetails = [...document.querySelectorAll('#result details')].map(node => [node, node.open]);
    for (const [node] of printDetails) node.open = true;
  });
  window.addEventListener('afterprint', () => {
    for (const [node, open] of printDetails) node.open = open;
    printDetails = [];
  });
  $('#watch-result').addEventListener('click', () => {
    if (!current || current.example) return;
    library.remember(current); library.toggle(current.id); renderWatchButton(); renderLibrary();
    if (!library.persistent) toast(tr('storageUnavailable'));
  });
  $('#library-all').addEventListener('click', () => { libraryFilter = 'all'; renderLibrary(); });
  $('#library-watched').addEventListener('click', () => { libraryFilter = 'watched'; renderLibrary(); });
  $('#library-refresh').addEventListener('click', () => refreshLibrary({ all: true }));
  for (const name of ['domain', 'horizon', 'tier']) $(`#track-${name}`).addEventListener('change', loadTrack);
  $('#form').addEventListener('input', () => saveDraft());
  $('#form').addEventListener('change', () => { renderAdvancedSummary(); saveDraft(); });
  $('#advanced-options').addEventListener('toggle', () => { if (draftSaved) saveDraft(); });
  $('#reset-form').addEventListener('click', () => {
    sessionStore.del('form');
    $('#form').reset();
    selectDomain(catalog.domains[0].id);
    $('#email-options').open = false;
    for (const [name, value] of [['horizon', '3m'], ['effort', catalog.defaultEffort]]) {
      const radio = [...document.getElementsByName(name)].find(input => input.value === value);
      if (radio) radio.checked = true;
    }
    $('#region').value = 'global'; $('#form-error').hidden = true;
    $('#email-error').hidden = true;
    $('#question').value = ''; $('#qcount').textContent = '0/500'; $('#email').value = '';
    answerLangChosen = false; $('#lang').value = ui; $('#advanced-options').open = false;
    draftSaved = false; $('#draft-status').textContent = ''; $('#reset-form').hidden = true;
    renderEffortHint(); renderExamples(); renderVisibility();
  });
  $('#retry-connection').addEventListener('click', () => {
    if (!catalog) bootstrap();
    else route();
  });
  window.addEventListener('offline', () => { saveDraft(); setConnection('offline'); });
  window.addEventListener('online', () => {
    setConnection('connected');
    if (!catalog) bootstrap();
    else if (currentPredictionId && !$('#view-progress').hidden) follow(currentPredictionId);
    else if (!$('#view-form').hidden) { refreshLibrary(); loadTrack(); }
  });
  window.addEventListener('focus', () => { if (catalog && !$('#view-form').hidden) refreshLibrary(); });
  setInterval(() => { if (catalog && !document.hidden && !$('#view-form').hidden) refreshLibrary(); }, 60000);

  // ---------- aplicație instalabilă (PWA) ----------
  let installPrompt = null;
  window.addEventListener('beforeinstallprompt', (e) => {
    e.preventDefault();
    installPrompt = e;
    $('#install').hidden = false;
  });
  $('#install').addEventListener('click', async () => {
    if (!installPrompt) return;
    installPrompt.prompt();
    await installPrompt.userChoice.catch(() => {});
    installPrompt = null;
    $('#install').hidden = true;
  });
  window.addEventListener('appinstalled', () => { $('#install').hidden = true; });
  if ('serviceWorker' in navigator) {
    window.addEventListener('load', () => navigator.serviceWorker.register('/sw.js').catch(() => {}));
  }

  // ---------- pornire ----------
  $('#lang').value = ui;
  applyUi();
  $('#domains').addEventListener('change', (event) => {
    selectDomain(event.target.value);
    renderExamples();
  });
  $('#other-domain').addEventListener('change', renderExamples);
  $('#private').addEventListener('change', renderVisibility);
  $('#efforts').addEventListener('change', renderEffortHint);
  $('#lang').addEventListener('change', () => { answerLangChosen = true; renderAdvancedSummary(); });
  $('#question').addEventListener('input', () => { $('#qcount').textContent = `${$('#question').value.length}/500`; });
  $('#form').addEventListener('submit', onSubmit);
  $('#submit-email').addEventListener('click', () => submitEmail());
  $('#email-options').addEventListener('toggle', () => { if ($('#email-options').open) trackVisit({ step: 'deep_open' }); });
  $('#email-result').addEventListener('click', () => {
    const panel = $('#result-email-options');
    panel.hidden = !panel.hidden;
    $('#email-result').setAttribute('aria-expanded', String(!panel.hidden));
    if (!panel.hidden) {
      trackVisit({ step: 'deep_open', detail: current?.id });
      if (!$('#result-email').value) $('#result-email').value = $('#email').value.trim();
      panel.scrollIntoView({ block: 'nearest' });
      $('#result-email').focus({ preventScroll: true });
    }
  });
  $('#result-email-form').addEventListener('submit', (event) => { event.preventDefault(); submitEmail(true); });


  function bootstrap() {
    api('/api/catalog', { cache: 'no-cache' }).then((c) => {
      catalog = c; applyUi(); buildForm(); restoreForm();
      setConnection(navigator.onLine === false ? 'offline' : 'connected'); route();
    }).catch(() => { setConnection(navigator.onLine === false ? 'offline' : 'reconnecting'); fail(tr('loadFail')); });
  }
  bootstrap();
})();
