// 차 안 화면: 계기판(속도·자율주행·도착 예정), 센터 화면(내비 지도·다음 안내·진행률·메뉴), 디지털 미러
import * as THREE from 'three';
import { makeCanvas, canvasTexture, roundRect, FONT } from '../util.js';
import { MIRROR_LAYER } from './terrain.js';

const SW = 1024, SH = 600;

export function fmtDur(sec) {
  sec = Math.max(0, Math.round(sec));
  const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60);
  return h ? `${h}시간 ${String(m).padStart(2, '0')}분` : `${m}분`;
}
// 한국 시간으로 표시
export function fmtClock(d) {
  const k = new Date(d.getTime() + 9 * 3600e3);
  return `${String(k.getUTCHours()).padStart(2, '0')}:${String(k.getUTCMinutes()).padStart(2, '0')}`;
}

export class TripCockpit {
  constructor({ model, app }) {
    this.model = model;
    this.app = app;
    const it = model.interior;
    this.clusterCanvas = makeCanvas(768, 272);
    this.clusterTex = canvasTexture(this.clusterCanvas);
    it.cluster.material = new THREE.MeshBasicMaterial({ map: this.clusterTex, toneMapped: false });
    this.screenCanvas = makeCanvas(SW, SH);
    this.screenTex = canvasTexture(this.screenCanvas);
    it.center.material = new THREE.MeshBasicMaterial({ map: this.screenTex, toneMapped: false });
    this.buttons = [];
    this.page = 'nav';
    this.hoverUV = null;
    this.pressed = null;
    this.pressedT = 0;
    this.drawT = 0;
    this.flash = null;
    // 디지털 미러
    this.mirrorRTs = {
      left: new THREE.WebGLRenderTarget(288, 180),
      right: new THREE.WebGLRenderTarget(288, 180),
      rearMirror: new THREE.WebGLRenderTarget(384, 100),
    };
    it.mirrorL.material = new THREE.MeshBasicMaterial({ map: this.mirrorRTs.left.texture });
    it.mirrorR.material = new THREE.MeshBasicMaterial({ map: this.mirrorRTs.right.texture });
    it.rearMirror.material = new THREE.MeshBasicMaterial({ map: this.mirrorRTs.rearMirror.texture });
    for (const k of ['left', 'right', 'rearMirror']) {
      const cam = model.cams[k];
      cam.layers.set(MIRROR_LAYER);
      cam.far = 1500;
      cam.updateProjectionMatrix();
    }
    this.mirrorFrame = 0;
    this.mapCache = null;
  }

  showFlash(text, color = '#2a6fd6', dur = 2.5) { this.flash = { text, color, t: dur }; }

