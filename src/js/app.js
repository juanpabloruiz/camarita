import './player.js?v=1.1.1';

const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];

const QUALITY_KEY = 'camarita.quality';
const PROBE_BYTES_HINT = 1024 * 1024;
const PROBE_TIMEOUT_MS = 7000;
const UPGRADE_COOLDOWN_MS = 45000;
const FORCED_SD_MS = 90000;

const state = {
    config: null,
    tiles: new Map(),
    visible: new Set(),
    mode: 'auto',
    bandwidthMbps: null,
    bandwidthPartial: false,
    bandwidthSource: 'none',
    probing: false,
    probeCount: 0,
    probeHistory: [],
    lastProbeAt: 0,
    lastDowngradeAt: 0,
    forcedSdUntil: new Map(),
    io: null,
};

document.addEventListener('DOMContentLoaded', init);

async function init() {
    bindGlobalUI();
    updateQualityButtons();

    try {
        const response = await fetch('cameras.json', { cache: 'no-store' });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        state.config = await response.json();
    } catch (error) {
        showFatal(`No se pudo cargar cameras.json: ${error.message}`);
        return;
    }

    const stored = readStoredMode();
    const validModes = ['auto', 'hd', 'sd'];
    state.mode = validModes.includes(stored)
        ? stored
        : validModes.includes(state.config.defaultQuality)
            ? state.config.defaultQuality
            : 'auto';

    applyConfigToUI();
    renderCameras();
    setupVisibility();
    updateQualityButtons();
    refreshNotice();
    updateUI();

    if (state.config.cameras.length === 0) {
        $('#empty-state').hidden = false;
        $('#grid').hidden = true;
        $('#footer-summary').textContent = '0 cámaras';
        return;
    }

    setTimeout(() => measureBandwidth(), 1100);
    window.setInterval(() => {
        if (document.visibilityState === 'visible') measureBandwidth();
    }, 60000);

    document.addEventListener('visibilitychange', onVisibilityChange);
    window.addEventListener('online', onOnline);
    window.addEventListener('offline', onOffline);
}

function bindGlobalUI() {
    $('#quality-control').addEventListener('click', (event) => {
        const button = event.target.closest('[data-quality]');
        if (!button) return;
        setMode(button.dataset.quality);
    });

    $('#reconnect-all').addEventListener('click', () => {
        let reconnected = 0;
        for (const tile of state.tiles.values()) {
            if (state.visible.has(tile.cam.id)) {
                tile.player.reconnect();
                reconnected += 1;
            }
        }
        toast(reconnected ? `Reconectando ${reconnected} cámara(s)…` : 'No hay cámaras visibles.');
    });

    $('#open-settings').addEventListener('click', () => {
        updateSettings();
        // El modal es el componente modal de Bootstrap (bootstrap.bundle.min.js).
        window.bootstrap?.Modal.getOrCreateInstance($('#settings-dialog')).show();
    });

    $('#measure-now').addEventListener('click', () => measureBandwidth(true));
}

function readStoredMode() {
    try {
        return localStorage.getItem(QUALITY_KEY);
    } catch {
        return null;
    }
}

function storeMode(mode) {
    try {
        localStorage.setItem(QUALITY_KEY, mode);
    } catch {
        // localStorage puede estar deshabilitado; no pasa nada.
    }
}

function applyConfigToUI() {
    const config = state.config;
    document.title = config.title || 'Camarita';
    $('#app-title').textContent = config.title || 'Camarita';
    $('#app-subtitle').textContent = config.subtitle || 'Cámaras IP en directo · sin conversión';

    $('#settings-player').textContent = (config.playerMode || '—').replaceAll(',', ' · ');
    $('#settings-auth').textContent = config.hasAuth ? 'Activada' : 'Desactivada';
    $('#settings-auth').className = config.hasAuth ? 'text-success' : 'text-warning';
    $('#settings-generated').textContent = config.generatedAt
        ? `Config generada: ${new Date(config.generatedAt).toLocaleString('es-ES')}`
        : '';

    const footerProtocol = $('#footer-protocol');
    if (footerProtocol && config.playerMode) {
        footerProtocol.textContent = config.playerMode.replaceAll(',', ' · ');
    }

    updateUI();
}

