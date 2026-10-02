// 장내기능시험 진행 + 채점
// 실제 시험 기준(도로교통공단 장내기능시험)을 시뮬레이터에 맞게 단순화했습니다.
import { CAR } from './carModel.js';
import { ROAD } from './course.js';
import { Emitter, randRange } from './util.js';

export const PASS_SCORE = 80;

export const RULES = [
  { item: '기기조작', cond: '지시받은 장치(전조등·방향지시등·와이퍼·변속기)를 제한시간 안에 조작하지 못함', pts: 5 },
  { item: '차로준수', cond: '바퀴가 중앙선이나 차선(흰 실선)에 닿음', pts: 15 },
  { item: '좌·우회전', cond: '회전하기 전에 방향지시등을 켜지 않음', pts: 5 },
  { item: '경사로', cond: '정지구간(노란 선 사이)에 앞범퍼를 맞춰 정지하지 않음', pts: 10 },
  { item: '경사로', cond: '정지 후 출발할 때 50cm 이상 뒤로 밀림', pts: 10 },
  { item: '직각주차', cond: '바퀴가 검지선(주차선·경계선)에 닿음 (닿을 때마다)', pts: 10 },
  { item: '직각주차', cond: '주차 후 주차 브레이크를 걸지 않음', pts: 10 },
  { item: '직각주차', cond: '제한시간 120초 초과', pts: 10 },
  { item: '돌발', cond: '경고음 후 2초 안에 정지하지 못함', pts: 10 },
  { item: '돌발', cond: '정지 후 3초 안에 비상점멸등을 켜지 않음', pts: 10 },
  { item: '돌발', cond: '다시 출발할 때 비상점멸등을 끄지 않음', pts: 10 },
  { item: '가속구간', cond: '시속 20km를 넘기지 못함', pts: 10 },
];

export const DQ_RULES = [
  '안전띠를 매지 않고 출발 (또는 주행 중 해제)',
  '출발 지시 후 30초 안에 출발선을 넘지 못함',
  '신호위반: 적색·황색 신호에 앞범퍼가 정지선을 넘음',
  '경사로에서 1m 이상 뒤로 밀림',
  '경사로 정지 후 30초 안에 통과하지 못함',
  '직각주차를 하지 않고 지나감',
  '코스를 벗어남 (차 중심이 노면 밖으로 나감)',
  '감점으로 점수가 80점 미만이 되는 순간',
];

const DEVICE_TASKS = {
  lights: () => ({
    name: '전조등',
    tip: 'lights',
    steps: [
      { say: '전조등을 상향등으로 켜십시오.', check: (c) => c.lights === 2 },
      { say: '하향등으로 바꾸십시오.', check: (c) => c.lights === 1 },
    ],
  }),
  turn: () => {
    const left = Math.random() < 0.5;
    return {
      name: '방향지시등',
      tip: left ? 'turnL' : 'turnR',
      steps: [{
        say: left ? '좌측 방향지시등을 켜십시오.' : '우측 방향지시등을 켜십시오.',
        check: (c) => c.turn === (left ? -1 : 1),
      }],
    };
  },
  wiper: () => ({
    name: '와이퍼',
    tip: 'wiper',
    steps: [{ say: '와이퍼를 작동하십시오.', check: (c) => c.wiper > 0 }],
  }),
  gear: () => {
    const target = Math.random() < 0.6 ? 'D' : 'N';
    return {
      name: '변속기',
      tip: 'gear',
      steps: [{
        say: `브레이크를 밟고 변속기를 ${target}로 변경하십시오.`,
        check: (c) => c.gear === target,
      }],
    };
  },
};

const STEP_LIMIT = 7; // 각 지시 제한시간(초)

