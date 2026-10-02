// VR 운전면허 마스터 — 진입점
import * as THREE from 'three';
import { createCourse } from './course.js';
import { buildWorld } from './world.js';
import { buildCarModel, updateCarVisual, CAR } from './carModel.js';
import { Vehicle } from './vehicle.js';
import { Cockpit, LAYER_HUD } from './cockpit.js';
import { Input } from './input.js';
import { Exam } from './exam.js';
import { createCityModel, buildCity } from './city.js';
import { RoadExam } from './roadtest.js';
import { AudioSys } from './audio.js';
import { UI } from './ui.js';
import { TouchPad } from './touchpad.js';
import { storage, clamp } from './util.js';

const DEFAULT_SETTINGS = {
  voice: true,
  sfx: true,
  guide: true,
  rearCam: true,
  mirrors: true,
  desktopHud: false,
  hillHold: false,
  quality: 'mid',
  footMode: 'off',
  footCal: null,
  padMap: null,
  seatOffset: 0,
  easy: true,        // 간편 조작: 브레이크 없이 시동/변속해도 자동으로 브레이크를 밟아 줌
  touchPad: 'auto',  // 화면 조작 버튼: auto(터치 기기) / on / off
  steerRange: 'normal', // 핸들 감도: quick(한쪽 3/4바퀴) / normal(1바퀴) / real(1.25바퀴)
  autoCenter: true,     // 손을 떼면 핸들이 천천히 가운데로 복귀
};
const STEER_RANGE = { quick: 270, normal: 360, real: 450 };
function applySteerRange() {
  CAR.maxWheelAngle = ((STEER_RANGE[app.settings.steerRange] || 360) * Math.PI) / 180;
}

const app = {
  started: false,
  paused: false,
  view: 'driver',
  settings: { ...DEFAULT_SETTINGS, ...storage.get('vrdrive.settings', {}) },
};
window.vrDrive = app; // 디버깅용

// ───────── 렌더러
const renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' });
renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.0;
renderer.xr.enabled = true;
renderer.xr.setReferenceSpaceType('local');
document.getElementById('app').appendChild(renderer.domElement);
app.renderer = renderer;

function applyQuality() {
  const q = app.settings.quality;
  const dpr = window.devicePixelRatio || 1;
  renderer.setPixelRatio(q === 'low' ? Math.min(dpr, 0.8) : q === 'high' ? Math.min(dpr, 2) : Math.min(dpr, 1.25));
  renderer.setSize(window.innerWidth, window.innerHeight);
}

const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(70, window.innerWidth / window.innerHeight, 0.05, 1500);
camera.layers.enable(LAYER_HUD);

// ───────── 코스, 환경, 차량
const course = createCourse();
app.course = course;
const world = buildWorld(scene, course, renderer);
app.world = world;

// 도로주행용 도시 (평소엔 숨겨 둠)
const cityModel = createCityModel();
const city = buildCity(scene, cityModel);
app.city = city;
app.map = 'course';

const model = buildCarModel({ color: 0x1f6fff, interior: true, plate: '12가 2026' });
scene.add(model.root);
app.model = model;

const car = new Vehicle(course);
app.car = car;
car.placeAt(course.zones.startPos);
car.hillHold = app.settings.hillHold;
car.easy = app.settings.easy;
applySteerRange();

// 운전석 시점 리그 (VR에서는 머리 위치가 여기에 맞춰짐)
const rig = new THREE.Group();
model.root.add(rig);
rig.add(camera);
app.rig = rig;
function eyeTarget() {
  return CAR.eye.clone().add(new THREE.Vector3(0, 0, app.settings.seatOffset));
}
rig.position.copy(eyeTarget());

const audio = new AudioSys();
audio.voiceOn = app.settings.voice;
audio.sfxOn = app.settings.sfx;
app.audio = audio;

const exam = new Exam({ car, course, world });
const roadExam = new RoadExam({ car, city });
app.exams = { course: exam, road: roadExam };
app.exam = exam; // 지금 진행 중인 시험(장내 또는 도로주행)

// 장내 코스 ↔ 도시 전환
function setMap(name) {
  if (app.map === name) return;
  app.map = name;
  world.root.visible = name === 'course';
  city.root.visible = name === 'city';
  car.course = name === 'course' ? course : null;
  world.setAlarm(false);
  audio.alarm(false);
}
const COURSE_BOUNDS = car.bounds;
function useCourse() {
  roadExam.stop();
  setMap('course');
  car.bounds = COURSE_BOUNDS;
  app.exam = exam;
}
function useCity() {
  exam.stop();
  setMap('city');
  car.bounds = cityModel.bounds;
  app.exam = roadExam;
}

