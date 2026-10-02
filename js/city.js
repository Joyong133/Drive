// 도로주행 시험용 도시: 도로망 데이터, 위치 판정, 신호 제어, 다른 차(AI), 보행자, 3D 모델
// 좌표계는 장내 코스와 같음: x = 동쪽, z = 남쪽. 모든 도로는 x축 또는 z축과 나란함.
import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/BufferGeometryUtils.js';
import {
  GeoBatch, makeCanvas, canvasTexture, drawLabel, noiseTexture, matrixFrom, randRange, FONT, labelTexture as labelTexture_,
} from './util.js';
import { buildCarModel, CAR } from './carModel.js';

export const LANE = 3.3;      // 차로 폭
export const RC = 8;          // 교차로 모서리(연석) 반경
export const STOP_OFF = 9;    // 교차로 가장자리 → 정지선 거리
const CW_NEAR = 3.5;          // 교차로 가장자리 → 횡단보도 시작
const CW_FAR = 7.5;           // 교차로 가장자리 → 횡단보도 끝

const ROADS = [
  { id: 'A1', name: '중앙대로', axis: 'x', c: 0, from: -150, to: 150, lanes: 2 },
  { id: 'A2', name: '북부로', axis: 'x', c: -180, from: -150, to: 150, lanes: 1 },
  { id: 'A3', name: '남부로', axis: 'x', c: 120, from: -150, to: 150, lanes: 1 },
  { id: 'S1', name: '서문로', axis: 'z', c: -150, from: -180, to: 120, lanes: 1 },
  { id: 'S2', name: '학교길', axis: 'z', c: -30, from: -180, to: 0, lanes: 1 },
  { id: 'S3', name: '시청로', axis: 'z', c: 90, from: -180, to: 120, lanes: 2 },
  { id: 'S4', name: '동문로', axis: 'z', c: 150, from: -180, to: 120, lanes: 1 },
];
const SIGNALIZED = ['-30,0', '90,0', '-30,-180', '90,120'];
const STOP_SIGNS = [{ inter: '90,-180', approach: 'S' }];
export const SCHOOL = { road: 'S2', z0: -155, z1: -35, cross: -100, limit: 30 };
export const BAYS = {
  start: { x0: -138, x1: -112, z0: 6.6, z1: 9.1 },
  dest: { x0: -128, x1: -102, z0: -9.1, z1: -6.6 },
};

// 도로주행 시험 경로: 출발(중앙대로 동쪽 방향) → 직진 → 좌회전 → 일시정지 후 좌회전 → 좌회전(어린이보호구역) → 우회전 → 도착
export const ROUTE = [
  { road: 'A1', dir: 1, to: '-30,0', move: 'S' },
  { road: 'A1', dir: 1, to: '90,0', move: 'L' },
  { road: 'S3', dir: -1, to: '90,-180', move: 'L' },
  { road: 'A2', dir: -1, to: '-30,-180', move: 'L' },
  { road: 'S2', dir: 1, to: '-30,0', move: 'R' },
  { road: 'A1', dir: -1, to: null, move: 'END' },
];

// 다른 차들이 도는 순환 경로 (모두 우회전만 해서 충돌이 없음)
const LOOPS = [
  { legs: [['A2', 1], ['S4', 1], ['A3', -1], ['S1', -1]], cars: 3, colors: [0xd8dde4, 0x22252b, 0x8a1a1a] },
  { legs: [['A1', 1], ['S3', 1], ['A3', -1], ['S1', -1]], cars: 4, colors: [0xf2f2f2, 0x1d3f7a, 0x6b6f76, 0x2e5e3a] },
  { legs: [['A2', 1], ['S3', 1], ['A1', -1], ['S2', -1]], cars: 3, colors: [0xb88a1a, 0x0f0f12, 0xc9ccd2] },
];

const BLOCKS = [
  { x0: -146.7, x1: -33.3, z0: -176.7, z1: -6.6, r: RC, notch: { edge: 'z1', a0: -128, a1: -102, depth: 2.5 }, id: 'B1' },
  { x0: -26.7, x1: 83.4, z0: -176.7, z1: -6.6, r: RC, id: 'B2' },
  { x0: 96.6, x1: 146.7, z0: -176.7, z1: -6.6, r: RC, id: 'B3' },
  { x0: -146.7, x1: 83.4, z0: 6.6, z1: 116.7, r: RC, notch: { edge: 'z0', a0: -138, a1: -112, depth: 2.5 }, id: 'B4' },
  { x0: 96.6, x1: 146.7, z0: 6.6, z1: 116.7, r: RC, id: 'B5' },
  { x0: -300, x1: -153.3, z0: -300, z1: 240, r: 0, id: 'W', outer: true },
  { x0: 153.3, x1: 300, z0: -300, z1: 240, r: 0, id: 'E', outer: true },
  { x0: -153.3, x1: 153.3, z0: -300, z1: -183.3, r: 0, id: 'N', outer: true },
  { x0: -153.3, x1: 153.3, z0: 123.3, z1: 240, r: 0, id: 'S', outer: true },
];

const travelVec = (axis, dir) => (axis === 'x' ? { x: dir, z: 0 } : { x: 0, z: dir });
const rightVec = (t) => ({ x: -t.z, z: t.x });
const leftOf = (t) => ({ x: t.z, z: -t.x });
const approachCode = (axis, dir) => (axis === 'x' ? (dir > 0 ? 'W' : 'E') : (dir > 0 ? 'N' : 'S'));
export const moveName = { S: '직진', L: '좌회전', R: '우회전', U: '유턴', END: '도착' };