  // ───────── 계기판
  drawCluster(st) {
    const c = this.clusterCanvas, g = c.getContext('2d');
    const W = c.width, H = c.height;
    g.fillStyle = '#05070b'; g.fillRect(0, 0, W, H);
    const grd = g.createLinearGradient(0, 0, W, 0);
    grd.addColorStop(0, 'rgba(61,220,255,0.10)'); grd.addColorStop(0.5, 'rgba(61,220,255,0.02)'); grd.addColorStop(1, 'rgba(61,220,255,0.10)');
    g.fillStyle = grd; g.fillRect(0, 0, W, H);
    g.textAlign = 'center'; g.textBaseline = 'middle';
    g.fillStyle = '#ffffff'; g.font = `900 120px ${FONT}`; g.fillText(String(Math.round(st.kmh)), W / 2, 118);
    g.fillStyle = '#8aa0b8'; g.font = `700 28px ${FONT}`; g.fillText('km/h', W / 2, 196);
    // 자율주행
    g.fillStyle = st.paused ? '#ffcc33' : '#3ddcff';
    g.font = `800 26px ${FONT}`;
    g.fillText(st.paused ? '일시정지' : (st.warp > 1 ? `자율주행 ×${st.warp}` : '자율주행 중'), W / 2, 240);
    // 왼쪽: 남은 거리, 오른쪽: 도착 예정
    g.textAlign = 'left'; g.fillStyle = '#8aa0b8'; g.font = `700 24px ${FONT}`; g.fillText('남은 거리', 40, 70);
    g.fillStyle = '#fff'; g.font = `900 46px ${FONT}`; g.fillText(`${(st.remainKm).toFixed(st.remainKm < 10 ? 1 : 0)} km`, 40, 118);
    g.fillStyle = '#8aa0b8'; g.font = `700 24px ${FONT}`; g.fillText(st.destName + ' 도착', 40, 176);
    g.fillStyle = '#fff'; g.font = `900 40px ${FONT}`; g.fillText(st.eta, 40, 218);
    g.textAlign = 'right'; g.fillStyle = '#8aa0b8'; g.font = `700 24px ${FONT}`; g.fillText('제한속도', W - 40, 70);
    // 제한속도 원
    g.save(); g.translate(W - 90, 128);
    g.fillStyle = '#fff'; g.beginPath(); g.arc(0, 0, 40, 0, Math.PI * 2); g.fill();
    g.strokeStyle = '#d11f2d'; g.lineWidth = 9; g.beginPath(); g.arc(0, 0, 35, 0, Math.PI * 2); g.stroke();
    g.fillStyle = '#111'; g.textAlign = 'center'; g.font = `900 30px ${FONT}`; g.fillText(String(st.limit), 0, 2);
    g.restore();
    g.textAlign = 'right'; g.fillStyle = '#8aa0b8'; g.font = `700 24px ${FONT}`; g.fillText(st.clock, W - 40, 218);
    // 방향지시등
    if (st.blink) {
      g.fillStyle = '#39e27d';
      const y = 40;
      const tri = (x, d) => { g.beginPath(); g.moveTo(x, y); g.lineTo(x + d * 26, y - 18); g.lineTo(x + d * 26, y + 18); g.closePath(); g.fill(); };
      if (st.turn < 0) tri(W / 2 - 150, 1);
      if (st.turn > 0) tri(W / 2 + 150, -1);
    }
    // D
    g.fillStyle = '#3ddcff'; g.textAlign = 'center'; g.font = `900 30px ${FONT}`; g.fillText('D', W / 2 + 110, 196);
    this.clusterTex.needsUpdate = true;
  }

  // ───────── 센터 화면
  btn(g, id, label, x, y, w, h, opts = {}) {
    const hover = this.hoverId === id, down = this.pressed === id;
    g.fillStyle = opts.on ? 'rgba(61,220,255,0.9)' : down ? 'rgba(255,255,255,0.3)' : hover ? 'rgba(255,255,255,0.18)' : 'rgba(255,255,255,0.08)';
    roundRect(g, x, y, w, h, 14); g.fill();
    g.strokeStyle = opts.on ? 'transparent' : 'rgba(255,255,255,0.18)'; g.lineWidth = 2; roundRect(g, x, y, w, h, 14); g.stroke();
    g.fillStyle = opts.on ? '#06121e' : '#eaf2ff';
    g.font = `800 ${opts.size || 26}px ${FONT}`; g.textAlign = 'center'; g.textBaseline = 'middle';
    const lines = label.split('\n');
    lines.forEach((l, i) => g.fillText(l, x + w / 2, y + h / 2 + (i - (lines.length - 1) / 2) * (opts.size || 26) * 1.15));
    this.buttons.push({ id, x, y, w, h });
  }

  drawScreen(st) {
    const c = this.screenCanvas, g = c.getContext('2d');
    this.buttons = [];
    g.fillStyle = '#0a0f17'; g.fillRect(0, 0, SW, SH);
    if (this.page === 'menu') this.drawMenu(g, st);
    else this.drawNav(g, st);
    if (this.flash) {
      g.fillStyle = this.flash.color; roundRect(g, 160, 250, 704, 100, 20); g.fill();
      g.fillStyle = '#fff'; g.font = `900 34px ${FONT}`; g.textAlign = 'center'; g.textBaseline = 'middle';
      g.fillText(this.flash.text, 512, 300, 660);
    }
    if (this.hoverUV) {
      g.fillStyle = 'rgba(61,220,255,0.9)';
      g.beginPath(); g.arc(this.hoverUV.x * SW, (1 - this.hoverUV.y) * SH, 9, 0, Math.PI * 2); g.fill();
    }
    this.screenTex.needsUpdate = true;
  }