export class Exam extends Emitter {
  constructor({ car, course, world }) {
    super();
    this.car = car;
    this.course = course;
    this.world = world;
    this.mode = 'idle'; // idle | practice | exam | drill
    this.phase = 'idle';
    this.score = 100;
    this.penalties = [];
    this.lapBase = 0;
    this.instruction = '';
    this.hintText = '';
    this.section = '';
    this.timerText = '';
    this.result = null;
    this.tip = (key) => key; // main.js가 입력 장치에 맞는 안내로 바꿔 끼움
    this.resetSections();
  }

  get active() { return this.mode === 'exam' || this.mode === 'practice' || this.mode === 'drill'; }
  get scoring() { return this.mode === 'exam'; }

  // ───────── 시작/종료 ─────────
  startExam() {
    const c = this.car;
    c.reset();
    c.placeAt(this.course.zones.startPos);
    this.mode = 'exam';
    c.beltRequired = true;
    this.score = 100;
    this.penalties = [];
    this.result = null;
    this.lapBase = 0;
    this.resetSections();
    this.setPhase('prep');
    this.say('장내기능시험을 시작합니다. 안전띠를 매고, 브레이크를 밟은 채 시동 버튼을 누르십시오.');
    this.hint(this.tip('prep'));
    this.emit('started', 'exam');
  }

  startPractice(jumpIndex = null) {
    const c = this.car;
    this.mode = 'practice';
    c.beltRequired = false;
    this.result = null;
    this.score = 100;
    this.penalties = [];
    if (jumpIndex != null) {
      const j = this.course.jumps[jumpIndex];
      const wasPower = c.power, belt = c.seatbelt, lights = c.lights;
      c.placeAt(j.s);
      if (wasPower) { c.gear = 'P'; c.epb = false; }
      c.seatbelt = belt; c.lights = lights;
      c.emit('belt', c.seatbelt);
      this.say(`${j.name}(으)로 이동했습니다.`);
    } else {
      this.say('연습 주행입니다. 자유롭게 코스를 달려 보세요. 구간마다 요령을 알려 드려요.');
    }
    this.lapBase = this.car.sAbs - this.course.wrapS(this.car.sAbs);
    if (this.car.sAbs < 0) this.lapBase = 0;
    this.resetSections();
    this.setPhase('course');
    this.courseStarted = true;
    this.hint(this.car.power ? '' : this.tip('prep'));
    this.emit('started', 'practice');
  }

  startDeviceDrill() {
    this.mode = 'drill';
    this.result = null;
    this.score = 100;
    this.penalties = [];
    const c = this.car;
    if (Math.abs(c.v) > 0.3) { this.say('정차한 상태에서 다시 시도하세요.'); return; }
    this.setPhase('devices');
    this.prepareDevices(['lights', 'turn', 'wiper', 'gear']);
    this.emit('started', 'drill');
  }

  stop() {
    this.world.setAlarm(false);
    this.emit('alarm', false);
    this.mode = 'idle';
    this.setPhase('idle');
    this.say('');
    this.hint('');
  }

  resetSections() {
    const z = this.course.zones;
    this.courseStarted = false;
    this.lane = { armed: true, clearT: 0 };
    this.offT = 0;
    this.turns = z.turns.map((t) => ({ ...t, ok: false, done: false }));
    this.hill = { state: 'idle', stopS: 0, t: 0, still: 0, p50: false, announced: false };
    this.park = { state: 'idle', t: 0, lines: {}, parked: false, epbDone: false, timePen: false, inside: false, still: 0, announced: false };
    this.sig = { announced: false, done: false, prevFront: null };
    this.sud = { state: 'idle', trigS: randRange(z.sudden.s0 + 2, z.sudden.s1 - 6), t: 0, ts: 0, p1: false, p2: false, haz: false, goS: 0 };
    this.acc = { state: 'idle', maxV: 0, okSaid: false };
    this.finish = { state: 'idle', still: 0 };
    this.beltWarned = false;
    this.startT = 0;
  }

  setPhase(p) { this.phase = p; this.phaseT = 0; this.emit('phase', p); }

  say(text, speak = true) {
    this.instruction = text;
    this.emit('say', text, speak);
  }

