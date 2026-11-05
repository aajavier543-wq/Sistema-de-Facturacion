#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
node scripts/verify-ocr-model.mjs
npm ci --prefix backend --include=dev --no-audit --no-fund
npm ci --prefix frontend --include=dev --no-audit --no-fund
npm run build --prefix backend
npm run build --prefix frontend
