// 실내 디스플레이(계기판·센터 터치스크린·HUD), 디지털 미러, 누를 수 있는 버튼
import * as THREE from 'three';
import { CAR } from './carModel.js';
import { makeCanvas, canvasTexture, roundRect, FONT, clamp } from './util.js';

export const LAYER_HUD = 3;

const SCREEN_W = 1024, SCREEN_H = 600;

function wrapText(ctx, text, maxW) {
  const out = [];
  for (const para of String(text).split('\n')) {
    let line = '';
    for (const ch of para) {
      const test = line + ch;
      if (ctx.measureText(test).width > maxW && line) {
        // 단어 경계(공백)에서 끊기
        const sp = line.lastIndexOf(' ');
        if (sp > line.length * 0.5) {
          out.push(line.slice(0, sp));
          line = line.slice(sp + 1) + ch;
        } else {
          out.push(line);
          line = ch;
        }
      } else {
        line = test;
      }
    }
    out.push(line);
  }
  return out;
}

export class Cockpit {
  constructor({ model, car, exam, app }) {
    this.model = model;
    this.car = car;
    this.exam = exam;
    this.app = app;
    const it = model.interior;

    // 계기판
    this.clusterCanvas = makeCanvas(768, 272);
    this.clusterTex = canvasTexture(this.clusterCanvas);
    it.cluster.material = new THREE.MeshBasicMaterial({ map: this.clusterTex, toneMapped: false });

    // 센터 터치스크린
    this.screenCanvas = makeCanvas(SCREEN_W, SCREEN_H);
    this.screenTex = canvasTexture(this.screenCanvas);
    it.center.material = new THREE.MeshBasicMaterial({ map: this.screenTex, toneMapped: false });
    this.page = 'home';
    this.screenButtons = [];
    this.pressedId = null;
    this.pressedT = 0;
    this.hoverUV = null;

    // 후방카메라 화면 (R단)
    this.rearRT = new THREE.WebGLRenderTarget(512, 300);
    const rearOverlayCanvas = makeCanvas(512, 300);
    this.drawRearGuides(rearOverlayCanvas);
    this.rearView = new THREE.Mesh(
      new THREE.PlaneGeometry(0.34, 0.2),
      new THREE.MeshBasicMaterial({ map: this.rearRT.texture, toneMapped: true }),
    );
    const guide = new THREE.Mesh(
      new THREE.PlaneGeometry(0.34, 0.2),
      new THREE.MeshBasicMaterial({ map: canvasTexture(rearOverlayCanvas), transparent: true, toneMapped: false, depthWrite: false }),
    );
    guide.position.z = 0.0015;
    this.rearView.add(guide);
    this.rearView.position.z = 0.002;
    this.rearView.visible = false;
    it.center.add(this.rearView);
    // 좌우 반전 (후방카메라는 거울처럼 보여 줌)
    const uv = this.rearView.geometry.attributes.uv;
    for (let i = 0; i < uv.count; i++) uv.setX(i, 1 - uv.getX(i));

    // 디지털 사이드미러/룸미러
    this.mirrorRTs = {
      left: new THREE.WebGLRenderTarget(320, 200),
      right: new THREE.WebGLRenderTarget(320, 200),
      rearMirror: new THREE.WebGLRenderTarget(420, 110),
    };
    it.mirrorL.material = new THREE.MeshBasicMaterial({ map: this.mirrorRTs.left.texture });
    it.mirrorR.material = new THREE.MeshBasicMaterial({ map: this.mirrorRTs.right.texture });
    it.rearMirror.material = new THREE.MeshBasicMaterial({ map: this.mirrorRTs.rearMirror.texture });
    this.mirrorFrame = 0;

    // HUD (앞유리에 떠 있는 안내)
    this.hudCanvas = makeCanvas(1024, 300);
    this.hudTex = canvasTexture(this.hudCanvas);
    this.hud = new THREE.Mesh(
      new THREE.PlaneGeometry(0.96, 0.28),
      new THREE.MeshBasicMaterial({ map: this.hudTex, transparent: true, depthTest: false, depthWrite: false, toneMapped: false }),
    );
    this.hud.position.set(CAR.eye.x + 0.05, CAR.eye.y - 0.1, CAR.eye.z - 1.75);
    this.hud.rotation.x = 0.06;
    this.hud.renderOrder = 100;
    this.hud.layers.set(LAYER_HUD);
    model.root.add(this.hud);
    this.flash = null; // { text, color, t }

    this.lastDraw = 0;
    this.lastHud = '';
    this.buttonStates = {};
  }

