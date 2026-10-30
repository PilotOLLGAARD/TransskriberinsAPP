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

  return {
    behandl: (id) => eneAdgang(id, async () => {
      const note = await lager.hentNote(id);
      if (!note || !KAN_BEHANDLES.has(note.status)) return;
      try {
        await lager.opdaterNote(id, { status: STATUS.SENDER, fejlType: undefined });
        const bevis = await login.hentBevis('api');
        const lyd = await lager.hentLyd(id);
        const { tekst } = await sendLyd(lyd, note.mime, bevis);
        if (tekst) await lager.opdaterNote(id, { status: STATUS.TEKST_KLAR, tekst });
        else await lager.opdaterNote(id, { status: STATUS.FEJL, fejlType: 'ingenTale' });
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
        await sendMail({ tekst: note.tekst, til: login.brugerMail(), oprettet: note.oprettet, bevis });
      } catch (e) {
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

    /** Retter noter, der stod midt i noget, da appen blev lukket. Sender intet af sig selv. */
    async genoptag() {
      const vist = [];
      for (const note of await lager.alleNoter()) {
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
}
