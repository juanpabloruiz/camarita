import { VideoRTC } from './video-rtc.js?v=1.1.1';

const MEDIA_ERRORS = {
    1: 'MEDIA_ERR_ABORTED',
    2: 'MEDIA_ERR_NETWORK',
    3: 'MEDIA_ERR_DECODE',
    4: 'MEDIA_ERR_SRC_NOT_SUPPORTED',
};

/**
 * Reproductor de Camarita.
 *
 * Extiende el player oficial de go2rtc (video-rtc.js) y añade:
 * - arranque/parada controlados por la UI (solo cámaras visibles),
 * - cambio de stream sin reconectar el WebSocket equivocado,
 * - eventos de estado, tecnología, resolución y cortes.
 */
export class CamaritaPlayer extends VideoRTC {
    constructor() {
        super();

        this._streamId = null;
        this._paused = true;
        this._lastTime = -1;
        this._lastProgressAt = performance.now();
        this._stallSent = false;
        this._monitorTID = 0;

        // La UI decide cuándo arrancar/parar; no queremos que VideoRTC lo haga.
        this.background = false;
        this.visibilityCheck = false;
        this.visibilityThreshold = 0;

        // Por defecto no usamos STUN externo: en LAN los candidatos host bastan.
        this.pcConfig = {
            ...this.pcConfig,
            iceServers: [],
        };
    }

    get streamId() {
        return this._streamId;
    }

    configure({ mode, iceServers } = {}) {
        if (mode) this.mode = mode;
        if (Array.isArray(iceServers)) {
            this.pcConfig = { ...this.pcConfig, iceServers };
        }
    }

    emit(type, detail = {}) {
        this.dispatchEvent(new CustomEvent('camarita', {
            detail: { type, streamId: this._streamId, ...detail },
        }));
    }

    oninit() {
        super.oninit();

        this.video.controls = false;
        this.video.muted = true;
        this.video.setAttribute('playsinline', '');
        this.video.disablePictureInPicture = true;

        this.video.addEventListener('loadedmetadata', () => {
            this.emit('resolution', {
                width: this.video.videoWidth,
                height: this.video.videoHeight,
            });
        });

        this.video.addEventListener('playing', () => {
            this._stallSent = false;
            this._lastTime = -1;
            this._lastProgressAt = performance.now();
            this.emit('playing', {
                width: this.video.videoWidth,
                height: this.video.videoHeight,
            });
        });

        this.video.addEventListener('waiting', () => {
            this.emit('buffering');
        });

        this.video.addEventListener('error', () => {
            if (this._paused) return;
            const err = this.video.error;
            this.emit('videoerror', {
                message: err ? (MEDIA_ERRORS[err.code] || err.message) : 'Error de vídeo',
                code: err ? err.code : 0,
            });
        });

        this.video.addEventListener('click', () => {
            if (this.video.paused) this.play();
        });

        clearInterval(this._monitorTID);
        this._monitorTID = window.setInterval(() => this._monitor(), 2000);
    }

    _monitor() {
        const video = this.video;
        if (!video || this._paused) return;

        // Sin fuente todavía, o reproducción pausada por el navegador: no es un corte.
        if ((!video.srcObject && !video.currentSrc) || video.readyState < 2 || video.paused) {
            this._lastProgressAt = performance.now();
            return;
        }

        const current = video.currentTime;
        if (Math.abs(current - this._lastTime) < 0.001) {
            const blockedFor = performance.now() - this._lastProgressAt;
            if (blockedFor > 6500 && !this._stallSent) {
                this._stallSent = true;
                this.emit('stall', { blockedFor });
            }
        } else {
            this._lastTime = current;
            this._lastProgressAt = performance.now();
            this._stallSent = false;
        }

        // Sesión activa que avanza pero sin fotograma decodificado: típico de
        // streams H.265 en navegadores que no decodifican HEVC a pesar de
        // declarar soporte. Avisamos una vez por conexión.
        if (video.videoWidth === 0) {
            if (this._noVideoSeenAt === undefined) {
                this._noVideoSeenAt = performance.now();
            } else if (!this._noVideoSent && performance.now() - this._noVideoSeenAt > 8000) {
                this._noVideoSent = true;
                this.emit('novideo', { time: Math.round(video.currentTime) });
            }
        } else {
            this._noVideoSeenAt = undefined;
            this._noVideoSent = false;
        }
    }