// ───────── 도로망 데이터 + 위치 판정 (3D와 무관, 시험 로직이 사용)
export function createCityModel() {
  const roads = ROADS.map((r) => ({ ...r, hw: r.lanes * LANE }));
  const byId = Object.fromEntries(roads.map((r) => [r.id, r]));
  const inters = [];
  for (const xr of roads.filter((r) => r.axis === 'x')) {
    for (const zr of roads.filter((r) => r.axis === 'z')) {
      if (zr.c < xr.from || zr.c > xr.to || xr.c < zr.from || xr.c > zr.to) continue;
      const key = `${zr.c},${xr.c}`;
      const arms = { E: xr.to > zr.c, W: xr.from < zr.c, S: zr.to > xr.c, N: zr.from < xr.c };
      inters.push({
        key, x: zr.c, z: xr.c, xr, zr, hx: zr.hw, hz: xr.hw, arms,
        signal: SIGNALIZED.includes(key),
        stops: STOP_SIGNS.filter((s) => s.inter === key).map((s) => s.approach),
      });
    }
  }
  const interByKey = Object.fromEntries(inters.map((i) => [i.key, i]));
  for (const r of roads) {
    r.inters = inters.filter((i) => i.xr === r || i.zr === r)
      .map((i) => ({ inter: i, at: r.axis === 'x' ? i.x : i.z, half: r.axis === 'x' ? i.hx : i.hz }))
      .sort((a, b) => a.at - b.at);
  }

  const inBay = (x, z) => {
    for (const [name, b] of Object.entries(BAYS)) if (x >= b.x0 && x <= b.x1 && z >= b.z0 && z <= b.z1) return name;
    return null;
  };

  function insideBlock(x, z) {
    for (const b of BLOCKS) {
      if (x < b.x0 || x > b.x1 || z < b.z0 || z > b.z1) continue;
      const r = b.r;
      if (r > 0) {
        const cx = x < b.x0 + r ? b.x0 + r : x > b.x1 - r ? b.x1 - r : null;
        const cz = z < b.z0 + r ? b.z0 + r : z > b.z1 - r ? b.z1 - r : null;
        if (cx !== null && cz !== null && Math.hypot(x - cx, z - cz) > r) continue; // 둥근 모서리 바깥
      }
      if (inBay(x, z)) continue;
      return b;
    }
    return null;
  }

  const onPavement = (x, z) => x > -160 && x < 160 && z > -190 && z < 130 && !insideBlock(x, z);

  function limitAt(road, along) {
    if (road.id === SCHOOL.road && along >= SCHOOL.z0 && along <= SCHOOL.z1) return SCHOOL.limit;
    return 50;
  }

  // 위치 + 진행 방향 → 어느 도로의 어느 쪽을 달리는지, 다음 교차로까지 거리 등
  function locate(x, z, heading) {
    for (const it of inters) {
      if (Math.abs(x - it.x) <= it.hx && Math.abs(z - it.z) <= it.hz) return { type: 'inter', inter: it };
    }
    const fx = Math.sin(heading), fz = -Math.cos(heading);
    const bay = inBay(x, z);
    // 교차로 모서리에서는 두 도로 범위가 겹칠 수 있으므로 더 안쪽에 있는 도로를 고름
    let road = null, bestRatio = Infinity;
    for (const r of roads) {
      const perp = r.axis === 'x' ? z : x;
      const along = r.axis === 'x' ? x : z;
      const wide = bay && r.id === 'A1' ? r.hw + 3 : r.hw + 0.4;
      if (Math.abs(perp - r.c) > wide || along < r.from - 0.01 || along > r.to + 0.01) continue;
      const ratio = Math.abs(perp - r.c) / r.hw;
      if (ratio < bestRatio) { bestRatio = ratio; road = r; }
    }
    if (road) {
      const perp = road.axis === 'x' ? z : x;
      const along = road.axis === 'x' ? x : z;
      const dot = road.axis === 'x' ? fx : fz;
      const dir = dot >= 0 ? 1 : -1;
      const d = road.axis === 'x' ? (perp - road.c) * dir : (perp - road.c) * -dir;
      let next = null, prev = null;
      for (const ri of road.inters) {
        const ahead = (ri.at - along) * dir;
        if (ahead > 0 && (!next || ahead < next.ahead)) next = { ...ri, ahead };
        if (ahead <= 0 && (!prev || -ahead < prev.behind)) prev = { ...ri, behind: -ahead };
      }
      const res = {
        type: 'road', road, dir, d, along, bay,
        lane: road.lanes === 2 ? (d < LANE ? 0 : 1) : 0,
        limit: limitAt(road, along),
        school: road.id === SCHOOL.road && along >= SCHOOL.z0 && along <= SCHOOL.z1,
      };
      if (next) {
        const distBox = next.ahead - next.half;
        res.next = { inter: next.inter, approach: approachCode(road.axis, dir), distBox, distStop: distBox - STOP_OFF };
      }
      if (prev) res.prevDist = prev.behind - prev.half;
      return res;
    }
    return { type: 'off' };
  }

  // 교차로에서 나온 도로/방향 → 진입 방향 기준 움직임(직진/좌/우/유턴)
  function movement(entryAxis, entryDir, exitAxis, exitDir) {
    const a = travelVec(entryAxis, entryDir);
    const b = travelVec(exitAxis, exitDir);
    if (a.x === b.x && a.z === b.z) return 'S';
    const l = leftOf(a);
    if (l.x === b.x && l.z === b.z) return 'L';
    if (-l.x === b.x && -l.z === b.z) return 'R';
    return 'U';
  }

  // 경로 구간의 정지선 앞 dist 미터 지점 (차로 중심)
  function legPose(legIndex, distBeforeStop, lane = 'outer') {
    const leg = ROUTE[legIndex];
    const road = byId[leg.road];
    const it = leg.to ? interByKey[leg.to] : null;
    let along;
    if (it) {
      const half = road.axis === 'x' ? it.hx : it.hz;
      const at = road.axis === 'x' ? it.x : it.z;
      along = at - leg.dir * (half + STOP_OFF + distBeforeStop);
    } else {
      along = -60; // 마지막 구간: 도착 지점 동쪽
    }
    const d = road.lanes === 2 ? (lane === 'inner' ? LANE * 0.5 : LANE * 1.5) : LANE * 0.5;
    const perp = road.axis === 'x' ? road.c + d * leg.dir : road.c - d * leg.dir;
    const t = travelVec(road.axis, leg.dir);
    const heading = Math.atan2(t.x, -t.z);
    return road.axis === 'x' ? { x: along, z: perp, heading } : { x: perp, z: along, heading };
  }

  // 지도에 그릴 경로 선분
  const routeLegs = ROUTE.map((leg, i) => {
    const a = i === 0 ? { x: -131, z: 4.95 } : interByKey[ROUTE[i - 1].to];
    const b = leg.to ? interByKey[leg.to] : { x: -115, z: -4.95 };
    return { x0: a.x, z0: a.z, x1: b.x, z1: b.z };
  });

  return {
    roads, byId, inters, interByKey, locate, onPavement, insideBlock, movement, legPose, limitAt, routeLegs, inBay,
    bounds: { x0: -160, x1: 160, z0: -190, z1: 130 },
    startPose: { x: -131, z: 7.85, heading: Math.PI / 2 },
  };
}

// ───────── 신호 제어 (방향별 순차 신호, 차가 없는 방향은 빨리 넘김)
class SignalController {
  constructor(inter, offset) {
    this.inter = inter;
    this.phases = ['W', 'N', 'E', 'S'].filter((a) => inter.arms[a]);
    this.idx = offset % this.phases.length;
    this.stage = 'green';
    this.t = 0;
    this.yellowAge = 0;
  }
  state(approach) {
    const cur = this.phases[this.idx];
    if (approach !== cur) return { state: 'red', age: 0 };
    if (this.stage === 'green') return { state: 'green', age: this.t };
    if (this.stage === 'yellow') return { state: 'yellow', age: this.t };
    return { state: 'red', age: this.t };
  }
  update(dt, demand) {
    this.t += dt;
    const cur = this.phases[this.idx];
    const anyOther = this.phases.some((a) => a !== cur && demand[a]);
    if (this.stage === 'green') {
      const minG = 4, maxG = 9;
      if ((this.t > minG && !demand[cur] && anyOther) || this.t > maxG) { this.stage = 'yellow'; this.t = 0; }
    } else if (this.stage === 'yellow') {
      if (this.t > 3) { this.stage = 'allred'; this.t = 0; }
    } else if (this.t > 1) {
      // 다음 방향: 기다리는 차가 있는 방향 우선
      let next = (this.idx + 1) % this.phases.length;
      for (let k = 1; k <= this.phases.length; k++) {
        const j = (this.idx + k) % this.phases.length;
        if (demand[this.phases[j]]) { next = j; break; }
      }
      this.idx = next;
      this.stage = 'green';
      this.t = 0;
    }
  }
}

// ───────── 다른 차(AI) 순환 경로
function buildLoopPath(model, legs) {
  const pts = [];
  const R = RC + LANE / 2; // 우회전 반경
  const lines = legs.map(([id, dir]) => {
    const road = model.byId[id];
    const t = travelVec(road.axis, dir);
    const d = road.hw - LANE / 2; // 바깥 차로
    const perp = road.axis === 'x' ? road.c + d * dir : road.c - d * dir;
    return { road, dir, t, perp };
  });
  const corner = (a, b) => {
    // a 구간 차로선과 b 구간 차로선의 교점
    const P = a.road.axis === 'x' ? { x: b.perp, z: a.perp } : { x: a.perp, z: b.perp };
    const A = { x: P.x - a.t.x * R, z: P.z - a.t.z * R };
    const B = { x: P.x + b.t.x * R, z: P.z + b.t.z * R };
    const C = { x: A.x + b.t.x * R, z: A.z + b.t.z * R };
    return { A, B, C };
  };
  const corners = lines.map((l, i) => corner(l, lines[(i + 1) % lines.length]));
  for (let i = 0; i < lines.length; i++) {
    const startB = corners[(i - 1 + lines.length) % lines.length].B;
    const { A, B, C } = corners[i];
    const len = Math.hypot(A.x - startB.x, A.z - startB.z);
    const n = Math.max(1, Math.ceil(len / 2));
    for (let k = 0; k < n; k++) pts.push({ x: startB.x + ((A.x - startB.x) * k) / n, z: startB.z + ((A.z - startB.z) * k) / n, arc: false });
    const a0 = Math.atan2(A.z - C.z, A.x - C.x);
    let a1 = Math.atan2(B.z - C.z, B.x - C.x);
    while (a1 - a0 > Math.PI) a1 -= Math.PI * 2;
    while (a1 - a0 < -Math.PI) a1 += Math.PI * 2;
    for (let k = 0; k < 10; k++) {
      const a = a0 + ((a1 - a0) * k) / 10;
      pts.push({ x: C.x + Math.cos(a) * R, z: C.z + Math.sin(a) * R, arc: true });
    }
  }
  let s = 0;
  pts.forEach((p, i) => {
    if (i > 0) s += Math.hypot(p.x - pts[i - 1].x, p.z - pts[i - 1].z);
    p.s = s;
  });
  const total = s + Math.hypot(pts[0].x - pts[pts.length - 1].x, pts[0].z - pts[pts.length - 1].z);

  // 정지 이벤트: 신호 교차로 정지선, 어린이보호구역 횡단보도
  const events = [];
  const sOf = (x, z) => {
    let best = 0, bd = Infinity;
    for (const p of pts) { const dd = (p.x - x) ** 2 + (p.z - z) ** 2; if (dd < bd) { bd = dd; best = p.s; } }
    return best;
  };
  for (const l of lines) {
    for (const ri of l.road.inters) {
      const it = ri.inter;
      const approach = approachCode(l.road.axis, l.dir);
      if (!it.signal && !it.stops.includes(approach)) continue;
      const along = ri.at - l.dir * (ri.half + STOP_OFF);
      const p = l.road.axis === 'x' ? { x: along, z: l.perp } : { x: l.perp, z: along };
      // 이 구간이 실제로 그 지점을 지나는지 확인
      const near = pts.some((q) => Math.hypot(q.x - p.x, q.z - p.z) < 1.5);
      if (near) events.push({ type: it.signal ? 'signal' : 'stop', inter: it, approach, s: sOf(p.x, p.z) });
    }
    if (l.road.id === SCHOOL.road) {
      const z = SCHOOL.cross - l.dir * 4.5;
      events.push({ type: 'cross', s: sOf(l.perp, z) });
    }
  }
  events.sort((a, b) => a.s - b.s);
  return { pts, total, events };
}