function renderCameras() {
    const grid = $('#grid');
    const template = $('#tile-template');
    const config = state.config;

    for (const cam of config.cameras) {
        const fragment = template.content.cloneNode(true);
        const tile = fragment.querySelector('.tile');
        tile.dataset.camId = cam.id;
        tile.dataset.status = 'idle';

        tile.querySelector('.tile-title').textContent = cam.name;
        tile.querySelector('.meta-brand').textContent = cam.brand || 'IP';
        tile.querySelector('.meta-tech').textContent = '—';
        tile.querySelector('.meta-resolution').textContent = '—';

        const player = document.createElement('camarita-player');
        player.configure({
            mode: config.playerMode,
            iceServers: config.clientIceServers || [],
        });

        const shell = tile.querySelector('.video-shell');
        shell.insertBefore(player, shell.firstChild);

        const initialQuality = initialQualityFor(cam);
        const record = {
            cam,
            tile,
            player,
            quality: initialQuality,
            desiredStream: streamFor(cam, initialQuality),
            tech: '—',
            resolution: '—',
            status: 'idle',
        };

        updateQualityBadge(record);
        player.addEventListener('camarita', (event) => onPlayerEvent(record, event.detail));
        wireTile(record);
        grid.append(fragment);
        state.tiles.set(cam.id, record);
        updateMuteButton(record);
    }

    if (config.cameras.length === 0) {
        $('#empty-state').hidden = false;
        $('#grid').hidden = true;
    } else {
        $('#empty-state').hidden = true;
        $('#grid').hidden = false;
    }
}

function initialQualityFor(cam) {
    if (state.mode === 'hd') return 'hd';
    if (state.mode === 'sd') return cam.sub ? 'sd' : 'hd';
    return cam.sub ? 'sd' : 'hd';
}

function streamFor(cam, quality) {
    if (quality === 'sd' && cam.sub) return cam.sub;
    return cam.main;
}

function wireTile(record) {
    const { tile, player } = record;

    tile.addEventListener('dblclick', () => toggleFullscreen(record));

    for (const button of $$('[data-action]', tile)) {
        button.addEventListener('click', (event) => {
            event.stopPropagation();
            const action = button.dataset.action;
            if (action === 'mute') toggleMute(record);
            else if (action === 'reconnect') reconnectTile(record);
            else if (action === 'fullscreen') toggleFullscreen(record);
            else if (action === 'retry') reconnectTile(record);
        });
    }

    player.addEventListener('dblclick', (event) => {
        event.preventDefault();
        toggleFullscreen(record);
    });
}

function setupVisibility() {
    state.io = new IntersectionObserver((entries) => {
        for (const entry of entries) {
            const id = entry.target.dataset.camId;
            if (entry.isIntersecting) state.visible.add(id);
            else state.visible.delete(id);
        }
        syncPlayers();
        applyQuality({ reason: 'visibility' });
        updateUI();
    }, {
        rootMargin: '120px 0px',
        threshold: 0.01,
    });

    for (const record of state.tiles.values()) {
        state.io.observe(record.tile);
    }
}

function syncPlayers() {
    const pageVisible = document.visibilityState === 'visible';
    for (const record of state.tiles.values()) {
        const visible = pageVisible && state.visible.has(record.cam.id);
        if (visible) {
            record.player.start(record.desiredStream);
        } else {
            if (record.status === 'idle') setStatus(record, 'paused', 'EN PAUSA');
            record.player.stop();
        }
    }
}

function onVisibilityChange() {
    if (document.visibilityState === 'visible') {
        syncPlayers();
        setTimeout(() => measureBandwidth(), 600);
    } else {
        for (const record of state.tiles.values()) record.player.stop();
    }
}

function onOnline() {
    refreshNotice();
    toast('Conexión de red restaurada.', 'info');
    syncPlayers();
    measureBandwidth();
}

function onOffline() {
    refreshNotice();
    toast('Sin conexión de red.', 'error');
}

function setMode(mode) {
    if (!['auto', 'hd', 'sd'].includes(mode)) return;
    state.mode = mode;
    storeMode(mode);
    updateQualityButtons();
    applyQuality({ force: true, reason: 'mode' });
    updateUI();
    toast(`Calidad: ${modeLabel(mode)}`);
}

function modeLabel(mode) {
    if (mode === 'hd') return 'HD (stream principal)';
    if (mode === 'sd') return 'SD (substream)';
    return 'Automática';
}

