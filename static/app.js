/**
 * F1 2D Replay — Silverstone 2025
 * Main application: data loading, track rendering, replay engine, UI updates.
 */

'use strict';

// ═══════════════════════════════════════════════════════════════════════════
// CONSTANTS & GLOBALS
// ═══════════════════════════════════════════════════════════════════════════

const TIRE_COLORS = {
  SOFT: '#E8002D', MEDIUM: '#FFF200', HARD: '#FFFFFF',
  INTERMEDIATE: '#39B54A', WET: '#0067FF', UNKNOWN: '#555555', nan: '#555555',
};

const TRAIL_LENGTH = 28;   // How many past positions to show as trail
const DRIVER_RADIUS = 9;   // Car marker radius on canvas
const PADDING_FRAC  = 0.08; // Canvas padding as fraction

// Track rotation — aligns Silverstone pit straight horizontally, S/F at top
// Angle: -32.5° (pit straight runs at ~32.5° from horizontal in data space)
const TRACK_ROT_COS = 0.8434;   // cos(-32.5°)
const TRACK_ROT_SIN = -0.5373;  // sin(-32.5°)

function rotatePoint(x, y) {
  // Rotate by -32.5° then negate Y to put S/F at top
  const rx = x * TRACK_ROT_COS - y * TRACK_ROT_SIN;
  const ry = -(x * TRACK_ROT_SIN + y * TRACK_ROT_COS);
  return [rx, ry];
}

// Pit lane path coordinates (extracted from position telemetry during pit stops)
const PIT_LANE_PATH = [
  [-1049, -129], [-1007, 125], [-960, 390], [-910, 660],
  [-856, 935], [-824, 1130], [-800, 1350], [-780, 1570],
  [-755, 1785], [-720, 1985], [-670, 2200], [-610, 2420],
  [-540, 2640], [-460, 2860], [-370, 3070], [-270, 3280],
  [-160, 3470], [-40, 3650], [90, 3790], [230, 3900], [380, 3960], [529, 3978],
];

let G = {
  // Raw data
  session: null,
  drivers: {},      // { num: driverObj }
  track: null,      // { x[], y[] }
  positions: {},    // { driverNum: { t[], x[], y[] } }
  laps: [],
  insights: {},

  // Derived / computed
  driverOrder: [],  // driver numbers sorted by current position
  lapStartTimes: [], // [{ lap, t }] sorted by lap
  lapStartMap: {},  // lap -> t
  maxT: 0,         // total race duration (seconds)
  totalLaps: 0,

  // Track normalisation
  trackBounds: null, // { minX, maxX, minY, maxY }
  toCanvas: null,    // function(x, y) -> [cx, cy]

  // Replay state
  currentT: 0,
  playing: false,
  speed: 1,
  lastFrameTime: null,
  currentLap: 1,

  // Canvas state
  canvas: null,
  ctx: null,
  canvasW: 0,
  canvasH: 0,
  offscreenTrack: null,  // pre-rendered track layer

  // Options
  showTrails: true,
  showLabels: true,

  // Trail history: { driverNum: [{cx, cy}] }
  trails: {},

  // RAF handle
  rafId: null,
};

// ═══════════════════════════════════════════════════════════════════════════
// INITIALISATION
// ═══════════════════════════════════════════════════════════════════════════

async function init() {
  await loadAllData();
  setupDerivedData();
  // Show the app BEFORE setupCanvas so the container has real dimensions
  // (getBoundingClientRect returns 0 while the element is display:none)
  showApp();
  // Allow one layout pass so the browser assigns pixel sizes
  await new Promise(r => requestAnimationFrame(r));
  setupCanvas();
  bindControls();
  buildLapMarkers();
  renderStandings();
  renderRaceInsights();
  renderEvents(1);
  startRaf();
}

async function loadAllData() {
  const bar = document.getElementById('loading-bar');
  const msg = document.getElementById('loading-msg');

  msg.textContent = 'Loading race data…';
  bar.style.width = '10%';

  const [dataRes, posRes] = await Promise.all([
    fetch('./data.json'),
    fetch('./positions.json'),
  ]);

  msg.textContent = 'Parsing data…';
  bar.style.width = '60%';

  const [data, positions] = await Promise.all([
    dataRes.json(),
    posRes.json(),
  ]);

  bar.style.width = '100%';

  G.session  = data.session;
  G.drivers  = data.drivers;
  G.track    = data.track;
  G.laps     = data.laps;
  G.insights = data.insights;
  G.positions = positions;
  G.totalLaps = data.session.total_laps;

  // Populate weather
  const w = data.session.weather;
  if (w) {
    document.getElementById('weather-air').textContent   = `${w.air_temp}°C Air`;
    document.getElementById('weather-track').textContent = `${w.track_temp}°C Track`;
    if (w.rainfall) {
      document.getElementById('hdr-status-badge').textContent = 'WET';
      document.getElementById('hdr-status-badge').className = 'status-badge status-yellow';
    }
  }

  document.getElementById('hdr-lap-total').textContent = G.totalLaps;
}

