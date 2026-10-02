// PC 화면용 메뉴·HUD·설정·보정 화면 (VR 안에서는 차량 화면과 HUD를 사용)
import { RULES, DQ_RULES, PASS_SCORE } from './exam.js';
import { ROAD_RULES, ROAD_DQ, ROAD_PASS } from './roadtest.js';

const $ = (s) => document.querySelector(s);

export class UI {
  constructor(app) {
    this.app = app;
    this.modalKind = null;
    this.modalTimer = null;

    $('#btn-desktop').addEventListener('click', () => app.startDesktop(this.pickedMode()));
    $('#btn-vr').addEventListener('click', () => app.enterVR(this.pickedMode()));

    document.addEventListener('click', (e) => {
      const open = e.target.closest('[data-open]');
      if (open) { this.open(open.dataset.open); return; }
      const act = e.target.closest('[data-action]');
      if (act) this.onAction(act.dataset.action, act);
    });
    $('#modal').addEventListener('click', (e) => { if (e.target.id === 'modal') this.closeModal(); });
    $('#pause-menu').addEventListener('click', (e) => { if (e.target.id === 'pause-menu') this.toggleMenu(false); });
    this.deviceTimer = setInterval(() => this.updateDeviceLine(), 700);
    // 화면 조작 버튼 켜고 끄기 (키보드가 없거나 마우스로만 운전할 때)
    $('#tp-toggle').addEventListener('click', () => {
      const on = app.touchpad?.visible;
      app.actions.setSetting('touchPad', on ? 'off' : 'on');
      this.toast(on ? '화면 조작 버튼을 숨겼어요' : '화면 조작 버튼을 켰어요', 'info');
      document.activeElement?.blur?.();
    });
  }

  pickedMode() {
    const r = document.querySelector('input[name=mode]:checked');
    return r ? r.value : 'practice';
  }

  setVRAvailable(ok, msg) {
    const b = $('#btn-vr');
    b.disabled = !ok;
    b.textContent = ok ? 'VR로 시작' : 'VR 사용 불가';
    $('#vr-status').textContent = msg || '';
  }

  hideStart() {
    $('#start-screen').classList.add('hidden');
    $('#hud').classList.remove('hidden');
  }

  onAction(a) {
    const A = this.app.actions;
    switch (a) {
      case 'resume': this.toggleMenu(false); break;
      case 'exam': this.toggleMenu(false); this.closeModal(); A.startExam(); break;
      case 'practice': this.toggleMenu(false); this.closeModal(); A.startPractice(); break;
      case 'drill': this.toggleMenu(false); this.closeModal(); A.startDrill(); break;
      case 'road': this.toggleMenu(false); this.closeModal(); A.startRoad(false); break;
      case 'roadPractice': this.toggleMenu(false); this.closeModal(); A.startRoad(true); break;
      case 'close-modal': this.closeModal(); break;
      case 'pad-calib': A.startPadCalib(); this.renderModal(); break;
      case 'pad-reset': A.setSetting('padMap', null); this.renderModal(); break;
      case 'cal-capture': this.app.input.calib?.capture(); this.renderModal(); break;
      case 'cal-skip': this.app.input.calib?.skip(); this.renderModal(); break;
      case 'cal-cancel': this.app.input.calib?.cancel(); this.renderModal(); break;
      default:
        if (a.startsWith('jump-')) {
          this.closeModal();
          this.toggleMenu(false);
          A.jump(Number(a.slice(5)));
        }
    }
  }

  toggleMenu(force) {
    if (!this.app.started) return;
    const el = $('#pause-menu');
    const show = force ?? el.classList.contains('hidden');
    if (show && this.modalKind) { this.closeModal(); return; }
    el.classList.toggle('hidden', !show);
    this.app.paused = show || !!this.modalKind;
    if (!show) document.activeElement?.blur?.();
  }

  open(kind) {
    this.modalKind = kind;
    $('#pause-menu').classList.add('hidden');
    $('#modal').classList.remove('hidden');
    if (this.app.started) this.app.paused = true;
    this.renderModal();
    clearInterval(this.modalTimer);
    if (kind === 'pedals') this.modalTimer = setInterval(() => this.renderPedalsLive(), 100);
  }

