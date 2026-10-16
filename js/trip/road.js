// 고속도로 3D: 포장(차선은 셰이더로), 중앙분리대, 가드레일, 방음벽, 가로등, 교량, 터널, 램프, 고가도로
// 경로를 400 m 덩어리로 나눠 카메라 앞뒤만 만들고, 지나간 것은 버림
import * as THREE from 'three';
import { Builder } from './mesher.js';
import { LANE_W, F_BRIDGE, F_TUNNEL, F_WALL_R, F_URBAN, bankOf } from './route.js';
import { buildChunkSigns } from './signs.js';
import { MIRROR_LAYER } from './terrain.js';

export const CHUNK_PTS = 40; // 400 m
const AHEAD = 3200, BEHIND = 700;

// ───────── 재질
const ASPHALT_VERT = /* glsl */`
  #include <common>
  #include <fog_pars_vertex>
  attribute vec3 aex;   // x: 차로 영역 폭(m), y: 터널(1), z: 버스전용차로(1) / 램프(2)
  varying vec2 vUv;
  varying vec3 vEx;
  varying vec3 vN;
  void main() {
    vUv = uv;
    vEx = aex;
    vN = normal;
    vec4 mvPosition = modelViewMatrix * vec4(position, 1.0);
    gl_Position = projectionMatrix * mvPosition;
    #include <fog_vertex>
  }
`;

const ASPHALT_FRAG = /* glsl */`
  #include <common>
  #include <fog_pars_fragment>
  uniform vec3 sunDir;
  uniform vec3 sunCol;
  uniform vec3 ambCol;
  uniform vec3 tunCol;
  varying vec2 vUv;
  varying vec3 vEx;
  varying vec3 vN;

  float hash2(vec2 p) { p = mod(p, 4096.0); return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
  float vnoise(vec2 p) {
    vec2 i = floor(p), f = fract(p);
    f = f * f * (3.0 - 2.0 * f);
    return mix(mix(hash2(i), hash2(i + vec2(1.0, 0.0)), f.x), mix(hash2(i + vec2(0.0, 1.0)), hash2(i + vec2(1.0, 1.0)), f.x), f.y);
  }
  // 픽셀 크기(fw)로 걸러 낸 선의 덮임 정도 → 멀리서도 계단·깜빡임 없음
  float lineCov(float d, float hw, float fw) {
    fw = max(fw, 1e-4);
    return clamp((min(d + fw * 0.5, hw) - max(d - fw * 0.5, -hw)) / fw, 0.0, 1.0);
  }
  float dashCov(float v, float period, float len, float fw) {
    float m = mod(v, period) - len * 0.5;
    float c = lineCov(m, len * 0.5, fw);
    return mix(c, len / period, clamp(fw / period * 2.0 - 0.5, 0.0, 1.0));
  }

  void main() {
    float u = vUv.x;     // 왼쪽 차로 끝에서 오른쪽으로 (m)
    float v = vUv.y;     // 진행 방향 거리 (m)
    float W = vEx.x;
    float fu = fwidth(u), fv = fwidth(v);
    // 아스팔트: 미세한 얼룩 + 구간별 재포장 차이 + 바퀴 자국
    float n = vnoise(vec2(u * 1.7, v * 0.35)) * 0.6 + vnoise(vec2(u * 9.0, v * 4.0)) * 0.4;
    float rpatch = hash2(vec2(floor(v / 160.0), 7.0));
    vec3 col = vec3(0.088, 0.09, 0.094) * (0.86 + 0.28 * n) * (0.9 + 0.2 * rpatch);
    float inLane = step(0.0, u) * step(u, W);
    float lc = (floor(u / 3.6) + 0.5) * 3.6;
    float track = lineCov(abs(u - lc) - 0.85, 0.32, fu) * inLane;
    col *= 1.0 - 0.13 * track;
    col = mix(col * 1.18, col, inLane); // 길어깨는 조금 밝게
    // 차선
    vec3 white = vec3(0.78, 0.78, 0.76), yellow = vec3(0.78, 0.5, 0.05), blue = vec3(0.05, 0.18, 0.6);
    float ramp = step(1.5, vEx.z);
    float left = lineCov(u - 0.1, 0.1, fu);
    col = mix(col, ramp > 0.5 ? white : yellow, left * 0.92);
    float right = lineCov(u - (W - 0.1), 0.1, fu);
    col = mix(col, white, right * 0.92);
    float k = floor(u / 3.6 + 0.5);
    if (k >= 1.0 && k * 3.6 < W - 1.2) {
      float d = u - k * 3.6;
      float bus = step(0.5, vEx.z) * (1.0 - ramp) * step(k, 1.5);
      if (bus > 0.5) {
        float dd = dashCov(v, 20.0, 10.0, fv);
        float c = max(lineCov(d - 0.17, 0.075, fu), lineCov(d + 0.17, 0.075, fu)) * dd;
        col = mix(col, blue, c * 0.9);
      } else {
        float c = lineCov(d, 0.075, fu) * dashCov(v, 20.0, 10.0, fv);
        col = mix(col, white, c * 0.9);
      }
    }
    vec3 nn = normalize(vN);
    vec3 light;
    if (vEx.y > 0.5) {
      float lamp = 0.8 + 0.2 * smoothstep(0.0, 1.0, abs(mod(v, 6.0) - 3.0) / 3.0);
      light = tunCol * lamp;
    } else {
      light = ambCol + sunCol * max(dot(nn, sunDir), 0.0);
    }
    gl_FragColor = vec4(col * light, 1.0);
    #include <colorspace_fragment>
    #include <fog_fragment>
  }
`;