  hint(text) {
    if (text === this.hintText) return;
    this.hintText = text;
    this.emit('hint', text);
  }

  penalty(pts, reason) {
    if (this.mode === 'practice' || this.mode === 'drill') {
      this.penalties.push({ pts, reason, dq: false, t: performance.now() });
      this.emit('warn', `${reason} (시험이면 -${pts}점)`);
      return;
    }
    if (this.mode !== 'exam' || this.phase === 'result') return;
    this.score -= pts;
    this.penalties.push({ pts, reason, dq: false, t: performance.now() });
    this.emit('penalty', pts, reason);
    this.say(`${reason}. ${pts}점 감점.`);
    if (this.score < PASS_SCORE) this.end(false, `점수가 ${this.score}점으로 기준(80점) 미만입니다`);
  }

  disqualify(reason) {
    if (this.mode === 'practice') {
      this.emit('warn', `${reason} (시험이면 실격)`);
      return;
    }
    if (this.mode !== 'exam' || this.phase === 'result') return;
    this.penalties.push({ pts: 0, reason, dq: true, t: performance.now() });
    this.end(false, `실격: ${reason}`);
  }

  end(pass, reason = '') {
    this.world.setAlarm(false);
    this.emit('alarm', false);
    this.result = { pass, score: Math.max(0, this.score), reason, penalties: [...this.penalties], kind: 'course' };
    this.setPhase('result');
    if (pass) this.say(`합격입니다! 점수는 ${this.score}점입니다. 축하합니다!`);
    else this.say(`불합격입니다. ${reason}.`);
    this.hint('메뉴에서 다시 시험을 보거나 연습 주행을 할 수 있어요.');
    this.emit('result', this.result);
  }

  // ───────── 매 프레임 ─────────
  update(dt) {
    if (!this.active) { this.section = ''; return; }
    this.phaseT = (this.phaseT || 0) + dt;
    const c = this.car;

    // 연습 모드: 한 바퀴 돌면 구간 상태 초기화
    if (this.mode === 'practice' && c.sAbs - this.lapBase > this.course.total + 1) {
      this.lapBase += this.course.total;
      this.resetSections();
      this.courseStarted = true;
      this.emit('lap');
    }
    if (this.mode === 'practice' && c.sAbs - this.lapBase < -20) {
      this.lapBase -= this.course.total;
      this.resetSections();
      this.courseStarted = true;
    }

    const ls = c.sAbs - this.lapBase;
    const front = c.frontS() - this.lapBase;
    this.section = this.sectionName(front);

    switch (this.phase) {
      case 'prep': this.updatePrep(dt); break;
      case 'devices': this.updateDevices(dt); break;
      case 'start': this.updateStart(dt, front); break;
      case 'course':
      case 'finishing':
        this.updateCourse(dt, ls, front);
        break;
      default: break;
    }
  }

  updatePrep() {
    const c = this.car;
    if (c.power && this.phaseT > 0.5) {
      this.setPhase('devices');
      const all = ['lights', 'turn', 'wiper', 'gear'];
      // 실제 시험처럼 4가지 중 2가지를 무작위로
      const pick = all.sort(() => Math.random() - 0.5).slice(0, 2);
      this.prepareDevices(pick);
      this.say('기기조작 시험을 시작합니다.');
    }
  }

  prepareDevices(keys) {
    this.devQueue = keys.map((k) => DEVICE_TASKS[k]());
    this.devTask = null;
    this.devStep = 0;
    this.devT = -2.2;
  }

