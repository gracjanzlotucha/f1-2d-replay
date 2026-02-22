"""
generate_static.py — Pre-generate static JSON data files from OpenF1 API.

Run this ONCE locally before deploying.  No external Python libraries needed
beyond `requests`.

Usage:
    python generate_static.py
    python generate_static.py --year 2025 --country "United Kingdom"

Output:
    static/data.json       — session, drivers, track, laps, insights, pit_lane_path
    static/positions.json  — per-driver position timeseries (~3.7 Hz)
"""

import argparse
import json
import logging
import math
import os
import time
from datetime import datetime, timezone

import requests

logging.basicConfig(level=logging.INFO, format='%(levelname)s %(message)s')
log = logging.getLogger(__name__)

# ─── Constants ────────────────────────────────────────────────────────────────

API_BASE = 'https://api.openf1.org/v1'

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

# ─── API helper ───────────────────────────────────────────────────────────────

_last_req = 0.0


def api_get(endpoint, **params):
    """Fetch JSON from OpenF1 API with rate-limiting (max 3 req/s)."""
    global _last_req
    elapsed = time.time() - _last_req
    if elapsed < 0.34:
        time.sleep(0.34 - elapsed)
    url = f'{API_BASE}/{endpoint}'
    r = requests.get(url, params=params, timeout=120)
    _last_req = time.time()
    r.raise_for_status()
    return r.json()


def parse_iso(s):
    """Parse ISO 8601 timestamp string to datetime (UTC)."""
    if not s:
        return None
    # Handle timezone-aware strings
    return datetime.fromisoformat(s)


def to_seconds(dt, ref):
    """Convert datetime to seconds relative to a reference datetime."""
    return (dt - ref).total_seconds()


# ─── Helpers ──────────────────────────────────────────────────────────────────

def _scrub(obj):
    """Remove NaN / Infinity from nested data structures."""
    if isinstance(obj, dict):
        return {k: _scrub(v) for k, v in obj.items()}
    if isinstance(obj, list):
        return [_scrub(v) for v in obj]
    if isinstance(obj, float):
        return None if (math.isnan(obj) or math.isinf(obj)) else obj
    return obj


def _safe_json(data):
    s = json.dumps(_scrub(data))
    return s