  // ───────── 후방카메라 가이드라인
  drawRearGuides(c) {
    const g = c.getContext('2d');
    g.clearRect(0, 0, c.width, c.height);
    const W = c.width, H = c.height;
    const line = (x0, y0, x1, y1, color, w = 5) => { g.strokeStyle = color; g.lineWidth = w; g.beginPath(); g.moveTo(x0, y0); g.lineTo(x1, y1); g.stroke(); };
    // 원근감 있는 두 선 (빨강=가까움, 노랑, 초록=멂)
    const L = (t) => [W * (0.12 + 0.22 * t), H * (1 - 0.62 * t)];
    const R = (t) => [W * (0.88 - 0.22 * t), H * (1 - 0.62 * t)];
    const seg = [[0, 0.25, '#ff3b3b'], [0.25, 0.6, '#ffd23a'], [0.6, 1, '#3ee08f']];
    for (const [a, b, col] of seg) {
      line(...L(a), ...L(b), col);
      line(...R(a), ...R(b), col);
      line(...L(b), L(b)[0] + 20, L(b)[1], col);
      line(...R(b), R(b)[0] - 20, R(b)[1], col);
    }
    g.fillStyle = 'rgba(0,0,0,0.5)';
    roundRect(g, 10, 10, 150, 40, 10); g.fill();
    g.fillStyle = '#fff'; g.font = `700 24px ${FONT}`; g.textBaseline = 'middle';
    g.fillText('후방 카메라', 22, 31);
  }

  // ───────── 계기판
  drawCluster() {
    const c = this.car;
    const g = this.clusterCanvas.getContext('2d');
    const W = 768, H = 272;
    const bg = g.createLinearGradient(0, 0, 0, H);
    bg.addColorStop(0, '#05070d');
    bg.addColorStop(1, '#0d1424');
    g.fillStyle = bg;
    g.fillRect(0, 0, W, H);

    // 속도
    g.fillStyle = c.power ? '#ffffff' : '#45506a';
    g.font = `900 120px ${FONT}`;
    g.textAlign = 'center';
    g.textBaseline = 'alphabetic';
    g.fillText(String(Math.round(c.kmh)), 170, 160);
    g.font = `700 26px ${FONT}`;
    g.fillStyle = '#7f8db0';
    g.fillText('km/h', 170, 196);

    // 속도 바
    const frac = clamp(c.kmh / 40, 0, 1);
    g.fillStyle = '#1c2438';
    roundRect(g, 40, 220, 260, 12, 6); g.fill();
    const gb = g.createLinearGradient(40, 0, 300, 0);
    gb.addColorStop(0, '#3ddcff'); gb.addColorStop(1, '#7b61ff');
    g.fillStyle = gb;
    roundRect(g, 40, 220, Math.max(12, 260 * frac), 12, 6); g.fill();

    // 기어
    const gears = ['P', 'R', 'N', 'D'];
    gears.forEach((gr, i) => {
      const x = 380 + i * 56;
      const active = c.gear === gr;
      if (active) {
        g.fillStyle = gr === 'R' ? '#ff5468' : '#3ddcff';
        roundRect(g, x - 24, 70, 48, 58, 10); g.fill();
      }
      g.fillStyle = active ? '#061128' : '#55617d';
      g.font = `900 44px ${FONT}`;
      g.fillText(gr, x, 116);
    });

    // 방향지시등 화살표
    const arrow = (x, dir, on) => {
      g.fillStyle = on ? '#2bff88' : '#1b2a24';
      g.beginPath();
      g.moveTo(x + dir * 30, 40);
      g.lineTo(x, 18); g.lineTo(x, 30); g.lineTo(x - dir * 22, 30);
      g.lineTo(x - dir * 22, 50); g.lineTo(x, 50); g.lineTo(x, 62);
      g.closePath(); g.fill();
    };
    const blink = c.blinkOn;
    arrow(384, -1, blink && (c.turn < 0 || c.hazard));
    arrow(712, 1, blink && (c.turn > 0 || c.hazard));

    // 경고등/표시등
    const icon = (x, y, text, color, on) => {
      g.fillStyle = on ? color : '#1a2133';
      roundRect(g, x, y, 76, 40, 8); g.fill();
      g.fillStyle = on ? '#061128' : '#3a4560';
      g.font = `900 22px ${FONT}`;
      g.fillText(text, x + 38, y + 28);
    };
    icon(352, 160, 'READY', '#3ee08f', c.power);
    icon(436, 160, c.lights === 2 ? '상향' : '전조', c.lights === 2 ? '#4aa3ff' : '#3ee08f', c.lights > 0);
    icon(520, 160, '벨트', '#ff5468', !c.seatbelt);
    icon(604, 160, '(P)', '#ff5468', c.epb);
    icon(352, 208, '와이퍼', '#3ddcff', c.wiper > 0);
    icon(436, 208, '비상', '#ffcc33', c.hazard && blink);

    // 시험 정보
    const st = this.exam.getStatus();
    g.textAlign = 'left';
    g.font = `700 24px ${FONT}`;
    g.fillStyle = '#9fb0d6';
    let info = '자유 주행';
    if (st.mode === 'exam') info = `시험 ${st.score}점`;
    else if (st.mode === 'practice') info = '연습 주행';
    else if (st.mode === 'drill') info = '기기조작 연습';
    g.fillText(info, 530, 238);
    if (st.section) { g.fillStyle = '#e8eefc'; g.fillText(st.section, 640, 238); }
    this.clusterTex.needsUpdate = true;
  }

