/**
 * F1 3D Replay — Silverstone 2025
 * Three.js scene: track, cars, cameras, playback.
 */

import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { CSS2DRenderer, CSS2DObject } from 'three/addons/renderers/CSS2DRenderer.js';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';

// ═══════════════════════════════════════════════════════════════════════════
// GLOBALS
// ═══════════════════════════════════════════════════════════════════════════

// FastF1 coordinates are in 1/10 meter. SCALE converts them to meters
// (1 Three.js unit = 1 meter).
const SCALE = 0.1;
const TRACK_WIDTH = 7;             // half-width in meters (~14 m total)
const CAR_TARGET_LENGTH = 5.7;     // F1 car length in meters

const G = {
  // Data
  session: null,
  drivers: {},
  track: null,
  positions: {},
  laps: [],
  insights: {},
  totalLaps: 0,
  maxT: 0,
  lapStartMap: {},
  lapStartTimes: [],

  // Three.js
  scene: null,
  camera: null,
  renderer: null,
  labelRenderer: null,
  controls: null,

  // Car meshes: { driverNum: { group, label } }
  cars: {},
  carTemplate: null,   // loaded GLB template
  carScale: 1,         // scale factor applied to the template

  // Track geometry
  trackCenter: new THREE.Vector3(),
  trackCurve: null,

  // Camera
  cameraMode: 'orbit',   // 'orbit' | 'follow' | 'topdown'
  followDriver: null,
  followCamPos: new THREE.Vector3(),
  followCamTarget: new THREE.Vector3(),

  // Playback
  currentT: 0,
  playing: false,
  speed: 1,
  lastFrameTime: null,
  currentLap: 1,
};

// ═══════════════════════════════════════════════════════════════════════════
// INIT
// ═══════════════════════════════════════════════════════════════════════════

async function init() {
  await loadData();
  setupDerived();
  showApp();
  setupScene();
  buildTrack();
  await loadCarModel();
  buildCars();
  bindControls();
  readUrlParams();
  animate();
}

// ─── Data Loading ──────────────────────────────────────────────────────────

async function loadData() {
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

  bar.style.width = '80%';

  G.session   = data.session;
  G.drivers   = data.drivers;
  G.track     = data.track;
  G.laps      = data.laps;
  G.insights  = data.insights;
  G.positions = positions;
  G.totalLaps = data.session.total_laps;

  document.getElementById('hdr-lap-total').textContent = G.totalLaps;
}

async function loadCarModel() {
  const bar = document.getElementById('loading-bar');
  const msg = document.getElementById('loading-msg');
  msg.textContent = 'Loading 3D car model…';
  bar.style.width = '90%';

  const loader = new GLTFLoader();
  try {
    const gltf = await loader.loadAsync('./f1-model.glb');
    G.carTemplate = gltf.scene;

    // Measure the model and compute scale factor
    const bbox = new THREE.Box3().setFromObject(G.carTemplate);
    const size = new THREE.Vector3();
    bbox.getSize(size);
    const modelLength = Math.max(size.x, size.y, size.z);
    G.carScale = CAR_TARGET_LENGTH / modelLength;

    bar.style.width = '100%';
  } catch (e) {
    console.warn('Could not load f1-model.glb, using box fallback:', e);
    G.carTemplate = null;
    bar.style.width = '100%';
  }
}

function setupDerived() {
  // Max race time
  let maxT = 0;
  for (const num in G.positions) {
    const ts = G.positions[num].t;
    if (ts && ts.length) maxT = Math.max(maxT, ts[ts.length - 1]);
  }
  G.maxT = maxT;

  // Lap start times
  const lapMap = {};
  for (const lap of G.laps) {
    if (lap.lap_start != null && lap.lap != null) {
      if (!(lap.lap in lapMap) || lap.lap_start < lapMap[lap.lap]) {
        lapMap[lap.lap] = lap.lap_start;
      }
    }
  }
  G.lapStartMap = lapMap;
  G.lapStartTimes = Object.entries(lapMap)
    .map(([l, t]) => ({ lap: parseInt(l), t }))
    .sort((a, b) => a.lap - b.lap);

  document.getElementById('ctrl-time-total').textContent = fmtRaceTime(G.maxT);

  // Default follow driver = first driver number
  const nums = Object.keys(G.drivers);
  if (nums.length) G.followDriver = nums[0];
}