    start(streamId) {
        if (!streamId) return;
        this._paused = false;

        if (this._streamId === streamId && (this.ws || this.pc)) return;

        if (this.ws || this.pc || this.reconnectTID) {
            this.stop();
        }

        this._paused = false;
        this._streamId = streamId;
        this._stallSent = false;
        this._noVideoSeenAt = undefined;
        this._noVideoSent = false;
        this._lastTime = -1;
        this._lastProgressAt = performance.now();

        this.src = new URL('api/ws?src=' + encodeURIComponent(streamId), location.href);
        this.emit('connecting');
    }

    stop() {
        const active = Boolean(this.ws || this.pc || this.reconnectTID || this.disconnectTID);
        this._paused = true;

        if (this.reconnectTID) {
            clearTimeout(this.reconnectTID);
            this.reconnectTID = 0;
        }
        if (this.disconnectTID) {
            clearTimeout(this.disconnectTID);
            this.disconnectTID = 0;
        }
        if (this.ws || this.pc) {
            this.ondisconnect();
        }
        if (active) this.emit('stopped');
    }

    /**
     * Reimplementado porque la base hace `video.src = ''` y eso dispara en
     * Chrome un error espurio MEDIA_ERR_SRC_NOT_SUPPORTED ("Empty src
     * attribute") cuyo listener cierra el WebSocket de la conexión que se
     * acaba de abrir al cambiar de stream.
     */
    ondisconnect() {
        this.wsState = WebSocket.CLOSED;
        if (this.ws) {
            this.ws.close();
            this.ws = null;
        }

        this.pcState = WebSocket.CLOSED;
        if (this.pc) {
            this.pc.getSenders().forEach(sender => {
                if (sender.track) sender.track.stop();
            });
            this.pc.close();
            this.pc = null;
        }

        // Desconectar el MediaSource sin provocar el error espurio.
        const src = this.video.src;
        if (src && src.startsWith('blob:')) URL.revokeObjectURL(src);
        if (this.video.srcObject) this.video.srcObject = null;
        this.video.removeAttribute('src');
        try {
            this.video.load();
        } catch {
            // ignorar: algunos navegadores lanzan al invocar load() en ciertos estados
        }
    }

    reconnect() {
        const streamId = this._streamId;
        if (!streamId) return;
        this.stop();
        this.start(streamId);
    }

    /**
     * Reimplementado para poder distinguir un cierre del WebSocket actual de
     * uno antiguo al cambiar de stream. Así no se pisan los reintentos.
     */
    onconnect() {
        if (this._paused || !this.isConnected || !this.wsURL || this.ws || this.pc) return false;

        this.wsState = WebSocket.CONNECTING;
        this.connectTS = Date.now();

        const ws = new WebSocket(this.wsURL);
        this.ws = ws;
        ws.binaryType = 'arraybuffer';

        ws.addEventListener('open', () => {
            if (this.ws === ws) this.onopen();
        });
        ws.addEventListener('close', () => {
            if (this.ws === ws) this.onclose();
        });

        return true;
    }

    onopen() {
        const modes = super.onopen();
        if (!modes) return modes;

        // El player base llama a todos los handlers de onmessage para cada
        // mensaje, así que esta clave nos sirve de "catch-all".
        this.onmessage['camarita-monitor'] = (msg) => this._onMessage(msg);

        if (modes.length === 0) {
            this.emit('unsupported', {
                message: 'El navegador no soporta MSE, HLS ni WebRTC.',
            });
        }
        return modes;
    }

    onclose() {
        if (this._paused) {
            this.ws = null;
            this.wsState = WebSocket.CLOSED;
            return false;
        }
        const result = super.onclose();
        if (result) this.emit('closed');
        return result;
    }

    _onMessage(msg) {
        switch (msg.type) {
            case 'mse':
                this.emit('tech', { tech: 'MSE', codecs: msg.value });
                break;
            case 'hls':
                this.emit('tech', { tech: 'HLS' });
                break;
            case 'mp4':
                this.emit('tech', { tech: 'MP4' });
                break;
            case 'mjpeg':
                this.emit('tech', { tech: 'MJPEG' });
                break;
            case 'error':
                this.emit('streamerror', { message: String(msg.value || 'Error del stream') });
                break;
            default:
                break;
        }
    }

    onpcvideo(video) {
        super.onpcvideo(video);
        if (this.pcState === WebSocket.OPEN) {
            this.emit('tech', { tech: 'RTC' });
        }
    }
}

customElements.define('camarita-player', CamaritaPlayer);
