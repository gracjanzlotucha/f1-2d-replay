/**
 * F1 3D Replay — Three.js track & cars.
 *
 * Loaded as a module after app.js on track3d.html. app.js owns the replay
 * clock, standings, timeline, events, weather, follow state and keyboard
 * controls (its 2D canvas runs underneath but is hidden by CSS). This module
 * reads app.js's global state via window.__app each frame and renders a 3D
 * scene: the Silverstone track built from real OpenF1 x/y/z telemetry, and the
 * 20 cars as instances of a real-scale STL model, tinted to team colours.
 *
 * Coordinate spaces:
 *   OpenF1 location  : x, y, z in decimetres (÷10 → metres). Same space the
 *                      car positions in positions.json live in.
 *   World (three.js) : metres, Y-up. world = (x/10, z/10, -y/10).
 *   STL model        : millimetres, real F1 dimensions (~5.39 × 1.88 × 1.10 m).
 */

import * as THREE from 'three';
import { STLLoader } from 'three/addons/loaders/STLLoader.js';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';

const DM2M = 0.1;          // decimetre → metre
const TRACK_HALF_W = 7.0;  // metres each side of the racing line (≈14 m road)
const CAR_URL = 'assets/car-model-lod.stl';

// OpenF1 (x,y,z dm) → world (metres, Y-up). Negating y keeps the circuit from
// rendering mirrored relative to the familiar 2D map orientation.
function toWorld(x, y, z) {
  return new THREE.Vector3(x * DM2M, z * DM2M, -y * DM2M);
}

// ── Module state ────────────────────────────────────────────────────────────
const S = {
  renderer: null, scene: null, camera: null, controls: null,
  cars: null,             // THREE.InstancedMesh
  carIndex: {},           // driverNum → instance index
  driverList: [],         // ordered driver numbers matching instance indices
  centerline: [],         // [{x,y,z}] decimetres (for elevation lookup)
  trackCurve: null,       // CatmullRomCurve3 in world space
  camMode: 'broadcast',   // 'broadcast' | 'overview' | 'follow'
  followNum: null,
  _camPos: new THREE.Vector3(),
  _camTarget: new THREE.Vector3(),
  ready: false,
  _heading: {},           // driverNum → last good heading angle (radians)
  trackCenter: new THREE.Vector3(),
  trackRadius: 500,
};

const app = () => window.__app;
window.__td = S; // debug/inspection handle
const TMP_M = new THREE.Matrix4();
const TMP_Q = new THREE.Quaternion();
const TMP_S = new THREE.Vector3(1, 1, 1);
const TMP_P = new THREE.Vector3();
const UP = new THREE.Vector3(0, 1, 0);

// ═══════════════════════════════════════════════════════════════════════════
// ELEVATION LOOKUP
// ═══════════════════════════════════════════════════════════════════════════

/** Elevation (decimetres) of the track surface nearest to (x,y) in dm space. */
function elevAt(x, y) {
  const c = S.centerline;
  let bestD = Infinity, bestZ = c.length ? c[0].z : 0;
  for (let i = 0; i < c.length; i++) {
    const a = c[i], b = c[(i + 1) % c.length];
    const abx = b.x - a.x, aby = b.y - a.y;
    const apx = x - a.x, apy = y - a.y;
    const len2 = abx * abx + aby * aby || 1;
    let t = (apx * abx + apy * aby) / len2;
    t = t < 0 ? 0 : t > 1 ? 1 : t;
    const px = a.x + abx * t, py = a.y + aby * t;
    const dx = x - px, dy = y - py;
    const d = dx * dx + dy * dy;
    if (d < bestD) { bestD = d; bestZ = a.z + (b.z - a.z) * t; }
  }
  return bestZ;
}

// ═══════════════════════════════════════════════════════════════════════════
// SCENE
// ═══════════════════════════════════════════════════════════════════════════

