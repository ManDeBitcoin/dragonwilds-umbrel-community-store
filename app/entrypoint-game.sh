#!/usr/bin/env bash
set -Eeuo pipefail

STEAMAPPDIR="${STEAMAPPDIR:-/home/steam/rsdw-dedicated}"
STEAMCMDDIR="${STEAMCMDDIR:-/home/steam/steamcmd}"
STEAMAPPID="${STEAMAPPID:-4019830}"
STEAMAPPUPDATE="${STEAMAPPUPDATE:-0}"
STEAMAPPVALIDATE="${STEAMAPPVALIDATE:-0}"
RSDW_PORT="${RSDW_PORT:-23409}"
RSDW_LAUNCH="${STEAMAPPDIR}/RSDragonwildsServer.sh"
RSDW_SHIPPING="${STEAMAPPDIR}/RSDragonwilds/Binaries/Linux/RSDragonwildsServer-Linux-Shipping"
RSDW_CONFIG="${STEAMAPPDIR}/RSDragonwilds/Saved/Config/LinuxServer/DedicatedServer.ini"

echo "[Dragonwilds] Preparando entorno del servidor dedicado..."

# 1. Enlace al SDK de 64 bits de Steam
mkdir -p "${HOME}/.steam/sdk64"
if [[ -f "${STEAMCMDDIR}/linux64/steamclient.so" ]]; then
  ln -sfT "${STEAMCMDDIR}/linux64/steamclient.so" "${HOME}/.steam/sdk64/steamclient.so" 2>/dev/null || true
fi

# 2. Descargar o validar binarios si no existen o se solicitó explícitamente
if [[ (! -f "${RSDW_SHIPPING}" && ! -x "${RSDW_LAUNCH}") || "${STEAMAPPVALIDATE}" == "1" || "${STEAMAPPUPDATE}" == "1" ]]; then
  echo "[Dragonwilds] Descargando/actualizando servidor mediante SteamCMD (App ID ${STEAMAPPID})..."
  mkdir -p "${STEAMAPPDIR}"

  validate_arg=""
  if [[ "${STEAMAPPVALIDATE}" == "1" ]]; then
    validate_arg="validate"
  fi

  "${STEAMCMDDIR}/steamcmd.sh" \
    +force_install_dir "${STEAMAPPDIR}" \
    +@bClientTryRequestManifestWithoutCode 1 \
    +login anonymous \
    +app_update "${STEAMAPPID}" ${validate_arg} \
    +quit || {
      echo "[Dragonwilds] ERROR: SteamCMD finalizó con error al descargar/actualizar." >&2
      if [[ ! -f "${RSDW_SHIPPING}" && ! -x "${RSDW_LAUNCH}" ]]; then
        exit 1
      fi
    }
fi

# 3. Permisos ejecutables para el gestor de caídas y binario
if [[ -f "${STEAMAPPDIR}/RSDragonwilds/Plugins/Developer/Sentry/Binaries/Linux/crashpad_handler" ]]; then
  chmod +x "${STEAMAPPDIR}/RSDragonwilds/Plugins/Developer/Sentry/Binaries/Linux/crashpad_handler" 2>/dev/null || true
fi
if [[ -f "${RSDW_SHIPPING}" ]]; then
  chmod +x "${RSDW_SHIPPING}" 2>/dev/null || true
fi

# 4. Asegurar DedicatedServer.ini inicial si no existe ninguno
if [[ ! -f "${RSDW_CONFIG}" ]]; then
  echo "[Dragonwilds] Generando DedicatedServer.ini inicial..."
  mkdir -p "$(dirname "${RSDW_CONFIG}")"
  cat <<EOF > "${RSDW_CONFIG}"
;METADATA=(Diff=true, UseCommands=true)
[/Script/Dominion.DedicatedServerSettings]
OwnerId=${RSDW_OWNER_ID:-00025be9182947128e2c6f899f51e1ba}
ServerName=${RSDW_SERVER_NAME:-ChamapTV}
DefaultWorldName=${RSDW_WORLD_NAME:-Chavito}
WorldPassword=${RSDW_PASSWORD:-}
AdminPassword=${RSDW_ADMIN_PASSWORD:-}
PlatformPolicy=${RSDW_PLATFORM_POLICY:-Crossplay}
bAllowSendingCrashDumps=True
EOF
fi

# 5. Cambiar al directorio del juego y ejecutar respetando la arquitectura del motor
cd "${STEAMAPPDIR}/RSDragonwilds"

if [[ -x "${RSDW_SHIPPING}" ]]; then
  echo "[Dragonwilds] Arrancando binario dedicado RSDragonwildsServer-Linux-Shipping en puerto UDP ${RSDW_PORT}..."
  exec "${RSDW_SHIPPING}" RSDragonwilds -log -NewConsole -Port="${RSDW_PORT}"
elif [[ -x "${RSDW_LAUNCH}" ]]; then
  echo "[Dragonwilds] Arrancando RSDragonwildsServer.sh en puerto UDP ${RSDW_PORT}..."
  exec bash "${RSDW_LAUNCH}" -log -NewConsole -Port="${RSDW_PORT}"
else
  echo "[Dragonwilds] ERROR: No se encontró ejecutable del servidor en ${STEAMAPPDIR}." >&2
  exit 1
fi
