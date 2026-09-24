#!/usr/bin/env bash
set -Eeuo pipefail

# Script de migración desde entorno independiente / home-lab hacia Dragonwilds en Umbrel

SRC_DIR="${1:-}"
TARGET_DATA_DIR="${2:-/home/umbrel/umbrel/app-data/dragonwilds-server/data}"

if [[ -z "${SRC_DIR}" ]]; then
  echo "Uso: $0 <directorio-origen-runescape-o-migracion> [directorio-destino-app-data]" >&2
  echo "Ejemplo: $0 /home/umbrel/umbrel/home-lab/runescape" >&2
  echo "         $0 /home/umbrel/dragonwilds-migration /home/umbrel/umbrel/app-data/dragonwilds-server/data" >&2
  exit 1
fi

echo "=== Iniciando migración hacia ${TARGET_DATA_DIR} ==="

# Localizar carpeta Saved
SAVED_SRC=""
if [[ -d "${SRC_DIR}/RSDragonwilds/Saved" ]]; then
  SAVED_SRC="${SRC_DIR}/RSDragonwilds/Saved"
elif [[ -d "${SRC_DIR}/Saved" ]]; then
  SAVED_SRC="${SRC_DIR}/Saved"
elif [[ -d "${SRC_DIR}/home/umbrel/umbrel/home-lab/runescape/RSDragonwilds/Saved" ]]; then
  SAVED_SRC="${SRC_DIR}/home/umbrel/umbrel/home-lab/runescape/RSDragonwilds/Saved"
else
  echo "ERROR: No se encontró el directorio Saved en ${SRC_DIR}" >&2
  exit 1
fi

# Crear estructura destino
mkdir -p "${TARGET_DATA_DIR}/server/RSDragonwilds/Saved"
mkdir -p "${TARGET_DATA_DIR}/backups"
mkdir -p "${TARGET_DATA_DIR}/control"
mkdir -p "${TARGET_DATA_DIR}/wireguard"

# 1. Copiar partidas guardadas (SaveGames)
if [[ -d "${SAVED_SRC}/SaveGames" ]]; then
  echo "Copiando partidas guardadas (SaveGames)..."
  mkdir -p "${TARGET_DATA_DIR}/server/RSDragonwilds/Saved/SaveGames"
  cp -rf "${SAVED_SRC}/SaveGames/"* "${TARGET_DATA_DIR}/server/RSDragonwilds/Saved/SaveGames/"
fi

# 2. Copiar caché de celdas del mundo (SpudCache)
if [[ -d "${SAVED_SRC}/SpudCache" ]]; then
  echo "Copiando celdas del mundo (SpudCache)..."
  mkdir -p "${TARGET_DATA_DIR}/server/RSDragonwilds/Saved/SpudCache"
  cp -rf "${SAVED_SRC}/SpudCache/"* "${TARGET_DATA_DIR}/server/RSDragonwilds/Saved/SpudCache/"
fi

# 3. Copiar archivos de configuración INI
if [[ -d "${SAVED_SRC}/Config/LinuxServer" ]]; then
  echo "Copiando configuración del servidor (DedicatedServer.ini, Engine.ini)..."
  mkdir -p "${TARGET_DATA_DIR}/server/RSDragonwilds/Saved/Config/LinuxServer"
  cp -rf "${SAVED_SRC}/Config/LinuxServer/"* "${TARGET_DATA_DIR}/server/RSDragonwilds/Saved/Config/LinuxServer/"
fi

# 4. Copiar WireGuard si está en el origen
for wg_candidate in \
  "${SRC_DIR}/etc/wireguard/wg-vps.conf" \
  "${SRC_DIR}/wg-vps.conf" \
  "/etc/wireguard/wg-vps.conf"
do
  if [[ -f "${wg_candidate}" ]]; then
    echo "Copiando configuración WireGuard desde ${wg_candidate}..."
    cp -f "${wg_candidate}" "${TARGET_DATA_DIR}/wireguard/wg-vps.conf"
    break
  fi
done

# 5. Copiar backups si existen
for backup_candidate in \
  "${SRC_DIR}/home/umbrel/dragonwilds-backups" \
  "${SRC_DIR}/dragonwilds-backups" \
  "/home/umbrel/dragonwilds-backups"
do
  if [[ -d "${backup_candidate}" ]]; then
    echo "Copiando backups históricos desde ${backup_candidate}..."
    cp -f "${backup_candidate}/"*.tar.gz "${TARGET_DATA_DIR}/backups/" 2>/dev/null || true
    break
  fi
done

# 6. Ajustar permisos
echo "Ajustando permisos a 1000:1000 (usuario umbrel/steam)..."
chown -R 1000:1000 "${TARGET_DATA_DIR}" 2>/dev/null || true
chmod -R u+rwX,g+rwX,o+rX "${TARGET_DATA_DIR}/server" 2>/dev/null || true
chmod 0700 "${TARGET_DATA_DIR}/control" "${TARGET_DATA_DIR}/wireguard" 2>/dev/null || true

echo "=== Migración completada con éxito ==="
echo "Los archivos están listos para ser utilizados por el contenedor de Dragonwilds en Umbrel."
