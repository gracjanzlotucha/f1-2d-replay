/**
 * test.js — Bahrain Pre-Season Test Asset Verification
 *
 * Fetches 2026 pre-season testing data from OpenF1 via the serverless proxy
 * and renders a grid of all drivers/teams to verify we have correct assets
 * (photos, logos, colors) before the live race weekend.
 */

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
  const url = `/api/f1?${qs}`;
  console.log('API request:', url);
  const resp = await fetch(url);
  if (!resp.ok) {
    const err = await resp.json().catch(() => ({}));
    console.error('API error:', endpoint, resp.status, err);
    const detail = err.detail ? ` — ${err.detail}` : '';
    throw new Error((err.error || `API ${endpoint}: ${resp.status}`) + detail);
  }
  const data = await resp.json();
  console.log(`API ${endpoint}: ${Array.isArray(data) ? data.length + ' items' : 'object'}`);
  return data;
}

// ─── Loading helpers ────────────────────────────────────────────────────────

function setLoading(msg, pct) {
  const msgEl = document.getElementById('loading-msg');
  const barEl = document.getElementById('loading-bar');
  if (msgEl) msgEl.textContent = msg;
  if (barEl) barEl.style.width = pct + '%';
}

function showApp() {
  document.getElementById('loading-screen').classList.add('hidden');
  document.getElementById('app').classList.remove('hidden');
}

// ─── Check if image exists ──────────────────────────────────────────────────

function checkImage(src) {
  return new Promise(resolve => {
    const img = new Image();
    img.onload = () => resolve(true);
    img.onerror = () => resolve(false);
    img.src = src;
  });
}

// ─── Main ───────────────────────────────────────────────────────────────────