function sampleLoop(path, s) {
  const { pts, total } = path;
  s = ((s % total) + total) % total;
  let lo = 0, hi = pts.length - 1;
  while (lo < hi) { const m = (lo + hi + 1) >> 1; if (pts[m].s <= s) lo = m; else hi = m - 1; }
  const a = pts[lo], b = pts[(lo + 1) % pts.length];
  const sb = lo + 1 === pts.length ? total : b.s;
  const t = sb > a.s ? (s - a.s) / (sb - a.s) : 0;
  return { x: a.x + (b.x - a.x) * t, z: a.z + (b.z - a.z) * t, heading: Math.atan2(b.x - a.x, -(b.z - a.z)), arc: a.arc };
}

// 회전된 직사각형 겹침 (분리축 정리)
function obbOverlap(a, b) {
  const axes = [
    { x: Math.sin(a.h), z: -Math.cos(a.h) }, { x: Math.cos(a.h), z: Math.sin(a.h) },
    { x: Math.sin(b.h), z: -Math.cos(b.h) }, { x: Math.cos(b.h), z: Math.sin(b.h) },
  ];
  const corners = (o) => {
    const f = { x: Math.sin(o.h), z: -Math.cos(o.h) }, r = { x: Math.cos(o.h), z: Math.sin(o.h) };
    return [[1, 1], [1, -1], [-1, 1], [-1, -1]].map(([i, j]) => ({ x: o.x + f.x * o.hl * i + r.x * o.hw * j, z: o.z + f.z * o.hl * i + r.z * o.hw * j }));
  };
  const ca = corners(a), cb = corners(b);
  for (const ax of axes) {
    const pa = ca.map((p) => p.x * ax.x + p.z * ax.z), pb = cb.map((p) => p.x * ax.x + p.z * ax.z);
    if (Math.max(...pa) < Math.min(...pb) || Math.max(...pb) < Math.min(...pa)) return false;
  }
  return true;
}