export function makeRoadMaterials(shared) {
  const asphalt = new THREE.ShaderMaterial({
    vertexShader: ASPHALT_VERT,
    fragmentShader: ASPHALT_FRAG,
    fog: true,
    uniforms: {
      ...THREE.UniformsUtils.clone(THREE.UniformsLib.fog),
      sunDir: shared.sunDir, sunCol: shared.sunCol, ambCol: shared.ambCol,
      tunCol: { value: new THREE.Color(0.95, 0.85, 0.7) },
    },
    polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -2,
  });
  return {
    asphalt,
    solid: new THREE.MeshLambertMaterial({ vertexColors: true, side: THREE.DoubleSide }),
    glow: new THREE.MeshBasicMaterial({ vertexColors: true, side: THREE.DoubleSide }),
    tunnel: new THREE.MeshBasicMaterial({ vertexColors: true, side: THREE.DoubleSide }),
  };
}

// 색 (sRGB → 선형으로 바꿔 정점 색에 넣음)
const C = (hex) => { const c = new THREE.Color(hex); return [c.r, c.g, c.b]; };
const COL = {
  concrete: C(0xb9b6ad), concreteDark: C(0x8c8a84), deck: C(0x9f9c95), steel: C(0xc4c8cc), post: C(0x9aa0a6),
  grass: C(0x56603a), gravel: C(0x6f6a5e), lip: C(0x4b4a47), wallPanel: C(0x7f9a92), wallFrame: C(0x5c6b70),
  wallClear: C(0xa9c4c4), pole: C(0x8d939a), lampHead: C(0x4a4f55), lampLED: [1, 1, 1], lampSodium: [1.0, 0.62, 0.25],
  tunWall: C(0xd8d2c2), tunTile: C(0x5a6470), tunCeil: C(0x3c3c3a), rail: C(0x6d5e52), green: C(0x2f6b43),
  delin: [1.0, 0.75, 0.1],
};

// ───────── 한 덩어리 만들기
function frameAt(route, i, extraBank = true) {
  const p = route.xyz;
  return {
    x: p[i * 3], z: p[i * 3 + 1], y: p[i * 3 + 2],
    rx: -route.tz[i], rz: route.tx[i],
    tx: route.tx[i], tz: route.tz[i],
    bank: extraBank ? bankOf(route.curv[i]) : 0,
    s: i * route.spacing, i,
  };
}

function hash(i) { const x = Math.sin(i * 127.1 + 311.7) * 43758.5453; return x - Math.floor(x); }

export class RoadSystem {
  constructor({ scene, routes, meta, ramps, materials, signs }) {
    this.scene = scene;
    this.routes = routes;
    this.meta = meta;
    this.ramps = ramps;
    this.mat = materials;
    this.signs = signs;
    this.group = new THREE.Group();
    this.group.name = 'roads';
    scene.add(this.group);
    this.chunks = new Map(); // `${route}:${c}` → group
    this.queue = [];
    // 반대 방향 차로와 겹치는 고가는 한 번만 (SB 쪽에서 양쪽을 덮도록 만듦)
    const sb = meta.routes.SB.overpasses, nb = meta.routes.NB.overpasses;
    this.overpasses = {
      SB: sb,
      NB: nb.filter((q) => !sb.some((o) => Math.hypot(o.x - q.x, o.z - q.z) < 60)),
    };
    this.rampsBy = { SB: [], NB: [] };
    for (const r of ramps) this.rampsBy[r.dir].push(r);
  }

  // 지금 달리는 경로의 위치에서 필요한 덩어리 목록
  wanted(route, s) {
    const out = [];
    const c0 = Math.max(0, Math.floor((s - BEHIND) / (CHUNK_PTS * route.spacing)));
    const c1 = Math.floor(Math.min(route.length, s + AHEAD) / (CHUNK_PTS * route.spacing));
    for (let c = c0; c <= c1; c++) out.push([route, c]);
    // 반대 방향
    const other = this.routes[route.name === 'SB' ? 'NB' : 'SB'];
    const ia = route.other[route.idx(s - BEHIND)[0]], ib = route.other[route.idx(s + AHEAD)[0]];
    const o0 = Math.floor(Math.min(ia, ib) / CHUNK_PTS), o1 = Math.floor(Math.max(ia, ib) / CHUNK_PTS);
    for (let c = o0; c <= o1; c++) out.push([other, c]);
    return out;
  }

