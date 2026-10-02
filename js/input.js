// 입력: 키보드 · 레이싱 휠/페달(Gamepad API) · VR 컨트롤러 · 발에 묶은 VR 컨트롤러
import * as THREE from 'three';
import { CAR } from './carModel.js';
import { clamp, approach } from './util.js';

const KEYMAP = {
  KeyP: 'gearP', KeyR: 'gearR', KeyN: 'gearN', KeyD: 'gearD',
  KeyQ: 'turnL', KeyE: 'turnR', KeyF: 'hazard', KeyL: 'lights', KeyK: 'high', KeyW: 'wiper',
  KeyB: 'belt', Space: 'epb', Enter: 'power', NumpadEnter: 'power',
  KeyV: 'view', KeyC: 'recenter', Escape: 'menu', F1: 'help', KeyM: 'mute',
  BracketLeft: 'shiftUp', BracketRight: 'shiftDown',
};

const tmpV = new THREE.Vector3();
const ZERO_M = new THREE.Matrix4().makeScale(0, 0, 0);
const tmpV2 = new THREE.Vector3();
const tmpQ = new THREE.Quaternion();

// 쿼터니언 → 회전 벡터(축 × 각도)
export function rotVec(q) {
  let { x, y, z, w } = q;
  if (w < 0) { x = -x; y = -y; z = -z; w = -w; }
  const s = Math.sqrt(Math.max(0, 1 - w * w));
  const angle = 2 * Math.acos(Math.min(1, w));
  if (s < 1e-5) return new THREE.Vector3(2 * x, 2 * y, 2 * z);
  return new THREE.Vector3(x / s, y / s, z / s).multiplyScalar(angle);
}

// 발 보정값으로부터 페달 입력 계산 (뒤꿈치를 축으로 좌우 = 페달 선택, 발끝 누르기 = 밟는 양)
export function footPedals(cal, q) {
  const rest = new THREE.Quaternion().fromArray(cal.rest);
  const rel = rest.invert().multiply(q);
  const r = rotVec(rel);
  const pressAxis = new THREE.Vector3().fromArray(cal.pressAxis);
  const pivotAxis = new THREE.Vector3().fromArray(cal.pivotAxis);
  const press = r.dot(pressAxis);
  const pivot = r.dot(pivotAxis) / cal.pivotAngle;
  const dz = 0.07;
  const onBrake = pivot > 0.5;
  let throttle = 0, brake = 0;
  if (onBrake) brake = clamp(((press - cal.brakeRest) / cal.brakePress - dz) / (1 - dz), 0, 1);
  else throttle = clamp((press / cal.pressAngle - dz) / (1 - dz), 0, 1);
  return { throttle, brake, pivot, onBrake };
}

// ───────── 손 추적 (Meta Quest 핸드 트래킹)
export const HAND_JOINTS = [
  'wrist',
  'thumb-metacarpal', 'thumb-phalanx-proximal', 'thumb-phalanx-distal', 'thumb-tip',
  'index-finger-metacarpal', 'index-finger-phalanx-proximal', 'index-finger-phalanx-intermediate', 'index-finger-phalanx-distal', 'index-finger-tip',
  'middle-finger-metacarpal', 'middle-finger-phalanx-proximal', 'middle-finger-phalanx-intermediate', 'middle-finger-phalanx-distal', 'middle-finger-tip',
  'ring-finger-metacarpal', 'ring-finger-phalanx-proximal', 'ring-finger-phalanx-intermediate', 'ring-finger-phalanx-distal', 'ring-finger-tip',
  'pinky-finger-metacarpal', 'pinky-finger-phalanx-proximal', 'pinky-finger-phalanx-intermediate', 'pinky-finger-phalanx-distal', 'pinky-finger-tip',
];
export const HAND = {
  fistClose: 0.115,  // 가운데·약지 끝이 손목에서 이만큼 가까우면 주먹 (핸들 잡기)
  fistOpen: 0.135,   // 이만큼 멀어지면 주먹을 편 것
  pinchFull: 0.012,  // 엄지·검지 끝 거리: 완전히 집음
  pinchNone: 0.045,  // 이보다 멀면 안 집음 (손을 편하게 두었을 때 가속되지 않게)
  extended: 0.13,    // 가운데 손가락이 펴져 있어야 '집기'로 인정 (주먹과 구분)
};

// 관절 위치(월드) → 주먹/집기 상태
export function analyzeHand(p) {
  const w = p.wrist, it = p['index-finger-tip'], tt = p['thumb-tip'];
  const mt = p['middle-finger-tip'], rt = p['ring-finger-tip'];
  const mp = p['middle-finger-phalanx-proximal'] || p['middle-finger-metacarpal'];
  if (!w || !it || !tt || !mt || !rt || !mp) return { tracked: false };
  const curl = (mt.distanceTo(w) + rt.distanceTo(w)) / 2;
  const pinchDist = it.distanceTo(tt);
  const pinch = clamp((HAND.pinchNone - pinchDist) / (HAND.pinchNone - HAND.pinchFull), 0, 1);
  return {
    tracked: true,
    curl,
    pinch,
    pinchDist,
    midExtended: mt.distanceTo(w) > HAND.extended,
    indexTip: it.clone(),
    grabPoint: w.clone().lerp(mp, 0.8), // 주먹 쥐었을 때 핸들 테두리가 오는 곳
  };
}