function showApp() {
  document.getElementById('loading-screen').style.display = 'none';
  document.getElementById('app').classList.remove('hidden');
}

// ═══════════════════════════════════════════════════════════════════════════
// THREE.JS SCENE
// ═══════════════════════════════════════════════════════════════════════════

function setupScene() {
  const container = document.getElementById('scene-container');

  // Renderer — dark neutral background
  G.renderer = new THREE.WebGLRenderer({ antialias: true, alpha: false });
  G.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  G.renderer.setSize(container.clientWidth, container.clientHeight);
  G.renderer.setClearColor(0x111111);
  G.renderer.shadowMap.enabled = false;
  container.appendChild(G.renderer.domElement);

  // CSS2D label renderer
  G.labelRenderer = new CSS2DRenderer();
  G.labelRenderer.setSize(container.clientWidth, container.clientHeight);
  G.labelRenderer.domElement.style.position = 'absolute';
  G.labelRenderer.domElement.style.top = '0';
  G.labelRenderer.domElement.style.left = '0';
  G.labelRenderer.domElement.style.pointerEvents = 'none';
  container.appendChild(G.labelRenderer.domElement);

  // Scene
  G.scene = new THREE.Scene();
  G.scene.fog = new THREE.Fog(0x111111, 800, 2500);

  // Camera — far plane large enough for km-scale track
  G.camera = new THREE.PerspectiveCamera(
    50, container.clientWidth / container.clientHeight, 1, 5000
  );
  G.camera.position.set(0, 500, 500);
  G.camera.lookAt(0, 0, 0);

  // Orbit Controls
  G.controls = new OrbitControls(G.camera, G.renderer.domElement);
  G.controls.enableDamping = true;
  G.controls.dampingFactor = 0.08;
  G.controls.maxPolarAngle = Math.PI * 0.48;
  G.controls.minDistance = 10;
  G.controls.maxDistance = 2000;

  // Lights
  const ambient = new THREE.AmbientLight(0xffffff, 0.7);
  G.scene.add(ambient);

  const sun = new THREE.DirectionalLight(0xffffff, 1.0);
  sun.position.set(300, 600, 300);
  G.scene.add(sun);

  const hemi = new THREE.HemisphereLight(0x8899aa, 0x333333, 0.3);
  G.scene.add(hemi);

  // Ground plane — dark asphalt-like, not green
  const groundGeo = new THREE.PlaneGeometry(5000, 5000);
  const groundMat = new THREE.MeshLambertMaterial({ color: 0x1a1a1a });
  const ground = new THREE.Mesh(groundGeo, groundMat);
  ground.rotation.x = -Math.PI / 2;
  ground.position.y = -0.5;
  G.scene.add(ground);

  // Handle resize
  const ro = new ResizeObserver(() => {
    const w = container.clientWidth;
    const h = container.clientHeight;
    G.camera.aspect = w / h;
    G.camera.updateProjectionMatrix();
    G.renderer.setSize(w, h);
    G.labelRenderer.setSize(w, h);
  });
  ro.observe(container);
}

// ═══════════════════════════════════════════════════════════════════════════
// TRACK GEOMETRY
// ═══════════════════════════════════════════════════════════════════════════

