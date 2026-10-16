// 지형 스트리밍: 카메라 주변을 쿼드트리(LOD)로 나눠 가까운 곳은 촘촘하게, 먼 곳은 성기게.
// 메시는 워커(terrainWorker.js)가 만들고, 여기서는 고르기·요청·표시·정리만 함.
import * as THREE from 'three';
import { tileBounds, worldToTile } from './geo.js';

export const MIRROR_LAYER = 2;

export const IMAGERY = {
  esri: {
    label: 'Esri 위성사진 (기본)',
    url: 'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}',
    maxZ: 18,
    credit: '위성사진: Esri, Maxar, Earthstar Geographics',
  },
  vworld: {
    label: 'VWorld 항공사진 (국토부, 키 필요)',
    url: 'https://api.vworld.kr/req/wmts/1.0.0/{key}/Satellite/{z}/{y}/{x}.jpeg',
    maxZ: 19,
    credit: '항공사진: 국토교통부 VWorld',
    needsKey: true,
  },
  none: { label: '사진 없이 (색으로만, 가장 가벼움)', url: null, maxZ: 0, credit: '' },
};
// 주소에 ?tiles=https://…/{z}/{x}/{y}.jpg 를 붙이면 다른 위성사진 서버를 쓸 수 있음
try {
  const custom = new URLSearchParams(location.search).get('tiles');
  if (custom) IMAGERY.custom = { label: '사용자 지정 사진', url: custom, maxZ: Number(new URLSearchParams(location.search).get('tilesMaxZ') || 18), credit: '사용자 지정 위성사진' };
} catch { /* 워커 등 */ }

export const QUALITY = {
  low: { maxZ: 16, split: 1.15, radius: 40000, inflight: 6, trees: 0, treeR: 0 },
  mid: { maxZ: 17, split: 1.45, radius: 70000, inflight: 8, trees: 0.42, treeR: 300 },
  high: { maxZ: 18, split: 1.8, radius: 80000, inflight: 10, trees: 0.7, treeR: 520 },
};

const ROOT_Z = 9;

const VERT = /* glsl */`
  #include <common>
  #include <fog_pars_vertex>
  attribute vec3 tcol;
  uniform mat3 uvTx;
  varying vec2 vUv;
  varying vec3 vN;
  varying vec3 vCol;
  varying vec3 vWp;
  void main() {
    vUv = (uvTx * vec3(uv, 1.0)).xy;
    vN = normal;
    vCol = tcol;
    vWp = (modelMatrix * vec4(position, 1.0)).xyz;
    vec4 mvPosition = modelViewMatrix * vec4(position, 1.0);
    gl_Position = projectionMatrix * mvPosition;
    #include <fog_vertex>
  }
`;

const FRAG = /* glsl */`
  #include <common>
  #include <fog_pars_fragment>
  uniform sampler2D map;
  uniform float hasMap;
  uniform vec3 sunDir;
  uniform vec3 sunCol;
  uniform vec3 ambCol;
  uniform vec3 tint;
  uniform vec3 hlPos;
  uniform vec3 hlDir;
  uniform float hlI;
  varying vec2 vUv;
  varying vec3 vN;
  varying vec3 vCol;
  varying vec3 vWp;
  void main() {
    vec3 base = hasMap > 0.5 ? texture2D(map, vUv).rgb : pow(vCol, vec3(2.2));
    vec3 n = normalize(vN);
    // 사진에 이미 그림자가 들어 있으므로 해 방향 음영은 약하게만
    float l = max(dot(n, sunDir), 0.0);
    vec3 light = ambCol + sunCol * l;
    if (hlI > 0.001) {
      vec3 L = vWp - hlPos;
      float d = length(L);
      float cone = smoothstep(0.86, 0.97, dot(L / max(d, 0.01), hlDir));
      light += vec3(1.0, 0.93, 0.8) * hlI * cone * 90.0 / (d * d + 60.0);
    }
    vec3 c = base * tint * light;
    gl_FragColor = vec4(c, 1.0);
    #include <colorspace_fragment>
    #include <fog_fragment>
  }
`;