def fmt_time(seconds):
    if seconds is None or (isinstance(seconds, float) and math.isnan(seconds)):
        return '—'
    m = int(seconds // 60)
    s = seconds % 60
    if m > 0:
        return f'{m}:{s:06.3f}'
    return f'{s:.3f}'


# ─── Insights ─────────────────────────────────────────────────────────────────

def compute_insights(laps, drivers, total_laps, race_control_events):
    """Compute per-lap event insights from lap data and race control messages."""
    insights = {}
    by_lap = {}
    for lap in laps:
        ln = lap.get('lap')
        if ln is None:
            continue
        by_lap.setdefault(ln, []).append(lap)

    # Index race control events by lap
    rc_by_lap = {}
    for rc in race_control_events:
        ln = rc.get('lap_number')
        if ln is not None:
            rc_by_lap.setdefault(ln, []).append(rc)

    prev_positions = {}

    for ln in sorted(by_lap.keys()):
        lap_group = by_lap[ln]
        events = []

        # Race control events (SC, VSC, flags)
        rc_events = rc_by_lap.get(ln, [])
        has_sc = any('SAFETY CAR' in (rc.get('message') or '').upper() and 'VIRTUAL' not in (rc.get('message') or '').upper() for rc in rc_events)
        has_vsc = any('VIRTUAL SAFETY CAR' in (rc.get('message') or '').upper() for rc in rc_events)
        has_yellow = any(rc.get('flag') in ('YELLOW', 'DOUBLE YELLOW') for rc in rc_events)

        # Also check track_status from lap data as fallback
        statuses = set(str(l.get('track_status', '')) for l in lap_group)

        if has_sc or '4' in statuses:
            events.append({'type': 'safety_car', 'icon': '🚗', 'title': 'Safety Car deployed', 'detail': '', 'driver': None, 'priority': 10})
        elif has_vsc or '5' in statuses:
            events.append({'type': 'vsc', 'icon': '🟡', 'title': 'Virtual Safety Car', 'detail': '', 'driver': None, 'priority': 9})
        elif has_yellow or '2' in statuses or '3' in statuses:
            events.append({'type': 'yellow', 'icon': '🟡', 'title': 'Yellow Flag', 'detail': '', 'driver': None, 'priority': 8})

        valid = [l for l in lap_group if l.get('lap_time')]
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


# ─── Track geometry helpers ───────────────────────────────────────────────────

def extract_track_outline(location_samples, race_start, laps_data, driver_number):
    """Extract track outline from one driver's clean mid-race lap location data."""
    # Find a clean mid-race lap (avoid lap 1 chaos)
    driver_laps = [l for l in laps_data
                   if l.get('driver_number') == driver_number
                   and l.get('lap_duration') is not None
                   and l.get('is_pit_out_lap') is not True
                   and l.get('lap_number', 0) > 3]
    if not driver_laps:
        # Fallback: any lap
        driver_laps = [l for l in laps_data
                       if l.get('driver_number') == driver_number
                       and l.get('lap_duration') is not None]
    if not driver_laps:
        return {'x': [], 'y': []}

    # Pick the fastest clean lap
    driver_laps.sort(key=lambda l: l['lap_duration'])
    best_lap = driver_laps[0]
    lap_start = parse_iso(best_lap['date_start'])
    lap_end_t = to_seconds(lap_start, race_start) + best_lap['lap_duration']
    lap_start_t = to_seconds(lap_start, race_start)

    # Filter location samples to this lap's time window
    xs, ys = [], []
    for loc in location_samples:
        dt = parse_iso(loc['date'])
        t = to_seconds(dt, race_start)
        if lap_start_t <= t <= lap_end_t:
            xs.append(loc['x'])
            ys.append(loc['y'])

    return {
        'x': xs,
        'y': ys,
    }


def extract_pit_lane_path(location_samples, race_start, pit_data, driver_number,
                          track_x, track_y):
    """Extract pit lane path from a driver's pit stop location data.

    Filters out points that are close to the racing line (track outline),
    keeping only points where the car deviates into the pit lane.
    """
    # Find a pit stop for this driver
    driver_pits = [p for p in pit_data if p.get('driver_number') == driver_number]
    if not driver_pits:
        return []

    pit = driver_pits[0]
    pit_date = parse_iso(pit['date'])
    lane_duration = pit.get('lane_duration', 30)

    pit_start_t = to_seconds(pit_date, race_start)
    pit_end_t = pit_start_t + lane_duration

    # Collect all location points during pit lane transit (with small buffer)
    raw_path = []
    for loc in location_samples:
        dt = parse_iso(loc['date'])
        t = to_seconds(dt, race_start)
        if pit_start_t - 8 <= t <= pit_end_t + 8:
            raw_path.append((t, loc['x'], loc['y']))

    if not raw_path or not track_x:
        return [[p[1], p[2]] for p in raw_path]

    # For each point, compute distance to nearest track outline point.
    # Points far from the racing line are in the pit lane.
    DEVIATION_THRESHOLD = 150  # units — pit lane is offset from track

    # Build simple track point list for nearest-neighbor search
    track_pts = list(zip(track_x, track_y))

    def min_dist_to_track(px, py):
        best = float('inf')
        for tx, ty in track_pts:
            d = (px - tx) ** 2 + (py - ty) ** 2
            if d < best:
                best = d
        return math.sqrt(best)

    # Filter to points that deviate from the racing line
    path = []
    for t, x, y in raw_path:
        dist = min_dist_to_track(x, y)
        if dist > DEVIATION_THRESHOLD:
            path.append([x, y])

    return path


def compute_track_rotation(track_x, track_y):
    """Compute rotation angle to align the start/finish straight horizontally.

    Returns the angle in degrees such that rotating by this angle makes
    the S/F straight approximately horizontal.
    """
    if len(track_x) < 20:
        return 0.0

    # The first ~3% of points form the S/F straight
    n = max(5, len(track_x) * 3 // 100)
    # Direction vector of the S/F straight
    dx = track_x[n] - track_x[0]
    dy = track_y[n] - track_y[0]
    # Angle of the straight from horizontal
    angle_rad = math.atan2(dy, dx)
    angle_deg = math.degrees(angle_rad)

    # We want to rotate by -angle so the straight becomes horizontal
    return round(-angle_deg, 2)


# ─── Main ────────────────────────────────────────────────────────────────────

def main():
    parser = argparse.ArgumentParser(description='Generate F1 replay data from OpenF1 API')
    parser.add_argument('--year', type=int, default=2025, help='Season year')
    parser.add_argument('--country', default='United Kingdom', help='Country name for the GP')
    args = parser.parse_args()

    # ── Step 1: Find session ──────────────────────────────────────────────────
    log.info(f'Finding {args.year} {args.country} GP Race session…')
    sessions = api_get('sessions', country_name=args.country, session_type='Race', year=args.year)
    if not sessions:
        log.error(f'No race session found for {args.year} {args.country}')
        return
    session = sessions[0]
    session_key = session['session_key']
    meeting_key = session.get('meeting_key')
    circuit_name = session.get('circuit_short_name', session.get('location', 'Unknown'))
    log.info(f'  Session key: {session_key} — {circuit_name}')

    # Fetch meeting name (e.g., "British Grand Prix")
    gp_name = f'{args.country} Grand Prix'
    if meeting_key:
        meetings = api_get('meetings', meeting_key=meeting_key)
        if meetings:
            gp_name = meetings[0].get('meeting_name', gp_name)
    log.info(f'  GP name: {gp_name}')

    # ── Step 2: Fetch all bulk data ───────────────────────────────────────────
    log.info('Fetching drivers…')
    drivers_raw = api_get('drivers', session_key=session_key)
    log.info(f'  {len(drivers_raw)} drivers')

    log.info('Fetching laps…')
    all_laps = api_get('laps', session_key=session_key)
    log.info(f'  {len(all_laps)} lap records')

    log.info('Fetching stints…')
    all_stints = api_get('stints', session_key=session_key)
    log.info(f'  {len(all_stints)} stints')

    log.info('Fetching pit stops…')
    all_pits = api_get('pit', session_key=session_key)
    log.info(f'  {len(all_pits)} pit stops')

    log.info('Fetching position changes…')
    all_pos_changes = api_get('position', session_key=session_key)
    log.info(f'  {len(all_pos_changes)} position updates')

    log.info('Fetching race control…')
    all_rc = api_get('race_control', session_key=session_key)
    log.info(f'  {len(all_rc)} race control messages')

    log.info('Fetching weather…')
    all_weather = api_get('weather', session_key=session_key)
    log.info(f'  {len(all_weather)} weather records')

    # ── Step 3: Determine race start time ─────────────────────────────────────
    log.info('Determining race start time…')
    lap1_starts = []
    for l in all_laps:
        if l.get('lap_number') == 1 and l.get('date_start'):
            lap1_starts.append(parse_iso(l['date_start']))
    if not lap1_starts:
        log.error('Could not determine race start time')
        return
    race_start = min(lap1_starts)
    log.info(f'  Race start: {race_start.isoformat()}')

    # ── Step 4: Process drivers ───────────────────────────────────────────────
    log.info('Processing drivers…')
    drivers = {}
    driver_numbers = []
    for d in drivers_raw:
        num = str(d['driver_number'])
        team = d.get('team_name', '')
        color = TEAM_COLORS.get(team)
        if not color:
            raw = d.get('team_colour')
            color = ('#' + raw) if raw else '#888888'
        drivers[num] = {
            'number': num,
            'abbr': d.get('name_acronym', num),
            'name': d.get('full_name', ''),
            'team': team,
            'color': color,
        }
        driver_numbers.append(d['driver_number'])

    # ── Step 5: Fetch location data per driver ────────────────────────────────
    log.info('Fetching location data for all drivers…')
    positions = {}
    all_location_by_driver = {}  # raw, for track outline / pit lane extraction

    for num in driver_numbers:
        snum = str(num)
        log.info(f'  #{num} ({drivers.get(snum, {}).get("abbr", "?")})…')
        locs = api_get('location', session_key=session_key, driver_number=num)
        if not locs:
            log.warning(f'    No location data')
            continue

        all_location_by_driver[num] = locs

        # Convert to race-relative time series
        ts, xs, ys = [], [], []
        for loc in locs:
            dt = parse_iso(loc['date'])
            t = to_seconds(dt, race_start)
            if t < 0:
                continue  # skip pre-race data
            ts.append(round(t, 2))
            xs.append(loc['x'])
            ys.append(loc['y'])

        if not ts:
            continue

        # Resample at uniform 4 Hz (0.25s intervals) using linear interpolation.
        # The raw data has irregular spacing (0.1s–0.5s+) which causes
        # jagged car movement when the frontend interpolates between samples.
        RESAMPLE_DT = 0.25  # 4 Hz — smooth, manageable file size
        resampled_t, resampled_x, resampled_y = [], [], []
        t_cursor = ts[0]
        t_end = ts[-1]
        j = 0  # index into raw arrays

        while t_cursor <= t_end:
            # Advance j so ts[j-1] <= t_cursor <= ts[j]
            while j < len(ts) - 1 and ts[j] < t_cursor:
                j += 1
            if j == 0:
                resampled_t.append(round(t_cursor, 2))
                resampled_x.append(xs[0])
                resampled_y.append(ys[0])
            else:
                t0, t1 = ts[j - 1], ts[j]
                frac = (t_cursor - t0) / (t1 - t0) if t1 != t0 else 0
                resampled_t.append(round(t_cursor, 2))
                resampled_x.append(round(xs[j - 1] + frac * (xs[j] - xs[j - 1])))
                resampled_y.append(round(ys[j - 1] + frac * (ys[j] - ys[j - 1])))
            t_cursor += RESAMPLE_DT

        positions[snum] = {
            't': resampled_t,
            'x': resampled_x,
            'y': resampled_y,
        }
        log.info(f'    {len(resampled_t)} samples ({len(locs)} raw, {RESAMPLE_DT}s resampled)')

    # ── Step 6: Extract track outline ─────────────────────────────────────────
    log.info('Extracting track outline…')
    track = {'x': [], 'y': []}

    # Try multiviewer circuit API first (higher resolution: ~900 points)
    circuit_key = session.get('circuit_key')
    if circuit_key:
        try:
            log.info(f'  Trying multiviewer API for circuit {circuit_key}…')
            mv = requests.get(
                f'https://api.multiviewer.app/api/v1/circuits/{circuit_key}/{args.year}',
                timeout=10,
                headers={'User-Agent': 'f1-2d-replay/1.0'},
            ).json()
            if mv.get('x') and mv.get('y'):
                track = {'x': mv['x'], 'y': mv['y']}
                log.info(f'  Got {len(track["x"])} points from multiviewer API')
        except Exception as e:
            log.warning(f'  Multiviewer API failed: {e}')

    # Fallback: extract from driver location data
    if not track['x']:
        outline_driver = driver_numbers[0] if driver_numbers else None
        if outline_driver and outline_driver in all_location_by_driver:
            track = extract_track_outline(
                all_location_by_driver[outline_driver],
                race_start, all_laps, outline_driver,
            )
        log.info(f'  {len(track["x"])} track points (from location data)')

    # ── Step 7: Extract pit lane path ─────────────────────────────────────────
    log.info('Extracting pit lane path…')
    pit_lane_path = []
    # Find a driver who pitted and has location data
    for pit in all_pits:
        pnum = pit.get('driver_number')
        if pnum in all_location_by_driver:
            pit_lane_path = extract_pit_lane_path(
                all_location_by_driver[pnum],
                race_start, all_pits, pnum,
                track['x'], track['y'],
            )
            if pit_lane_path:
                log.info(f'  {len(pit_lane_path)} points from #{pnum} pit stop')
                break
    if not pit_lane_path:
        log.warning('  Could not extract pit lane path')

    # ── Step 8: Compute track rotation ────────────────────────────────────────
    log.info('Computing track rotation…')
    track_rotation = compute_track_rotation(track['x'], track['y'])
    log.info(f'  Rotation: {track_rotation}°')

    # ── Step 9: Build stint lookup ────────────────────────────────────────────
    # Index stints by driver for quick lookup
    stints_by_driver = {}
    for st in all_stints:
        dnum = str(st['driver_number'])
        stints_by_driver.setdefault(dnum, []).append(st)

    def find_stint(driver_num, lap_number):
        """Find the stint for a given driver and lap number."""
        for st in stints_by_driver.get(str(driver_num), []):
            start = st.get('lap_start', 0)
            end = st.get('lap_end')
            if end is None:
                end = 9999
            if start <= lap_number <= end:
                return st
        return None

    # ── Step 10: Build pit stop lookup ────────────────────────────────────────
    pits_by_driver_lap = {}
    for pit in all_pits:
        key = (str(pit['driver_number']), pit.get('lap_number'))
        pits_by_driver_lap[key] = pit

    # ── Step 11: Build position lookup ────────────────────────────────────────
    # Position changes are timestamped, build a lookup per driver
    pos_by_driver = {}
    for pc in all_pos_changes:
        dnum = str(pc['driver_number'])
        pos_by_driver.setdefault(dnum, []).append(pc)

    def get_position_at_time(driver_num, t):
        """Get the most recent position for a driver at time t."""
        entries = pos_by_driver.get(str(driver_num), [])
        best = None
        for entry in entries:
            dt = parse_iso(entry['date'])
            et = to_seconds(dt, race_start)
            if et <= t and (best is None or et > best[0]):
                best = (et, entry['position'])
        return best[1] if best else None

    # ── Step 12: Build race control track status lookup ───────────────────────
    # Map race control flags to track_status codes for compat
    def get_track_status_for_lap(lap_number):
        """Get track status code for a given lap (compat with old format)."""
        rc_for_lap = [rc for rc in all_rc if rc.get('lap_number') == lap_number]
        for rc in rc_for_lap:
            msg = (rc.get('message') or '').upper()
            flag = rc.get('flag') or ''
            if 'SAFETY CAR' in msg and 'VIRTUAL' not in msg:
                return '4'
            if 'VIRTUAL SAFETY CAR' in msg:
                return '5'
        for rc in rc_for_lap:
            flag = rc.get('flag') or ''
            if flag == 'DOUBLE YELLOW':
                return '3'
            if flag == 'YELLOW':
                return '2'
        return '1'  # green / normal

    # ── Step 13: Assemble lap records ─────────────────────────────────────────
    log.info('Assembling lap records…')
    laps_list = []
    # Track personal bests per driver
    driver_best_times = {}
    total_laps = 0

    # Group OpenF1 laps by driver
    laps_by_driver = {}
    for l in all_laps:
        dnum = str(l['driver_number'])
        laps_by_driver.setdefault(dnum, []).append(l)

    # Sort each driver's laps by lap number
    for dnum in laps_by_driver:
        laps_by_driver[dnum].sort(key=lambda l: l.get('lap_number', 0))

    for l in all_laps:
        dnum = str(l['driver_number'])
        lap_num = l.get('lap_number')
        if lap_num is None:
            continue

        total_laps = max(total_laps, lap_num)

        lap_time = l.get('lap_duration')
        s1 = l.get('duration_sector_1')
        s2 = l.get('duration_sector_2')
        s3 = l.get('duration_sector_3')

        # Round to 3 decimal places
        if lap_time is not None:
            lap_time = round(lap_time, 3)
        if s1 is not None:
            s1 = round(s1, 3)
        if s2 is not None:
            s2 = round(s2, 3)
        if s3 is not None:
            s3 = round(s3, 3)

        # Compute lap_start relative to race_start
        lap_start = None
        if l.get('date_start'):
            lap_start_dt = parse_iso(l['date_start'])
            lap_start = round(to_seconds(lap_start_dt, race_start), 3)

        # Stint info (compound, tyre_life, stint number)
        stint = find_stint(l['driver_number'], lap_num)
        compound = stint.get('compound', 'UNKNOWN') if stint else 'UNKNOWN'
        stint_num = stint.get('stint_number') if stint else None
        tyre_age_start = stint.get('tyre_age_at_start', 0) if stint else 0
        stint_lap_start = stint.get('lap_start', lap_num) if stint else lap_num
        tyre_life = tyre_age_start + (lap_num - stint_lap_start) + 1

        # Pit stop info
        pit = pits_by_driver_lap.get((dnum, lap_num))
        pit_in = None
        pit_out = None
        pit_stop_duration = None
        if pit:
            pit_date = parse_iso(pit['date'])
            pit_t = round(to_seconds(pit_date, race_start), 3)
            lane_dur = pit.get('lane_duration', 0) or 0
            pit_in = pit_t
            pit_out = round(pit_t + lane_dur, 3)
            pit_stop_duration = pit.get('stop_duration')
            if pit_stop_duration is not None:
                pit_stop_duration = round(pit_stop_duration, 1)

        # Position at this lap
        lap_end_t = (lap_start + lap_time) if (lap_start is not None and lap_time is not None) else None
        position = get_position_at_time(l['driver_number'], lap_end_t) if lap_end_t else None

        # Personal best tracking
        is_pb = False
        if lap_time is not None:
            prev_best = driver_best_times.get(dnum)
            if prev_best is None or lap_time < prev_best:
                driver_best_times[dnum] = lap_time
                is_pb = True

        # Track status
        track_status = get_track_status_for_lap(lap_num)

        laps_list.append({
            'driver': dnum,
            'lap': lap_num,
            'lap_time': lap_time,
            'sector1': s1,
            'sector2': s2,
            'sector3': s3,
            'compound': compound,
            'tyre_life': tyre_life,
            'pit_in': pit_in,
            'pit_out': pit_out,
            'pit_stop_duration': pit_stop_duration,
            'lap_start': lap_start,
            'position': position,
            'is_pb': is_pb,
            'track_status': track_status,
            'stint': stint_num,
        })

    log.info(f'  {len(laps_list)} lap records, {total_laps} total laps')

    # ── Step 14: Weather ──────────────────────────────────────────────────────
    log.info('Processing weather…')
    weather = {}
    if all_weather:
        # Filter to race window
        race_weather = []
        for w in all_weather:
            dt = parse_iso(w['date'])
            t = to_seconds(dt, race_start)
            if -300 <= t <= 7200:  # 5 min before to 2 hours after
                race_weather.append(w)

        if race_weather:
            air_temps = [w['air_temperature'] for w in race_weather if w.get('air_temperature') is not None]
            track_temps = [w['track_temperature'] for w in race_weather if w.get('track_temperature') is not None]
            humidities = [w['humidity'] for w in race_weather if w.get('humidity') is not None]
            rainfall_any = any(w.get('rainfall', False) for w in race_weather)

            weather = {
                'air_temp': round(sum(air_temps) / len(air_temps), 1) if air_temps else None,
                'track_temp': round(sum(track_temps) / len(track_temps), 1) if track_temps else None,
                'humidity': round(sum(humidities) / len(humidities), 1) if humidities else None,
                'rainfall': rainfall_any,
            }
    log.info(f'  Weather: {weather}')

    # ── Step 15: Compute insights ─────────────────────────────────────────────
    log.info('Computing insights…')
    insights = compute_insights(laps_list, drivers, total_laps, all_rc)

    # ── Step 16: Write output files ───────────────────────────────────────────
    out_dir = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'static')

    data_payload = {
        'session': {
            'name': f'{gp_name} {args.year}',
            'circuit': circuit_name,
            'total_laps': total_laps,
            'weather': weather,
        },
        'drivers': drivers,
        'track': track,
        'track_rotation': track_rotation,
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


if __name__ == '__main__':
    main()