function updateQualityButtons() {
    for (const button of $$('#quality-control [data-quality]')) {
        button.classList.toggle('active', button.dataset.quality === state.mode);
    }
}

function setTileQuality(record, quality) {
    if (record.quality === quality) return;
    record.quality = quality;
    record.desiredStream = streamFor(record.cam, quality);
    updateQualityBadge(record);

    if (state.visible.has(record.cam.id) && document.visibilityState === 'visible') {
        record.player.start(record.desiredStream);
    }
}

function updateQualityBadge(record) {
    const badge = record.tile.querySelector('.quality-badge');
    badge.textContent = record.quality === 'sd' ? 'SD' : 'HD';
    badge.dataset.quality = record.quality;
    badge.title = record.quality === 'sd'
        ? 'Substream: menor bitrate'
        : 'Stream principal: mayor calidad';
}

function computeTargets() {
    const targets = new Map();
    const all = [...state.tiles.values()];

    if (all.length === 0) return targets;

    if (state.mode === 'hd' || state.mode === 'sd') {
        for (const record of all) {
            targets.set(record.cam.id, record.cam.sub ? state.mode : 'hd');
        }
        return targets;
    }

    const visible = all.filter((record) => state.visible.has(record.cam.id));
    if (visible.length === 0) return targets;

    const bandwidth = state.bandwidthMbps;
    if (!bandwidth || bandwidth <= 0) {
        for (const record of visible) {
            targets.set(record.cam.id, record.cam.sub ? 'sd' : 'hd');
        }
        return targets;
    }

    const safety = Number(state.config.bandwidthSafety) || 0.7;
    const available = bandwidth * safety;
    const base = visible.reduce((sum, record) => {
        return sum + (record.cam.sub ? record.cam.subMbps : record.cam.mainMbps);
    }, 0);

    if (base >= available) {
        for (const record of visible) {
            targets.set(record.cam.id, record.cam.sub ? 'sd' : 'hd');
        }
        return targets;
    }

    let remaining = available - base;
    const sorted = [...visible].sort((a, b) => {
        const priorityDiff = (b.cam.priority || 0) - (a.cam.priority || 0);
        if (priorityDiff !== 0) return priorityDiff;
        return a.cam.mainMbps - b.cam.mainMbps;
    });

    for (const record of sorted) {
        if (!record.cam.sub) {
            targets.set(record.cam.id, 'hd');
            continue;
        }
        const extra = Math.max(0.05, record.cam.mainMbps - record.cam.subMbps);
        if (remaining >= extra) {
            targets.set(record.cam.id, 'hd');
            remaining -= extra;
        } else {
            targets.set(record.cam.id, 'sd');
        }
    }

    return targets;
}

function applyQuality({ force = false, reason = 'auto' } = {}) {
    if (!state.config) return;

    const now = Date.now();
    const targets = computeTargets();

    if (state.mode === 'auto') {
        for (const [id, until] of state.forcedSdUntil) {
            if (until <= now) {
                state.forcedSdUntil.delete(id);
            } else {
                const record = state.tiles.get(id);
                if (record) targets.set(id, 'sd');
            }
        }

        if (!force && now - state.lastDowngradeAt < UPGRADE_COOLDOWN_MS) {
            for (const record of state.tiles.values()) {
                if (targets.get(record.cam.id) === 'hd' && record.quality === 'sd') {
                    targets.set(record.cam.id, 'sd');
                }
            }
        }
    }

    for (const record of state.tiles.values()) {
        const target = targets.get(record.cam.id);
        if (!target || target === record.quality) continue;
        if (target === 'sd' && record.quality === 'hd') {
            state.lastDowngradeAt = now;
        }
        setTileQuality(record, target);
    }

    updateUI();
}