// ───────── 3D 도시 + 교통 + 보행자
export function buildCity(scene, model) {
  const root = new THREE.Group();
  root.visible = false;
  scene.add(root);

  const asphaltTex = noiseTexture(256, 256, '#3f4247', 20, { speckle: 1200 });
  asphaltTex.repeat.set(120, 120);
  const tileTex = (() => {
    const c = makeCanvas(128, 128);
    const g = c.getContext('2d');
    g.fillStyle = '#b9b5ac'; g.fillRect(0, 0, 128, 128);
    g.strokeStyle = '#a19c92'; g.lineWidth = 3;
    for (let i = 0; i <= 128; i += 32) { g.beginPath(); g.moveTo(i, 0); g.lineTo(i, 128); g.stroke(); g.beginPath(); g.moveTo(0, i); g.lineTo(128, i); g.stroke(); }
    const t = canvasTexture(c);
    t.wrapS = t.wrapT = THREE.RepeatWrapping;
    t.repeat.set(0.5, 0.5);
    return t;
  })();
  const M = {
    asphalt: new THREE.MeshLambertMaterial({ map: asphaltTex }),
    grass: new THREE.MeshLambertMaterial({ color: 0x5c8a3e }),
    sidewalk: new THREE.MeshLambertMaterial({ map: tileTex }),
    white: new THREE.MeshLambertMaterial({ color: 0xf4f4f0, emissive: 0x222222, polygonOffset: true, polygonOffsetFactor: -3, polygonOffsetUnits: -3 }),
    yellow: new THREE.MeshLambertMaterial({ color: 0xf3c02a, emissive: 0x221800, polygonOffset: true, polygonOffsetFactor: -3, polygonOffsetUnits: -3 }),
    school: new THREE.MeshLambertMaterial({ color: 0xa8433a, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2 }),
    dest: new THREE.MeshBasicMaterial({ color: 0x2f7bff, transparent: true, opacity: 0.28, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -4, polygonOffsetUnits: -4 }),
    post: new THREE.MeshLambertMaterial({ color: 0x9aa3ad }),
    dark: new THREE.MeshLambertMaterial({ color: 0x2b2f35 }),
    trunk: new THREE.MeshLambertMaterial({ color: 0x6b4a2f }),
    leaf: new THREE.MeshLambertMaterial({ color: 0xffffff }),
    sand: new THREE.MeshLambertMaterial({ color: 0xd8c49a }),
    fence: new THREE.MeshLambertMaterial({ color: 0x3f7a55 }),
  };

  // 바닥: 도시 전체 아스팔트 + 바깥 풀밭
  const far = new THREE.Mesh(new THREE.PlaneGeometry(3000, 3000), M.grass);
  far.rotation.x = -Math.PI / 2;
  far.position.y = -0.05;
  root.add(far);
  const base = new THREE.Mesh(new THREE.PlaneGeometry(600, 540), M.asphalt);
  base.rotation.x = -Math.PI / 2;
  base.position.set(0, 0, -30);
  root.add(base);

  // ── 블록(보도 + 연석): 둥근 모서리 사각형을 0.15m 올림
  const blocks = new GeoBatch();
  for (const b of BLOCKS) {
    const s = new THREE.Shape();
    const r = b.r;
    // shape 좌표: X = x, Y = -z (눕힌 뒤 월드 z가 되도록)
    const X0 = b.x0, X1 = b.x1, Y0 = -b.z1, Y1 = -b.z0;
    s.moveTo(X0 + r, Y0);
    if (b.notch && b.notch.edge === 'z1') {
      // 아래쪽 변(z1)의 정차 구역 홈
      const n = b.notch;
      s.lineTo(n.a0 - 1, Y0); s.lineTo(n.a0, Y0 + n.depth); s.lineTo(n.a1, Y0 + n.depth); s.lineTo(n.a1 + 1, Y0);
    }
    s.lineTo(X1 - r, Y0);
    if (r) s.absarc(X1 - r, Y0 + r, r, -Math.PI / 2, 0, false);
    s.lineTo(X1, Y1 - r);
    if (r) s.absarc(X1 - r, Y1 - r, r, 0, Math.PI / 2, false);
    if (b.notch && b.notch.edge === 'z0') {
      const n = b.notch;
      s.lineTo(n.a1 + 1, Y1); s.lineTo(n.a1, Y1 - n.depth); s.lineTo(n.a0, Y1 - n.depth); s.lineTo(n.a0 - 1, Y1);
    }
    s.lineTo(X0 + r, Y1);
    if (r) s.absarc(X0 + r, Y1 - r, r, Math.PI / 2, Math.PI, false);
    s.lineTo(X0, Y0 + r);
    if (r) s.absarc(X0 + r, Y0 + r, r, Math.PI, Math.PI * 1.5, false);
    const geo = new THREE.ExtrudeGeometry(s, { depth: 0.15, bevelEnabled: false, curveSegments: 8 });
    geo.rotateX(-Math.PI / 2);
    blocks.add(geo, M.sidewalk);
  }
  blocks.build(root, 'blocks');

  // ── 차선 표시
  const marks = new GeoBatch();
  const Y = 0.02;
  const rect = (mat, x0, x1, z0, z1, y = Y) => {
    const g = new THREE.PlaneGeometry(Math.abs(x1 - x0), Math.abs(z1 - z0));
    g.rotateX(-Math.PI / 2);
    marks.add(g, mat, matrixFrom((x0 + x1) / 2, y, (z0 + z1) / 2));
  };
  // 도로 좌표(along, perp)로 사각형
  const rrect = (road, mat, a0, a1, p0, p1, y) => {
    if (road.axis === 'x') rect(mat, a0, a1, p0, p1, y); else rect(mat, p0, p1, a0, a1, y);
  };
  const crossSpots = []; // 횡단보도 위치 (표지판 등에 사용)
  for (const road of model.roads) {
    const list = road.inters;
    for (let i = 0; i < list.length - 1; i++) {
      const A = list[i], B = list[i + 1];
      const a0 = A.at + A.half, a1 = B.at - B.half;
      // 끝마다 횡단보도/정지선 여부
      const endInfo = (ri, dirToward) => {
        const app = approachCode(road.axis, dirToward);
        const it = ri.inter;
        return { signal: it.signal, stop: it.stops.includes(app), cross: it.signal };
      };
      const eA = endInfo(A, -1), eB = endInfo(B, 1);
      const cA = eA.cross ? CW_FAR + 0.6 : 0, cB = eB.cross ? CW_FAR + 0.6 : 0;
      // 중앙선
      for (const off of [-0.17, 0.07]) rrect(road, M.yellow, a0 + cA, a1 - cB, road.c + off, road.c + off + 0.1);
      // 가장자리선 (정차 구역 제외)
      const eOffA = Math.max(cA, RC), eOffB = Math.max(cB, RC);
      for (const side of [-1, 1]) {
        const p = road.c + side * (road.hw - 0.2);
        let gaps = [];
        if (road.id === 'A1') {
          const bay = side > 0 ? BAYS.start : BAYS.dest;
          gaps = [[bay.x0, bay.x1]];
        }
        let cur = a0 + eOffA;
        for (const [g0, g1] of gaps) {
          if (g1 < cur || g0 > a1 - eOffB) continue;
          rrect(road, M.white, cur, g0, p - 0.075, p + 0.075);
          cur = g1;
        }
        rrect(road, M.white, cur, a1 - eOffB, p - 0.075, p + 0.075);
      }
      // 2차로 도로: 차로 경계 (교차로 앞 30m는 실선 = 진로변경 제한)
      if (road.lanes === 2) {
        for (const dir of [1, -1]) {
          const p = road.axis === 'x' ? road.c + LANE * dir : road.c - LANE * dir;
          const towardEnd = dir > 0 ? eB : eA;
          const stopAlong = dir > 0 ? a1 - STOP_OFF : a0 + STOP_OFF;
          const solidLen = towardEnd.signal || towardEnd.stop ? 30 : 0;
          const s0 = dir > 0 ? a0 + cA : a1 - cB;           // 이 방향 구간 시작
          const s1 = stopAlong;                               // 정지선
          const solidStart = s1 - dir * solidLen;
          // 점선
          const lo = Math.min(s0, solidStart), hi = Math.max(s0, solidStart);
          for (let a = lo; a < hi - 3; a += 8) rrect(road, M.white, a, a + 3, p - 0.075, p + 0.075);
          if (solidLen) rrect(road, M.white, Math.min(solidStart, s1), Math.max(solidStart, s1), p - 0.075, p + 0.075);
        }
      }
      // 정지선 + 횡단보도
      for (const [ri, dirToward, e] of [[B, 1, eB], [A, -1, eA]]) {
        const edge = dirToward > 0 ? a1 : a0; // 교차로 가장자리 along
        if (e.signal || e.stop) {
          const sl = edge - dirToward * STOP_OFF;
          const pr0 = road.axis === 'x' ? road.c + 0.2 * dirToward : road.c - 0.2 * dirToward;
          const pr1 = road.axis === 'x' ? road.c + road.hw * dirToward : road.c - road.hw * dirToward;
          rrect(road, M.white, sl - 0.225, sl + 0.225, Math.min(pr0, pr1), Math.max(pr0, pr1));
        }
        if (e.cross) {
          const c0 = edge - dirToward * CW_FAR, c1 = edge - dirToward * CW_NEAR;
          for (let p = road.c - road.hw + 0.3; p < road.c + road.hw - 0.3; p += 0.9) {
            rrect(road, M.white, Math.min(c0, c1), Math.max(c0, c1), p, p + 0.45);
          }
          crossSpots.push({ road, along: (c0 + c1) / 2 });
        }
      }
    }
  }
  // 어린이보호구역: 붉은 노면 + 횡단보도
  {
    const road = model.byId[SCHOOL.road];
    rrect(road, M.school, SCHOOL.z0, SCHOOL.z1, road.c - road.hw, road.c + road.hw, 0.012);
    for (let p = road.c - road.hw + 0.3; p < road.c + road.hw - 0.3; p += 0.9) rrect(road, M.white, SCHOOL.cross - 2, SCHOOL.cross + 2, p, p + 0.45, 0.025);
    rrect(road, M.white, SCHOOL.cross - 4.5 - 0.225, SCHOOL.cross - 4.5 + 0.225, road.c - road.hw, road.c - 0.2, 0.025);
    rrect(road, M.white, SCHOOL.cross + 4.5 - 0.225, SCHOOL.cross + 4.5 + 0.225, road.c + 0.2, road.c + road.hw, 0.025);
  }
  // 도착/출발 구역
  rect(M.dest, BAYS.dest.x0, BAYS.dest.x1, BAYS.dest.z0, BAYS.dest.z1, 0.03);
  marks.build(root, 'marks');

  // ── 노면 글자 (아틀라스 하나)
  const decals = [];
  const decal = (text, x, z, heading, w, opts = {}) => decals.push({ text, x, z, heading, w, ...opts });
  {
    const s2 = model.byId.S2;
    decal('어린이 보호구역', s2.c - 1.65, SCHOOL.z0 + 6, Math.PI, 3.0, { color: '#ffffff' });
    decal('30', s2.c - 1.65, SCHOOL.z0 + 14, Math.PI, 2.4, { color: '#ffffff', ring: true });
    decal('어린이 보호구역', s2.c + 1.65, SCHOOL.z1 - 6, 0, 3.0, { color: '#ffffff' });
    decal('30', s2.c + 1.65, SCHOOL.z1 - 14, 0, 2.4, { color: '#ffffff', ring: true });
    decal('천천히', s2.c - 1.65, SCHOOL.cross - 12, Math.PI, 2.6, { color: '#ffffff' });
    decal('천천히', s2.c + 1.65, SCHOOL.cross + 12, 0, 2.6, { color: '#ffffff' });
    const it = model.interByKey['90,-180'];
    decal('정지', 90 + 3.3, it.z + it.hz + STOP_OFF + 3, 0, 3.0, { color: '#ffffff' });
    decal('출발', -128, 7.85, Math.PI / 2, 2.2, { color: '#ffffff' });
    decal('도착', -115, -7.85, -Math.PI / 2, 2.2, { color: '#ffffff' });
    // 좌회전/직진 화살표 (2차로 신호 접근로)
    for (const road of model.roads.filter((r) => r.lanes === 2)) {
      for (const ri of road.inters) {
        if (!ri.inter.signal) continue;
        for (const dir of [1, -1]) {
          const app = approachCode(road.axis, dir);
          if (!ri.inter.arms[app]) continue;
          const along = ri.at - dir * (ri.half + STOP_OFF + 16);
          if (along < road.from || along > road.to) continue;
          const t = travelVec(road.axis, dir);
          const heading = Math.atan2(t.x, -t.z);
          for (const [d, txt] of [[LANE * 0.5, 'L'], [LANE * 1.5, 'SR']]) {
            const perp = road.axis === 'x' ? road.c + d * dir : road.c - d * dir;
            const pos = road.axis === 'x' ? { x: along, z: perp } : { x: perp, z: along };
            decal(txt, pos.x, pos.z, heading, 2.2, { arrow: true });
          }
        }
      }
    }
  }
  buildDecals(root, decals);

  // ── 건물 (창문 텍스처 하나 + 정점 색으로 한 번에)
  buildBuildings(root, model);

  // ── 학교: 운동장, 울타리, 간판
  {
    const g = new GeoBatch();
    g.addBox(M.sand, 34, 0.04, 44, 2, 0.17, -128);
    for (const [x, z, w, d] of [[2, -150.5, 34, 0.1], [2, -105.5, 34, 0.1], [-15.2, -128, 0.1, 45], [19.2, -128, 0.1, 45]]) g.addBox(M.fence, w, 1.4, d, x, 0.85, z);
    g.addBox(M.dark, 0.15, 3, 0.15, -10, 1.6, -140);
    g.addBox(M.dark, 0.15, 3, 0.15, 14, 1.6, -140);
    g.addBox(M.dark, 24, 0.12, 0.12, 2, 3.0, -140);
    g.build(root, 'school');
  }

  // ── 표지판 (아틀라스)
  const signs = [];
  const sign = (kind, x, z, heading, opts = {}) => signs.push({ kind, x, z, heading, ...opts });
  const roadsideFor = (road, dir, along, extra = 1.6) => {
    const d = road.hw + extra;
    const perp = road.axis === 'x' ? road.c + d * dir : road.c - d * dir;
    const t = travelVec(road.axis, dir);
    const heading = Math.atan2(t.x, -t.z);
    return road.axis === 'x' ? { x: along, z: perp, heading } : { x: perp, z: along, heading };
  };
  for (const road of model.roads) {
    for (const dir of [1, -1]) {
      const along = dir > 0 ? road.from + 22 : road.to - 22;
      const p = roadsideFor(road, dir, along);
      sign('limit50', p.x, p.z, p.heading);
    }
  }
  {
    const s2 = model.byId.S2;
    let p = roadsideFor(s2, 1, SCHOOL.z0 - 2);
    sign('school', p.x, p.z, p.heading);
    p = roadsideFor(s2, 1, SCHOOL.z0 + 3);
    sign('limit30', p.x, p.z, p.heading);
    p = roadsideFor(s2, -1, SCHOOL.z1 + 2);
    sign('school', p.x, p.z, p.heading);
    p = roadsideFor(s2, -1, SCHOOL.z1 - 3);
    sign('limit30', p.x, p.z, p.heading);
    p = roadsideFor(s2, 1, SCHOOL.cross - 6, 1.2);
    sign('pause', p.x, p.z, p.heading);
    p = roadsideFor(s2, -1, SCHOOL.cross + 6, 1.2);
    sign('pause', p.x, p.z, p.heading);
    const s3 = model.byId.S3;
    const it = model.interByKey['90,-180'];
    p = roadsideFor(s3, -1, it.z + it.hz + STOP_OFF + 1, 1.2);
    sign('stop', p.x, p.z, p.heading);
    sign('start', -124, 10.8, Math.PI / 2);
    sign('dest', -113, -10.8, -Math.PI / 2);
  }
  buildSigns(root, signs, M);
  {
    const tex = labelTexture_(['VR초등학교'], { w: 512, h: 128, bg: '#0f2a52', size: 76 });
    const mesh = new THREE.Mesh(new THREE.PlaneGeometry(6, 1.5), new THREE.MeshLambertMaterial({ map: tex, emissive: 0x333333, emissiveMap: tex }));
    mesh.position.set(2, 3.6, -140.1);
    root.add(mesh);
  }

  // ── 나무, 가로등
  buildStreetFurniture(root, model, M);

  // ── 신호등
  const controllers = {};
  let off = 0;
  for (const it of model.inters) if (it.signal) controllers[it.key] = new SignalController(it, off++);
  const lamps = buildSignalHeads(root, model, M);

  // ── 먼 산
  const hills = new GeoBatch();
  for (let i = 0; i < 12; i++) {
    const a = (i / 12) * Math.PI * 2;
    const r = randRange(420, 560);
    const h = randRange(50, 120);
    hills.add(new THREE.ConeGeometry(randRange(100, 180), h, 7), new THREE.MeshLambertMaterial({ color: 0x6e8a7a }), matrixFrom(Math.cos(a) * r, h / 2 - 2, -30 + Math.sin(a) * r));
  }
  hills.build(root, 'hills');

  // ── 다른 차들
  const traffic = buildTraffic(root, model);
  // ── 보행자
  const peds = buildPeds(root, model);

  const city = {
    root, model, controllers, traffic, peds, t: 0, events: [], routeLegs: model.routeLegs,
    signalOf(interKey, approach) {
      const c = controllers[interKey];
      return c ? c.state(approach) : { state: 'green', age: 99 };
    },
    update(dt, car, opts = {}) {
      this.t += dt;
      this.events.length = 0;
      // 신호: 각 방향 대기 차량 수요
      const vehicles = traffic.cars.map((c) => ({ x: c.x, z: c.z, h: c.heading }));
      vehicles.push({ x: car.x, z: car.z, h: car.heading });
      const demand = {};
      for (const v of vehicles) {
        const loc = model.locate(v.x, v.z, v.h);
        if (loc.type === 'road' && loc.next && loc.next.inter.signal && loc.next.distStop > -2 && loc.next.distStop < 45) {
          (demand[loc.next.inter.key] ||= {})[loc.next.approach] = true;
        }
      }
      for (const key in controllers) controllers[key].update(dt, demand[key] || {});
      lamps.update(controllers);
      traffic.update(dt, car, this, opts);
      peds.update(dt, car, traffic, opts);
      // 충돌
      const me = { x: car.x, z: car.z, h: car.heading, hl: CAR.length / 2, hw: CAR.width / 2 };
      for (const c of traffic.cars) {
        if (Math.abs(c.x - car.x) > 7 || Math.abs(c.z - car.z) > 7) continue;
        if (obbOverlap(me, { x: c.x, z: c.z, h: c.heading, hl: 2.3, hw: 0.93 })) {
          this.events.push({ type: 'crash', car: c });
          c.v = 0;
          c.stuck = 3;
        }
      }
      for (const p of peds.list) {
        if (!p.active) continue;
        const dx = p.x - car.x, dz = p.z - car.z;
        const f = { x: Math.sin(car.heading), z: -Math.cos(car.heading) };
        const along = dx * f.x + dz * f.z, lat = dx * f.z * -1 + dz * f.x;
        if (Math.abs(along) < CAR.length / 2 + 0.25 && Math.abs(lat) < CAR.width / 2 + 0.25) {
          this.events.push({ type: 'hitPed', ped: p });
          p.hit = 2;
        }
      }
    },
    // 앞차와의 간격 (같은 차로)
    gapAhead(car) {
      let best = Infinity;
      const f = { x: Math.sin(car.heading), z: -Math.cos(car.heading) };
      for (const c of traffic.cars) {
        const dx = c.x - car.x, dz = c.z - car.z;
        const along = dx * f.x + dz * f.z;
        const lat = -dx * f.z + dz * f.x;
        if (along > 0 && along < 60 && Math.abs(lat) < 1.6) best = Math.min(best, along - 4.7);
      }
      return best;
    },
    // 학교 앞 횡단보도: 차도 위(또는 막 들어서려는) 보행자가 있는지 → 지나가면 보행자 보호 위반
    pedOnSchoolCrossing() {
      const road = model.byId[SCHOOL.road];
      return peds.list.some((p) => p.active && p.crossing && Math.abs(p.x - road.c) < road.hw + 1.0 && Math.abs(p.z - SCHOOL.cross) < 2.5);
    },
    // 건너려고 걷기 시작한 보행자까지 포함 → 양보 판단용
    pedCrossingActive() {
      return peds.list.some((p) => p.active && p.crossing);
    },
    spawnCrossingPed() { peds.spawnCrossing(); },
  };
  return city;
}

