# Transskriberingsapp til ØLLGAARD: projektregler

Medarbejderen indtaler en note på telefonen, giver den et navn og får et referat med PDF på mail. Erstatter Notta.ai.

**Ny session: læs først `docs/overdragelse.md`.** Den beskriver, hvad der er bygget, beslutninger, konti, kendte mangler og næste skridt. Opsætning og udgivelse: `docs/vejledning.md`.

Repoet er offentligt. Disse filer ligger kun i projektmappen og må aldrig i git: `.env`, `docs/overdragelse.md`, `docs/plan.md`, `docs/plan-*.md` (design og planer), `docs/it-opsaetning.md` (til IT), `docs/test-resultater.md`, `docs/udrulning.md` (tjekliste før udrulning). `npm run tjek:hemmeligheder` fejler, hvis de kommer med. Interne beslutninger, navne og aftaler skrives kun der.

## Krav der aldrig må brydes

- Data må ikke bruges til træning eller gives videre: kun betalt Gemini API, `store: false`, filer slettes hos Google efter brug.
- En fremmed må aldrig kunne koste penge: adgangstjekket er det første, serveren gør på `POST /transskriber`, før lyden læses. Fejler lukket.
- Alle ansatte i ØLLGAARDs tenant har adgang, gæster har ikke. Serveren kræver gyldig signatur, `iss` og `aud` (v1 eller v2), `exp`, `tid`, scope `access_as_user` og `acct = 0`. Mailadressen afgør aldrig adgang.
- En optagelse må aldrig gå tabt: Lyd slettes kun, når Microsoft har svaret 202 på mailen, eller brugeren selv har valgt Slet.
- Sendte noter (tekst, referat og PDF, uden lyd) bliver på telefonen i 7 dage efter første afsendelse og slettes derefter automatisk. Noter, der ikke er sendt eller er fejlet, slettes aldrig automatisk. "Send referat igen" bruger det, der ligger på telefonen, og koster intet AI-kald.
- Lydkvaliteten sættes ikke ned: ingen omkodning, nedsampling eller opdeling.
- Referatet må aldrig opfinde noget. Reglerne står i `server/src/referat.js`. Den fulde transskription følger altid med som bilag i PDF'en.
- Design: ØLLGAARDs blå (`#2D89E5`, knapper `#0E5AA3`) og `#282828`, systemskrift, store knapper. Logoet ligger i `web/ordmaerke.svg` og `web/maerke.svg`.
- Ingen hemmeligheder i git, i `web/` eller i logs. Læs aldrig `.env*`.
- GitHub-kontoen PilotOLLGAARD må kun have denne ene GitHub Pages-side, og repoet `pilotollgaard.github.io` må aldrig oprettes. Alle Pages-sider på kontoen deler adressen `https://pilotollgaard.github.io`, så en anden side kunne læse login og optagelser. Skal der flere sider til, skal appen først have sit eget domæne.
- Kør `npm run tjek:hemmeligheder` før hvert push, også til `main`. Testen på GitHub kører først, når historikken allerede er offentlig. Push aldrig tags eller andre grene end `main`.
- Brug aldrig rigtige byggepladsnoter i udvikling eller test.

## Arkitektur

iPhone/Android-PWA (`web/`, ren HTML/JS uden build, GitHub Pages) → server (`server/`, Node 24, eneste afhængighed er `pdfkit`, Google Cloud Run, `europe-north2`) → transskription med Gemini 3.8 Flash (Gemini 3.5 Transcribe som reserve for korte optagelser, `TRANSSKRIPTION_FOERST`) → referat med Gemini 3.8 Flash (`server/src/referat.js`) → PDF i hukommelsen med Lato og logo (`server/src/pdf.js`) og Word-dokument (`server/src/docx.js`, egen ZIP uden nye afhængigheder). Telefonen sender mailen med PDF via Microsoft Graph (`web/js/mail.js`). Azure bruges ikke.

| Fil | Ansvar |
|---|---|
| `server/src/adgang.js` | Tjek af Entra-bevis |
| `server/src/handler.js` | `POST /transskriber`: adgang → format → transskription → referat → PDF og Word. Headere `x-titel`, `x-type` (kun gamle noter), `x-varighed` (over 9000 s afvises), `x-optaget`, `x-kun-tekst` (kun teksten), `x-referat-mangler` (appen forstår `{tekst, referatMangler}`, når referatet fejler efter transskriptionen). `POST /referat`: ét referat af delteksterne fra en afbrudt optagelse |
| `server/src/gemini.js` | Upload, transskription og sletning hos Google. Flash først; Transcribe tager over ved 429/5xx (højst 400 s lyd) og ved Googles indholdsfilter (alle længder) |
| `server/src/genforsoeg.js` | Genforsøg ved 429, 5xx og netfejl. Dagsgrænsen giver 503 `kvote` |
| `server/src/afsnit.js` | Flashs `[mm:ss]`-markører: fjernes fra teksten, rettes med varigheden og deler bilaget i emner med undertitel |
| `server/src/referat.js` | Referatets prompt, skema og emner. `server/src/tal.js`: tal, der ikke blev sagt, bliver [uklart] |
| `server/src/pdf.js`, `server/src/docx.js` | PDF og Word med samme indhold |
| `server/src/konfig.js` | Miljøvariabler og standarder (500 MiB, 840 s, verbatim, modeller) |
| `web/js/optager.js` | Optagelse, afbrydelser, varighed |
| `web/js/lydfil.js` | Upload lydfil: kontrol af format og størrelse, varighed, gemning uden omkodning, fil fra del-menuen (Android) |
| `web/js/forloeb.js` | Navngiv og send, flere dele, genforsøg, genstart, Send referat igen, Slet med Fortryd, oprydning efter 7 dage. Lyd slettes kun ved 202 eller Slet |
| `web/js/app.js` | Kun brugerflade |
| `scripts/lokal.js` | Lokal server med falsk login, falsk Gemini og falsk referat. Rigtig handler og PDF |
| `scripts/testbaenk/` | Testlyd og målinger mod rigtig Gemini (koster penge, spørg først). Forbrug logges i `testlyd/forbrug.json` |

Googles grænser på Tier 1: Flash 1.000 kald/min og 10.000/dag, Transcribe 10 kald/min, 10.000 tokens/min og 100/dag. Indholdsfilteret kan ikke slås fra. Forsidens browsertests måler med Arial/Liberation Sans, så de også består med Linux' skrifter på GitHub.

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
- Arbejdsgrenen hedder `forbedringer`. Den udgives med `git push origin forbedringer:main`.

## Arbejdsform

- Skills: brainstorming → writing-plans → executing-plans med test først i hver opgave og én uafhængig gennemgang til sidst.
- Små commits. Aldrig `git push --force`.
- Kør tests og se resultatet, før noget kaldes færdigt.
- Spørg før: push, oprettelse i Google Cloud, alt der koster penge eller kræver IT.
- Sprog: brugerflade og dokumentation på dansk.
- Tilføj ikke funktioner uden aftale.
