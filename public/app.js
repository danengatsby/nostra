'use strict';
// Interfața Nostradamus: formular → flux de progres (SSE) → previziune. Tot conținutul venit de la
// server este inserat cu textContent (niciodată ca HTML). Interfața e în română sau engleză.

(async () => {
  const $ = (sel) => document.querySelector(sel);
  // Un proces pornit înaintea actualizării poate servi încă șablonul HTML anterior.
  if (!$('#featured-verdict')) {
    try {
      const response = await fetch('/index.html', { cache: 'reload' });
      if (!response.ok) throw new Error('shell');
      const shell = new DOMParser().parseFromString(await response.text(), 'text/html');
      if (!shell.querySelector('#featured-verdict')) throw new Error('shell');
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
  let offlineCatalog = false;
  let loadingCatalog = false;
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
      checkOrder: 'Reverifică starea comenzii', advancedOptions: 'Opțiuni avansate', private: 'Previziune privată', otherDomains: 'Alege un domeniu sau scrie propria întrebare',
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
      tagline: 'Pune o întrebare. Primești scenarii cu probabilități și surse. Revino după termen pentru a vedea ce s-a adeverit.',
      publicVerdict: 'Ultima verificare publică', exampleVerdict: 'Cum se verifică o previziune',
      noPublicVerdict: 'Până la prima verificare publică, poți explora raportul fictiv și criteriile sale de verificare.',
      openEvidence: 'Citește sursa verdictului', calendar: 'Adaugă verificarea în calendar', calendarTitle: 'Verifică previziunea',
      viewExample: 'Vezi un raport exemplu', edit: 'Modifică', yourQuestion: 'Întrebarea ta', questionMin: 'Scrie cel puțin 5 caractere.', tryExample: 'Încearcă cu întrebarea ta', exploreDomain: 'Domeniu, regiune și perioadă',
      exampleChecks: 'Într-un raport real poți urmări întrebarea și reveni după termen pentru a vedea ce afirmații s-au adeverit și pe ce dovezi se bazează verdictul.',
      sharePrivate: 'Oricine primește linkul poate citi întrebarea și raportul.', viewProgress: 'Vezi progresul',
      declinedQuestion: 'Întrebare refuzată', rephrase: 'Reformulează', removedHistory: 'Raportul a fost eliminat din acest browser. Linkul rămâne valabil.', removedEntry: 'Întrebarea a fost eliminată din istoricul acestui browser.',
      createForecast: 'Creează o previziune', reloadReport: 'Reîncarcă raportul', reloadPage: 'Reîncarcă pagina',
      exampleLabel: 'Exemplu ilustrativ', exampleNote: 'Datele, instituțiile și sursele sunt fictive. Acest exemplu arată formatul rezultatului; nu este o prognoză actuală și nu necesită plată.',
      draftSaved: 'Formular salvat în această filă.', draftUnavailable: 'Browserul nu permite salvarea formularului.', clearDraft: 'Golește formularul',
      personalTitle: 'Istoricul meu', personalHint: 'Salvat în acest browser. Întrebările urmărite se actualizează când revii în aplicație.',
      historyAll: 'Toate', historyWatched: 'Întrebări urmărite', refreshChecks: 'Actualizează rezultatele', personalEmpty: 'Previziunile pe care le consulți vor apărea aici.', watchedEmpty: 'Urmărește o întrebare din pagina unei previziuni.',
      watchQuestion: 'Urmărește întrebarea', unwatchQuestion: 'Nu mai urmări', removeHistory: 'Elimină din istoricul meu', pendingForecast: 'În lucru', failedForecast: 'Previziune nereușită',
      watchHint: 'Urmărirea este salvată în acest browser. Verificăm actualizările când revii; nu trimitem notificări și nu generăm previziuni noi automat.',
      baseProbability: 'Probabilitatea scenariului de bază',
      checkedCount: (n, total) => `${n}/${total} afirmații verificate`, historyUpdated: 'Rezultatele au fost actualizate.', historyOffline: 'Actualizarea nu a reușit. Istoricul salvat rămâne disponibil.', storageUnavailable: 'Istoricul nu poate fi păstrat în acest browser.',
      allDomains: 'Toate domeniile', allHorizons: 'Toate perioadele', allModels: 'Toate modelele', modelFilter: 'Modelul', mainModel: 'Principal', liteModel: 'Rapid', smallSample: 'Eșantion mic: rezultatele pot varia mult.',
      retryConnection: 'Reîncearcă legătura', offline: 'Nu ai conexiune. Poți continua să completezi formularul; previziunile pornite continuă pe server.', reconnecting: 'Legătura cu serverul s-a întrerupt. Reîncercăm automat; previziunea continuă pe server.', connectionUnavailable: 'Legătura cu serverul s-a întrerupt. Poți reîncerca fără să reintroduci întrebarea.', trackUnavailable: 'Palmaresul nu a putut fi încărcat. Reîncearcă după restabilirea conexiunii.',
      install: 'Instalează aplicația', stepDomain: 'Domeniul', stepQuestion: 'Ce vrei să afli?', optional: '(opțional)',
      questionPh: 'Ex.: Va scădea inflația din România sub 5% până la finalul perioadei?', examples: 'Exemple de întrebări',
      questionHint: 'Poți lăsa întrebarea goală pentru o privire de ansamblu asupra domeniului ales.',
      stepHorizon: 'Perioada', region: 'Regiunea', answerLang: 'Limba răspunsului', effort: 'Efortul oracolului',
      publicNotice: 'Întrebarea și rezultatul vor fi publice și pot apărea în motoarele de căutare.',
      privateNotice: 'Accesibilă prin link. Ascunsă din lista publică și din motoarele de căutare.',
      fixedPrice: (p) => `Efortul ales se aplică previziunii rapide gratuite; analiza aprofundată (${p}) folosește mereu efortul înalt.`,
      submit: 'Generează gratuit', freeHint: minutes => `Raportul apare pe ecran în aproximativ ${minutes === 1 ? 'un minut' : minutes + ' minute'}.`,
      emailResult: (p) => `Analiză aprofundată — ${p}`,
      emailFee: (p) => `Plată unică: ${p}, fără abonament. Rezultatul apare pe ecran și îl primești și pe email.`,
      emailContinue: (p) => `Continuă către plată — ${p}`,
      emailExistingHint: 'Căutăm în mai multe surse și analizăm în detaliu aceeași întrebare. Raportul apare pe ecran și primești linkul pe email în aproximativ 2 minute. Dacă nu reușește, banii se returnează automat.',
      emailConfirmed: 'Emailul cu linkul previziunii a fost trimis.',
      payHint: (p) => `Căutăm în mai multe surse și analizăm în detaliu întrebarea. Raportul apare pe ecran și primești linkul pe email în aproximativ 2 minute. Plată unică de ${p} pe pagina securizată Stripe, fără abonament. Dacă analiza nu poate fi făcută, banii se returnează automat.`,
      toPayment: 'Te ducem la pagina de plată…', confirming: 'Confirmăm plata…',
      consent: 'Sunt de acord cu Termenii și confidențialitatea și cer furnizarea imediată a analizei aprofundate (pe ecran și pe email); înțeleg că, după furnizarea serviciului plătit, nu mai pot cere retragerea din contract.',
      readTerms: 'Citește termenii', termsLink: 'Termeni și confidențialitate', contact: 'Contact',
      screenEmail: 'Email (obligatoriu și pentru afișarea gratuită)',
      emailLabel: 'Adresa de email la care primești previziunea', emailPh: 'nume@exemplu.ro',
      emailMissing: 'Scrie adresa de email la care să primești previziunea.', emailInvalid: 'Adresa de email nu pare corectă.',
      consentMissing: 'Bifează acordul cu termenii înainte de plată.',
      payPending: 'Plata nu a fost confirmată încă. Dacă ai plătit, previziunea pornește automat — poți reveni la acest link.',
      payExpired: 'Plata nu a fost finalizată, iar pagina de plată a expirat. Nu ți s-a luat niciun ban.',
      payCanceled: 'Plata a fost anulată. Nu ți s-a luat niciun ban.',
      refundedNote: 'Plata pentru această previziune a fost returnată automat.',
      trackTitle: 'Palmaresul oracolului', loading: 'Se încarcă…', recentTitle: 'Previziuni recente',
      recentEmpty: 'Încă nu există previziuni. Fii primul care consultă oracolul.',
      preparing: 'Oracolul se pregătește…', notify: '🔔 Anunță-mă când e gata', notifyOn: '🔔 Te anunțăm când e gata',
      leaveHint: 'Poți lăsa pagina deschisă sau poți reveni mai târziu la același link: previziunea se termină oricum.',
      share: 'Distribuie', copyLink: 'Copiază linkul', pdf: 'Salvează PDF', newForecast: 'O nouă previziune',
      errorTitle: 'Oracolul a tăcut',
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
        counts: (n, pending) => `${n} ${n === 1 ? 'afirmație verificată' : 'afirmații verificate'} · ${pending} în așteptare`,
        verdict: (p, outcome) => `Estimat la ${p}% · ${outcome ? 'evenimentul s-a produs' : 'evenimentul nu s-a produs'}`,
        metrics: 'Rată de succes, scor Brier și calibrare', calibration: 'Calibrare', said: (r) => `Spus ${r}`, happened: (a, n) => `s-a întâmplat ${a}% (${n})`, latest: 'Ultimele verificări',
      },
      examplesBy: {
        general: [['Va scădea inflația din România sub 5%?', 'ro', 'economie'], ['Ce lansări importante în AI vor avea loc?', 'global', 'tehnologie']],
        economie: [['Va scădea inflația din România sub 5%?', 'ro'], ['Va intra zona euro în recesiune?', 'eu']],
        piete: [['Unde va fi cursul EUR/RON?', 'ro'], ['Va depăși Bitcoin maximul istoric?']],
        tehnologie: [['Ce lansări importante în AI vor avea loc?'], ['Cum va evolua piața smartphone-urilor?']],
        politica: [['Ce partid va obține cele mai multe voturi la următoarele alegeri parlamentare din România?', 'ro', 'politica', '5y'], ['Va rămâne coaliția actuală la guvernare în România?', 'ro']],
        geopolitica: [['Va exista un armistițiu în Ucraina?', 'ua'], ['Cum vor evolua relațiile SUA–China?', 'global']],
        energie: [['Cât va costa barilul de petrol Brent?'], ['Vor scădea facturile la energie în România?', 'ro']],
        imobiliare: [['Vor crește prețurile apartamentelor în București?', 'ro'], ['Vor scădea dobânzile la creditele ipotecare?']],
        clima: [['Va fi iarna mai caldă decât media?'], ['Va fi acest an cel mai cald înregistrat?']],
        sanatate: [['Cum va evolua sezonul de gripă?'], ['Ce tratamente noi vor fi aprobate în UE?', 'eu']],
        sport: [['Cine va câștiga următoarea finală a Ligii Campionilor?', 'global', 'sport', '1y'], ['Se va califica România la Campionatul Mondial?', 'ro']],
        stiinta: [['Va ateriza o misiune cu echipaj pe Lună?', 'global', 'stiinta', '5y'], ['Ce descoperiri importante sunt așteptate?']],
        societate: [['Va crește salariul minim în România?', 'ro'], ['Cum va evolua șomajul în UE?', 'eu']],
        divertisment: [['Ce film va câștiga Oscarul?'], ['Care va fi cel mai vizionat film al anului?']],
        afaceri: [['Va crește numărul firmelor noi din România?', 'ro'], ['Cum va evolua finanțarea startup-urilor europene?', 'eu']],
        agricultura: [['Cum va evolua recolta de grâu din România?', 'ro'], ['Vor crește prețurile alimentelor în UE?', 'eu']],
        educatie: [['Va crește numărul studenților din România?', 'ro'], ['Cum va evolua cererea pentru cursuri de reconversie profesională?']],
        turism: [['Va crește numărul turiștilor străini în România?', 'ro'], ['Cum vor evolua tarifele de cazare pe litoralul românesc?', 'ro']],
        transport: [['Ce tronsoane de autostradă ar putea fi deschise în România?', 'ro'], ['Va crește transportul feroviar de pasageri în UE?', 'eu']],
        mediu: [['Se va îmbunătăți calitatea aerului în București?', 'ro'], ['Va crește rata de reciclare a deșeurilor din România?', 'ro']],
        securitate_cibernetica: [['Cum va evolua numărul incidentelor ransomware raportate în UE?', 'eu'], ['Va crește adoptarea autentificării fără parolă?']],
        justitie: [['Ce reglementări europene privind AI vor intra în aplicare?', 'eu'], ['Cum ar putea evolua regulile pentru comerțul online în UE?', 'eu']],
        auto: [['Va crește ponderea mașinilor electrice înmatriculate în România?', 'ro'], ['Cum va evolua rețeaua de stații de încărcare din UE?', 'eu']],
        industrie: [['Va crește producția industrială din România?', 'ro'], ['Cum vor evolua comenzile fabricilor europene?', 'eu']],
        comert: [['Vor crește vânzările online din România?', 'ro'], ['Cum va evolua încrederea consumatorilor din UE?', 'eu']],
        telecom: [['Cum va evolua acoperirea 5G în România?', 'ro'], ['Va crește accesul la internet prin satelit în UE?', 'eu']],
      },
    },
    en: {
      checkOrder: 'Check order status again', advancedOptions: 'Advanced options', private: 'Private forecast', otherDomains: 'Choose a topic or write your own question',
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
      tagline: 'Ask a question. Get scenarios with probabilities and sources. Return after the deadline to see what came true.',
      publicVerdict: 'Latest public check', exampleVerdict: 'How forecasts are checked',
      noPublicVerdict: 'Until the first public check is available, explore the fictional report and its resolution criteria.',
      openEvidence: 'Read the evidence', calendar: 'Add the check to your calendar', calendarTitle: 'Check the forecast',
      viewExample: 'See a sample report', edit: 'Edit', yourQuestion: 'Your question', questionMin: 'Enter at least 5 characters.', tryExample: 'Try your own question', exploreDomain: 'Topic, region and period',
      exampleChecks: 'With a real report, you can follow the question and return after the deadline to see which claims came true and the evidence for each verdict.',
      sharePrivate: 'Anyone who receives this link can read the question and the report.', viewProgress: 'View progress',
      declinedQuestion: 'Question declined', rephrase: 'Rephrase question', removedHistory: 'The report was removed from this browser. Its link still works.', removedEntry: 'The question was removed from this browser’s history.',
      createForecast: 'Create a forecast', reloadReport: 'Reload report', reloadPage: 'Reload page',
      exampleLabel: 'Illustrative example', exampleNote: 'The data, institutions and sources are fictional. This example shows the result format; it is not a current forecast and requires no payment.',
      draftSaved: 'Form saved in this tab.', draftUnavailable: 'Your browser does not allow the form to be saved.', clearDraft: 'Clear form',
      personalTitle: 'My history', personalHint: 'Saved in this browser. Followed questions are updated when you return to the app.',
      historyAll: 'All', historyWatched: 'Followed questions', refreshChecks: 'Update results', personalEmpty: 'Forecasts you consult will appear here.', watchedEmpty: 'Follow a question from a forecast page.',
      watchQuestion: 'Follow this question', unwatchQuestion: 'Stop following', removeHistory: 'Remove from my history', pendingForecast: 'In progress', failedForecast: 'Forecast failed',
      watchHint: 'Following is saved in this browser. We check for updates when you return; we do not send notifications or generate new forecasts automatically.',
      baseProbability: 'Base scenario probability',
      checkedCount: (n, total) => `${n}/${total} claims checked`, historyUpdated: 'Results have been updated.', historyOffline: 'Could not update. Your saved history is still available.', storageUnavailable: 'History cannot be saved in this browser.',
      allDomains: 'All domains', allHorizons: 'All periods', allModels: 'All models', modelFilter: 'Model', mainModel: 'Main', liteModel: 'Fast', smallSample: 'Small sample: results may vary substantially.',
      retryConnection: 'Retry connection', offline: 'You are offline. You can keep filling in the form; forecasts already started continue on the server.', reconnecting: 'The server connection was interrupted. Retrying automatically; your forecast continues on the server.', connectionUnavailable: 'The server connection was interrupted. You can retry without entering your question again.', trackUnavailable: 'Could not load the track record. Retry when the connection is restored.',
      install: 'Install the app', stepDomain: 'Domain', stepQuestion: 'What would you like to know?', optional: '(optional)',
      questionPh: 'E.g.: Will euro area inflation fall below 2% by the end of the period?', examples: 'Example questions',
      questionHint: 'Leave the question blank for an overview of your chosen topic.',
      stepHorizon: 'Period', region: 'Region', answerLang: 'Answer language', effort: 'Oracle effort',
      publicNotice: 'Your question and forecast will be public and may appear in search engines.',
      privateNotice: 'Anyone with the link can view it. Hidden from public listings and search engines.',
      fixedPrice: (p) => `The selected effort applies to the free quick forecast; the in-depth analysis (${p}) always uses high effort.`,
      submit: 'Generate for free', freeHint: minutes => `Read your report on screen in about ${minutes === 1 ? 'one minute' : minutes + ' minutes'}.`,
      emailResult: (p) => `In-depth analysis — ${p}`,
      emailFee: (p) => `One-off payment: ${p}, no subscription. The result appears on screen and is also emailed to you.`,
      emailContinue: (p) => `Continue to payment — ${p}`,
      emailExistingHint: 'We search more sources and analyse the same question in detail. In about 2 minutes you can read your report on screen and receive its link by email. If it fails, you are refunded automatically.',
      emailConfirmed: 'The email with your forecast link has been sent.',
      payHint: (p) => `We search more sources and analyse your question in detail. In about 2 minutes you can read your report on screen and receive its link by email. One-off payment of ${p} on Stripe’s secure page, no subscription. If the analysis cannot be produced, you are refunded automatically.`,
      toPayment: 'Taking you to the payment page…', confirming: 'Confirming your payment…',
      consent: 'I agree to the Terms and privacy policy and request immediate supply of the in-depth analysis (on screen and by email); I understand that once the paid service is supplied I can no longer withdraw from the contract.',
      readTerms: 'Read the terms', termsLink: 'Terms and privacy', contact: 'Contact',
      screenEmail: 'Email (required for free viewing too)',
      emailLabel: 'Email address to receive your forecast', emailPh: 'name@example.com',
      emailMissing: 'Enter the email address where you want to receive the forecast.', emailInvalid: 'This email address does not look right.',
      consentMissing: 'Please tick the box accepting the terms before paying.',
      payPending: 'The payment has not been confirmed yet. If you paid, the forecast will start automatically — you can come back to this link.',
      payExpired: 'The payment was not completed and the payment page has expired. You have not been charged.',
      payCanceled: 'The payment was canceled. You have not been charged.',
      refundedNote: 'The payment for this forecast was refunded automatically.',
      trackTitle: 'The oracle’s track record', loading: 'Loading…', recentTitle: 'Recent forecasts',
      recentEmpty: 'No forecasts yet. Be the first to consult the oracle.',
      preparing: 'The oracle is getting ready…', notify: '🔔 Notify me when it’s ready', notifyOn: '🔔 We’ll notify you when it’s ready',
      leaveHint: 'You can keep this page open or come back later to the same link: the forecast will finish anyway.',
      share: 'Share', copyLink: 'Copy link', pdf: 'Save as PDF', newForecast: 'New forecast',
      errorTitle: 'The oracle fell silent',
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
        counts: (n, pending) => `${n} verified ${n === 1 ? 'claim' : 'claims'} · ${pending} pending`,
        verdict: (p, outcome) => `Estimated at ${p}% · the event ${outcome ? 'happened' : 'did not happen'}`,
        metrics: 'Success rate, Brier score and calibration', calibration: 'Calibration', said: (r) => `Said ${r}`, happened: (a, n) => `happened ${a}% (${n})`, latest: 'Latest checks',
      },
      examplesBy: {
        general: [['Will the euro area enter a recession?', 'eu', 'economie'], ['Which major AI launches are expected?', 'global', 'tehnologie']],
        economie: [['Will the euro area enter a recession?', 'eu'], ['Will the Fed cut interest rates?', 'us']],
        piete: [['Where will EUR/USD trade?'], ['Will Bitcoin hit a new all-time high?']],
        tehnologie: [['Which major AI launches will happen?'], ['How will the smartphone market evolve?']],
        politica: [['Which party will win the most votes in Romania’s next parliamentary election?', 'ro', 'politica', '5y'], ['Will Romania’s governing coalition stay in power?', 'ro']],
        geopolitica: [['Will there be a ceasefire in Ukraine?', 'ua'], ['How will US–China relations evolve?', 'global']],
        energie: [['What will a barrel of Brent cost?'], ['Will European gas prices fall?', 'eu']],
        imobiliare: [['Will house prices rise in Bucharest?', 'ro'], ['Will mortgage rates go down?']],
        clima: [['Will this winter be warmer than average?'], ['Will this be the hottest year on record?']],
        sanatate: [['How will the flu season evolve?'], ['Which new treatments will be approved in the EU?', 'eu']],
        sport: [['Who will win the next Champions League final?', 'global', 'sport', '1y'], ['Who will win the next Grand Slam?']],
        stiinta: [['Will a crewed mission land on the Moon?', 'global', 'stiinta', '5y'], ['Which major discoveries are expected?']],
        societate: [['Will unemployment rise in the EU?', 'eu'], ['How will migration trends change?']],
        divertisment: [['Which film will win the Oscar?'], ['What will be the year’s biggest box office hit?']],
        afaceri: [['Will the number of new businesses in Romania rise?', 'ro'], ['How will funding for European startups evolve?', 'eu']],
        agricultura: [['How will Romania’s wheat harvest evolve?', 'ro'], ['Will food prices rise in the EU?', 'eu']],
        educatie: [['Will university enrolment in Romania increase?', 'ro'], ['How will demand for professional retraining courses evolve?']],
        turism: [['Will international tourist arrivals in Romania increase?', 'ro'], ['How will accommodation prices on the Romanian coast evolve?', 'ro']],
        transport: [['Which motorway sections could open in Romania?', 'ro'], ['Will rail passenger traffic increase in the EU?', 'eu']],
        mediu: [['Will air quality improve in Bucharest?', 'ro'], ['Will Romania’s waste recycling rate increase?', 'ro']],
        securitate_cibernetica: [['How will reported ransomware incidents in the EU evolve?', 'eu'], ['Will adoption of passwordless authentication increase?']],
        justitie: [['Which European AI regulations will become applicable?', 'eu'], ['How might rules for online commerce in the EU evolve?', 'eu']],
        auto: [['Will the share of electric vehicles registered in Romania increase?', 'ro'], ['How will the EU charging station network evolve?', 'eu']],
        industrie: [['Will industrial production in Romania increase?', 'ro'], ['How will European manufacturing orders evolve?', 'eu']],
        comert: [['Will online retail sales in Romania increase?', 'ro'], ['How will EU consumer confidence evolve?']],
        telecom: [['How will 5G coverage in Romania evolve?', 'ro'], ['Will satellite internet access expand in the EU?', 'eu']],
      },
    },
  };

  // Etichetele rezultatului urmează limba previziunii (conținutul), nu a interfeței.
  const L = {
    ro: {
      scenarios: 'Scenarii', predictions: 'Previziuni verificabile', now: 'Unde ne aflăm acum', drivers: 'Factori-cheie',
      watch: 'De urmărit', wildcards: 'Surprize posibile', sources: 'Surse consultate', confidence: 'Încrederea oracolului', conf1: 'Încredere',
      conf: { low: 'scăzută', medium: 'medie', high: 'ridicată' }, imp: { positive: 'favorabil', negative: 'nefavorabil', uncertain: 'incert' },
      made: 'Previziune făcută la', forecastPeriod: 'Intervalul prognozei',
      previousEdition: 'Ediția anterioară', thisEdition: 'Această ediție', addedSources: 'Surse citate pentru prima dată față de ediția anterioară',
      noAddedSources: 'Această ediție nu citează surse suplimentare față de ediția anterioară.', research: (s, c) => `${s} căutări pe internet, ${c} surse găsite`,
      declinedTitle: 'Oracolul nu răspunde la această întrebare', horizon: 'Perioada', privateTag: 'privată', effort: 'Efort',
      liteTag: 'model rapid', liteNote: 'Previziune făcută cu modelul rapid al oracolului (analiză mai scurtă, cu mai puține căutări).',
      resolutionCriteria: 'Criteriu de verificare',
      published: 'Publicată la', dateUnknown: 'Dată de publicare neprecizată', noClaimSources: 'Nu sunt disponibile surse asociate acestei afirmații.',
      claimDetails: 'Argument și criteriu de verificare', claimSources: 'Surse pentru această afirmație',
      coverage: (n, total) => `Afirmații cu surse asociate: ${n} din ${total}.`,
      contextSourcesOnly: 'Surse disponibile pentru contextul general.', noSources: 'Raportul nu conține surse.',
      generalSources: 'Vezi sursele generale (neasociate acestei afirmații)',
      sourcesHint: 'Sursele de mai jos oferă context pentru analiză. Doar trimiterile de lângă fiecare afirmație indică sursele asociate acesteia; ele susțin argumentul, nu garantează rezultatul.',
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
      made: 'Forecast made on', forecastPeriod: 'Forecast period',
      previousEdition: 'Previous edition', thisEdition: 'This edition', addedSources: 'Sources newly cited since the previous edition',
      noAddedSources: 'This edition cites no additional sources compared with the previous edition.', research: (s, c) => `${s} web searches, ${c} sources found`,
      declinedTitle: 'The oracle will not answer this question', horizon: 'Horizon', privateTag: 'private', effort: 'Effort',
      liteTag: 'fast model', liteNote: 'Forecast made with the oracle’s fast model (a shorter analysis with fewer searches).',
      resolutionCriteria: 'Resolution criteria',
      published: 'Published', dateUnknown: 'Publication date unavailable', noClaimSources: 'No sources are associated with this claim.',
      claimDetails: 'Reasoning and resolution criteria', claimSources: 'Sources for this claim',
      coverage: (n, total) => `Claims with linked sources: ${n} of ${total}.`,
      contextSourcesOnly: 'Sources are available for general context only.', noSources: 'This report has no sources.',
      generalSources: 'View general sources (not linked to this claim)',
      sourcesHint: 'The sources below provide context for the analysis. Only references beside each claim identify sources associated with it; they support the reasoning, not a guaranteed outcome.',
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
  let draftKey = sessionStore.get('active-form') || 'form';
  eta = Number(sessionStore.get('eta')) || eta;
  let ui = store.get('ui') || ((navigator.language || 'ro').toLowerCase().startsWith('ro') ? 'ro' : 'en');
  const tr = (key) => U[ui][key];

  function applyUi() {
    document.documentElement.lang = ui;
    const astro = ui === 'en' ? 'https://astrohor.fun/?lang=en' : 'https://astrohor.fun/';
    $('#astro-switch').href = astro;
    document.querySelectorAll('[data-i18n]').forEach((n) => { n.textContent = tr(n.dataset.i18n); });
    const pay = catalog?.payment;
    $('#free-hint').textContent = tr('freeHint')(catalog?.freeTier === 'main' ? 2 : 1);
    if (pay?.required) {
      $('#delivery-option').textContent = tr('emailResult')(pay.price);
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
  const fmtUTCDate = (date, lang) => new Date(date).toLocaleDateString(lang === 'en' ? 'en-GB' : 'ro-RO', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' });
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
    visitRegistration = visitEvent({ event: 'visit', id: formVisit, device, layout: 'question-first' }).catch(() => {});
  }

  async function recordDisplay(id, marker) {
    const free = marker.startsWith('free:');
    const visit = free ? marker.slice(5) : marker;
    try {
      if (visit === formVisit) await visitRegistration;
      const result = await visitEvent({ event: 'display', id: visit, free });
      if (result.ok && sessionStore.get('visit-report-' + id) === marker) sessionStore.del('visit-report-' + id);
    } catch { /* Reîncercăm la următoarea afișare a raportului. */ }
  }

  // ---------- formular ----------
  // Domeniile din grila originală. Cataloagele extinse apar la „Alt domeniu”.
  const gridDomains = new Set(['general', 'economie', 'piete', 'tehnologie', 'politica', 'geopolitica', 'energie',
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
    renderContextSummary();
    renderExamples();
  }

  function renderContextSummary() {
    if (!catalog) return;
    const horizon = document.querySelector('input[name=horizon]:checked')?.value;
    $('#context-summary').textContent = [label(catalog.domains, currentDomain()), label(catalog.regions, $('#region').value), label(catalog.horizons, horizon)].join(' · ');
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
    const custom = currentDomain() === 'altul';
    const question = $('#question');
    question.required = custom;
    question.minLength = custom ? 5 : 0;
    $('#question-min').hidden = !custom;
    if (custom) question.setAttribute('aria-describedby', 'question-min');
    else question.removeAttribute('aria-describedby');
    $('#question-title').textContent = tr(custom ? 'yourQuestion' : 'stepQuestion');
    $('#question-optional').hidden = custom;
    $('.context-hint').hidden = custom;
    const box = $('#examples');
    box.replaceChildren();
    const group = currentDomain();
    (tr('examplesBy')[group] || []).forEach(([text, region = 'global', domain = group, horizon = '3m']) => {
      const b = el('button', { type: 'button', class: 'example', text });
      b.addEventListener('click', () => {
        const q = $('#question');
        selectDomain(domain);
        $('#region').value = region;
        document.getElementById('h-' + horizon).checked = true;
        renderContextSummary();
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
    if (formVisit && !$('#view-form').hidden) sessionStore.set('visit-report-' + res.id, 'free:' + formVisit);
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
    link.textContent = tr(state.message === 'generating' ? 'viewProgress' : 'openForecast');
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

  function restoreForm(request) {
    let body = request;
    try { body ??= JSON.parse(sessionStore.get(draftKey) || 'null'); } catch { /* ignorăm */ }
    if (!body || typeof body !== 'object') return;
    restoringDraft = true;
    const check = (name, value) => { const i = [...document.getElementsByName(name)].find(input => input.value === value); if (i) i.checked = true; };
    if (catalog.domains.some(d => d.id === body.domain)) selectDomain(body.domain);
    check('horizon', body.horizon);
    check('effort', body.effort);
    if (body.region) $('#region').value = body.region;
    if (body.lang) { answerLangChosen = body.answerLangChosen ?? true; $('#lang').value = answerLangChosen ? body.lang : ui; }
    $('#question').value = body.question || '';
    $('#question').dispatchEvent(new Event('input'));
    $('#private').checked = body.visibilityChoice !== 'public';
    renderVisibility();
    $('#email').value = body.email || '';
    $('#consent').checked = false;
    $('#advanced-options').open = body.advancedOpen === true;
    $('#forecast-context').open = body.contextOpen === true;
    renderContextSummary();
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
    draftSaved = sessionStore.set(draftKey, JSON.stringify({ ...body, answerLangChosen, consent: undefined, visibilityChoice: body.private === false ? 'public' : 'unlisted', contextOpen: $('#forecast-context').open, advancedOpen: $('#advanced-options').open }));
    $('#draft-status').textContent = tr(draftSaved ? 'draftSaved' : 'draftUnavailable');
    $('#reset-form').hidden = !draftSaved;
  }

  function validQuestion() {
    if (currentDomain() !== 'altul' || $('#question').value.trim().replace(/\s+/g, ' ').length >= 5) return true;
    $('#form-error').textContent = tr('questionMin');
    $('#form-error').hidden = false;
    $('#question').focus();
    return false;
  }

  async function onSubmit(e) {
    e.preventDefault();
    if (submitting || $('#submit').disabled || !validQuestion()) return;
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
    for (const id of ['submit', 'submit-email', 'result-submit-email']) {
      $(`#${id}`).disabled = value || !catalog || offlineCatalog || navigator.onLine === false;
    }
  }

  async function submitEmail(fromResult = false) {
    if (submitting || !catalog?.payment?.required || $('#submit-email').disabled) return;
    if (!fromResult && !validQuestion()) return;
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

  function fail(msg, action = 'createForecast') {
    const link = $('#error-action');
    link.dataset.i18n = action;
    link.textContent = tr(action);
    link.href = action === 'createForecast' ? '/' : location.pathname + location.search;
    link.toggleAttribute('data-nav', action !== 'reloadPage');
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
      fail(ex.message, ex.status === 404 ? 'createForecast' : 'reloadReport');
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
    const previous = rec.comparison && rec.history.find(h => h.id === rec.comparison.previousId);
    const base = rec.prediction.scenarios[0];
    const changes = previous?.base && base ? el('div', { class: 'edition-change' },
      el('p', {}, el('a', { href: '/p/' + previous.id, 'data-nav': true, text: t.previousEdition }), ` · ${fmtShort(previous.createdAt, lang)} · ${previous.base.name} (${previous.base.probability}%)`),
      el('p', {}, el('strong', { text: t.thisEdition }), ` · ${fmtShort(rec.createdAt, lang)} · ${base.name} (${base.probability}%)`),
      rec.comparison.addedSources.length
        ? el('div', {}, el('strong', { text: t.addedSources }), sourceList(rec.comparison.addedSources, t, lang))
        : el('p', { class: 'hint', text: t.noAddedSources })) : null;
    return card(rows.length ? t.history : null, changes,
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
      root.append(el('section', { class: 'card declined' }, tags, el('h1', { text: t.declinedTitle }), el('p', { text: p.declined_reason || p.summary }), rephraseButton(rq),
        rec.refunded ? el('p', { class: 'muted', text: tr('refundedNote') }) : null));
      return;
    }

    // Numerotare comună pentru trimiterile pe afirmații și lista generală, fără asocieri deduse.
    const sourceMap = new Map();
    for (const source of [...p.sources, ...p.predictions.flatMap(claim => claim.sources || [])]) {
      if (!sourceMap.has(sourceKey(source.url))) sourceMap.set(sourceKey(source.url), source);
    }
    const sources = [...sourceMap.values()];
    const missing = p.predictions.filter(claim => !claim.sources?.length).length;
    const linked = p.predictions.length - missing;
    const coverage = linked ? t.coverage(linked, p.predictions.length) : sources.length ? t.contextSourcesOnly : t.noSources;
    root.append(el('section', { class: 'card r-head' },
      tags,
      el('h1', { text: p.title }),
      rq.question ? el('p', { class: 'muted', text: `„${rq.question}”` }) : null,
      el('p', { class: 'r-summary', text: p.summary }),
      el('p', { class: 'hint report-dates' },
        `${t.made} ${fmtUTCDate(rec.createdAt, lang)}`,
        rec.forecastStart && rec.forecastEnd ? el('span', { text: `${t.forecastPeriod}: ${fmtUTCDate(rec.forecastStart, lang)} – ${fmtUTCDate(rec.forecastEnd, lang)}` }) : null),
      confidenceDots(p.confidence, t),
      el('p', { class: 'hint source-coverage' }, sources.length ? sourceJump(coverage) : coverage),
      reportAction(rec)));
    renderWatchButton();

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
    if (!rec.example) root.append(el('p', { class: 'r-foot', text: [t.research(meta.searches || 0, meta.consulted || 0), meta.tier === 'lite' ? t.liteNote : ''].filter(Boolean).join(' · ') }));
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
    } catch (ex) { if (location.pathname !== '/exemplu' || ui !== language) return; if (ex.network) setConnection('reconnecting'); fail(ex.message, 'reloadReport'); }
  }

  function renderConnection() {
    setSubmitting(submitting);
    $('#network-warning').hidden = networkState === 'connected';
    $('#network-message').textContent = networkState === 'connected' ? '' : tr(networkState === 'reconnecting' && !currentPredictionId ? 'connectionUnavailable' : networkState);
  }

  function setConnection(state) { networkState = state === 'connected' && navigator.onLine === false ? 'offline' : state; renderConnection(); }

  function renderWatchButton() {
    const button = $('#watch-result');
    if (!button || !current) return;
    const watched = library.get(current.id)?.watched;
    button.textContent = tr(watched ? 'unwatchQuestion' : 'watchQuestion');
    button.setAttribute('aria-pressed', String(!!watched));
  }

  function calendarButton(id, nextCheck, title) {
    const button = el('button', { class: 'btn-small', type: 'button', text: tr('calendar') });
    button.addEventListener('click', () => {
      const date = new Date(nextCheck);
      const day = [date.getUTCFullYear(), String(date.getUTCMonth() + 1).padStart(2, '0'), String(date.getUTCDate()).padStart(2, '0')].join('');
      const link = `${location.origin}/p/${id}`;
      const summary = (tr('calendarTitle') + ' · ' + title).replace(/\\/g, '\\\\').replace(/\r\n|[\r\n]/g, '\\n').replace(/[,;]/g, '\\$&');
      const lines = ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Nostradamus//Forecast//EN', 'BEGIN:VEVENT',
        `UID:${id}-${day}@${location.hostname}`, `DTSTAMP:${new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '')}`,
        `DTSTART;VALUE=DATE:${day}`, 'TRANSP:TRANSPARENT', `SUMMARY:${summary}`, `DESCRIPTION:${link}`, `URL:${link}`, 'END:VEVENT', 'END:VCALENDAR'];
      // iCalendar limitează fiecare linie la 75 de octeți, inclusiv spațiul de continuare.
      const encoder = new TextEncoder();
      const folded = lines.map(line => {
        let output = '', bytes = 0;
        for (const char of line) {
          const size = encoder.encode(char).length;
          if (bytes + size > 75) { output += '\r\n '; bytes = 1; }
          output += char;
          bytes += size;
        }
        return output;
      });
      const file = URL.createObjectURL(new Blob([folded.join('\r\n') + '\r\n'], { type: 'text/calendar;charset=utf-8' }));
      const download = el('a', { href: file, download: `nostradamus-${id}.ics` });
      document.body.append(download);
      download.click();
      download.remove();
      setTimeout(() => URL.revokeObjectURL(file), 1000);
    });
    return button;
  }

  function reportAction(rec) {
    if (rec.example) {
      return el('div', { class: 'report-action' },
        el('a', { class: 'btn-ghost', href: '/', 'data-nav': true, 'data-focus-question': true, text: tr('tryExample') }),
        el('p', { class: 'hint', text: tr('exampleChecks') }));
    }
    const button = el('button', { id: 'watch-result', class: 'btn-ghost', type: 'button', 'aria-describedby': 'watch-hint' });
    button.addEventListener('click', () => {
      library.remember(rec);
      library.toggle(rec.id);
      renderWatchButton();
      renderLibrary();
      if (!library.persistent) toast(tr('storageUnavailable'));
    });
    const hasChecks = rec.checks?.some(check => check.status !== 'pending');
    return el('div', { class: 'report-action' }, button,
      rec.nextCheckAt ? el('p', { class: 'hint', text: tr(hasChecks ? 'nextCheckAfter' : 'firstCheckAfter') + ' ' + fmtDate(rec.nextCheckAt) }) : null,
      rec.nextCheckAt ? calendarButton(rec.id, rec.nextCheckAt, rec.prediction.title) : null,
      el('p', { class: 'hint', id: 'watch-hint', text: tr('watchHint') }));
  }

  function rephrase(request) {
    if (location.pathname !== '/') {
      history.pushState({}, '', '/');
      route();
    }
    restoreForm({ ...request, visibilityChoice: request.private ? 'unlisted' : 'public' });
    saveDraft();
    $('#form-error').hidden = true;
    $('#email-error').hidden = true;
    $('#question').focus();
  }

  function rephraseButton(request) {
    const button = el('button', { type: 'button', class: 'btn-small', text: tr('rephrase') });
    button.addEventListener('click', () => rephrase(request));
    return button;
  }

  function renderLibrary() {
    if (!catalog) return;
    const all = library.list();
    if (!all.length) libraryFilter = 'all';
    $('#library-all').setAttribute('aria-pressed', String(libraryFilter === 'all'));
    $('#library-watched').setAttribute('aria-pressed', String(libraryFilter === 'watched'));
    for (const selector of ['#library-tools', '#personal-hint', '#personal-title']) $(selector).hidden = !all.length;
    const entries = all.filter(e => libraryFilter !== 'watched' || e.watched);
    $('#personal-list').replaceChildren(...entries.map(e => {
      let action;
      if (e.status === 'declined') {
        action = rephraseButton(e.request);
      } else {
        action = el('button', { type: 'button', class: 'btn-small', text: tr(e.watched ? 'unwatchQuestion' : 'watchQuestion'), 'aria-pressed': String(e.watched) });
        action.addEventListener('click', () => { library.toggle(e.id); renderLibrary(); renderWatchButton(); });
      }
      const remove = el('button', { type: 'button', class: 'btn-small', text: tr('removeHistory') });
      remove.addEventListener('click', () => {
        library.remove(e.id);
        renderLibrary();
        renderWatchButton();
        toast(tr(e.status === 'done' || e.status === 'declined' ? 'removedHistory' : 'removedEntry'));
      });
      const evolution = e.trend.length > 1 ? e.trend.map(p => `${p}%`).join(' → ') : e.base !== null ? `${e.base}%` : '';
      const statusLabel = { pending: 'pendingForecast', error: 'failedForecast', declined: 'declinedQuestion' }[e.status];
      const state = statusLabel ? tr(statusLabel) : tr('checkedCount')(e.resolved, e.total);
      return el('li', {}, el('a', { href: `/p/${e.id}`, 'data-nav': true, class: 'personal-title', text: e.title || label(catalog.domains, e.request.domain) }),
        el('p', { class: 'hint', text: [fmtShort(e.createdAt), e.request.private ? '🔒' : '', state].filter(Boolean).join(' · ') }),
        e.watched && e.nextCheck ? el('p', { class: 'hint', text: `${tr(e.checkedBefore ? 'nextCheckAfter' : 'firstCheckAfter')} ${fmtShort(e.nextCheck)}` }) : null,
        e.watched && e.resolved > e.seenResolved ? el('strong', { text: tr('newChecks')(e.resolved - e.seenResolved) }) : null,
        evolution ? el('p', { class: 'hint history-probability', text: `${tr('baseProbability')}: ${evolution}${e.baseName ? ` — ${e.baseName}` : ''}` }) : null,
        el('div', { class: 'personal-tools' }, action, e.watched && e.nextCheck ? calendarButton(e.id, e.nextCheck, e.title) : null, remove));
    }));
    $('#personal-list').hidden = !entries.length;
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
    $('#share-private').hidden = rec.example || !rec.request.private;
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
  let homeTrackRequest = 0;
  function loadHomeTrack() {
    const request = ++homeTrackRequest;
    const unfiltered = api('/api/track-record');
    loadTrack(unfiltered);
    unfiltered.then(data => {
      if (request !== homeTrackRequest) return;
      $('#verdict-card').hidden = false;
      const verdict = data.recent[0];
      $('#verdict-title').textContent = tr(verdict ? 'publicVerdict' : 'exampleVerdict');
      $('#featured-verdict').replaceChildren(...(verdict ? [
        el('strong', { text: verdict.claim }),
        el('p', { text: tr('track').verdict(verdict.probability, verdict.outcome) }),
        el('p', { text: verdict.evidence }),
        el('a', { href: verdict.url, target: '_blank', rel: 'noopener noreferrer', text: tr('openEvidence') + ' · ' + hostOf(verdict.url) }),
        el('p', {}, el('a', { href: '/p/' + verdict.id, 'data-nav': true, text: tr('openForecast') })),
      ] : [el('p', { text: tr('noPublicVerdict') }), el('a', { href: '/exemplu', 'data-nav': true, text: tr('viewExample') })]));
    }).catch(() => {
      if (request !== homeTrackRequest) return;
      $('#verdict-card').hidden = false;
      $('#verdict-title').textContent = tr('publicVerdict');
      $('#featured-verdict').textContent = tr('trackUnavailable');
    });
  }

  async function loadTrack(unfiltered) {
    const request = ++trackRequest;
    const box = $('#track');
    const T = tr('track');
    try {
      const params = new URLSearchParams();
      for (const name of ['domain', 'horizon', 'tier']) if ($(`#track-${name}`).value) params.set(name, $(`#track-${name}`).value);
      const data = await (params.size || !unfiltered ? api(`/api/track-record?${params}`) : unfiltered);
      if (request !== trackRequest) return;
      if (!$('#view-form').hidden) setConnection('connected');
      if (!data.resolved) {
        box.replaceChildren(
          el('strong', { text: T.counts(0, data.pending) }), el('p', { text: T.intro }),
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
      box.replaceChildren(
        el('strong', { text: T.counts(data.resolved, data.pending) }),
        data.resolved < 30 ? el('p', { class: 'hint', text: tr('smallSample') }) : null,
        el('details', { class: 'track-metrics', open: data.resolved >= 30 },
          el('summary', { text: T.metrics }), stats,
          rows.length ? el('div', {}, el('h3', { text: T.calibration }), el('ul', { class: 'calibration' }, rows)) : null),
        data.recent.length ? el('div', {}, el('h3', { text: T.latest }), el('ul', { class: 'checked-list' }, data.recent.map((r) => el('li', {},
          el('a', { href: `/p/${r.id}`, 'data-nav': true, text: r.claim }),
          el('span', { class: 'muted', text: ' — ' + T.verdict(r.probability, r.outcome) }))))) : null);
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
    } else if (location.pathname.startsWith('/p/')) {
      fail(tr('missing'));
    } else if (pay) {
      confirmPayment(pay[1]);
    } else {
      const params = new URLSearchParams(location.search);
      if (params.has('new')) {
        draftKey = 'form-' + crypto.randomUUID();
        clearForm();
      } else if (history.state?.draftKey && history.state.draftKey !== draftKey) {
        draftKey = history.state.draftKey;
        clearForm();
        restoreForm();
      }
      sessionStore.set('active-form', draftKey);
      const cancelled = params.has('anulat');
      history.replaceState({ ...history.state, draftKey }, '', params.has('new') || cancelled ? '/' : location.href);
      if (cancelled) {
        restoreForm();
        toast(tr('payCanceled'));
      }
      document.title = tr('defaultTitle');
      show('form');
      renderLibrary();
      if (offlineCatalog || navigator.onLine === false) return;
      startFormVisit();
      refreshLibrary();
      loadHomeTrack();
      loadRecent();
    }
  }

  document.addEventListener('click', (e) => {
    const a = e.target.closest('a[data-nav]');
    if (!a || e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return;
    e.preventDefault();
    if (!$('#view-form').hidden) saveDraft();
    if (a.pathname + a.search !== location.pathname + location.search) history.pushState({}, '', a.getAttribute('href'));
    route();
    if (a.hasAttribute('data-focus-question') || a.dataset.i18n === 'newForecast') $('#question').focus();
  });
  window.addEventListener('popstate', route);

  $('#ui-lang').addEventListener('click', () => {
    ui = ui === 'ro' ? 'en' : 'ro';
    store.set('ui', ui);
    if (!answerLangChosen) $('#lang').value = ui;
    applyUi();
    if (catalog) buildForm();
    if (current && !current.example && !$('#view-result').hidden) renderPrediction(current);
    if (!$('#view-form').hidden) { loadHomeTrack(); loadRecent(); document.title = tr('defaultTitle'); }
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
  $('#library-all').addEventListener('click', () => { libraryFilter = 'all'; renderLibrary(); });
  $('#library-watched').addEventListener('click', () => { libraryFilter = 'watched'; renderLibrary(); });
  $('#library-refresh').addEventListener('click', () => refreshLibrary({ all: true }));
  for (const name of ['domain', 'horizon', 'tier']) $(`#track-${name}`).addEventListener('change', () => loadTrack());
  $('#form').addEventListener('input', () => saveDraft());
  $('#form').addEventListener('change', () => { renderContextSummary(); renderAdvancedSummary(); saveDraft(); });
  for (const id of ['advanced-options', 'forecast-context']) {
    $(`#${id}`).addEventListener('toggle', () => { if (draftSaved) saveDraft(); });
  }
  function clearForm() {
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
    $('#forecast-context').open = false;
    $('#private').checked = true;
    renderEffortHint(); renderExamples(); renderVisibility(); renderContextSummary();
  }
  $('#reset-form').addEventListener('click', () => {
    sessionStore.del(draftKey);
    clearForm();
  });
  $('#retry-connection').addEventListener('click', () => {
    if (!catalog || offlineCatalog) bootstrap();
    else route();
  });
  window.addEventListener('offline', () => { saveDraft(); setConnection('offline'); });
  window.addEventListener('online', () => {
    setConnection('connected');
    if (!catalog || offlineCatalog) bootstrap();
    else if (currentPredictionId && !$('#view-progress').hidden) follow(currentPredictionId);
    else if (!$('#view-form').hidden) { refreshLibrary(); loadHomeTrack(); }
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


  async function bootstrap() {
    if (loadingCatalog) return;
    loadingCatalog = true;
    try {
      let config;
      try {
        config = await api('/api/catalog', { cache: 'no-cache' });
        store.set('nostra.public-catalog.v1', JSON.stringify(config));
        offlineCatalog = false;
      } catch (err) {
        config = JSON.parse(store.get('nostra.public-catalog.v1') || 'null');
        if (!config || location.pathname !== '/') throw err;
        offlineCatalog = true;
      }
      catalog = config;
      applyUi();
      buildForm();
      restoreForm();
      setConnection(offlineCatalog ? 'reconnecting' : 'connected');
      route();
    } catch {
      setConnection('reconnecting');
      fail(tr('loadFail'), 'reloadPage');
    } finally {
      loadingCatalog = false;
    }
  }
  bootstrap();
})();