function buildDecals(root, decals) {
  const W = 1024, cellW = 256, cellH = 128;
  const cols = W / cellW;
  const rows = Math.ceil(decals.length / cols);
  const H = THREE.MathUtils.ceilPowerOfTwo(rows * cellH);
  const c = makeCanvas(W, H);
  const g = c.getContext('2d');
  decals.forEach((d, i) => {
    const x = (i % cols) * cellW, y = Math.floor(i / cols) * cellH;
    d.slot = { x, y };
    g.save();
    g.translate(x + cellW / 2, y + cellH / 2);
    g.fillStyle = d.color || '#ffffff';
    g.strokeStyle = d.color || '#ffffff';
    if (d.arrow) {
      g.lineWidth = 14; g.lineCap = 'round'; g.lineJoin = 'round';
      const arrowHead = (x0, y0, ang) => {
        g.beginPath();
        g.moveTo(x0 + Math.cos(ang) * 26, y0 + Math.sin(ang) * 26);
        g.lineTo(x0 + Math.cos(ang + 2.4) * 22, y0 + Math.sin(ang + 2.4) * 22);
        g.lineTo(x0 + Math.cos(ang - 2.4) * 22, y0 + Math.sin(ang - 2.4) * 22);
        g.closePath(); g.fill();
      };
      if (d.text === 'L') {
        g.beginPath(); g.moveTo(10, 50); g.lineTo(10, -10); g.lineTo(-30, -10); g.stroke();
        arrowHead(-40, -10, Math.PI);
      } else {
        g.beginPath(); g.moveTo(-14, 50); g.lineTo(-14, -30); g.stroke();
        arrowHead(-14, -40, -Math.PI / 2);
        g.beginPath(); g.moveTo(-14, 20); g.lineTo(-14, 0); g.lineTo(30, 0); g.stroke();
        arrowHead(40, 0, 0);
      }
    } else {
      if (d.ring) { g.lineWidth = 9; g.beginPath(); g.arc(0, 0, 56, 0, Math.PI * 2); g.stroke(); }
      g.font = `900 ${d.text.length > 3 ? 40 : 66}px ${FONT}`;
      g.textAlign = 'center'; g.textBaseline = 'middle';
      g.fillText(d.text, 0, 4, cellW - 16);
    }
    g.restore();
  });
  const tex = canvasTexture(c);
  const mat = new THREE.MeshLambertMaterial({ map: tex, transparent: true, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -4, polygonOffsetUnits: -4 });
  const batch = new GeoBatch();
  for (const d of decals) {
    const h = d.w * (cellH / cellW) * (d.arrow ? 1.6 : 1);
    const geo = new THREE.PlaneGeometry(d.w, h);
    const uv = geo.attributes.uv;
    for (let i = 0; i < uv.count; i++) {
      uv.setXY(i, (d.slot.x + uv.getX(i) * cellW) / W, 1 - (d.slot.y + (1 - uv.getY(i)) * cellH) / H);
    }
    const m = new THREE.Matrix4().makeRotationFromEuler(new THREE.Euler(-Math.PI / 2, -d.heading, 0, 'YXZ'));
    m.setPosition(d.x, 0.035, d.z);
    batch.add(geo, mat, m);
  }
  batch.build(root, 'decals');
}