async function init() {
  try {
    // 1. Find Bahrain testing sessions
    setLoading('Finding 2026 sessions...', 10);
    const sessions = await api('sessions', { year: '2026' });

    // Find pre-season testing sessions (Bahrain)
    // Don't filter by session_type — testing sessions may be 'Testing', 'Practice', etc.
    const testSessions = sessions.filter(s => {
      const name = (s.session_name || '').toLowerCase();
      const loc = (s.location || '').toLowerCase();
      const country = (s.country_name || '').toLowerCase();
      return name.includes('test') ||
        (loc.includes('bahrain') || loc.includes('sakhir') || country.includes('bahrain'));
    });

    // Only consider sessions that already have data (date_start is in the past)
    const now = new Date().toISOString();
    const pastTestSessions = testSessions.filter(s => s.date_start && s.date_start < now);
    const pastSessions = sessions.filter(s => s.date_start && s.date_start < now);

    // Pick the most recent PAST test session, or the most recent past session overall
    const targetSession = pastTestSessions.length > 0
      ? pastTestSessions[pastTestSessions.length - 1]
      : pastSessions.length > 0
        ? pastSessions[pastSessions.length - 1]
        : sessions[0];

    console.log('All 2026 sessions:', sessions.length);
    console.log('Test sessions found:', testSessions.length, testSessions.map(s =>
      `${s.session_key}: ${s.session_name} @ ${s.location} (${s.session_type})`));
    console.log('Selected session:', targetSession);

    if (!targetSession) {
      setLoading('No 2026 sessions found in API', 100);
      return;
    }

    const sessionKey = targetSession.session_key;
    document.getElementById('session-name').textContent =
      `${targetSession.session_name || 'Pre-Season Testing'} — ${targetSession.location || 'Bahrain'}`;

    // 2. Fetch drivers
    setLoading(`Fetching drivers for session ${sessionKey}...`, 30);
    console.log(`Fetching drivers for session_key=${sessionKey}`);
    const rawDrivers = await api('drivers', { session_key: String(sessionKey) });

    // Deduplicate drivers by number (API may return multiple entries)
    const driversMap = {};
    for (const d of rawDrivers) {
      driversMap[d.driver_number] = d;
    }
    const drivers = Object.values(driversMap);

    // 3. Check assets for each driver
    setLoading('Checking assets...', 50);

    const results = [];
    for (const d of drivers) {
      const abbr = d.name_acronym || String(d.driver_number);
      const team = d.team_name || 'Unknown';
      const teamSlug = TEAM_LOGO_MAP[team] || '';
      const photoSrc = `assets/drivers/${abbr}.png`;
      const logoSrc = teamSlug ? `assets/teams/${teamSlug}.svg` : '';
      const rawColor = d.team_colour;
      const knownColor = TEAM_COLORS[team];
      const color = knownColor || (rawColor ? '#' + rawColor : '#888888');

      const [hasPhoto, hasLogo] = await Promise.all([
        checkImage(photoSrc),
        logoSrc ? checkImage(logoSrc) : Promise.resolve(false),
      ]);

      results.push({
        number: d.driver_number,
        abbr,
        name: d.full_name || abbr,
        team,
        color,
        teamSlug,
        photoSrc,
        logoSrc,
        hasPhoto,
        hasLogo,
        hasTeamMapping: !!TEAM_LOGO_MAP[team],
        hasColorMapping: !!knownColor,
        headshotUrl: d.headshot_url || '',
      });
    }

    setLoading('Rendering...', 80);

    // 4. Render summary
    const missingPhotos = results.filter(r => !r.hasPhoto);
    const missingLogos = results.filter(r => !r.hasLogo);
    const missingTeamMaps = results.filter(r => !r.hasTeamMapping);

    const summaryEl = document.getElementById('test-summary');
    summaryEl.innerHTML = `
      <div class="test-stat ${results.length > 0 ? 'ok' : 'warn'}">
        <div class="test-stat-value">${results.length}</div>
        <div class="test-stat-label">Drivers</div>
      </div>
      <div class="test-stat ${missingPhotos.length === 0 ? 'ok' : 'error'}">
        <div class="test-stat-value">${missingPhotos.length}</div>
        <div class="test-stat-label">Missing Photos</div>
      </div>
      <div class="test-stat ${missingLogos.length === 0 ? 'ok' : 'error'}">
        <div class="test-stat-value">${missingLogos.length}</div>
        <div class="test-stat-label">Missing Logos</div>
      </div>
      <div class="test-stat ${missingTeamMaps.length === 0 ? 'ok' : 'warn'}">
        <div class="test-stat-value">${missingTeamMaps.length}</div>
        <div class="test-stat-label">Unmapped Teams</div>
      </div>
    `;

    // 5. Render driver grid
    const gridEl = document.getElementById('driver-grid');
    // Group by team
    const byTeam = {};
    for (const r of results) {
      (byTeam[r.team] = byTeam[r.team] || []).push(r);
    }

    let gridHtml = '';
    for (const [team, teamDrivers] of Object.entries(byTeam).sort()) {
      for (const r of teamDrivers) {
        const issues = [];
        if (!r.hasPhoto) issues.push('photo');
        if (!r.hasLogo) issues.push('logo');
        if (!r.hasTeamMapping) issues.push('team-map');
        if (!r.hasColorMapping) issues.push('color-map');
        const statusClass = issues.length === 0 ? 'ok' : 'missing';

        gridHtml += `
          <div class="test-card ${statusClass}">
            <div class="test-card-photo" style="background-color: ${r.color}">
              ${r.hasPhoto
                ? `<img src="${r.photoSrc}" alt="${r.abbr}" />`
                : `<div class="test-card-no-photo">${r.abbr}</div>`
              }
            </div>
            <div class="test-card-info">
              <div class="test-card-name">${r.name}</div>
              <div class="test-card-meta">
                <span class="test-card-number">#${r.number}</span>
                <span class="test-card-abbr">${r.abbr}</span>
              </div>
              <div class="test-card-team">
                ${r.hasLogo
                  ? `<img class="test-card-logo" src="${r.logoSrc}" alt="${r.team}" />`
                  : `<span class="test-card-no-logo">?</span>`
                }
                <span>${r.team}</span>
              </div>
              <div class="test-card-color">
                <span class="test-card-swatch" style="background: ${r.color}"></span>
                <span>${r.color}</span>
                ${!r.hasColorMapping ? '<span class="test-card-tag">from API</span>' : ''}
              </div>
              ${issues.length > 0 ? `
                <div class="test-card-issues">
                  ${issues.map(i => `<span class="test-card-issue">${i}</span>`).join('')}
                </div>
              ` : '<div class="test-card-ok">All assets OK</div>'}
              ${r.headshotUrl && !r.hasPhoto ? `
                <div class="test-card-headshot">
                  <a href="${r.headshotUrl}" target="_blank">API headshot URL</a>
                </div>
              ` : ''}
            </div>
          </div>
        `;
      }
    }
    gridEl.innerHTML = gridHtml;

    // 6. Try to fetch and render track data
    setLoading('Fetching track data...', 90);
    try {
      const locations = await api('location', {
        session_key: String(sessionKey),
        driver_number: String(drivers[0].driver_number),
      });

      if (locations.length > 0) {
        renderTrackPreview(locations);
        document.getElementById('track-info').textContent =
          `${locations.length} location points for driver #${drivers[0].driver_number}`;
      } else {
        document.getElementById('track-info').textContent = 'No location data available for this session';
      }
    } catch (err) {
      document.getElementById('track-info').textContent = `Track data error: ${err.message}`;
    }

    showApp();
  } catch (err) {
    setLoading(`Error: ${err.message}`, 100);
    console.error(err);
  }
}

