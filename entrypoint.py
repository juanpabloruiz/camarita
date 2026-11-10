#!/usr/bin/env python3
"""
Camarita - genera la configuración de go2rtc y el manifiesto de la interfaz
a partir de las variables de entorno definidas en .env.

No se transcodea vídeo: go2rtc recibe el RTSP original de cada cámara y lo
reempaqueta para el navegador (MSE, WebRTC o HLS según el modo configurado).
"""

from __future__ import annotations

import json
import os
import re
import sys
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Any
from urllib.parse import quote, urlsplit, urlunsplit

CONFIG_DIR = Path("/config")
WWW_DIR = Path("/app/src")
CONFIG_PATH = CONFIG_DIR / "go2rtc.yaml"
MANIFEST_PATH = WWW_DIR / "cameras.json"


@dataclass(frozen=True)
class Brand:
    key: str
    label: str
    port: int
    main: str | None
    sub: str | None
    aliases: tuple[str, ...] = ()


BRANDS: dict[str, Brand] = {
    "hikvision": Brand(
        key="hikvision",
        label="Hikvision",
        port=554,
        main="/Streaming/Channels/101",
        sub="/Streaming/Channels/102",
        aliases=("hik", "hik-vision", "hikvision"),
    ),
    "ezviz": Brand(
        key="ezviz",
        label="Ezviz",
        port=554,
        main="/Streaming/Channels/101",
        sub="/Streaming/Channels/102",
        aliases=("ezviz", "ez-viz"),
    ),
    "yoosee": Brand(
        key="yoosee",
        label="Yoosee",
        port=554,
        main="/onvif1",
        sub="/onvif2",
        aliases=("yoosee", "yoo-see"),
    ),
    "eufy": Brand(
        key="eufy",
        label="Eufy",
        port=554,
        main="/live0",
        sub=None,
        aliases=("eufy",),
    ),
    "generic": Brand(
        key="generic",
        label="IP",
        port=554,
        main=None,
        sub=None,
        aliases=("generic", "generica", "genérica", "otra", "other"),
    ),
}


def normalize_alias(value: str) -> str:
    return re.sub(r"[^a-z0-9]", "", value.lower())


ALIASES: dict[str, str] = {}
for _key, _brand in BRANDS.items():
    ALIASES[normalize_alias(_key)] = _key
    for _alias in _brand.aliases:
        ALIASES[normalize_alias(_alias)] = _key


def env_raw(name: str) -> str | None:
    """Valor tal cual, sin strip. Devuelve None si no está definida."""
    return os.environ.get(name)


def env(name: str, *, strip: bool = True) -> str | None:
    value = os.environ.get(name)
    if value is None:
        return None
    if strip:
        value = value.strip()
    return value or None


def env_present(name: str) -> bool:
    return name in os.environ


def first(*values: str | None) -> str | None:
    for value in values:
        if value is not None and value.strip():
            return value.strip()
    return None


def warn(message: str) -> None:
    print(f"[camarita] AVISO: {message}", file=sys.stderr, flush=True)


def info(message: str) -> None:
    print(f"[camarita] {message}", flush=True)


def parse_bool(value: str | None, default: bool = False) -> bool:
    if value is None:
        return default
    return value.strip().lower() in {"1", "true", "yes", "y", "on", "si", "sí"}


def parse_float(
    name: str,
    default: float,
    *,
    minimum: float = 0.0,
    maximum: float = 10_000.0,
) -> float:
    raw = env(name)
    if raw is None:
        return default
    try:
        value = float(raw.replace(",", "."))
    except ValueError:
        warn(f"{name}={raw!r} no es un número; se usa {default}.")
        return default
    if value < minimum or value > maximum:
        warn(f"{name}={value} fuera de rango; se usa {default}.")
        return default
    return value


def resolve_brand(raw: str | None) -> Brand:
    if not raw:
        return BRANDS["generic"]
    key = ALIASES.get(normalize_alias(raw))
    if key is None:
        warn(f"Marca desconocida {raw!r}; se usa configuración genérica.")
        return BRANDS["generic"]
    return BRANDS[key]


