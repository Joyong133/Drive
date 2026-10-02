// 도로주행 시험: 내비게이션 안내 + 채점 (도로교통공단 도로주행시험 기준을 단순화)
import { CAR } from './carModel.js';
import { Emitter } from './util.js';
import { ROUTE, BAYS, SCHOOL, LANE, STOP_OFF, moveName } from './city.js';

export const ROAD_PASS = 70;

export const ROAD_RULES = [
  { item: '출발', cond: '출발할 때 왼쪽 방향지시등을 켜지 않음', pts: 5 },
  { item: '진로변경', cond: '차로를 바꿀 때 방향지시등을 켜지 않음', pts: 7 },
  { item: '진로변경', cond: '교차로 앞 실선 구간(진로변경 제한선)에서 차로 변경', pts: 7 },
  { item: '차로 유지', cond: '두 차로에 걸쳐 4초 넘게 주행 / 도로 가장자리 침범', pts: 5 },
  { item: '좌·우회전', cond: '회전하기 전에 방향지시등을 켜지 않음', pts: 5 },
  { item: '좌·우회전', cond: '좌회전은 1차로, 우회전은 맨 오른쪽 차로에서 하지 않음', pts: 7 },
  { item: '교차로', cond: '빨간불에 정지선을 넘어 멈춤 (정지선 침범)', pts: 5 },
  { item: '교차로', cond: '빨간불 우회전 전에 정지선 앞에서 일시정지하지 않음', pts: 10 },
  { item: '일시정지', cond: '일시정지 표지 앞에서 완전히 멈추지 않음', pts: 10 },
  { item: '어린이보호구역', cond: '신호 없는 횡단보도 앞에서 일시정지하지 않음', pts: 10 },
  { item: '운전 조작', cond: '급제동, 급출발(급가속)', pts: 5 },
  { item: '안전거리', cond: '앞차와 너무 가깝게 2.5초 넘게 주행', pts: 5 },
  { item: '경로', cond: '안내한 방향과 다르게 주행', pts: 5 },
  { item: '종료', cond: '정차할 때 오른쪽 방향지시등을 켜지 않음', pts: 5 },
];

export const ROAD_DQ = [
  '신호위반 (빨간불에 교차로 진입)',
  '중앙선 침범',
  '제한속도를 10km/h 넘게 초과',
  '어린이보호구역에서 30km/h 초과',
  '횡단보도에 보행자가 있는데 지나감 (보행자 보호 위반)',
  '다른 차나 보행자와 충돌 (교통사고)',
  '도로를 벗어나 보도·연석 침범',
  '안전띠를 매지 않고 주행',
  '감점으로 점수가 70점 미만이 되는 순간',
];

const ARROW = { S: '↑', L: '↰', R: '↱', END: '◎' };

export class RoadExam extends Emitter {
  constructor({ car, city }) {
    super();
    this.car = car;
    this.city = city;
    this.model = city.model;
    this.mode = 'idle'; // idle | road | roadPractice
    this.phase = 'idle';
    this.score = 100;
    this.penalties = [];
    this.result = null;
    this.instruction = '';
    this.hintText = '';
    this.tip = (k) => k;
    this.nav = null;
    this.loc = null;
  }

  get active() { return this.mode === 'road' || this.mode === 'roadPractice'; }
  get scoring() { return this.mode === 'road'; }
  get practice() { return this.mode === 'roadPractice'; }

  start(practice = false) {
    const c = this.car;
    c.reset();
    const p = this.model.startPose;
    c.placeXZ(p.x, p.z, p.heading);
    c.beltRequired = !practice;
    this.mode = practice ? 'roadPractice' : 'road';
    this.score = 100;
    this.penalties = [];
    this.result = null;
    this.leg = 0;
    this.flags = {};
    this.appr = null;
    this.laneKey = null;
    this.laneIdx = null;
    this.t = 0;
    this.lastL = this.lastR = -99;
    this.prevV = 0;
    this.accS = 0;
    this.harshT = this.launchT = this.tailT = this.straddleT = 0;
    this.lastHarsh = this.lastLaunch = this.lastTail = this.lastStraddle = this.lastSpeedWarn = -99;
    this.edgeArmed = true;
    this.edgeClear = 0;
    this.startPos = { x: c.x, z: c.z };
    this.lastGood = { x: c.x, z: c.z, h: c.heading };
    this.schoolSaid = false;
    this.schoolStopped = false;
    this.prevSchoolFront = null;
    this.pedTriggered = false;
    this.teleportT = 0;
    this.stillT = 0;
    this.dq = false;
    this.setPhase('prep');
    this.say(practice
      ? '도로주행 연습입니다. 내비게이션 안내를 따라 운전해 보세요. 실수하면 알려 드려요.'
      : '도로주행 시험을 시작합니다. 안전띠를 매고 시동을 거십시오.');
    this.hint(this.tip('prep'));
    this.emit('started', this.mode);
  }