export class Terrain {
  constructor({ scene, renderer, routes, ramps, quality = 'mid', imagery = 'esri', vworldKey = '' }) {
    this.scene = scene;
    this.renderer = renderer;
    this.group = new THREE.Group();
    this.group.name = 'terrain';
    scene.add(this.group);
    this.nodes = new Map();
    this.pending = new Map(); // key → node (워커에 보냄)
    this.results = [];
    this.q = QUALITY[quality] || QUALITY.mid;
    this.anisotropy = Math.min(8, renderer.capabilities.getMaxAnisotropy());
    this.shared = {
      sunDir: { value: new THREE.Vector3(0.3, 0.8, 0.2).normalize() },
      sunCol: { value: new THREE.Color(0.35, 0.34, 0.32) },
      ambCol: { value: new THREE.Color(0.78, 0.8, 0.84) },
      tint: { value: new THREE.Color(1, 1, 1) },
      // 내 차 전조등 (밤): 월드 위치·방향·세기
      hlPos: { value: new THREE.Vector3() },
      hlDir: { value: new THREE.Vector3(0, 0, -1) },
      hlI: { value: 0 },
    };
    this.visibleCount = 0;
    this.stats = { built: 0, requested: 0, imageryFail: 0 };
    this.worker = new Worker(new URL('./terrainWorker.js', import.meta.url), { type: 'module' });
    this.worker.onmessage = (e) => this.onMessage(e.data);
    this.ready = new Promise((res) => { this._readyRes = res; });
    this.imageryKey = imagery;
    this.vworldKey = vworldKey;
    const routeMsg = Object.values(routes).map((r) => ({ name: r.name, n: r.n, spacing: r.spacing, buf: r.buffer.slice(0) }));
    const rampMsg = ramps.map((r) => ({ n: r.n, buf: r.pts.slice().buffer }));
    this.worker.postMessage({ type: 'init', routes: routeMsg, ramps: rampMsg, imagery: this.imageryConfig() });
    this.treeHandler = null;
    this.lastSelect = -1;
    this.splitScale = 1; // VR에서는 조금 낮춤 (두 눈 = 두 배 그리기)
  }

  imageryConfig() {
    const p = IMAGERY[this.imageryKey] || IMAGERY.esri;
    if (!p.url) return null;
    if (p.needsKey && !this.vworldKey) return { url: IMAGERY.esri.url, maxZ: IMAGERY.esri.maxZ };
    return { url: p.url.replace('{key}', encodeURIComponent(this.vworldKey)), maxZ: p.maxZ };
  }

  setImagery(key, vworldKey = this.vworldKey) {
    this.imageryKey = key;
    this.vworldKey = vworldKey;
    this.worker.postMessage({ type: 'imagery', imagery: this.imageryConfig() });
    this.clear();
  }

  setQuality(q) {
    this.q = QUALITY[q] || QUALITY.mid;
  }

  clear() {
    for (const n of this.nodes.values()) this.dispose(n);
    this.nodes.clear();
    this.pending.clear();
  }

  dispose(n) {
    if (n.mesh) {
      this.group.remove(n.mesh);
      n.mesh.geometry.dispose();
      n.mesh.material.uniforms.map.value?.dispose();
      n.mesh.material.dispose();
      n.mesh = null;
    }
    n.state = 'none';
  }

  node(z, x, y) {
    const key = `${z}/${x}/${y}`;
    let n = this.nodes.get(key);
    if (!n) {
      const b = tileBounds(z, x, y);
      n = { key, z, x, y, b, state: 'none', mesh: null, used: 0, minY: 0, maxY: 300 };
      this.nodes.set(key, n);
    }
    return n;
  }

  // 카메라에서 타일까지 거리
  dist(n, p) {
    const b = n.b;
    const dx = Math.max(b.x0 - p.x, 0, p.x - b.x1);
    const dz = Math.max(b.z0 - p.z, 0, p.z - b.z1);
    const dy = Math.max(n.minY - p.y, 0, p.y - n.maxY);
    return Math.sqrt(dx * dx + dz * dz + dy * dy);
  }

  request(n, pri) {
    if (n.state !== 'none') return;
    n.state = 'queued';
    n.pri = pri;
    this.pending.set(n.key, n);
  }