  updateDevices(dt) {
    const c = this.car;
    if (!this.devTask) {
      this.devT += dt;
      if (this.devT < 0) return;
      this.devTask = this.devQueue.shift();
      if (!this.devTask) {
        if (this.mode === 'drill') {
          this.say('기기조작 연습이 끝났습니다. 잘하셨어요!');
          this.mode = 'idle';
          this.setPhase('idle');
          this.emit('drillDone');
          return;
        }
        this.setPhase('start');
        this.startT = 0;
        this.say('기기조작이 끝났습니다. 출발하십시오.');
        this.hint(`D로 변속(${this.tip('gear')}) → 브레이크를 놓고 가속(${this.tip('accel')})을 살짝 · 30초 안에 출발`);
        return;
      }
      this.devStep = 0;
      this.devT = 0;
      this.say(this.devTask.steps[0].say);
      this.hint(`${this.devTask.name}: ${this.tip(this.devTask.tip)} · 제한시간 ${STEP_LIMIT}초`);
      return;
    }
    this.devT += dt;
    const step = this.devTask.steps[this.devStep];
    this.timerText = `${Math.max(0, Math.ceil(STEP_LIMIT + 1.5 - this.devT))}초`;
    if (step.check(c)) {
      this.devStep++;
      this.emit('ok', `${this.devTask.name} 확인`);
      if (this.devStep >= this.devTask.steps.length) {
        this.devTask = null;
        this.devT = -1.2;
        this.timerText = '';
      } else {
        this.devT = 0;
        this.say(this.devTask.steps[this.devStep].say);
      }
      return;
    }
    if (this.devT > STEP_LIMIT + 1.5) {
      this.penalty(5, `기기조작(${this.devTask.name}) 미조작`);
      this.devTask = null;
      this.devT = -1.5;
      this.timerText = '';
    }
  }

  updateStart(dt, front) {
    const c = this.car;
    this.startT += dt;
    this.timerText = `${Math.max(0, Math.ceil(30 - this.startT))}초`;
    if (Math.abs(c.v) > 0.2 && !c.seatbelt) return this.disqualify('안전띠를 매지 않고 출발');
    if (front > this.course.zones.startLine) {
      this.timerText = '';
      this.setPhase('course');
      this.courseStarted = true;
      this.hint('');
      this.emit('ok', '출발');
      return;
    }
    if (this.startT > 30) this.disqualify('출발 지시 후 30초 안에 출발하지 못함');
  }

  updateCourse(dt, ls, front) {
    const c = this.car;
    const z = this.course.zones;

    if (this.mode === 'exam' && !c.seatbelt && Math.abs(c.v) > 0.2) return this.disqualify('주행 중 안전띠 미착용');
    if (this.mode === 'practice' && !c.seatbelt && Math.abs(c.v) > 0.5 && !this.beltWarned) {
      this.beltWarned = true;
      this.emit('warn', '안전띠를 매지 않았습니다 (시험이면 실격)');
    }

    this.checkOffCourse(dt);
    if (this.phase === 'result') return;
    this.checkLane(dt, ls, front);
    this.checkTurns(front);
    this.checkHill(dt, front);
    this.checkPark(dt, ls);
    this.checkSignal(front);
    this.checkSudden(dt, ls);
    this.checkAccel(ls);
    if (this.phase === 'result') return;

    // 종료
    if (this.mode === 'exam') {
      if (this.finish.state === 'idle' && front >= z.finish) {
        this.finish.state = 'stop';
        this.setPhase('finishing');
        this.say('종료선을 통과했습니다. 정지하십시오.');
        this.hint('브레이크로 부드럽게 정지 → P단');
      }
      if (this.finish.state === 'stop') {
        if (Math.abs(c.v) < 0.05) this.finish.still += dt; else this.finish.still = 0;
        if (this.finish.still > 1.0) {
          this.finish.state = 'done';
          this.end(this.score >= PASS_SCORE, '');
        }
      }
    }

    this.practiceHints(ls, front);
  }

  // 차 중심이 노면 밖 → 실격
  checkOffCourse(dt) {
    const c = this.car;
    const on = this.course.onPavement(c.s, c.d);
    if (!on) this.offT += dt; else this.offT = 0;
    if (this.offT > 0.6) {
      this.offT = -3; // 연습 모드에서 경고 반복 방지
      this.disqualify('코스 이탈 (연석 충돌)');
    }
  }

