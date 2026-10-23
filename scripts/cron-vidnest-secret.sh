#!/usr/bin/env bash
# Refresh vidnest v2 secret into .env; restart backend only when it changes.
# Installed on the droplet as a cron job every 3 days (see readme.md).
set -euo pipefail
export PATH="/root/.nvm/versions/node/v20.20.2/bin:/usr/local/bin:/usr/bin:/bin:$PATH"
cd /var/www/m3u8-scraper
LOG=/var/log/vidnest-secret.log
mkdir -p "$(dirname "$LOG")"
{
  echo "==== $(date -u +%Y-%m-%dT%H:%M:%SZ) ===="
  set -a
  # shellcheck disable=SC1091
  [ -f .env ] && . ./.env
  set +a
  OUT=$(node scripts/update-vidnest-secret.mjs --env-apply 2>&1) || {
    echo "$OUT"
    echo "FAILED (exit $?)"
    exit 1
  }
  echo "$OUT"
  if echo "$OUT" | grep -q "UPDATED .env"; then
    echo "Restarting backend…"
    pm2 restart backend --update-env
  else
    echo "No restart needed."
  fi
} >>"$LOG" 2>&1
