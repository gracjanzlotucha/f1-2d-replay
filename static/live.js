/**
 * live.js — F1 Live Race Tracker
 *
 * Polls the OpenF1 API via the Vercel serverless proxy and renders
 * real-time driver positions, standings, and auto-generated insights.
 */

'use strict';

// ═══════════════════════════════════════════════════════════════════════════
// CONSTANTS
// ═══════════════════════════════════════════════════════════════════════════

const TIRE_COLORS = {
  SOFT: '#E8002D', MEDIUM: '#FFF200', HARD: '#FFFFFF',
  INTERMEDIATE: '#39B54A', WET: '#0067FF', UNKNOWN: '#555555',
};

const TEAM_LOGO_MAP = {
  'Red Bull Racing': 'red-bull',
  'McLaren': 'mclaren',
  'Ferrari': 'ferrari',
  'Mercedes': 'mercedes',
  'Aston Martin': 'aston-martin',
  'Alpine': 'alpine',
  'Haas F1 Team': 'haas',
  'Haas': 'haas',
  'Racing Bulls': 'racing-bulls',
  'RB': 'racing-bulls',
  'Visa Cash App RB': 'racing-bulls',
  'Williams': 'williams',
  'Kick Sauber': 'kick-sauber',
  'Sauber': 'kick-sauber',
  'Cadillac': 'cadillac',
  'Cadillac F1 Team': 'cadillac',
  'Audi': 'audi',
};

const TEAM_COLORS = {
  'Red Bull Racing': '#3671C6',
  'Ferrari': '#E8002D',
  'Mercedes': '#27F4D2',
  'McLaren': '#FF8000',
  'Aston Martin': '#229971',
  'Alpine': '#0093CC',
  'Williams': '#64C4FF',
  'Haas F1 Team': '#B6BABD',
  'Haas': '#B6BABD',
  'Sauber': '#52E252',
  'Kick Sauber': '#52E252',
  'Racing Bulls': '#6692FF',
  'RB': '#6692FF',
  'Visa Cash App RB': '#6692FF',
  'Cadillac': '#C0C0C0',
  'Cadillac F1 Team': '#C0C0C0',
  'Audi': '#52E252',
};

const TYRE_SVG_MAP = {
  SOFT: 'soft', MEDIUM: 'medium', HARD: 'hard',
  INTERMEDIATE: 'intermediate', WET: 'wet',
};

const DRIVER_RADIUS = 13;
const PADDING_FRAC = 0.08;

// ═══════════════════════════════════════════════════════════════════════════
// GLOBAL STATE
// ═══════════════════════════════════════════════════════════════════════════

let L = {
  // Session
  sessionKey: null,
  sessionName: '',
  sessionType: '',
  totalLaps: null,
  currentLap: 0,
  raceStartTs: null,
  sessionStartTs: null,

  // Drivers
  drivers: {},

  // Track
  track: { x: [], y: [] },
  pitLanePath: [],
  trackRotCos: 1,
  trackRotSin: 0,
  trackBounds: null,
  toCanvas: null,
  toCanvasBase: null,

  // Live positions (latest per driver)
  livePositions: {},

  // Standings
  standings: [],
  driverOrder: [],

  // Lap data
  laps: {},
  stints: {},

  // Race control
  raceControl: [],
  trackStatus: 'GREEN',

  // Weather
  weather: {},

  // Insights
  insights: [],
  insightCount: 0,

  // Canvas
  canvas: null,
  ctx: null,
  canvasW: 0,
  canvasH: 0,
  zoom: 1,
  panX: 0,
  panY: 0,
  followDriver: null,
  followZoom: 3,
  showLabels: true,

  // Polling
  pollTimers: {},
  connected: false,
  lastPollTs: {},

  // Follow mode / drag state
  _dragging: false,
  _dragMoved: false,
  _dragStartX: 0,
  _dragStartY: 0,
  _pinchDist: 0,
  _resettingZoom: false,
};

// Insight state for incremental processing
const insightState = {
  prevPositions: {},
  driverBestTimes: {},
  overallFastest: null,
  seenLapKeys: new Set(),
  seenRcKeys: new Set(),
};

// ═══════════════════════════════════════════════════════════════════════════
// API HELPER
// ═══════════════════════════════════════════════════════════════════════════

async function api(endpoint, params = {}) {
  const qs = new URLSearchParams({ endpoint, ...params }).toString();
  const resp = await fetch(`/api/f1?${qs}`);
  if (!resp.ok) {
    const err = await resp.json().catch(() => ({}));
    throw new Error(err.error || `API ${endpoint}: ${resp.status}`);
  }
  return resp.json();
}

// ═══════════════════════════════════════════════════════════════════════════
// LOADING / UI HELPERS
// ═══════════════════════════════════════════════════════════════════════════

function setLoading(msg, pct) {
  const msgEl = document.getElementById('loading-msg');
  const barEl = document.getElementById('loading-bar');
  if (msgEl) msgEl.textContent = msg;
  if (barEl) barEl.style.width = pct + '%';
}

function showApp() {
  document.getElementById('loading-screen').classList.add('hidden');
  document.getElementById('no-session').classList.add('hidden');
  document.getElementById('app').classList.remove('hidden');
}

function showNoSession(nextInfo) {
  document.getElementById('loading-screen').classList.add('hidden');
  document.getElementById('no-session').classList.remove('hidden');
  if (nextInfo) {
    document.getElementById('next-session-info').textContent = nextInfo;
  }
}

function setConnectionStatus(status) {
  const dot = document.querySelector('#connection-status .connection-dot');
  const text = document.querySelector('#connection-status .connection-text');
  if (!dot || !text) return;

  dot.className = 'connection-dot ' + status;
  const labels = { connected: 'Connected', error: 'Reconnecting...', offline: 'Offline' };
  text.textContent = labels[status] || status;
  L.connected = status === 'connected';
}

// ═══════════════════════════════════════════════════════════════════════════
// COORDINATE TRANSFORMS (duplicated from app.js)
// ═══════════════════════════════════════════════════════════════════════════

function rotatePoint(x, y) {
  return [
    x * L.trackRotCos - y * L.trackRotSin,
    x * L.trackRotSin + y * L.trackRotCos,
  ];
}

function hexAlpha(hex, alpha) {
  if (!hex || hex.length < 7) return `rgba(136,136,136,${alpha})`;
  const r = parseInt(hex.slice(1, 3), 16);
  const g = parseInt(hex.slice(3, 5), 16);
  const b = parseInt(hex.slice(5, 7), 16);
  return `rgba(${r},${g},${b},${alpha})`;
}

