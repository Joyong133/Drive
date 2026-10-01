// 화면 조작 버튼: 키보드나 VR 컨트롤러 없이 터치/마우스로 운전 (휴대폰·태블릿·PC)
import { approach } from './util.js';

// [동작 이름, 표시 글자]
const BUTTONS = [
  ['power', 'START'], ['belt', '벨트'], ['epb', 'EPB'], ['hazard', '비상등'], ['menu', '메뉴'],
  ['gearP', 'P'], ['gearR', 'R'], ['gearN', 'N'], ['gearD', 'D'], ['view', '시점'],
  ['turnL', '◀ 깜빡'], ['turnR', '깜빡 ▶'], ['lights', '전조등'], ['high', '상향'], ['wiper', '와이퍼'],
];

const WHEEL_SVG = `
<svg viewBox="-100 -100 200 200" aria-hidden="true">
  <circle r="86" fill="none" stroke="currentColor" stroke-width="16" />
  <circle r="26" fill="currentColor" opacity="0.85" />
  <rect x="-80" y="-7" width="54" height="14" rx="6" fill="currentColor" opacity="0.85" />
  <rect x="26" y="-7" width="54" height="14" rx="6" fill="currentColor" opacity="0.85" />
  <rect x="-7" y="22" width="14" height="58" rx="6" fill="currentColor" opacity="0.85" />
  <rect x="-6" y="-100" width="12" height="20" rx="3" class="tp-mark" />
</svg>`;

export class TouchPad {
  constructor(app) {
    this.app = app;
    this.visible = false;
    this.throttle = 0;
    this.brake = 0;
    this.accelDown = false;
    this.brakeDown = false;
    this.wheelHeld = false;
    this.wheelDelta = 0;
    this.prevPhi = 0;

    const el = document.createElement('section');
    el.id = 'touch-pad';
    el.className = 'hidden';
    el.innerHTML = `
      <div class="tp-wheel" id="tp-wheel" role="slider" aria-label="핸들: 돌려서 조향">${WHEEL_SVG}<span>돌려서 조향</span></div>
      <div class="tp-buttons">${BUTTONS.map(([a, t]) => `<button type="button" class="tp-btn" data-tp="${a}">${t}</button>`).join('')}</div>
      <div class="tp-pedals">
        <div class="tp-pedal brake" id="tp-brake" role="button" aria-label="브레이크">브레이크</div>
        <div class="tp-pedal accel" id="tp-accel" role="button" aria-label="가속 페달">가속</div>
      </div>`;
    document.body.appendChild(el);
    this.el = el;
    this.wheelEl = el.querySelector('#tp-wheel');
    this.wheelSvg = this.wheelEl.querySelector('svg');
    this.btns = {};
    el.querySelectorAll('[data-tp]').forEach((b) => {
      this.btns[b.dataset.tp] = b;
      b.addEventListener('click', () => {
        app.audio.unlock();
        app.doAction(b.dataset.tp, 'touch');
      });
    });

    this.hold(el.querySelector('#tp-brake'), 'brakeDown');
    this.hold(el.querySelector('#tp-accel'), 'accelDown');
    this.setupWheel();
  }

  // 누르고 있는 동안 페달을 밟음 (여러 손가락 동시 가능)
  hold(target, key) {
    target.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      target.setPointerCapture?.(e.pointerId);
      this[key] = true;
      target.classList.add('down');
      this.app.audio.unlock();
    });
    const up = () => { this[key] = false; target.classList.remove('down'); };
    target.addEventListener('pointerup', up);
    target.addEventListener('pointercancel', up);
    target.addEventListener('lostpointercapture', up);
    target.addEventListener('contextmenu', (e) => e.preventDefault());
  }

  setupWheel() {
    const w = this.wheelEl;
    const angleOf = (e) => {
      const r = w.getBoundingClientRect();
      const dx = e.clientX - (r.left + r.width / 2);
      const dy = e.clientY - (r.top + r.height / 2);
      return { phi: Math.atan2(dy, dx), dist: Math.hypot(dx, dy) };
    };
    w.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      w.setPointerCapture?.(e.pointerId);
      this.wheelHeld = true;
      this.prevPhi = angleOf(e).phi;
      w.classList.add('down');
    });
    w.addEventListener('pointermove', (e) => {
      if (!this.wheelHeld) return;
      const { phi, dist } = angleOf(e);
      if (dist < 14) return; // 가운데는 각도가 불안정
      let d = phi - this.prevPhi;
      while (d > Math.PI) d -= Math.PI * 2;
      while (d < -Math.PI) d += Math.PI * 2;
      this.prevPhi = phi;
      this.wheelDelta += d; // 화면에서 시계방향 = 오른쪽
    });
    const up = () => { this.wheelHeld = false; w.classList.remove('down'); };
    w.addEventListener('pointerup', up);
    w.addEventListener('pointercancel', up);
    w.addEventListener('lostpointercapture', up);
  }

  shouldShow() {
    const app = this.app;
    if (!app.started || app.renderer.xr.isPresenting) return false;
    const mode = app.settings.touchPad;
    if (mode === 'on') return true;
    if (mode === 'off') return false;
    return window.matchMedia?.('(pointer: coarse)').matches || false;
  }

  // 입력 계산 전에 호출: 페달 값 서서히 올리기/내리기
  tick(dt) {
    const show = this.shouldShow();
    if (show !== this.visible) {
      this.visible = show;
      this.el.classList.toggle('hidden', !show);
      document.body.classList.toggle('touch-on', show);
      if (!show) { this.accelDown = this.brakeDown = this.wheelHeld = false; }
    }
    this.throttle = this.accelDown ? approach(this.throttle, 0.7, dt * 1.0) : approach(this.throttle, 0, dt * 4);
    this.brake = this.brakeDown ? approach(this.brake, 1, dt * 5) : approach(this.brake, 0, dt * 6);
  }

  // 화면 표시 갱신 (핸들 각도, 버튼 켜짐 상태)
  render() {
    if (!this.visible) return;
    const c = this.app.car;
    this.wheelSvg.style.transform = `rotate(${(c.wheelAngle * 180) / Math.PI}deg)`;
    const on = (id, v) => this.btns[id]?.classList.toggle('on', !!v);
    for (const g of ['P', 'R', 'N', 'D']) on(`gear${g}`, c.gear === g);
    on('power', c.power);
    on('belt', c.seatbelt);
    on('epb', c.epb);
    on('hazard', c.hazard && c.blinkOn);
    on('turnL', c.blinkOn && (c.turn < 0 || c.hazard));
    on('turnR', c.blinkOn && (c.turn > 0 || c.hazard));
    on('lights', c.lights > 0);
    on('high', c.lights === 2);
    on('wiper', c.wiper > 0);
  }
}
