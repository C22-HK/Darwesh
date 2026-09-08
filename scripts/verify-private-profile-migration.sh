#!/usr/bin/env bash
# U1 migration rehearsal -- EMULATOR ONLY. Exercises the full
# seed -> dry-run -> apply -> verify -> rollback -> verify cycle of
# backend/scripts/migrate_private_profile.py against a throwaway Firestore
# emulator, then re-checks with the client SDK (through firestore.rules)
# that a signed-out visitor still reads the public agent document but never
# its private fields. Never touches production: the migration tool itself
# refuses to run without FIRESTORE_EMULATOR_HOST unless --allow-production.
#
#   ./scripts/verify-private-profile-migration.sh
#
# Requires: firebase-tools (npm), python3 with google-cloud-firestore
# (backend/requirements.txt), and network-free emulator binaries already
# cached (same as `npm run test:rules`).
set -euo pipefail
cd "$(dirname "$0")/.."
export FIRESTORE_EMULATOR_HOST=127.0.0.1:8080
OUT="${MIGRATION_REPORT_DIR:-/tmp}/private-profile-migration"
mkdir -p "$OUT"
MIG="python3 backend/scripts/migrate_private_profile.py --project demo-darwesh"

npx firebase emulators:exec --only firestore --project demo-darwesh "
  set -e
  $MIG --mode seed-demo
  echo '== dry-run (writes nothing)'
  $MIG --mode dry-run --report $OUT/dry-run.json
  echo '== verify BEFORE apply must fail (legacy docs still carry private fields)'
  if $MIG --mode verify --report $OUT/verify-before.json; then echo 'expected verify to fail before apply'; exit 1; fi
  echo '== apply'
  $MIG --mode apply --report $OUT/apply.json
  echo '== verify AFTER apply must pass'
  $MIG --mode verify --report $OUT/verify-after.json
  echo '== rules check: public read of an agent doc has no private fields; private doc denied'
  node tests/migration/check_public_agent_doc.mjs
  echo '== rollback (restore public fields, delete private docs) and verify it is back to the legacy shape'
  $MIG --mode rollback --delete-private --report $OUT/rollback.json
  if $MIG --mode verify --report $OUT/verify-after-rollback.json; then echo 'expected verify to fail after rollback'; exit 1; fi
  echo '== apply again (idempotent re-run)'
  $MIG --mode apply --report $OUT/apply-2.json
  $MIG --mode verify --report $OUT/verify-final.json
"
echo "reports in $OUT"