function fmtLapTime(seconds) {
  if (seconds == null) return '--';
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return m > 0 ? `${m}:${s.toFixed(3).padStart(6, '0')}` : s.toFixed(3);
}

function fmtElapsed(seconds) {
  if (seconds == null || seconds < 0) return '0:00:00';
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.floor(seconds % 60);
  return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}

// ═══════════════════════════════════════════════════════════════════════════
// CANVAS & TRACK RENDERING (duplicated from app.js)
// ═══════════════════════════════════════════════════════════════════════════

function computeTrackBounds() {
  const tx = L.track.x, ty = L.track.y;
  if (!tx || !tx.length) { L.trackBounds = null; return; }

  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;

  for (let i = 0; i < tx.length; i++) {
    const [rx, ry] = rotatePoint(tx[i], ty[i]);
    if (rx < minX) minX = rx; if (rx > maxX) maxX = rx;
    if (ry < minY) minY = ry; if (ry > maxY) maxY = ry;
  }

  // Include pit lane in bounds
  for (const [px, py] of L.pitLanePath) {
    const [rx, ry] = rotatePoint(px, py);
    if (rx < minX) minX = rx; if (rx > maxX) maxX = rx;
    if (ry < minY) minY = ry; if (ry > maxY) maxY = ry;
  }

  L.trackBounds = { minX, maxX, minY, maxY };
}

function setupCanvas() {
  L.canvas = document.getElementById('track-canvas');
  L.ctx = L.canvas.getContext('2d');

  const container = document.getElementById('track-container');

  function resize() {
    const dpr = window.devicePixelRatio || 1;
    const rect = container.getBoundingClientRect();
    const w = Math.round(rect.width);
    const h = Math.round(rect.height);
    L.canvas.width = Math.round(w * dpr);
    L.canvas.height = Math.round(h * dpr);
    L.canvas.style.width = w + 'px';
    L.canvas.style.height = h + 'px';
    L.canvasW = w;
    L.canvasH = h;
    L.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    buildToCanvasFn();
  }

  const ro = new ResizeObserver(resize);
  ro.observe(container);
  resize();
}

function buildToCanvasFn() {
  if (!L.trackBounds) {
    L.toCanvasBase = () => [L.canvasW / 2, L.canvasH / 2];
    L.toCanvas = L.toCanvasBase;
    return;
  }
  const { minX, maxX, minY, maxY } = L.trackBounds;
  const dataW = maxX - minX || 1;
  const dataH = maxY - minY || 1;
  const pad = PADDING_FRAC;

  const availW = L.canvasW * (1 - 2 * pad);
  const availH = L.canvasH * (1 - 2 * pad);
  const fitScale = Math.min(availW / dataW, availH / dataH);
  const offX = (L.canvasW - dataW * fitScale) / 2;
  const offY = (L.canvasH - dataH * fitScale) / 2;

  L.toCanvasBase = function (x, y) {
    const [rx, ry] = rotatePoint(x, y);
    return [offX + (rx - minX) * fitScale, offY + (dataH - (ry - minY)) * fitScale];
  };

  L.toCanvas = function (x, y) {
    const [cx, cy] = L.toCanvasBase(x, y);
    const zx = (cx - L.canvasW / 2) * L.zoom + L.canvasW / 2 + L.panX;
    const zy = (cy - L.canvasH / 2) * L.zoom + L.canvasH / 2 + L.panY;
    return [zx, zy];
  };
}

function applyZoomPan() {
  buildToCanvasFn();
}

function drawTrack(ctx) {
  const tx = L.track.x, ty = L.track.y;
  if (!tx || tx.length < 2) return;

  const scale = Math.max(0.5, L.canvasW / 720) * L.zoom;
  const trackW = Math.max(4, 6 * scale);
  const centerW = Math.max(1, 1.2 * scale);
  const pitW = Math.max(1, 2 * scale);

  function tracePath() {
    ctx.beginPath();
    const pts = [];
    for (let i = 0; i < tx.length; i++) {
      pts.push(L.toCanvas(tx[i], ty[i]));
    }
    const n = pts.length;
    ctx.moveTo((pts[0][0] + pts[1][0]) / 2, (pts[0][1] + pts[1][1]) / 2);
    for (let i = 1; i < n - 1; i++) {
      const mx = (pts[i][0] + pts[i + 1][0]) / 2;
      const my = (pts[i][1] + pts[i + 1][1]) / 2;
      ctx.quadraticCurveTo(pts[i][0], pts[i][1], mx, my);
    }
    const mx1 = (pts[n - 1][0] + pts[0][0]) / 2;
    const my1 = (pts[n - 1][1] + pts[0][1]) / 2;
    ctx.quadraticCurveTo(pts[n - 1][0], pts[n - 1][1], mx1, my1);
    const mx2 = (pts[0][0] + pts[1][0]) / 2;
    const my2 = (pts[0][1] + pts[1][1]) / 2;
    ctx.quadraticCurveTo(pts[0][0], pts[0][1], mx2, my2);
    ctx.closePath();
  }

  // Track surface
  tracePath();
  ctx.strokeStyle = '#272A35';
  ctx.lineWidth = trackW;
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  ctx.stroke();

  // Pit lane
  if (L.pitLanePath.length >= 3) {
    const raw = L.pitLanePath;
    const n = raw.length;
    const extAmt = 300;
    const sdx = raw[0][0] - raw[1][0], sdy = raw[0][1] - raw[1][1];
    const slen = Math.sqrt(sdx * sdx + sdy * sdy) || 1;
    const startExt = [raw[0][0] + (sdx / slen) * extAmt, raw[0][1] + (sdy / slen) * extAmt];
    const edx = raw[n - 1][0] - raw[n - 2][0], edy = raw[n - 1][1] - raw[n - 2][1];
    const elen = Math.sqrt(edx * edx + edy * edy) || 1;
    const endExt = [raw[n - 1][0] + (edx / elen) * extAmt, raw[n - 1][1] + (edy / elen) * extAmt];

    const extPath = [startExt, ...raw, endExt];
    const plPts = extPath.map(p => L.toCanvas(p[0], p[1]));

    ctx.beginPath();
    ctx.moveTo(plPts[0][0], plPts[0][1]);
    for (let i = 0; i < plPts.length - 2; i++) {
      const mx = (plPts[i + 1][0] + plPts[i + 2][0]) / 2;
      const my = (plPts[i + 1][1] + plPts[i + 2][1]) / 2;
      ctx.quadraticCurveTo(plPts[i + 1][0], plPts[i + 1][1], mx, my);
    }
    const last = plPts[plPts.length - 1];
    ctx.lineTo(last[0], last[1]);
    ctx.strokeStyle = '#272A35';
    ctx.lineWidth = pitW;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.stroke();
  }

  // Center line
  tracePath();
  ctx.strokeStyle = '#0D0F13';
  ctx.lineWidth = centerW;
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  ctx.stroke();

  // Start/Finish checkerboard
  if (tx.length > 10) {
    const midIdx = Math.floor(tx.length * 0.02);
    const [sfx, sfy] = L.toCanvas(tx[midIdx], ty[midIdx]);
    ctx.save();
    const [sx2, sy2] = L.toCanvas(tx[midIdx + 2], ty[midIdx + 2]);
    const angle = Math.atan2(sy2 - sfy, sx2 - sfx);
    ctx.translate(sfx, sfy);
    ctx.rotate(angle);
    const cols = 4, rows = 8;
    const cellSize = Math.max(1.5, 1.8 * scale);
    const boardW = cols * cellSize, boardH = rows * cellSize;
    const borderW = Math.max(1.5, 1.8 * scale);
    ctx.fillStyle = '#0D0E12';
    ctx.fillRect(-boardW / 2 - borderW, -boardH / 2 - borderW, boardW + borderW * 2, boardH + borderW * 2);
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        ctx.fillStyle = (r + c) % 2 === 0 ? '#FFFFFF' : '#000000';
        ctx.fillRect(-boardW / 2 + c * cellSize, -boardH / 2 + r * cellSize, cellSize, cellSize);
      }
    }
    ctx.restore();
  }
}

