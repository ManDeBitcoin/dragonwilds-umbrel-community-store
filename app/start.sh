#!/usr/bin/env bash
set -euo pipefail

# 1. Crear directorios base
install -d -o 1000 -g 1000 /home/steam/rsdw-dedicated
install -d -m 0700 /data/control /data/backups /etc/wireguard
mkdir -p /home/steam/.config/Epic
touch /home/steam/.config/Epic/NotAllowedUnattendedBugReports

# 2. Sembrado automático (seed-data) si los volúmenes montados están vacíos
if [[ -d /opt/dragonwilds/seed-data ]]; then
  if [[ ! -f /data/control/settings.json && -f /opt/dragonwilds/seed-data/control/settings.json ]]; then
    echo "[start.sh] Inicializando configuración inicial desde datos migrados..."
    cp /opt/dragonwilds/seed-data/control/settings.json /data/control/settings.json
  fi

  if [[ ! -f /etc/wireguard/wg-vps.conf && -f /opt/dragonwilds/seed-data/wireguard/wg-vps.conf ]]; then
    echo "[start.sh] Inicializando configuración WireGuard desde datos migrados..."
    cp /opt/dragonwilds/seed-data/wireguard/wg-vps.conf /etc/wireguard/wg-vps.conf
  fi

  if [[ ! -d /home/steam/rsdw-dedicated/RSDragonwilds/Saved && -d /opt/dragonwilds/seed-data/server/RSDragonwilds/Saved ]]; then
    echo "[start.sh] Inicializando mundo guardado y configuraciones desde datos migrados..."
    mkdir -p /home/steam/rsdw-dedicated/RSDragonwilds
    cp -r /opt/dragonwilds/seed-data/server/RSDragonwilds/Saved /home/steam/rsdw-dedicated/RSDragonwilds/
  fi

  if compgen -G "/opt/dragonwilds/seed-data/backups/*.tar.gz" >/dev/null; then
    for backup in /opt/dragonwilds/seed-data/backups/*.tar.gz; do
      base="$(basename "$backup")"
      if [[ ! -f "/data/backups/$base" ]]; then
        cp "$backup" "/data/backups/$base"
      fi
    done
  fi
fi

# 3. Permisos adecuados para usuario steam (1000:1000)
chown -R 1000:1000 /home/steam /data/control /data/backups
chmod -R u+rwX,g+rwX,o+rX /home/steam/rsdw-dedicated
chmod 0755 /opt/dragonwilds/entrypoint-game.sh 2>/dev/null || true

# 4. Iniciar panel web supervisor
exec node /opt/dragonwilds/src/server.js
