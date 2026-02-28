/**
 * test.js — Bahrain Pre-Season Testing Replay
 *
 * Fetches 2026 pre-season testing data from OpenF1 via the serverless proxy,
 * processes it into the same format as data.json + positions.json,
 * then dynamically loads app.js to render the full replay.
 */

// ─── Team mappings ──────────────────────────────────────────────────────────

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
};

// ─── API helper ─────────────────────────────────────────────────────────────

async function api(endpoint, params = {}) {
  const qs = new URLSearchParams({ endpoint, ...params }).toString();
  const resp = await fetch(`/api/f1?${qs}`);
  if (!resp.ok) {
    const err = await resp.json().catch(() => ({}));
    throw new Error(err.error || `API ${endpoint}: ${resp.status}`);
  }
  return resp.json();
}

// ─── Loading helpers ────────────────────────────────────────────────────────

function setLoading(msg, pct) {
  const msgEl = document.getElementById('loading-msg');
  const barEl = document.getElementById('loading-bar');
  if (msgEl) msgEl.textContent = msg;
  if (barEl) barEl.style.width = pct + '%';
}

// ─── Timestamp helpers ──────────────────────────────────────────────────────

function parseISO(s) {
  if (!s) return null;
  return new Date(s).getTime() / 1000; // seconds since epoch
}

// ─── Throttled batch fetcher ────────────────────────────────────────────────

async function fetchSequential(calls, onProgress) {
  const results = [];
  for (let i = 0; i < calls.length; i++) {
    const result = await calls[i]();
    results.push(result);
    if (onProgress) onProgress(i + 1, calls.length);
    // Small delay to respect rate limits (max 6 req/s)
    if (i < calls.length - 1) {
      await new Promise(r => setTimeout(r, 200));
    }
  }
  return results;
}

// ─── Resample array to 2 Hz ────────────────────────────────────────────────

function resample2Hz(times, values, tStart, tEnd) {
  if (!times.length) return [];
  const step = 0.5; // 2 Hz
  const result = [];
  let idx = 0;
  for (let t = tStart; t <= tEnd; t += step) {
    // Advance idx to nearest time
    while (idx < times.length - 1 && times[idx + 1] <= t) idx++;
    result.push(values[idx]);
  }
  return result;
}

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

// ─── Main ───────────────────────────────────────────────────────────────────