function buildTrack() {
  const tx = G.track.x;
  const ty = G.track.y;
  if (!tx || tx.length < 2) return;

  // Convert to Three.js coords: FastF1 X → Three.js X, FastF1 Y → Three.js Z
  const pts = [];
  for (let i = 0; i < tx.length; i++) {
    pts.push(new THREE.Vector3(tx[i] * SCALE, 0, -ty[i] * SCALE));
  }

  // Compute center for camera
  const box = new THREE.Box3();
  for (const p of pts) box.expandByPoint(p);
  box.getCenter(G.trackCenter);

  // Set orbit controls target
  G.controls.target.copy(G.trackCenter);
  G.camera.position.set(G.trackCenter.x, 500, G.trackCenter.z + 500);
  G.controls.update();

  // Build smooth curve
  G.trackCurve = new THREE.CatmullRomCurve3(pts, true, 'catmullrom', 0.5);
  const numSamples = 2000;
  const curvePoints = G.trackCurve.getSpacedPoints(numSamples);

  // Build track ribbon as BufferGeometry
  const positions = [];
  const normals = [];
  const indices = [];

  for (let i = 0; i < curvePoints.length; i++) {
    const p = curvePoints[i];
    const next = curvePoints[(i + 1) % curvePoints.length];
    const tangent = new THREE.Vector3().subVectors(next, p).normalize();
    const perp = new THREE.Vector3(-tangent.z, 0, tangent.x).normalize();

    const left  = new THREE.Vector3().copy(p).addScaledVector(perp, -TRACK_WIDTH);
    const right = new THREE.Vector3().copy(p).addScaledVector(perp, TRACK_WIDTH);

    positions.push(left.x, 0.05, left.z);
    positions.push(right.x, 0.05, right.z);
    normals.push(0, 1, 0);
    normals.push(0, 1, 0);
  }

  const vCount = curvePoints.length;
  for (let i = 0; i < vCount; i++) {
    const a = i * 2;
    const b = i * 2 + 1;
    const c = ((i + 1) % vCount) * 2;
    const d = ((i + 1) % vCount) * 2 + 1;
    indices.push(a, b, c);
    indices.push(b, d, c);
  }

  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geo.setAttribute('normal', new THREE.Float32BufferAttribute(normals, 3));
  geo.setIndex(indices);

  const trackMat = new THREE.MeshLambertMaterial({ color: 0x333333, side: THREE.DoubleSide });
  const trackMesh = new THREE.Mesh(geo, trackMat);
  G.scene.add(trackMesh);

  // Track edge lines (white)
  buildTrackEdge(curvePoints, TRACK_WIDTH, 0xffffff, 0.2);
  buildTrackEdge(curvePoints, -TRACK_WIDTH, 0xffffff, 0.2);

  // Center line (dashed, subtle)
  const centerPts = curvePoints.map(p => new THREE.Vector3(p.x, 0.1, p.z));
  const centerGeo = new THREE.BufferGeometry().setFromPoints(centerPts);
  const centerMat = new THREE.LineDashedMaterial({
    color: 0xffffff, transparent: true, opacity: 0.08,
    dashSize: 3, gapSize: 5,
  });
  const centerLine = new THREE.Line(centerGeo, centerMat);
  centerLine.computeLineDistances();
  G.scene.add(centerLine);

  // Start/Finish line
  if (curvePoints.length > 10) {
    const sfIdx = Math.floor(curvePoints.length * 0.02);
    const sfPt = curvePoints[sfIdx];
    const sfNext = curvePoints[(sfIdx + 1) % curvePoints.length];
    const sfTangent = new THREE.Vector3().subVectors(sfNext, sfPt).normalize();
    const sfPerp = new THREE.Vector3(-sfTangent.z, 0, sfTangent.x);

    const sfGeo = new THREE.BufferGeometry().setFromPoints([
      new THREE.Vector3().copy(sfPt).addScaledVector(sfPerp, -TRACK_WIDTH * 1.2).setY(0.15),
      new THREE.Vector3().copy(sfPt).addScaledVector(sfPerp, TRACK_WIDTH * 1.2).setY(0.15),
    ]);
    const sfMat = new THREE.LineBasicMaterial({ color: 0xffffff, linewidth: 2 });
    const sfLine = new THREE.Line(sfGeo, sfMat);
    G.scene.add(sfLine);
  }
}