  // ───────── 센터 터치스크린
  drawScreen() {
    const g = this.screenCanvas.getContext('2d');
    const W = SCREEN_W, H = SCREEN_H;
    const bg = g.createLinearGradient(0, 0, W, H);
    bg.addColorStop(0, '#0a1020');
    bg.addColorStop(1, '#121a33');
    g.fillStyle = bg;
    g.fillRect(0, 0, W, H);
    this.screenButtons = [];

    // 상단 바
    const st = this.exam.getStatus();
    g.fillStyle = 'rgba(255,255,255,0.05)';
    g.fillRect(0, 0, W, 64);
    g.fillStyle = '#3ddcff';
    g.font = `900 30px ${FONT}`;
    g.textAlign = 'left';
    g.textBaseline = 'middle';
    g.fillText('VR 운전면허 마스터', 28, 33);
    g.textAlign = 'right';
    g.fillStyle = '#e8eefc';
    let modeText = '대기';
    if (st.mode === 'exam') modeText = st.phase === 'result' ? '시험 종료' : `시험 중 · ${st.score}점`;
    else if (st.mode === 'practice') modeText = '연습 주행';
    else if (st.mode === 'drill') modeText = '기기조작 연습';
    g.fillText(modeText, W - 28, 33);

    const calib = this.app.input?.calib;
    if (calib && calib.active) return this.drawCalibPage(g, calib);
    if (st.phase === 'result' && st.result && this.page === 'home') return this.drawResultPage(g, st.result);

    if (this.page === 'home') this.drawHome(g, st);
    else if (this.page === 'jump') this.drawJump(g);
    else if (this.page === 'settings') this.drawSettings(g);
  }

  btn(g, id, label, x, y, w, h, opts = {}) {
    const { primary = false, on = null, small = false, action } = opts;
    const pressed = this.pressedId === id;
    const hover = this.hoverUV && this.hitTest(this.hoverUV, [{ id, x, y, w, h }]);
    g.fillStyle = primary ? '#3ddcff' : on ? 'rgba(62,224,143,0.25)' : 'rgba(255,255,255,0.08)';
    if (pressed) g.fillStyle = '#7b61ff';
    roundRect(g, x, y, w, h, 18);
    g.fill();
    if (hover) { g.strokeStyle = '#ffffff'; g.lineWidth = 4; roundRect(g, x + 2, y + 2, w - 4, h - 4, 16); g.stroke(); }
    g.fillStyle = primary ? '#061128' : '#eef3ff';
    g.font = `900 ${small ? 28 : 34}px ${FONT}`;
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    const lines = label.split('\n');
    lines.forEach((l, i) => g.fillText(l, x + w / 2, y + h / 2 + (i - (lines.length - 1) / 2) * (small ? 32 : 38)));
    this.screenButtons.push({ id, x, y, w, h, action });
  }