  closeModal() {
    this.modalKind = null;
    clearInterval(this.modalTimer);
    $('#modal').classList.add('hidden');
    this.app.paused = !$('#pause-menu').classList.contains('hidden');
    document.activeElement?.blur?.();
  }

  renderModal() {
    this._padKey = null;
    const body = $('#modal-body');
    const k = this.modalKind;
    if (k === 'help') body.innerHTML = this.helpHTML();
    else if (k === 'rules') body.innerHTML = this.rulesHTML();
    else if (k === 'settings') { body.innerHTML = this.settingsHTML(); this.bindSettings(); }
    else if (k === 'pedals') { body.innerHTML = this.pedalsHTML(); this.bindSettings(); this.renderPedalsLive(); }
    else if (k === 'jump') body.innerHTML = this.jumpHTML();
    else if (k === 'result') body.innerHTML = this.resultHTML(this.lastResult);
  }

  helpHTML() {
    const row = (k, d) => `<tr><td>${k}</td><td>${d}</td></tr>`;
    return `
      <h2>조작법</h2>
      <h3>시동 거는 법 (먼저 읽어 주세요)</h3>
      <table>
        ${row('키보드', '<kbd>B</kbd>(안전벨트) → <kbd>↓</kbd>를 누른 채 <kbd>Enter</kbd> → <kbd>D</kbd> → <kbd>↑</kbd>')}
        ${row('VR 컨트롤러', '빨간 [안전벨트] 버튼을 손끝으로 → 왼손 트리거(브레이크)를 당긴 채 오른손 스틱 누르기 → 오른손 스틱을 뒤로 당겨 D → 오른손 트리거')}
        ${row('게임패드', '십자키 ←(안전벨트) → LT(브레이크)를 당긴 채 A → 십자키 ↓로 D → RT')}
        ${row('화면 버튼', '[벨트] → [START] → [D] → [가속]을 길게 누르기')}
      </table>
      <p class="note"><b>간편 조작</b>이 켜져 있으면(기본값) 브레이크를 안 밟아도 START·변속 때 자동으로 브레이크를 밟아 줘요. 실제처럼 연습하려면 [설정]에서 끄세요.</p>
      <h3>화면 조작 버튼 (휴대폰·태블릿·마우스)</h3>
      <p class="note">터치 화면에서는 자동으로 나타나요. PC에서는 오른쪽 아래 <b>[화면 버튼]</b>으로 켜고 끕니다. 왼쪽 아래 핸들을 손가락으로 돌리고, 오른쪽 아래 [브레이크]·[가속]을 누르고 있으면 밟혀요(길게 누를수록 깊게).</p>
      <h3>키보드 (PC)</h3>
      <table>
        ${row('<kbd>↑</kbd> / <kbd>Shift</kbd>+<kbd>↑</kbd>', '가속 페달 (천천히 / 깊게)')}
        ${row('<kbd>↓</kbd>', '브레이크')}
        ${row('<kbd>←</kbd> <kbd>→</kbd>', '핸들 (손을 떼면 주행 중 가운데로 복귀)')}
        ${row('<kbd>P</kbd> <kbd>R</kbd> <kbd>N</kbd> <kbd>D</kbd>', '기어 변경 (P에서 바꿀 땐 브레이크를 밟은 채로)')}
        ${row('<kbd>Enter</kbd>', '시동 (브레이크를 밟은 채)')}
        ${row('<kbd>B</kbd>', '안전벨트')}
        ${row('<kbd>Space</kbd>', '전자식 주차 브레이크(EPB)')}
        ${row('<kbd>Q</kbd> / <kbd>E</kbd>', '왼쪽 / 오른쪽 방향지시등')}
        ${row('<kbd>F</kbd>', '비상등')}
        ${row('<kbd>L</kbd> / <kbd>K</kbd>', '전조등(하향) / 상향등')}
        ${row('<kbd>W</kbd>', '와이퍼')}
        ${row('<kbd>H</kbd>', '경적')}
        ${row('<kbd>V</kbd>', '시점 바꾸기 (운전석 → 3인칭 → 위에서)')}
        ${row('마우스 드래그', '고개 돌리기 (사이드미러 확인) · 화면/버튼 클릭 가능')}
        ${row('<kbd>Esc</kbd>', '메뉴')}
      </table>
      <h3>VR 컨트롤러 (Meta Quest 등)</h3>
      <table>
        ${row('오른손 트리거', '가속 페달 (P단에서 화면을 가리키면 클릭)')}
        ${row('왼손 트리거', '브레이크')}
        ${row('그립(양손)', '핸들 테두리를 잡고 실제처럼 돌리기')}
        ${row('손끝으로 누르기', '기어 버튼·EPB·시동·비상등·안전벨트·화면 등 모든 버튼')}
        ${row('오른손 A / B', '오른쪽 방향지시등 / 와이퍼')}
        ${row('왼손 X / Y', '왼쪽 방향지시등 / 비상등')}
        ${row('오른손 스틱 앞/뒤', '기어 P쪽 / D쪽 (D→N→R→P)')}
        ${row('왼손 스틱 앞/뒤', '전조등 밝게 / 어둡게 · 좌우 = 핸들(잡지 않았을 때)')}
        ${row('오른손 스틱 누르기', '시동')}
        ${row('왼손 스틱 누르기', '주차 브레이크')}
      </table>
      <h3>발로 운전하기</h3>
      <table>
        ${row('레이싱 페달/휠', 'USB로 연결 → [발 페달 · 핸들 설정]에서 보정. 실제 페달처럼 밟기')}
        ${row('발에 묶은 VR 컨트롤러', '컨트롤러 하나를 발등에 묶고 [발 컨트롤러 모드] → 뒤꿈치를 축으로 왼쪽=브레이크, 오른쪽=가속, 발끝 누르기=밟기')}
        ${row('USB 발판 스위치', '↑/↓ 키를 보내도록 설정하면 키보드처럼 사용 (켜기/끄기만 가능)')}
      </table>`;
  }

