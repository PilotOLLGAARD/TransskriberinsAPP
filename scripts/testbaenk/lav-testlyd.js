'use strict';
// Laver testlyd til testbænken i testlyd/ (ikke i git):
//  - syntetisk tale (Gemini TTS) ud fra manuskripter.js, som wav, m4a (AAC, som iPhone) og webm (Opus, som Android)
//  - varianter med støj, vind, trafik, ekko, lav lydstyrke og stilhed (ffmpeg, syntetisk støj)
//  - FLEURS-klip med facit, og lange filer (5, 20 og 45 min.) sat sammen af FLEURS-klip med pauser
// Brug: node --env-file=.env scripts/testbaenk/lav-testlyd.js
// Koster kun penge for TTS. Allerede lavede filer springes over. Forbruget skrives i testlyd/forbrug.json.

const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { syntetiser, ttsPris } = require('./tts.js');
const manuskripter = require('./manuskripter.js');
const { tilfoejForbrug, forbrugIalt, GRAENSE_USD } = require('./forbrug.js');

const ROD = path.resolve(__dirname, '..', '..');
const FFMPEG = path.join(ROD, '.vaerktoej/ffmpeg/ffmpeg-9.0.2-essentials_build/bin/ffmpeg.exe');
const UD = path.join(ROD, 'testlyd/baenk');
const SYN = path.join(ROD, 'testlyd/syntetisk');
const FLEURS = path.join(ROD, 'testlyd/fleurs');

const ff = (...args) => execFileSync(FFMPEG, ['-hide_banner', '-loglevel', 'error', '-y', ...args]);
const findes = (f) => fs.existsSync(f) && fs.statSync(f).size > 0;
const aac = (ind, ud) => ff('-i', ind, '-ac', '1', '-ar', '48000', '-c:a', 'aac', '-b:a', '96k', ud);
const opus = (ind, ud) => ff('-i', ind, '-ac', '1', '-ar', '48000', '-c:a', 'libopus', '-b:a', '32k', ud);

/** Facit uden talernavne og pausemarkører. */
function facitTekst(m) {
  return m.tekst.split('\n').map((l) => l.replace(/^[A-ZÆØÅ][a-zæøå]+: /, '')).join(' ').replace(/\[lang pause\]/g, ' ').replace(/\s+/g, ' ').trim();
}

// Syntetisk støj. Lyden er tale i 48 kHz mono.
const STOEJ = {
  byggeplads: 'anoisesrc=color=brown:amplitude=0.25:sample_rate=48000[b];aevalsrc=0.9*sin(2*PI*110*t)*exp(-25*mod(t\\,0.8)):s=48000[h];[b][h]amix=inputs=2:normalize=0[st];[0:a][st]amix=inputs=2:duration=first:normalize=0',
  vind: 'anoisesrc=color=brown:amplitude=0.5:sample_rate=48000,lowpass=f=400,tremolo=f=0.4:d=0.9[v];[0:a][v]amix=inputs=2:duration=first:normalize=0',
  trafik: 'anoisesrc=color=pink:amplitude=0.25:sample_rate=48000,lowpass=f=900[p];sine=f=55:sample_rate=48000,volume=0.2[r];[p][r]amix=inputs=2:normalize=0[t];[0:a][t]amix=inputs=2:duration=first:normalize=0',
  ekko: '[0:a]aecho=0.8:0.7:90|210|380:0.5|0.35|0.2',
  lav: '[0:a]volume=-25dB',
};
const VARIANT_MANUSKRIPTER = ['s03-maal', 's04-rettelser', 's05-datoer', 's07-byggemoede', 's08-gennemgang', 's10-adresser-navne', 's13-afbrydelser', 's14-klokkeslaet', 's15-tal-ord', 's17-lang-moede'];

async function lavSyntetisk(liste) {
  fs.mkdirSync(SYN, { recursive: true });
  for (const m of manuskripter) {
    const wav = path.join(SYN, `${m.id}.wav`);
    if (!findes(wav)) {
      if (forbrugIalt() > GRAENSE_USD) throw new Error('Budgetgrænsen er nået. Stopper.');
      const dele = m.tekst.split('[lang pause]').map((t) => t.trim()).filter(Boolean);
      const filer = [];
      for (const [i, del] of dele.entries()) {
        const r = await syntetiser({ tekst: del, stemmer: m.stemmer, stil: m.stil });
        tilfoejForbrug({ hvad: `tts ${m.id}`, usd: ttsPris(r.tokens) });
        const f = path.join(SYN, `${m.id}.del${i}.wav`);
        fs.writeFileSync(f, r.wav);
        filer.push(f);
      }
      if (filer.length === 1) fs.renameSync(filer[0], wav);
      else {
        // Lange pauser på 8 sek. mellem delene.
        const input = filer.flatMap((f) => ['-i', f]);
        const kæde = filer.map((_, i) => `[${i}:a]aresample=24000${i < filer.length - 1 ? ',apad=pad_dur=8' : ''}[a${i}]`).join(';');
        ff(...input, '-filter_complex', `${kæde};${filer.map((_, i) => `[a${i}]`).join('')}concat=n=${filer.length}:v=0:a=1`, wav);
        for (const f of filer) fs.rmSync(f);
      }
      console.log('TTS', m.id, `i alt ${forbrugIalt().toFixed(4)} USD`);
    }
    for (const [endelse, lav] of [['m4a', aac], ['webm', opus]]) {
      const ud = path.join(UD, `syn-${m.id}.${endelse}`);
      if (!findes(ud)) lav(wav, ud);
      liste.push({ fil: path.relative(ROD, ud), kilde: 'syntetisk', id: m.id, forhold: 'ren', format: endelse, facit: facitTekst(m), forkerte: m.forkerte ?? [], type: m.type });
    }
    if (VARIANT_MANUSKRIPTER.includes(m.id)) {
      for (const [navn, filter] of Object.entries({ ...STOEJ, stilhed: null })) {
        const ud = path.join(UD, `syn-${m.id}-${navn}.m4a`);
        if (!findes(ud)) {
          const tmp = path.join(UD, 'tmp.wav');
          if (navn === 'stilhed') ff('-i', wav, '-af', 'aresample=48000,adelay=15000,apad=pad_dur=15', '-ac', '1', tmp);
          else ff('-i', wav, '-filter_complex', `[0:a]aresample=48000[x];${filter.replaceAll('[0:a]', '[x]')}`, '-ac', '1', tmp);
          aac(tmp, ud);
          fs.rmSync(tmp);
        }
        liste.push({ fil: path.relative(ROD, ud), kilde: 'syntetisk', id: m.id, forhold: navn, format: 'm4a', facit: facitTekst(m), forkerte: m.forkerte ?? [], type: m.type });
      }
    }
  }
}