function setupDerivedData() {
  // ── Compute max race time ────────────────────────────────────────────────
  let maxT = 0;
  for (const num in G.positions) {
    const ts = G.positions[num].t;
    if (ts && ts.length) maxT = Math.max(maxT, ts[ts.length - 1]);
  }
  G.maxT = maxT;

  // ── Build lap start time map ─────────────────────────────────────────────
  // Use the leader's (or any driver's) laps
  const lapMap = {};
  for (const lap of G.laps) {
    if (lap.lap_start != null && lap.lap != null) {
      const key = lap.lap;
      if (!(key in lapMap) || lap.lap_start < lapMap[key]) {
        lapMap[key] = lap.lap_start;
      }
    }
  }
  G.lapStartMap = lapMap;
  G.lapStartTimes = Object.entries(lapMap)
    .map(([l, t]) => ({ lap: parseInt(l), t }))
    .sort((a, b) => a.lap - b.lap);

  // ── Detect DNS / DNF / pit-start drivers ────────────────────────────────
  G.driverStatus = {}; // { driverNum: { status, retirementLap, pitStart } }

  // Count max lap per driver and detect pit-lane starters
  const maxLapByDriver = {};
  const pitStartDrivers = new Set();

  for (const lap of G.laps) {
    const d = lap.driver;
    if (lap.lap != null) {
      maxLapByDriver[d] = Math.max(maxLapByDriver[d] || 0, lap.lap);
    }
    // Pit-lane start: has pit_out on lap 1 but no pit_in on lap 1
    if (lap.lap === 1 && lap.pit_out != null && lap.pit_in == null) {
      pitStartDrivers.add(d);
    }
  }

  for (const num in G.drivers) {
    const maxLap = maxLapByDriver[num] || 0;
    const status = { status: 'racing', retirementLap: null, pitStart: pitStartDrivers.has(num) };

    if (maxLap === 0) {
      // No laps at all = DNS
      status.status = 'dns';
    } else if (maxLap < G.totalLaps) {
      // Fewer laps than total = DNF/RET
      status.status = 'dnf';
      status.retirementLap = maxLap;
    }

    G.driverStatus[num] = status;
  }

  // ── Track normalisation ──────────────────────────────────────────────────
  computeTrackBounds();

  // ── Driver order init ────────────────────────────────────────────────────
  G.driverOrder = Object.keys(G.drivers);

  // ── Init trails ─────────────────────────────────────────────────────────
  for (const num in G.drivers) G.trails[num] = [];

  document.getElementById('ctrl-time-total').textContent = fmtRaceTime(G.maxT);
}

function computeTrackBounds() {
  const tx = G.track.x, ty = G.track.y;
  if (!tx || !tx.length) { G.trackBounds = null; return; }

  // Compute bounds in ROTATED coordinate space
  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;

  for (let i = 0; i < tx.length; i++) {
    const [rx, ry] = rotatePoint(tx[i], ty[i]);
    if (rx < minX) minX = rx; if (rx > maxX) maxX = rx;
    if (ry < minY) minY = ry; if (ry > maxY) maxY = ry;
  }

  for (const num in G.positions) {
    const px = G.positions[num].x, py = G.positions[num].y;
    for (let i = 0; i < px.length; i++) {
      const [rx, ry] = rotatePoint(px[i], py[i]);
      if (rx < minX) minX = rx; if (rx > maxX) maxX = rx;
      if (ry < minY) minY = ry; if (ry > maxY) maxY = ry;
    }
  }

  // Include pit lane path in bounds
  for (const [px, py] of PIT_LANE_PATH) {
    const [rx, ry] = rotatePoint(px, py);
    if (rx < minX) minX = rx; if (rx > maxX) maxX = rx;
    if (ry < minY) minY = ry; if (ry > maxY) maxY = ry;
  }

  G.trackBounds = { minX, maxX, minY, maxY };
}

// ═══════════════════════════════════════════════════════════════════════════
// CANVAS SETUP
// ═══════════════════════════════════════════════════════════════════════════

function setupCanvas() {
  G.canvas = document.getElementById('track-canvas');
  G.ctx    = G.canvas.getContext('2d');

  const container = document.getElementById('track-container');

  function resize() {
    const dpr  = window.devicePixelRatio || 1;
    const rect = container.getBoundingClientRect();
    // Round to integer CSS pixels to avoid subpixel positioning blur
    const size = Math.round(Math.min(rect.width * 0.96, rect.height * 0.96));
    // Physical pixel dimensions (retina-sharp)
    G.canvas.width  = Math.round(size * dpr);
    G.canvas.height = Math.round(size * dpr);
    // CSS display size
    G.canvas.style.width  = size + 'px';
    G.canvas.style.height = size + 'px';
    // Logical (CSS-pixel) size used by all coordinate math
    G.canvasW = size;
    G.canvasH = size;
    // Use setTransform instead of scale() so the matrix is always set to
    // exactly dpr — avoids accumulation if canvas.width didn't reset the
    // context (browsers may skip reset when the value is unchanged).
    G.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    buildToCanvasFn();
    buildOffscreenTrack();
  }

  const ro = new ResizeObserver(resize);
  ro.observe(container);
  resize();
}