function initScene() {
  const root = document.getElementById('td-root');
  const w = root.clientWidth || 800, h = root.clientHeight || 600;

  S.renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' });
  S.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
  S.renderer.setSize(w, h);
  S.renderer.outputColorSpace = THREE.SRGBColorSpace;
  S.renderer.toneMapping = THREE.ACESFilmicToneMapping;
  S.renderer.toneMappingExposure = 1.05;
  S.renderer.shadowMap.enabled = true;
  S.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  root.appendChild(S.renderer.domElement);

  S.scene = new THREE.Scene();
  S.scene.background = new THREE.Color(0x9fb6cc);
  // Fog distances are set in buildTrack() once the circuit size is known —
  // a fixed near/far would wash out a ~2 km-wide track.

  S.camera = new THREE.PerspectiveCamera(45, w / h, 1, 8000);
  S.camera.position.set(0, 600, 600);

  S.controls = new OrbitControls(S.camera, S.renderer.domElement);
  S.controls.enableDamping = true;
  S.controls.dampingFactor = 0.08;
  S.controls.maxPolarAngle = Math.PI * 0.495; // don't go below the horizon
  S.controls.minDistance = 12;
  S.controls.maxDistance = 4000;

  // Lighting — soft sky/ground fill plus an angled sun for relief
  const hemi = new THREE.HemisphereLight(0xcfe3ff, 0x4a5238, 0.85);
  S.scene.add(hemi);
  const sun = new THREE.DirectionalLight(0xfff3e0, 2.0);
  sun.position.set(-800, 1400, 900);
  sun.castShadow = true;
  sun.shadow.mapSize.set(2048, 2048);
  sun.shadow.bias = -0.0004;
  const sc = sun.shadow.camera;
  sc.near = 100; sc.far = 4000;
  sc.left = -1200; sc.right = 1200; sc.top = 1200; sc.bottom = -1200;
  S.scene.add(sun);
  S.scene.add(sun.target);

  window.addEventListener('resize', onResize);
  new ResizeObserver(onResize).observe(root);
}

function onResize() {
  const root = document.getElementById('td-root');
  if (!root || !S.renderer) return;
  const w = root.clientWidth, h = root.clientHeight;
  if (!w || !h) return;
  S.camera.aspect = w / h;
  S.camera.updateProjectionMatrix();
  S.renderer.setSize(w, h);
}

// ═══════════════════════════════════════════════════════════════════════════
// TRACK GEOMETRY
// ═══════════════════════════════════════════════════════════════════════════

