"""서울 ↔ 부산 경부고속도로 드라이브용 데이터 만들기.

입력(모두 공개 데이터, 인터넷에서 자동으로 받음):
  - Overture Maps (ODbL, OpenStreetMap 기반): 도로·교량·터널·출구 안내·제한속도, 건물, 장소, 행정구역
  - AWS Terrain Tiles (Terrarium, SRTM 등): 지형 고도

출력: data/trip/
  meta.json            좌표계, 경로 길이, 출구·표지판·터널·교량·휴게소·지명 목록
  route_SB.bin         서울→부산 차로 중심선 (10 m 간격)  float32 x,z,y + uint8 flags/lanes/speed
  route_NB.bin         부산→서울
  ramps.bin            출구/진입 램프 (짧은 구간)
  bld/NNN.bin          경로 주변 건물 (구간별)

실행: python3 tools/build_trip_data.py      (처음엔 데이터를 받느라 10~20분 걸림)
"""
import collections
import heapq
import io
import json
import math
import os
import struct
import sys

import numpy as np
import pyarrow.compute as pc
import pyarrow as pa
import requests
import shapely.wkb as wkb
from PIL import Image
from scipy.ndimage import gaussian_filter1d, median_filter
from scipy.spatial import cKDTree
from shapely.geometry import LineString, Point, box
from shapely.ops import unary_union

sys.path.insert(0, os.path.dirname(__file__))
import overture  # noqa: E402

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT = os.path.join(ROOT, 'data', 'trip')
CACHE = overture.CACHE
os.makedirs(OUT, exist_ok=True)

# ───────── 좌표계: 웹 메르카토르를 경로 가운데 위도의 축척(cos φ0)으로 줄인 평면 (m)
R_EARTH = 6378137.0
LON0, LAT0 = 128.0, 36.4
K = math.cos(math.radians(LAT0))
MX0 = R_EARTH * math.radians(LON0)
MY0 = R_EARTH * math.log(math.tan(math.pi / 4 + math.radians(LAT0) / 2))


def to_world(lon, lat):
    lon = np.asarray(lon, dtype=np.float64)
    lat = np.asarray(lat, dtype=np.float64)
    mx = R_EARTH * np.radians(lon)
    my = R_EARTH * np.log(np.tan(np.pi / 4 + np.radians(lat) / 2))
    return (mx - MX0) * K, -(my - MY0) * K


def to_lonlat(x, z):
    mx = np.asarray(x) / K + MX0
    my = -np.asarray(z) / K + MY0
    lon = np.degrees(mx / R_EARTH)
    lat = np.degrees(2 * np.arctan(np.exp(my / R_EARTH)) - np.pi / 2)
    return lon, lat


SPACING = 10.0  # 경로 점 간격 (m)
SEOUL = (127.0170, 37.5290)   # 한남IC 부근 (경부고속도로 서울 기점)
BUSAN = (129.0920, 35.2470)   # 구서IC 부근 (부산 종점)

# ───────── 지형 고도 (Terrarium PNG, z13 ≈ 15 m/px)
DEM_Z = 13
_dem_cache = {}


def dem_tile(tx, ty, z=DEM_Z):
    key = (z, tx, ty)
    if key in _dem_cache:
        return _dem_cache[key]
    path = os.path.join(CACHE, 'terrarium', str(z), str(tx), f'{ty}.png')
    if not os.path.exists(path):
        os.makedirs(os.path.dirname(path), exist_ok=True)
        url = f'https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{tx}/{ty}.png'
        for _ in range(5):
            try:
                r = requests.get(url, timeout=60)
                r.raise_for_status()
                open(path, 'wb').write(r.content)
                break
            except requests.RequestException:
                continue
    a = np.asarray(Image.open(path).convert('RGB'), dtype=np.float64)
    h = a[:, :, 0] * 256 + a[:, :, 1] + a[:, :, 2] / 256 - 32768
    _dem_cache[key] = h
    return h


def dem_at(x, z):
    """월드 좌표 배열 → 고도 (쌍선형 보간)"""
    x = np.atleast_1d(np.asarray(x, dtype=np.float64))
    z = np.atleast_1d(np.asarray(z, dtype=np.float64))
    n = 2 ** DEM_Z
    W = 2 * math.pi * R_EARTH
    mx = x / K + MX0
    my = -z / K + MY0
    px = (mx + math.pi * R_EARTH) / W * n * 256 - 0.5
    py = (math.pi * R_EARTH - my) / W * n * 256 - 0.5
    out = np.zeros_like(x)
    x0 = np.floor(px).astype(np.int64)
    y0 = np.floor(py).astype(np.int64)
    fx = px - x0
    fy = py - y0

    def val(ix, iy):
        tx, ty = ix // 256, iy // 256
        res = np.zeros(len(ix))
        for key in set(zip(tx.tolist(), ty.tolist())):
            m = (tx == key[0]) & (ty == key[1])
            t = dem_tile(*key)
            res[m] = t[iy[m] - key[1] * 256, ix[m] - key[0] * 256]
        return res

    out = (val(x0, y0) * (1 - fx) * (1 - fy) + val(x0 + 1, y0) * fx * (1 - fy)
           + val(x0, y0 + 1) * (1 - fx) * fy + val(x0 + 1, y0 + 1) * fx * fy)
    return out


def hav(a, b):
    la1, la2 = math.radians(a[1]), math.radians(b[1])
    dla = la2 - la1
    dlo = math.radians(b[0] - a[0])
    h = math.sin(dla / 2) ** 2 + math.cos(la1) * math.cos(la2) * math.sin(dlo / 2) ** 2
    return 2 * 6371000 * math.asin(math.sqrt(h))


def oneway(r):
    for a in r['access_restrictions'] or []:
        w = a.get('when') or {}
        if (a['access_type'] == 'denied' and w.get('heading') and not w.get('mode')
                and not w.get('using') and not w.get('vehicle') and not w.get('during')):
            return w['heading']  # 'backward' = 정방향 일방통행
    return None


def is_gyeongbu(r):
    n = (r['names'] or {}).get('primary') or ''
    if '경부고속도로' in n:
        return True
    for rt in r.get('routes') or []:
        if rt['ref'] == '1' and rt['network'] in ('KR:expressway',):
            return True
    return False


def ranges(r, field, value):
    """road_flags 등에서 value가 걸린 [a,b] 구간 목록 (0~1 비율)"""
    out = []
    for f in r.get(field) or []:
        vals = f.get('values') or ([f.get('value')] if 'value' in f else [])
        if value in vals:
            a, b = f['between'] or [0.0, 1.0]
            out.append((a, b))
    return out


