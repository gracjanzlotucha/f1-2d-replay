/**
 * F1 2D Replay — Detached panel window.
 * Standalone page (panel.html?panel=standings|insights|events|track) opened
 * from the MultiView page. Loads the same static data files as the main app
 * and keeps time in sync with the main window over BroadcastChannel:
 * the main window broadcasts its playback clock ~5×/s and this window
 * extrapolates between messages, so rendering stays smooth at any rate.
 *
 * The popup never advances the race on its own authority — when the main
 * window disappears (heartbeat lost) the clock freezes and the sync badge
 * flips to DISCONNECTED until the main window comes back.
 */

'use strict';

// ═══════════════════════════════════════════════════════════════════════════
// CONSTANTS (kept in sync with app.js)
// ═══════════════════════════════════════════════════════════════════════════

const TYRE_SVG_MAP = {
  SOFT: 'soft', MEDIUM: 'medium', HARD: 'hard',
  INTERMEDIATE: 'intermediate', WET: 'wet',
};

const PLAY_SVG = '<svg viewBox="0 0 12 12" fill="none" xmlns="http://www.w3.org/2000/svg"><path d="M4.622 1.184C3.707.592 2.5 1.249 2.5 2.338v7.324c0 1.09 1.207 1.746 2.122 1.154l5.66-3.662c.837-.542.837-1.767 0-2.308L4.622 1.184z" fill="currentColor"/></svg>';
const WEATHER_SVG = '<svg viewBox="0 0 20 20" fill="none" xmlns="http://www.w3.org/2000/svg"><path d="M7.917 1.667c-2.992 0-5.417 2.425-5.417 5.416 0 2.992 2.425 5.417 5.417 5.417h5.416c2.301 0 4.167-1.866 4.167-4.167s-1.866-4.166-4.167-4.166c-.19 0-.378.012-.562.037a.356.356 0 01-.355-.137C11.446 2.621 9.793 1.667 7.917 1.667z" fill="#47C8FF"/><path d="M6.162 15.373a.833.833 0 00-1.49-.746l-.834 1.667a.833.833 0 001.49.746l.834-1.667zM10.329 15.373a.833.833 0 00-1.49-.746l-.834 1.667a.833.833 0 001.49.746l.834-1.667zM14.495 15.373a.833.833 0 00-1.49-.746l-.834 1.667a.833.833 0 001.49.746l.834-1.667z" fill="#47C8FF"/></svg>';

// Curated story cards (same data as the main page)
const RACE_INSIGHTS = [
  {
    title: 'Norris undercuts Piastri for the win',
    body: 'Piastri led for 34 laps but pitted first (lap 43). Norris came in a lap later, emerged P1 and held the gap to the flag — a textbook 1-2 for McLaren at their home race.',
    lap: 44, t: 5075, drivers: ['4', '81'],
  },
  {
    title: "Piastri's race fastest lap",
    body: "On lap 51 with fresh Mediums, Piastri threw everything at it — 1:29.337, the quickest lap of the entire race, 0.4 s faster than Norris' best.",
    lap: 51, t: 5658, drivers: ['81'],
  },
  {
    title: 'Hulkenberg: P16 → P3 podium',
    body: "Hulkenberg pitted early on lap 9 to cover Stroll. He dropped to P16 as the field cycled through stops, then climbed steadily lap after lap to seal Haas's best result of the season.",
    lap: 10, t: 1068, drivers: ['27'],
  },
  {
    title: "Hamilton's Soft tire blitz at home",
    body: 'After pitting onto Softs on lap 41, Hamilton immediately ran sub-91 s laps for 11 consecutive laps, setting the 3rd fastest time of the race (1:30.016) in front of the Silverstone crowd.',
    lap: 41, t: 4812, drivers: ['44'], compound: 'SOFT',
  },
  {
    title: 'Wet-weather chaos reshuffles the grid',
    body: 'The first 8 laps featured VSC periods, yellow-flag sectors and shifting track conditions. Track status cycled through 6 different codes — forcing teams into opportunistic early pit calls.',
    lap: 2, t: 128, drivers: [], icon: 'weather',
  },
  {
    title: "Stroll's bold Soft gamble on lap 10",
    body: 'While most drivers were still on Intermediates, Stroll switched to Softs on lap 10 — a high-risk call that briefly launched him into the top 3. He recovered from P12 to finish P7.',
    lap: 10, t: 1173, drivers: ['18'],
  },
  {
    title: "Antonelli's 4-stop nightmare",
    body: 'The rookie pitted from P4 on only lap 2, switching to Hard tyres in wet conditions — an experiment that unravelled over the race. Four stops and P16 at the flag.',
    lap: 2, t: 236, drivers: ['12'],
  },
];