function buildTrack(centerlineDm) {
  S.centerline = centerlineDm.map(([x, y, z]) => ({ x, y, z }));

  // World-space points for the smooth racing-line curve
  const worldPts = centerlineDm.map(([x, y, z]) => toWorld(x, y, z));
  const curve = new THREE.CatmullRomCurve3(worldPts, true, 'catmullrom', 0.5);
  S.trackCurve = curve;

  // Resample evenly for a clean ribbon
  const N = 1400;
  const pts = curve.getSpacedPoints(N);

  // Asphalt ribbon + white edge lines + red/white kerbs, built from
  // cross-sections at each resampled point.
  const road = [], roadIdx = [];
  const edgeL = [], edgeR = [];
  const kerbPos = [], kerbCol = [], kerbIdx = [];
  const EDGE_W = 0.5;      // white edge line width (m)
  const KERB_W = 1.0;      // kerb width outside the white line (m)
  const yLift = 0.05;      // lift markings above asphalt to avoid z-fighting
  const STRIPE = 2;        // resampled segments per kerb colour stripe (~8 m)
  const RED = [0.78, 0.05, 0.10], WHITE = [0.9, 0.9, 0.9];

  for (let i = 0; i <= N; i++) {
    const p = pts[i % pts.length];
    const pNext = pts[(i + 1) % pts.length];
    const tangent = new THREE.Vector3().subVectors(pNext, p);
    tangent.y = 0;
    if (tangent.lengthSq() < 1e-6) tangent.set(1, 0, 0);
    tangent.normalize();
    // horizontal normal = up × tangent
    const nrm = new THREE.Vector3().crossVectors(UP, tangent).normalize();

    const lx = p.x + nrm.x * TRACK_HALF_W, lz = p.z + nrm.z * TRACK_HALF_W;
    const rx = p.x - nrm.x * TRACK_HALF_W, rz = p.z - nrm.z * TRACK_HALF_W;
    road.push(lx, p.y, lz, rx, p.y, rz);

    // white edge lines (thin ribbons just inside each border)
    edgeL.push(
      lx, p.y + yLift, lz,
      lx - nrm.x * EDGE_W, p.y + yLift, lz - nrm.z * EDGE_W
    );
    edgeR.push(
      rx + nrm.x * EDGE_W, p.y + yLift, rz + nrm.z * EDGE_W,
      rx, p.y + yLift, rz
    );

    // kerbs: a strip just outside each white edge line
    const ky = p.y + yLift * 0.5;
    kerbPos.push(
      lx + nrm.x * EDGE_W, ky, lz + nrm.z * EDGE_W,
      lx + nrm.x * (EDGE_W + KERB_W), ky, lz + nrm.z * (EDGE_W + KERB_W),
      rx - nrm.x * EDGE_W, ky, rz - nrm.z * EDGE_W,
      rx - nrm.x * (EDGE_W + KERB_W), ky, rz - nrm.z * (EDGE_W + KERB_W)
    );
    const col = (Math.floor(i / STRIPE) % 2 === 0) ? RED : WHITE;
    for (let k = 0; k < 4; k++) kerbCol.push(col[0], col[1], col[2]);
  }
  for (let i = 0; i < N; i++) {
    const a = i * 2, b = i * 2 + 1, c = (i + 1) * 2, d = (i + 1) * 2 + 1;
    roadIdx.push(a, c, b, b, c, d);
    // kerb quads: left (0,1) and right (2,3) of each 4-vertex cross-section
    const base = i * 4, nb = (i + 1) * 4;
    kerbIdx.push(base, nb, base + 1, base + 1, nb, nb + 1);       // left
    kerbIdx.push(base + 2, base + 3, nb + 2, base + 3, nb + 3, nb + 2); // right
  }

  const roadGeo = new THREE.BufferGeometry();
  roadGeo.setAttribute('position', new THREE.Float32BufferAttribute(road, 3));
  roadGeo.setIndex(roadIdx);
  roadGeo.computeVertexNormals();
  const roadMat = new THREE.MeshStandardMaterial({ color: 0x595d66, roughness: 0.96, metalness: 0.0 });
  const roadMesh = new THREE.Mesh(roadGeo, roadMat);
  roadMesh.receiveShadow = true;
  roadMesh.renderOrder = 1;
  S.scene.add(roadMesh);

  // Kerbs (vertex-coloured red/white)
  const kerbGeo = new THREE.BufferGeometry();
  kerbGeo.setAttribute('position', new THREE.Float32BufferAttribute(kerbPos, 3));
  kerbGeo.setAttribute('color', new THREE.Float32BufferAttribute(kerbCol, 3));
  kerbGeo.setIndex(kerbIdx);
  const kerbMesh = new THREE.Mesh(kerbGeo, new THREE.MeshBasicMaterial({ vertexColors: true }));
  kerbMesh.renderOrder = 2;
  S.scene.add(kerbMesh);

  // White edge lines
  const edgeMat = new THREE.MeshBasicMaterial({ color: 0xf2f2f2 });
  for (const strip of [edgeL, edgeR]) {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(strip, 3));
    const idx = [];
    for (let i = 0; i < N; i++) {
      const a = i * 2, b = i * 2 + 1, c = (i + 1) * 2, d = (i + 1) * 2 + 1;
      idx.push(a, c, b, b, c, d);
    }
    g.setIndex(idx);
    const m = new THREE.Mesh(g, edgeMat);
    m.renderOrder = 3;
    S.scene.add(m);
  }

  // Start/finish band — white stripe across the road near the curve start
  buildStartLine(pts, N);

  // Ground / grass
  buildGround(centerlineDm);

  // Track bounds for the overview camera
  S.trackBox = new THREE.Box3().setFromPoints(worldPts);
  S.trackBox.getCenter(S.trackCenter);
  S.trackSize = S.trackBox.getSize(new THREE.Vector3());
  S.trackRadius = S.trackSize.length() * 0.5;

  // Fog only kicks in well beyond the circuit so the track stays crisp
  S.scene.fog = new THREE.Fog(0x9fb6cc, S.trackRadius * 2.2, S.trackRadius * 9);
}