function buildToCanvasFn() {
  if (!G.trackBounds) {
    G.toCanvas = (x, y) => [G.canvasW / 2, G.canvasH / 2];
    return;
  }
  const { minX, maxX, minY, maxY } = G.trackBounds;
  const dataW = maxX - minX || 1;
  const dataH = maxY - minY || 1;
  const pad   = PADDING_FRAC;

  G.toCanvas = function (x, y) {
    // Apply rotation to match F1 website Silverstone orientation
    const [rx, ry] = rotatePoint(x, y);
    const nx = (rx - minX) / dataW;
    // Flip Y (screen Y grows downward)
    const ny = 1 - (ry - minY) / dataH;
    const cx = (pad + nx * (1 - 2 * pad)) * G.canvasW;
    const cy = (pad + ny * (1 - 2 * pad)) * G.canvasH;
    return [cx, cy];
  };
}

function buildOffscreenTrack() {
  const tx = G.track.x, ty = G.track.y;
  if (!tx || tx.length < 2) { G.offscreenTrack = null; return; }

  const dpr = window.devicePixelRatio || 1;
  const oc = document.createElement('canvas');
  oc.width  = Math.round(G.canvasW * dpr);
  oc.height = Math.round(G.canvasH * dpr);
  const octx = oc.getContext('2d');
  octx.scale(dpr, dpr);

  // Outer shadow / glow effect
  octx.shadowColor = 'rgba(255,255,255,0.06)';
  octx.shadowBlur = 14;

  // Draw track boundary (wider, darker)
  octx.beginPath();
  const [sx0, sy0] = G.toCanvas(tx[0], ty[0]);
  octx.moveTo(sx0, sy0);
  for (let i = 1; i < tx.length; i++) {
    const [cx, cy] = G.toCanvas(tx[i], ty[i]);
    octx.lineTo(cx, cy);
  }
  octx.closePath();
  octx.strokeStyle = 'rgba(255,255,255,0.10)';
  octx.lineWidth   = 14;
  octx.lineCap     = 'round';
  octx.lineJoin    = 'round';
  octx.stroke();

  octx.shadowBlur = 0;

  // Draw track surface
  octx.beginPath();
  const [sx1, sy1] = G.toCanvas(tx[0], ty[0]);
  octx.moveTo(sx1, sy1);
  for (let i = 1; i < tx.length; i++) {
    const [cx, cy] = G.toCanvas(tx[i], ty[i]);
    octx.lineTo(cx, cy);
  }
  octx.closePath();
  octx.strokeStyle = '#333333';
  octx.lineWidth   = 10;
  octx.stroke();

  // Centre line (subtle dashes)
  octx.beginPath();
  const [sx2, sy2] = G.toCanvas(tx[0], ty[0]);
  octx.moveTo(sx2, sy2);
  for (let i = 1; i < tx.length; i++) {
    const [cx, cy] = G.toCanvas(tx[i], ty[i]);
    octx.lineTo(cx, cy);
  }
  octx.closePath();
  octx.strokeStyle = 'rgba(255,255,255,0.06)';
  octx.lineWidth   = 1.5;
  octx.setLineDash([6, 10]);
  octx.stroke();
  octx.setLineDash([]);

  // Pit lane line (gray, dashed)
  if (PIT_LANE_PATH.length >= 2) {
    octx.beginPath();
    const [plx0, ply0] = G.toCanvas(PIT_LANE_PATH[0][0], PIT_LANE_PATH[0][1]);
    octx.moveTo(plx0, ply0);
    for (let i = 1; i < PIT_LANE_PATH.length; i++) {
      const [plx, ply] = G.toCanvas(PIT_LANE_PATH[i][0], PIT_LANE_PATH[i][1]);
      octx.lineTo(plx, ply);
    }
    octx.strokeStyle = 'rgba(255,255,255,0.25)';
    octx.lineWidth   = 4;
    octx.setLineDash([6, 6]);
    octx.lineCap     = 'round';
    octx.lineJoin    = 'round';
    octx.stroke();
    octx.setLineDash([]);

    // "PIT" label near the middle of the pit lane
    const pitMid = Math.floor(PIT_LANE_PATH.length / 2);
    const [pmx, pmy] = G.toCanvas(PIT_LANE_PATH[pitMid][0], PIT_LANE_PATH[pitMid][1]);
    octx.font = 'bold 8px Inter, sans-serif';
    octx.fillStyle = 'rgba(255,255,255,0.3)';
    octx.textAlign = 'center';
    octx.fillText('PIT', pmx - 12, pmy + 3);
  }

  // Start/Finish line
  if (tx.length > 10) {
    const midIdx = Math.floor(tx.length * 0.02);
    const [sfx, sfy] = G.toCanvas(tx[midIdx], ty[midIdx]);
    octx.save();
    octx.strokeStyle = '#FFFFFF';
    octx.lineWidth   = 3;
    // Compute angle using rotated coordinates
    const [rx1, ry1] = rotatePoint(tx[midIdx], ty[midIdx]);
    const [rx2, ry2] = rotatePoint(tx[midIdx + 2], ty[midIdx + 2]);
    const angle = Math.atan2(-(ry2 - ry1), rx2 - rx1);
    octx.translate(sfx, sfy);
    octx.rotate(angle + Math.PI / 2);
    octx.beginPath();
    octx.moveTo(-12, 0); octx.lineTo(12, 0);
    octx.stroke();
    octx.restore();

    // S/F label
    octx.font = 'bold 9px Inter, sans-serif';
    octx.fillStyle = 'rgba(255,255,255,0.4)';
    octx.textAlign = 'center';
    octx.fillText('S/F', sfx, sfy - 14);
  }

  G.offscreenTrack = oc;
}

