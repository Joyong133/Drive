// 경부고속도로 차로 중심선 데이터 (tools/build_trip_data.py가 만든 route_SB.bin / route_NB.bin)
// three.js에 의존하지 않음 → 지형 워커에서도 그대로 씀
export const LANE_W = 3.6;      // 차로 폭
export const SHOULDER_L = 0.8;  // 안쪽(중앙분리대 쪽) 길어깨
export const SHOULDER_R = 3.0;  // 바깥쪽 길어깨

export const F_BRIDGE = 1, F_TUNNEL = 2, F_WALL_R = 4, F_WALL_L = 8, F_URBAN = 16;

// 곡선 구간 편경사 (오른쪽으로 굽으면 오른쪽이 낮아짐). 높이 변화 = -bank × 횡거리(오른쪽 +)
export function bankOf(curv) { return Math.max(-0.05, Math.min(0.05, curv * 25)); }

export class Route {
  constructor(name, n, spacing, buf) {
    this.name = name;
    this.n = n;
    this.spacing = spacing;
    this.length = (n - 1) * spacing;
    let o = 0;
    this.xyz = new Float32Array(buf, o, n * 3); o += n * 12;
    this.dem = new Float32Array(buf, o, n); o += n * 4;
    this.other = new Int32Array(buf, o, n); o += n * 4;
    this.flags = new Uint8Array(buf, o, n); o += n;
    this.lanes = new Uint8Array(buf, o, n); o += n;
    this.speed = new Uint8Array(buf, o, n); o += n;
    this.sep = new Uint8Array(buf, o, n);
    this.buffer = buf;
    this.prepare();
  }