function buildBuildings(root, model) {
  const c = makeCanvas(256, 256);
  const g = c.getContext('2d');
  g.fillStyle = '#eeeeee'; g.fillRect(0, 0, 256, 256);
  for (let i = 0; i < 4; i++) {
    for (let j = 0; j < 4; j++) {
      const lit = Math.random() < 0.18;
      g.fillStyle = lit ? '#f5e2a8' : '#5b6f86';
      g.fillRect(i * 64 + 10, j * 64 + 14, 44, 36);
      g.fillStyle = 'rgba(255,255,255,0.25)';
      g.fillRect(i * 64 + 10, j * 64 + 14, 44, 5);
    }
  }
  const tex = canvasTexture(c);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  const mat = new THREE.MeshLambertMaterial({ map: tex, vertexColors: true });
  const palette = [0xe9e4da, 0xc9d3dd, 0xd8c7b0, 0xb7c4c9, 0xe2d6c6, 0x9fb3c8, 0xcfc9c0, 0xb5aea3, 0xdfe7ee];
  const geos = [];
  const col = new THREE.Color();
  const add = (x, z, w, d, h, color) => {
    const geo = new THREE.BoxGeometry(w, h, d);
    geo.translate(x, h / 2 + 0.15, z);
    const uv = geo.attributes.uv;
    for (let face = 0; face < 6; face++) {
      for (let k = 0; k < 4; k++) {
        const i = face * 4 + k;
        if (face === 2 || face === 3) { uv.setXY(i, 0.01, 0.99); continue; }
        const span = face < 2 ? d : w;
        uv.setXY(i, uv.getX(i) * (span / 12), uv.getY(i) * (h / 12));
      }
    }
    col.setHex(color);
    const colors = new Float32Array(uv.count * 3);
    for (let i = 0; i < uv.count; i++) { colors[i * 3] = col.r; colors[i * 3 + 1] = col.g; colors[i * 3 + 2] = col.b; }
    geo.setAttribute('color', new THREE.BufferAttribute(colors, 3));
    geos.push(geo);
  };
  const avoid = [
    { x0: -16, x1: 20, z0: -152, z1: -104 },   // 학교 운동장
    { x0: -18, x1: 22, z0: -93, z1: -75 },     // 학교 건물
    { x0: 96, x1: 140, z0: -75, z1: -45 },     // 시청
    { x0: -140, x1: -110, z0: 17, z1: 35 },    // 출발점 건물
  ];
  const free = (x, z, w, d) => !avoid.some((a) => x + w / 2 > a.x0 && x - w / 2 < a.x1 && z + d / 2 > a.z0 && z - d / 2 < a.z1);
  for (const b of BLOCKS) {
    const inset = 4;
    if (b.outer) {
      // 바깥 블록: 도로를 향한 한 줄 + 먼 고층 건물
      const horiz = b.id === 'N' || b.id === 'S';
      const len0 = horiz ? b.x0 + 6 : b.z0 + 6, len1 = horiz ? b.x1 - 6 : b.z1 - 6;
      let a = len0;
      while (a < len1) {
        const w = randRange(14, 24);
        const dd = randRange(14, 20);
        const h = randRange(10, 40);
        const edge = b.id === 'N' ? b.z1 - inset - dd / 2 : b.id === 'S' ? b.z0 + inset + dd / 2 : b.id === 'W' ? b.x1 - inset - dd / 2 : b.x0 + inset + dd / 2;
        if (horiz) add(a + w / 2, edge, w - 2, dd, h, palette[(Math.random() * palette.length) | 0]);
        else add(edge, a + w / 2, dd, w - 2, h, palette[(Math.random() * palette.length) | 0]);
        a += w;
      }
      continue;
    }
    // 안쪽 블록: 가장자리를 따라 건물을 두르고 가운데는 비움
    const x0 = b.x0 + inset, x1 = b.x1 - inset, z0 = b.z0 + inset, z1 = b.z1 - inset;
    const depth = Math.min(18, (z1 - z0) / 2 - 2, (x1 - x0) / 2 - 2);
    const placeRow = (horiz, fixed, a0, a1, faceSign) => {
      let a = a0;
      while (a < a1 - 8) {
        const w = Math.min(randRange(14, 26), a1 - a);
        const h = randRange(8, b.id === 'B4' ? 26 : 38);
        const cx = horiz ? a + w / 2 : fixed + faceSign * depth / 2;
        const cz = horiz ? fixed + faceSign * depth / 2 : a + w / 2;
        const bw = horiz ? w - 2 : depth;
        const bd = horiz ? depth : w - 2;
        if (free(cx, cz, bw, bd)) add(cx, cz, bw, bd, h, palette[(Math.random() * palette.length) | 0]);
        a += w;
      }
    };
    const rr = b.r + 4;
    placeRow(true, z0, x0 + rr, x1 - rr, 1);
    placeRow(true, z1, x0 + rr, x1 - rr, -1);
    if (z1 - z0 > depth * 2 + 10) {
      placeRow(false, x0, z0 + depth + 2, z1 - depth - 2, 1);
      placeRow(false, x1, z0 + depth + 2, z1 - depth - 2, -1);
    }
  }
  // 학교 건물, 시청, 시험장
  add(2, -84, 36, 14, 12, 0xf1e6c8);
  add(118, -60, 40, 26, 22, 0xdfe7ee);
  add(-125, 26, 26, 14, 9, 0xe9e6df);
  const merged = mergeGeometries(geos, false);
  geos.forEach((gg) => gg.dispose());
  const mesh = new THREE.Mesh(merged, mat);
  mesh.matrixAutoUpdate = false;
  root.add(mesh);
}

function buildSigns(root, signs, M) {
  const SW = 256;
  const draw = (g, kind, x, y, w, h) => {
    g.save();
    g.translate(x, y);
    const cx = w / 2, cy = h / 2;
    if (kind.startsWith('limit')) {
      g.fillStyle = '#fff'; g.beginPath(); g.arc(cx, cy, 116, 0, Math.PI * 2); g.fill();
      g.strokeStyle = '#d4202a'; g.lineWidth = 26; g.beginPath(); g.arc(cx, cy, 100, 0, Math.PI * 2); g.stroke();
      g.fillStyle = '#111'; g.font = `900 104px ${FONT}`; g.textAlign = 'center'; g.textBaseline = 'middle';
      g.fillText(kind.slice(5), cx, cy + 6);
    } else if (kind === 'stop') {
      g.fillStyle = '#fff';
      g.beginPath(); g.moveTo(8, 20); g.lineTo(w - 8, 20); g.lineTo(cx, h - 6); g.closePath(); g.fill();
      g.fillStyle = '#d4202a';
      g.beginPath(); g.moveTo(26, 32); g.lineTo(w - 26, 32); g.lineTo(cx, h - 28); g.closePath(); g.fill();
      g.fillStyle = '#fff'; g.font = `900 60px ${FONT}`; g.textAlign = 'center'; g.textBaseline = 'middle';
      g.fillText('정지', cx, 92);
      g.font = `900 30px ${FONT}`; g.fillText('STOP', cx, 136);
    } else if (kind === 'school') {
      drawLabel(g, 0, 0, w, h, [{ text: '어린이', size: 64 }, { text: '보호구역', size: 64 }], { bg: '#f4c20d', fg: '#111', border: '#111', radius: 20 });
    } else if (kind === 'pause') {
      drawLabel(g, 0, 0, w, h, [{ text: '일시정지', size: 56 }, { text: '횡단보도', size: 40 }], { bg: '#ffffff', fg: '#d4202a', border: '#d4202a', radius: 20 });
    } else if (kind === 'start') {
      drawLabel(g, 0, 0, w, h, [{ text: '도로주행', size: 54 }, { text: '출발', size: 70 }], { bg: '#167a3e', radius: 20 });
    } else if (kind === 'dest') {
      drawLabel(g, 0, 0, w, h, [{ text: '도착', size: 80 }, { text: '여기에 정차', size: 40 }], { bg: '#1d5fc4', radius: 20 });
    }
    g.restore();
  };
  const cols = 4;
  const AW = SW * cols;
  const rows = Math.ceil(signs.length / cols);
  const AH = THREE.MathUtils.ceilPowerOfTwo(rows * SW);
  const c = makeCanvas(AW, AH);
  const g = c.getContext('2d');
  signs.forEach((s, i) => {
    s.slot = { x: (i % cols) * SW, y: Math.floor(i / cols) * SW };
    draw(g, s.kind, s.slot.x, s.slot.y, SW, SW);
  });
  const tex = canvasTexture(c);
  const mat = new THREE.MeshLambertMaterial({ map: tex, transparent: true, alphaTest: 0.3, emissive: 0x333333, emissiveMap: tex, side: THREE.DoubleSide });
  const batch = new GeoBatch();
  for (const s of signs) {
    const w = 0.9, h = 0.9;
    const y = 2.3;
    batch.addBox(M.post, 0.07, y + 0.15, 0.07, s.x, (y + 0.15) / 2, s.z);
    const geo = new THREE.PlaneGeometry(w, h);
    const uv = geo.attributes.uv;
    for (let i = 0; i < uv.count; i++) {
      const u = uv.getX(i), v = uv.getY(i);
      uv.setXY(i, (s.slot.x + u * SW) / AW, 1 - (s.slot.y + (1 - v) * SW) / AH);
    }
    batch.add(geo, mat, matrixFrom(s.x, y + h / 2, s.z, -s.heading));
  }
  batch.build(root, 'signs');
}

