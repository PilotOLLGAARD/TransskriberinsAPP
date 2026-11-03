# Vejledning: opstart, opsætning og udgivelse

Sådan fortsætter du på en anden computer, opsætter tjenesterne og udgiver en ny udgave.

## Sådan hænger det sammen

| Del | Hvor | Udgives ved |
|---|---|---|
| Appen (`web/`) | GitHub Pages | Push til `main` med ændringer i `web/` |
| Serveren (`server/`) | Google Cloud Run | Push til `main` med ændringer i `server/` |
| Nøglen til Gemini | Google Secret Manager og lokalt i `.env` | Skiftes manuelt, se nedenfor |
| Login | Microsoft Entra ID | IT, se `docs/it-opsaetning.md` |

Repoet er offentligt på GitHub-kontoen PilotOLLGAARD. Repoet hedder `TransskriberinsAPP`, og appen ligger på https://pilotollgaard.github.io/TransskriberinsAPP/. Brug præcis de store og små bogstaver, for adressen skal stemme med login-opsætningen.

**Opret aldrig andre GitHub Pages-sider på kontoen PilotOLLGAARD**, og aldrig repoet `pilotollgaard.github.io`. Alle sider på kontoen deler adressen `https://pilotollgaard.github.io`. En anden side ville derfor kunne læse medarbejdernes login og optagelser i browseren. Skal kontoen bruges til andet, skal appen først flyttes til sit eget domæne.

## Filer, der kun ligger i projektmappen

Disse filer kommer ikke på GitHub og følger ikke med `git clone`. Skifter du computer, skal du selv kopiere dem:

- `.env`
- `docs/overdragelse.md`
- `docs/plan.md` og alle `docs/plan-*.md`
- `docs/it-opsaetning.md`
- `docs/test-resultater.md`

Tag en sikkerhedskopi af dem, for eksempel på OneDrive. Mappen ligger ikke selv et sted med sikkerhedskopi. `npm run tjek:hemmeligheder` fejler, hvis en af dem nogensinde har ligget i git, også i et tag eller en gammel gren.

Historikken fra før repoet blev offentligt ligger som `C:\Users\RW\TranskriberingsApp-backup\foer-offentlig.bundle` uden for projektmappen. Den indeholder interne dokumenter og må aldrig lægges på GitHub.

## Lokal opstart

Kræver Node 24 og Git.

```bash
git clone https://github.com/PilotOLLGAARD/TransskriberinsAPP.git
```

```bash
cd TransskriberinsAPP
```

```bash
npm install
```

```bash
npm test
```

```bash
npm run lokal
```

Åbn http://localhost:4280. Login, transskription og mail er falske, så det koster ikke noget, og `.env` er ikke nødvendig.

Browsertestene kræver en browser, der kun skal hentes én gang:

```bash
npx playwright install chromium
```

```bash
npm run e2e
```

På computeren, hvor projektet blev bygget, ligger browseren i `.vaerktoej/browsere`, så der er installationen ikke nødvendig. Ellers sættes `PLAYWRIGHT_BROWSERS_PATH`, inden testene køres.

## `.env`

`.env` skal kun bruges, når du vil prøve rigtig Gemini fra din computer. Den ligger i projektmappen og er ignoreret af git.

1. Kopiér `.env.example` til `.env`.
2. Indsæt nøglen ud for `GEMINI_API_KEY`.

Prøv en selvindtalt testoptagelse (koster penge):

```bash
node --env-file=.env scripts/proev-gemini.js testnote.m4a
```

Der er ingen `local.settings.json`, da projektet ikke bruger Azure Functions.

## Opsætning af Google Cloud

Gøres kun én gang. Scriptet er skrevet, men endnu ikke kørt mod Google, så læs det, det skriver.

1. **Opret projektet.** Opret et Google Cloud-projekt på https://console.cloud.google.com, og tilknyt en aktiv betalingskonto. Det er det, der gør Gemini til betalt niveau, hvor Google ikke bruger data til at forbedre produkter.
2. **Opret nøglen.** Opret en Gemini-nøgle til samme projekt på https://aistudio.google.com/apikey. Sæt den også ind i `.env` på din computer.
3. **Kør opsætningen.** Åbn Cloud Shell (ikonet `>_` øverst i Google Cloud Console), vælg projektet, og kør de tre kommandoer herunder. Scriptet beder om nøglen og viser den ikke på skærmen.

