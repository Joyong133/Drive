// 운전면허시험장 환경: 도로·차선·경사로·직각주차·신호교차로·건물·나무
import * as THREE from 'three';
import { ROAD, HILL_X0, HILL_X1, heightAt, hillProfile } from './course.js';
import {
  GeoBatch, labelTexture, drawLabel, noiseTexture, matrixFrom, makeCanvas, canvasTexture, randRange, roundRect, FONT,
} from './util.js';
import { buildCarModel } from './carModel.js';

const Y_ROAD = 0.02;
const Y_LINE = 0.034;

// 경로를 따라가는 띠(노면·차선) 지오메트리
function ribbon(course, s0, s1, d0, d1, yOff, step = 0.5, uvScale = 4) {
  const n = Math.max(1, Math.ceil(Math.abs(s1 - s0) / step));
  const pos = [], uv = [], idx = [];
  for (let i = 0; i <= n; i++) {
    const s = s0 + ((s1 - s0) * i) / n;
    const a = course.pointAt(s, d0);
    const b = course.pointAt(s, d1);
    pos.push(a.x, heightAt(a.x, a.z) + yOff, a.z, b.x, heightAt(b.x, b.z) + yOff, b.z);
    uv.push(d0 / uvScale, s / uvScale, d1 / uvScale, s / uvScale);
    if (i < n) {
      const k = i * 2;
      idx.push(k, k + 1, k + 2, k + 1, k + 3, k + 2);
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  g.setIndex(idx);
  g.computeVertexNormals();
  return g;
}

// 연석(윗면 + 양 옆면)
function curb(course, s0, s1, d0, d1, h = 0.13, step = 0.5) {
  const top = ribbon(course, s0, s1, d0, d1, h, step, 1);
  const side = (d) => {
    const n = Math.max(1, Math.ceil(Math.abs(s1 - s0) / step));
    const pos = [], idx = [];
    for (let i = 0; i <= n; i++) {
      const s = s0 + ((s1 - s0) * i) / n;
      const p = course.pointAt(s, d);
      const y = heightAt(p.x, p.z);
      pos.push(p.x, y, p.z, p.x, y + h, p.z);
      if (i < n) { const k = i * 2; idx.push(k, k + 2, k + 1, k + 1, k + 2, k + 3); }
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    g.setIndex(idx);
    g.computeVertexNormals();
    return g;
  };
  return [top, side(d0), side(d1)];
}

// 차선 그리기 헬퍼: 특정 s 구간을 제외하고 그림
function spans(s0, s1, gaps) {
  const out = [];
  let cur = s0;
  const sorted = [...gaps].sort((a, b) => a[0] - b[0]);
  for (const [g0, g1] of sorted) {
    if (g1 <= cur || g0 >= s1) continue;
    if (g0 > cur) out.push([cur, g0]);
    cur = Math.max(cur, g1);
  }
  if (cur < s1) out.push([cur, s1]);
  return out;
}

function skyMaterial() {
  return new THREE.ShaderMaterial({
    side: THREE.BackSide,
    depthWrite: false,
    fog: false,
    uniforms: {
      top: { value: new THREE.Color(0x3d7fd9) },
      mid: { value: new THREE.Color(0x9cc7f2) },
      horizon: { value: new THREE.Color(0xe6f1fb) },
    },
    vertexShader: `varying vec3 vP; void main(){ vP = normalize(position); gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }`,
    fragmentShader: `uniform vec3 top; uniform vec3 mid; uniform vec3 horizon; varying vec3 vP;
      void main(){ float h = vP.y; vec3 c = h > 0.0 ? mix(horizon, mix(mid, top, smoothstep(0.15, 0.8, h)), smoothstep(0.0, 0.15, h)) : horizon;
      gl_FragColor = vec4(c, 1.0); }`,
  });
}

class TrafficSignal {
  constructor(heads, crossHeads) {
    this.heads = heads;         // 우리 방향 신호등
    this.crossHeads = crossHeads; // 교차 도로 신호등
    this.state = 'green';
    this.age = 0;
    this.decided = false;
    this.armDelay = 0;
    this.redDur = 9;
    this.redChance = 0.65;
    this.apply();
  }

  set(state) {
    this.state = state;
    this.age = 0;
    this.apply();
  }

  apply() {
    const on = { red: this.state === 'red', yellow: this.state === 'yellow', green: this.state === 'green' || this.state === 'armed' };
    for (const h of this.heads) {
      h.red.color.setHex(on.red ? 0xff2a2a : 0x3a0d0d);
      h.yellow.color.setHex(on.yellow ? 0xffc21a : 0x3a2a08);
      h.green.color.setHex(on.green ? 0x22ff88 : 0x0b2a18);
      h.arrow.color.setHex(0x0b2a18);
    }
    const crossGreen = this.state === 'red' && this.age > 1.2;
    for (const h of this.crossHeads) {
      h.red.color.setHex(!crossGreen ? 0xff2a2a : 0x3a0d0d);
      h.yellow.color.setHex(0x3a2a08);
      h.green.color.setHex(crossGreen ? 0x22ff88 : 0x0b2a18);
      h.arrow.color.setHex(0x0b2a18);
    }
  }

  // dist: 앞범퍼에서 정지선까지 거리(+면 정지선 전)
  update(dt, dist, v) {
    this.age += dt;
    switch (this.state) {
      case 'green':
        if (!this.decided && dist > 6 && dist < 42) {
          this.decided = true;
          if (Math.random() < this.redChance) {
            this.state = 'armed';
            this.armDelay = randRange(0.3, 2.5);
          }
        }
        if (dist > 70 || dist < -30) this.decided = false;
        break;
      case 'armed':
        this.armDelay -= dt;
        // 편안하게 설 수 있는 거리일 때만 황색으로 (갑자기 못 서는 상황 방지)
        if (this.armDelay <= 0 && dist > (v * v) / (2 * 2.5) + 2.5) this.set('yellow');
        else if (dist < 2) this.state = 'green';
        break;
      case 'yellow':
        if (this.age > 3) { this.set('red'); this.redDur = randRange(7, 10); }
        break;
      case 'red':
        if (this.age > 1.2 && this.age - dt <= 1.2) this.apply();
        if (this.age > this.redDur) this.set('green');
        break;
      default: break;
    }
  }
}

// 움직이지 않는 장식용 차: 재질별로 합쳐서 드로우콜 절약
function bakeStatic(obj, parent) {
  obj.updateMatrixWorld(true);
  const batch = new GeoBatch();
  obj.traverse((o) => {
    if (o.isMesh && !Array.isArray(o.material)) batch.add(o.geometry, o.material, o.matrixWorld);
  });
  batch.build(parent, 'parked-car');
}

export function buildWorld(scene, course, renderer) {
  const z = course.zones;
  const root = new THREE.Group();
  scene.add(root);

  // ── 하늘, 안개, 조명
  scene.background = new THREE.Color(0xcfe3f7);
  scene.fog = new THREE.Fog(0xd8e8f8, 160, 760);
  const sky = new THREE.Mesh(new THREE.SphereGeometry(900, 24, 16), skyMaterial());
  sky.renderOrder = -10;
  scene.add(sky);
  const hemi = new THREE.HemisphereLight(0xdbeaff, 0x7a7466, 1.35);
  scene.add(hemi);
  const sun = new THREE.DirectionalLight(0xfff3dd, 2.1);
  sun.position.set(-120, 200, 80);
  scene.add(sun);

  // 차체 반사용 환경맵 (하늘 + 지면)
  try {
    const envScene = new THREE.Scene();
    envScene.add(new THREE.Mesh(new THREE.SphereGeometry(50, 16, 12), skyMaterial()));
    const gnd = new THREE.Mesh(new THREE.CircleGeometry(49, 24), new THREE.MeshBasicMaterial({ color: 0x5b6b4a }));
    gnd.rotation.x = -Math.PI / 2;
    gnd.position.y = -2;
    envScene.add(gnd);
    const pmrem = new THREE.PMREMGenerator(renderer);
    scene.environment = pmrem.fromScene(envScene, 0.02).texture;
    pmrem.dispose();
  } catch (e) {
    console.warn('환경맵 생성 실패', e);
  }

  // ── 재질
  const grassTex = noiseTexture(256, 256, '#5f8f3e', 46, { greenBias: 1.3 });
  grassTex.repeat.set(160, 160);
  const asphaltTex = noiseTexture(256, 256, '#44474d', 22, { speckle: 1400 });
  const concreteTex = noiseTexture(128, 128, '#b8b4ab', 18);
  const M = {
    grass: new THREE.MeshLambertMaterial({ map: grassTex }),
    asphalt: new THREE.MeshLambertMaterial({ map: asphaltTex, polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -1 }),
    white: new THREE.MeshLambertMaterial({ color: 0xf4f4f0, emissive: 0x222222, polygonOffset: true, polygonOffsetFactor: -3, polygonOffsetUnits: -3 }),
    yellow: new THREE.MeshLambertMaterial({ color: 0xf3c02a, emissive: 0x221800, polygonOffset: true, polygonOffsetFactor: -3, polygonOffsetUnits: -3 }),
    stopYellow: new THREE.MeshLambertMaterial({ color: 0xffd23a, emissive: 0x332200, polygonOffset: true, polygonOffsetFactor: -3, polygonOffsetUnits: -3 }),
    curb: new THREE.MeshLambertMaterial({ map: concreteTex, side: THREE.DoubleSide }),
    curbRed: new THREE.MeshLambertMaterial({ color: 0xc8463b, side: THREE.DoubleSide }),
    wall: new THREE.MeshLambertMaterial({ map: concreteTex, side: THREE.DoubleSide }),
    metal: new THREE.MeshLambertMaterial({ color: 0x9aa3ad }),
    darkMetal: new THREE.MeshLambertMaterial({ color: 0x2b2f35 }),
    post: new THREE.MeshLambertMaterial({ color: 0xb9c0c8 }),
    building: new THREE.MeshLambertMaterial({ color: 0xe9e6df }),
    building2: new THREE.MeshLambertMaterial({ color: 0x9fb3c8 }),
    glass: new THREE.MeshLambertMaterial({ color: 0x5d7f9e, emissive: 0x0d1b2a }),
    roof: new THREE.MeshLambertMaterial({ color: 0x59606a }),
    trunk: new THREE.MeshLambertMaterial({ color: 0x6b4a2f }),
    leaf: new THREE.MeshLambertMaterial({ color: 0xffffff }),
    fence: new THREE.MeshLambertMaterial({ color: 0x4f7a5a }),
    stripe: new THREE.MeshLambertMaterial({ color: 0xffb21a }),
    mountain: new THREE.MeshLambertMaterial({ color: 0x6e8a7a }),
  };

  // ── 지면
  const ground = new THREE.Mesh(new THREE.PlaneGeometry(1600, 1600), M.grass);
  ground.rotation.x = -Math.PI / 2;
  root.add(ground);

  const T = course.total;
  const P = z.park;
  const SG = z.signal;
  const lw = ROAD.lineW;
  const hw = lw / 2;
  const box = [SG.crossS - SG.boxHalf, SG.crossS + SG.boxHalf];
  const parkSpan = [P.s0, P.s1];
  const bayOpen = [P.bayS - P.bayHalf - hw, P.bayS + P.bayHalf + hw];

  // ── 노면
  const road = new GeoBatch();
  road.add(ribbon(course, 0, T, ROAD.left - 0.2, ROAD.right + 0.2, Y_ROAD), M.asphalt);
  road.add(ribbon(course, P.s0, P.s1, P.leftD - 0.25, ROAD.left - 0.1, Y_ROAD), M.asphalt);
  road.add(ribbon(course, P.bayS - P.bayHalf - 0.2, P.bayS + P.bayHalf + 0.2, ROAD.right, P.bayD1 + 0.2, Y_ROAD), M.asphalt);

  // 교차 도로 (남북 방향, 막다른 길)
  const cross = course.pointAt(SG.crossS);
  const crossLen = 50;
  const cg = new THREE.PlaneGeometry(7.4, crossLen);
  cg.rotateX(-Math.PI / 2);
  road.add(cg, M.asphalt, matrixFrom(cross.x, Y_ROAD - 0.004, cross.z));

  // 출발 대기 공간 옆 주차장 (장식)
  const lot = new THREE.PlaneGeometry(26, 34);
  lot.rotateX(-Math.PI / 2);
  road.add(lot, M.asphalt, matrixFrom(-26, Y_ROAD - 0.005, 6));
  road.build(root, 'road');

  // ── 차선
  const lines = new GeoBatch();
  const addLine = (mat, s0, s1, d0, d1, step = 0.5) => lines.add(ribbon(course, s0, s1, d0, d1, Y_LINE, step), mat);
  // 오른쪽 흰 실선
  for (const [a, b] of spans(0, T, [box, bayOpen])) addLine(M.white, a, b, ROAD.right - hw, ROAD.right + hw);
  // 왼쪽 가장자리
  for (const [a, b] of spans(0, T, [box, parkSpan])) addLine(M.white, a, b, ROAD.left - hw, ROAD.left + hw);
  // 중앙선 (노란 복선)
  for (const [a, b] of spans(0, T, [box, [P.s0 + 2, P.s1 - 2]])) {
    addLine(M.yellow, a, b, ROAD.center - 0.17, ROAD.center - 0.07);
    addLine(M.yellow, a, b, ROAD.center + 0.07, ROAD.center + 0.17);
  }
  // 직각주차 구역 경계 + 주차칸
  addLine(M.white, P.s0, P.s1, P.leftD - hw, P.leftD + hw);
  addLine(M.white, P.s0 - hw, P.s0 + hw, P.leftD, ROAD.left, 0.2);
  addLine(M.white, P.s1 - hw, P.s1 + hw, P.leftD, ROAD.left, 0.2);
  addLine(M.yellow, P.bayS - P.bayHalf - hw, P.bayS - P.bayHalf + hw, P.bayD0, P.bayD1 + hw, 0.2);
  addLine(M.yellow, P.bayS + P.bayHalf - hw, P.bayS + P.bayHalf + hw, P.bayD0, P.bayD1 + hw, 0.2);
  addLine(M.yellow, P.bayS - P.bayHalf - hw, P.bayS + P.bayHalf + hw, P.bayD1 - hw, P.bayD1 + hw, 0.2);
  // 출발선, 종료선
  addLine(M.white, -0.2, 0.2, ROAD.center, ROAD.right, 0.2);
  addLine(M.white, z.finish - 0.2, z.finish + 0.2, ROAD.center, ROAD.right, 0.2);
  // 경사로 정지구간 (노란 박스)
  addLine(M.stopYellow, z.hill.stop0 - 0.1, z.hill.stop0 + 0.1, ROAD.center + 0.25, ROAD.right - 0.25, 0.2);
  addLine(M.stopYellow, z.hill.stop1 - 0.1, z.hill.stop1 + 0.1, ROAD.center + 0.25, ROAD.right - 0.25, 0.2);
  addLine(M.stopYellow, z.hill.stop0, z.hill.stop1, ROAD.center + 0.25, ROAD.center + 0.4, 0.25);
  addLine(M.stopYellow, z.hill.stop0, z.hill.stop1, ROAD.right - 0.4, ROAD.right - 0.25, 0.25);
  // 가속구간 시작/끝
  for (const s of [z.accel.s0, z.accel.s1]) addLine(M.white, s - 0.12, s + 0.12, ROAD.center, ROAD.right, 0.24);
  // 교차로: 정지선, 횡단보도
  addLine(M.white, SG.stopLine - 0.25, SG.stopLine + 0.25, ROAD.center, ROAD.right, 0.5);
  for (const sc of [SG.crossS - 5.6, SG.crossS + 5.6]) {
    for (let d = ROAD.left + 0.3; d < ROAD.right - 0.3; d += 0.9) {
      addLine(M.white, sc - 1.4, sc + 1.4, d, d + 0.45, 1.4);
    }
  }
  lines.build(root, 'lines');

  // 교차 도로 차선 (간단한 박스)
  const deco = new GeoBatch();
  {
    const c0 = course.pointAt(SG.crossS, ROAD.left - 0.2);
    const c1 = course.pointAt(SG.crossS, ROAD.right + 0.2);
    const zN = Math.min(c0.z, c1.z), zS = Math.max(c0.z, c1.z);
    const zEndN = cross.z - crossLen / 2, zEndS = cross.z + crossLen / 2;
    for (const [za, zb] of [[zEndN, zN - 0.2], [zS + 0.2, zEndS]]) {
      const len = zb - za, zc = (za + zb) / 2;
      deco.addBox(M.yellow, 0.1, 0.01, len, cross.x - 0.12, Y_LINE, zc);
      deco.addBox(M.yellow, 0.1, 0.01, len, cross.x + 0.12, Y_LINE, zc);
      deco.addBox(M.white, 0.15, 0.01, len, cross.x - 3.55, Y_LINE, zc);
      deco.addBox(M.white, 0.15, 0.01, len, cross.x + 3.55, Y_LINE, zc);
    }
    // 막다른 길 바리케이드
    for (const zz of [zEndN + 0.5, zEndS - 0.5]) {
      for (let i = -3; i <= 3; i++) {
        deco.addBox(i % 2 ? M.stripe : M.white, 1.0, 0.25, 0.12, cross.x + i * 1.0, 0.9, zz);
      }
      deco.addBox(M.darkMetal, 0.1, 1.0, 0.1, cross.x - 3.4, 0.5, zz);
      deco.addBox(M.darkMetal, 0.1, 1.0, 0.1, cross.x + 3.4, 0.5, zz);
    }
    // 교차 도로 정지선
    deco.addBox(M.white, 3.5, 0.01, 0.4, cross.x + 1.75, Y_LINE, zN - 6.5);
    deco.addBox(M.white, 3.5, 0.01, 0.4, cross.x - 1.75, Y_LINE, zS + 6.5);
  }

  // ── 연석
  const curbs = new GeoBatch();
  const addCurb = (s0, s1, d0, d1, mat = M.curb) => {
    for (const g of curb(course, s0, s1, d0, d1)) curbs.add(g, mat);
  };
  const hillSpan = [z.hill.s0 - 2.5, z.hill.s1 + 2.5];
  for (const [a, b] of spans(0, T, [box, bayOpen])) addCurb(a, b, ROAD.right + 0.2, ROAD.right + 0.45);
  for (const [a, b] of spans(0, T, [box, parkSpan])) addCurb(a, b, ROAD.left - 0.45, ROAD.left - 0.2);
  addCurb(P.s0, P.s1, P.leftD - 0.5, P.leftD - 0.25);
  addCurb(P.s0 - 0.25, P.s0, P.leftD - 0.5, ROAD.left - 0.2);
  addCurb(P.s1, P.s1 + 0.25, P.leftD - 0.5, ROAD.left - 0.2);
  addCurb(P.bayS - P.bayHalf - 0.45, P.bayS - P.bayHalf - 0.2, ROAD.right + 0.2, P.bayD1 + 0.45, M.curbRed);
  addCurb(P.bayS + P.bayHalf + 0.2, P.bayS + P.bayHalf + 0.45, ROAD.right + 0.2, P.bayD1 + 0.45, M.curbRed);
  addCurb(P.bayS - P.bayHalf - 0.2, P.bayS + P.bayHalf + 0.2, P.bayD1 + 0.2, P.bayD1 + 0.45, M.curbRed);
  // 경사로 양쪽 보도
  addCurb(hillSpan[0], hillSpan[1], ROAD.right + 0.45, HILL_X1 - 0.02);
  addCurb(hillSpan[0], hillSpan[1], HILL_X0 + 0.02, ROAD.left - 0.45);
  curbs.build(root, 'curbs');

  // ── 경사로 옹벽 + 난간
  const walls = new GeoBatch();
  for (const x of [HILL_X0 + 0.02, HILL_X1 - 0.02]) {
    const n = 90;
    const pos = [], idx = [];
    for (let i = 0; i <= n; i++) {
      const s = z.hill.s0 - 2.5 + ((z.hill.s1 - z.hill.s0 + 5) * i) / n;
      const top = hillProfile(s) + 0.13;
      pos.push(x, -0.05, -s, x, top, -s);
      if (i < n) { const k = i * 2; idx.push(k, k + 2, k + 1, k + 1, k + 2, k + 3); }
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    g.setIndex(idx);
    g.computeVertexNormals();
    walls.add(g, M.wall);
    // 난간 기둥
    for (let s = z.hill.s0; s <= z.hill.s1; s += 2.5) {
      const y = hillProfile(s) + 0.13;
      walls.addBox(M.metal, 0.06, 0.9, 0.06, x, y + 0.45, -s);
    }
  }
  walls.build(root, 'walls');
  // 난간 레일
  const rails = new GeoBatch();
  for (const x of [HILL_X0 + 0.02, HILL_X1 - 0.02]) {
    for (const yo of [0.55, 0.9]) {
      const n = 40;
      for (let i = 0; i < n; i++) {
        const sa = z.hill.s0 + ((z.hill.s1 - z.hill.s0) * i) / n;
        const sb = z.hill.s0 + ((z.hill.s1 - z.hill.s0) * (i + 1)) / n;
        const ya = hillProfile(sa) + 0.13 + yo, yb = hillProfile(sb) + 0.13 + yo;
        const len = Math.hypot(sb - sa, yb - ya);
        rails.addBox(M.metal, 0.05, 0.05, len, x, (ya + yb) / 2, -(sa + sb) / 2, 0, Math.atan2(yb - ya, sb - sa));
      }
    }
  }
  rails.build(root, 'rails');

  // ── 표지판 (모든 글자를 텍스처 하나에 모아 한 번에 그림)
  const signs = new GeoBatch();
  const signSpecs = [];
  const addSign = (s, lines2, opts = {}) => signSpecs.push({ s, lines: lines2, opts });
  addSign(z.startLine + 1.5, ['출발', { text: '좌측 깜빡이 → 출발', size: 44 }], { bg: '#167a3e' });
  addSign(z.hill.s0 - 6, ['경사로', { text: '정지구간에서 정지', size: 44 }]);
  addSign(z.hill.stop0 - 0.5, [{ text: '▼ 정지구간', size: 70 }], { bg: '#e2a400', fg: '#1b1b1b', w: 1.4, h: 0.5, poleH: 1.4, d: ROAD.right + 1.0 });
  addSign(P.s0 - 10, ['직각주차', { text: '후진 주차 → 주차브레이크', size: 44 }]);
  addSign(SG.stopLine - 22, ['신호교차로', { text: '정지선 지키기', size: 44 }]);
  addSign(z.sudden.s0 - 3, ['돌발구간', { text: '경고 시 즉시 정지', size: 44 }], { bg: '#b3261e' });
  addSign(z.accel.s0 - 1, ['가속구간', { text: '20km/h 이상', size: 52 }], { bg: '#167a3e' });
  addSign(z.accel.s1, ['가속구간 끝', { text: '감속하세요', size: 48 }], { bg: '#555' });
  addSign(z.finish - 3, ['종료', { text: '종료선 통과 후 정지', size: 44 }], { bg: '#167a3e' });
  for (const t of z.turns) {
    addSign(t.s0 - 12, [t.dir > 0 ? '우회전 ↱' : '↰ 좌회전', { text: '방향지시등 켜기', size: 44 }], { w: 1.3, h: 0.65, size: 80, bg: '#2a4f8a' });
  }
  {
    const AW = 2048, SW = 512;
    let x = 0, y = 0, rowH = 0;
    for (const sp of signSpecs) {
      const w = sp.opts.w ?? 1.6, hgt = sp.opts.h ?? 0.8;
      sp.px = { w: SW, h: Math.round((SW * hgt) / w) };
      if (x + SW > AW) { x = 0; y += rowH; rowH = 0; }
      sp.slot = { x, y };
      x += SW;
      rowH = Math.max(rowH, sp.px.h);
    }
    const AH = THREE.MathUtils.ceilPowerOfTwo(y + rowH);
    const atlas = makeCanvas(AW, AH);
    const actx = atlas.getContext('2d');
    for (const sp of signSpecs) {
      drawLabel(actx, sp.slot.x, sp.slot.y, sp.px.w, sp.px.h, sp.lines, {
        bg: sp.opts.bg ?? '#1d5fc4', fg: sp.opts.fg ?? '#fff', size: sp.opts.size ?? 92,
      });
    }
    const atlasTex = canvasTexture(atlas);
    const signMat = new THREE.MeshLambertMaterial({ map: atlasTex, emissive: 0x333333, emissiveMap: atlasTex });
    for (const sp of signSpecs) {
      const d = sp.opts.d ?? ROAD.right + 1.4;
      const p = course.pointAt(sp.s, d);
      const y0 = heightAt(p.x, p.z);
      const w = sp.opts.w ?? 1.6, hgt = sp.opts.h ?? 0.8;
      const poleH = sp.opts.poleH ?? 2.2;
      signs.addBox(M.post, 0.08, poleH + hgt / 2, 0.08, p.x, y0 + (poleH + hgt / 2) / 2, p.z);
      const face = new THREE.PlaneGeometry(w, hgt);
      const uv = face.attributes.uv;
      for (let i = 0; i < uv.count; i++) {
        const u = uv.getX(i), v = uv.getY(i);
        uv.setXY(i, (sp.slot.x + u * sp.px.w) / AW, 1 - (sp.slot.y + (1 - v) * sp.px.h) / AH);
      }
      const cy = y0 + poleH + hgt / 2;
      signs.add(face, signMat, matrixFrom(p.x, cy, p.z, -p.h));
      // 뒷면: 진행 방향 쪽으로 1cm 물러난 반대 방향 판
      const back = new THREE.PlaneGeometry(w, hgt);
      const fx = Math.sin(p.h) * 0.01, fz = -Math.cos(p.h) * 0.01;
      signs.add(back, M.darkMetal, matrixFrom(p.x + fx, cy, p.z + fz, -p.h + Math.PI));
    }
  }
  signs.build(root, 'sign-posts');

  // 노면 글자
  const roadText = (s, text, d = 0, color = '#f4f4f0', size = 2.4) => {
    const c = makeCanvas(512, 256);
    const g = c.getContext('2d');
    g.fillStyle = color;
    g.font = `900 180px ${FONT}`;
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    g.fillText(text, 256, 140);
    const tex = canvasTexture(c);
    const m = new THREE.Mesh(
      new THREE.PlaneGeometry(size, size / 2),
      new THREE.MeshLambertMaterial({ map: tex, transparent: true, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -4, polygonOffsetUnits: -4 }),
    );
    const p = course.pointAt(s, d);
    m.position.set(p.x, heightAt(p.x, p.z) + Y_LINE + 0.004, p.z);
    m.rotation.set(-Math.PI / 2, -p.h, 0, 'YXZ');
    root.add(m);
  };
  roadText(2.2, '출발');
  roadText(z.finish + 2.4, '종료');
  roadText(P.bayS, 'P', (P.bayD0 + P.bayD1) / 2 + 1, '#f3c02a', 2.2);
  roadText(z.accel.s0 + 3, '가속', 0, '#f4f4f0', 2.2);
  roadText(SG.stopLine - 4, '정지', 0, '#f4f4f0', 2.2);

  // ── 신호등
  const lampGeo = new THREE.CircleGeometry(0.13, 20);
  const arrowTex = (() => {
    const c = makeCanvas(64, 64);
    const g = c.getContext('2d');
    g.fillStyle = '#fff';
    g.beginPath(); g.moveTo(10, 32); g.lineTo(30, 14); g.lineTo(30, 26); g.lineTo(54, 26); g.lineTo(54, 38); g.lineTo(30, 38); g.lineTo(30, 50); g.closePath(); g.fill();
    return canvasTexture(c);
  })();
  // 같은 방향 신호등끼리는 재질을 공유 → 하나로 합쳐 그려도 색 변경이 그대로 적용됨
  const lampSet = () => ({
    red: new THREE.MeshBasicMaterial({ color: 0x222222 }),
    yellow: new THREE.MeshBasicMaterial({ color: 0x222222 }),
    arrow: new THREE.MeshBasicMaterial({ color: 0x222222, map: arrowTex }),
    green: new THREE.MeshBasicMaterial({ color: 0x222222 }),
  });
  const mainLamps = lampSet();
  const crossLamps = lampSet();
  const makeHead = (parent, L) => {
    const head = new THREE.Group();
    head.add(new THREE.Mesh(new THREE.BoxGeometry(1.32, 0.38, 0.26), M.darkMetal));
    const lamp = (x, mat) => {
      const m = new THREE.Mesh(lampGeo, mat);
      m.position.set(x, 0, 0.135);
      head.add(m);
      const visor = new THREE.Mesh(new THREE.BoxGeometry(0.3, 0.02, 0.14), M.darkMetal);
      visor.position.set(x, 0.15, 0.2);
      head.add(visor);
    };
    lamp(-0.46, L.red); lamp(-0.155, L.yellow); lamp(0.155, L.arrow); lamp(0.46, L.green);
    parent.add(head);
    return head;
  };
  const signalRoot = new THREE.Group();
  {
    // 우리 방향: 교차로 건너편 오른쪽 기둥 + 차로 위로 뻗은 암
    const p = course.pointAt(SG.crossS + SG.boxHalf + 1.5, ROAD.right + 1.0);
    const pole = new THREE.Group();
    pole.position.set(p.x, 0, p.z);
    pole.rotation.y = -p.h;
    signalRoot.add(pole);
    pole.add(new THREE.Mesh(new THREE.CylinderGeometry(0.12, 0.15, 6, 10), M.post).translateY(3));
    const arm = new THREE.Mesh(new THREE.BoxGeometry(4.2, 0.12, 0.12), M.post);
    arm.position.set(-2.0, 5.6, 0);
    pole.add(arm);
    makeHead(pole, mainLamps).position.set(-2.6, 5.25, 0.05);
    const h2 = makeHead(pole, mainLamps);
    h2.position.set(0, 3.1, 0.2);
    h2.scale.setScalar(0.8);
    // 교차 도로 신호등
    for (const [dx, dz, ry] of [[4.6, -9.5, 0], [-4.6, 9.5, Math.PI]]) {
      const cp = new THREE.Group();
      cp.position.set(cross.x + dx, 0, cross.z + dz);
      cp.rotation.y = ry;
      signalRoot.add(cp);
      cp.add(new THREE.Mesh(new THREE.CylinderGeometry(0.1, 0.12, 4.2, 8), M.post).translateY(2.1));
      const ch = makeHead(cp, crossLamps);
      ch.position.set(0, 4.0, 0.15);
      ch.scale.setScalar(0.8);
    }
  }
  bakeStatic(signalRoot, root);
  const heads = [mainLamps];
  const crossHeads = [crossLamps];
  const signal = new TrafficSignal(heads, crossHeads);

  // ── 돌발 경고등
  const alarmLamps = [];
  {
    const alarmMat = new THREE.MeshBasicMaterial({ color: 0x3a0808 });
    const gantryS = z.sudden.s0 + 2;
    const a = course.pointAt(gantryS, ROAD.left - 0.8);
    const b = course.pointAt(gantryS, ROAD.right + 0.8);
    for (const p of [a, b]) deco.addBox(M.post, 0.18, 5.2, 0.18, p.x, 2.6, p.z);
    const mid = course.pointAt(gantryS, (ROAD.left + ROAD.right) / 2);
    const span = Math.hypot(b.x - a.x, b.z - a.z);
    deco.addBox(M.post, span, 0.3, 0.3, mid.x, 5.2, mid.z, -mid.h);
    const panel = new THREE.Mesh(new THREE.PlaneGeometry(2.6, 0.9), new THREE.MeshBasicMaterial({ map: labelTexture('돌발', { bg: '#200', fg: '#ff3030', border: '#400', size: 120 }) }));
    const pp = course.pointAt(gantryS, ROAD.center + 1.75);
    panel.position.set(pp.x, 4.6, pp.z);
    panel.rotation.y = -pp.h;
    panel.material.color.setHex(0x444444);
    root.add(panel);
    alarmLamps.push({ mat: panel.material, kind: 'panel' });
    for (const s of [z.sudden.s0 + 6, z.sudden.s0 + 16, z.sudden.s0 + 26]) {
      const p = course.pointAt(s, ROAD.right + 1.2);
      deco.addBox(M.darkMetal, 0.1, 1.6, 0.1, p.x, 0.8, p.z);
      const lamp = new THREE.Mesh(new THREE.SphereGeometry(0.16, 12, 8), alarmMat);
      lamp.position.set(p.x, 1.7, p.z);
      root.add(lamp);
    }
    alarmLamps.push({ mat: alarmMat, kind: 'lamp' });
  }

  // ── 건물: 시험장 본관, 관제탑, 대기실
  const bld = new GeoBatch();
  bld.addBox(M.building, 14, 9, 32, -26, 4.5, -30);
  bld.addBox(M.roof, 14.6, 0.5, 32.6, -26, 9.25, -30);
  for (let i = 0; i < 7; i++) {
    bld.addBox(M.glass, 0.1, 2.0, 3.2, -18.95, 2.4, -43 + i * 4.3);
    bld.addBox(M.glass, 0.1, 2.0, 3.2, -18.95, 6.4, -43 + i * 4.3);
  }
  bld.addBox(M.glass, 0.2, 3.2, 4.5, -18.95, 1.6, -30);
  // 관제탑 (코스 안쪽)
  bld.addBox(M.building, 5, 9, 5, 38, 4.5, -52);
  bld.addBox(M.glass, 7, 2.6, 7, 38, 10.3, -52);
  bld.addBox(M.roof, 7.6, 0.4, 7.6, 38, 11.8, -52);
  // 정비고/대기실
  bld.addBox(M.building2, 18, 5, 10, 60, 2.5, 46);
  bld.addBox(M.roof, 18.6, 0.4, 10.6, 60, 5.2, 46);
  bld.addBox(M.building2, 10, 4, 14, 158, 2, -10);
  bld.addBox(M.roof, 10.6, 0.4, 14.6, 158, 4.2, -10);
  bld.build(root, 'buildings');
  {
    const tex = labelTexture(['VR 운전면허시험장', { text: 'VR DRIVING TEST CENTER', size: 40 }], { w: 1024, h: 256, bg: '#0f2a52', size: 96 });
    const sign = new THREE.Mesh(new THREE.PlaneGeometry(12, 3), new THREE.MeshLambertMaterial({ map: tex, emissive: 0x444444, emissiveMap: tex }));
    sign.position.set(-18.85, 7.2, -30);
    sign.rotation.y = Math.PI / 2;
    root.add(sign);
    const tTex = labelTexture('관제탑', { w: 512, h: 160, bg: '#0f2a52', size: 90 });
    for (const [x, zz, ry] of [[38, -48.4, 0], [41.6, -52, Math.PI / 2]]) {
      const t = new THREE.Mesh(new THREE.PlaneGeometry(3.6, 1.1), new THREE.MeshLambertMaterial({ map: tTex, emissive: 0x333333, emissiveMap: tTex }));
      t.position.set(x, 7.6, zz);
      t.rotation.y = ry;
      root.add(t);
    }
  }

  // 주차된 차들 (장식)
  const parked = [
    [0xd8dde4, -33, -2, 0], [0x22252b, -33, 4, 0], [0xb3122a, -33, 10, 0], [0x3b6e5a, -19, -2, Math.PI], [0xf0f0f0, -19, 10, Math.PI],
  ];
  const parkedRoot = new THREE.Group();
  for (const [color, x, zz, ry] of parked) {
    const m = buildCarModel({ color, interior: false, lite: true });
    m.root.position.set(x, 0, zz);
    m.root.rotation.y = ry + Math.PI / 2;
    parkedRoot.add(m.root);
  }
  bakeStatic(parkedRoot, root);

  // ── 울타리
  const F = { x0: -48, x1: 178, z0: -121, z1: 61 };
  const fence = new GeoBatch();
  const fenceSide = (x0, z0, x1, z1) => {
    const len = Math.hypot(x1 - x0, z1 - z0);
    const n = Math.ceil(len / 4);
    const ang = Math.atan2(x1 - x0, z1 - z0);
    for (let i = 0; i <= n; i++) {
      const t = i / n;
      fence.addBox(M.fence, 0.08, 1.8, 0.08, x0 + (x1 - x0) * t, 0.9, z0 + (z1 - z0) * t);
    }
    for (const y of [0.5, 1.1, 1.7]) fence.addBox(M.fence, 0.04, 0.04, len, (x0 + x1) / 2, y, (z0 + z1) / 2, ang);
  };
  fenceSide(F.x0, F.z0, F.x1, F.z0);
  fenceSide(F.x1, F.z0, F.x1, F.z1);
  fenceSide(F.x1, F.z1, F.x0, F.z1);
  fenceSide(F.x0, F.z1, F.x0, F.z0);
  fence.build(root, 'fence');
  deco.build(root, 'deco');

  // ── 나무 (인스턴싱)
  const treePos = [];
  const nearRoad = (x, zz) => {
    const p = course.project(x, zz);
    return p.dist < 11;
  };
  const inRect = (x, zz, x0, z0, x1, z1) => x > x0 && x < x1 && zz > z0 && zz < z1;
  let guard = 0;
  while (treePos.length < 190 && guard++ < 6000) {
    const ring = Math.random() < 0.6;
    const x = ring ? randRange(-110, 240) : randRange(-40, 170);
    const zz = ring ? randRange(-180, 120) : randRange(-115, 55);
    if (ring && inRect(x, zz, F.x0 - 4, F.z0 - 4, F.x1 + 4, F.z1 + 4)) continue;
    if (!ring && nearRoad(x, zz)) continue;
    if (inRect(x, zz, -36, -50, -15, 20) || inRect(x, zz, 30, -60, 46, -44) || inRect(x, zz, 48, 38, 72, 54)) continue;
    if (inRect(x, zz, 90, -70, 114, -10)) continue; // 교차 도로
    treePos.push([x, zz, randRange(0.8, 1.4)]);
  }
  const trunkGeo = new THREE.CylinderGeometry(0.18, 0.26, 2.4, 6);
  trunkGeo.translate(0, 1.2, 0);
  const crownGeo = new THREE.IcosahedronGeometry(1.8, 0);
  crownGeo.translate(0, 3.6, 0);
  const trunks = new THREE.InstancedMesh(trunkGeo, M.trunk, treePos.length);
  const crowns = new THREE.InstancedMesh(crownGeo, M.leaf, treePos.length);
  const mtx = new THREE.Matrix4();
  const col = new THREE.Color();
  treePos.forEach(([x, zz, s], i) => {
    mtx.compose(new THREE.Vector3(x, 0, zz), new THREE.Quaternion().setFromEuler(new THREE.Euler(0, Math.random() * 6, 0)), new THREE.Vector3(s, s * randRange(0.9, 1.2), s));
    trunks.setMatrixAt(i, mtx);
    crowns.setMatrixAt(i, mtx);
    col.setHSL(randRange(0.24, 0.34), randRange(0.35, 0.55), randRange(0.25, 0.38));
    crowns.setColorAt(i, col);
  });
  root.add(trunks, crowns);

  // 먼 산
  const mountains = new GeoBatch();
  for (let i = 0; i < 14; i++) {
    const a = (i / 14) * Math.PI * 2 + randRange(-0.1, 0.1);
    const r = randRange(380, 520);
    const h = randRange(40, 110);
    const g = new THREE.ConeGeometry(randRange(90, 170), h, 7);
    mountains.add(g, M.mountain, matrixFrom(60 + Math.cos(a) * r, h / 2 - 2, -30 + Math.sin(a) * r, randRange(0, 3)));
  }
  mountains.build(root, 'mountains');

  // ── 교차로를 지나가는 차 (적색 신호일 때)
  const npc = buildCarModel({ color: 0xe8e8ea, interior: false, lite: true });
  npc.root.visible = false;
  root.add(npc.root);
  const npcState = { active: false, z: 0, dir: 1, v: 9, done: false };

  let alarmOn = false;
  let alarmT = 0;

  return {
    root,
    signal,
    setAlarm(on) { alarmOn = on; alarmT = 0; if (!on) for (const l of alarmLamps) l.mat.color.setHex(l.kind === 'panel' ? 0x444444 : 0x3a0808); },
    update(dt, car) {
      // 신호등: 앞범퍼에서 정지선까지 거리
      let front = course.wrapS(car.frontS());
      let dist = SG.stopLine - front;
      if (dist > T / 2) dist -= T;
      if (dist < -T / 2) dist += T;
      signal.update(dt, dist, Math.max(0, car.v));

      // 교차 차량
      if (signal.state === 'red' && signal.age > 1.5 && !npcState.active && !npcState.done) {
        npcState.active = true;
        npcState.dir = Math.random() < 0.5 ? 1 : -1;
        npcState.z = cross.z - npcState.dir * (crossLen / 2 - 3);
      }
      if (signal.state !== 'red') npcState.done = false;
      if (npcState.active) {
        npcState.z += npcState.dir * npcState.v * dt;
        npc.root.visible = true;
        npc.root.position.set(cross.x - npcState.dir * 1.75, 0, npcState.z);
        npc.root.rotation.set(0, npcState.dir > 0 ? Math.PI : 0, 0);
        for (const w of npc.wheels) w.spin.rotation.x -= (npcState.v * dt) / 0.37;
        if (Math.abs(npcState.z - cross.z) > crossLen / 2 - 2) {
          npcState.active = false;
          npcState.done = true;
          npc.root.visible = false;
        }
      }

      // 돌발 경고등 점멸
      if (alarmOn) {
        alarmT += dt;
        const on = (alarmT % 0.5) < 0.28;
        for (const l of alarmLamps) {
          l.mat.color.setHex(on ? (l.kind === 'panel' ? 0xffffff : 0xff2020) : (l.kind === 'panel' ? 0x552222 : 0x3a0808));
        }
      }
    },
  };
}