async function measureBandwidth(manual = false) {
    if (state.probing) {
        if (manual) toast('Ya se está midiendo el ancho de banda…');
        return;
    }
    if (!navigator.onLine) {
        if (manual) toast('El navegador está sin conexión.', 'error');
        return;
    }

    state.probing = true;
    updateNetPill();

    const controller = new AbortController();
    const timer = window.setTimeout(() => controller.abort(), PROBE_TIMEOUT_MS);
    const started = performance.now();
    let bytes = 0;

    try {
        const response = await fetch(`probe.bin?t=${Date.now()}`, {
            cache: 'no-store',
            signal: controller.signal,
        });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);

        if (response.body && response.body.getReader) {
            const reader = response.body.getReader();
            while (true) {
                const { done, value } = await reader.read();
                if (done) break;
                bytes += value.byteLength;
            }
        } else {
            bytes = (await response.arrayBuffer()).byteLength;
        }

        finishProbe(bytes, (performance.now() - started) / 1000, manual, false);
    } catch (error) {
        const seconds = (performance.now() - started) / 1000;
        if (bytes > 64 * 1024 && seconds > 0.1) {
            finishProbe(bytes, seconds, manual, true);
        } else {
            if (state.bandwidthMbps == null) {
                state.bandwidthSource = 'unknown';
                state.bandwidthPartial = false;
                applyQuality({ reason: 'probe-failed' });
            }
            if (manual) {
                toast('No se pudo medir el ancho de banda. Se mantiene la calidad segura.', 'warning');
            }
        }
    } finally {
        window.clearTimeout(timer);
        state.probing = false;
        updateNetPill();
        updateSettings();
    }
}

function finishProbe(bytes, seconds, manual, partial) {
    const mbps = Math.max(0.05, (bytes * 8) / Math.max(seconds, 0.2) / 1_000_000);
    state.bandwidthMbps = mbps;
    state.bandwidthPartial = partial;
    state.bandwidthSource = partial ? 'probe-partial' : 'probe';
    state.probeCount += 1;
    state.lastProbeAt = Date.now();
    state.probeHistory.push(mbps);
    if (state.probeHistory.length > 6) state.probeHistory.shift();

    applyQuality({ force: state.probeCount <= 1, reason: 'probe' });
    updateNetPill();
    updateSettings();

    if (manual) {
        const suffix = partial ? ' (parcial, límite de tiempo)' : '';
        toast(`Ancho de banda estimado: ${formatMbps(mbps)}${suffix}`);
    }
}

function updateNetPill() {
    const pill = $('#net-pill');
    const text = $('#net-text');
    if (!pill || !text) return;

    pill.classList.remove('is-measuring', 'is-good', 'is-low', 'is-unknown');

    if (state.probing) {
        pill.classList.add('is-measuring');
        text.textContent = 'Midiendo…';
        return;
    }

    if (state.bandwidthMbps == null) {
        pill.classList.add('is-unknown');
        text.textContent = 'BW desconocido';
        return;
    }

    const required = minimumRequiredForVisible();
    const isLow = required > 0 && state.bandwidthMbps < required;
    pill.classList.add(isLow ? 'is-low' : 'is-good');
    text.textContent = `${state.bandwidthPartial ? '≥ ' : ''}${formatMbps(state.bandwidthMbps)}`;
    pill.title = isLow
        ? 'El ancho de banda medido es inferior a la suma de los substreams visibles.'
        : 'Ancho de banda estimado hasta el navegador';
}

function minimumRequiredForVisible() {
    if (!state.config) return 0;
    const visible = [...state.tiles.values()].filter((record) => state.visible.has(record.cam.id));
    const list = visible.length ? visible : [...state.tiles.values()];
    return list.reduce((sum, record) => {
        return sum + (record.cam.sub ? record.cam.subMbps : record.cam.mainMbps);
    }, 0);
}

function formatMbps(value) {
    if (!Number.isFinite(value)) return '—';
    if (value < 1) return `${value.toFixed(2)} Mbps`;
    return `${value.toFixed(1)} Mbps`;
}

