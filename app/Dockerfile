FROM ghcr.io/runescape/rsdw-dedicated:latest@sha256:c35701edb05619fd28bfb37856b6a323c10bc8aa6466fb57b3e1b232936294dc

USER root

RUN apt-get update \
    && apt-get install -y --no-install-recommends \
      ca-certificates \
      curl \
      iproute2 \
      iptables \
      nodejs \
      procps \
      tar \
      tini \
      util-linux \
      wireguard-tools \
    && rm -rf /var/lib/apt/lists/*

COPY package.json /opt/dragonwilds/package.json
COPY src /opt/dragonwilds/src
COPY public /opt/dragonwilds/public
COPY start.sh /opt/dragonwilds/start.sh

RUN chmod 0755 /opt/dragonwilds/start.sh

ENV WEB_PORT=8080 \
    DATA_DIR=/data/control \
    SERVER_DIR=/home/steam/rsdw-dedicated \
    BACKUP_DIR=/data/backups \
    WG_DIR=/etc/wireguard \
    GAME_PORT=23409 \
    GAME_UID=1000 \
    GAME_GID=1000

EXPOSE 8080/tcp 23409/udp 24520/udp

ENTRYPOINT ["/usr/bin/tini", "--", "/opt/dragonwilds/start.sh"]
