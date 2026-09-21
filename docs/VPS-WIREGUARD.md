# VPS, WireGuard y CGNAT

## Puertos

La versión actual del contenedor oficial usa dos puertos:

| Propósito | Puerto del MVP |
| --- | ---: |
| Juego | `23409/UDP` |
| Baliza de ajustes del mundo | `24520/UDP` (`23409 + 1111`) |
| WireGuard del VPS | `51820/UDP` |
| WireGuard local | `51831/UDP` |

El host y el contenedor deben usar el mismo puerto para juego y baliza. En el VPS,
publica ambos UDP además del puerto WireGuard.

## Peer exclusivo

Cada dispositivo debe tener su propio peer. Si Umbrel y un teléfono comparten la
misma `PrivateKey`, WireGuard moverá el endpoint entre ambos y puede causar
rubber-banding, congelamientos y mensajes `Reset SequenceHistory`.

## Reglas conceptuales del VPS

Suponiendo `wg0`, red `10.8.0.0/24`, peer Umbrel `10.8.0.2` y salida `eth0`:

```bash
iptables -t nat -A POSTROUTING -s 10.8.0.0/24 -o eth0 -j MASQUERADE
iptables -A FORWARD -i wg0 -j ACCEPT
iptables -A FORWARD -o wg0 -j ACCEPT

iptables -t nat -A PREROUTING -i eth0 -p udp --dport 23409 -j DNAT --to-destination 10.8.0.2:23409
iptables -t nat -A POSTROUTING -o wg0 -d 10.8.0.2 -p udp --dport 23409 -j MASQUERADE

iptables -t nat -A PREROUTING -i eth0 -p udp --dport 24520 -j DNAT --to-destination 10.8.0.2:24520
iptables -t nat -A POSTROUTING -o wg0 -d 10.8.0.2 -p udp --dport 24520 -j MASQUERADE
```

El panel genera las variantes completas `WG_POST_UP` y `WG_POST_DOWN` con los
datos guardados. Úsalas para reducir errores al copiar.

## Policy routing

El contenedor crea una tabla dedicada y una regla `uidrange` para que sólo el UID
del servidor/SteamCMD use `wg-vps`. El panel web continúa usando la ruta normal.
Las consultas a `1.1.1.1`, `9.9.9.9` y `8.8.8.8` se excluyen a la tabla principal,
replicando el workaround validado en el material original para DNS UDP/53.

## Diagnóstico

En **Red y VPN** comprueba:

1. túnel activo;
2. endpoint correcto;
3. handshake reciente;
4. contadores de tráfico;
5. que **Probar salida** devuelve la IPv4 del VPS.

Si el mundo aparece en el navegador pero la conexión vuelve al título, revisa
especialmente la baliza `24520/UDP`, el DNAT y que los puertos externos/internos
coincidan.
