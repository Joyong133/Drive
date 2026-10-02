// 2026년형 전기 크로스오버 (가상의 최신형 차량) — 외장 + 실내 모델
// 차량 로컬 좌표: 앞쪽 = -Z, 오른쪽 = +X, 위 = +Y, 원점 = 차량 바닥 중심(앞/뒤 차축의 가운데)
import * as THREE from 'three';
import { makeCanvas, canvasTexture, roundRect, FONT, mergeStaticChildren } from './util.js';

export const CAR = {
  length: 4.72,
  width: 1.90,
  wheelbase: 2.9,
  track: 1.62,
  wheelR: 0.37,
  tireW: 0.24,
  eye: new THREE.Vector3(-0.38, 1.2, 0.3),
  wheelCenter: new THREE.Vector3(-0.38, 0.98, -0.2),
  wheelTilt: 0.4, // 스티어링 컬럼 각도(rad)
  rimR: 0.185,
  maxWheelAngle: (360 * Math.PI) / 180, // 핸들 최대 회전(한쪽). 설정 '핸들 감도'로 바뀜
};

const tmpV = new THREE.Vector3();

// 두 점 사이에 놓인 막대(필러 등)
function beam(p1, p2, w, d, mat) {
  const m = new THREE.Mesh(new THREE.BoxGeometry(w, d, 1), mat);
  placeBeltPart(m, p1, p2);
  return m;
}

// 옆모습 프로파일(Shape: x=앞쪽, y=위)을 차폭 방향으로 돌출
function extrudeSide(shape, width, bevelT, bevelS) {
  const depth = width - bevelT * 2;
  const geo = new THREE.ExtrudeGeometry(shape, {
    depth,
    bevelEnabled: true,
    bevelThickness: bevelT,
    bevelSize: bevelS,
    bevelSegments: 4,
    curveSegments: 18,
    steps: 1,
  });
  geo.translate(0, 0, -depth / 2);
  geo.rotateY(Math.PI / 2); // shape x(앞) → -Z, 돌출 z → X
  return geo;
}

// 실내가 보이도록 차체 윗면(벨트라인) 중 실내 위를 덮는 삼각형 제거
function cutCabinTop(geo, zMin, zMax, yMin) {
  const pos = geo.attributes.position.array;
  const nor = geo.attributes.normal.array;
  const uv = geo.attributes.uv ? geo.attributes.uv.array : null;
  const keepP = [], keepN = [], keepU = [];
  for (let i = 0; i < pos.length; i += 9) {
    const cz = (pos[i + 2] + pos[i + 5] + pos[i + 8]) / 3;
    const cy = (pos[i + 1] + pos[i + 4] + pos[i + 7]) / 3;
    const ny = (nor[i + 1] + nor[i + 4] + nor[i + 7]) / 3;
    if (cz > zMin && cz < zMax && cy > yMin && ny > 0.25) continue;
    for (let k = 0; k < 9; k++) { keepP.push(pos[i + k]); keepN.push(nor[i + k]); }
    if (uv) { const j = (i / 3) * 2; for (let k = 0; k < 6; k++) keepU.push(uv[j + k]); }
  }
  const out = new THREE.BufferGeometry();
  out.setAttribute('position', new THREE.Float32BufferAttribute(keepP, 3));
  out.setAttribute('normal', new THREE.Float32BufferAttribute(keepN, 3));
  if (uv) out.setAttribute('uv', new THREE.Float32BufferAttribute(keepU, 2));
  geo.dispose();
  return out;
}

function bodyShape() {
  const s = new THREE.Shape();
  s.moveTo(-2.3, 0.3);
  s.lineTo(-1.94, 0.28);
  s.lineTo(-1.92, 0.37);
  s.absarc(-1.45, 0.37, 0.47, Math.PI, 0, true);
  s.lineTo(-0.98, 0.28);
  s.lineTo(0.98, 0.28);
  s.lineTo(0.98, 0.37);
  s.absarc(1.45, 0.37, 0.47, Math.PI, 0, true);
  s.lineTo(1.94, 0.28);
  s.lineTo(2.2, 0.3);
  s.quadraticCurveTo(2.35, 0.33, 2.36, 0.5);
  s.quadraticCurveTo(2.37, 0.72, 2.24, 0.8);
  s.quadraticCurveTo(1.8, 0.92, 1.15, 0.98);
  s.lineTo(-1.72, 1.02);
  s.quadraticCurveTo(-2.24, 1.03, -2.32, 0.88);
  s.quadraticCurveTo(-2.37, 0.6, -2.3, 0.3);
  return s;
}

function cabinShape() {
  const s = new THREE.Shape();
  s.moveTo(1.17, 0.96);
  s.quadraticCurveTo(0.8, 1.27, 0.3, 1.52);
  s.quadraticCurveTo(-0.6, 1.6, -1.38, 1.54);
  s.quadraticCurveTo(-1.95, 1.4, -2.16, 1.04);
  s.lineTo(-2.16, 0.95);
  s.lineTo(1.17, 0.95);
  return s;
}

