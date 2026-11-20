# Transskriberingsapp til ØLLGAARD: projektregler

Medarbejderen indtaler en note på telefonen, giver den et navn og får et referat som Word-dokument på mail. Erstatter Notta.ai.

**Ny session: læs først `docs/overdragelse.md`.** Den beskriver, hvad der er bygget, beslutninger, konti, kendte mangler og næste skridt. Opsætning og udgivelse: `docs/vejledning.md`.

Repoet er offentligt. Disse filer ligger kun i projektmappen og må aldrig i git: `.env`, `docs/overdragelse.md`, `docs/plan-*.md` (aktuelle design og planer), `docs/planer/` (gamle planer), `arkiv/` (lokalt arkiv), `docs/it-opsaetning.md` (til IT), `docs/test-resultater.md`, `docs/udrulning.md` (tjekliste før udrulning), `docs/dataoverblik.md` (hvor data ligger, til databeskyttelse og IT). `npm run tjek:hemmeligheder` fejler, hvis de kommer med. Interne beslutninger, navne og aftaler skrives kun der.

## Krav der aldrig må brydes

- Data må ikke bruges til træning eller gives videre: kun betalt Gemini API, `store: false`, filer slettes hos Google efter brug.
- En fremmed må aldrig kunne koste penge: adgangstjekket er det første, serveren gør på `POST /transskriber`, før lyden læses. Fejler lukket.
- Alle ansatte i ØLLGAARDs tenant har adgang, gæster har ikke. Serveren kræver gyldig signatur, `iss` og `aud` (v1 eller v2), `exp`, `tid`, scope `access_as_user` og `acct = 0`. Mailadressen afgør aldrig adgang.
- En optagelse må aldrig gå tabt: Lyd slettes kun, når Microsoft har svaret 202 på mailen, eller brugeren selv har valgt Slet.
- Sendte noter (tekst, referat og PDF, uden lyd) bliver på telefonen i 7 dage efter første afsendelse og slettes derefter automatisk. Noter, der ikke er sendt eller er fejlet, slettes aldrig automatisk. "Send referat igen" bruger det, der ligger på telefonen, og koster intet AI-kald.
- Lydkvaliteten sættes ikke ned: ingen omkodning eller nedsampling. En del over 35 min. klippes i bidder på 30 min. med 30 s overlap, kun mellem hele lydrammer, så lyden er byte for byte den samme (brugerens ja 18. nov. 2026). En optagelse eller fil må højst vare 4 timer.
- Der må aldrig mangle tekst, uden at det står der: en tom bid prøves igen, og er den stadig tom, står "[Dette afsnit (tidsrum) kunne ikke transskriberes]" i bilaget, mailen, Word og på trin-skærmen. Teksten til referatet og talkontrollen har ingen tal (`HUL_TEKST` i `server/src/samling.js`).
- Referatet må aldrig opfinde noget. Reglerne står i `server/src/referat.js`. Den fulde transskription følger altid med som bilag i Word-dokumentet. Mailen har kun Word-dokumentet; PDF'en sendes kun som reserve, hvis Word mangler (fejlet på serveren eller gamle noter). Serveren laver stadig PDF'en til det og til ældre apps.
- Design: ØLLGAARDs blå (`#2D89E5`, knapper `#0E5AA3`) og `#282828`, systemskrift, store knapper, tekst mindst 18 px (statusmærkerne Sendt, Venter og Fejlet 16 px). Mørk tilstand følger telefonen (farverne er variabler øverst i `app/styles.css`). Logoet ligger i `app/ordmaerke.svg` (`app/ordmaerke-lys.svg` i mørk tilstand) og `app/maerke.svg`. App-ikonet er hvidt Ø på `#0E5AA3`.
- Forsiden har en fast bundlinje med Tidligere, Optag og Upload lydfil, og Stop ligger præcis, hvor Optag lå. Al bevægelse har en udgave til "reducer bevægelse", og kun `transform` og `opacity` animeres.
- Lydkurven på optageskærmen må aldrig kunne stoppe en optagelse: den lytter kun med, alle dens fejl sluges, og den stopper aldrig mikrofonens spor.
- Ingen hemmeligheder i git, i `app/` eller i logs. Læs aldrig `.env*`.
- GitHub-kontoen PilotOLLGAARD må kun have denne ene GitHub Pages-side, og repoet `pilotollgaard.github.io` må aldrig oprettes. Alle Pages-sider på kontoen deler adressen `https://pilotollgaard.github.io`, så en anden side kunne læse login og optagelser. Skal der flere sider til, skal appen først have sit eget domæne.
- Kør `npm run tjek:hemmeligheder` før hvert push, også til `main`. Testen på GitHub kører først, når historikken allerede er offentlig. Push aldrig tags eller andre grene end `main`.
- Brug aldrig rigtige byggepladsnoter i udvikling eller test.

