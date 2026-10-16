// 경로 주변 건물: 바닥 모양(OSM/Overture)을 높이만큼 세움. 창문은 셰이더로 (텍스처 없이 가벼움)
import * as THREE from 'three';
import { MIRROR_LAYER } from './terrain.js';

const VERT = /* glsl */`
  #include <common>
  #include <fog_pars_vertex>
  attribute vec4 aex; // x: 종류, y: 난수, z: 지붕(1)/벽(0), w: 건물 높이
  varying vec2 vUv;
  varying vec4 vEx;
  varying vec3 vN;
  varying vec3 vCol;
  void main() {
    vUv = uv; vEx = aex; vN = normal; vCol = color;
    vec4 mvPosition = modelViewMatrix * vec4(position, 1.0);
    gl_Position = projectionMatrix * mvPosition;
    #include <fog_vertex>
  }
`;

const FRAG = /* glsl */`
  #include <common>
  #include <fog_pars_fragment>
  uniform vec3 sunDir;
  uniform vec3 sunCol;
  uniform vec3 ambCol;
  uniform float night;
  varying vec2 vUv;
  varying vec4 vEx;
  varying vec3 vN;
  varying vec3 vCol;
  float h1(float x) { return fract(sin(x * 91.17) * 43758.5453); }
  void main() {
    vec3 base = vCol;
    float kind = vEx.x;
    vec3 n = normalize(vN);
    float win = 0.0;
    if (vEx.z < 0.5) {
      // 층 높이·창 간격 (아파트 2.9 m, 상가/학교 3.6 m, 공장은 띠창)
      float fh = kind < 1.5 && kind > 0.5 ? 2.9 : 3.6;
      float floorI = floor(vUv.y / fh);
      float fy = fract(vUv.y / fh);
      float bay = kind < 1.5 && kind > 0.5 ? 3.2 : 3.0;
      float fx = fract(vUv.x / bay);
      float colI = floor(vUv.x / bay);
      if (kind > 3.5 && kind < 4.5) {
        win = step(0.62, fy) * step(fy, 0.82) * step(vUv.y, vEx.w - 1.0);
      } else if (kind > 4.5 && kind < 5.5) {
        win = 0.0;
      } else {
        win = step(0.32, fy) * step(fy, 0.78) * step(0.14, fx) * step(fx, 0.86);
        win *= step(1.2, vUv.y) * step(vUv.y, vEx.w - 0.6);
      }
      // 걸러서 멀리서 지글거리지 않게
      float fw = fwidth(vUv.y) + fwidth(vUv.x);
      win *= 1.0 - smoothstep(0.6, 1.6, fw);
      vec3 glass = mix(vec3(0.05, 0.07, 0.09), vec3(0.22, 0.27, 0.32), h1(floorI * 13.0 + colI * 7.0 + vEx.y * 100.0) * 0.6 + max(n.y, 0.0));
      // 밤에는 일부 창에 불
      float r = h1(floorI * 3.1 + colI * 17.3 + vEx.y * 50.0);
      float lit = step(0.68, r) * night;
      vec3 lamp = mix(vec3(1.0, 0.78, 0.48), vec3(0.85, 0.9, 1.0), step(0.86, r)); // 전구색 / 형광등
      glass = mix(glass, lamp * 0.85, lit);
      base = mix(base, glass, win);
    }
    float l = max(dot(n, sunDir), 0.0);
    vec3 light = ambCol * (0.75 + 0.25 * n.y) + sunCol * l;
    vec3 c = base * light;
    if (win > 0.5 && night > 0.5) c = max(c, base * 0.9);
    gl_FragColor = vec4(c, 1.0);
    #include <colorspace_fragment>
    #include <fog_fragment>
  }
`;

