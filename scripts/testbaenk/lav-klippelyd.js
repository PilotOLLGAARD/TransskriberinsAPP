'use strict';
// Laver små, syntetiske lydfiler til testene af klipningen (app/test/lyd/, i git). Kun toner og støj, ingen tale.
// ffmpeg ligger i .vaerktoej/ (ikke i git). Testene selv kræver hverken ffmpeg eller en browser.
// Brug: node scripts/testbaenk/lav-klippelyd.js   (--optag laver også appens egne formater med Chromium)

const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const { execFileSync } = require('node:child_process');

const ROD = path.resolve(__dirname, '..', '..');
const FFMPEG = path.join(ROD, '.vaerktoej/ffmpeg/ffmpeg-9.0.2-essentials_build/bin/ffmpeg.exe');
const UD = path.join(ROD, 'app/test/lyd');
const SEK = 30;

// En tone, der skifter hvert sekund, så hvert sekund har sine egne bytes.
const KILDE = ['-f', 'lavfi', '-i', `aevalsrc='0.4*sin(2*PI*(300+40*floor(t))*t)+0.05*random(0)':s=8000:d=${SEK}`];
const ff = (...args) => execFileSync(FFMPEG, ['-hide_banner', '-loglevel', 'error', '-y', ...KILDE, ...args]);

function lavFfmpeg() {
  fs.mkdirSync(UD, { recursive: true });
  // MP3 (MPEG-2,5 ved 8 kHz) med ID3-mærke og Xing-ramme, som de fleste optagere skriver.
  ff('-ac', '1', '-c:a', 'libmp3lame', '-b:a', '8k', '-id3v2_version', '3', '-metadata', 'title=Testtone', path.join(UD, 'tone.mp3'));
  // Almindelig m4a: moov sidst (som mange optagere) og moov først (faststart).
  ff('-ac', '1', '-c:a', 'aac', '-b:a', '12k', path.join(UD, 'tone-moov-sidst.m4a'));
  ff('-ac', '1', '-c:a', 'aac', '-b:a', '12k', '-movflags', '+faststart', path.join(UD, 'tone-faststart.m4a'));
  // Samsungs optager skriver 3gp4 som ftyp.
  ff('-ac', '1', '-c:a', 'aac', '-b:a', '12k', '-brand', '3gp4', '-f', 'mp4', path.join(UD, 'tone-3gp4.m4a'));
}

/** Optager SEK sekunder med Chromiums falske mikrofon, som appen gør, i de formater browseren kan. */
async function lavOptagelser() {
  process.env.PLAYWRIGHT_BROWSERS_PATH ||= path.join(ROD, '.vaerktoej', 'browsere');
  const { chromium } = require('playwright');
  const server = http.createServer((_q, r) => r.end('<html></html>'));
  await new Promise((ok) => server.listen(0, '127.0.0.1', ok));
  const browser = await chromium.launch({ args: ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream'] });
  try {
    const side = await (await browser.newContext({ permissions: ['microphone'] })).newPage();
    await side.goto(`http://localhost:${server.address().port}/`);
    // Chromium ser bort fra den lave bitrate i mp4, så den optagelse er kortere.
    for (const [mime, navn, sek] of [['audio/mp4;codecs=mp4a.40.2', 'optagelse.mp4', 12], ['audio/webm;codecs=opus', 'optagelse.webm', SEK]]) {
      const bytes = await side.evaluate(async ({ mime: m, sek }) => {
        const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
        const r = new MediaRecorder(stream, { mimeType: m, audioBitsPerSecond: 16000 });
        const dele = [];
        r.ondataavailable = (e) => dele.push(e.data);
        // Som appen, men stykker på 1 s, så testene kan klippe små bidder.
        r.start(1000);
        await new Promise((ok) => setTimeout(ok, sek * 1000));
        await new Promise((ok) => { r.onstop = ok; r.stop(); });
        stream.getTracks().forEach((t) => t.stop());
        return Array.from(new Uint8Array(await new Blob(dele).arrayBuffer()));
      }, { mime, sek });
      fs.writeFileSync(path.join(UD, navn), Buffer.from(bytes));
    }
  } finally {
    await browser.close();
    server.close();
  }
}

(async () => {
  lavFfmpeg();
  if (process.argv.includes('--optag')) await lavOptagelser();
  for (const f of fs.readdirSync(UD)) console.log(f, fs.statSync(path.join(UD, f)).size);
})();
