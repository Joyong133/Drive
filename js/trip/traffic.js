// 다른 차들: 같은 방향(차간거리 유지·추월·차로 변경)과 반대 방향. 인스턴싱으로 몇 번의 드로우콜에 그림
import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/BufferGeometryUtils.js';
import { LANE_W, bankOf } from './route.js';
import { MIRROR_LAYER } from './terrain.js';

const PALETTE = [
  [0xf2f2f0, 30], [0xd8dadc, 8], [0x9da3a8, 14], [0x5c6166, 10], [0x16181b, 18], [0x1d2d4f, 6],
  [0x8a1b1f, 4], [0x3c4a3a, 2], [0xc9b99a, 3], [0x2a5d9a, 3], [0x6b2a2a, 2],
];
function pickColor(r) {
  let tot = 0;
  for (const [, w] of PALETTE) tot += w;
  let x = r * tot;
  for (const [c, w] of PALETTE) { if ((x -= w) <= 0) return c; }
  return 0xffffff;
}

// ───────── 차 모양 (몸체: 흰색 → 인스턴스 색, 세부: 고정 색)
function colorize(geo, hex) {
  const g = geo.index ? geo.toNonIndexed() : geo;
  const c = new THREE.Color(hex);
  const n = g.attributes.position.count;
  const arr = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) { arr[i * 3] = c.r; arr[i * 3 + 1] = c.g; arr[i * 3 + 2] = c.b; }
  g.setAttribute('color', new THREE.BufferAttribute(arr, 3));
  for (const k of Object.keys(g.attributes)) if (!['position', 'normal', 'color'].includes(k)) g.deleteAttribute(k);
  return g;
}
function box(w, h, l, x, y, z, hex) {
  const g = new THREE.BoxGeometry(w, h, l);
  g.translate(x, y, z);
  return colorize(g, hex);
}
// 옆모습(앞 = -z, 위 = y)을 폭 방향으로 돌출
function side(points, width, hex, bevel = 0.05) {
  const s = new THREE.Shape();
  points.forEach(([z, y], i) => (i ? s.lineTo(-z, y) : s.moveTo(-z, y)));
  const g = new THREE.ExtrudeGeometry(s, { depth: width - bevel * 2, bevelEnabled: bevel > 0, bevelThickness: bevel, bevelSize: bevel, bevelSegments: 1, curveSegments: 4 });
  g.translate(0, 0, -(width - bevel * 2) / 2);
  g.rotateY(Math.PI / 2);
  return colorize(g, hex);
}
function wheels(geoList, track, wb, r, w, extra = []) {
  const t = new THREE.CylinderGeometry(r, r, w, 10);
  t.rotateZ(Math.PI / 2);
  for (const z of [-wb / 2, wb / 2, ...extra]) {
    for (const x of [-track / 2, track / 2]) {
      const g = t.clone();
      g.translate(x, r, z);
      geoList.push(colorize(g, 0x151517));
    }
  }
}

const GLASS = 0x10161e, DARK = 0x1c1e22, TAIL = 0x8a0d14, HEAD = 0xe8ecf0, PLATE = 0xf0f2f4, CHROME = 0xb5bbc2;

