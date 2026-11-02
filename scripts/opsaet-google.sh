#!/usr/bin/env bash
# Opsætter serveren hos Google Cloud. Køres én gang i Google Cloud Shell:
#
#   git clone https://github.com/PilotOLLGAARD/TransskriberinsAPP.git
#   cd TransskriberinsAPP
#   bash scripts/opsaet-google.sh
#
# Kræver et Google Cloud-projekt med aktiv betaling, valgt i Cloud Shell, og en Gemini-nøgle
# lavet i Google AI Studio til samme projekt. Scriptet beder om nøglen og viser den ikke.
# Det kan køres igen uden at gå i stykker: det, der allerede findes, springes over.

set -euo pipefail

REGION=europe-north2
TJENESTE=transskribering
REPO=PilotOLLGAARD/TransskriberinsAPP
APP=https://pilotollgaard.github.io
SERVER_KONTO_NAVN=transskribering-server
GITHUB_KONTO_NAVN=github-udgivelse
POOL=github
UDBYDER=github

PROJEKT=$(gcloud config get-value project 2>/dev/null)
if [ -z "$PROJEKT" ]; then
  echo "Vælg projektet først: gcloud config set project <projekt-id>" >&2
  exit 1
fi
NUMMER=$(gcloud projects describe "$PROJEKT" --format='value(projectNumber)')
SERVER_KONTO="$SERVER_KONTO_NAVN@$PROJEKT.iam.gserviceaccount.com"
GITHUB_KONTO="$GITHUB_KONTO_NAVN@$PROJEKT.iam.gserviceaccount.com"
BYG_KONTO="$NUMMER-compute@developer.gserviceaccount.com"

echo "Projekt: $PROJEKT ($NUMMER), region $REGION"

echo "1/7 Slår tjenesterne til"
gcloud services enable run.googleapis.com cloudbuild.googleapis.com artifactregistry.googleapis.com \
  secretmanager.googleapis.com iamcredentials.googleapis.com sts.googleapis.com generativelanguage.googleapis.com

echo "2/7 Gemmer Gemini-nøglen i Secret Manager"
if gcloud secrets describe gemini-api-key >/dev/null 2>&1; then
  echo "    Findes allerede. Ny nøgle: gcloud secrets versions add gemini-api-key --data-file=-"
else
  read -r -s -p "    Indsæt Gemini-nøglen, og tryk Enter (vises ikke): " NOEGLE
  echo
  if [ -z "$NOEGLE" ]; then echo "Ingen nøgle indtastet." >&2; exit 1; fi
  printf '%s' "$NOEGLE" | gcloud secrets create gemini-api-key --replication-policy=automatic --data-file=-
  unset NOEGLE
fi

echo "3/7 Opretter serverens konto, som kun må læse nøglen"
gcloud iam service-accounts describe "$SERVER_KONTO" >/dev/null 2>&1 ||
  gcloud iam service-accounts create "$SERVER_KONTO_NAVN" --display-name="Transskribering, server"
gcloud secrets add-iam-policy-binding gemini-api-key \
  --member="serviceAccount:$SERVER_KONTO" --role=roles/secretmanager.secretAccessor >/dev/null

echo "4/7 Giver bygningen af serveren de rettigheder, den skal bruge"
gcloud projects add-iam-policy-binding "$PROJEKT" \
  --member="serviceAccount:$BYG_KONTO" --role=roles/run.builder --condition=None >/dev/null

echo "5/7 Lader GitHub udgive uden fast nøgle (kun fra $REPO)"
gcloud iam service-accounts describe "$GITHUB_KONTO" >/dev/null 2>&1 ||
  gcloud iam service-accounts create "$GITHUB_KONTO_NAVN" --display-name="Transskribering, udgivelse fra GitHub"
for ROLLE in roles/run.admin roles/cloudbuild.builds.editor roles/artifactregistry.admin roles/storage.admin roles/serviceusage.serviceUsageConsumer; do
  gcloud projects add-iam-policy-binding "$PROJEKT" \
    --member="serviceAccount:$GITHUB_KONTO" --role="$ROLLE" --condition=None >/dev/null
done
for KONTO in "$SERVER_KONTO" "$BYG_KONTO"; do
  gcloud iam service-accounts add-iam-policy-binding "$KONTO" \
    --member="serviceAccount:$GITHUB_KONTO" --role=roles/iam.serviceAccountUser >/dev/null
done
gcloud iam workload-identity-pools describe "$POOL" --location=global >/dev/null 2>&1 ||
  gcloud iam workload-identity-pools create "$POOL" --location=global --display-name="GitHub"
gcloud iam workload-identity-pools providers describe "$UDBYDER" --location=global --workload-identity-pool="$POOL" >/dev/null 2>&1 ||
  gcloud iam workload-identity-pools providers create-oidc "$UDBYDER" --location=global --workload-identity-pool="$POOL" \
    --display-name="GitHub Actions" --issuer-uri="https://token.actions.githubusercontent.com" \
    --attribute-mapping="google.subject=assertion.sub,attribute.repository=assertion.repository" \
    --attribute-condition="assertion.repository=='$REPO'"
gcloud iam service-accounts add-iam-policy-binding "$GITHUB_KONTO" --role=roles/iam.workloadIdentityUser \
  --member="principalSet://iam.googleapis.com/projects/$NUMMER/locations/global/workloadIdentityPools/$POOL/attribute.repository/$REPO" >/dev/null

echo "6/7 Udgiver serveren første gang (tager et par minutter)"
gcloud run deploy "$TJENESTE" --source server --region "$REGION" \
  --service-account "$SERVER_KONTO" \
  --use-http2 --timeout=900 --max-instances=3 --min-instances=0 --memory=512Mi \
  --set-env-vars "ENTRA_TENANT_ID=0aefac4e-4313-4168-9865-27d269eaeff8,ENTRA_CLIENT_ID=792bac2e-d895-4c24-9a58-7466eb8d03a3,TILLADT_OPRINDELSE=$APP,GEMINI_MODEL=gemini-3.5-transcribe,SPROG=da-DK,TRANSSKRIPTION_TILSTAND=smart" \
  --set-secrets "GEMINI_API_KEY=gemini-api-key:latest" \
  --quiet

echo "7/7 Åbner serveren for kald. Adgangen afgøres af Microsoft-login i serverens egen kode"
gcloud run services add-iam-policy-binding "$TJENESTE" --region "$REGION" \
  --member=allUsers --role=roles/run.invoker >/dev/null

ADRESSE=$(gcloud run services describe "$TJENESTE" --region "$REGION" --format='value(status.url)')

echo
echo "Færdig. Tjekker, at fremmede afvises:"
node scripts/test-adgang.js "$ADRESSE" || echo "ADVARSEL: Afvisningen virker ikke som ventet. Brug ikke appen, før det er rettet."

cat <<EOF

Sæt disse fire variabler på GitHub under
https://github.com/$REPO/settings/variables/actions (fanen Variables, ikke Secrets):

  SERVER_ADRESSE       $ADRESSE
  GCP_WIF_PROVIDER     projects/$NUMMER/locations/global/workloadIdentityPools/$POOL/providers/$UDBYDER
  GCP_SERVICE_ACCOUNT  $GITHUB_KONTO
  GCP_SERVER_KONTO     $SERVER_KONTO

Kør derefter "Udgiv appen" under Actions på GitHub, så appen får serverens adresse.
Husk at sætte et forbrugsloft på projektet (se docs/vejledning.md).
EOF