  stop() {
    this.mode = 'idle';
    this.setPhase('idle');
    this.nav = null;
  }

  setPhase(p) { this.phase = p; this.phaseT = 0; }
  say(text, speak = true) { this.instruction = text; this.emit('say', text, speak); }
  hint(text) { if (text !== this.hintText) { this.hintText = text; this.emit('hint', text); } }
  notice(text) { this.emit('notice', text); }

  penalty(pts, reason) {
    if (this.phase === 'result') return;
    if (this.practice) {
      this.penalties.push({ pts, reason, dq: false });
      this.emit('warn', `${reason} (시험이면 -${pts}점)`);
      return;
    }
    this.score -= pts;
    this.penalties.push({ pts, reason, dq: false });
    this.emit('penalty', pts, reason);
    this.say(`${reason}. ${pts}점 감점.`);
    if (this.score < ROAD_PASS) this.end(false, `점수가 ${this.score}점으로 합격 기준(70점) 미만입니다`);
  }

  disqualify(reason) {
    if (this.phase === 'result') return;
    if (this.practice) {
      if (this.t - (this.lastDqWarn || -99) < 3) return;
      this.lastDqWarn = this.t;
      this.emit('warn', `${reason} (시험이면 실격)`);
      return;
    }
    this.penalties.push({ pts: 0, reason, dq: true });
    this.end(false, `실격: ${reason}`);
  }

  end(pass, reason = '') {
    this.result = { pass, score: Math.max(0, this.score), reason, penalties: [...this.penalties], kind: 'road' };
    this.setPhase('result');
    this.nav = null;
    if (pass) this.say(`도로주행 시험 합격입니다! 점수는 ${this.score}점입니다. 축하합니다!`);
    else this.say(`도로주행 시험 불합격입니다. ${reason}.`);
    this.hint('메뉴에서 다시 시험을 보거나 연습할 수 있어요.');
    this.emit('result', this.result);
  }

  // ───────── 매 프레임
  update(dt) {
    if (!this.active) return;
    this.t += dt;
    this.phaseT += dt;
    const c = this.car;
    const loc = this.model.locate(c.x, c.z, c.heading);
    this.loc = loc;
    if (c.turn === -1 && !c.hazard) this.lastL = this.t;
    if (c.turn === 1 && !c.hazard) this.lastR = this.t;

    for (const e of this.city.events) {
      if (e.type === 'crash') this.crash('교통사고 (다른 차와 충돌)');
      if (e.type === 'hitPed') this.crash('교통사고 (보행자와 충돌)');
    }
    if (this.phase === 'result') return;

    if (this.teleportT > 0) {
      this.teleportT -= dt;
      if (this.teleportT <= 0) this.returnToRoute();
      return;
    }

    if (this.scoring && !c.seatbelt && Math.abs(c.v) > 0.3) return this.disqualify('안전띠 미착용');

    this.keepOnRoad();

    switch (this.phase) {
      case 'prep':
        if (c.power && this.phaseT > 0.5) {
          this.setPhase('start');
          this.say('왼쪽 방향지시등을 켜고, 뒤에서 오는 차를 확인한 뒤 출발하십시오.');
          this.hint(`왼쪽 방향지시등: ${this.tip('turnL')} → D로 변속 → 천천히 출발`);
        }
        break;
      case 'start':
        if (Math.hypot(c.x - this.startPos.x, c.z - this.startPos.z) > 1.5) {
          if (!(c.turn === -1 || this.t - this.lastL < 6)) this.penalty(5, '출발 시 방향지시등 미작동');
          this.setPhase('drive');
          this.hint('');
          this.announceLeg();
        }
        break;
      case 'drive':
        this.driveChecks(dt, loc);
        if (this.phase === 'drive') this.navigate(loc, dt);
        break;
      case 'park':
        this.hint(`P단: ${this.tip('gear')} · 주차 브레이크: ${this.tip('epb')}`);
        if (c.gear === 'P') this.finish();
        break;
      default: break;
    }
  }

