// 효과음(Web Audio 합성) + 한국어 음성 안내(Speech Synthesis)
export class AudioSys {
  constructor() {
    this.ctx = null;
    this.voiceOn = true;
    this.sfxOn = true;
    this.koVoice = null;
    this.alarmTimer = null;
    this.reverseT = 0;
    this.beltT = 0;
    if ('speechSynthesis' in window) {
      const pick = () => {
        const voices = speechSynthesis.getVoices();
        this.koVoice = voices.find((v) => v.lang && v.lang.toLowerCase().startsWith('ko')) || null;
      };
      pick();
      speechSynthesis.addEventListener?.('voiceschanged', pick);
    }
  }

  unlock() {
    if (this.ctx) {
      if (this.ctx.state === 'suspended') this.ctx.resume();
      return;
    }
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return;
    const ctx = new AC();
    this.ctx = ctx;
    this.master = ctx.createGain();
    this.master.gain.value = 0.8;
    this.master.connect(ctx.destination);

    // 전기모터 소리
    this.motorGain = ctx.createGain();
    this.motorGain.gain.value = 0;
    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.value = 1400;
    this.motorGain.connect(lp).connect(this.master);
    this.osc1 = ctx.createOscillator();
    this.osc1.type = 'sine';
    this.osc2 = ctx.createOscillator();
    this.osc2.type = 'triangle';
    const g2 = ctx.createGain();
    g2.gain.value = 0.35;
    this.osc1.connect(this.motorGain);
    this.osc2.connect(g2).connect(this.motorGain);
    this.osc1.start();
    this.osc2.start();

    // 노면/바람 소음
    const len = ctx.sampleRate * 2;
    const buf = ctx.createBuffer(1, len, ctx.sampleRate);
    const data = buf.getChannelData(0);
    let last = 0;
    for (let i = 0; i < len; i++) {
      last = last * 0.97 + (Math.random() * 2 - 1) * 0.03;
      data[i] = last * 4;
    }
    this.noise = ctx.createBufferSource();
    this.noise.buffer = buf;
    this.noise.loop = true;
    const bp = ctx.createBiquadFilter();
    bp.type = 'lowpass';
    bp.frequency.value = 500;
    this.roadGain = ctx.createGain();
    this.roadGain.gain.value = 0;
    this.noise.connect(bp).connect(this.roadGain).connect(this.master);
    this.noise.start();

    // 경적
    this.hornGain = ctx.createGain();
    this.hornGain.gain.value = 0;
    const hlp = ctx.createBiquadFilter();
    hlp.type = 'lowpass';
    hlp.frequency.value = 1800;
    this.hornGain.connect(hlp).connect(this.master);
    for (const f of [415, 495]) {
      const o = ctx.createOscillator();
      o.type = 'square';
      o.frequency.value = f;
      o.connect(this.hornGain);
      o.start();
    }
  }

  tone(freq, dur, { type = 'sine', vol = 0.15, delay = 0, slide = 0 } = {}) {
    if (!this.ctx || !this.sfxOn) return;
    const t = this.ctx.currentTime + delay;
    const o = this.ctx.createOscillator();
    const g = this.ctx.createGain();
    o.type = type;
    o.frequency.setValueAtTime(freq, t);
    if (slide) o.frequency.linearRampToValueAtTime(freq + slide, t + dur);
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(vol, t + 0.008);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    o.connect(g).connect(this.master);
    o.start(t);
    o.stop(t + dur + 0.02);
  }

  tick(on) {
    // 방향지시등 똑딱
    this.tone(on ? 2200 : 1500, 0.025, { type: 'square', vol: 0.05 });
  }

  chime(kind) {
    switch (kind) {
      case 'ok': this.tone(880, 0.12, { vol: 0.12 }); this.tone(1320, 0.18, { vol: 0.12, delay: 0.1 }); break;
      case 'warn': this.tone(330, 0.25, { type: 'square', vol: 0.06 }); break;
      case 'penalty': this.tone(520, 0.18, { type: 'sawtooth', vol: 0.09 }); this.tone(330, 0.3, { type: 'sawtooth', vol: 0.09, delay: 0.16 }); break;
      case 'button': this.tone(1600, 0.03, { type: 'square', vol: 0.04 }); break;
      case 'shift': this.tone(1200, 0.05, { vol: 0.08 }); break;
      case 'power': this.tone(440, 0.25, { vol: 0.1, slide: 440 }); this.tone(1320, 0.3, { vol: 0.08, delay: 0.22 }); break;
      case 'off': this.tone(880, 0.3, { vol: 0.08, slide: -440 }); break;
      case 'belt': this.tone(1046, 0.12, { vol: 0.08 }); this.tone(784, 0.16, { vol: 0.08, delay: 0.12 }); break;
      case 'pass':
        [523, 659, 784, 1046].forEach((f, i) => this.tone(f, 0.3, { vol: 0.12, delay: i * 0.13 }));
        break;
      case 'fail':
        [392, 330, 262].forEach((f, i) => this.tone(f, 0.35, { type: 'triangle', vol: 0.14, delay: i * 0.2 }));
        break;
      case 'rumble': this.tone(60, 0.18, { type: 'sawtooth', vol: 0.12 }); break;
      default: break;
    }
  }

  alarm(on) {
    clearInterval(this.alarmTimer);
    this.alarmTimer = null;
    if (on && this.ctx) {
      let hi = false;
      const beep = () => { hi = !hi; this.tone(hi ? 1250 : 950, 0.22, { type: 'square', vol: 0.12 }); };
      beep();
      this.alarmTimer = setInterval(beep, 250);
    }
  }

  horn(on) {
    if (!this.ctx) return;
    this.hornGain.gain.setTargetAtTime(on && this.sfxOn ? 0.09 : 0, this.ctx.currentTime, 0.02);
  }

  update(car, dt) {
    if (!this.ctx) return;
    const t = this.ctx.currentTime;
    const sp = Math.abs(car.v);
    const on = car.power && this.sfxOn;
    this.osc1.frequency.setTargetAtTime(60 + sp * 14 + car.throttle * 30, t, 0.08);
    this.osc2.frequency.setTargetAtTime(180 + sp * 38, t, 0.08);
    this.motorGain.gain.setTargetAtTime(on ? 0.025 + car.throttle * 0.05 + Math.min(sp, 15) * 0.002 : 0, t, 0.1);
    this.roadGain.gain.setTargetAtTime(this.sfxOn ? Math.min(0.16, sp * 0.012) : 0, t, 0.15);

    // 후진 경고음
    if (car.power && car.gear === 'R') {
      this.reverseT -= dt;
      if (this.reverseT <= 0) { this.reverseT = 1.0; this.tone(1000, 0.18, { vol: 0.06 }); }
    } else {
      this.reverseT = 0;
    }
    // 안전벨트 경고
    if (car.power && !car.seatbelt && sp > 1.5) {
      this.beltT -= dt;
      if (this.beltT <= 0) { this.beltT = 1.2; this.tone(1175, 0.15, { vol: 0.07 }); this.tone(1175, 0.15, { vol: 0.07, delay: 0.3 }); }
    }
  }

  speak(text, interrupt = true) {
    if (!this.voiceOn || !text || !('speechSynthesis' in window)) return;
    try {
      if (interrupt) speechSynthesis.cancel();
      const u = new SpeechSynthesisUtterance(text);
      u.lang = 'ko-KR';
      if (this.koVoice) u.voice = this.koVoice;
      u.rate = 1.08;
      u.pitch = 1.0;
      speechSynthesis.speak(u);
    } catch {
      /* 음성 미지원 환경 */
    }
  }
}