## Arkitektur

iPhone/Android-PWA (`app/`, ren HTML/JS uden build, GitHub Pages) → server (`server/`, Node 24, eneste afhængighed er `pdfkit`, Google Cloud Run, `europe-north2`) → transskription med Gemini 3.8 Flash (Gemini 3.5 Transcribe som reserve for korte optagelser, `TRANSSKRIPTION_FOERST`) → referat med Gemini 3.8 Flash (`server/src/referat.js`) → PDF i hukommelsen med Lato og logo (`server/src/pdf.js`) og Word-dokument med logo (`server/src/docx.js`, egen ZIP uden nye afhængigheder). Telefonen sender mailen med Word-dokumentet via Microsoft Graph (`app/js/mail.js`). Feedback ("Giv feedback") sendes også fra telefonen via Graph, fra brugerens egen konto til rw@ollgaard.dk (`app/js/feedback.js`); den går aldrig til serveren eller AI. Azure bruges ikke.

| Fil | Ansvar |
|---|---|
| `server/src/adgang.js` | Tjek af Entra-bevis |
| `server/src/handler.js` | `POST /transskriber`: adgang → format → transskription → referat → PDF og Word. Headere `x-titel`, `x-type` (kun gamle noter), `x-varighed` (over 9000 s afvises), `x-optaget`, `x-kun-tekst` (kun teksten), `x-afsnit` (sammen med `x-kun-tekst`: også afsnittene med tider), `x-smaabidder` (appen kan dele bidden, se gemini.js), `x-reserve` (appen beder om Transcribe til en tom bid), `x-referat-mangler` (appen forstår `{tekst, referatMangler}`, når referatet fejler efter transskriptionen). Googles filter giver 422 `blokeret`. `POST /referat`: ét referat af `dele` med bidder (eller gamle `tekster`), højst 200 bidder, 150 s |
| `server/src/samling.js` | Samler bidder og dele til én tidslinje: fjerner overlappet (fælles ordrække på 6 ord, ellers en omtrentlig, ellers midten; lange afsnit, der rækker ind i overlappet, tæller med), "Del n: filnavn", afbrudte dele og huller |
| `server/src/gemini.js` | Upload, transskription og sletning hos Google. Flash først; Transcribe tager over ved 429/5xx (højst 400 s lyd) og ved Googles indholdsfilter. Sender appen `x-smaabidder: 1`, og er bidden over Transcribes grænse (400 s), gives blokeringen straks videre, så appen prøver mindre bidder med Flash før Transcribe. Højst ét kald til Transcribe ad gangen pr. server; efter en blokering ventes et 429 ud |
| `server/src/genforsoeg.js` | Genforsøg ved 429, 5xx og netfejl. Dagsgrænsen giver 503 `kvote` |
| `server/src/afsnit.js` | Flashs `[mm:ss]`-markører (også midt i linjen, når der er mindst tre): fjernes fra teksten, rettes med varigheden og deler bilaget i emner med undertitel |
| `server/src/referat.js` | Referatets prompt, skema og emner. `server/src/tal.js`: tal, der ikke blev sagt, bliver [uklart] |
| `server/src/pdf.js`, `server/src/docx.js` | PDF og Word med samme indhold |
| `server/src/konfig.js` | Miljøvariabler og standarder (500 MiB, 840 s, verbatim, modeller) |
| `app/js/optager.js` | Optagelse, afbrydelser, varighed. Højst 4 timer (59 min., hvis optagelsen ikke kan klippes) |
| `app/js/lydfil.js` | Upload lydfil: kontrol af format, størrelse og varighed (4 timer, ogg/flac/aac 2½ time), flere filer (højst 10) som én note, gemning uden omkodning, fil fra del-menuen (Android) |
| `app/js/opdeling/` | Klipper lyd i bidder uden at røre lydrammerne: fragmenteret og almindelig MP4, WebM, MP3, WAV. Kan en fil ikke læses, sendes den hel |
| `app/js/forloeb.js` | Navngiv og send, bidder (højst 3 ad gangen, hver tekst gemmes straks; en blokeret, tom eller hullet bid (spring på over 2 min. i Flashs tider) prøves som 10- og 5-min.-bidder og derefter med den anden model; midlertidige fejl ventes ud 20 og 60 s), flere dele og filer, genforsøg, genstart, Send referat igen, Slet med Fortryd, oprydning efter 7 dage. Lyd slettes kun ved 202 eller Slet |
| `app/js/feedback.js` | Feedback til rw@ollgaard.dk: ren tekst (højst 2.000 tegn), app-version og telefontype. Gemmes i en kø på telefonen og fjernes først ved 202; sendes igen, når nettet eller login er tilbage |
| `app/js/app.js` | Kun brugerflade |
| `app/js/lydkurve.js` | Lydkurven på optageskærmen: måler lyden på optagelsens egen strøm og tegner søjler. Kaster aldrig |
| `app/js/tilbage.js` | Telefonens tilbage (Android-knappen og swipe) går ét skridt tilbage i appen. Går aldrig selv tilbage ud fra en gammel historik |
| `scripts/lokal.js` | Lokal server med falsk login, falsk Gemini og falsk referat. Rigtig handler og PDF |
| `scripts/tjek-hemmeligheder.js` | Finder nøgler og interne dokumenter i git og historikken |
| `scripts/opsaetning/` | `opsaet-google.sh` (Google Cloud, én gang) og `lav-ikoner.js` (ikoner, lyst ordmærke og iPhones startskærme i `app/start/`; kun med `--server` også logo-PNG til PDF'erne) |
| `scripts/proev/` | `proev-referat.js` (rigtig Gemini, koster penge) og `test-adgang.js` (udgivet server afviser fremmede) |
| `scripts/testbaenk/` | Testlyd og målinger mod rigtig Gemini (koster penge, spørg først). `lange.js` måler 1-3 timer og to filer i bidder (`--falsk` er gratis). `lav-klippelyd.js` laver testlyden i `app/test/lyd/`. Forbrug logges i `testlyd/forbrug.json` |

Mapper: `app/` (PWA, tests i `app/test/`), `server/` (tests i `server/test/`), `e2e/` (browsertests), `scripts/` (tests i `scripts/test/`), `docs/`. Workflows: `tjek.yml`, `app.yml` ("Udgiv appen", `app/**`) og `server.yml` ("Udgiv serveren", `server/**`). Kun lokalt: `testlyd/`, `.vaerktoej/` (browsere, ffmpeg), `.superpowers/`, `arkiv/`. Appens offentlige adresse `/TransskriberinsAPP/` følger repoets navn, ikke mappen: den må aldrig ændres, for login og telefonernes lager hænger på den.

Googles grænser på Tier 1: Flash 1.000 kald/min og 10.000/dag, Transcribe 10 kald/min, 10.000 tokens/min og 100/dag. Indholdsfilteret kan ikke slås fra. Forsidens browsertests måler med Arial/Liberation Sans, så de også består med Linux' skrifter på GitHub.

## Kommandoer

```
npm test                     # alle unit-tests
npm run e2e                  # hele forløbet i Chromium med falsk login og falsk Gemini
npm run lokal                # lokal server på :4280
npm run tjek:hemmeligheder   # finder nøgler og interne dokumenter i git
node --env-file=.env scripts/proev/proev-referat.js testlyd/x.txt --pdf .   # rigtig Gemini, koster penge
```

## Udgivelse

- Push til `main` udgiver straks: `app/` til GitHub Pages og `server/` til Cloud Run. Begge kører hele testsuiten først.
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
