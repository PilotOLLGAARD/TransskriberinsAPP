// WAV: et RIFF-hoved, en fmt-del og prøverne i data. En bid får et nyt hoved med sin længde og
// præcis de samme prøver. Klippes kun mellem hele prøver (blockAlign).

const tekst = (b, i) => String.fromCharCode(b[i], b[i + 1], b[i + 2], b[i + 3]);
const u32 = (b, i) => b[i] | (b[i + 1] << 8) | (b[i + 2] << 16) | (b[i + 3] * 0x1000000);

export async function lavIndeks(kilde) {
  const start = await kilde.laes(0, 12);
  if (start.length < 12 || tekst(start, 0) !== 'RIFF' || tekst(start, 8) !== 'WAVE') return null;
  let pos = 12;
  let fmt = null;
  while (pos + 8 <= kilde.stoerrelse) {
    const h = await kilde.laes(pos, pos + 8);
    const id = tekst(h, 0);
    const str = u32(h, 4);
    if (id === 'fmt ') {
      fmt = await kilde.laes(pos, pos + 8 + str + (str & 1));
    } else if (id === 'data') {
      if (!fmt) return null;
      const blockAlign = fmt[20] | (fmt[21] << 8);
      const byteRate = u32(fmt, 16);
      if (!blockAlign || !byteRate || byteRate % blockAlign) return null;
      const fra = pos + 8;
      // Nogle optagere skriver ikke størrelsen færdig. Så gælder filens slutning.
      const raa = Math.min(str, kilde.stoerrelse - fra);
      const stoerrelse = raa - (raa % blockAlign);
      if (stoerrelse <= 0) return null;
      const enheder = [];
      for (let i = 0; i * byteRate < stoerrelse; i++) {
        enheder.push({ tidMs: i * 1000, fra: fra + i * byteRate, til: fra + Math.min((i + 1) * byteRate, stoerrelse) });
      }
      return { format: 'wav', varighedMs: Math.round((stoerrelse / byteRate) * 1000), enheder, hoved: { fmt } };
    }
    pos += 8 + str + (str & 1);
  }
  return null;
}

export async function lavBid(kilde, indeks, { fraEnhed, tilEnhed }) {
  const fra = indeks.enheder[fraEnhed].fra;
  const til = indeks.enheder[tilEnhed - 1].til;
  const { fmt } = indeks.hoved;
  const hoved = new Uint8Array(12 + fmt.length + 8);
  const v = new DataView(hoved.buffer);
  hoved.set(new TextEncoder().encode('RIFF'), 0);
  v.setUint32(4, 4 + fmt.length + 8 + (til - fra), true);
  hoved.set(new TextEncoder().encode('WAVE'), 8);
  hoved.set(fmt, 12);
  hoved.set(new TextEncoder().encode('data'), 12 + fmt.length);
  v.setUint32(12 + fmt.length + 4, til - fra, true);
  return new Blob([hoved, await kilde.udsnit(fra, til)], { type: 'audio/wav' });
}
