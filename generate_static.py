"""
generate_static.py — Pre-generate static JSON data files for Vercel deployment.

Fetches data from the OpenF1 REST API (https://openf1.org) using Pro tier
authentication for higher rate limits.

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
import time
from datetime import datetime, timezone

import requests

logging.basicConfig(level=logging.INFO, format='%(levelname)s %(message)s')
log = logging.getLogger(__name__)

# ─── OpenF1 Config ────────────────────────────────────────────────────────────

BASE_URL = 'https://api.openf1.org/v1'
CIRCUIT_INFO_URL = 'https://api.multiviewer.app/api/v1/circuits/63/2025'
SESSION_KEY = 9947       # 2025 British GP Race
MEETING_KEY = 1277       # 2025 British GP

OPENF1_USERNAME = 'm@d8a.gg'
OPENF1_PASSWORD = 'DSJLuZHJUBRHX7BN'

# ─── Helpers ──────────────────────────────────────────────────────────────────

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
    """Recursively convert problematic float values to None."""
    if isinstance(obj, dict):
        return {k: _scrub(v) for k, v in obj.items()}
    if isinstance(obj, list):
        return [_scrub(v) for v in obj]
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


def parse_iso(date_str):
    """Parse ISO 8601 date string to UTC timestamp in seconds."""
    if not date_str:
        return None
    # Handle timezone offset format
    dt = datetime.fromisoformat(date_str)
    return dt.timestamp()


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
            events.append({'type': 'red_flag', 'icon': '🔴', 'title': 'Red Flag', 'detail': '', 'driver': None, 'priority': 10})
        elif '6' in statuses or '7' in statuses:
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


# ─── API Helpers ──────────────────────────────────────────────────────────────

def authenticate():
    """Authenticate with OpenF1 Pro and return a configured requests session."""
    log.info('Authenticating with OpenF1 Pro…')
    resp = requests.post(
        'https://api.openf1.org/token',
        data={'username': OPENF1_USERNAME, 'password': OPENF1_PASSWORD},
        headers={'Content-Type': 'application/x-www-form-urlencoded'},
    )
    resp.raise_for_status()
    token = resp.json()['access_token']
    log.info('  Authenticated successfully')

    session = requests.Session()
    session.headers.update({'Authorization': f'Bearer {token}'})
    return session


def fetch(session, endpoint, params=None):
    """Fetch data from OpenF1 API with rate-limit awareness."""
    url = f'{BASE_URL}/{endpoint}'
    for attempt in range(3):
        resp = session.get(url, params=params or {})
        if resp.status_code == 429:
            wait = 10 * (attempt + 1)
            log.warning(f'  Rate limited, waiting {wait}s…')
            time.sleep(wait)
            continue
        resp.raise_for_status()
        return resp.json()
    resp.raise_for_status()
    return resp.json()


# ─── Main ────────────────────────────────────────────────────────────────────

def main():
    api = authenticate()

    # ── Fetch all raw data ────────────────────────────────────────────────────

    log.info('Fetching drivers…')
    raw_drivers = fetch(api, 'drivers', {'session_key': SESSION_KEY})
    log.info(f'  {len(raw_drivers)} drivers')

    log.info('Fetching lap data…')
    raw_laps = fetch(api, 'laps', {'session_key': SESSION_KEY})
    log.info(f'  {len(raw_laps)} lap records')

    log.info('Fetching stints…')
    raw_stints = fetch(api, 'stints', {'session_key': SESSION_KEY})
    log.info(f'  {len(raw_stints)} stints')

    log.info('Fetching pit stops…')
    raw_pits = fetch(api, 'pit', {'session_key': SESSION_KEY})
    log.info(f'  {len(raw_pits)} pit stops')

    log.info('Fetching race control events…')
    raw_race_control = fetch(api, 'race_control', {'session_key': SESSION_KEY})
    log.info(f'  {len(raw_race_control)} events')

    log.info('Fetching position data…')
    raw_positions = fetch(api, 'position', {'session_key': SESSION_KEY})
    log.info(f'  {len(raw_positions)} position entries')

    log.info('Fetching weather…')
    raw_weather = fetch(api, 'weather', {'session_key': SESSION_KEY})
    log.info(f'  {len(raw_weather)} weather samples')

    log.info('Fetching circuit info from Multiviewer…')
    circuit_resp = requests.get(CIRCUIT_INFO_URL, headers={'User-Agent': 'f1-2d-replay/1.0'})
    circuit_resp.raise_for_status()
    raw_circuit = circuit_resp.json()
    log.info(f'  {len(raw_circuit["x"])} track points, {len(raw_circuit["corners"])} corners')

    # ── Process drivers ───────────────────────────────────────────────────────

    log.info('Processing drivers…')
    drivers = {}
    driver_numbers = []
    for d in raw_drivers:
        num = str(d['driver_number'])
        team = d.get('team_name', '')
        color = TEAM_COLORS.get(team)
        if not color:
            raw_color = d.get('team_colour')
            color = ('#' + raw_color) if raw_color else '#888888'
        drivers[num] = {
            'number': num,
            'abbr': d.get('name_acronym', num),
            'name': d.get('full_name', ''),
            'team': team,
            'color': color,
        }
        driver_numbers.append(d['driver_number'])

    # ── Circuit info (rotation only for now; track + corners set after location fetch) ─

    log.info('Processing circuit info…')
    circuit_rotation = round(float(raw_circuit.get('rotation', 0)), 2)
    log.info(f'  Circuit rotation: {circuit_rotation}°')

    # ── Detect race start time ────────────────────────────────────────────────

    log.info('Detecting race start time…')
    # Find the earliest lap 1 start time across all drivers
    lap1_starts = [
        parse_iso(lap['date_start'])
        for lap in raw_laps
        if lap.get('lap_number') == 1 and lap.get('date_start')
    ]
    race_start_ts = min(lap1_starts) if lap1_starts else 0.0
    log.info(f'  Race start timestamp: {race_start_ts:.1f}')

    # ── Build lookup tables ───────────────────────────────────────────────────

    # Stints lookup: {driver_number: [{lap_start, lap_end, compound, tyre_age_at_start, stint_number}, ...]}
    stints_by_driver = {}
    for s in raw_stints:
        dn = s['driver_number']
        stints_by_driver.setdefault(dn, []).append(s)

    # Pit stops lookup: {(driver_number, lap_number): pit_data}
    pits_by_driver_lap = {}
    for p in raw_pits:
        key = (p['driver_number'], p['lap_number'])
        pits_by_driver_lap[key] = p

    # Race control → track status per lap
    # Build a map: lap_number → status code string
    # Status codes: '1'=green, '2'=yellow, '4'=SC, '5'/'6'=VSC
    log.info('Building track status per lap…')
    lap_track_status = {}  # {lap_number: status_code}
    for evt in raw_race_control:
        lap_num = evt.get('lap_number')
        if not lap_num:
            continue
        category = evt.get('category', '')
        message = evt.get('message', '').upper()
        flag = evt.get('flag', '') or ''

        if category == 'SafetyCar':
            if 'VIRTUAL' in message:
                # VSC deployed — mark this lap and subsequent until ending
                if 'ENDING' not in message:
                    lap_track_status[lap_num] = '6'  # VSC
            else:
                if 'IN THIS LAP' not in message:
                    lap_track_status[lap_num] = '4'  # SC
        elif category == 'Flag' and flag in ('YELLOW', 'DOUBLE YELLOW') and evt.get('scope') == 'Track':
            if lap_num not in lap_track_status:
                lap_track_status[lap_num] = '2'  # Yellow

    # Expand SC/VSC ranges: if lap N has SC deployed, mark all subsequent laps until SC ends
    sc_active = None  # 'sc' or 'vsc'
    sc_start_lap = None
    sc_events = []
    for evt in sorted(raw_race_control, key=lambda e: e.get('date', '')):
        if evt.get('category') != 'SafetyCar':
            continue
        message = (evt.get('message') or '').upper()
        lap_num = evt.get('lap_number')
        if not lap_num:
            continue

        if 'DEPLOYED' in message:
            sc_type = 'vsc' if 'VIRTUAL' in message else 'sc'
            sc_active = sc_type
            sc_start_lap = lap_num
        elif 'ENDING' in message or 'IN THIS LAP' in message:
            if sc_active and sc_start_lap:
                code = '6' if sc_active == 'vsc' else '4'
                for ln in range(sc_start_lap, lap_num + 1):
                    lap_track_status[ln] = code
            sc_active = None
            sc_start_lap = None

    # Position lookup: {driver_number: [(timestamp, position), ...]} sorted by time
    positions_by_driver = {}
    for p in raw_positions:
        dn = p['driver_number']
        ts = parse_iso(p.get('date'))
        if ts is not None:
            positions_by_driver.setdefault(dn, []).append((ts, p['position']))
    for dn in positions_by_driver:
        positions_by_driver[dn].sort()

    def get_position_at(driver_num, timestamp):
        """Get the position for a driver at or before a given timestamp."""
        entries = positions_by_driver.get(driver_num, [])
        pos = None
        for ts, p in entries:
            if ts <= timestamp:
                pos = p
            else:
                break
        return pos

    # ── Process lap data ──────────────────────────────────────────────────────

    log.info('Processing lap data…')
    # Track personal bests per driver
    driver_best_times = {}
    laps_list = []

    # Sort laps by driver and lap number for personal best tracking
    sorted_laps = sorted(raw_laps, key=lambda l: (l.get('driver_number', 0), l.get('lap_number', 0)))

    for lap in sorted_laps:
        dn = lap['driver_number']
        sdn = str(dn)
        lap_num = lap.get('lap_number')
        lap_duration = lap.get('lap_duration')

        # Find matching stint for compound + tyre life
        compound = 'UNKNOWN'
        tyre_life = None
        stint_num = None
        for s in stints_by_driver.get(dn, []):
            if s['lap_start'] <= (lap_num or 0) <= s['lap_end']:
                compound = s.get('compound', 'UNKNOWN')
                tyre_life = (lap_num or 0) - s['lap_start'] + (s.get('tyre_age_at_start') or 0) + 1
                stint_num = s.get('stint_number')
                break

        # Pit stop data
        pit_data = pits_by_driver_lap.get((dn, lap_num))
        pit_in = None
        pit_out = None
        stop_duration = None
        if pit_data:
            pit_ts = parse_iso(pit_data.get('date'))
            if pit_ts is not None:
                # OpenF1 'date' = pit lane EXIT timestamp
                lane_dur = pit_data.get('lane_duration') or 30
                pit_out = round(pit_ts - race_start_ts, 3)
                pit_in = round(pit_out - lane_dur, 3)
                stop_duration = pit_data.get('stop_duration')

        # Pit lane start: lap 1 marked as pit_out_lap without a pit stop
        if lap_num == 1 and lap.get('is_pit_out_lap') and not pit_data:
            pit_out = lap_start if lap_start is not None else 0

        # Lap start relative to race start
        lap_start_ts = parse_iso(lap.get('date_start'))
        lap_start = None
        if lap_start_ts is not None:
            lap_start = round(lap_start_ts - race_start_ts, 3)

        # Position at end of this lap (only if lap was completed)
        position = None
        if lap_start_ts and lap_duration:
            lap_end_ts = lap_start_ts + lap_duration
            position = get_position_at(dn, lap_end_ts)

        # Track status for this lap
        track_status = lap_track_status.get(lap_num, '1')

        # Personal best detection
        is_pb = False
        if lap_duration and not lap.get('is_pit_out_lap'):
            prev_best = driver_best_times.get(dn)
            if prev_best is None or lap_duration < prev_best:
                driver_best_times[dn] = lap_duration
                if prev_best is not None:  # Not the first lap
                    is_pb = True

        laps_list.append({
            'driver': sdn,
            'lap': lap_num,
            'lap_time': round(lap_duration, 3) if lap_duration else None,
            'sector1': round(lap['duration_sector_1'], 3) if lap.get('duration_sector_1') else None,
            'sector2': round(lap['duration_sector_2'], 3) if lap.get('duration_sector_2') else None,
            'sector3': round(lap['duration_sector_3'], 3) if lap.get('duration_sector_3') else None,
            'compound': compound,
            'tyre_life': tyre_life,
            'pit_in': pit_in,
            'pit_out': pit_out,
            'stop_duration': stop_duration,
            'lap_start': lap_start,
            'position': position,
            'is_pb': is_pb,
            'track_status': track_status,
            'stint': stint_num,
        })

    total_laps = max((l.get('lap_number') or 0 for l in raw_laps), default=0)

    # ── Fetch and process position telemetry ──────────────────────────────────

    log.info('Fetching position telemetry (location data)…')
    positions = {}
    all_location_data = {}  # Keep raw for pit lane extraction

    for i, dn in enumerate(driver_numbers):
        sdn = str(dn)
        log.info(f'  Fetching driver #{dn} ({i+1}/{len(driver_numbers)})…')
        try:
            raw_loc = fetch(api, 'location', {
                'session_key': SESSION_KEY,
                'driver_number': dn,
            })
        except Exception as e:
            log.warning(f'  Location data error for {dn}: {e}')
            continue

        if not raw_loc:
            continue

        all_location_data[dn] = raw_loc

        # Convert to race-relative time and resample to 2Hz
        points = []
        for pt in raw_loc:
            ts = parse_iso(pt.get('date'))
            if ts is None:
                continue
            t = ts - race_start_ts
            if t >= 0:
                points.append((t, pt['x'], pt['y']))

        if not points:
            continue

        points.sort()

        # Resample to 2Hz (0.5s buckets)
        resampled_t = []
        resampled_x = []
        resampled_y = []
        seen_buckets = set()
        for t, x, y in points:
            bucket = int(t / 0.5)
            if bucket not in seen_buckets:
                seen_buckets.add(bucket)
                resampled_t.append(round(t, 2))
                resampled_x.append(round(float(x), 1))
                resampled_y.append(round(float(y), 1))

        positions[sdn] = {
            't': resampled_t,
            'x': resampled_x,
            'y': resampled_y,
        }
        log.info(f'    {len(raw_loc)} raw → {len(resampled_t)} resampled points')

        # Small delay to respect rate limits on bulk fetches
        if i < len(driver_numbers) - 1:
            time.sleep(0.2)

    # ── Build track outline from location data ──────────────────────────────

    log.info('Building track outline from location data…')
    track = {'x': [], 'y': []}
    try:
        # Find the fastest clean lap (after SC periods, not a pit out lap)
        candidate_laps = [
            l for l in raw_laps
            if l.get('lap_duration')
            and (l.get('lap_number') or 0) >= 25
            and not l.get('is_pit_out_lap')
        ]
        if candidate_laps:
            best_lap = min(candidate_laps, key=lambda l: l['lap_duration'])
            ref_dn = best_lap['driver_number']
            ref_lap_start = parse_iso(best_lap['date_start'])
            ref_lap_end = ref_lap_start + best_lap['lap_duration']

            loc_data = all_location_data.get(ref_dn, [])
            lap_points = []
            for pt in loc_data:
                pt_ts = parse_iso(pt['date'])
                if pt_ts and ref_lap_start <= pt_ts <= ref_lap_end:
                    lap_points.append((pt_ts, pt['x'], pt['y']))
            lap_points.sort()

            if lap_points:
                track = {
                    'x': [round(float(x), 1) for _, x, y in lap_points],
                    'y': [round(float(y), 1) for _, x, y in lap_points],
                }
                log.info(f'  {len(track["x"])} points from driver #{ref_dn} lap {best_lap["lap_number"]} ({best_lap["lap_duration"]:.3f}s)')
    except Exception as e:
        log.warning(f'Track outline extraction failed: {e}')

    # ── Transform corner coordinates from Multiviewer to location space ───

    log.info('Transforming corner coordinates…')
    circuit_info = {'rotation': circuit_rotation, 'corners': []}
    try:
        if track['x'] and raw_circuit['x']:
            # Compute centroids
            mv_cx = sum(raw_circuit['x']) / len(raw_circuit['x'])
            mv_cy = sum(raw_circuit['y']) / len(raw_circuit['y'])
            loc_cx = sum(track['x']) / len(track['x'])
            loc_cy = sum(track['y']) / len(track['y'])

            # Center both track outlines
            mv_centered_x = [x - mv_cx for x in raw_circuit['x']]
            mv_centered_y = [y - mv_cy for y in raw_circuit['y']]

            # Resample location track to same number of points as Multiviewer
            # for Procrustes alignment (simple uniform resampling)
            n_mv = len(raw_circuit['x'])
            n_loc = len(track['x'])
            loc_resampled_x = []
            loc_resampled_y = []
            for i in range(n_mv):
                idx = int(i * n_loc / n_mv)
                idx = min(idx, n_loc - 1)
                loc_resampled_x.append(track['x'][idx] - loc_cx)
                loc_resampled_y.append(track['y'][idx] - loc_cy)

            # Compute optimal rotation using Procrustes formula:
            # theta = atan2(sum(mx*ly - my*lx), sum(mx*lx + my*ly))
            num = sum(mx * ly - my * lx for mx, my, lx, ly
                      in zip(mv_centered_x, mv_centered_y, loc_resampled_x, loc_resampled_y))
            den = sum(mx * lx + my * ly for mx, my, lx, ly
                      in zip(mv_centered_x, mv_centered_y, loc_resampled_x, loc_resampled_y))
            theta = math.atan2(num, den)

            # Compute uniform scale
            mv_rms = math.sqrt(sum(x**2 + y**2 for x, y in zip(mv_centered_x, mv_centered_y)) / n_mv)
            loc_rms = math.sqrt(sum(x**2 + y**2 for x, y in zip(loc_resampled_x, loc_resampled_y)) / n_mv)
            scale = loc_rms / mv_rms if mv_rms else 1.0

            cos_t = math.cos(theta)
            sin_t = math.sin(theta)

            def transform_mv(mx, my):
                """Transform Multiviewer coordinates to OpenF1 location space."""
                cx = mx - mv_cx
                cy = my - mv_cy
                rx = (cx * cos_t - cy * sin_t) * scale + loc_cx
                ry = (cx * sin_t + cy * cos_t) * scale + loc_cy
                return round(rx, 1), round(ry, 1)

            circuit_info['corners'] = [
                {
                    'number': int(c.get('number', 0)),
                    'letter': '',
                    'x': transform_mv(c['trackPosition']['x'], c['trackPosition']['y'])[0],
                    'y': transform_mv(c['trackPosition']['x'], c['trackPosition']['y'])[1],
                    'angle': round(float(c.get('angle', 0)), 1),
                    'distance': round(float(c.get('length', 0)), 1),
                }
                for c in raw_circuit['corners']
            ]
            log.info(f'  Transformed {len(circuit_info["corners"])} corners (rotation={math.degrees(theta):.1f}°, scale={scale:.4f})')
    except Exception as e:
        log.warning(f'Corner transformation failed: {e}')

    # ── Extract pit lane path ─────────────────────────────────────────────────

    log.info('Extracting pit lane path…')
    pit_lane_path = []
    try:
        if raw_pits:
            first_pit = raw_pits[0]
            pit_driver = first_pit['driver_number']
            pit_ts = parse_iso(first_pit.get('date'))
            lane_dur = first_pit.get('lane_duration') or 30

            loc_data = all_location_data.get(pit_driver, [])
            if pit_ts and loc_data:
                # date = pit lane exit; entry = date - lane_dur
                window_start = pit_ts - lane_dur - 5
                window_end = pit_ts + 5
                pit_points = []
                for pt in loc_data:
                    ts = parse_iso(pt.get('date'))
                    if ts and window_start <= ts <= window_end:
                        pit_points.append((ts, pt['x'], pt['y']))
                pit_points.sort()
                pit_lane_path = [[round(float(x), 1), round(float(y), 1)] for _, x, y in pit_points]
                log.info(f'  {len(pit_lane_path)} points from driver #{pit_driver} pit stop')
    except Exception as e:
        log.warning(f'Pit lane extraction failed: {e}')

    # ── Process weather ───────────────────────────────────────────────────────

    log.info('Processing weather…')
    weather = {}
    try:
        if raw_weather:
            air_temps = [w['air_temperature'] for w in raw_weather if w.get('air_temperature') is not None]
            track_temps = [w['track_temperature'] for w in raw_weather if w.get('track_temperature') is not None]
            humidities = [w['humidity'] for w in raw_weather if w.get('humidity') is not None]
            rainfalls = [w.get('rainfall', 0) for w in raw_weather]
            weather = {
                'air_temp': round(sum(air_temps) / len(air_temps), 1) if air_temps else 0,
                'track_temp': round(sum(track_temps) / len(track_temps), 1) if track_temps else 0,
                'humidity': round(sum(humidities) / len(humidities), 1) if humidities else 0,
                'rainfall': any(r > 0 for r in rainfalls),
            }
    except Exception:
        pass

    # ── Compute insights ──────────────────────────────────────────────────────

    log.info('Computing insights…')
    insights = compute_insights(laps_list, drivers, total_laps)

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
        'circuit_info': circuit_info,
        'pit_lane_path': pit_lane_path,
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
