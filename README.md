# Dragonwilds Umbrel Community App

MVP de una Community App Store para ejecutar y administrar un servidor dedicado
de **RuneScape: Dragonwilds** desde umbrelOS.

El proyecto usa la [imagen oficial de Jagex](https://github.com/runescape/rsdw-dedicated)
como runtime del juego y añade un panel web para:

- completar la configuración inicial sin SSH;
- arrancar, detener, reiniciar, actualizar y validar el servidor;
- crear backups coherentes con el juego detenido y restaurarlos con un punto de
  retorno automático;
- importar mundos `.sav` con dificultad, modo creativo o reglas JcJ definidas
  desde el cliente del juego;
- configurar y diagnosticar el túnel WireGuard hacia un VPS;
- generar `WG_POST_UP` y `WG_POST_DOWN` para wg-easy;
- comprobar la IP pública usada por el proceso del juego;
- consultar registros con redacción de los secretos conocidos.

## Estado del MVP

El código, panel, paquete Umbrel, Dockerfile y workflow de publicación están
incluidos. Antes de instalarlo en Umbrel hay que publicar la imagen en tu GHCR y
reemplazar los tres marcadores `YOUR_GITHUB_USER`.

La aplicación es **x86_64 solamente** porque, a fecha de esta versión, la imagen
oficial del servidor Dragonwilds publica un único manifiesto `linux/amd64`. La
interfaz y el empaquetado están preparados, pero no debe anunciarse compatibilidad
con Raspberry Pi/arm64 mientras el runtime del juego no la tenga.

## Arquitectura

```text
PS5 / PC
   │
   ▼
VPS público :23409 y :24520 UDP
   │  DNAT + MASQUERADE
   ▼
WireGuard wg-vps (10.8.0.1 ↔ 10.8.0.2)
   │
   ▼
Contenedor Dragonwilds
   ├─ panel web :8080 (protegido por Umbrel + sesión propia)
   ├─ juego :23409/UDP
   └─ baliza :24520/UDP
```

El panel y el juego viven en el mismo contenedor para que el panel pueda detener
el proceso antes de tocar `Saved` y aplicar WireGuard en el mismo namespace de
red. No se monta `/var/run/docker.sock`.

## Preparar el repositorio

1. Crea un repositorio desde este directorio.
2. Reemplaza `YOUR_GITHUB_USER` en:
   - `dragonwilds-server/docker-compose.yml`
   - `dragonwilds-server/umbrel-app.yml`
3. Publica una etiqueta, por ejemplo `v0.1.0`. El workflow crea
   `ghcr.io/<usuario>/dragonwilds-umbrel:0.1.0`.
4. Fija el digest inmutable en el paquete:

   ```bash
   ./scripts/pin-image.sh ghcr.io/<usuario>/dragonwilds-umbrel:0.1.0
   ```

5. Haz commit del `docker-compose.yml` actualizado.
6. Añade la URL del repositorio en **Umbrel → App Store → Community App Stores**.

## Primer arranque

1. Instala la app y abre el panel.
2. Usa el usuario `admin` y la contraseña que muestra Umbrel para la app.
3. Introduce el Player ID de Dragonwilds, nombre del servidor, mundo y contraseña
   de administración.
4. Elige conexión directa o VPS + WireGuard.
5. En modo WireGuard, pega un peer exclusivo para este Umbrel. No reutilices la
   misma clave en teléfonos u otros equipos.
6. Copia las reglas que muestra **Red y VPN** al contenedor wg-easy del VPS.
7. Arranca. El primer inicio descarga aproximadamente 20 GB y puede tardar.

## JcJ y dificultad

Jagex no expone esos valores como claves simples de `DedicatedServer.ini`. Las
reglas personalizadas viven en el archivo del mundo. Crea el mundo desde el juego,
selecciona allí dificultad/JcJ/modo creativo, sal del mundo y carga el `.sav` desde
la sección **Mundo**. El panel hace backup, detiene el servidor, importa y reinicia.

## Desarrollo local

```bash
cd app
npm test
npm run check
cd ..
docker compose -f docker-compose.dev.yml build
docker compose -f docker-compose.dev.yml up
```

El panel queda en `http://localhost:8080`. La contraseña del compose de desarrollo
es deliberadamente visible y debe cambiarse para cualquier entorno compartido.

## Requisitos

- Umbrel sobre `linux/amd64`.
- 1 CPU como mínimo, 4 GB de RAM como base y 20 GB libres; Jagex recomienda
  2 GB + 1 GB por jugador.
- Para WireGuard: `/dev/net/tun`, `NET_ADMIN`, `SYS_MODULE` y módulo WireGuard del
  host. Esos privilegios se limitan al contenedor.
- VPS con IPv4 pública y los puertos UDP `23409` y `24520` publicados.

Consulta [docs/VPS-WIREGUARD.md](docs/VPS-WIREGUARD.md) para el relay y
[docs/SECURITY.md](docs/SECURITY.md) para el modelo de seguridad. Las pruebas y
límites actuales están en [docs/VALIDATION.md](docs/VALIDATION.md).

## Fuentes técnicas

- [Community App Store template de Umbrel](https://github.com/getumbrel/umbrel-community-app-store)
- [Repositorio oficial de apps de Umbrel](https://github.com/getumbrel/umbrel-apps)
- [Guía oficial de servidores dedicados de Dragonwilds](https://dragonwilds.runescape.com/news/how-to-dedicated-servers)
- [Imagen oficial `runescape/rsdw-dedicated`](https://github.com/runescape/rsdw-dedicated)

## Licencias

El código de este panel está bajo MIT. RuneScape: Dragonwilds, sus binarios,
marcas y contenidos pertenecen a Jagex y conservan sus propios términos. La
imagen base oficial declara sus licencias en el repositorio de Jagex.