const cockpit = new Cockpit({ model, car, exam, app });
app.cockpit = cockpit;

// ───────── 주행 궤적 가이드 (연습용)
const guide = (() => {
  const mat = new THREE.MeshBasicMaterial({ color: 0x3ddcff, transparent: true, opacity: 0.7, depthWrite: false });
  const N = 24;
  const make = () => {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(new Float32Array((N + 1) * 2 * 3), 3));
    const idx = [];
    for (let i = 0; i < N; i++) { const k = i * 2; idx.push(k, k + 1, k + 2, k + 1, k + 3, k + 2); }
    g.setIndex(idx);
    const m = new THREE.Mesh(g, mat);
    m.frustumCulled = false;
    m.renderOrder = 3;
    model.root.add(m);
    return m;
  };
  const lines = [make(), make()];
  return {
    update() {
      const show = app.settings.guide && !app.exam.scoring && car.power && (car.gear === 'D' || car.gear === 'R') && Math.abs(car.v) < 7;
      lines.forEach((l) => { l.visible = show; });
      if (!show) return;
      const rev = car.gear === 'R';
      mat.color.setHex(rev ? 0xffd23a : 0x3ddcff);
      const L = CAR.wheelbase;
      const k = Math.tan(car.steer) / L;
      const len = rev ? -7 : 9;
      const fwdOff = rev ? 0 : L; // 후진은 뒷바퀴, 전진은 앞바퀴 궤적
      [-1, 1].forEach((side, li) => {
        const arr = lines[li].geometry.attributes.position.array;
        for (let i = 0; i <= N; i++) {
          const u = (len * i) / N;
          const th = k * u;
          const px = Math.abs(k) < 1e-5 ? 0 : (1 - Math.cos(th)) / k;
          const pz = (Math.abs(k) < 1e-5 ? -u : -Math.sin(th) / k) + L / 2;
          // 회전된 오른쪽/앞 방향
          const rx = Math.cos(th), rz = Math.sin(th);
          const fx = Math.sin(th), fz = -Math.cos(th);
          for (let e = 0; e < 2; e++) {
            const w = side * (CAR.track / 2) + (e ? 0.07 : -0.07);
            const x = px + rx * w + fx * fwdOff;
            const z = pz + rz * w + fz * fwdOff;
            const o = (i * 2 + e) * 3;
            arr[o] = x; arr[o + 1] = 0.05; arr[o + 2] = z;
          }
        }
        lines[li].geometry.attributes.position.needsUpdate = true;
      });
    },
  };
})();

// ───────── 동작
function saveSettings() {
  storage.set('vrdrive.settings', app.settings);
}

const actions = {
  startExam() {
    app.paused = false;
    cockpit.page = 'home';
    useCourse();
    exam.startExam();
  },
  startPractice() {
    cockpit.page = 'home';
    const fresh = app.map !== 'course';
    useCourse();
    exam.startPractice(fresh ? 0 : null);
  },
  startDrill() {
    cockpit.page = 'home';
    if (app.map !== 'course') { useCourse(); exam.startPractice(0); }
    exam.startDeviceDrill();
  },
  jump(i) {
    useCourse();
    exam.startPractice(i);
  },
  startRoad(practice = false) {
    app.paused = false;
    cockpit.page = 'home';
    useCity();
    roadExam.start(practice);
  },
  recenter() {
    recenter();
  },
  setSetting(key, value) {
    app.settings[key] = value;
    saveSettings();
    if (key === 'voice') { audio.voiceOn = value; if (!value && 'speechSynthesis' in window) speechSynthesis.cancel(); }
    if (key === 'sfx') audio.sfxOn = value;
    if (key === 'hillHold') car.hillHold = value;
    if (key === 'easy') car.easy = value;
    if (key === 'steerRange') applySteerRange();
    if (key === 'quality') applyQuality();
  },
  startFootCalib() { input.startFootCalib(); },
  startPadCalib() {
    input.startPadCalib();
    if (!renderer.xr.isPresenting && ui.modalKind !== 'pedals') ui.open('pedals');
  },
  seat(delta) {
    app.settings.seatOffset = clamp(app.settings.seatOffset + delta, -0.2, 0.2);
    saveSettings();
    recenter();
  },
};
app.actions = actions;