  drawHome(g, st) {
    const bw = 300, bh = 120, gap = 22, x0 = (SCREEN_W - (bw * 3 + gap * 2)) / 2, y0 = 92;
    const A = this.app.actions;
    this.btn(g, 'exam', '장내기능시험\n시작', x0, y0, bw, bh, { primary: true, action: () => A.startExam() });
    this.btn(g, 'practice', '연습 주행', x0 + bw + gap, y0, bw, bh, { action: () => A.startPractice() });
    this.btn(g, 'drill', '기기조작 연습', x0 + (bw + gap) * 2, y0, bw, bh, { action: () => A.startDrill() });
    this.btn(g, 'jump', '구간 이동', x0, y0 + bh + gap, bw, bh, { action: () => { this.page = 'jump'; } });
    this.btn(g, 'recenter', '시점 재설정', x0 + bw + gap, y0 + bh + gap, bw, bh, { action: () => A.recenter() });
    this.btn(g, 'settings', '설정 · 발 보정', x0 + (bw + gap) * 2, y0 + bh + gap, bw, bh, { action: () => { this.page = 'settings'; } });

    // 현재 안내
    g.fillStyle = 'rgba(255,255,255,0.05)';
    roundRect(g, x0, 372, SCREEN_W - x0 * 2, 200, 18); g.fill();
    g.textAlign = 'left';
    g.textBaseline = 'top';
    g.fillStyle = '#9fb0d6';
    g.font = `700 26px ${FONT}`;
    g.fillText(st.section ? `현재 구간: ${st.section}${st.timer ? ' · ' + st.timer : ''}` : '안내', x0 + 22, 388);
    g.fillStyle = '#eef3ff';
    g.font = `700 32px ${FONT}`;
    const lines = wrapText(g, st.instruction || '시작할 모드를 선택하세요. 컨트롤러로 화면을 직접 누르거나, P단에서 화면을 가리키고 트리거를 당기세요.', SCREEN_W - x0 * 2 - 44);
    lines.slice(0, 4).forEach((l, i) => g.fillText(l, x0 + 22, 428 + i * 38));
  }

  drawJump(g) {
    const A = this.app.actions;
    const jumps = this.app.course.jumps;
    const bw = 300, bh = 110, gap = 22, x0 = (SCREEN_W - (bw * 3 + gap * 2)) / 2, y0 = 92;
    jumps.forEach((j, i) => {
      const col = i % 3, row = Math.floor(i / 3);
      this.btn(g, `jump${i}`, j.name, x0 + col * (bw + gap), y0 + row * (bh + gap), bw, bh, { action: () => { A.jump(i); this.page = 'home'; } });
    });
    this.btn(g, 'back', '← 뒤로', x0, 470, bw, 100, { action: () => { this.page = 'home'; } });
  }

