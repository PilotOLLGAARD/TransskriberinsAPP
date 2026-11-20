import { FORTRYD_MS, OPBEVARING_MS, STATUS, efterGenstart } from './tilstand.js';
import * as standardOpdeling from './opdeling/index.js';
import { BIDDER } from './konfig.js';

// Optager og sender kan stå tilbage, hvis lageret svigtede. Dobbeltkald forhindres af eneAdgang.
const KAN_BEHANDLES = new Set([STATUS.GEMT, STATUS.FEJL, STATUS.OPTAGER, STATUS.SENDER]);
// En optagelse, der har gemt lyd for nylig, kan stadig køre i en anden fane.
const FRISK_MS = 30 * 1000;
// Højst så mange bidder af en lang optagelse sendes ad gangen.
const SAMTIDIGE_BIDDER = 3;
// En del, der ikke kan klippes, sendes hel, men kun op til 2½ time (serverens grænse for ét kald).
const MAKS_UDELT_MS = 9000 * 1000;
// En lydfil, hvis længde ikke kunne læses, er måske lang: over ca. 35 min. ved 128 kbit/s går den i bidder.
const UKENDT_LANG_BYTES = 30 * 1000 * 1000;

/** En valgt lydfil, der stadig gemmes, eller som ikke blev gemt færdig. */
function erHalvFil(note) {
  return (note.kilde === 'fil' || note.kilde === 'filer') && note.status === STATUS.OPTAGER;
}

/** Fuldt lager hedder plads, så brugeren får at vide, hvad der skal til. */
function fejlTypeFor(e, reserve) {
  return e?.name === 'QuotaExceededError' ? 'plads' : (e?.type || reserve);
}

/**
 * Binder lager, login og afsendelse sammen. Lyd slettes kun, når mailen er accepteret,
 * eller brugeren selv vælger Slet. Alle fejl ender i en tilstand, hvor man kan prøve igen.
 */
