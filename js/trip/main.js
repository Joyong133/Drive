// 서울 ↔ 부산 경부고속도로 VR 드라이브 — 진입점
import * as THREE from 'three';
import { buildCarModel, CAR } from '../carModel.js';
import { mergeGeometries } from 'three/addons/BufferGeometryUtils.js';
import { storage, clamp, damp } from '../util.js';
import { loadTripData, F_TUNNEL, F_BRIDGE } from './route.js';
import { toLonLat } from './geo.js';
import { Terrain, IMAGERY, QUALITY, MIRROR_LAYER } from './terrain.js';
import { RoadSystem, makeRoadMaterials } from './road.js';
import { SignFactory, setSignGlow } from './signs.js';
import { Sky } from './sky.js';
import { TripPlan, carPose } from './drive.js';
import { Traffic } from './traffic.js';
import { Buildings } from './buildings.js';
import { Trees } from './trees.js';
import { TripCockpit, fmtDur, fmtClock } from './tripCockpit.js';
import { TripAudio } from './tripAudio.js';

const DEFAULTS = {
  dir: 'SB', seat: 'passenger', departTime: '09:00', durationMin: 270,
  imagery: 'esri', vworldKey: '', quality: 'mid', haze: 'normal', clouds: 0.35,
  voice: true, sfx: true, mirrors: true, comfort: false,
};
const SEATS = {
  driver: new THREE.Vector3(CAR.eye.x, CAR.eye.y, CAR.eye.z),
  passenger: new THREE.Vector3(-CAR.eye.x, CAR.eye.y, CAR.eye.z),
  rear: new THREE.Vector3(0.42, 1.14, 1.42),
};
const WARPS = [1, 2, 5, 10, 20, 60];
const NAMES = { SB: ['서울', '부산'], NB: ['부산', '서울'] };

const app = {
  settings: { ...DEFAULTS, ...storage.get('vrtrip.settings', {}), ...(IMAGERY.custom ? { imagery: 'custom' } : {}) },
  started: false, paused: false, warp: 1, tSim: 0, view: 'inside', loading: true,
};
window.vrTrip = app;
const S = app.settings;
const save = () => storage.set('vrtrip.settings', S);

// ───────── 렌더러
const renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' });
renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.toneMapping = THREE.NoToneMapping;
renderer.xr.enabled = true;
renderer.xr.setReferenceSpaceType('local');
document.getElementById('app').appendChild(renderer.domElement);
app.renderer = renderer;
function applyPixelRatio() {
  if (renderer.xr.isPresenting) return;
  const dpr = window.devicePixelRatio || 1;
  renderer.setPixelRatio(S.quality === 'low' ? Math.min(dpr, 1) : S.quality === 'high' ? Math.min(dpr, 2) : Math.min(dpr, 1.5));
  renderer.setSize(window.innerWidth, window.innerHeight);
}
applyPixelRatio();

const scene = new THREE.Scene();
// 실내 금속·플라스틱이 하늘빛을 받도록 간단한 환경맵 (하늘 그라데이션)
{
  const envScene = new THREE.Scene();
  const g = new THREE.SphereGeometry(10, 24, 12);
  const cols = [];
  const pos = g.attributes.position;
  const top = new THREE.Color(0x9ec4ef), hor = new THREE.Color(0xe8edf2), bot = new THREE.Color(0x4a4a44);
  for (let i = 0; i < pos.count; i++) {
    const y = pos.getY(i) / 10;
    const c = y > 0 ? hor.clone().lerp(top, y) : hor.clone().lerp(bot, Math.min(1, -y * 3));
    cols.push(c.r, c.g, c.b);
  }
  g.setAttribute('color', new THREE.Float32BufferAttribute(cols, 3));
  envScene.add(new THREE.Mesh(g, new THREE.MeshBasicMaterial({ vertexColors: true, side: THREE.BackSide })));
  const pm = new THREE.PMREMGenerator(renderer);
  scene.environment = pm.fromScene(envScene, 0.02).texture;
  scene.environmentIntensity = 0.55;
  pm.dispose();
}
const camera = new THREE.PerspectiveCamera(72, window.innerWidth / window.innerHeight, 0.1, 140000);
app.scene = scene; app.camera = camera;

// ───────── 차
const model = buildCarModel({ color: 0x2b3440, interior: true, plate: '12가 2026' });
scene.add(model.root);
model.root.traverse((o) => { if (o.isMesh && !isInterior(o)) o.layers.enable(MIRROR_LAYER); });
function isInterior(o) { let p = o; while (p) { if (p === model.interior?.group) return true; p = p.parent; } return false; }
// 전조등 (밤): 일반 재질용 스포트라이트 + 지형/도로 셰이더용 값
const headLight = new THREE.SpotLight(0xfff0d8, 0, 180, 0.4, 0.6, 2);
headLight.position.set(0, 0.7, -2.3);
headLight.target.position.set(0, -1.2, -40);
headLight.layers.enable(MIRROR_LAYER);
model.root.add(headLight, headLight.target);
// 차 안 시점에서는 밖에서만 보이는 부분(바퀴·외부 등화·그림자·유리)을 숨겨 드로우콜을 줄임
const exteriorOnly = model.root.children.filter((c) => c !== model.interior.group && (c.isGroup || c.isMesh) &&
  (c.material?.type === 'MeshBasicMaterial' || model.wheels.some((w) => w.steer === c) || c === model.cabin));