  crash(reason) {
    this.car.v = 0;
    this.emit('rumble', 1);
    this.disqualify(reason);
  }

  // 보도/연석으로 올라가면 되돌림 (시험이면 실격)
  keepOnRoad() {
    const c = this.car;
    if (this.model.onPavement(c.x, c.z)) {
      this.lastGood = { x: c.x, z: c.z, h: c.heading };
      return;
    }
    c.x = this.lastGood.x; c.z = this.lastGood.z; c.heading = this.lastGood.h;
    c.v = 0;
    this.emit('rumble', 0.8);
    this.disqualify('도로 이탈 (보도·연석 침범)');
  }

  dOf(road, dir, x, z) {
    return road.axis === 'x' ? (z - road.c) * dir : (x - road.c) * -dir;
  }

  driveChecks(dt, loc) {
    const c = this.car;
    // 급제동 / 급출발
    const a = (c.v - this.prevV) / Math.max(dt, 1e-3);
    this.prevV = c.v;
    this.accS += (a - this.accS) * Math.min(1, dt * 10);
    if (this.accS < -6.5 && c.v > 1) this.harshT += dt; else this.harshT = 0;
    if (this.harshT > 0.15 && this.t - this.lastHarsh > 5) { this.lastHarsh = this.t; this.penalty(5, '급제동'); }
    if (this.accS > 3.0 && c.v < 9) this.launchT += dt; else this.launchT = 0;
    if (this.launchT > 0.4 && this.t - this.lastLaunch > 5) { this.lastLaunch = this.t; this.penalty(5, '급출발 (급가속)'); }

    if (loc.type !== 'road') { this.approachTrack(loc); return; }
    const road = loc.road;

    // 속도
    const kmh = c.kmh;
    if (loc.school && kmh > SCHOOL.limit + 0.5) return this.disqualify('어린이보호구역 속도 위반 (30km/h 초과)');
    if (kmh > loc.limit + 10) return this.disqualify(`제한속도 10km/h 초과 (${loc.limit}km/h 구간)`);
    if (kmh > loc.limit + 2 && this.t - this.lastSpeedWarn > 5) {
      this.lastSpeedWarn = this.t;
      this.notice(`제한속도 ${loc.limit}km/h를 넘었어요. 감속하세요!`);
    }

    // 안전거리
    if (c.v > 4) {
      const gap = this.city.gapAhead(c);
      if (gap < Math.max(5, c.v * 1.0)) this.tailT += dt; else this.tailT = 0;
      if (this.tailT > 2.5 && this.t - this.lastTail > 8) { this.lastTail = this.t; this.penalty(5, '안전거리 미확보'); }
    } else {
      this.tailT = 0;
    }

    // 차로 관련 (교차로 근처와 정차 구역은 제외)
    const nearInter = (loc.next && loc.next.distBox < STOP_OFF) || (loc.prevDist != null && loc.prevDist < STOP_OFF);
    const key = `${road.id}${loc.dir}`;
    if (key !== this.laneKey) { this.laneKey = key; this.laneIdx = null; }
    if (!nearInter && !loc.bay) {
      let center = false, edge = false;
      for (const w of c.wheelPoints(true)) {
        if (this.model.inBay(w.x, w.z)) continue; // 정차 구역 위 바퀴는 제외
        const d = this.dOf(road, loc.dir, w.x, w.z);
        if (d < -0.05) center = true;
        if (d > road.hw + 0.25 && loc.d < road.hw) edge = true; // 차 중심이 도로 안일 때만 (정차구역 진출입 제외)
      }
      if (center) return this.disqualify('중앙선 침범');
      if (edge) {
        this.edgeClear = 0;
        if (this.edgeArmed) { this.edgeArmed = false; this.penalty(5, '차로 이탈 (도로 가장자리 침범)'); }
      } else {
        this.edgeClear += dt;
        if (this.edgeClear > 1.5) this.edgeArmed = true;
      }
      if (road.lanes === 2) {
        const dc = loc.d;
        if (this.laneIdx == null) this.laneIdx = dc < LANE ? 0 : 1;
        let changed = 0;
        if (this.laneIdx === 0 && dc > LANE + 0.35) { this.laneIdx = 1; changed = 1; }
        else if (this.laneIdx === 1 && dc < LANE - 0.35) { this.laneIdx = 0; changed = -1; }
        if (changed) {
          const signaled = c.turn === changed || (changed < 0 ? this.t - this.lastL : this.t - this.lastR) < 4;
          if (!signaled) this.penalty(7, '진로변경 시 방향지시등 미작동');
          const n = loc.next;
          if (n && n.distStop < 30 && n.distStop > -2 && (n.inter.signal || n.inter.stops.includes(n.approach))) {
            this.penalty(7, '진로변경 제한구간(실선)에서 진로변경');
          }
        }
        if (Math.abs(dc - LANE) < 0.55) this.straddleT += dt; else this.straddleT = 0;
        if (this.straddleT > 4 && this.t - this.lastStraddle > 10) { this.lastStraddle = this.t; this.penalty(5, '차로 걸침 주행'); }
      }
    }

    this.schoolChecks(loc);
    this.approachTrack(loc);
  }