function buildStartLine(pts, N) {
  const p = pts[0], pNext = pts[1];
  const tangent = new THREE.Vector3().subVectors(pNext, p); tangent.y = 0; tangent.normalize();
  const nrm = new THREE.Vector3().crossVectors(UP, tangent).normalize();
  const depth = 2.0;
  const t2 = tangent.clone().multiplyScalar(depth * 0.5);
  const verts = [];
  const lx = p.x + nrm.x * TRACK_HALF_W, lz = p.z + nrm.z * TRACK_HALF_W;
  const rx = p.x - nrm.x * TRACK_HALF_W, rz = p.z - nrm.z * TRACK_HALF_W;
  const y = p.y + 0.08;
  verts.push(
    lx - t2.x, y, lz - t2.z,
    rx - t2.x, y, rz - t2.z,
    lx + t2.x, y, lz + t2.z,
    rx + t2.x, y, rz + t2.z
  );
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(verts, 3));
  g.setIndex([0, 2, 1, 1, 2, 3]);
  g.computeVertexNormals();
  const m = new THREE.Mesh(g, new THREE.MeshBasicMaterial({ color: 0xffffff }));
  m.renderOrder = 3;
  S.scene.add(m);
}

function buildGround(centerlineDm) {
  let zmin = Infinity;
  for (const [, , z] of centerlineDm) if (z < zmin) zmin = z;
  const y = zmin * DM2M - 0.4;
  const geo = new THREE.PlaneGeometry(12000, 12000);
  geo.rotateX(-Math.PI / 2);
  const mat = new THREE.MeshStandardMaterial({ color: 0x4d7a3a, roughness: 1.0, metalness: 0.0 });
  const ground = new THREE.Mesh(geo, mat);
  ground.position.set(S.trackCenter.x, y, S.trackCenter.z);
  ground.receiveShadow = true;
  ground.renderOrder = 0;
  S.scene.add(ground);
}

// ═══════════════════════════════════════════════════════════════════════════
// CARS
// ═══════════════════════════════════════════════════════════════════════════

