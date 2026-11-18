// Klipning af lange optagelser i bidder, uden at røre lyden. Kun filens indpakning skrives på ny;
// lydrammerne kopieres byte for byte. Se docs/plan-lange-optagelser.md (privat) og CLAUDE.md.
//
// En kilde er der, hvor lyden ligger: { stoerrelse, laes(fra, til) -> Uint8Array, udsnit(fra, til) -> Blob }.
// Et indeks er { format, varighedMs, enheder: [{ tidMs, fra, til }], hoved }, hvor en enhed er det mindste,
// der kan klippes ved (ca. ét sekund, et fragment eller en klynge).

import * as wav from './wav.js';
import * as mp3 from './mp3.js';
import * as mp4 from './mp4.js';
import * as webm from './webm.js';

const MODULER = { wav, mp3, mp4, mp4f: mp4, webm };
// En sidste rest under en sjettedel af en bid (5 min. ved 30 min.) lægges til bidden før, så der ikke
// sendes en lille bid for sig.
const MIN_REST_ANDEL = 1 / 6;

function formatFor(mime) {
  const m = String(mime || '').split(';')[0].trim().toLowerCase();
  if (['audio/mp4', 'audio/x-m4a', 'audio/m4a', 'video/mp4'].includes(m)) return 'mp4';
  if (['audio/webm', 'video/webm'].includes(m)) return 'webm';
  if (['audio/mpeg', 'audio/mp3'].includes(m)) return 'mp3';
  if (['audio/wav', 'audio/x-wav', 'audio/wave'].includes(m)) return 'wav';
  return null;
}

/** Om lyd af denne type kan klippes. ogg, flac og aac sendes hele. */
export function kanKlippes(mime) {
  return formatFor(mime) !== null;
}

/** En kilde, der læser fra en Blob (en valgt fil eller en samlet bid). */
export function blobKilde(blob) {
  return {
    stoerrelse: blob.size,
    laes: async (fra, til) => new Uint8Array(await blob.slice(Math.max(0, fra), Math.min(blob.size, til)).arrayBuffer()),
    udsnit: async (fra, til) => blob.slice(fra, til),
  };
}

/** Indekset over lyden, eller null, når den ikke kan klippes (ukendt eller ødelagt). Kaster aldrig. */
export async function lavIndeks(kilde, mime) {
  const format = formatFor(mime);
  if (!format) return null;
  try {
    const indeks = await MODULER[format].lavIndeks(kilde);
    return indeks && indeks.enheder.length && indeks.varighedMs > 0 ? indeks : null;
  } catch {
    return null;
  }
}

/** Første enhed, der starter ved eller efter tid (binær søgning). */
function foersteFra(enheder, tidMs) {
  let lav = 0;
  let hoej = enheder.length;
  while (lav < hoej) {
    const m = (lav + hoej) >> 1;
    if (enheder[m].tidMs < tidMs) lav = m + 1;
    else hoej = m;
  }
  return lav;
}

/**
 * Bidderne for en del: [{ nr, startMs, slutMs, overlapMs, fraEnhed, tilEnhed }] (tilEnhed er ikke med).
 * Op til delFraMs: én bid. Ellers bid k fra k·bidMs − overlapMs til (k+1)·bidMs, start rundet ned og slut rundet
 * op til en enhed, så overlappet aldrig bliver mindre end ønsket.
 */
export function planlaegBidder(varighedMs, enheder, { bidMs, overlapMs, delFraMs }) {
  const n = enheder.length;
  if (varighedMs <= delFraMs) return [{ nr: 0, startMs: 0, slutMs: varighedMs, overlapMs: 0, fraEnhed: 0, tilEnhed: n }];
  let antal = Math.floor(varighedMs / bidMs);
  if (varighedMs - antal * bidMs >= bidMs * MIN_REST_ANDEL || antal === 0) antal++;
  const ud = [];
  for (let k = 0; k < antal; k++) {
    const sidste = k === antal - 1;
    const oensketStart = k === 0 ? 0 : k * bidMs - overlapMs;
    let fraEnhed = foersteFra(enheder, oensketStart);
    if (fraEnhed >= n || enheder[fraEnhed].tidMs > oensketStart) fraEnhed = Math.max(0, fraEnhed - 1);
    const tilEnhed = sidste ? n : Math.min(n, foersteFra(enheder, (k + 1) * bidMs));
    const startMs = enheder[fraEnhed].tidMs;
    const slutMs = tilEnhed < n ? enheder[tilEnhed].tidMs : varighedMs;
    ud.push({ nr: k, startMs, slutMs, overlapMs: k === 0 ? 0 : ud[k - 1].slutMs - startMs, fraEnhed, tilEnhed });
  }
  return ud;
}

/** Bidden som en Blob: et nyt hoved og udsnit af kilden. Lyden kopieres uændret. */
export async function lavBid(kilde, indeks, bid) {
  return MODULER[indeks.format].lavBid(kilde, indeks, bid);
}