// ═══════════════════════════════════════════════════════════════════════════
// POSITION INTERPOLATION
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Binary-search for the insertion index of `t` in sorted array `arr`.
 */
function bisect(arr, t) {
  let lo = 0, hi = arr.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (arr[mid] < t) lo = mid + 1; else hi = mid;
  }
  return lo;
}

/**
 * Returns interpolated { x, y } for a given driver at time t.
 * Returns null if no data available.
 */
function getPosition(driverNum, t) {
  const pd = G.positions[driverNum];
  if (!pd || !pd.t.length) return null;

  const idx = bisect(pd.t, t);
  if (idx === 0) return { x: pd.x[0], y: pd.y[0] };
  if (idx >= pd.t.length) return { x: pd.x[pd.t.length - 1], y: pd.y[pd.t.length - 1] };

  const t0 = pd.t[idx - 1], t1 = pd.t[idx];
  const frac = t1 === t0 ? 0 : (t - t0) / (t1 - t0);
  return {
    x: pd.x[idx - 1] + frac * (pd.x[idx] - pd.x[idx - 1]),
    y: pd.y[idx - 1] + frac * (pd.y[idx] - pd.y[idx - 1]),
  };
}

// ═══════════════════════════════════════════════════════════════════════════
// REPLAY ENGINE
// ═══════════════════════════════════════════════════════════════════════════

function startRaf() {
  function loop(now) {
    if (G.playing) {
      if (G.lastFrameTime !== null) {
        const elapsed = (now - G.lastFrameTime) / 1000;  // seconds
        G.currentT += elapsed * G.speed;
        if (G.currentT >= G.maxT) {
          G.currentT = G.maxT;
          G.playing  = false;
          updatePlayButton();
        }
      }
      G.lastFrameTime = now;
    } else {
      G.lastFrameTime = null;
    }

    updateCurrentLap();
    renderFrame();
    updateTimelineUI();
    G.rafId = requestAnimationFrame(loop);
  }
  G.rafId = requestAnimationFrame(loop);
}

