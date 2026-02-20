#!/usr/bin/env bash
set -euo pipefail

echo "[check] opencode_mobile_gateway prerequisites"

missing=0

if ! command -v opencode >/dev/null 2>&1; then
  echo "- missing: opencode"
  missing=1
else
  echo "- ok: opencode ($(opencode --version 2>/dev/null || echo version-unknown))"
fi

if ! command -v node >/dev/null 2>&1; then
  echo "- missing: node"
  missing=1
else
  echo "- ok: node ($(node -v))"
fi

if ! command -v git >/dev/null 2>&1; then
  echo "- missing: git"
  missing=1
else
  echo "- ok: git ($(git --version))"
fi

if [ ! -f "./config/instances.json" ]; then
  echo "- note: config/instances.json not found (run: npm run onboard)"
else
  echo "- ok: config/instances.json"
fi

if [ "$missing" -eq 1 ]; then
  printf '\n[fail] missing required prerequisites\n'
  exit 1
fi

printf '\n[ok] prerequisites look good\n'
