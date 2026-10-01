// 차량 물리 + 조작 상태 (자동변속 전기차, 2종 보통 기준)
import { CAR } from './carModel.js';
import { clamp, Emitter } from './util.js';
import { heightAt } from './course.js';

const G = 9.81;
const GEARS = ['P', 'R', 'N', 'D'];
const BOUNDS = { x0: -45, x1: 175, z0: -118, z1: 58 };

export class Vehicle extends Emitter {
  constructor(course) {
    super();
    this.course = course;
    this.mass = 2050;
    this.maxSteer = 0.6; // 앞바퀴 최대 조향각(약 34°)
    this.hillHold = false; // 시험 연습용: 언덕 밀림 방지 끔
    this.reset();
  }

  reset() {
    this.x = 0; this.z = 0; this.y = 0;
    this.heading = 0; this.pitch = 0;
    this.v = 0; this.steer = 0; this.wheelAngle = 0;
    this.power = false;
    this.gear = 'P';
    this.epb = true;
    this.seatbelt = false;
    this.lights = 0;      // 0 끔, 1 하향등, 2 상향등
    this.turn = 0;        // -1 좌, 1 우
    this.hazard = false;
    this.wiper = 0;       // 0 끔, 1 저속, 2 고속
    this.wiperPhase = 0;
    this.horn = false;
    this.throttle = 0;
    this.brake = 0;
    this.blinkT = 0;
    this.blinkOn = false;
    this.turnArmed = false;
    this.odometer = 0;
    this.routeIdx = -1;
    this.s = 0; this.d = 0; this.lap = 0; this.sAbs = 0;
    this.offRoute = 0;
    this.lastShiftMsgT = 0;
  }

  get kmh() { return Math.abs(this.v) * 3.6; }
  get epbHolding() { return this.epb; }
  get forward() { return { x: Math.sin(this.heading), z: -Math.cos(this.heading) }; }
  get right() { return { x: Math.cos(this.heading), z: Math.sin(this.heading) }; }

  // 경로상 s 위치에 차 중심을 놓기 (연습 모드 구간 이동, 시험 시작)
  placeAt(s, d = 0) {
    const p = this.course.pointAt(s, d);
    this.x = p.x; this.z = p.z; this.heading = p.h;
    this.v = 0; this.steer = 0; this.wheelAngle = 0;
    this.turn = 0; this.turnArmed = false;
    this.routeIdx = -1;
    this.lap = s > this.course.total - 30 ? -1 : 0;
    this._prevS = null;
    this.updateHeights();
    this.updateRoute();
  }

  // 차량 기준 점(로컬 x=오른쪽, z=뒤쪽) → 월드
  toWorld(lx, lz) {
    const f = this.forward, r = this.right;
    return { x: this.x + r.x * lx - f.x * lz, z: this.z + r.z * lx - f.z * lz };
  }

  wheelPoints(outer = true) {
    const hx = CAR.track / 2 + (outer ? CAR.tireW / 2 : 0);
    const hz = CAR.wheelbase / 2;
    return [
      { id: 'FL', ...this.toWorld(-hx, -hz), side: -1 },
      { id: 'FR', ...this.toWorld(hx, -hz), side: 1 },
      { id: 'RL', ...this.toWorld(-hx, hz), side: -1 },
      { id: 'RR', ...this.toWorld(hx, hz), side: 1 },
    ];
  }

  bodyCorners(halfW = CAR.width / 2 - 0.02, halfL = CAR.length / 2) {
    return [
      this.toWorld(-halfW, -halfL), this.toWorld(halfW, -halfL),
      this.toWorld(halfW, halfL), this.toWorld(-halfW, halfL),
    ];
  }

  // ───────── 조작 ─────────
  message(text, kind = 'info') { this.emit('message', text, kind); }

  togglePower() {
    if (!this.power) {
      if (this.brake < 0.25) {
        this.message('브레이크 페달을 밟은 상태에서 시동 버튼을 누르세요', 'warn');
        this.emit('denied');
        return false;
      }
      this.power = true;
      this.emit('power', true);
      return true;
    }
    if (this.gear !== 'P' || Math.abs(this.v) > 0.3) {
      this.message('정차 후 P단에서 시동을 끄세요', 'warn');
      this.emit('denied');
      return false;
    }
    this.power = false;
    this.emit('power', false);
    return true;
  }