  update(route, s, budgetMs = 6) {
    const want = this.wanted(route, s);
    const keys = new Set();
    // 가까운 것부터
    want.sort((a, b) => Math.abs(a[1] * CHUNK_PTS * a[0].spacing - (a[0] === route ? s : 0)) - Math.abs(b[1] * CHUNK_PTS * b[0].spacing - (b[0] === route ? s : 0)));
    const t0 = performance.now();
    let built = 0;
    for (const [rt, c] of want) {
      const key = `${rt.name}:${c}`;
      keys.add(key);
      if (!this.chunks.has(key) && (built === 0 || performance.now() - t0 < budgetMs)) {
        this.chunks.set(key, this.buildChunk(rt, c));
        built++;
      }
    }
    for (const [key, g] of this.chunks) {
      if (!keys.has(key)) {
        this.group.remove(g);
        g.traverse((o) => {
          if (o.geometry) o.geometry.dispose();
          if (o.material && o.material.map && o.userData.ownMap) { o.material.map.dispose(); o.material.dispose(); }
        });
        this.chunks.delete(key);
      }
    }
    return built;
  }

  // 아직 못 만든 덩어리 수 (시작 로딩용)
  missing(route, s) {
    let n = 0;
    for (const [rt, c] of this.wanted(route, s)) if (!this.chunks.has(`${rt.name}:${c}`)) n++;
    return n;
  }

  buildChunk(rt, c) {
    const g = new THREE.Group();
    g.name = `${rt.name}:${c}`;
    const i0 = c * CHUNK_PTS, i1 = Math.min((c + 1) * CHUNK_PTS, rt.n - 1);
    if (i1 <= i0) { this.group.add(g); return g; }
    const mid = frameAt(rt, Math.floor((i0 + i1) / 2));
    const origin = new THREE.Vector3(mid.x, mid.y, mid.z);
    const B = new Builder(origin);
    const frames = [];
    for (let i = i0; i <= i1; i++) frames.push(frameAt(rt, i));
    this.buildSurface(B, rt, frames);
    this.buildSides(B, rt, frames);
    this.buildStructures(B, rt, frames);
    for (const rp of this.rampsBy[rt.name]) {
      if (rp.s >= i0 * rt.spacing && rp.s < i1 * rt.spacing) this.buildRamp(B, rt, rp);
    }
    for (const ov of this.overpasses[rt.name]) {
      if (ov.s >= i0 * rt.spacing && ov.s < i1 * rt.spacing) this.buildOverpass(B, rt, ov);
    }
    B.build(g, this.mat);
    buildChunkSigns(g, this.signs, rt, i0 * rt.spacing, i1 * rt.spacing, origin);
    g.traverse((o) => { if (o.isMesh) o.layers.enable(MIRROR_LAYER); });
    this.group.add(g);
    return g;
  }

  // 포장 (차로 + 길어깨) — 차선은 셰이더가 그림
  buildSurface(B, rt, frames) {
    const part = B.part('asphalt', true, 3);
    const lip = B.part('solid');
    let prev = null;
    for (const f of frames) {
      const i = f.i;
      const W = rt.width[i];
      const L = rt.leftEdge(i), R = rt.rightEdge(i);
      const tunnel = rt.flags[i] & F_TUNNEL ? 1 : 0;
      const bus = this.busLane(rt, f.s) ? 1 : 0;
      const cols = [-L, -W / 2, 0, W / 2, R];
      const row = cols.map((lat) => {
        const x = f.x + f.rx * lat, z = f.z + f.rz * lat, y = f.y - f.bank * lat;
        return part.vert(x, y, z, f.bank * f.rx, 1, f.bank * f.rz, 1, 1, 1, lat + W / 2, f.s, [W, tunnel, bus]);
      });
      if (prev) for (let k = 0; k < cols.length - 1; k++) part.quad(prev[k], prev[k + 1], row[k + 1], row[k]);
      prev = row;
    }
    // 포장 가장자리 턱 (지형 틈 가리기)
    const edgeL = (f) => -rt.leftEdge(f.i), edgeR = (f) => rt.rightEdge(f.i);
    this.sweepVar(lip, frames, (f) => [[edgeR(f), 0], [edgeR(f) + 0.05, -0.35]], COL.lip);
    this.sweepVar(lip, frames, (f) => [[edgeL(f) - 0.05, -0.35], [edgeL(f), 0]], COL.lip);
  }

  busLane(rt, s) {
    // 경부고속도로 버스전용차로: 한남IC ~ 오산IC (약 0 ~ 46 km)
    const d = rt.name === 'SB' ? s : rt.length - s;
    return d < 46000;
  }