app.doAction = (name, source) => {
  audio.unlock();
  switch (name) {
    case 'gearP': case 'gearR': case 'gearN': case 'gearD': car.shift(name.slice(4)); break;
    case 'shiftUp': car.shiftStep(-1); break;
    case 'shiftDown': car.shiftStep(1); break;
    case 'turnL': car.setTurn(-1); break;
    case 'turnR': car.setTurn(1); break;
    case 'hazard': car.toggleHazard(); break;
    case 'lights': car.toggleLights(); break;
    case 'high': car.toggleHigh(); break;
    case 'lightsUp': car.lightsStep(1); break;
    case 'lightsDown': car.lightsStep(-1); break;
    case 'wiper': car.cycleWiper(); break;
    case 'belt': car.toggleBelt(); break;
    case 'epb': car.toggleEPB(); break;
    case 'power': car.togglePower(); break;
    case 'horn': audio.horn(true); setTimeout(() => audio.horn(false), 350); break;
    case 'view': cycleView(); break;
    case 'recenter': recenter(); break;
    case 'menu': ui.toggleMenu(); break;
    case 'help': ui.open('help'); break;
    case 'mute': actions.setSetting('voice', !app.settings.voice); ui.toast(app.settings.voice ? '음성 안내 켬' : '음성 안내 끔', 'info'); break;
    default: break;
  }
  void source;
};

// ───────── 이벤트 연결
car.on('message', (text, kind) => {
  ui.toast(text, kind === 'warn' ? 'bad' : 'info');
  cockpit.showFlash(text, kind === 'warn' ? '#b8860b' : '#2a6fd6', 2.2);
  if (renderer.xr.isPresenting && kind === 'warn') audio.speak(text);
});
car.on('blink', (on) => audio.tick(on));
car.on('shift', () => audio.chime('shift'));
car.on('power', (on) => audio.chime(on ? 'power' : 'off'));
car.on('belt', (on) => { audio.chime(on ? 'belt' : 'button'); model.interior.setBelt(on); });
car.on('epb', () => audio.chime('button'));
car.on('denied', () => { audio.chime('warn'); input.hapticAll(0.3, 60); });
for (const ev of ['turn', 'hazard', 'lights', 'wiper']) car.on(ev, () => audio.chime('button'));

for (const ex of [exam, roadExam]) wireExam(ex);
function wireExam(exam) {
exam.on('say', (text, speak) => { ui.setInstruction(text); if (speak) audio.speak(text); });
exam.on('hint', (text) => ui.setHint(text));
exam.on('notice', (text) => {
  ui.toast(text, 'bad');
  cockpit.showFlash(text, '#b8860b', 2.2);
  audio.chime('warn');
});
exam.on('penalty', (pts, reason) => {
  ui.toast(`-${pts}점 · ${reason}`, 'bad');
  cockpit.showFlash(`-${pts}점  ${reason}`, '#d4314a', 2.8);
  audio.chime('penalty');
  input.hapticAll(0.9, 150);
});
exam.on('warn', (text) => {
  ui.toast(text, 'bad');
  cockpit.showFlash(text, '#b8860b', 2.6);
  audio.chime('warn');
  audio.speak(text);
});
exam.on('ok', (text) => {
  ui.toast(text, 'ok');
  cockpit.showFlash(text, '#1f9e5a', 1.3);
  audio.chime('ok');
});
exam.on('alarm', (on) => { audio.alarm(on); if (on) input.hapticAll(1, 300); });
exam.on('rumble', (v) => input.hapticAll(v, 60));
exam.on('result', (r) => {
  audio.chime(r.pass ? 'pass' : 'fail');
  cockpit.page = 'home';
  ui.showResult(r);
});
exam.on('started', () => { if (ui.modalKind === 'result') ui.closeModal(); });
}

app.scene = scene;
app.camera = camera;
app.refreshVisual = () => updateCarVisual(model, car, 0); // 디버깅/스크린샷용

const input = new Input(app);
app.input = input;
const ui = new UI(app);
app.ui = ui;
const touchpad = new TouchPad(app);
app.touchpad = touchpad;

