import './player.js?v=1.1.1';

const params = new URLSearchParams(location.search);
const requestedSources = params.getAll('src').flatMap((value) => value.split(',')).filter(Boolean);
const requestedQuality = (params.get('quality') || 'auto').toLowerCase();
const qualityMode = ['auto', 'hd', 'sd'].includes(requestedQuality) ? requestedQuality : 'auto';
const fit = params.get('fit') === 'cover' ? 'cover' : 'contain';
const startMuted = params.get('muted') !== '0';
const showLabel = params.get('label') !== '0';

const records = [];
let config = null;
let bandwidth = null;
let lastDowngradeAt = 0;
let probeRunning = false;
let probingTimer = 0;
const forcedSdUntil = new Map();

main();

async function main() {
    try {
        const response = await fetch('cameras.json', { cache: 'no-store' });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        config = await response.json();
    } catch (error) {
        showEmpty(`No se pudo cargar la configuración: ${error.message}`);
        return;
    }

    let cameras = config.cameras || [];
    if (requestedSources.length) {
        cameras = requestedSources
            .map((source) => {
                return config.cameras.find((camera) => {
                    return camera.id === source || camera.name === source || camera.sub === source;
                });
            })
            .filter(Boolean);
    } else {
        cameras = cameras.slice(0, 1);
    }

    if (cameras.length === 0) {
        showEmpty('No hay cámaras configuradas en Camarita.');
        return;
    }

    const root = document.getElementById('embed');
    document.title = config.title || 'Camarita';

    cameras.forEach((camera, index) => {
        const sourceIsSub = requestedSources[index] && requestedSources[index] === camera.sub;
        const initialQuality = initialQualityFor(camera, sourceIsSub);
        const cell = buildCell(camera, initialQuality);
        root.append(cell.element);
        records.push(cell);
        cell.player.start(cell.stream);
        updateMuteButton(cell);
    });

    document.addEventListener('visibilitychange', () => {
        const active = document.visibilityState === 'visible';
        for (const record of records) {
            if (active) record.player.start(record.stream);
            else record.player.stop();
        }
        if (active && qualityMode === 'auto') scheduleProbe(800);
    });

    if (qualityMode === 'auto') scheduleProbe(1000);
}

function initialQualityFor(camera, sourceIsSub) {
    if (qualityMode === 'hd') return 'hd';
    if (qualityMode === 'sd') return camera.sub ? 'sd' : 'hd';
    if (sourceIsSub && camera.sub) return 'sd';
    return camera.sub ? 'sd' : 'hd';
}