function setExterior(v) { for (const c of exteriorOnly) c.visible = v; }
// 실내 버튼 글자판 14개를 한 장의 텍스처로 합쳐 한 번에 그림 (드라이브에서는 누를 필요 없음)
(function mergeButtonFaces() {
  const it = model.interior;
  const faces = Object.values(it.buttons).map((b) => b.mesh).filter((m) => m.material.map?.image);
  if (faces.length < 2) return;
  const cell = 256, cols = 4, rows = Math.ceil(faces.length / cols);
  const atlas = document.createElement('canvas');
  atlas.width = cell * cols; atlas.height = cell * rows;
  const g = atlas.getContext('2d');
  const geos = [];
  faces.forEach((m, k) => {
    const cx = (k % cols) * cell, cy = Math.floor(k / cols) * cell;
    g.drawImage(m.material.map.image, cx, cy, cell, cell);
    m.updateWorldMatrix(true, false);
    const geo = m.geometry.clone();
    // 모델 루트 기준 좌표로
    const rel = new THREE.Matrix4().copy(model.root.matrixWorld).invert().multiply(m.matrixWorld);
    geo.applyMatrix4(rel);
    const uv = geo.attributes.uv;
    for (let i = 0; i < uv.count; i++) {
      uv.setXY(i, (cx + uv.getX(i) * cell) / atlas.width, 1 - (cy + (1 - uv.getY(i)) * cell) / atlas.height);
    }
    for (const key of Object.keys(geo.attributes)) if (!['position', 'normal', 'uv'].includes(key)) geo.deleteAttribute(key);
    geos.push(geo.index ? geo.toNonIndexed() : geo);
    m.parent.remove(m);
  });
  const tex = new THREE.CanvasTexture(atlas);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 4;
  const merged = new THREE.Mesh(mergeGeometries(geos), new THREE.MeshBasicMaterial({ map: tex }));
  merged.name = 'buttons';
  model.root.add(merged);
})();
const rig = new THREE.Group();
rig.add(camera);
model.root.add(rig);
app.model = model;

// UI 요소
const $ = (id) => document.getElementById(id);
const ui = {
  start: $('start-screen'), status: $('load-status'), btnVR: $('btn-vr'), btnPC: $('btn-desktop'), btnResume: $('btn-resume'),
  hud: $('hud'), place: $('hud-place'), next: $('hud-next'), prog: $('hud-progress'), progFill: $('hud-progress-fill'),
  eta: $('hud-eta'), speed: $('hud-speed'), warp: $('hud-warp'), seek: $('hud-seek'), loading: $('hud-loading'), toast: $('toasts'),
};

function toast(text, kind = 'info') {
  const el = document.createElement('div');
  el.className = `toast ${kind}`;
  el.textContent = text;
  ui.toast.appendChild(el);
  setTimeout(() => el.remove(), 3500);
  cockpit?.showFlash(text, kind === 'bad' ? '#b8860b' : '#2a6fd6', 2.5);
  vrToast(text);
}

// ───────── 데이터·세계
let data, terrain, roads, sky, traffic, buildings, trees, cockpit, signs, plan, route;
const audio = new TripAudio();
audio.sfx = S.sfx; audio.voice = S.voice;
app.audio = audio;

async function init() {
  ui.status.textContent = '경부고속도로 경로 데이터를 불러오는 중…';
  try {
    await document.fonts?.load?.(`900 40px "Noto Sans KR"`);
  } catch { /* 글꼴 실패해도 진행 */ }
  data = await loadTripData('data/trip/');
  // 램프 형상
  data.ramps = data.meta.ramps.map((r) => ({ ...r, pts: new Float32Array(data.rampBuf, r.off, r.n * 3) }));
  terrain = new Terrain({ scene, renderer, routes: data.routes, ramps: data.ramps, quality: S.quality, imagery: S.imagery, vworldKey: S.vworldKey });
  sky = new Sky(scene, terrain.shared, { haze: S.haze, clouds: S.clouds });
  sky.mesh.layers.enable(MIRROR_LAYER);
  sky.sun.layers.enable(MIRROR_LAYER);
  sky.hemi.layers.enable(MIRROR_LAYER);
  signs = new SignFactory(data.meta, data.routes, data.ramps);
  roads = new RoadSystem({ scene, routes: data.routes, meta: data.meta, ramps: data.ramps, materials: makeRoadMaterials(terrain.shared), signs });
  traffic = new Traffic({ scene, routes: data.routes, quality: S.quality });
  buildings = new Buildings({ scene, meta: data.meta, routes: data.routes, shared: terrain.shared });
  trees = new Trees({ scene, terrain, quality: S.quality });
  cockpit = new TripCockpit({ model, app });
  Object.assign(app, { data, terrain, roads, sky, traffic, buildings, trees, cockpit, signs });
  terrain.onImageryBlocked = () => {
    if (app.imageryWarned) return;
    app.imageryWarned = true;
    toast('위성사진 서버에 연결되지 않아 색으로 표시해요 (인터넷·차단 여부 확인)', 'bad');
  };
  await terrain.ready;
  setupRoute(S.dir, 0);
  const prog = storage.get('vrtrip.progress', null);
  if (prog && prog.t > 60 && prog.t < plan.duration - 60) {
    ui.btnResume.classList.remove('hidden');
    $('chk-resume-vr').parentElement.classList.remove('hidden');
    ui.btnResume.textContent = `이어서 보기 · ${NAMES[prog.dir][0]}→${NAMES[prog.dir][1]} ${fmtDur(prog.t)} 지점`;
  }
  ui.status.textContent = `준비 완료 · 경부고속도로 ${(route.length / 1000).toFixed(0)} km · 터널 ${data.meta.routes[S.dir].tunnels.length}곳 · 교량 ${data.meta.routes[S.dir].bridges.length}곳`;
  ui.btnPC.disabled = false;
  checkVR();
}