def is_full_source(value: str) -> bool:
    """True para rtsp://, onvif://, ffmpeg:..., http://, etc."""
    return bool(re.match(r"^[a-zA-Z][a-zA-Z0-9+.-]*:", value)) and not value.startswith("/")


def is_rtsp_like(url: str) -> bool:
    return urlsplit(url).scheme.lower() in {"rtsp", "rtsps", "rtspx"}


def is_disabled(value: str | None) -> bool:
    if value is None:
        return False
    return value.strip().lower() in {"", "0", "false", "no", "off", "none", "disabled", "-"}


def split_host_port(host: str, port_raw: str | None) -> tuple[str, int | None]:
    host = host.strip()
    port: int | None = None
    if port_raw:
        try:
            port = int(port_raw)
        except ValueError:
            warn(f"Puerto {port_raw!r} no válido; se ignora.")

    if host.startswith("["):
        end = host.find("]")
        if end != -1:
            inner = host[1:end]
            rest = host[end + 1 :]
            if rest.startswith(":") and rest[1:].isdigit() and port is None:
                port = int(rest[1:])
            return inner, port

    # host:puerto (una sola vez); CAMx_PORT tiene prioridad si existe.
    if host.count(":") == 1:
        candidate_host, candidate_port = host.rsplit(":", 1)
        if candidate_port.isdigit():
            if port is None:
                port = int(candidate_port)
            return candidate_host, port

    # IPv6 sin corchetes
    return host.strip("[]"), port


def host_for_netloc(host: str) -> str:
    if ":" in host and not host.startswith("["):
        return f"[{host}]"
    return host


def build_url(
    scheme: str,
    host: str,
    port: int | None,
    username: str | None,
    password: str | None,
    path: str,
) -> str:
    auth = ""
    if username is not None or password is not None:
        auth = quote(username or "", safe="")
        if password is not None:
            auth += ":" + quote(password, safe="")
        auth += "@"

    if not path.startswith("/"):
        path = "/" + path

    netloc = auth + host_for_netloc(host)
    if port:
        netloc += f":{port}"
    return f"{scheme}://{netloc}{path}"


def set_credentials(url: str, username: str | None, password: str | None) -> str:
    """Añade usuario/contraseña si la URL no trae credenciales propias."""
    if username is None and password is None:
        return url
    parts = urlsplit(url)
    if parts.username is not None:
        return url

    auth = quote(username or "", safe="")
    if password is not None:
        auth += ":" + quote(password, safe="")
    auth += "@"

    netloc = auth + host_for_netloc(parts.hostname or "")
    if parts.port:
        netloc += f":{parts.port}"

    return urlunsplit((parts.scheme, netloc, parts.path, parts.query, parts.fragment))


def with_path(url: str, path: str) -> str:
    """Sustituye la ruta conservando esquema, host y credenciales."""
    parts = urlsplit(url)
    new_path, _, new_query = path.partition("?")
    if not new_path.startswith("/"):
        new_path = "/" + new_path
    return urlunsplit((parts.scheme, parts.netloc, new_path, new_query, ""))


def redact(url: str) -> str:
    return re.sub(r"//([^/@\s]+)@", r"//***:***@", url)


def quote_yaml(value: str) -> str:
    """Una cadena JSON es YAML válido entre comillas dobles."""
    return json.dumps(value, ensure_ascii=False)


@dataclass
class Camera:
    index: int
    name: str
    brand: Brand
    main_url: str
    sub_url: str | None
    priority: float
    main_mbps: float
    sub_mbps: float | None

    @property
    def id(self) -> str:
        return f"cam{self.index}"

    @property
    def sub_id(self) -> str:
        return f"{self.id}_sub"


def camera_has_config(index: int) -> bool:
    prefix = f"CAM{index}_"
    return any(name.startswith(prefix) for name in os.environ)


