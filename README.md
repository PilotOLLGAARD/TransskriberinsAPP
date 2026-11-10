# Transskriberingsapp til ØLLGAARD

Medarbejderen indtaler en note på telefonen eller uploader en lydfil, giver den et navn og får et referat som Word-dokument på mail. Den fulde transskription ligger som bilag.

Telefonen sender lyden til serveren. Serveren transskriberer med Gemini, laver et referat og et Word-dokument og gemmer intet. Telefonen sender selv mailen fra medarbejderens egen konto. Appen kræver login med en ØLLGAARD-konto. Der er ingen hemmeligheder i dette repo.

## Mapper

| Mappe | Indhold |
|---|---|
| `app/` | Appen (PWA) på GitHub Pages: ren HTML og JavaScript uden build |
| `server/` | Serveren på Google Cloud Run (Node 24) |
| `e2e/` | Browsertests af hele forløbet |
| `scripts/` | Lokal server, tjek af hemmeligheder, opsætning, prøver og testbænk mod rigtig Gemini |
| `docs/` | Vejledninger |

Hver del har sine unit-tests ved siden af koden (`app/test/`, `server/test/`, `scripts/test/`).

## Kom i gang på en ny computer

Kræver Node 24 og Git.

```bash
git clone https://github.com/PilotOLLGAARD/TransskriberinsAPP.git
cd TransskriberinsAPP
npm install
npm install --prefix server
npm test
npm run lokal
```

Åbn http://localhost:4280. Login, transskription og mail er falske, så det koster ikke noget.

Browsertestene kræver Chromium, som hentes én gang til `.vaerktoej/browsere`, hvor testene leder:

```bash
PLAYWRIGHT_BROWSERS_PATH=.vaerktoej/browsere npx playwright install chromium
npm run e2e
```

I PowerShell: `$env:PLAYWRIGHT_BROWSERS_PATH = ".vaerktoej/browsere"; npx playwright install chromium`.

## Mere

- **Opsætning, udgivelse og fejlfinding:** [`docs/vejledning.md`](docs/vejledning.md)
- **Til medarbejdere:** [`docs/vejledning-medarbejdere.md`](docs/vejledning-medarbejdere.md)

Push til `main` udgiver straks: `app/` til GitHub Pages og `server/` til Cloud Run, efter at alle tests er bestået.