function carGeo({ L = 4.8, W = 1.85, H = 1.45, hood = 0.95, kind = 'sedan' }) {
  const body = [], det = [];
  const hz = L / 2;
  const belt = kind === 'suv' ? 1.05 : 0.86;
  body.push(side([[hz, 0.32], [hz + 0.03, 0.62], [hz - 0.1, belt - 0.05], [hz - hood, belt + 0.02], [-hz + 0.35, belt + 0.06], [-hz, belt - 0.05], [-hz - 0.02, 0.5], [-hz + 0.1, 0.3]], W, 0xffffff));
  // 유리 실내부
  const roofF = hz - hood - (kind === 'suv' ? 0.45 : 0.6), roofB = kind === 'hatch' || kind === 'suv' ? -hz + 0.25 : -hz + 0.85;
  det.push(side([[hz - hood, belt + 0.01], [roofF, H], [roofB, H - (kind === 'sedan' ? 0.03 : 0)], [kind === 'sedan' ? -hz + 0.3 : -hz + 0.12, belt + 0.04]], W - 0.16, GLASS, 0.03));
  body.push(box(W - 0.22, 0.05, roofF - roofB - 0.1, 0, H - 0.01, (roofF + roofB) / 2, 0xffffff));
  det.push(box(W * 0.8, 0.12, 0.05, 0, belt - 0.12, -hz + 0.01, TAIL));
  det.push(box(W * 0.7, 0.07, 0.05, 0, 0.66, hz + 0.01, HEAD));
  det.push(box(W * 0.6, 0.16, 0.05, 0, 0.45, hz + 0.02, DARK));
  det.push(box(0.5, 0.12, 0.03, 0, 0.5, -hz - 0.01, PLATE));
  det.push(box(W + 0.02, 0.18, L * 0.9, 0, 0.35, 0, DARK));
  wheels(det, W - 0.2, L * 0.6, 0.34, 0.24);
  return { body: mergeGeometries(body), det: mergeGeometries(det), L };
}

function porterGeo() {
  // 1톤 소형 트럭 (짧은 캡 + 적재함)
  const body = [], det = [];
  body.push(box(1.74, 1.5, 1.55, 0, 1.15, 1.7, 0xffffff));
  det.push(box(1.6, 0.6, 0.05, 0, 1.55, 2.48, GLASS));
  det.push(box(1.76, 0.5, 0.02, 0, 1.55, 1.7, GLASS));
  det.push(box(1.76, 0.12, 3.0, 0, 0.62, -0.7, 0x6b6f75));
  det.push(box(1.76, 0.45, 0.06, 0, 0.92, -2.2, 0x9aa0a6));
  for (const x of [-0.86, 0.86]) det.push(box(0.05, 0.45, 3.0, x, 0.92, -0.7, 0x9aa0a6));
  det.push(box(1.0, 0.1, 0.05, 0, 0.75, 2.47, HEAD));
  det.push(box(1.4, 0.1, 0.05, 0, 0.7, -2.23, TAIL));
  wheels(det, 1.5, 2.6, 0.32, 0.2, []);
  return { body: mergeGeometries(body), det: mergeGeometries(det), L: 5.1 };
}

function truckGeo(L = 8.5) {
  // 5톤 화물차 (캡 + 탑차)
  const body = [], det = [];
  body.push(box(2.3, 2.1, 1.9, 0, 1.75, L / 2 - 0.95, 0xffffff));
  det.push(box(2.1, 0.8, 0.05, 0, 2.2, L / 2 + 0.01, GLASS));
  det.push(box(2.42, 2.6, L - 2.2, 0, 2.15, -1.05, 0xdfe2e4));
  det.push(box(2.4, 0.4, L, 0, 0.75, 0, DARK));
  det.push(box(1.6, 0.12, 0.05, 0, 0.9, L / 2 + 0.02, HEAD));
  det.push(box(2.0, 0.15, 0.05, 0, 0.9, -L / 2 - 0.01, TAIL));
  wheels(det, 2.0, L * 0.55, 0.5, 0.35, [-L * 0.275 - 1.3]);
  return { body: mergeGeometries(body), det: mergeGeometries(det), L };
}

function semiGeo() {
  const L = 16.5;
  const body = [], det = [];
  body.push(box(2.45, 2.6, 2.4, 0, 2.0, L / 2 - 1.2, 0xffffff));
  det.push(box(2.2, 0.9, 0.05, 0, 2.5, L / 2 + 0.01, GLASS));
  det.push(box(2.5, 2.7, 12.5, 0, 2.65, -1.8, 0xc9c2b2));
  det.push(box(2.4, 0.35, L, 0, 0.85, 0, DARK));
  det.push(box(2.0, 0.15, 0.05, 0, 1.0, -L / 2 - 0.01, TAIL));
  wheels(det, 2.0, 3.6, 0.52, 0.4, [L / 2 - 4.6, -L / 2 + 2.0, -L / 2 + 3.3, -L / 2 + 4.6]);
  return { body: mergeGeometries(body), det: mergeGeometries(det), L };
}