function loadCars() {
  return new Promise((resolve, reject) => {
    new STLLoader().load(CAR_URL, (geo) => {
      // STL is in mm with nose at -X_model, up at +Z_model. Bake a canonical
      // orientation: forward +X, up +Y, right +Z, scaled to metres, pivot at
      // the ground-centre of the car.
      geo.scale(0.001, 0.001, 0.001);                    // mm → m
      const remap = new THREE.Matrix4().set(
        -1, 0, 0, 0,
        0, 0, 1, 0,
        0, 1, 0, 0,
        0, 0, 0, 1
      );
      geo.applyMatrix4(remap);
      geo.computeBoundingBox();
      const bb = geo.boundingBox;
      const cx = (bb.min.x + bb.max.x) / 2;
      const cz = (bb.min.z + bb.max.z) / 2;
      geo.translate(-cx, -bb.min.y, -cz);                // pivot: ground centre
      geo.computeVertexNormals();

      const G = app().G;
      S.driverList = Object.keys(G.drivers);
      const count = S.driverList.length;

      const mat = new THREE.MeshStandardMaterial({
        roughness: 0.45, metalness: 0.35, vertexColors: false,
      });
      const mesh = new THREE.InstancedMesh(geo, mat, count);
      mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
      mesh.castShadow = true;
      mesh.frustumCulled = false;

      const color = new THREE.Color();
      S.driverList.forEach((num, i) => {
        S.carIndex[num] = i;
        // Color.set() already interprets the hex as sRGB and stores it in the
        // renderer's working space, so no manual conversion is needed.
        color.set(G.drivers[num].color || '#cccccc');
        mesh.setColorAt(i, color);
        // park off-scene until first update
        TMP_M.makeTranslation(0, -9999, 0);
        mesh.setMatrixAt(i, TMP_M);
      });
      mesh.instanceColor.needsUpdate = true;
      mesh.instanceMatrix.needsUpdate = true;

      S.cars = mesh;
      S.scene.add(mesh);
      resolve();
    }, undefined, reject);
  });
}

/** Position/orient one car instance from app.js interpolated data. */
function updateCar(num, t) {
  const G = app().G;
  const idx = S.carIndex[num];
  if (idx == null) return;

  const ds = G.driverStatus[num];
  let visible = true;
  if (ds && ds.status === 'dns') visible = false;
  if (ds && ds.status === 'dnf' && ds.retirementLap != null) {
    const retT = G.lapStartMap[ds.retirementLap + 1] || G.lapStartMap[ds.retirementLap];
    if (retT != null && t > retT + 10) visible = false;
  }

  const pos = visible ? app().getPosition(num, t) : null;
  if (!pos) {
    TMP_M.makeTranslation(0, -9999, 0);
    S.cars.setMatrixAt(idx, TMP_M);
    return;
  }

  const elev = elevAt(pos.x, pos.y);
  TMP_P.copy(toWorld(pos.x, pos.y, elev));

  // Heading from a look-ahead sample; keep last good heading when stationary
  const ahead = app().getPosition(num, t + 0.35);
  let yaw = S._heading[num] ?? 0;
  if (ahead) {
    const dx = (ahead.x - pos.x), dz = -(ahead.y - pos.y); // world dx, dz
    if (dx * dx + dz * dz > 1e-4) {
      yaw = Math.atan2(-dz, dx); // rotate local +X to (cosθ,0,-sinθ)=dir
      S._heading[num] = yaw;
    }
  }
  TMP_Q.setFromAxisAngle(UP, yaw);
  TMP_M.compose(TMP_P, TMP_Q, TMP_S);
  S.cars.setMatrixAt(idx, TMP_M);
}

// ═══════════════════════════════════════════════════════════════════════════
// CAMERA
// ═══════════════════════════════════════════════════════════════════════════

function frameOverview() {
  const c = S.trackCenter;
  const sz = S.trackSize || new THREE.Vector3(1000, 50, 1000);
  // Distance needed to fit the larger horizontal dimension in the FOV
  const maxDim = Math.max(sz.x, sz.z);
  const vFov = (S.camera.fov * Math.PI) / 180;
  const hFov = 2 * Math.atan(Math.tan(vFov / 2) * S.camera.aspect);
  const fit = (maxDim / 2) / Math.tan(Math.min(vFov, hFov) / 2);
  const dist = fit * 1.15;
  // Lower 3/4 angle (~40° above the horizon) so the circuit's shape and
  // elevation read clearly rather than looking flat top-down.
  const dir = new THREE.Vector3(0.18, 0.66, 0.73).normalize();
  S.camera.position.copy(c).addScaledVector(dir, dist);
  S.controls.target.copy(c);
  S.controls.update();
}