# ───────── 1. 고속도로 도로망 받기
SEG_COLS = ['id', 'names', 'subtype', 'class', 'subclass', 'access_restrictions', 'connectors', 'road_flags',
            'level_rules', 'speed_limits', 'routes', 'destinations', 'geometry', 'bbox']
ROUTE_BOX = box(126.85, 34.95, 129.25, 37.65)


def major_filter(t):
    return pc.is_in(t.column('class'), value_set=pa.array(['motorway', 'trunk']))


def load_major():
    print('1) 고속도로 도로망 (Overture)')
    T = overture.fetch('transportation', 'segment', ROUTE_BOX, SEG_COLS, major_filter, name='kr_major')
    return T.to_pylist()


def build_paths(segs):
    edges = collections.defaultdict(list)
    coords = {}
    byid = {}
    gbc = set()
    for r in segs:
        pts = list(wkb.loads(r['geometry']).coords)
        byid[r['id']] = (r, pts)
        cs = sorted(r['connectors'], key=lambda c: c['at'])
        a, b = cs[0]['connector_id'], cs[-1]['connector_id']
        coords[a] = pts[0]
        coords[b] = pts[-1]
        L = sum(hav(pts[i], pts[i + 1]) for i in range(len(pts) - 1))
        gb = is_gyeongbu(r)
        if gb:
            for c in cs:
                gbc.add(c['connector_id'])
        w = 1.0 if gb else (6.0 if r['subclass'] == 'link' else 3.0)
        ow = oneway(r)
        if ow != 'forward':
            edges[a].append((b, L * w, r['id'], False))
        if ow != 'backward':
            edges[b].append((a, L * w, r['id'], True))

    def sssp(s):
        dist = {s: 0}
        prev = {}
        h = [(0, s)]
        while h:
            d, u = heapq.heappop(h)
            if d > dist[u]:
                continue
            for v, W, sid, rev in edges[u]:
                nd = d + W
                if nd < dist.get(v, 1e18):
                    dist[v] = nd
                    prev[v] = (u, sid, rev)
                    heapq.heappush(h, (nd, v))
        return dist, prev

    def cands(p, rad):
        return [c for c in coords if c in gbc and hav(coords[c], p) < rad]

    paths = {}
    for name, a, b in [('SB', SEOUL, BUSAN), ('NB', BUSAN, SEOUL)]:
        best = None
        T_ = set(cands(b, 1500))
        for s in cands(a, 1500):
            dist, prev = sssp(s)
            for t in T_:
                if t in dist:
                    score = dist[t] + 20 * hav(coords[s], a) + 20 * hav(coords[t], b)
                    if best is None or score < best[0]:
                        best = (score, s, t, prev)
        _, s, t, prev = best
        path = []
        u = t
        while u != s:
            p = prev[u]
            path.append(p)
            u = p[0]
        path = path[::-1]
        # 구간 목록: (segment row, 좌표(진행 방향), 뒤집힘 여부)
        items = []
        for _, sid, rev in path:
            r, pts = byid[sid]
            items.append((r, pts[::-1] if rev else pts, rev))
        paths[name] = items
        print(f'   {name}: 구간 {len(items)}개')
    return paths, byid


# ───────── 2. 경로 → 10 m 간격 중심선 + 속성
def polyline_from_items(items):
    """구간들을 이어 붙인 좌표와, 원래 구간의 (시작 거리, 끝 거리) 목록"""
    xs, zs = [], []
    seg_span = []
    total = 0.0
    for r, pts, rev in items:
        lon = [p[0] for p in pts]
        lat = [p[1] for p in pts]
        x, z = to_world(lon, lat)
        d = np.concatenate([[0], np.cumsum(np.hypot(np.diff(x), np.diff(z)))])
        start = total
        if xs:
            x, z, d = x[1:], z[1:], d[1:]
        xs.append(x)
        zs.append(z)
        total = start + (d[-1] if len(d) else 0)
        seg_span.append((start, total, r, rev))
    x = np.concatenate(xs)
    z = np.concatenate(zs)
    return x, z, seg_span


def resample(x, z, step):
    d = np.concatenate([[0], np.cumsum(np.hypot(np.diff(x), np.diff(z)))])
    keep = np.concatenate([[True], np.diff(d) > 1e-6])
    x, z, d = x[keep], z[keep], d[keep]
    s = np.arange(0, d[-1], step)
    return np.interp(s, d, x), np.interp(s, d, z), d[-1]


def build_route(items):
    x, z, span = polyline_from_items(items)
    # 2 m 간격으로 고르게 → 꺾인 점을 부드럽게 (σ 12 m) → 10 m 간격으로 다시
    x2, z2, L0 = resample(x, z, 2.0)
    xs = gaussian_filter1d(x2, 6, mode='nearest')
    zs = gaussian_filter1d(z2, 6, mode='nearest')
    xr, zr, L1 = resample(xs, zs, SPACING)
    n = len(xr)
    s = np.arange(n) * SPACING
    scale = L0 / L1  # 원래 길이 기준 거리 → 새 경로 거리
    # 원래 구간의 속성을 새 경로 거리로 옮김
    flags = np.zeros(n, np.uint8)
    speed = np.full(n, 100, np.uint8)
    level = np.zeros(n, np.int8)
    seg_index = []  # (s0, s1, segment id, rev)
    for a0, a1, r, rev in span:
        s0, s1 = a0 / scale, a1 / scale
        seg_index.append((s0, s1, r, rev))
        i0, i1 = int(math.floor(s0 / SPACING)), int(math.ceil(s1 / SPACING))

        def mark(ab, val, arr, mode='or'):
            a, b = ab
            if rev:
                a, b = 1 - b, 1 - a
            j0 = int((s0 + (s1 - s0) * a) / SPACING)
            j1 = int(math.ceil((s0 + (s1 - s0) * b) / SPACING))
            j0, j1 = max(j0, 0), min(j1, n)
            if mode == 'or':
                arr[j0:j1] |= val
            else:
                arr[j0:j1] = val

        for ab in ranges(r, 'road_flags', 'is_bridge'):
            mark(ab, 1, flags)
        for ab in ranges(r, 'road_flags', 'is_tunnel'):
            mark(ab, 2, flags)
        for lv in r['level_rules'] or []:
            mark(lv['between'] or [0, 1], lv['value'], level, 'set')
        sp = None
        for sl in r['speed_limits'] or []:
            if sl.get('when') is None and sl.get('max_speed') and not sl.get('between'):
                sp = sl['max_speed']['value']
        if sp:
            speed[max(i0, 0):min(i1, n)] = sp
    return dict(x=xr, z=zr, s=s, n=n, flags=flags, speed=speed, level=level, seg_index=seg_index, scale=scale)