const axisNorm = (v, rest, full) => (full === rest ? 0 : clamp((v - rest) / (full - rest), 0, 1));
const dead = (v, d = 0.04) => (v < d ? 0 : (v - d) / (1 - d));

function isXRPad(p) {
  return !!p.hand || /oculus|openvr|touch|spatial|vive|knuckles|quest|meta/i.test(p.id);
}

// ───────── 보정 마법사 (발 컨트롤러)
class FootCalib {
  constructor(input) {
    this.input = input;
    this.kind = 'foot';
    this.active = true;
    this.title = '발 컨트롤러 보정';
    this.stepIndex = 0;
    this.error = '';
    this.done = false;
    this.data = {};
    this.canSkip = false;
    this.steps = [
      '컨트롤러를 오른발 등(신발 끈 위)에 단단히 묶고, 의자에 앉아 뒤꿈치를 바닥에 대세요. 발을 가속 페달 위치에 "올려놓기만" 하고 [측정]을 누르세요.',
      '뒤꿈치는 바닥에 붙인 채 가속 페달을 "끝까지 밟는" 자세를 유지하고 [측정]을 누르세요.',
      '뒤꿈치를 축으로 발끝을 왼쪽(브레이크 페달 위치)으로 옮겨 "올려놓기만" 하고 [측정]을 누르세요.',
      '브레이크 페달을 "끝까지 밟는" 자세를 유지하고 [측정]을 누르세요.',
    ];
  }
  get stepCount() { return this.steps.length; }
  get prompt() { return this.done ? '보정 완료! 이제 발로 가속·브레이크를 조작할 수 있어요. 실제 운전처럼 오른발 하나로 두 페달을 번갈아 밟으세요.' : this.steps[this.stepIndex]; }
  get canCapture() { return !this.done; }
  get meters() {
    const cal = this.input.app.settings.footCal;
    const q = this.input.footQuat;
    if (!cal || !q) return null;
    const f = footPedals(cal, q);
    return [
      { label: '가속', value: f.throttle },
      { label: '브레이크', value: f.brake },
      { label: '발 위치', value: clamp(f.pivot, 0, 1) },
    ];
  }
  capture() {
    const q = this.input.footQuat;
    if (!q) {
      this.error = '발에 묶은 컨트롤러가 보이지 않아요. VR 모드에서 [설정]의 발 컨트롤러 모드를 켜세요.';
      return;
    }
    this.error = '';
    const d = this.data;
    const qc = q.clone();
    if (this.stepIndex === 0) {
      d.rest = qc;
    } else {
      const rel = d.rest.clone().invert().multiply(qc);
      const r = rotVec(rel);
      if (this.stepIndex === 1) {
        if (r.length() < 0.12) { this.error = '각도 변화가 너무 작아요. 더 깊게 밟아 주세요.'; return; }
        d.pressAngle = r.length();
        d.pressAxis = r.clone().normalize();
      } else if (this.stepIndex === 2) {
        const along = r.dot(d.pressAxis);
        const side = r.clone().sub(d.pressAxis.clone().multiplyScalar(along));
        if (side.length() < 0.1) { this.error = '발끝을 브레이크 쪽으로 더 옮겨 주세요.'; return; }
        d.pivotAngle = side.length();
        d.pivotAxis = side.normalize();
        d.brakeRest = along;
      } else if (this.stepIndex === 3) {
        const bp = r.dot(d.pressAxis) - d.brakeRest;
        if (bp < 0.1) { this.error = '브레이크를 더 깊게 밟아 주세요.'; return; }
        d.brakePress = bp;
      }
    }
    this.stepIndex++;
    this.input.app.audio.chime('ok');
    if (this.stepIndex >= this.steps.length) {
      this.done = true;
      this.stepIndex = this.steps.length - 1;
      this.input.app.actions.setSetting('footCal', {
        rest: d.rest.toArray(),
        pressAxis: d.pressAxis.toArray(),
        pressAngle: d.pressAngle,
        pivotAxis: d.pivotAxis.toArray(),
        pivotAngle: d.pivotAngle,
        brakeRest: d.brakeRest,
        brakePress: d.brakePress,
      });
    }
  }
  skip() {}
  cancel() { this.active = false; this.input.calib = null; }
}

