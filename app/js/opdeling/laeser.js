// Læser en kilde i blokke på 1 MB, så indeksering af en stor fil hverken ligger i hukommelsen på én gang
// eller kalder kilden for hver lille stump.

const BLOK = 1024 * 1024;

/** hent(pos, antal) -> { buf, i, ok }: bytes fra pos ligger i buf fra i; ok er false ved filens slutning. */
export function lavLaeser(kilde) {
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
