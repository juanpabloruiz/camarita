# syntax=docker/dockerfile:1

# Versión de go2rtc fijada para que la imagen sea reproducible.
ARG GO2RTC_VERSION=1.9.15
FROM alexxit/go2rtc:${GO2RTC_VERSION}

LABEL org.opencontainers.image.title="Camarita" \
      org.opencontainers.image.description="Visor local de cámaras IP con go2rtc, sin transcodificación" \
      org.opencontainers.image.licenses="MIT"

ENV PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1

WORKDIR /app

# Interfaz web propia (go2rtc la sirve con api.static_dir) y generador de config.
COPY entrypoint.py /app/entrypoint.py
COPY src/ /app/src/

# probe.bin se usa para estimar el ancho de banda real hasta el navegador.
RUN chmod 0755 /app/entrypoint.py \
    && dd if=/dev/urandom of=/app/src/probe.bin bs=1024 count=1024 2>/dev/null

EXPOSE 1984 8555/tcp 8555/udp

# Desde localhost la API de go2rtc no pide auth (local_auth=false), así que
# este healthcheck funciona también cuando CAMARITA_USER/CAMARITA_PASS están definidos.
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
    CMD wget -q -O /dev/null http://127.0.0.1:1984/api || exit 1

# La imagen base ya usa tini como entrypoint. El generador escribe la config y
# hace exec de go2rtc para que tini siga siendo el PID 1.
ENTRYPOINT ["/sbin/tini", "--"]
CMD ["/usr/local/bin/python3", "/app/entrypoint.py"]