// Compute the chase camera target pose for a driver at time t.
function chasePose(num, t) {
  const pos = app().getPosition(num, t);
  if (!pos) return null;
  const elev = elevAt(pos.x, pos.y);
  const carPos = toWorld(pos.x, pos.y, elev);
  const yaw = S._heading[num] ?? 0;
  const fwd = new THREE.Vector3(Math.cos(yaw), 0, -Math.sin(yaw)); // car forward
  return {
    pos: carPos.clone().addScaledVector(fwd, -16).add(new THREE.Vector3(0, 7.5, 0)),
    look: carPos.clone().addScaledVector(fwd, 8).add(new THREE.Vector3(0, 1.5, 0)),
  };
}

function updateFollowCamera(num, t) {
  const p = chasePose(num, t);
  if (!p) return;
  S._camPos.lerp(p.pos, 0.12);
  S._camTarget.lerp(p.look, 0.18);
  S.camera.position.copy(S._camPos);
  S.camera.lookAt(S._camTarget);
}

// TV-helicopter pose: high and behind a target car. Shows the asphalt, the
// elevation and several cars at true scale — the default, watchable view.
function broadcastPose(num, t) {
  const pos = app().getPosition(num, t);
  if (!pos) return null;
  const elev = elevAt(pos.x, pos.y);
  const carPos = toWorld(pos.x, pos.y, elev);
  const yaw = S._heading[num] ?? 0;
  const fwd = new THREE.Vector3(Math.cos(yaw), 0, -Math.sin(yaw));
  return {
    pos: carPos.clone().addScaledVector(fwd, -42).add(new THREE.Vector3(0, 30, 0)),
    look: carPos.clone().addScaledVector(fwd, 14).add(new THREE.Vector3(0, 1.5, 0)),
  };
}

// Driver the broadcast/follow cameras track: the explicitly-followed car, else
// the current race leader.
function camTargetDriver() {
  return S.followNum || app().G.driverOrder?.[0] || S.driverList[0];
}

function updateBroadcastCamera(t) {
  const num = camTargetDriver();
  const p = broadcastPose(num, t);
  if (!p) return;
  S._camPos.lerp(p.pos, 0.06);
  S._camTarget.lerp(p.look, 0.1);
  S.camera.position.copy(S._camPos);
  S.camera.lookAt(S._camTarget);
}

function setCamMode(mode) {
  S.camMode = mode;
  document.querySelectorAll('#td-cam button')
    .forEach(b => b.classList.toggle('active', b.dataset.mode === mode));
  S.controls.enabled = (mode === 'overview');

  if (mode === 'overview') {
    frameOverview();
    return;
  }
  // Snap auto-cameras straight to their target pose so they don't fly in
  const t = app().G.currentT;
  const p = mode === 'follow'
    ? (S.followNum && chasePose(S.followNum, t))
    : broadcastPose(camTargetDriver(), t);
  if (p) { S._camPos.copy(p.pos); S._camTarget.copy(p.look); }
  else { S._camPos.copy(S.camera.position); S._camTarget.copy(S.controls.target); }
  S.camera.position.copy(S._camPos);
  S.camera.lookAt(S._camTarget);
}

function buildCamUI() {
  const root = document.getElementById('td-root');
  const bar = document.createElement('div');
  bar.id = 'td-cam';
  bar.innerHTML = `
    <button data-mode="broadcast" class="active">Broadcast</button>
    <button data-mode="overview">Overview</button>
    <button data-mode="follow">Follow</button>`;
  root.appendChild(bar);
  bar.querySelectorAll('button').forEach(b => {
    b.addEventListener('click', () => {
      const mode = b.dataset.mode;
      if (mode === 'follow' && !S.followNum) {
        const leader = app().G.driverOrder?.[0];
        if (leader) { setFollow(leader); return; } // setFollow switches to follow
      }
      if (mode !== 'follow' && mode !== 'broadcast') {
        // leaving the car-tracking modes clears the explicit follow selection
      }
      setCamMode(mode);
    });
  });
}

