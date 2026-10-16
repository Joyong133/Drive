// 고속도로 안내표지: 출구 예고(2 km·1 km), 출구 문형식 표지, 이정표(도시까지 km), 휴게소·졸음쉼터,
// 제한속도, 거리표(km), 시·군 경계, 터널 예고, 졸음운전 경고 현수막
import * as THREE from 'three';
import { Builder } from './mesher.js';
import { F_TUNNEL } from './route.js';
import { makeCanvas, canvasTexture, roundRect, FONT } from '../util.js';

const GREEN = '#0b6b45';
const BLUE = '#1c4fa0';
const MAJOR = ['서울', '수원', '천안', '청주', '대전', '김천', '구미', '대구', '경주', '울산', '양산', '부산'];
const SLOGANS = [
  ['졸음운전의 종착지는', '이 세상이 아닙니다'],
  ['졸리면 제발', '쉬어가세요'],
  ['깜빡 졸음', '번쩍 저승'],
  ['안전띠', '뒷좌석도 꼭!'],
  ['2시간마다', '휴게소에서 쉬어가세요'],
];

function cleanIC(name) {
  if (!name) return '';
  return name.replace(/나들목$/, ' IC').replace(/분기점$/, ' JC').replace(/(IC|JC)$/, ' $1').replace(/\s+/g, ' ').trim();
}

export class SignFactory {
  constructor(meta, routes, ramps) {
    this.routes = routes;
    this.place = {};
    for (const dir of Object.keys(routes)) this.place[dir] = this.compute(dir, meta.routes[dir], routes[dir], ramps.filter((r) => r.dir === dir));
  }

  compute(dir, m, rt, ramps) {
    const out = [];
    const L = rt.length;
    const inTunnel = (s) => (rt.flagAt(s) & F_TUNNEL) || (rt.flagAt(s + 40) & F_TUNNEL) || (rt.flagAt(s - 40) & F_TUNNEL);
    const add = (p) => {
      if (p.s < 30 || p.s > L - 30) return;
      // 터널 안이나 다른 표지와 겹치면 조금 뒤로
      for (let k = 0; k < 8 && (inTunnel(p.s) || out.some((q) => Math.abs(q.s - p.s) < 45 && q.side === p.side)); k++) p.s -= 60;
      if (p.s < 30 || inTunnel(p.s)) return;
      out.push(p);
    };
    const majorsAhead = (s, n = 2) => {
      const list = m.cities.filter((c) => c.s > s + 4000 && MAJOR.includes(c.name));
      const res = list.slice(0, n).map((c) => c.name);
      const last = dir === 'SB' ? '부산' : '서울';
      if (!res.includes(last)) { if (res.length >= n) res.pop(); res.push(last); }
      return res;
    };
    // 출구: 같은 IC의 안내를 묶음
    const exits = [];
    for (const sg of m.signs) {
      if (sg.kind !== 'exit') continue;
      const last = exits[exits.length - 1];
      if (last && sg.s - last.s < 700) {
        for (const l of sg.labels) if (!last.labels.includes(l) && last.labels.length < 3) last.labels.push(l);
        continue;
      }
      const ramp = ramps.filter((r) => r.kind === 'exit' && Math.abs(r.s - sg.s) < 500).sort((a, b) => Math.abs(a.s - sg.s) - Math.abs(b.s - sg.s))[0];
      exits.push({ s: sg.s, labels: [...sg.labels].slice(0, 3), name: cleanIC(ramp?.name), side: ramp ? ramp.side : 1 });
    }
    for (const e of exits) {
      // 이 방향의 목적지(부산/서울 등)는 출구 표지에서 빼기
      const through = majorsAhead(e.s);
      const labels = e.labels.filter((l) => !through.includes(l)).slice(0, 2);
      if (!labels.length) continue;
      const jc = /JC/.test(e.name);
      if (jc) add({ s: e.s - 2000, type: 'advance', side: 1, labels, name: e.name, dist: '2km' });
      add({ s: e.s - 1000, type: 'advance', side: 1, labels, name: e.name, dist: '1km' });
      add({ s: e.s - 60, type: 'gantry', side: 0, labels, name: e.name, through, exitSide: e.side });
    }
    // 이정표: 진입 램프가 합류한 뒤
    let lastD = -1e9;
    for (const r of ramps) {
      if (r.kind !== 'entry' || r.s - lastD < 3000) continue;
      lastD = r.s;
      const list = m.cities.filter((c) => c.s > r.s + 3000 && MAJOR.includes(c.name)).slice(0, 3);
      const last = m.cities[m.cities.length - 1];
      if (last && !list.includes(last) && list.length) list[list.length - 1] = last;
      if (list.length) add({ s: r.s + 650, type: 'distance', side: 1, cities: list.map((c) => ({ name: c.name, km: Math.round((c.s - r.s - 650) / 1000) })) });
    }
    // 휴게소·졸음쉼터
    for (const rs of m.rests) {
      const isRest = rs.kind === 'rest';
      for (const [d, txt] of isRest ? [[2000, '2km'], [1000, '1km'], [500, '500m']] : [[1000, '1km'], [400, '400m']]) {
        add({ s: rs.s - d, type: isRest ? 'rest' : 'shelter', side: 1, name: rs.name, dist: txt });
      }
    }
    // 제한속도: 바뀌는 곳 + 6 km마다
    let lastSp = 0, lastSpS = -1e9;
    for (let s = 300; s < L; s += 100) {
      const sp = rt.speedAt(s);
      if (sp !== lastSp || s - lastSpS > 6000) {
        add({ s, type: 'speed', side: 2, speed: sp });
        lastSp = sp; lastSpS = s;
      }
    }
    // 거리표 (부산 기점 km)
    for (let s = 500; s < L; s += 1000) {
      const km = dir === 'SB' ? (L - s) / 1000 : s / 1000;
      add({ s, type: 'km', side: 3, km: km.toFixed(1) });
    }
    // 시·군 경계
    for (const nm of m.names.slice(1)) {
      if (nm.county) add({ s: nm.s + 80, type: 'boundary', side: 1, region: nm.region, county: nm.county });
    }
    // 터널 예고
    for (const [a, b] of m.tunnels) {
      if (b - a < 150) continue;
      add({ s: a - 280, type: 'tunnel', side: 1, len: b - a });
    }
    // 졸음운전 경고 현수막 (25 km쯤마다)
    let k = 0;
    for (let s = 9000; s < L - 5000; s += 25000 + ((k * 7919) % 6000)) {
      add({ s, type: 'slogan', side: 1, text: SLOGANS[k++ % SLOGANS.length] });
    }
    out.sort((a, b) => a.s - b.s);
    return out;
  }
}