  drawNav(g, st) {
    // 윗줄: 지금 위치, 시각
    g.fillStyle = '#131b27'; g.fillRect(0, 0, SW, 64);
    g.fillStyle = '#eaf2ff'; g.font = `800 28px ${FONT}`; g.textAlign = 'left'; g.textBaseline = 'middle';
    g.fillText(`📍 ${st.place}`, 22, 33, 640);
    g.textAlign = 'right'; g.fillStyle = '#9fb3c8'; g.font = `700 26px ${FONT}`;
    g.fillText(`${st.clock}  ·  경부고속도로`, SW - 22, 33);
    // 지도
    this.drawMap(g, 16, 76, 560, 420, st);
    // 오른쪽: 다음 안내
    const x0 = 592;
    g.textAlign = 'left';
    g.fillStyle = '#9fb3c8'; g.font = `700 22px ${FONT}`; g.fillText('다음 안내', x0, 96);
    st.upcoming.slice(0, 5).forEach((u, i) => {
      const y = 132 + i * 66;
      g.fillStyle = 'rgba(255,255,255,0.06)'; roundRect(g, x0, y - 26, 416, 56, 12); g.fill();
      g.fillStyle = u.color; g.font = `900 22px ${FONT}`; g.fillText(u.icon, x0 + 14, y + 2);
      g.fillStyle = '#eaf2ff'; g.font = `800 25px ${FONT}`; g.fillText(u.name, x0 + 52, y + 2, 250);
      g.textAlign = 'right'; g.fillStyle = '#3ddcff'; g.font = `900 25px ${FONT}`; g.fillText(u.dist, x0 + 402, y + 2);
      g.textAlign = 'left';
    });
    // 진행 막대
    const py = 512;
    g.fillStyle = '#9fb3c8'; g.font = `800 22px ${FONT}`; g.textAlign = 'left'; g.fillText(st.fromName, 22, py);
    g.textAlign = 'right'; g.fillText(st.destName, SW - 22, py);
    const bx = 90, bw = SW - 180;
    g.fillStyle = 'rgba(255,255,255,0.12)'; roundRect(g, bx, py - 7, bw, 14, 7); g.fill();
    g.fillStyle = '#3ddcff'; roundRect(g, bx, py - 7, Math.max(14, bw * st.progress), 14, 7); g.fill();
    g.fillStyle = '#fff'; g.beginPath(); g.arc(bx + bw * st.progress, py, 11, 0, Math.PI * 2); g.fill();
    // 아래 버튼
    const by = 540, bh = 50;
    this.btn(g, 'warpDown', '◀ 느리게', 16, by, 170, bh, { size: 24 });
    this.btn(g, 'pause', st.paused ? '▶ 계속' : '❚❚ 멈춤', 196, by, 150, bh, { size: 24, on: st.paused });
    this.btn(g, 'warpUp', `빠르게 ▶  ×${st.warp}`, 356, by, 220, bh, { size: 24, on: st.warp > 1 });
    this.btn(g, 'view', '시점', 586, by, 120, bh, { size: 24 });
    this.btn(g, 'recenter', '정면 맞춤', 716, by, 150, bh, { size: 22 });
    this.btn(g, 'menu', '메뉴', 876, by, 132, bh, { size: 24 });
  }