def clean_flags(rt):
    """짧은 끊김 메우기 + 너무 짧은 교량/터널 정리"""
    f = rt['flags']
    for bit, gap, minlen in [(1, 3, 2), (2, 4, 3)]:
        on = (f & bit) > 0
        # 짧은 틈(gap 점 이하)은 메움
        i = 0
        n = len(on)
        while i < n:
            if not on[i]:
                j = i
                while j < n and not on[j]:
                    j += 1
                if 0 < i and j < n and j - i <= gap:
                    on[i:j] = True
                i = j
            else:
                i += 1
        # 너무 짧은 구간은 없앰
        i = 0
        while i < n:
            if on[i]:
                j = i
                while j < n and on[j]:
                    j += 1
                if j - i < minlen:
                    on[i:j] = False
                i = j
            else:
                i += 1
        f[:] = (f & ~np.uint8(bit)) | (on.astype(np.uint8) * bit)
    # 터널이면서 교량인 점은 터널 우선
    f[(f & 2) > 0] &= np.uint8(2)


def runs(mask):
    out = []
    n = len(mask)
    i = 0
    while i < n:
        if mask[i]:
            j = i
            while j < n and mask[j]:
                j += 1
            out.append((i, j))
            i = j
        else:
            i += 1
    return out


def road_profile(rt, lam=1e5):
    """도로 높이: 지형 고도에 맞추되 곡률(2차 차분)에 벌점을 주는 최소제곱 해
    (짧은 언덕은 깎고 골짜기는 메운 듯한 고속도로 종단). 터널·교량 안은 지형을 따르지 않음."""
    from scipy.sparse import diags, eye
    from scipy.sparse.linalg import spsolve
    x, z, n = rt['x'], rt['z'], rt['n']
    raw = dem_at(x, z)
    rt['dem'] = raw
    f = rt['flags']
    g = median_filter(raw, size=7, mode='nearest')
    w = np.ones(n)
    w[(f & 3) > 0] = 0.0
    # 터널 입구 근처 산비탈 고도는 덜 믿음 (입구 바깥 150 m에서 서서히)
    for a, b in runs((f & 2) > 0):
        for i0, sgn in [(a, -1), (b - 1, 1)]:
            for k in range(1, 16):
                j = i0 + sgn * k
                if 0 <= j < n:
                    w[j] = min(w[j], (k / 15) ** 2)
    w = np.maximum(w, 0.0)
    D = diags([1.0, -2.0, 1.0], [0, 1, 2], shape=(n - 2, n))
    P = lam * (D.T @ D) + 1e-6 * eye(n)
    target = g.copy()
    wc = w.copy()
    bridge = (f & 1) > 0
    tunnel = (f & 2) > 0
    for it in range(6):
        y = spsolve((diags(wc) + P).tocsc(), wc * target + 1e-6 * g)
        # 교량 상판은 아래 지형보다 3 m 이상 위, 터널은 산보다 8 m 이상 아래 (부드러운 제약)
        lo = bridge & (y < g + 3)
        hi = tunnel & (y > g - 8)
        if not lo.any() and not hi.any():
            break
        wc[lo] = 0.5
        target[lo] = g[lo] + 3.5
        wc[hi] = 0.2
        target[hi] = g[hi] - 9
    rt['y'] = y
    gr = np.abs(np.diff(y)) / SPACING
    im = int(np.argmax(gr))
    print(f'      경사 최대 {gr.max() * 100:.1f}% ({im * SPACING / 1000:.1f} km, flag {f[im]}), 6% 초과 {np.mean(gr > 0.06) * 100:.2f}%, '
          f'지형과 차이 중앙값 {np.median(np.abs(y - g)[w > 0]):.1f} m')


def merge_profiles(a, b):
    """두 방향 차로가 붙어 있는 곳은 높이를 맞춤 (중앙분리대 단차 방지)"""
    ta = cKDTree(np.c_[a['x'], a['z']])
    tb = cKDTree(np.c_[b['x'], b['z']])
    da, ia = tb.query(np.c_[a['x'], a['z']])
    db, ib = ta.query(np.c_[b['x'], b['z']])
    wa = np.clip((60 - da) / 35, 0, 1)
    wb = np.clip((60 - db) / 35, 0, 1)
    ya = a['y'] * (1 - wa * 0.5) + b['y'][ia] * wa * 0.5
    yb = b['y'] * (1 - wb * 0.5) + a['y'][ib] * wb * 0.5
    a['y'], b['y'] = ya, yb
    a['sep'], b['sep'] = da, db
    a['other_i'], b['other_i'] = ia, ib


def side_of(rt, i, px, pz):
    """경로 i번 점 기준으로 (px,pz)가 오른쪽(+)인지 왼쪽(-)인지, 그리고 횡거리"""
    j = min(i + 1, rt['n'] - 1)
    k = max(j - 1, 0)
    tx, tz = rt['x'][j] - rt['x'][k], rt['z'][j] - rt['z'][k]
    L = math.hypot(tx, tz) or 1
    tx, tz = tx / L, tz / L
    # 오른쪽 벡터 = (-tz, tx)  (앞이 -Z일 때 오른쪽은 +X)
    rx, rz = -tz, tx
    return (px - rt['x'][i]) * rx + (pz - rt['z'][i]) * rz


def lane_counts(rt):
    """두 방향 중심선 사이 거리로 차로 수 추정 (중앙분리대 + 안쪽 길어깨 ≈ 2.2 m, 차로 3.6 m)"""
    sep = rt['sep']
    est = np.where(sep < 32, np.clip(np.round((sep - 2.2) / 3.6), 2, 6), np.nan)
    # 빈 곳은 앞뒤 값으로
    idx = np.arange(len(est))
    ok = ~np.isnan(est)
    est = np.interp(idx, idx[ok], est[ok]) if ok.any() else np.full(len(est), 2)
    est = median_filter(est, size=301, mode='nearest')  # 3 km 창
    est = np.round(median_filter(est, size=101, mode='nearest'))
    lanes = np.clip(est, 2, 5).astype(np.uint8)
    # 아주 짧은 변화(1.5 km 미만)는 없앰
    out = lanes.copy()
    i = 0
    n = len(out)
    while i < n:
        j = i
        while j < n and out[j] == out[i]:
            j += 1
        if (j - i) < 150 and i > 0:
            out[i:j] = out[i - 1]
        i = j
    rt['lanes'] = out