function buildStreetFurniture(root, model, M) {
  const trees = [];
  const lampsPos = [];
  for (const b of BLOCKS) {
    if (b.outer) continue;
    const edges = [
      { horiz: true, fixed: b.z0 + 1.6, a0: b.x0, a1: b.x1, face: Math.PI },
      { horiz: true, fixed: b.z1 - 1.6, a0: b.x0, a1: b.x1, face: 0 },
      { horiz: false, fixed: b.x0 + 1.6, a0: b.z0, a1: b.z1, face: -Math.PI / 2 },
      { horiz: false, fixed: b.x1 - 1.6, a0: b.z0, a1: b.z1, face: Math.PI / 2 },
    ];
    for (const e of edges) {
      for (let a = e.a0 + b.r + 6; a < e.a1 - b.r - 6; a += 12) {
        const x = e.horiz ? a : e.fixed, z = e.horiz ? e.fixed : a;
        if (Object.values(BAYS).some((bay) => x > bay.x0 - 3 && x < bay.x1 + 3 && Math.abs(z - (bay.z0 + bay.z1) / 2) < 6)) continue;
        if (Math.abs(z - SCHOOL.cross) < 5 && Math.abs(x - -30) < 8) continue;
        if (((a - e.a0) / 12 | 0) % 3 === 1) lampsPos.push({ x, z }); else trees.push({ x, z });
      }
    }
  }
  const trunkGeo = new THREE.CylinderGeometry(0.12, 0.18, 2.2, 6);
  trunkGeo.translate(0, 1.25, 0);
  const crownGeo = new THREE.IcosahedronGeometry(1.4, 0);
  crownGeo.translate(0, 3.2, 0);
  const trunks = new THREE.InstancedMesh(trunkGeo, M.trunk, trees.length);
  const crowns = new THREE.InstancedMesh(crownGeo, M.leaf, trees.length);
  const m = new THREE.Matrix4();
  const col = new THREE.Color();
  trees.forEach((t, i) => {
    const s = randRange(0.85, 1.2);
    m.compose(new THREE.Vector3(t.x, 0.15, t.z), new THREE.Quaternion(), new THREE.Vector3(s, s, s));
    trunks.setMatrixAt(i, m);
    crowns.setMatrixAt(i, m);
    col.setHSL(randRange(0.24, 0.33), 0.45, randRange(0.28, 0.36));
    crowns.setColorAt(i, col);
  });
  root.add(trunks, crowns);
  const poleGeo = new THREE.CylinderGeometry(0.07, 0.1, 6, 6);
  poleGeo.translate(0, 3.15, 0);
  const headGeo = new THREE.BoxGeometry(0.3, 0.12, 0.8);
  headGeo.translate(0, 6.1, 0.3);
  const poles = new THREE.InstancedMesh(poleGeo, M.post, lampsPos.length);
  const heads = new THREE.InstancedMesh(headGeo, M.dark, lampsPos.length);
  lampsPos.forEach((p, i) => {
    m.makeTranslation(p.x, 0, p.z);
    poles.setMatrixAt(i, m);
    heads.setMatrixAt(i, m);
  });
  root.add(poles, heads);
}

function buildSignalHeads(root, model, M) {
  const housings = new GeoBatch();
  const lampGeo = new THREE.CircleGeometry(0.13, 16);
  const lampList = []; // { inter, approach, k }
  const mats = [];
  for (const it of model.inters) {
    if (!it.signal) continue;
    for (const a of ['W', 'N', 'E', 'S']) {
      if (!it.arms[a]) continue;
      const axis = a === 'W' || a === 'E' ? 'x' : 'z';
      const dir = a === 'W' || a === 'N' ? 1 : -1;
      const t = travelVec(axis, dir);
      const r = rightVec(t);
      const road = axis === 'x' ? it.xr : it.zr;
      const halfAlong = axis === 'x' ? it.hx : it.hz;
      const halfPerp = axis === 'x' ? it.hz : it.hx;
      // 건너편 도로가 있으면 모서리 곡선(연석)을 지나서, 없으면(T자) 바로 건너편 보도에
      const farArm = { W: 'E', E: 'W', N: 'S', S: 'N' }[a];
      const reach = it.arms[farArm] ? halfAlong + RC + 1 : halfAlong + 1.5;
      const base = { x: it.x + t.x * reach, z: it.z + t.z * reach };
      const pole = { x: base.x + r.x * (halfPerp + 1.5), z: base.z + r.z * (halfPerp + 1.5) };
      const head = { x: base.x + r.x * (road.hw * 0.5), z: base.z + r.z * (road.hw * 0.5) };
      const heading = Math.atan2(t.x, -t.z);
      housings.addBox(M.post, 0.25, 6, 0.25, pole.x, 3, pole.z);
      const armLen = Math.hypot(pole.x - head.x, pole.z - head.z) + 0.3;
      housings.addBox(M.post, 0.12, 0.12, armLen, (pole.x + head.x) / 2, 5.65, (pole.z + head.z) / 2, Math.atan2(pole.x - head.x, pole.z - head.z));
      // 헤드: 진행 방향을 바라보는 운전자 쪽(-t)으로 향함
      housings.addBox(M.dark, 1.32, 0.38, 0.26, head.x, 5.3, head.z, -heading);
      const rr = { x: Math.cos(heading), z: Math.sin(heading) }; // 운전자 기준 오른쪽
      [-0.46, -0.155, 0.155, 0.46].forEach((o, k) => {
        lampList.push({
          inter: it.key, approach: a, k,
          x: head.x + rr.x * o - t.x * 0.14, z: head.z + rr.z * o - t.z * 0.14, heading,
        });
      });
    }
  }
  const inst = new THREE.InstancedMesh(lampGeo, new THREE.MeshBasicMaterial({ color: 0xffffff }), lampList.length);
  const m = new THREE.Matrix4();
  const q = new THREE.Quaternion();
  lampList.forEach((l, i) => {
    // 원판은 +Z를 바라봄 → 운전자 쪽(-t)을 보도록 회전
    q.setFromEuler(new THREE.Euler(0, -l.heading, 0));
    m.compose(new THREE.Vector3(l.x, 5.3, l.z), q, new THREE.Vector3(1, 1, 1));
    inst.setMatrixAt(i, m);
    inst.setColorAt(i, new THREE.Color(0x222222));
  });
  inst.frustumCulled = false;
  root.add(inst);
  housings.build(root, 'signal-housings');
  const ON = [0xff2a2a, 0xffc21a, 0x22ff88, 0x22ff88];
  const OFF = [0x3a0d0d, 0x3a2a08, 0x0b2a18, 0x0b2a18];
  const color = new THREE.Color();
  let lastKey = '';
  return {
    update(controllers) {
      const states = lampList.map((l) => controllers[l.inter].state(l.approach).state);
      const key = states.join();
      if (key === lastKey) return;
      lastKey = key;
      lampList.forEach((l, i) => {
        const st = states[i];
        const on = (l.k === 0 && st === 'red') || (l.k === 1 && st === 'yellow') || (l.k >= 2 && st === 'green');
        inst.setColorAt(i, color.setHex(on ? ON[l.k] : OFF[l.k]));
      });
      inst.instanceColor.needsUpdate = true;
    },
  };
}