// ───────── 지금 쓰는 입력 장치에 맞춘 조작 안내
app.inputMode = () => {
  if (renderer.xr.isPresenting) return input.handsActive ? 'hand' : 'xr';
  if (touchpad.shouldShow()) return 'touch';
  if (input.padNames.length) return 'pad';
  return 'keyboard';
};
const TIPS = {
  brake: { hand: '왼손 엄지·검지 집기', xr: '왼손 트리거', touch: '화면 오른쪽 아래 [브레이크] 버튼', pad: '왼쪽 트리거(LT) 또는 브레이크 페달', keyboard: '↓ 키' },
  accel: { hand: '오른손 엄지·검지 집기', xr: '오른손 트리거', touch: '[가속] 버튼', pad: '오른쪽 트리거(RT) 또는 가속 페달', keyboard: '↑ 키' },
  start: { hand: 'START 버튼을 검지로', xr: 'START 버튼(손끝으로) 또는 오른손 스틱 누르기', touch: '[START] 버튼', pad: 'A 버튼', keyboard: 'Enter 키' },
  belt: { hand: '시트 오른쪽 빨간 [안전벨트] 버튼을 검지로', xr: '시트 옆 빨간 [안전벨트] 버튼(손끝으로)', touch: '[벨트] 버튼', pad: '십자키 ←', keyboard: 'B 키' },
  epb: { hand: '콘솔 [EPB] 버튼을 검지로', xr: '콘솔 [EPB] 버튼 또는 왼손 스틱 누르기', touch: '[EPB] 버튼', pad: 'B 버튼', keyboard: 'Space 키' },
  hazard: { hand: '대시보드 빨간 삼각형 버튼', xr: '왼손 Y 버튼', touch: '[비상등] 버튼', pad: 'X 버튼', keyboard: 'F 키' },
  turnL: { hand: '핸들 왼쪽 ◀ 버튼', xr: '왼손 X 버튼', touch: '[◀ 깜빡] 버튼', pad: 'LB 버튼', keyboard: 'Q 키' },
  turnR: { hand: '핸들 오른쪽 ▶ 버튼', xr: '오른손 A 버튼', touch: '[깜빡 ▶] 버튼', pad: 'RB 버튼', keyboard: 'E 키' },
  gear: { hand: '콘솔 P·R·N·D 버튼을 검지로', xr: '콘솔 P·R·N·D 버튼 또는 오른손 스틱 앞/뒤', touch: '[P][R][N][D] 버튼', pad: '십자키 ↑/↓', keyboard: 'P·R·N·D 키' },
  lights: { hand: '대시보드 왼쪽 [전조등]·[상향등] 버튼', xr: '왼손 스틱 앞/뒤', touch: '[전조등]·[상향] 버튼', pad: '십자키 →(전조등)', keyboard: 'L(전조등)·K(상향등) 키' },
  wiper: { hand: '대시보드 왼쪽 [와이퍼] 버튼', xr: '오른손 B 버튼', touch: '[와이퍼] 버튼', pad: 'Y 버튼', keyboard: 'W 키' },
};
app.tip = (key) => {
  const mode = app.inputMode();
  if (key === 'brake' && mode === 'xr' && app.settings.footMode !== 'off' && app.settings.footCal) return '발(브레이크 쪽으로 돌려 밟기) 또는 왼손 트리거';
  if (key === 'prep') {
    const easy = app.settings.easy ? ' (간편 조작: START만 눌러도 브레이크가 자동으로 밟혀요)' : '';
    return `① 안전벨트: ${app.tip('belt')}  ② 시동: 브레이크(${app.tip('brake')})를 밟은 채 ${app.tip('start')}${easy}`;
  }
  return TIPS[key]?.[mode] ?? '';
};
car.brakeHint = () => app.tip('brake');
exam.tip = app.tip;
roadExam.tip = app.tip;