  checkLane(dt, ls, front) {
    const c = this.car;
    const z = this.course.zones;
    const p = z.park, sg = z.signal;
    const rear = c.rearS() - this.lapBase;
    const inPark = rear < p.s1 + 1 && front > p.s0 - 1;
    const inBox = front > sg.crossS - sg.boxHalf - 0.3 && rear < sg.crossS + sg.boxHalf + 0.3;
    if (inPark || inBox || front < 0.5 || !this.courseStarted) {
      this.lane.armed = true;
      return;
    }
    let touch = null;
    for (const w of c.wheelPoints(true)) {
      const q = c.projectNear(w);
      if (q.d < ROAD.center + 0.17) { touch = '중앙선 침범(차로 이탈)'; break; }
      if (q.d > ROAD.right - ROAD.lineW / 2) { touch = '차선 접촉(차로 이탈)'; break; }
    }
    if (touch) {
      this.lane.clearT = 0;
      this.emit('rumble', 0.6);
      if (this.lane.armed) {
        this.lane.armed = false;
        this.penalty(15, touch);
      }
    } else {
      this.lane.clearT += dt;
      if (this.lane.clearT > 1.5) this.lane.armed = true;
    }
  }

  checkTurns(front) {
    const c = this.car;
    for (const t of this.turns) {
      if (t.done) continue;
      if (front > t.s0 - 22 && front < t.s0 + 3 && c.turn === t.dir && !c.hazard) t.ok = true;
      if (front >= t.s0 + 3 && front < t.s1 + 5) {
        t.done = true;
        if (!t.ok && this.courseStarted) this.penalty(5, `${t.dir > 0 ? '우회전' : '좌회전'} 방향지시등 미작동`);
      }
      if (front >= t.s1 + 5) t.done = true; // 이미 지나친 구간(구간 이동 등)
    }
  }

  checkHill(dt, front) {
    const c = this.car;
    const h = this.course.zones.hill;
    const st = this.hill;
    if (st.state === 'done') return;
    if (front > h.s1 + 5) { st.state = 'done'; return; }
    if (!st.announced && front > h.s0 - 10 && front < h.stop0) {
      st.announced = true;
      this.say('경사로 구간입니다. 앞범퍼를 정지구간 안에 맞춰 정지하십시오.');
    }
    if (st.state === 'idle') {
      if (front >= h.stop0 && front <= h.stop1 && Math.abs(c.v) < 0.04) {
        st.still += dt;
        if (st.still > 0.6) {
          st.state = 'stopped';
          st.stopS = c.sAbs;
          st.t = 0;
          this.emit('ok', '정지 확인');
          this.say('정지 확인. 뒤로 밀리지 않게 출발하십시오.');
          this.hint('브레이크 → 가속 페달로 발을 옮길 때 차가 밀리기 전에 살짝 가속');
        }
      } else {
        st.still = 0;
      }
      if (front > h.stop1 + 0.3 && st.state === 'idle') {
        st.state = 'passed';
        this.penalty(10, '경사로 정지구간 미정지');
      }
    } else if (st.state === 'stopped') {
      st.t += dt;
      const roll = st.stopS - c.sAbs;
      if (roll >= 1.0) { st.state = 'done'; return this.disqualify('경사로에서 1m 이상 뒤로 밀림'); }
      if (roll >= 0.5 && !st.p50) { st.p50 = true; this.penalty(10, '경사로 뒤로 밀림(50cm 이상)'); }
      if (front > h.top) {
        st.state = 'done';
        this.emit('ok', '경사로 통과');
        this.hint('');
        return;
      }
      if (st.t > 30) { st.state = 'done'; this.disqualify('경사로 정지 후 30초 안에 통과하지 못함'); }
      this.timerText = `경사로 ${Math.ceil(30 - st.t)}초`;
    }
    if (st.state !== 'stopped' && this.timerText.startsWith('경사로')) this.timerText = '';
  }