function rimTexture() {
  const c = makeCanvas(256, 256);
  const g = c.getContext('2d');
  g.translate(128, 128);
  g.fillStyle = '#1a1c20';
  g.beginPath(); g.arc(0, 0, 127, 0, Math.PI * 2); g.fill();
  for (let i = 0; i < 5; i++) {
    g.save();
    g.rotate((i / 5) * Math.PI * 2);
    const grd = g.createLinearGradient(0, -120, 0, 0);
    grd.addColorStop(0, '#d7dce4');
    grd.addColorStop(1, '#8a93a3');
    g.fillStyle = grd;
    g.beginPath();
    g.moveTo(-10, -26); g.lineTo(-34, -118); g.lineTo(34, -118); g.lineTo(10, -26);
    g.closePath(); g.fill();
    g.fillStyle = '#2a2e36';
    g.beginPath();
    g.moveTo(-4, -40); g.lineTo(-14, -112); g.lineTo(14, -112); g.lineTo(4, -40);
    g.closePath(); g.fill();
    g.restore();
  }
  g.strokeStyle = '#c9ced8'; g.lineWidth = 8;
  g.beginPath(); g.arc(0, 0, 118, 0, Math.PI * 2); g.stroke();
  g.fillStyle = '#c9ced8';
  g.beginPath(); g.arc(0, 0, 26, 0, Math.PI * 2); g.fill();
  g.fillStyle = '#20242c';
  g.beginPath(); g.arc(0, 0, 16, 0, Math.PI * 2); g.fill();
  return canvasTexture(c);
}

function plateTexture(text) {
  const c = makeCanvas(512, 112);
  const g = c.getContext('2d');
  g.fillStyle = '#f4f6f8'; roundRect(g, 0, 0, 512, 112, 14); g.fill();
  g.strokeStyle = '#222'; g.lineWidth = 6; roundRect(g, 4, 4, 504, 104, 12); g.stroke();
  g.fillStyle = '#16181c';
  g.font = `900 72px ${FONT}`; g.textAlign = 'center'; g.textBaseline = 'middle';
  g.fillText(text, 256, 60);
  return canvasTexture(c);
}

export function buttonTexture(label, opts = {}) {
  const { bg = '#22262e', fg = '#e8eef8', size = 52, w = 128, h = 128, ring = null } = opts;
  const c = makeCanvas(w, h);
  const g = c.getContext('2d');
  g.fillStyle = bg; roundRect(g, 0, 0, w, h, 20); g.fill();
  if (ring) { g.strokeStyle = ring; g.lineWidth = 6; roundRect(g, 6, 6, w - 12, h - 12, 16); g.stroke(); }
  g.fillStyle = fg; g.font = `900 ${size}px ${FONT}`; g.textAlign = 'center'; g.textBaseline = 'middle';
  const lines = label.split('\n');
  lines.forEach((l, i) => g.fillText(l, w / 2, h / 2 + (i - (lines.length - 1) / 2) * size * 1.05));
  const t = canvasTexture(c);
  return t;
}

function hazardTexture() {
  const c = makeCanvas(128, 96);
  const g = c.getContext('2d');
  g.fillStyle = '#2a0c10'; roundRect(g, 0, 0, 128, 96, 16); g.fill();
  g.strokeStyle = '#ff3b4e'; g.lineWidth = 9;
  g.beginPath(); g.moveTo(64, 16); g.lineTo(104, 80); g.lineTo(24, 80); g.closePath(); g.stroke();
  g.lineWidth = 5;
  g.beginPath(); g.moveTo(64, 38); g.lineTo(84, 70); g.lineTo(44, 70); g.closePath(); g.stroke();
  return canvasTexture(c);
}

let liteShared = null;

function commonMaterials() {
  const sc = makeCanvas(128, 128);
  const sg = sc.getContext('2d');
  const grad = sg.createRadialGradient(64, 64, 10, 64, 64, 64);
  grad.addColorStop(0, 'rgba(0,0,0,0.75)');
  grad.addColorStop(1, 'rgba(0,0,0,0)');
  sg.fillStyle = grad;
  sg.fillRect(0, 0, 128, 128);
  return {
    black: new THREE.MeshStandardMaterial({ color: 0x0c0d10, metalness: 0.2, roughness: 0.5 }),
    glass: new THREE.MeshStandardMaterial({
      color: 0x05080e, metalness: 0.4, roughness: 0.04, transparent: true, opacity: 0.92, envMapIntensity: 1.6,
    }),
    chrome: new THREE.MeshStandardMaterial({ color: 0xc9ced8, metalness: 0.9, roughness: 0.2 }),
    rubber: new THREE.MeshStandardMaterial({ color: 0x141518, roughness: 0.9 }),
    linerMat: new THREE.MeshBasicMaterial({ color: 0x08090b, side: THREE.DoubleSide }),
    underMat: new THREE.MeshBasicMaterial({ color: 0x0a0a0c }),
    rimMat: new THREE.MeshStandardMaterial({ map: rimTexture(), metalness: 0.6, roughness: 0.35 }),
    shadowMat: new THREE.MeshBasicMaterial({ map: canvasTexture(sc), transparent: true, depthWrite: false }),
    mats: {
      drl: new THREE.MeshBasicMaterial({ color: 0xffffff }),
      head: new THREE.MeshBasicMaterial({ color: 0x9aa4b4 }),
      tail: new THREE.MeshBasicMaterial({ color: 0x5a0a10 }),
      brake: new THREE.MeshBasicMaterial({ color: 0x4a0a10 }),
      reverse: new THREE.MeshBasicMaterial({ color: 0x777777 }),
      turnL: new THREE.MeshBasicMaterial({ color: 0x4a2a00 }),
      turnR: new THREE.MeshBasicMaterial({ color: 0x4a2a00 }),
    },
  };
}