function fleursRaekker() {
  return fs.readFileSync(path.join(FLEURS, 'dev.tsv'), 'utf8').trim().split('\n').map((l) => {
    const [id, fil, raa, , , antal] = l.split('\t');
    return { id, fil, raa, sek: Number(antal) / 16000 };
  }).sort((a, b) => a.fil.localeCompare(b.fil));
}

function lavFleurs(liste) {
  const raekker = fleursRaekker();
  // 60 klip spredt over hele sættet. 20 af dem også som webm.
  const valgte = raekker.filter((_, i) => i % Math.floor(raekker.length / 60) === 0).slice(0, 60);
  for (const [i, r] of valgte.entries()) {
    const wav = path.join(FLEURS, 'lyd/dev', r.fil);
    for (const endelse of i < 20 ? ['m4a', 'webm'] : ['m4a']) {
      const ud = path.join(UD, `fleurs-${r.fil.replace('.wav', '')}.${endelse}`);
      if (!findes(ud)) (endelse === 'm4a' ? aac : opus)(wav, ud);
      liste.push({ fil: path.relative(ROD, ud), kilde: 'fleurs', id: r.fil, forhold: 'ren', format: endelse, facit: r.raa, forkerte: [], type: null });
    }
  }
  // Lange filer: FLEURS-klip i rækkefølge med 2 sek. pause, indtil længden er nået.
  for (const minutter of [5, 20, 45]) {
    const ud = path.join(UD, `lang-${minutter}min.m4a`);
    const brugte = [];
    let sek = 0;
    for (const r of raekker) {
      if (sek >= minutter * 60) break;
      brugte.push(r);
      sek += r.sek + 2;
    }
    if (!findes(ud)) {
      const liste2 = path.join(UD, `lang-${minutter}.txt`);
      const pause = path.join(UD, 'pause2.wav');
      if (!findes(pause)) ff('-f', 'lavfi', '-i', 'anullsrc=r=16000:cl=mono', '-t', '2', pause);
      fs.writeFileSync(liste2, brugte.flatMap((r) => [`file '${path.join(FLEURS, 'lyd/dev', r.fil).replace(/\\/g, '/')}'`, `file '${pause.replace(/\\/g, '/')}'`]).join('\n'));
      ff('-f', 'concat', '-safe', '0', '-i', liste2, '-ac', '1', '-ar', '48000', '-c:a', 'aac', '-b:a', '64k', ud);
      fs.rmSync(liste2);
    }
    liste.push({ fil: path.relative(ROD, ud), kilde: 'fleurs-lang', id: `lang-${minutter}min`, forhold: 'lang', format: 'm4a', facit: brugte.map((r) => r.raa).join(' '), forkerte: [], type: null, minutter });
  }
}

function lavFejlfiler(liste) {
  const fejl = path.join(UD, 'fejl');
  fs.mkdirSync(fejl, { recursive: true });
  const kilde = path.join(SYN, 's01-kort-paamindelse.wav');
  const filer = {
    'tom.m4a': () => fs.writeFileSync(path.join(fejl, 'tom.m4a'), Buffer.alloc(0)),
    'stilhed-10s.m4a': () => ff('-f', 'lavfi', '-i', 'anullsrc=r=48000:cl=mono', '-t', '10', '-c:a', 'aac', '-b:a', '64k', path.join(fejl, 'stilhed-10s.m4a')),
    'odelagt.m4a': () => fs.writeFileSync(path.join(fejl, 'odelagt.m4a'), Buffer.from(Array.from({ length: 50000 }, (_, i) => (i * 7919) % 256))),
    'mp3.mp3': () => ff('-i', kilde, '-c:a', 'libmp3lame', path.join(fejl, 'mp3.mp3')),
    'wav.wav': () => fs.copyFileSync(kilde, path.join(fejl, 'wav.wav')),
  };
  for (const [navn, lav] of Object.entries(filer)) {
    if (!fs.existsSync(path.join(fejl, navn))) lav();
    liste.push({ fil: path.relative(ROD, path.join(fejl, navn)), kilde: 'fejl', id: navn, forhold: 'fejl', format: path.extname(navn).slice(1), facit: null, forkerte: [], type: null });
  }
}

(async () => {
  fs.mkdirSync(UD, { recursive: true });
  const liste = [];
  await lavSyntetisk(liste);
  lavFleurs(liste);
  lavFejlfiler(liste);
  fs.writeFileSync(path.join(UD, 'liste.json'), JSON.stringify(liste, null, 1));
  console.log(`${liste.length} filer. Forbrug i alt ${forbrugIalt().toFixed(4)} USD.`);
})().catch((e) => { console.error('Fejl:', e.message); process.exit(1); });