  // 단면 모양이 점마다 다른 띠
  sweepVar(part, frames, profFn, col, opts = {}) {
    // 같은 개수의 점을 가진 단면을 frame마다 계산해서 이어 붙임
    const profs = frames.map(profFn);
    const np = profs[0].length;
    for (let e = 0; e < np - 1; e++) {
      let prevA = -1, prevB = -1;
      frames.forEach((f, k) => {
        const pr = profs[k];
        if (!pr) { prevA = -1; return; }
        const a = pr[e], b = pr[e + 1];
        let nl = b[1] - a[1], nh = -(b[0] - a[0]);
        const L = Math.hypot(nl, nh) || 1;
        nl /= L; nh /= L;
        const c = typeof col === 'function' ? col(f, e) : col;
        const ia = part.vert(f.x + f.rx * a[0], f.y + a[1] - f.bank * a[0], f.z + f.rz * a[0], f.rx * nl, nh, f.rz * nl, c[0], c[1], c[2]);
        const ib = part.vert(f.x + f.rx * b[0], f.y + b[1] - f.bank * b[0], f.z + f.rz * b[0], f.rx * nl, nh, f.rz * nl, c[0], c[1], c[2]);
        if (prevA >= 0) part.quad(prevA, ia, ib, prevB);
        prevA = ia; prevB = ib;
      });
    }
    void opts;
  }

  // 구간 나누기: 조건이 참인 연속 구간마다 frames 조각
  runs(frames, pred) {
    const out = [];
    let cur = [];
    for (const f of frames) {
      if (pred(f)) cur.push(f);
      else { if (cur.length > 1) out.push(cur); cur = []; }
    }
    if (cur.length > 1) out.push(cur);
    return out;
  }

  adjacent(rt, i) {
    const sep = rt.sep[i];
    return sep < 200 && sep / 2 - 0.15 <= rt.width[i] / 2 + 0.8 + 0.6;
  }

