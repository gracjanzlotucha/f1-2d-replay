"""
generate_static.py — Pre-generate static JSON data files for Vercel deployment.

Run this ONCE locally before deploying. Uses your existing local FastF1 cache
so no re-download is needed.

Usage:
    python generate_static.py

Output:
    static/data.json       — session, drivers, track, laps, insights
    static/positions.json  — per-driver position timeseries
"""

import os
import re
import json
import logging
import math
import pandas as pd
import numpy as np
import fastf1

logging.basicConfig(level=logging.INFO, format='%(levelname)s %(message)s')
log = logging.getLogger(__name__)

# ─── Helpers ─────────────────────────────────────────────────────────────────

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


def _scrub(obj):
    if isinstance(obj, dict):
        return {k: _scrub(v) for k, v in obj.items()}
    if isinstance(obj, list):
        return [_scrub(v) for v in obj]
    if isinstance(obj, np.generic):
        obj = obj.item()
    if isinstance(obj, float):
        return None if (math.isnan(obj) or math.isinf(obj)) else obj
    return obj


def _safe_json(data):
    s = json.dumps(_scrub(data))
    s = re.sub(r'\bNaN\b', 'null', s)
    s = re.sub(r'\bInfinity\b', 'null', s)
    return s


def fmt_time(seconds):
    if seconds is None or math.isnan(seconds):
        return '—'
    m = int(seconds // 60)
    s = seconds % 60
    if m > 0:
        return f'{m}:{s:06.3f}'
    return f'{s:.3f}'


def compute_insights(laps, drivers, total_laps):
    insights = {}
    by_lap = {}
    for lap in laps:
        ln = lap['lap']
        if ln is None:
            continue
        by_lap.setdefault(ln, []).append(lap)

    prev_positions = {}

    for ln in sorted(by_lap.keys()):
        lap_group = by_lap[ln]
        events = []

        statuses = set(l['track_status'] for l in lap_group)
        if '4' in statuses:
            events.append({'type': 'safety_car', 'icon': '🚗', 'title': 'Safety Car deployed', 'detail': '', 'driver': None, 'priority': 10})
        elif '5' in statuses:
            events.append({'type': 'vsc', 'icon': '🟡', 'title': 'Virtual Safety Car', 'detail': '', 'driver': None, 'priority': 9})
        elif '2' in statuses or '3' in statuses:
            events.append({'type': 'yellow', 'icon': '🟡', 'title': 'Yellow Flag', 'detail': '', 'driver': None, 'priority': 8})

        valid = [l for l in lap_group if l['lap_time']]
        if valid:
            fastest = min(valid, key=lambda x: x['lap_time'])
            abbr = drivers.get(fastest['driver'], {}).get('abbr', fastest['driver'])
            color = drivers.get(fastest['driver'], {}).get('color', '#888')
            events.append({
                'type': 'fastest_lap', 'icon': '⚡',
                'title': f'{abbr} fastest',
                'detail': fmt_time(fastest['lap_time']),
                'driver': fastest['driver'], 'color': color, 'priority': 7,
            })

        for lap in lap_group:
            if lap.get('is_pb') and lap.get('lap_time'):
                abbr = drivers.get(lap['driver'], {}).get('abbr', lap['driver'])
                color = drivers.get(lap['driver'], {}).get('color', '#888')
                events.append({
                    'type': 'personal_best', 'icon': '🟣',
                    'title': f'{abbr} personal best',
                    'detail': fmt_time(lap['lap_time']),
                    'driver': lap['driver'], 'color': color, 'priority': 6,
                })

        for lap in lap_group:
            if lap.get('pit_in') is not None:
                abbr = drivers.get(lap['driver'], {}).get('abbr', lap['driver'])
                color = drivers.get(lap['driver'], {}).get('color', '#888')
                compound = lap.get('compound', 'UNKNOWN')
                events.append({
                    'type': 'pit_stop', 'icon': '🔧',
                    'title': f'{abbr} pits',
                    'detail': f'→ {compound}',
                    'driver': lap['driver'], 'color': color, 'priority': 5,
                })

        cur_positions = {}
        for lap in lap_group:
            if lap.get('position') and lap.get('driver'):
                cur_positions[lap['driver']] = lap['position']

        for driver, cur_pos in cur_positions.items():
            if driver in prev_positions:
                delta = prev_positions[driver] - cur_pos
                if abs(delta) >= 2:
                    abbr = drivers.get(driver, {}).get('abbr', driver)
                    color = drivers.get(driver, {}).get('color', '#888')
                    direction = '▲' if delta > 0 else '▼'
                    events.append({
                        'type': 'position_change',
                        'icon': direction,
                        'title': f'{abbr} {direction} {abs(delta)} positions',
                        'detail': f'P{cur_pos}',
                        'driver': driver, 'color': color, 'priority': 4,
                    })

        prev_positions = cur_positions

        if valid:
            for sector, key in [('S1', 'sector1'), ('S2', 'sector2'), ('S3', 'sector3')]:
                sect_valid = [l for l in lap_group if l.get(key)]
                if sect_valid:
                    best = min(sect_valid, key=lambda x: x[key])
                    abbr = drivers.get(best['driver'], {}).get('abbr', best['driver'])
                    color = drivers.get(best['driver'], {}).get('color', '#888')
                    events.append({
                        'type': 'best_sector', 'icon': '📍',
                        'title': f'{abbr} best {sector}',
                        'detail': fmt_time(best[key]),
                        'driver': best['driver'], 'color': color, 'priority': 3,
                    })

        events.sort(key=lambda e: e['priority'], reverse=True)
        insights[str(ln)] = events[:8]

    return insights


# ─── Main ────────────────────────────────────────────────────────────────────

def main():
    CACHE_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'cache')
    os.makedirs(CACHE_DIR, exist_ok=True)
    fastf1.Cache.enable_cache(CACHE_DIR)

    log.info('Loading Silverstone 2025 GP from cache…')
    session = fastf1.get_session(2025, 'British Grand Prix', 'R')
    session.load(laps=True, telemetry=True, weather=True, messages=False)

    log.info('Processing drivers…')
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

    log.info('Extracting track outline…')
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

    log.info('Detecting race start time…')
    laps_df = session.laps.copy()
    race_start_t = 0.0
    try:
        lap1_starts = laps_df[laps_df['LapNumber'] == 1]['LapStartTime'].dropna()
        if len(lap1_starts):
            race_start_t = float(lap1_starts.min().total_seconds())
            log.info(f'Race start at session t={race_start_t:.1f}s')
    except Exception as e:
        log.warning(f'Could not detect race start: {e}')

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
        v = safe_sec(td)
        return None if v is None else round(v - race_start_t, 3)

    def safe_int(v):
        try:
            return int(v) if pd.notna(v) else None
        except Exception:
            return None

    log.info('Resampling position data (2 Hz)…')
    positions = {}
    for num in session.drivers:
        snum = str(num)
        if num not in session.pos_data:
            continue
        try:
            pos = session.pos_data[num].copy()
            pos = pos.dropna(subset=['X', 'Y'])
            pos['t'] = pos['SessionTime'].dt.total_seconds() - race_start_t
            pos = pos[pos['t'] >= 0].sort_values('t')
            if pos.empty:
                continue
            pos['bucket'] = (pos['t'] / 0.5).astype(int)
            pos = pos.drop_duplicates('bucket')
            positions[snum] = {
                't': [round(float(v), 2) for v in pos['t'].tolist()],
                'x': [round(float(v), 1) for v in pos['X'].tolist()],
                'y': [round(float(v), 1) for v in pos['Y'].tolist()],
            }
        except Exception as e:
            log.warning(f'Pos data error for {num}: {e}')

    log.info('Processing lap data…')
    laps_list = []
    for _, lap in laps_df.iterrows():
        laps_list.append({
            'driver': str(lap.get('DriverNumber', '')),
            'lap': safe_int(lap.get('LapNumber')),
            'lap_time': safe_sec(lap.get('LapTime')),
            'sector1': safe_sec(lap.get('Sector1Time')),
            'sector2': safe_sec(lap.get('Sector2Time')),
            'sector3': safe_sec(lap.get('Sector3Time')),
            'compound': str(lap.get('Compound', 'UNKNOWN')),
            'tyre_life': safe_int(lap.get('TyreLife')),
            'pit_in': safe_sec_r(lap.get('PitInTime')),
            'pit_out': safe_sec_r(lap.get('PitOutTime')),
            'lap_start': safe_sec_r(lap.get('LapStartTime')),
            'position': safe_int(lap.get('Position')),
            'is_pb': bool(lap.get('IsPersonalBest', False)),
            'track_status': str(lap.get('TrackStatus', '')),
            'stint': safe_int(lap.get('Stint')),
        })

    log.info('Computing insights…')
    total_laps = int(laps_df['LapNumber'].max()) if not laps_df.empty else 0
    insights = compute_insights(laps_list, drivers, total_laps)

    log.info('Reading weather data…')
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

    # ── Write output files ────────────────────────────────────────────────────
    out_dir = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'static')

    data_payload = {
        'session': {
            'name': 'British Grand Prix 2025',
            'circuit': 'Silverstone Circuit',
            'total_laps': total_laps,
            'weather': weather,
        },
        'drivers': drivers,
        'track': track,
        'laps': laps_list,
        'insights': insights,
    }

    data_path = os.path.join(out_dir, 'data.json')
    log.info(f'Writing {data_path}…')
    with open(data_path, 'w', encoding='utf-8') as f:
        f.write(_safe_json(data_payload))
    size_kb = os.path.getsize(data_path) / 1024
    log.info(f'  data.json: {size_kb:.0f} KB')

    pos_path = os.path.join(out_dir, 'positions.json')
    log.info(f'Writing {pos_path}…')
    with open(pos_path, 'w', encoding='utf-8') as f:
        f.write(_safe_json(positions))
    size_mb = os.path.getsize(pos_path) / 1024 / 1024
    log.info(f'  positions.json: {size_mb:.1f} MB')

    log.info('')
    log.info('Done! Static files ready:')
    log.info(f'  static/data.json       ({size_kb:.0f} KB)')
    log.info(f'  static/positions.json  ({size_mb:.1f} MB)')
    log.info('')
    log.info('Next step: deploy to Vercel')
    log.info('  npm i -g vercel')
    log.info('  vercel')


if __name__ == '__main__':
    main()