// ───────── 글자판 그리기
function shield(g, x, y, h, num) {
  // 고속도로 노선 번호 방패 (파랑+빨강)
  const w = h * 0.86;
  g.save();
  g.translate(x, y);
  g.fillStyle = '#ffffff';
  g.beginPath(); g.moveTo(0, 0); g.lineTo(w, 0); g.lineTo(w, h * 0.62); g.quadraticCurveTo(w, h * 0.9, w / 2, h); g.quadraticCurveTo(0, h * 0.9, 0, h * 0.62); g.closePath(); g.fill();
  g.fillStyle = '#d11f2d'; g.fillRect(h * 0.06, h * 0.06, w - h * 0.12, h * 0.2);
  g.fillStyle = BLUE;
  g.beginPath(); g.moveTo(h * 0.06, h * 0.3); g.lineTo(w - h * 0.06, h * 0.3); g.lineTo(w - h * 0.06, h * 0.6); g.quadraticCurveTo(w - h * 0.06, h * 0.84, w / 2, h * 0.93); g.quadraticCurveTo(h * 0.06, h * 0.84, h * 0.06, h * 0.6); g.closePath(); g.fill();
  g.fillStyle = '#fff'; g.font = `900 ${h * 0.46}px ${FONT}`; g.textAlign = 'center'; g.textBaseline = 'middle';
  g.fillText(num, w / 2, h * 0.6);
  g.restore();
}

function panel(w, h, bg = GREEN) {
  const c = makeCanvas(w, h);
  const g = c.getContext('2d');
  g.fillStyle = '#e9efe9'; roundRect(g, 0, 0, w, h, 18); g.fill();
  g.fillStyle = bg; roundRect(g, 7, 7, w - 14, h - 14, 14); g.fill();
  g.textAlign = 'center'; g.textBaseline = 'middle'; g.fillStyle = '#fff';
  return { c, g };
}