  rulesHTML() {
    return `
      <h2>장내기능시험 채점 기준</h2>
      <p class="note">100점에서 시작해 실수할 때마다 감점되며, <b>${PASS_SCORE}점 이상</b>이면 합격입니다. 점수가 ${PASS_SCORE}점 아래로 떨어지는 순간 바로 불합격 처리됩니다.</p>
      <table>
        <tr><th>항목</th><th>감점 조건</th><th>감점</th></tr>
        ${RULES.map((r) => `<tr><td>${r.item}</td><td>${r.cond}</td><td class="pts">-${r.pts}</td></tr>`).join('')}
      </table>
      <h3>실격 (즉시 불합격)</h3>
      <table>${DQ_RULES.map((r) => `<tr><td class="dq">실격</td><td>${r}</td></tr>`).join('')}</table>
      <div class="callout">이 시뮬레이터는 도로교통공단 장내기능시험을 바탕으로 연습하기 쉽게 단순화했습니다. 실제 시험 코스·기준은 시험장과 시기에 따라 다를 수 있으니, 응시 전에 꼭 시험장 안내를 확인하세요.</div>
      <h3>코스 순서</h3>
      <p class="note">기기조작 → 출발 → 경사로(정지 후 출발) → 우회전 → 직각주차 → 우회전 → 좌회전 → 신호교차로 → 우회전 → 돌발 → 우회전 → 가속구간 → 종료</p>

      <h2 style="margin-top:28px">도로주행 시험 채점 기준</h2>
      <p class="note">실제 도로처럼 다른 차와 신호가 있는 도시를 내비게이션 안내대로 달립니다. 100점에서 감점되며 <b>${ROAD_PASS}점 이상</b>이고 실격이 없으면 합격입니다.</p>
      <table>
        <tr><th>항목</th><th>감점 조건</th><th>감점</th></tr>
        ${ROAD_RULES.map((r) => `<tr><td>${r.item}</td><td>${r.cond}</td><td class="pts">-${r.pts}</td></tr>`).join('')}
      </table>
      <h3>실격 (즉시 불합격)</h3>
      <table>${ROAD_DQ.map((r) => `<tr><td class="dq">실격</td><td>${r}</td></tr>`).join('')}</table>
      <h3>도로주행 경로</h3>
      <p class="note">출발(정차 구역에서 왼쪽 깜빡이) → 중앙대로 직진 → 1차로로 바꿔 좌회전 → 시청로 → 일시정지 후 좌회전 → 북부로 → 좌회전 → 학교길(어린이보호구역 30km/h, 횡단보도 일시정지) → 우회전 → 중앙대로 → 오른쪽 깜빡이 켜고 "도착" 구역에 정차 → P</p>`;
  }

