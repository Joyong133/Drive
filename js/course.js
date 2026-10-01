// 장내기능시험 코스 정의
// 좌표계: x = 동쪽, z = 남쪽, y = 위. 진행 방향(heading) h: 0 = 북쪽(-z), π/2 = 동쪽(+x)
// 주행 차로 중심선을 따라가는 경로(route)를 만들고, 차의 위치를 (s: 경로상 거리, d: 오른쪽 + 횡방향 거리)로 환산합니다.

export const ROAD = {
  laneW: 3.5,
  right: 1.75,   // 주행 차로 오른쪽 경계(흰 실선)
  center: -1.75, // 중앙선(노란 복선)
  left: -5.25,   // 반대 차로 바깥 경계
  lineW: 0.15,
};

const TURN_R = 9;

// 코스 구성 (거북이 그래픽처럼 직선/곡선을 이어 붙임)
const SEG_DEFS = [
  { kind: 'S', len: 12, label: '출발' },        // 0
  { kind: 'S', len: 40, label: '경사로' },      // 1
  { kind: 'S', len: 20, label: '차로준수' },    // 2
  { kind: 'A', dir: 1 },                         // 3  우회전
  { kind: 'S', len: 50, label: '직각주차' },    // 4
  { kind: 'A', dir: 1 },                         // 5  우회전
  { kind: 'S', len: 22, label: '차로준수' },    // 6
  { kind: 'A', dir: -1 },                        // 7  좌회전
  { kind: 'S', len: 50, label: '신호교차로' },  // 8
  { kind: 'A', dir: 1 },                         // 9  우회전
  { kind: 'S', len: 44, label: '돌발' },        // 10
  { kind: 'A', dir: 1 },                         // 11 우회전
  { kind: 'S', len: 118, label: '가속구간' },   // 12
  { kind: 'A', dir: 1 },                         // 13 우회전
  { kind: 'S', len: 12, label: '출발 대기' },   // 14
];

export const dirOf = (h) => ({ x: Math.sin(h), z: -Math.cos(h) });
export const rightOf = (h) => ({ x: Math.cos(h), z: Math.sin(h) });

// 경사로: s 12→30 오르막(10%), 30→36 평지, 36→52 내리막. 꺾이는 곳은 포물선으로 부드럽게.
const HILL_BREAKS = [
  [12, 0.1],
  [30, -0.1],
  [36, -0.1125],
  [52, 0.1125],
];
const HILL_BLEND = 1.5;
function smoothRamp(u) {
  const b = HILL_BLEND;
  if (u <= -b) return 0;
  if (u >= b) return u;
  return ((u + b) * (u + b)) / (4 * b);
}
export function hillProfile(s) {
  let h = 0;
  for (const [s0, dg] of HILL_BREAKS) h += dg * smoothRamp(s - s0);
  return Math.max(0, h);
}
export const HILL_X0 = ROAD.left - 0.75;
export const HILL_X1 = ROAD.right + 0.75;

export function heightAt(x, z) {
  // 경사로는 첫 직선 구간(x≈0, 북쪽 방향)에만 있음. 이 구간에서는 s = -z
  if (x > HILL_X0 && x < HILL_X1 && z < -9 && z > -55) return hillProfile(-z);
  return 0;
}