  shift(target) {
    if (target === this.gear) return true;
    const deny = (msg) => { this.message(msg, 'warn'); this.emit('denied'); return false; };
    if (!this.power) return deny('먼저 시동을 거세요 (브레이크 + START 버튼)');
    if (this.gear === 'P' && this.brake < 0.25) return deny('브레이크를 밟은 상태에서 변속하세요');
    if (target === 'P' && Math.abs(this.v) > 0.5) return deny('완전히 정차한 뒤 P로 변속하세요');
    if ((target === 'R' && this.v > 1.2) || (target === 'D' && this.v < -1.2)) {
      return deny('차가 움직이는 방향과 반대로는 변속할 수 없습니다');
    }
    if (target !== 'P' && target !== 'N' && this.gear === 'N' && this.brake < 0.25 && Math.abs(this.v) < 0.3) {
      return deny('브레이크를 밟은 상태에서 변속하세요');
    }
    this.gear = target;
    this.emit('shift', target);
    return true;
  }

  shiftStep(dir) {
    // dir -1: P 쪽으로, +1: D 쪽으로
    const i = GEARS.indexOf(this.gear);
    const j = clamp(i + dir, 0, GEARS.length - 1);
    if (j !== i) this.shift(GEARS[j]);
  }

  setTurn(dir) {
    this.turn = this.turn === dir ? 0 : dir;
    this.turnArmed = false;
    if (this.turn !== 0 && !this.hazard) { this.blinkT = 0; this.setBlink(true); }
    if (this.turn === 0 && !this.hazard) this.setBlink(false);
    this.emit('turn', this.turn);
  }

  toggleHazard() {
    this.hazard = !this.hazard;
    this.blinkT = 0;
    this.setBlink(this.hazard || this.turn !== 0);
    this.emit('hazard', this.hazard);
  }

  toggleEPB() {
    if (!this.epb && Math.abs(this.v) > 1.0) {
      this.message('주행 중에는 주차 브레이크를 걸 수 없습니다', 'warn');
      return;
    }
    this.epb = !this.epb;
    this.emit('epb', this.epb);
  }

  toggleLights() {
    this.lights = this.lights === 0 ? 1 : 0;
    this.emit('lights', this.lights);
  }

  toggleHigh() {
    this.lights = this.lights === 2 ? 1 : 2;
    this.emit('lights', this.lights);
  }

  lightsStep(dir) {
    this.lights = clamp(this.lights + dir, 0, 2);
    this.emit('lights', this.lights);
  }

  cycleWiper() {
    this.wiper = (this.wiper + 1) % 3;
    this.emit('wiper', this.wiper);
  }

  toggleBelt() {
    this.seatbelt = !this.seatbelt;
    this.emit('belt', this.seatbelt);
  }

  setBlink(on) {
    if (on !== this.blinkOn) {
      this.blinkOn = on;
      this.emit('blink', on);
    }
  }

  // ───────── 시뮬레이션 ─────────
  update(dt) {
    // 방향지시등 점멸 (약 1.4Hz)
    if (this.turn !== 0 || this.hazard) {
      this.blinkT += dt;
      const period = 0.72;
      this.setBlink((this.blinkT % period) < period * 0.5);
    } else {
      this.setBlink(false);
    }

    // 방향지시등 자동 복귀: 그 방향으로 핸들을 충분히 돌렸다가 풀면 꺼짐
    if (this.turn !== 0) {
      const sw = this.wheelAngle / CAR.maxWheelAngle;
      if (sw * this.turn > 0.32) this.turnArmed = true;
      if (this.turnArmed && sw * this.turn < 0.07) {
        this.turn = 0;
        this.turnArmed = false;
        this.emit('turn', 0);
      }
    }

    if (this.wiper > 0) this.wiperPhase += dt * (this.wiper === 1 ? 3.4 : 6.5);

    // 전자식 주차브레이크 자동 해제 (안전벨트 착용 + D/R + 가속 페달)
    if (this.epb && this.power && (this.gear === 'D' || this.gear === 'R') && this.throttle > 0.12) {
      if (this.seatbelt) {
        this.epb = false;
        this.emit('epb', false);
        this.message('전자식 주차 브레이크가 자동으로 풀렸습니다');
      } else if (performance.now() - this.lastShiftMsgT > 4000) {
        this.lastShiftMsgT = performance.now();
        this.message('주차 브레이크가 걸려 있습니다 (안전벨트를 매면 자동 해제)', 'warn');
      }
    }

    const steps = Math.max(1, Math.ceil(dt / (1 / 120)));
    const h = dt / steps;
    for (let i = 0; i < steps; i++) this.step(h);
    this.updateRoute();
  }