  // 중앙분리대, 가드레일, 방음벽, 길가 풀밭, 가로등
  buildSides(B, rt, frames) {
    const solid = B.part('solid');
    const glow = B.part('glow');
    const notTunnel = (f) => !(rt.flags[f.i] & F_TUNNEL);
    const onBridge = (f) => !!(rt.flags[f.i] & F_BRIDGE);
    // 중앙: 붙어 있으면 SB 쪽만 콘크리트 방호벽 (가운데), 떨어져 있으면 각자 가드레일
    for (const run of this.runs(frames, (f) => notTunnel(f) && this.adjacent(rt, f.i) && rt.name === 'SB')) {
      this.sweepVar(solid, run, (f) => {
        const c = -rt.leftEdge(f.i) - 0.15;
        return [[c + 0.3, -0.05], [c + 0.25, 0.08], [c + 0.11, 0.3], [c + 0.09, 0.95], [c - 0.09, 0.95], [c - 0.11, 0.3], [c - 0.25, 0.08], [c - 0.3, -0.05]];
      }, COL.concrete);
      // 눈부심 방지판 (얇은 녹색 판)
      this.sweepVar(solid, run, (f) => { const c = -rt.leftEdge(f.i) - 0.15; return [[c, 0.95], [c, 1.55]]; }, COL.green);
    }
    for (const run of this.runs(frames, (f) => notTunnel(f) && !this.adjacent(rt, f.i))) {
      if (run.some(onBridge)) {
        this.sweepVar(solid, run, (f) => { const c = -rt.leftEdge(f.i) - 0.25; return [[c + 0.22, 0], [c + 0.18, 1.0], [c - 0.18, 1.0], [c - 0.22, -1.2]]; }, COL.concrete);
      } else {
        this.guardrail(solid, run, (f) => -rt.leftEdge(f.i) - 0.5, -1);
        // 넓은 중앙 풀밭
        this.sweepVar(solid, run, (f) => { const e = -rt.leftEdge(f.i); return [[e - 3.5, -0.45], [e - 0.05, -0.3]]; }, COL.grass);
      }
    }
    // 바깥쪽: 교량은 콘크리트 난간, 방음벽 구간은 방음벽, 나머지는 가드레일 (깊은 절토는 생략)
    for (const run of this.runs(frames, (f) => notTunnel(f) && onBridge(f))) {
      this.sweepVar(solid, run, (f) => { const c = rt.rightEdge(f.i) + 0.3; return [[c - 0.22, -0.02], [c - 0.18, 1.05], [c + 0.18, 1.05], [c + 0.22, -1.2]]; }, COL.concrete);
      this.sweepVar(solid, run, (f) => { const c = rt.rightEdge(f.i) + 0.3; return [[c, 1.05], [c, 1.25]]; }, COL.steel);
    }
    const cut = (f) => rt.dem[f.i] - f.y > 2.5;
    for (const run of this.runs(frames, (f) => notTunnel(f) && !onBridge(f) && !(rt.flags[f.i] & F_WALL_R) && !cut(f))) {
      this.guardrail(solid, run, (f) => rt.rightEdge(f.i) + 0.5, 1);
    }
    // 길가 비탈(풀/자갈)
    for (const run of this.runs(frames, (f) => notTunnel(f) && !onBridge(f))) {
      this.sweepVar(solid, run, (f) => { const e = rt.rightEdge(f.i); return [[e + 0.05, -0.3], [e + 1.4, -0.38], [e + 4.0, -0.9]]; }, (f, e) => (e === 0 ? COL.gravel : COL.grass));
      // 절토 구간 콘크리트 측구
      for (const sub of this.runs(run, cut)) {
        this.sweepVar(solid, sub, (f) => { const e = rt.rightEdge(f.i); return [[e + 0.05, -0.32], [e + 0.6, -0.5], [e + 1.2, -0.3]]; }, COL.concreteDark);
      }
    }
    // 방음벽
    for (const run of this.runs(frames, (f) => notTunnel(f) && !!(rt.flags[f.i] & F_WALL_R))) {
      const hgt = 4.5 + hash(run[0].i) * 2.5;
      this.sweepVar(solid, run, (f) => { const c = rt.rightEdge(f.i) + 1.2; return [[c, -0.8], [c, 1.4]]; }, COL.wallFrame);
      this.sweepVar(solid, run, (f) => { const c = rt.rightEdge(f.i) + 1.2; return [[c, 1.4], [c, hgt]]; }, COL.wallClear);
      this.sweepVar(solid, run, (f) => { const c = rt.rightEdge(f.i) + 1.2; return [[c, hgt], [c - 0.6, hgt + 0.5]]; }, COL.wallPanel);
      // 기둥 (4 m마다)
      for (let k = 0; k < run.length - 1; k++) {
        const f = run[k];
        for (let q = 0; q < 2; q++) {
          const t = q * 0.5;
          const g = this.lerpFrame(f, run[k + 1], t);
          const c = rt.rightEdge(f.i) + 1.25;
          solid.box([g.x + g.rx * c, g.y + hgt / 2 - 0.4 - g.bank * c, g.z + g.rz * c], [g.tx, 0, g.tz], [0, 1, 0], [g.rx, 0, g.rz], 0.1, hgt / 2 + 0.4, 0.08, COL.wallFrame);
        }
      }
    }
    // 가로등 (도심 구간, 40 m마다)
    for (const f of frames) {
      if (!(rt.flags[f.i] & F_URBAN) || (rt.flags[f.i] & F_TUNNEL) || f.i % 4 !== 0) continue;
      const adj = this.adjacent(rt, f.i);
      if (adj && rt.name !== 'SB') continue;
      const lat = adj ? -rt.leftEdge(f.i) - 0.15 : rt.rightEdge(f.i) + 1.0;
      const base = [f.x + f.rx * lat, f.y - f.bank * lat, f.z + f.rz * lat];
      const H = 11;
      solid.box([base[0], base[1] + H / 2, base[2]], [f.tx, 0, f.tz], [0, 1, 0], [f.rx, 0, f.rz], 0.11, H / 2, 0.11, COL.pole);
      const arms = adj ? [-1, 1] : [-1];
      for (const sd of arms) {
        const ax = base[0] + f.rx * sd * 1.3, az = base[2] + f.rz * sd * 1.3;
        solid.box([ax, base[1] + H - 0.15, az], [f.rx, 0, f.rz], [0, 1, 0], [f.tx, 0, f.tz], 1.35, 0.06, 0.06, COL.pole);
        const hx = base[0] + f.rx * sd * 2.5, hz = base[2] + f.rz * sd * 2.5;
        solid.box([hx, base[1] + H - 0.2, hz], [f.rx, 0, f.rz], [0, 1, 0], [f.tx, 0, f.tz], 0.35, 0.09, 0.16, COL.lampHead);
        glow.box([hx, base[1] + H - 0.3, hz], [f.rx, 0, f.rz], [0, 1, 0], [f.tx, 0, f.tz], 0.28, 0.02, 0.12, [0.85, 0.85, 0.8], false);
      }
    }
  }

  lerpFrame(a, b, t) {
    return {
      x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t, z: a.z + (b.z - a.z) * t,
      rx: a.rx + (b.rx - a.rx) * t, rz: a.rz + (b.rz - a.rz) * t,
      tx: a.tx + (b.tx - a.tx) * t, tz: a.tz + (b.tz - a.tz) * t,
      bank: a.bank + (b.bank - a.bank) * t, s: a.s + (b.s - a.s) * t, i: a.i,
    };
  }