function drawCar(ctx, num, cx, cy) {
  const driver = L.drivers[num];
  if (!driver) return;
  const color = driver.color || '#888';
  const baseR = L.canvasW < 500 ? 9 : DRIVER_RADIUS;
  const r = baseR * Math.pow(L.zoom, 0.4);

  ctx.save();
  ctx.beginPath();
  ctx.arc(cx, cy, r, 0, Math.PI * 2);
  ctx.fillStyle = color;
  ctx.fill();

  ctx.beginPath();
  ctx.arc(cx, cy, r, 0, Math.PI * 2);
  ctx.strokeStyle = hexAlpha(color, 0.15);
  ctx.lineWidth = Math.max(1.5, 2 * Math.pow(L.zoom, 0.6));
  ctx.stroke();
  ctx.restore();

  if (L.showLabels) {
    ctx.save();
    ctx.font = `600 ${Math.floor(r * 0.72)}px "Clash Display", sans-serif`;
    ctx.fillStyle = '#000';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(driver.abbr.slice(0, 3), cx, cy + 0.5);
    ctx.restore();
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// ZOOM & PAN (duplicated from app.js, using L instead of G)
// ═══════════════════════════════════════════════════════════════════════════

function stopFollowing() {
  if (L.followDriver) {
    L.followDriver = null;
    L._resettingZoom = true;
    renderStandings();
  }
}

function setupZoomPan() {
  const canvas = L.canvas;

  canvas.addEventListener('wheel', (e) => {
    e.preventDefault();
    L._resettingZoom = false;
    if (L.followDriver) {
      const factor = e.deltaY < 0 ? 1.15 : 1 / 1.15;
      L.followZoom = Math.min(6, Math.max(1, L.followZoom * factor));
      return;
    }
    const rect = canvas.getBoundingClientRect();
    const mx = e.clientX - rect.left;
    const my = e.clientY - rect.top;
    const oldZoom = L.zoom;
    const factor = e.deltaY < 0 ? 1.15 : 1 / 1.15;
    L.zoom = Math.min(6, Math.max(1, L.zoom * factor));
    if (L.zoom === 1) {
      L.panX = 0; L.panY = 0;
    } else {
      const ratio = L.zoom / oldZoom;
      const cx = L.canvasW / 2, cy = L.canvasH / 2;
      L.panX = (mx - cx) * (1 - ratio) + ratio * L.panX;
      L.panY = (my - cy) * (1 - ratio) + ratio * L.panY;
    }
    applyZoomPan();
  }, { passive: false });

  canvas.addEventListener('mousedown', (e) => {
    if (L.zoom <= 1) return;
    L._dragging = true;
    L._dragMoved = false;
    L._dragStartX = e.clientX;
    L._dragStartY = e.clientY;
  });

  window.addEventListener('mousemove', (e) => {
    if (!L._dragging) return;
    if (L.followDriver) return;
    const dx = e.clientX - L._dragStartX;
    const dy = e.clientY - L._dragStartY;
    if (Math.abs(dx) > 3 || Math.abs(dy) > 3) L._dragMoved = true;
    L.panX += dx; L.panY += dy;
    L._dragStartX = e.clientX; L._dragStartY = e.clientY;
    applyZoomPan();
  });

  window.addEventListener('mouseup', () => { L._dragging = false; });

  canvas.addEventListener('dblclick', (e) => {
    e.preventDefault();
    if (L.followDriver) { L.followZoom = 3; return; }
    L._resettingZoom = false;
    if (L.zoom !== 1) { L.zoom = 1; L.panX = 0; L.panY = 0; applyZoomPan(); }
  });

  // Touch events
  canvas.addEventListener('touchstart', (e) => {
    if (e.touches.length === 1 && L.zoom > 1) {
      L._dragging = true; L._dragMoved = false;
      L._dragStartX = e.touches[0].clientX; L._dragStartY = e.touches[0].clientY;
    } else if (e.touches.length === 2) {
      L._dragging = false;
      const dx = e.touches[0].clientX - e.touches[1].clientX;
      const dy = e.touches[0].clientY - e.touches[1].clientY;
      L._pinchDist = Math.hypot(dx, dy);
    }
  }, { passive: true });

  canvas.addEventListener('touchmove', (e) => {
    if (e.touches.length === 1 && L._dragging) {
      if (L.followDriver) { e.preventDefault(); return; }
      const dx = e.touches[0].clientX - L._dragStartX;
      const dy = e.touches[0].clientY - L._dragStartY;
      if (Math.abs(dx) > 3 || Math.abs(dy) > 3) L._dragMoved = true;
      L.panX += dx; L.panY += dy;
      L._dragStartX = e.touches[0].clientX; L._dragStartY = e.touches[0].clientY;
      applyZoomPan();
      e.preventDefault();
    } else if (e.touches.length === 2) {
      if (L.followDriver) { e.preventDefault(); return; }
      const dx = e.touches[0].clientX - e.touches[1].clientX;
      const dy = e.touches[0].clientY - e.touches[1].clientY;
      const dist = Math.hypot(dx, dy);
      if (L._pinchDist > 0) {
        const rect = canvas.getBoundingClientRect();
        const mx = (e.touches[0].clientX + e.touches[1].clientX) / 2 - rect.left;
        const my = (e.touches[0].clientY + e.touches[1].clientY) / 2 - rect.top;
        const oldZoom = L.zoom;
        L.zoom = Math.min(6, Math.max(1, L.zoom * (dist / L._pinchDist)));
        if (L.zoom === 1) { L.panX = 0; L.panY = 0; }
        else {
          const ratio = L.zoom / oldZoom;
          const cx = L.canvasW / 2, cy = L.canvasH / 2;
          L.panX = (mx - cx) * (1 - ratio) + ratio * L.panX;
          L.panY = (my - cy) * (1 - ratio) + ratio * L.panY;
        }
        applyZoomPan();
      }
      L._pinchDist = dist;
      e.preventDefault();
    }
  }, { passive: false });

  canvas.addEventListener('touchend', () => { L._dragging = false; L._pinchDist = 0; });

  // Click on canvas to follow/unfollow driver
  canvas.addEventListener('click', (e) => {
    if (L._dragMoved) return;
    const rect = canvas.getBoundingClientRect();
    const mx = e.clientX - rect.left;
    const my = e.clientY - rect.top;

    let closest = null, closestDist = Infinity;
    for (const num in L.livePositions) {
      const pos = getDriverScreenPos(num);
      if (!pos) continue;
      const d = Math.hypot(pos[0] - mx, pos[1] - my);
      if (d < closestDist) { closestDist = d; closest = num; }
    }

    const baseR = L.canvasW < 500 ? 9 : DRIVER_RADIUS;
    const hitR = baseR * Math.pow(L.zoom, 0.4) * 1.5;

    if (closest && closestDist < hitR) {
      if (L.followDriver === closest) {
        stopFollowing();
      } else {
        L.followDriver = closest;
        L._resettingZoom = false;
        renderStandings();
      }
    } else if (L.followDriver) {
      stopFollowing();
    }
  });
}

// ═══════════════════════════════════════════════════════════════════════════
// POSITION TRACKING
// ═══════════════════════════════════════════════════════════════════════════

function updateLivePositions(locationData) {
  for (const pt of locationData) {
    const num = String(pt.driver_number);
    if (!L.livePositions[num]) {
      L.livePositions[num] = { x: pt.x, y: pt.y, prevX: pt.x, prevY: pt.y, ts: Date.now() };
    } else {
      const pos = L.livePositions[num];
      pos.prevX = pos.x;
      pos.prevY = pos.y;
      pos.x = pt.x;
      pos.y = pt.y;
      pos.ts = Date.now();
    }
  }
}

function getDriverPosition(num) {
  const pos = L.livePositions[num];
  if (!pos) return null;
  // Smooth interpolation over 3 seconds
  const elapsed = (Date.now() - pos.ts) / 3000;
  const t = Math.min(1, elapsed);
  return {
    x: pos.prevX + (pos.x - pos.prevX) * t,
    y: pos.prevY + (pos.y - pos.prevY) * t,
  };
}

function getDriverScreenPos(num) {
  const pos = getDriverPosition(num);
  if (!pos || !L.toCanvas) return null;
  return L.toCanvas(pos.x, pos.y);
}

// ═══════════════════════════════════════════════════════════════════════════
// RENDER LOOP
// ═══════════════════════════════════════════════════════════════════════════

function startRenderLoop() {
  function loop() {
    renderFrame();
    requestAnimationFrame(loop);
  }
  requestAnimationFrame(loop);
}

function renderFrame() {
  const ctx = L.ctx;
  if (!ctx) return;
  ctx.clearRect(0, 0, L.canvasW, L.canvasH);

  // Follow driver mode
  if (L.followDriver && L.livePositions[L.followDriver]) {
    const pos = getDriverPosition(L.followDriver);
    if (pos) {
      const [baseCx, baseCy] = L.toCanvasBase(pos.x, pos.y);
      const targetZoom = L.followZoom;
      L.zoom += (targetZoom - L.zoom) * 0.1;
      const targetPanX = -(baseCx - L.canvasW / 2) * L.zoom;
      const targetPanY = -(baseCy - L.canvasH / 2) * L.zoom;
      L.panX += (targetPanX - L.panX) * 0.1;
      L.panY += (targetPanY - L.panY) * 0.1;
      buildToCanvasFn();
    }
  } else if (L._resettingZoom) {
    L.zoom += (1 - L.zoom) * 0.1;
    L.panX *= 0.9;
    L.panY *= 0.9;
    if (Math.abs(L.zoom - 1) < 0.01 && Math.abs(L.panX) < 1 && Math.abs(L.panY) < 1) {
      L.zoom = 1; L.panX = 0; L.panY = 0;
      L._resettingZoom = false;
    }
    buildToCanvasFn();
  }

  drawTrack(ctx);

  // Collect and sort cars by Y for back-to-front rendering
  const carData = [];
  for (const num in L.drivers) {
    const pos = getDriverPosition(num);
    if (!pos) continue;
    const [cx, cy] = L.toCanvas(pos.x, pos.y);
    carData.push({ num, cx, cy });
  }
  carData.sort((a, b) => a.cy - b.cy);

  // Draw all cars (followed driver last for on-top rendering)
  for (const { num, cx, cy } of carData) {
    if (num === L.followDriver) continue;
    drawCar(ctx, num, cx, cy);
  }
  // Draw followed driver on top
  if (L.followDriver) {
    const fd = carData.find(c => c.num === L.followDriver);
    if (fd) drawCar(ctx, fd.num, fd.cx, fd.cy);
  }

  // Update elapsed time
  updateElapsedTime();
}

function updateElapsedTime() {
  if (!L.sessionStartTs) return;
  const elapsed = (Date.now() / 1000) - L.sessionStartTs;
  const el = document.getElementById('live-elapsed');
  if (el) el.textContent = fmtElapsed(Math.max(0, elapsed));
}

// ═══════════════════════════════════════════════════════════════════════════
// STANDINGS
// ═══════════════════════════════════════════════════════════════════════════

function updateDriverOrder() {
  // Sort by position from standings data
  const ordered = [...L.standings].sort((a, b) => a.position - b.position);
  L.driverOrder = ordered.map(s => String(s.driver_number));

  // Add any drivers not in standings
  for (const num in L.drivers) {
    if (!L.driverOrder.includes(num)) {
      L.driverOrder.push(num);
    }
  }
}

function renderStandings() {
  updateDriverOrder();
  const list = document.getElementById('standings-list');
  if (!list) return;

  // Update lap counter
  const curEl = document.getElementById('standings-lap-cur');
  const totalEl = document.getElementById('standings-lap-total');
  if (curEl) curEl.textContent = L.currentLap || '--';
  if (totalEl) totalEl.textContent = L.totalLaps || '--';

  const existingRows = {};
  for (const row of Array.from(list.children)) {
    existingRows[row.dataset.driver] = row;
  }

  const orderedRows = [];

  L.driverOrder.forEach((num, idx) => {
    const driver = L.drivers[num];
    if (!driver) return;
    const pos = idx + 1;

    // Get tire compound from stints
    const driverStints = L.stints[num] || [];
    const latestStint = driverStints[driverStints.length - 1];
    const compound = (latestStint?.compound || 'UNKNOWN').toUpperCase();

    // Gap (from position data)
    let gapHtml = '';
    const standingEntry = L.standings.find(s => String(s.driver_number) === num);
    if (idx === 0) {
      gapHtml = '<span class="dr-gap-label">Leader</span>';
    } else if (standingEntry?.interval) {
      gapHtml = `+${Number(standingEntry.interval).toFixed(3)}`;
    } else {
      gapHtml = '<span class="dr-gap-label">--</span>';
    }

    const tyreSvg = TYRE_SVG_MAP[compound] || 'soft';
    const tyreImgSrc = `assets/tyres/${tyreSvg}.svg`;
    const teamColor = driver.color || '#555';
    const teamSlug = TEAM_LOGO_MAP[driver.team] || '';
    const teamLogoSrc = teamSlug ? `assets/teams/${teamSlug}.svg` : '';
    const wantClass = 'driver-row' + (num === L.followDriver ? ' following' : '');

    let row = existingRows[num];
    if (row) {
      if (row.className !== wantClass) row.className = wantClass;
      const posEl = row.querySelector('.dr-pos');
      const posText = posEl?.firstChild;
      if (posText?.nodeType === 3) {
        const trimmed = posText.textContent.trim();
        if (trimmed !== String(pos)) posText.textContent = '\n        ' + pos + '\n        ';
      }
      const gapEl = row.querySelector('.dr-gap');
      if (gapEl && gapEl.innerHTML !== gapHtml) gapEl.innerHTML = gapHtml;
      const tyreImg = row.querySelector('.dr-tyre img');
      if (tyreImg && tyreImg.getAttribute('src') !== tyreImgSrc) {
        tyreImg.src = tyreImgSrc;
        tyreImg.alt = compound;
      }
      delete existingRows[num];
    } else {
      row = document.createElement('div');
      row.className = wantClass;
      row.dataset.driver = num;
      const photoSrc = `assets/drivers/${driver.abbr}.png`;
      row.innerHTML = `
        <div class="dr-pos">
          ${pos}
          <div class="dr-color-bar" style="background:${teamColor}"></div>
        </div>
        <div class="dr-driver">
          <div class="dr-photo" style="background-color:${teamColor}"><img src="${photoSrc}" alt="${driver.abbr}" /></div>
          <span class="dr-abbr">${driver.abbr}</span>
        </div>
        <div class="dr-team-logo">
          ${teamLogoSrc ? `<img src="${teamLogoSrc}" alt="${driver.team}" />` : ''}
        </div>
        <div class="dr-gap">${gapHtml}</div>
        <div class="dr-tyre">
          <img src="${tyreImgSrc}" alt="${compound}" />
        </div>
      `;

      // Click to follow
      row.addEventListener('click', () => {
        if (L.followDriver === num) {
          stopFollowing();
        } else {
          L.followDriver = num;
          L._resettingZoom = false;
          renderStandings();
        }
      });
    }
    orderedRows.push(row);
  });

  for (const num in existingRows) existingRows[num].remove();

  orderedRows.forEach((row, i) => {
    if (list.children[i] !== row) {
      list.insertBefore(row, list.children[i] || null);
    }
  });
}

// ═══════════════════════════════════════════════════════════════════════════
// LIVE INSIGHTS ENGINE
// ═══════════════════════════════════════════════════════════════════════════

function addInsight(type, title, detail, color, driverNum, lap) {
  const key = `${type}-${driverNum || 'all'}-${lap || L.currentLap}`;
  L.insights.unshift({
    id: ++L.insightCount,
    type, title, detail, color,
    driver: driverNum,
    lap: lap || L.currentLap,
    time: Date.now(),
  });

  // Keep max 50 insights
  if (L.insights.length > 50) L.insights.length = 50;
  renderInsights();
}

function processNewLaps(lapData) {
  for (const lap of lapData) {
    const num = String(lap.driver_number);
    const driver = L.drivers[num];
    if (!driver || !lap.lap_duration) continue;

    const lapKey = `${num}-${lap.lap_number}`;
    if (insightState.seenLapKeys.has(lapKey)) continue;
    insightState.seenLapKeys.add(lapKey);

    // Update current lap
    if (lap.lap_number > L.currentLap) {
      L.currentLap = lap.lap_number;
    }

    // Fastest lap detection
    if (!insightState.overallFastest || lap.lap_duration < insightState.overallFastest.time) {
      const wasPrevious = insightState.overallFastest != null;
      insightState.overallFastest = { driver: num, time: lap.lap_duration };
      if (wasPrevious) {
        addInsight('fastest_lap', `${driver.abbr} sets fastest lap`,
          fmtLapTime(lap.lap_duration), driver.color, num, lap.lap_number);
      }
    }

    // Personal best detection
    const prev = insightState.driverBestTimes[num];
    if (!prev || lap.lap_duration < prev) {
      if (prev) {
        addInsight('personal_best', `${driver.abbr} personal best`,
          fmtLapTime(lap.lap_duration), driver.color, num, lap.lap_number);
      }
      insightState.driverBestTimes[num] = lap.lap_duration;
    }
  }
}

function processPositionChanges(positionData) {
  for (const pos of positionData) {
    const num = String(pos.driver_number);
    const driver = L.drivers[num];
    if (!driver) continue;

    const prev = insightState.prevPositions[num];
    if (prev != null) {
      const delta = prev - pos.position;
      if (Math.abs(delta) >= 3) {
        const dir = delta > 0 ? '\u25B2' : '\u25BC';
        addInsight('position_change',
          `${driver.abbr} ${dir} ${Math.abs(delta)} places`,
          `Now P${pos.position}`, driver.color, num);
      }
    }
    insightState.prevPositions[num] = pos.position;
  }
}

function processRaceControl(events) {
  for (const evt of events) {
    const key = evt.date + (evt.message || '');
    if (insightState.seenRcKeys.has(key)) continue;
    insightState.seenRcKeys.add(key);

    const category = evt.category || '';
    const flag = evt.flag || '';
    const message = evt.message || '';

    if (category === 'SafetyCar') {
      if (message.toUpperCase().includes('DEPLOYED')) {
        const isVSC = message.toUpperCase().includes('VIRTUAL');
        L.trackStatus = isVSC ? 'VSC' : 'SC';
        addInsight('safety_car', isVSC ? 'Virtual Safety Car' : 'Safety Car deployed',
          message, '#FFD700', null, evt.lap_number);
      } else if (message.toUpperCase().includes('ENDING') || message.toUpperCase().includes('IN THIS LAP')) {
        L.trackStatus = 'GREEN';
        addInsight('safety_car_end', 'Safety Car ending', message, '#2EE86B', null, evt.lap_number);
      }
    } else if (category === 'Flag') {
      if (flag === 'RED') {
        L.trackStatus = 'RED';
        addInsight('red_flag', 'Red Flag', message, '#E8002D', null, evt.lap_number);
      } else if (flag === 'YELLOW' || flag === 'DOUBLE YELLOW') {
        if (L.trackStatus === 'GREEN') L.trackStatus = 'YELLOW';
        addLiveEvent('flag', `Yellow Flag — ${message}`, '#FFD700', evt.lap_number);
      } else if (flag === 'GREEN') {
        L.trackStatus = 'GREEN';
      }
    }
  }

  updateTrackStatusBadge();
}

function updateTrackStatusBadge() {
  const el = document.getElementById('live-track-status');
  if (!el) return;
  const colors = { GREEN: 'status-green', YELLOW: 'status-yellow', SC: 'status-yellow', VSC: 'status-yellow', RED: 'status-red' };
  el.className = 'status-badge ' + (colors[L.trackStatus] || 'status-green');
  el.textContent = L.trackStatus;
}

// ═══════════════════════════════════════════════════════════════════════════
// LIVE EVENTS FEED
// ═══════════════════════════════════════════════════════════════════════════

function addLiveEvent(type, text, color, lap) {
  const list = document.getElementById('live-events-list');
  const empty = document.getElementById('events-empty');
  if (!list) return;
  if (empty) empty.classList.add('hidden');

  const el = document.createElement('div');
  el.className = 'live-event-item new';
  el.innerHTML = `
    <div class="live-event-dot" style="background: ${color || '#838AA5'}"></div>
    <div class="live-event-text">
      <span class="live-event-lap">L${lap || L.currentLap}</span>
      ${text}
    </div>
  `;

  list.prepend(el);
  // Remove "new" animation class after it plays
  setTimeout(() => el.classList.remove('new'), 1000);

  // Keep max 100 events
  while (list.children.length > 100) {
    list.removeChild(list.lastChild);
  }
}

function renderInsights() {
  const container = document.getElementById('race-insights-content');
  const empty = document.getElementById('insights-empty');
  if (!container) return;

  if (L.insights.length === 0) {
    if (empty) empty.classList.remove('hidden');
    return;
  }
  if (empty) empty.classList.add('hidden');

  // Only render the latest 20 insights
  const toRender = L.insights.slice(0, 20);
  let html = '';

  for (const ins of toRender) {
    const driver = ins.driver ? L.drivers[ins.driver] : null;
    const photoSrc = driver ? `assets/drivers/${driver.abbr}.png` : '';
    const isNew = Date.now() - ins.time < 10000;

    html += `
      <div class="insight-card ${isNew ? 'insight-new' : ''}" style="border-left-color: ${ins.color || '#838AA5'}">
        <div class="insight-header">
          ${photoSrc ? `<div class="insight-photo" style="background-color: ${ins.color}"><img src="${photoSrc}" alt="" /></div>` : ''}
          <div class="insight-title">${ins.title}</div>
          <span class="insight-lap">L${ins.lap}</span>
        </div>
        <div class="insight-detail">${ins.detail}</div>
      </div>
    `;
  }

  // Keep only the insight cards (not the empty message)
  const existing = container.querySelector('.insights-generated');
  if (existing) {
    existing.innerHTML = html;
  } else {
    const wrapper = document.createElement('div');
    wrapper.className = 'insights-generated';
    wrapper.innerHTML = html;
    container.appendChild(wrapper);
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// DATA PROCESSING
// ═══════════════════════════════════════════════════════════════════════════

function processDrivers(rawDrivers) {
  for (const d of rawDrivers) {
    const num = String(d.driver_number);
    const team = d.team_name || '';
    const knownColor = TEAM_COLORS[team];
    const rawColor = d.team_colour;
    const color = knownColor || (rawColor ? '#' + rawColor : '#888888');

    L.drivers[num] = {
      number: num,
      abbr: d.name_acronym || num,
      name: d.full_name || '',
      team,
      color,
    };
  }
}

function processStints(rawStints) {
  L.stints = {};
  for (const s of rawStints) {
    const num = String(s.driver_number);
    if (!L.stints[num]) L.stints[num] = [];
    L.stints[num].push(s);
  }
}

function buildTrackFromLocations(locations) {
  if (!locations || locations.length < 20) return;

  // Use the location data to build a track outline
  // Find a representative lap worth of data
  const xs = locations.map(p => p.x);
  const ys = locations.map(p => p.y);

  // Simple approach: deduplicate by spatial proximity
  const track = { x: [], y: [] };
  let lastX = -Infinity, lastY = -Infinity;
  const minDist = 5; // minimum distance between points

  for (let i = 0; i < xs.length; i++) {
    const dx = xs[i] - lastX, dy = ys[i] - lastY;
    if (dx * dx + dy * dy > minDist * minDist) {
      track.x.push(Math.round(xs[i] * 10) / 10);
      track.y.push(Math.round(ys[i] * 10) / 10);
      lastX = xs[i]; lastY = ys[i];
    }
  }

  L.track = track;
}

// ═══════════════════════════════════════════════════════════════════════════
// POLLING ENGINE
// ═══════════════════════════════════════════════════════════════════════════

async function pollLocation() {
  const params = { session_key: L.sessionKey };
  if (L.lastPollTs.location) params['date>'] = L.lastPollTs.location;

  try {
    const data = await api('location', params);
    if (data.length > 0) {
      L.lastPollTs.location = data[data.length - 1].date;
      updateLivePositions(data);

      // If track is empty, try building it
      if (L.track.x.length === 0) {
        buildTrackFromLocations(data);
        if (L.track.x.length > 0) {
          computeTrackBounds();
          buildToCanvasFn();
        }
      }
    }
    setConnectionStatus('connected');
  } catch (err) {
    console.warn('Location poll error:', err);
    setConnectionStatus('error');
  }
}

async function pollStandings() {
  try {
    const data = await api('position', { session_key: L.sessionKey });
    if (data.length > 0) {
      // Keep latest entry per driver
      const latest = {};
      for (const p of data) {
        latest[p.driver_number] = p;
      }
      L.standings = Object.values(latest);
      processPositionChanges(L.standings);
      renderStandings();
    }
    setConnectionStatus('connected');
  } catch (err) {
    console.warn('Position poll error:', err);
  }
}

async function pollLaps() {
  const params = { session_key: L.sessionKey };
  if (L.lastPollTs.laps) params['date>'] = L.lastPollTs.laps;

  try {
    const data = await api('laps', params);
    if (data.length > 0) {
      L.lastPollTs.laps = data[data.length - 1].date_start;
      processNewLaps(data);

      // Also add to live events feed
      for (const lap of data) {
        if (!lap.lap_duration) continue;
        const num = String(lap.driver_number);
        const driver = L.drivers[num];
        if (!driver) continue;

        const lapKey = `event-${num}-${lap.lap_number}`;
        if (insightState.seenLapKeys.has(lapKey)) continue;
        insightState.seenLapKeys.add(lapKey);

        addLiveEvent('lap', `${driver.abbr} Lap ${lap.lap_number}: ${fmtLapTime(lap.lap_duration)}`,
          driver.color, lap.lap_number);
      }

      // Update lap display
      const lapEl = document.getElementById('live-lap');
      if (lapEl) lapEl.textContent = L.currentLap || '--';
    }
  } catch (err) {
    console.warn('Laps poll error:', err);
  }
}

async function pollRaceControl() {
  try {
    const data = await api('race_control', { session_key: L.sessionKey });
    if (data.length > 0) {
      processRaceControl(data);
    }
  } catch (err) {
    console.warn('Race control poll error:', err);
  }
}

async function pollWeather() {
  try {
    const data = await api('weather', { session_key: L.sessionKey });
    if (data.length > 0) {
      const latest = data[data.length - 1];
      L.weather = latest;
      const airEl = document.getElementById('live-air-temp');
      const trackEl = document.getElementById('live-track-temp');
      if (airEl && latest.air_temperature != null) {
        airEl.textContent = Math.round(latest.air_temperature) + '\u00B0C';
      }
      if (trackEl && latest.track_temperature != null) {
        trackEl.textContent = Math.round(latest.track_temperature) + '\u00B0C';
      }
    }
  } catch (err) {
    console.warn('Weather poll error:', err);
  }
}

async function pollStints() {
  try {
    const data = await api('stints', { session_key: L.sessionKey });
    if (data.length > 0) {
      processStints(data);
      renderStandings();
    }
  } catch (err) {
    console.warn('Stints poll error:', err);
  }
}

function startPolling() {
  // Stagger polls to spread load
  L.pollTimers.location = setInterval(pollLocation, 3000);
  setTimeout(() => { L.pollTimers.position = setInterval(pollStandings, 5000); }, 1500);
  setTimeout(() => { L.pollTimers.laps = setInterval(pollLaps, 10000); }, 3000);
  setTimeout(() => { L.pollTimers.raceControl = setInterval(pollRaceControl, 10000); }, 4500);
  setTimeout(() => { L.pollTimers.weather = setInterval(pollWeather, 30000); }, 6000);
  setTimeout(() => { L.pollTimers.stints = setInterval(pollStints, 60000); }, 8000);
}

function stopPolling() {
  for (const key in L.pollTimers) {
    clearInterval(L.pollTimers[key]);
  }
  L.pollTimers = {};
}

// ═══════════════════════════════════════════════════════════════════════════
// SESSION DISCOVERY
// ═══════════════════════════════════════════════════════════════════════════

function findLiveSession(sessions) {
  const now = new Date();

  // Sort by date descending
  const sorted = sessions
    .filter(s => s.date_start)
    .sort((a, b) => new Date(b.date_start) - new Date(a.date_start));

  for (const s of sorted) {
    const start = new Date(s.date_start);
    const end = s.date_end ? new Date(s.date_end) : null;

    // Active: started and (not ended, or ended within 30 minutes)
    if (start <= now && (!end || (now - end) < 30 * 60 * 1000)) {
      return s;
    }
  }

  return null;
}

function findNextSession(sessions) {
  const now = new Date();
  const upcoming = sessions
    .filter(s => s.date_start && new Date(s.date_start) > now)
    .sort((a, b) => new Date(a.date_start) - new Date(b.date_start));

  return upcoming[0] || null;
}

// ═══════════════════════════════════════════════════════════════════════════
// CONTROLS & BINDINGS
// ═══════════════════════════════════════════════════════════════════════════

function bindControls() {
  // Segmented controls (right panel tabs)
  document.querySelectorAll('.seg-control').forEach(ctrl => {
    const tabs = ctrl.querySelectorAll('.seg-tab');
    const indicator = ctrl.querySelector('.seg-indicator');

    function updateIndicator(activeTab) {
      if (!indicator) return;
      indicator.style.width = activeTab.offsetWidth + 'px';
      indicator.style.left = activeTab.offsetLeft + 'px';
    }

    tabs.forEach(tab => {
      tab.addEventListener('click', () => {
        tabs.forEach(t => t.classList.remove('active'));
        tab.classList.add('active');
        updateIndicator(tab);

        const panel = tab.dataset.tab || tab.dataset.panel;
        if (panel) {
          // Desktop: right panel tabs
          if (tab.dataset.tab) {
            document.getElementById('events-content')?.classList.toggle('hidden', panel !== 'events');
            document.getElementById('race-insights-content')?.classList.toggle('hidden', panel !== 'insights');
            document.getElementById('track-content')?.classList.toggle('hidden', panel !== 'track');
          }
          // Mobile: full panel switching
          if (tab.dataset.panel) {
            document.querySelector('.standings-panel')?.classList.toggle('hidden', panel !== 'standings');
            document.querySelector('.track-section')?.classList.toggle('hidden', panel !== 'track');
            document.querySelector('.insights-panel')?.classList.toggle('hidden',
              panel !== 'events' && panel !== 'insights');
          }
        }
      });
    });

    // Init indicator position
    const active = ctrl.querySelector('.seg-tab.active');
    if (active) requestAnimationFrame(() => updateIndicator(active));
  });

  // Settings popup
  const settingsBtn = document.getElementById('btn-player-settings');
  const settingsPopup = document.getElementById('settings-popup');
  if (settingsBtn && settingsPopup) {
    settingsBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      settingsPopup.classList.toggle('hidden');
    });
    document.addEventListener('click', () => settingsPopup.classList.add('hidden'));
  }

  // Show labels toggle
  const labelsOpt = document.getElementById('opt-labels');
  if (labelsOpt) {
    labelsOpt.addEventListener('change', () => {
      L.showLabels = labelsOpt.checked;
    });
  }

  // Fullscreen
  const fsBtn = document.getElementById('btn-fullscreen');
  if (fsBtn) {
    fsBtn.addEventListener('click', () => {
      if (!document.fullscreenElement) {
        document.documentElement.requestFullscreen().catch(() => {});
      } else {
        document.exitFullscreen();
      }
    });

    document.addEventListener('fullscreenchange', () => {
      const isFs = !!document.fullscreenElement;
      fsBtn.querySelector('.fs-expand')?.classList.toggle('hidden', isFs);
      fsBtn.querySelector('.fs-compress')?.classList.toggle('hidden', !isFs);
    });
  }

  // Keyboard
  document.addEventListener('keydown', (e) => {
    if (e.key === 'f' || e.key === 'F') {
      if (!document.fullscreenElement) {
        document.documentElement.requestFullscreen().catch(() => {});
      } else {
        document.exitFullscreen();
      }
    }
    if (e.key === 'Escape' && L.followDriver) {
      stopFollowing();
    }
  });

  // Retry button on no-session screen
  const retryBtn = document.getElementById('btn-retry');
  if (retryBtn) {
    retryBtn.addEventListener('click', () => {
      document.getElementById('no-session').classList.add('hidden');
      document.getElementById('loading-screen').classList.remove('hidden');
      init();
    });
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// INITIALIZATION
// ═══════════════════════════════════════════════════════════════════════════

async function init() {
  try {
    // 1. Find live session
    setLoading('Discovering live session...', 10);
    const sessions = await api('sessions', { year: '2026' });
    const liveSession = findLiveSession(sessions);

    if (!liveSession) {
      const next = findNextSession(sessions);
      let nextInfo = 'Check back during a live session.';
      if (next) {
        const d = new Date(next.date_start);
        nextInfo = `Next: ${next.session_name || next.session_type} — ${next.location || ''} — ${d.toLocaleDateString()} ${d.toLocaleTimeString()}`;
      }
      showNoSession(nextInfo);
      return;
    }

    L.sessionKey = liveSession.session_key;
    L.sessionName = liveSession.meeting_name || liveSession.location || 'Live Session';
    L.sessionType = liveSession.session_type || '';
    L.sessionStartTs = new Date(liveSession.date_start).getTime() / 1000;

    document.getElementById('live-session-name').textContent = L.sessionName;
    document.getElementById('live-session-type').textContent = L.sessionType;
    document.getElementById('loading-title').textContent = L.sessionName;
    document.getElementById('loading-subtitle').textContent = L.sessionType;

    // 2. Fetch initial data in parallel
    setLoading('Loading race data...', 30);
    const [rawDrivers, rawWeather, rawStints, rawRaceControl] = await Promise.all([
      api('drivers', { session_key: L.sessionKey }),
      api('weather', { session_key: L.sessionKey }),
      api('stints', { session_key: L.sessionKey }),
      api('race_control', { session_key: L.sessionKey }),
    ]);

    processDrivers(rawDrivers);
    processStints(rawStints);

    // Weather
    if (rawWeather.length > 0) {
      const w = rawWeather[rawWeather.length - 1];
      L.weather = w;
      const airEl = document.getElementById('live-air-temp');
      const trackEl = document.getElementById('live-track-temp');
      if (airEl && w.air_temperature != null) airEl.textContent = Math.round(w.air_temperature) + '\u00B0C';
      if (trackEl && w.track_temperature != null) trackEl.textContent = Math.round(w.track_temperature) + '\u00B0C';
    }

    // Race control
    processRaceControl(rawRaceControl);

    // 3. Fetch initial location data
    setLoading('Loading positions...', 60);
    const firstDriver = Object.keys(L.drivers)[0];
    if (firstDriver) {
      try {
        const locations = await api('location', {
          session_key: L.sessionKey,
          driver_number: firstDriver,
        });
        if (locations.length > 0) {
          buildTrackFromLocations(locations);
        }
      } catch (err) {
        console.warn('Could not fetch initial location data:', err);
      }
    }

    // Fetch track rotation from Multiviewer if possible
    try {
      setLoading('Loading circuit info...', 70);
      const circuitYear = liveSession.year || 2026;
      const circuitKey = liveSession.circuit_key;
      if (circuitKey) {
        const circuitResp = await fetch(
          `https://api.multiviewer.app/api/v1/circuits/${circuitKey}/${circuitYear}`,
          { headers: { 'User-Agent': 'f1-2d-replay/1.0' } }
        );
        if (circuitResp.ok) {
          const circuitData = await circuitResp.json();
          const rotDeg = -(circuitData.rotation || 0);
          const rotRad = rotDeg * Math.PI / 180;
          L.trackRotCos = Math.cos(rotRad);
          L.trackRotSin = Math.sin(rotRad);
        }
      }
    } catch (err) {
      console.warn('Could not fetch circuit info:', err);
    }

    // 4. Compute track bounds and setup canvas
    setLoading('Setting up...', 85);
    computeTrackBounds();

    // 5. Fetch initial standings
    try {
      const positions = await api('position', { session_key: L.sessionKey });
      if (positions.length > 0) {
        const latest = {};
        for (const p of positions) latest[p.driver_number] = p;
        L.standings = Object.values(latest);
      }
    } catch (err) {
      console.warn('Could not fetch initial standings:', err);
    }

    // Determine total laps if it's a race
    if (L.sessionType === 'Race') {
      const totalEl = document.getElementById('live-total-laps');
      // The API doesn't directly provide total laps, so we'll update as we go
      if (totalEl) totalEl.textContent = '--';
    }

    // 6. Show app
    setLoading('Ready!', 100);
    await new Promise(r => setTimeout(r, 300));
    showApp();

    setupCanvas();
    setupZoomPan();
    renderStandings();
    bindControls();
    startRenderLoop();

    // 7. Start polling
    startPolling();
    // Do an immediate poll for all data
    pollLocation();

    setConnectionStatus('connected');

  } catch (err) {
    console.error('Initialization error:', err);
    setLoading(`Error: ${err.message}`, 100);
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// BOOT
// ═══════════════════════════════════════════════════════════════════════════

init();
