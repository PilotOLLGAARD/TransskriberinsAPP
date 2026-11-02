import { STATUS, efterGenstart } from './tilstand.js';

// Optager og sender kan stå tilbage, hvis lageret svigtede. Dobbeltkald forhindres af eneAdgang.
const KAN_BEHANDLES = new Set([STATUS.GEMT, STATUS.FEJL, STATUS.OPTAGER, STATUS.SENDER]);

/**
 * Binder lager, login og afsendelse sammen. Lyd slettes kun, når mailen er accepteret,
 * eller brugeren selv vælger Slet. Alle fejl ender i en tilstand, hvor man kan prøve igen.
 */
export function lavForloeb({ lager, login, sendLyd, sendMail }) {
  const igang = new Set();

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
      try {
        await lager.opdaterNote(id, { status: STATUS.SENDER, fejlType: undefined });
        const bevis = await login.hentBevis('api');
        const lyd = await lager.hentLyd(id);
        const svar = await sendLyd(lyd, note.mime, bevis, { titel: note.titel, varighedMs: note.varighedMs, oprettet: note.oprettet });
        if (!svar.tekst) {
          await lager.opdaterNote(id, { status: STATUS.FEJL, fejlType: 'ingenTale' });
          return;
        }
        const felter = { status: STATUS.TEKST_KLAR, tekst: svar.tekst };
        for (const k of ['titel', 'referat', 'pdf', 'filnavn']) if (svar[k] !== undefined) felter[k] = svar[k];
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
    async navngivOgSend(id, titel) {
      // Afkortes i hele tegn, så en emoji aldrig deles.
      const ren = [...String(titel || '').trim()].slice(0, 120).join('').trim();
      await lager.opdaterNote(id, { titel: ren, navngivet: true });
      await forloeb.behandlOgSend(id);
    },

    /** Retter noter, der stod midt i noget, da appen blev lukket. Sender intet af sig selv. */
    async genoptag(aktiveAndetSted = new Set()) {
      const vist = [];
      for (const note of await lager.alleNoter()) {
        // En optagelse, der stadig kører i en anden fane eller i den installerede app, er ikke vores.
        if (aktiveAndetSted.has(note.id)) continue;
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