function setupRoute(dir, t) {
  S.dir = dir;
  route = data.routes[dir];
  plan = new TripPlan(route, { totalSec: S.durationMin * 60, slow: roads.tolls[dir].map((t) => ({ s: t.s, half: 250, kmh: 75 })) });
  app.route = route; app.plan = plan;
  app.tSim = clamp(t, 0, plan.duration);
  app.lastS = plan.sAt(app.tSim);
  traffic.reset(route, app.lastS, plan);
  app.events = buildEvents(dir);
  app.announced = new Set();
  updatePose(0);
}

// 다음 안내 목록용 이벤트 (출구·분기점·휴게소·터널)
function buildEvents(dir) {
  const m = data.meta.routes[dir];
  const ev = [];
  for (const p of signs.place[dir]) {
    if (p.type === 'gantry') ev.push({ s: p.s + 60, name: p.name || p.labels.join('·'), icon: /JC/.test(p.name) ? '⇄' : '↗', color: '#3ddcff', kind: /JC/.test(p.name) ? 'jc' : 'ic' });
  }
  for (const r of m.rests) ev.push({ s: r.s, name: r.name, icon: r.kind === 'rest' ? '☕' : '🅿', color: r.kind === 'rest' ? '#7fb3ff' : '#9fb3c8', kind: r.kind });
  for (const [a, b] of m.tunnels) if (b - a > 150) ev.push({ s: a, name: `터널 ${b - a >= 1000 ? ((b - a) / 1000).toFixed(1) + 'km' : Math.round(b - a) + 'm'}`, icon: '◠', color: '#ffb020', kind: 'tunnel', len: b - a });
  for (const t of roads.tolls[dir]) ev.push({ s: t.s, name: `${t.name} (하이패스)`, icon: '▦', color: '#7fb3ff', kind: 'toll' });
  ev.push({ s: route.length, name: `${NAMES[dir][1]} 도착`, icon: '🏁', color: '#39e27d', kind: 'end' });
  ev.sort((a, b) => a.s - b.s);
  return ev;
}

// ───────── 출발 시각 (하늘·해 위치용)
// 출발 시각은 기기 시간대와 상관없이 한국 시간(KST, UTC+9)으로
const KST = 9 * 3600e3;
function departDate() {
  if (S.departTime === 'now') return app.departNow || (app.departNow = new Date());
  const k = new Date(Date.now() + KST);
  const [h, m] = S.departTime.split(':').map(Number);
  return new Date(Date.UTC(k.getUTCFullYear(), k.getUTCMonth(), k.getUTCDate(), h, m, 0) - KST);
}

// ───────── 차 자세
const pose = {};
const camWorld = new THREE.Vector3();
let wheelAngle = 0, susT = 0;
function updatePose(dt) {
  const s = plan.sAt(app.tSim);
  carPose(route, plan, s, pose);
  pose.s = s;
  pose.v = app.paused ? 0 : plan.speedAt(s);
  const r = model.root;
  susT += dt * (pose.v > 1 ? 1 : 0);
  const k = S.comfort ? 0 : 1;
  const bump = (0.0035 * Math.sin(susT * 11.3) + 0.0025 * Math.sin(susT * 17.9 + 1.3) + 0.006 * Math.sin(susT * 1.9)) * Math.min(pose.v / 25, 1) * k;
  r.position.set(pose.x, pose.y + bump, pose.z);
  if (S.comfort) r.rotation.set(0, pose.yaw, 0, 'YXZ'); // 멀미 방지: 앞뒤·좌우 기울기 없음
  else r.rotation.set(pose.pitch + bump * 0.6, pose.yaw, pose.roll + 0.002 * Math.sin(susT * 2.3) * k, 'YXZ');
  // 바퀴·핸들
  const f = route.sample(s);
  const d2 = (plan.latAt(s + 15) - 2 * plan.latAt(s) + plan.latAt(s - 15)) / 225;
  const steer = Math.atan(CAR.wheelbase * (f.curv + d2));
  wheelAngle = damp(wheelAngle, steer * 15, 6, dt);
  for (const w of model.wheels) {
    if (w.front) w.steer.rotation.y = -steer;
    w.spin.rotation.x -= (pose.v * dt) / CAR.wheelR;
  }
  if (model.interior) model.interior.spinner.rotation.z = -wheelAngle;
  // 방향지시등
  const blinking = Math.abs(pose.laneShift) > 0.006 && pose.v > 3;
  app.turn = blinking ? Math.sign(pose.laneShift) : 0;
  app.blinkOn = blinking && Math.floor(performance.now() / 380) % 2 === 0;
  const m = model.mats;
  m.turnL.color.setHex(app.blinkOn && app.turn < 0 ? 0xffa21a : 0x4a2a00);
  m.turnR.color.setHex(app.blinkOn && app.turn > 0 ? 0xffa21a : 0x4a2a00);
  m.drl.color.setHex(0xffffff);
  m.tail.color.setHex(0xc0101e);
}

