# Vejledning: opstart, opsætning og udgivelse

Sådan fortsætter du på en anden computer, opsætter tjenesterne og udgiver en ny udgave.

## Sådan hænger det sammen

| Del | Hvor | Udgives ved |
|---|---|---|
| Appen (`web/`) | GitHub Pages | Push til `main` med ændringer i `web/` |
| Serveren (`server/`) | Google Cloud Run | Push til `main` med ændringer i `server/` |
| Nøglen til Gemini | Google Secret Manager og lokalt i `.env` | Skiftes manuelt, se nedenfor |
| Login | Microsoft Entra ID | IT, se `docs/it-opsaetning.md` |

## Lokal opstart

Kræver Node 24 og Git.

```bash
git clone <repoets adresse>
```

```bash
cd transskriberingsapp
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

Gøres kun én gang. Kommandoerne kører du i Google Cloud Shell eller med `gcloud` på din computer. Tjek rollerne, når det gøres første gang, da de ikke er afprøvet endnu.

1. **Opret projektet.** Opret et Google Cloud-projekt, og tilknyt en aktiv betalingskonto. Det er det, der gør Gemini til betalt niveau, hvor Google ikke bruger data til at forbedre produkter.
2. **Opret nøglen.** Opret en Gemini-nøgle til projektet i Google AI Studio, og begræns den til Gemini API'et.
3. **Sæt et forbrugsloft.** Under Fakturering > Budgetter oprettes et loft for hver tjeneste, Gemini API og Cloud Run. Et almindeligt budget advarer kun, så vælg typen med loft. Når loftet nås, stopper tjenesten resten af måneden, og alle optagelser bliver liggende på telefonerne.
4. **Slå tjenesterne til:**

```bash
gcloud services enable run.googleapis.com cloudbuild.googleapis.com artifactregistry.googleapis.com secretmanager.googleapis.com iamcredentials.googleapis.com
```

5. **Læg nøglen i Secret Manager.** Kommandoen læser nøglen uden at gemme den i din historik. Indsæt nøglen, tryk Enter og derefter Ctrl+D:

```bash
gcloud secrets create gemini-api-key --data-file=-
```

6. **Giv serveren adgang til nøglen.** Rollen `roles/secretmanager.secretAccessor` gives til serverens tjenestekonto.
7. **Giv GitHub adgang uden fast nøgle.** Opret en Workload Identity Federation-pool, der kun tillader dit repo, og en tjenestekonto med rollerne `roles/run.admin`, `roles/cloudbuild.builds.editor`, `roles/artifactregistry.admin`, `roles/storage.admin` og `roles/iam.serviceAccountUser`. Vejledning: [google-github-actions/auth](https://github.com/google-github-actions/auth).
8. **Sæt variabler på GitHub** under Settings > Secrets and variables > Actions > Variables. De er ikke hemmelige:

| Navn | Eksempel |
|---|---|
| `GCP_WIF_PROVIDER` | `projects/123/locations/global/workloadIdentityPools/github/providers/repo` |
| `GCP_SERVICE_ACCOUNT` | `github-udgivelse@projekt.iam.gserviceaccount.com` |
| `TILLADT_OPRINDELSE` | `https://navn.github.io` (uden sti) |
| `GEMINI_NOEGLE_VERSION` | `1` |

9. **Slå GitHub Pages til** under Settings > Pages > Source: GitHub Actions.
10. **Første udgivelse af serveren.** Kør workflowet "Udgiv serveren", og åbn derefter serveren for kald. Adgangen afgøres af Entra-beviset i vores egen kode, ikke af Googles login:

```bash
gcloud run services add-iam-policy-binding transskribering --region=europe-north2 --member=allUsers --role=roles/run.invoker
```

11. **Indsæt serverens adresse** i `web/js/konfig.js` (`SERVER_ADRESSE`) og i `Content-Security-Policy` i `web/index.html`. Adressen er ikke hemmelig. En test fejler, hvis de to ikke er ens.
12. **Send appens adresse til IT** som Redirect URI.
13. **Tjek afvisningen:**

```bash
node scripts/test-adgang.js https://serverens-adresse
```

Alle tre forsøg skal give 401.

## Udgiv en ny udgave

1. Lav ændringen på en branch, og kør `npm test` og `npm run e2e`.
2. Læg ændringen på GitHub, og flet den ind i `main`.
3. GitHub udgiver selv det, der er ændret. Følg det under Actions.
4. Er appens filer ændret, så skift `VERSION` i `web/sw.js`. Telefonerne henter den nye udgave næste gang appen åbnes, og bruger den gangen efter.

## Skift af Gemini-nøglen

1. Opret en ny nøgle i Google AI Studio, og læg den i Secret Manager (Ctrl+D afslutter):

```bash
gcloud secrets versions add gemini-api-key --data-file=-
```

2. Ret `GEMINI_NOEGLE_VERSION` på GitHub, og kør "Udgiv serveren".
3. Slet den gamle nøgle i Google AI Studio.

## Rette ordlisten med fagudtryk

Ret `server/src/ordliste.js`, og læg ændringen på `main`. Bedst med højst 100 ord, kun egennavne og fagudtryk.

## Fejlfinding

| Det ser du | Sandsynlig årsag |
|---|---|
| Alle får "Din konto har ikke adgang" | Rollen er ikke tildelt, `acct` er ikke sat op, eller `requestedAccessTokenVersion` er ikke 2. Se `docs/it-opsaetning.md`. Serverens log viser grunden som `adgang-afvist` |
| Alle får "Transskriptionen mislykkedes" | Nøglen, forbrugsloftet eller Google. Serverens log viser `gemini-fejl` med en kode. `server-ikke-klar` betyder, at en indstilling mangler |
| Appen svarer "Ingen forbindelse" trods net | `SERVER_ADRESSE` eller `TILLADT_OPRINDELSE` er forkert |

Serverens log findes i Google Cloud Console under Cloud Run > transskribering > Logs. Den indeholder aldrig tekst, lyd eller hvem der har kaldt.