function updateCurrentLap() {
  let lap = 1;
  for (const entry of G.lapStartTimes) {
    if (entry.t <= G.currentT) lap = entry.lap;
    else break;
  }
  if (lap !== G.currentLap) {
    G.currentLap = lap;
    renderStandings();
    renderEvents(lap);
    document.getElementById('standings-lap-label').textContent = `LAP ${lap}`;
    document.getElementById('hdr-lap-cur').textContent = lap;

    // Track status badge
    const lapRows = G.laps.filter(l => l.lap === lap);
    const statuses = new Set(lapRows.map(l => l.track_status));
    const badge = document.getElementById('hdr-status-badge');
    if (statuses.has('4')) {
      badge.className = 'status-badge status-yellow'; badge.textContent = 'SAFETY CAR';
    } else if (statuses.has('5')) {
      badge.className = 'status-badge status-yellow'; badge.textContent = 'VSC';
    } else if (statuses.has('2') || statuses.has('3')) {
      badge.className = 'status-badge status-yellow'; badge.textContent = 'YELLOW';
    } else {
      badge.className = 'status-badge status-green'; badge.textContent = 'RACE';
    }
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// RENDER FRAME
// ═══════════════════════════════════════════════════════════════════════════

function renderFrame() {
  const ctx  = G.ctx;
  const W    = G.canvasW;
  const H    = G.canvasH;

  // Clear
  ctx.clearRect(0, 0, W, H);

  // Draw pre-rendered track
  if (G.offscreenTrack) {
    ctx.drawImage(G.offscreenTrack, 0, 0, G.canvasW, G.canvasH);
  } else {
    // Placeholder if no track data
    ctx.fillStyle = '#1a1a1a';
    ctx.fillRect(0, 0, W, H);
    ctx.fillStyle = '#444';
    ctx.font = '16px Inter, sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText('Track data loading…', W / 2, H / 2);
    return;
  }

  // Collect current positions and sort by screen Y (depth)
  const carData = [];
  for (const num in G.drivers) {
    const ds = G.driverStatus[num];
    // Skip DNS drivers — they never started
    if (ds && ds.status === 'dns') continue;
    // Skip DNF drivers after their retirement lap
    if (ds && ds.status === 'dnf' && ds.retirementLap != null) {
      const retLapT = G.lapStartMap[ds.retirementLap + 1] || G.lapStartMap[ds.retirementLap];
      if (retLapT != null && G.currentT > retLapT + 10) continue; // +10s grace period
    }
    const pos = getPosition(num, G.currentT);
    if (!pos) continue;
    const [cx, cy] = G.toCanvas(pos.x, pos.y);
    carData.push({ num, cx, cy, pos });
  }
  // Sort so cars lower on screen render last (on top)
  carData.sort((a, b) => a.cy - b.cy);

  // Draw trails first (below everything)
  if (G.showTrails) {
    for (const { num, cx, cy } of carData) {
      const trail = G.trails[num] || [];
      if (trail.length < 2) continue;
      const color = G.drivers[num]?.color || '#888';
      ctx.save();
      for (let i = 1; i < trail.length; i++) {
        const alpha = (i / trail.length) * 0.45;
        const width = (i / trail.length) * 4;
        ctx.beginPath();
        ctx.moveTo(trail[i - 1].cx, trail[i - 1].cy);
        ctx.lineTo(trail[i].cx,     trail[i].cy);
        ctx.strokeStyle = hexAlpha(color, alpha);
        ctx.lineWidth   = width;
        ctx.lineCap     = 'round';
        ctx.stroke();
      }
      ctx.restore();
    }
  }

  // Update trails
  for (const { num, cx, cy } of carData) {
    if (!G.trails[num]) G.trails[num] = [];
    G.trails[num].push({ cx, cy });
    if (G.trails[num].length > TRAIL_LENGTH) G.trails[num].shift();
  }

  // Draw cars
  for (const { num, cx, cy } of carData) {
    drawCar(ctx, num, cx, cy);
  }

  // Update driver order (for standings) based on position at current time
  updateDriverOrder();
}

function drawCar(ctx, num, cx, cy) {
  const driver = G.drivers[num];
  if (!driver) return;
  const color = driver.color || '#888';
  const r     = DRIVER_RADIUS;

  // Outer glow
  ctx.save();
  ctx.shadowColor = hexAlpha(color, 0.7);
  ctx.shadowBlur  = 14;

  // Circle fill
  ctx.beginPath();
  ctx.arc(cx, cy, r, 0, Math.PI * 2);
  ctx.fillStyle = color;
  ctx.fill();

  ctx.shadowBlur = 0;

  // White border
  ctx.beginPath();
  ctx.arc(cx, cy, r, 0, Math.PI * 2);
  ctx.strokeStyle = 'rgba(255,255,255,0.5)';
  ctx.lineWidth   = 1.5;
  ctx.stroke();

  ctx.restore();

  // Abbreviation inside
  if (G.showLabels) {
    ctx.save();
    ctx.font         = `bold ${Math.floor(r * 0.75)}px "JetBrains Mono", monospace`;
    ctx.fillStyle    = isLightColor(color) ? '#000' : '#fff';
    ctx.textAlign    = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(driver.abbr.slice(0, 3), cx, cy + 0.5);
    ctx.restore();
  }
}

function isLightColor(hex) {
  const r = parseInt(hex.slice(1, 3), 16);
  const g = parseInt(hex.slice(3, 5), 16);
  const b = parseInt(hex.slice(5, 7), 16);
  return (r * 299 + g * 587 + b * 114) / 1000 > 128;
}

function hexAlpha(hex, alpha) {
  if (!hex || hex.length < 7) return `rgba(136,136,136,${alpha})`;
  const r = parseInt(hex.slice(1, 3), 16);
  const g = parseInt(hex.slice(3, 5), 16);
  const b = parseInt(hex.slice(5, 7), 16);
  return `rgba(${r},${g},${b},${alpha})`;
}

// ═══════════════════════════════════════════════════════════════════════════
// STANDINGS
// ═══════════════════════════════════════════════════════════════════════════

function updateDriverOrder() {
  // Find each driver's position at current lap
  const posAtT = {};
  const lapRows = G.laps.filter(l => l.lap === G.currentLap);

  for (const row of lapRows) {
    if (row.position && !posAtT[row.driver]) {
      posAtT[row.driver] = {
        pos: row.position,
        compound: row.compound,
        tyre_life: row.tyre_life,
        lap_time: row.lap_time,
        stint: row.stint,
      };
    }
  }

  G.driverOrder = Object.keys(G.drivers).sort((a, b) => {
    const pa = posAtT[a]?.pos ?? 99;
    const pb = posAtT[b]?.pos ?? 99;
    return pa - pb;
  });

  // Store metadata for rendering
  G._posAtT = posAtT;
}

function renderStandings() {
  updateDriverOrder();
  const posAtT = G._posAtT || {};
  const list   = document.getElementById('standings-list');
  list.innerHTML = '';

  // Compute gaps — use lap time as delta if available
  const leaderLapTime = posAtT[G.driverOrder[0]]?.lap_time;

  G.driverOrder.forEach((num, idx) => {
    const driver = G.drivers[num];
    if (!driver) return;
    const meta    = posAtT[num] || {};
    const ds      = G.driverStatus[num] || {};
    const pos     = meta.pos || (idx + 1);
    const compound = (meta.compound || 'UNKNOWN').toUpperCase();
    const tireColor = TIRE_COLORS[compound] || '#555';
    const tyreLife  = meta.tyre_life ?? '—';

    // Status badge (DNS / DNF / RET / PIT)
    let statusBadge = '';
    let isRetired = false;
    if (ds.status === 'dns') {
      statusBadge = '<span class="dr-status-badge dns">DNS</span>';
      isRetired = true;
    } else if (ds.status === 'dnf') {
      // Show DNF only after the retirement lap
      if (ds.retirementLap != null && G.currentLap > ds.retirementLap) {
        statusBadge = '<span class="dr-status-badge dnf">DNF</span>';
        isRetired = true;
      }
    }

    // Pit lane start indicator (only on lap 1)
    let pitStartLabel = '';
    if (ds.pitStart && G.currentLap <= 1) {
      pitStartLabel = '<span class="dr-pit-start">PIT START</span>';
    }

    // Gap to leader
    let gapStr = '';
    if (isRetired) {
      gapStr = ds.status === 'dns' ? '—' : `LAP ${ds.retirementLap}`;
    } else if (idx === 0) {
      gapStr = meta.lap_time ? fmtLapTime(meta.lap_time) : 'LEADER';
    } else {
      const myTime  = meta.lap_time;
      if (leaderLapTime && myTime) {
        const delta = myTime - leaderLapTime;
        gapStr = delta > 0 ? `+${delta.toFixed(3)}` : fmtLapTime(myTime);
      } else {
        gapStr = `+${idx} LAP${idx > 1 ? 'S' : ''}`;
      }
    }

    const row = document.createElement('div');
    row.className = 'driver-row' + (isRetired ? ' retired' : '');
    row.dataset.driver = num;

    const posClass = pos === 1 ? 'dr-pos p1' : pos === 2 ? 'dr-pos p2' : pos === 3 ? 'dr-pos p3' : 'dr-pos';

    row.innerHTML = `
      <div class="${posClass}">${pos}</div>
      <div class="dr-color-bar" style="background:${driver.color}"></div>
      <div class="dr-number-badge" style="background:${driver.color}; color:${isLightColor(driver.color) ? '#000' : '#fff'}">
        ${driver.number}
      </div>
      <div class="dr-info">
        <div class="dr-abbr">${driver.abbr}${statusBadge}${pitStartLabel}</div>
        <div class="dr-team">${driver.team}</div>
      </div>
      <div class="dr-right">
        <div class="dr-gap">${gapStr}</div>
        <div class="dr-tire">
          <div class="tire-dot" style="background:${tireColor}"></div>
          <span class="tire-life">${tyreLife}L</span>
        </div>
      </div>
    `;

    list.appendChild(row);
  });
}

// ═══════════════════════════════════════════════════════════════════════════
// RACE INSIGHTS (curated story cards)
// ═══════════════════════════════════════════════════════════════════════════

// Hand-crafted from actual race data — each card links to a specific moment.
const RACE_INSIGHTS = [
  {
    icon: '🏆',
    title: 'Norris undercuts Piastri for the win',
    body: 'Piastri led for 34 laps but pitted first (lap 43). Norris came in a lap later, emerged P1 and held the gap to the flag — a textbook 1-2 for McLaren at their home race.',
    stat: 'Lap 44 · NOR gap <1 s',
    lap: 44,
    t: 5075,
    driverNum: '4',
  },
  {
    icon: '⚡',
    title: "Piastri's race fastest lap",
    body: "On lap 51 with fresh Mediums, Piastri threw everything at it — 1:29.337, the quickest lap of the entire race, 0.4 s faster than Norris' best.",
    stat: '1:29.337 · Lap 51 · Medium',
    lap: 51,
    t: 5658,
    driverNum: '81',
  },
  {
    icon: '🔝',
    title: "Hulkenberg: P16 → P3 podium",
    body: 'Hulkenberg pitted early on lap 9 to cover Stroll. He dropped to P16 as the field cycled through stops, then climbed steadily lap after lap to seal Haas\'s best result of the season.',
    stat: 'P16 on lap 10 → P3 finish',
    lap: 10,
    t: 1068,
    driverNum: '27',
  },
  {
    icon: '🔴',
    title: "Hamilton's Soft tire blitz at home",
    body: 'After pitting onto Softs on lap 41, Hamilton immediately ran sub-91 s laps for 11 consecutive laps, setting the 3rd fastest time of the race (1:30.016) in front of the Silverstone crowd.',
    stat: '1:30.016 · Lap 49 · Soft',
    lap: 41,
    t: 4812,
    driverNum: '44',
  },
  {
    icon: '🌧️',
    title: 'Wet-weather chaos reshuffles the grid',
    body: 'The first 8 laps featured VSC periods, yellow-flag sectors and shifting track conditions. Track status cycled through 6 different codes — forcing teams into opportunistic early pit calls.',
    stat: 'Laps 1–8 · VSC / Yellow flags',
    lap: 2,
    t: 128,
    driverNum: null,
  },
  {
    icon: '🎲',
    title: "Stroll's bold Soft gamble on lap 10",
    body: 'While most drivers were still on Intermediates, Stroll switched to Softs on lap 10 — a high-risk call that briefly launched him into the top 3. He recovered from P12 to finish P7.',
    stat: 'P12 → P7 · 4 stops',
    lap: 10,
    t: 1173,
    driverNum: '18',
  },
  {
    icon: '💥',
    title: "Antonelli's 4-stop nightmare",
    body: "The rookie pitted from P4 on only lap 2, switching to Hard tyres in wet conditions — an experiment that unravelled over the race. Four stops and P16 at the flag.",
    stat: 'P4 → P16 · 4 pit stops',
    lap: 2,
    t: 236,
    driverNum: '87',
  },
];

function renderRaceInsights() {
  const container = document.getElementById('race-insights-content');
  let html = '';

  for (const ins of RACE_INSIGHTS) {
    const color = ins.driverNum ? (G.drivers[ins.driverNum]?.color || '#888') : '#ffd700';
    html += `
      <div class="race-insight-card" data-t="${ins.t}">
        <div class="ric-header">
          <span class="ric-icon">${ins.icon}</span>
          <span class="ric-title" style="color:${color}">${ins.title}</span>
          <span class="ric-lap">L${ins.lap}</span>
        </div>
        <div class="ric-body">${ins.body}</div>
        <div class="ric-body"><span class="ric-stat">${ins.stat}</span></div>
        <div class="ric-seek-hint">▶ Jump to this moment</div>
      </div>
    `;
  }

  container.innerHTML = html;

  container.querySelectorAll('.race-insight-card').forEach(card => {
    card.addEventListener('click', () => {
      const t = parseFloat(card.dataset.t);
      seekToT(t);
      if (!G.playing) togglePlay();
    });
  });
}

// ═══════════════════════════════════════════════════════════════════════════
// LAP EVENTS PANEL (formerly "insights")
// ═══════════════════════════════════════════════════════════════════════════

let _lastEventLap = -1;

function renderEvents(lap) {
  if (lap === _lastEventLap) return;
  _lastEventLap = lap;

  const panel = document.getElementById('events-content');

  // Show current + last 2 laps
  const lapsToShow = [];
  for (let l = Math.max(1, lap - 2); l <= lap; l++) lapsToShow.push(l);

  let html = '';
  let hasContent = false;

  for (let i = lapsToShow.length - 1; i >= 0; i--) {
    const l = lapsToShow[i];
    const events = G.insights[String(l)];
    if (!events || !events.length) continue;
    hasContent = true;

    const isCurrentLap = l === lap;
    html += `<div class="insights-lap-header">${isCurrentLap ? '▶ ' : ''}LAP ${l}</div>`;

    for (const ev of events) {
      const colorBar = ev.color
        ? `<div class="insight-color-bar" style="background:${ev.color}"></div>`
        : '<div class="insight-color-bar" style="background:transparent"></div>';
      html += `
        <div class="insight-item ${ev.type}">
          <div class="insight-icon">${ev.icon}</div>
          <div class="insight-body">
            <div class="insight-title">${ev.title}</div>
            ${ev.detail ? `<div class="insight-detail">${ev.detail}</div>` : ''}
          </div>
          ${colorBar}
        </div>
      `;
    }
  }

  if (!hasContent) {
    html = '<div class="insights-empty">No notable events yet this lap</div>';
  }

  panel.innerHTML = html;
}

// ═══════════════════════════════════════════════════════════════════════════
// CONTROLS
// ═══════════════════════════════════════════════════════════════════════════

function bindControls() {
  // Play / Pause
  document.getElementById('btn-play').addEventListener('click', togglePlay);

  // Navigation
  document.getElementById('btn-prev-lap').addEventListener('click', () => jumpLap(-1));
  document.getElementById('btn-next-lap').addEventListener('click', () => jumpLap(+1));

  // Timeline scrubber
  const slider = document.getElementById('timeline');
  slider.addEventListener('input', () => {
    G.currentT = (slider.value / 1000) * G.maxT;
    G.trails = {};  // reset trails on manual seek
    for (const num in G.drivers) G.trails[num] = [];
  });

  // Speed buttons
  document.querySelectorAll('.speed-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      G.speed = parseFloat(btn.dataset.speed);
      document.querySelectorAll('.speed-btn').forEach(b => b.classList.remove('speed-active'));
      btn.classList.add('speed-active');
    });
  });

  // Toggles
  document.getElementById('toggle-trails').addEventListener('change', e => {
    G.showTrails = e.target.checked;
  });
  document.getElementById('toggle-labels').addEventListener('change', e => {
    G.showLabels = e.target.checked;
  });

  // Right sidebar tab switcher (Insights / Events)
  document.querySelectorAll('.panel-tab').forEach(tab => {
    tab.addEventListener('click', () => {
      document.querySelectorAll('.panel-tab').forEach(t => t.classList.remove('active'));
      tab.classList.add('active');
      const which = tab.dataset.tab;
      document.getElementById('race-insights-content').classList.toggle('hidden', which !== 'insights');
      document.getElementById('events-content').classList.toggle('hidden', which !== 'events');
    });
  });

  // Canvas hover tooltip
  G.canvas.addEventListener('mousemove', onCanvasHover);
  G.canvas.addEventListener('mouseleave', () => {
    document.getElementById('car-tooltip').classList.add('hidden');
  });

  // Keyboard shortcuts
  document.addEventListener('keydown', onKeyDown);

  // Mobile tab switcher
  bindMobileTabs();
}