function onPlayerEvent(record, detail) {
    switch (detail.type) {
        case 'connecting':
            record.tech = '—';
            record.resolution = '—';
            updateMeta(record);
            setStatus(record, 'connecting', 'CONECTANDO');
            break;

        case 'tech':
            record.tech = detail.tech || '—';
            updateMeta(record);
            updateSettings();
            break;

        case 'resolution':
            record.resolution = formatResolution(detail.width, detail.height);
            updateMeta(record);
            break;

        case 'playing':
            if (detail.width && detail.height) {
                record.resolution = formatResolution(detail.width, detail.height);
            }
            updateMeta(record);
            setStatus(record, 'live', 'EN VIVO');
            hideError(record);
            updateSettings();
            break;

        case 'buffering':
            if (record.status === 'idle') setStatus(record, 'connecting', 'CONECTANDO');
            break;

        case 'stall':
            handleStall(record);
            break;

        case 'novideo':
            handleNoVideo(record);
            break;

        case 'streamerror':
            handleStreamError(record, detail.message);
            break;

        case 'videoerror':
            handleStreamError(record, detail.message);
            break;

        case 'unsupported':
            showPlayerError(record, detail.message || 'Tecnología de vídeo no soportada.');
            break;

        case 'closed':
            if (record.status !== 'error') setStatus(record, 'connecting', 'RECONECTANDO');
            break;

        case 'stopped':
            if (record.status !== 'error') setStatus(record, 'paused', 'EN PAUSA');
            break;

        default:
            break;
    }
}

function updateMeta(record) {
    record.tile.querySelector('.meta-tech').textContent = record.tech || '—';
    record.tile.querySelector('.meta-resolution').textContent = record.resolution || '—';
}

function formatResolution(width, height) {
    if (!width || !height) return '—';
    return `${width}×${height}`;
}

function setStatus(record, status, label) {
    record.status = status;
    record.tile.dataset.status = status;
    const labelElement = record.tile.querySelector('.state-label');
    if (labelElement && label) labelElement.textContent = label;
    if (status !== 'error') hideError(record);
    updateUI();
}

function showPlayerError(record, message) {
    record.status = 'error';
    record.tile.dataset.status = 'error';
    record.tile.querySelector('.state-label').textContent = 'ERROR';
    const overlay = record.tile.querySelector('.error-overlay');
    overlay.hidden = false;
    overlay.querySelector('.error-message').textContent = message || 'Error desconocido.';

    if (state.mode === 'auto' && record.quality === 'hd' && record.cam.sub) {
        forceSd(record, `${record.cam.name}: error en HD, cambiando a substream.`);
    }
    updateUI();
}

function hideError(record) {
    const overlay = record.tile.querySelector('.error-overlay');
    if (overlay) overlay.hidden = true;
}

function handleStall(record) {
    if (state.mode === 'auto' && record.quality === 'hd' && record.cam.sub) {
        forceSd(record, `${record.cam.name}: cortes en HD, cambiando a SD.`);
        return;
    }
    toast(`${record.cam.name}: sin avance de vídeo, reconectando…`, 'warning');
    reconnectTile(record);
}

function handleNoVideo(record) {
    if (record.noVideoWarned) return;
    record.noVideoWarned = true;
    toast(
        `${record.cam.name}: la conexión es correcta pero el navegador no puede ` +
        'decodificar la imagen. Suelen ser streams H.265/HEVC: cambia la cámara a ' +
        'H.264 en su app web o plugin. Detalles en el README.',
        'warning',
    );
}

function handleStreamError(record, message) {
    const text = String(message || 'Error desconocido');
    if (/stream not found/i.test(text)) {
        showPlayerError(
            record,
            'go2rtc no encuentra este stream. Revisa la URL de la cámara en .env y reinicia el contenedor.',
        );
    } else {
        showPlayerError(record, text);
    }
}

function forceSd(record, message) {
    state.forcedSdUntil.set(record.cam.id, Date.now() + FORCED_SD_MS);
    state.lastDowngradeAt = Date.now();
    setTileQuality(record, 'sd');
    toast(message, 'warning');
    applyQuality({ reason: 'stall' });
}

function reconnectTile(record) {
    record.player.reconnect();
    setStatus(record, 'connecting', 'RECONECTANDO');
    hideError(record);
    updateUI();
}

function toggleMute(record) {
    const video = record.player.video;
    if (!video) return;

    const willUnmute = video.muted;
    if (willUnmute) {
        for (const other of state.tiles.values()) {
            if (other !== record && other.player.video) {
                other.player.video.muted = true;
                updateMuteButton(other);
            }
        }
    }

    video.muted = !willUnmute;
    if (!video.muted) record.player.play();
    updateMuteButton(record);
}

function updateMuteButton(record) {
    const button = record.tile.querySelector('[data-action="mute"]');
    const video = record.player.video;
    if (!button || !video) return;
    button.dataset.muted = String(video.muted);
    button.title = video.muted ? 'Activar sonido' : 'Silenciar';
    button.setAttribute('aria-label', button.title);
}