  drawMap(g, x, y, w, h, st) {
    g.save();
    g.beginPath(); roundRect(g, x, y, w, h, 16); g.clip();
    g.fillStyle = '#0f1a14'; g.fillRect(x, y, w, h);
    const R = st.route, s = st.s;
    const cx = x + w / 2, cy = y + h * 0.68;
    const scale = h / 5200; // 화면 높이 ≈ 5.2 km
    const hx = st.heading.x, hz = st.heading.z; // 진행 방향 = 화면 위
    const P = (px, pz) => {
      const dx = px - st.pos.x, dz = pz - st.pos.z;
      // 화면 오른쪽 = 진행 방향 오른쪽
      const right = dx * -hz + dz * hx;
      const fwd = dx * hx + dz * hz;
      return [cx + right * scale, cy - fwd * scale];
    };
    // 격자
    g.strokeStyle = 'rgba(255,255,255,0.04)'; g.lineWidth = 1;
    for (let k = -6; k <= 6; k++) { g.beginPath(); g.moveTo(x + w / 2 + k * 60, y); g.lineTo(x + w / 2 + k * 60, y + h); g.stroke(); }
    // 반대 방향 + 램프
    const drawRoute = (rt, color, width, i0, i1, step = 3) => {
      g.strokeStyle = color; g.lineWidth = width; g.lineCap = 'round'; g.lineJoin = 'round';
      g.beginPath();
      let first = true;
      for (let i = Math.max(0, i0); i <= Math.min(rt.n - 1, i1); i += step) {
        const [px, py] = P(rt.xyz[i * 3], rt.xyz[i * 3 + 1]);
        if (first) { g.moveTo(px, py); first = false; } else g.lineTo(px, py);
      }
      g.stroke();
    };
    const i = R.idx(s)[0];
    for (const rp of st.ramps) {
      if (Math.abs(rp.s - s) > 4000) continue;
      g.strokeStyle = '#3a4a5a'; g.lineWidth = 5; g.beginPath();
      for (let k = 0; k < rp.n; k += 2) { const [px, py] = P(rp.pts[k * 3], rp.pts[k * 3 + 1]); k ? g.lineTo(px, py) : g.moveTo(px, py); }
      g.stroke();
    }
    drawRoute(R, '#2b3a4c', 16, i - 300, i + 600);
    drawRoute(R, '#3f8cff', 9, i, i + 600);
    drawRoute(R, '#5a6676', 9, i - 300, i);
    // 터널
    for (const [a, b] of st.tunnels) {
      if (b < s - 3000 || a > s + 6000) continue;
      drawRoute(R, '#ffb020', 9, Math.floor(a / R.spacing), Math.ceil(b / R.spacing), 1);
    }
    // 도시 이름
    g.font = `800 20px ${FONT}`; g.textAlign = 'center'; g.fillStyle = '#c9d6e2';
    for (const ct of st.cities) {
      if (Math.abs(ct.s - s) > 6000) continue;
      const k = Math.floor(ct.s / R.spacing);
      const [px, py] = P(R.xyz[k * 3], R.xyz[k * 3 + 1]);
      g.fillText(ct.name, px + 46, py);
    }
    // 내 차
    g.fillStyle = '#ffffff';
    g.beginPath(); g.moveTo(cx, cy - 18); g.lineTo(cx + 12, cy + 12); g.lineTo(cx, cy + 5); g.lineTo(cx - 12, cy + 12); g.closePath(); g.fill();
    // 축척
    g.fillStyle = '#9fb3c8'; g.font = `700 18px ${FONT}`; g.textAlign = 'left'; g.fillText('1 km', x + 14, y + h - 16);
    g.fillRect(x + 64, y + h - 18, 1000 * scale, 4);
    g.restore();
  }

