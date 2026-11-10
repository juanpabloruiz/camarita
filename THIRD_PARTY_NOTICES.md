# Avisos de terceros

Camarita usa y distribuye componentes de terceros:

## go2rtc

- Proyecto: https://github.com/AlexxIT/go2rtc
- Licencia: MIT
- Uso: se utiliza la imagen oficial `alexxit/go2rtc`, que incluye el binario
  go2rtc, FFmpeg y Python. Camarita solo añade la configuración generada y la
  interfaz web.

## video-rtc.js

- Proyecto: https://github.com/AlexxIT/go2rtc
  Archivo base usado: `internal/www/video-rtc.js` en el repositorio de go2rtc.
- Licencia: MIT (forma parte de go2rtc)
- Uso: reproductor WebRTC/MSE/HLS del navegador, copiado sin modificaciones en
  `src/js/video-rtc.js`. La clase `CamaritaPlayer` de `src/js/player.js` lo extiende
  para añadir gestión de visibilidad, cambio de stream y eventos de estado.

## Bootstrap 5.3.3

- Proyecto: https://getbootstrap.com — https://github.com/twbs/bootstrap
- Archivos: `src/css/bootstrap.min.css` y `src/js/bootstrap.bundle.min.js`
- Licencia: MIT — Copyright (c) 2011-2024 The Bootstrap Authors
- Uso: base de la interfaz principal (modo oscuro). Componentes usados: grid,
  botones y grupos de botones, badges, alertas, modal de ajustes y toasts.
  `src/css/app.css` personaliza el tema sobre las variables CSS de Bootstrap.
  La página `embed.html` no usa Bootstrap.

## Fuentes

La interfaz usa la pila de fuentes del sistema (Inter, San Francisco, Segoe UI,
Roboto, etc.). No se cargan fuentes ni recursos desde CDNs externos.