const PANEL_TITLES = {
  standings: 'Standings',
  insights: 'Insights',
  events: 'Events',
  track: 'Track',
};

// ═══════════════════════════════════════════════════════════════════════════
// STATE
// ═══════════════════════════════════════════════════════════════════════════

const PANEL = new URLSearchParams(location.search).get('panel') || 'standings';

const P = {
  // data
  session: null,
  drivers: {},
  laps: [],
  insights: {},
  weatherTimeline: null,
  positions: null,   // loaded for standings only
  // derived
  lapStartTimes: [],
  lapStartMap: {},
  totalLaps: 0,
  maxT: 0,
  driverStatus: {},
  pitStops: [],
  gridStart: {},     // driver -> position on lap 1
  // synced clock
  t: 0,
  playing: false,
  speed: 1,
  follow: null,
  lastMsgT: 0,
  lastMsgAt: 0,      // Date.now() when last state arrived
  connected: false,
  currentLap: 0,
};

const bc = new BroadcastChannel('f1-replay-sync');

// ═══════════════════════════════════════════════════════════════════════════
// UTILITIES
// ═══════════════════════════════════════════════════════════════════════════

function bisect(arr, t) {
  let lo = 0, hi = arr.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (arr[mid] < t) lo = mid + 1; else hi = mid;
  }
  return lo;
}

function fmtLapTime(seconds) {
  if (!seconds || isNaN(seconds)) return '—';
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return `${m}:${s.toFixed(3).padStart(6, '0')}`;
}

function fmtSector(seconds) {
  if (!seconds || isNaN(seconds)) return '—';
  return seconds.toFixed(3);
}

function fmtGap(seconds) {
  if (seconds == null || isNaN(seconds)) return '—';
  return '+' + seconds.toFixed(3);
}

// ═══════════════════════════════════════════════════════════════════════════
// DATA LOADING & DERIVED DATA
// ═══════════════════════════════════════════════════════════════════════════

async function loadData() {
  const needPositions = PANEL === 'standings';
  const [dataRes, posRes] = await Promise.all([
    fetch('./data.json'),
    needPositions ? fetch('./positions.json') : Promise.resolve(null),
  ]);
  const data = await dataRes.json();
  if (posRes) P.positions = await posRes.json();

  P.session = data.session;
  P.drivers = data.drivers;
  P.laps = data.laps;
  P.insights = data.insights;
  P.weatherTimeline = data.weather_timeline || null;
  P.totalLaps = data.session.total_laps;

  // Lap start map (same as app.js)
  const lapMap = {};
  for (const lap of P.laps) {
    if (lap.lap_start != null && lap.lap != null) {
      if (!(lap.lap in lapMap) || lap.lap_start < lapMap[lap.lap]) {
        lapMap[lap.lap] = lap.lap_start;
      }
    }
  }
  P.lapStartMap = lapMap;
  P.lapStartTimes = Object.entries(lapMap)
    .map(([l, t]) => ({ lap: parseInt(l), t }))
    .sort((a, b) => a.lap - b.lap);

  // Max race time
  let maxT = 0;
  if (P.positions) {
    for (const num in P.positions) {
      const ts = P.positions[num].t;
      if (ts && ts.length) maxT = Math.max(maxT, ts[ts.length - 1]);
    }
  } else {
    for (const lap of P.laps) {
      if (lap.lap_start != null && lap.lap_time != null) {
        maxT = Math.max(maxT, lap.lap_start + lap.lap_time);
      }
    }
  }
  P.maxT = maxT;

  // DNS / DNF detection (simplified from app.js — no positions fallback needed
  // for display purposes; drivers with zero laps are DNS)
  const maxLapByDriver = {};
  for (const lap of P.laps) {
    if (lap.lap != null) {
      maxLapByDriver[lap.driver] = Math.max(maxLapByDriver[lap.driver] || 0, lap.lap);
    }
  }
  for (const num in P.drivers) {
    const maxLap = maxLapByDriver[num] || 0;
    const st = { status: 'racing', retirementLap: null };
    if (maxLap === 0) st.status = 'dns';
    else if (maxLap < P.totalLaps) { st.status = 'dnf'; st.retirementLap = maxLap; }
    P.driverStatus[num] = st;
  }

  // Pit stop windows (for live PIT badge)
  const pitPending = {};
  for (const lap of P.laps) {
    if (lap.pit_in != null) pitPending[lap.driver] = lap.pit_in;
    if (lap.pit_out != null && pitPending[lap.driver] != null) {
      P.pitStops.push({ driver: lap.driver, tStart: pitPending[lap.driver], tEnd: lap.pit_out });
      delete pitPending[lap.driver];
    }
  }

  // Starting positions (lap 1)
  for (const lap of P.laps) {
    if (lap.lap === 1 && lap.position && !(lap.driver in P.gridStart)) {
      P.gridStart[lap.driver] = lap.position;
    }
  }
}