function bindMobileTabs() {
  const tabs            = document.querySelectorAll('.mobile-tab');
  const standingsPanel  = document.querySelector('.standings-panel');
  const insightsPanel   = document.querySelector('.insights-panel');
  const insightsContent = document.getElementById('race-insights-content');
  const eventsContent   = document.getElementById('events-content');

  function activateTab(panelName) {
    tabs.forEach(t => t.classList.toggle('active', t.dataset.panel === panelName));

    // Top-level panel visibility
    standingsPanel.classList.toggle('mobile-active', panelName === 'standings');
    insightsPanel.classList.toggle('mobile-active', panelName === 'insights' || panelName === 'events');

    // Which content area is visible inside the insights panel
    if (panelName === 'insights' || panelName === 'events') {
      insightsContent.classList.toggle('hidden', panelName !== 'insights');
      eventsContent.classList.toggle('hidden', panelName !== 'events');
    }
  }

  tabs.forEach(tab => tab.addEventListener('click', () => activateTab(tab.dataset.panel)));

  activateTab('standings'); // default
}

function togglePlay() {
  G.playing = !G.playing;
  if (G.playing && G.currentT >= G.maxT) G.currentT = 0;
  updatePlayButton();
}

function updatePlayButton() {
  document.getElementById('btn-play').textContent = G.playing ? '⏸' : '▶';
}