def build_camera(index: int, default_main_mbps: float, default_sub_mbps: float) -> Camera | None:
    prefix = f"CAM{index}_"

    enabled = env(prefix + "ENABLED")
    if enabled is not None and not parse_bool(enabled, True):
        return None

    raw_url = first(
        env(prefix + "URL"),
        env(prefix + "MAIN_URL"),
        env(prefix + "RTSP_URL"),
        env(prefix + "RTSP"),
    )
    main_value = first(
        env(prefix + "MAIN"),
        env(prefix + "MAIN_PATH"),
        env(prefix + "PATH"),
    )
    sub_is_defined = any(
        env_present(prefix + key) for key in ("SUB", "SUB_URL", "SUB_PATH")
    )
    sub_value = first(
        env(prefix + "SUB_URL"),
        env(prefix + "SUB"),
        env(prefix + "SUB_PATH"),
    )

    ip_value = first(
        env(prefix + "IP"),
        env(prefix + "HOST"),
        env(prefix + "HOSTNAME"),
    )
    port_raw = env(prefix + "PORT")
    username = env(prefix + "USER", strip=False)
    password = env(prefix + "PASS", strip=False)
    if password is None:
        password = env(prefix + "PASSWORD", strip=False)

    brand = resolve_brand(env(prefix + "BRAND"))
    name = env(prefix + "NAME") or f"Cámara {index}"

    base_url: str | None = None
    if raw_url and is_full_source(raw_url):
        base_url = raw_url
    elif raw_url and raw_url.startswith("/") and main_value is None:
        main_value = raw_url

    if base_url is None and ip_value:
        if is_full_source(ip_value):
            base_url = ip_value
        else:
            host, parsed_port = split_host_port(ip_value, port_raw)
            scheme = (env(prefix + "SCHEME") or "rtsp").lower()
            base_url = build_url(
                scheme,
                host,
                parsed_port or brand.port,
                username,
                password,
                "/",
            )
    elif base_url is None and main_value and is_full_source(main_value):
        base_url = main_value

    if base_url is None:
        warn(f"CAM{index}: falta CAM{index}_IP o CAM{index}_URL; se omite.")
        return None

    base_url = set_credentials(base_url, username, password)

    # --- Stream principal -------------------------------------------------
    if main_value and is_full_source(main_value):
        main_url = main_value
    elif main_value:
        main_url = with_path(base_url, main_value)
    elif raw_url and is_full_source(raw_url):
        parts = urlsplit(raw_url)
        if parts.path in ("", "/") and brand.main:
            main_url = with_path(raw_url, brand.main)
        else:
            main_url = raw_url
    elif brand.main:
        main_url = with_path(base_url, brand.main)
    else:
        parts = urlsplit(base_url)
        if parts.path not in ("", "/"):
            main_url = base_url
        else:
            warn(
                f"CAM{index}: no hay ruta de stream. Define CAM{index}_MAIN "
                f"o CAM{index}_URL."
            )
            return None

    main_url = set_credentials(main_url, username, password)

    # --- Substream (calidad baja) ----------------------------------------
    if sub_is_defined:
        if sub_value is None or is_disabled(sub_value):
            sub_url = None
        elif is_full_source(sub_value):
            sub_url = set_credentials(sub_value, username, password)
        else:
            sub_url = with_path(main_url, sub_value)
    elif brand.sub and is_rtsp_like(main_url):
        sub_url = with_path(main_url, brand.sub)
    else:
        sub_url = None

    if sub_url == main_url:
        sub_url = None

    for label, url in (("principal", main_url), ("substream", sub_url)):
        if url and ("\n" in url or "\r" in url):
            warn(f"CAM{index}: la URL {label} contiene saltos de línea; se omite.")
            return None

    main_mbps = parse_float(
        prefix + "MAIN_MBPS", default_main_mbps, minimum=0.05, maximum=1_000
    )
    sub_mbps = (
        parse_float(prefix + "SUB_MBPS", default_sub_mbps, minimum=0.05, maximum=1_000)
        if sub_url
        else None
    )
    priority = parse_float(
        prefix + "PRIORITY", 0.0, minimum=-1_000, maximum=1_000
    )

    return Camera(
        index=index,
        name=name[:80],
        brand=brand,
        main_url=main_url,
        sub_url=sub_url,
        priority=priority,
        main_mbps=main_mbps,
        sub_mbps=sub_mbps,
    )