// ───────── 시점
const look = { yaw: 0, pitch: -0.05 };
const viewPos = new THREE.Vector3();
let viewYaw = 0;
function seatEye() { return SEATS[S.seat] || SEATS.passenger; }
function placeRig(dt) {
  const xr = renderer.xr.isPresenting;
  setExterior(app.view !== 'inside');
  if (app.view === 'inside') {
    if (rig.parent !== model.root) { model.root.add(rig); rig.rotation.set(0, 0, 0); recenter(); }
    if (!xr) { rig.position.copy(seatEye()); camera.position.set(0, 0, 0); camera.rotation.set(look.pitch, look.yaw, 0, 'YXZ'); }
    return;
  }
  if (rig.parent !== scene) { scene.add(rig); viewPos.set(pose.x, pose.y + 30, pose.z); viewYaw = pose.yaw; }
  const back = app.view === 'chase' ? 11 : 110, up = app.view === 'chase' ? 3.8 : 55;
  const want = new THREE.Vector3(pose.x - pose.tx * back, pose.y + up, pose.z - pose.tz * back);
  if (viewPos.distanceTo(want) > 300) viewPos.copy(want);
  viewPos.x = damp(viewPos.x, want.x, 3, dt); viewPos.y = damp(viewPos.y, want.y, 3, dt); viewPos.z = damp(viewPos.z, want.z, 3, dt);
  let dy = pose.yaw - viewYaw;
  while (dy > Math.PI) dy -= 2 * Math.PI;
  while (dy < -Math.PI) dy += 2 * Math.PI;
  viewYaw += dy * (1 - Math.exp(-2.5 * dt));
  rig.position.copy(viewPos);
  rig.rotation.set(0, viewYaw, 0);
  if (!xr) { camera.position.set(0, 0, 0); camera.rotation.set(look.pitch + (app.view === 'chase' ? -0.12 : -0.42), look.yaw, 0, 'YXZ'); }
}
function cycleView() {
  app.view = app.view === 'inside' ? 'chase' : app.view === 'chase' ? 'drone' : 'inside';
  toast({ inside: '차 안 시점', chase: '차 뒤 시점', drone: '하늘에서 보기' }[app.view]);
}
function recenter() {
  if (app.view !== 'inside') return;
  const eye = seatEye();
  if (renderer.xr.isPresenting) {
    const p = camera.position.clone();
    const e = new THREE.Euler().setFromQuaternion(camera.quaternion, 'YXZ');
    rig.rotation.set(0, -e.y, 0);
    p.applyAxisAngle(new THREE.Vector3(0, 1, 0), -e.y);
    rig.position.copy(eye).sub(p);
  } else {
    rig.rotation.set(0, 0, 0);
    rig.position.copy(eye);
    look.yaw = 0; look.pitch = -0.05;
  }
}

// ───────── 동작
function setWarp(w) {
  app.warp = w;
  toast(w === 1 ? '실제 속도 (×1)' : `빠르게 ×${w}`);
}
function jump(sec) {
  app.tSim = clamp(app.tSim + sec, 0, plan.duration);
  traffic.reset(route, plan.sAt(app.tSim), plan);
  app.lastS = plan.sAt(app.tSim);
  toast(`${sec > 0 ? '앞으로' : '뒤로'} ${Math.abs(Math.round(sec / 60))}분 이동`);
  app.loading = true;
}
function seekTo(t) {
  app.tSim = clamp(t, 0, plan.duration);
  traffic.reset(route, plan.sAt(app.tSim), plan);
  app.lastS = plan.sAt(app.tSim);
  app.loading = true;
}
const actions = {
  warpUp() { const i = WARPS.indexOf(app.warp); setWarp(WARPS[Math.min(WARPS.length - 1, i + 1)]); },
  warpDown() { const i = WARPS.indexOf(app.warp); setWarp(WARPS[Math.max(0, i - 1)]); },
  pause() { app.paused = !app.paused; toast(app.paused ? '일시정지' : '다시 출발'); },
  view: cycleView,
  recenter() { recenter(); toast('정면을 맞췄어요'); },
  menu() { cockpit.page = 'menu'; },
  back() { cockpit.page = 'nav'; },
  dirSB() { if (S.dir !== 'SB') { setupRoute('SB', 0); save(); toast('서울 → 부산으로 출발'); announceStart(); app.loading = true; } },
  dirNB() { if (S.dir !== 'NB') { setupRoute('NB', 0); save(); toast('부산 → 서울로 출발'); announceStart(); app.loading = true; } },
  seatpassenger() { S.seat = 'passenger'; save(); recenter(); },
  seatdriver() { S.seat = 'driver'; save(); recenter(); },
  seatrear() { S.seat = 'rear'; save(); recenter(); },
  jumpBack() { jump(-600); },
  jumpFwd() { jump(600); },
  jumpRest() {
    const r = data.meta.routes[S.dir].rests.find((q) => q.kind === 'rest' && q.s > pose.s + 2500);
    if (r) { seekTo(plan.timeAt(r.s - 2300)); toast(`${r.name} 2km 앞으로 이동`); }
  },
  restart() { seekTo(0); announceStart(); },
  warp1() { setWarp(1); }, warp5() { setWarp(5); }, warp20() { setWarp(20); }, warp60() { setWarp(60); },
  qlow() { setQuality('low'); }, qmid() { setQuality('mid'); }, qhigh() { setQuality('high'); },
  voice() { S.voice = audio.voice = !S.voice; save(); },
  sfx() { S.sfx = audio.sfx = !S.sfx; save(); },
  mirrors() { S.mirrors = !S.mirrors; save(); },
  comfort() { S.comfort = !S.comfort; save(); toast(S.comfort ? '멀미 방지: 차 흔들림·기울기 끔' : '실제처럼 흔들림·기울기 켬'); },
  hazeclear() { S.haze = 'clear'; sky.setHaze('clear'); save(); },
  hazenormal() { S.haze = 'normal'; sky.setHaze('normal'); save(); },
  hazehazy() { S.haze = 'hazy'; sky.setHaze('hazy'); save(); },
  exitVR() {
    const ses = renderer.xr.getSession();
    if (ses) ses.end(); else showStart();
  },
};
app.actions = actions;
app.seekS = (s) => seekTo(plan.timeAt(s)); // 디버깅/테스트용: 거리로 이동
function setQuality(q) {
  S.quality = q; save();
  terrain.setQuality(q);
  trees.setQuality(q);
  applyPixelRatio();
  toast({ low: '가볍게 (성능 우선)', mid: '보통 화질', high: '고화질' }[q]);
}
function doAction(id) { audio.unlock(); actions[id]?.(); }

