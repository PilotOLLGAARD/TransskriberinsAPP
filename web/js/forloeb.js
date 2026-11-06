import { FORTRYD_MS, OPBEVARING_MS, STATUS, efterGenstart } from './tilstand.js';

// Optager og sender kan stå tilbage, hvis lageret svigtede. Dobbeltkald forhindres af eneAdgang.
const KAN_BEHANDLES = new Set([STATUS.GEMT, STATUS.FEJL, STATUS.OPTAGER, STATUS.SENDER]);
// En optagelse, der har gemt lyd for nylig, kan stadig køre i en anden fane.
const FRISK_MS = 30 * 1000;

/** En valgt lydfil, der stadig gemmes, eller som ikke blev gemt færdig. */
function erHalvFil(note) {
  return note.kilde === 'fil' && note.status === STATUS.OPTAGER;
}

/** Fuldt lager hedder plads, så brugeren får at vide, hvad der skal til. */
function fejlTypeFor(e, reserve) {
  return e?.name === 'QuotaExceededError' ? 'plads' : (e?.type || reserve);
}

/**
 * Binder lager, login og afsendelse sammen. Lyd slettes kun, når mailen er accepteret,
 * eller brugeren selv vælger Slet. Alle fejl ender i en tilstand, hvor man kan prøve igen.
 */