  // 매 프레임: 워커 결과를 조금씩 메시로 (한 번에 몰리면 끊김)
  // 0.2초마다: 보일 타일 고르기
  update(cam, now, lookahead = null) {
    let budget = 3;
    while (this.results.length && budget-- > 0) this.makeMesh(this.results.shift());
    if (now - this.lastSelect < 0.2 && this.lastSelect >= 0) return;
    this.lastSelect = now;
    this.frame = (this.frame || 0) + 1;
    const visible = [];
    const q = this.q;
    const t0 = worldToTile(cam.x - q.radius, cam.z - q.radius, ROOT_Z);
    const t1 = worldToTile(cam.x + q.radius, cam.z + q.radius, ROOT_Z);
    const visit = (n, p, collect) => {
      n.used = this.frame;
      const d = this.dist(n, p);
      // 우선순위: 타일 크기에 비해 가까운 것부터 (가까운 상세 타일이 먼 큰 타일보다 먼저)
      const pri = n.z * 0.15 + d / n.b.size;
      if (n.state === 'none') this.request(n, pri);
      else if (n.state === 'queued') n.pri = Math.min(n.pri, pri);
      const split = n.z < q.maxZ && d < n.b.size * q.split * this.splitScale;
      if (split && n.state === 'ready') {
        const kids = [];
        let ready = true;
        for (let i = 0; i < 4; i++) {
          const c = this.node(n.z + 1, n.x * 2 + (i & 1), n.y * 2 + (i >> 1));
          c.used = this.frame;
          if (c.state === 'none') {
            if (c.minY === 0 && c.maxY === 300) { c.minY = n.minY; c.maxY = n.maxY; }
            this.request(c, c.z * 0.15 + this.dist(c, p) / c.b.size);
          }
          if (c.state !== 'ready') ready = false;
          kids.push(c);
        }
        if (ready) { for (const c of kids) visit(c, p, collect); return; }
      }
      if (collect && n.state === 'ready') collect.push(n);
    };
    for (let tx = Math.floor(t0.tx); tx <= Math.floor(t1.tx); tx++) {
      for (let ty = Math.floor(t0.ty); ty <= Math.floor(t1.ty); ty++) visit(this.node(ROOT_Z, tx, ty), cam, visible);
    }
    // 앞으로 갈 곳 미리 받기 (표시는 안 함)
    if (lookahead) {
      const l0 = worldToTile(lookahead.x, lookahead.z, ROOT_Z);
      visit(this.node(ROOT_Z, Math.floor(l0.tx), Math.floor(l0.ty)), lookahead, null);
    }
    // 표시
    const show = new Set(visible);
    for (const n of this.nodes.values()) {
      if (n.mesh) n.mesh.visible = show.has(n);
    }
    this.visibleCount = visible.length;
    this.dispatch();
    this.evict(show);
  }

  dispatch() {
    // 오래 안 쓰인 대기 요청은 버림
    for (const [k, n] of this.pending) {
      if (n.state === 'queued' && this.frame - n.used > 10) { n.state = 'none'; this.pending.delete(k); }
    }
    const inflight = [...this.pending.values()].filter((n) => n.state === 'loading').length;
    let free = this.q.inflight - inflight;
    if (free <= 0) return;
    const list = [...this.pending.values()].filter((n) => n.state === 'queued').sort((a, b) => a.pri - b.pri);
    for (const n of list) {
      if (free-- <= 0) break;
      n.state = 'loading';
      this.stats.requested++;
      this.worker.postMessage({ type: 'tile', kind: 'tile', id: n.key, z: n.z, x: n.x, y: n.y, pri: n.pri });
    }
  }

  evict(show) {
    const max = 360;
    if (this.nodes.size <= max) return;
    const list = [...this.nodes.values()].filter((n) => !show.has(n) && n.state !== 'loading' && n.state !== 'queued')
      .sort((a, b) => a.used - b.used);
    for (const n of list) {
      if (this.nodes.size <= max * 0.85) break;
      this.dispose(n);
      this.nodes.delete(n.key);
    }
  }

  onMessage(m) {
    if (m.type === 'ready') { this._readyRes(); return; }
    if (m.type === 'imageryBlocked') { this.imageryBlocked = true; this.onImageryBlocked?.(); return; }
    if (m.type === 'trees' || (m.type === 'error' && m.kind === 'trees')) { this.treeHandler?.(m); return; }
    if (m.type === 'error') {
      console.warn('tile error', m.id, m.error);
      const n = this.nodes.get(m.id);
      if (n) { n.state = 'none'; this.pending.delete(m.id); }
      return;
    }
    if (m.type === 'tile') this.results.push(m);
  }