// ───────── 음성 안내
function announceStart() {
  const end = new Date(departDate().getTime() + plan.duration * 1000);
  const [eh, em] = fmtClock(end).split(':').map(Number);
  audio.speak(`${NAMES[S.dir][0]}에서 ${NAMES[S.dir][1]}까지 경부고속도로 여행을 시작합니다. 약 ${fmtDur(plan.duration)} 걸리고, 도착 예정 시각은 ${eh}시 ${em ? em + '분' : ''}입니다.`);
}
let lastRegion = '';
function announce(s) {
  for (const e of app.events) {
    const d = e.s - s;
    const key = `${e.kind}:${Math.round(e.s)}`;
    if (e.kind === 'rest' && d > 1900 && d < 2100 && !app.announced.has(key)) { app.announced.add(key); audio.speak(`2킬로미터 앞 ${e.name}입니다.`); }
    if (e.kind === 'jc' && d > 900 && d < 1100 && !app.announced.has(key)) { app.announced.add(key); audio.speak(`1킬로미터 앞 ${e.name.replace(' JC', ' 분기점')}입니다. 경부고속도로를 따라 계속 직진합니다.`); }
    if (e.kind === 'tunnel' && e.len > 900 && d > 250 && d < 350 && !app.announced.has(key)) { app.announced.add(key); audio.speak(`잠시 후 길이 ${(e.len / 1000).toFixed(1)}킬로미터 터널입니다.`); }
    if (e.kind === 'toll' && d > 900 && d < 1100 && !app.announced.has(key)) { app.announced.add(key); audio.speak(`1킬로미터 앞 ${e.name.replace(' (하이패스)', '')}입니다. 하이패스 차로로 통과합니다.`); }
    if (e.kind === 'end' && d < 30 && !app.announced.has(key)) { app.announced.add(key); audio.chime(); audio.speak(`목적지 ${NAMES[S.dir][1]}에 도착했습니다. 긴 여행 수고하셨습니다.`); toast(`${NAMES[S.dir][1]} 도착! 수고하셨습니다`); }
  }
  const nm = placeAt(s);
  if (nm.region && nm.region !== lastRegion) {
    if (lastRegion) audio.speak(`${nm.region}에 들어왔습니다.`);
    lastRegion = nm.region;
  }
}
function placeAt(s) {
  const list = data.meta.routes[S.dir].names;
  let cur = list[0];
  for (const n of list) { if (n.s <= s) cur = n; else break; }
  return cur || { region: '', county: '' };
}

// ───────── 상태 (화면용)
function status() {
  const s = pose.s;
  const now = new Date(departDate().getTime() + app.tSim * 1000);
  const remainT = plan.duration - app.tSim;
  const eta = new Date(departDate().getTime() + plan.duration * 1000);
  const nm = placeAt(s);
  const upcoming = app.events.filter((e) => e.s > s + 20).slice(0, 6).map((e) => ({ ...e, dist: e.s - s >= 1000 ? `${((e.s - s) / 1000).toFixed(e.s - s < 10000 ? 1 : 0)} km` : `${Math.round((e.s - s) / 10) * 10} m` }));
  return {
    s, route, kmh: pose.v * 3.6, warp: app.warp, paused: app.paused, remainKm: (route.length - s) / 1000,
    eta: fmtClock(eta), clock: fmtClock(now), limit: route.speedAt(s), blink: app.blinkOn, turn: app.turn,
    destName: NAMES[S.dir][1], fromName: NAMES[S.dir][0], progress: s / route.length, place: `${nm.region} ${nm.county}`.trim() || '경부고속도로',
    upcoming, pos: { x: pose.x, z: pose.z }, heading: { x: pose.tx, z: pose.tz }, ramps: data.ramps.filter((r) => r.dir === S.dir),
    tunnels: data.meta.routes[S.dir].tunnels, cities: data.meta.routes[S.dir].cities, remainT, xr: renderer.xr.isPresenting,
    credit: `${(IMAGERY[S.imagery] || IMAGERY.esri).credit} · 도로·건물 © OpenStreetMap, Overture Maps · 지형 AWS Terrain Tiles`,
  };
}

// ───────── PC 화면 HUD
let hudT = 0;
function updateHud(st, dt) {
  if ((hudT -= dt) > 0) return;
  hudT = 0.25;
  ui.place.textContent = st.place;
  const n = st.upcoming[0];
  ui.next.textContent = n ? `${n.icon} ${n.name} · ${n.dist}` : '';
  ui.progFill.style.width = `${(st.progress * 100).toFixed(2)}%`;
  ui.eta.textContent = `${st.fromName} → ${st.destName} · 남은 ${fmtDur(st.remainT)} · 도착 ${st.eta} · 지금 ${st.clock}`;
  ui.speed.textContent = `${Math.round(st.kmh)}`;
  ui.warp.textContent = app.paused ? '일시정지' : `×${app.warp}`;
  if (!ui.seek.matches(':active')) ui.seek.value = String(Math.round((app.tSim / plan.duration) * 1000));
  ui.loading.classList.toggle('hidden', !app.loading);
}