export function lavForloeb({ lager, login, sendLyd, sendMail, sendReferat, aktivAndetSted = async () => false, nu = Date.now, vedAendring = () => {}, vedUpload = () => {} }) {
  const igang = new Set();
  // Afsendelser, der kan stoppes, når brugeren sletter noten.
  const afbrydere = new Map();
  // Ændringer, der ikke kunne gemmes (fx fuldt lager). De vises, så skærmen aldrig hænger i "sender",
  // og forsvinder, når noten gemmes igen. Efter en genstart retter genoptag noten.
  const ugemte = new Map();

  function nyAfbryder(id) {
    const ctrl = new AbortController();
    afbrydere.set(id, ctrl);
    return ctrl.signal;
  }

  /**
   * Om en optagelse måske stadig kører et andet sted. aktive er låsene, andre faner holder,
   * eller null, når de ikke kan ses. Så afgør tiden siden sidste gemte stykke, og tvivl betyder ja.
   * Låsene skal læses efter noten: optageren tager sin lås, før noten findes.
   */
  function maaskeIGang(note, aktive) {
    if (note.status !== STATUS.OPTAGER) return false;
    if (aktive) return aktive.has(note.id);
    return nu() - (note.sidstAktiv ?? note.oprettet ?? 0) < FRISK_MS;
  }

  /** Gemmer og glemmer ændringer, der ikke kunne gemmes før. */
  async function skriv(id, felter) {
    await lager.opdaterNote(id, felter);
    ugemte.delete(id);
  }

  function huskUgemt(id, felter) {
    ugemte.set(id, { ...ugemte.get(id), ...felter });
  }

  async function opdaterTrygt(id, felter) {
    try {
      await skriv(id, felter);
    } catch {
      // Lyden er stadig gemt, og noten rettes ved næste start. Indtil da vises ændringen alligevel.
      huskUgemt(id, felter);
    }
  }

  /**
   * Mailen er modtaget: noten bliver i OPBEVARING_MS med referat og PDF, så den kan sendes igen.
   * Status skrives før lyden slettes, så et nedbrud imellem kun efterlader lyd, aldrig en tabt note.
   */
  async function markerSendt(id) {
    await lager.opdaterNote(id, { status: STATUS.SENDT, sendt: nu(), fejlType: undefined, maaskeSendt: undefined, fremdrift: undefined });
    await lager.sletLyd(id);
  }

  /**
   * Transskriberer hver del for sig og laver ét referat. Delteksterne gemmes én ad gangen,
   * så et genforsøg aldrig sender en del, der allerede er transskriberet.
   */
  async function behandlDele(id, note, bevis, signal) {
    const dele = await lager.hentDele(id);
    const tekster = [...(note.deltekster || [])];
    let sendtLyd = false;
    for (let i = 0; i < dele.length; i++) {
      if (typeof tekster[i] === 'string') continue;
      sendtLyd = true;
      const sidste = i === dele.length - 1;
      const svar = await sendLyd(dele[i], note.mime, bevis, { kunTekst: true, oprettet: note.oprettet }, undefined, {
        vedSendt: sidste ? () => fremdrift(id, 'laver') : undefined,
        signal,
      });
      tekster[i] = svar.tekst || '';
      await lager.opdaterNote(id, { deltekster: [...tekster] });
    }
    // Al lyd er transskriberet før: kun referatet mangler, og det er det, skærmen skal vise.
    if (!sendtLyd) await fremdrift(id, 'laver');
    return lavReferat(note, tekster, bevis, signal);
  }

  /** Ét referat af teksterne via /referat. Intet lyd sendes. */
  async function lavReferat(note, tekster, bevis, signal) {
    const medTale = tekster.filter((x) => x.trim());
    if (!medTale.length) return { tekst: '' };
    return sendReferat(
      { tekster: medTale, titel: note.titel, type: note.type, varighedMs: note.varighedMs, oprettet: note.oprettet },
      bevis,
      undefined,
      { signal },
    );
  }

  /** Hvor langt afsendelsen er: sender, laver (referatet) eller mailer. Vises på skærmen efter Send. */
  async function fremdrift(id, trin) {
    await opdaterTrygt(id, { fremdrift: trin });
    vedAendring(id);
  }

  async function eneAdgang(id, arbejde) {
    if (igang.has(id)) return;
    igang.add(id);
    try {
      await arbejde();
    } finally {
      igang.delete(id);
    }
  }

  const forloeb = {
    /** Noten, som den skal vises: med ændringer, der ikke kunne gemmes. */
    medUgemt(note) {
      if (!note || !ugemte.has(note.id)) return note;
      return { ...note, ...ugemte.get(note.id) };
    },

    behandl: (id) => eneAdgang(id, async () => {
      // Oprettes før alt andet, så Slet altid kan stoppe afsendelsen, også i de første millisekunder.
      const signal = nyAfbryder(id);
      try {
      const note = await lager.hentNote(id);
      if (!note || note.slettet || signal.aborted || !KAN_BEHANDLES.has(note.status)) return;
      // En lydfil, der ikke blev gemt færdig, er ikke hele filen. Den sendes aldrig.
      if (erHalvFil(note)) return;
      if (note.status === STATUS.OPTAGER) {
        const andetSted = await aktivAndetSted(id).catch(() => null);
        if (andetSted === true || (andetSted !== false && maaskeIGang(note, null))) return;
      }
      try {
        await skriv(id, { status: STATUS.SENDER, fejlType: undefined, fremdrift: 'sender' });
        vedAendring(id);
        if (signal.aborted) throw Object.assign(new Error('net'), { type: 'net' });
        const bevis = await login.hentBevis('api');
        if (signal.aborted) throw Object.assign(new Error('net'), { type: 'net' });
        // En note med gemte deltekster er (delvis) transskriberet. Den går altid via delene, også med én del,
        // så lyd, der allerede er betalt for, aldrig sendes igen.
        const viaDele = (note.dele ?? 1) > 1 || note.deltekster?.length > 0;
        let svar = viaDele
          ? await behandlDele(id, note, bevis, signal)
          : await sendLyd(await lager.hentLyd(id), note.mime, bevis, {
            titel: note.titel, type: note.type, varighedMs: note.varighedMs, oprettet: note.oprettet,
          }, undefined, {
            vedSendt: () => fremdrift(id, 'laver'),
            // Kun til skærmen. Gemmes ikke.
            vedFremdrift: (sendt, ialt) => vedUpload(id, sendt, ialt),
            signal,
          });
        if (!viaDele && svar.referatMangler && svar.tekst) {
          // Transskriptionen lykkedes, men referatet fejlede på serveren. Teksten gemmes, før referatet
          // prøves igen, så "Prøv igen" kun laver referatet.
          await lager.opdaterNote(id, { deltekster: [svar.tekst] });
          svar = await lavReferat(note, [svar.tekst], bevis, signal);
        }
        if (!svar.tekst) {
          await lager.opdaterNote(id, { status: STATUS.FEJL, fejlType: 'ingenTale' });
          return;
        }
        const felter = { status: STATUS.TEKST_KLAR, tekst: svar.tekst };
        for (const k of ['titel', 'type', 'referat', 'pdf', 'filnavn', 'docx', 'docxFilnavn', 'emne', 'html']) if (svar[k] !== undefined) felter[k] = svar[k];
        await lager.opdaterNote(id, felter);
      } catch (e) {
        await opdaterTrygt(id, { status: STATUS.FEJL, fejlType: fejlTypeFor(e, 'tjeneste') });
      }
      } finally {
        afbrydere.delete(id);
      }
    }),

    sendTilMig: (id) => eneAdgang(id, async () => {
      const note = await lager.hentNote(id);
      if (!note || note.slettet || note.status !== STATUS.TEKST_KLAR) return;
      const signal = nyAfbryder(id);
      try {
        await skriv(id, { status: STATUS.SENDER_MAIL, fejlType: undefined, fremdrift: 'mailer' });
        vedAendring(id);
        const bevis = await login.hentBevis('mail');
        if (signal.aborted) throw Object.assign(new Error('mailFejl'), { type: 'mailFejl' });
        await sendMail({ note, til: login.brugerMail(), bevis, signal });
      } catch (e) {
        if (e?.type === 'mailUkendt') {
          // Mailen kan være sendt. Brugeren tjekker indbakken i stedet for at få en dobbelt mail.
          await opdaterTrygt(id, { status: STATUS.TEKST_KLAR, maaskeSendt: true });
          return;
        }
        await opdaterTrygt(id, {
          status: STATUS.TEKST_KLAR,
          fejlType: e?.type === 'login' ? 'login' : e?.name === 'QuotaExceededError' ? 'plads' : 'mailFejl',
        });
        return;
      } finally {
        afbrydere.delete(id);
      }
      try {
        await markerSendt(id);
      } catch {
        // Noten står som sender-mail og får advarslen om mulig afsendelse ved næste start.
        // Indtil da vises den som sendt, for Microsoft har modtaget mailen. Lyden bliver liggende.
        huskUgemt(id, { status: STATUS.SENDT, sendt: nu(), fejlType: undefined, maaskeSendt: undefined, fremdrift: undefined });
      }
    }),

    /**
     * Sender en sendt notes referat og PDF igen fra telefonen. Intet AI-kald og intet kald til serveren.
     * sendt ændres ikke, så de 7 dage regnes fra første afsendelse.
     */
    sendIgen: (id) => eneAdgang(id, async () => {
      const note = await lager.hentNote(id);
      if (note?.status !== STATUS.SENDT || !note.pdf || note.slettet) return;
      try {
        const bevis = await login.hentBevis('mail');
        await sendMail({ note, til: login.brugerMail(), bevis });
      } catch (e) {
        // Mailen kan være sendt. Brugeren tjekker indbakken i stedet for at få en dobbelt mail.
        if (e?.type === 'mailUkendt') await opdaterTrygt(id, { maaskeSendt: true });
        else await opdaterTrygt(id, { fejlType: e?.type === 'login' ? 'login' : 'mailFejl' });
        return;
      }
      await opdaterTrygt(id, { sendtIgen: nu(), fejlType: undefined, maaskeSendt: undefined });
    }),

    /**
     * Efter login: sender noter, der stoppede, fordi login manglede. Brugeren havde allerede trykket Send.
     * En mail, der måske er sendt, sendes ikke igen af sig selv.
     */
    async sendVentende() {
      const venter = (n) => n?.fejlType === 'login' && !n.slettet && !n.maaskeSendt
        && [STATUS.FEJL, STATUS.TEKST_KLAR, STATUS.SENDT].includes(n.status);
      // Alle ryddes først. Så tager en anden fane dem ikke, og login-boksen vises ikke under afsendelsen.
      const mine = [];
      for (const { id } of (await lager.alleNoter()).filter(venter)) {
        const note = await lager.hentNote(id);
        if (!venter(note)) continue;
        await opdaterTrygt(id, { fejlType: undefined });
        mine.push(note);
      }
      for (const note of mine) {
        if (note.status === STATUS.FEJL) await forloeb.behandlOgSend(note.id);
        else if (note.status === STATUS.TEKST_KLAR) await forloeb.sendTilMig(note.id);
        else await forloeb.sendIgen(note.id);
      }
    },

    /** Laver referatet, hvis det mangler, og sender det derefter selv. Bruges også af Prøv igen. */
    async behandlOgSend(id) {
      await forloeb.behandl(id);
      const note = await lager.hentNote(id);
      // En mulig dobbelt mail skal brugeren selv tage stilling til.
      if (note?.status === STATUS.TEKST_KLAR && !note.maaskeSendt && !note.slettet) await forloeb.sendTilMig(id);
    },

    /** Gemmer navnet, før noget sendes, så det overlever netværksfejl og genforsøg. */
    async navngivOgSend(id, titel) {
      // Afkortes i hele tegn, så en emoji aldrig deles.
      const ren = [...String(titel || '').trim()].slice(0, 120).join('').trim();
      try {
        await skriv(id, { titel: ren, navngivet: true });
      } catch (e) {
        // Intet sendes uden navnet. Optagelsen er gemt og kan sendes, når der er plads.
        huskUgemt(id, { status: STATUS.FEJL, fejlType: fejlTypeFor(e, 'lager') });
        return;
      }
      await forloeb.behandlOgSend(id);
    },

    /**
     * Retter noter, der stod midt i noget, da appen blev lukket. Sender intet af sig selv.
     * aktiveAndetSted er låsene eller en funktion, der henter dem. Funktionen kaldes først, når
     * noterne er læst, så en optagelse, der starter imens, altid ses med sin lås.
     * Låsene er null, når de ikke kan ses. Så røres en frisk optagelse ikke.
     */
    async genoptag(aktiveAndetSted = new Set()) {
      await forloeb.ryd().catch(() => {});
      const vist = [];
      const noter = await lager.alleNoter();
      const aktive = typeof aktiveAndetSted === 'function' ? await aktiveAndetSted() : aktiveAndetSted;
      for (const note of noter) {
        // Slettet inden for Fortryd-tiden: vises ikke, og ryddes ved næste start.
        if (note.slettet) continue;
        // En optagelse, der stadig kører i en anden fane eller i den installerede app, er ikke vores.
        if (maaskeIGang(note, aktive)) continue;
        // En lydfil, der ikke blev gemt færdig: Filen ligger stadig, hvor brugeren valgte den.
        if (erHalvFil(note)) {
          await lager.sletNote(note.id).catch(() => {});
          continue;
        }
        try {
          // Lukket før første stykke blev gemt: Der er intet at gemme.
          if (note.status === STATUS.OPTAGER && (await lager.hentLyd(note.id)).size === 0) {
            await lager.sletNote(note.id);
            continue;
          }
        } catch {
          // Noten vises, så brugeren kan nå den, også når lageret svigter.
        }
        const rettet = efterGenstart(note);
        if (rettet !== note) await opdaterTrygt(note.id, rettet);
        vist.push(rettet);
      }
      return vist;
    },

    /** Brugeren har set mailen i indbakken efter en advarsel om mulig afsendelse. */
    async bekraeftSendt(id) {
      const note = await lager.hentNote(id);
      if (!note?.maaskeSendt) throw new Error('Kun noter med advarsel kan bekræftes');
      await markerSendt(id);
    },

    /** Sletter sendte noter, når opbevaringen er udløbet. Alt andet slettes aldrig automatisk. */
    async ryd() {
      let antal = 0;
      for (const note of await lager.alleNoter()) {
        const udloebet = note.status === STATUS.SENDT && Number.isFinite(note.sendt) && nu() - note.sendt >= OPBEVARING_MS;
        const slettet = Number.isFinite(note.slettet) && nu() - note.slettet >= FORTRYD_MS;
        if (!udloebet && !slettet) continue;
        await lager.sletNote(note.id);
        antal++;
      }
      return antal;
    },

    /**
     * Sletter en note, så den kan fortrydes i FORTRYD_MS. En afsendelse, der er i gang, stoppes straks,
     * og serveren stopper så sit arbejde og sletter lydfilen hos Google.
     */
    async slet(id) {
      afbrydere.get(id)?.abort();
      await lager.opdaterNote(id, { slettet: nu() });
    },

    async fortrydSlet(id) {
      await lager.opdaterNote(id, { slettet: undefined });
    },

    /** Sletter lyd, tekst, referat og PDF helt fra telefonen. Kun noter, der er markeret slettet. */
    async endeligSlet(id) {
      const note = await lager.hentNote(id);
      if (note?.slettet) await lager.sletNote(id);
    },
  };
  return forloeb;
}