  settingsHTML() {
    const S = this.app.settings;
    const toggle = (key, label, desc) => `
      <label class="setting"><span>${label}<small>${desc}</small></span>
      <input type="checkbox" data-setting="${key}" ${S[key] ? 'checked' : ''} /></label>`;
    return `
      <h2>설정</h2>
      <div class="settings-list">
        ${toggle('voice', '음성 안내', '시험 지시를 한국어 음성으로 읽어 줍니다')}
        ${toggle('sfx', '효과음', '모터·방향지시등·경고음')}
        ${toggle('guide', '주행 궤적 가이드', '연습 모드에서 바퀴가 지나갈 길을 바닥에 표시 (시험 모드에서는 꺼짐)')}
        ${toggle('rearCam', '후방 카메라', 'R단에서 센터 화면에 후방 영상 표시')}
        ${toggle('mirrors', '디지털 사이드미러', '끄면 VR 성능이 좋아집니다')}
        ${toggle('desktopHud', 'PC에서도 앞유리 HUD 보기', 'VR에서는 항상 표시')}
        ${toggle('easy', '간편 조작 (자동 브레이크)', '브레이크를 안 밟고 시동·변속해도 자동으로 브레이크를 밟아 줍니다. 끄면 실제 차처럼 엄격해져요')}
        <label class="setting"><span>화면 조작 버튼<small>핸들·페달·버튼을 화면에 표시 (키보드나 VR 컨트롤러가 없을 때)</small></span>
          <select data-setting="touchPad">
            <option value="auto" ${S.touchPad === 'auto' ? 'selected' : ''}>자동 (터치 화면이면 표시)</option>
            <option value="on" ${S.touchPad === 'on' ? 'selected' : ''}>항상 표시</option>
            <option value="off" ${S.touchPad === 'off' ? 'selected' : ''}>숨기기</option>
          </select></label>
        <label class="setting"><span>핸들 감도<small>깊게 꺾을 때 핸들을 얼마나 돌려야 하는지</small></span>
          <select data-setting="steerRange">
            <option value="quick" ${S.steerRange === 'quick' ? 'selected' : ''}>빠름 (끝까지 3/4바퀴)</option>
            <option value="normal" ${S.steerRange === 'normal' ? 'selected' : ''}>보통 (끝까지 1바퀴)</option>
            <option value="real" ${S.steerRange === 'real' ? 'selected' : ''}>실제 차 (끝까지 1.25바퀴)</option>
          </select></label>
        ${toggle('autoCenter', '핸들 자동 복귀', '주행 중 손을 떼면 핸들이 천천히 가운데로 돌아옵니다')}
        ${toggle('hillHold', '언덕 밀림 방지(HAC)', '실제 시험 연습에는 끄는 것을 추천')}
        <label class="setting"><span>그래픽 해상도<small>낮추면 부드러워집니다</small></span>
          <select data-setting="quality">
            <option value="low" ${S.quality === 'low' ? 'selected' : ''}>낮음</option>
            <option value="mid" ${S.quality === 'mid' ? 'selected' : ''}>보통</option>
            <option value="high" ${S.quality === 'high' ? 'selected' : ''}>높음</option>
          </select></label>
      </div>`;
  }