  schoolChecks(loc) {
    const c = this.car;
    const road = loc.road;
    if (road.id !== SCHOOL.road) { this.schoolSaid = false; return; }
    if (loc.school && !this.schoolSaid) {
      this.schoolSaid = true;
      this.say('어린이 보호구역입니다. 시속 30킬로미터 이하로 서행하고, 신호 없는 횡단보도 앞에서는 반드시 일시정지하세요.');
    }
    const stopAlong = SCHOOL.cross - loc.dir * 4.5;
    const front = (stopAlong - loc.along) * loc.dir - CAR.length / 2;
    if (front > 30 && front < 45 && !this.pedTriggered) {
      this.pedTriggered = true;
      if (Math.random() < 0.7) this.city.spawnCrossingPed();
    }
    if (front > 50) this.pedTriggered = false;
    if (front > 15) this.schoolStopped = false;
    if (Math.abs(c.v) < 0.15 && front < 5 && front > -1) this.schoolStopped = true;
    if (this.prevSchoolFront != null && this.prevSchoolFront > 0 && front <= 0 && !this.schoolStopped) {
      this.penalty(10, '어린이보호구역 횡단보도 앞 일시정지 위반');
    }
    this.prevSchoolFront = front;
    // 보행자가 건너는 중에 횡단보도 위를 지나가면 실격
    const a0 = Math.min(loc.along - CAR.length / 2, loc.along + CAR.length / 2);
    const a1 = Math.max(loc.along - CAR.length / 2, loc.along + CAR.length / 2);
    if (a1 > SCHOOL.cross - 2 && a0 < SCHOOL.cross + 2 && Math.abs(c.v) > 0.1 && this.city.pedOnSchoolCrossing()) {
      this.disqualify('보행자 보호 의무 위반 (횡단보도)');
    }
  }

  // 교차로 접근 → 정지선 → 교차로 안 → 빠져나온 방향 판정
  approachTrack(loc) {
    const c = this.car;
    if (loc.type === 'inter') {
      if (this.appr && loc.inter.key === this.appr.inter.key) this.appr.inBox = true;
      return;
    }
    if (loc.type !== 'road') return;
    // 교차로를 지나 다른 도로(또는 같은 도로의 반대편)로 나왔으면 판정.
    // 급한 우회전은 교차로 상자를 안 거치고 모서리로 돌 수 있어서 도로가 바뀐 것도 함께 봄
    if (this.appr && (this.appr.inBox || loc.road !== this.appr.road || loc.dir !== this.appr.dir)) {
      const ap = this.appr;
      this.appr = null;
      const mv = this.model.movement(ap.road.axis, ap.dir, loc.road.axis, loc.dir);
      this.judgeExit(ap, mv);
      if (this.phase !== 'drive') return;
    }
    const n = loc.next;
    if (!n) return;
    const key = n.inter.key + n.approach;
    if (!this.appr || this.appr.key !== key) {
      if (n.distStop > 70) return;
      this.appr = {
        key, inter: n.inter, approach: n.approach, road: loc.road, dir: loc.dir,
        sigL: false, sigR: false, stopped: false, lineState: null, lane: null,
        prevStop: null, prevBox: null, redEntry: false, overPen: false, inBox: false,
      };
    }
    const ap = this.appr;
    const it = ap.inter;
    const frontStop = n.distStop - CAR.length / 2;
    const frontBox = n.distBox - CAR.length / 2;
    if (frontStop < 35) {
      if (c.turn === -1 && !c.hazard) ap.sigL = true;
      if (c.turn === 1 && !c.hazard) ap.sigR = true;
    }
    if (Math.abs(c.v) < 0.15 && frontStop < 5 && frontStop > -1) ap.stopped = true;
    if (frontStop > 0) ap.lane = loc.lane;
    const isStopSign = it.stops.includes(ap.approach);
    if (ap.prevStop != null && ap.prevStop > 0 && frontStop <= 0) {
      ap.lane = loc.lane;
      if (it.signal) {
        const st = this.city.signalOf(it.key, ap.approach);
        ap.lineState = st.state === 'green' || (st.state === 'yellow' && st.age < 1.5) ? 'go' : 'stop';
      }
      if (isStopSign && !ap.stopped) this.penalty(10, '일시정지 위반 (정지선 앞에서 완전히 멈추지 않음)');
    }
    if (it.signal && ap.lineState === 'stop' && frontStop < 0 && frontBox > 0 && Math.abs(c.v) < 0.1 && !ap.overPen) {
      const st = this.city.signalOf(it.key, ap.approach);
      if (st.state !== 'green') { ap.overPen = true; this.penalty(5, '정지선 침범'); }
    }
    if (ap.prevBox != null && ap.prevBox > 0 && frontBox <= 0 && it.signal) {
      if (ap.lineState !== 'go') {
        const st = this.city.signalOf(it.key, ap.approach);
        if (st.state !== 'green' && !(st.state === 'yellow' && st.age < 1.5)) ap.redEntry = true;
      }
    }
    ap.prevStop = frontStop;
    ap.prevBox = frontBox;
  }