  drawSettings(g) {
    const A = this.app.actions;
    const S = this.app.settings;
    const x0 = 42, bw = 300, bh = 96, gap = 18;
    const footLabel = { off: '끔', right: '오른쪽 컨트롤러', left: '왼쪽 컨트롤러' }[S.footMode];
    this.btn(g, 'voice', `음성 안내\n${S.voice ? '켬' : '끔'}`, x0, 86, bw, bh, { on: S.voice, small: true, action: () => A.setSetting('voice', !S.voice) });
    this.btn(g, 'guide', `주행 궤적 가이드\n${S.guide ? '켬' : '끔'}`, x0 + bw + gap, 86, bw, bh, { on: S.guide, small: true, action: () => A.setSetting('guide', !S.guide) });
    this.btn(g, 'rearcam', `후방 카메라\n${S.rearCam ? '켬' : '끔'}`, x0 + (bw + gap) * 2, 86, bw, bh, { on: S.rearCam, small: true, action: () => A.setSetting('rearCam', !S.rearCam) });
    this.btn(g, 'foot', `발 컨트롤러 모드\n${footLabel}`, x0, 86 + bh + gap, bw, bh, {
      on: S.footMode !== 'off', small: true,
      action: () => A.setSetting('footMode', S.footMode === 'off' ? 'right' : S.footMode === 'right' ? 'left' : 'off'),
    });
    this.btn(g, 'footcal', '발 보정 시작', x0 + bw + gap, 86 + bh + gap, bw, bh, { primary: S.footMode !== 'off', small: true, action: () => A.startFootCalib() });
    this.btn(g, 'padcal', '페달·핸들 보정', x0 + (bw + gap) * 2, 86 + bh + gap, bw, bh, { small: true, action: () => A.startPadCalib() });
    this.btn(g, 'seatF', '좌석 앞으로', x0, 86 + (bh + gap) * 2, bw, bh, { small: true, action: () => A.seat(-0.03) });
    this.btn(g, 'seatB', '좌석 뒤로', x0 + bw + gap, 86 + (bh + gap) * 2, bw, bh, { small: true, action: () => A.seat(0.03) });
    this.btn(g, 'mirrors', `디지털 미러\n${S.mirrors ? '켬' : '끔 (성능↑)'}`, x0 + (bw + gap) * 2, 86 + (bh + gap) * 2, bw, bh, { on: S.mirrors, small: true, action: () => A.setSetting('mirrors', !S.mirrors) });
    this.btn(g, 'back', '← 뒤로', x0, 86 + (bh + gap) * 3 + 8, bw, 92, { action: () => { this.page = 'home'; } });
    g.fillStyle = '#9fb0d6';
    g.font = `700 24px ${FONT}`;
    g.textAlign = 'left';
    g.textBaseline = 'middle';
    g.fillText('발 컨트롤러: 컨트롤러를 발등에 묶고 뒤꿈치를 축으로 페달을 밟아요', x0 + bw + gap, 86 + (bh + gap) * 3 + 54);
  }

  drawCalibPage(g, cal) {
    const x0 = 42;
    g.textAlign = 'left';
    g.textBaseline = 'top';
    g.fillStyle = '#3ddcff';
    g.font = `900 34px ${FONT}`;
    g.fillText(`${cal.title} (${cal.stepIndex + 1}/${cal.stepCount})`, x0, 90);
    g.fillStyle = '#eef3ff';
    g.font = `700 36px ${FONT}`;
    wrapText(g, cal.prompt, SCREEN_W - x0 * 2).slice(0, 4).forEach((l, i) => g.fillText(l, x0, 146 + i * 44));
    if (cal.error) {
      g.fillStyle = '#ff8090';
      g.font = `700 28px ${FONT}`;
      g.fillText(cal.error, x0, 330);
    }
    // 실시간 값
    if (cal.meters) {
      cal.meters.forEach((m, i) => {
        const y = 372 + i * 34;
        g.fillStyle = '#9fb0d6';
        g.font = `700 22px ${FONT}`;
        g.fillText(m.label, x0, y);
        g.fillStyle = 'rgba(255,255,255,0.1)';
        roundRect(g, x0 + 150, y + 2, 500, 18, 9); g.fill();
        g.fillStyle = '#3ddcff';
        roundRect(g, x0 + 150, y + 2, Math.max(18, 500 * clamp(m.value, 0, 1)), 18, 9); g.fill();
      });
    }
    const y = 480;
    if (cal.canCapture) this.btn(g, 'cal-capture', cal.captureLabel || '측정', x0, y, 300, 96, { primary: true, action: () => cal.capture() });
    if (cal.canSkip) this.btn(g, 'cal-skip', '건너뛰기', x0 + 320, y, 260, 96, { action: () => cal.skip() });
    this.btn(g, 'cal-cancel', cal.done ? '완료' : '취소', SCREEN_W - x0 - 240, y, 240, 96, { action: () => cal.cancel() });
  }

  drawResultPage(g, r) {
    const A = this.app.actions;
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    g.fillStyle = r.pass ? '#3ee08f' : '#ff5468';
    g.font = `900 72px ${FONT}`;
    g.fillText(r.pass ? '합격!' : '불합격', SCREEN_W / 2, 130);
    g.fillStyle = '#eef3ff';
    g.font = `900 46px ${FONT}`;
    g.fillText(`${r.score}점`, SCREEN_W / 2, 200);
    g.font = `700 26px ${FONT}`;
    g.fillStyle = '#9fb0d6';
    if (r.reason) g.fillText(r.reason, SCREEN_W / 2, 248);
    g.textAlign = 'left';
    const list = r.penalties.slice(-4);
    list.forEach((p, i) => {
      g.fillStyle = p.dq ? '#ff5468' : '#ffcc33';
      g.fillText(p.dq ? '실격' : `-${p.pts}`, 120, 296 + i * 36);
      g.fillStyle = '#eef3ff';
      g.fillText(p.reason, 210, 296 + i * 36);
    });
    if (!list.length) { g.fillStyle = '#eef3ff'; g.fillText('감점 없이 완벽한 주행이었어요!', 120, 300); }
    this.btn(g, 'again', '다시 시험', 120, 470, 360, 100, { primary: true, action: () => A.startExam() });
    this.btn(g, 'topractice', '연습 주행', SCREEN_W - 480, 470, 360, 100, { action: () => A.startPractice() });
  }

