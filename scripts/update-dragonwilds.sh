#!/usr/bin/env bash
set -Eeuo pipefail

# Script de actualización de RuneScape Dragonwilds adaptado para Umbrel
# Replica la lógica de update-dragonwilds del host independiente utilizando el contenedor de Umbrel.

APP_NAME="dragonwilds-server"
APP_DIR="${APP_DIR:-/home/umbrel/umbrel/app-data/${APP_NAME}}"
ACTION="update"

if [[ "${1:-}" == "validate" ]]; then
  ACTION="validate"
fi

echo "=== Dragonwilds Server Updater (Umbrel) ==="
echo "Acción: ${ACTION}"

# Opción 1: Si el contenedor está activo, solicitar actualización segura vía supervisor web
if curl -fsS "http://127.0.0.1:8080/healthz" >/dev/null 2>&1; then
  echo "Enviando orden segura al supervisor de Dragonwilds..."
  if curl -fsS -X POST "http://127.0.0.1:8080/api/server/${ACTION}" >/dev/null 2>&1; then
    echo "Actualización iniciada en segundo plano con backup automático."
    echo "Puedes consultar el progreso en el panel web o ejecutando: docker compose logs -f app"
    exit 0
  fi
fi

# Opción 2: Si el panel no responde o se ejecuta directamente mediante Docker Compose
echo "Ejecutando actualización directamente dentro del contenedor..."
docker compose exec app /opt/dragonwilds/entrypoint-game.sh || {
  echo "Aviso: no se pudo ejecutar dentro de un contenedor en ejecución. Verificando estado..."
}

echo "Proceso finalizado."