def parse_player_mode() -> tuple[str, list[str], bool]:
    raw = env("CAMARITA_PLAYER_MODE") or "mse,hls"
    aliases = {
        "auto": "webrtc,mse,hls",
        "estable": "mse,hls",
        "stable": "mse,hls",
        "baja-latencia": "webrtc,mse",
        "low-latency": "webrtc,mse",
        "baja_latencia": "webrtc,mse",
    }
    raw = aliases.get(normalize_alias(raw), raw)
    tokens = [token.strip().lower() for token in raw.split(",") if token.strip()]
    allowed = {"webrtc", "webrtc/tcp", "mse", "hls", "mp4", "mjpeg"}
    unknown = [token for token in tokens if token not in allowed]
    if unknown:
        warn(f"Modos de player desconocidos: {', '.join(unknown)}. Se ignoran.")
    tokens = [token for token in tokens if token in allowed]
    if not tokens:
        warn("CAMARITA_PLAYER_MODE no contiene modos válidos; se usa mse,hls.")
        tokens = ["mse", "hls"]
    if "mjpeg" in tokens:
        warn(
            "El modo mjpeg puede provocar transcodificación en go2rtc. "
            "Para mantener 'sin conversión' usa mse,hls."
        )
    webrtc_enabled = any(token.startswith("webrtc") for token in tokens)
    return ",".join(tokens), tokens, webrtc_enabled


def normalize_candidate(candidate: str) -> str:
    candidate = candidate.strip()
    if not candidate:
        return candidate
    if candidate.startswith(("stun:", "turn:")):
        return candidate
    if candidate.startswith("["):
        return candidate if "]:" in candidate else candidate + ":8555"
    if candidate.count(":") > 1:
        return f"[{candidate}]:8555"
    if ":" not in candidate:
        return candidate + ":8555"
    return candidate


def load_json_env(name: str, default: Any) -> Any:
    raw = env(name)
    if raw is None:
        return default
    try:
        value = json.loads(raw)
    except json.JSONDecodeError as exc:
        warn(f"{name} no es JSON válido ({exc}); se ignora.")
        return default
    if not isinstance(value, type(default)):
        warn(f"{name} debe ser un {type(default).__name__}; se ignora.")
        return default
    return value


def build_yaml(cameras: list[Camera], *, auth_user: str | None, auth_pass: str | None,
               webrtc_enabled: bool, candidates: list[str],
               ice_servers: list[Any]) -> str:
    lines: list[str] = [
        "# Generado automáticamente por Camarita. No editar a mano.",
        "log:",
        '  level: "info"',
        "api:",
        '  listen: ":1984"',
        f"  static_dir: {quote_yaml(str(WWW_DIR))}",
    ]
    if auth_user:
        lines.append(f"  username: {quote_yaml(auth_user)}")
        lines.append(f"  password: {quote_yaml(auth_pass or '')}")

    lines.extend([
        "rtsp:",
        # Solo en localhost del contenedor: lo necesita el módulo ffmpeg
        # (p. ej. fuentes ffmpeg:virtual que inyectan por RTSP) y no es
        # accesible desde fuera porque el puerto no se publica.
        '  listen: "127.0.0.1:8554"',
        "webrtc:",
        f'  listen: {quote_yaml(":8555" if webrtc_enabled else "")}',
    ])
    if webrtc_enabled:
        lines.append(f"  ice_servers: {json.dumps(ice_servers, ensure_ascii=False)}")
        if candidates:
            lines.append("  candidates:")
            for candidate in candidates:
                lines.append(f"    - {quote_yaml(candidate)}")

    if cameras:
        lines.append("streams:")
        for camera in cameras:
            lines.append(f"  {quote_yaml(camera.id)}: {quote_yaml(camera.main_url)}")
            if camera.sub_url:
                lines.append(
                    f"  {quote_yaml(camera.sub_id)}: {quote_yaml(camera.sub_url)}"
                )
    else:
        lines.append("streams: {}")

    return "\n".join(lines) + "\n"