// ───────── 보정 마법사 (레이싱 페달/핸들)
const PAD_STEPS = [
  { key: 'rest', prompt: '모든 페달에서 발을 떼고 핸들을 가운데에 둔 채 [측정]을 누르세요.' },
  { key: 'throttle', prompt: '가속 페달을 끝까지 밟은 상태로 [측정]을 누르세요.' },
  { key: 'brake', prompt: '가속 페달은 떼고, 브레이크 페달을 끝까지 밟은 상태로 [측정]을 누르세요.' },
  { key: 'steer', prompt: '핸들을 오른쪽 끝까지 돌린 상태로 [측정]을 누르세요. (핸들이 없으면 건너뛰기)', skip: true },
  { key: 'btn:turnL', prompt: '왼쪽 방향지시등으로 쓸 버튼을 누르세요 (건너뛰기 가능)', button: true },
  { key: 'btn:turnR', prompt: '오른쪽 방향지시등으로 쓸 버튼을 누르세요', button: true },
  { key: 'btn:shiftUp', prompt: '기어를 P 쪽으로(D→N→R→P) 올릴 버튼을 누르세요', button: true },
  { key: 'btn:shiftDown', prompt: '기어를 D 쪽으로(P→R→N→D) 내릴 버튼을 누르세요', button: true },
  { key: 'btn:hazard', prompt: '비상등 버튼으로 쓸 버튼을 누르세요', button: true },
  { key: 'btn:epb', prompt: '주차 브레이크(EPB) 버튼으로 쓸 버튼을 누르세요', button: true },
];

class PadCalib {
  constructor(input) {
    this.input = input;
    this.kind = 'pad';
    this.active = true;
    this.title = '페달·핸들 보정';
    this.stepIndex = 0;
    this.error = '';
    this.done = false;
    this.map = { buttons: {} };
    this.base = new Map();
    this.prevButtons = new Map();
    this.pads = [];
  }
  get step() { return PAD_STEPS[this.stepIndex]; }
  get stepCount() { return PAD_STEPS.length; }
  get prompt() {
    if (this.done) return '보정 완료! 페달을 밟고 핸들을 돌려 아래 막대가 움직이는지 확인하세요.';
    if (!this.pads.length) return '페달/핸들이 아직 인식되지 않았어요. USB를 연결하고 페달을 한 번 밟거나 버튼을 눌러 주세요.';
    return this.step.prompt;
  }
  get canCapture() { return !this.done && !this.step.button && this.pads.length > 0; }
  get canSkip() { return !this.done && (this.step.skip || this.step.button); }
  get meters() {
    const m = this.input.padValues;
    return [
      { label: '가속', value: m.throttle },
      { label: '브레이크', value: m.brake },
      { label: '핸들', value: (m.steer + 1) / 2 },
    ];
  }
  tick(pads) {
    this.pads = pads;
    if (this.done || !this.step.button) {
      for (const p of pads) this.prevButtons.set(p.id, p.buttons.map((b) => b.pressed));
      return;
    }
    for (const p of pads) {
      const prev = this.prevButtons.get(p.id) || [];
      const idx = p.buttons.findIndex((b, i) => b.pressed && !prev[i]);
      this.prevButtons.set(p.id, p.buttons.map((b) => b.pressed));
      if (idx >= 0) {
        this.map.buttons[this.step.key.slice(4)] = { id: p.id, index: idx };
        this.next();
        return;
      }
    }
  }
  snapshot() {
    const snap = new Map();
    for (const p of this.pads) snap.set(p.id, [...p.axes]);
    return snap;
  }
  // 기준값 대비 가장 많이 변한 축 찾기
  biggestChange(exclude = []) {
    let best = null;
    for (const p of this.pads) {
      const base = this.base.get(p.id);
      if (!base) continue;
      p.axes.forEach((v, i) => {
        if (exclude.some((e) => e && e.id === p.id && e.axis === i)) return;
        const dlt = Math.abs(v - base[i]);
        if (!best || dlt > best.delta) best = { id: p.id, axis: i, rest: base[i], full: v, delta: dlt };
      });
    }
    return best && best.delta > 0.3 ? best : null;
  }
  capture() {
    this.error = '';
    const k = this.step.key;
    if (k === 'rest') {
      this.base = this.snapshot();
    } else if (k === 'throttle') {
      const b = this.biggestChange();
      if (!b) { this.error = '페달 변화가 감지되지 않았어요. 끝까지 밟아 주세요.'; return; }
      this.map.throttle = { id: b.id, axis: b.axis, rest: b.rest, full: b.full };
    } else if (k === 'brake') {
      let b = this.biggestChange([this.map.throttle]);
      // 가속/브레이크가 한 축을 공유하는 구형 장치
      const t = this.map.throttle;
      const p = this.pads.find((x) => x.id === t.id);
      if (p && Math.abs(p.axes[t.axis] - t.rest) > 0.3 && Math.sign(p.axes[t.axis] - t.rest) !== Math.sign(t.full - t.rest)) {
        b = { id: t.id, axis: t.axis, rest: t.rest, full: p.axes[t.axis] };
      }
      if (!b) { this.error = '브레이크 변화가 감지되지 않았어요. 끝까지 밟아 주세요.'; return; }
      this.map.brake = { id: b.id, axis: b.axis, rest: b.rest, full: b.full };
    } else if (k === 'steer') {
      const b = this.biggestChange([this.map.throttle, this.map.brake]);
      if (!b) { this.error = '핸들 변화가 감지되지 않았어요. 오른쪽 끝까지 돌려 주세요.'; return; }
      this.map.steer = { id: b.id, axis: b.axis, center: b.rest, right: b.full };
    }
    this.next();
  }
  skip() { this.next(); }
  next() {
    this.input.app.audio.chime('ok');
    this.stepIndex++;
    if (this.stepIndex === 1) this.input.app.actions.setSetting('padMap', null);
    if (this.stepIndex >= PAD_STEPS.length) {
      this.done = true;
      this.stepIndex = PAD_STEPS.length - 1;
      this.input.app.actions.setSetting('padMap', this.map);
    } else if (this.stepIndex >= 3 && this.map.throttle && this.map.brake) {
      // 페달 보정이 끝나면 바로 써볼 수 있게 임시 적용
      this.input.app.settings.padMap = this.map;
    }
  }
  cancel() { this.active = false; this.input.calib = null; }
}