  judgeExit(ap, mv) {
    if (ap.redEntry) {
      if (mv === 'R') { if (!ap.stopped) this.penalty(10, '빨간불 우회전 전 일시정지 위반'); }
      else return this.disqualify('신호위반');
    }
    if (mv === 'L' && !ap.sigL) this.penalty(5, '좌회전 방향지시등 미작동');
    if (mv === 'R' && !ap.sigR) this.penalty(5, '우회전 방향지시등 미작동');
    if (ap.road.lanes === 2 && ap.lane != null) {
      if (mv === 'L' && ap.lane !== 0) this.penalty(7, '좌회전 차로 위반 (1차로에서 좌회전해야 해요)');
      if (mv === 'R' && ap.lane !== 1) this.penalty(7, '우회전 차로 위반 (맨 오른쪽 차로에서 우회전해야 해요)');
    }
    if (this.phase !== 'drive') return;
    const leg = ROUTE[this.leg];
    if (leg && leg.to === ap.inter.key && mv === leg.move) {
      this.leg++;
      this.flags = {};
      this.emit('ok', `${moveName[mv]} 확인`);
      this.announceLeg();
    } else {
      this.wrongRoute();
    }
  }

  wrongRoute() {
    this.penalty(5, '안내한 경로와 다르게 주행');
    if (this.phase === 'result') return;
    this.say('경로를 벗어났습니다. 잠시 후 원래 경로로 돌아갑니다.');
    this.teleportT = 2.5;
  }

  returnToRoute() {
    const leg = ROUTE[this.leg];
    const pose = this.model.legPose(this.leg, 45, leg.move === 'L' ? 'inner' : 'outer');
    const c = this.car;
    c.placeXZ(pose.x, pose.z, pose.heading);
    this.appr = null;
    this.laneKey = null;
    this.prevV = 0;
    this.accS = 0;
    this.lastGood = { x: c.x, z: c.z, h: c.heading };
    this.flags = {};
    this.announceLeg();
  }

  announceLeg() {
    const leg = ROUTE[this.leg];
    if (!leg) return;
    if (leg.move === 'END') {
      this.say('이제 목적지로 갑니다. 오른쪽 "도착" 표시가 보이면 그 안에 정차하세요.');
      return;
    }
    const name = moveName[leg.move];
    this.say(leg.move === 'S' ? '다음 교차로에서 직진입니다.' : `다음 교차로에서 ${name}입니다.`);
    const road = this.model.byId[leg.road];
    if (road.lanes === 2 && leg.move === 'L') this.hint('좌회전은 1차로(왼쪽 차로)에서! 실선이 시작되기 전에 방향지시등을 켜고 진로를 바꾸세요.');
    else if (road.lanes === 2 && leg.move === 'R') this.hint('우회전은 맨 오른쪽 차로에서!');
    else this.hint('');
  }