```bash
git clone https://github.com/PilotOLLGAARD/TransskriberinsAPP.git
```

```bash
cd TransskriberinsAPP
```

```bash
bash scripts/opsaet-google.sh
```

   Scriptet slår tjenesterne til, gemmer nøglen i Secret Manager, giver GitHub adgang uden fast nøgle (kun fra dette repo), udgiver serveren i Stockholm og tjekker, at fremmede afvises.
4. **Sæt de fire variabler på GitHub,** som scriptet skriver til sidst, under Settings > Secrets and variables > Actions > Variables. De er ikke hemmelige.
5. **Kør "Udgiv appen"** under Actions på GitHub, så appen får serverens adresse.
6. **Sæt et forbrugsloft.** Under Fakturering > Budgetter oprettes et loft for Gemini API og for Cloud Run. Et almindeligt budget advarer kun, så vælg typen med loft. Når loftet nås, stopper tjenesten resten af måneden, og optagelserne bliver liggende på telefonerne.

Serverens adresse sættes ind i appen af GitHub, når den udgives. Den skal ikke rettes i koden.

## Udgiv en ny udgave

1. Lav ændringen på en branch, og kør `npm test` og `npm run e2e`.
2. Læg ændringen på GitHub, og flet den ind i `main`.
3. GitHub udgiver selv det, der er ændret. Følg det under Actions.
4. Telefonerne henter en ny udgave af appen, næste gang den åbnes, og bruger den gangen efter. Versionsnummeret sættes af GitHub.
5. Ændringer i `server/` udgives først, når testene er bestået.
6. **Serveren skal ud før appen,** når en ændring rører begge, fx nye headere. Læg serverens ændring på `main` først, og vent, til "Udgiv serveren" er grøn under Actions. Læg derefter appens ændring på. Ellers kan den nye app i nogle minutter tale med den gamle server, og afsendelser fejler med "Ingen forbindelse". Lyden bevares, og Prøv igen virker bagefter.

## Skift af Gemini-nøglen

1. Opret en ny nøgle i Google AI Studio, og læg den i Secret Manager (Ctrl+D afslutter):

```bash
gcloud secrets versions add gemini-api-key --data-file=-
```

2. Kør "Udgiv serveren" under Actions på GitHub. Serveren bruger altid den nyeste nøgle.
3. Slet den gamle nøgle i Google AI Studio.

## Referat og PDF

Efter transskriptionen laver serveren et referat med Gemini 3.8 Flash og en PDF med ØLLGAARD-logo, skriften Lato og hele transskriptionen som bilag. Intet gemmes på serveren eller hos Google (`store: false`). Et referat koster ca. 2 øre for 5 minutters tale.

- Modellen kan skiftes med miljøvariablen `REFERAT_MODEL` på serveren, fx `gemini-3.5-flash-lite`.
- Reglerne for referatet står i `server/src/referat.js`.
- Prøv et referat og en PDF på din computer (koster penge, brug kun opdigtede tekster):

```bash
node --env-file=.env scripts/proev-referat.js testlyd/note.txt --titel "Test" --varighed 120 --pdf .
```

## Rette ordlisten med fagudtryk

Ret `server/src/ordliste.js`, og læg ændringen på `main`. Bedst med højst 100 ord, kun egennavne og fagudtryk.

## Fejlfinding

| Det ser du | Sandsynlig årsag |
|---|---|
| Alle får "Din konto har ikke adgang" | Den valgfri claim `acct` er ikke sat op i Entra ID. Se `docs/it-opsaetning.md`. Serverens log viser grunden som `adgang-afvist` |
| Alle får "Transskriptionen mislykkedes" | Nøglen, forbrugsloftet eller Google. Serverens log viser `gemini-fejl` med en kode. `server-ikke-klar` betyder, at en indstilling mangler |
| Appen svarer "Ingen forbindelse" trods net | Variablen `SERVER_ADRESSE` på GitHub mangler eller er forkert, eller "Udgiv appen" er ikke kørt efter den blev sat |

Serverens log findes i Google Cloud Console under Cloud Run > transskribering > Logs. Den indeholder aldrig tekst, lyd eller hvem der har kaldt.
