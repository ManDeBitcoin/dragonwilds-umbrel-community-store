#!/usr/bin/env bash
set -euo pipefail

if [[ $# -lt 1 || $# -gt 2 ]]; then
  echo "Uso: $0 ghcr.io/ManDeBitcoin/dragonwilds-umbrel:0.1.0 [digest]" >&2
  exit 2
fi

image_ref="$(echo "$1" | tr '[:upper:]' '[:lower:]')"
if [[ $# -eq 2 ]]; then
  digest="$2"
else
  digest="$(docker buildx imagetools inspect "$image_ref" 2>/dev/null | awk '/^Digest:/ {print $2; exit}' || true)"
fi

if [[ ! "$digest" =~ ^sha256:[0-9a-f]{64}$ ]]; then
  echo "No se pudo resolver un digest válido para $image_ref" >&2
  exit 1
fi

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
compose_file="$repo_root/dragonwilds-server/docker-compose.yml"
escaped_ref="${image_ref//\//\\/}"
escaped_digest="${digest//\//\\/}"
sed -E -i.bak "s/^    image: .*/    image: ${escaped_ref}@${escaped_digest}/" "$compose_file"
rm -f "$compose_file.bak"
echo "Imagen fijada: ${image_ref}@${digest}"