  pedalsHTML() {
    const S = this.app.settings;
    return `
      <h2>발 페달 · 핸들 설정</h2>
      <p class="note">네, 발로 운전할 수 있어요! 세 가지 방법 중 편한 것을 고르세요.</p>
      <h3>① 레이싱 페달 / 레이싱 휠 (가장 실감 나요)</h3>
      <p class="note">로지텍·스러스트마스터·파나텍 등 USB 페달과 휠을 PC에 연결하세요. 페달을 한 번 밟으면 아래에 장치가 나타납니다.
      VR로 쓰려면 PC VR(Quest Link/Air Link, SteamVR)로 PC의 Chrome/Edge에서 이 페이지를 여세요. Quest 단독 브라우저는 USB 페달을 지원하지 않을 수 있어요.</p>
      <div class="row">
        <button class="btn primary small" data-action="pad-calib">페달·핸들 보정 시작</button>
        <button class="btn small danger" data-action="pad-reset">보정 초기화</button>
      </div>
      <div id="pad-live"></div>
      <h3>② VR 컨트롤러를 발에 묶기 (추가 장비 없이!)</h3>
      <p class="note">컨트롤러 하나를 오른발 등에 벨크로/고무줄로 단단히 묶으세요. 실제 운전처럼 <b>뒤꿈치를 바닥에 대고 축으로 삼아</b>
      발끝을 왼쪽으로 돌리면 브레이크, 오른쪽이면 가속 페달이 되고, 발끝을 누르는 만큼 밟힙니다. 다른 손 컨트롤러로 핸들을 잡으세요.
      VR 안에서 센터 화면의 <b>[설정 · 발 보정] → [발 보정 시작]</b>으로 보정합니다.</p>
      <label class="setting"><span>발 컨트롤러 모드<small>발에 묶은 컨트롤러를 고르세요</small></span>
        <select data-setting="footMode">
          <option value="off" ${S.footMode === 'off' ? 'selected' : ''}>끔</option>
          <option value="right" ${S.footMode === 'right' ? 'selected' : ''}>오른쪽 컨트롤러를 발에</option>
          <option value="left" ${S.footMode === 'left' ? 'selected' : ''}>왼쪽 컨트롤러를 발에</option>
        </select></label>
      <p class="note">${S.footCal ? '✅ 발 보정 완료됨' : '아직 발 보정 전이에요.'}</p>
      <h3>③ USB 발판 스위치</h3>
      <p class="note">키보드 키를 보내는 발판 스위치(풋 스위치)를 ↑(가속), ↓(브레이크) 키로 설정하면 바로 쓸 수 있어요. 단, 세기 조절은 안 됩니다.</p>`;
  }

  renderPedalsLive() {
    const el = document.getElementById('pad-live');
    if (!el) return;
    const inp = this.app.input;
    const cal = inp.calib && inp.calib.kind === 'pad' ? inp.calib : null;
    const pv = inp.padValues;
    const meter = (label, v) => `<div>${label}<div class="meter"><i style="width:${Math.round(Math.max(0, Math.min(1, v)) * 100)}%"></i></div></div>`;
    const devices = inp.padNames.length ? inp.padNames.map((n) => `• ${n}`).join('<br>') : '연결된 장치 없음 (페달을 한 번 밟아 보세요)';
    let calHTML = '';
    if (cal) {
      calHTML = `<div class="calib-box">
        <div class="note">${cal.title} · ${cal.stepIndex + 1}/${cal.stepCount}</div>
        <div class="calib-step">${cal.prompt}</div>
        ${cal.error ? `<div class="note" style="color:var(--bad)">${cal.error}</div>` : ''}
        <div class="row">
          ${cal.canCapture ? '<button class="btn primary small" data-action="cal-capture">측정</button>' : ''}
          ${cal.canSkip ? '<button class="btn small" data-action="cal-skip">건너뛰기</button>' : ''}
          <button class="btn small" data-action="cal-cancel">${cal.done ? '완료' : '취소'}</button>
        </div></div>`;
    }
    const key = devices + (cal ? cal.stepIndex + cal.prompt + cal.error + cal.done : '');
    if (this._padKey !== key) {
      this._padKey = key;
      el.innerHTML = `<div class="note" style="margin-top:10px">${devices}</div>${calHTML}
        <div class="calib-meter" id="pad-meters"></div>
        <p class="note">${this.app.settings.padMap ? '✅ 보정된 매핑 사용 중' : '보정 전: 엑스박스 등 표준 게임패드는 RT=가속, LT=브레이크, 왼쪽 스틱=핸들로 바로 동작'}</p>`;
    }
    const m = document.getElementById('pad-meters');
    if (m) m.innerHTML = meter('가속', pv.throttle) + meter('브레이크', pv.brake) + meter('핸들', (pv.steer + 1) / 2);
  }