function toggleFullscreen(record) {
    if (document.fullscreenElement === record.tile) {
        document.exitFullscreen().catch(() => {});
        return;
    }
    record.tile.requestFullscreen().catch(() => {
        toast('El navegador no permitió entrar en pantalla completa.', 'warning');
    });
}

function updateUI() {
    updateNetPill();
    updateQualitySummary();
    updateSettings();
}

function updateQualitySummary() {
    if (!state.config) return;

    const total = state.tiles.size;
    const visible = [...state.tiles.values()].filter((record) => state.visible.has(record.cam.id));
    const live = [...state.tiles.values()].filter((record) => record.status === 'live').length;
    const hd = visible.filter((record) => record.quality === 'hd').length;

    const mode = state.mode === 'auto' ? 'auto' : state.mode.toUpperCase();
    $('#footer-summary').textContent = total
        ? `${total} cámara${total === 1 ? '' : 's'} · ${live} en vivo · ${hd}/${visible.length || 0} HD · ${mode}`
        : '0 cámaras';

    $('#settings-quality').textContent = state.mode === 'auto'
        ? `Automática (${hd}/${visible.length || 0} HD visibles)`
        : modeLabel(state.mode);
    $('#settings-cameras').textContent = `${total} configurada${total === 1 ? '' : 's'} · ${live} en vivo`;

    const bw = state.bandwidthMbps == null
        ? 'Desconocido'
        : `${formatMbps(state.bandwidthMbps)}${state.bandwidthPartial ? ' (parcial)' : ''}`;
    $('#settings-bandwidth').textContent = bw;
}

function updateSettings() {
    if (!state.config) return;
    updateQualitySummary();
    $('#settings-player').textContent = (state.config.playerMode || '—').replaceAll(',', ' · ');
    $('#settings-auth').textContent = state.config.hasAuth ? 'Activada' : 'Desactivada';
    $('#settings-auth').className = state.config.hasAuth ? 'text-success' : 'text-warning';
}

function refreshNotice() {
    const messages = [];
    let kind = 'alert-info';

    if (state.config && !state.config.hasAuth) {
        messages.push('La interfaz no tiene autenticación. Define CAMARITA_USER y CAMARITA_PASS en .env.');
        kind = 'alert-warning';
    }
    if (!navigator.onLine) {
        messages.push('El navegador está sin conexión de red.');
        kind = 'alert-danger';
    }

    const notice = $('#notice');
    if (messages.length === 0) {
        notice.hidden = true;
        notice.textContent = '';
        return;
    }

    notice.hidden = false;
    notice.className = `alert ${kind} border-0`;
    notice.textContent = messages.join(' · ');
}

function showFatal(message) {
    const notice = $('#notice');
    notice.hidden = false;
    notice.className = 'alert alert-danger border-0';
    notice.textContent = message;
    $('#grid').hidden = true;
    $('#empty-state').hidden = true;
    $('#footer-summary').textContent = 'Error de configuración';
    console.error('[camarita]', message);
}

function toast(message, kind = 'info') {
    const container = $('#toasts');
    if (!container) return;

    while (container.children.length >= 4) {
        container.firstElementChild.remove();
    }

    const element = document.createElement('div');
    element.className = `toast camarita-toast kind-${kind}`;
    element.setAttribute('data-bs-autohide', 'true');
    element.setAttribute('data-bs-delay', '4600');
    element.setAttribute('role', 'status');

    const row = document.createElement('div');
    row.className = 'd-flex align-items-start gap-2 w-100';

    const dot = document.createElement('span');
    dot.className = 'toast-dot';

    const body = document.createElement('div');
    body.className = 'toast-body';
    body.textContent = message;

    const close = document.createElement('button');
    close.type = 'button';
    close.className = 'btn-close me-1 m-auto flex-shrink-0';
    close.setAttribute('data-bs-dismiss', 'toast');
    close.setAttribute('aria-label', 'Cerrar');

    row.append(dot, body, close);
    element.append(row);
    container.append(element);

    if (window.bootstrap?.Toast) {
        window.bootstrap.Toast.getOrCreateInstance(element).show();
    } else {
        // Por si el bundle no estuviera cargado: mostrar y ocultar a mano.
        element.classList.add('show');
        window.setTimeout(() => element.remove(), 4600);
    }
}