  step(dt) {
    this.steer = clamp(this.wheelAngle / CAR.maxWheelAngle, -1, 1) * this.maxSteer;

    const m = this.mass;
    const v = this.v;
    let F = 0;
    const thr = this.power ? this.throttle : 0;
    if (this.power && (this.gear === 'D' || this.gear === 'R')) {
      const dir = this.gear === 'D' ? 1 : -1;
      const along = v * dir;
      let maxF = this.gear === 'D' ? 7000 : 3000;
      if (along > 1) maxF = Math.min(maxF, 150000 / along);
      if (this.gear === 'R' && along > 3.4) maxF *= Math.max(0, 1 - (along - 3.4) * 2); // 후진 속도 제한(약 13km/h)
      let drive = Math.pow(thr, 1.45) * maxF;
      const creepV = this.gear === 'D' ? 1.9 : 1.3; // 크리프: D 약 7km/h
      if (thr < 0.04) {
        drive = Math.max(drive, clamp((creepV - along) * 2400, 0, 1300));
        if (along > creepV + 0.3) drive -= Math.min(1600, (along - creepV) * 800); // 회생제동
      }
      F += drive * dir;
    }
    F += -m * G * Math.sin(this.pitch);

    const resist = 0.012 * m * G + 0.42 * v * v;
    let brakeF = Math.pow(this.brake, 1.2) * 19000;
    if (this.gear === 'P' || this.epb) brakeF = Math.max(brakeF, 40000);
    if (this.hillHold && this.brake > 0.2 && Math.abs(v) < 0.05) brakeF = Math.max(brakeF, 30000);

    if (Math.abs(v) < 0.03 && Math.abs(F) <= brakeF + resist) {
      this.v = 0;
    } else {
      const sign = Math.abs(v) >= 0.03 ? Math.sign(v) : Math.sign(F);
      const a = (F - sign * (resist + brakeF)) / m;
      let nv = v + a * dt;
      if (Math.sign(nv) !== sign && Math.abs(F) <= brakeF + resist) nv = 0;
      this.v = nv;
    }

    // 자전거 모델 (뒤차축 기준)
    const L = CAR.wheelbase;
    const half = L / 2;
    const hd = this.heading;
    const dist = this.v * dt * Math.cos(this.pitch);
    const dh = (dist * Math.tan(this.steer)) / L;
    let rx = this.x - Math.sin(hd) * half;
    let rz = this.z + Math.cos(hd) * half;
    const hm = hd + dh / 2;
    rx += Math.sin(hm) * dist;
    rz -= Math.cos(hm) * dist;
    this.heading = hd + dh;
    let nx = rx + Math.sin(this.heading) * half;
    let nz = rz - Math.cos(this.heading) * half;
    if (nx < BOUNDS.x0 || nx > BOUNDS.x1 || nz < BOUNDS.z0 || nz > BOUNDS.z1) {
      nx = clamp(nx, BOUNDS.x0, BOUNDS.x1);
      nz = clamp(nz, BOUNDS.z0, BOUNDS.z1);
      this.v = 0;
    }
    this.x = nx; this.z = nz;
    this.odometer += Math.abs(dist);
    this.updateHeights();
  }

  updateHeights() {
    const half = CAR.wheelbase / 2;
    const fx = this.x + Math.sin(this.heading) * half, fz = this.z - Math.cos(this.heading) * half;
    const rx = this.x - Math.sin(this.heading) * half, rz = this.z + Math.cos(this.heading) * half;
    const hf = heightAt(fx, fz), hr = heightAt(rx, rz);
    this.y = (hf + hr) / 2;
    this.pitch = Math.atan2(hf - hr, CAR.wheelbase);
  }

  // 차 중심의 경로 좌표 (s: 누적 거리, 바퀴 수 반영한 sAbs)
  updateRoute() {
    const c = this.course;
    const p = c.project(this.x, this.z, this.routeIdx);
    if (this._prevS != null) {
      const ds = p.s - this._prevS;
      if (ds < -c.total / 2) this.lap++;
      else if (ds > c.total / 2) this.lap--;
    }
    this._prevS = p.s;
    this.routeIdx = p.idx;
    this.s = p.s;
    this.d = p.d;
    this.routeHeading = p.h;
    this.sAbs = this.lap * c.total + p.s;
  }

  // 임의의 월드 점을 현재 차 위치 근처의 연속 s 값으로
  projectNear(pt) {
    const c = this.course;
    const p = c.project(pt.x, pt.z, this.routeIdx);
    let s = this.lap * c.total + p.s;
    if (s - this.sAbs > c.total / 2) s -= c.total;
    else if (this.sAbs - s > c.total / 2) s += c.total;
    return { s, d: p.d };
  }

  frontS() {
    const f = this.forward;
    return this.projectNear({ x: this.x + f.x * (CAR.length / 2), z: this.z + f.z * (CAR.length / 2) }).s;
  }

  rearS() {
    const f = this.forward;
    return this.projectNear({ x: this.x - f.x * (CAR.length / 2), z: this.z - f.z * (CAR.length / 2) }).s;
  }
}