  hitTest(uv, list = this.screenButtons) {
    const x = uv.x * SCREEN_W, y = (1 - uv.y) * SCREEN_H;
    return list.find((b) => x >= b.x && x <= b.x + b.w && y >= b.y && y <= b.y + b.h) || null;
  }

  screenClick(uv) {
    if (this.rearView.visible) return false;
    const b = this.hitTest(uv);
    if (!b) return false;
    this.pressedId = b.id;
    this.pressedT = 0.18;
    this.app.audio.chime('button');
    if (b.action) b.action();
    this.drawScreen();
    this.screenTex.needsUpdate = true;
    return true;
  }

  // ───────── HUD
  showFlash(text, color = '#ff5468', dur = 2.4) {
    this.flash = { text, color, t: dur };
  }

  drawHud() {
    const st = this.exam.getStatus();
    const c = this.car;
    const key = [st.instruction, st.hint, st.score, st.section, st.timer, Math.round(c.kmh), c.gear, this.flash?.text, this.flash ? Math.ceil(this.flash.t * 4) : 0, st.mode].join('|');
    if (key === this.lastHud) return;
    this.lastHud = key;
    const g = this.hudCanvas.getContext('2d');
    const W = 1024, H = 300;
    g.clearRect(0, 0, W, H);
    g.fillStyle = 'rgba(4,10,24,0.55)';
    roundRect(g, 0, 0, W, H, 30); g.fill();

    g.textBaseline = 'middle';
    g.textAlign = 'left';
    g.font = `900 34px ${FONT}`;
    g.fillStyle = st.mode === 'exam' ? '#ffcc33' : '#3ddcff';
    const tag = st.mode === 'exam' ? `시험 ${st.score}점` : st.mode === 'practice' ? '연습' : st.mode === 'drill' ? '기기조작 연습' : '대기';
    g.fillText(tag, 30, 40);
    g.fillStyle = '#c9d6f2';
    g.font = `700 30px ${FONT}`;
    g.fillText(`${st.section || ''}${st.timer ? '  ⏱ ' + st.timer : ''}`, 260, 40);
    g.textAlign = 'right';
    g.font = `900 40px ${FONT}`;
    g.fillStyle = '#ffffff';
    g.fillText(`${Math.round(c.kmh)} km/h  ${c.gear}`, W - 30, 40);

    g.textAlign = 'left';
    g.fillStyle = '#ffffff';
    g.font = `900 44px ${FONT}`;
    const lines = wrapText(g, st.instruction || '', W - 60);
    lines.slice(0, 2).forEach((l, i) => g.fillText(l, 30, 116 + i * 54));
    g.fillStyle = '#9fd8ff';
    g.font = `700 30px ${FONT}`;
    const hl = wrapText(g, st.hint || '', W - 60);
    hl.slice(0, 2).forEach((l, i) => g.fillText(l, 30, 222 + i * 36));

    if (this.flash) {
      g.fillStyle = this.flash.color;
      roundRect(g, 140, 70, W - 280, 110, 24); g.fill();
      g.fillStyle = '#fff';
      g.textAlign = 'center';
      g.font = `900 52px ${FONT}`;
      g.fillText(this.flash.text, W / 2, 126, W - 320);
    }
    this.hudTex.needsUpdate = true;
  }