// ───────── 입력 (PC)
const pointer = { down: false, x: 0, y: 0, moved: 0 };
const ray = new THREE.Raycaster();
function screenHit(ndc, cam) {
  ray.setFromCamera(ndc, cam);
  ray.far = 4;
  const hit = ray.intersectObject(model.interior.center, false)[0];
  return hit ? hit.uv : null;
}
const canvas = renderer.domElement;
canvas.addEventListener('pointerdown', (e) => { pointer.down = true; pointer.x = e.clientX; pointer.y = e.clientY; pointer.moved = 0; canvas.setPointerCapture?.(e.pointerId); });
canvas.addEventListener('pointermove', (e) => {
  if (pointer.down) {
    const dx = e.clientX - pointer.x, dy = e.clientY - pointer.y;
    pointer.moved += Math.abs(dx) + Math.abs(dy);
    pointer.x = e.clientX; pointer.y = e.clientY;
    look.yaw = clamp(look.yaw - dx * 0.0045, -2.6, 2.6);
    look.pitch = clamp(look.pitch - dy * 0.0045, -1.2, 1.0);
  } else if (app.started && app.view === 'inside') {
    const r = canvas.getBoundingClientRect();
    cockpit.hoverUV = screenHit(new THREE.Vector2(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1), camera);
    canvas.style.cursor = cockpit.hoverUV ? 'pointer' : 'grab';
  }
});
canvas.addEventListener('pointerup', (e) => {
  pointer.down = false;
  if (pointer.moved < 6 && app.started && app.view === 'inside') {
    const r = canvas.getBoundingClientRect();
    const uv = screenHit(new THREE.Vector2(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1), camera);
    if (uv) { const id = cockpit.click(uv); if (id) doAction(id); }
  }
});
canvas.addEventListener('wheel', (e) => {
  if (renderer.xr.isPresenting) return;
  camera.fov = clamp(camera.fov + Math.sign(e.deltaY) * 4, 35, 95);
  camera.updateProjectionMatrix();
}, { passive: true });
canvas.addEventListener('dblclick', () => { look.yaw = 0; look.pitch = -0.05; });
window.addEventListener('keydown', (e) => {
  if (!app.started || e.target.tagName === 'INPUT' || e.target.tagName === 'SELECT') return;
  audio.unlock();
  const k = e.key;
  if (k === ' ') { e.preventDefault(); actions.pause(); }
  else if (k >= '1' && k <= '6') setWarp(WARPS[Number(k) - 1]);
  else if (k === 'ArrowRight') jump(e.shiftKey ? 600 : 60);
  else if (k === 'ArrowLeft') jump(e.shiftKey ? -600 : -60);
  else if (k === 'v' || k === 'V') cycleView();
  else if (k === 'c' || k === 'C') { const order = ['passenger', 'driver', 'rear']; S.seat = order[(order.indexOf(S.seat) + 1) % 3]; save(); recenter(); toast({ passenger: '조수석', driver: '운전석', rear: '뒷좌석' }[S.seat]); }
  else if (k === 'm' || k === 'M') cockpit.page = cockpit.page === 'menu' ? 'nav' : 'menu';
  else if (k === 'h' || k === 'H') ui.hud.classList.toggle('hidden');
  else if (k === 'Escape') showStart();
});
ui.seek?.addEventListener('change', () => seekTo((Number(ui.seek.value) / 1000) * plan.duration));
document.querySelectorAll('[data-hud]').forEach((b) => b.addEventListener('click', () => doAction(b.dataset.hud)));

// ───────── VR 입력: 컨트롤러 광선으로 센터 화면 누르기, 버튼
const controllers = [];
const rayGeo = new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(0, 0, 0), new THREE.Vector3(0, 0, -1)]);
for (let i = 0; i < 2; i++) {
  const c = renderer.xr.getController(i);
  const line = new THREE.Line(rayGeo, new THREE.LineBasicMaterial({ color: 0x3ddcff, transparent: true, opacity: 0.7 }));
  line.scale.z = 1.2;
  c.add(line);
  c.userData.line = line;
  c.addEventListener('connected', (e) => { c.userData.source = e.data; line.visible = e.data.targetRayMode !== 'gaze'; });
  c.addEventListener('disconnected', () => { c.userData.source = null; });
  c.addEventListener('selectstart', () => {
    audio.unlock();
    const uv = controllerHit(c);
    if (uv) { const id = cockpit.click(uv); if (id) doAction(id); }
  });
  rig.add(c);
  controllers.push(c);
}
const tmpM = new THREE.Matrix4();
function controllerHit(c) {
  tmpM.identity().extractRotation(c.matrixWorld);
  ray.ray.origin.setFromMatrixPosition(c.matrixWorld);
  ray.ray.direction.set(0, 0, -1).applyMatrix4(tmpM);
  ray.far = 3;
  const hit = ray.intersectObject(model.interior.center, false)[0];
  return hit ? hit.uv : null;
}
const padPrev = new Map();
function pollXR() {
  const ses = renderer.xr.getSession();
  if (!ses) return;
  let hover = null;
  for (const c of controllers) {
    const uv = c.userData.source ? controllerHit(c) : null;
    if (uv) hover = uv;
    c.userData.line.scale.z = uv ? 0.6 : 1.2;
  }
  cockpit.hoverUV = hover;
  for (const src of ses.inputSources) {
    const gp = src.gamepad;
    if (!gp) continue;
    const key = src.handedness;
    const prev = padPrev.get(key) || {};
    const now = { y: gp.axes[3] || 0, a: !!gp.buttons[4]?.pressed, b: !!gp.buttons[5]?.pressed, stick: !!gp.buttons[3]?.pressed };
    const edge = (k) => now[k] && !prev[k];
    if (key === 'right') {
      if (now.y < -0.75 && !(prev.y < -0.75)) actions.warpUp();
      if (now.y > 0.75 && !(prev.y > 0.75)) actions.warpDown();
      if (edge('a')) actions.pause();
      if (edge('b')) cycleView();
    } else {
      if (edge('a')) cockpit.page = cockpit.page === 'menu' ? 'nav' : 'menu';
      if (edge('b') || edge('stick')) actions.recenter();
    }
    padPrev.set(key, now);
  }
}

