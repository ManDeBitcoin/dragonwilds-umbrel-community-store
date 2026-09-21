# Validación realizada

## Comprobaciones superadas

- `node --test`: validación de ajustes, redacción de secretos y rechazo de claves
  WireGuard malformadas/inyección de configuración.
- `node --check`: API, runtime y frontend sin errores de sintaxis.
- Parseo de YAML: store, manifiesto, ambos Compose y workflow.
- Parseo estructural de HTML y `git diff --check`.
- Prueba HTTP del panel con servidor simulado:
  - bootstrap y login;
  - guardado de ajustes;
  - secretos ausentes en la respuesta;
  - arranque y parada;
  - cabeceras CSP y `nosniff`.
- Flujo de mantenimiento simulado:
  - backup con parada segura;
  - restauración con backup de retorno;
  - importación `.sav`;
  - reinicio automático después del mantenimiento.
- Linter oficial de `getumbrel/umbrel-apps`: 0 errores de estructura al sustituir
  temporalmente la imagen todavía no publicada por una referencia existente con
  digest. Las advertencias de `/dev/net/tun`, `NET_ADMIN`, `SYS_MODULE` y
  `/lib/modules` son intencionales y están justificadas en `SECURITY.md`.

## Límites comprobados

El chequeo de imágenes oficial confirma que la imagen actual de Jagex es sólo
`linux/amd64`; por ello no puede superar el gate multi-arquitectura del App Store
oficial. Sí puede distribuirse como Community App Store para equipos x86_64,
dejando esa limitación visible en el manifiesto.

## Pendiente antes de una instalación real

1. Sustituir `YOUR_GITHUB_USER`.
2. Publicar `ghcr.io/<usuario>/dragonwilds-umbrel:0.1.0`.
3. Fijar su digest con `scripts/pin-image.sh`.
4. Ejecutar el linter con `--check-images` sobre la imagen publicada.
5. Probar en un Umbrel x86_64 real: instalación, primer download, navegador,
   reinicio, persistencia, handshake WireGuard y conexión PS5/PC.

No se ejecutó la descarga del servidor (~20 GB), una instalación umbrelOS real ni
un handshake con un VPS. El navegador remoto de validación no permite abrir
servicios locales; por eso el layout no se presenta como QA visual automatizado.