  // ───────── 버튼(물리 버튼) 상태 표시
  updateButtons() {
    const c = this.car;
    const B = this.model.interior.buttons;
    const set = (id, color) => {
      if (this.buttonStates[id] === color) return;
      this.buttonStates[id] = color;
      B[id].mat.color.setHex(color);
    };
    const dim = 0x8a8f99, full = 0xffffff;
    for (const gr of ['P', 'R', 'N', 'D']) set(`gear${gr}`, c.gear === gr ? (gr === 'R' ? 0xff7a88 : 0x7fe9ff) : dim);
    set('epb', c.epb ? 0xff6070 : dim);
    set('belt', c.seatbelt ? 0x7dffb0 : full);
    set('power', c.power ? 0x7fe9ff : full);
    set('hazard', c.hazard && c.blinkOn ? 0xffffff : 0x9a8a8a);
    set('lights', c.lights > 0 ? 0x7dffb0 : dim);
    set('high', c.lights === 2 ? 0x7fb8ff : dim);
    set('wiper', c.wiper > 0 ? 0x7fe9ff : dim);
    set('horn', dim);
  }

  pressButtonVisual(id) {
    const b = this.model.interior.buttons[id];
    if (!b) return;
    b.mesh.position.copy(b.base).addScaledVector(b.normal, -0.005);
    clearTimeout(b.timer);
    b.timer = setTimeout(() => { b.mesh.position.copy(b.base); }, 150);
  }

  // 월드 좌표의 손끝이 버튼/화면에 닿았는지
  pokeTest(worldPt) {
    const B = this.model.interior.buttons;
    const tmp = new THREE.Vector3();
    for (const id in B) {
      const b = B[id];
      tmp.copy(worldPt);
      b.mesh.worldToLocal(tmp);
      if (Math.abs(tmp.x) < b.half.x + 0.008 && Math.abs(tmp.y) < b.half.y + 0.008 && tmp.z > -0.02 && tmp.z < 0.03) {
        return { kind: 'button', id };
      }
    }
    const scr = this.model.interior.center;
    tmp.copy(worldPt);
    scr.worldToLocal(tmp);
    if (Math.abs(tmp.x) < 0.17 && Math.abs(tmp.y) < 0.1 && tmp.z > -0.015 && tmp.z < 0.02) {
      return { kind: 'screen', uv: new THREE.Vector2(tmp.x / 0.34 + 0.5, tmp.y / 0.2 + 0.5) };
    }
    return null;
  }

  interactiveObjects() {
    const B = this.model.interior.buttons;
    return [...Object.values(B).map((b) => b.mesh), this.model.interior.center];
  }

  idForObject(obj) {
    const B = this.model.interior.buttons;
    for (const id in B) if (B[id].mesh === obj) return id;
    return obj === this.model.interior.center ? 'screen' : null;
  }

  // ───────── 디지털 미러 렌더링 (XR 중에도 안전하게)
  renderMirrors(renderer, scene, xrActive) {
    const S = this.app.settings;
    const cams = this.model.cams;
    const showRear = S.rearCam && this.car.gear === 'R' && this.car.power;
    this.rearView.visible = showRear;
    if (!S.mirrors && !showRear) return;

    const prevTarget = renderer.getRenderTarget();
    const prevXr = renderer.xr.enabled;
    renderer.xr.enabled = false;
    const f = this.mirrorFrame++;
    if (S.mirrors) {
      const which = xrActive ? [['left', 'right', 'rearMirror'][f % 3]] : (f % 2 ? ['left', 'right'] : ['rearMirror', 'left']);
      for (const k of which) {
        renderer.setRenderTarget(this.mirrorRTs[k]);
        renderer.render(scene, cams[k]);
      }
    }
    if (showRear && f % 2 === 0) {
      renderer.setRenderTarget(this.rearRT);
      renderer.render(scene, cams.rear);
    }
    renderer.xr.enabled = prevXr;
    renderer.setRenderTarget(prevTarget);
  }

  update(dt, xrActive) {
    if (this.pressedT > 0) {
      this.pressedT -= dt;
      if (this.pressedT <= 0) this.pressedId = null;
    }
    if (this.flash) {
      this.flash.t -= dt;
      if (this.flash.t <= 0) this.flash = null;
    }
    this.lastDraw += dt;
    if (this.lastDraw > 1 / 12) {
      this.lastDraw = 0;
      this.drawCluster();
      this.drawScreen();
      this.screenTex.needsUpdate = true;
    }
    this.hud.visible = xrActive || this.app.settings.desktopHud;
    if (this.hud.visible) this.drawHud();
    this.updateButtons();
  }
}
