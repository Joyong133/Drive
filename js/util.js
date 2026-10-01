import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/BufferGeometryUtils.js';

export const FONT = "'Noto Sans KR','Apple SD Gothic Neo','Malgun Gothic',sans-serif";

export const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
export const lerp = (a, b, t) => a + (b - a) * t;
export const approach = (cur, target, maxDelta) =>
  cur < target ? Math.min(cur + maxDelta, target) : Math.max(cur - maxDelta, target);
// 프레임레이트와 무관한 지수 감쇠 보간
export const damp = (cur, target, rate, dt) => target + (cur - target) * Math.exp(-rate * dt);
export const randRange = (a, b) => a + Math.random() * (b - a);

// localStorage는 시크릿 창 등에서 막힐 수 있으므로 항상 try/catch
export const storage = {
  get(key, fallback) {
    try {
      const raw = localStorage.getItem(key);
      return raw == null ? fallback : JSON.parse(raw);
    } catch {
      return fallback;
    }
  },
  set(key, value) {
    try {
      localStorage.setItem(key, JSON.stringify(value));
    } catch {
      /* 저장 불가 환경은 무시 */
    }
  },
};

export class Emitter {
  constructor() { this._h = {}; }
  on(name, fn) { (this._h[name] ||= []).push(fn); return this; }
  emit(name, ...args) { for (const fn of this._h[name] || []) fn(...args); }
}

export function makeCanvas(w, h) {
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  return c;
}

export function canvasTexture(canvas) {
  const t = new THREE.CanvasTexture(canvas);
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 4;
  return t;
}

export function roundRect(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

// 표지판 등 고정 글자 텍스처
export function labelTexture(lines, opts = {}) {
  const {
    w = 512, h = 256, bg = '#1f5fbf', fg = '#ffffff', border = '#ffffff',
    size = 96, weight = 900, radius = 28, pad = 14,
  } = opts;
  const c = makeCanvas(w, h);
  const ctx = c.getContext('2d');
  if (bg) {
    ctx.fillStyle = border || bg;
    roundRect(ctx, 0, 0, w, h, radius);
    ctx.fill();
    ctx.fillStyle = bg;
    roundRect(ctx, pad, pad, w - pad * 2, h - pad * 2, Math.max(4, radius - pad / 2));
    ctx.fill();
  }
  ctx.fillStyle = fg;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  const arr = Array.isArray(lines) ? lines : [lines];
  const lineH = h / (arr.length + 0.6);
  arr.forEach((line, i) => {
    const s = typeof line === 'object' ? line.size : size;
    const text = typeof line === 'object' ? line.text : line;
    ctx.font = `${weight} ${s}px ${FONT}`;
    ctx.fillText(text, w / 2, lineH * (i + 0.8), w - pad * 4);
  });
  return canvasTexture(c);
}

// 같은 재질을 쓰는 정적 지오메트리를 하나로 합쳐 드로우콜을 줄임 (VR 성능)
export class GeoBatch {
  constructor() { this.map = new Map(); }

  add(geometry, material, matrix) {
    const g = geometry.index ? geometry.toNonIndexed() : geometry.clone();
    if (matrix) g.applyMatrix4(matrix);
    for (const name of Object.keys(g.attributes)) {
      if (!['position', 'normal', 'uv'].includes(name)) g.deleteAttribute(name);
    }
    if (!g.attributes.normal) g.computeVertexNormals();
    if (!g.attributes.uv) {
      g.setAttribute('uv', new THREE.Float32BufferAttribute(new Float32Array(g.attributes.position.count * 2), 2));
    }
    g.clearGroups();
    if (!this.map.has(material)) this.map.set(material, []);
    this.map.get(material).push(g);
    return this;
  }

  addBox(material, sx, sy, sz, x, y, z, ry = 0, rx = 0, rz = 0) {
    const m = new THREE.Matrix4().compose(
      new THREE.Vector3(x, y, z),
      new THREE.Quaternion().setFromEuler(new THREE.Euler(rx, ry, rz, 'YXZ')),
      new THREE.Vector3(1, 1, 1),
    );
    return this.add(new THREE.BoxGeometry(sx, sy, sz), material, m);
  }

  build(parent, name = 'batch') {
    const meshes = [];
    for (const [material, list] of this.map) {
      if (!list.length) continue;
      const merged = mergeGeometries(list, false);
      list.forEach((g) => g.dispose());
      const mesh = new THREE.Mesh(merged, material);
      mesh.name = name;
      mesh.matrixAutoUpdate = false;
      mesh.updateMatrix();
      parent.add(mesh);
      meshes.push(mesh);
    }
    this.map.clear();
    return meshes;
  }
}

// 그룹의 정적 자식 메시를 재질별로 합침 (keep에 든 것은 그대로 둠)
export function mergeStaticChildren(group, keep = new Set()) {
  const batch = new GeoBatch();
  const remove = [];
  for (const child of group.children) {
    if (!child.isMesh || keep.has(child) || Array.isArray(child.material) || child.children.length) continue;
    child.updateMatrix();
    batch.add(child.geometry, child.material, child.matrix);
    remove.push(child);
  }
  remove.forEach((c) => { group.remove(c); c.geometry.dispose(); });
  return batch.build(group, 'merged');
}

export function matrixFrom(x, y, z, ry = 0, rx = 0, rz = 0, s = 1) {
  return new THREE.Matrix4().compose(
    new THREE.Vector3(x, y, z),
    new THREE.Quaternion().setFromEuler(new THREE.Euler(rx, ry, rz, 'YXZ')),
    new THREE.Vector3(s, s, s),
  );
}

export function noiseTexture(w, h, base, spread, opts = {}) {
  const c = makeCanvas(w, h);
  const ctx = c.getContext('2d');
  ctx.fillStyle = base;
  ctx.fillRect(0, 0, w, h);
  const img = ctx.getImageData(0, 0, w, h);
  const d = img.data;
  for (let i = 0; i < d.length; i += 4) {
    const n = (Math.random() - 0.5) * spread;
    d[i] = clamp(d[i] + n, 0, 255);
    d[i + 1] = clamp(d[i + 1] + n * (opts.greenBias || 1), 0, 255);
    d[i + 2] = clamp(d[i + 2] + n, 0, 255);
  }
  ctx.putImageData(img, 0, 0);
  if (opts.speckle) {
    for (let i = 0; i < opts.speckle; i++) {
      ctx.fillStyle = Math.random() < 0.5 ? 'rgba(255,255,255,0.08)' : 'rgba(0,0,0,0.12)';
      ctx.fillRect(Math.random() * w, Math.random() * h, 1 + Math.random() * 2, 1 + Math.random() * 2);
    }
  }
  const t = canvasTexture(c);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  return t;
}
