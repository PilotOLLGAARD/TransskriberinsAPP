'use strict';

/**
 * Laver appens ikoner og startskærme ud fra ØLLGAARDs logo (app/maerke.svg og app/ordmaerke.svg).
 *
 * - Ikoner: hvidt Ø på knappernes blå. Android får sit eget ikon til rund beskæring (maskable) med mere luft.
 * - Ordmærket med lyse bogstaver til appens mørke tilstand (app/ordmaerke-lys.svg).
 * - Startskærme til iPhone i lys og mørk (app/start/), og linjerne til dem i app/index.html.
 *   Android laver selv sin startskærm ud fra manifestet.
 * - Med --server: ordmærket som PNG til PDF'erne (server/assets/ordmaerke.png). Ændrer serveren, så den udgives.
 *
 * Brug: node scripts/opsaetning/lav-ikoner.js [--server]
 */

const path = require('node:path');
const fs = require('node:fs');

process.env.PLAYWRIGHT_BROWSERS_PATH ||= path.resolve(__dirname, '..', '..', '.vaerktoej', 'browsere');
const { chromium } = require('playwright');

const APP = path.resolve(__dirname, '..', '..', 'app');
const KNAPBLAA = '#0e5aa3';
const LYS_FLADE = '#f3f5f8';
const MOERK_FLADE = '#0f1a26';
const LYS_TEKST = '#f1f4f8';

// Navn, størrelse og hvor meget af fladen mærket fylder. Maskable beskæres rundt af Android og skal have mere luft.
const IKONER = [
  ['icon-192.png', 192, 0.58],
  ['icon-512.png', 512, 0.58],
  ['apple-touch-icon.png', 180, 0.58],
  ['icon-maskable-192.png', 192, 0.46],
  ['icon-maskable-512.png', 512, 0.46],
];

// iPhones skærme i punkter og tæthed, fra iPhone SE (1. gen.) til de største. iPhone viser kun en startskærm,
// der passer præcis til telefonen. Mangler en størrelse, starter appen bare uden.
const TELEFONER = [
  [320, 568, 2], [375, 667, 2], [414, 736, 3], [375, 812, 3], [414, 896, 2], [414, 896, 3],
  [390, 844, 3], [428, 926, 3], [393, 852, 3], [430, 932, 3], [402, 874, 3], [440, 956, 3],
];
const SKEMAER = [['lys', 'light', LYS_FLADE], ['moerk', 'dark', MOERK_FLADE]];
const START_FRA = '<!-- startskaerme -->';
const START_TIL = '<!-- /startskaerme -->';

async function billede(browser, { bredde, hoejde, taethed = 1, baggrund, svg, svgBredde, fil }) {
  const side = await browser.newPage({ viewport: { width: bredde, height: hoejde }, deviceScaleFactor: taethed });
  await side.setContent(`<!doctype html><style>
    html,body{margin:0;width:${bredde}px;height:${hoejde}px;background:${baggrund};display:grid;place-items:center}
    svg{width:${svgBredde}px;height:auto}
  </style>${svg}`);
  await side.screenshot({ path: fil, omitBackground: false });
  await side.close();
}

async function main() {
  const maerke = fs.readFileSync(path.join(APP, 'maerke.svg'), 'utf8');
  const ord = fs.readFileSync(path.join(APP, 'ordmaerke.svg'), 'utf8');
  // Mørk tilstand: bogstaverne i appens lyse tekstfarve. Ø'et beholder logoets blå.
  const ordLys = ord.replaceAll('#282828', LYS_TEKST);
  const browser = await chromium.launch();
  try {
    const hvidtMaerke = maerke.replace(/fill="#[0-9A-Fa-f]{6}"/, 'fill="#ffffff"');
    for (const [navn, str, andel] of IKONER) {
      await billede(browser, { bredde: str, hoejde: str, baggrund: KNAPBLAA, svg: hvidtMaerke, svgBredde: Math.round(str * andel), fil: path.join(APP, navn) });
      console.log(`${navn}: ${str}x${str}`);
    }

    fs.writeFileSync(path.join(APP, 'ordmaerke-lys.svg'), ordLys);
    console.log('ordmaerke-lys.svg');

    fs.mkdirSync(path.join(APP, 'start'), { recursive: true });
    const linjer = [];
    for (const [b, h, t] of TELEFONER) {
      for (const [navn, skema, baggrund] of SKEMAER) {
        const fil = `start/${b}x${h}@${t}-${navn}.png`;
        await billede(browser, { bredde: b, hoejde: h, taethed: t, baggrund, svg: navn === 'moerk' ? ordLys : ord, svgBredde: Math.round(b * 0.56), fil: path.join(APP, fil) });
        linjer.push(`  <link rel="apple-touch-startup-image" media="(device-width: ${b}px) and (device-height: ${h}px) and (-webkit-device-pixel-ratio: ${t}) and (orientation: portrait) and (prefers-color-scheme: ${skema})" href="${fil}">`);
      }
    }
    console.log(`start/: ${linjer.length} startskærme`);
    const indeks = path.join(APP, 'index.html');
    const html = fs.readFileSync(indeks, 'utf8');
    const fra = html.indexOf(START_FRA);
    const til = html.indexOf(START_TIL);
    if (fra < 0 || til < fra) throw new Error(`index.html mangler ${START_FRA} og ${START_TIL}`);
    fs.writeFileSync(indeks, `${html.slice(0, fra + START_FRA.length)}\n${linjer.join('\n')}\n  ${html.slice(til)}`);
    console.log('index.html: linjerne til startskærmene er skrevet');

    if (process.argv.includes('--server')) {
      const side = await browser.newPage({ viewport: { width: 1200, height: 240 } });
      await side.setContent(`<!doctype html><style>html,body{margin:0;background:transparent}svg{display:block;width:1200px;height:auto}</style>${ord}`);
      const ud = path.resolve(__dirname, '..', '..', 'server', 'assets', 'ordmaerke.png');
      await side.locator('svg').screenshot({ path: ud, omitBackground: true });
      console.log(`ordmaerke.png: ${ud}`);
    }
  } finally {
    await browser.close();
  }
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