  // W빔 가드레일 + 기둥 (side: +1 오른쪽, -1 왼쪽)
  guardrail(part, run, latFn, side) {
    this.sweepVar(part, run, (f) => {
      const c = latFn(f);
      return [[c, 0.5], [c - side * 0.06, 0.6], [c, 0.68], [c - side * 0.06, 0.76], [c, 0.84]];
    }, COL.steel);
    for (let k = 0; k < run.length - 1; k++) {
      for (let q = 0; q < 5; q++) {
        const g = this.lerpFrame(run[k], run[k + 1], q / 5);
        const c = latFn(run[k]) + side * 0.12;
        const top = (q === 0 && k % 2 === 0);
        part.box([g.x + g.rx * c, g.y + 0.38 - g.bank * c, g.z + g.rz * c], [g.tx, 0, g.tz], [0, 1, 0], [g.rx, 0, g.rz], 0.06, 0.48, 0.06, COL.post);
        if (top) {
          // 시선유도 반사체
          part.box([g.x + g.rx * (c - side * 0.05), g.y + 0.95 - g.bank * c, g.z + g.rz * (c - side * 0.05)], [g.tx, 0, g.tz], [0, 1, 0], [g.rx, 0, g.rz], 0.04, 0.09, 0.02, COL.delin);
        }
      }
    }
  }

  // 교량(상판·교각·교대), 터널(관·조명·갱구)
  buildStructures(B, rt, frames) {
    const solid = B.part('solid');
    const glow = B.part('glow');
    const tun = B.part('tunnel');
    const isB = (f) => !!(rt.flags[f.i] & F_BRIDGE);
    const isT = (f) => !!(rt.flags[f.i] & F_TUNNEL);
    for (const run of this.runs(frames, isB)) {
      this.sweepVar(solid, run, (f) => {
        const L = rt.leftEdge(f.i) + 0.5, R = rt.rightEdge(f.i) + 0.55;
        return [[R, -0.02], [R, -0.9], [R - 1.2, -2.1], [-L + 1.2, -2.1], [-L, -0.9], [-L, -0.02]];
      }, COL.deck);
      // 교각: 30 m마다, 땅까지 4 m 이상일 때
      for (const f of run) {
        if (f.i % 3 !== 0) continue;
        const gap = f.y - rt.dem[f.i];
        if (gap < 4.5) continue;
        const W = rt.width[f.i];
        const bottom = rt.dem[f.i] - 3;
        const top = f.y - 2.1;
        const hh = (top - bottom) / 2;
        for (const lat of [-W / 4, W / 4]) {
          solid.box([f.x + f.rx * lat, bottom + hh, f.z + f.rz * lat], [f.tx, 0, f.tz], [0, 1, 0], [f.rx, 0, f.rz], 0.8, hh, 0.8, COL.concreteDark);
        }
        solid.box([f.x, top - 0.5, f.z], [f.tx, 0, f.tz], [0, 1, 0], [f.rx, 0, f.rz], 0.9, 0.5, W / 2 + 0.6, COL.concreteDark);
      }
    }
    // 교량 시작/끝의 교대 벽
    for (let k = 1; k < frames.length; k++) {
      const a = frames[k - 1], b = frames[k];
      if (isB(a) !== isB(b)) {
        const f = isB(a) ? a : b;
        const L = rt.leftEdge(f.i) + 0.6, R = rt.rightEdge(f.i) + 0.6;
        const cl = (R - L) / 2;
        solid.box([f.x + f.rx * cl, f.y - 4, f.z + f.rz * cl], [f.tx, 0, f.tz], [0, 1, 0], [f.rx, 0, f.rz], 0.8, 4, (R + L) / 2 + 1.5, COL.concrete);
      }
    }
    // 터널
    for (const run of this.runs(frames, isT)) {
      const sodium = hash(Math.floor(run[0].s / 3000)) < 0.4;
      const lampCol = sodium ? COL.lampSodium : COL.lampLED;
      this.sweepVar(tun, run, (f) => this.tunnelProfile(rt, f.i), (f, e) => {
        if (e < 2) return COL.tunTile;
        if (e < 4 || e > 14) return COL.tunWall;
        return COL.tunCeil;
      });
      // 조명 두 줄 (6 m마다)
      for (let k = 0; k < run.length - 1; k++) {
        for (let q = 0; q < 2; q++) {
          const g = this.lerpFrame(run[k], run[k + 1], q * 0.5 + 0.25);
          const W = rt.width[g.i];
          for (const lat of [-W / 2 + 0.6, W / 2 - 0.6]) {
            glow.box([g.x + g.rx * lat, g.y + 5.3 - g.bank * lat, g.z + g.rz * lat], [g.tx, 0, g.tz], [0, 1, 0], [g.rx, 0, g.rz], 0.7, 0.05, 0.12, lampCol, false);
          }
        }
      }
    }
    // 갱구 (터널 입구/출구 벽)
    for (let k = 1; k < frames.length; k++) {
      const a = frames[k - 1], b = frames[k];
      if (isT(a) !== isT(b)) this.portal(solid, rt, isT(a) ? a : b, isT(b) ? 1 : -1);
    }
  }