def write_camera_manifest(cameras: list[Camera], *, title: str, subtitle: str,
                          default_quality: str, player_mode: str,
                          client_ice_servers: list[Any], safety: float,
                          default_main_mbps: float, default_sub_mbps: float,
                          has_auth: bool, webrtc_enabled: bool) -> None:
    manifest = {
        "version": 1,
        "appVersion": env("CAMARITA_VERSION") or "1.0.0",
        "generatedAt": datetime.now(timezone.utc).isoformat(),
        "title": title,
        "subtitle": subtitle,
        "defaultQuality": default_quality,
        "playerMode": player_mode,
        "webrtcEnabled": webrtc_enabled,
        "clientIceServers": client_ice_servers,
        "bandwidthSafety": safety,
        "hasAuth": has_auth,
        "defaults": {
            "mainMbps": default_main_mbps,
            "subMbps": default_sub_mbps,
        },
        "cameras": [
            {
                "id": camera.id,
                "name": camera.name,
                "brand": camera.brand.label,
                "main": camera.id,
                "sub": camera.sub_id if camera.sub_url else None,
                "mainMbps": camera.main_mbps,
                "subMbps": camera.sub_mbps,
                "priority": camera.priority,
                "snapshot": f"api/frame.jpeg?src={camera.id}",
            }
            for camera in cameras
        ],
    }

    WWW_DIR.mkdir(parents=True, exist_ok=True)
    temp_path = MANIFEST_PATH.with_suffix(".json.tmp")
    temp_path.write_text(
        json.dumps(manifest, ensure_ascii=False, indent=2) + "\n",
        encoding="utf-8",
    )
    os.chmod(temp_path, 0o644)
    os.replace(temp_path, MANIFEST_PATH)