// ───────── 시점 (PC)
const look = { yaw: 0, pitch: -0.08 };
function setDriverCamera() {
  if (camera.parent !== rig) rig.add(camera);
  camera.position.set(0, 0, 0);
  camera.rotation.set(look.pitch, look.yaw, 0, 'YXZ');
  camera.fov = 70;
  camera.updateProjectionMatrix();
}
function cycleView() {
  if (renderer.xr.isPresenting) return;
  app.view = app.view === 'driver' ? 'chase' : app.view === 'chase' ? 'top' : 'driver';
  if (app.view === 'driver') setDriverCamera();
  else if (camera.parent !== scene) scene.add(camera);
  ui.toast({ driver: '운전석 시점', chase: '3인칭 시점', top: '위에서 보기 (주차 연습)' }[app.view], 'info');
}
let showcaseT = 0;
function updateDesktopCamera(dt) {
  if (!app.started) {
    showcaseT += dt * 0.12;
    const a = showcaseT + 2.2;
    camera.position.set(car.x + Math.sin(a) * 7.5, 1.7, car.z + Math.cos(a) * 7.5);
    camera.lookAt(car.x, 0.8, car.z);
    return;
  }
  if (app.view === 'driver') {
    camera.rotation.set(look.pitch, look.yaw, 0, 'YXZ');
    return;
  }
  const f = car.forward;
  const target = new THREE.Vector3(car.x, car.y + 1, car.z);
  let want;
  if (app.view === 'chase') {
    want = new THREE.Vector3(car.x - f.x * 8.5, car.y + 3.4, car.z - f.z * 8.5);
    camera.position.lerp(want, 1 - Math.exp(-6 * dt));
    camera.lookAt(target.x + f.x * 3, target.y, target.z + f.z * 3);
  } else {
    want = new THREE.Vector3(car.x - f.x * 2, car.y + 17, car.z - f.z * 2);
    camera.position.lerp(want, 1 - Math.exp(-6 * dt));
    camera.up.set(f.x, 0, f.z);
    camera.lookAt(target);
    camera.up.set(0, 1, 0);
  }
}

// 마우스: 드래그로 둘러보기, 클릭으로 버튼/화면 누르기
const pointer = { down: false, x: 0, y: 0, moved: 0 };
const raycaster = new THREE.Raycaster();
function pickCockpit(ev) {
  const rect = renderer.domElement.getBoundingClientRect();
  const ndc = new THREE.Vector2(((ev.clientX - rect.left) / rect.width) * 2 - 1, -((ev.clientY - rect.top) / rect.height) * 2 + 1);
  raycaster.setFromCamera(ndc, camera);
  raycaster.far = 3;
  const hits = raycaster.intersectObjects(cockpit.interactiveObjects(), false);
  return hits[0] || null;
}
renderer.domElement.addEventListener('pointerdown', (e) => {
  pointer.down = true; pointer.x = e.clientX; pointer.y = e.clientY; pointer.moved = 0;
  renderer.domElement.setPointerCapture?.(e.pointerId);
});
renderer.domElement.addEventListener('pointermove', (e) => {
  if (pointer.down) {
    const dx = e.clientX - pointer.x, dy = e.clientY - pointer.y;
    pointer.moved += Math.abs(dx) + Math.abs(dy);
    pointer.x = e.clientX; pointer.y = e.clientY;
    if (app.view === 'driver') {
      look.yaw = clamp(look.yaw - dx * 0.004, -2.2, 2.2);
      look.pitch = clamp(look.pitch - dy * 0.004, -1.0, 0.8);
    }
  } else if (app.view === 'driver' && app.started) {
    const hit = pickCockpit(e);
    cockpit.hoverUV = hit && hit.object === model.interior.center ? hit.uv : null;
    renderer.domElement.style.cursor = hit ? 'pointer' : 'grab';
  }
});
renderer.domElement.addEventListener('pointerup', (e) => {
  pointer.down = false;
  if (pointer.moved < 6 && app.view === 'driver' && app.started && !app.paused) {
    audio.unlock();
    const hit = pickCockpit(e);
    if (hit) {
      const id = cockpit.idForObject(hit.object);
      if (id === 'screen') cockpit.screenClick(hit.uv);
      else if (id) { cockpit.pressButtonVisual(id); app.doAction(id, 'mouse'); }
    }
  }
});
renderer.domElement.addEventListener('wheel', (e) => {
  if (app.view !== 'driver' || renderer.xr.isPresenting) return;
  camera.fov = clamp(camera.fov + Math.sign(e.deltaY) * 4, 40, 90);
  camera.updateProjectionMatrix();
}, { passive: true });
renderer.domElement.addEventListener('dblclick', () => { look.yaw = 0; look.pitch = -0.08; });

// ───────── VR
function recenter() {
  const eye = eyeTarget();
  if (renderer.xr.isPresenting) {
    const p = camera.position.clone();
    const e = new THREE.Euler().setFromQuaternion(camera.quaternion, 'YXZ');
    rig.rotation.set(0, -e.y, 0);
    p.applyAxisAngle(new THREE.Vector3(0, 1, 0), -e.y);
    rig.position.copy(eye).sub(p);
  } else {
    rig.rotation.set(0, 0, 0);
    rig.position.copy(eye);
    look.yaw = 0; look.pitch = -0.08;
  }
}