  makeMesh(m) {
    const n = this.nodes.get(m.id);
    this.pending.delete(m.id);
    if (!n || n.state !== 'loading') { m.img?.close?.(); return; }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(m.pos, 3));
    g.setAttribute('normal', new THREE.BufferAttribute(m.nor, 3, true));
    g.setAttribute('uv', new THREE.BufferAttribute(m.uv, 2));
    g.setAttribute('tcol', new THREE.BufferAttribute(m.col, 3, true));
    g.setIndex(new THREE.BufferAttribute(m.idx, 1));
    const size = n.b.size;
    g.boundingBox = new THREE.Box3(new THREE.Vector3(-size / 2, m.minY - size * 0.02 - 5, -size / 2), new THREE.Vector3(size / 2, m.maxY, size / 2));
    g.boundingSphere = g.boundingBox.getBoundingSphere(new THREE.Sphere());
    let tex = null;
    const uvTx = new THREE.Matrix3();
    if (m.img) {
      tex = new THREE.Texture(m.img);
      tex.colorSpace = THREE.SRGBColorSpace;
      tex.flipY = false;
      tex.anisotropy = this.anisotropy;
      tex.minFilter = THREE.LinearMipmapLinearFilter;
      tex.wrapS = tex.wrapT = THREE.ClampToEdgeWrapping;
      tex.needsUpdate = true;
      const d = n.z - m.imgInfo.iz;
      if (d > 0) {
        const s = 1 / 2 ** d;
        uvTx.setUvTransform((n.x - (m.imgInfo.ix << d)) * s, (n.y - (m.imgInfo.iy << d)) * s, s, s, 0, 0, 0);
      }
    } else {
      this.stats.imageryFail++;
    }
    const mat = new THREE.ShaderMaterial({
      vertexShader: VERT,
      fragmentShader: FRAG,
      fog: true,
      uniforms: {
        ...THREE.UniformsUtils.clone(THREE.UniformsLib.fog),
        map: { value: tex },
        hasMap: { value: tex ? 1 : 0 },
        uvTx: { value: uvTx },
        ...this.shared,
      },
    });
    const mesh = new THREE.Mesh(g, mat);
    mesh.position.set(m.cx, 0, m.cz);
    mesh.matrixAutoUpdate = false;
    mesh.updateMatrix();
    mesh.visible = false;
    if (n.z >= 15) mesh.layers.enable(MIRROR_LAYER);
    mesh.renderOrder = -1;
    n.mesh = mesh;
    n.minY = m.minY;
    n.maxY = m.maxY;
    n.state = 'ready';
    this.group.add(mesh);
    this.stats.built++;
    this.stats.ms = (this.stats.ms || 0) * 0.9 + (m.ms || 0) * 0.1;
  }

  // 해·하늘 빛 (sky.js에서 매 프레임 부름)
  setLight(sunDir, sunCol, ambCol, tint) {
    this.shared.sunDir.value.copy(sunDir);
    this.shared.sunCol.value.copy(sunCol);
    this.shared.ambCol.value.copy(ambCol);
    if (tint) this.shared.tint.value.copy(tint);
  }

  // 카메라 바로 아래 보이는 타일의 상세 단계 (로딩 끝 판단용)
  detailAt(p) {
    let best = 0;
    for (const n of this.nodes.values()) {
      if (!n.mesh || !n.mesh.visible) continue;
      const b = n.b;
      if (p.x >= b.x0 && p.x <= b.x1 && p.z >= b.z0 && p.z <= b.z1) best = Math.max(best, n.z);
    }
    return best;
  }

  requestTrees(z, x, y, density, id) {
    this.worker.postMessage({ type: 'tile', kind: 'trees', id, z, x, y, density, pri: 30 });
  }

  // 로딩 진행 정도 (시작 화면용)
  loadingCount() {
    let n = 0;
    for (const p of this.pending.values()) if (p.state === 'loading' || p.state === 'queued') n++;
    return n + this.results.length;
  }
}
