// MP3: en række rammer, hver med sit eget hoved. En bid er et sammenhængende udsnit af rammerne.
// ID3-mærker og Xing/Info-rammen (en tavs ramme med tal for hele filen) tages ikke med.

const BITRATE = {
  '1-1': [0, 32, 64, 96, 128, 160, 192, 224, 256, 288, 320, 352, 384, 416, 448],
  '1-2': [0, 32, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320, 384],
  '1-3': [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320],
  '2-1': [0, 32, 48, 56, 64, 80, 96, 112, 128, 144, 160, 176, 192, 224, 256],
  '2-2': [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160],
  '2-3': [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160],
};
const RATE = { 1: [44100, 48000, 32000], 2: [22050, 24000, 16000], 25: [11025, 12000, 8000] };
const BLOK = 1024 * 1024;
const MAKS_SPRING = 64 * 1024;

/** Rammens hoved: { laengde, prover, rate } eller null. */
function hoved(b, i) {
  if (b[i] !== 0xff || (b[i + 1] & 0xe0) !== 0xe0) return null;
  const v = (b[i + 1] >> 3) & 3;
  const lag = 4 - ((b[i + 1] >> 1) & 3);
  const brIdx = b[i + 2] >> 4;
  const srIdx = (b[i + 2] >> 2) & 3;
  if (v === 1 || lag === 4 || brIdx === 0 || brIdx === 15 || srIdx === 3) return null;
  const version = v === 3 ? 1 : v === 2 ? 2 : 25;
  const br = BITRATE[`${version === 1 ? 1 : 2}-${lag}`][brIdx] * 1000;
  const rate = RATE[version][srIdx];
  const pad = (b[i + 2] >> 1) & 1;
  let laengde;
  let prover;
  if (lag === 1) {
    laengde = (Math.floor((12 * br) / rate) + pad) * 4;
    prover = 384;
  } else {
    const smal = lag === 3 && version !== 1;
    laengde = Math.floor(((smal ? 72 : 144) * br) / rate) + pad;
    prover = smal ? 576 : 1152;
  }
  return { laengde, prover, rate };
}

/** Læser kilden i blokke, så en stor fil aldrig ligger i hukommelsen på én gang. */
function laeser(kilde) {
  let start = 0;
  let buf = new Uint8Array(0);
  return async (pos, antal) => {
    if (pos < start || pos + antal > start + buf.length) {
      start = pos;
      buf = await kilde.laes(pos, pos + Math.max(BLOK, antal));
    }
    return { buf, i: pos - start, ok: pos + antal <= start + buf.length };
  };
}

const erVbrHoved = (b, i, laengde) => {
  const s = String.fromCharCode(...b.subarray(i, Math.min(b.length, i + Math.min(laengde, 64))));
  return /Xing|Info|VBRI/.test(s);
};

export async function lavIndeks(kilde) {
  const hent = laeser(kilde);
  let pos = 0;
  let slut = kilde.stoerrelse;
  const id3 = await kilde.laes(0, 10);
  if (id3.length === 10 && id3[0] === 0x49 && id3[1] === 0x44 && id3[2] === 0x33) {
    const str = ((id3[6] & 0x7f) << 21) | ((id3[7] & 0x7f) << 14) | ((id3[8] & 0x7f) << 7) | (id3[9] & 0x7f);
    pos = 10 + str + (id3[5] & 0x10 ? 10 : 0);
  }
  if (slut >= 128) {
    const tag = await kilde.laes(slut - 128, slut - 125);
    if (tag[0] === 0x54 && tag[1] === 0x41 && tag[2] === 0x47) slut -= 128;
  }

  // Første ramme: dens hoved og det næste skal begge være gyldige, så støj ikke tages for en ramme.
  for (let spring = 0; ; pos++, spring++) {
    if (spring > MAKS_SPRING || pos + 4 > slut) return null;
    const { buf, i } = await hent(pos, 4);
    const h = hoved(buf, i);
    if (!h) continue;
    const naeste = await hent(pos + h.laengde, 4);
    if (pos + h.laengde === slut || (naeste.ok && hoved(naeste.buf, naeste.i))) break;
  }

  const enheder = [];
  let tidUs = 0;
  let foerste = true;
  while (pos + 4 <= slut) {
    const { buf, i } = await hent(pos, 4);
    const h = hoved(buf, i);
    if (!h) break;
    const helt = await hent(pos, Math.min(h.laengde, 64));
    if (foerste && erVbrHoved(helt.buf, helt.i, h.laengde)) {
      foerste = false;
      pos += h.laengde;
      continue;
    }
    foerste = false;
    if (pos + h.laengde > slut) break;
    const tidMs = Math.round(tidUs / 1000);
    // En ny enhed for hvert sekund lyd.
    if (!enheder.length || tidMs >= enheder.length * 1000) enheder.push({ tidMs, fra: pos, til: pos + h.laengde });
    else enheder[enheder.length - 1].til = pos + h.laengde;
    tidUs += (h.prover / h.rate) * 1e6;
    pos += h.laengde;
  }
  return { format: 'mp3', varighedMs: Math.round(tidUs / 1000), enheder, hoved: {} };
}

export async function lavBid(kilde, indeks, { fraEnhed, tilEnhed }) {
  return new Blob([await kilde.udsnit(indeks.enheder[fraEnhed].fra, indeks.enheder[tilEnhed - 1].til)], { type: 'audio/mpeg' });
}
