#!/usr/bin/env bash
# One-time Google Cloud setup for thomaszacharias-mcp on Cloud Run.
# Creates: APIs, two service accounts, Secret Manager secrets, and keyless GitHub
# deploy access (Workload Identity Federation). Creates NO buckets, NO Artifact
# Registry repos and NO key files — Google Cloud only runs the container.
#
# Usage:
#   PROJECT_ID=my-project GITHUB_REPO=owner/thomaszacharias-mcp REGION=asia-south1 ./deploy/setup-gcp.sh
set -euo pipefail

: "${PROJECT_ID:?set PROJECT_ID}"
: "${GITHUB_REPO:?set GITHUB_REPO (owner/repo)}"
REGION="${REGION:-asia-south1}"
POOL=github
PROVIDER=github
RUNTIME_SA="mcp-runtime@${PROJECT_ID}.iam.gserviceaccount.com"
DEPLOY_SA="mcp-deployer@${PROJECT_ID}.iam.gserviceaccount.com"

gcloud config set project "$PROJECT_ID"
PROJECT_NUMBER="$(gcloud projects describe "$PROJECT_ID" --format='value(projectNumber)')"

echo "==> Enabling APIs"
gcloud services enable run.googleapis.com secretmanager.googleapis.com iamcredentials.googleapis.com sts.googleapis.com

echo "==> Service accounts"
gcloud iam service-accounts create mcp-runtime --display-name="thomaszacharias-mcp runtime" 2>/dev/null || true
gcloud iam service-accounts create mcp-deployer --display-name="thomaszacharias-mcp GitHub deployer" 2>/dev/null || true

# Runtime SA: may only read its own secrets. Nothing else.
# Deployer SA: may deploy Cloud Run and act as the runtime SA.
gcloud projects add-iam-policy-binding "$PROJECT_ID" --member="serviceAccount:${DEPLOY_SA}" --role=roles/run.admin --condition=None >/dev/null
gcloud iam service-accounts add-iam-policy-binding "$RUNTIME_SA" --member="serviceAccount:${DEPLOY_SA}" --role=roles/iam.serviceAccountUser >/dev/null

echo "==> Secrets (values are prompted, never written to disk)"
for name in DATABASE_URL DATABASE_CA_CERT UNSTOPPABLE_API_KEY ETHEREUM_RPC_URL BASE_RPC_URL POLYGON_RPC_URL PRICE_FEED_API_KEY API_KEYS MCP_AUTH_SECRET; do
  if ! gcloud secrets describe "$name" >/dev/null 2>&1; then
    gcloud secrets create "$name" --replication-policy=automatic >/dev/null
  fi
  if [[ "$name" == "DATABASE_CA_CERT" ]]; then
    read -r -p "Path to Supabase CA certificate (.crt) [skip]: " certpath
    [[ -n "$certpath" ]] && gcloud secrets versions add "$name" --data-file="$certpath" >/dev/null
  elif [[ "$name" == "MCP_AUTH_SECRET" ]]; then
    openssl rand -hex 32 | tr -d '\n' | gcloud secrets versions add "$name" --data-file=- >/dev/null
    echo "   $name: generated"
  else
    read -r -s -p "Value for $name (enter to skip): " value; echo
    [[ -n "$value" ]] && printf '%s' "$value" | gcloud secrets versions add "$name" --data-file=- >/dev/null
  fi
  gcloud secrets add-iam-policy-binding "$name" --member="serviceAccount:${RUNTIME_SA}" --role=roles/secretmanager.secretAccessor >/dev/null
done

echo "==> Keyless GitHub → Google auth (Workload Identity Federation)"
gcloud iam workload-identity-pools create "$POOL" --location=global --display-name="GitHub" 2>/dev/null || true
gcloud iam workload-identity-pools providers create-oidc "$PROVIDER" --location=global --workload-identity-pool="$POOL" \
  --issuer-uri="https://token.actions.githubusercontent.com" \
  --attribute-mapping="google.subject=assertion.sub,attribute.repository=assertion.repository" \
  --attribute-condition="assertion.repository=='${GITHUB_REPO}'" 2>/dev/null || true
gcloud iam service-accounts add-iam-policy-binding "$DEPLOY_SA" --role=roles/iam.workloadIdentityUser \
  --member="principalSet://iam.googleapis.com/projects/${PROJECT_NUMBER}/locations/global/workloadIdentityPools/${POOL}/attribute.repository/${GITHUB_REPO}" >/dev/null

cat <<EOF

Done. Add these as GitHub → Settings → Secrets and variables → Actions → Variables:
  GCP_REGION        = ${REGION}
  GCP_WIF_PROVIDER  = projects/${PROJECT_NUMBER}/locations/global/workloadIdentityPools/${POOL}/providers/${PROVIDER}
  GCP_DEPLOY_SA     = ${DEPLOY_SA}
  GCP_RUNTIME_SA    = ${RUNTIME_SA}
  PUBLIC_BASE_URL   = https://mcp.<your-domain>
  BILLING_PINNED_ADDRESSES = base:0x...,polygon:0x...

And as Actions secrets (used only to run database migrations):
  SUPABASE_DB_URL, SUPABASE_MIGRATION_DB_URL (session/direct URL), SUPABASE_CA_CERT
EOF
