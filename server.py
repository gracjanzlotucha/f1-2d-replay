"""
F1 2D Replay System - Silverstone 2025
Backend server using FastF1 to fetch telemetry and race data.
"""
import os
import re
import json
import logging
import threading
import math
import pandas as pd
import numpy as np
import fastf1
from flask import Flask, Response, send_from_directory, request
from flask_cors import CORS

logging.basicConfig(level=logging.INFO, format='%(levelname)s %(message)s')
log = logging.getLogger(__name__)


def _scrub(obj):
    """
    Recursively convert every NaN / Inf to None so the payload is
    always valid JSON.  Handles plain Python floats, numpy.float32/64,
    and any other numpy scalar that exposes .item().
    """
    if isinstance(obj, dict):
        return {k: _scrub(v) for k, v in obj.items()}
    if isinstance(obj, list):
        return [_scrub(v) for v in obj]
    # numpy scalars (float32, int32, bool_, …) – convert to Python first
    if isinstance(obj, np.generic):
        obj = obj.item()
    # Python float (includes numpy.float64 which subclasses float)
    if isinstance(obj, float):
        return None if (math.isnan(obj) or math.isinf(obj)) else obj
    return obj


def _json_response(data, status=200):
    """Serialize `data` to a JSON Response bypassing Flask's provider entirely.
    _scrub() removes NaN/Inf, then a regex catches anything that slipped through."""
    s = json.dumps(_scrub(data))
    s = re.sub(r'\bNaN\b', 'null', s)
    s = re.sub(r'\bInfinity\b', 'null', s)
    return Response(s, status=status, mimetype='application/json')


app = Flask(__name__, static_folder='static')
CORS(app)

CACHE_DIR = os.path.join(os.path.dirname(__file__), 'cache')
os.makedirs(CACHE_DIR, exist_ok=True)
fastf1.Cache.enable_cache(CACHE_DIR)

# ─── Global state ────────────────────────────────────────────────────────────
STATE = {
    'status': 'idle',
    'progress': 0,
    'message': '',
    'data': None,
}

TEAM_COLORS = {
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
}

TIRE_COLORS = {
    'SOFT': '#E8002D',
    'MEDIUM': '#FFF200',
    'HARD': '#FFFFFF',
    'INTERMEDIATE': '#39B54A',
    'WET': '#0067FF',
    'UNKNOWN': '#888888',
    'nan': '#888888',
}