// ─── Track preview (simple, no rotation logic) ─────────────────────────────

function renderTrackPreview(locations) {
  const canvas = document.getElementById('test-track-canvas');
  const ctx = canvas.getContext('2d');
  const dpr = window.devicePixelRatio || 1;

  canvas.width = canvas.clientWidth * dpr;
  canvas.height = canvas.clientHeight * dpr;
  ctx.scale(dpr, dpr);

  const w = canvas.clientWidth;
  const h = canvas.clientHeight;

  const xs = locations.map(p => p.x);
  const ys = locations.map(p => p.y);
  const minX = Math.min(...xs), maxX = Math.max(...xs);
  const minY = Math.min(...ys), maxY = Math.max(...ys);
  const rangeX = maxX - minX || 1;
  const rangeY = maxY - minY || 1;
  const pad = 40;

  const scale = Math.min((w - 2 * pad) / rangeX, (h - 2 * pad) / rangeY);
  const offX = pad + ((w - 2 * pad) - rangeX * scale) / 2;
  const offY = pad + ((h - 2 * pad) - rangeY * scale) / 2;

  function toCanvas(x, y) {
    return [(x - minX) * scale + offX, (y - minY) * scale + offY];
  }

  // Draw track outline
  ctx.strokeStyle = '#3a3d4a';
  ctx.lineWidth = 6;
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  ctx.beginPath();
  for (let i = 0; i < locations.length; i++) {
    const [cx, cy] = toCanvas(locations[i].x, locations[i].y);
    if (i === 0) ctx.moveTo(cx, cy);
    else ctx.lineTo(cx, cy);
  }
  ctx.stroke();

  // Draw colored path on top
  ctx.strokeStyle = '#BFFF4A';
  ctx.lineWidth = 2;
  ctx.beginPath();
  for (let i = 0; i < locations.length; i++) {
    const [cx, cy] = toCanvas(locations[i].x, locations[i].y);
    if (i === 0) ctx.moveTo(cx, cy);
    else ctx.lineTo(cx, cy);
  }
  ctx.stroke();
}

// ─── Boot ───────────────────────────────────────────────────────────────────

init();