function buildTrackEdge(curvePoints, offset, color, opacity) {
  const edgePts = [];
  for (let i = 0; i < curvePoints.length; i++) {
    const p = curvePoints[i];
    const next = curvePoints[(i + 1) % curvePoints.length];
    const tangent = new THREE.Vector3().subVectors(next, p).normalize();
    const perp = new THREE.Vector3(-tangent.z, 0, tangent.x).normalize();
    const ep = new THREE.Vector3().copy(p).addScaledVector(perp, offset);
    ep.y = 0.1;
    edgePts.push(ep);
  }
  edgePts.push(edgePts[0].clone());

  const geo = new THREE.BufferGeometry().setFromPoints(edgePts);
  const mat = new THREE.LineBasicMaterial({ color, transparent: true, opacity });
  const line = new THREE.Line(geo, mat);
  G.scene.add(line);
}

// ═══════════════════════════════════════════════════════════════════════════
// CAR MODEL & MESHES
// ═══════════════════════════════════════════════════════════════════════════

function createCarGroup(driverData) {
  const group = new THREE.Group();
  const teamColor = new THREE.Color(driverData.color);

  if (G.carTemplate) {
    // Clone the loaded GLB model
    const model = G.carTemplate.clone();
    model.scale.setScalar(G.carScale);

    // Tint all meshes to the team color
    model.traverse((child) => {
      if (child.isMesh) {
        child.material = child.material.clone();
        child.material.color.copy(teamColor);
      }
    });

    // Center the model at origin
    const bbox = new THREE.Box3().setFromObject(model);
    const center = new THREE.Vector3();
    bbox.getCenter(center);
    model.position.sub(center);
    // Lift so bottom sits on track surface
    const minY = bbox.min.y * G.carScale;
    model.position.y -= minY;

    group.add(model);
  } else {
    // Fallback: colored box
    const geo = new THREE.BoxGeometry(CAR_TARGET_LENGTH, 1.0, 2.0);
    const mat = new THREE.MeshLambertMaterial({ color: teamColor });
    const box = new THREE.Mesh(geo, mat);
    box.position.y = 0.5;
    group.add(box);
  }

  return group;
}

function buildCars() {
  const select = document.getElementById('driver-select');

  for (const num in G.drivers) {
    const d = G.drivers[num];

    // Create car group from GLB or fallback
    const group = createCarGroup(d);
    group.position.set(0, -1000, 0); // off-screen initially
    G.scene.add(group);

    // Driver label
    const labelDiv = document.createElement('div');
    labelDiv.className = 'driver-label-3d';
    labelDiv.textContent = d.abbr;
    labelDiv.style.borderBottom = `2px solid ${d.color}`;
    const label = new CSS2DObject(labelDiv);
    label.position.set(0, 3.5, 0);
    group.add(label);

    G.cars[num] = { group, label };

    // Add to driver selector dropdown
    const opt = document.createElement('option');
    opt.value = num;
    opt.textContent = `${d.abbr} — ${d.name}`;
    select.appendChild(opt);
  }

  if (G.followDriver) select.value = G.followDriver;
}

// ═══════════════════════════════════════════════════════════════════════════
// POSITION INTERPOLATION
// ═══════════════════════════════════════════════════════════════════════════

function bisect(arr, t) {
  let lo = 0, hi = arr.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (arr[mid] < t) lo = mid + 1; else hi = mid;
  }
  return lo;
}

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

/** Convert FastF1 coords to Three.js world position */
function toWorld(pos) {
  return new THREE.Vector3(pos.x * SCALE, 0.1, -pos.y * SCALE);
}

// ═══════════════════════════════════════════════════════════════════════════
// UPDATE CARS
// ═══════════════════════════════════════════════════════════════════════════

const _prevPositions = {};