  // 바퀴와 검지선 접촉 판정
  parkLines() {
    const p = this.course.zones.park;
    const hw = p.lineW / 2;
    return [
      { id: 'bayL', s0: p.bayS - p.bayHalf - hw, s1: p.bayS - p.bayHalf + hw, d0: p.bayD0, d1: p.bayD1 + hw },
      { id: 'bayR', s0: p.bayS + p.bayHalf - hw, s1: p.bayS + p.bayHalf + hw, d0: p.bayD0, d1: p.bayD1 + hw },
      { id: 'bayB', s0: p.bayS - p.bayHalf - hw, s1: p.bayS + p.bayHalf + hw, d0: p.bayD1 - hw, d1: p.bayD1 + hw },
      { id: 'left', s0: p.s0, s1: p.s1, d0: p.leftD - hw, d1: p.leftD + hw },
      { id: 'edgeA', s0: p.s0, s1: p.bayS - p.bayHalf - hw, d0: ROAD.right - hw, d1: ROAD.right + hw },
      { id: 'edgeB', s0: p.bayS + p.bayHalf + hw, s1: p.s1, d0: ROAD.right - hw, d1: ROAD.right + hw },
    ];
  }

  checkPark(dt, ls) {
    const c = this.car;
    const p = this.course.zones.park;
    const st = this.park;
    if (st.state === 'done') return;
    if (st.state === 'idle') {
      if (!st.announced && ls > p.s0 - 25 && ls < p.s0) {
        st.announced = true;
        this.say('직각주차 코스입니다. 주차구역에 들어가 정지한 뒤 주차 브레이크를 거십시오.');
      }
      if (ls >= p.s0 && ls < p.s1) {
        st.state = 'active';
        st.t = 0;
      } else if (ls >= p.s1) {
        st.state = 'done';
      }
      return;
    }

    st.t += dt;
    if (!st.parked) this.timerText = `주차 ${Math.max(0, Math.ceil(120 - st.t))}초`;
    if (st.t > 120 && !st.timePen) { st.timePen = true; this.penalty(10, '직각주차 제한시간(120초) 초과'); }

    // 검지선 접촉
    const lines = this.parkLines();
    const base = this.lapBase;
    const wheels = c.wheelPoints(false).map((w) => {
      const q = c.projectNear(w);
      return { s: q.s - base, d: q.d };
    });
    const R = CAR.tireW / 2;
    for (const L of lines) {
      const touching = wheels.some((w) =>
        w.s > L.s0 - R && w.s < L.s1 + R && w.d > L.d0 - R && w.d < L.d1 + R);
      const rec = (st.lines[L.id] ||= { armed: true, clear: 0 });
      if (touching) {
        rec.clear = 0;
        if (rec.armed) {
          rec.armed = false;
          this.emit('rumble', 0.8);
          this.penalty(10, '직각주차 검지선 접촉');
        }
      } else {
        rec.clear += dt;
        if (rec.clear > 1.0) rec.armed = true;
      }
    }

    // 주차칸 안에 완전히 들어갔는지 (차체 네 모서리)
    const hw = p.lineW / 2;
    const corners = c.bodyCorners(CAR.width / 2 - 0.04, CAR.length / 2).map((pt) => {
      const q = c.projectNear(pt);
      return { s: q.s - base, d: q.d };
    });
    const inside = corners.every((q) =>
      q.s > p.bayS - p.bayHalf + hw && q.s < p.bayS + p.bayHalf - hw &&
      q.d > p.bayD0 - 0.05 && q.d < p.bayD1 - hw);
    if (inside && Math.abs(c.v) < 0.04) st.still += dt; else st.still = 0;

    if (!st.parked && st.still > 0.5) {
      st.parked = true;
      this.timerText = '';
      this.emit('ok', '주차 확인');
      this.say('주차 확인. 주차 브레이크를 거십시오.');
      this.hint(`주차 브레이크: ${this.tip('epb')} → 그 다음 다시 출발`);
    }
    if (st.parked && !st.epbDone && inside && c.epb) {
      st.epbDone = true;
      this.emit('ok', '주차 브레이크 확인');
      this.say('좋습니다. 이제 주차구역에서 나와 코스로 진행하십시오.');
      this.hint('D로 변속 → 핸들을 돌려 앞으로 빠져나오기');
    }
    if (st.parked && !inside && !st.epbChecked) {
      st.epbChecked = true;
      if (!st.epbDone) this.penalty(10, '직각주차 후 주차 브레이크 미작동');
    }

    if (ls > p.s1 + 1.5) {
      st.state = 'done';
      this.timerText = '';
      if (!st.parked) this.disqualify('직각주차 미이행');
    }
  }