  bindSettings() {
    document.querySelectorAll('[data-setting]').forEach((el) => {
      el.addEventListener('change', () => {
        const key = el.dataset.setting;
        const v = el.type === 'checkbox' ? el.checked : el.value;
        this.app.actions.setSetting(key, v);
      });
    });
  }

  jumpHTML() {
    return `<h2>구간 이동 (연습 모드)</h2>
      <div class="menu-grid">${this.app.course.jumps.map((j, i) => `<button class="btn" data-action="jump-${i}">${j.name}</button>`).join('')}
      <button class="btn" data-action="drill">기기조작 연습</button></div>`;
  }

  resultHTML(r) {
    if (!r) return '';
    return `
      <h2>${r.kind === 'road' ? (r.practice ? '도로주행 연습 결과' : '도로주행 시험 결과') : '장내기능시험 결과'}</h2>
      <div class="result-score ${r.pass ? 'result-pass' : 'result-fail'}">${r.practice ? '연습 완료' : `${r.pass ? '합격' : '불합격'} · ${r.score}점`}</div>
      ${r.reason ? `<p class="note">${r.reason}</p>` : ''}
      <ul class="penalty-list">
        ${r.penalties.length ? r.penalties.map((p) => `<li class="${p.dq ? 'dq' : ''}"><b>${p.dq ? '실격' : '-' + p.pts}</b>${p.reason}</li>`).join('') : '<li><b>0</b>감점 없음 — 완벽해요!</li>'}
      </ul>
      <div class="row">
        ${r.kind === 'road'
          ? '<button class="btn primary" data-action="road">도로주행 다시 보기</button><button class="btn" data-action="roadPractice">도로주행 연습</button>'
          : '<button class="btn primary" data-action="exam">다시 시험 보기</button><button class="btn" data-action="practice">장내 연습</button>'}
      </div>`;
  }

  showResult(r) {
    this.lastResult = r;
    setTimeout(() => { if (!this.app.renderer.xr.isPresenting) this.open('result'); }, 1800);
  }

  // ───────── HUD
  setInstruction(t) { $('#hud-instruction').textContent = t || ''; }
  setHint(t) { $('#hud-hint').textContent = t || ''; }

  toast(text, kind = 'bad') {
    const el = document.createElement('div');
    el.className = `toast ${kind === 'ok' ? 'ok' : kind === 'info' ? 'info' : ''}`;
    el.textContent = text;
    const box = $('#toasts');
    box.appendChild(el);
    while (box.children.length > 3) box.firstChild.remove();
    setTimeout(() => el.remove(), 2700);
  }

  update() {
    const car = this.app.car;
    const st = this.app.exam.getStatus();
    $('#hud-kmh').textContent = Math.round(car.kmh);
    $('#hud-gear').textContent = car.gear;
    const tag = $('#hud-mode');
    tag.textContent = st.kind === 'road' ? (st.scoring ? '도로주행' : '도로 연습') : st.mode === 'exam' ? '시험' : st.mode === 'practice' ? '연습' : st.mode === 'drill' ? '기기조작' : '대기';
    tag.classList.toggle('exam', !!st.scoring);
    $('#hud-section').textContent = [st.section, st.limit ? `제한 ${st.limit}` : '', st.timer].filter(Boolean).join(' · ');
    $('#hud-score').textContent = st.scoring ? `${st.score}점` : '';
  }

  updateDeviceLine() {
    const inp = this.app.input;
    if (!inp) return;
    const el = $('#device-line');
    const names = inp.padNames;
    el.textContent = names.length ? `연결된 페달/핸들: ${names.join(', ')}` : '연결된 페달/핸들: 없음 (키보드 사용 · 페달을 연결했다면 한 번 밟아 주세요)';
    el.classList.toggle('on', names.length > 0);
  }
}