// ═══════════════════════════════════════════════════════════════════════════
// PICKING (click a car → follow)
// ═══════════════════════════════════════════════════════════════════════════

function setFollow(num) {
  const G = app().G;
  S.followNum = num;
  G.followDriver = num;          // app.js uses this for the telemetry panel
  G.followZoom = 3;
  app().renderStandings();
  setCamMode('follow');
}

function clearFollow() {
  S.followNum = null;
  app().stopFollowing();
  setCamMode('broadcast');
}

function setupPicking() {
  const dom = S.renderer.domElement;
  const ray = new THREE.Raycaster();
  const ndc = new THREE.Vector2();
  let downX = 0, downY = 0;

  dom.addEventListener('pointerdown', (e) => { downX = e.clientX; downY = e.clientY; });
  dom.addEventListener('pointerup', (e) => {
    if (Math.hypot(e.clientX - downX, e.clientY - downY) > 5) return; // was a drag
    const rect = dom.getBoundingClientRect();
    ndc.x = ((e.clientX - rect.left) / rect.width) * 2 - 1;
    ndc.y = -((e.clientY - rect.top) / rect.height) * 2 + 1;
    ray.setFromCamera(ndc, S.camera);
    const hit = S.cars ? ray.intersectObject(S.cars) : [];
    if (hit.length && hit[0].instanceId != null) {
      const num = S.driverList[hit[0].instanceId];
      if (num === S.followNum) clearFollow();
      else setFollow(num);
    }
  });
}

// Reflect standings-row follow (driven by app.js) into the 3D camera
function syncFollowFromApp() {
  const fd = app().G.followDriver;
  if (fd !== S.followNum) {
    S.followNum = fd;
    if (fd) { if (S.camMode !== 'follow') setCamMode('follow'); }
    else if (S.camMode === 'follow') setCamMode('broadcast');
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// MAIN LOOP
// ═══════════════════════════════════════════════════════════════════════════

function animate() {
  requestAnimationFrame(animate);
  if (!S.ready) return;

  const t = app().G.currentT;

  for (const num of S.driverList) updateCar(num, t);
  S.cars.instanceMatrix.needsUpdate = true;

  syncFollowFromApp();
  if (S.camMode === 'follow' && S.followNum) updateFollowCamera(S.followNum, t);
  else if (S.camMode === 'broadcast') updateBroadcastCamera(t);
  else if (S.camMode === 'overview') S.controls.update();

  S.renderer.render(S.scene, S.camera);
}

// ═══════════════════════════════════════════════════════════════════════════
// BOOT
// ═══════════════════════════════════════════════════════════════════════════

function waitForApp() {
  return new Promise((resolve) => {
    (function check() {
      const a = window.__app;
      if (a && a.G && a.G.positions && Object.keys(a.G.positions).length &&
          a.G.drivers && Object.keys(a.G.drivers).length && a.G.maxT > 0) {
        resolve();
      } else {
        requestAnimationFrame(check);
      }
    })();
  });
}

async function boot() {
  await waitForApp();
  initScene();

  const trackData = await (await fetch('./track3d.json')).json();
  buildTrack(trackData.centerline);
  frameOverview();

  buildCamUI();
  setupPicking();

  try {
    await loadCars();
  } catch (e) {
    console.error('Car model failed to load:', e);
  }

  S.ready = true;
  setCamMode('broadcast'); // default to the TV-helicopter view over the leader
  document.getElementById('td-loading')?.classList.add('hidden');
  const hint = document.getElementById('td-hint');
  if (hint) {
    hint.classList.add('show');
    setTimeout(() => hint.classList.add('fade'), 6000);
  }
  animate();
}

boot().catch(err => {
  console.error('3D init error:', err);
  const l = document.getElementById('td-loading');
  if (l) l.querySelector('span').textContent = 'Failed to load 3D scene: ' + err.message;
});