  tunnelProfile(rt, i) {
    const L = rt.leftEdge(i) + 0.7, R = rt.rightEdge(i) + 0.7;
    const cx = (R - L) / 2, rx = (R + L) / 2;
    const pts = [[R, -0.3], [R, 0.9], [R, 1.25]];
    const n = 14;
    for (let k = 0; k <= n; k++) {
      const a = (k / n) * Math.PI;
      pts.push([cx + Math.cos(a) * rx, 1.25 + Math.sin(a) * 6.3]);
    }
    pts.push([-L, 0.9], [-L, -0.3]);
    return pts;
  }

  // 터널 입구 벽: 관 모양 구멍이 뚫린 큰 콘크리트 면
  portal(part, rt, f, dir) {
    const prof = this.tunnelProfile(rt, f.i);
    const L = rt.leftEdge(f.i) + 9, R = rt.rightEdge(f.i) + 9;
    const shape = new THREE.Shape();
    shape.moveTo(-L, -2); shape.lineTo(R, -2); shape.lineTo(R, 13); shape.lineTo(-L, 13); shape.lineTo(-L, -2);
    const hole = new THREE.Path();
    prof.forEach(([lat, h], k) => (k ? hole.lineTo(lat, h) : hole.moveTo(lat, h)));
    hole.lineTo(prof[0][0], prof[0][1]);
    shape.holes.push(hole);
    const geo = new THREE.ShapeGeometry(shape, 1);
    const pos = geo.attributes.position;
    const idx = geo.index.array;
    const nx = -f.tx * dir, nz = -f.tz * dir;
    const base = part.count;
    for (let k = 0; k < pos.count; k++) {
      const lat = pos.getX(k), h = pos.getY(k);
      const c = h > 9 ? COL.concreteDark : COL.concrete;
      part.vert(f.x + f.rx * lat, f.y + h - f.bank * Math.max(-L, Math.min(R, lat)), f.z + f.rz * lat, nx, 0, nz, c[0], c[1], c[2]);
    }
    for (let k = 0; k < idx.length; k += 3) {
      if (dir > 0) part.tri(base + idx[k], base + idx[k + 1], base + idx[k + 2]);
      else part.tri(base + idx[k], base + idx[k + 2], base + idx[k + 1]);
    }
    geo.dispose();
    // 위쪽 처마
    const cl = (R - L) / 2;
    part.box([f.x + f.rx * cl - f.tx * dir * 1.5, f.y + 12.6, f.z + f.rz * cl - f.tz * dir * 1.5], [f.tx, 0, f.tz], [0, 1, 0], [f.rx, 0, f.rz], 1.5, 0.4, (R + L) / 2, COL.concreteDark);
  }

  // 출구·진입 램프: 본선에서 충분히 떨어진 부분부터
  buildRamp(B, rt, rp) {
    const part = B.part('asphalt', true, 3);
    const solid = B.part('solid');
    const n = rp.n, P = rp.pts;
    // 본선 중심에서의 횡거리로 보일 구간 고르기
    const ok = new Array(n).fill(false);
    let hint = rt.idx(rp.s)[0];
    for (let k = 0; k < n; k++) {
      const x = P[k * 3], z = P[k * 3 + 1];
      const nr = rt.nearest(x, z, hint, 600);
      hint = nr.i;
      const lat = (x - rt.xyz[nr.i * 3]) * -rt.tz[nr.i] + (z - rt.xyz[nr.i * 3 + 1]) * rt.tx[nr.i];
      const edge = lat > 0 ? rt.rightEdge(nr.i) : rt.leftEdge(nr.i);
      ok[k] = Math.abs(lat) - edge > 3.2;
    }
    const frames = [];
    for (let k = 0; k < n; k++) {
      const a = Math.max(k - 1, 0), b = Math.min(k + 1, n - 1);
      let tx = P[b * 3] - P[a * 3], tz = P[b * 3 + 1] - P[a * 3 + 1];
      const L = Math.hypot(tx, tz) || 1;
      tx /= L; tz /= L;
      frames.push({ x: P[k * 3], z: P[k * 3 + 1], y: P[k * 3 + 2], tx, tz, rx: -tz, rz: tx, bank: 0, s: rp.s + k * 5, i: k, ok: ok[k] });
    }
    for (const run of this.runs(frames, (f) => f.ok)) {
      let prev = null;
      for (const f of run) {
        const cols = [-2.8, -1.8, 1.8, 3.8];
        const row = cols.map((lat) => part.vert(f.x + f.rx * lat, f.y, f.z + f.rz * lat, 0, 1, 0, 1, 1, 1, lat + 1.8, f.s, [3.6, 0, 2]));
        if (prev) for (let k = 0; k < 3; k++) part.quad(prev[k], prev[k + 1], row[k + 1], row[k]);
        prev = row;
      }
      this.sweepVar(solid, run, () => [[3.8, 0], [3.85, -0.4]], COL.lip);
      this.sweepVar(solid, run, () => [[-2.85, -0.4], [-2.8, 0]], COL.lip);
      this.guardrail(solid, run.filter((_, k) => k % 2 === 0), () => 4.3, 1);
    }
  }

