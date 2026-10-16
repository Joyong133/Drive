// 주행 소리(합성): 타이어 소음·바람·터널 울림·교량 이음매 덜컹·옆 차 지나가는 소리·깜빡이, 한국어 음성 안내
export class TripAudio {
  constructor() {
    this.ctx = null;
    this.sfx = true;
    this.voice = true;
    this.koVoice = null;
    if ('speechSynthesis' in window) {
      const pick = () => { this.koVoice = speechSynthesis.getVoices().find((v) => v.lang?.toLowerCase().startsWith('ko')) || null; };
      pick();
      speechSynthesis.addEventListener?.('voiceschanged', pick);
    }
  }

  unlock() {
    if (this.ctx) { if (this.ctx.state === 'suspended') this.ctx.resume(); return; }
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return;
    const ctx = (this.ctx = new AC());
    this.master = ctx.createGain();
    this.master.gain.value = 0.9;
    this.master.connect(ctx.destination);
    // 갈색 잡음 (타이어·바람)
    const mk = (len, alpha) => {
      const b = ctx.createBuffer(2, ctx.sampleRate * len, ctx.sampleRate);
      for (let ch = 0; ch < 2; ch++) {
        const d = b.getChannelData(ch);
        let last = 0;
        for (let i = 0; i < d.length; i++) { last = last * alpha + (Math.random() * 2 - 1) * (1 - alpha); d[i] = last * 3.5; }
      }
      return b;
    };
    this.brown = mk(4, 0.985);
    this.white = mk(2, 0.2);
    const loop = (buf, filterType, freq, q = 0.7) => {
      const src = ctx.createBufferSource();
      src.buffer = buf; src.loop = true;
      const f = ctx.createBiquadFilter(); f.type = filterType; f.frequency.value = freq; f.Q.value = q;
      const g = ctx.createGain(); g.gain.value = 0;
      src.connect(f).connect(g).connect(this.master);
      src.start();
      return { f, g };
    };
    this.road = loop(this.brown, 'lowpass', 420);
    this.tire = loop(this.white, 'bandpass', 900, 0.6);
    this.wind = loop(this.white, 'bandpass', 1800, 0.4);
    // 전기차 모터 휘잉
    this.motor = ctx.createOscillator();
    this.motor.type = 'sine';
    this.motorG = ctx.createGain(); this.motorG.gain.value = 0;
    this.motor.connect(this.motorG).connect(this.master);
    this.motor.start();
    this.blinkT = 0;
  }

  thump(vol = 0.25) {
    // 교량 이음매 '덜컹'
    if (!this.ctx || !this.sfx) return;
    const ctx = this.ctx, t = ctx.currentTime;
    for (const [dt, v] of [[0, 1], [0.11, 0.7]]) {
      const o = ctx.createOscillator(); o.type = 'sine'; o.frequency.setValueAtTime(70, t + dt); o.frequency.exponentialRampToValueAtTime(38, t + dt + 0.12);
      const g = ctx.createGain(); g.gain.setValueAtTime(0, t + dt); g.gain.linearRampToValueAtTime(vol * v, t + dt + 0.01); g.gain.exponentialRampToValueAtTime(0.001, t + dt + 0.18);
      o.connect(g).connect(this.master); o.start(t + dt); o.stop(t + dt + 0.25);
    }
  }

  whoosh(big, side = 1, rel = 10) {
    if (!this.ctx || !this.sfx) return;
    const ctx = this.ctx, t = ctx.currentTime;
    const src = ctx.createBufferSource(); src.buffer = this.brown;
    const f = ctx.createBiquadFilter(); f.type = 'bandpass'; f.frequency.value = big ? 300 : 700; f.Q.value = 0.5;
    const pan = ctx.createStereoPanner ? ctx.createStereoPanner() : null;
    const g = ctx.createGain();
    const dur = big ? 1.4 : 0.8;
    const v = Math.min(0.5, (big ? 0.4 : 0.22) * (0.5 + rel / 25));
    g.gain.setValueAtTime(0.0001, t); g.gain.exponentialRampToValueAtTime(v, t + dur * 0.45); g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    let node = src.connect(f).connect(g);
    if (pan) { pan.pan.setValueAtTime(side * 0.7, t); pan.pan.linearRampToValueAtTime(side * 0.2, t + dur); node = node.connect(pan); }
    node.connect(this.master);
    src.start(t, Math.random() * 2); src.stop(t + dur + 0.05);
  }

  tick() {
    if (!this.ctx || !this.sfx) return;
    const ctx = this.ctx, t = ctx.currentTime;
    const o = ctx.createOscillator(); o.type = 'square'; o.frequency.value = 2200;
    const g = ctx.createGain(); g.gain.setValueAtTime(0.03, t); g.gain.exponentialRampToValueAtTime(0.0001, t + 0.03);
    o.connect(g).connect(this.master); o.start(t); o.stop(t + 0.05);
  }

  chime() {
    if (!this.ctx || !this.sfx) return;
    const ctx = this.ctx, t = ctx.currentTime;
    [880, 1318].forEach((fq, k) => {
      const o = ctx.createOscillator(); o.type = 'sine'; o.frequency.value = fq;
      const g = ctx.createGain(); g.gain.setValueAtTime(0.0001, t + k * 0.16); g.gain.exponentialRampToValueAtTime(0.08, t + k * 0.16 + 0.02); g.gain.exponentialRampToValueAtTime(0.0001, t + k * 0.16 + 0.6);
      o.connect(g).connect(this.master); o.start(t + k * 0.16); o.stop(t + k * 0.16 + 0.7);
    });
  }

  // v: m/s, tunnel 0..1, bridge: 교량 위
  update(dt, { v, tunnel, bridge, warp, paused }) {
    if (!this.ctx) return;
    const t = this.ctx.currentTime;
    const on = this.sfx && !paused ? 1 : 0;
    const k = Math.min(v / 30, 1.3);
    const tun = 1 + tunnel * 0.9;
    const quiet = warp > 5 ? 0.35 : 1; // 빠르게 감기 중엔 작게
    this.road.g.gain.setTargetAtTime(on * quiet * (0.05 + 0.2 * k) * tun * (bridge ? 1.15 : 1), t, 0.3);
    this.road.f.frequency.setTargetAtTime(220 + 380 * k + tunnel * 120, t, 0.3);
    this.tire.g.gain.setTargetAtTime(on * quiet * 0.035 * k * k * tun, t, 0.3);
    this.wind.g.gain.setTargetAtTime(on * quiet * 0.04 * k * k * k, t, 0.3);
    this.motor.frequency.setTargetAtTime(120 + v * 11, t, 0.2);
    this.motorG.gain.setTargetAtTime(on * quiet * 0.006 * Math.min(v / 10, 1), t, 0.3);
  }

  blinker(on, dt) {
    if (!on) { this.blinkT = 0; return; }
    this.blinkT -= dt;
    if (this.blinkT <= 0) { this.blinkT = 0.38; this.tick(); }
  }

  speak(text) {
    if (!this.voice || !text || !('speechSynthesis' in window)) return;
    try {
      speechSynthesis.cancel();
      const u = new SpeechSynthesisUtterance(text);
      u.lang = 'ko-KR';
      if (this.koVoice) u.voice = this.koVoice;
      u.rate = 1.02;
      speechSynthesis.speak(u);
    } catch { /* 음성 미지원 */ }
  }
}