export function lavForloeb({
  lager, login, sendLyd, sendMail, sendReferat, aktivAndetSted = async () => false, nu = Date.now, vedAendring = () => {}, vedUpload = () => {},
  vedBidder = () => {}, opdeling = standardOpdeling, bidder = BIDDER,
}) {
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

  /** Delene på noten: filer (hver med sin type) eller dele af en afbrudt optagelse. */
  function delePaa(note) {
    if (note.kilde === 'filer' && Array.isArray(note.filer)) return note.filer.map((f) => ({ mime: f.mime, filnavn: f.navn, varighedMs: f.varighedMs }));
    const antal = note.dele ?? 1;
    // Med én del er notens længde delens længde. Afbrudte deles længde findes ved klipningen.
    return Array.from({ length: antal }, () => ({ mime: note.mime, ...(antal === 1 ? { varighedMs: note.varighedMs } : {}) }));
  }

  /**
   * Bidderne for én del. Kan lyden klippes, planlægges bidder på 30 min.; ellers er hele delen én bid.
   * Kun til denne afsendelse: indekset gemmes ikke, planen gør (så tekster altid hører til samme bid).
   */
  async function planForDel(kilde, del, gemtPlan) {
    const indeks = await opdeling.lavIndeks(kilde, del.mime).catch(() => null);
    if (gemtPlan) return { kilde, indeks, plan: gemtPlan };
    if (!indeks) {
      // Ukendt eller ødelagt indpakning: delen sendes hel, som før, hvis den ikke er for lang til ét kald.
      if (Number.isFinite(del.varighedMs) && del.varighedMs > MAKS_UDELT_MS) throw Object.assign(new Error('forLang'), { type: 'forLang' });
      return { kilde, indeks, plan: [{ nr: 0, startMs: 0, slutMs: del.varighedMs ?? null, overlapMs: 0, hel: true }] };
    }
    const plan = opdeling.planlaegBidder(indeks.varighedMs, indeks.enheder, bidder);
    // Én bid: delen sendes, som den er gemt, uden ny indpakning.
    if (plan.length === 1) plan[0].hel = true;
    return { kilde, indeks, plan, varighedMs: indeks.varighedMs };
  }

  /** Småbidder på 10 min. af en bid, som Googles filter afviste. Tider i forhold til delen. */
  function smaaPlan(indeks, bid) {
    if (!indeks || bid.hel && bid.slutMs === null) return [];
    const enheder = indeks.enheder.slice(bid.fraEnhed, bid.tilEnhed).map((e) => ({ ...e, tidMs: e.tidMs - bid.startMs }));
    const varighed = bid.slutMs - bid.startMs;
    if (varighed <= bidder.smaaBidMs || enheder.length < 2) return [];
    return opdeling.planlaegBidder(varighed, enheder, { bidMs: bidder.smaaBidMs, overlapMs: bidder.overlapMs, delFraMs: bidder.smaaBidMs })
      .map((s, k) => ({
        nr: k, startMs: bid.startMs + s.startMs, slutMs: bid.startMs + s.slutMs,
        overlapMs: k === 0 ? bid.overlapMs : s.overlapMs, fraEnhed: bid.fraEnhed + s.fraEnhed, tilEnhed: bid.fraEnhed + s.tilEnhed,
      }));
  }

  /** Et svar uden et eneste ord, hverken i teksten eller i afsnittene. */
  function erTomtSvar(svar) {
    const afsnit = Array.isArray(svar?.afsnit) ? svar.afsnit.map((a) => a?.tekst ?? '').join('') : '';
    return !String(svar?.tekst ?? '').trim() && !afsnit.trim();
  }

  /**
   * Transskriberer hver bid af hver del, højst SAMTIDIGE ad gangen, og laver ét referat via /referat.
   * Hver bids tekst gemmes, så snart den kommer, så et genforsøg aldrig sender noget, der er betalt.
   * Blokerer Googles filter en bid, prøves den i småbidder; en småbid, der også blokeres, mangler i referatet.
   */
  async function behandlBidder(id, note, bevis, signal) {
    const dele = delePaa(note);
    // Tilstanden: { [del]: { plan, varighedMs, tekster: { [nr]: { tekst, afsnit } | { mangler } | { smaa: { plan, tekster } } } } }.
    const tilstand = JSON.parse(JSON.stringify(note.bidder ?? {}));
    // Alle deles lyd i én gennemgang af lageret. En del uden lyd (appen lukket lige efter Fortsæt) er ikke med.
    const kildePr = await lager.lavKilder(id);
    const tom = (d) => !kildePr.has(d) || kildePr.get(d).stoerrelse === 0;
    const enBid = (tekst) => ({ plan: [{ nr: 0, startMs: 0, slutMs: null, overlapMs: 0, hel: true }], tekster: { 0: { tekst } } });
    // En note fra før bidderne: en gemt deltekst er en færdig del uden tider. Teksterne hørte til delene med lyd.
    const medLyd = dele.map((_, d) => d).filter((d) => !tom(d));
    (note.deltekster ?? []).forEach((tekst, i) => {
      const d = medLyd[i];
      if (typeof tekst === 'string' && d !== undefined && !tilstand[d]) tilstand[d] = enBid(tekst);
    });
    for (let d = 0; d < dele.length; d++) if (tom(d) && !tilstand[d]) tilstand[d] = { ...enBid(''), varighedMs: 0 };
    let skriv = Promise.resolve();
    const gem = () => {
      const kopi = JSON.parse(JSON.stringify(tilstand));
      skriv = skriv.then(() => lager.opdaterNote(id, { bidder: kopi }));
      return skriv;
    };

    const kilder = [];
    for (let d = 0; d < dele.length; d++) {
      const faerdig = tilstand[d] && tilstand[d].plan.every((b) => tilstand[d].tekster[b.nr] && !tilstand[d].tekster[b.nr].smaa?.plan.some((s) => !tilstand[d].tekster[b.nr].smaa.tekster[s.nr]));
      if (faerdig) continue;
      const p = await planForDel(kildePr.get(d), dele[d], tilstand[d]?.plan);
      kilder[d] = p;
      tilstand[d] ??= { plan: p.plan, tekster: {} };
      if (p.varighedMs) tilstand[d].varighedMs = p.varighedMs;
    }
    await gem();

    // Opgaverne: hver bid (eller småbid), der mangler sin tekst.
    const ventende = [];
    const opgave = (d, bid, smaa) => ventende.push({ d, bid, smaa });
    for (const [d, t] of Object.entries(tilstand)) {
      for (const bid of t.plan) {
        const svar = t.tekster[bid.nr];
        if (!svar) opgave(Number(d), bid, null);
        else if (svar.smaa) for (const s of svar.smaa.plan) if (!svar.smaa.tekster[s.nr]) opgave(Number(d), s, bid);
      }
    }
    const taelBidder = () => Object.values(tilstand).reduce((sum, t) => sum + t.plan.reduce((n, b) => n + (t.tekster[b.nr]?.smaa ? t.tekster[b.nr].smaa.plan.length : 1), 0), 0);
    const taelFaerdige = () => Object.values(tilstand).reduce((sum, t) => sum + t.plan.reduce((n, b) => {
      const svar = t.tekster[b.nr];
      if (!svar) return n;
      return n + (svar.smaa ? svar.smaa.plan.filter((s) => svar.smaa.tekster[s.nr]).length : 1);
    }, 0), 0);
    const meld = () => vedBidder(id, { ialt: taelBidder(), faerdige: taelFaerdige() });
    meld();

    let fejl = null;
    // Bytes sendt af de bidder, der er i gang, kun til skærmen.
    const upload = new Map();
    const meldUpload = () => {
      let sendt = 0;
      let ialt = 0;
      for (const u of upload.values()) { sendt += u.sendt; ialt += u.ialt; }
      vedUpload(id, sendt, ialt);
    };
    async function send({ d, bid, smaa }) {
      const del = dele[d];
      const { kilde, indeks } = kilder[d];
      const lyd = bid.hel ? await kilde.udsnit(0, kilde.stoerrelse) : await opdeling.lavBid(kilde, indeks, bid);
      if (signal.aborted || fejl) return;
      const varighedMs = Number.isFinite(bid.slutMs) ? bid.slutMs - bid.startMs : undefined;
      let resultat;
      try {
        // Kan bidden deles i småbidder (klippelig og længere end en småbid), prøver appen dem før Transcribe.
        const smaabidder = !smaa && Boolean(indeks) && Number.isFinite(varighedMs) && varighedMs > bidder.smaaBidMs;
        const sendBid = () => {
          const noegle = {};
          return sendLyd(lyd, del.mime, bevis, { kunTekst: true, afsnit: true, smaabidder, varighedMs, oprettet: note.oprettet }, undefined, {
            signal,
            // Skærmen viser bidder; "referatet laves" først, når alle bidder er færdige.
            vedSendt: () => {},
            vedFremdrift: (sendt, ialt) => { upload.set(noegle, { sendt, ialt }); meldUpload(); },
          }).finally(() => upload.delete(noegle));
        };
        let svar = await sendBid();
        // En tom bid godtages aldrig som stilhed: den prøves én gang til, og er den stadig tom, mangler den
        // (serveren skriver så "[Dette afsnit (tidsrum) kunne ikke transskriberes]").
        if (erTomtSvar(svar) && !signal.aborted && !fejl) svar = await sendBid();
        resultat = erTomtSvar(svar)
          ? { mangler: true, tom: true, tekst: '' }
          : { tekst: svar.tekst || '', ...(Array.isArray(svar.afsnit) ? { afsnit: svar.afsnit } : {}) };
      } catch (e) {
        if (e?.type !== 'blokeret') throw e;
        // Googles filter: en hel bid prøves i småbidder, en småbid (eller en bid, der ikke kan deles) mangler.
        const plan = smaa ? [] : smaaPlan(indeks, bid);
        if (plan.length) {
          tilstand[d].tekster[bid.nr] = { smaa: { plan, tekster: {} } };
          for (const s of plan) ventende.push({ d, bid: s, smaa: bid });
          await gem();
          meld();
          return;
        }
        resultat = { mangler: true, tekst: '' };
      }
      if (smaa) tilstand[d].tekster[smaa.nr].smaa.tekster[bid.nr] = resultat;
      else tilstand[d].tekster[bid.nr] = resultat;
      await gem();
      meld();
    }

    async function arbejder() {
      while (ventende.length && !fejl && !signal.aborted) {
        const naeste = ventende.shift();
        try {
          await send(naeste);
        } catch (e) {
          fejl ??= e;
        }
      }
    }
    await Promise.all(Array.from({ length: SAMTIDIGE_BIDDER }, arbejder));
    await skriv;
    if (signal.aborted) throw Object.assign(new Error('net'), { type: 'net' });
    if (fejl) throw fejl;

    await fremdrift(id, 'laver');
    const tilServer = dele.map((del, d) => {
      const t = tilstand[d];
      const bidListe = t.plan.flatMap((bid) => {
        const svar = t.tekster[bid.nr];
        const enkelt = (b, s) => ({
          tom: s.tom === true,
          startSek: b.startMs / 1000, overlapSek: b.overlapMs / 1000,
          varighedSek: Number.isFinite(b.slutMs) ? (b.slutMs - b.startMs) / 1000 : 0,
          tekst: s.tekst || '', ...(s.afsnit ? { afsnit: s.afsnit } : {}), ...(s.mangler ? { mangler: true } : {}),
        });
        return svar.smaa ? svar.smaa.plan.map((s) => enkelt(s, svar.smaa.tekster[s.nr])) : [enkelt(bid, svar)];
      });
      return {
        ...(del.filnavn ? { filnavn: del.filnavn } : {}),
        afbrudt: d > 0 && note.kilde !== 'filer',
        ...(Number.isFinite(t.varighedMs) ? { varighedSek: t.varighedMs / 1000 } : {}),
        bidder: bidListe,
      };
    });
    const alle = tilServer.flatMap((d) => d.bidder);
    // Intet ord nogen steder: "ingen tale" som før. Ellers blokeret, hvis Googles filter afviste det hele.
    if (!alle.some((b) => b.tekst.trim()) && alle.every((b) => b.mangler ? b.tom : true)) return { tekst: '' };
    if (alle.every((b) => b.mangler)) throw Object.assign(new Error('blokeret'), { type: 'blokeret' });
    for (const d of tilServer) for (const b of d.bidder) delete b.tom;
    return sendReferat(
      { dele: tilServer, titel: note.titel, type: note.type, varighedMs: note.varighedMs, oprettet: note.oprettet },
      bevis,
      undefined,
      { signal },
    );
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
        // Flere dele, flere filer, en lang optagelse eller ukendt længde går i bidder. En note med gemte tekster
        // er (delvis) transskriberet og går altid den vej, så lyd, der allerede er betalt for, aldrig sendes igen.
        const viaDele = (note.dele ?? 1) > 1 || note.deltekster?.length > 0 || note.kilde === 'filer' || note.bidder !== undefined
          || note.varighedMs > bidder.delFraMs || (!Number.isFinite(note.varighedMs) && (note.bytes ?? 0) > UKENDT_LANG_BYTES);
        let svar = viaDele
          ? await behandlBidder(id, note, bevis, signal)
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
        for (const k of ['titel', 'type', 'referat', 'pdf', 'filnavn', 'docx', 'docxFilnavn', 'emne', 'html', 'huller', 'mangler']) if (svar[k] !== undefined) felter[k] = svar[k];
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
