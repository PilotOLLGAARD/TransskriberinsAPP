// Notifikationer fra telefonen selv (ingen push fra serveren). De vises via service workeren, kun med brugerens lov.
// Intet her må stoppe en optagelse eller en afsendelse: alle fejl sluges.

/**
 * Hver slags har sit eget tag. En ny notifikation af samme slags erstatter den gamle, så der aldrig ligger to.
 * maal er det sted i appen, et tryk åbner (se sw.js og aabnFraNotifikation i app.js).
 */
export const NOTIFIKATIONER = {
  stoppet: { tag: 'optagelse', tekst: 'Optagelsen er stoppet – åbn appen for at fortsætte', maal: 'navn' },
  ikkeSendtEndnu: { tag: 'referat', tekst: 'Referatet er ikke sendt endnu – åbn appen, så det bliver færdigt', maal: 'start' },
  sendt: { tag: 'referat', tekst: 'Dit referat er sendt til din mail', maal: 'tidligere', lyd: true },
  fejlet: { tag: 'referat', tekst: 'Referatet blev ikke sendt – åbn appen, og tryk Prøv igen', maal: 'start', lyd: true },
};

export function lavNotifikationer({
  notifikation = globalThis.Notification,
  serviceWorker = globalThis.navigator?.serviceWorker,
} = {}) {
  // Registreringen hentes én gang med det samme. Så kan en notifikation vises uden at vente, når appen skjules:
  // iPhone sætter appen på pause kort efter.
  let registrering = null;
  let klar;
  try {
    klar = Promise.resolve(serviceWorker?.ready).then((r) => { registrering = r ?? null; return registrering; }, () => null);
  } catch {
    klar = Promise.resolve(null);
  }
  const hent = async () => registrering ?? klar;

  return {
    /** Viser en notifikation af slagen type. Giver true, hvis den blev vist. */
    async vis(type, id = null) {
      const n = NOTIFIKATIONER[type];
      if (!n || notifikation?.permission !== 'granted') return false;
      try {
        const reg = await hent();
        if (!reg) return false;
        await reg.showNotification('Transskribering', {
          body: n.tekst, tag: n.tag, data: { maal: n.maal, id }, renotify: Boolean(n.lyd),
        });
        return true;
      } catch {
        return false;
      }
    },

    /** Fjerner appens notifikationer, fx når appen åbnes og selv viser status. */
    async luk() {
      try {
        const reg = await hent();
        for (const n of (await reg?.getNotifications?.()) ?? []) n.close();
      } catch { /* Bliver liggende. */ }
    },

    /** 'til', 'fra' (afvist), 'spoerg' (ikke afgjort) eller 'mangler' (fx en Safari-fane på iPhone). */
    tilstand() {
      const p = notifikation?.permission;
      if (p === 'granted') return 'til';
      if (p === 'denied') return 'fra';
      if (p === 'default') return 'spoerg';
      return 'mangler';
    },

    /** Spørger om lov, når det ikke er afgjort. Skal kaldes ved et tryk. */
    async bedOmTilladelse() {
      if (notifikation?.permission !== 'default') return;
      try {
        await notifikation.requestPermission();
      } catch { /* Ingen notifikationer, men appen virker som før. */ }
    },
  };
}