function fit(g, text, size, maxW, weight = 900) {
  let s = size;
  do { g.font = `${weight} ${s}px ${FONT}`; s -= 4; } while (g.measureText(text).width > maxW && s > 16);
}

function arrow(g, x, y, s, dir = 'up') {
  g.save();
  g.translate(x, y);
  if (dir === 'right') g.rotate(Math.PI / 4);
  else if (dir === 'left') g.rotate(-Math.PI / 4);
  g.fillStyle = '#fff';
  g.beginPath();
  g.moveTo(0, -s); g.lineTo(s * 0.62, -s * 0.3); g.lineTo(s * 0.2, -s * 0.3); g.lineTo(s * 0.2, s); g.lineTo(-s * 0.2, s); g.lineTo(-s * 0.2, -s * 0.3); g.lineTo(-s * 0.62, -s * 0.3);
  g.closePath(); g.fill();
  g.restore();
}

function drawSign(p) {
  switch (p.type) {
    case 'advance': {
      const { c, g } = panel(640, 400);
      fit(g, p.name || '출구', 54, 560); g.fillText(p.name || '출구', 320, 70);
      p.labels.forEach((l, i) => { fit(g, l, 84, 470); g.fillText(l, 300, 170 + i * 100 - (p.labels.length - 1) * 30); });
      arrow(g, 560, 220, 52, 'right');
      g.fillStyle = '#ffffff'; g.font = `900 64px ${FONT}`; g.fillText(p.dist, 320, 345);
      return { c, w: 4.2, h: 2.62 };
    }
    case 'gantry': {
      // 왼쪽: 직진 방향, 오른쪽: 출구
      const a = panel(720, 400);
      shield(a.g, 40, 40, 110, '1');
      a.g.fillStyle = '#fff';
      p.through.forEach((l, i) => { fit(a.g, l, 96, 460); a.g.fillText(l, 400, 140 + i * 120); });
      arrow(a.g, 640, 200, 60, 'up');
      const b = panel(640, 400);
      fit(b.g, p.name || '출구', 52, 560); b.g.fillText(p.name || '출구', 320, 66);
      p.labels.forEach((l, i) => { fit(b.g, l, 84, 440); b.g.fillText(l, 280, 175 + i * 100 - (p.labels.length - 1) * 30); });
      arrow(b.g, 560, 230, 56, p.exitSide < 0 ? 'left' : 'right');
      b.g.fillStyle = '#ffd400'; b.g.font = `900 46px ${FONT}`; b.g.fillText('출구', 320, 350);
      return { c: a.c, w: 5.2, h: 2.9, c2: b.c, w2: 4.6, h2: 2.9 };
    }
    case 'distance': {
      const h = 120 + p.cities.length * 104;
      const { c, g } = panel(640, h);
      p.cities.forEach((ct, i) => {
        g.font = `900 80px ${FONT}`; g.textAlign = 'left'; g.fillText(ct.name, 60, 100 + i * 104);
        g.textAlign = 'right'; g.fillText(`${ct.km}`, 520, 100 + i * 104);
        g.font = `700 44px ${FONT}`; g.fillText('km', 600, 110 + i * 104);
      });
      return { c, w: 3.4, h: (3.4 * h) / 640 };
    }
    case 'rest':
    case 'shelter': {
      const { c, g } = panel(640, 400, p.type === 'rest' ? BLUE : GREEN);
      const nm = p.type === 'rest' ? p.name.replace(/휴게소$/, '') : '졸음쉼터';
      fit(g, nm, 96, 560); g.fillText(nm, 320, 110);
      g.font = `900 64px ${FONT}`; g.fillText(p.type === 'rest' ? '휴게소' : '잠깐 쉬어가세요', 320, 215);
      g.fillStyle = '#ffd400'; g.font = `900 70px ${FONT}`; g.fillText(p.dist, 320, 320);
      return { c, w: 3.6, h: 2.25 };
    }
    case 'speed': {
      const c = makeCanvas(256, 256);
      const g = c.getContext('2d');
      g.fillStyle = '#ffffff'; g.beginPath(); g.arc(128, 128, 124, 0, Math.PI * 2); g.fill();
      g.strokeStyle = '#d11f2d'; g.lineWidth = 30; g.beginPath(); g.arc(128, 128, 104, 0, Math.PI * 2); g.stroke();
      g.fillStyle = '#111'; g.font = `900 ${p.speed >= 100 ? 92 : 110}px ${FONT}`; g.textAlign = 'center'; g.textBaseline = 'middle';
      g.fillText(String(p.speed), 128, 136);
      return { c, w: 1.2, h: 1.2, round: true };
    }
    case 'km': {
      const { c, g } = panel(256, 160);
      g.font = `900 70px ${FONT}`; g.fillText(p.km, 128, 84);
      return { c, w: 0.75, h: 0.47 };
    }
    case 'boundary': {
      const { c, g } = panel(640, 300, '#3b5f8a');
      g.font = `700 50px ${FONT}`; g.fillText(p.region, 320, 80);
      fit(g, p.county, 110, 560); g.fillText(p.county, 320, 190);
      return { c, w: 3.2, h: 1.5 };
    }
    case 'tunnel': {
      const { c, g } = panel(640, 360, '#2b2f36');
      g.font = `900 92px ${FONT}`; g.fillText('터널', 320, 110);
      g.font = `700 60px ${FONT}`; g.fillText(`L = ${p.len >= 1000 ? (p.len / 1000).toFixed(1) + ' km' : Math.round(p.len) + ' m'}`, 320, 210);
      g.fillStyle = '#ffd400'; g.font = `700 46px ${FONT}`; g.fillText('전조등 켜기 · 차로변경 금지', 320, 295);
      return { c, w: 3.2, h: 1.8 };
    }
    case 'slogan': {
      const c = makeCanvas(1024, 256);
      const g = c.getContext('2d');
      g.fillStyle = '#ffd400'; g.fillRect(0, 0, 1024, 256);
      g.fillStyle = '#111'; g.fillRect(10, 10, 1004, 236);
      g.fillStyle = '#ffd400'; g.textAlign = 'center'; g.textBaseline = 'middle';
      fit(g, p.text[0], 96, 960); g.fillText(p.text[0], 512, 80);
      fit(g, p.text[1], 104, 960); g.fillText(p.text[1], 512, 180);
      return { c, w: 7, h: 1.75 };
    }
    default:
      return null;
  }
}

