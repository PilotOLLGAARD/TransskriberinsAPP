import { STATUS, efterGenstart } from './tilstand.js';

const KAN_BEHANDLES = new Set([STATUS.GEMT, STATUS.FEJL]);

/**
 * Binder lager, login og afsendelse sammen. Lyd slettes kun, når mailen er accepteret,
 * eller brugeren selv vælger Slet. Alle fejl ender i en tilstand, hvor man kan prøve igen.
 */
export function lavForloeb({ lager, login, sendLyd, sendMail }) {
  const igang = new Set();

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
      await lager.opdaterNote(id, { status: STATUS.SENDER, fejlType: undefined });
      try {
        const bevis = await login.hentBevis('api');
        const lyd = await lager.hentLyd(id);
        const { tekst } = await sendLyd(lyd, note.mime, bevis);
        if (tekst) await lager.opdaterNote(id, { status: STATUS.TEKST_KLAR, tekst });
        else await lager.opdaterNote(id, { status: STATUS.FEJL, fejlType: 'ingenTale' });
      } catch (e) {
        await lager.opdaterNote(id, { status: STATUS.FEJL, fejlType: e?.type || 'tjeneste' });
      }
    }),

    sendTilMig: (id) => eneAdgang(id, async () => {
      const note = await lager.hentNote(id);
      if (!note || note.status !== STATUS.TEKST_KLAR) return;
      await lager.opdaterNote(id, { status: STATUS.SENDER_MAIL, fejlType: undefined });
      try {
        const bevis = await login.hentBevis('mail');
        await sendMail({ tekst: note.tekst, til: login.brugerMail(), oprettet: note.oprettet, bevis });
      } catch (e) {
        await lager.opdaterNote(id, {
          status: STATUS.TEKST_KLAR,
          fejlType: e?.type === 'login' ? 'login' : 'mailFejl',
        });
        return;
      }
      await lager.sletNote(id);
    }),

    /** Retter noter, der stod midt i noget, da appen blev lukket. Sender intet af sig selv. */
    async genoptag() {
      for (const note of await lager.alleNoter()) {
        // Lukket før første stykke blev gemt: Der er intet at gemme.
        if (note.status === STATUS.OPTAGER && (await lager.hentLyd(note.id)).size === 0) {
          await lager.sletNote(note.id);
          continue;
        }
        const rettet = efterGenstart(note);
        if (rettet !== note) await lager.opdaterNote(note.id, rettet);
      }
      return lager.alleNoter();
    },

    async slet(id) {
      const note = await lager.hentNote(id);
      if (note?.status !== STATUS.FEJL) throw new Error('Kun fejlede optagelser kan slettes');
      await lager.sletNote(id);
    },
  };
}