  checkSignal(front) {
    const c = this.car;
    const sg = this.course.zones.signal;
    const st = this.sig;
    if (st.done) return;
    if (!st.announced && front > sg.stopLine - 30 && front < sg.stopLine) {
      st.announced = true;
      this.say('신호교차로입니다. 신호를 확인하십시오.');
      this.hint('황색·적색이면 앞범퍼가 정지선을 넘지 않게 정지 → 녹색에 출발');
    }
    if (st.prevFront != null && st.prevFront < sg.stopLine && front >= sg.stopLine) {
      const light = this.world.signal;
      if (light.state === 'red' || (light.state === 'yellow' && light.age > 1.0)) {
        st.done = true;
        this.disqualify('신호위반');
      }
    }
    st.prevFront = front;
    if (front > sg.crossS + sg.boxHalf + 3) {
      st.done = true;
      if (this.hintText.startsWith('황색')) this.hint('');
    }
    void c;
  }

  checkSudden(dt, ls) {
    const c = this.car;
    const z = this.course.zones.sudden;
    const st = this.sud;
    switch (st.state) {
      case 'idle':
        if (ls > z.s1 + 5) { st.state = 'done'; break; }
        if (ls >= st.trigS && (Math.abs(c.v) > 0.8 || ls > st.trigS + 6)) {
          st.state = 'alarm';
          st.t = 0;
          this.world.setAlarm(true);
          this.emit('alarm', true);
          this.say('돌발! 즉시 정지하십시오!', false);
          this.hint(`2초 안에 정지 → 3초 안에 비상등(${this.tip('hazard')}) → 출발할 때 비상등 끄기`);
        }
        break;
      case 'alarm':
        st.t += dt;
        if (Math.abs(c.v) < 0.05) {
          st.state = 'stopped';
          st.ts = 0;
          st.haz = c.hazard;
        } else if (st.t > 2 && !st.p1) {
          st.p1 = true;
          this.penalty(10, '돌발 시 2초 안에 미정지');
        }
        break;
      case 'stopped':
        st.ts += dt;
        if (c.hazard) st.haz = true;
        if (st.ts > 3 && !st.haz && !st.p2) {
          st.p2 = true;
          this.penalty(10, '돌발 시 비상점멸등 미작동');
        }
        if ((st.haz && st.ts > 1.2) || st.ts > 3.6) {
          st.state = 'go';
          st.goS = c.sAbs;
          this.world.setAlarm(false);
          this.emit('alarm', false);
          this.say('출발하십시오. 비상점멸등을 끄고 출발하십시오.');
        }
        break;
      case 'go':
        if (Math.abs(c.sAbs - st.goS) > 1.5) {
          st.state = 'done';
          if (c.hazard) this.penalty(10, '출발 시 비상점멸등 미해제');
          else this.emit('ok', '돌발 통과');
          this.hint('');
        }
        break;
      default: break;
    }
  }