export function buildCarModel({ color = 0x1f6fff, interior = true, plate = '12가 2026', lite = false } = {}) {
  const root = new THREE.Group();
  root.rotation.order = 'YXZ';

  const paint = new THREE.MeshStandardMaterial({ color, metalness: 0.55, roughness: 0.32, envMapIntensity: 1.2 });
  // 장식용(lite) 차들은 공용 재질을 써서 하나로 합쳐 그릴 수 있게 함
  const C = lite ? (liteShared ||= commonMaterials()) : commonMaterials();
  const { black, glass, chrome, rubber, linerMat, underMat, rimMat, shadowMat } = C;
  const mats = C.mats;

  // ── 차체
  const body = new THREE.Mesh(cutCabinTop(extrudeSide(bodyShape(), 1.9, 0.07, 0.045), -1.1, 1.66, 0.9), paint);
  root.add(body);
  const cabin = new THREE.Mesh(extrudeSide(cabinShape(), 1.62, 0.07, 0.05), glass);
  cabin.renderOrder = 2;
  root.add(cabin);

  // 벨트라인 몰딩 (실내에서는 도어 상단 트림으로 보임)
  for (const sx of lite ? [] : [-1, 1]) {
    const sill = new THREE.Mesh(new THREE.BoxGeometry(0.16, 0.03, 2.8), black);
    sill.position.set(sx * 0.86, 1.0, 0.28);
    root.add(sill);
    // 도어 라인, 손잡이
    for (const z of [-0.98, 0.18, 1.2]) {
      const seam = new THREE.Mesh(new THREE.BoxGeometry(0.01, 0.6, 0.008), black);
      seam.position.set(sx * 0.993, 0.66, z);
      root.add(seam);
    }
    for (const z of [-0.3, 0.75]) {
      const handle = new THREE.Mesh(new THREE.BoxGeometry(0.012, 0.025, 0.22), chrome);
      handle.position.set(sx * 0.995, 0.86, z);
      root.add(handle);
    }
    // 루프레일
    const rail = new THREE.Mesh(new THREE.BoxGeometry(0.04, 0.03, 1.5), chrome);
    rail.position.set(sx * 0.6, 1.6, 0.5);
    root.add(rail);
    // 하단 블랙 클래딩
    const clad = new THREE.Mesh(new THREE.BoxGeometry(0.03, 0.1, 1.9), black);
    clad.position.set(sx * 0.985, 0.33, 0.0);
    root.add(clad);
  }

  // 휠하우스 안쪽 (차체 너머가 비쳐 보이지 않게)
  const linerGeo = new THREE.CylinderGeometry(0.47, 0.47, 1.86, 20, 1, true, -Math.PI / 2, Math.PI);
  linerGeo.rotateZ(Math.PI / 2);
  for (const z of [-1.45, 1.45]) {
    const liner = new THREE.Mesh(linerGeo, linerMat);
    liner.position.set(0, 0.37, z);
    root.add(liner);
  }
  // 차량 하부
  const under = new THREE.Mesh(new THREE.BoxGeometry(1.8, 0.05, 4.4), underMat);
  under.position.set(0, 0.27, 0);
  root.add(under);

  // ── 조명
  const addLight = (mat, w, h, d, x, y, z) => {
    if (lite && mat !== mats.drl && mat !== mats.tail) return null;
    const m = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), mat);
    m.position.set(x, y, z);
    root.add(m);
    return m;
  };
  addLight(mats.drl, 1.5, 0.026, 0.08, 0, 0.765, -2.33);           // 전면 일자형 LED
  addLight(mats.head, 0.3, 0.05, 0.06, -0.62, 0.66, -2.395);      // 헤드램프 (슬림 프로젝터)
  addLight(mats.head, 0.3, 0.05, 0.06, 0.62, 0.66, -2.395);
  addLight(mats.turnL, 0.16, 0.026, 0.06, -0.8, 0.745, -2.345);
  addLight(mats.turnR, 0.16, 0.026, 0.06, 0.8, 0.745, -2.345);
  addLight(mats.tail, 1.66, 0.04, 0.06, 0, 0.9, 2.355);           // 후면 일자형 라이트
  addLight(mats.brake, 0.34, 0.05, 0.05, -0.6, 0.83, 2.38);
  addLight(mats.brake, 0.34, 0.05, 0.05, 0.6, 0.83, 2.38);
  addLight(mats.brake, 0.4, 0.025, 0.05, 0, 1.43, 2.0);           // 보조 제동등
  addLight(mats.turnL, 0.14, 0.04, 0.05, -0.86, 0.83, 2.37);
  addLight(mats.turnR, 0.14, 0.04, 0.05, 0.86, 0.83, 2.37);
  addLight(mats.reverse, 0.14, 0.035, 0.05, -0.32, 0.5, 2.39);
  addLight(mats.reverse, 0.14, 0.035, 0.05, 0.32, 0.5, 2.39);
  // 전면 하단 공기흡입구 / 센서 패널, 후면 디퓨저
  if (!lite) {
    for (const [w, h, x, y, z] of [[1.24, 0.09, 0, 0.36, -2.36], [0.24, 0.07, -0.72, 0.42, -2.37], [0.24, 0.07, 0.72, 0.42, -2.37], [1.3, 0.08, 0, 0.36, 2.37]]) {
      const m = new THREE.Mesh(new THREE.BoxGeometry(w, h, 0.06), black);
      m.position.set(x, y, z);
      root.add(m);
    }
  }

  // 번호판
  if (!lite) {
  const plateTex = plateTexture(plate);
  const plateMat = new THREE.MeshBasicMaterial({ map: plateTex });
  const pf = new THREE.Mesh(new THREE.PlaneGeometry(0.52, 0.114), plateMat);
  pf.position.set(0, 0.5, -2.405); pf.rotation.y = Math.PI;
  root.add(pf);
  const pr = new THREE.Mesh(new THREE.PlaneGeometry(0.52, 0.114), plateMat);
  pr.position.set(0, 0.62, 2.395);
  root.add(pr);

  // 디지털 사이드미러(카메라) 포드
  for (const sx of [-1, 1]) {
    const pod = new THREE.Mesh(new THREE.BoxGeometry(0.1, 0.07, 0.16), black);
    pod.position.set(sx * 1.04, 0.99, -0.9);
    root.add(pod);
    const arm = new THREE.Mesh(new THREE.BoxGeometry(0.1, 0.03, 0.05), black);
    arm.position.set(sx * 0.98, 0.98, -0.9);
    root.add(arm);
    const rep = new THREE.Mesh(new THREE.BoxGeometry(0.04, 0.012, 0.1), sx < 0 ? mats.turnL : mats.turnR);
    rep.position.set(sx * 1.09, 0.99, -0.9);
    root.add(rep);
  }
  }

  // ── 바퀴
  const wheels = [];
  const tireGeo = new THREE.CylinderGeometry(CAR.wheelR, CAR.wheelR, CAR.tireW, 28, 1);
  tireGeo.rotateZ(Math.PI / 2);
  const rimGeo = new THREE.CircleGeometry(CAR.wheelR * 0.74, 28);
  for (const [sx, sz] of [[-1, -1], [1, -1], [-1, 1], [1, 1]]) {
    const steer = new THREE.Group();
    steer.position.set(sx * (CAR.track / 2), CAR.wheelR, sz * (CAR.wheelbase / 2));
    const spin = new THREE.Group();
    steer.add(spin);
    spin.add(new THREE.Mesh(tireGeo, rubber));
    const rim = new THREE.Mesh(rimGeo, rimMat);
    rim.position.x = sx * (CAR.tireW / 2 + 0.003);
    rim.rotation.y = sx * Math.PI / 2;
    spin.add(rim);
    root.add(steer);
    wheels.push({ steer, spin, front: sz < 0, side: sx });
  }

  // 차 아래 그림자 (가벼운 블롭 섀도)
  const shadow = new THREE.Mesh(new THREE.PlaneGeometry(2.6, 5.6), shadowMat);
  shadow.rotation.x = -Math.PI / 2;
  shadow.position.y = 0.03;
  shadow.renderOrder = 1;
  root.add(shadow);

  // 와이퍼
  const wipers = [];
  for (const x of lite ? [] : [-0.55, 0.15]) {
    const pivot = new THREE.Group();
    pivot.position.set(x, 1.0, -1.12);
    pivot.rotation.x = -0.55;
    const blade = new THREE.Mesh(new THREE.BoxGeometry(0.62, 0.015, 0.02), black);
    blade.position.x = 0.31;
    pivot.add(blade);
    root.add(pivot);
    wipers.push(pivot);
  }

  const model = { root, wheels, mats, wipers, body, cabin, paint, interior: null, cams: null };
  mergeStaticChildren(root, new Set([cabin, shadow]));

  if (interior) {
    model.interior = buildInterior(root);
    model.cams = buildMirrorCams(root);
  }
  return model;
}