function lapAtT(t) {
  let lap = 1;
  for (const entry of P.lapStartTimes) {
    if (entry.t <= t) lap = entry.lap;
    else break;
  }
  return lap;
}

function getWeather(t) {
  const wt = P.weatherTimeline;
  if (!wt || !wt.length) return null;
  let lo = 0, hi = wt.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (wt[mid].t <= t) lo = mid + 1; else hi = mid;
  }
  const idx = Math.max(0, lo - 1);
  return wt[idx];
}

/** Live speed / DRS for a driver at time t (standings panel only). */
function getLiveTelemetry(num, t) {
  const pd = P.positions?.[num];
  if (!pd || !pd.speed || !pd.speed.length) return null;
  const idx = bisect(pd.t, t);
  if (idx === 0) return { speed: pd.speed[0], drs: pd.drs[0] };
  if (idx >= pd.t.length) {
    const i = pd.t.length - 1;
    return { speed: pd.speed[i], drs: pd.drs[i] };
  }
  const t0 = pd.t[idx - 1], t1 = pd.t[idx];
  const f = t1 === t0 ? 0 : (t - t0) / (t1 - t0);
  const near = (t - t0 <= t1 - t) ? idx - 1 : idx;
  return {
    speed: pd.speed[idx - 1] + f * (pd.speed[idx] - pd.speed[idx - 1]),
    drs: pd.drs[near],
  };
}

// ═══════════════════════════════════════════════════════════════════════════
// TIMING COMPUTATION (extended standings)
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Walks the lap table once and computes, as of time t:
 * per-driver current/last-completed lap rows, lap & sector personal bests,
 * pit counts, lap-start times — plus session-wide best lap & sectors.
 */
