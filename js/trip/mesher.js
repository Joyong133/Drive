// 가벼운 지오메트리 빌더: 재질별로 삼각형을 모아 한 번에 BufferGeometry로 만듦 (드로우콜 최소화)
import * as THREE from 'three';

export class Part {
  constructor(withUv = false, withExtra = 0, origin = null) {
    // 큰 좌표(수백 km)를 그대로 float32로 쓰면 떨림이 생기므로 원점 기준 상대좌표로 저장
    this.ox = origin ? origin.x : 0;
    this.oy = origin ? origin.y : 0;
    this.oz = origin ? origin.z : 0;
    this.p = [];
    this.n = [];
    this.c = [];
    this.uv = withUv ? [] : null;
    this.ex = withExtra ? [] : null; // 추가 속성 (도로 셰이더용)
    this.exSize = withExtra;
    this.i = [];
    this.count = 0;
  }

  vert(x, y, z, nx, ny, nz, r = 1, g = 1, b = 1, u = 0, v = 0, ex = null) {
    this.p.push(x - this.ox, y - this.oy, z - this.oz);
    this.n.push(nx, ny, nz);
    this.c.push(r, g, b);
    if (this.uv) this.uv.push(u, v);
    if (this.ex) for (let k = 0; k < this.exSize; k++) this.ex.push(ex ? ex[k] : 0);
    return this.count++;
  }

  tri(a, b, c) { this.i.push(a, b, c); }
  quad(a, b, c, d) { this.i.push(a, b, c, a, c, d); }

  // 평평한 사각형 (네 점은 반시계 방향이 앞면)
  face(p0, p1, p2, p3, col) {
    const ux = p1[0] - p0[0], uy = p1[1] - p0[1], uz = p1[2] - p0[2];
    const vx = p3[0] - p0[0], vy = p3[1] - p0[1], vz = p3[2] - p0[2];
    let nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
    const L = Math.hypot(nx, ny, nz) || 1;
    nx /= L; ny /= L; nz /= L;
    const [r, g, b] = col;
    const a = this.vert(p0[0], p0[1], p0[2], nx, ny, nz, r, g, b, 0, 0);
    const bb = this.vert(p1[0], p1[1], p1[2], nx, ny, nz, r, g, b, 1, 0);
    const c = this.vert(p2[0], p2[1], p2[2], nx, ny, nz, r, g, b, 1, 1);
    const d = this.vert(p3[0], p3[1], p3[2], nx, ny, nz, r, g, b, 0, 1);
    this.quad(a, bb, c, d);
  }

  // 방향이 있는 상자: 중심 c, 축 ex(앞), ey(위), ez(옆) 단위벡터와 반길이
  box(c, ax, ay, az, hx, hy, hz, col, skipBottom = true) {
    const P = (sx, sy, sz) => [
      c[0] + ax[0] * hx * sx + ay[0] * hy * sy + az[0] * hz * sz,
      c[1] + ax[1] * hx * sx + ay[1] * hy * sy + az[1] * hz * sz,
      c[2] + ax[2] * hx * sx + ay[2] * hy * sy + az[2] * hz * sz,
    ];
    const f = (a, b, cc, d) => this.face(P(...a), P(...b), P(...cc), P(...d), col);
    f([-1, 1, -1], [-1, 1, 1], [1, 1, 1], [1, 1, -1]);   // 위
    f([1, -1, -1], [1, 1, -1], [1, 1, 1], [1, -1, 1]);   // +x
    f([-1, -1, 1], [-1, 1, 1], [-1, 1, -1], [-1, -1, -1]); // -x
    f([-1, -1, -1], [-1, 1, -1], [1, 1, -1], [1, -1, -1]); // -z
    f([1, -1, 1], [1, 1, 1], [-1, 1, 1], [-1, -1, 1]);   // +z
    if (!skipBottom) f([-1, -1, -1], [1, -1, -1], [1, -1, 1], [-1, -1, 1]);
  }

  // 단면(profile: [[횡거리, 높이], ...])을 경로 틀(frames)을 따라 쓸어 만든 띠
  // frames: [{x,y,z, rx,rz, bank, s}] (오른쪽 = (rx,0,rz)), side: 단면 바깥 방향 뒤집기
  sweep(frames, profile, col, { flip = false, closed = false, uvScale = 0 } = {}) {
    const np = profile.length;
    const segs = closed ? np : np - 1;
    for (let e = 0; e < segs; e++) {
      const a = profile[e], b = profile[(e + 1) % np];
      // 단면 2D에서의 법선 (오른쪽-위 평면)
      let nl = b[1] - a[1], nh = -(b[0] - a[0]);
      if (flip) { nl = -nl; nh = -nh; }
      const L = Math.hypot(nl, nh) || 1;
      nl /= L; nh /= L;
      let prevA = -1, prevB = -1;
      for (const f of frames) {
        const pa = [f.x + f.rx * a[0], f.y + a[1] - f.bank * a[0], f.z + f.rz * a[0]];
        const pb = [f.x + f.rx * b[0], f.y + b[1] - f.bank * b[0], f.z + f.rz * b[0]];
        const nx = f.rx * nl, ny = nh, nz = f.rz * nl;
        const shade = Array.isArray(col) ? col : col(f, e);
        const ia = this.vert(pa[0], pa[1], pa[2], nx, ny, nz, shade[0], shade[1], shade[2], 0, uvScale ? f.s * uvScale : 0);
        const ib = this.vert(pb[0], pb[1], pb[2], nx, ny, nz, shade[0], shade[1], shade[2], 1, uvScale ? f.s * uvScale : 0);
        if (prevA >= 0) {
          if (flip) this.quad(prevA, ia, ib, prevB);
          else this.quad(prevA, prevB, ib, ia);
        }
        prevA = ia; prevB = ib;
      }
    }
  }

  get empty() { return this.i.length === 0; }

  geometry() {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(this.p, 3));
    g.setAttribute('normal', new THREE.Float32BufferAttribute(this.n, 3));
    g.setAttribute('color', new THREE.Float32BufferAttribute(this.c, 3));
    if (this.uv) g.setAttribute('uv', new THREE.Float32BufferAttribute(this.uv, 2));
    if (this.ex) g.setAttribute('aex', new THREE.Float32BufferAttribute(this.ex, this.exSize));
    g.setIndex(this.count > 65535 ? new THREE.Uint32BufferAttribute(this.i, 1) : new THREE.Uint16BufferAttribute(this.i, 1));
    g.computeBoundingSphere();
    g.computeBoundingBox();
    return g;
  }
}

// 재질 이름 → Part 모음
export class Builder {
  constructor(origin = null) { this.parts = new Map(); this.origin = origin; }
  part(name, withUv = false, extra = 0) {
    let p = this.parts.get(name);
    if (!p) this.parts.set(name, (p = new Part(withUv, extra, this.origin)));
    return p;
  }
  build(group, materials, origin = this.origin) {
    for (const [name, part] of this.parts) {
      if (part.empty) continue;
      const g = part.geometry();
      const mesh = new THREE.Mesh(g, materials[name]);
      mesh.name = name;
      if (origin) mesh.position.copy(origin);
      mesh.matrixAutoUpdate = false;
      mesh.updateMatrix();
      group.add(mesh);
    }
    this.parts.clear();
  }
}