  drawMenu(g, st) {
    g.fillStyle = '#eaf2ff'; g.font = `900 34px ${FONT}`; g.textAlign = 'left'; g.textBaseline = 'middle';
    g.fillText('메뉴', 28, 44);
    this.btn(g, 'back', '← 내비로', 820, 18, 186, 52, { size: 24 });
    const S = this.app.settings;
    const row = (y, label, items) => {
      g.fillStyle = '#9fb3c8'; g.font = `700 22px ${FONT}`; g.textAlign = 'left'; g.fillText(label, 28, y + 26);
      const w = (SW - 220 - 16 - (items.length - 1) * 10) / items.length;
      items.forEach(([id, text, on], k) => this.btn(g, id, text, 220 + k * (w + 10), y, w, 52, { size: 22, on }));
    };
    row(96, '방향', [['dirSB', '서울 → 부산', S.dir === 'SB'], ['dirNB', '부산 → 서울', S.dir === 'NB']]);
    row(160, '좌석', [['seatpassenger', '조수석', S.seat === 'passenger'], ['seatdriver', '운전석', S.seat === 'driver'], ['seatrear', '뒷좌석', S.seat === 'rear']]);
    row(224, '이동', [['jumpBack', '−10분', false], ['jumpFwd', '+10분', false], ['jumpRest', '다음 휴게소', false], ['restart', '처음부터', false]]);
    row(288, '빠르기', [['warp1', '×1 실제', st.warp === 1], ['warp5', '×5', st.warp === 5], ['warp20', '×20', st.warp === 20], ['warp60', '×60', st.warp === 60]]);
    row(352, '화질', [['qlow', '가볍게', S.quality === 'low'], ['qmid', '보통', S.quality === 'mid'], ['qhigh', '고화질', S.quality === 'high']]);
    row(416, '소리', [['voice', S.voice ? '음성 안내 켬' : '음성 안내 끔', S.voice], ['sfx', S.sfx ? '주행 소리 켬' : '주행 소리 끔', S.sfx], ['mirrors', S.mirrors ? '디지털 미러 켬' : '디지털 미러 끔', S.mirrors]]);
    row(480, '날씨·멀미', [['hazeclear', '맑음', S.haze === 'clear'], ['hazenormal', '보통', S.haze === 'normal'], ['hazehazy', '뿌연 날', S.haze === 'hazy'], ['comfort', '멀미 방지', !!S.comfort]]);
    this.btn(g, 'exitVR', st.xr ? 'VR 나가기' : '시작 화면', 220, 544, 260, 48, { size: 22 });
    g.fillStyle = '#6f8296'; g.font = `600 17px ${FONT}`; g.textAlign = 'left';
    g.fillText(st.credit, 500, 568, 510);
  }

  hitTest(uv) {
    const x = uv.x * SW, y = (1 - uv.y) * SH;
    return this.buttons.find((b) => x >= b.x && x <= b.x + b.w && y >= b.y && y <= b.y + b.h) || null;
  }

  click(uv) {
    const b = this.hitTest(uv);
    if (!b) return null;
    this.pressed = b.id;
    this.pressedT = 0.25;
    return b.id;
  }

  update(dt, st) {
    if (this.pressedT > 0 && (this.pressedT -= dt) <= 0) this.pressed = null;
    if (this.flash && (this.flash.t -= dt) <= 0) this.flash = null;
    this.hoverId = this.hoverUV ? this.hitTest(this.hoverUV)?.id : null;
    this.drawT -= dt;
    if (this.drawT <= 0) {
      this.drawT = 0.2;
      this.drawCluster(st);
      this.drawScreen(st);
    }
  }

  renderMirrors(renderer, scene, enabled) {
    if (!enabled) return;
    // 두 프레임에 한 번, 거울 하나씩 (각 거울은 6프레임마다 갱신 → 72fps에서 약 12회/초)
    if ((this.mirrorTick = (this.mirrorTick || 0) + 1) % 2) return;
    const prevTarget = renderer.getRenderTarget();
    const prevXr = renderer.xr.enabled;
    renderer.xr.enabled = false;
    const k = ['left', 'right', 'rearMirror'][this.mirrorFrame++ % 3];
    renderer.setRenderTarget(this.mirrorRTs[k]);
    renderer.render(scene, this.model.cams[k]);
    renderer.xr.enabled = prevXr;
    renderer.setRenderTarget(prevTarget);
  }
}