const WALLS = {
  0: [0xd9d4c8, 0xc9c3b6, 0xbdb9ae, 0xe2ddd0, 0xa89f90],
  1: [0xece8de, 0xe4dfd2, 0xd8d4cc, 0xf0ece4, 0xd6cdbd],
  2: [0xd8c8b0, 0xc4b49c, 0xe0d6c4, 0xb8a58a, 0xcfc3ae],
  3: [0xc8ccd0, 0x9aa6b0, 0xd8d0c0, 0xb0b4b8, 0x8c98a4],
  4: [0xbcc4c8, 0xa8b4bc, 0xc8ccc4, 0x9aa8b0, 0xd0d0c8],
  5: [0xe8ecec, 0xdce4e4],
  6: [0xd8c8a8, 0xcbb894, 0xe0d4bc],
  7: [0xd0c8b8, 0xb8a890],
};
const ROOFS = {
  0: [0x6f7377, 0x8a8a84, 0x5a7a6a], 1: [0x8c8c88, 0x9a9890, 0x7c8484], 2: [0x8a4a3a, 0x4a5f7a, 0x5f6f5a, 0x7a6a5a],
  3: [0x7a7e82, 0x6a6e72], 4: [0x3f6f9a, 0x4f7f6a, 0x8a8e92, 0x2f5f8a], 5: [0xf0f4f4], 6: [0x6a7a6a, 0x7a6a5a], 7: [0x5a4a3a],
};

export class Buildings {
  constructor({ scene, meta, routes, shared, base = 'data/trip/bld/' }) {
    this.group = new THREE.Group();
    this.group.name = 'buildings';
    scene.add(this.group);
    this.meta = meta.buildings;
    this.routes = routes;
    this.base = base;
    this.chunks = new Map(); // ci → { state, mesh }
    this.uniforms = { night: { value: 0 } };
    this.mat = new THREE.ShaderMaterial({
      vertexShader: VERT, fragmentShader: FRAG, fog: true, vertexColors: true,
      uniforms: { ...THREE.UniformsUtils.clone(THREE.UniformsLib.fog), sunDir: shared.sunDir, sunCol: shared.sunCol, ambCol: shared.ambCol, night: this.uniforms.night },
    });
    this.enabled = true;
  }

  // SB 기준 거리(s)로 나눈 덩어리. NB에서는 반대 방향 대응점으로 바꿈
  update(route, s) {
    if (!this.meta || !this.enabled) return;
    let sb = s;
    if (route.name !== 'SB') sb = route.other[route.idx(s)[0]] * route.spacing;
    const c = Math.floor(sb / this.meta.chunk);
    const want = new Set([c - 1, c, c + 1, c + 2].filter((k) => this.meta.chunks[k]));
    // 진행 방향 앞쪽을 하나 더
    want.add(route.name === 'SB' ? c + 2 : c - 2);
    for (const k of want) {
      if (!this.meta.chunks[k] || this.chunks.has(k)) continue;
      this.chunks.set(k, { state: 'loading' });
      this.load(k);
    }
    for (const [k, ch] of this.chunks) {
      if (!want.has(k) && Math.abs(k - c) > 3) {
        if (ch.mesh) { this.group.remove(ch.mesh); ch.mesh.geometry.dispose(); }
        this.chunks.delete(k);
      }
    }
  }

  async load(k) {
    try {
      const buf = await (await fetch(`${this.base}${String(k).padStart(3, '0')}.bin`)).arrayBuffer();
      const ch = this.chunks.get(k);
      if (!ch) return;
      const mesh = this.buildMesh(buf);
      ch.mesh = mesh;
      ch.state = 'ready';
      this.group.add(mesh);
    } catch (e) {
      console.warn('buildings', k, e);
    }
  }