// VR 안에서 잠깐 보이는 안내 글 (시선 앞)
const vrToastCanvas = document.createElement('canvas');
vrToastCanvas.width = 1024; vrToastCanvas.height = 160;
const vrToastTex = new THREE.CanvasTexture(vrToastCanvas);
vrToastTex.colorSpace = THREE.SRGBColorSpace;
const vrToastMesh = new THREE.Mesh(new THREE.PlaneGeometry(0.9, 0.14), new THREE.MeshBasicMaterial({ map: vrToastTex, transparent: true, depthTest: false, toneMapped: false }));
vrToastMesh.position.set(0, -0.22, -1.1);
vrToastMesh.renderOrder = 999;
vrToastMesh.visible = false;
camera.add(vrToastMesh);
let vrToastT = 0;
function vrToast(text) {
  const g = vrToastCanvas.getContext('2d');
  g.clearRect(0, 0, 1024, 160);
  g.fillStyle = 'rgba(8,14,24,0.82)';
  g.beginPath(); g.roundRect?.(0, 0, 1024, 160, 40); g.fill();
  g.fillStyle = '#fff'; g.font = `800 64px 'Noto Sans KR', sans-serif`; g.textAlign = 'center'; g.textBaseline = 'middle';
  g.fillText(text, 512, 84, 980);
  vrToastTex.needsUpdate = true;
  vrToastT = 2.4;
}

// ───────── 시작 / VR
async function checkVR() {
  if (!('xr' in navigator)) { ui.btnVR.textContent = 'VR 미지원 브라우저'; return; }
  try {
    const ok = await navigator.xr.isSessionSupported('immersive-vr');
    ui.btnVR.disabled = !ok;
    ui.btnVR.textContent = ok ? 'VR로 시작 (Meta Quest)' : '이 기기는 VR 불가 (PC 화면으로)';
  } catch { ui.btnVR.textContent = 'VR 확인 실패 (https 필요)'; }
}

function readStartForm() {
  const f = (n) => document.querySelector(`[name="${n}"]:checked`)?.value;
  S.dir = f('dir') || S.dir;
  S.seat = f('seat') || S.seat;
  S.departTime = $('opt-depart').value;
  S.durationMin = Number($('opt-duration').value);
  S.quality = $('opt-quality').value;
  S.imagery = $('opt-imagery').value;
  S.vworldKey = $('opt-vworld').value.trim();
  S.haze = $('opt-haze').value;
  S.comfort = $('opt-comfort').checked;
  save();
  terrain.setQuality(S.quality);
  trees.setQuality(S.quality);
  sky.setHaze(S.haze);
  if (terrain.imageryKey !== S.imagery || terrain.vworldKey !== S.vworldKey) terrain.setImagery(S.imagery, S.vworldKey);
  applyPixelRatio();
}

function fillStartForm() {
  const set = (n, v) => { const el = document.querySelector(`[name="${n}"][value="${v}"]`); if (el) el.checked = true; };
  set('dir', S.dir); set('seat', S.seat);
  $('opt-depart').value = S.departTime;
  $('opt-duration').value = String(S.durationMin);
  $('opt-quality').value = S.quality;
  $('opt-imagery').value = S.imagery;
  $('opt-vworld').value = S.vworldKey;
  $('opt-haze').value = S.haze;
  $('opt-comfort').checked = !!S.comfort;
  $('vworld-row').classList.toggle('hidden', S.imagery !== 'vworld');
}
$('opt-imagery').addEventListener('change', () => $('vworld-row').classList.toggle('hidden', $('opt-imagery').value !== 'vworld'));

function begin(resume) {
  audio.unlock();
  readStartForm();
  const prog = storage.get('vrtrip.progress', null);
  if (resume && prog) { S.dir = prog.dir; setupRoute(prog.dir, prog.t); }
  else if (!app.started || route.name !== S.dir || plan.totalSec !== S.durationMin * 60) setupRoute(S.dir, 0);
  app.started = true;
  app.paused = false;
  app.loading = true;
  app.loadT = 0;
  ui.start.classList.add('hidden');
  ui.hud.classList.remove('hidden');
  document.activeElement?.blur?.();
  recenter();
  if (!resume || app.tSim < 5) setTimeout(announceStart, 600);
}

function showStart() {
  app.paused = true;
  fillStartForm();
  ui.start.classList.remove('hidden');
}

ui.btnPC.addEventListener('click', () => begin(false));
ui.btnResume.addEventListener('click', async () => {
  if (renderer.xr.isPresenting) { begin(true); return; }
  begin(true);
});
ui.btnVR.addEventListener('click', async () => {
  audio.unlock();
  try {
    const q = S.quality;
    renderer.xr.setFramebufferScaleFactor(q === 'low' ? 0.85 : q === 'high' ? 1.25 : 1.0);
    renderer.xr.setFoveation(q === 'high' ? 0.5 : 1);
    const session = await navigator.xr.requestSession('immersive-vr', { optionalFeatures: ['local-floor', 'hand-tracking'] });
    session.addEventListener('end', () => { app.view = 'inside'; recenter(); applyPixelRatio(); });
    await renderer.xr.setSession(session);
    app.view = 'inside';
    begin(ui.btnVR.dataset.resume === '1');
    setTimeout(recenter, 400);
    setTimeout(recenter, 1500);
    renderer.xr.getReferenceSpace()?.addEventListener?.('reset', () => setTimeout(recenter, 50));
  } catch (err) {
    console.error(err);
    toast('VR을 시작하지 못했어요: ' + (err.message || err), 'bad');
  }
});
$('chk-resume-vr')?.addEventListener('change', (e) => { ui.btnVR.dataset.resume = e.target.checked ? '1' : '0'; });