function busGeo() {
  // 고속버스 (우등/프리미엄)
  const L = 12.2;
  const body = [], det = [];
  body.push(box(2.49, 2.4, L, 0, 1.95, 0, 0xffffff));
  det.push(box(2.51, 0.95, L - 2.2, 0, 2.45, -0.6, GLASS));
  det.push(box(2.3, 1.5, 0.05, 0, 2.2, L / 2 + 0.01, GLASS));
  det.push(box(2.51, 0.18, L - 0.4, 0, 1.6, 0, 0xc8a24a));
  det.push(box(2.4, 0.5, L, 0, 0.6, 0, DARK));
  det.push(box(2.0, 0.12, 0.05, 0, 0.75, L / 2 + 0.02, HEAD));
  det.push(box(2.0, 0.2, 0.05, 0, 1.0, -L / 2 - 0.01, TAIL));
  wheels(det, 2.05, 6.2, 0.5, 0.35, [-3.1 - 1.3]);
  return { body: mergeGeometries(body), det: mergeGeometries(det), L };
}

const TYPES = [
  { name: 'sedan', make: () => carGeo({ kind: 'sedan' }), w: 34, vDes: [100, 122], truck: false },
  { name: 'suv', make: () => carGeo({ kind: 'suv', H: 1.72, L: 4.7, W: 1.9, hood: 1.0 }), w: 26, vDes: [98, 120] },
  { name: 'hatch', make: () => carGeo({ kind: 'hatch', L: 4.1, W: 1.78, H: 1.5, hood: 0.85 }), w: 10, vDes: [95, 115] },
  { name: 'porter', make: porterGeo, w: 9, vDes: [88, 100], truck: true, colors: [0x2b4f9e, 0xf2f2f0, 0x2b4f9e] },
  { name: 'truck', make: () => truckGeo(8.5), w: 8, vDes: [82, 90], truck: true, colors: [0xf2f2f0, 0x2b4f9e, 0xd8dadc, 0x7a1f1f] },
  { name: 'semi', make: semiGeo, w: 5, vDes: [80, 88], truck: true, colors: [0xf2f2f0, 0x3b6db0, 0xc0202a] },
  { name: 'bus', make: busGeo, w: 8, vDes: [98, 105], bus: true, colors: [0xf4f4f2, 0x1d3f8a, 0x173a2f] },
];

const MAX_PER_TYPE = 64;