function buildCell(camera, quality) {
    const cell = document.createElement('div');
    cell.className = 'cell';
    cell.dataset.status = 'connecting';
    cell.dataset.fit = fit;
    cell.dataset.camId = camera.id;

    const player = document.createElement('camarita-player');
    player.configure({
        mode: config.playerMode,
        iceServers: config.clientIceServers || [],
    });

    const overlay = document.createElement('div');
    overlay.className = 'overlay';
    if (!showLabel) overlay.style.display = 'none';

    const top = document.createElement('div');
    top.className = 'top';
    const live = document.createElement('span');
    live.className = 'live';
    live.innerHTML = '<i></i><span>EN VIVO</span>';
    const qualityBadge = document.createElement('span');
    qualityBadge.className = 'quality';
    top.append(live, qualityBadge);

    const bottom = document.createElement('div');
    bottom.className = 'bottom';
    const info = document.createElement('div');
    const name = document.createElement('div');
    name.className = 'name';
    name.textContent = camera.name;
    const meta = document.createElement('div');
    meta.className = 'meta';
    meta.textContent = `${camera.brand || 'IP'} · — · —`;
    info.append(name, meta);

    const fullscreen = document.createElement('button');
    fullscreen.type = 'button';
    fullscreen.className = 'fs';
    fullscreen.title = 'Pantalla completa';
    fullscreen.setAttribute('aria-label', 'Pantalla completa');
    fullscreen.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M8 3H5a2 2 0 0 0-2 2v3"/><path d="M16 3h3a2 2 0 0 1 2 2v3"/><path d="M8 21H5a2 2 0 0 1-2-2v-3"/><path d="M16 21h3a2 2 0 0 0 2-2v-3"/></svg>';
    bottom.append(info, fullscreen);

    overlay.append(top, bottom);

    const error = document.createElement('div');
    error.className = 'error';
    const errorTitle = document.createElement('strong');
    errorTitle.textContent = 'No se pudo abrir la cámara';
    const errorText = document.createElement('span');
    error.append(errorTitle, errorText);

    cell.append(player, overlay, error);

    const qualityRecord = quality;
    const stream = qualityRecord === 'sd' && camera.sub ? camera.sub : camera.main;

    const record = {
        camera,
        element: cell,
        player,
        quality: qualityRecord,
        stream,
        tech: '—',
        resolution: '—',
        status: 'connecting',
        errorText: errorText,
        elements: { qualityBadge, meta, live },
    };

    qualityBadge.textContent = qualityRecord === 'sd' ? 'SD' : 'HD';
    qualityBadge.classList.toggle('sd', qualityRecord === 'sd');

    player.addEventListener('camarita', (event) => onPlayerEvent(record, event.detail));

    fullscreen.addEventListener('click', (event) => {
        event.stopPropagation();
        if (document.fullscreenElement === cell) document.exitFullscreen().catch(() => {});
        else cell.requestFullscreen().catch(() => {});
    });

    cell.addEventListener('click', () => {
        if (startMuted || !player.video) return;
        player.video.muted = false;
        player.play();
        updateMuteButton(record);
    });

    cell.addEventListener('dblclick', (event) => {
        event.preventDefault();
        if (document.fullscreenElement === cell) document.exitFullscreen().catch(() => {});
        else cell.requestFullscreen().catch(() => {});
    });

    // El vídeo se crea al conectar el custom element.
    queueMicrotask(() => {
        if (player.video) player.video.style.objectFit = fit;
    });

    return record;
}

function updateMuteButton(record) {
    if (!startMuted || !record.player.video) return;
    record.player.video.muted = true;
}

function onPlayerEvent(record, detail) {
    switch (detail.type) {
        case 'connecting':
            setStatus(record, 'connecting');
            record.elements.meta.textContent = `${record.camera.brand || 'IP'} · — · —`;
            break;

        case 'tech':
            record.tech = detail.tech || '—';
            updateMeta(record);
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
            setStatus(record, 'live');
            break;

        case 'stall':
            handleStall(record);
            break;

        case 'streamerror':
            showError(record, detail.message);
            break;

        case 'videoerror':
            showError(record, detail.message);
            break;

        case 'unsupported':
            showError(record, detail.message);
            break;

        case 'closed':
            if (record.status !== 'error') setStatus(record, 'connecting');
            break;

        default:
            break;
    }
}

function updateMeta(record) {
    record.elements.meta.textContent = `${record.camera.brand || 'IP'} · ${record.tech || '—'} · ${record.resolution || '—'}`;
}

function setStatus(record, status) {
    record.status = status;
    record.element.dataset.status = status;
    record.elements.live.lastElementChild.textContent = status === 'live'
        ? 'EN VIVO'
        : status === 'connecting'
            ? 'CONECTANDO'
            : status === 'error'
                ? 'ERROR'
                : 'EN PAUSA';
}

function showError(record, message) {
    setStatus(record, 'error');
    record.errorText.textContent = String(message || 'Error desconocido');
    if (qualityMode === 'auto' && record.quality === 'hd' && record.camera.sub) {
        forceSd(record);
    }
}

function handleStall(record) {
    if (qualityMode === 'auto' && record.quality === 'hd' && record.camera.sub) {
        forceSd(record);
        return;
    }
    record.player.reconnect();
    setStatus(record, 'connecting');
}