  checkAccel(ls) {
    const c = this.car;
    const z = this.course.zones.accel;
    const st = this.acc;
    if (st.state === 'done') return;
    if (st.state === 'idle' && ls >= z.s0 && ls < z.s1) {
      st.state = 'in';
      st.maxV = 0;
      this.say('가속구간입니다. 시속 20킬로미터 이상으로 가속하십시오.');
    } else if (st.state === 'idle' && ls >= z.s1) {
      st.state = 'done';
    }
    if (st.state === 'in') {
      st.maxV = Math.max(st.maxV, c.kmh);
      this.timerText = `최고 ${st.maxV.toFixed(0)}km/h`;
      if (st.maxV >= 20 && !st.okSaid) {
        st.okSaid = true;
        this.emit('ok', '가속 확인');
        this.hint('좋아요! 이제 감속하세요.');
      }
      if (ls > z.s1) {
        st.state = 'done';
        this.timerText = '';
        if (st.maxV < 20) this.penalty(10, '가속구간 20km/h 미달');
      }
    }
  }

  practiceHints(ls, front) {
    if (this.mode !== 'practice') return;
    const c = this.car;
    // 아직 출발 전이면 시동/출발 방법을 계속 보여 줌
    if (!c.power) { this.hint(this.tip('prep')); return; }
    if (c.gear === 'P' && Math.abs(c.v) < 0.1) {
      this.hint(`출발: D로 변속(${this.tip('gear')}) → 브레이크를 놓고 가속(${this.tip('accel')})`);
      return;
    }
    const z = this.course.zones;
    const near = (s, before = 25, after = 0) => front > s - before && front < s + after;
    let h = '';
    if (near(z.hill.stop0, 22, 4)) h = '경사로: 앞범퍼가 노란 정지구간 안에 오면 정지 → 뒤로 밀리지 않게 출발';
    else if (near(z.park.s0, 22, 36)) h = '직각주차: 주차칸을 지나쳐 정지 → R → 핸들을 오른쪽으로 감고 천천히 후진 → 완전히 들어가면 정지 + EPB';
    else if (near(z.signal.stopLine, 30, 2)) h = '신호교차로: 황색·적색이면 정지선 앞에 정지';
    else if (near(z.sudden.s0, 8, 26)) h = '돌발구간: 경고가 울리면 2초 안에 정지 → 비상등';
    else if (near(z.accel.s0, 10, 35)) h = '가속구간: 20km/h 이상으로 가속';
    else {
      for (const t of z.turns) {
        if (near(t.s0, 22, 2)) { h = `${t.dir > 0 ? '우회전' : '좌회전'} 전에 ${t.dir > 0 ? '오른쪽' : '왼쪽'} 방향지시등을 켜세요 (${this.tip(t.dir > 0 ? 'turnR' : 'turnL')})`; break; }
      }
    }
    if (this.sud.state === 'alarm' || this.sud.state === 'stopped' || this.sud.state === 'go') return;
    if (this.park.state === 'active' && this.park.parked) return;
    this.hint(h);
    void ls;
  }

  sectionName(front) {
    const z = this.course.zones;
    if (this.phase === 'prep') return '시험 준비';
    if (this.phase === 'devices') return '기기조작';
    if (this.phase === 'start') return '출발';
    if (front < 0) return '출발';
    if (front < z.hill.s1) return '경사로';
    for (const t of z.turns) if (front >= t.s0 && front < t.s1) return t.dir > 0 ? '우회전' : '좌회전';
    if (front >= z.park.s0 - 5 && front < z.park.s1 + 5) return '직각주차';
    if (front >= z.signal.stopLine - 30 && front < z.signal.crossS + 8) return '신호교차로';
    if (front >= z.sudden.s0 && front < z.sudden.s1) return '돌발';
    if (front >= z.accel.s0 && front < z.accel.s1) return '가속구간';
    if (front >= z.finish - 20 && front < z.finish + 5) return '종료';
    return '차로준수';
  }

  getStatus() {
    const label = this.mode === 'exam' ? `시험 ${this.score}점` : this.mode === 'practice' ? '연습 주행'
      : this.mode === 'drill' ? '기기조작 연습' : '대기';
    return {
      kind: 'course',
      label,
      scoring: this.scoring,
      mode: this.mode,
      phase: this.phase,
      score: this.score,
      section: this.section,
      instruction: this.instruction,
      hint: this.hintText,
      timer: this.timerText,
      result: this.result,
    };
  }
}