export class Traffic {
  constructor({ scene, routes, quality = 'mid' }) {
    this.routes = routes;
    this.group = new THREE.Group();
    this.group.name = 'traffic';
    scene.add(this.group);
    const bodyMat = new THREE.MeshLambertMaterial({ vertexColors: true });
    const detMat = new THREE.MeshLambertMaterial({ vertexColors: true });
    this.types = TYPES.map((t) => {
      const g = t.make();
      const body = new THREE.InstancedMesh(g.body, bodyMat, MAX_PER_TYPE);
      const det = new THREE.InstancedMesh(g.det, detMat, MAX_PER_TYPE);
      for (const m of [body, det]) {
        m.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
        m.frustumCulled = false;
        m.count = 0;
        m.layers.enable(MIRROR_LAYER);
        this.group.add(m);
      }
      body.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(MAX_PER_TYPE * 3), 3);
      return { ...t, L: g.L, body, det };
    });
    this.totalW = TYPES.reduce((a, t) => a + t.w, 0);
    this.density = { low: 9, mid: 14, high: 18 }[quality] || 14; // 차로·km당이 아니라 방향·km당 대수
    this.same = [];
    this.opp = [];
    this.seed = 12345;
    this.events = [];
    this.m = new THREE.Matrix4();
    this.q = new THREE.Quaternion();
    this.e = new THREE.Euler(0, 0, 0, 'YXZ');
    this.v3 = new THREE.Vector3();
    this.one = new THREE.Vector3(1, 1, 1);
    this.col = new THREE.Color();
    this.tmp = {};
  }

  rand() { this.seed = (this.seed * 16807) % 2147483647; return this.seed / 2147483647; }

  makeVehicle(busZone) {
    let x = this.rand() * this.totalW;
    let ti = 0;
    for (; ti < TYPES.length - 1; ti++) if ((x -= TYPES[ti].w) <= 0) break;
    const t = TYPES[ti];
    const vd = t.vDes[0] + (t.vDes[1] - t.vDes[0]) * this.rand();
    const col = t.colors ? t.colors[Math.floor(this.rand() * t.colors.length)] : pickColor(this.rand());
    return { type: ti, L: TYPES[ti].L, vDes: vd / 3.6, v: vd / 3.6, lane: 1, target: 1, color: col, s: 0, truck: !!t.truck, bus: !!t.bus, think: this.rand() * 3, passed: 0, busZone };
  }

  busZone(route, s) {
    const d = route.name === 'SB' ? s : route.length - s;
    return d < 46000;
  }

  // 차로 고르기: 트럭은 오른쪽, 승용차는 아무 데나, 1차로 버스전용 구간은 버스만
  pickLane(route, s, veh) {
    const n = route.lanesAt(s);
    const bz = this.busZone(route, s);
    if (veh.bus && bz) return 0;
    const lo = bz ? 1 : 0;
    if (veh.truck) return Math.max(lo, n - 1 - Math.floor(this.rand() * Math.min(2, n - lo)));
    return lo + Math.floor(this.rand() * (n - lo));
  }

  reset(route, s, plan) {
    this.route = route;
    this.other = this.routes[route.name === 'SB' ? 'NB' : 'SB'];
    this.same = [];
    this.opp = [];
    const lanes = route.lanesAt(s);
    const nSame = Math.round(this.density * 2.7 * (lanes / 3));
    for (let k = 0; k < nSame; k++) {
      const v = this.makeVehicle();
      v.s = s - 700 + this.rand() * 2700;
      if (Math.abs(v.s - s) < 40) v.s += 80;
      v.lane = v.target = this.pickLane(route, v.s, v);
      this.same.push(v);
    }
    this.spaceOut(this.same);
    const io = route.other[route.idx(s)[0]];
    const so = io * this.other.spacing;
    for (let k = 0; k < Math.round(this.density * 2.7 * (lanes / 3)); k++) {
      const v = this.makeVehicle();
      v.s = so - 2000 + this.rand() * 2700;
      v.lane = v.target = this.pickLane(this.other, v.s, v);
      this.opp.push(v);
    }
    this.spaceOut(this.opp);
    void plan;
  }

  spaceOut(list) {
    list.sort((a, b) => a.s - b.s);
    for (let i = 1; i < list.length; i++) {
      for (let j = i - 1; j >= Math.max(0, i - 8); j--) {
        const a = list[j], b = list[i];
        if (Math.round(a.lane) === Math.round(b.lane) && b.s - a.s < 25) b.s = a.s + 25 + this.rand() * 15;
      }
    }
  }

  // 같은 차로 앞차 찾기
  leader(list, v, lane, me) {
    let best = null, bd = 1e9;
    for (const o of list) {
      if (o === v || Math.abs(o.lane - lane) > 0.65) continue;
      const d = o.s - v.s;
      if (d > 0 && d < bd) { bd = d; best = o; }
    }
    if (me && Math.abs(me.lane - lane) < 0.75) {
      const d = me.s - v.s;
      if (d > 0 && d < bd) { bd = d; best = me; }
    }
    return best ? { o: best, gap: bd - (best.L || 4.7) / 2 - v.L / 2 } : null;
  }

  laneFree(list, v, lane, me, back = 22, front = 35) {
    for (const o of list) {
      if (o === v || Math.abs(o.lane - lane) > 0.8) continue;
      const d = o.s - v.s;
      if (d > -back && d < front) return false;
    }
    if (me && Math.abs(me.lane - lane) < 0.9 && me.s - v.s > -back - 10 && me.s - v.s < front + 30) return false;
    return true;
  }

  // dt: 시뮬레이션 시간, s: 내 차 거리, vMe: 내 속도(m/s), latMe: 내 횡위치
  update(dt, s, vMe, latMe) {
    if (!this.route) return;
    const R = this.route;
    dt = Math.min(dt, 0.25);
    const laneOf = (lat, ss) => (lat + R.width[R.idx(ss)[0]] / 2) / LANE_W - 0.5;
    const me = { s, lane: laneOf(latMe, s), v: vMe, L: 4.72 };
    const list = this.same;
    for (const v of list) {
      const n = R.lanesAt(v.s);
      const bz = this.busZone(R, v.s);
      const lo = bz && !v.bus ? 1 : 0;
      // 차로 감소: 바깥 차로가 없어지면 안쪽으로
      if (v.target > n - 1) v.target = n - 1;
      if (v.target < lo) v.target = lo;
      v.think -= dt;
      const ld = this.leader(list, v, v.target, me);
      if (v.think <= 0) {
        v.think = 1.5 + this.rand() * 2.5;
        const blocked = ld && ld.gap < 90 && ld.o.v < v.vDes - 2.5;
        if (blocked) {
          const l = v.target - 1, r = v.target + 1;
          if (l >= lo && !v.truck && this.laneFree(list, v, l, me)) v.target = l;
          else if (r <= n - 1 && this.laneFree(list, v, r, me)) v.target = r;
        } else if (v.target < n - 1 && (v.truck || this.rand() < 0.25) && this.laneFree(list, v, v.target + 1, me, 25, 70)) {
          v.target += 1; // 오른쪽으로 복귀
        }
        // 내 앞을 막는 느린 차는 비켜 줌
        const dMe = v.s - s;
        if (dMe > 0 && dMe < 160 && Math.abs(v.lane - me.lane) < 0.8 && v.v < vMe + 1.5) {
          for (const c of [v.target + 1, v.target - 1]) {
            if (c >= lo && c <= n - 1 && Math.abs(c - me.lane) > 0.8 && this.laneFree(list, v, c, null, 15, 30)) { v.target = c; break; }
          }
        }
      }
      // 속도 (IDM)
      const L0 = this.leader(list, v, v.lane, me);
      let acc = 1.1 * (1 - (v.v / v.vDes) ** 4);
      if (L0) {
        const dv = v.v - L0.o.v;
        const sStar = 6 + v.v * 1.3 + (v.v * dv) / (2 * Math.sqrt(1.1 * 2.2));
        acc -= 1.1 * (Math.max(sStar, 0) / Math.max(L0.gap, 0.5)) ** 2;
      }
      v.v = Math.max(0, v.v + Math.max(acc, -6) * dt);
      // 내 앞 가까이 있는데 못 비키면 내 속도에 맞춤 (안 부딪히게)
      const dMe = v.s - s;
      if (dMe > 0 && dMe < 60 && Math.abs(v.lane - me.lane) < 0.8) v.v = Math.max(v.v, vMe + 0.5);
      v.lane += Math.sign(v.target - v.lane) * Math.min(Math.abs(v.target - v.lane), dt * 0.32);
      const before = v.s - s;
      v.s += v.v * dt;
      const after = v.s - s;
      // 지나칠 때 소리
      if (Math.sign(before) !== Math.sign(after)) {
        const latGap = Math.abs(v.lane - me.lane) * LANE_W;
        if (latGap < 7) this.events.push({ kind: 'pass', big: v.truck || v.bus, rel: Math.abs(v.v - vMe), side: v.lane < me.lane ? -1 : 1 });
      }
    }
    // 창 밖으로 나간 차는 앞/뒤에서 다시
    for (const v of list) {
      const d = v.s - s;
      if (d > 2100 || d < -750 || v.s > R.length - 20) {
        const nv = this.makeVehicle();
        Object.assign(v, nv);
        const ahead = v.vDes < vMe || this.rand() < 0.45;
        v.s = ahead ? s + 1600 + this.rand() * 450 : s - 700 + this.rand() * 40;
        if (ahead) v.v = Math.min(v.vDes, vMe * 0.95);
        if (v.s > R.length - 30) v.s = s - 650;
        v.lane = v.target = this.pickLane(R, v.s, v);
        if (!this.laneFree(list, v, v.lane, me, 30, 30)) v.s += ahead ? 60 : -60;
      }
    }
    // 반대 방향 (단순: 같은 차로 앞차와 거리만 유지)
    const O = this.other;
    const io = R.other[R.idx(s)[0]];
    const so = io * O.spacing;
    for (const v of this.opp) {
      const ld = this.leader(this.opp, v, v.lane, null);
      let target = v.vDes;
      if (ld && ld.gap < 50) target = Math.min(target, ld.o.v);
      v.v += Math.sign(target - v.v) * Math.min(Math.abs(target - v.v), 2 * dt);
      const before = v.s - so;
      v.s += v.v * dt;
      const after = v.s - so;
      if (Math.sign(before) !== Math.sign(after) && O.sep[O.idx(v.s)[0]] < 30) this.events.push({ kind: 'oncoming', big: v.truck || v.bus, side: -1 });
      if (v.s - so > 750 || v.s - so < -2200 || v.s > O.length - 20) {
        Object.assign(v, this.makeVehicle());
        v.s = so - 2000 - this.rand() * 150;
        if (v.s < 20) v.s = so + 700;
        v.lane = v.target = this.pickLane(O, v.s, v);
        const n = O.lanesAt(v.s);
        if (v.lane > n - 1) v.lane = v.target = n - 1;
      }
    }
  }

  // 그리기: origin(카메라 근처) 기준 상대좌표로 행렬을 채움 (큰 좌표 떨림 방지)
  render(origin) {
    const counts = this.types.map(() => 0);
    for (const t of this.types) { t.body.position.copy(origin); t.det.position.copy(origin); }
    const put = (route, v) => {
      const t = this.types[v.type];
      const k = counts[v.type];
      if (k >= MAX_PER_TYPE) return;
      const f = route.sample(v.s, this.tmp);
      const lanes = route.lanesAt(v.s);
      const lane = Math.min(v.lane, lanes - 0.5);
      const lat = -f.width / 2 + LANE_W * (lane + 0.5);
      const bank = bankOf(f.curv);
      const x = f.x - f.tz * lat - origin.x, z = f.z + f.tx * lat - origin.z, y = f.y - bank * lat - origin.y;
      const dl = (v.target - v.lane) * 0.04;
      const yaw = Math.atan2(-(f.tx - f.tz * dl), -(f.tz + f.tx * dl));
      this.e.set(Math.atan(f.grade), yaw, -Math.atan(bank));
      this.q.setFromEuler(this.e);
      this.v3.set(x, y, z);
      this.m.compose(this.v3, this.q, this.one);
      t.body.setMatrixAt(k, this.m);
      t.det.setMatrixAt(k, this.m);
      this.col.setHex(v.color);
      t.body.setColorAt(k, this.col);
      counts[v.type] = k + 1;
    };
    for (const v of this.same) put(this.route, v);
    for (const v of this.opp) put(this.other, v);
    this.types.forEach((t, i) => {
      t.body.count = t.det.count = counts[i];
      t.body.instanceMatrix.needsUpdate = true;
      t.det.instanceMatrix.needsUpdate = true;
      if (t.body.instanceColor) t.body.instanceColor.needsUpdate = true;
    });
  }
}