function computeTiming(t) {
  const byDriver = {};
  const session = { bestLap: Infinity, bestS: [Infinity, Infinity, Infinity] };

  for (const row of P.laps) {
    if (row.lap == null) continue;
    const d = byDriver[row.driver] || (byDriver[row.driver] = {
      curRow: null, lastRow: null,
      bestLap: Infinity, bestS: [Infinity, Infinity, Infinity],
      pits: 0, lapStarts: {},
    });
    if (row.lap_start != null) {
      d.lapStarts[row.lap] = row.lap_start;
      if (row.lap_start <= t && (!d.curRow || row.lap > d.curRow.lap)) d.curRow = row;
    }
    if (row.pit_in != null && row.pit_in <= t) d.pits++;

    const completed = row.lap_time != null && row.lap_start != null
      && (row.lap_start + row.lap_time) <= t;
    if (completed) {
      if (!d.lastRow || row.lap > d.lastRow.lap) d.lastRow = row;
      if (row.lap_time < d.bestLap) d.bestLap = row.lap_time;
      if (row.lap_time < session.bestLap) session.bestLap = row.lap_time;
      const secs = [row.sector1, row.sector2, row.sector3];
      for (let i = 0; i < 3; i++) {
        const s = secs[i];
        if (s != null && !isNaN(s)) {
          if (s < d.bestS[i]) d.bestS[i] = s;
          if (s < session.bestS[i]) session.bestS[i] = s;
        }
      }
    }
  }

  // Order drivers by their current position; DNS drivers sink to the bottom
  const order = Object.keys(P.drivers).sort((a, b) => {
    const pa = byDriver[a]?.curRow?.position ?? 99;
    const pb = byDriver[b]?.curRow?.position ?? 99;
    return pa - pb;
  });

  // Gaps to leader from lap-crossing timestamps (timing-screen style:
  // the gap updates each time a driver starts the lap the leader started)
  const leader = order[0];
  const leaderD = byDriver[leader];
  const leaderLap = leaderD?.curRow?.lap ?? 0;

  for (const num of order) {
    const d = byDriver[num];
    if (!d) continue;
    d.gapToLeader = null;
    d.lapsDown = 0;
    if (num === leader || !d.curRow || !leaderD) continue;
    const myLap = d.curRow.lap;
    d.lapsDown = Math.max(0, leaderLap - myLap);
    if (d.lapsDown <= 0 || (d.lapsDown === 1 && d.lapStarts[leaderLap] == null)) {
      // On the lead lap (or about to be scored on it): compare crossing times
      const m = d.lapStarts[myLap], l = leaderD.lapStarts[myLap];
      if (m != null && l != null) d.gapToLeader = Math.max(0, m - l);
      d.lapsDown = 0;
    }
  }

  return { byDriver, session, order, leader };
}

// ═══════════════════════════════════════════════════════════════════════════
// RENDERERS
// ═══════════════════════════════════════════════════════════════════════════

const content = () => document.getElementById('pp-content');

// ── STANDINGS ───────────────────────────────────────────────────────────────

