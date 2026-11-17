#!/bin/sh
# Backup zilnic al datelor Nostradamus (previziuni, verificări, registrul de buget) și al fișierului .env.
# Păstrează ultimele 14 arhive. Instalat în crontab-ul utilizatorului ubuntu:
#   30 3 * * * /var/www/nostra/deploy/backup.sh
# Restaurare: tar -xzf <arhiva> -C /var/www/nostra   (apoi sudo systemctl restart nostra)
set -eu
APP=/var/www/nostra
DEST=${BACKUP_DIR:-/home/ubuntu/backups/nostra}
mkdir -p "$DEST"
chmod 700 "$DEST"
STAMP=$(date -u +%Y-%m-%d)
# Imaginile de previzualizare se pot regenera oricând: nu le salvăm.
tar -czf "$DEST/nostra-$STAMP.tar.gz.tmp" -C "$APP" --exclude=data/og data .env
mv "$DEST/nostra-$STAMP.tar.gz.tmp" "$DEST/nostra-$STAMP.tar.gz"
chmod 600 "$DEST/nostra-$STAMP.tar.gz"
ls -1t "$DEST"/nostra-*.tar.gz | tail -n +15 | xargs -r rm -f