def fmt_time(seconds):
    if seconds is None or math.isnan(seconds):
        return '—'
    m = int(seconds // 60)
    s = seconds % 60
    if m > 0:
        return f'{m}:{s:06.3f}'
    return f'{s:.3f}'


def load_race_data():
    global STATE
    try:
        STATE['status'] = 'loading'
        STATE['progress'] = 5
        STATE['message'] = 'Fetching Silverstone 2025 GP session…'
        log.info('Loading Silverstone 2025 GP…')

        session = fastf1.get_session(2025, 'British Grand Prix', 'R')
        session.load(laps=True, telemetry=True, weather=True, messages=False)

        STATE['progress'] = 30
        STATE['message'] = 'Processing driver info…'

        # ── Drivers ─────────────────────────────────────────────────────────
        drivers = {}
        for num in session.drivers:
            d = session.get_driver(num)
            team = d.get('TeamName', '')
            color = TEAM_COLORS.get(team)
            if not color:
                raw = d.get('TeamColor', None)
                color = ('#' + raw) if raw else '#888888'
            drivers[str(num)] = {
                'number': str(num),
                'abbr': d.get('Abbreviation', str(num)),
                'name': d.get('FullName', ''),
                'team': team,
                'color': color,
            }

        STATE['progress'] = 45
        STATE['message'] = 'Extracting track outline…'

        # ── Track outline from fastest lap telemetry ─────────────────────────
        try:
            fast_lap = session.laps.pick_fastest()
            tel = fast_lap.get_telemetry()[['X', 'Y', 'Distance']].dropna()
            tel = tel.drop_duplicates('Distance').sort_values('Distance')
            track = {
                'x': [round(float(v), 1) for v in tel['X'].tolist()],
                'y': [round(float(v), 1) for v in tel['Y'].tolist()],
            }
        except Exception as e:
            log.warning(f'Track outline fallback: {e}')
            track = {'x': [], 'y': []}

        STATE['progress'] = 52
        STATE['message'] = 'Detecting race start time…'

        # ── Find the session-time offset for lights-out ───────────────────────
        # LapStartTime of lap 1 is when the race actually began.
        # Everything before that is grid/formation/parade — skip it.
        laps_df = session.laps.copy()
        race_start_t = 0.0
        try:
            lap1_starts = laps_df[laps_df['LapNumber'] == 1]['LapStartTime'].dropna()
            if len(lap1_starts):
                race_start_t = float(lap1_starts.min().total_seconds())
                log.info(f'Race start detected at session t={race_start_t:.1f}s')
        except Exception as e:
            log.warning(f'Could not detect race start: {e}')

        STATE['progress'] = 55
        STATE['message'] = 'Sampling position data…'

        # ── Helper: convert a session-relative Timedelta to race-relative secs ─
        def safe_sec(td):
            try:
                if pd.isna(td):
                    return None
                val = float(td.total_seconds())
                if math.isnan(val) or math.isinf(val):
                    return None
                return round(val, 3)
            except Exception:
                return None

        def safe_sec_r(td):
            """Like safe_sec but subtracts the race-start offset."""
            v = safe_sec(td)
            return None if v is None else round(v - race_start_t, 3)

        def safe_int(v):
            try:
                return int(v) if pd.notna(v) else None
            except Exception:
                return None

        # ── Position data, resampled at 2 Hz, trimmed to race start ──────────
        positions = {}
        for num in session.drivers:
            snum = str(num)
            if num not in session.pos_data:
                continue
            try:
                pos = session.pos_data[num].copy()
                pos = pos.dropna(subset=['X', 'Y'])
                pos['t'] = pos['SessionTime'].dt.total_seconds() - race_start_t
                # Drop everything before lights-out (t < 0)
                pos = pos[pos['t'] >= 0].sort_values('t')
                if pos.empty:
                    continue
                # Resample: pick one sample per 500ms bucket
                pos['bucket'] = (pos['t'] / 0.5).astype(int)
                pos = pos.drop_duplicates('bucket')
                positions[snum] = {
                    't': [round(float(v), 2) for v in pos['t'].tolist()],
                    'x': [round(float(v), 1) for v in pos['X'].tolist()],
                    'y': [round(float(v), 1) for v in pos['Y'].tolist()],
                }
            except Exception as e:
                log.warning(f'Pos data error for {num}: {e}')

        STATE['progress'] = 70
        STATE['message'] = 'Processing lap data…'

        # ── Laps (session-relative times re-zeroed to race start) ─────────────
        laps_list = []

        for _, lap in laps_df.iterrows():
            laps_list.append({
                'driver': str(lap.get('DriverNumber', '')),
                'lap': safe_int(lap.get('LapNumber')),
                'lap_time': safe_sec(lap.get('LapTime')),      # duration — no offset
                'sector1':  safe_sec(lap.get('Sector1Time')),  # duration — no offset
                'sector2':  safe_sec(lap.get('Sector2Time')),
                'sector3':  safe_sec(lap.get('Sector3Time')),
                'compound': str(lap.get('Compound', 'UNKNOWN')),
                'tyre_life': safe_int(lap.get('TyreLife')),
                'pit_in':   safe_sec_r(lap.get('PitInTime')),  # session time — offset
                'pit_out':  safe_sec_r(lap.get('PitOutTime')),
                'lap_start': safe_sec_r(lap.get('LapStartTime')),
                'position': safe_int(lap.get('Position')),
                'is_pb': bool(lap.get('IsPersonalBest', False)),
                'track_status': str(lap.get('TrackStatus', '')),
                'stint': safe_int(lap.get('Stint')),
            })

        STATE['progress'] = 85
        STATE['message'] = 'Computing lap insights…'

        total_laps = int(laps_df['LapNumber'].max()) if not laps_df.empty else 0
        insights = compute_insights(laps_list, drivers, total_laps)

        STATE['progress'] = 95
        STATE['message'] = 'Finalising…'

        # ── Weather summary ─────────────────────────────────────────────────
        weather = {}
        try:
            wdf = session.weather_data
            weather = {
                'air_temp': round(float(wdf['AirTemp'].mean()), 1),
                'track_temp': round(float(wdf['TrackTemp'].mean()), 1),
                'humidity': round(float(wdf['Humidity'].mean()), 1),
                'rainfall': bool(wdf['Rainfall'].any()),
            }
        except Exception:
            pass

        STATE['data'] = _scrub({
            'session': {
                'name': 'British Grand Prix 2025',
                'circuit': 'Silverstone Circuit',
                'total_laps': total_laps,
                'weather': weather,
            },
            'drivers': drivers,
            'track': track,
            'positions': positions,
            'laps': laps_list,
            'insights': insights,
        })

        STATE['status'] = 'ready'
        STATE['progress'] = 100
        STATE['message'] = 'Ready'
        log.info('Race data fully loaded.')

    except Exception as e:
        STATE['status'] = 'error'
        STATE['message'] = str(e)
        log.error(f'Data loading failed: {e}', exc_info=True)


def compute_insights(laps, drivers, total_laps):
    """Generate per-lap insights: fastest laps, pits, position changes, etc."""
    insights = {}

    # Group by lap number
    by_lap = {}
    for lap in laps:
        ln = lap['lap']
        if ln is None:
            continue
        by_lap.setdefault(ln, []).append(lap)

    # Previous lap positions for delta calculation
    prev_positions = {}

    for ln in sorted(by_lap.keys()):
        lap_group = by_lap[ln]
        events = []

        # Safety car / VSC from track status
        statuses = set(l['track_status'] for l in lap_group)
        if '4' in statuses:
            events.append({'type': 'safety_car', 'icon': '🚗', 'title': 'Safety Car deployed', 'detail': '', 'driver': None, 'priority': 10})
        elif '5' in statuses:
            events.append({'type': 'vsc', 'icon': '🟡', 'title': 'Virtual Safety Car', 'detail': '', 'driver': None, 'priority': 9})
        elif '2' in statuses or '3' in statuses:
            events.append({'type': 'yellow', 'icon': '🟡', 'title': 'Yellow Flag', 'detail': '', 'driver': None, 'priority': 8})

        # Fastest lap overall in this lap number
        valid = [l for l in lap_group if l['lap_time']]
        if valid:
            fastest = min(valid, key=lambda x: x['lap_time'])
            abbr = drivers.get(fastest['driver'], {}).get('abbr', fastest['driver'])
            color = drivers.get(fastest['driver'], {}).get('color', '#888')
            events.append({
                'type': 'fastest_lap',
                'icon': '⚡',
                'title': f'{abbr} fastest',
                'detail': fmt_time(fastest['lap_time']),
                'driver': fastest['driver'],
                'color': color,
                'priority': 7,
            })

        # Personal bests
        for lap in lap_group:
            if lap.get('is_pb') and lap.get('lap_time'):
                abbr = drivers.get(lap['driver'], {}).get('abbr', lap['driver'])
                color = drivers.get(lap['driver'], {}).get('color', '#888')
                events.append({
                    'type': 'personal_best',
                    'icon': '🟣',
                    'title': f'{abbr} personal best',
                    'detail': fmt_time(lap['lap_time']),
                    'driver': lap['driver'],
                    'color': color,
                    'priority': 6,
                })

        # Pit stops
        for lap in lap_group:
            if lap.get('pit_in') is not None:
                abbr = drivers.get(lap['driver'], {}).get('abbr', lap['driver'])
                color = drivers.get(lap['driver'], {}).get('color', '#888')
                compound = lap.get('compound', 'UNKNOWN')
                events.append({
                    'type': 'pit_stop',
                    'icon': '🔧',
                    'title': f'{abbr} pits',
                    'detail': f'→ {compound}',
                    'driver': lap['driver'],
                    'color': color,
                    'priority': 5,
                })

        # Position changes vs previous lap
        cur_positions = {}
        for lap in lap_group:
            if lap.get('position') and lap.get('driver'):
                cur_positions[lap['driver']] = lap['position']

        for driver, cur_pos in cur_positions.items():
            if driver in prev_positions:
                delta = prev_positions[driver] - cur_pos  # positive = gained
                if abs(delta) >= 2:
                    abbr = drivers.get(driver, {}).get('abbr', driver)
                    color = drivers.get(driver, {}).get('color', '#888')
                    direction = '▲' if delta > 0 else '▼'
                    events.append({
                        'type': 'position_change',
                        'icon': direction,
                        'title': f'{abbr} {direction} {abs(delta)} positions',
                        'detail': f'P{cur_pos}',
                        'driver': driver,
                        'color': color,
                        'priority': 4,
                    })

        prev_positions = cur_positions

        # Sector records across the lap
        if valid:
            for sector, key in [('S1', 'sector1'), ('S2', 'sector2'), ('S3', 'sector3')]:
                sect_valid = [l for l in lap_group if l.get(key)]
                if sect_valid:
                    best = min(sect_valid, key=lambda x: x[key])
                    abbr = drivers.get(best['driver'], {}).get('abbr', best['driver'])
                    color = drivers.get(best['driver'], {}).get('color', '#888')
                    events.append({
                        'type': 'best_sector',
                        'icon': '📍',
                        'title': f'{abbr} best {sector}',
                        'detail': fmt_time(best[key]),
                        'driver': best['driver'],
                        'color': color,
                        'priority': 3,
                    })

        # Sort by priority desc, keep top 8
        events.sort(key=lambda e: e['priority'], reverse=True)
        insights[str(ln)] = events[:8]

    return insights


# ─── API Routes ───────────────────────────────────────────────────────────────

@app.route('/api/status')
def api_status():
    return _json_response({'status': STATE['status'], 'progress': STATE['progress'], 'message': STATE['message']})


@app.route('/api/data')
def api_data():
    if STATE['status'] != 'ready':
        return _json_response({'error': 'Data not ready', 'status': STATE['status']}, status=503)
    d = STATE['data']
    return _json_response({
        'session': d['session'],
        'drivers': d['drivers'],
        'track': d['track'],
        'laps': d['laps'],
        'insights': d['insights'],
    })


@app.route('/api/positions')
def api_positions():
    if STATE['status'] != 'ready':
        return _json_response({'error': 'Data not ready'}, status=503)
    return _json_response(STATE['data']['positions'])


@app.route('/')
def index():
    return send_from_directory('static', 'index.html')


@app.route('/<path:path>')
def static_files(path):
    return send_from_directory('static', path)


# ─── Entry point ─────────────────────────────────────────────────────────────

if __name__ == '__main__':
    log.info('Starting F1 Replay System…')
    t = threading.Thread(target=load_race_data, daemon=True)
    t.start()
    app.run(host='0.0.0.0', port=5000, debug=False)