# ───────── 3. 출구·진입 램프, 방향 안내
def build_ramps(rt, name, byid, segs_by_conn):
    """경로 위 커넥터에 붙은 램프(link)를 찾아 짧은 형상(최대 450 m)과 안내 문구를 모음"""
    ramps = []
    signs = []
    tree = cKDTree(np.c_[rt['x'], rt['z']])
    route_ids = set(r['id'] for _, _, r, _ in rt['seg_index'])
    for s0, s1, r, rev in rt['seg_index']:
        # 이 구간의 커넥터별 위치(경로 거리)
        for c in r['connectors']:
            at = 1 - c['at'] if rev else c['at']
            sc = s0 + (s1 - s0) * at
            for oid in segs_by_conn.get(c['connector_id'], []):
                if oid in route_ids:
                    continue
                o, opts = byid[oid]
                if o['subclass'] != 'link':
                    continue
                ow = oneway(o)
                cs = sorted(o['connectors'], key=lambda q: q['at'])
                start_here = cs[0]['connector_id'] == c['connector_id']
                end_here = cs[-1]['connector_id'] == c['connector_id']
                if ow == 'backward':
                    kind = 'exit' if start_here else ('entry' if end_here else None)
                    geo = opts if start_here else opts[::-1]
                elif ow == 'forward':
                    kind = 'exit' if end_here else ('entry' if start_here else None)
                    geo = opts[::-1] if end_here else opts
                else:
                    kind = None
                if not kind:
                    continue
                # 이어지는 링크를 따라 450 m 까지 (출구는 앞으로, 진입은 뒤로)
                chain = [geo]
                total = sum(hav(geo[i], geo[i + 1]) for i in range(len(geo) - 1))
                cur = o
                tail_conn = (cs[-1] if (kind == 'exit') == (ow == 'backward') else cs[0])['connector_id']
                guard = 0
                while total < 450 and guard < 6:
                    guard += 1
                    nxt = None
                    for nid in segs_by_conn.get(tail_conn, []):
                        if nid == cur['id'] or nid in route_ids:
                            continue
                        n_, npts = byid[nid]
                        if n_['class'] not in ('motorway', 'trunk'):
                            continue
                        ncs = sorted(n_['connectors'], key=lambda q: q['at'])
                        now = oneway(n_)
                        if kind == 'exit':
                            if now == 'backward' and ncs[0]['connector_id'] == tail_conn:
                                nxt = (n_, npts, ncs[-1]['connector_id'])
                        else:
                            if now == 'backward' and ncs[-1]['connector_id'] == tail_conn:
                                nxt = (n_, npts[::-1], ncs[0]['connector_id'])
                        if nxt:
                            break
                    if not nxt:
                        break
                    cur, g2, tail_conn = nxt
                    chain.append(g2)
                    total += sum(hav(g2[i], g2[i + 1]) for i in range(len(g2) - 1))
                pts = chain[0] + [p for g_ in chain[1:] for p in g_[1:]]
                lon = [p[0] for p in pts]
                lat = [p[1] for p in pts]
                px, pz = to_world(lon, lat)
                if len(px) < 2:
                    continue
                qx, qz, L = resample(px, pz, 5.0)
                if L < 60:
                    continue
                qx, qz = qx[:90], qz[:90]
                if kind == 'entry':
                    qx, qz = qx[::-1], qz[::-1]  # 진입: 램프 시작 → 본선 합류 순서
                # 진행 방향 기준 좌/우
                i = int(np.clip(round(sc / SPACING), 0, rt['n'] - 1))
                probe = 8 if kind == 'exit' else -9
                side = side_of(rt, i, qx[min(len(qx) - 1, 8)] if kind == 'exit' else qx[max(len(qx) - 9, 0)],
                               qz[min(len(qz) - 1, 8)] if kind == 'exit' else qz[max(len(qz) - 9, 0)])
                del probe
                nm = (o['names'] or {}).get('primary') or ''
                ramps.append(dict(dir=name, kind=kind, s=float(sc), side=1 if side > 0 else -1,
                                  name=nm, x=qx.tolist(), z=qz.tolist()))
        # 방향 안내 (destinations)
        for d in r['destinations'] or []:
            if (d.get('when') or {}).get('heading') not in (None, 'backward' if rev else 'forward'):
                continue
            labels = [l_['value'] for l_ in d['labels'] or [] if l_['type'] != 'route_ref']
            refs = [l_['value'] for l_ in d['labels'] or [] if l_['type'] == 'route_ref']
            if not labels:
                continue
            conn = d['from_connector_id']
            at = next((q['at'] for q in r['connectors'] if q['connector_id'] == conn), None)
            if at is None:
                continue
            at = 1 - at if rev else at
            sc = s0 + (s1 - s0) * at
            to = d['to_segment_id']
            to_row = byid.get(to, (None,))[0]
            kind = 'exit' if (to_row is not None and to_row['subclass'] == 'link') else 'through'
            signs.append(dict(dir=name, s=float(sc), kind=kind, labels=labels[:3], refs=refs[:2]))
    # 정렬/중복 제거
    ramps.sort(key=lambda q: q['s'])
    signs.sort(key=lambda q: q['s'])
    ded = []
    for sg in signs:
        if ded and abs(ded[-1]['s'] - sg['s']) < 30 and ded[-1]['kind'] == sg['kind'] and ded[-1]['labels'] == sg['labels']:
            continue
        ded.append(sg)
    return ramps, ded


def ramp_profiles(ramps, routes):
    """램프 높이: 본선 높이에서 시작해 지형(매끄럽게)을 따라감"""
    for rp in ramps:
        rt = routes[rp['dir']]
        x = np.array(rp['x'])
        z = np.array(rp['z'])
        i = int(np.clip(round(rp['s'] / SPACING), 0, rt['n'] - 1))
        y0 = rt['y'][i]
        g = gaussian_filter1d(dem_at(x, z), 3, mode='nearest')
        d = np.concatenate([[0], np.cumsum(np.hypot(np.diff(x), np.diff(z)))])
        if rp['kind'] == 'exit':
            w = np.clip((d - 40) / 220, 0, 1)
        else:
            w = np.clip(((d[-1] - d) - 40) / 220, 0, 1)
        w = w * w * (3 - 2 * w)
        y = y0 * (1 - w) + (g + (y0 - g[0] if rp['kind'] == 'exit' else y0 - g[-1]) * 0.0) * w
        # 경사 8% 제한
        y = gaussian_filter1d(y, 2, mode='nearest')
        rp['y'] = y.tolist()