async function init() {
  try {
    // 1. Find Bahrain testing sessions
    setLoading('Finding 2026 sessions…', 5);
    const sessions = await api('sessions', { year: '2026' });

    // Find pre-season testing sessions
    const testSessions = sessions.filter(s => {
      const name = (s.session_name || '').toLowerCase();
      const loc = (s.location || '').toLowerCase();
      const country = (s.country_name || '').toLowerCase();
      return name.includes('test') ||
        (loc.includes('bahrain') || loc.includes('sakhir') || country.includes('bahrain'));
    });

    // Only past sessions (have actual data)
    const now = new Date().toISOString();
    const pastTestSessions = testSessions.filter(s => s.date_start && s.date_start < now);
    const pastSessions = sessions.filter(s => s.date_start && s.date_start < now);

    // Pick the most recent past test session with session_type 'Practice'
    // (prefer actual testing days over qualifying/race)
    const practiceSessions = pastTestSessions.filter(s =>
      s.session_type === 'Practice' && (s.session_name || '').toLowerCase().includes('day')
    );
    const targetSession = practiceSessions.length > 0
      ? practiceSessions[practiceSessions.length - 1]
      : pastTestSessions.length > 0
        ? pastTestSessions[pastTestSessions.length - 1]
        : pastSessions.length > 0
          ? pastSessions[pastSessions.length - 1]
          : sessions[0];

    if (!targetSession) {
      setLoading('No 2026 sessions found in API', 100);
      return;
    }

    console.log('Selected session:', targetSession);
    const sessionKey = String(targetSession.session_key);
    const sessionStart = parseISO(targetSession.date_start);
    const sessionEnd = targetSession.date_end ? parseISO(targetSession.date_end) : sessionStart + 3600;

    // Update loading screen title
    const titleEl = document.querySelector('.loading-title');
    const subtitleEl = document.querySelector('.loading-subtitle');
    if (titleEl) titleEl.textContent = targetSession.session_name || 'Pre-Season Testing';
    if (subtitleEl) subtitleEl.textContent = `${targetSession.location || 'Bahrain'} — ${targetSession.country_name || ''}`;

    // 2. Fetch metadata (drivers, laps, stints, position, weather, race_control)
    setLoading('Fetching session data…', 10);
    const [rawDrivers, rawLaps, rawStints, rawPits, rawRaceControl, rawPositions, rawWeather] =
      await Promise.all([
        api('drivers', { session_key: sessionKey }),
        api('laps', { session_key: sessionKey }).catch(() => []),
        api('stints', { session_key: sessionKey }).catch(() => []),
        api('pit', { session_key: sessionKey }).catch(() => []),
        api('race_control', { session_key: sessionKey }).catch(() => []),
        api('position', { session_key: sessionKey }).catch(() => []),
        api('weather', { session_key: sessionKey }).catch(() => []),
      ]);

    // Deduplicate drivers
    const driversMap = {};
    for (const d of rawDrivers) {
      driversMap[d.driver_number] = d;
    }
    const driverNumbers = Object.keys(driversMap);
    console.log(`Found ${driverNumbers.length} drivers`);

    // Build drivers object (same format as data.json)
    const drivers = {};
    for (const dn of driverNumbers) {
      const d = driversMap[dn];
      const team = d.team_name || 'Unknown';
      const knownColor = TEAM_COLORS[team];
      const rawColor = d.team_colour;
      const color = knownColor || (rawColor ? '#' + rawColor : '#888888');
      const teamSlug = TEAM_LOGO_MAP[team] || '';

      drivers[dn] = {
        number: parseInt(dn),
        abbr: d.name_acronym || dn,
        name: d.full_name || d.name_acronym || dn,
        team,
        color,
        teamSlug,
      };
    }

    // 3. Fetch location data per driver (this is the big one)
    setLoading('Fetching track positions…', 20);

    // Limit to 60 minutes of data to keep it manageable
    const maxDuration = 3600; // 60 min in seconds
    const endTime = Math.min(sessionEnd, sessionStart + maxDuration);
    const dateStart = new Date(sessionStart * 1000).toISOString();
    const dateEnd = new Date(endTime * 1000).toISOString();

    const locationCalls = driverNumbers.map(dn => () =>
      api('location', {
        session_key: sessionKey,
        driver_number: dn,
        'date>': dateStart,
        'date<': dateEnd,
      }).catch(() => [])
    );

    const locationResults = await fetchSequential(locationCalls, (done, total) => {
      const pct = 20 + Math.round((done / total) * 30);
      setLoading(`Fetching positions… ${done}/${total} drivers`, pct);
    });

    const allLocationData = {};
    driverNumbers.forEach((dn, i) => {
      allLocationData[dn] = locationResults[i];
    });

    // 4. Fetch car telemetry per driver
    setLoading('Fetching telemetry…', 55);

    const carDataCalls = driverNumbers.map(dn => () =>
      api('car_data', {
        session_key: sessionKey,
        driver_number: dn,
        'date>': dateStart,
        'date<': dateEnd,
      }).catch(() => [])
    );

    const carDataResults = await fetchSequential(carDataCalls, (done, total) => {
      const pct = 55 + Math.round((done / total) * 25);
      setLoading(`Fetching telemetry… ${done}/${total} drivers`, pct);
    });

    const allCarData = {};
    driverNumbers.forEach((dn, i) => {
      allCarData[dn] = carDataResults[i];
    });

    // 5. Process data
    setLoading('Processing data…', 82);

    // Determine actual time range from location data
    let globalMinT = Infinity, globalMaxT = -Infinity;
    for (const dn of driverNumbers) {
      const locs = allLocationData[dn];
      if (!locs || !locs.length) continue;
      const first = parseISO(locs[0].date);
      const last = parseISO(locs[locs.length - 1].date);
      if (first < globalMinT) globalMinT = first;
      if (last > globalMaxT) globalMaxT = last;
    }

    if (globalMinT === Infinity) {
      setLoading('No track data available for this session', 100);
      return;
    }

    const tDuration = globalMaxT - globalMinT;

    // Build track outline from a driver's data (find driver with most points)
    let bestTrackDriver = null, bestTrackCount = 0;
    for (const dn of driverNumbers) {
      const count = (allLocationData[dn] || []).length;
      if (count > bestTrackCount) {
        bestTrackCount = count;
        bestTrackDriver = dn;
      }
    }

    // Extract one "lap" worth of track outline — use points from the middle section
    // where the driver is likely doing a clean lap
    const trackLocs = allLocationData[bestTrackDriver] || [];
    let trackX = [], trackY = [];

    if (trackLocs.length > 100) {
      // Find a clean section by looking for a loop (start/end near each other)
      // Take a section of points that forms approximately one lap
      const midIdx = Math.floor(trackLocs.length / 3);
      const startPt = { x: trackLocs[midIdx].x, y: trackLocs[midIdx].y };
      let lapEndIdx = midIdx + 200; // minimum lap length in points

      // Walk forward looking for the point that comes closest to the start
      let bestDist = Infinity, bestIdx = lapEndIdx;
      for (let i = lapEndIdx; i < Math.min(trackLocs.length, midIdx + 2000); i++) {
        const dx = trackLocs[i].x - startPt.x;
        const dy = trackLocs[i].y - startPt.y;
        const dist = dx * dx + dy * dy;
        if (dist < bestDist) {
          bestDist = dist;
          bestIdx = i;
        }
      }

      // Extract the lap points
      for (let i = midIdx; i <= bestIdx; i++) {
        trackX.push(Math.round(trackLocs[i].x * 10) / 10);
        trackY.push(Math.round(trackLocs[i].y * 10) / 10);
      }
    }

    if (trackX.length < 10) {
      // Fallback: use all points from the best driver
      for (const pt of trackLocs) {
        trackX.push(Math.round(pt.x * 10) / 10);
        trackY.push(Math.round(pt.y * 10) / 10);
      }
    }

    // Build positions (same format as positions.json)
    setLoading('Building replay data…', 87);

    const positions = {};
    for (const dn of driverNumbers) {
      const locs = allLocationData[dn] || [];
      const cars = allCarData[dn] || [];

      if (!locs.length) {
        positions[dn] = { t: [], x: [], y: [], speed: [], rpm: [], throttle: [], brake: [], gear: [], drs: [] };
        continue;
      }

      // Convert timestamps to race-relative seconds
      const locTimes = locs.map(p => parseISO(p.date) - globalMinT);
      const locX = locs.map(p => p.x);
      const locY = locs.map(p => p.y);

      // Telemetry times
      const carTimes = cars.map(c => parseISO(c.date) - globalMinT);
      const speeds = cars.map(c => c.speed || 0);
      const rpms = cars.map(c => c.rpm || 0);
      const throttles = cars.map(c => (c.throttle || 0) / 100);
      const brakes = cars.map(c => c.brake || 0);
      const gears = cars.map(c => c.n_gear || 0);
      const drss = cars.map(c => c.drs || 0);

      // Resample everything to 2 Hz
      const tEnd = tDuration;
      const step = 0.5;
      const numSamples = Math.floor(tEnd / step) + 1;
      const resampledT = [];
      for (let i = 0; i < numSamples; i++) resampledT.push(Math.round(i * step * 100) / 100);

      positions[dn] = {
        t: resampledT,
        x: resampleLerp(locTimes, locX, 0, tEnd).map(v => Math.round(v * 10) / 10),
        y: resampleLerp(locTimes, locY, 0, tEnd).map(v => Math.round(v * 10) / 10),
        speed: carTimes.length ? resampleLerp(carTimes, speeds, 0, tEnd).map(v => Math.round(v)) : resampledT.map(() => 0),
        rpm: carTimes.length ? resampleLerp(carTimes, rpms, 0, tEnd).map(v => Math.round(v)) : resampledT.map(() => 0),
        throttle: carTimes.length ? resampleLerp(carTimes, throttles, 0, tEnd).map(v => Math.round(v * 100) / 100) : resampledT.map(() => 0),
        brake: carTimes.length ? resample2Hz(carTimes, brakes, 0, tEnd) : resampledT.map(() => 0),
        gear: carTimes.length ? resample2Hz(carTimes, gears, 0, tEnd) : resampledT.map(() => 0),
        drs: carTimes.length ? resample2Hz(carTimes, drss, 0, tEnd) : resampledT.map(() => 0),
      };
    }

    // Build laps list
    const lapsList = [];
    const stintsByDriver = {};
    for (const s of rawStints) {
      const dn = String(s.driver_number);
      if (!stintsByDriver[dn]) stintsByDriver[dn] = [];
      stintsByDriver[dn].push(s);
    }

    // Process raw laps into the expected format
    const lapStartMap = {};
    for (const lap of rawLaps) {
      const dn = String(lap.driver_number);
      const lapNum = lap.lap_number;
      if (!lapNum) continue;

      const lapStart = lap.date_start ? parseISO(lap.date_start) - globalMinT : null;
      if (lapStart != null) {
        if (!lapStartMap[lapNum] || lapStart < lapStartMap[lapNum]) {
          lapStartMap[lapNum] = lapStart;
        }
      }

      // Find stint info for this lap
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

      // Find pit info
      let pitIn = null, pitOut = null, stopDuration = null;
      for (const pit of rawPits) {
        if (String(pit.driver_number) === dn && pit.lap_number === lapNum) {
          pitIn = pit.pit_duration ? lapStart : null;
          pitOut = pitIn != null && pit.pit_duration ? lapStart + pit.pit_duration : null;
          stopDuration = pit.pit_duration;
          break;
        }
      }

      // Find position from position data
      let position = null;
      for (const p of rawPositions) {
        if (String(p.driver_number) === dn) {
          position = p.position;
        }
      }

      lapsList.push({
        driver: dn,
        lap: lapNum,
        lap_time: lap.lap_duration || null,
        sector1: lap.duration_sector_1 || null,
        sector2: lap.duration_sector_2 || null,
        sector3: lap.duration_sector_3 || null,
        compound,
        tyre_life: tyreLife,
        pit_in: pitIn,
        pit_out: pitOut,
        stop_duration: stopDuration,
        lap_start: lapStart,
        position,
        is_pb: lap.is_personal_best || false,
        track_status: '1',
        stint: stintNum,
      });
    }

    // Total laps (max lap number found)
    const totalLaps = lapsList.reduce((max, l) => Math.max(max, l.lap || 0), 0) || 1;

    // Weather summary
    let weather = { air_temp: 0, track_temp: 0, humidity: 0, rainfall: false };
    if (rawWeather.length) {
      const airTemps = rawWeather.map(w => w.air_temperature).filter(Boolean);
      const trackTemps = rawWeather.map(w => w.track_temperature).filter(Boolean);
      const humidities = rawWeather.map(w => w.humidity).filter(Boolean);
      const rainfalls = rawWeather.map(w => w.rainfall);
      weather = {
        air_temp: airTemps.length ? Math.round(airTemps.reduce((a, b) => a + b) / airTemps.length * 10) / 10 : 0,
        track_temp: trackTemps.length ? Math.round(trackTemps.reduce((a, b) => a + b) / trackTemps.length * 10) / 10 : 0,
        humidity: humidities.length ? Math.round(humidities.reduce((a, b) => a + b) / humidities.length * 10) / 10 : 0,
        rainfall: rainfalls.some(r => r > 0),
      };
    }

    // Compute basic insights
    const insights = computeInsights(lapsList, drivers, totalLaps);

    // 6. Fetch circuit rotation from Multiviewer API
    setLoading('Fetching circuit info…', 92);
    let circuitInfo = null;
    let pitLanePath = [];
    try {
      const circuitKey = targetSession.circuit_key;
      if (circuitKey) {
        const circResp = await fetch(`https://api.multiviewer.app/api/v1/circuits/${circuitKey}`);
        if (circResp.ok) {
          const circData = await circResp.json();
          circuitInfo = {
            rotation: circData.rotation || 0,
            corners: (circData.corners || []).map(c => ({
              number: c.number || 0,
              letter: '',
              x: c.trackPosition?.x || 0,
              y: c.trackPosition?.y || 0,
              angle: c.angle || 0,
              distance: c.length || 0,
            })),
          };
        }
      }
    } catch (e) {
      console.warn('Could not fetch circuit info:', e);
    }

    // 7. Build final data payload (same format as data.json)
    setLoading('Building replay…', 95);

    const sessionName = targetSession.session_name || 'Pre-Season Testing';
    const circuitName = `${targetSession.location || 'Bahrain'} International Circuit`;

    const dataPayload = {
      session: {
        name: sessionName,
        circuit: circuitName,
        total_laps: totalLaps,
        weather,
      },
      drivers,
      track: {
        x: trackX,
        y: trackY,
      },
      circuit_info: circuitInfo,
      pit_lane_path: pitLanePath,
      laps: lapsList,
      insights,
    };

    // 8. Create blob URLs and load app.js
    setLoading('Loading replay engine…', 98);

    const dataBlob = new Blob([JSON.stringify(dataPayload)], { type: 'application/json' });
    const posBlob = new Blob([JSON.stringify(positions)], { type: 'application/json' });

    window.__F1_DATA_URLS = {
      data: URL.createObjectURL(dataBlob),
      positions: URL.createObjectURL(posBlob),
    };

    // Update header text before app.js loads
    const hdrName = document.getElementById('hdr-race-name');
    if (hdrName) hdrName.textContent = sessionName;
    document.title = `F1 2D Replay — ${sessionName}`;

    // Dynamically load app.js
    const script = document.createElement('script');
    script.src = 'app.js';
    script.onerror = () => {
      setLoading('Failed to load replay engine', 100);
    };
    document.body.appendChild(script);

  } catch (err) {
    setLoading(`Error: ${err.message}`, 100);
    console.error('Test init error:', err);
  }
}

