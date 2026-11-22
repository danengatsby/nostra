#!/bin/sh
# Backup local zilnic. Pentru copia externă, configurează variabilele în mediul cron.
set -eu
umask 077
APP=${NOSTRA_APP_DIR:-/var/www/nostra}
DEST=${BACKUP_DIR:-/home/ubuntu/backups/nostra}
mkdir -p "$DEST"
chmod 700 "$DEST"
stage=$(mktemp -d "$DEST/.backup.XXXXXX")
trap 'rm -rf "$stage"' EXIT
archive=nostra-$(date -u +%F).tar.gz
mkdir "$stage/data"
# Luăm mai întâi coada. Rezultatele deja finalizate între timp sunt detectate la reluare.
if [ -f "$APP/data/operations.sqlite" ]; then
  python3 - "$APP/data/operations.sqlite" "$stage/data/operations.sqlite" <<'PY'
import sqlite3, sys
from pathlib import Path
with sqlite3.connect(Path(sys.argv[1]).resolve().as_uri() + '?mode=ro', uri=True) as source, sqlite3.connect(sys.argv[2]) as target:
    source.backup(target)
    if target.execute('PRAGMA integrity_check').fetchone() != ('ok',):
        raise RuntimeError('Backup SQLite invalid')
PY
fi
tar -cf "$stage/content.tar" -C "$APP" --exclude=data/og --exclude='data/operations.sqlite*' --exclude='data/access.db*' --exclude='*.tmp' data .env
if [ -f "$stage/data/operations.sqlite" ]; then
  tar -rf "$stage/content.tar" -C "$stage" data/operations.sqlite
fi
gzip -c "$stage/content.tar" > "$stage/$archive"
tar -tzf "$stage/$archive" >/dev/null
mv "$stage/$archive" "$DEST/$archive"
if [ -n "${BACKUP_SSH_DEST:-}${BACKUP_GPG_RECIPIENT:-}" ]; then
  : "${BACKUP_SSH_DEST:?Lipsește destinația SSH}" "${BACKUP_GPG_RECIPIENT:?Lipsește cheia publică GPG}"
  gpg --batch --trust-model always --recipient "$BACKUP_GPG_RECIPIENT" --output "$stage/$archive.gpg" --encrypt "$DEST/$archive"
  scp -B -o StrictHostKeyChecking=yes -- "$stage/$archive.gpg" "${BACKUP_SSH_DEST%/}/$archive.gpg"
fi
ls -1t "$DEST"/nostra-*.tar.gz | tail -n +15 | while IFS= read -r old; do rm -f -- "$old"; done