# ───────── 4. 위를 지나는 도로(고가·육교) 찾기
def build_overpasses(routes):
    print('4) 위를 지나는 도로(고가/육교) 찾는 중')
    lines = {k: LineString(np.c_[to_lonlat(rt['x'][::5], rt['z'][::5])]) for k, rt in routes.items()}
    area = unary_union([l_.buffer(0.004) for l_ in lines.values()])

    def flt(t):
        return pc.invert(pc.is_in(t.column('subclass'), value_set=pa.array(['link']))) if False else pc.is_valid(t.column('id'))

    cols = ['id', 'names', 'subtype', 'class', 'subclass', 'road_flags', 'level_rules', 'rail_flags', 'geometry', 'bbox']
    Tt = overture.fetch('transportation', 'segment', area, cols, None, name='kr_corridor_segments')
    # 경로 50 m 안에 걸치는 것만 (bbox로 먼저 거름)
    import shapely
    bb = Tt.column('bbox')
    boxes = shapely.box(pc.struct_field(bb, 'xmin').to_numpy(), pc.struct_field(bb, 'ymin').to_numpy(),
                        pc.struct_field(bb, 'xmax').to_numpy(), pc.struct_field(bb, 'ymax').to_numpy())
    near = unary_union([l_.buffer(0.0006) for l_ in lines.values()])
    keep = shapely.intersects(boxes, near)
    T = Tt.filter(pa.array(keep)).to_pylist()
    print(f'   주변 도로/철도 구간 {len(T)}개 (전체 {Tt.num_rows})')
    out = {k: [] for k in routes}
    WIDTH = {'motorway': 24, 'trunk': 20, 'primary': 18, 'secondary': 13, 'tertiary': 10, 'residential': 7,
             'living_street': 6, 'unclassified': 7, 'service': 6, 'track': 4, 'footway': 3, 'cycleway': 3,
             'path': 3, 'pedestrian': 4, 'steps': 3}
    from shapely.strtree import STRtree
    for k, rt in routes.items():
        pieces = [LineString(np.c_[rt['x'][i:i + 51], rt['z'][i:i + 51]]) for i in range(0, rt['n'] - 1, 50)]
        ptree = STRtree(pieces)
        idx_tree = cKDTree(np.c_[rt['x'], rt['z']])
        for r in T:
            if is_gyeongbu(r) and r['class'] in ('motorway', 'trunk'):
                continue
            g = wkb.loads(r['geometry'])
            if g.geom_type != 'LineString':
                continue
            lon, lat = zip(*g.coords)
            gx, gz = to_world(lon, lat)
            gl = LineString(np.c_[gx, gz])
            pts = []
            for j in ptree.query(gl):
                inter = gl.intersection(pieces[j])
                if inter.is_empty:
                    continue
                pts += [inter] if inter.geom_type == 'Point' else [p for p in getattr(inter, 'geoms', []) if p.geom_type == 'Point']
            for p in pts:
                # 교차 지점의 상대 위치(비율)에서 이 도로의 레벨
                at = gl.project(p) / max(gl.length, 1e-6)
                lvl = 0
                for lv in r['level_rules'] or []:
                    a, b = lv['between'] or [0, 1]
                    if a - 0.02 <= at <= b + 0.02:
                        lvl = lv['value']
                bridge = any(a - 0.02 <= at <= b + 0.02 for a, b in ranges(r, 'road_flags', 'is_bridge') + ranges(r, 'rail_flags', 'is_bridge'))
                tunnel = any(a - 0.02 <= at <= b + 0.02 for a, b in ranges(r, 'road_flags', 'is_tunnel') + ranges(r, 'rail_flags', 'is_tunnel'))
                d, i = idx_tree.query([p.x, p.y])
                i = int(i)
                mine = rt['flags'][i]
                my_lvl = rt['level'][i]
                if tunnel or (mine & 2):
                    continue
                if not (lvl > my_lvl or (bridge and not (mine & 1))):
                    continue
                # 교차 방향
                a2 = gl.interpolate(max(gl.project(p) - 15, 0))
                b2 = gl.interpolate(min(gl.project(p) + 15, gl.length))
                ang = math.atan2(b2.y - a2.y, b2.x - a2.x)
                kind = 'rail' if r['subtype'] == 'rail' else (r['class'] or 'road')
                out[k].append(dict(s=float(i * SPACING), x=float(p.x), z=float(p.y), ang=ang, kind=kind,
                                   w=WIDTH.get(r['class'], 8) if kind != 'rail' else 10))
        out[k].sort(key=lambda q: q['s'])
        # 같은 다리(가까운 교차) 합치기
        ded = []
        for q in out[k]:
            if ded and abs(ded[-1]['s'] - q['s']) < 12:
                ded[-1]['w'] = max(ded[-1]['w'], q['w'])
                continue
            ded.append(q)
        out[k] = ded
        print(f'   {k}: 고가/육교 {len(ded)}곳')
    return out


# ───────── 5. 휴게소·지명
def clean_rest_name(nm):
    import re
    if '졸음쉼터' in nm:
        m = re.findall(r'([가-힣]{1,8})\s*졸음쉼터', nm)
        return (m[-1] if m else '') + ' 졸음쉼터'
    for pre in ('고속도로휴게소', '고속도로관리공단', '한국도로공사'):
        nm = nm.replace(pre, ' ')
    if '삼거리' in nm and '천안' in nm:
        return '천안삼거리휴게소'
    m = [q for q in re.findall(r'([가-힣]{2,10}?)\s*휴게소', nm) if q not in ('고속도로',)]
    base = m[-1] if m else nm
    base = re.sub(r'(나들목|IC)$', '', base)
    if len(base) > 2 and base[-1] in '상하':
        base = base[:-1]
    return base + '휴게소'