function buildInterior(root) {
  const g = new THREE.Group();
  root.add(g);
  const dash = new THREE.MeshStandardMaterial({ color: 0x1b1e24, roughness: 0.8 });
  const trim = new THREE.MeshStandardMaterial({ color: 0x2c3038, roughness: 0.7 });
  const satin = new THREE.MeshStandardMaterial({ color: 0x8792a4, metalness: 0.7, roughness: 0.35 });
  const leather = new THREE.MeshStandardMaterial({ color: 0xcbb89a, roughness: 0.75 });
  const leatherDark = new THREE.MeshStandardMaterial({ color: 0x3a3d44, roughness: 0.8 });
  const carpet = new THREE.MeshStandardMaterial({ color: 0x15171b, roughness: 1 });
  const headliner = new THREE.MeshStandardMaterial({ color: 0x8d8981, emissive: 0x3a3936, roughness: 0.9 });
  const ambient = new THREE.MeshBasicMaterial({ color: 0x3ddcff });

  const box = (mat, w, h, d, x, y, z, rx = 0, ry = 0, rz = 0) => {
    const m = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), mat);
    m.position.set(x, y, z);
    m.rotation.set(rx, ry, rz);
    g.add(m);
    return m;
  };
  const V = (x, y, z) => new THREE.Vector3(x, y, z);

  // 바닥, 방화벽
  box(carpet, 1.72, 0.04, 3.3, 0, 0.34, 0.25);
  box(carpet, 1.72, 0.5, 0.05, 0, 0.58, -1.02, -0.5);
  // 대시보드
  box(dash, 1.74, 0.3, 0.56, 0, 0.85, -0.82);
  box(dash, 1.74, 0.22, 0.12, 0, 0.71, -0.55);
  box(ambient, 1.5, 0.006, 0.006, 0, 0.83, -0.488);                 // 앰비언트 라이트
  box(satin, 1.6, 0.02, 0.02, 0, 0.8, -0.49);
  box(dash, 0.44, 0.05, 0.2, -0.38, 1.075, -0.62);                  // 계기판 후드
  box(trim, 0.42, 0.15, 0.03, -0.38, 0.99, -0.575, -0.17);          // 계기판 베젤
  box(trim, 0.38, 0.23, 0.03, 0.03, 1.02, -0.52, -0.15, -0.3);      // 센터 디스플레이 베젤
  // 센터 콘솔
  box(trim, 0.24, 0.3, 0.95, 0, 0.52, 0.0);
  box(trim, 0.24, 0.12, 0.3, 0, 0.62, -0.5, -0.45);
  box(leatherDark, 0.22, 0.05, 0.36, 0, 0.7, 0.3);                  // 팔걸이
  // 도어 패널
  for (const sx of [-1, 1]) {
    box(trim, 0.06, 0.6, 2.0, sx * 0.9, 0.68, 0.1);
    box(leatherDark, 0.08, 0.05, 0.6, sx * 0.85, 0.74, 0.2);
    box(ambient, 0.004, 0.006, 1.2, sx * 0.865, 0.9, 0.1);
    box(dash, 0.08, 0.04, 2.0, sx * 0.87, 0.985, 0.1);
  }

  // 필러와 루프 프레임 (파노라마 글래스 루프)
  const pillar = (a, b, w = 0.055, d = 0.08) => g.add(beam(a, b, w, d, headliner));
  for (const sx of [-1, 1]) {
    pillar(V(sx * 0.8, 0.99, -1.12), V(sx * 0.7, 1.5, -0.33));      // A필러
    pillar(V(sx * 0.84, 1.0, 0.8), V(sx * 0.72, 1.5, 0.8), 0.08, 0.14); // B필러
    pillar(V(sx * 0.8, 1.0, 1.85), V(sx * 0.66, 1.47, 1.42), 0.08, 0.2); // C필러
    pillar(V(sx * 0.7, 1.5, -0.33), V(sx * 0.68, 1.49, 1.42), 0.1, 0.04); // 루프 사이드
  }
  box(headliner, 1.42, 0.04, 0.16, 0, 1.51, -0.28);
  box(headliner, 1.38, 0.04, 0.2, 0, 1.49, 1.4);
  box(headliner, 1.38, 0.03, 0.06, 0, 1.5, 0.8);

  // 시트
  const seat = (x) => {
    box(leather, 0.52, 0.12, 0.54, x, 0.52, 0.56);
    box(leather, 0.52, 0.72, 0.12, x, 0.9, 0.88, -0.22);
    box(leather, 0.28, 0.2, 0.1, x, 1.33, 0.98, -0.12);
    box(leatherDark, 0.06, 0.18, 0.5, x - 0.24, 0.6, 0.56);
    box(leatherDark, 0.06, 0.18, 0.5, x + 0.24, 0.6, 0.56);
  };
  seat(-0.38);
  seat(0.38);
  box(leather, 1.36, 0.12, 0.5, 0, 0.52, 1.5);
  box(leather, 1.36, 0.62, 0.12, 0, 0.86, 1.8, -0.18);
  for (const x of [-0.45, 0, 0.45]) box(leather, 0.24, 0.16, 0.08, x, 1.23, 1.86, -0.1);

  // 페달
  const accelPivot = new THREE.Group();
  accelPivot.position.set(-0.27, 0.62, -0.8);
  const accelPad = new THREE.Mesh(new THREE.BoxGeometry(0.07, 0.2, 0.02), satin);
  accelPad.position.set(0, -0.12, 0);
  accelPivot.add(accelPad);
  g.add(accelPivot);
  const brakePivot = new THREE.Group();
  brakePivot.position.set(-0.44, 0.7, -0.78);
  const brakePad = new THREE.Mesh(new THREE.BoxGeometry(0.13, 0.08, 0.025), satin);
  brakePad.position.set(0, -0.2, 0.02);
  brakePivot.add(brakePad);
  const brakeArm = new THREE.Mesh(new THREE.BoxGeometry(0.025, 0.2, 0.02), trim);
  brakeArm.position.set(0, -0.1, 0);
  brakePivot.add(brakeArm);
  g.add(brakePivot);
  box(trim, 0.08, 0.06, 0.25, -0.62, 0.42, -0.62, -0.6); // 풋레스트

  // 스티어링 휠
  const wheelPivot = new THREE.Group();
  wheelPivot.position.copy(CAR.wheelCenter);
  wheelPivot.rotation.x = -CAR.wheelTilt;
  g.add(wheelPivot);
  const column = new THREE.Mesh(new THREE.CylinderGeometry(0.035, 0.05, 0.36, 12), dash);
  column.rotation.x = Math.PI / 2;
  column.position.z = -0.2;
  wheelPivot.add(column);
  const spinner = new THREE.Group();
  wheelPivot.add(spinner);
  const rim = new THREE.Mesh(new THREE.TorusGeometry(CAR.rimR, 0.017, 10, 48), leatherDark);
  spinner.add(rim);
  const hub = new THREE.Mesh(new THREE.BoxGeometry(0.13, 0.095, 0.05), dash);
  hub.position.z = 0.02;
  spinner.add(hub);
  const logo = new THREE.Mesh(new THREE.BoxGeometry(0.05, 0.006, 0.004), satin);
  logo.position.set(0, 0, 0.047);
  spinner.add(logo);
  for (const [x, y, w, h] of [[-0.12, -0.01, 0.12, 0.03], [0.12, -0.01, 0.12, 0.03], [0, -0.11, 0.03, 0.12]]) {
    const spoke = new THREE.Mesh(new THREE.BoxGeometry(w, h, 0.02), trim);
    spoke.position.set(x, y, 0.005);
    spinner.add(spoke);
  }
  const topMark = new THREE.Mesh(new THREE.BoxGeometry(0.02, 0.012, 0.038), new THREE.MeshBasicMaterial({ color: 0x3ddcff }));
  topMark.position.set(0, CAR.rimR, 0);
  spinner.add(topMark);
  // 스티어링 휠 버튼 패드 (장식)
  for (const sx of [-1, 1]) {
    const pad = new THREE.Mesh(new THREE.BoxGeometry(0.035, 0.03, 0.006), satin);
    pad.position.set(sx * 0.09, -0.01, 0.018);
    spinner.add(pad);
  }

  // 레버(스토크): 왼쪽 = 방향지시등/전조등, 오른쪽 = 와이퍼
  const stalkL = new THREE.Group();
  stalkL.position.set(-0.05, 0.0, -0.08);
  const stalkLMesh = new THREE.Mesh(new THREE.CylinderGeometry(0.008, 0.01, 0.16, 8), trim);
  stalkLMesh.rotation.z = Math.PI / 2;
  stalkLMesh.position.x = -0.08;
  stalkL.add(stalkLMesh);
  wheelPivot.add(stalkL);
  const stalkR = new THREE.Group();
  stalkR.position.set(0.05, 0.0, -0.08);
  const stalkRMesh = stalkLMesh.clone();
  stalkRMesh.position.x = 0.08;
  stalkR.add(stalkRMesh);
  wheelPivot.add(stalkR);

  // 디스플레이 평면 (텍스처는 cockpit.js에서 연결)
  const cluster = new THREE.Mesh(new THREE.PlaneGeometry(0.34, 0.12), new THREE.MeshBasicMaterial({ color: 0x000000 }));
  cluster.position.set(-0.38, 0.99, -0.558);
  cluster.rotation.x = -0.17;
  g.add(cluster);
  const center = new THREE.Mesh(new THREE.PlaneGeometry(0.34, 0.2), new THREE.MeshBasicMaterial({ color: 0x000000 }));
  center.position.set(0.03, 1.02, -0.503);
  center.rotation.set(-0.15, -0.3, 0, 'YXZ');
  g.add(center);

  // 디지털 사이드미러 화면, 디지털 룸미러
  const flipUV = (geo) => {
    const uv = geo.attributes.uv;
    for (let i = 0; i < uv.count; i++) uv.setX(i, 1 - uv.getX(i));
    return geo;
  };
  const mirrorMat = () => new THREE.MeshBasicMaterial({ color: 0x111111 });
  const mirrorL = new THREE.Mesh(flipUV(new THREE.PlaneGeometry(0.15, 0.094)), mirrorMat());
  mirrorL.position.set(-0.8, 1.075, -0.63);
  mirrorL.rotation.set(0.05, 0.45, 0, 'YXZ');
  g.add(mirrorL);
  box(trim, 0.17, 0.112, 0.02, -0.805, 1.075, -0.64, 0.05, 0.45);
  box(trim, 0.05, 0.08, 0.05, -0.82, 1.02, -0.66);
  const mirrorR = new THREE.Mesh(flipUV(new THREE.PlaneGeometry(0.15, 0.094)), mirrorMat());
  mirrorR.position.set(0.8, 1.075, -0.63);
  mirrorR.rotation.set(0.05, -0.88, 0, 'YXZ');
  g.add(mirrorR);
  box(trim, 0.17, 0.112, 0.02, 0.808, 1.075, -0.637, 0.05, -0.88);
  box(trim, 0.05, 0.08, 0.05, 0.82, 1.02, -0.66);
  const rearMirror = new THREE.Mesh(flipUV(new THREE.PlaneGeometry(0.25, 0.066)), mirrorMat());
  rearMirror.position.set(0.02, 1.39, -0.4);
  rearMirror.rotation.set(-0.05, -0.12, 0, 'YXZ');
  g.add(rearMirror);
  box(trim, 0.27, 0.085, 0.025, 0.02, 1.39, -0.415, -0.05, -0.12);
  box(trim, 0.02, 0.1, 0.02, 0.02, 1.46, -0.36);

  // 누를 수 있는 버튼들 (VR에서 컨트롤러로 직접 누르기)
  const buttons = {};
  const keep = new Set();
  const addBtn = (id, label, w, h, x, y, z, rx, ry, opts = {}) => {
    const tex = opts.tex || buttonTexture(label, opts);
    const mat = new THREE.MeshBasicMaterial({ map: tex });
    const base = new THREE.Mesh(new THREE.BoxGeometry(w + 0.008, h + 0.008, 0.014), trim);
    base.position.set(x, y, z);
    base.rotation.set(rx, ry, 0, 'YXZ');
    g.add(base);
    const face = new THREE.Mesh(new THREE.PlaneGeometry(w, h), mat);
    face.position.set(x, y, z);
    face.rotation.set(rx, ry, 0, 'YXZ');
    face.translateZ(0.0075);
    g.add(face);
    keep.add(face);
    const normal = new THREE.Vector3(0, 0, 1).applyEuler(face.rotation);
    buttons[id] = { mesh: face, mat, half: new THREE.Vector3(w / 2, h / 2, 0.03), base: face.position.clone(), normal };
    return face;
  };
  // 콘솔 위 변속 버튼 (위를 향하게 눕힘)
  const lay = -Math.PI / 2 + 0.25;
  addBtn('gearP', 'P', 0.046, 0.046, -0.078, 0.705, -0.26, lay, 0, { size: 70 });
  addBtn('gearR', 'R', 0.046, 0.046, -0.026, 0.705, -0.26, lay, 0, { size: 70 });
  addBtn('gearN', 'N', 0.046, 0.046, 0.026, 0.705, -0.26, lay, 0, { size: 70 });
  addBtn('gearD', 'D', 0.046, 0.046, 0.078, 0.705, -0.26, lay, 0, { size: 70 });
  addBtn('epb', 'EPB\n(P)', 0.07, 0.045, -0.04, 0.712, -0.14, lay, 0, { size: 40, w: 192, h: 128 });
  addBtn('belt', '안전\n벨트', 0.06, 0.06, -0.18, 0.64, 0.42, -Math.PI / 2 + 0.6, 0.4, { size: 40, bg: '#7a1420' });
  addBtn('power', 'START\nSTOP', 0.055, 0.055, -0.12, 0.9, -0.535, -0.1, -0.2, { size: 30, ring: '#3ddcff' });
  addBtn('hazard', '', 0.06, 0.045, 0.03, 0.86, -0.53, -0.25, -0.3, { tex: hazardTexture() });
  addBtn('lights', '전조등', 0.07, 0.04, -0.72, 0.88, -0.535, -0.1, 0.2, { size: 34, w: 192, h: 110 });
  addBtn('high', '상향등', 0.07, 0.04, -0.72, 0.83, -0.535, -0.1, 0.2, { size: 34, w: 192, h: 110 });
  addBtn('wiper', '와이퍼', 0.07, 0.04, -0.64, 0.83, -0.535, -0.1, 0.2, { size: 34, w: 192, h: 110 });
  addBtn('horn', '경적', 0.07, 0.04, -0.64, 0.88, -0.535, -0.1, 0.2, { size: 34, w: 192, h: 110 });

  // 안전벨트 띠
  const beltMat = new THREE.MeshStandardMaterial({ color: 0x23252b, roughness: 0.9 });
  const beltShoulder = new THREE.Mesh(new THREE.BoxGeometry(0.05, 0.004, 1), beltMat);
  const beltLap = new THREE.Mesh(new THREE.BoxGeometry(0.05, 0.004, 1), beltMat);
  g.add(beltShoulder, beltLap);
  const setBelt = (on) => {
    if (on) {
      placeBeltPart(beltShoulder, V(-0.66, 1.3, 0.82), V(-0.18, 0.66, 0.42));
      placeBeltPart(beltLap, V(-0.64, 0.6, 0.62), V(-0.18, 0.64, 0.42));
      beltLap.visible = true;
    } else {
      placeBeltPart(beltShoulder, V(-0.74, 1.3, 0.82), V(-0.76, 0.72, 0.84));
      beltLap.visible = false;
    }
  };
  setBelt(false);

  for (const m of [cluster, center, mirrorL, mirrorR, rearMirror, beltShoulder, beltLap]) keep.add(m);
  mergeStaticChildren(g, keep);
  mergeStaticChildren(spinner);

  return {
    group: g, wheelPivot, spinner, stalkL, stalkR, cluster, center, mirrorL, mirrorR, rearMirror,
    buttons, setBelt, accelPivot, brakePivot,
  };
}

