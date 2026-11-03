import { STATUS, efterGenstart } from './tilstand.js';
import { rensType } from './typer.js';

// Optager og sender kan stå tilbage, hvis lageret svigtede. Dobbeltkald forhindres af eneAdgang.
const KAN_BEHANDLES = new Set([STATUS.GEMT, STATUS.FEJL, STATUS.OPTAGER, STATUS.SENDER]);
// En optagelse, der har gemt lyd for nylig, kan stadig køre i en anden fane.
const FRISK_MS = 30 * 1000;

/**
 * Binder lager, login og afsendelse sammen. Lyd slettes kun, når mailen er accepteret,
 * eller brugeren selv vælger Slet. Alle fejl ender i en tilstand, hvor man kan prøve igen.
 */
export function lavForloeb({ lager, login, sendLyd, sendMail, aktivAndetSted = async () => false, nu = Date.now }) {
  const igang = new Set();

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

  async function opdaterTrygt(id, felter) {
    try {
      await lager.opdaterNote(id, felter);
    } catch {
      // Lyden er stadig gemt, og noten rettes ved næste start.
    }
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
    behandl: (id) => eneAdgang(id, async () => {
      const note = await lager.hentNote(id);
      if (!note || !KAN_BEHANDLES.has(note.status)) return;
      if (note.status === STATUS.OPTAGER) {
        const andetSted = await aktivAndetSted(id).catch(() => null);
        if (andetSted === true || (andetSted !== false && maaskeIGang(note, null))) return;
      }
      try {
        await lager.opdaterNote(id, { status: STATUS.SENDER, fejlType: undefined });
        const bevis = await login.hentBevis('api');
        const lyd = await lager.hentLyd(id);
        const svar = await sendLyd(lyd, note.mime, bevis, {
          titel: note.titel, type: note.type, varighedMs: note.varighedMs, oprettet: note.oprettet,
        });
        if (!svar.tekst) {
          await lager.opdaterNote(id, { status: STATUS.FEJL, fejlType: 'ingenTale' });
          return;
        }
        const felter = { status: STATUS.TEKST_KLAR, tekst: svar.tekst };
        for (const k of ['titel', 'type', 'referat', 'pdf', 'filnavn', 'emne', 'html']) if (svar[k] !== undefined) felter[k] = svar[k];
        await lager.opdaterNote(id, felter);
      } catch (e) {
        await opdaterTrygt(id, { status: STATUS.FEJL, fejlType: e?.type || 'tjeneste' });
      }
    }),

    sendTilMig: (id) => eneAdgang(id, async () => {
      const note = await lager.hentNote(id);
      if (!note || note.status !== STATUS.TEKST_KLAR) return;
      try {
        await lager.opdaterNote(id, { status: STATUS.SENDER_MAIL, fejlType: undefined });
        const bevis = await login.hentBevis('mail');
        await sendMail({ note, til: login.brugerMail(), bevis });
      } catch (e) {
        if (e?.type === 'mailUkendt') {
          // Mailen kan være sendt. Brugeren tjekker indbakken i stedet for at få en dobbelt mail.
          await opdaterTrygt(id, { status: STATUS.TEKST_KLAR, maaskeSendt: true });
          return;
        }
        await opdaterTrygt(id, {
          status: STATUS.TEKST_KLAR,
          fejlType: e?.type === 'login' ? 'login' : 'mailFejl',
        });
        return;
      }
      try {
        await lager.sletNote(id);
      } catch {
        // Noten står som sender-mail og får advarslen om mulig afsendelse ved næste start.
      }
    }),

    /** Laver referatet, hvis det mangler, og sender det derefter selv. Bruges også af Prøv igen. */
    async behandlOgSend(id) {
      await forloeb.behandl(id);
      const note = await lager.hentNote(id);
      // En mulig dobbelt mail skal brugeren selv tage stilling til.
      if (note?.status === STATUS.TEKST_KLAR && !note.maaskeSendt) await forloeb.sendTilMig(id);
    },

    /** Gemmer navnet, før noget sendes, så det overlever netværksfejl og genforsøg. */
    async navngivOgSend(id, titel, type) {
      // Afkortes i hele tegn, så en emoji aldrig deles.
      const ren = [...String(titel || '').trim()].slice(0, 120).join('').trim();
      // Uden ny type beholdes den, der blev valgt før optagelsen.
      await lager.opdaterNote(id, { titel: ren, navngivet: true, ...(type === undefined ? {} : { type: rensType(type) }) });
      await forloeb.behandlOgSend(id);
    },

    /**
     * Retter noter, der stod midt i noget, da appen blev lukket. Sender intet af sig selv.
     * aktiveAndetSted er låsene eller en funktion, der henter dem. Funktionen kaldes først, når
     * noterne er læst, så en optagelse, der starter imens, altid ses med sin lås.
     * Låsene er null, når de ikke kan ses. Så røres en frisk optagelse ikke.
     */
    async genoptag(aktiveAndetSted = new Set()) {
      const vist = [];
      const noter = await lager.alleNoter();
      const aktive = typeof aktiveAndetSted === 'function' ? await aktiveAndetSted() : aktiveAndetSted;
      for (const note of noter) {
        // En optagelse, der stadig kører i en anden fane eller i den installerede app, er ikke vores.
        if (maaskeIGang(note, aktive)) continue;
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
      await lager.sletNote(id);
    },

    async slet(id) {
      const note = await lager.hentNote(id);
      if (note?.status !== STATUS.FEJL) throw new Error('Kun fejlede optagelser kan slettes');
      await lager.sletNote(id);
    },
  };
  return forloeb;
}