def build_places(routes):
    print('5) 휴게소·지명')
    lines = {k: LineString(np.c_[to_lonlat(rt['x'][::10], rt['z'][::10])]) for k, rt in routes.items()}
    area = unary_union([l_.buffer(0.006) for l_ in lines.values()])
    cols = ['id', 'names', 'basic_category', 'taxonomy', 'geometry', 'bbox', 'confidence']

    def flt(t):
        nm = pc.struct_field(t.column('names'), 'primary')
        m1 = pc.match_substring_regex(pc.fill_null(nm, ''), '휴게소|졸음쉼터')
        return m1

    P = overture.fetch('places', 'place', area, cols, flt, name='kr_rest_places').to_pylist()
    rests = {k: [] for k in routes}
    for k, rt in routes.items():
        tree = cKDTree(np.c_[rt['x'], rt['z']])
        for p in P:
            nm = p['names']['primary']
            g = wkb.loads(p['geometry'])
            x, z = to_world([g.x], [g.y])
            d, i = tree.query([x[0], z[0]])
            if d > 350:
                continue
            side = side_of(rt, int(i), x[0], z[0])
            if side < 0:  # 진행 방향 오른쪽만 (들어갈 수 있는 쪽)
                continue
            kind = 'shelter' if '졸음쉼터' in nm else 'rest'
            nm = clean_rest_name(nm)
            rests[k].append(dict(s=float(i * SPACING), name=nm, kind=kind, d=float(d)))
        rests[k].sort(key=lambda q: q['s'])
        ded = []
        for q in rests[k]:
            base = q['name'].split('(')[0].replace(' ', '')
            if ded and (abs(ded[-1]['s'] - q['s']) < 4000 and ded[-1]['base'] == base or abs(ded[-1]['s'] - q['s']) < 400):
                continue
            q['base'] = base
            ded.append(q)
        rests[k] = [dict(s=q['s'], name=q['name'], kind=q['kind']) for q in ded]
        print(f'   {k}: 휴게소/쉼터 {len(rests[k])}곳: ' + ', '.join(q['name'] for q in rests[k] if q['kind'] == 'rest'))

    # 행정구역 (시·군·구, 도)
    cols = ['id', 'names', 'subtype', 'class', 'admin_level', 'country', 'geometry', 'bbox', 'is_land']

    def dflt(t):
        return pc.and_(pc.equal(t.column('country'), 'KR'), pc.is_in(t.column('subtype'), value_set=pa.array(['region', 'county', 'localadmin', 'locality'])))

    D = overture.fetch('divisions', 'division_area', area, cols, dflt, name='kr_divisions').to_pylist()
    shapes = []
    for d in D:
        try:
            g = wkb.loads(d['geometry'])
        except Exception:
            continue
        shapes.append((d['subtype'], d['names']['primary'] if d['names'] else '', g))
    from shapely.strtree import STRtree
    tr = STRtree([s[2] for s in shapes])
    names = {}
    for k, rt in routes.items():
        seq = []
        last = None
        for i in range(0, rt['n'], 50):  # 500 m마다
            lon, lat = to_lonlat(rt['x'][i], rt['z'][i])
            pt = Point(float(lon), float(lat))
            reg = cty = loc = ''
            for j in tr.query(pt):
                st, nm, g = shapes[j]
                if g.contains(pt):
                    if st == 'region':
                        reg = nm
                    elif st == 'county':
                        cty = nm
                    elif st in ('localadmin', 'locality') and not loc:
                        loc = nm
            cur = (reg, cty)
            if cur != last:
                seq.append(dict(s=float(i * SPACING), region=reg, county=cty))
                last = cur
        names[k] = seq
        print(f'   {k}: 지명 변화 {len(seq)}번')
    return rests, names


# ───────── 6. 건물 (경로 주변)
BLD_CHUNK = 2000.0  # 경로 2 km 단위로 나눠 저장


def build_buildings(routes):
    print('6) 경로 주변 건물')
    rt = routes['SB']
    line = LineString(np.c_[to_lonlat(rt['x'][::10], rt['z'][::10])])
    area = line.buffer(0.009)  # 약 0.8~1 km
    cols = ['id', 'height', 'num_floors', 'class', 'subtype', 'geometry', 'bbox', 'is_underground', 'min_height', 'has_parts']

    def flt(t):
        bb = t.column('bbox')
        w = pc.subtract(pc.struct_field(bb, 'xmax'), pc.struct_field(bb, 'xmin'))
        h = pc.subtract(pc.struct_field(bb, 'ymax'), pc.struct_field(bb, 'ymin'))
        big = pc.greater(pc.multiply(w, h), 6e-9)  # 대략 50 m² 이상
        return pc.and_(big, pc.invert(pc.fill_null(t.column('is_underground'), False)))

    B = overture.fetch('buildings', 'building', area, cols, flt, name='kr_corridor_buildings', workers=16)
    print(f'   후보 건물 {B.num_rows}개')
    return B


