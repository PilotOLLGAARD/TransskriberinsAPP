# Transskriberingsapp til ØLLGAARD: projektregler

Medarbejderen indtaler en note på telefonen, læser teksten og sender den til sig selv. Erstatter Notta.ai.

Opsætning og udgivelse: `docs/vejledning.md`.

Repoet er offentligt. Disse filer ligger kun i projektmappen og må aldrig i git: `.env`, `docs/plan.md` (design og plan), `docs/it-opsaetning.md` (til IT), `docs/test-resultater.md`.

## Krav der aldrig må brydes

- Data må ikke bruges til træning eller gives videre: kun betalt Gemini API, `store: false`, filer slettes hos Google efter brug.
- En fremmed må aldrig kunne koste penge: adgangstjekket er det første, serveren gør på `POST /transskriber`, før lyden læses. Fejler lukket.
- Serveren kræver gyldig signatur, `iss`, `aud`, `exp`, `tid`, scope `access_as_user`, rollen `Transskribering.Bruger` og `acct = 0`. Mailadressen afgør aldrig adgang.
- En optagelse må aldrig gå tabt: Lyd slettes kun, når Microsoft har svaret 202 på mailen, eller brugeren selv har valgt Slet.
- Lydkvaliteten sættes ikke ned: ingen omkodning, nedsampling eller opdeling.
- Ingen hemmeligheder i git, i `web/` eller i logs. Læs aldrig `.env*`.
- Brug aldrig rigtige byggepladsnoter i udvikling eller test.

## Arkitektur

iPhone/Android-PWA (`web/`, ren HTML/JS uden build, GitHub Pages) → server (`server/`, Node 24 uden afhængigheder, Google Cloud Run) → Gemini 3.5 Transcribe. Mailen sendes fra telefonen via Microsoft Graph. Azure bruges ikke.

## Kommandoer

```
npm test                     # alle unit-tests
npm run e2e                  # hele forløbet i Chromium med falsk login og falsk Gemini
npm run lokal                # lokal server på :4280
npm run tjek:hemmeligheder   # finder nøgler i git
```

## Arbejdsform

- Små commits. Aldrig `git push --force`.
- Kør tests og se resultatet, før noget kaldes færdigt.
- Spørg før: første push, oprettelse i Google Cloud, alt der koster penge eller kræver IT.
- Sprog: brugerflade og dokumentation på dansk.
- Tilføj ikke funktioner uden aftale.
