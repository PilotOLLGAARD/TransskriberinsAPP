# Transskriberingsapp til ØLLGAARD: projektregler

Medarbejderen indtaler en note på telefonen, giver den et navn og får et referat med PDF på mail. Erstatter Notta.ai.

**Ny session: læs først `docs/overdragelse.md`.** Den beskriver, hvad der er bygget, beslutninger, konti, kendte mangler og næste skridt. Opsætning og udgivelse: `docs/vejledning.md`.

Repoet er offentligt. Disse filer ligger kun i projektmappen og må aldrig i git: `.env`, `docs/overdragelse.md`, `docs/plan.md`, `docs/plan-*.md` (design og planer), `docs/it-opsaetning.md` (til IT), `docs/test-resultater.md`. `npm run tjek:hemmeligheder` fejler, hvis de kommer med. Interne beslutninger, navne og aftaler skrives kun der.

## Krav der aldrig må brydes

- Data må ikke bruges til træning eller gives videre: kun betalt Gemini API, `store: false`, filer slettes hos Google efter brug.
- En fremmed må aldrig kunne koste penge: adgangstjekket er det første, serveren gør på `POST /transskriber`, før lyden læses. Fejler lukket.
- Alle ansatte i ØLLGAARDs tenant har adgang, gæster har ikke. Serveren kræver gyldig signatur, `iss` og `aud` (v1 eller v2), `exp`, `tid`, scope `access_as_user` og `acct = 0`. Mailadressen afgør aldrig adgang.
- En optagelse må aldrig gå tabt: Lyd slettes kun, når Microsoft har svaret 202 på mailen, eller brugeren selv har valgt Slet.
- Lydkvaliteten sættes ikke ned: ingen omkodning, nedsampling eller opdeling.
- Referatet må aldrig opfinde noget. Reglerne står i `server/src/referat.js`. Den fulde transskription følger altid med som bilag i PDF'en.
- Design: ØLLGAARDs blå (`#2D89E5`, knapper `#0E5AA3`) og `#282828`, systemskrift, store knapper. Logoet ligger i `web/ordmaerke.svg` og `web/maerke.svg`.
- Ingen hemmeligheder i git, i `web/` eller i logs. Læs aldrig `.env*`.
- Brug aldrig rigtige byggepladsnoter i udvikling eller test.

## Arkitektur

iPhone/Android-PWA (`web/`, ren HTML/JS uden build, GitHub Pages) → server (`server/`, Node 24, eneste afhængighed er `pdfkit`, Google Cloud Run, `europe-north2`) → Gemini 3.5 Transcribe → referat med Gemini 3.8 Flash (`server/src/referat.js`) → PDF i hukommelsen med Lato og logo (`server/src/pdf.js`). Telefonen sender mailen med PDF via Microsoft Graph (`web/js/mail.js`). Azure bruges ikke.

| Fil | Ansvar |
|---|---|
| `server/src/adgang.js` | Tjek af Entra-bevis |
| `server/src/handler.js` | `POST /transskriber`: adgang → format → transskription → referat → PDF. Headere `x-titel`, `x-varighed`, `x-optaget` |
| `server/src/gemini.js` | Upload, transskription og sletning hos Google |
| `web/js/optager.js` | Optagelse, afbrydelser, varighed |
| `web/js/forloeb.js` | Navngiv og send, genforsøg, genstart. Lyd slettes kun ved 202 |
| `web/js/app.js` | Kun brugerflade |
| `scripts/lokal.js` | Lokal server med falsk login, falsk Gemini og falsk referat. Rigtig handler og PDF |

## Kommandoer

```
npm test                     # alle unit-tests
npm run e2e                  # hele forløbet i Chromium med falsk login og falsk Gemini
npm run lokal                # lokal server på :4280
npm run tjek:hemmeligheder   # finder nøgler og interne dokumenter i git
node --env-file=.env scripts/proev-referat.js testlyd/x.txt --pdf .   # rigtig Gemini, koster penge
```

## Udgivelse

- Push til `main` udgiver straks: `web/` til GitHub Pages og `server/` til Cloud Run. Begge kører hele testsuiten først.
- Arbejd på en separat gren, og push først, når alt er testet.
- Ændrer en opgave både server og app, skal serveren udgives først. Vent, til "Udgiv serveren" er grøn.

## Arbejdsform

- Skills: brainstorming → writing-plans → executing-plans med test først i hver opgave og én uafhængig gennemgang til sidst.
- Små commits. Aldrig `git push --force`.
- Kør tests og se resultatet, før noget kaldes færdigt.
- Spørg før: push, oprettelse i Google Cloud, alt der koster penge eller kræver IT.
- Sprog: brugerflade og dokumentation på dansk.
- Tilføj ikke funktioner uden aftale.