// ───────── 구조물과 판
const POST = (() => { const c = new THREE.Color(0x8b9197); return [c.r, c.g, c.b]; })();
const BACK = (() => { const c = new THREE.Color(0x3d4247); return [c.r, c.g, c.b]; })();

const panelMats = new Map();
const postMat = new THREE.MeshLambertMaterial({ vertexColors: true, side: THREE.DoubleSide });

function addPanel(group, tex, origin, f, lat, bottom, w, h) {
  // 앞면이 다가오는 차를 보도록 (법선 = -진행 방향)
  const cx = f.x + -f.tz * lat, cz = f.z + f.tx * lat;
  const rx = -f.tz, rz = f.tx;
  const y0 = f.y + bottom, y1 = y0 + h;
  const pos = new Float32Array([
    cx - rx * w / 2 - origin.x, y0 - origin.y, cz - rz * w / 2 - origin.z,
    cx + rx * w / 2 - origin.x, y0 - origin.y, cz + rz * w / 2 - origin.z,
    cx + rx * w / 2 - origin.x, y1 - origin.y, cz + rz * w / 2 - origin.z,
    cx - rx * w / 2 - origin.x, y1 - origin.y, cz - rz * w / 2 - origin.z,
  ]);
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  const n = [-f.tx, 0, -f.tz];
  geo.setAttribute('normal', new THREE.BufferAttribute(new Float32Array([...n, ...n, ...n, ...n]), 3));
  geo.setAttribute('uv', new THREE.BufferAttribute(new Float32Array([0, 0, 1, 0, 1, 1, 0, 1]), 2));
  geo.setIndex([0, 2, 1, 0, 3, 2]);
  geo.computeBoundingSphere();
  const mat = new THREE.MeshLambertMaterial({ map: tex, alphaTest: 0.5 });
  void panelMats;
  const mesh = new THREE.Mesh(geo, mat);
  mesh.position.copy(origin);
  mesh.userData.ownMap = true;
  mesh.matrixAutoUpdate = false;
  mesh.updateMatrix();
  group.add(mesh);
  return { cx, cz, rx, rz, y0, y1 };
}