// ─── Insights computation (simplified) ──────────────────────────────────────

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
  const prevPositions = {};

  for (const ln of Object.keys(byLap).map(Number).sort((a, b) => a - b)) {
    const lapGroup = byLap[ln];
    const events = [];

    // Fastest lap of this lap group
    const valid = lapGroup.filter(l => l.lap_time);
    if (valid.length) {
      const fastest = valid.reduce((a, b) => a.lap_time < b.lap_time ? a : b);
      const d = drivers[fastest.driver];
      const isOverallBest = fastest.lap_time < overallBest;
      if (isOverallBest) overallBest = fastest.lap_time;

      events.push({
        type: 'fastest_lap',
        driver: fastest.driver,
        abbr: d?.abbr || fastest.driver,
        team: d?.team || '',
        color: d?.color || '#888',
        time: fastest.lap_time,
        priority: isOverallBest ? 8 : 7,
        label: isOverallBest
          ? `${d?.abbr || fastest.driver} sets fastest lap: ${fmtLapTime(fastest.lap_time)}`
          : `${d?.abbr || fastest.driver} fastest this lap: ${fmtLapTime(fastest.lap_time)}`,
      });
    }

    // Personal bests
    for (const lap of lapGroup) {
      if (!lap.lap_time) continue;
      const prev = personalBests[lap.driver];
      if (!prev || lap.lap_time < prev) {
        personalBests[lap.driver] = lap.lap_time;
        if (prev) { // Only show if improving a previous PB
          const d = drivers[lap.driver];
          events.push({
            type: 'personal_best',
            driver: lap.driver,
            abbr: d?.abbr || lap.driver,
            team: d?.team || '',
            color: d?.color || '#888',
            time: lap.lap_time,
            priority: 6,
            label: `${d?.abbr || lap.driver} sets personal best: ${fmtLapTime(lap.lap_time)}`,
          });
        }
      }
    }

    // Pit stops
    for (const lap of lapGroup) {
      if (lap.pit_in != null) {
        const d = drivers[lap.driver];
        events.push({
          type: 'pit_stop',
          driver: lap.driver,
          abbr: d?.abbr || lap.driver,
          team: d?.team || '',
          color: d?.color || '#888',
          duration: lap.stop_duration,
          priority: 5,
          label: `${d?.abbr || lap.driver} pits${lap.stop_duration ? ' (' + lap.stop_duration.toFixed(1) + 's)' : ''}`,
        });
      }
    }

    events.sort((a, b) => b.priority - a.priority);
    insights[String(ln)] = events.slice(0, 8);
  }

  return insights;
}

function fmtLapTime(seconds) {
  if (!seconds || isNaN(seconds)) return '—';
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return `${m}:${s.toFixed(3).padStart(6, '0')}`;
}

// ─── Boot ───────────────────────────────────────────────────────────────────

init();