def write_buildings(B, routes):
    rtA, rtB = routes['SB'], routes['NB']
    treeA = cKDTree(np.c_[rtA['x'], rtA['z']])
    treeB = cKDTree(np.c_[rtB['x'], rtB['z']])
    geoms = B.column('geometry').to_pylist()
    heights = B.column('height').to_pylist()
    floors = B.column('num_floors').to_pylist()
    classes = B.column('class').to_pylist()
    subtypes = B.column('subtype').to_pylist()
    chunks = collections.defaultdict(list)
    kept = 0
    # 주변 건물 밀도 (시골의 길쭉한 창고를 아파트로 착각하지 않게)
    bbx = B.column('bbox')
    ccx = (pc.struct_field(bbx, 'xmin').to_numpy() + pc.struct_field(bbx, 'xmax').to_numpy()) / 2
    ccy = (pc.struct_field(bbx, 'ymin').to_numpy() + pc.struct_field(bbx, 'ymax').to_numpy()) / 2
    wx_, wz_ = to_world(ccx, ccy)
    dens_tree = cKDTree(np.c_[wx_, wz_])
    KIND = {'apartments': 1, 'residential': 1, 'house': 2, 'detached': 2, 'terrace': 2, 'commercial': 3, 'office': 3,
            'retail': 3, 'hotel': 3, 'industrial': 4, 'warehouse': 4, 'factory': 4, 'greenhouse': 5, 'school': 6,
            'university': 6, 'kindergarten': 6, 'public': 6, 'hospital': 6, 'church': 7, 'temple': 7}
    SUBKIND = {'residential': 1, 'commercial': 3, 'industrial': 4, 'agricultural': 5, 'education': 6, 'civic': 6,
               'medical': 6, 'religious': 7, 'outbuilding': 2}
    for gb_, hgt, fl, cl, st in zip(geoms, heights, floors, classes, subtypes):
        try:
            g = wkb.loads(gb_)
        except Exception:
            continue
        polys = [g] if g.geom_type == 'Polygon' else list(getattr(g, 'geoms', []))
        for poly in polys:
            if poly.geom_type != 'Polygon':
                continue
            ring = list(poly.exterior.coords)[:-1]
            if len(ring) < 3:
                continue
            lon, lat = zip(*ring)
            x, z = to_world(lon, lat)
            cx, cz = float(np.mean(x)), float(np.mean(z))
            dA, iA = treeA.query([cx, cz])
            dB, _ = treeB.query([cx, cz])
            d = min(dA, dB)
            # 도로 위/바로 옆 건물(데이터 오류·톨게이트 지붕 등)은 제외
            if d < 22 or d > 900:
                continue
            area_m2 = abs(0.5 * np.sum(x * np.roll(z, -1) - np.roll(x, -1) * z))
            if area_m2 < 40:
                continue
            # 멀리 있는 작은 건물은 생략 (용량)
            if d > 450 and area_m2 < 150:
                continue
            kind = KIND.get(cl) or SUBKIND.get(st) or 0
            if kind == 1 and cl == 'residential' and area_m2 < 250:
                kind = 2
            # 길쭉하고 큰 주거 건물 = 아파트로 봄
            mrr = poly.minimum_rotated_rectangle
            ex = list(mrr.exterior.coords) if mrr.geom_type == 'Polygon' else []
            if len(ex) >= 4:
                lon_, lat_ = zip(*ex[:4])
                rx_, rz_ = to_world(lon_, lat_)
                e1 = math.hypot(rx_[1] - rx_[0], rz_[1] - rz_[0])
                e2 = math.hypot(rx_[2] - rx_[1], rz_[2] - rz_[1])
                aspect = max(e1, e2) / max(min(e1, e2), 1)
            else:
                aspect = 1
            rnd = (hash((round(cx, 1), round(cz, 1))) % 1000) / 1000
            if hgt is None:
                if fl:
                    hgt = fl * 3.0 + 1.5
                elif kind == 1 and area_m2 > 300:
                    hgt = (12 + int(rnd * 14)) * 2.9 + 2
                elif (kind == 0 and 350 < area_m2 < 2500 and aspect > 2.6 and d < 700
                      and len(dens_tree.query_ball_point([cx, cz], 300)) > 60):
                    kind = 1
                    hgt = (10 + int(rnd * 12)) * 2.9 + 2
                elif kind == 5:
                    hgt = 3.2
                elif kind == 4:
                    hgt = 8 + rnd * 5
                elif kind == 3:
                    hgt = 9 + rnd * 14
                elif kind == 6:
                    hgt = 13 + rnd * 4
                elif kind == 2:
                    hgt = 4 + rnd * 3.5
                else:
                    hgt = 4.5 + rnd * 2 if area_m2 < 150 else (7 + rnd * 3 if area_m2 < 600 else 9 + rnd * 4)
            hgt = float(min(max(hgt, 3), 320))
            # 단순화 (최대 24점)
            if len(ring) > 24:
                sp = poly.simplify(0.00002)
                if sp.geom_type == 'Polygon':
                    ring2 = list(sp.exterior.coords)[:-1]
                    if 3 <= len(ring2) < len(ring):
                        lon, lat = zip(*ring2)
                        x, z = to_world(lon, lat)
            if len(x) > 40:
                continue
            ci = int(iA * SPACING // BLD_CHUNK)
            chunks[ci].append((x, z, hgt, kind))
            kept += 1
    print(f'   저장할 건물 {kept}개, 구간 {len(chunks)}개')
    bdir = os.path.join(OUT, 'bld')
    os.makedirs(bdir, exist_ok=True)
    for f_ in os.listdir(bdir):
        os.remove(os.path.join(bdir, f_))
    total = 0
    index = {}
    for ci, items in chunks.items():
        allx = np.concatenate([it[0] for it in items])
        allz = np.concatenate([it[1] for it in items])
        ox, oz = float(np.round(allx.mean())), float(np.round(allz.mean()))
        cx_ = np.array([it[0].mean() for it in items])
        cz_ = np.array([it[1].mean() for it in items])
        base = dem_at(cx_, cz_)
        buf = io.BytesIO()
        buf.write(struct.pack('<ffI', ox, oz, len(items)))
        for (x, z, h, kd), b0 in zip(items, base):
            buf.write(struct.pack('<HHfB', len(x), int(round(h * 10)), float(b0), kd))
            q = np.c_[np.round((x - ox) * 4), np.round((z - oz) * 4)].astype(np.int16)
            buf.write(q.tobytes())
        data = buf.getvalue()
        open(os.path.join(bdir, f'{ci:03d}.bin'), 'wb').write(data)
        index[ci] = len(items)
        total += len(data)
    print(f'   건물 데이터 {total / 1e6:.1f} MB')
    return index


# ───────── 저장
def write_route(rt, name):
    """[x,z,y float32 ×n][지형고도 float32 ×n][반대 방향 최근접 점 int32 ×n][flags u8][차로 수 u8][제한속도 u8][반대 차로까지 거리 u8]"""
    xyz = np.c_[rt['x'], rt['z'], rt['y']].astype(np.float32)
    with open(os.path.join(OUT, f'route_{name}.bin'), 'wb') as f:
        f.write(xyz.tobytes())
        f.write(rt['dem'].astype(np.float32).tobytes())
        f.write(rt['other_i'].astype(np.int32).tobytes())
        f.write(rt['flags'].astype(np.uint8).tobytes())
        f.write(rt['lanes'].astype(np.uint8).tobytes())
        f.write(rt['speed'].astype(np.uint8).tobytes())
        f.write(np.clip(rt['sep'], 0, 255).astype(np.uint8).tobytes())


def sound_walls(routes, B):
    """도로 가까이(25~170 m) 건물이 모여 있으면 방음벽(flag 4=오른쪽, 8=왼쪽), 도심(16) 표시"""
    print('   방음벽 위치 계산')
    bb = B.column('bbox')
    cx = (pc.struct_field(bb, 'xmin').to_numpy() + pc.struct_field(bb, 'xmax').to_numpy()) / 2
    cy = (pc.struct_field(bb, 'ymin').to_numpy() + pc.struct_field(bb, 'ymax').to_numpy()) / 2
    bx, bz = to_world(cx, cy)
    tree = cKDTree(np.c_[bx, bz])
    for name, rt in routes.items():
        n = rt['n']
        right = np.zeros(n)
        left = np.zeros(n)
        dense = np.zeros(n)
        tx = np.gradient(rt['x'])
        tz = np.gradient(rt['z'])
        L = np.hypot(tx, tz) + 1e-9
        tx, tz = tx / L, tz / L
        for i in range(0, n, 3):
            idx = tree.query_ball_point([rt['x'][i], rt['z'][i]], 170)
            if not idx:
                continue
            dx = bx[idx] - rt['x'][i]
            dz = bz[idx] - rt['z'][i]
            lat = dx * -tz[i] + dz * tx[i]
            lon = dx * tx[i] + dz * tz[i]
            ok = np.abs(lon) < 120
            right[i:i + 3] = np.sum(ok & (lat > 25))
            left[i:i + 3] = np.sum(ok & (lat < -25))
            dense[i:i + 3] = np.sum(ok)
        f = rt['flags']
        not_tunnel = (f & 2) == 0
        for bit, arr, thr in [(4, right, 4), (8, left, 4), (16, dense, 10)]:
            on = (median_filter(arr, size=31, mode='nearest') >= thr) & not_tunnel
            on = median_filter(on.astype(np.uint8), size=21, mode='nearest') > 0
            f |= (on.astype(np.uint8) * bit)
        print(f'      {name}: 방음벽 오른쪽 {np.mean((f & 4) > 0) * 100:.0f}%, 왼쪽 {np.mean((f & 8) > 0) * 100:.0f}%, 도심 {np.mean((f & 16) > 0) * 100:.0f}%')


CITIES = [('서울', 37.5665, 126.9780), ('성남', 37.4200, 127.1265), ('수원', 37.2636, 127.0286), ('오산', 37.1498, 127.0772),
          ('평택', 36.9921, 127.1129), ('안성', 37.0080, 127.2797), ('천안', 36.8151, 127.1139), ('청주', 36.6424, 127.4890),
          ('세종', 36.4800, 127.2890), ('대전', 36.3504, 127.3845), ('옥천', 36.3064, 127.5713), ('영동', 36.1750, 127.7764),
          ('김천', 36.1398, 128.1136), ('구미', 36.1195, 128.3446), ('칠곡', 35.9955, 128.4018), ('대구', 35.8714, 128.6014),
          ('경산', 35.8251, 128.7414), ('영천', 35.9733, 128.9386), ('경주', 35.8562, 129.2247), ('울산', 35.5384, 129.3114),
          ('양산', 35.3350, 129.0372), ('부산', 35.1796, 129.0756)]


def city_marks(rt):
    """각 도시와 가장 가까운 경로 위치 (이정표 '대구 45 km' 계산용)"""
    tree = cKDTree(np.c_[rt['x'], rt['z']])
    out = []
    for nm, lat, lon in CITIES:
        x, z = to_world([lon], [lat])
        d, i = tree.query([x[0], z[0]])
        if d < 14000:
            out.append(dict(name=nm, s=float(i * SPACING)))
    out.sort(key=lambda q: q['s'])
    return out


def overpass_heights(ov, rt):
    """고가 양 끝(진입로) 지형 높이"""
    for q in ov:
        ex, ez = math.cos(q['ang']), math.sin(q['ang'])
        pts_x = np.array([q['x'] - ex * 45, q['x'] + ex * 45])
        pts_z = np.array([q['z'] - ez * 45, q['z'] + ez * 45])
        ya, yb = dem_at(pts_x, pts_z)
        q['ya'], q['yb'] = round(float(ya), 1), round(float(yb), 1)
        q['x'], q['z'], q['ang'] = round(q['x'], 2), round(q['z'], 2), round(q['ang'], 4)


def write_ramps(ramps):
    buf = io.BytesIO()
    meta = []
    for rp in ramps:
        n = len(rp['x'])
        meta.append(dict(dir=rp['dir'], kind=rp['kind'], s=round(rp['s'], 1), side=rp['side'], name=rp['name'],
                         n=n, off=buf.tell()))
        buf.write(np.c_[rp['x'], rp['z'], rp['y']].astype(np.float32).tobytes())
    open(os.path.join(OUT, 'ramps.bin'), 'wb').write(buf.getvalue())
    return meta


def summarize_structures(rt):
    f = rt['flags']
    tunnels = [[a * SPACING, b * SPACING] for a, b in runs((f & 2) > 0)]
    bridges = [[a * SPACING, b * SPACING] for a, b in runs((f & 1) > 0)]
    return tunnels, bridges


def buildings_only():
    """이미 만든 경로 파일로 건물만 다시"""
    meta = json.load(open(os.path.join(OUT, 'meta.json')))
    routes = {}
    for name, m in meta['routes'].items():
        n = m['n']
        raw = open(os.path.join(OUT, f'route_{name}.bin'), 'rb').read()
        xyz = np.frombuffer(raw[:n * 12], np.float32).reshape(n, 3).astype(np.float64)
        routes[name] = dict(x=xyz[:, 0], z=xyz[:, 1], n=n)
    B = build_buildings(routes)
    meta['buildings'] = dict(chunk=BLD_CHUNK, chunks=write_buildings(B, routes))
    json.dump(meta, open(os.path.join(OUT, 'meta.json'), 'w'), ensure_ascii=False, separators=(',', ':'))


def main():
    if '--buildings-only' in sys.argv:
        return buildings_only()
    segs = load_major()
    paths, byid = build_paths(segs)
    segs_by_conn = collections.defaultdict(list)
    for r in segs:
        for c in r['connectors']:
            segs_by_conn[c['connector_id']].append(r['id'])
    print('2) 중심선·높이')
    routes = {}
    for name, items in paths.items():
        rt = build_route(items)
        clean_flags(rt)
        road_profile(rt)
        routes[name] = rt
        print(f'   {name}: {rt["n"] * SPACING / 1000:.1f} km, 점 {rt["n"]}개')
    merge_profiles(routes['SB'], routes['NB'])
    for rt in routes.values():
        lane_counts(rt)
    print('3) 램프·안내표지')
    all_ramps, all_signs = [], {}
    for name, rt in routes.items():
        ramps, signs = build_ramps(rt, name, byid, segs_by_conn)
        all_ramps += ramps
        all_signs[name] = signs
        print(f'   {name}: 출구 {sum(1 for r in ramps if r["kind"] == "exit")}, 진입 {sum(1 for r in ramps if r["kind"] == "entry")}, 안내 {len(signs)}')
    ramp_profiles(all_ramps, routes)
    overpasses = build_overpasses(routes)
    for name, rt in routes.items():
        overpass_heights(overpasses[name], rt)
    rests, names = build_places(routes)
    B = build_buildings(routes) if '--no-buildings' not in sys.argv else None
    if B is not None:
        sound_walls(routes, B)
    for name, rt in routes.items():
        write_route(rt, name)
    ramp_meta = write_ramps(all_ramps)
    meta = dict(
        version=1,
        origin=dict(lon=LON0, lat=LAT0, k=K, R=R_EARTH),
        spacing=SPACING,
        routes={},
        ramps=ramp_meta,
        attribution='도로·건물·지명: © OpenStreetMap contributors, Overture Maps Foundation (ODbL) · 지형: AWS Terrain Tiles (SRTM 등)',
    )
    for name, rt in routes.items():
        tunnels, bridges = summarize_structures(rt)
        meta['routes'][name] = dict(n=int(rt['n']), length=float(rt['n'] * SPACING), tunnels=tunnels, bridges=bridges,
                                    signs=all_signs[name], overpasses=overpasses[name], rests=rests[name],
                                    names=names[name], cities=city_marks(rt))
    if B is not None:
        meta['buildings'] = dict(chunk=BLD_CHUNK, chunks=write_buildings(B, routes))
    json.dump(meta, open(os.path.join(OUT, 'meta.json'), 'w'), ensure_ascii=False, separators=(',', ':'))
    print('완료:', OUT)


if __name__ == '__main__':
    main()
