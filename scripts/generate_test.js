#!/usr/bin/env node
/**
 * generate_test.js — Pre-generate Bahrain testing data for instant replay
 *
 * Usage: node scripts/generate_test.js
 *
 * Reads OPENF1_USERNAME / OPENF1_PASSWORD from .env (or env vars),
 * fetches all data for the most recent Bahrain pre-season testing day,
 * and writes static/test-data.json + static/test-positions.json.
 */

const fs = require('fs');
const path = require('path');

// ─── Load .env ──────────────────────────────────────────────────────────────

// Try multiple locations for .env
const envCandidates = [
  path.join(__dirname, '..', '.env'),
  path.join(process.cwd(), '.env'),
];
for (const ep of envCandidates) {
  if (fs.existsSync(ep)) {
    for (const line of fs.readFileSync(ep, 'utf8').split(/\r?\n/)) {
      const m = line.trim().match(/^([A-Z0-9_]+)=(.*)$/);
      if (m) process.env[m[1]] = m[2].trim();
    }
    break;
  }
}

const USERNAME = process.env.OPENF1_USERNAME;
const PASSWORD = process.env.OPENF1_PASSWORD;
if (!USERNAME || !PASSWORD) {
  console.error('Missing OPENF1_USERNAME / OPENF1_PASSWORD');
  process.exit(1);
}

const BASE = 'https://api.openf1.org/v1';
const TOKEN_URL = 'https://api.openf1.org/token';
const OUT_DIR = path.join(__dirname, '..', 'static');

// ─── Team mappings ──────────────────────────────────────────────────────────

const TEAM_COLORS = {
  'Red Bull Racing': '#3671C6', 'Ferrari': '#E8002D', 'Mercedes': '#27F4D2',
  'McLaren': '#FF8000', 'Aston Martin': '#229971', 'Alpine': '#0093CC',
  'Williams': '#64C4FF', 'Haas F1 Team': '#B6BABD', 'Haas': '#B6BABD',
  'Sauber': '#52E252', 'Kick Sauber': '#52E252', 'Racing Bulls': '#6692FF',
  'RB': '#6692FF', 'Visa Cash App RB': '#6692FF', 'Cadillac': '#C0C0C0',
  'Cadillac F1 Team': '#C0C0C0',
};
const TEAM_LOGO_MAP = {
  'Red Bull Racing': 'red-bull', 'McLaren': 'mclaren', 'Ferrari': 'ferrari',
  'Mercedes': 'mercedes', 'Aston Martin': 'aston-martin', 'Alpine': 'alpine',
  'Haas F1 Team': 'haas', 'Haas': 'haas', 'Racing Bulls': 'racing-bulls',
  'RB': 'racing-bulls', 'Visa Cash App RB': 'racing-bulls', 'Williams': 'williams',
  'Kick Sauber': 'kick-sauber', 'Sauber': 'kick-sauber', 'Cadillac': 'cadillac',
  'Cadillac F1 Team': 'cadillac',
};

// ─── Auth ───────────────────────────────────────────────────────────────────

let token = null;

async function getToken() {
  if (token) return token;
  console.log('  Authenticating…');
  const resp = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ username: USERNAME, password: PASSWORD }).toString(),
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

  for (let attempt = 0; attempt < 3; attempt++) {
    const tok = await getToken();
    const resp = await fetch(url, { headers: { Authorization: `Bearer ${tok}` } });

    if (resp.status === 429) {
      const wait = (attempt + 1) * 5000;
      console.log(`  Rate limited, waiting ${wait / 1000}s…`);
      await new Promise(r => setTimeout(r, wait));
      continue;
    }
    if (resp.status === 401) {
      token = null;
      continue;
    }
    if (!resp.ok) {
      const text = await resp.text();
      throw new Error(`API ${endpoint} ${resp.status}: ${text.slice(0, 200)}`);
    }
    return resp.json();
  }
  throw new Error(`API ${endpoint}: failed after 3 retries`);
}

function parseISO(s) {
  return s ? new Date(s).getTime() / 1000 : null;
}

function delay(ms) {
  return new Promise(r => setTimeout(r, ms));
}

// ─── Resample helpers ───────────────────────────────────────────────────────

function resampleLerp(times, values, tStart, tEnd) {
  if (!times.length) return [];
  const step = 0.5;
  const result = [];
  let idx = 0;
  for (let t = tStart; t <= tEnd; t += step) {
    while (idx < times.length - 1 && times[idx + 1] <= t) idx++;
    if (idx >= times.length - 1) {
      result.push(values[values.length - 1]);
    } else {
      const t0 = times[idx], t1 = times[idx + 1];
      const f = t1 === t0 ? 0 : (t - t0) / (t1 - t0);
      result.push(values[idx] + f * (values[idx + 1] - values[idx]));
    }
  }
  return result;
}