  navigate(loc, dt) {
    const c = this.car;
    const leg = ROUTE[this.leg];
    if (!leg) return;
    const f = this.flags;
    if (leg.move === 'END') {
      const b = BAYS.dest;
      let dist = null;
      if (loc.type === 'road' && loc.road.id === 'A1' && loc.dir === -1) {
        dist = Math.max(0, c.x - b.x1);
        if (!f.near && dist < 110) {
          f.near = true;
          this.say('목적지가 가까워졌습니다. 오른쪽 방향지시등을 켜고, 오른쪽 "도착" 구역 안에 정차하십시오.');
          this.hint(`오른쪽 방향지시등: ${this.tip('turnR')} → 파란 "도착" 구역에 멈추기`);
        }
      }
      this.nav = { move: 'END', dist };
      const inZone = c.x > b.x0 + 2 && c.x < b.x1 - 2 && c.z < -5.9 && c.z > -8.9;
      if (inZone && Math.abs(c.v) < 0.05) this.stillT += dt; else this.stillT = 0;
      if (this.stillT > 0.8) {
        if (!(c.turn === 1 || this.t - this.lastR < 10)) this.penalty(5, '정차 시 오른쪽 방향지시등 미작동');
        if (this.phase === 'result') return;
        this.setPhase('park');
        this.say('정차를 확인했습니다. 변속기를 P로 바꾸고 주차 브레이크를 거십시오.');
      } else if (loc.type === 'road' && loc.road.id === 'A1' && loc.dir === -1 && c.x < b.x0 - 6) {
        this.penalty(5, '도착 지점을 지나침');
        if (this.phase === 'result') return;
        this.say('도착 지점을 지나쳤습니다. 다시 접근합니다.');
        this.teleportT = 2;
      }
      return;
    }
    let dist = null;
    if (loc.type === 'road' && loc.road.id === leg.road && loc.dir === leg.dir && loc.next && loc.next.inter.key === leg.to) {
      dist = Math.max(0, loc.next.distStop);
      const name = moveName[leg.move];
      const road = loc.road;
      if (!f.a150 && dist < 150 && dist > 70) {
        f.a150 = true;
        let extra = '';
        if (road.lanes === 2 && leg.move === 'L') extra = ' 1차로로 미리 진로를 변경하세요.';
        if (road.lanes === 2 && leg.move === 'R') extra = ' 맨 오른쪽 차로를 이용하세요.';
        if (leg.move !== 'S') this.say(`150미터 앞 교차로에서 ${name}입니다.${extra}`);
      }
      if (!f.a50 && dist < 55) {
        f.a50 = true;
        const it = this.model.interByKey[leg.to];
        const app = loc.next.approach;
        if (it.stops.includes(app)) this.say(`전방에 일시정지 표지가 있습니다. 정지선 앞에서 완전히 멈춘 뒤 ${name}하세요.`);
        else if (leg.move === 'S') this.say('이번 교차로에서 직진하세요. 신호를 확인하세요.');
        else this.say(`잠시 후 ${name}입니다. 방향지시등을 켜세요.`);
      }
    }
    this.nav = { move: leg.move, dist };
  }

  finish() {
    if (this.practice) {
      this.setPhase('result');
      this.result = { pass: true, score: 100, reason: '', penalties: [...this.penalties], kind: 'road', practice: true };
      this.say(`도로주행 연습 완료! ${this.penalties.length ? `실수 ${this.penalties.length}번을 다시 확인해 보세요.` : '실수 없이 잘하셨어요!'}`);
      this.hint('메뉴에서 도로주행 시험에 도전해 보세요.');
      this.emit('result', this.result);
      return;
    }
    this.end(this.score >= ROAD_PASS, '');
  }

  getStatus() {
    const loc = this.loc;
    let section = '';
    let limit = null;
    if (loc && loc.type === 'road') {
      section = `${loc.road.name}${loc.school ? ' · 어린이보호구역' : ''}`;
      limit = loc.limit;
    } else if (loc && loc.type === 'inter') {
      section = '교차로';
    }
    let timer = '';
    if (this.nav && this.phase === 'drive') {
      const n = this.nav;
      timer = `${ARROW[n.move]} ${moveName[n.move]}${n.dist != null ? ` ${Math.round(n.dist)}m` : ''}`;
    }
    if (this.phase === 'prep') section = '출발 준비';
    return {
      mode: this.mode,
      kind: 'road',
      label: this.mode === 'road' ? `도로주행 ${this.score}점` : '도로주행 연습',
      scoring: this.scoring,
      phase: this.phase,
      score: this.score,
      section,
      instruction: this.instruction,
      hint: this.hintText,
      timer,
      result: this.result,
      limit,
      nav: this.nav,
      leg: this.leg,
    };
  }
}