  // 위로 지나가는 도로/철도/육교
  buildOverpass(B, rt, ov) {
    const solid = B.part('solid');
    const i = Math.min(Math.round(ov.s / rt.spacing), rt.n - 1);
    const f = frameAt(rt, i);
    const ex = Math.cos(ov.ang), ez = Math.sin(ov.ang);
    const sinT = Math.abs(ex * f.tz - ez * f.tx);
    const sep = rt.sep[i] < 200 ? rt.sep[i] : 0;
    const across = rt.leftEdge(i) + rt.rightEdge(i) + sep + 16;
    const Ld = Math.min(across / Math.max(sinT, 0.3), 260);
    // 두 방향 차로 가운데쯤으로 옮김 (반대 차로는 왼쪽)
    const mx = ov.x - f.rx * sep / 2, mz = ov.z - f.rz * sep / 2;
    const t = (mx - ov.x) * ex + (mz - ov.z) * ez;
    const cx = ov.x + ex * t, cz = ov.z + ez * t;
    const yTop = f.y + 6.9;
    const w = Math.max(ov.w, 3) / 2;
    const nx = -ez, nz = ex; // 다리 폭 방향
    const rail = ov.kind === 'rail';
    const foot = ['footway', 'cycleway', 'path', 'pedestrian', 'steps'].includes(ov.kind);
    const deckCol = rail ? COL.rail : foot ? COL.steel : COL.deck;
    const thick = foot ? 0.8 : 1.5;
    solid.box([cx, yTop - thick / 2, cz], [ex, 0, ez], [0, 1, 0], [nx, 0, nz], Ld / 2, thick / 2, w, deckCol, false);
    // 난간
    for (const sd of [-1, 1]) {
      solid.box([cx + nx * sd * (w - 0.15), yTop + 0.55, cz + nz * sd * (w - 0.15)], [ex, 0, ez], [0, 1, 0], [nx, 0, nz], Ld / 2, 0.55, 0.12, foot ? COL.steel : COL.concrete);
    }
    if (foot) {
      // 육교 지붕 대신 높은 난간
      for (const sd of [-1, 1]) solid.box([cx + nx * sd * (w - 0.05), yTop + 1.3, cz + nz * sd * (w - 0.05)], [ex, 0, ez], [0, 1, 0], [nx, 0, nz], Ld / 2, 0.2, 0.03, COL.wallFrame);
    }
    // 교각: 양 끝과 중앙분리대 위치(다리 축 위로 옮긴 값)
    const piers = [-Ld / 2 + 2.5, Ld / 2 - 2.5];
    const medLat = -rt.leftEdge(i) - (this.adjacent(rt, i) ? 0.15 : sep / 2);
    const mpx = ov.x + f.rx * medLat, mpz = ov.z + f.rz * medLat;
    // 중앙 지점을 지나 도로 방향으로 그은 선과 다리 축의 교점
    const den = ex * f.tz - ez * f.tx;
    if (Math.abs(den) > 0.25) {
      const tm = ((mpx - cx) * f.tz - (mpz - cz) * f.tx) / den;
      if (Math.abs(tm) < Ld / 2 - 4) piers.push(tm);
    }
    const groundY = f.y - 1;
    for (const p of piers) {
      const px = cx + ex * p, pz = cz + ez * p;
      const hh = (yTop - thick - groundY) / 2;
      const cols = foot ? [0] : [-w * 0.55, w * 0.55];
      for (const q of cols) {
        solid.box([px + nx * q, groundY + hh, pz + nz * q], [ex, 0, ez], [0, 1, 0], [nx, 0, nz], 0.55, hh, 0.55, COL.concreteDark);
      }
    }
    // 접속 경사로 (다리 끝 → 지형)
    if (!foot) {
      for (const sd of [-1, 1]) {
        const endY = sd < 0 ? ov.ya : ov.yb;
        const ax = cx + ex * sd * Ld / 2, az = cz + ez * sd * Ld / 2;
        const len = 40;
        const bx = ax + ex * sd * len, bz = az + ez * sd * len;
        const y0 = yTop, y1 = Math.min(yTop, endY + 0.3);
        // 경사 상판 + 옹벽
        const p0 = [ax + nx * w, y0, az + nz * w], p1 = [ax - nx * w, y0, az - nz * w];
        const p2 = [bx - nx * w, y1, bz - nz * w], p3 = [bx + nx * w, y1, bz + nz * w];
        solid.face(...(sd > 0 ? [p0, p1, p2, p3] : [p1, p0, p3, p2]), deckCol);
        for (const q of [-1, 1]) {
          const s0 = [ax + nx * q * w, y0, az + nz * q * w], s1 = [bx + nx * q * w, y1, bz + nz * q * w];
          solid.face(s0, s1, [s1[0], Math.min(y1, endY) - 3, s1[2]], [s0[0], groundY - 2, s0[2]], COL.concrete);
        }
      }
    }
  }
}
