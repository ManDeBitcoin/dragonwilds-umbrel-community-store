#!/usr/bin/env bash
set -euo pipefail

install -d -o 1000 -g 1000 /home/steam/rsdw-dedicated
install -d -m 0700 /data/control /data/backups /etc/wireguard
chown 1000:1000 /home/steam/rsdw-dedicated

exec node /opt/dragonwilds/src/server.js
