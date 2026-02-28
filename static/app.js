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

const TEAM_LOGO_MAP = {
  'Red Bull Racing': 'red-bull',
  'McLaren': 'mclaren',
  'Ferrari': 'ferrari',
  'Mercedes': 'mercedes',
  'Aston Martin': 'aston-martin',
  'Alpine': 'alpine',
  'Haas F1 Team': 'haas',
  'Racing Bulls': 'racing-bulls',
  'Williams': 'williams',
  'Kick Sauber': 'kick-sauber',
};

const TYRE_SVG_MAP = {
  SOFT: 'soft', MEDIUM: 'medium', HARD: 'hard',
  INTERMEDIATE: 'intermediate', WET: 'wet',
};

const DRIVER_RADIUS = 13;  // Car marker radius on canvas (base, scales with zoom)
const PADDING_FRAC  = 0.08; // Canvas padding as fraction

// Track rotation — matches the standard Silverstone map orientation (SVG reference)
// FastF1 circuit_info.rotation = 92°; rotating by -91° aligns the pit straight
// horizontally with S/F at the top, matching the canonical track layout.
// These defaults are for Silverstone; overridden from data.circuit_info if present.
let TRACK_ROT_COS = -0.01745;  // cos(-91°)
let TRACK_ROT_SIN = -0.99985;  // sin(-91°)

function rotatePoint(x, y) {
  return [
    x * TRACK_ROT_COS - y * TRACK_ROT_SIN,
    x * TRACK_ROT_SIN + y * TRACK_ROT_COS,
  ];
}

// Pit lane path (extracted from position telemetry during Hulkenberg's lap-9 pit stop)
// Includes full entry curve (diverging from track) through pit boxes to exit (rejoining track)
let PIT_LANE_PATH = [
  // Pit entry — diverging from main track towards pit lane
  [-496, -716],  [-906, -280],  [-1025, -155], [-1094, -81],
  [-1146, -26],  [-1231, 63],   [-1396, 238],  [-1442, 286],
  // Entry curve — the sharp turn into the pit lane
  [-1535, 388],  [-1584, 464],  [-1623, 598],  [-1625, 694],
  // Pit lane proper (running parallel to the main straight)
  [-1596, 813],  [-1499, 977],  [-1368, 1172], [-1228, 1381],
  [-1115, 1550], [-991, 1735],  [-861, 1930],  [-754, 2090],
  [-625, 2280],  [-495, 2474],  [-366, 2665],  [-251, 2835],
  [-116, 3036],  [-12, 3190],   [100, 3358],   [218, 3534],
  [273, 3614],
  // Pit exit — accelerating back onto the track
  [329, 3698],   [417, 3830],   [524, 3973],   [632, 4056],
  [748, 4113],   [911, 4154],   [1052, 4172],  [1240, 4195],
  [1479, 4225],  [1634, 4244],
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
  // (track is drawn directly each frame — no offscreen buffer)

  // Zoom & pan
  zoom: 1,       // 1 = fit-to-canvas, max 6
  panX: 0,       // pixel offset
  panY: 0,
  _dragging: false,
  _dragStartX: 0,
  _dragStartY: 0,
  _dragMoved: false,
  _pinchDist: 0, // for touch pinch-to-zoom

  // Follow driver
  followDriver: null,   // driver number string, or null
  followZoom: 3,        // zoom level when following
  _resettingZoom: false, // true while smoothly zooming back out

  // Options
  showLabels: true,

  // Trail history: { driverNum: [{cx, cy}] }

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
  setupZoomPan();
  bindControls();
  buildLapMarkers();
  buildEventMarkers();
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

  const dataUrl = window.__F1_DATA_URLS?.data || './data.json';
  const posUrl  = window.__F1_DATA_URLS?.positions || './positions.json';
  const [dataRes, posRes] = await Promise.all([
    fetch(dataUrl),
    fetch(posUrl),
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

  // Override circuit-specific constants from data if present
  if (data.circuit_info?.rotation != null) {
    const angle = -(data.circuit_info.rotation - 1);
    const rad = angle * Math.PI / 180;
    TRACK_ROT_COS = Math.cos(rad);
    TRACK_ROT_SIN = Math.sin(rad);
  }
  if (data.pit_lane_path?.length) {
    PIT_LANE_PATH = data.pit_lane_path;
  }

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
  document.getElementById('standings-lap-total').textContent = G.totalLaps;
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

  // Check which drivers had meaningful lap data (lap_time or position) on their first lap
  const hasLap1Data = new Set();
  for (const lap of G.laps) {
    if (lap.lap === 1 && (lap.lap_time || lap.position)) {
      hasLap1Data.add(lap.driver);
    }
  }

  for (const num in G.drivers) {
    const maxLap = maxLapByDriver[num] || 0;
    const status = { status: 'racing', retirementLap: null, pitStart: pitStartDrivers.has(num) };

    if (maxLap === 0) {
      // No laps at all = DNS
      status.status = 'dns';
    } else if (maxLap <= 1 && !hasLap1Data.has(num)) {
      // Listed for lap 1 but no timing data — check if car actually moved on track
      const pd = G.positions[num];
      let moved = false;
      if (pd && pd.x.length > 1) {
        const x0 = pd.x[0], y0 = pd.y[0];
        for (let i = Math.min(100, pd.x.length - 1); i > 0; i--) {
          const dx = pd.x[i] - x0, dy = pd.y[i] - y0;
          if (dx * dx + dy * dy > 1000000) { moved = true; break; } // > 1000 units from start
        }
      }
      if (moved) {
        // Car raced but DNF'd before completing lap 1 (e.g. Lawson crash)
        status.status = 'dnf';
        status.retirementLap = maxLap;
      } else {
        // Car never moved = true DNS (e.g. COL sitting in garage)
        status.status = 'dns';
      }
    } else if (maxLap < G.totalLaps) {
      // Fewer laps than total = DNF/RET
      status.status = 'dnf';
      status.retirementLap = maxLap;
    }

    G.driverStatus[num] = status;
  }

  // ── Pre-compute pit stop intervals ─────────────────────────────────────
  // Use pit_in / pit_out timestamps from lap data directly (position data
  // at ~2 Hz is too coarse to reliably detect the brief stationary window).
  G.pitStops = []; // [{ driver, tStart, tEnd, duration, boxStart, boxEnd, stopDuration }]

  const pitPending = {}; // { driverNum: { pitIn, stopDuration } }
  for (const lap of G.laps) {
    if (lap.pit_in != null) {
      pitPending[lap.driver] = { pitIn: lap.pit_in, stopDuration: lap.stop_duration };
    }
    if (lap.pit_out != null && pitPending[lap.driver] != null) {
      const pending = pitPending[lap.driver];
      const duration = lap.pit_out - pending.pitIn;
      const stopDur = pending.stopDuration || 0;
      // Approximate box timing: split remaining drive time equally for in/out
      const driveIn = (duration - stopDur) / 2;
      G.pitStops.push({
        driver: lap.driver,
        tStart: pending.pitIn,
        tEnd: lap.pit_out,
        duration: duration,
        boxStart: pending.pitIn + driveIn,
        boxEnd: pending.pitIn + driveIn + stopDur,
        stopDuration: stopDur,
      });
      delete pitPending[lap.driver];
    }
  }

  // ── Track normalisation ──────────────────────────────────────────────────
  computeTrackBounds();

  // ── Driver order init ────────────────────────────────────────────────────
  G.driverOrder = Object.keys(G.drivers);

  // Total time is shown in the player-time element via updateTimelineUI()
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
    // Fill the entire container (Google Maps-like behavior)
    const w = Math.round(rect.width);
    const h = Math.round(rect.height);
    // Physical pixel dimensions (retina-sharp)
    G.canvas.width  = Math.round(w * dpr);
    G.canvas.height = Math.round(h * dpr);
    // CSS display size
    G.canvas.style.width  = w + 'px';
    G.canvas.style.height = h + 'px';
    // Logical (CSS-pixel) size used by all coordinate math
    G.canvasW = w;
    G.canvasH = h;
    // Use setTransform instead of scale() so the matrix is always set to
    // exactly dpr — avoids accumulation if canvas.width didn't reset the
    // context (browsers may skip reset when the value is unchanged).
    G.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    buildToCanvasFn();
  }

  const ro = new ResizeObserver(resize);
  ro.observe(container);
  resize();
}

function buildToCanvasFn() {
  if (!G.trackBounds) {
    G.toCanvasBase = (x, y) => [G.canvasW / 2, G.canvasH / 2];
    G.toCanvas = G.toCanvasBase;
    return;
  }
  const { minX, maxX, minY, maxY } = G.trackBounds;
  const dataW = maxX - minX || 1;
  const dataH = maxY - minY || 1;
  const pad   = PADDING_FRAC;

  // Fit track within canvas preserving aspect ratio (uniform scale)
  const availW = G.canvasW * (1 - 2 * pad);
  const availH = G.canvasH * (1 - 2 * pad);
  const fitScale = Math.min(availW / dataW, availH / dataH);
  const offX = (G.canvasW - dataW * fitScale) / 2;
  const offY = (G.canvasH - dataH * fitScale) / 2;

  // Base transform: data coords → canvas pixels (no zoom/pan)
  G.toCanvasBase = function (x, y) {
    const [rx, ry] = rotatePoint(x, y);
    const cx = offX + (rx - minX) * fitScale;
    const cy = offY + (dataH - (ry - minY)) * fitScale;
    return [cx, cy];
  };

  // Full transform: data coords → zoomed/panned canvas pixels
  G.toCanvas = function (x, y) {
    const [cx, cy] = G.toCanvasBase(x, y);
    const zx = (cx - G.canvasW / 2) * G.zoom + G.canvasW / 2 + G.panX;
    const zy = (cy - G.canvasH / 2) * G.zoom + G.canvasH / 2 + G.panY;
    return [zx, zy];
  };
}

function drawTrack(ctx) {
  const tx = G.track.x, ty = G.track.y;
  if (!tx || tx.length < 2) return false;

  // Scale line widths proportionally to canvas size and zoom level
  const scale = Math.max(0.5, G.canvasW / 720) * G.zoom;
  const trackW   = Math.max(4, 6 * scale);
  const centerW  = Math.max(1, 1.2 * scale);
  const pitW     = Math.max(1, 2 * scale);

  // Helper: trace the full track path using smooth quadratic bezier curves
  // Each data point becomes a control point; endpoints are midpoints between them
  function tracePath() {
    ctx.beginPath();
    const pts = [];
    for (let i = 0; i < tx.length; i++) {
      pts.push(G.toCanvas(tx[i], ty[i]));
    }
    const n = pts.length;
    ctx.moveTo((pts[0][0] + pts[1][0]) / 2, (pts[0][1] + pts[1][1]) / 2);
    for (let i = 1; i < n - 1; i++) {
      const mx = (pts[i][0] + pts[i + 1][0]) / 2;
      const my = (pts[i][1] + pts[i + 1][1]) / 2;
      ctx.quadraticCurveTo(pts[i][0], pts[i][1], mx, my);
    }
    // Close: curve through last point back to start
    const mx1 = (pts[n - 1][0] + pts[0][0]) / 2;
    const my1 = (pts[n - 1][1] + pts[0][1]) / 2;
    ctx.quadraticCurveTo(pts[n - 1][0], pts[n - 1][1], mx1, my1);
    const mx2 = (pts[0][0] + pts[1][0]) / 2;
    const my2 = (pts[0][1] + pts[1][1]) / 2;
    ctx.quadraticCurveTo(pts[0][0], pts[0][1], mx2, my2);
    ctx.closePath();
  }

  // 1. Track surface — thick dark road
  tracePath();
  ctx.strokeStyle = '#272A35';
  ctx.lineWidth   = trackW;
  ctx.lineCap     = 'round';
  ctx.lineJoin    = 'round';
  ctx.stroke();

  // 2. Pit lane — thin single stroke, same color as track surface so it merges at endpoints
  if (PIT_LANE_PATH.length >= 3) {
    // Extend start/end points along entry/exit direction so they overlap with the main track
    const raw = PIT_LANE_PATH;
    const n = raw.length;
    const extAmt = 300; // extend in data-space units to reach well into the track
    // Start extension: direction from point[1] toward point[0], continue further
    const sdx = raw[0][0] - raw[1][0], sdy = raw[0][1] - raw[1][1];
    const slen = Math.sqrt(sdx * sdx + sdy * sdy) || 1;
    const startExt = [raw[0][0] + (sdx / slen) * extAmt, raw[0][1] + (sdy / slen) * extAmt];
    // End extension: direction from point[n-2] toward point[n-1], continue further
    const edx = raw[n-1][0] - raw[n-2][0], edy = raw[n-1][1] - raw[n-2][1];
    const elen = Math.sqrt(edx * edx + edy * edy) || 1;
    const endExt = [raw[n-1][0] + (edx / elen) * extAmt, raw[n-1][1] + (edy / elen) * extAmt];

    const extPath = [startExt, ...raw, endExt];
    const plPts = extPath.map(p => G.toCanvas(p[0], p[1]));

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
    ctx.lineWidth   = pitW;
    ctx.lineCap     = 'round';
    ctx.lineJoin    = 'round';
    ctx.stroke();
  }

  // 3. Center line — thin dark line on top for edge definition (covers both track + pit lane)
  tracePath();
  ctx.strokeStyle = '#0D0F13';
  ctx.lineWidth   = centerW;
  ctx.lineCap     = 'round';
  ctx.lineJoin    = 'round';
  ctx.stroke();

  // 4. Start/Finish checkerboard flag
  if (tx.length > 10) {
    const midIdx = Math.floor(tx.length * 0.02);
    const [sfx, sfy] = G.toCanvas(tx[midIdx], ty[midIdx]);
    ctx.save();

    // Calculate track direction angle from canvas coordinates
    const [sx2, sy2] = G.toCanvas(tx[midIdx + 2], ty[midIdx + 2]);
    const angle = Math.atan2(sy2 - sfy, sx2 - sfx);

    ctx.translate(sfx, sfy);
    ctx.rotate(angle);

    // Checkerboard dimensions (4 cols × 8 rows), scaled
    const cols = 4;
    const rows = 8;
    const cellSize = Math.max(1.5, 1.8 * scale);
    const boardW = cols * cellSize;
    const boardH = rows * cellSize;
    const borderW = Math.max(1.5, 1.8 * scale);

    // Dark border around the checkerboard
    ctx.fillStyle = '#0D0E12';
    ctx.fillRect(
      -boardW / 2 - borderW,
      -boardH / 2 - borderW,
      boardW + borderW * 2,
      boardH + borderW * 2
    );

    // Draw checkerboard cells
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        ctx.fillStyle = (r + c) % 2 === 0 ? '#FFFFFF' : '#000000';
        ctx.fillRect(
          -boardW / 2 + c * cellSize,
          -boardH / 2 + r * cellSize,
          cellSize,
          cellSize
        );
      }
    }

    ctx.restore();
  }

  // 5. "PIT" label
  if (PIT_LANE_PATH.length >= 3) {
    const pitMid = Math.floor(PIT_LANE_PATH.length / 2);
    const [pmx, pmy] = G.toCanvas(PIT_LANE_PATH[pitMid][0], PIT_LANE_PATH[pitMid][1]);
    const [pa, pb]   = G.toCanvas(PIT_LANE_PATH[pitMid - 1][0], PIT_LANE_PATH[pitMid - 1][1]);
    const [pc, pd]   = G.toCanvas(PIT_LANE_PATH[pitMid + 1][0], PIT_LANE_PATH[pitMid + 1][1]);
    const pdx = pc - pa, pdy = pd - pb;
    const plen = Math.sqrt(pdx * pdx + pdy * pdy) || 1;
    const nx = -pdy / plen, ny = pdx / plen;
    const labelDist = 8 + 4 * scale;
    const fontSize  = Math.max(7, Math.round(6 + 3 * scale));

    ctx.font      = `600 ${fontSize}px "Clash Display", sans-serif`;
    ctx.fillStyle = '#838aa5';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText('PIT', pmx + nx * labelDist, pmy + ny * labelDist);
  }

  return true;
}