export function buildChunkSigns(group, factory, rt, s0, s1, origin) {
  if (!factory) return;
  const list = factory.place[rt.name].filter((p) => p.s >= s0 && p.s < s1);
  if (!list.length) return;
  const B = new Builder(origin);
  const solid = B.part('solid');
  const f = {};
  for (const p of list) {
    rt.sample(p.s, f);
    const d = drawSign(p);
    if (!d) continue;
    const tex = canvasTexture(d.c);
    tex.anisotropy = 4;
    const i = f.i;
    const R = rt.rightEdge(i), Lw = rt.leftEdge(i), W = rt.width[i];
    const fwd = [f.tx, 0, f.tz], up = [0, 1, 0], right = [-f.tz, 0, f.tx];
    const at = (lat, h) => [f.x + right[0] * lat, f.y + h, f.z + right[2] * lat];
    if (p.type === 'gantry') {
      // 문형식: 양쪽 기둥 + 들보, 판 두 개
      const postL = -Lw - 0.15, postR = R + 1.8;
      for (const lat of [postL, postR]) solid.box(at(lat, 3.9), fwd, up, right, 0.25, 3.9, 0.25, POST);
      const span = postR - postL;
      solid.box(at((postL + postR) / 2, 7.55), fwd, up, right, 0.35, 0.3, span / 2, POST);
      const exitLat = p.exitSide < 0 ? -W / 2 + d.w2 / 2 : W / 2 - d.w2 / 2 + 0.6;
      const thrLat = p.exitSide < 0 ? exitLat + d.w2 / 2 + 0.4 + d.w / 2 : Math.max(-W / 2 + d.w / 2 - 0.3, exitLat - d.w2 / 2 - 0.4 - d.w / 2);
      addPanel(group, tex, origin, f, thrLat, 4.75, d.w, d.h);
      const tex2 = canvasTexture(d.c2);
      tex2.anisotropy = 4;
      addPanel(group, tex2, origin, f, exitLat, 4.75, d.w2, d.h2);
      for (const [lat, w] of [[thrLat, d.w], [exitLat, d.w2]]) solid.box([at(lat, 6.2)[0] + f.tx * 0.06, f.y + 6.2, at(lat, 6.2)[2] + f.tz * 0.06], fwd, up, right, 0.04, 1.45, w / 2, BACK);
      continue;
    }
    if (p.type === 'advance' || p.type === 'distance' || p.type === 'rest' || p.type === 'shelter' || p.type === 'boundary' || p.type === 'tunnel' || p.type === 'slogan') {
      const lat = R + 1.6 + d.w / 2;
      const bottom = p.type === 'advance' ? 2.4 : 1.9;
      addPanel(group, tex, origin, f, lat, bottom, d.w, d.h);
      solid.box([at(lat, 0)[0] + f.tx * 0.06, f.y + bottom + d.h / 2, at(lat, 0)[2] + f.tz * 0.06], fwd, up, right, 0.04, d.h / 2, d.w / 2, BACK);
      const postH = bottom + d.h;
      for (const q of d.w > 2.5 ? [-d.w / 3, d.w / 3] : [0]) solid.box(at(lat + q, postH / 2 - 0.3), fwd, up, right, 0.09, postH / 2 + 0.3, 0.09, POST);
      continue;
    }
    if (p.type === 'speed') {
      const lat = R + 1.3;
      addPanel(group, tex, origin, f, lat, 2.0, d.w, d.h);
      solid.box(at(lat, 1.3), fwd, up, right, 0.05, 1.6, 0.05, POST);
      continue;
    }
    if (p.type === 'km') {
      const lat = R + 0.9;
      addPanel(group, tex, origin, f, lat, 0.75, d.w, d.h);
      solid.box(at(lat, 0.5), fwd, up, right, 0.03, 0.6, 0.03, POST);
    }
  }
  B.build(group, { solid: postMat });
}