function seekToT(t) {
  G.currentT = Math.max(0, Math.min(t, G.maxT));
  G.trails = {};
  for (const num in G.drivers) G.trails[num] = [];
}

function jumpLap(delta) {
  const target = Math.max(1, Math.min(G.totalLaps, G.currentLap + delta));
  const t = G.lapStartMap[target];
  if (t != null) seekToT(t);
}

function updateTimelineUI() {
  const frac = G.maxT > 0 ? G.currentT / G.maxT : 0;
  document.getElementById('timeline').value = Math.round(frac * 1000);
  document.getElementById('ctrl-time-cur').textContent  = fmtRaceTime(G.currentT);
  document.getElementById('hdr-race-time').textContent  = fmtRaceTime(G.currentT);
}

function buildLapMarkers() {
  const container = document.getElementById('timeline-lap-markers');
  container.innerHTML = '';
  for (const { lap, t } of G.lapStartTimes) {
    if (lap === 1) continue;
    const frac = G.maxT > 0 ? t / G.maxT : 0;
    const marker = document.createElement('div');
    marker.className = 'lap-marker';
    marker.style.left = (frac * 100) + '%';
    marker.title = `Lap ${lap}`;
    container.appendChild(marker);
  }
}

function onCanvasHover(e) {
  const rect   = G.canvas.getBoundingClientRect();
  const mx     = e.clientX - rect.left;
  const my     = e.clientY - rect.top;
  // mx/my are already in CSS pixels; G.toCanvas also returns CSS pixels
  const cx2    = mx;
  const cy2    = my;

  let closest = null, closestDist = Infinity;

  for (const num in G.drivers) {
    const ds = G.driverStatus[num];
    if (ds && ds.status === 'dns') continue;
    if (ds && ds.status === 'dnf' && ds.retirementLap != null) {
      const retLapT = G.lapStartMap[ds.retirementLap + 1] || G.lapStartMap[ds.retirementLap];
      if (retLapT != null && G.currentT > retLapT + 10) continue;
    }
    const pos = getPosition(num, G.currentT);
    if (!pos) continue;
    const [cx, cy] = G.toCanvas(pos.x, pos.y);
    const d = Math.hypot(cx - cx2, cy - cy2);
    if (d < closestDist) { closestDist = d; closest = num; }
  }

  const tooltip = document.getElementById('car-tooltip');
  if (closest && closestDist < 20) {
    const driver = G.drivers[closest];
    const meta   = G._posAtT?.[closest] || {};
    tooltip.classList.remove('hidden');
    tooltip.querySelector('.tooltip-driver').textContent = driver.abbr + ' — ' + driver.name;
    tooltip.querySelector('.tooltip-team').textContent   = driver.team;
    tooltip.querySelector('.tooltip-pos').textContent    = meta.pos ? `P${meta.pos}` : '';
    tooltip.style.left = (e.clientX - rect.left + 14) + 'px';
    tooltip.style.top  = (e.clientY - rect.top  - 10) + 'px';
  } else {
    tooltip.classList.add('hidden');
  }
}

