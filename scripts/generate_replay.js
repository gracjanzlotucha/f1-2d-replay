/**
 * generate_replay.js — Pre-generate static replay data from OpenF1 API.
 *
 * Usage: node scripts/generate_replay.js <session_key> <output_dir> [duration_minutes]
 * Example: node scripts/generate_replay.js 11468 static/bahrain 15
 *
 * Fetches location + car_data for all drivers within a time window,
 * builds track outline from Multiviewer API, and writes data.json + positions.json.
 */

const path = require('path');
const fs = require('fs');

const BASE = 'https://api.openf1.org/v1';
const TOKEN_URL = 'https://api.openf1.org/token';

// ─── Load .env ──────────────────────────────────────────────────────────────

const envPaths = [path.join(__dirname, '..', '.env'), path.join(process.cwd(), '.env')];
for (const p of envPaths) {
  if (fs.existsSync(p)) {
    const lines = fs.readFileSync(p, 'utf8').split(/\r?\n/);
    for (const line of lines) {
      const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
      if (m) process.env[m[1]] = m[2].trim();
    }
    break;
  }
}

// ─── Auth ───────────────────────────────────────────────────────────────────

let token = null;
async function getToken() {
  if (token) return token;
  const resp = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      username: process.env.OPENF1_USERNAME,
      password: process.env.OPENF1_PASSWORD,
    }).toString(),
  });
  if (!resp.ok) throw new Error(`Auth failed: ${resp.status}`);
  const data = await resp.json();
  token = data.access_token;
  return token;
}

// ─── API fetch with retry ───────────────────────────────────────────────────

async function apiFetch(endpoint, params = {}) {
  const qs = new URLSearchParams(params).toString();
  const url = `${BASE}/${endpoint}${qs ? '?' + qs : ''}`;
  for (let attempt = 0; attempt < 6; attempt++) {
    const tok = await getToken();
    const resp = await fetch(url, { headers: { Authorization: `Bearer ${tok}` } });
    if (resp.status === 429) {
      const wait = (attempt + 1) * 10000;
      console.log(`  Rate limited, waiting ${wait / 1000}s…`);
      await new Promise(r => setTimeout(r, wait));
      continue;
    }
    if (resp.status === 401) { token = null; continue; }
    if (!resp.ok) {
      const text = await resp.text();
      throw new Error(`API ${endpoint} ${resp.status}: ${text.slice(0, 200)}`);
    }
    return resp.json();
  }
  throw new Error(`API ${endpoint}: failed after 6 retries`);
}

function parseISO(s) { return s ? new Date(s).getTime() / 1000 : null; }
function delay(ms) { return new Promise(r => setTimeout(r, ms)); }

// ─── Resample helpers ───────────────────────────────────────────────────────

function resampleLerp(times, values, tStart, tEnd) {
  if (!times.length) return [];
  const step = 0.5, result = [];
  let idx = 0;
  for (let t = tStart; t <= tEnd; t += step) {
    while (idx < times.length - 1 && times[idx + 1] <= t) idx++;
    if (idx >= times.length - 1) result.push(values[values.length - 1]);
    else {
      const t0 = times[idx], t1 = times[idx + 1];
      const f = t1 === t0 ? 0 : (t - t0) / (t1 - t0);
      result.push(values[idx] + f * (values[idx + 1] - values[idx]));
    }
  }
  return result;
}

function resample2Hz(times, values, tStart, tEnd) {
  if (!times.length) return [];
  const step = 0.5, result = [];
  let idx = 0;
  for (let t = tStart; t <= tEnd; t += step) {
    while (idx < times.length - 1 && times[idx + 1] <= t) idx++;
    result.push(values[idx]);
  }
  return result;
}

// ─── Chunked fetch (15-minute windows to avoid 422) ─────────────────────────

