export const STATUS = {
  OPTAGER: 'optager',
  GEMT: 'gemt',
  SENDER: 'sender',
  TEKST_KLAR: 'tekst-klar',
  SENDER_MAIL: 'sender-mail',
  FEJL: 'fejl',
  SENDT: 'sendt',
};

/** Så længe bliver referat og PDF på telefonen efter første afsendelse. Lyden slettes ved afsendelse. */
export const OPBEVARING_MS = 7 * 24 * 60 * 60 * 1000;
/** Så længe kan en sletning fortrydes. Derefter slettes noten helt. */
export const FORTRYD_MS = 7 * 1000;
const DAG_MS = 24 * 60 * 60 * 1000;

/** Hele dage, til en sendt note slettes (0 = i dag). null for noter, der ikke slettes automatisk. */
export function slettesOm(note, nu = Date.now()) {
  if (note?.status !== STATUS.SENDT || !Number.isFinite(note.sendt)) return null;
  return Math.max(0, Math.ceil((note.sendt + OPBEVARING_MS - nu) / DAG_MS));
}

/** En note, der stod midt i noget, da appen blev lukket. Sender aldrig noget af sig selv. */
export function efterGenstart(note) {
  if (note.status === STATUS.OPTAGER) return { ...note, status: STATUS.GEMT, afbrudt: true };
  if (note.status === STATUS.SENDER) return { ...note, status: STATUS.FEJL, fejlType: 'net' };
  if (note.status === STATUS.SENDER_MAIL) return { ...note, status: STATUS.TEKST_KLAR, maaskeSendt: true };
  return note;
}
