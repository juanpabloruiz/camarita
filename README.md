# Camarita

Visor web de cámaras IP para la red local. Usa [go2rtc](https://github.com/AlexxIT/go2rtc)
para recibir el RTSP original de cada cámara y entregarlo al navegador mediante
MSE, HLS o WebRTC, **sin recodificar el vídeo**.

La interfaz está pensada para funcionar con Ezviz, Yoosee, Eufy y Hikvision,
aunque acepta cualquier fuente soportada por go2rtc (`rtsp://`, `http://`,
`onvif://`, etc.).

![Flujo](https://img.shields.io/badge/RTSP-original-%235eead4) ![Sin conversión](https://img.shields.io/badge/vídeo-sin%20recodificar-%2360a5fa)

## Qué incluye

- Un único contenedor Docker con go2rtc y la interfaz de Camarita.
- Configuración por `.env`: IP/URL, puerto, usuario, contraseña y marca de cada cámara.
- Reproducción en directo con la menor latencia posible y sin transcodificación.
- Calidad automática: alterna entre el stream principal (HD) y el substream (SD)
  de la propia cámara según el ancho de banda medido y los cortes detectados.
- Solo reproduce las cámaras visibles; al hacer scroll o cambiar de pestaña se
  pausan para no consumir ancho de banda.
- Autenticación básica opcional, pensada para una red de confianza.
- Página `embed.html` para insertar una o varias cámaras con `<iframe>`.
- Sin CDNs ni recursos externos: la interfaz es totalmente local.

## Arquitectura

```text
Navegador
  │  HTTP + WebSocket (puerto 18080 del host → 1984 del contenedor)
  │  vídeo: MSE / HLS / WebRTC
  ▼
┌──────────────────────────────────────────────┐
│ Contenedor camarita                          │
│  - go2rtc: recibe RTSP y reempaqueta         │
│  - src/: interfaz y reproductor              │
│  - entrypoint.py: genera go2rtc.yaml         │
└──────────────────────────────────────────────┘
  │  RTSP original (LAN, puerto 554 normalmente)
  ▼
Ezviz · Yoosee · Eufy · Hikvision · cualquier IP
```

go2rtc no recodifica el vídeo: cambia el contenedor/protocolo (RTSP → fMP4,
HLS o WebRTC). El vídeo sigue siendo el H.264/H.265 original de la cámara.
El audio PCMA/PCMU se puede reempaquetar automáticamente a FLAC para MSE; eso
tampoco recodifica el vídeo.

## Inicio rápido

```bash
cp .env.example .env
# edita .env con los datos de tus cámaras

docker compose up -d --build
docker compose logs -f camarita
```

Abre en el navegador:

```text
http://IP-DEL-SERVIDOR:18080
```

El puerto por defecto es `18080` (no el `8080`, que suele estar ocupado por
otros contenedores como qBittorrent) y se cambia con `CAMARITA_PORT` en `.env`.

### Cambiar cámaras o contraseñas

La configuración se genera al arrancar el contenedor. Después de editar `.env`
hay que recrear el contenedor para que reciba las variables nuevas:

```bash
docker compose up -d --force-recreate
```

No hace falta reconstruir la imagen (`--build`) salvo que cambies el código o
el `Dockerfile`.

```bash
docker compose down      # parar
docker compose logs -f   # ver logs
```

## Configuración de cámaras

Cada cámara usa un prefijo `CAM<N>_`, con `N` de 1 a 32.
Hay tres formas de indicar el origen:

### A) IP + credenciales + marca

Camarita construye la URL RTSP con la ruta típica de cada marca:

```dotenv
CAM1_NAME=Salón
CAM1_BRAND=ezviz
CAM1_IP=192.168.1.51
CAM1_PORT=554
CAM1_USER=admin
CAM1_PASS=CODIGO_DE_VERIFICACION
CAM1_MAIN=/Streaming/Channels/101
CAM1_SUB=/Streaming/Channels/102
```

### B) URL completa

```dotenv
CAM2_NAME=Patio
CAM2_BRAND=yoosee
CAM2_URL=rtsp://admin:12345678@192.168.1.52:554/onvif1
CAM2_SUB_URL=rtsp://admin:12345678@192.168.1.52:554/onvif2
```

`CAM<N>_URL` tiene prioridad sobre IP/ruta/marca. La URL puede ser cualquier
fuente soportada por go2rtc (`rtsp://`, `http://`, `onvif://`, `ffmpeg:...`).
Si la URL incluye usuario y contraseña, esos tienen prioridad sobre
`CAM<N>_USER`/`CAM<N>_PASS`.

### C) IP + ruta manual

```dotenv
CAM3_NAME=Garaje
CAM3_BRAND=hikvision
CAM3_IP=192.168.1.54
CAM3_PORT=554
CAM3_USER=admin
CAM3_PASS=TU_CLAVE
CAM3_MAIN=/Streaming/Channels/101
CAM3_SUB=/Streaming/Channels/102
```

### Variables por cámara

| Variable | Obligatoria | Descripción |
|---|---|---|
| `CAM<N>_NAME` | No | Nombre visible. Por defecto `Cámara N`. |
| `CAM<N>_BRAND` | No | `ezviz`, `yoosee`, `eufy`, `hikvision` o `generic`. |
| `CAM<N>_IP` / `HOST` | Sí, si no hay URL | IP o hostname; admite `192.168.1.5:554`. |
| `CAM<N>_PORT` | No | Puerto RTSP. Por defecto 554. |
| `CAM<N>_USER` | No | Usuario RTSP. |
| `CAM<N>_PASS` | No | Contraseña RTSP. Si contiene `#`, `$`, espacios, etc., usa comillas simples. |
| `CAM<N>_URL` | Alternativa | URL completa del stream principal. |
| `CAM<N>_MAIN` / `MAIN_PATH` | No | Ruta del stream principal. |
| `CAM<N>_SUB` / `SUB_URL` | No | Ruta/URL del substream. `CAM<N>_SUB=` vacío lo desactiva. |
| `CAM<N>_SCHEME` | No | `rtsp` por defecto; `rtsps`, `http`, etc. |
| `CAM<N>_MAIN_MBPS` | No | Bitrate estimado del principal, para la calidad automática. |
| `CAM<N>_SUB_MBPS` | No | Bitrate estimado del substream. |
| `CAM<N>_PRIORITY` | No | Prioridad para conservar HD (mayor = antes). |
| `CAM<N>_ENABLED` | No | `false` para desactivarla sin borrar su configuración. |

Si un valor contiene `#`, `$`, espacios o caracteres especiales, entrecomíllalo
con comillas simples en `.env`:

```dotenv
CAM1_PASS='mi#clave$rara'
```

## Cámaras por marca

| Marca | Puerto típico | Principal | Substream | Notas |
|---|---:|---|---|---|
| **Hikvision** | 554 | `/Streaming/Channels/101` | `/Streaming/Channels/102` | Activa RTSP en la cámara. Algunos modelos usan `/ISAPI/Streaming/channels/101`. |
| **Ezviz** | 554 | `/Streaming/Channels/101` | `/Streaming/Channels/102` | Usuario `admin`; contraseña = código de verificación. Algunos modelos usan `/h264/ch1/main/av_stream` y `/h264/ch1/sub/av_stream`. |
| **Yoosee** | 554 | `/onvif1` | `/onvif2` | Activa RTSP en la app. Algunos modelos usan `/live/ch0`. |
| **Eufy** | 554 / 8554 | `/live0` | — | La mayoría no expone RTSP directo. Usa la URL exacta de HomeBase o del add-on Eufy Security; normalmente no hay substream. |

Si la ruta por defecto no funciona, abre la URL con VLC o `ffplay` y ajusta
`CAM<N>_MAIN`/`CAM<N>_SUB`. Ejemplo:

```bash
ffplay -fflags nobuffer -flags low_delay \
  "rtsp://admin:clave@192.168.1.54:554/Streaming/Channels/101"
```

### Códecs: importante para “sin conversión”

Camarita no recodifica. Por eso:

- Configura las cámaras en **H.264** siempre que sea posible. Es el códec con
  mejor soporte en MSE y WebRTC.
- H.265/HEVC solo funciona si el navegador lo soporta (Chrome/Edge recientes,
  Safari 18+); en otros casos hay que cambiar la cámara a H.264.
  Un síntoma típico: el tile aparece «En vivo» y con conexión estable, pero la
  imagen nunca muestra resolución (enlace `—`) y Camarita avisa de que no se
  puede decodificar. Cambia entonces el códec de la cámara a H.264 en los
  ajustes de vídeo de su propia app (en Yoosee, en los ajustes del
  dispositivo, sección de codificación/`Encode Settings` de cada stream).
- Para audio, PCMA/PCMU/AAC funcionan bien; go2rtc puede reempaquetar
  PCMA/PCMU a FLAC para MSE sin tocar el vídeo.
- El modo `mjpeg` puede hacer que go2rtc use FFmpeg y recodifique. No lo uses
  si quieres mantener la condición de “sin conversión”.

## Calidad automática

La calidad automática **no es un ABR transcodificado**: no hay varias versiones
generadas por el servidor. Se elige entre dos streams nativos de la cámara:

- **HD**: stream principal de la cámara.
- **SD**: substream de la cámara (normalmente 640×360, 704×576 o similar).

Para que funcione, activa el substream en la configuración de la cámara. Si una
cámara no tiene substream, siempre usará el principal.

Cómo decide:

1. Mide el ancho de banda real descargando `probe.bin` (1 MiB) desde el propio
   contenedor al navegador.
2. Aplica un margen de seguridad (`CAMARITA_BANDWIDTH_SAFETY`, 0.7 por defecto).
3. Estima el coste de todos los substreams visibles y reparte el ancho de banda
   restante para subir a HD las cámaras que quepan, respetando `PRIORITY`.
4. Si una cámara en HD se corta (el vídeo no avanza), baja esa cámara a SD
   durante 90 segundos.
5. Vuelve a medir cada 60 segundos. Las subidas tienen histéresis para evitar
   cambios constantes.

Ajusta `CAMARITA_MAIN_MBPS` y `CAMARITA_SUB_MBPS` (o los valores por cámara) al
bitrate real. Si no los conoces, mira la configuración de la cámara o el
ancho de banda que consume en VLC. Valores orientativos:

- 1080p H.264: 2–6 Mbps.
- 4K H.264: 8–16 Mbps.
- Substream 640×360: 0.3–1 Mbps.

También puedes forzar la calidad desde la cabecera:

- **Auto**: adaptativa.
- **HD**: todos al stream principal.
- **SD**: todos al substream (si existe).

En modo manual no se baja automáticamente por cortes; se reconecta.

> La medición es una estimación del enlace navegador ↔ servidor. No mide el
> enlace cámara ↔ servidor. Los cortes reales se detectan igualmente y se
> corrigen bajando de calidad.

## WebRTC opcional (menor latencia)

Por defecto se usa `mse,hls`, que funciona bien dentro de Docker y no necesita
puertos UDP adicionales.

Para probar WebRTC:

```dotenv
CAMARITA_PLAYER_MODE=webrtc,mse,hls
CAMARITA_WEBRTC_CANDIDATES=192.168.1.10:8555
CAMARITA_WEBRTC_PORT=8555
```

`192.168.1.10` debe ser la IP LAN del host Docker (no la del contenedor).
Asegúrate de que los puertos 8555/TCP y 8555/UDP están publicados y permitidos
en el firewall. Si accedes desde fuera de la LAN, necesitarás STUN/TURN:

```dotenv
CAMARITA_ICE_SERVERS=[{"urls":["stun:stun.l.google.com:19302"]}]
CAMARITA_CLIENT_ICE_SERVERS=[{"urls":["stun:stun.l.google.com:19302"]}]
```

Para la mayoría de usos domésticos, MSE es más estable y suficiente.

## Insertar con iframe

`embed.html` está pensado para incrustar una o varias cámaras:

```html
<iframe
  src="http://192.168.1.10:18080/embed.html?src=cam1&quality=auto&muted=1&label=1"
  style="width:100%;aspect-ratio:16/9;border:0;border-radius:16px"
  allow="autoplay; fullscreen"
  allowfullscreen>
</iframe>
```

Parámetros:

| Parámetro | Valores | Descripción |
|---|---|---|
| `src` | `cam1` | ID de cámara. Se puede repetir (`src=cam1&src=cam2`) o separar por comas. Si se omite, usa la primera cámara. |
| `quality` | `auto`, `hd`, `sd` | Calidad inicial. `auto` mide el ancho de banda y adapta. |
| `fit` | `contain`, `cover` | Ajuste del vídeo. |
| `muted` | `1`, `0` | Silenciado. `0` intenta reproducir con audio; si el navegador lo bloquea, haz clic en el vídeo. |
| `label` | `1`, `0` | Mostrar u ocultar el nombre/estado. |

La página principal usa un reproductor directo (no iframe) porque permite
controlar visibilidad, reconexión, pantalla completa y calidad sin recargar
marcos. `embed.html` es la opción cómoda para incrustar en otra web.

## Seguridad

- **Cambia `CAMARITA_PASS`** en `.env`. Si `CAMARITA_USER` está vacío, la
  interfaz no pide autenticación.
- `.env` contiene las contraseñas de las cámaras. No lo subas a git
  (`.gitignore` ya lo excluye).
- `go2rtc.yaml` se genera dentro del contenedor con permisos `0600`; no se
  sirve como archivo estático.
- El frontend (`cameras.json`) no incluye usuarios ni contraseñas, solo IDs,
  nombres y bitrates.
- La autenticación básica no cifra el tráfico. No expongas el puerto a Internet
  sin HTTPS (reverse proxy) o, mejor, usa una VPN (WireGuard/Tailscale).
- Cualquier persona con acceso a la interfaz autenticada puede ver las cámaras.
  Usa una contraseña distinta a la de las cámaras.

## Solución de problemas

### No se ve ninguna cámara

1. Comprueba que el contenedor está arriba:

   ```bash
   docker compose ps
   docker compose logs --tail=100 camarita
   ```

2. Prueba la URL RTSP desde otro equipo de la LAN con VLC/ffplay.
3. Revisa usuario, contraseña, puerto y ruta. En Ezviz la contraseña suele ser
   el código de verificación, no la del usuario de la app.
4. Verifica que la cámara está en H.264.
5. Si usas una URL con caracteres especiales, entrecomíllala en `.env`.

### “stream not found”

go2rtc no ha podido abrir la fuente. Mira los logs: aparecerá el error RTSP.
Suele ser autenticación, ruta incorrecta, cámara apagada o RTSP deshabilitado.
La interfaz también muestra el mensaje en la tarjeta.

### Se ve el vídeo pero con cortes

- Activa el substream de la cámara y define `CAM<N>_SUB`.
- Baja `CAMARITA_MAIN_MBPS` o usa el modo **SD**.
- Reduce el número de cámaras visibles a la vez.
- Prueba con cable en lugar de Wi-Fi, especialmente para 4K.
- Revisa que la cámara no esté limitando conexiones simultáneas.

### El vídeo no arranca en Safari/iPhone

Safari usa HLS cuando no hay MSE. Comprueba que `CAMARITA_PLAYER_MODE` incluye
`hls`. En iOS antiguo, HLS solo funciona con H.264. Evita H.265.

### WebRTC no conecta

- Usa `CAMARITA_PLAYER_MODE=mse,hls` (recomendado en Docker).
- Si insistes en WebRTC, define `CAMARITA_WEBRTC_CANDIDATES` con la IP LAN del
  host y publica 8555/TCP y UDP.
- En redes con NAT simétrico o fuera de la LAN, añade STUN/TURN.

### Cambié `.env` y no se aplica

Hay que recrear el contenedor:

```bash
docker compose up -d --force-recreate
```

### Ver la configuración generada

```bash
docker compose exec camarita sh -c 'cat /config/go2rtc.yaml'
```

Contiene contraseñas; no compartas esa salida.

## Estructura del proyecto

```text
camarita/                     (raíz del proyecto)
├── compose.yaml
├── Dockerfile
├── entrypoint.py             # .env → go2rtc.yaml + cameras.json
├── nginx.conf                # plantilla para publicar detrás de un dominio (opcional)
├── LICENSE                   # MIT
├── THIRD_PARTY_NOTICES.md
├── .env.example
└── src/                      # todo lo que se sirve al navegador
    ├── index.html            # interfaz principal
    ├── embed.html            # vista para iframe
    ├── favicon.svg
    ├── css/
    │   ├── bootstrap.min.css  # Bootstrap 5.3.3 (MIT) — base de la interfaz
    │   └── app.css            # tema propio sobre Bootstrap
    ├── js/
    │   ├── bootstrap.bundle.min.js  # Bootstrap 5.3.3 (MIT) — modal y toasts
    │   ├── app.js            # calidad automática, visibilidad, UI
    │   ├── player.js         # extensión del player de go2rtc
    │   ├── video-rtc.js      # player oficial de go2rtc (MIT)
    │   └── embed.js
    └── img/                  # imágenes de la interfaz si hagan falta
```

La interfaz principal está construida con [Bootstrap 5.3](https://getbootstrap.com)
en modo oscuro (`data-bs-theme="dark"`): botones, badges, alertas, modal de
ajustes y toasts son componentes de Bootstrap; `css/app.css` solo añade el tema
(propio de la app), el HUD de las tarjetas de vídeo y pequeños ajustes.
`embed.html` es independiente y no carga Bootstrap, para minimizar su peso
dentro de los iframes.

El archivo `probe.bin` (1 MiB) se genera durante el build de la imagen y se usa
para medir el ancho de banda. `cameras.json` se genera al arrancar el contenedor.

## Créditos

- [go2rtc](https://github.com/AlexxIT/go2rtc) de AlexxIT, licencia MIT.
- `video-rtc.js` forma parte de go2rtc y se distribuye con la misma licencia.
- [Bootstrap 5.3.3](https://github.com/twbs/bootstrap) (`bootstrap.min.css` y
  `bootstrap.bundle.min.js`), licencia MIT, Copyright (c) 2011-2024 The
  Bootstrap Authors.
- Camarita: MIT (ver `LICENSE` en la raíz del repositorio).

Consulta `THIRD_PARTY_NOTICES.md` para más detalle.
