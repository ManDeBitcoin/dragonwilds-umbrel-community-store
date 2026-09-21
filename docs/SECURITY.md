# Modelo de seguridad

## Límites de privilegio

WireGuard necesita `NET_ADMIN`, `SYS_MODULE`, `/dev/net/tun` y lectura de
`/lib/modules`. La app los usa dentro de su namespace de contenedor. No monta el
socket Docker, el filesystem raíz de Umbrel ni directorios de otras apps.

## Autenticación

Umbrel protege el acceso mediante `app_proxy`. Además, la API mantiene una sesión
propia con cookie `HttpOnly`, `SameSite=Strict`, firma HMAC y caducidad de 12 horas.
En Umbrel, la contraseña proviene de `APP_PASSWORD`; fuera de Umbrel, el primer
arranque obliga a crear una contraseña local de al menos 12 caracteres.

El login aplica un límite básico de intentos por IP. Las mutaciones comprueban el
origen del navegador y la aplicación sirve una política CSP restrictiva.

## Secretos

- `settings.json` y `wg-vps.conf` se escriben con modo `0600`.
- La API nunca devuelve las contraseñas ni claves privadas guardadas.
- Los valores secretos conocidos se reemplazan por `[SECRETO]` en el buffer de
  registros del panel.
- Los backups contienen datos del mundo y pueden incluir configuración sensible;
  deben tratarse como privados.

## Restauraciones e importaciones

Antes de restaurar o importar un mundo se detiene el servidor y se crea un backup
de retorno. Los archivos tar se validan para rechazar rutas absolutas o `..` antes
de extraerse. Los nombres de archivos subidos se normalizan y sólo se aceptan
extensiones `.sav`.

## Recomendaciones de operación

- usa un peer WireGuard exclusivo para Umbrel;
- no publiques el panel web directamente en Internet;
- rota claves si alguna apareció en logs o soporte;
- limita el firewall del VPS a `51820/UDP`, `23409/UDP` y `24520/UDP`;
- revisa el digest de la imagen después de cada release y no despliegues etiquetas
  móviles sin digest en producción.