function onKeyDown(e) {
  switch (e.code) {
    case 'Space': e.preventDefault(); togglePlay(); break;
    case 'ArrowLeft':
      e.preventDefault();
      if (e.shiftKey) jumpLap(-1);
      else seekToT(G.currentT - 5);
      break;
    case 'ArrowRight':
      e.preventDefault();
      if (e.shiftKey) jumpLap(+1);
      else seekToT(G.currentT + 5);
      break;
    case 'Home': e.preventDefault(); seekToT(0); break;
    case 'End':  e.preventDefault(); seekToT(G.maxT); break;
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// UTILITIES
// ═══════════════════════════════════════════════════════════════════════════

function fmtRaceTime(seconds) {
  if (!seconds || isNaN(seconds)) return '0:00:00';
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.floor(seconds % 60);
  return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}

function fmtLapTime(seconds) {
  if (!seconds || isNaN(seconds)) return '—';
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return `${m}:${s.toFixed(3).padStart(6, '0')}`;
}

function showApp() {
  document.getElementById('loading-screen').classList.add('hidden');
  document.getElementById('app').classList.remove('hidden');
}

// ═══════════════════════════════════════════════════════════════════════════
// BOOT
// ═══════════════════════════════════════════════════════════════════════════

init().catch(err => {
  document.getElementById('loading-msg').textContent = `Error: ${err.message}`;
  document.getElementById('loading-bar').style.background = '#BFFF4A';
  console.error('F1 Replay init error:', err);
});