// ───────── 루프
let last = performance.now(), saveT = 0, fpsT = 0, frames = 0;
app.prof = {};
let profT = 0;
const mark = (name) => { const t = performance.now(); app.prof[name] = (app.prof[name] || 0) * 0.95 + (t - profT) * 0.05; profT = t; };
const lookahead = new THREE.Vector3();
const origin = new THREE.Vector3();
let prevFlags = 0;
let tunnelF = 0;
function loop() {
  const now = performance.now();
  const rawDt = (now - last) / 1000;
  const dt = Math.min(rawDt, 0.1);
  last = now;
  app.frameMs = (app.frameMs || 16) * 0.9 + rawDt * 1000 * 0.1;
  if (!data || !plan) { renderer.render(scene, camera); return; }
  const xr = renderer.xr.isPresenting;
  profT = performance.now();
  if (xr) pollXR();
  // 시뮬레이션 시간
  if (app.started && !app.paused && !app.loading) app.tSim = Math.min(plan.duration, app.tSim + dt * app.warp);
  updatePose(dt);
  placeRig(dt);
  rig.updateMatrixWorld(true);
  camera.getWorldPosition(camWorld);
  // 앞으로 30초 뒤 위치 미리 받기
  const ahead = carPose(route, plan, Math.min(route.length, pose.s + Math.max(pose.v, 20) * 30 * Math.max(1, app.warp / 3)), {});
  lookahead.set(ahead.x, ahead.y + 2, ahead.z);
  const tnow = now / 1000;
  mark('pose');
  terrain.splitScale = xr ? 0.88 : 1;
  terrain.update(camWorld, tnow, lookahead);
  mark('terrain');
  roads.update(route, pose.s, app.loading ? 30 : 5);
  mark('roads');
  buildings.update(route, pose.s);
  trees.update(camWorld, tnow);
  mark('bld+trees');
  // 교통
  const jumped = Math.abs(pose.s - app.lastS) > 600;
  if (jumped) traffic.reset(route, pose.s, plan);
  if (!app.paused && !app.loading) {
    const simDt = dt * app.warp;
    const steps = Math.min(8, Math.ceil(simDt / 0.2));
    for (let k = 0; k < steps; k++) traffic.update(simDt / steps, pose.s, pose.v, pose.lat);
  }
  app.lastS = pose.s;
  origin.set(pose.x, pose.y, pose.z);
  traffic.render(origin);
  mark('traffic');
  for (const ev of traffic.events.splice(0)) {
    if (app.warp <= 2 && app.view === 'inside') audio.whoosh(ev.big, ev.kind === 'oncoming' ? -1 : ev.side, ev.rel || 30);
  }
  // 터널·교량
  const fl = route.flagAt(pose.s);
  const inT = (route.flagAt(pose.s + 15) & F_TUNNEL) && (route.flagAt(pose.s - 25) & F_TUNNEL) ? 1 : (fl & F_TUNNEL ? 0.6 : 0);
  tunnelF = damp(tunnelF, inT, 3, dt);
  if (((fl ^ prevFlags) & F_BRIDGE) && app.warp <= 2 && pose.v > 5) audio.thump(0.22);
  prevFlags = fl;
  // 하늘·빛
  const ll = toLonLat(pose.x, pose.z);
  const date = new Date(departDate().getTime() + app.tSim * 1000);
  const sk = sky.update(date, ll.lat, ll.lon, camWorld, dt, tunnelF);
  buildings.uniforms.night.value = sk.night;
  // 해 질 녘부터 불빛: 다른 차 전조등·후미등, 표지판 반사, 내 차 전조등 (터널에서도 켬)
  const dusk = clamp(1 - sk.day, 0, 1);
  traffic.setLamps(Math.max(dusk, tunnelF * 0.85));
  setSignGlow(dusk * 0.5);
  terrain.shared.hlI.value = dusk;
  headLight.intensity = dusk * 300;
  terrain.shared.hlPos.value.set(pose.x + pose.tx * 2.3, pose.y + 0.7, pose.z + pose.tz * 2.3);
  terrain.shared.hlDir.value.set(pose.tx, -0.06, pose.tz).normalize();
  model.mats.head.color.setHex(dusk > 0.3 ? 0xf4f8ff : 0x9aa4b4);
  // 처음/이동 직후: 가까운 지형이 준비될 때까지 기다림
  if (app.loading) {
    if (!app.loadT && xr) vrToast('지형·위성사진 불러오는 중…');
    app.loadT = (app.loadT || 0) + dt;
    const zNear = terrain.detailAt(camWorld);
    const roadsLeft = roads.missing(route, pose.s);
    if ((zNear >= Math.min(15, terrain.q.maxZ) && roadsLeft === 0 && app.loadT > 1) || app.loadT > 25) { app.loading = false; app.loadT = 0; }
  }
  mark('sky');
  const st = status();
  cockpit.update(dt, st);
  mark('cockpit');
  audio.update(dt, { v: pose.v, tunnel: tunnelF, bridge: !!(fl & F_BRIDGE), warp: app.warp, paused: app.paused || app.loading });
  audio.blinker(!!app.turn && app.warp <= 2, dt);
  if (app.started && !app.paused) announce(pose.s);
  if (!xr) updateHud(st, dt);
  if (vrToastT > 0) { vrToastT -= dt; vrToastMesh.visible = xr && vrToastT > 0; }
  // 디지털 미러 (VR에서는 한 프레임에 하나씩)
  mark('misc');
  cockpit.renderMirrors(renderer, scene, S.mirrors && app.view === 'inside' && S.quality !== 'low');
  mark('mirrors');
  renderer.render(scene, camera);
  mark('render');
  // 진행 저장
  if (app.started && (saveT += dt) > 5) { saveT = 0; storage.set('vrtrip.progress', { dir: S.dir, t: app.tSim }); }
  frames++; fpsT += dt;
  if (fpsT > 1) { app.fps = frames / fpsT; frames = 0; fpsT = 0; }
}

window.addEventListener('resize', () => {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  applyPixelRatio();
});

fillStartForm();
renderer.setAnimationLoop(loop);
init().catch((e) => { console.error(e); ui.status.textContent = '데이터를 불러오지 못했어요: ' + e.message; });
app.QUALITY = QUALITY;