const standingsRenderer = {
  rows: {},       // driver -> { el, refs }
  table: null,
  _lastTimingAt: -1,

  init() {
    content().classList.add('pp-standings');
    const table = document.createElement('div');
    table.className = 'mvs-table';
    table.innerHTML = `
      <div class="mvs-head">
        <div>P</div><div></div><div style="text-align:left;padding-left:9px">Driver</div>
        <div>Tyre</div><div>Pit</div>
        <div>Last</div><div>Best</div>
        <div>Int</div><div>Gap</div>
        <div>S1</div><div>S2</div><div>S3</div>
        <div>Spd</div><div>DRS</div>
      </div>`;
    content().appendChild(table);
    this.table = table;

    for (const num of Object.keys(P.drivers)) {
      const driver = P.drivers[num];
      const color = driver.color || '#555';
      const el = document.createElement('div');
      el.className = 'mvs-row';
      el.dataset.driver = num;
      el.innerHTML = `
        <div class="mvs-pos">—</div>
        <div class="mvs-chg"></div>
        <div class="mvs-tag">
          <span class="mvs-tag-bar" style="background:${color}"></span>
          <span class="mvs-num">${num}</span>
          <span class="mvs-abbr">${driver.abbr}</span>
        </div>
        <div class="mvs-tyre"><img src="" alt="" /><span class="mvs-tyre-life"></span></div>
        <div class="mvs-pits">0</div>
        <div class="mvs-time mvs-last">—</div>
        <div class="mvs-time mvs-best">—</div>
        <div class="mvs-int">—</div>
        <div class="mvs-gap">—</div>
        <div class="mvs-sec mvs-s1">—</div>
        <div class="mvs-sec mvs-s2">—</div>
        <div class="mvs-sec mvs-s3">—</div>
        <div class="mvs-spd">—</div>
        <div class="mvs-drs"><span class="mvs-drs-box">DRS</span></div>`;
      el.addEventListener('click', () => {
        bc.postMessage({ type: 'cmd', action: 'follow', driver: P.follow === num ? null : num });
      });
      this.rows[num] = {
        el,
        pos: el.querySelector('.mvs-pos'),
        chg: el.querySelector('.mvs-chg'),
        tyreImg: el.querySelector('.mvs-tyre img'),
        tyreLife: el.querySelector('.mvs-tyre-life'),
        pits: el.querySelector('.mvs-pits'),
        last: el.querySelector('.mvs-last'),
        best: el.querySelector('.mvs-best'),
        int: el.querySelector('.mvs-int'),
        gap: el.querySelector('.mvs-gap'),
        s1: el.querySelector('.mvs-s1'),
        s2: el.querySelector('.mvs-s2'),
        s3: el.querySelector('.mvs-s3'),
        spd: el.querySelector('.mvs-spd'),
        drs: el.querySelector('.mvs-drs-box'),
      };
      table.appendChild(el);
    }
  },

  tick(t) {
    // Telemetry columns every frame; timing columns 4×/s (lap data only
    // changes when someone crosses a line — 250 ms is plenty)
    const now = performance.now();
    const doTiming = now - this._lastTimingAt > 250;
    if (doTiming) this._lastTimingAt = now;

    if (doTiming) this.updateTiming(t);
    this.updateTelemetry(t);
  },

  updateTiming(t) {
    const { byDriver, session, order } = computeTiming(t);
    const EPS = 0.0005;
    const ordered = [];
    let prevGap = null, prevLapsDown = 0;

    order.forEach((num, idx) => {
      const r = this.rows[num];
      if (!r) return;
      const d = byDriver[num] || {};
      const cur = d.curRow || {};
      const lastRow = d.lastRow;
      const st = P.driverStatus[num] || {};
      const pos = cur.position || idx + 1;

      // Retired state
      const isDnf = st.status === 'dnf' && st.retirementLap != null && lapAtT(t) > st.retirementLap;
      const isDns = st.status === 'dns';
      const retired = isDnf || isDns;
      r.el.classList.toggle('retired', retired);
      r.el.classList.toggle('following', P.follow === num);

      // Position + change vs start
      r.pos.textContent = pos;
      const start = P.gridStart[num];
      if (!retired && start && start !== pos) {
        const delta = start - pos;
        r.chg.textContent = (delta > 0 ? '▲' : '▼') + Math.abs(delta);
        r.chg.className = 'mvs-chg ' + (delta > 0 ? 'up' : 'down');
      } else {
        r.chg.textContent = '';
        r.chg.className = 'mvs-chg';
      }

      // Tyre + life
      const compound = (cur.compound || 'UNKNOWN').toUpperCase();
      const svg = TYRE_SVG_MAP[compound];
      const src = svg ? `assets/tyres/${svg}.svg` : '';
      if (r.tyreImg.getAttribute('src') !== src) r.tyreImg.src = src;
      r.tyreImg.style.visibility = src ? 'visible' : 'hidden';
      r.tyreLife.textContent = cur.tyre_life != null ? cur.tyre_life : '';

      r.pits.textContent = d.pits || 0;

      // Last / best lap
      const lastTime = lastRow?.lap_time;
      r.last.textContent = fmtLapTime(lastTime);
      r.last.className = 'mvs-time mvs-last'
        + (lastTime && Math.abs(lastTime - session.bestLap) < EPS ? ' sb'
          : lastTime && Math.abs(lastTime - d.bestLap) < EPS ? ' pb' : '');
      const bestTime = isFinite(d.bestLap) ? d.bestLap : null;
      r.best.textContent = fmtLapTime(bestTime);
      r.best.className = 'mvs-time mvs-best'
        + (bestTime && Math.abs(bestTime - session.bestLap) < EPS ? ' sb' : '');

      // Interval / gap
      const inPit = !retired && P.pitStops.some(ps => ps.driver === num && t >= ps.tStart && t <= ps.tEnd);
      if (isDns) {
        r.int.innerHTML = '<span class="mvs-badge dns">DNS</span>';
        r.gap.textContent = '';
      } else if (isDnf) {
        r.int.innerHTML = '<span class="mvs-badge dnf">DNF</span>';
        r.gap.textContent = '';
      } else if (idx === 0) {
        r.int.textContent = inPit ? '' : '—';
        if (inPit) r.int.innerHTML = '<span class="mvs-badge pit">PIT</span>';
        r.gap.textContent = 'Leader';
      } else {
        if (inPit) {
          r.int.innerHTML = '<span class="mvs-badge pit">PIT</span>';
        } else if (d.lapsDown > 0) {
          const diff = d.lapsDown - prevLapsDown;
          r.int.textContent = diff > 0 ? `+${diff}L` : (d.gapToLeader != null && prevGap != null ? fmtGap(d.gapToLeader - prevGap) : '—');
        } else if (d.gapToLeader != null && prevGap != null) {
          r.int.textContent = fmtGap(Math.max(0, d.gapToLeader - prevGap));
        } else {
          r.int.textContent = '—';
        }
        r.gap.textContent = d.lapsDown > 0 ? `+${d.lapsDown}L` : fmtGap(d.gapToLeader);
      }
      if (!retired) { prevGap = d.lapsDown > 0 ? null : d.gapToLeader; prevLapsDown = d.lapsDown; }

      // Sectors of last completed lap, colored vs personal/session best
      const secs = lastRow ? [lastRow.sector1, lastRow.sector2, lastRow.sector3] : [null, null, null];
      [r.s1, r.s2, r.s3].forEach((cell, i) => {
        const v = secs[i];
        cell.textContent = fmtSector(v);
        cell.className = cell.className.replace(/ (pb|sb)/g, '');
        if (v != null && !isNaN(v)) {
          if (Math.abs(v - session.bestS[i]) < EPS) cell.className += ' sb';
          else if (Math.abs(v - d.bestS[i]) < EPS) cell.className += ' pb';
        }
      });

      ordered.push(r.el);
    });

    // Reorder DOM (header stays first)
    ordered.forEach((el, i) => {
      const want = this.table.children[i + 1];
      if (want !== el) this.table.insertBefore(el, want || null);
    });
  },

  updateTelemetry(t) {
    for (const num in this.rows) {
      const r = this.rows[num];
      if (r.el.classList.contains('retired')) {
        r.spd.textContent = '—';
        r.drs.classList.remove('active');
        continue;
      }
      const tel = getLiveTelemetry(num, t);
      if (!tel) continue;
      r.spd.textContent = Math.round(tel.speed);
      r.drs.classList.toggle('active', tel.drs >= 10);
    }
  },
};