// ═══════════════════════════════════════════════════════════════════════════
// ZOOM & PAN
// ═══════════════════════════════════════════════════════════════════════════

function stopFollowing() {
  if (G.followDriver) {
    G.followDriver = null;
    G._resettingZoom = true;
    renderStandings();
  }
}

function applyZoomPan() {
  buildToCanvasFn();
}

function setupZoomPan() {
  const canvas = G.canvas;

  // ── Mouse wheel → zoom (centered on cursor) ──
  canvas.addEventListener('wheel', (e) => {
    e.preventDefault();
    G._resettingZoom = false;

    if (G.followDriver) {
      // While following, wheel adjusts the follow zoom level
      const factor = e.deltaY < 0 ? 1.15 : 1 / 1.15;
      G.followZoom = Math.min(6, Math.max(1, G.followZoom * factor));
      return;
    }

    const rect = canvas.getBoundingClientRect();
    const mx = e.clientX - rect.left;
    const my = e.clientY - rect.top;

    const oldZoom = G.zoom;
    const factor = e.deltaY < 0 ? 1.15 : 1 / 1.15;
    G.zoom = Math.min(6, Math.max(1, G.zoom * factor));

    if (G.zoom === 1) {
      G.panX = 0;
      G.panY = 0;
    } else {
      const ratio = G.zoom / oldZoom;
      const cx = G.canvasW / 2;
      const cy = G.canvasH / 2;
      G.panX = (mx - cx) * (1 - ratio) + ratio * G.panX;
      G.panY = (my - cy) * (1 - ratio) + ratio * G.panY;
    }

    applyZoomPan();
  }, { passive: false });

  // ── Mouse drag → pan ──
  canvas.addEventListener('mousedown', (e) => {
    if (G.zoom <= 1) return;
    G._dragging = true;
    G._dragMoved = false;
    G._dragStartX = e.clientX;
    G._dragStartY = e.clientY;
  });

  window.addEventListener('mousemove', (e) => {
    if (!G._dragging) return;
    if (G.followDriver) return; // pan disabled while following
    const dx = e.clientX - G._dragStartX;
    const dy = e.clientY - G._dragStartY;
    if (Math.abs(dx) > 3 || Math.abs(dy) > 3) {
      G._dragMoved = true;
    }
    G.panX += dx;
    G.panY += dy;
    G._dragStartX = e.clientX;
    G._dragStartY = e.clientY;
    applyZoomPan();
  });

  window.addEventListener('mouseup', () => {
    if (G._dragging) {
      G._dragging = false;
    }
  });

  // ── Double-click → reset zoom ──
  canvas.addEventListener('dblclick', (e) => {
    e.preventDefault();
    if (G.followDriver) {
      // Reset follow zoom to default
      G.followZoom = 3;
      return;
    }
    G._resettingZoom = false;
    if (G.zoom !== 1) {
      G.zoom = 1;
      G.panX = 0;
      G.panY = 0;
      applyZoomPan();
    }
  });

  // ── Touch: drag to pan, pinch to zoom ──
  canvas.addEventListener('touchstart', (e) => {
    if (e.touches.length === 1 && G.zoom > 1) {
      G._dragging = true;
      G._dragMoved = false;
      G._dragStartX = e.touches[0].clientX;
      G._dragStartY = e.touches[0].clientY;
    } else if (e.touches.length === 2) {
      G._dragging = false;
      const dx = e.touches[0].clientX - e.touches[1].clientX;
      const dy = e.touches[0].clientY - e.touches[1].clientY;
      G._pinchDist = Math.hypot(dx, dy);
    }
  }, { passive: true });

  canvas.addEventListener('touchmove', (e) => {
    if (e.touches.length === 1 && G._dragging) {
      if (G.followDriver) { e.preventDefault(); return; } // pan disabled while following
      const dx = e.touches[0].clientX - G._dragStartX;
      const dy = e.touches[0].clientY - G._dragStartY;
      if (Math.abs(dx) > 3 || Math.abs(dy) > 3) {
        G._dragMoved = true;
      }
      G.panX += dx;
      G.panY += dy;
      G._dragStartX = e.touches[0].clientX;
      G._dragStartY = e.touches[0].clientY;
      applyZoomPan();
      e.preventDefault();
    } else if (e.touches.length === 2) {
      if (G.followDriver) { e.preventDefault(); return; } // pinch disabled while following
      const dx = e.touches[0].clientX - e.touches[1].clientX;
      const dy = e.touches[0].clientY - e.touches[1].clientY;
      const dist = Math.hypot(dx, dy);
      if (G._pinchDist > 0) {
        const rect = canvas.getBoundingClientRect();
        const mx = (e.touches[0].clientX + e.touches[1].clientX) / 2 - rect.left;
        const my = (e.touches[0].clientY + e.touches[1].clientY) / 2 - rect.top;
        const oldZoom = G.zoom;
        G.zoom = Math.min(6, Math.max(1, G.zoom * (dist / G._pinchDist)));
        if (G.zoom === 1) {
          G.panX = 0; G.panY = 0;
        } else {
          const ratio = G.zoom / oldZoom;
          const cx = G.canvasW / 2;
          const cy = G.canvasH / 2;
          G.panX = (mx - cx) * (1 - ratio) + ratio * G.panX;
          G.panY = (my - cy) * (1 - ratio) + ratio * G.panY;
        }
        applyZoomPan();
      }
      G._pinchDist = dist;
      e.preventDefault();
    }
  }, { passive: false });

  canvas.addEventListener('touchend', () => {
    G._dragging = false;
    G._pinchDist = 0;
  });
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

/**
 * Returns interpolated telemetry for a given driver at time t.
 * Continuous values (speed, rpm, throttle) are linearly interpolated.
 * Discrete values (brake, gear, drs) use nearest-neighbor.
 */
function getTelemetry(driverNum, t) {
  const pd = G.positions[driverNum];
  if (!pd || !pd.speed || !pd.speed.length) return null;

  const idx = bisect(pd.t, t);
  const near = idx === 0 ? 0
    : idx >= pd.t.length ? pd.t.length - 1
    : (t - pd.t[idx - 1] <= pd.t[idx] - t ? idx - 1 : idx);

  if (idx === 0 || idx >= pd.t.length) {
    const i = idx === 0 ? 0 : pd.t.length - 1;
    return {
      speed: pd.speed[i], rpm: pd.rpm[i], throttle: pd.throttle[i],
      brake: pd.brake[i], gear: pd.gear[i], drs: pd.drs[i],
    };
  }

  const t0 = pd.t[idx - 1], t1 = pd.t[idx];
  const f = t1 === t0 ? 0 : (t - t0) / (t1 - t0);
  const lerp = (a, b) => a + f * (b - a);

  return {
    speed: lerp(pd.speed[idx - 1], pd.speed[idx]),
    rpm: lerp(pd.rpm[idx - 1], pd.rpm[idx]),
    throttle: lerp(pd.throttle[idx - 1], pd.throttle[idx]),
    brake: lerp(pd.brake[idx - 1], pd.brake[idx]),
    gear: pd.gear[near],
    drs: pd.drs[near],
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
    document.getElementById('standings-lap-cur').textContent = lap;
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

  // Follow driver — smoothly zoom & pan to center on them
  // At followZoom=1, show normal full-track view (no pan offset)
  if (G.followDriver) {
    const fpos = getPosition(G.followDriver, G.currentT);
    if (fpos) {
      const [baseCx, baseCy] = G.toCanvasBase(fpos.x, fpos.y);
      const targetZoom = G.followZoom;
      // Blend between driver-centered pan and default view (0,0) based on zoom
      // At zoom=1 → fully default view; at zoom>=2 → fully driver-centered
      const followBlend = Math.min(1, (targetZoom - 1));
      const driverPanX = -(baseCx - W / 2) * targetZoom;
      const driverPanY = -(baseCy - H / 2) * targetZoom;
      const targetPanX = driverPanX * followBlend;
      const targetPanY = driverPanY * followBlend;
      const lerp = 0.08;
      G.zoom = G.zoom + (targetZoom - G.zoom) * lerp;
      G.panX = G.panX + (targetPanX - G.panX) * lerp;
      G.panY = G.panY + (targetPanY - G.panY) * lerp;
      buildToCanvasFn();
    }
  } else if (G._resettingZoom) {
    // Smooth zoom-out back to default
    const lerp = 0.1;
    G.zoom = G.zoom + (1 - G.zoom) * lerp;
    G.panX = G.panX + (0 - G.panX) * lerp;
    G.panY = G.panY + (0 - G.panY) * lerp;
    // Snap when close enough
    if (Math.abs(G.zoom - 1) < 0.01) {
      G.zoom = 1;
      G.panX = 0;
      G.panY = 0;
      G._resettingZoom = false;
    }
    buildToCanvasFn();
  }

  // Draw track directly (no offscreen buffer — avoids clipping when zoomed)
  if (!drawTrack(ctx)) {
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

  // Draw cars — followed driver rendered last (on top)
  if (G.followDriver) {
    for (const { num, cx, cy } of carData) {
      if (num === G.followDriver) continue;
      drawCar(ctx, num, cx, cy);
    }
    const fd = carData.find(c => c.num === G.followDriver);
    if (fd) drawCar(ctx, fd.num, fd.cx, fd.cy);
  } else {
    for (const { num, cx, cy } of carData) {
      drawCar(ctx, num, cx, cy);
    }
  }

  // Draw pit stop timers above cars currently in pit
  for (const ps of G.pitStops) {
    if (G.currentT >= ps.tStart && G.currentT <= ps.tEnd + 1.5) {
      const car = carData.find(c => c.num === ps.driver);
      if (!car) continue;
      const elapsed = Math.min(G.currentT - ps.tStart, ps.duration);
      const finished = G.currentT > ps.tEnd;
      // Box phase: compute box elapsed time
      const inBox = G.currentT >= ps.boxStart;
      const boxElapsed = inBox ? Math.min(G.currentT - ps.boxStart, ps.stopDuration) : 0;
      const boxFinished = G.currentT > ps.boxEnd;
      drawPitTimer(ctx, car.cx, car.cy, elapsed, finished, inBox, boxElapsed, ps.stopDuration, boxFinished, G.drivers[ps.driver]);
    }
  }

  // Update driver order (for standings) based on position at current time
  updateDriverOrder();

  // Update telemetry panel when following a driver
  updateTelemetryPanel();

}

function drawCar(ctx, num, cx, cy) {
  const driver = G.drivers[num];
  if (!driver) return;
  const color = driver.color || '#888';
  // Scale radius with zoom — grows but not 1:1 (pow 0.4 gives a nice feel)
  // On small screens (mobile), use a smaller base so circles don't obscure the track
  const baseR = G.canvasW < 500 ? 9 : DRIVER_RADIUS;
  const r = baseR * Math.pow(G.zoom, 0.4);

  ctx.save();

  // Circle fill
  ctx.beginPath();
  ctx.arc(cx, cy, r, 0, Math.PI * 2);
  ctx.fillStyle = color;
  ctx.fill();

  // Team-color border (scaled 2px at 0.15 opacity)
  ctx.beginPath();
  ctx.arc(cx, cy, r, 0, Math.PI * 2);
  ctx.strokeStyle = hexAlpha(color, 0.15);
  ctx.lineWidth   = Math.max(1.5, 2 * Math.pow(G.zoom, 0.6));
  ctx.stroke();

  ctx.restore();

  // Abbreviation inside
  if (G.showLabels) {
    ctx.save();
    ctx.font         = `600 ${Math.floor(r * 0.72)}px "Clash Display", sans-serif`;
    ctx.fillStyle    = '#000';
    ctx.textAlign    = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(driver.abbr.slice(0, 3), cx, cy + 0.5);
    ctx.restore();
  }
}

function drawPitTimer(ctx, cx, cy, elapsed, finished, inBox, boxElapsed, stopDuration, boxFinished, driver) {
  const color  = driver?.color || '#888';
  const radius = 4;
  const padH   = 6;
  const barW   = 3;

  ctx.save();
  ctx.font = 'bold 11px "JetBrains Mono", monospace';

  // Build lines to display
  const pitStr = elapsed.toFixed(1) + 's';
  const showBox = inBox && stopDuration > 0;
  const boxStr = showBox ? ('BOX ' + boxElapsed.toFixed(1) + 's') : '';

  // Measure widths for the widest line
  const pitW = ctx.measureText(pitStr).width;
  const boxW_text = showBox ? ctx.measureText(boxStr).width : 0;
  const contentW = Math.max(pitW, boxW_text);

  const boxW = barW + contentW + padH * 2;
  const lineH = 16;
  const boxH = showBox ? lineH * 2 : lineH;

  // Position above the car
  const boxX = cx;
  const boxY = cy - DRIVER_RADIUS * Math.pow(G.zoom, 0.4) - 22 - (showBox ? lineH / 2 : 0);
  const x0 = boxX - boxW / 2;
  const y0 = boxY - boxH / 2;

  // Background rounded rect
  ctx.beginPath();
  ctx.moveTo(x0 + radius, y0);
  ctx.lineTo(x0 + boxW - radius, y0);
  ctx.arcTo(x0 + boxW, y0, x0 + boxW, y0 + radius, radius);
  ctx.lineTo(x0 + boxW, y0 + boxH - radius);
  ctx.arcTo(x0 + boxW, y0 + boxH, x0 + boxW - radius, y0 + boxH, radius);
  ctx.lineTo(x0 + radius, y0 + boxH);
  ctx.arcTo(x0, y0 + boxH, x0, y0 + boxH - radius, radius);
  ctx.lineTo(x0, y0 + radius);
  ctx.arcTo(x0, y0, x0 + radius, y0, radius);
  ctx.closePath();
  ctx.fillStyle = 'rgba(0, 0, 0, 0.85)';
  ctx.fill();

  // Team color accent bar on left
  ctx.fillStyle = color;
  ctx.beginPath();
  ctx.moveTo(x0 + radius, y0);
  ctx.lineTo(x0 + barW + 1, y0);
  ctx.lineTo(x0 + barW + 1, y0 + boxH);
  ctx.lineTo(x0 + radius, y0 + boxH);
  ctx.arcTo(x0, y0 + boxH, x0, y0 + boxH - radius, radius);
  ctx.lineTo(x0, y0 + radius);
  ctx.arcTo(x0, y0, x0 + radius, y0, radius);
  ctx.closePath();
  ctx.fill();

  // Pit lane time (top line)
  const textCx = x0 + barW + padH + contentW / 2;
  ctx.font         = 'bold 11px "JetBrains Mono", monospace';
  ctx.textAlign    = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillStyle    = finished ? '#2EE86B' : '#FFFFFF';
  ctx.fillText(pitStr, textCx, y0 + lineH / 2);

  // Box time (bottom line, shown during/after box phase)
  if (showBox) {
    ctx.fillStyle = boxFinished ? '#2EE86B' : '#FFCC00';
    ctx.fillText(boxStr, textCx, y0 + lineH + lineH / 2);
  }

  // Small pointer triangle pointing down to the car
  ctx.beginPath();
  ctx.moveTo(boxX - 4, y0 + boxH);
  ctx.lineTo(boxX + 4, y0 + boxH);
  ctx.lineTo(boxX, y0 + boxH + 5);
  ctx.closePath();
  ctx.fillStyle = 'rgba(0, 0, 0, 0.85)';
  ctx.fill();

  ctx.restore();
}

// ── Telemetry gauge (shown in follow mode) ──────────────────────────────

function drawTelemetryGauge(ctx, W, H, tel, driver) {
  const R = 80;             // gauge radius
  const cx = R + 16;        // center x (bottom-left)
  const cy = H - R - 16;    // center y
  const color = driver?.color || '#888';

  ctx.save();

  // ── Background circle ──
  ctx.beginPath();
  ctx.arc(cx, cy, R, 0, Math.PI * 2);
  ctx.fillStyle = 'rgba(0, 0, 0, 0.8)';
  ctx.fill();
  ctx.lineWidth = 1.5;
  ctx.strokeStyle = 'rgba(255,255,255,0.12)';
  ctx.stroke();

  // ── Speed tick marks & arc ──
  // Arc spans from 150° (bottom-left) to 390° (bottom-right) = 240° range
  const arcStart = (150 * Math.PI) / 180;
  const arcSpan  = (240 * Math.PI) / 180;
  const maxSpeed = 360;
  const ticks = [0, 60, 120, 180, 240, 300, 360];
  const tickR = R - 6;
  const tickLen = 6;

  ctx.lineWidth = 1;
  ctx.strokeStyle = 'rgba(255,255,255,0.2)';
  ctx.font = '7px "JetBrains Mono", monospace';
  ctx.fillStyle = 'rgba(255,255,255,0.3)';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';

  for (const spd of ticks) {
    const frac = spd / maxSpeed;
    const angle = arcStart + frac * arcSpan;
    const cos = Math.cos(angle), sin = Math.sin(angle);
    ctx.beginPath();
    ctx.moveTo(cx + cos * (tickR - tickLen), cy + sin * (tickR - tickLen));
    ctx.lineTo(cx + cos * tickR, cy + sin * tickR);
    ctx.stroke();
    // Label
    const lr = tickR + 8;
    ctx.fillText(String(spd), cx + cos * lr, cy + sin * lr);
  }

  // Speed arc (colored segment showing current speed)
  const speedFrac = Math.min(tel.speed / maxSpeed, 1);
  const speedEnd = arcStart + speedFrac * arcSpan;
  ctx.beginPath();
  ctx.arc(cx, cy, tickR - 3, arcStart, speedEnd);
  ctx.lineWidth = 3;
  ctx.strokeStyle = color;
  ctx.lineCap = 'round';
  ctx.stroke();
  ctx.lineCap = 'butt';

  // ── Throttle arc (left side) ──
  // Arc from 240° down to 150° (counter-clockwise on left)
  const thrStart = (240 * Math.PI) / 180;
  const thrSpan  = (90 * Math.PI) / 180;
  const thrFrac  = Math.min(tel.throttle / 100, 1);
  const barR = R - 18;

  // Background track
  ctx.beginPath();
  ctx.arc(cx, cy, barR, thrStart - thrSpan, thrStart);
  ctx.lineWidth = 5;
  ctx.strokeStyle = 'rgba(255,255,255,0.06)';
  ctx.stroke();

  // Filled portion
  if (thrFrac > 0.01) {
    ctx.beginPath();
    ctx.arc(cx, cy, barR, thrStart - thrFrac * thrSpan, thrStart);
    ctx.lineWidth = 5;
    ctx.strokeStyle = '#3B82F6';
    ctx.stroke();
  }

  // "THROTTLE" label
  ctx.save();
  ctx.translate(cx, cy);
  ctx.rotate((-195 * Math.PI) / 180);
  ctx.font = 'bold 5.5px "JetBrains Mono", monospace';
  ctx.fillStyle = 'rgba(255,255,255,0.25)';
  ctx.textAlign = 'center';
  const thrLabel = 'THROTTLE';
  for (let i = 0; i < thrLabel.length; i++) {
    const charAngle = ((i - thrLabel.length / 2 + 0.5) * 6.5 * Math.PI) / 180;
    ctx.save();
    ctx.rotate(charAngle);
    ctx.fillText(thrLabel[i], 0, -(barR + 5));
    ctx.restore();
  }
  ctx.restore();

  // ── Brake arc (right side) ──
  // Arc from -60° (300°) down to 30° (going clockwise on right)
  const brkStart = (-60 * Math.PI) / 180;
  const brkSpan  = (90 * Math.PI) / 180;

  // Background track
  ctx.beginPath();
  ctx.arc(cx, cy, barR, brkStart, brkStart + brkSpan);
  ctx.lineWidth = 5;
  ctx.strokeStyle = 'rgba(255,255,255,0.06)';
  ctx.stroke();

  // Filled when braking
  if (tel.brake) {
    ctx.beginPath();
    ctx.arc(cx, cy, barR, brkStart, brkStart + brkSpan);
    ctx.lineWidth = 5;
    ctx.strokeStyle = '#EF4444';
    ctx.stroke();
  }

  // "BRAKE" label
  ctx.save();
  ctx.translate(cx, cy);
  ctx.rotate((-15 * Math.PI) / 180);
  ctx.font = 'bold 5.5px "JetBrains Mono", monospace';
  ctx.fillStyle = 'rgba(255,255,255,0.25)';
  ctx.textAlign = 'center';
  const brkLabel = 'BRAKE';
  for (let i = 0; i < brkLabel.length; i++) {
    const charAngle = ((i - brkLabel.length / 2 + 0.5) * 7.5 * Math.PI) / 180;
    ctx.save();
    ctx.rotate(charAngle);
    ctx.fillText(brkLabel[i], 0, -(barR + 5));
    ctx.restore();
  }
  ctx.restore();

  // ── Center text ──
  ctx.textAlign    = 'center';
  ctx.textBaseline = 'middle';

  // Speed (large)
  ctx.font      = 'bold 28px "JetBrains Mono", monospace';
  ctx.fillStyle = '#FFFFFF';
  ctx.fillText(Math.round(tel.speed), cx, cy - 12);

  // "KMH"
  ctx.font      = 'bold 8px "JetBrains Mono", monospace';
  ctx.fillStyle = 'rgba(255,255,255,0.4)';
  ctx.fillText('KMH', cx, cy + 5);

  // RPM
  ctx.font      = 'bold 13px "JetBrains Mono", monospace';
  ctx.fillStyle = 'rgba(255,255,255,0.7)';
  ctx.fillText(Math.round(tel.rpm), cx, cy + 20);

  // "RPM"
  ctx.font      = 'bold 7px "JetBrains Mono", monospace';
  ctx.fillStyle = 'rgba(255,255,255,0.3)';
  ctx.fillText('RPM', cx, cy + 31);

  // ── DRS indicator ──
  const drsActive = tel.drs >= 10;
  const drsX = cx - 14;
  const drsY = cy + 40;
  const drsW = 28, drsH = 12;
  ctx.strokeStyle = drsActive ? '#2EE86B' : 'rgba(255,255,255,0.15)';
  ctx.lineWidth = 1.5;
  ctx.strokeRect(drsX, drsY, drsW, drsH);
  if (drsActive) {
    ctx.fillStyle = 'rgba(46, 232, 107, 0.15)';
    ctx.fillRect(drsX, drsY, drsW, drsH);
  }
  ctx.font      = 'bold 8px "JetBrains Mono", monospace';
  ctx.fillStyle = drsActive ? '#2EE86B' : 'rgba(255,255,255,0.25)';
  ctx.textAlign = 'center';
  ctx.fillText('DRS', cx, drsY + drsH / 2 + 1);

  // ── Gear ──
  ctx.font      = 'bold 7px "JetBrains Mono", monospace';
  ctx.fillStyle = 'rgba(255,255,255,0.3)';
  ctx.fillText('GEAR', cx - 10, cy + 60);
  ctx.font      = 'bold 14px "JetBrains Mono", monospace';
  ctx.fillStyle = '#FFFFFF';
  ctx.fillText(tel.gear, cx + 12, cy + 60);

  ctx.restore();
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

// ── Telemetry panel (DOM-based, replaces canvas gauge) ───────────────────

let _telPanelDriver = null; // track which driver the panel is set up for

function updateTelemetryPanel() {
  const panel = document.getElementById('telemetry-panel');
  if (!panel) return;

  const trackSection = document.querySelector('.track-section');

  if (!G.followDriver) {
    panel.classList.add('hidden');
    if (trackSection) trackSection.classList.remove('tel-active');
    _telPanelDriver = null;
    return;
  }

  const driver = G.drivers[G.followDriver];
  if (!driver) { panel.classList.add('hidden'); if (trackSection) trackSection.classList.remove('tel-active'); return; }

  const telem = getTelemetry(G.followDriver, G.currentT);
  if (!telem) { panel.classList.add('hidden'); if (trackSection) trackSection.classList.remove('tel-active'); return; }

  panel.classList.remove('hidden');
  if (trackSection) trackSection.classList.add('tel-active');

  const color = driver.color || '#888';

  // Update driver info only when the followed driver changes
  if (_telPanelDriver !== G.followDriver) {
    _telPanelDriver = G.followDriver;

    // Header gradient background
    const header = document.getElementById('tel-header');
    header.style.background = `linear-gradient(to right, ${hexAlpha(color, 0.15)}, ${hexAlpha(color, 0.08)}), #0d0e12`;

    // Team logo
    const teamSlug = TEAM_LOGO_MAP[driver.team] || '';
    const logoEl = document.getElementById('tel-team-logo');
    logoEl.src = teamSlug ? `assets/teams/${teamSlug}.svg` : '';
    logoEl.style.display = teamSlug ? '' : 'none';

    // Driver name (last name only)
    const nameEl = document.getElementById('tel-driver-name');
    const parts = driver.name.split(' ');
    nameEl.textContent = parts.length > 1 ? parts[parts.length - 1] : driver.name;
    // Capitalize properly (data has "VERSTAPPEN" → "Verstappen")
    nameEl.textContent = nameEl.textContent.charAt(0).toUpperCase()
      + nameEl.textContent.slice(1).toLowerCase();

    // Driver photo
    const photoEl = document.getElementById('tel-driver-photo');
    photoEl.src = `assets/drivers-hd/${driver.abbr}.png`;

    // Speed indicator colors (team color)
    document.getElementById('tel-speed-fill').style.background = color;
    document.getElementById('tel-speed-fill').parentElement.style.background = hexAlpha(color, 0.15);
  }

  // Update live values every frame
  const speed = Math.round(telem.speed);
  const rpm = Math.round(telem.rpm);
  const brakeOn = telem.brake >= 0.5;
  const throttlePct = Math.min(telem.throttle / 100, 1);
  const drsActive = telem.drs >= 10;

  document.getElementById('tel-speed').textContent = speed;
  document.getElementById('tel-rpm').textContent = rpm;

  // DRS state
  const drsEl = document.getElementById('tel-drs');
  drsEl.classList.toggle('active', drsActive);

  // Speed indicator
  const maxSpeed = 360;
  document.getElementById('tel-speed-fill').style.width = Math.min(speed / maxSpeed * 100, 100) + '%';

  // RPM dual indicators: throttle (blue) + brake (red)
  const throttleFill = document.getElementById('tel-throttle-fill');
  const brakeFill = document.getElementById('tel-brake-fill');
  // Throttle: inner fill proportional to throttle %
  throttleFill.style.background = throttlePct > 0.01
    ? `linear-gradient(to right, #3d83ea ${throttlePct * 100}%, rgba(61,131,234,0.15) ${throttlePct * 100}%)`
    : 'rgba(61,131,234,0.15)';
  // Brake: solid fill when braking, dim track when not
  brakeFill.style.background = brakeOn ? '#e02c59' : 'rgba(224,44,89,0.15)';

  // Gear sliding animation
  const gear = telem.gear;
  const strip = document.getElementById('tel-gear-strip');
  if (strip) {
    const gearNum = strip.querySelector('.tel-gear-num');
    const gearWidth = gearNum ? gearNum.offsetWidth : 20;
    const windowWidth = strip.parentElement ? strip.parentElement.offsetWidth : 56;
    const offset = -(gear * gearWidth) + (windowWidth / 2 - gearWidth / 2);
    strip.style.transform = `translateX(${offset}px)`;
    // Update active gear highlight
    const nums = strip.querySelectorAll('.tel-gear-num');
    for (let i = 0; i < nums.length; i++) {
      nums[i].classList.toggle('active', i === gear);
    }
  }
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

  // Update lap counter in header
  document.getElementById('standings-lap-cur').textContent = G.currentLap || '—';

  // Compute gaps — use lap time as delta if available
  const leaderLapTime = posAtT[G.driverOrder[0]]?.lap_time;

  // Build a map of existing rows keyed by driver number for reuse
  const existingRows = {};
  for (const row of Array.from(list.children)) {
    existingRows[row.dataset.driver] = row;
  }

  // Build ordered list of rows, reusing existing DOM elements
  const orderedRows = [];

  G.driverOrder.forEach((num, idx) => {
    const driver = G.drivers[num];
    if (!driver) return;
    const meta    = posAtT[num] || {};
    const ds      = G.driverStatus[num] || {};
    const pos     = meta.pos || (idx + 1);
    const compound = (meta.compound || 'UNKNOWN').toUpperCase();

    // Status (DNS / DNF)
    let isRetired = false;
    let statusHtml = '';
    if (ds.status === 'dns') {
      statusHtml = '<span class="dr-status-badge dns">DNS</span>';
      isRetired = true;
    } else if (ds.status === 'dnf') {
      if (ds.retirementLap != null && G.currentLap > ds.retirementLap) {
        statusHtml = '<span class="dr-status-badge dnf">DNF</span>';
        isRetired = true;
      }
    }

    // Pit lane start (show as PIT badge on lap 1)
    if (ds.pitStart && G.currentLap <= 1) {
      statusHtml = '<span class="dr-status-badge pit">PIT</span>';
    }

    // Currently in pit (active pit stop)
    const inPitNow = !isRetired && G.pitStops.some(ps => ps.driver === num && G.currentT >= ps.tStart && G.currentT <= ps.tEnd);
    if (inPitNow) {
      statusHtml = '<span class="dr-status-badge pit">PIT</span>';
    }

    // Gap to leader
    let gapHtml = '';
    if (isRetired) {
      gapHtml = statusHtml;
    } else if (inPitNow) {
      gapHtml = statusHtml;
    } else if (ds.pitStart && G.currentLap <= 1) {
      gapHtml = statusHtml;
    } else if (idx === 0) {
      gapHtml = '<span class="dr-gap-label">Leader</span>';
    } else {
      const myTime = meta.lap_time;
      if (leaderLapTime && myTime) {
        const delta = myTime - leaderLapTime;
        gapHtml = delta > 0 ? `+${delta.toFixed(3)}` : '+0.000';
      } else {
        gapHtml = '<span class="dr-gap-label">—</span>';
      }
    }

    // Tyre SVG
    const tyreSvg = TYRE_SVG_MAP[compound] || 'soft';
    const tyreImgSrc = `assets/tyres/${tyreSvg}.svg`;

    // Team color bar + logo
    const teamColor = driver.color || '#555';
    const teamSlug = TEAM_LOGO_MAP[driver.team] || '';
    const teamLogoSrc = teamSlug ? `assets/teams/${teamSlug}.svg` : '';

    const wantClass = 'driver-row' + (isRetired ? ' retired' : '') + (num === G.followDriver ? ' following' : '');

    let row = existingRows[num];
    if (row) {
      // Reuse existing row — patch only what changed
      if (row.className !== wantClass) row.className = wantClass;

      // Position number + color bar
      const posEl = row.querySelector('.dr-pos');
      const posText = posEl.firstChild;
      if (posText.nodeType === 3) {
        const trimmed = posText.textContent.trim();
        if (trimmed !== String(pos)) posText.textContent = '\n        ' + pos + '\n        ';
      }

      // Gap
      const gapEl = row.querySelector('.dr-gap');
      if (gapEl.innerHTML !== gapHtml) gapEl.innerHTML = gapHtml;

      // Tyre
      const tyreImg = row.querySelector('.dr-tyre img');
      if (tyreImg && tyreImg.getAttribute('src') !== tyreImgSrc) {
        tyreImg.src = tyreImgSrc;
        tyreImg.alt = compound;
      }

      delete existingRows[num];
    } else {
      // Create new row (first render or new driver)
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
    }

    orderedRows.push(row);
  });

  // Remove rows for drivers no longer in the order
  for (const num in existingRows) {
    existingRows[num].remove();
  }

  // Reorder DOM to match current standings (only moves what changed)
  orderedRows.forEach((row, i) => {
    if (list.children[i] !== row) {
      list.insertBefore(row, list.children[i] || null);
    }
  });
}

// ═══════════════════════════════════════════════════════════════════════════
// RACE INSIGHTS (curated story cards)
// ═══════════════════════════════════════════════════════════════════════════

// Hand-crafted from actual race data — each card links to a specific moment.
const RACE_INSIGHTS = [
  {
    title: 'Norris undercuts Piastri for the win',
    body: 'Piastri led for 34 laps but pitted first (lap 43). Norris came in a lap later, emerged P1 and held the gap to the flag — a textbook 1-2 for McLaren at their home race.',
    lap: 44,
    t: 5075,
    drivers: ['4', '81'],
  },
  {
    title: "Piastri's race fastest lap",
    body: "On lap 51 with fresh Mediums, Piastri threw everything at it — 1:29.337, the quickest lap of the entire race, 0.4 s faster than Norris' best.",
    lap: 51,
    t: 5658,
    drivers: ['81'],
  },
  {
    title: "Hulkenberg: P16 → P3 podium",
    body: 'Hulkenberg pitted early on lap 9 to cover Stroll. He dropped to P16 as the field cycled through stops, then climbed steadily lap after lap to seal Haas\'s best result of the season.',
    lap: 10,
    t: 1068,
    drivers: ['27'],
  },
  {
    title: "Hamilton's Soft tire blitz at home",
    body: 'After pitting onto Softs on lap 41, Hamilton immediately ran sub-91 s laps for 11 consecutive laps, setting the 3rd fastest time of the race (1:30.016) in front of the Silverstone crowd.',
    lap: 41,
    t: 4812,
    drivers: ['44'],
    compound: 'SOFT',
  },
  {
    title: 'Wet-weather chaos reshuffles the grid',
    body: 'The first 8 laps featured VSC periods, yellow-flag sectors and shifting track conditions. Track status cycled through 6 different codes — forcing teams into opportunistic early pit calls.',
    lap: 2,
    t: 128,
    drivers: [],
    icon: 'weather',
  },
  {
    title: "Stroll's bold Soft gamble on lap 10",
    body: 'While most drivers were still on Intermediates, Stroll switched to Softs on lap 10 — a high-risk call that briefly launched him into the top 3. He recovered from P12 to finish P7.',
    lap: 10,
    t: 1173,
    drivers: ['18'],
  },
  {
    title: "Antonelli's 4-stop nightmare",
    body: "The rookie pitted from P4 on only lap 2, switching to Hard tyres in wet conditions — an experiment that unravelled over the race. Four stops and P16 at the flag.",
    lap: 2,
    t: 236,
    drivers: ['12'],
  },
];

const WEATHER_SVG = '<svg viewBox="0 0 20 20" fill="none" xmlns="http://www.w3.org/2000/svg"><path d="M7.917 1.667c-2.992 0-5.417 2.425-5.417 5.416 0 2.992 2.425 5.417 5.417 5.417h5.416c2.301 0 4.167-1.866 4.167-4.167s-1.866-4.166-4.167-4.166c-.19 0-.378.012-.562.037a.356.356 0 01-.355-.137C11.446 2.621 9.793 1.667 7.917 1.667z" fill="#47C8FF"/><path d="M6.162 15.373a.833.833 0 00-1.49-.746l-.834 1.667a.833.833 0 001.49.746l.834-1.667zM10.329 15.373a.833.833 0 00-1.49-.746l-.834 1.667a.833.833 0 001.49.746l.834-1.667zM14.495 15.373a.833.833 0 00-1.49-.746l-.834 1.667a.833.833 0 001.49.746l.834-1.667z" fill="#47C8FF"/></svg>';

const PLAY_SVG = '<svg viewBox="0 0 12 12" fill="none" xmlns="http://www.w3.org/2000/svg"><path d="M4.622 1.184C3.707.592 2.5 1.249 2.5 2.338v7.324c0 1.09 1.207 1.746 2.122 1.154l5.66-3.662c.837-.542.837-1.767 0-2.308L4.622 1.184z" fill="currentColor"/></svg>';

function renderRaceInsights() {
  const container = document.getElementById('race-insights-content');
  let html = '';

  for (const ins of RACE_INSIGHTS) {
    let itemsHtml = '';
    let itemCount = 0;

    // Weather icon (for non-driver insights)
    if (ins.icon === 'weather') {
      itemsHtml += `<div class="ric-weather-icon">${WEATHER_SVG}</div>`;
      itemCount++;
    }

    // Driver photos
    if (ins.drivers && ins.drivers.length > 0) {
      for (const num of ins.drivers) {
        const driver = G.drivers[num];
        if (!driver) continue;
        const color = ins.teamColor || driver.color || '#555';
        const photoSrc = `assets/drivers/${driver.abbr}.png`;
        itemsHtml += `<div class="ric-driver-photo" style="background-color:${color}"><img src="${photoSrc}" alt="${driver.abbr}" /></div>`;
        itemCount++;
      }
    }

    // Tyre compound icon (same size as driver photo, overlapping)
    if (ins.compound) {
      const tyreSvg = TYRE_SVG_MAP[ins.compound] || 'soft';
      itemsHtml += `<div class="ric-tyre"><img src="assets/tyres/${tyreSvg}.svg" alt="${ins.compound}" /></div>`;
      itemCount++;
    }

    const overlapClass = itemCount > 1 ? ' ric-overlap' : '';

    html += `
      <div class="race-insight-card" data-t="${ins.t}">
        <div class="ric-header">
          <div class="ric-drivers${overlapClass}">${itemsHtml}</div>
          <span class="ric-lap">
            <span class="ric-lap-icon">${PLAY_SVG}</span>
            <span class="ric-lap-text">Lap ${ins.lap}</span>
            <span class="ric-lap-play">Play</span>
          </span>
        </div>
        <div class="ric-details">
          <div class="ric-title">${ins.title}</div>
          <div class="ric-body">${ins.body}</div>
        </div>
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

  // Timeline click/drag
  const tlTrack = document.getElementById('tl-track');
  let tlDragging = false;

  function tlSeekFromEvent(e) {
    const rect = tlTrack.getBoundingClientRect();
    const frac = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
    seekToT(frac * G.maxT);
  }

  tlTrack.addEventListener('mousedown', (e) => {
    tlDragging = true;
    tlSeekFromEvent(e);
    e.preventDefault();
  });
  document.addEventListener('mousemove', (e) => {
    if (tlDragging) tlSeekFromEvent(e);
  });
  document.addEventListener('mouseup', () => { tlDragging = false; });

  // Timeline hover: YouTube-style highlight + tooltip
  const tlHover = document.getElementById('tl-hover');
  const tlTooltip = document.getElementById('tl-tooltip');
  const tlTooltipTime = document.getElementById('tl-tooltip-time');
  const tlTooltipLap = document.getElementById('tl-tooltip-lap');

  function getLapAtT(t) {
    let lap = 1;
    for (const entry of G.lapStartTimes) {
      if (entry.t <= t) lap = entry.lap;
      else break;
    }
    return lap;
  }

  function updateTlTooltip(clientX) {
    const rect = tlTrack.getBoundingClientRect();
    const frac = Math.max(0, Math.min(1, (clientX - rect.left) / rect.width));
    const hoverT = frac * G.maxT;

    // Hover highlight from current progress to mouse (or from mouse to progress)
    const progressPct = G.maxT > 0 ? (G.currentT / G.maxT) * 100 : 0;
    const hoverPct = frac * 100;
    if (hoverPct > progressPct) {
      tlHover.style.left = progressPct + '%';
      tlHover.style.width = (hoverPct - progressPct) + '%';
    } else {
      tlHover.style.left = hoverPct + '%';
      tlHover.style.width = (progressPct - hoverPct) + '%';
    }

    // Tooltip position + content
    const totalLaps = G.lapStartTimes.length > 0 ? G.lapStartTimes[G.lapStartTimes.length - 1].lap : 0;
    const lap = getLapAtT(hoverT);
    tlTooltipTime.textContent = fmtRaceTime(hoverT);
    tlTooltipLap.textContent = 'Lap ' + lap + (totalLaps ? ' / ' + totalLaps : '');

    // Clamp tooltip so it stays within the timeline bounds
    const tipW = tlTooltip.offsetWidth;
    const mouseX = clientX - rect.left;
    const minLeft = tipW / 2;
    const maxLeft = rect.width - tipW / 2;
    const clampedLeft = Math.max(minLeft, Math.min(maxLeft, mouseX));
    tlTooltip.style.left = clampedLeft + 'px';
  }

  tlTrack.addEventListener('mousemove', (e) => { updateTlTooltip(e.clientX); });

  tlTrack.addEventListener('mouseleave', () => {
    tlHover.style.width = '0';
  });

  // Touch support for timeline
  tlTrack.addEventListener('touchstart', (e) => {
    tlDragging = true;
    tlTooltip.classList.add('touch-active');
    const touch = e.touches[0];
    tlSeekFromEvent(touch);
    updateTlTooltip(touch.clientX);
    e.preventDefault();
  }, { passive: false });
  document.addEventListener('touchmove', (e) => {
    if (tlDragging) {
      const touch = e.touches[0];
      tlSeekFromEvent(touch);
      updateTlTooltip(touch.clientX);
    }
  });
  document.addEventListener('touchend', () => {
    tlDragging = false;
    tlTooltip.classList.remove('touch-active');
    tlHover.style.width = '0';
  });

  // Speed dropdown
  const speedBtn = document.getElementById('btn-speed');
  const speedDropdown = document.getElementById('speed-dropdown');
  const speedControl = document.getElementById('speed-control');
  speedBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    speedDropdown.classList.toggle('hidden');
    // Close settings if open
    document.getElementById('settings-popup').classList.add('hidden');
  });
  speedDropdown.querySelectorAll('.speed-option').forEach(opt => {
    opt.addEventListener('click', () => {
      speedDropdown.querySelectorAll('.speed-option').forEach(o => o.classList.remove('active'));
      opt.classList.add('active');
      G.speed = parseFloat(opt.dataset.speed);
      speedBtn.textContent = opt.textContent;
      speedDropdown.classList.add('hidden');
    });
  });

  // Settings popup
  const settingsBtn = document.getElementById('btn-player-settings');
  const settingsPopup = document.getElementById('settings-popup');
  settingsBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    settingsPopup.classList.toggle('hidden');
    // Close speed if open
    speedDropdown.classList.add('hidden');
  });
  document.getElementById('opt-labels').addEventListener('change', (e) => {
    G.showLabels = e.target.checked;
  });

  // Close dropdowns/popups on outside click
  document.addEventListener('click', (e) => {
    if (!speedControl.contains(e.target)) speedDropdown.classList.add('hidden');
    if (!document.getElementById('settings-control').contains(e.target)) settingsPopup.classList.add('hidden');
  });

  // Fullscreen
  document.getElementById('btn-fullscreen').addEventListener('click', toggleFullscreen);
  document.addEventListener('fullscreenchange', updateFullscreenIcon);

  // Right sidebar tab switcher (Insights / Events / Track)
  const panelTabBar = document.querySelector('.panel-tab-bar');
  if (panelTabBar) {
    panelTabBar.querySelectorAll('.seg-tab').forEach(tab => {
      tab.addEventListener('click', () => {
        panelTabBar.querySelectorAll('.seg-tab').forEach(t => t.classList.remove('active'));
        tab.classList.add('active');
        moveSegIndicator(tab);
        const which = tab.dataset.tab;
        document.getElementById('race-insights-content').classList.toggle('hidden', which !== 'insights');
        document.getElementById('events-content').classList.toggle('hidden', which !== 'events');
        document.getElementById('track-content').classList.toggle('hidden', which !== 'track');
      });
    });

    // Initialize sidebar segmented control indicator
    const activeSegTab = panelTabBar.querySelector('.seg-tab.active');
    if (activeSegTab) requestAnimationFrame(() => moveSegIndicator(activeSegTab));
  }

  // Standings row click → follow driver on track
  document.getElementById('standings-list').addEventListener('click', (e) => {
    const row = e.target.closest('.driver-row');
    if (!row) return;
    const num = row.dataset.driver;
    if (G.followDriver === num) {
      stopFollowing();
    } else {
      G.followDriver = num;
      G.followZoom = 3;
      renderStandings();
    }
  });

  // Canvas hover tooltip
  G.canvas.addEventListener('mousemove', onCanvasHover);
  G.canvas.addEventListener('mouseleave', () => {
    document.getElementById('car-tooltip').classList.add('hidden');
  });

  // Canvas click → follow/unfollow driver (same as standings click)
  G.canvas.addEventListener('click', (e) => {
    // Ignore if this was a drag-to-pan gesture
    if (G._dragMoved) return;
    const rect = G.canvas.getBoundingClientRect();
    const mx = e.clientX - rect.left;
    const my = e.clientY - rect.top;
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
      const d = Math.hypot(cx - mx, cy - my);
      if (d < closestDist) { closestDist = d; closest = num; }
    }
    const hitRadius = DRIVER_RADIUS * Math.pow(G.zoom, 0.4) + 8;
    if (closest && closestDist < hitRadius) {
      if (G.followDriver === closest) {
        stopFollowing();
      } else {
        G.followDriver = closest;
        G.followZoom = 3;
        renderStandings();
      }
    }
  });

  // Keyboard shortcuts
  document.addEventListener('keydown', onKeyDown);

  // Mobile tab switcher
  bindMobileTabs();

  // Header: Grand Prix dropdown
  bindGpDropdown();

  // Header: Share button
  document.getElementById('btn-share').addEventListener('click', () => {
    navigator.clipboard.writeText(window.location.href).then(() => {
      showShareToast('Link copied to clipboard');
    }).catch(() => {
      showShareToast('Could not copy link');
    });
  });
}

function moveSegIndicator(tab) {
  const indicator = tab.closest('.seg-control').querySelector('.seg-indicator');
  if (!indicator) return;
  indicator.style.left = tab.offsetLeft + 'px';
  indicator.style.width = tab.offsetWidth + 'px';
}

function bindMobileTabs() {
  const mobileSeg       = document.querySelector('.mobile-seg');
  if (!mobileSeg) return;
  const tabs            = mobileSeg.querySelectorAll('.seg-tab');
  const standingsPanel  = document.querySelector('.standings-panel');
  const insightsPanel   = document.querySelector('.insights-panel');
  const insightsContent = document.getElementById('race-insights-content');
  const eventsContent   = document.getElementById('events-content');
  const trackContent    = document.getElementById('track-content');

  function activateTab(tab) {
    const panelName = tab.dataset.panel;
    tabs.forEach(t => t.classList.toggle('active', t === tab));
    moveSegIndicator(tab);

    // Top-level panel visibility
    standingsPanel.classList.toggle('mobile-active', panelName === 'standings');
    insightsPanel.classList.toggle('mobile-active', panelName === 'insights' || panelName === 'events' || panelName === 'track');

    // Which content area is visible inside the insights panel
    if (panelName === 'insights' || panelName === 'events' || panelName === 'track') {
      insightsContent.classList.toggle('hidden', panelName !== 'insights');
      eventsContent.classList.toggle('hidden', panelName !== 'events');
      trackContent.classList.toggle('hidden', panelName !== 'track');
    }
  }

  tabs.forEach(tab => tab.addEventListener('click', () => activateTab(tab)));

  // Init: activate the default tab so the panel gets mobile-active class
  const activeTab = mobileSeg.querySelector('.seg-tab.active');
  if (activeTab) requestAnimationFrame(() => activateTab(activeTab));
}

function bindGpDropdown() {
  const select = document.getElementById('race-select');
  const dropdown = document.getElementById('gp-dropdown');

  select.addEventListener('click', (e) => {
    if (e.target.closest('.gp-dropdown')) return;
    select.classList.toggle('open');
    dropdown.classList.toggle('hidden');
  });

  document.addEventListener('click', (e) => {
    if (!select.contains(e.target)) {
      select.classList.remove('open');
      dropdown.classList.add('hidden');
    }
  });

  dropdown.querySelectorAll('.gp-dropdown-item').forEach(item => {
    item.addEventListener('click', () => {
      // Only British GP is available — close dropdown without navigating
      select.classList.remove('open');
      dropdown.classList.add('hidden');
    });
  });
}

function showShareToast(msg) {
  let toast = document.querySelector('.share-toast');
  if (!toast) {
    toast = document.createElement('div');
    toast.className = 'share-toast';
    document.body.appendChild(toast);
  }
  toast.textContent = msg;
  toast.classList.add('show');
  setTimeout(() => toast.classList.remove('show'), 2000);
}

function togglePlay() {
  G.playing = !G.playing;
  if (G.playing && G.currentT >= G.maxT) G.currentT = 0;
  updatePlayButton();
}

function updatePlayButton() {
  const btn = document.getElementById('btn-play');
  btn.querySelector('.player-icon-play').classList.toggle('hidden', G.playing);
  btn.querySelector('.player-icon-pause').classList.toggle('hidden', !G.playing);
}

function seekToT(t) {
  G.currentT = Math.max(0, Math.min(t, G.maxT));
}

function jumpLap(delta) {
  const target = Math.max(1, Math.min(G.totalLaps, G.currentLap + delta));
  const t = G.lapStartMap[target];
  if (t != null) seekToT(t);
}

function updateTimelineUI() {
  const pct = G.maxT > 0 ? (G.currentT / G.maxT) * 100 : 0;
  document.getElementById('tl-progress').style.width = pct + '%';
  document.getElementById('player-time').textContent = fmtRaceTime(G.currentT) + ' / ' + fmtRaceTime(G.maxT);
  document.getElementById('hdr-race-time').textContent = fmtRaceTime(G.currentT);

  // Lap markers: dark only within progress area
  const markers = document.querySelectorAll('.tl-lap-marker');
  for (let i = 0; i < markers.length; i++) {
    const pos = parseFloat(markers[i].style.left);
    markers[i].classList.toggle('tl-lap-active', pos <= pct);
  }
}

function buildLapMarkers() {
  const container = document.getElementById('tl-laps');
  container.innerHTML = '';
  for (const { lap, t } of G.lapStartTimes) {
    if (lap === 1) continue;
    const frac = G.maxT > 0 ? t / G.maxT : 0;
    const marker = document.createElement('div');
    marker.className = 'tl-lap-marker';
    marker.style.left = (frac * 100) + '%';
    container.appendChild(marker);
  }
}

function buildEventMarkers() {
  const container = document.getElementById('tl-events');
  container.innerHTML = '';

  // Gather dominant track_status per lap
  const lapStatus = {};
  for (const lap of G.laps) {
    const ts = String(lap.track_status || '');
    const ln = lap.lap;
    if (!ln || ts === '1') continue;
    // Classify: Red if 5, SC if 4, VSC if 6 or 7, Yellow if 2
    const hasRed = ts.includes('5');
    const hasSC = ts.includes('4');
    const hasVSC = ts.includes('6') || ts.includes('7');
    const hasYellow = ts.includes('2');
    if (hasRed) lapStatus[ln] = lapStatus[ln] || 'red';
    else if (hasSC) lapStatus[ln] = lapStatus[ln] || 'sc';
    else if (hasVSC && !lapStatus[ln]) lapStatus[ln] = 'vsc';
    else if (hasYellow && !lapStatus[ln]) lapStatus[ln] = 'yellow';
  }

  // Group consecutive laps with same status into ranges
  const ranges = [];
  let current = null;
  for (const entry of G.lapStartTimes) {
    const status = lapStatus[entry.lap];
    if (status) {
      if (current && current.status === status && entry.lap === current.endLap + 1) {
        current.endLap = entry.lap;
      } else {
        if (current) ranges.push(current);
        current = { status, startLap: entry.lap, endLap: entry.lap, startT: entry.t };
      }
    } else {
      if (current) { ranges.push(current); current = null; }
    }
  }
  if (current) ranges.push(current);

  // Status labels for tooltips
  const STATUS_LABELS = { sc: 'Safety Car', vsc: 'Virtual Safety Car', yellow: 'Yellow Flag', red: 'Red Flag' };

  // Shared tooltip element
  let tooltip = document.getElementById('tl-event-tooltip');
  if (!tooltip) {
    tooltip = document.createElement('div');
    tooltip.id = 'tl-event-tooltip';
    tooltip.className = 'tl-event-tooltip';
    tooltip.innerHTML = '<div class="tl-event-tooltip-type"></div><div class="tl-event-tooltip-laps"></div>';
    document.body.appendChild(tooltip);
  }

  // Render
  for (let i = 0; i < ranges.length; i++) {
    const range = ranges[i];
    // End time = start of next lap after range, or maxT
    const nextLap = G.lapStartTimes.find(e => e.lap === range.endLap + 1);
    const endT = nextLap ? nextLap.t : G.maxT;
    const leftPct = (range.startT / G.maxT) * 100;
    const widthPct = ((endT - range.startT) / G.maxT) * 100;

    const el = document.createElement('div');
    el.className = 'tl-event';
    if (range.status === 'sc') el.classList.add('tl-event-sc');
    else if (range.status === 'vsc') el.classList.add('tl-event-vsc');
    else if (range.status === 'red') el.classList.add('tl-event-red');
    else el.classList.add('tl-event-yellow');

    // Add 1px gap between consecutive events
    const prevRange = i > 0 ? ranges[i - 1] : null;
    const isAdjacent = prevRange && range.startLap === prevRange.endLap + 1;
    if (isAdjacent) {
      el.style.left = 'calc(' + leftPct + '% + 1px)';
      el.style.width = 'calc(' + widthPct + '% - 1px)';
    } else {
      el.style.left = leftPct + '%';
      el.style.width = widthPct + '%';
    }

    // Tooltip data
    const lapLabel = range.startLap === range.endLap
      ? 'Lap ' + range.startLap
      : 'Laps ' + range.startLap + '–' + range.endLap;
    el.dataset.eventType = STATUS_LABELS[range.status];
    el.dataset.eventLaps = lapLabel;

    el.addEventListener('mouseenter', () => {
      tooltip.querySelector('.tl-event-tooltip-type').textContent = el.dataset.eventType;
      tooltip.querySelector('.tl-event-tooltip-laps').textContent = el.dataset.eventLaps;
      tooltip.classList.add('visible');
      positionEventTooltip(el, tooltip);
    });
    el.addEventListener('mouseleave', () => {
      tooltip.classList.remove('visible');
    });

    container.appendChild(el);
  }
}

function positionEventTooltip(el, tooltip) {
  const elRect = el.getBoundingClientRect();
  // Measure tooltip
  tooltip.style.left = '0px';
  tooltip.style.top = '0px';
  const tipW = tooltip.offsetWidth;
  const tipH = tooltip.offsetHeight;
  const vw = window.innerWidth;

  // Center above the event element
  let left = elRect.left + elRect.width / 2 - tipW / 2;
  const top = elRect.top - tipH - 6;

  // Clamp to viewport edges with 8px margin
  left = Math.max(8, Math.min(left, vw - tipW - 8));

  tooltip.style.left = left + 'px';
  tooltip.style.top = top + 'px';
}

function onCanvasHover(e) {
  // Suppress tooltip while dragging to pan
  if (G._dragging) return;
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
  if (closest && closestDist < DRIVER_RADIUS * Math.pow(G.zoom, 0.4) + 8) {
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

function toggleFullscreen() {
  if (!document.fullscreenElement) {
    document.documentElement.requestFullscreen().catch(() => {});
  } else {
    document.exitFullscreen().catch(() => {});
  }
}

function updateFullscreenIcon() {
  const isFs = !!document.fullscreenElement;
  const btn = document.getElementById('btn-fullscreen');
  btn.querySelector('.fs-expand').classList.toggle('hidden', isFs);
  btn.querySelector('.fs-compress').classList.toggle('hidden', !isFs);
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
    case 'KeyF': e.preventDefault(); toggleFullscreen(); break;
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
  const ls = document.getElementById('loading-screen');
  ls.classList.add('hidden');
  ls.remove();
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