export class Input {
  constructor(app) {
    this.app = app;
    this.car = app.car;
    this.renderer = app.renderer;
    this.keys = new Set();
    this.kbThrottle = 0;
    this.kbBrake = 0;
    this.calib = null;
    this.controllers = [];
    this.footQuat = null;
    this.padPrev = new Map();
    this.padValues = { throttle: 0, brake: 0, steer: 0 };
    this.padNames = [];
    this.lastSource = 'keyboard';

    window.addEventListener('keydown', (e) => this.onKey(e, true));
    window.addEventListener('keyup', (e) => this.onKey(e, false));
    window.addEventListener('blur', () => { this.keys.clear(); app.audio.horn(false); });
    this.setupXR();
  }

  onKey(e, down) {
    if (e.target && e.target.closest && e.target.closest('input,select,textarea')) return;
    if (['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Space', 'F1'].includes(e.code)) e.preventDefault();
    // 주행 중에는 Enter가 화면의 버튼을 누르지 않도록
    if (e.code === 'Enter' && this.app.started && !this.app.paused) e.preventDefault();
    if (!down) {
      this.keys.delete(e.code);
      if (e.code === 'KeyH') this.app.audio.horn(false);
      return;
    }
    this.keys.add(e.code);
    if (e.repeat) return;
    if (this.app.paused && !['Escape', 'F1'].includes(e.code)) return;
    if (e.code === 'KeyH') { this.app.audio.horn(true); return; }
    const act = KEYMAP[e.code];
    if (act) this.app.doAction(act, 'keyboard');
  }

  startFootCalib() {
    if (this.app.settings.footMode === 'off') this.app.actions.setSetting('footMode', 'right');
    this.calib = new FootCalib(this);
  }

  startPadCalib() {
    this.calib = new PadCalib(this);
  }