function buildTraffic(root, model) {
  // 장식용 차 한 대를 템플릿으로 재질별 인스턴스 메시 생성 (차가 많아도 드로우콜 몇 개)
  const tpl = buildCarModel({ color: 0xffffff, interior: false, lite: true });
  tpl.root.updateMatrixWorld(true);
  const byMat = new Map();
  tpl.root.traverse((o) => {
    if (!o.isMesh || Array.isArray(o.material)) return;
    const geo = (o.geometry.index ? o.geometry.toNonIndexed() : o.geometry.clone()).applyMatrix4(o.matrixWorld);
    for (const n of Object.keys(geo.attributes)) if (!['position', 'normal', 'uv'].includes(n)) geo.deleteAttribute(n);
    if (!geo.attributes.uv) geo.setAttribute('uv', new THREE.Float32BufferAttribute(new Float32Array(geo.attributes.position.count * 2), 2));
    if (!byMat.has(o.material)) byMat.set(o.material, []);
    byMat.get(o.material).push(geo);
  });
  const loops = LOOPS.map((L) => ({ ...L, path: buildLoopPath(model, L.legs) }));
  const cars = [];
  loops.forEach((L, li) => {
    for (let k = 0; k < L.cars; k++) {
      cars.push({
        loop: li, s: (L.path.total / L.cars) * k + randRange(0, 8), v: randRange(6, 9),
        x: 0, z: 0, heading: 0, color: L.colors[k % L.colors.length], waitT: 0, cleared: new Set(), stuck: 0,
        maxV: randRange(10, 12.5),
      });
    }
  });
  const meshes = [];
  const paintMat = tpl.paint;
  for (const [mat, list] of byMat) {
    const geo = mergeGeometries(list, false);
    const im = new THREE.InstancedMesh(geo, mat, cars.length);
    im.frustumCulled = false;
    if (mat === paintMat) cars.forEach((c, i) => im.setColorAt(i, new THREE.Color(c.color)));
    root.add(im);
    meshes.push(im);
  }
  const m = new THREE.Matrix4();
  const q = new THREE.Quaternion();
  const up = new THREE.Vector3(0, 1, 0);
  const pos = new THREE.Vector3();
  const one = new THREE.Vector3(1, 1, 1);

  const place = (c) => {
    const p = sampleLoop(loops[c.loop].path, c.s);
    c.x = p.x; c.z = p.z; c.heading = p.heading; c.onArc = p.arc;
  };
  cars.forEach(place);

  return {
    cars, loops,
    update(dt, player, city, opts) {
      for (const c of cars) {
        const L = loops[c.loop];
        const path = L.path;
        if (c.stuck > 0) { c.stuck -= dt; c.v = 0; place(c); continue; }
        const sNorm = ((c.s % path.total) + path.total) % path.total;
        // 목표 속도: 제한속도, 곡선, 어린이보호구역
        let vT = c.maxV;
        const loc = model.locate(c.x, c.z, c.heading);
        if (loc.type === 'road' && loc.school) vT = Math.min(vT, 7);
        const ahead = sampleLoop(path, c.s + 12);
        if (c.onArc || ahead.arc) vT = Math.min(vT, 5);
        // 정지 이벤트
        for (const e of path.events) {
          let ds = e.s - sNorm;
          if (ds < -5) ds += path.total;
          if (ds > 60 || ds < -5) continue;
          const id = e.s;
          if (c.cleared.has(id)) { if (ds < -3 || ds > 50) c.cleared.delete(id); continue; }
          let mustStop = false;
          if (e.type === 'signal') {
            const st = city.signalOf(e.inter.key, e.approach);
            if (st.state === 'red') mustStop = true;
            else if (st.state === 'yellow' && ds > (c.v * c.v) / 6 + 1) mustStop = true;
            if (!mustStop && ds < 2) c.cleared.add(id);
          } else if (e.type === 'stop' || e.type === 'cross') {
            mustStop = true;
            if (ds < 3 && c.v < 0.3) {
              c.waitT += dt;
              const pedBusy = e.type === 'cross' && city.pedCrossingActive();
              if (c.waitT > 1.3 && !pedBusy) { c.cleared.add(id); c.waitT = 0; mustStop = false; }
            }
          }
          if (mustStop) vT = Math.min(vT, Math.sqrt(Math.max(0, 2 * 3 * (ds - 1.5))));
        }
        // 앞차/플레이어/보행자와의 간격
        const f = { x: Math.sin(c.heading), z: -Math.cos(c.heading) };
        const consider = (x, z, len) => {
          const dx = x - c.x, dz = z - c.z;
          const along = dx * f.x + dz * f.z;
          const lat = -dx * f.z + dz * f.x;
          if (along > 0 && along < 40 && Math.abs(lat) < 2.1) {
            const gap = along - len;
            vT = Math.min(vT, Math.max(0, (gap - 2.5) / 1.3));
          }
        };
        for (const o of cars) if (o !== c) consider(o.x, o.z, 4.7);
        consider(player.x, player.z, 4.7);
        for (const p of city.peds.list) if (p.active) consider(p.x, p.z, 1.5);
        // 가감속
        const acc = vT > c.v ? 1.8 : -6;
        c.v = vT > c.v ? Math.min(vT, c.v + acc * dt) : Math.max(vT, c.v + acc * dt);
        c.v = Math.max(0, c.v);
        c.s += c.v * dt;
        place(c);
        void opts;
      }
      // 화면 반영
      cars.forEach((c, i) => {
        pos.set(c.x, 0, c.z);
        q.setFromAxisAngle(up, -c.heading);
        m.compose(pos, q, one);
        for (const im of meshes) im.setMatrixAt(i, m);
      });
      for (const im of meshes) im.instanceMatrix.needsUpdate = true;
    },
  };
}

function buildPeds(root, model) {
  const N = 22;
  const bodyGeo = new THREE.CylinderGeometry(0.2, 0.17, 0.7, 8);
  bodyGeo.translate(0, 1.05, 0);
  const legGeo = new THREE.CylinderGeometry(0.15, 0.12, 0.72, 6);
  legGeo.translate(0, 0.36, 0);
  const headGeo = new THREE.SphereGeometry(0.15, 10, 8);
  headGeo.translate(0, 1.58, 0);
  const body = new THREE.InstancedMesh(bodyGeo, new THREE.MeshLambertMaterial({ color: 0xffffff }), N);
  const legs = new THREE.InstancedMesh(legGeo, new THREE.MeshLambertMaterial({ color: 0x2c3140 }), N);
  const head = new THREE.InstancedMesh(headGeo, new THREE.MeshLambertMaterial({ color: 0xe8c4a0 }), N);
  for (const im of [body, legs, head]) { im.frustumCulled = false; root.add(im); }
  const shirt = [0xd94f4f, 0x3b7dd8, 0xf2c94c, 0x3fa86b, 0x8a5cd1, 0xf08a3c, 0xeeeeee, 0x333a48];
  const list = [];
  const road = model.byId[SCHOOL.road];
  // 보도를 걷는 사람들
  const walkLines = [];
  for (const b of BLOCKS) {
    if (b.outer) continue;
    walkLines.push({ x0: b.x0 + b.r + 4, x1: b.x1 - b.r - 4, z0: b.z1 - 1.0, z1: b.z1 - 1.0 });
    walkLines.push({ x0: b.x0 + b.r + 4, x1: b.x1 - b.r - 4, z0: b.z0 + 1.0, z1: b.z0 + 1.0 });
    walkLines.push({ x0: b.x0 + 1.0, x1: b.x0 + 1.0, z0: b.z0 + b.r + 4, z1: b.z1 - b.r - 4 });
  }
  for (let i = 0; i < N; i++) {
    const kid = i < 6;
    const p = { active: false, kid, x: 0, z: 0, tx: 0, tz: 0, speed: kid ? 1.0 : 1.3, crossing: false, phase: Math.random() * 6, color: shirt[i % shirt.length], hit: 0 };
    if (!kid && walkLines.length) {
      const L = walkLines[(Math.random() * walkLines.length) | 0];
      const t0 = Math.random(), t1 = Math.random();
      p.ax = L.x0 + (L.x1 - L.x0) * t0; p.az = L.z0 + (L.z1 - L.z0) * t0;
      p.bx = L.x0 + (L.x1 - L.x0) * t1; p.bz = L.z0 + (L.z1 - L.z0) * t1;
      p.x = p.ax; p.z = p.az; p.tx = p.bx; p.tz = p.bz;
      p.active = true;
      p.walker = true;
    }
    list.push(p);
  }
  const col = new THREE.Color();
  list.forEach((p, i) => body.setColorAt(i, col.setHex(p.color)));
  let spawnT = 4;

  const spawnCrossing = () => {
    const p = list.find((q) => q.kid && !q.active);
    if (!p) return;
    const fromWest = Math.random() < 0.5;
    const wx = road.c - road.hw - 1.6, ex = road.c + road.hw + 1.6;
    p.x = fromWest ? wx : ex;
    p.z = SCHOOL.cross + randRange(-1.2, 1.2);
    p.tx = fromWest ? ex : wx;
    p.tz = p.z;
    p.active = true;
    p.crossing = true;
    p.after = 6;
  };

  const m = new THREE.Matrix4();
  const q = new THREE.Quaternion();
  const up = new THREE.Vector3(0, 1, 0);
  const hidden = new THREE.Matrix4().makeScale(0, 0, 0);
  return {
    list,
    spawnCrossing,
    update(dt, car, traffic, opts) {
      spawnT -= dt;
      if (spawnT <= 0) {
        // 차가 횡단보도 바로 앞에 있을 때 갑자기 뛰어들지 않게
        const near = Math.hypot(car.x - road.c, car.z - SCHOOL.cross) < 16
          || traffic.cars.some((c) => Math.hypot(c.x - road.c, c.z - SCHOOL.cross) < 10);
        if (near) spawnT = 2; else { spawnT = randRange(10, 20); spawnCrossing(); }
      }
      list.forEach((p, i) => {
        if (!p.active) { body.setMatrixAt(i, hidden); legs.setMatrixAt(i, hidden); head.setMatrixAt(i, hidden); return; }
        if (p.hit > 0) { p.hit -= dt; }
        const dx = p.tx - p.x, dz = p.tz - p.z;
        const dist = Math.hypot(dx, dz);
        if (dist < 0.1) {
          if (p.walker) { [p.tx, p.tz, p.ax, p.az, p.bx, p.bz] = p.tx === p.bx ? [p.ax, p.az, p.ax, p.az, p.bx, p.bz] : [p.bx, p.bz, p.ax, p.az, p.bx, p.bz]; }
          else if (p.crossing) {
            // 건넌 뒤 보도를 따라 조금 걸어가다 사라짐
            p.crossing = false;
            p.tz = p.z + (Math.random() < 0.5 ? -8 : 8);
          } else { p.active = false; }
        } else {
          const step = Math.min(dist, p.speed * dt);
          p.x += (dx / dist) * step;
          p.z += (dz / dist) * step;
          p.h = Math.atan2(dx, -dz);
        }
        p.phase += dt * 7;
        const bob = Math.abs(Math.sin(p.phase)) * 0.04;
        const s = p.kid ? 0.72 : 1;
        q.setFromAxisAngle(up, -(p.h || 0));
        const y = model.onPavement(p.x, p.z) ? 0 : 0.15;
        m.compose(new THREE.Vector3(p.x, y + bob, p.z), q, new THREE.Vector3(s, s, s));
        body.setMatrixAt(i, m);
        legs.setMatrixAt(i, m);
        head.setMatrixAt(i, m);
      });
      for (const im of [body, legs, head]) im.instanceMatrix.needsUpdate = true;
      void car; void traffic; void opts;
    },
  };
}