function placeBeltPart(mesh, a, b) {
  const len = a.distanceTo(b);
  mesh.position.copy(a).add(b).multiplyScalar(0.5);
  const dir = tmpV.copy(b).sub(a).normalize();
  mesh.quaternion.setFromUnitVectors(new THREE.Vector3(0, 0, 1), dir);
  mesh.scale.set(1, 1, len);
}

function buildMirrorCams(root) {
  const mk = (fov, aspect, pos, target) => {
    const cam = new THREE.PerspectiveCamera(fov, aspect, 0.05, 400);
    cam.position.copy(pos);
    root.add(cam);
    root.updateMatrixWorld(true);
    cam.lookAt(target); // 이 시점에서 root는 원점/무회전이므로 로컬 = 월드
    return cam;
  };
  const V = (x, y, z) => new THREE.Vector3(x, y, z);
  return {
    left: mk(30, 1.6, V(-1.07, 1.0, -0.78), V(-1.6, 0.8, 4)),
    right: mk(30, 1.6, V(1.07, 1.0, -0.78), V(1.6, 0.8, 4)),
    rearMirror: mk(26, 3.8, V(0, 1.42, 1.3), V(0, 1.15, 12)),
    rear: mk(80, 1.7, V(0, 0.98, 2.42), V(0, 0.0, 5.0)),
  };
}