  // ───────── VR 컨트롤러
  setupXR() {
    const r = this.renderer;
    const tipMat = new THREE.MeshBasicMaterial({ color: 0x3ddcff });
    const gloveMat = new THREE.MeshStandardMaterial({ color: 0x23262d, roughness: 0.6 });
    for (let i = 0; i < 2; i++) {
      const ray = r.xr.getController(i);
      const grip = r.xr.getControllerGrip(i);
      const c = {
        i, ray, grip, source: null, hand: null, prev: [], stickY: null, stickYL: null,
        grabbing: false, prevPhi: 0, prevSqueeze: false, pokeKey: null, laser: null, visual: null,
      };
      // 손 모양 대신 간단한 컨트롤러 + 손끝 표시
      const glove = new THREE.Group();
      const body = new THREE.Mesh(new THREE.BoxGeometry(0.045, 0.035, 0.11), gloveMat);
      body.position.set(0, -0.01, 0.03);
      glove.add(body);
      const ring = new THREE.Mesh(new THREE.TorusGeometry(0.035, 0.006, 6, 20), tipMat);
      ring.position.set(0, 0.01, -0.03);
      ring.rotation.x = Math.PI / 2.4;
      glove.add(ring);
      grip.add(glove);
      const tip = new THREE.Mesh(new THREE.SphereGeometry(0.008, 10, 8), tipMat);
      ray.add(tip);
      const laserGeo = new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(0, 0, 0), new THREE.Vector3(0, 0, -1)]);
      const laser = new THREE.Line(laserGeo, new THREE.LineBasicMaterial({ color: 0x3ddcff }));
      laser.visible = false;
      ray.add(laser);
      c.laser = laser;
      c.visual = { glove, tip };
      const handGroup = r.xr.getHand(i);
      this.app.rig.add(handGroup);
      c.handGroup = handGroup;
      c.pinchS = 0;
      c.fist = false;
      ray.addEventListener('connected', (e) => {
        c.source = e.data;
        c.hand = e.data.handedness;
      });
      ray.addEventListener('disconnected', () => {
        c.source = null;
        c.grabbing = false;
        c.hand = null;
      });
      this.app.rig.add(ray);
      this.app.rig.add(grip);
      this.controllers.push(c);
    }
    // 손 관절 표시 (두 손 × 25개 관절을 인스턴스 하나로)
    this.jointMesh = new THREE.InstancedMesh(
      new THREE.SphereGeometry(1, 8, 6),
      new THREE.MeshStandardMaterial({ color: 0xe8c4a0, roughness: 0.6 }),
      HAND_JOINTS.length * 2,
    );
    this.jointMesh.frustumCulled = false;
    this.jointMesh.count = HAND_JOINTS.length * 2;
    const zero = new THREE.Matrix4().makeScale(0, 0, 0);
    for (let k = 0; k < this.jointMesh.count; k++) {
      this.jointMesh.setMatrixAt(k, zero);
      const tip = HAND_JOINTS[k % HAND_JOINTS.length] === 'index-finger-tip';
      this.jointMesh.setColorAt(k, new THREE.Color(tip ? 0x3ddcff : 0xe8c4a0));
    }
    this.app.rig.add(this.jointMesh);
    this.handsActive = false;
  }

  // 손 하나 처리: 주먹으로 핸들 잡기, 엄지·검지 집기로 가속(오른손)/브레이크(왼손), 검지로 버튼 누르기
  updateHand(c, idx, dt, out, acc) {
    c.visual.glove.visible = false;
    c.visual.tip.visible = false;
    c.laser.visible = false;
    const joints = c.handGroup.joints || {};
    const pos = {};
    const m = new THREE.Matrix4();
    const rig = this.app.rig;
    HAND_JOINTS.forEach((name, k) => {
      const j = joints[name];
      const slot = idx * HAND_JOINTS.length + k;
      if (j && j.visible) {
        const wp = j.getWorldPosition(new THREE.Vector3());
        pos[name] = wp;
        const lp = rig.worldToLocal(wp.clone());
        const rad = Math.max(0.006, (j.jointRadius || 0.008) * 0.9);
        m.makeScale(rad, rad, rad).setPosition(lp);
      } else {
        m.makeScale(0, 0, 0);
      }
      this.jointMesh.setMatrixAt(slot, m);
    });
    this.jointMesh.instanceMatrix.needsUpdate = true;
    c.jointsShown = true;
    const h = analyzeHand(pos);
    if (!h.tracked) { c.grabbing = false; c.fist = false; c.pokeKey = null; return; }
    this.handsActive = true;
    c.fist = c.fist ? h.curl < HAND.fistOpen : h.curl < HAND.fistClose;
    const g = this.grabCheck(c, c.fist, h.grabPoint, true);
    if (g !== null) { acc.delta += g; acc.count++; }
    const pinch = !c.grabbing && h.midExtended ? h.pinch : 0;
    c.pinchS += (pinch - c.pinchS) * Math.min(1, dt * 12);
    const val = c.pinchS < 0.06 ? 0 : (c.pinchS - 0.06) / 0.94;
    if (c.hand === 'right') out.throttle = Math.max(out.throttle, val);
    else out.brake = Math.max(out.brake, val);
    if (val > 0.05) this.lastSource = 'hand';
    if (!c.grabbing && !c.fist) this.pokeAt(c, h.indexTip);
    else c.pokeKey = null;
  }

  haptic(c, v = 0.5, ms = 30) {
    try {
      const h = c.source?.gamepad?.hapticActuators?.[0];
      if (h && h.pulse) h.pulse(v, ms);
    } catch { /* 진동 미지원 */ }
  }

  hapticAll(v, ms) { for (const c of this.controllers) if (c.source) this.haptic(c, v, ms); }

  updateXR(dt, out) {
    const app = this.app;
    const S = app.settings;
    const car = this.car;
    const acc = { delta: 0, count: 0 };
    this.footQuat = null;
    this.handsActive = false;
    app.cockpit.hoverUV = null;

    this.controllers.forEach((c, idx) => {
      if (c.source && c.source.hand) { this.updateHand(c, idx, dt, out, acc); return; }
      // 손이 아니면 이 손 관절 표시는 숨김
      if (c.jointsShown !== false) {
        for (let k = 0; k < HAND_JOINTS.length; k++) this.jointMesh.setMatrixAt(idx * HAND_JOINTS.length + k, ZERO_M);
        this.jointMesh.instanceMatrix.needsUpdate = true;
        c.jointsShown = false;
      }
      const gp = c.source?.gamepad;
      if (!gp) { c.laser.visible = false; return; }
      const isFoot = S.footMode !== 'off' && c.hand === S.footMode;
      c.visual.glove.visible = !isFoot;
      c.visual.tip.visible = !isFoot;
      if (isFoot) {
        c.laser.visible = false;
        // 리그 기준 발 방향 (그립 포즈 행렬에서 직접 계산)
        this.footQuat = new THREE.Quaternion().setFromRotationMatrix(c.grip.matrix);
        if (S.footCal) {
          const f = footPedals(S.footCal, this.footQuat);
          out.throttle = Math.max(out.throttle, f.throttle);
          out.brake = Math.max(out.brake, f.brake);
          if (f.throttle > 0.05 || f.brake > 0.05) this.lastSource = 'foot';
        }
        return;
      }
      const singleHand = S.footMode !== 'off';
      const pressed = gp.buttons.map((b) => b.pressed);
      const edge = (i) => pressed[i] && !c.prev[i];
      const trigger = gp.buttons[0]?.value || 0;
      const sx = gp.axes[2] || 0, sy = gp.axes[3] || 0;

      // 화면 가리키기 (정차·P단일 때만 트리거로 클릭)
      let usedTrigger = false;
      const canPoint = car.gear === 'P' || car.gear === 'N' || car.epb || !car.power;
      if (canPoint) {
        const hit = this.screenRay(c);
        if (hit) {
          c.laser.visible = true;
          c.laser.scale.z = hit.distance;
          app.cockpit.hoverUV = hit.uv;
          if (edge(0)) app.cockpit.screenClick(hit.uv);
          usedTrigger = true;
        } else {
          c.laser.visible = false;
        }
      } else {
        c.laser.visible = false;
      }
      if (!usedTrigger) {
        if (c.hand === 'right') out.throttle = Math.max(out.throttle, dead(trigger));
        else out.brake = Math.max(out.brake, dead(trigger));
        if (trigger > 0.05) this.lastSource = 'xr';
      }

      // 손끝으로 버튼 누르기
      this.pokeCheck(c);

      // 핸들 잡기
      const squeeze = !!pressed[1];
      const g = this.grabCheck(c, squeeze);
      if (g !== null) { acc.delta += g; acc.count++; }

      // 버튼 배치
      const stickEdge = (y, key) => {
        let fire = 0;
        if (y < -0.7 && c[key] !== 'up') { c[key] = 'up'; fire = -1; }
        else if (y > 0.7 && c[key] !== 'down') { c[key] = 'down'; fire = 1; }
        else if (Math.abs(y) < 0.3) c[key] = null;
        return fire;
      };
      if (singleHand) {
        if (edge(4)) app.doAction('turnL', 'xr');
        if (edge(5)) app.doAction('turnR', 'xr');
        if (edge(3)) app.doAction('hazard', 'xr');
        const f = stickEdge(sy, 'stickY');
        if (f) app.doAction(f < 0 ? 'shiftUp' : 'shiftDown', 'xr');
      } else if (c.hand === 'right') {
        if (edge(4)) app.doAction('turnR', 'xr');
        if (edge(5)) app.doAction('wiper', 'xr');
        if (edge(3)) app.doAction('power', 'xr');
        const f = stickEdge(sy, 'stickY');
        if (f) app.doAction(f < 0 ? 'shiftUp' : 'shiftDown', 'xr');
      } else {
        if (edge(4)) app.doAction('turnL', 'xr');
        if (edge(5)) app.doAction('hazard', 'xr');
        if (edge(3)) app.doAction('epb', 'xr');
        const f = stickEdge(sy, 'stickYL');
        if (f) app.doAction(f < 0 ? 'lightsUp' : 'lightsDown', 'xr');
      }
      // 핸들을 안 잡았을 때는 스틱 좌우로도 조향 가능
      if (!c.grabbing && Math.abs(sx) > 0.2 && (c.hand === 'left' || singleHand)) {
        out.steerRate += sx * 3.2;
        out.activeSteer = true;
      }
      c.prev = pressed;
    });
    if (acc.count > 0) {
      out.wheelDelta += acc.delta / acc.count;
      out.activeSteer = true;
      out.grabbing = true;
    }
  }

  screenRay(c) {
    const screen = this.app.model.interior.center;
    const origin = c.ray.getWorldPosition(tmpV);
    const dir = tmpV2.set(0, 0, -1).applyQuaternion(c.ray.getWorldQuaternion(tmpQ));
    const rc = this.raycaster || (this.raycaster = new THREE.Raycaster());
    rc.set(origin, dir);
    rc.far = 1.6;
    const hits = rc.intersectObject(screen, false);
    if (!hits.length) return null;
    return { uv: hits[0].uv, distance: hits[0].distance };
  }

  pokeCheck(c) {
    this.pokeAt(c, c.ray.getWorldPosition(tmpV));
  }

  pokeAt(c, tip) {
    const app = this.app;
    const hit = app.cockpit.pokeTest(tip);
    const key = hit ? (hit.kind === 'button' ? hit.id : 'screen') : null;
    if (key && key !== c.pokeKey) {
      if (hit.kind === 'button') {
        app.cockpit.pressButtonVisual(hit.id);
        app.doAction(hit.id, 'poke');
      } else {
        app.cockpit.screenClick(hit.uv);
      }
      this.haptic(c, 0.6, 25);
    }
    c.pokeKey = key;
  }

  // 반환: 이번 프레임 회전량(라디안, 시계방향 +) 또는 null
  // pos: 잡는 위치(월드). level: 손 추적처럼 주먹을 쥔 채로 테두리에 다가가도 잡히게
  grabCheck(c, squeeze, pos = null, level = false) {
    const pivot = this.app.model.interior.wheelPivot;
    const p = pos ? tmpV.copy(pos) : c.grip.getWorldPosition(tmpV);
    pivot.worldToLocal(p);
    const r = Math.hypot(p.x, p.y);
    const phi = Math.atan2(p.y, p.x);
    const near = Math.abs(r - CAR.rimR) < 0.1 && Math.abs(p.z) < 0.13;
    let result = null;
    if (squeeze && (level || !c.prevSqueeze) && near && !c.grabbing) {
      c.grabbing = true;
      c.prevPhi = phi;
      this.haptic(c, 0.4, 40);
    }
    if (!squeeze || r > 0.42 || Math.abs(p.z) > 0.3) c.grabbing = false;
    if (c.grabbing) {
      let d = phi - c.prevPhi;
      while (d > Math.PI) d -= Math.PI * 2;
      while (d < -Math.PI) d += Math.PI * 2;
      c.prevPhi = phi;
      result = r > 0.05 ? -d : 0;
    }
    c.prevSqueeze = squeeze;
    return result;
  }

  // ───────── 게임패드 / 레이싱 휠 / 페달
  updatePads(dt, out) {
    const all = navigator.getGamepads ? [...navigator.getGamepads()].filter(Boolean) : [];
    const pads = all.filter((p) => !isXRPad(p));
    this.padNames = pads.map((p) => p.id);
    if (this.calib && this.calib.kind === 'pad') this.calib.tick(pads);
    const app = this.app;
    const map = app.settings.padMap;
    const byId = new Map(pads.map((p) => [p.id, p]));
    const used = new Set();
    const pv = { throttle: 0, brake: 0, steer: 0 };

    if (map) {
      const rd = (m) => { const p = byId.get(m.id); return p ? p.axes[m.axis] ?? 0 : null; };
      if (map.throttle) {
        const v = rd(map.throttle);
        if (v != null) { pv.throttle = dead(axisNorm(v, map.throttle.rest, map.throttle.full), 0.03); used.add(map.throttle.id); }
      }
      if (map.brake) {
        const v = rd(map.brake);
        if (v != null) { pv.brake = dead(axisNorm(v, map.brake.rest, map.brake.full), 0.03); used.add(map.brake.id); }
      }
      if (map.steer) {
        const v = rd(map.steer);
        if (v != null) {
          const span = map.steer.right - map.steer.center || 1;
          pv.steer = clamp((v - map.steer.center) / span, -1, 1);
          out.wheelAbs = pv.steer * CAR.maxWheelAngle;
          out.activeSteer = true;
          used.add(map.steer.id);
        }
      }
      for (const [act, b] of Object.entries(map.buttons || {})) {
        const p = byId.get(b.id);
        if (!p) continue;
        const prev = this.padPrev.get(p.id) || [];
        if (p.buttons[b.index]?.pressed && !prev[b.index]) app.doAction(act, 'pad');
      }
    }

    // 표준 게임패드(엑스박스 등)는 보정 없이 바로 사용
    for (const p of pads) {
      if (used.has(p.id) || p.mapping !== 'standard') continue;
      const prev = this.padPrev.get(p.id) || [];
      const b = p.buttons;
      const edge = (i) => b[i]?.pressed && !prev[i];
      pv.throttle = Math.max(pv.throttle, dead(b[7]?.value || 0));
      pv.brake = Math.max(pv.brake, dead(b[6]?.value || 0));
      const x = p.axes[0] || 0;
      if (Math.abs(x) > 0.08) {
        out.wheelTarget = Math.sign(x) * Math.pow(Math.abs(x), 1.6) * CAR.maxWheelAngle;
        out.activeSteer = true;
      }
      if (edge(4)) app.doAction('turnL', 'pad');
      if (edge(5)) app.doAction('turnR', 'pad');
      if (edge(12)) app.doAction('shiftUp', 'pad');
      if (edge(13)) app.doAction('shiftDown', 'pad');
      if (edge(14)) app.doAction('belt', 'pad');
      if (edge(15)) app.doAction('lights', 'pad');
      if (edge(2)) app.doAction('hazard', 'pad');
      if (edge(1)) app.doAction('epb', 'pad');
      if (edge(0)) app.doAction('power', 'pad');
      if (edge(3)) app.doAction('wiper', 'pad');
      if (edge(9)) app.doAction('menu', 'pad');
    }
    for (const p of pads) this.padPrev.set(p.id, p.buttons.map((x) => x.pressed));
    this.padValues = pv;
    if (pv.throttle > 0.05 || pv.brake > 0.05) this.lastSource = 'pad';
    out.throttle = Math.max(out.throttle, pv.throttle);
    out.brake = Math.max(out.brake, pv.brake);
  }

  // ───────── 키보드
  updateKeyboard(dt, out) {
    const k = this.keys;
    const paused = this.app.paused;
    const up = !paused && (k.has('ArrowUp'));
    const down = !paused && (k.has('ArrowDown'));
    const maxT = k.has('ShiftLeft') || k.has('ShiftRight') ? 1 : 0.5;
    this.kbThrottle = up ? approach(this.kbThrottle, maxT, dt * 1.1) : approach(this.kbThrottle, 0, dt * 4);
    this.kbBrake = down ? approach(this.kbBrake, 1, dt * 4) : approach(this.kbBrake, 0, dt * 5);
    out.throttle = Math.max(out.throttle, this.kbThrottle);
    out.brake = Math.max(out.brake, this.kbBrake);
    if (up || down) this.lastSource = 'keyboard';
    const left = !paused && k.has('ArrowLeft');
    const right = !paused && k.has('ArrowRight');
    const dir = (right ? 1 : 0) - (left ? 1 : 0);
    if (dir) {
      // 처음엔 천천히(미세 조정), 계속 누르면 점점 빠르게(깊게 꺾기)
      this.kbSteerT = this.kbSteerDir === dir ? (this.kbSteerT || 0) + dt : 0;
      this.kbSteerDir = dir;
      let rate = 1.4 + Math.min(this.kbSteerT, 0.8) * 4.5;
      // 반대쪽으로 꺾여 있으면 가운데로 빨리 돌아오게
      if (Math.sign(this.car.wheelAngle) === -dir && Math.abs(this.car.wheelAngle) > 0.2) rate = Math.max(rate, 5.5);
      out.steerRate += dir * rate;
      out.activeSteer = true;
    } else {
      this.kbSteerDir = 0;
    }
  }

  // ───────── 화면 조작 버튼 (터치/마우스)
  updateTouch(dt, out) {
    const tp = this.app.touchpad;
    if (!tp) return;
    tp.tick(dt);
    if (!tp.visible) return;
    out.throttle = Math.max(out.throttle, tp.throttle);
    out.brake = Math.max(out.brake, tp.brake);
    if (tp.throttle > 0.05 || tp.brake > 0.05) this.lastSource = 'touch';
    if (tp.wheelHeld || tp.wheelDelta) {
      // 손가락으로 조금만 돌려도 충분히 꺾이도록 1.5배
      out.wheelDelta += tp.wheelDelta * 1.5;
      tp.wheelDelta = 0;
      out.grabbing = true;
      out.activeSteer = true;
    }
  }

  update(dt) {
    const out = { throttle: 0, brake: 0, steerRate: 0, wheelDelta: 0, wheelAbs: null, wheelTarget: null, activeSteer: false, grabbing: false };
    this.updateKeyboard(dt, out);
    this.updatePads(dt, out);
    if (this.renderer.xr.isPresenting) this.updateXR(dt, out);
    this.updateTouch(dt, out);

    const car = this.car;
    car.throttle = clamp(out.throttle, 0, 1);
    car.brake = clamp(out.brake, 0, 1);

    let w = car.wheelAngle;
    if (out.grabbing) w += out.wheelDelta;
    else if (out.wheelAbs != null) w = out.wheelAbs;
    else if (out.wheelTarget != null) w = approach(w, out.wheelTarget, dt * 9);
    w += out.steerRate * dt;
    // 주행 중 손을 놓으면 핸들이 천천히 가운데로 돌아옴.
    // 다시 잡으려고 잠깐 놓은 사이(0.7초)에는 돌아가지 않아서 깊게 꺾을 때 튕기지 않음
    this.steerIdleT = out.activeSteer ? 0 : (this.steerIdleT || 0) + dt;
    if (this.app.settings.autoCenter && this.steerIdleT > 0.7 && Math.abs(car.v) > 0.5) {
      w *= Math.exp(-0.12 * Math.min(Math.abs(car.v), 8) * dt);
    }
    car.wheelAngle = clamp(w, -CAR.maxWheelAngle, CAR.maxWheelAngle);
    this.grabbing = out.grabbing;
  }
}
