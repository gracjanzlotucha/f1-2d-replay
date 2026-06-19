/**
 * Decimate a binary STL via vertex clustering (grid snapping).
 *
 * The source car model (static/assets/car-model.stl) is ~58 MB / 1.16M
 * triangles — far too large to ship to the browser. This produces a small
 * binary STL (static/assets/car-model-lod.stl) used by the /3d view.
 *
 * Usage:
 *   node scripts/decimate-stl.js          # dry run: print tri counts per cell size
 *   node scripts/decimate-stl.js 30       # write LOD at 30 mm grid cells
 *
 * Vertex clustering snaps every vertex to a grid cell, replaces it with the
 * cell centroid, and drops triangles that collapse to a line/point. 30 mm
 * cells give ~56k triangles / ~2.8 MB, which looks sharp on the follow camera
 * and is cheap as a shared InstancedMesh geometry.
 */
const fs = require('fs');
const path = require('path');

const SRC = path.join(__dirname, '..', 'static', 'assets', 'car-model.stl');
const OUT = path.join(__dirname, '..', 'static', 'assets', 'car-model-lod.stl');

function readTris() {
  const buf = fs.readFileSync(SRC);
  const n = buf.readUInt32LE(80);
  const tris = new Float32Array(n * 9);
  let off = 84;
  for (let i = 0; i < n; i++) {
    off += 12; // skip normal
    for (let v = 0; v < 9; v++) { tris[i * 9 + v] = buf.readFloatLE(off); off += 4; }
    off += 2; // attribute byte count
  }
  return { tris, n };
}

function cluster(tris, n, cell) {
  const sum = new Map();
  const key = (x, y, z) =>
    Math.floor(x / cell) + '_' + Math.floor(y / cell) + '_' + Math.floor(z / cell);
  for (let i = 0; i < n; i++) {
    for (let v = 0; v < 3; v++) {
      const o = i * 9 + v * 3;
      const x = tris[o], y = tris[o + 1], z = tris[o + 2];
      const k = key(x, y, z);
      let s = sum.get(k);
      if (!s) { s = [0, 0, 0, 0]; sum.set(k, s); }
      s[0] += x; s[1] += y; s[2] += z; s[3]++;
    }
  }
  const rep = new Map();
  for (const [k, s] of sum) rep.set(k, [s[0] / s[3], s[1] / s[3], s[2] / s[3]]);

  const outTris = [];
  for (let i = 0; i < n; i++) {
    const ks = [];
    for (let v = 0; v < 3; v++) {
      const o = i * 9 + v * 3;
      ks.push(key(tris[o], tris[o + 1], tris[o + 2]));
    }
    if (ks[0] === ks[1] || ks[1] === ks[2] || ks[0] === ks[2]) continue;
    outTris.push([rep.get(ks[0]), rep.get(ks[1]), rep.get(ks[2])]);
  }
  return outTris;
}

function writeSTL(outTris, file) {
  const n = outTris.length;
  const buf = Buffer.alloc(84 + n * 50);
  buf.write('decimated car model', 0);
  buf.writeUInt32LE(n, 80);
  let off = 84;
  for (const [a, b, c] of outTris) {
    const ux = b[0] - a[0], uy = b[1] - a[1], uz = b[2] - a[2];
    const vx = c[0] - a[0], vy = c[1] - a[1], vz = c[2] - a[2];
    let nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
    const L = Math.hypot(nx, ny, nz) || 1; nx /= L; ny /= L; nz /= L;
    buf.writeFloatLE(nx, off); buf.writeFloatLE(ny, off + 4); buf.writeFloatLE(nz, off + 8); off += 12;
    for (const p of [a, b, c]) {
      buf.writeFloatLE(p[0], off); buf.writeFloatLE(p[1], off + 4); buf.writeFloatLE(p[2], off + 8); off += 12;
    }
    buf.writeUInt16LE(0, off); off += 2;
  }
  fs.writeFileSync(file, buf);
  return buf.length;
}

console.error('reading STL…');
const { tris, n } = readTris();
console.error(`source triangles: ${n.toLocaleString()}`);

const arg = parseFloat(process.argv[2]);
if (!arg) {
  for (const cell of [15, 20, 25, 30, 40]) {
    const out = cluster(tris, n, cell);
    console.error(`cell ${cell}mm -> ${out.length.toLocaleString()} tris, ~${((84 + out.length * 50) / 1e6).toFixed(2)}MB STL`);
  }
} else {
  const out = cluster(tris, n, arg);
  const bytes = writeSTL(out, OUT);
  console.error(`cell ${arg}mm -> ${out.length.toLocaleString()} tris, wrote ${OUT} (${(bytes / 1e6).toFixed(2)}MB)`);
}
