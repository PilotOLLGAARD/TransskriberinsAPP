export const STATUS = {
  OPTAGER: 'optager',
  GEMT: 'gemt',
  SENDER: 'sender',
  TEKST_KLAR: 'tekst-klar',
  SENDER_MAIL: 'sender-mail',
  FEJL: 'fejl',
};

/** En note, der stod midt i noget, da appen blev lukket. Sender aldrig noget af sig selv. */
export function efterGenstart(note) {
  if (note.status === STATUS.OPTAGER) return { ...note, status: STATUS.GEMT, afbrudt: true };
  if (note.status === STATUS.SENDER) return { ...note, status: STATUS.FEJL, fejlType: 'net' };
  if (note.status === STATUS.SENDER_MAIL) return { ...note, status: STATUS.TEKST_KLAR, maaskeSendt: true };
  return note;
}