function resample2Hz(times, values, tStart, tEnd) {
  if (!times.length) return [];
  const step = 0.5;
  const result = [];
  let idx = 0;
  for (let t = tStart; t <= tEnd; t += step) {
    while (idx < times.length - 1 && times[idx + 1] <= t) idx++;
    result.push(values[idx]);
  }
  return result;
}

function fmtLapTime(s) {
  if (!s) return '—';
  const m = Math.floor(s / 60);
  const sec = s % 60;
  return `${m}:${sec.toFixed(3).padStart(6, '0')}`;
}

// ─── Main ───────────────────────────────────────────────────────────────────

async function main() {
  console.log('=== Bahrain Testing Data Generator ===\n');

  // 1. Find session
  const targetKey = process.argv[2];
  if (!targetKey) {
    console.error('Usage: node scripts/generate_test.js <session_key>');
    console.error('Example: node scripts/generate_test.js 9896  (Singapore 2025 Race)');
    process.exit(1);
  }

  console.log(`[1/7] Fetching session ${targetKey}…`);
  const sessions = await apiFetch('sessions', { session_key: targetKey });
  const session = sessions[0];
  if (!session) {
    console.error(`Session ${targetKey} not found`);
    process.exit(1);
  }

  console.log(`  Selected: ${session.session_name} @ ${session.location} (key=${session.session_key})`);
  const SK = String(session.session_key);
  const sessionStart = parseISO(session.date_start);
  const sessionEnd = session.date_end ? parseISO(session.date_end) : sessionStart + 28800;

  // 2. Fetch metadata
  console.log('[2/7] Fetching metadata…');
  const [rawDrivers, rawLaps, rawStints, rawPits, rawRC, rawPositions, rawWeather] = await Promise.all([
    apiFetch('drivers', { session_key: SK }),
    apiFetch('laps', { session_key: SK }).catch(() => []),
    apiFetch('stints', { session_key: SK }).catch(() => []),
    apiFetch('pit', { session_key: SK }).catch(() => []),
    apiFetch('race_control', { session_key: SK }).catch(() => []),
    apiFetch('position', { session_key: SK }).catch(() => []),
    apiFetch('weather', { session_key: SK }).catch(() => []),
  ]);

  // Deduplicate drivers
  const driversMap = {};
  for (const d of rawDrivers) driversMap[d.driver_number] = d;
  const driverNumbers = Object.keys(driversMap);
  console.log(`  ${driverNumbers.length} drivers, ${rawLaps.length} laps`);

  // Build drivers
  const drivers = {};
  for (const dn of driverNumbers) {
    const d = driversMap[dn];
    const team = d.team_name || 'Unknown';
    const color = TEAM_COLORS[team] || (d.team_colour ? '#' + d.team_colour : '#888');
    drivers[dn] = {
      number: parseInt(dn),
      abbr: d.name_acronym || dn,
      name: d.full_name || d.name_acronym || dn,
      team,
      color,
      teamSlug: TEAM_LOGO_MAP[team] || '',
    };
  }

  // 3. Fetch location data per driver (chunked in 15-min windows to avoid 422)
  console.log('[3/7] Fetching location data…');
  const CHUNK_SECS = 15 * 60; // 15 minutes
  const allLocation = {};
  for (let i = 0; i < driverNumbers.length; i++) {
    const dn = driverNumbers[i];
    process.stdout.write(`  Driver ${dn} (${i + 1}/${driverNumbers.length})…`);
    allLocation[dn] = [];
    try {
      for (let t = sessionStart; t < sessionEnd; t += CHUNK_SECS) {
        const from = new Date(t * 1000).toISOString();
        const to = new Date(Math.min(t + CHUNK_SECS, sessionEnd) * 1000).toISOString();
        const chunk = await apiFetch('location', {
          session_key: SK, driver_number: dn, 'date>': from, 'date<': to,
        }).catch(() => []);
        allLocation[dn].push(...chunk);
        await delay(170);
      }
      console.log(` ${allLocation[dn].length} points`);
    } catch (e) {
      console.log(` error: ${e.message}`);
    }
  }

  // 4. Fetch car telemetry per driver (chunked)
  console.log('[4/7] Fetching car telemetry…');
  const allCar = {};
  for (let i = 0; i < driverNumbers.length; i++) {
    const dn = driverNumbers[i];
    process.stdout.write(`  Driver ${dn} (${i + 1}/${driverNumbers.length})…`);
    allCar[dn] = [];
    try {
      for (let t = sessionStart; t < sessionEnd; t += CHUNK_SECS) {
        const from = new Date(t * 1000).toISOString();
        const to = new Date(Math.min(t + CHUNK_SECS, sessionEnd) * 1000).toISOString();
        const chunk = await apiFetch('car_data', {
          session_key: SK, driver_number: dn, 'date>': from, 'date<': to,
        }).catch(() => []);
        allCar[dn].push(...chunk);
        await delay(170);
      }
      console.log(` ${allCar[dn].length} points`);
    } catch (e) {
      console.log(` error: ${e.message}`);
    }
  }

  // 5. Process
  console.log('[5/7] Processing data…');

  // Global time range
  let globalMinT = Infinity, globalMaxT = -Infinity;
  for (const dn of driverNumbers) {
    const locs = allLocation[dn];
    if (!locs?.length) continue;
    const first = parseISO(locs[0].date);
    const last = parseISO(locs[locs.length - 1].date);
    if (first < globalMinT) globalMinT = first;
    if (last > globalMaxT) globalMaxT = last;
  }

  if (globalMinT === Infinity) {
    console.error('No location data found');
    process.exit(1);
  }

  const tDuration = globalMaxT - globalMinT;
  console.log(`  Time range: ${Math.round(tDuration)}s (${(tDuration / 60).toFixed(1)} min)`);

  // Build track outline
  let bestDriver = null, bestCount = 0;
  for (const dn of driverNumbers) {
    const count = (allLocation[dn] || []).length;
    if (count > bestCount) { bestCount = count; bestDriver = dn; }
  }

  const trackLocs = allLocation[bestDriver] || [];
  let trackX = [], trackY = [];

  if (trackLocs.length > 100) {
    // Find a clean lap loop from the middle of the session
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

  if (trackX.length < 10) {
    // Subsample all points
    const step = Math.max(1, Math.floor(trackLocs.length / 2000));
    for (let i = 0; i < trackLocs.length; i += step) {
      trackX.push(Math.round(trackLocs[i].x * 10) / 10);
      trackY.push(Math.round(trackLocs[i].y * 10) / 10);
    }
  }

  console.log(`  Track outline: ${trackX.length} points from driver ${bestDriver}`);

  // Build positions.json
  const positions = {};
  for (const dn of driverNumbers) {
    const locs = allLocation[dn] || [];
    const cars = allCar[dn] || [];

    if (!locs.length) {
      positions[dn] = { t: [], x: [], y: [], speed: [], rpm: [], throttle: [], brake: [], gear: [], drs: [] };
      continue;
    }

    const locTimes = locs.map(p => parseISO(p.date) - globalMinT);
    const locX = locs.map(p => p.x);
    const locY = locs.map(p => p.y);

    const carTimes = cars.map(c => parseISO(c.date) - globalMinT);
    const speeds = cars.map(c => c.speed || 0);
    const rpms = cars.map(c => c.rpm || 0);
    const throttles = cars.map(c => (c.throttle || 0) / 100);
    const brakes = cars.map(c => c.brake || 0);
    const gears = cars.map(c => c.n_gear || 0);
    const drss = cars.map(c => c.drs || 0);

    const step = 0.5;
    const numSamples = Math.floor(tDuration / step) + 1;
    const resampledT = [];
    for (let i = 0; i < numSamples; i++) resampledT.push(Math.round(i * step * 100) / 100);

    positions[dn] = {
      t: resampledT,
      x: resampleLerp(locTimes, locX, 0, tDuration).map(v => Math.round(v * 10) / 10),
      y: resampleLerp(locTimes, locY, 0, tDuration).map(v => Math.round(v * 10) / 10),
      speed: carTimes.length ? resampleLerp(carTimes, speeds, 0, tDuration).map(v => Math.round(v)) : resampledT.map(() => 0),
      rpm: carTimes.length ? resampleLerp(carTimes, rpms, 0, tDuration).map(v => Math.round(v)) : resampledT.map(() => 0),
      throttle: carTimes.length ? resampleLerp(carTimes, throttles, 0, tDuration).map(v => Math.round(v * 100) / 100) : resampledT.map(() => 0),
      brake: carTimes.length ? resample2Hz(carTimes, brakes, 0, tDuration) : resampledT.map(() => 0),
      gear: carTimes.length ? resample2Hz(carTimes, gears, 0, tDuration) : resampledT.map(() => 0),
      drs: carTimes.length ? resample2Hz(carTimes, drss, 0, tDuration) : resampledT.map(() => 0),
    };
  }

  // Build laps
  const stintsByDriver = {};
  for (const s of rawStints) {
    const dn = String(s.driver_number);
    if (!stintsByDriver[dn]) stintsByDriver[dn] = [];
    stintsByDriver[dn].push(s);
  }

  const lapsList = [];
  for (const lap of rawLaps) {
    const dn = String(lap.driver_number);
    const lapNum = lap.lap_number;
    if (!lapNum) continue;

    const lapStart = lap.date_start ? parseISO(lap.date_start) - globalMinT : null;
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
        pitIn = lapStart;
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

  // Weather
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

  // Insights
  const insights = computeInsights(lapsList, drivers, totalLaps);

  // 6. Circuit info
  console.log('[6/7] Fetching circuit info…');
  let circuitInfo = null;
  try {
    const circuitKey = session.circuit_key;
    if (circuitKey) {
      const resp = await fetch(`https://api.multiviewer.app/api/v1/circuits/${circuitKey}`);
      if (resp.ok) {
        const cd = await resp.json();
        circuitInfo = {
          rotation: cd.rotation || 0,
          corners: (cd.corners || []).map(c => ({
            number: c.number || 0, letter: '',
            x: c.trackPosition?.x || 0, y: c.trackPosition?.y || 0,
            angle: c.angle || 0, distance: c.length || 0,
          })),
        };
        console.log(`  Rotation: ${circuitInfo.rotation}°, ${circuitInfo.corners.length} corners`);
      }
    }
  } catch (e) {
    console.log(`  Could not fetch circuit info: ${e.message}`);
  }

  // 7. Write files
  console.log('[7/7] Writing files…');

  const dataPayload = {
    session: {
      name: session.session_name || 'Pre-Season Testing',
      circuit: `${session.location || 'Bahrain'} International Circuit`,
      total_laps: totalLaps,
      weather,
    },
    drivers,
    track: { x: trackX, y: trackY },
    circuit_info: circuitInfo,
    pit_lane_path: [],
    laps: lapsList,
    insights,
  };

  const dataPath = path.join(OUT_DIR, 'test-data.json');
  const posPath = path.join(OUT_DIR, 'test-positions.json');

  fs.writeFileSync(dataPath, JSON.stringify(dataPayload));
  fs.writeFileSync(posPath, JSON.stringify(positions));

  const dataSizeMB = (fs.statSync(dataPath).size / 1024 / 1024).toFixed(1);
  const posSizeMB = (fs.statSync(posPath).size / 1024 / 1024).toFixed(1);

  console.log(`\n  ${dataPath} (${dataSizeMB} MB)`);
  console.log(`  ${posPath} (${posSizeMB} MB)`);
  console.log('\nDone!');
}

// ─── Insights ───────────────────────────────────────────────────────────────

function computeInsights(laps, drivers, totalLaps) {
  const insights = {};
  const byLap = {};
  for (const lap of laps) {
    if (lap.lap == null) continue;
    if (!byLap[lap.lap]) byLap[lap.lap] = [];
    byLap[lap.lap].push(lap);
  }

  let overallBest = Infinity;
  const personalBests = {};

  for (const ln of Object.keys(byLap).map(Number).sort((a, b) => a - b)) {
    const group = byLap[ln];
    const events = [];
    const valid = group.filter(l => l.lap_time);

    if (valid.length) {
      const fastest = valid.reduce((a, b) => a.lap_time < b.lap_time ? a : b);
      const d = drivers[fastest.driver];
      const isBest = fastest.lap_time < overallBest;
      if (isBest) overallBest = fastest.lap_time;
      events.push({
        type: 'fastest_lap', driver: fastest.driver,
        abbr: d?.abbr || fastest.driver, team: d?.team || '', color: d?.color || '#888',
        time: fastest.lap_time, priority: isBest ? 8 : 7,
        label: `${d?.abbr || fastest.driver} ${isBest ? 'sets fastest lap' : 'fastest this lap'}: ${fmtLapTime(fastest.lap_time)}`,
      });
    }

    for (const lap of group) {
      if (!lap.lap_time) continue;
      const prev = personalBests[lap.driver];
      if (!prev || lap.lap_time < prev) {
        personalBests[lap.driver] = lap.lap_time;
        if (prev) {
          const d = drivers[lap.driver];
          events.push({
            type: 'personal_best', driver: lap.driver,
            abbr: d?.abbr || lap.driver, team: d?.team || '', color: d?.color || '#888',
            time: lap.lap_time, priority: 6,
            label: `${d?.abbr || lap.driver} PB: ${fmtLapTime(lap.lap_time)}`,
          });
        }
      }
    }

    for (const lap of group) {
      if (lap.pit_in != null) {
        const d = drivers[lap.driver];
        events.push({
          type: 'pit_stop', driver: lap.driver,
          abbr: d?.abbr || lap.driver, team: d?.team || '', color: d?.color || '#888',
          duration: lap.stop_duration, priority: 5,
          label: `${d?.abbr || lap.driver} pits${lap.stop_duration ? ' (' + lap.stop_duration.toFixed(1) + 's)' : ''}`,
        });
      }
    }

    events.sort((a, b) => b.priority - a.priority);
    insights[String(ln)] = events.slice(0, 8);
  }
  return insights;
}

main().catch(err => {
  console.error('\nFatal error:', err.message);
  process.exit(1);
});