  buildMesh(buf) {
    const dv = new DataView(buf);
    const ox = dv.getFloat32(0, true), oz = dv.getFloat32(4, true), count = dv.getUint32(8, true);
    let o = 12;
    const P = [], N = [], U = [], Cc = [], E = [], I = [];
    let vc = 0;
    const col = new THREE.Color();
    const pick = (arr, r) => arr[Math.floor(r * arr.length) % arr.length];
    for (let b = 0; b < count; b++) {
      const n = dv.getUint16(o, true); o += 2;
      const h = dv.getUint16(o, true) / 10; o += 2;
      const y0 = dv.getFloat32(o, true) - 1.5; o += 4;
      const kind = dv.getUint8(o); o += 1;
      const xs = new Float32Array(n), zs = new Float32Array(n);
      for (let k = 0; k < n; k++) {
        xs[k] = dv.getInt16(o, true) / 4; zs[k] = dv.getInt16(o + 2, true) / 4; o += 4;
      }
      const rnd = Math.abs(Math.sin(xs[0] * 12.9898 + zs[0] * 78.233)) % 1;
      const top = y0 + 1.5 + h;
      // 바깥쪽 법선: 부호 있는 넓이로 방향 판단
      let area = 0;
      for (let k = 0; k < n; k++) { const j = (k + 1) % n; area += xs[k] * zs[j] - xs[j] * zs[k]; }
      col.setHex(pick(WALLS[kind] || WALLS[0], rnd));
      let perim = 0;
      for (let k = 0; k < n; k++) {
        let a = k, bb = (k + 1) % n;
        if (area > 0) { a = (k + 1) % n; bb = k; }
        const ax = xs[a], az = zs[a], bx = xs[bb], bz = zs[bb];
        const len = Math.hypot(bx - ax, bz - az);
        if (len < 0.05) continue;
        const tx = (bx - ax) / len, tz = (bz - az) / len;
        const nx = -tz, nz = tx; // t × up
        for (const [x, z, yy, u, v] of [[ax, az, y0, perim, 0], [bx, bz, y0, perim + len, 0], [bx, bz, top, perim + len, h + 1.5], [ax, az, top, perim, h + 1.5]]) {
          P.push(x, yy, z); N.push(nx, 0, nz); U.push(u, v - 1.5); Cc.push(col.r, col.g, col.b); E.push(kind, rnd, 0, h);
        }
        I.push(vc, vc + 1, vc + 2, vc, vc + 2, vc + 3);
        vc += 4;
        perim += len;
      }
      // 지붕
      const contour = [];
      for (let k = 0; k < n; k++) contour.push(new THREE.Vector2(xs[k], zs[k]));
      let tris;
      try { tris = THREE.ShapeUtils.triangulateShape(contour, []); } catch { tris = []; }
      col.setHex(pick(ROOFS[kind] || ROOFS[0], rnd * 7 % 1));
      const base = vc;
      for (let k = 0; k < n; k++) { P.push(xs[k], top, zs[k]); N.push(0, 1, 0); U.push(0, 0); Cc.push(col.r, col.g, col.b); E.push(kind, rnd, 1, h); vc++; }
      for (const t of tris) {
        // 위를 보도록
        const [a, bq, c] = t;
        const cross = (xs[bq] - xs[a]) * (zs[c] - zs[a]) - (zs[bq] - zs[a]) * (xs[c] - xs[a]);
        if (cross < 0) I.push(base + a, base + bq, base + c); else I.push(base + a, base + c, base + bq);
      }
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(P, 3));
    g.setAttribute('normal', new THREE.Float32BufferAttribute(N, 3));
    g.setAttribute('uv', new THREE.Float32BufferAttribute(U, 2));
    g.setAttribute('color', new THREE.Float32BufferAttribute(Cc, 3));
    g.setAttribute('aex', new THREE.Float32BufferAttribute(E, 4));
    g.setIndex(vc > 65535 ? new THREE.Uint32BufferAttribute(I, 1) : new THREE.Uint16BufferAttribute(I, 1));
    g.computeBoundingSphere();
    const mesh = new THREE.Mesh(g, this.mat);
    mesh.position.set(ox, 0, oz);
    mesh.matrixAutoUpdate = false;
    mesh.updateMatrix();
    mesh.layers.enable(MIRROR_LAYER);
    return mesh;
  }
}