// 매 프레임: 물리 상태 → 3D 모델 반영
export function updateCarVisual(model, car, dt) {
  const r = model.root;
  r.position.set(car.x, car.y, car.z);
  r.rotation.set(car.pitch, -car.heading, 0, 'YXZ');

  const delta = car.steer;
  const L = CAR.wheelbase, T = CAR.track;
  for (const w of model.wheels) {
    if (w.front) {
      // 애커만 조향: 안쪽 바퀴가 더 꺾임
      let a = delta;
      if (Math.abs(delta) > 1e-4) {
        const R = L / Math.tan(Math.abs(delta));
        const inner = Math.sign(delta) === w.side;
        a = Math.sign(delta) * Math.atan(L / (R + (inner ? -T / 2 : T / 2)));
      }
      w.steer.rotation.y = -a;
    }
    w.spin.rotation.x -= (car.v * dt) / CAR.wheelR;
  }

  const m = model.mats;
  const blink = car.blinkOn;
  const leftOn = blink && (car.hazard || car.turn < 0);
  const rightOn = blink && (car.hazard || car.turn > 0);
  m.turnL.color.setHex(leftOn ? 0xffa21a : 0x4a2a00);
  m.turnR.color.setHex(rightOn ? 0xffa21a : 0x4a2a00);
  m.drl.color.setHex(car.power ? 0xffffff : 0x8a8f99);
  m.head.color.setHex(car.lights === 2 ? 0xeaf6ff : car.lights === 1 ? 0xd6e6ff : 0x9aa4b4);
  const brakeVis = Math.max(car.brake, car.autoBrakeT > 0 ? 1 : 0);
  const braking = brakeVis > 0.05 || car.epbHolding;
  m.brake.color.setHex(braking && car.power ? 0xff1b2d : 0x4a0a10);
  m.tail.color.setHex(car.lights > 0 || car.power ? 0xc0101e : 0x5a0a10);
  m.reverse.color.setHex(car.gear === 'R' && car.power ? 0xffffff : 0x777777);

  // 와이퍼
  const wp = car.wiper > 0 ? Math.sin(car.wiperPhase) * 0.5 + 0.5 : 0;
  model.wipers.forEach((p, i) => { p.rotation.z = wp * 1.6 * (i === 0 ? 1 : 0.9); });

  const it = model.interior;
  if (it) {
    it.spinner.rotation.z = -car.wheelAngle;
    it.stalkL.rotation.x = car.turn * 0.18;
    it.stalkL.rotation.z = car.lights === 2 ? -0.12 : 0;
    it.stalkR.rotation.x = -car.wiper * 0.12;
    it.accelPivot.rotation.x = -car.throttle * 0.35;
    it.brakePivot.rotation.x = -brakeVis * 0.4;
  }
}