  prepare() {
    const n = this.n, p = this.xyz;
    // 접선 (앞뒤 점으로 구한 뒤 한 번 더 부드럽게)
    const tx = new Float32Array(n), tz = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      const a = Math.max(i - 2, 0), b = Math.min(i + 2, n - 1);
      let dx = p[b * 3] - p[a * 3], dz = p[b * 3 + 1] - p[a * 3 + 1];
      const L = Math.hypot(dx, dz) || 1;
      tx[i] = dx / L; tz[i] = dz / L;
    }
    this.tx = tx; this.tz = tz;
    // 포장 폭: 차로 수가 바뀌는 곳은 150 m에 걸쳐 서서히 (차로 감소/증가 테이퍼)
    const W = new Float32Array(n);
    const half = 8;
    let acc = 0;
    const lw = (i) => this.lanes[Math.min(Math.max(i, 0), n - 1)] * LANE_W;
    for (let i = -half; i <= half; i++) acc += lw(i);
    for (let i = 0; i < n; i++) {
      W[i] = acc / (half * 2 + 1);
      acc += lw(i + half + 1) - lw(i - half);
    }
    this.width = W;
    // 곡률 (부호: 오른쪽으로 굽으면 +)
    const curv = new Float32Array(n);
    for (let i = 1; i < n - 1; i++) {
      const a1 = Math.atan2(tz[i - 1], tx[i - 1]), a2 = Math.atan2(tz[i + 1], tx[i + 1]);
      let d = a2 - a1;
      if (d > Math.PI) d -= 2 * Math.PI;
      if (d < -Math.PI) d += 2 * Math.PI;
      curv[i] = d / (2 * this.spacing);
    }
    this.curv = curv;
  }

  clampS(s) { return Math.min(Math.max(s, 0), this.length); }

  // 거리 s의 점 번호와 보간 비율
  idx(s) {
    const f = this.clampS(s) / this.spacing;
    const i = Math.min(Math.floor(f), this.n - 2);
    return [i, f - i];
  }

  // 중심선 위치·접선·높이
  sample(s, out = {}) {
    const [i, t] = this.idx(s);
    const p = this.xyz, j = i + 1;
    out.x = p[i * 3] + (p[j * 3] - p[i * 3]) * t;
    out.z = p[i * 3 + 1] + (p[j * 3 + 1] - p[i * 3 + 1]) * t;
    out.y = p[i * 3 + 2] + (p[j * 3 + 2] - p[i * 3 + 2]) * t;
    let tx = this.tx[i] + (this.tx[j] - this.tx[i]) * t;
    let tz = this.tz[i] + (this.tz[j] - this.tz[i]) * t;
    const L = Math.hypot(tx, tz) || 1;
    out.tx = tx / L; out.tz = tz / L;
    out.grade = (p[j * 3 + 2] - p[i * 3 + 2]) / this.spacing;
    out.width = this.width[i] + (this.width[j] - this.width[i]) * t;
    out.curv = this.curv[i] + (this.curv[j] - this.curv[i]) * t;
    out.i = i;
    out.t = t;
    return out;
  }

  // 오른쪽으로 off(m) 떨어진 점 (오른쪽 = (-tz, tx))
  offsetPoint(s, off, out = {}) {
    this.sample(s, out);
    out.x += -out.tz * off;
    out.z += out.tx * off;
    return out;
  }

  flagAt(s) { return this.flags[this.idx(s)[0]]; }
  lanesAt(s) { return this.lanes[this.idx(s)[0]]; }
  speedAt(s) { return this.speed[this.idx(s)[0]]; }

  // 안쪽(왼쪽) 포장 끝: 반대 차로와 붙어 있으면 그 사이 가운데에서 끊음
  leftEdge(i) {
    const w = this.width[i] / 2 + SHOULDER_L;
    const sep = this.sep[i];
    return sep < 200 ? Math.min(w, Math.max(sep / 2 - 0.15, this.width[i] / 2 + 0.3)) : w;
  }

  rightEdge(i) { return this.width[i] / 2 + SHOULDER_R; }

  // 월드 좌표에서 가장 가까운 점 (격자 색인, 처음 부를 때 만듦)
  nearest(x, z, hint = -1, range = 400) {
    const p = this.xyz;
    let best = -1, bd = Infinity;
    if (hint >= 0) {
      const r = Math.ceil(range / this.spacing);
      for (let i = Math.max(0, hint - r); i < Math.min(this.n, hint + r); i++) {
        const d = (p[i * 3] - x) ** 2 + (p[i * 3 + 1] - z) ** 2;
        if (d < bd) { bd = d; best = i; }
      }
      return { i: best, d: Math.sqrt(bd) };
    }
    if (!this.grid) this.buildGrid();
    const c = 200;
    const gx = Math.floor(x / c), gz = Math.floor(z / c);
    for (let r = 0; r < 60 && best < 0; r++) {
      for (let a = -r; a <= r; a++) {
        for (let b = -r; b <= r; b++) {
          if (Math.max(Math.abs(a), Math.abs(b)) !== r) continue;
          const cell = this.grid.get((gx + a) * 100003 + (gz + b));
          if (!cell) continue;
          for (const i of cell) {
            const d = (p[i * 3] - x) ** 2 + (p[i * 3 + 1] - z) ** 2;
            if (d < bd) { bd = d; best = i; }
          }
        }
      }
      if (best >= 0) {
        // 한 칸 더 둘러봄
        for (let a = -r - 1; a <= r + 1; a++) {
          for (let b = -r - 1; b <= r + 1; b++) {
            const cell = this.grid.get((gx + a) * 100003 + (gz + b));
            if (!cell) continue;
            for (const i of cell) {
              const d = (p[i * 3] - x) ** 2 + (p[i * 3 + 1] - z) ** 2;
              if (d < bd) { bd = d; best = i; }
            }
          }
        }
      }
    }
    return { i: best, d: Math.sqrt(bd) };
  }

  buildGrid() {
    const c = 200;
    this.grid = new Map();
    for (let i = 0; i < this.n; i++) {
      const k = Math.floor(this.xyz[i * 3] / c) * 100003 + Math.floor(this.xyz[i * 3 + 1] / c);
      let a = this.grid.get(k);
      if (!a) this.grid.set(k, (a = []));
      a.push(i);
    }
  }
}

export async function loadTripData(base = 'data/trip/') {
  const meta = await (await fetch(base + 'meta.json')).json();
  const routes = {};
  await Promise.all(Object.keys(meta.routes).map(async (name) => {
    const buf = await (await fetch(`${base}route_${name}.bin`)).arrayBuffer();
    routes[name] = new Route(name, meta.routes[name].n, meta.spacing, buf);
  }));
  const rampBuf = await (await fetch(base + 'ramps.bin')).arrayBuffer();
  return { meta, routes, rampBuf };
}