function updateCars(t) {
  for (const num in G.cars) {
    const pos = getPosition(num, t);
    if (!pos) continue;

    const worldPos = toWorld(pos);
    const car = G.cars[num];
    car.group.position.copy(worldPos);

    // Compute heading from velocity
    const prev = _prevPositions[num];
    if (prev) {
      const dx = worldPos.x - prev.x;
      const dz = worldPos.z - prev.z;
      const dist = Math.sqrt(dx * dx + dz * dz);
      if (dist > 0.05) {
        const targetAngle = Math.atan2(dx, dz);
        const currentY = car.group.rotation.y;
        let diff = targetAngle - currentY;
        while (diff > Math.PI) diff -= 2 * Math.PI;
        while (diff < -Math.PI) diff += 2 * Math.PI;
        car.group.rotation.y = currentY + diff * 0.15;
      }
    }
    _prevPositions[num] = worldPos.clone();
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// CAMERA MODES
// ═══════════════════════════════════════════════════════════════════════════

function updateCamera() {
  if (G.cameraMode === 'orbit') {
    G.controls.enabled = true;
    G.controls.update();
    return;
  }

  G.controls.enabled = false;

  if (G.cameraMode === 'follow') {
    updateFollowCamera();
  } else if (G.cameraMode === 'topdown') {
    updateTopDownCamera();
  }
}

function updateFollowCamera() {
  if (!G.followDriver || !G.cars[G.followDriver]) return;

  const carPos = G.cars[G.followDriver].group.position;
  const carRot = G.cars[G.followDriver].group.rotation.y;

  // Chase camera: 20 m behind, 8 m above
  const dist = 20;
  const height = 8;
  const targetCamPos = new THREE.Vector3(
    carPos.x - Math.sin(carRot) * dist,
    carPos.y + height,
    carPos.z - Math.cos(carRot) * dist,
  );

  G.followCamPos.lerp(targetCamPos, 0.04);
  G.followCamTarget.lerp(carPos, 0.08);

  G.camera.position.copy(G.followCamPos);
  G.camera.lookAt(G.followCamTarget);
}

function updateTopDownCamera() {
  let target = G.trackCenter.clone();
  if (G.followDriver && G.cars[G.followDriver]) {
    target = G.cars[G.followDriver].group.position.clone();
  }

  const desiredPos = new THREE.Vector3(target.x, 800, target.z + 1);
  G.camera.position.lerp(desiredPos, 0.05);
  G.camera.lookAt(target);
}

function setCameraMode(mode) {
  G.cameraMode = mode;

  document.querySelectorAll('.cam-btn').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.mode === mode);
  });

  if (mode === 'follow' && G.followDriver && G.cars[G.followDriver]) {
    const carPos = G.cars[G.followDriver].group.position;
    G.followCamPos.set(carPos.x, carPos.y + 8, carPos.z - 20);
    G.followCamTarget.copy(carPos);
  }

  if (mode === 'orbit') {
    G.controls.target.copy(G.trackCenter);
    G.controls.update();
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// PLAYBACK
// ═══════════════════════════════════════════════════════════════════════════

function togglePlay() {
  G.playing = !G.playing;
  if (G.playing && G.currentT >= G.maxT) G.currentT = 0;
  if (!G.playing) G.lastFrameTime = null;
  updatePlayButton();
}

function updatePlayButton() {
  const btn = document.getElementById('btn-play');
  btn.textContent = G.playing ? '⏸' : '▶';
}

function seekToT(t) {
  G.currentT = Math.max(0, Math.min(t, G.maxT));
  G.lastFrameTime = null;
  for (const num in _prevPositions) delete _prevPositions[num];
}

function seekToLap(lap) {
  const t = G.lapStartMap[lap];
  if (t != null) seekToT(t);
}

function updateCurrentLap() {
  let lap = 1;
  for (const entry of G.lapStartTimes) {
    if (entry.t <= G.currentT) lap = entry.lap;
    else break;
  }
  if (lap !== G.currentLap) {
    G.currentLap = lap;
    document.getElementById('hdr-lap-cur').textContent = lap;

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

function updateTimelineUI() {
  const slider = document.getElementById('timeline');
  const pct = G.maxT > 0 ? (G.currentT / G.maxT) * 1000 : 0;
  slider.value = pct;

  document.getElementById('ctrl-time-cur').textContent = fmtTime(G.currentT);
  document.getElementById('hdr-race-time').textContent = fmtRaceTime(G.currentT);
}

function fmtTime(s) {
  const m = Math.floor(s / 60);
  const sec = Math.floor(s % 60);
  return `${m}:${String(sec).padStart(2, '0')}`;
}

function fmtRaceTime(s) {
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = Math.floor(s % 60);
  return `${h}:${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}`;
}

// ═══════════════════════════════════════════════════════════════════════════
// ANIMATION LOOP
// ═══════════════════════════════════════════════════════════════════════════

function animate() {
  requestAnimationFrame(animate);

  const now = performance.now();

  if (G.playing) {
    if (G.lastFrameTime !== null) {
      const elapsed = (now - G.lastFrameTime) / 1000;
      G.currentT += elapsed * G.speed;
      if (G.currentT >= G.maxT) {
        G.currentT = G.maxT;
        G.playing = false;
        updatePlayButton();
      }
    }
    G.lastFrameTime = now;
  } else {
    G.lastFrameTime = null;
  }

  updateCurrentLap();
  updateCars(G.currentT);
  updateCamera();
  updateTimelineUI();

  G.renderer.render(G.scene, G.camera);
  G.labelRenderer.render(G.scene, G.camera);
}

// ═══════════════════════════════════════════════════════════════════════════
// CONTROLS BINDING
// ═══════════════════════════════════════════════════════════════════════════

function bindControls() {
  // Play/Pause
  document.getElementById('btn-play').addEventListener('click', togglePlay);

  // Prev/Next lap
  document.getElementById('btn-prev-lap').addEventListener('click', () => {
    const lap = Math.max(1, G.currentLap - 1);
    seekToLap(lap);
  });
  document.getElementById('btn-next-lap').addEventListener('click', () => {
    const lap = Math.min(G.totalLaps, G.currentLap + 1);
    seekToLap(lap);
  });

  // Timeline scrubber
  const slider = document.getElementById('timeline');
  slider.addEventListener('input', () => {
    const frac = parseFloat(slider.value) / 1000;
    seekToT(frac * G.maxT);
  });

  // Speed buttons
  document.querySelectorAll('.speed-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      G.speed = parseFloat(btn.dataset.speed);
      document.querySelectorAll('.speed-btn').forEach(b => b.classList.remove('speed-active'));
      btn.classList.add('speed-active');
    });
  });

  // Camera mode buttons
  document.querySelectorAll('.cam-btn').forEach(btn => {
    btn.addEventListener('click', () => setCameraMode(btn.dataset.mode));
  });

  // Driver selector
  document.getElementById('driver-select').addEventListener('change', (e) => {
    G.followDriver = e.target.value;
    if (G.cameraMode === 'follow') {
      const car = G.cars[G.followDriver];
      if (car) {
        G.followCamPos.copy(car.group.position).add(new THREE.Vector3(0, 8, -20));
        G.followCamTarget.copy(car.group.position);
      }
    }
  });

  // 2D view switch — pass current time
  const switchBtn = document.getElementById('btn-switch-2d');
  switchBtn.addEventListener('click', (e) => {
    e.preventDefault();
    const t = Math.round(G.currentT * 100) / 100;
    window.location.href = `index.html?t=${t}`;
  });

  // Keyboard shortcuts
  document.addEventListener('keydown', (e) => {
    if (e.target.tagName === 'INPUT' || e.target.tagName === 'SELECT') return;
    switch (e.key) {
      case ' ':
        e.preventDefault();
        togglePlay();
        break;
      case 'ArrowLeft':
        seekToT(G.currentT - 5);
        break;
      case 'ArrowRight':
        seekToT(G.currentT + 5);
        break;
      case '1':
        setCameraMode('orbit');
        break;
      case '2':
        setCameraMode('follow');
        break;
      case '3':
        setCameraMode('topdown');
        break;
    }
  });
}

// ═══════════════════════════════════════════════════════════════════════════
// URL PARAMS (for 2D↔3D sync)
// ═══════════════════════════════════════════════════════════════════════════

function readUrlParams() {
  const params = new URLSearchParams(window.location.search);
  const t = parseFloat(params.get('t'));
  if (!isNaN(t) && t > 0) {
    seekToT(t);
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// START
// ═══════════════════════════════════════════════════════════════════════════

init();