def main() -> None:
    info("Generando configuración de go2rtc...")

    default_main_mbps = parse_float(
        "CAMARITA_MAIN_MBPS", 4.0, minimum=0.1, maximum=1_000
    )
    default_sub_mbps = parse_float(
        "CAMARITA_SUB_MBPS", 0.6, minimum=0.05, maximum=1_000
    )
    safety = parse_float(
        "CAMARITA_BANDWIDTH_SAFETY", 0.7, minimum=0.1, maximum=1.0
    )

    try:
        max_cameras = int(env("CAMARITA_MAX_CAMERAS") or "32")
    except ValueError:
        max_cameras = 32
    max_cameras = max(1, min(max_cameras, 128))

    cameras: list[Camera] = []
    for index in range(1, max_cameras + 1):
        if not camera_has_config(index):
            continue
        try:
            camera = build_camera(index, default_main_mbps, default_sub_mbps)
        except Exception as exc:  # noqa: BLE001 - una cámara no debe tumbar el arranque
            warn(f"CAM{index}: error inesperado al leer la configuración: {exc}")
            continue
        if camera is not None:
            cameras.append(camera)

    # Orden estable: prioridad alta primero y luego el orden del .env.
    cameras.sort(key=lambda c: (c.index,))
    cameras.sort(key=lambda c: c.priority, reverse=True)

    auth_user = env("CAMARITA_USER")
    auth_pass = env_raw("CAMARITA_PASS")
    if auth_user:
        if auth_pass is None:
            warn("CAMARITA_PASS no está definida; la contraseña web será vacía.")
            auth_pass = ""
    else:
        if auth_pass:
            warn("CAMARITA_PASS está definida sin CAMARITA_USER; se ignora la contraseña.")
        auth_user = None
        auth_pass = None

    player_mode, player_tokens, webrtc_enabled = parse_player_mode()

    raw_candidates = first(
        env("CAMARITA_WEBRTC_CANDIDATES"),
        env("WEBRTC_CANDIDATES"),
        env("WEBRTC_CANDIDATE"),
    )
    candidates: list[str] = []
    if raw_candidates:
        candidates = [
            normalize_candidate(item)
            for item in re.split(r"[,;\s]+", raw_candidates)
            if item.strip()
        ]
    if webrtc_enabled and not candidates:
        warn(
            "WebRTC está activo pero CAMARITA_WEBRTC_CANDIDATES está vacío. "
            "Dentro de Docker suele ser necesario indicar la IP del host, "
            "por ejemplo: CAMARITA_WEBRTC_CANDIDATES=192.168.1.10:8555"
        )
    if not webrtc_enabled:
        candidates = []

    ice_servers = load_json_env("CAMARITA_ICE_SERVERS", [])
    if not isinstance(ice_servers, list):
        ice_servers = []
    client_ice_servers = load_json_env("CAMARITA_CLIENT_ICE_SERVERS", [])
    if not isinstance(client_ice_servers, list):
        client_ice_servers = []

    default_quality = (env("CAMARITA_DEFAULT_QUALITY") or "auto").lower()
    if default_quality not in {"auto", "hd", "sd"}:
        warn(
            f"CAMARITA_DEFAULT_QUALITY={default_quality!r} no es válido; "
            "se usa auto."
        )
        default_quality = "auto"

    title = (env("CAMARITA_TITLE") or "Camarita")[:80]
    subtitle = (env("CAMARITA_SUBTITLE") or "Cámaras IP en directo · sin conversión")[:160]

    CONFIG_DIR.mkdir(parents=True, exist_ok=True)
    config = build_yaml(
        cameras,
        auth_user=auth_user,
        auth_pass=auth_pass,
        webrtc_enabled=webrtc_enabled,
        candidates=candidates,
        ice_servers=ice_servers,
    )
    temp_config = CONFIG_PATH.with_suffix(".yaml.tmp")
    temp_config.write_text(config, encoding="utf-8")
    os.chmod(temp_config, 0o600)
    os.replace(temp_config, CONFIG_PATH)

    write_camera_manifest(
        cameras,
        title=title,
        subtitle=subtitle,
        default_quality=default_quality,
        player_mode=player_mode,
        client_ice_servers=client_ice_servers,
        safety=safety,
        default_main_mbps=default_main_mbps,
        default_sub_mbps=default_sub_mbps,
        has_auth=bool(auth_user),
        webrtc_enabled=webrtc_enabled,
    )

    streams = len(cameras) + sum(1 for camera in cameras if camera.sub_url)
    info(f"{len(cameras)} cámara(s), {streams} stream(s) configurados.")
    for camera in cameras:
        sub = f" + sub {redact(camera.sub_url)}" if camera.sub_url else " (sin substream)"
        info(f"  {camera.id} · {camera.name} [{camera.brand.label}] -> {redact(camera.main_url)}{sub}")

    if not cameras:
        warn(
            "No hay cámaras configuradas. Añade variables CAM1_* a .env "
            "y reinicia el contenedor."
        )

    if auth_user:
        info(f"Autenticación web activada (usuario: {auth_user}).")
    else:
        warn(
            "La interfaz no tiene autenticación. Define CAMARITA_USER y "
            "CAMARITA_PASS en .env si el puerto es accesible desde la red."
        )

    info(
        "Interfaz interna en el puerto 1984 del contenedor "
        f"(publicada en el puerto {env('CAMARITA_PORT') or '18080'} del host)."
    )

    try:
        os.execvp("go2rtc", ["go2rtc", "-config", str(CONFIG_PATH)])
    except FileNotFoundError:
        print("[camarita] ERROR: no se encontró el binario go2rtc.", file=sys.stderr)
        sys.exit(127)


if __name__ == "__main__":
    main()