async function checkVR() {
  if (!('xr' in navigator)) {
    ui.setVRAvailable(false, 'VR을 지원하지 않는 브라우저예요. Meta Quest 브라우저나 PC VR(Chrome/Edge)에서 열어 주세요. PC 화면으로도 연습할 수 있어요.');
    return;
  }
  try {
    const ok = await navigator.xr.isSessionSupported('immersive-vr');
    if (ok) ui.setVRAvailable(true, 'VR 헤드셋이 준비됐어요. 의자에 앉아서 시작하세요.');
    else ui.setVRAvailable(false, '이 기기에서는 VR 모드를 쓸 수 없어요. PC 화면으로 연습할 수 있어요.');
  } catch {
    ui.setVRAvailable(false, 'VR 확인 중 오류가 발생했어요. (https 주소인지 확인해 주세요)');
  }
}

app.enterVR = async (mode) => {
  audio.unlock();
  try {
    const session = await navigator.xr.requestSession('immersive-vr', { optionalFeatures: ['local-floor', 'hand-tracking'] });
    session.addEventListener('end', onSessionEnd);
    await renderer.xr.setSession(session);
    app.view = 'driver';
    setDriverCamera();
    beginSession(mode);
    setTimeout(recenter, 400);
    setTimeout(recenter, 1500);
    const ref = renderer.xr.getReferenceSpace();
    ref?.addEventListener?.('reset', () => setTimeout(recenter, 50));
  } catch (err) {
    console.error(err);
    ui.toast('VR을 시작하지 못했어요: ' + (err.message || err), 'bad');
  }
};

function onSessionEnd() {
  setDriverCamera();
  recenter();
  applyQuality();
}

app.startDesktop = (mode) => {
  audio.unlock();
  setDriverCamera();
  beginSession(mode);
};

function beginSession(mode) {
  app.started = true;
  app.paused = false;
  // 시작 버튼에 포커스가 남아 있으면 Enter/Space(시동/EPB)가 버튼을 다시 누르게 됨
  document.activeElement?.blur?.();
  ui.hideStart();
  if (mode === 'exam') actions.startExam();
  else if (mode === 'road') actions.startRoad(false);
  else if (mode === 'roadPractice') actions.startRoad(true);
  else actions.startPractice();
}

// ───────── 루프
let lastT = performance.now();
let fpsT = 0, frames = 0;
function loop() {
  const now = performance.now();
  const dt = Math.min((now - lastT) / 1000, 0.05);
  lastT = now;
  const xr = renderer.xr.isPresenting;
  input.update(dt);
  if (app.started && !app.paused) {
    car.update(dt);
  }
  if (app.map === 'city') {
    if (app.started && !app.paused) city.update(dt, car);
  } else {
    world.update(dt, car);
  }
  if (app.started && !app.paused) app.exam.update(dt);
  // 손이 처음 인식되면 손 조작법을 한 번 알려 줌
  if (input.handsActive && !app.handTipShown) {
    app.handTipShown = true;
    const t = '손으로 운전: 핸들 테두리에서 주먹을 쥐고 돌리기, 오른손 엄지·검지 집기는 가속, 왼손 집기는 브레이크, 버튼은 검지로 누르기';
    cockpit.showFlash('손 인식됨 · 주먹=핸들 · 집기=페달', '#2a6fd6', 4);
    ui.toast(t, 'info');
    audio.speak(t);
  }
  updateCarVisual(model, car, dt);
  guide.update();
  cockpit.update(dt, xr);
  audio.update(car, dt);
  if (!xr) updateDesktopCamera(dt);
  ui.update();
  touchpad.render();
  cockpit.renderMirrors(renderer, scene, xr);
  renderer.render(scene, camera);
  frames++;
  fpsT += dt;
  if (fpsT > 1) { app.fps = frames / fpsT; frames = 0; fpsT = 0; }
}

window.addEventListener('resize', () => {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  applyQuality();
});

applyQuality();
scene.add(camera); // 시작 화면에서는 차 주위를 천천히 도는 쇼케이스 시점
cockpit.update(0, false);
renderer.setAnimationLoop(loop);
checkVR();