export function createCourse() {
  const STEP = 0.5;
  const pts = [];
  const segs = [];
  let x = 0, z = 0, h = 0, s = 0;
  pts.push({ x, z, h, s });

  for (const def of SEG_DEFS) {
    const seg = { ...def, s0: s };
    if (def.kind === 'S') {
      const n = Math.round(def.len / STEP);
      const ds = def.len / n;
      for (let i = 0; i < n; i++) {
        x += Math.sin(h) * ds;
        z -= Math.cos(h) * ds;
        s += ds;
        pts.push({ x, z, h, s });
      }
    } else {
      const len = (TURN_R * Math.PI) / 2;
      const n = Math.round(len / STEP);
      const ds = len / n;
      const dth = (ds / TURN_R) * def.dir;
      const chord = 2 * TURN_R * Math.sin(ds / (2 * TURN_R));
      for (let i = 0; i < n; i++) {
        const hm = h + dth / 2;
        x += Math.sin(hm) * chord;
        z -= Math.cos(hm) * chord;
        h += dth;
        s += ds;
        pts.push({ x, z, h, s });
      }
      seg.len = len;
      seg.r = TURN_R;
    }
    seg.s1 = s;
    segs.push(seg);
  }

  const end = pts[pts.length - 1];
  if (Math.hypot(end.x, end.z) > 0.05) console.warn('코스가 닫히지 않았습니다', end);
  pts.pop(); // 시작점과 중복
  const total = s;
  const N = pts.length;

  const wrapS = (v) => ((v % total) + total) % total;

  // 경로상 s 위치의 점(횡방향 d 만큼 이동)
  function pointAt(sq, d = 0) {
    const sv = wrapS(sq);
    let lo = 0, hi = N - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (pts[mid].s <= sv) lo = mid; else hi = mid - 1;
    }
    const a = pts[lo];
    const b = pts[(lo + 1) % N];
    const sb = lo + 1 === N ? total : b.s;
    const t = sb > a.s ? (sv - a.s) / (sb - a.s) : 0;
    const px = a.x + (b.x - a.x) * t;
    const pz = a.z + (b.z - a.z) * t;
    let hb = b.h;
    while (hb - a.h > Math.PI) hb -= Math.PI * 2;
    while (hb - a.h < -Math.PI) hb += Math.PI * 2;
    const hh = a.h + (hb - a.h) * t;
    const r = rightOf(hh);
    return { x: px + r.x * d, z: pz + r.z * d, h: hh, idx: lo };
  }

  // 월드 좌표 → (s, d). hint 인덱스 주변만 탐색해 빠르게, 멀어지면 전체 탐색
  function project(px, pz, hint = -1) {
    let best = null;
    let bestD2 = Infinity;
    const scan = (k0, k1) => {
      for (let k = k0; k <= k1; k++) {
        const i = ((k % N) + N) % N;
        const a = pts[i];
        const b = pts[(i + 1) % N];
        const abx = b.x - a.x, abz = b.z - a.z;
        const len2 = abx * abx + abz * abz;
        let t = ((px - a.x) * abx + (pz - a.z) * abz) / len2;
        t = t < 0 ? 0 : t > 1 ? 1 : t;
        const qx = a.x + abx * t, qz = a.z + abz * t;
        const dx = px - qx, dz = pz - qz;
        const d2 = dx * dx + dz * dz;
        if (d2 < bestD2) {
          bestD2 = d2;
          const len = Math.sqrt(len2);
          const rx = -abz / len, rz = abx / len; // 진행방향의 오른쪽
          const sb = i + 1 === N ? total : b.s;
          best = { idx: i, s: a.s + (sb - a.s) * t, d: dx * rx + dz * rz, dist: Math.sqrt(d2), h: a.h };
        }
      }
    };
    if (hint >= 0) {
      scan(hint - 50, hint + 50);
      if (bestD2 > 14 * 14) { bestD2 = Infinity; scan(0, N - 1); }
    } else {
      scan(0, N - 1);
    }
    return best;
  }

  const S = (i) => segs[i];
  const zones = {
    startLine: 0,
    startPos: total - 3.2, // 차 중심 위치 (앞범퍼가 출발선 바로 뒤)
    hill: { s0: 12, s1: 52, stop0: 22, stop1: 25, top: 36 },
    park: {
      s0: S(4).s0 + 9,
      s1: S(4).s0 + 45,
      bayS: S(4).s0 + 27,
      bayHalf: 1.5,                 // 주차칸 폭 3.0m
      bayD0: ROAD.right,            // 주차칸 입구 (도로 오른쪽 끝)
      bayD1: ROAD.right + 6.0,      // 주차칸 깊이 6.0m
      leftD: -7.25,                 // 직각주차 구역은 왼쪽으로 넓힌 노면
      lineW: 0.15,
    },
    signal: { stopLine: S(8).s0 + 17, crossS: S(8).s0 + 25, boxHalf: 3.5 },
    sudden: { s0: S(10).s0 + 8, s1: S(10).s0 + 34 },
    accel: { s0: S(12).s0 + 22, s1: S(12).s0 + 57 },
    finish: S(12).s0 + 111,
    turns: segs
      .map((seg, i) => ({ seg, i }))
      .filter(({ seg }) => seg.kind === 'A')
      .map(({ seg, i }) => ({ id: i, s0: seg.s0, s1: seg.s1, dir: seg.dir })),
  };

  const jumps = [
    { name: '출발 지점', s: zones.startPos },
    { name: '경사로 앞', s: 3 },
    { name: '직각주차 앞', s: S(4).s0 + 2 },
    { name: '신호교차로 앞', s: S(8).s0 + 2 },
    { name: '돌발 구간', s: S(10).s0 + 1 },
    { name: '가속구간 앞', s: S(12).s0 + 6 },
  ];

  // 노면이 있는(차가 달려도 되는) 영역인지
  function onPavement(sv, d) {
    const p = zones.park;
    const sw = wrapS(sv);
    if (d >= ROAD.left - 0.15 && d <= ROAD.right + 0.15) return true;
    if (sw >= p.s0 && sw <= p.s1 && d >= p.leftD - 0.1 && d <= ROAD.right + 0.15) return true;
    if (Math.abs(sw - p.bayS) <= p.bayHalf + p.lineW && d >= p.bayD0 && d <= p.bayD1 + p.lineW) return true;
    const sig = zones.signal;
    if (Math.abs(sw - sig.crossS) <= sig.boxHalf) return true; // 교차로 내부/교차 도로
    return false;
  }

  return { pts, segs, total, N, zones, jumps, pointAt, project, wrapS, onPavement, heightAt };
}