// ── INSIGHTS ────────────────────────────────────────────────────────────────

const insightsRenderer = {
  init() {
    let html = '';
    for (const ins of RACE_INSIGHTS) {
      let itemsHtml = '';
      let itemCount = 0;
      if (ins.icon === 'weather') {
        itemsHtml += `<div class="ric-weather-icon">${WEATHER_SVG}</div>`;
        itemCount++;
      }
      for (const num of ins.drivers || []) {
        const driver = P.drivers[num];
        if (!driver) continue;
        const color = driver.color || '#555';
        itemsHtml += `<div class="ric-driver-photo" style="background-color:${color}"><img src="assets/drivers/${driver.abbr}.png" alt="${driver.abbr}" /></div>`;
        itemCount++;
      }
      if (ins.compound) {
        const svg = TYRE_SVG_MAP[ins.compound] || 'soft';
        itemsHtml += `<div class="ric-tyre"><img src="assets/tyres/${svg}.svg" alt="${ins.compound}" /></div>`;
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
        </div>`;
    }
    content().innerHTML = html;
    content().querySelectorAll('.race-insight-card').forEach(card => {
      card.addEventListener('click', () => {
        bc.postMessage({ type: 'cmd', action: 'seek', t: parseFloat(card.dataset.t) });
        bc.postMessage({ type: 'cmd', action: 'play' });
      });
    });
  },
  tick() {},
};

// ── EVENTS ──────────────────────────────────────────────────────────────────

const eventsRenderer = {
  _lastLap: -1,

  init() {
    content().innerHTML = '<div class="insights-empty">Events will appear as the race progresses</div>';
  },

  tick(t) {
    const lap = lapAtT(t);
    if (lap === this._lastLap) return;
    this._lastLap = lap;

    const STATUS_TYPES = new Set(['safety_car', 'red_flag', 'vsc', 'yellow']);
    const BADGE_CLASS = { safety_car: 'yellow', red_flag: 'red', vsc: 'yellow', yellow: 'yellow' };

    // Full history: current lap first, back to lap 1
    let html = '';
    let hasContent = false;
    for (let l = lap; l >= 1; l--) {
      const events = P.insights[String(l)];
      if (!events || !events.length) continue;
      hasContent = true;

      const statusEvs = events.filter(e => STATUS_TYPES.has(e.type));
      const driverEvs = events.filter(e => !STATUS_TYPES.has(e.type));

      let badgeHtml = '';
      for (const se of statusEvs) {
        badgeHtml += `<span class="ev-badge ${BADGE_CLASS[se.type] || 'yellow'}">${se.title}</span>`;
      }

      html += `<div class="ev-lap-group">`;
      html += `<div class="ev-lap-header"><span class="ev-lap-title">Lap ${l}</span><div>${badgeHtml}</div></div>`;
      html += `<div class="ev-items">`;
      for (const ev of driverEvs) {
        const driver = ev.driver ? P.drivers[ev.driver] : null;
        const teamColor = ev.color || '#272a35';
        const text = ev.detail ? `${ev.title} - ${ev.detail}` : ev.title;
        if (driver) {
          html += `<div class="ev-row">
            <div class="ev-photo" style="background-color:${teamColor}"><img src="assets/drivers/${driver.abbr}.png" alt="${driver.abbr}" /></div>
            <span class="ev-text">${text}</span>
          </div>`;
        } else {
          html += `<div class="ev-row"><span class="ev-text">${text}</span></div>`;
        }
      }
      html += `</div></div>`;
    }

    if (!hasContent) html = '<div class="insights-empty">No notable events yet</div>';

    const el = content();
    const scrollTop = el.scrollTop;
    el.innerHTML = html;
    el.scrollTop = scrollTop;
  },
};

// ── TRACK INFO ──────────────────────────────────────────────────────────────

const trackRenderer = {
  init() {
    const s = P.session;
    let html = '';
    html += '<div class="trk-section">';
    html += '<div class="trk-title">Overview</div>';
    html += `<div class="trk-row"><div class="trk-label">Name</div><div class="trk-val">${s.circuit}</div></div>`;
    html += `<div class="trk-row"><div class="trk-label">Event</div><div class="trk-val">${s.name}</div></div>`;
    if (s.total_laps) {
      html += `<div class="trk-row"><div class="trk-label">Total Laps</div><div class="trk-val">${s.total_laps}</div></div>`;
    }
    html += '</div>';

    const w = getWeather(0) || s.weather;
    if (w) {
      html += '<div class="trk-section">';
      html += '<div class="trk-title">Weather</div>';
      html += '<div class="trk-cols">';
      html += `<div class="trk-row"><div class="trk-label">Air temp.</div><div class="trk-val" id="track-weather-air">${w.air_temp}°C</div></div>`;
      html += `<div class="trk-row"><div class="trk-label">Track temp.</div><div class="trk-val" id="track-weather-track">${w.track_temp}°C</div></div>`;
      html += '</div>';
      html += '<div class="trk-cols">';
      html += `<div class="trk-row"><div class="trk-label">Humidity</div><div class="trk-val" id="track-weather-humidity">${w.humidity}%</div></div>`;
      html += `<div class="trk-row"><div class="trk-label">Conditions</div><div class="trk-val ${w.rainfall ? 'rain' : 'dry'}" id="track-weather-cond">${w.rainfall ? 'Wet' : 'Dry'}</div></div>`;
      html += '</div></div>';
    }
    content().innerHTML = html;
  },

  tick(t) {
    const w = getWeather(t);
    if (!w) return;
    const airEl = document.getElementById('track-weather-air');
    const trkEl = document.getElementById('track-weather-track');
    const humEl = document.getElementById('track-weather-humidity');
    const conEl = document.getElementById('track-weather-cond');
    if (airEl) airEl.textContent = `${w.air_temp}°C`;
    if (trkEl) trkEl.textContent = `${w.track_temp}°C`;
    if (humEl) humEl.textContent = `${w.humidity}%`;
    if (conEl) {
      conEl.textContent = w.rainfall ? 'Wet' : 'Dry';
      conEl.className = `trk-val ${w.rainfall ? 'rain' : 'dry'}`;
    }
  },
};

const RENDERERS = {
  standings: standingsRenderer,
  insights: insightsRenderer,
  events: eventsRenderer,
  track: trackRenderer,
};

// ═══════════════════════════════════════════════════════════════════════════
// CLOCK SYNC & MAIN LOOP
// ═══════════════════════════════════════════════════════════════════════════

bc.onmessage = (e) => {
  const m = e.data || {};
  if (m.type === 'state') {
    P.lastMsgT = m.t;
    P.lastMsgAt = Date.now();
    P.playing = m.playing;
    P.speed = m.speed;
    P.follow = m.follow ?? null;
    setConnected(true);
  } else if (m.type === 'main-hello') {
    // Main page (re)loaded — re-register so it hides this panel again
    bc.postMessage({ type: 'panel-open', panel: PANEL });
  } else if (m.type === 'main-bye') {
    setConnected(false);
  }
};

function setConnected(on) {
  if (P.connected === on) return;
  P.connected = on;
  const badge = document.getElementById('pp-sync');
  const label = document.getElementById('pp-sync-label');
  badge.classList.toggle('disconnected', !on);
  label.textContent = on ? 'SYNC' : 'NO SIGNAL';
  if (!on) {
    // Freeze the clock where extrapolation last placed it
    P.lastMsgT = P.t;
    P.playing = false;
  }
}

function currentTime() {
  if (!P.playing) return P.lastMsgT;
  const dt = (Date.now() - P.lastMsgAt) / 1000;
  return Math.min(P.maxT, P.lastMsgT + dt * P.speed);
}

function loop() {
  // Heartbeat watchdog: main broadcasts every 200 ms; 2.5 s of silence
  // means the main window is gone (closed, crashed, or frozen)
  if (P.connected && Date.now() - P.lastMsgAt > 2500) setConnected(false);

  P.t = currentTime();
  const lap = lapAtT(P.t);
  if (lap !== P.currentLap) {
    P.currentLap = lap;
    document.getElementById('pp-lap-cur').textContent = lap;
  }

  RENDERERS[PANEL].tick(P.t);
  requestAnimationFrame(loop);
}

// ═══════════════════════════════════════════════════════════════════════════
// BOOT
// ═══════════════════════════════════════════════════════════════════════════

async function init() {
  const title = PANEL_TITLES[PANEL] || 'Panel';
  document.title = `${title} — F1 2D Replay`;
  document.getElementById('pp-title').textContent = title;

  await loadData();

  document.getElementById('pp-race').textContent = P.session.name;
  document.getElementById('pp-lap-total').textContent = P.totalLaps;

  RENDERERS[PANEL].init();

  document.getElementById('pp-loading').remove();
  document.getElementById('pp-app').classList.remove('hidden');

  // Register with the main window (it hides the embedded panel in response)
  bc.postMessage({ type: 'panel-open', panel: PANEL });

  window.addEventListener('pagehide', () => {
    bc.postMessage({ type: 'panel-close', panel: PANEL });
  });

  // Space = play/pause, same as the main window
  document.addEventListener('keydown', (e) => {
    if (e.code === 'Space') {
      e.preventDefault();
      bc.postMessage({ type: 'cmd', action: 'toggle' });
    }
  });

  loop();
}

init().catch(err => {
  const el = document.getElementById('pp-loading');
  if (el) el.textContent = `Error: ${err.message}`;
  console.error('Panel init error:', err);
});
