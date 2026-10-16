// 자율주행 일정: 4시간 30분(설정 가능)에 맞춘 속도 계획, 차로 선택, 차의 자세(위치·방향·기울기)
import { LANE_W, bankOf } from './route.js';

const smooth = (a, sigma) => {
  // 1차원 가우시안 (sigma: 점 개수)
  const n = a.length, r = Math.ceil(sigma * 3);
  const w = [];
  let ws = 0;
  for (let k = -r; k <= r; k++) { const v = Math.exp(-(k * k) / (2 * sigma * sigma)); w.push(v); ws += v; }
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    let s = 0;
    for (let k = -r; k <= r; k++) s += a[Math.min(n - 1, Math.max(0, i + k))] * w[k + r];
    out[i] = s / ws;
  }
  return out;
};

export class TripPlan {
  constructor(route, { totalSec = 4.5 * 3600, seed = 1, slow = [] } = {}) {
    this.route = route;
    this.totalSec = totalSec;
    const n = route.n, ds = route.spacing;
    // ── 차로: 왼쪽(1차로)은 추월용, 버스전용차로 피함
    const lat = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      // 앞 300 m 안에서 가장 적은 차로 수에 맞춰 미리 차로를 옮김
      let lanes = route.lanes[i];
      for (let k = 1; k <= 30 && i + k < n; k++) lanes = Math.min(lanes, route.lanes[i + k]);
      const lane = lanes >= 4 ? lanes - 2 : lanes - 1; // 0 = 1차로
      lat[i] = -route.width[i] / 2 + LANE_W * (lane + 0.5);
    }
    this.lat = smooth(lat, 9);
    // ── 속도 계획 (m/s)
    const v = new Float32Array(n);
    const L = route.length;
    let ph = seed * 1.7;
    for (let i = 0; i < n; i++) {
      const s = i * ds;
      let vt = (route.speed[i] || 100) * 0.97;
      // 서울·부산 도심 구간은 막힘
      const fromSeoul = route.name === 'SB' ? s : L - s;
      const fromBusan = route.name === 'SB' ? L - s : s;
      if (fromSeoul < 22000) vt = Math.min(vt, 62 + (fromSeoul / 22000) * 25);
      if (fromBusan < 9000) vt = Math.min(vt, 70);
      // 요금소(하이패스) 통과
      for (const z of slow) if (Math.abs(s - z.s) < z.half) vt = Math.min(vt, z.kmh);
      // 곡선: 옆 가속도 1.5 m/s² 이내
      const R = 1 / Math.max(Math.abs(route.curv[i]), 1e-5);
      vt = Math.min(vt, Math.sqrt(1.5 * R) * 3.6);
      // 교통 흐름에 따른 완만한 변화 (±4%)
      ph += 0.0021;
      vt *= 1 + 0.04 * Math.sin(ph) * Math.sin(ph * 0.37 + 1.3);
      v[i] = vt / 3.6;
    }
    this.vCruise = smooth(v, 6);
    this.solve();
  }

  // 가감속 한계를 지키며, 전체 시간이 totalSec가 되도록 비율을 맞춤
  solve() {
    const n = this.route.n, ds = this.route.spacing;
    const base = this.vCruise;
    let k = 1;
    for (let it = 0; it < 30; it++) {
      const v = new Float32Array(n);
      for (let i = 0; i < n; i++) v[i] = base[i] * k;
      v[0] = 0; v[n - 1] = 0;
      const aUp = 0.7, aDn = 0.9;
      for (let i = 1; i < n; i++) v[i] = Math.min(v[i], Math.sqrt(v[i - 1] ** 2 + 2 * aUp * ds));
      for (let i = n - 2; i >= 0; i--) v[i] = Math.min(v[i], Math.sqrt(v[i + 1] ** 2 + 2 * aDn * ds));
      const t = new Float64Array(n);
      for (let i = 1; i < n; i++) t[i] = t[i - 1] + (2 * ds) / Math.max(v[i - 1] + v[i], 0.3);
      const T = t[n - 1];
      this.v = v; this.t = t;
      if (Math.abs(T - this.totalSec) < 1) break;
      k *= T / this.totalSec;
    }
    this.scale = k;
    this.duration = this.t[n - 1];
  }

  // 출발 후 경과 시간(초) → 거리 s
  sAt(time) {
    const t = this.t, n = t.length;
    if (time <= 0) return 0;
    if (time >= t[n - 1]) return this.route.length;
    let lo = 0, hi = n - 1;
    while (hi - lo > 1) { const m = (lo + hi) >> 1; if (t[m] <= time) lo = m; else hi = m; }
    // 구간 안에서는 등가속 운동으로 보간
    const ds = this.route.spacing;
    const v0 = this.v[lo], v1 = this.v[hi];
    const dt = t[hi] - t[lo];
    const tau = time - t[lo];
    const a = (v1 - v0) / dt;
    const d = v0 * tau + 0.5 * a * tau * tau;
    return lo * ds + Math.min(Math.max(d, 0), ds);
  }

  timeAt(s) {
    const f = Math.min(Math.max(s / this.route.spacing, 0), this.route.n - 1);
    const i = Math.min(Math.floor(f), this.route.n - 2);
    return this.t[i] + (this.t[i + 1] - this.t[i]) * (f - i);
  }

  speedAt(s) {
    const f = Math.min(Math.max(s / this.route.spacing, 0), this.route.n - 1);
    const i = Math.min(Math.floor(f), this.route.n - 2);
    return this.v[i] + (this.v[i + 1] - this.v[i]) * (f - i);
  }

  latAt(s) {
    const f = Math.min(Math.max(s / this.route.spacing, 0), this.route.n - 1);
    const i = Math.min(Math.floor(f), this.route.n - 2);
    return this.lat[i] + (this.lat[i + 1] - this.lat[i]) * (f - i);
  }
}

// 차 자세: 경로 위 s, 횡위치 → 위치·방향·피치·롤
export function carPose(route, plan, s, out = {}) {
  const f = route.sample(s, out._f || (out._f = {}));
  const lat = plan.latAt(s);
  const bank = bankOf(f.curv);
  out.x = f.x - f.tz * lat;
  out.z = f.z + f.tx * lat;
  out.y = f.y - bank * lat;
  // 차로 변경 중이면 그 방향으로 살짝 틀어짐
  const dl = (plan.latAt(s + 8) - plan.latAt(s - 8)) / 16;
  let tx = f.tx, tz = f.tz;
  tx += -f.tz * dl; tz += f.tx * dl;
  const L = Math.hypot(tx, tz) || 1;
  out.tx = tx / L; out.tz = tz / L;
  out.yaw = Math.atan2(-out.tx, -out.tz);
  out.pitch = Math.atan(f.grade);
  out.roll = -Math.atan(bank);
  out.laneShift = dl; // + 오른쪽으로 옮기는 중
  out.lat = lat;
  out.i = f.i;
  return out;
}