async function fetchChunked(endpoint, sessionKey, driverNum, dateStart, dateEnd) {
  const chunkSec = 15 * 60;
  let all = [];
  let cursor = dateStart;
  while (cursor < dateEnd) {
    const chunkEnd = Math.min(cursor + chunkSec, dateEnd);
    const ds = new Date(cursor * 1000).toISOString();
    const de = new Date(chunkEnd * 1000).toISOString();
    const params = { session_key: sessionKey, driver_number: driverNum, 'date>': ds, 'date<': de };
    const chunk = await apiFetch(endpoint, params);
    all = all.concat(chunk);
    cursor = chunkEnd;
  }
  return all;
}

// ─── Main ───────────────────────────────────────────────────────────────────

async function main() {
  const sessionKey = process.argv[2];
  const outDir = process.argv[3];
  const durationMin = parseInt(process.argv[4] || '15', 10);

  if (!sessionKey || !outDir) {
    console.error('Usage: node scripts/generate_replay.js <session_key> <output_dir> [duration_minutes]');
    console.error('Example: node scripts/generate_replay.js 11468 static/bahrain 15');
    process.exit(1);
  }

  console.log(`=== Replay Data Generator ===\n`);

  // 1. Fetch session info
  console.log(`[1/7] Fetching session ${sessionKey}…`);
  const sessions = await apiFetch('sessions', { session_key: sessionKey });
  const session = sessions[0];
  if (!session) { console.error(`Session ${sessionKey} not found`); process.exit(1); }
  console.log(`  ${session.session_name} @ ${session.location} (key=${session.session_key})`);

  const sessionStart = parseISO(session.date_start);
  const windowEnd = sessionStart + durationMin * 60;
  console.log(`  Time window: ${durationMin} minutes`);

  // 2. Fetch metadata
  console.log('[2/7] Fetching metadata…');
  const [rawDrivers, rawLaps, rawStints, rawPits, rawPositions, rawWeather] = await Promise.all([
    apiFetch('drivers', { session_key: sessionKey }),
    apiFetch('laps', { session_key: sessionKey }).catch(() => []),
    apiFetch('stints', { session_key: sessionKey }).catch(() => []),
    apiFetch('pit', { session_key: sessionKey }).catch(() => []),
    apiFetch('position', { session_key: sessionKey }).catch(() => []),
    apiFetch('weather', { session_key: sessionKey }).catch(() => []),
  ]);

  // Deduplicate drivers
  const driverMap = {};
  for (const d of rawDrivers) {
    const dn = String(d.driver_number);
    if (!driverMap[dn]) driverMap[dn] = d;
  }
  const driverNumbers = Object.keys(driverMap);
  console.log(`  ${driverNumbers.length} drivers`);

  const TEAM_LOGO_MAP = {
    'Red Bull Racing': 'red-bull', 'McLaren': 'mclaren', 'Ferrari': 'ferrari',
    'Mercedes': 'mercedes', 'Aston Martin': 'aston-martin', 'Alpine': 'alpine',
    'Haas F1 Team': 'haas', 'Haas': 'haas', 'Racing Bulls': 'racing-bulls',
    'RB': 'racing-bulls', 'Visa Cash App RB': 'racing-bulls', 'Williams': 'williams',
    'Kick Sauber': 'kick-sauber', 'Sauber': 'kick-sauber',
    'Cadillac': 'cadillac', 'Cadillac F1 Team': 'cadillac', 'Audi': 'audi',
  };
  const TEAM_COLORS = {
    'Red Bull Racing': '#3671C6', 'Ferrari': '#E8002D', 'Mercedes': '#27F4D2',
    'McLaren': '#FF8000', 'Aston Martin': '#229971', 'Alpine': '#0093CC',
    'Williams': '#64C4FF', 'Haas F1 Team': '#B6BABD', 'Haas': '#B6BABD',
    'Sauber': '#52E252', 'Kick Sauber': '#52E252', 'Audi': '#52E252',
    'Racing Bulls': '#6692FF', 'RB': '#6692FF', 'Visa Cash App RB': '#6692FF',
    'Cadillac': '#C0C0C0', 'Cadillac F1 Team': '#C0C0C0',
  };

  const drivers = {};
  for (const dn of driverNumbers) {
    const d = driverMap[dn];
    drivers[dn] = {
      number: parseInt(dn), abbr: d.name_acronym || dn,
      name: d.full_name || d.name_acronym || dn,
      team: d.team_name || '', color: TEAM_COLORS[d.team_name] || d.team_colour ? `#${d.team_colour}` : '#555',
      teamSlug: TEAM_LOGO_MAP[d.team_name] || '',
    };
  }

  // 3. Fetch location data (within time window only)
  console.log('[3/7] Fetching location data…');
  const allLocation = {};
  for (let i = 0; i < driverNumbers.length; i++) {
    const dn = driverNumbers[i];
    process.stdout.write(`  Driver ${dn} (${i + 1}/${driverNumbers.length})…`);
    const locs = await fetchChunked('location', sessionKey, dn, sessionStart, windowEnd);
    allLocation[dn] = locs;
    console.log(` ${locs.length} points`);
    if ((i + 1) % 8 === 0) await delay(1000);
  }

  // 4. Fetch car telemetry (within time window only)
  console.log('[4/7] Fetching car telemetry…');
  const allCarData = {};
  for (let i = 0; i < driverNumbers.length; i++) {
    const dn = driverNumbers[i];
    process.stdout.write(`  Driver ${dn} (${i + 1}/${driverNumbers.length})…`);
    const cd = await fetchChunked('car_data', sessionKey, dn, sessionStart, windowEnd);
    allCarData[dn] = cd;
    console.log(` ${cd.length} points`);
    if ((i + 1) % 8 === 0) await delay(1000);
  }

  // 5. Process data
  console.log('[5/7] Processing data…');

  // Find global time range from actual data
  let globalMinT = Infinity, globalMaxT = -Infinity;
  for (const dn of driverNumbers) {
    for (const pt of (allLocation[dn] || [])) {
      const t = parseISO(pt.date);
      if (t < globalMinT) globalMinT = t;
      if (t > globalMaxT) globalMaxT = t;
    }
  }
  if (globalMinT === Infinity) { console.error('No location data found'); process.exit(1); }

  const tDuration = globalMaxT - globalMinT;
  console.log(`  Time range: ${Math.round(tDuration)}s (${(tDuration / 60).toFixed(1)} min)`);

  // Build positions (resampled to 2Hz)
  const positions = {};
  for (const dn of driverNumbers) {
    const locPts = allLocation[dn] || [];
    const carPts = allCarData[dn] || [];
    if (!locPts.length) continue;

    const locTimes = locPts.map(p => parseISO(p.date) - globalMinT);
    const locX = locPts.map(p => p.x);
    const locY = locPts.map(p => p.y);

    const carTimes = carPts.map(p => parseISO(p.date) - globalMinT);
    const carSpeed = carPts.map(p => p.speed || 0);
    const carRpm = carPts.map(p => p.rpm || 0);
    const carThrottle = carPts.map(p => p.throttle || 0);
    const carBrake = carPts.map(p => p.brake || 0);
    const carGear = carPts.map(p => p.n_gear || 0);
    const carDrs = carPts.map(p => p.drs || 0);

    const tStart = 0, tEnd = tDuration;
    positions[dn] = {
      t: Array.from({ length: Math.floor(tEnd / 0.5) + 1 }, (_, i) => Math.round(i * 0.5 * 10) / 10),
      x: resampleLerp(locTimes, locX, tStart, tEnd).map(v => Math.round(v * 10) / 10),
      y: resampleLerp(locTimes, locY, tStart, tEnd).map(v => Math.round(v * 10) / 10),
      speed: resample2Hz(carTimes, carSpeed, tStart, tEnd).map(v => Math.round(v)),
      rpm: resample2Hz(carTimes, carRpm, tStart, tEnd).map(v => Math.round(v)),
      throttle: resample2Hz(carTimes, carThrottle, tStart, tEnd).map(v => Math.round(v)),
      brake: resample2Hz(carTimes, carBrake, tStart, tEnd).map(v => Math.round(v)),
      gear: resample2Hz(carTimes, carGear, tStart, tEnd).map(v => Math.round(v)),
      drs: resample2Hz(carTimes, carDrs, tStart, tEnd).map(v => Math.round(v)),
    };
  }

  // Build laps list (only laps within our time window)
  const stintsByDriver = {};
  for (const st of rawStints) {
    const dn = String(st.driver_number);
    if (!stintsByDriver[dn]) stintsByDriver[dn] = [];
    stintsByDriver[dn].push(st);
  }

  const lapsList = [];
  for (const lap of rawLaps) {
    const dn = String(lap.driver_number);
    const lapNum = lap.lap_number;
    if (!lapNum) continue;

    const lapStart = lap.date_start ? parseISO(lap.date_start) - globalMinT : null;
    // Only include laps that started within our time window
    if (lapStart != null && lapStart > tDuration) continue;

    const driverStints = stintsByDriver[dn] || [];
    let compound = null, tyreLife = null, stintNum = null;
    for (const st of driverStints) {
      if (lapNum >= (st.lap_start || 0) && lapNum <= (st.lap_end || 999)) {
        compound = st.compound;
        tyreLife = lapNum - (st.lap_start || 0) + (st.tyre_age_at_start || 0);
        stintNum = st.stint_number;
        break;
      }
    }

    let pitIn = null, pitOut = null, stopDuration = null;
    for (const pit of rawPits) {
      if (String(pit.driver_number) === dn && pit.lap_number === lapNum) {
        pitIn = pit.date ? parseISO(pit.date) - globalMinT : lapStart;
        stopDuration = pit.pit_duration;
        pitOut = pitIn != null && stopDuration ? pitIn + stopDuration : null;
        break;
      }
    }

    let position = null;
    for (const p of rawPositions) {
      if (String(p.driver_number) === dn) position = p.position;
    }

    lapsList.push({
      driver: dn, lap: lapNum, lap_time: lap.lap_duration || null,
      sector1: lap.duration_sector_1 || null, sector2: lap.duration_sector_2 || null,
      sector3: lap.duration_sector_3 || null, compound, tyre_life: tyreLife,
      pit_in: pitIn, pit_out: pitOut, stop_duration: stopDuration,
      lap_start: lapStart, position, is_pb: lap.is_personal_best || false,
      track_status: '1', stint: stintNum,
    });
  }

  const totalLaps = lapsList.reduce((max, l) => Math.max(max, l.lap || 0), 0) || 1;

  // Weather (averaged snapshot for backward compat + full timeline)
  let weather = { air_temp: 0, track_temp: 0, humidity: 0, rainfall: false };
  if (rawWeather.length) {
    const avg = (arr) => arr.length ? Math.round(arr.reduce((a, b) => a + b) / arr.length * 10) / 10 : 0;
    weather = {
      air_temp: avg(rawWeather.map(w => w.air_temperature).filter(Boolean)),
      track_temp: avg(rawWeather.map(w => w.track_temperature).filter(Boolean)),
      humidity: avg(rawWeather.map(w => w.humidity).filter(Boolean)),
      rainfall: rawWeather.some(w => w.rainfall > 0),
    };
  }
  const weatherTimeline = rawWeather
    .filter(w => w.date)
    .map(w => ({
      t: Math.round((parseISO(w.date) - globalMinT) * 10) / 10,
      air_temp: Math.round((w.air_temperature || 0) * 10) / 10,
      track_temp: Math.round((w.track_temperature || 0) * 10) / 10,
      humidity: Math.round((w.humidity || 0) * 10) / 10,
      rainfall: (w.rainfall || 0) > 0,
    }))
    .filter(w => w.t >= 0 && w.t <= tDuration)
    .sort((a, b) => a.t - b.t);
  console.log(`  ${weatherTimeline.length} weather readings`);

  // Insights
  const insights = {};
  for (const lap of lapsList) {
    const key = lap.lap;
    if (!insights[key]) insights[key] = [];
    if (lap.lap_time) {
      insights[key].push({ type: 'lap', driver: lap.driver, time: lap.lap_time });
    }
  }

  // 6. Circuit info + track outline from Multiviewer
  console.log('[6/7] Fetching circuit info…');
  let circuitInfo = null;
  let trackX = [], trackY = [];

  // Use GPS trace as fallback track outline
  let bestDriver = null, bestCount = 0;
  for (const dn of driverNumbers) {
    const count = (allLocation[dn] || []).length;
    if (count > bestCount) { bestCount = count; bestDriver = dn; }
  }
  const trackLocs = allLocation[bestDriver] || [];
  if (trackLocs.length > 100) {
    const midIdx = Math.floor(trackLocs.length / 3);
    const startPt = { x: trackLocs[midIdx].x, y: trackLocs[midIdx].y };
    let bestDist = Infinity, bestIdx = midIdx + 200;
    for (let i = midIdx + 200; i < Math.min(trackLocs.length, midIdx + 2000); i++) {
      const dx = trackLocs[i].x - startPt.x;
      const dy = trackLocs[i].y - startPt.y;
      const dist = dx * dx + dy * dy;
      if (dist < bestDist) { bestDist = dist; bestIdx = i; }
    }
    for (let i = midIdx; i <= bestIdx; i++) {
      trackX.push(Math.round(trackLocs[i].x * 10) / 10);
      trackY.push(Math.round(trackLocs[i].y * 10) / 10);
    }
  }
  console.log(`  GPS trace fallback: ${trackX.length} points`);

  try {
    const circuitKey = session.circuit_key;
    const year = session.year || new Date(session.date_start).getFullYear();
    if (circuitKey) {
      let cd = null;
      for (const tryYear of [year, year - 1, year + 1]) {
        const resp = await fetch(`https://api.multiviewer.app/api/v1/circuits/${circuitKey}/${tryYear}`);
        if (resp.ok) { cd = await resp.json(); console.log(`  Found Multiviewer data for ${tryYear}`); break; }
      }
      if (cd) {
        circuitInfo = {
          rotation: cd.rotation || 0,
          corners: (cd.corners || []).map(c => ({
            number: c.number || 0, letter: '',
            x: c.trackPosition?.x || 0, y: c.trackPosition?.y || 0,
            angle: c.angle || 0, distance: c.length || 0,
          })),
        };
        console.log(`  Rotation: ${circuitInfo.rotation}°, ${circuitInfo.corners.length} corners`);
        if (cd.x?.length > 10 && cd.y?.length > 10) {
          trackX = cd.x.map(v => Math.round(v * 10) / 10);
          trackY = cd.y.map(v => Math.round(v * 10) / 10);
          console.log(`  Using Multiviewer track outline: ${trackX.length} points`);
        }
      }
    }
  } catch (e) {
    console.log(`  Could not fetch circuit info: ${e.message}`);
  }

  // 7. Write files
  console.log('[7/7] Writing files…');

  fs.mkdirSync(outDir, { recursive: true });

  const dataPayload = {
    session: {
      name: session.session_name || 'Testing',
      circuit: session.circuit_short_name || session.location || 'Unknown',
      total_laps: totalLaps,
      weather,
    },
    drivers,
    track: { x: trackX, y: trackY },
    circuit_info: circuitInfo,
    pit_lane_path: [],
    laps: lapsList,
    insights,
    weather_timeline: weatherTimeline,
  };

  const dataPath = path.join(outDir, 'data.json');
  const posPath = path.join(outDir, 'positions.json');

  fs.writeFileSync(dataPath, JSON.stringify(dataPayload));
  fs.writeFileSync(posPath, JSON.stringify(positions));

  const dataSizeMB = (fs.statSync(dataPath).size / 1024 / 1024).toFixed(1);
  const posSizeMB = (fs.statSync(posPath).size / 1024 / 1024).toFixed(1);

  console.log(`\n  ${dataPath} (${dataSizeMB} MB)`);
  console.log(`  ${posPath} (${posSizeMB} MB)`);
  console.log('\nDone!');
}

main().catch(err => { console.error(err); process.exit(1); });
