// 길가 숲: 위성사진에서 숲인 곳을 골라(워커) 가까운 곳에 입체 나무를 심음
import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/BufferGeometryUtils.js';
import { worldToTile, tileBounds } from './geo.js';

const TZ = 16;

function colored(g, r, gg, b) {
  const n = g.attributes.position.count;
  const c = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) { c[i * 3] = r; c[i * 3 + 1] = gg; c[i * 3 + 2] = b; }
  g.setAttribute('color', new THREE.BufferAttribute(c, 3));
  for (const k of Object.keys(g.attributes)) if (!['position', 'normal', 'color'].includes(k)) g.deleteAttribute(k);
  return g.index ? g.toNonIndexed() : g;
}

function pineGeo() {
  const trunk = new THREE.CylinderGeometry(0.12, 0.18, 3, 4, 1, true); trunk.translate(0, 1.5, 0);
  const c1 = new THREE.ConeGeometry(2.3, 5.5, 6, 1, true); c1.translate(0, 4.6, 0);
  const c2 = new THREE.ConeGeometry(1.6, 4.2, 6, 1, true); c2.translate(0, 7.6, 0);
  // 줄기는 갈색이지만 인스턴스 색(사진 색)과 곱해지므로 밝게
  return mergeGeometries([colored(trunk, 1.6, 1.0, 0.6), colored(c1, 0.95, 1.05, 0.95), colored(c2, 1.1, 1.15, 1.05)]);
}

function broadGeo() {
  const trunk = new THREE.CylinderGeometry(0.15, 0.22, 3.2, 4, 1, true); trunk.translate(0, 1.6, 0);
  const crown = new THREE.IcosahedronGeometry(3.0, 0); crown.scale(1, 0.9, 1); crown.translate(0, 5.4, 0);
  return mergeGeometries([colored(trunk, 1.6, 1.0, 0.6), colored(crown, 1.05, 1.05, 1.0)]);
}

export class Trees {
  constructor({ scene, terrain, quality }) {
    this.group = new THREE.Group();
    this.group.name = 'trees';
    scene.add(this.group);
    this.terrain = terrain;
    this.geos = [pineGeo(), broadGeo()];
    this.mat = new THREE.MeshLambertMaterial({ vertexColors: true });
    this.tiles = new Map(); // key → { state, meshes }
    this.setQuality(quality);
    terrain.treeHandler = (m) => this.onResult(m);
    this.last = -1;
    this.mo = new THREE.Matrix4();
    this.q = new THREE.Quaternion();
    this.up = new THREE.Vector3(0, 1, 0);
    this.v = new THREE.Vector3();
    this.s = new THREE.Vector3();
    this.c = new THREE.Color();
  }

  setQuality(q) {
    const t = this.terrain.q;
    this.radius = t.treeR;
    this.density = t.trees;
    if (!this.radius) this.clear();
  }

  clear() {
    for (const t of this.tiles.values()) this.disposeTile(t);
    this.tiles.clear();
  }

  disposeTile(t) {
    for (const m of t.meshes || []) { this.group.remove(m); m.dispose(); }
    t.meshes = null;
  }

  update(cam, now) {
    if (!this.radius) return;
    if (now - this.last < 0.5) return;
    this.last = now;
    const R = this.radius;
    const a = worldToTile(cam.x - R, cam.z - R, TZ), b = worldToTile(cam.x + R, cam.z + R, TZ);
    const want = new Set();
    for (let x = Math.floor(a.tx); x <= Math.floor(b.tx); x++) {
      for (let y = Math.floor(a.ty); y <= Math.floor(b.ty); y++) {
        const bd = tileBounds(TZ, x, y);
        const dx = Math.max(bd.x0 - cam.x, 0, cam.x - bd.x1), dz = Math.max(bd.z0 - cam.z, 0, cam.z - bd.z1);
        if (Math.hypot(dx, dz) > R) continue;
        const key = `${x}/${y}`;
        want.add(key);
        if (!this.tiles.has(key)) {
          this.tiles.set(key, { state: 'loading', x, y, b: bd });
          this.terrain.requestTrees(TZ, x, y, this.density, 'T' + key);
        }
      }
    }
    for (const [key, t] of this.tiles) {
      if (!want.has(key)) {
        const bd = t.b;
        const dx = Math.max(bd.x0 - cam.x, 0, cam.x - bd.x1), dz = Math.max(bd.z0 - cam.z, 0, cam.z - bd.z1);
        if (Math.hypot(dx, dz) > R + 250) { this.disposeTile(t); this.tiles.delete(key); }
      }
    }
  }

  onResult(m) {
    const key = String(m.id).slice(1);
    const t = this.tiles.get(key);
    if (!t) return;
    t.state = 'ready';
    if (!m.trees || !m.trees.length) return;
    const arr = m.trees;
    const cx = (t.b.x0 + t.b.x1) / 2, cz = (t.b.z0 + t.b.z1) / 2;
    const counts = [0, 0];
    for (let i = 0; i < arr.length; i += 8) counts[arr[i + 4] > 0.5 ? 1 : 0]++;
    t.meshes = [];
    const meshes = counts.map((n, k) => {
      if (!n) return null;
      const im = new THREE.InstancedMesh(this.geos[k], this.mat, n);
      im.position.set(cx, 0, cz);
      im.frustumCulled = true;
      this.group.add(im);
      t.meshes.push(im);
      return im;
    });
    const idx = [0, 0];
    let minY = Infinity, maxY = -Infinity;
    for (let i = 0; i < arr.length; i += 8) {
      const k = arr[i + 4] > 0.5 ? 1 : 0;
      const im = meshes[k];
      const sc = arr[i + 3];
      const rot = (arr[i] * 13.37 + arr[i + 2] * 7.1) % (Math.PI * 2);
      this.q.setFromAxisAngle(this.up, rot);
      this.v.set(arr[i] - cx, arr[i + 1], arr[i + 2] - cz);
      this.s.set(sc, sc * (0.9 + (rot % 0.4)), sc);
      this.mo.compose(this.v, this.q, this.s);
      im.setMatrixAt(idx[k], this.mo);
      // 사진의 숲 색을 조금 밝게 (위에서 찍힌 사진은 옆에서 보는 것보다 어두움)
      this.c.setRGB(Math.min(1, arr[i + 5] * 1.35), Math.min(1, arr[i + 6] * 1.35), Math.min(1, arr[i + 7] * 1.25), THREE.SRGBColorSpace);
      im.setColorAt(idx[k], this.c);
      idx[k]++;
      minY = Math.min(minY, arr[i + 1]); maxY = Math.max(maxY, arr[i + 1] + 12);
    }
    for (const im of t.meshes) {
      im.instanceMatrix.needsUpdate = true;
      if (im.instanceColor) im.instanceColor.needsUpdate = true;
      im.computeBoundingSphere();
    }
  }
}