function forceSd(record) {
    forcedSdUntil.set(record.camera.id, Date.now() + 90000);
    lastDowngradeAt = Date.now();
    setQuality(record, 'sd');
}

function setQuality(record, quality) {
    if (record.quality === quality) return;
    record.quality = quality;
    record.stream = quality === 'sd' && record.camera.sub ? record.camera.sub : record.camera.main;
    record.elements.qualityBadge.textContent = quality === 'sd' ? 'SD' : 'HD';
    record.elements.qualityBadge.classList.toggle('sd', quality === 'sd');
    record.player.start(record.stream);
}

function scheduleProbe(delay = 60000) {
    window.clearTimeout(probingTimer);
    probingTimer = window.setTimeout(async () => {
        if (document.visibilityState !== 'visible') return;
        const measured = await probe();
        if (measured) applyBandwidth(measured);
        scheduleProbe(60000);
    }, delay);
}

async function probe() {
    if (probeRunning) return null;
    probeRunning = true;

    const controller = new AbortController();
    const timer = window.setTimeout(() => controller.abort(), 7000);
    const started = performance.now();
    let bytes = 0;

    try {
        const response = await fetch(`probe.bin?t=${Date.now()}`, {
            cache: 'no-store',
            signal: controller.signal,
        });
        if (!response.ok) return null;

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

        const seconds = (performance.now() - started) / 1000;
        return Math.max(0.05, (bytes * 8) / Math.max(seconds, 0.2) / 1_000_000);
    } catch {
        const seconds = (performance.now() - started) / 1000;
        if (bytes > 64 * 1024 && seconds > 0.1) {
            return Math.max(0.05, (bytes * 8) / Math.max(seconds, 0.2) / 1_000_000);
        }
        return null;
    } finally {
        window.clearTimeout(timer);
        probeRunning = false;
    }
}

function applyBandwidth(measured) {
    bandwidth = measured;
    const now = Date.now();
    const safety = Number(config.bandwidthSafety) || 0.7;
    const available = measured * safety;

    const targets = new Map();
    const base = records.reduce((sum, record) => {
        return sum + (record.camera.sub ? record.camera.subMbps : record.camera.mainMbps);
    }, 0);

    if (base >= available) {
        for (const record of records) {
            targets.set(record.camera.id, record.camera.sub ? 'sd' : 'hd');
        }
    } else {
        let remaining = available - base;
        const sorted = [...records].sort((a, b) => {
            const priorityDiff = (b.camera.priority || 0) - (a.camera.priority || 0);
            if (priorityDiff !== 0) return priorityDiff;
            return a.camera.mainMbps - b.camera.mainMbps;
        });
        for (const record of sorted) {
            if (!record.camera.sub) {
                targets.set(record.camera.id, 'hd');
                continue;
            }
            const extra = Math.max(0.05, record.camera.mainMbps - record.camera.subMbps);
            if (remaining >= extra) {
                targets.set(record.camera.id, 'hd');
                remaining -= extra;
            } else {
                targets.set(record.camera.id, 'sd');
            }
        }
    }

    for (const [id, until] of forcedSdUntil) {
        if (until <= now) forcedSdUntil.delete(id);
        else targets.set(id, 'sd');
    }

    for (const record of records) {
        const target = targets.get(record.camera.id);
        if (!target || target === record.quality) continue;
        if (target === 'hd' && record.quality === 'sd') {
            if (now - lastDowngradeAt < 45000) continue;
        }
        if (target === 'sd' && record.quality === 'hd') {
            lastDowngradeAt = now;
        }
        setQuality(record, target);
    }
}

function formatResolution(width, height) {
    if (!width || !height) return '—';
    return `${width}×${height}`;
}

function showEmpty(message) {
    const element = document.getElementById('empty');
    element.hidden = false;
    element.textContent = message;
}
