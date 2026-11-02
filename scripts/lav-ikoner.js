'use strict';

/**
 * Laver appens ikoner ud fra ØLLGAARDs Ø-mærke (web/maerke.svg): blåt mærke på hvid flade.
 * Laver også ordmærket som PNG til PDF'erne (server/assets/ordmaerke.png).
 * Brug: node scripts/lav-ikoner.js
 */

const path = require('node:path');
const fs = require('node:fs');

process.env.PLAYWRIGHT_BROWSERS_PATH ||= path.resolve(__dirname, '..', '.vaerktoej', 'browsere');
const { chromium } = require('playwright');

const WEB = path.resolve(__dirname, '..', 'web');
// Mærket fylder 58 %, så det også ligger inden for Androids runde beskæring.
const IKONER = [['icon-192.png', 192], ['icon-512.png', 512], ['apple-touch-icon.png', 180]];

async function main() {
  const maerke = fs.readFileSync(path.join(WEB, 'maerke.svg'), 'utf8');
  const browser = await chromium.launch();
  try {
    for (const [navn, str] of IKONER) {
      const side = await browser.newPage({ viewport: { width: str, height: str } });
      await side.setContent(`<!doctype html><style>
        html,body{margin:0;width:${str}px;height:${str}px;background:#fff;display:grid;place-items:center}
        svg{width:${Math.round(str * 0.58)}px;height:auto}
      </style>${maerke}`);
      await side.screenshot({ path: path.join(WEB, navn), omitBackground: false });
      await side.close();
      console.log(`${navn}: ${str}x${str}`);
    }
    const ord = fs.readFileSync(path.join(WEB, 'ordmaerke.svg'), 'utf8');
    const side = await browser.newPage({ viewport: { width: 1200, height: 240 } });
    await side.setContent(`<!doctype html><style>html,body{margin:0;background:transparent}svg{display:block;width:1200px;height:auto}</style>${ord}`);
    const ud = path.resolve(__dirname, '..', 'server', 'assets', 'ordmaerke.png');
    await side.locator('svg').screenshot({ path: ud, omitBackground: true });
    console.log(`ordmaerke.png: ${ud}`);
  } finally {
    await browser.close();
  }
}

main();
