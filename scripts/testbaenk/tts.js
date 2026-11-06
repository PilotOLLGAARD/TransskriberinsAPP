'use strict';
// Talesyntese med Gemini TTS til testlyd. Manuskriptet er facit. Kun opdigtet indhold.
const fs = require('node:fs');

const MODEL = 'gemini-3.8-flash-lite-tts';
const BASE = 'https://generativelanguage.googleapis.com/v1beta';

/** WAV-hoved til rå 16-bit PCM. */
function wav(pcm, rate = 24000) {
  const h = Buffer.alloc(44);
  h.write('RIFF', 0); h.writeUInt32LE(36 + pcm.length, 4); h.write('WAVE', 8);
  h.write('fmt ', 12); h.writeUInt32LE(16, 16); h.writeUInt16LE(1, 20); h.writeUInt16LE(1, 22);
  h.writeUInt32LE(rate, 24); h.writeUInt32LE(rate * 2, 28); h.writeUInt16LE(2, 32); h.writeUInt16LE(16, 34);
  h.write('data', 36); h.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([h, pcm]);
}

/**
 * @param {{ tekst: string, stemmer: Record<string,string>, stil?: string }} m  stemmer: taler → Gemini-stemme. Én eller to talere.
 * @returns {Promise<{ wav: Buffer, tokens: { ind: number, ud: number } }>}
 */
async function syntetiser({ tekst, stemmer, stil = '' }, noegle = process.env.GEMINI_API_KEY) {
  const navne = Object.keys(stemmer);
  const speechConfig = navne.length > 1
    ? { multiSpeakerVoiceConfig: { speakerVoiceConfigs: navne.map((speaker) => ({ speaker, voiceConfig: { prebuiltVoiceConfig: { voiceName: stemmer[speaker] } } })) } }
    : { voiceConfig: { prebuiltVoiceConfig: { voiceName: stemmer[navne[0]] } } };
  // Kun teksten. En instruktion på dansk bliver læst højt. En stil gives på engelsk, som modellen ikke læser op.
  const tekstDel = stil ? `${stil}:\n${tekst}` : tekst;
  const s = await fetch(`${BASE}/models/${MODEL}:generateContent`, {
    method: 'POST',
    headers: { 'x-goog-api-key': noegle, 'content-type': 'application/json' },
    body: JSON.stringify({
      // Flere talere: hver replik er sin egen del med taleren angivet ("Mette: ..." pr. linje i manuskriptet).
      contents: [{
        parts: navne.length > 1
          ? tekst.split('\n').filter(Boolean).map((l) => {
            const [, speaker, replik] = /^([^:]+):\s*(.*)$/.exec(l);
            return { text: replik, speechMetadata: { speaker } };
          })
          : [{ text: tekstDel }],
      }],
      generationConfig: { responseModalities: ['AUDIO'], speechConfig },
    }),
  });
  const j = await s.json();
  if (!s.ok) throw new Error(`TTS status ${s.status} ${j.error?.status ?? ''}`);
  const del = j.candidates?.[0]?.content?.parts?.find((p) => p.inlineData);
  if (!del) throw new Error('TTS uden lyd');
  const rate = Number(/rate=(\d+)/.exec(del.inlineData.mimeType)?.[1] ?? 24000);
  return {
    wav: wav(Buffer.from(del.inlineData.data, 'base64'), rate),
    tokens: { ind: j.usageMetadata?.promptTokenCount ?? 0, ud: j.usageMetadata?.candidatesTokenCount ?? 0 },
  };
}

/** Pris i USD for gemini-3.8-flash-lite-tts til og med 31.12.2026: 0,50 ind og 6,00 ud pr. mio. tokens. */
const ttsPris = ({ ind, ud }) => (ind * 0.5 + ud * 6) / 1e6;

module.exports = { syntetiser, ttsPris, wav, MODEL };

if (require.main === module) {
  (async () => {
    const r = await syntetiser({ tekst: 'Revnen i opgang 2 er cirka 60 centimeter lang. Vi mødes den tredje november klokken halv otte.', stemmer: { A: 'Kore' } });
    fs.writeFileSync('testlyd/syntetisk/proeve.wav', r.wav);
    console.log('bytes', r.wav.length, 'sek', ((r.wav.length - 44) / 48000).toFixed(1), 'tokens', r.tokens, 'pris USD', ttsPris(r.tokens).toFixed(5));
  })().catch((e) => { console.error(e.message); process.exit(1); });
}
