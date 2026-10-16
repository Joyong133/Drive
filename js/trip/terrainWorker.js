// 지형 타일 만들기 (웹 워커): 고도 타일(Terrarium) 해독 → 격자 메시 → 도로 주변 깎기/메우기,
// 위성사진 받기, 나무 위치 고르기. 메인 스레드가 끊기지 않도록 무거운 일은 여기서 함.
import { tileBounds, worldToTile } from './geo.js';
import { Route, F_BRIDGE, F_TUNNEL, bankOf } from './route.js';

const DEM_URL = 'https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png';
const DEM_MAX_Z = 13;

let routes = [];
let ramps = [];
let imagery = null; // { url, maxZ }
let corridor = null;

// ───────── 고도 타일 캐시
const demCache = new Map(); // key → Promise<Float32Array|null>
const demOrder = [];
function demKey(z, x, y) { return `${z}/${x}/${y}`; }
function getDem(z, x, y) {
  const key = demKey(z, x, y);
  let p = demCache.get(key);
  if (p) return p;
  p = (async () => {
    const url = DEM_URL.replace('{z}', z).replace('{x}', x).replace('{y}', y);
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const res = await fetch(url, { mode: 'cors' });
        if (!res.ok) throw new Error(res.status);
        const bmp = await createImageBitmap(await res.blob(), { colorSpaceConversion: 'none', premultiplyAlpha: 'none' });
        const cv = new OffscreenCanvas(256, 256);
        const g = cv.getContext('2d', { willReadFrequently: true });
        g.drawImage(bmp, 0, 0);
        bmp.close?.();
        const d = g.getImageData(0, 0, 256, 256).data;
        const h = new Float32Array(256 * 256);
        for (let i = 0; i < h.length; i++) h[i] = d[i * 4] * 256 + d[i * 4 + 1] + d[i * 4 + 2] / 256 - 32768;
        return h;
      } catch (e) {
        await new Promise((r) => setTimeout(r, 400 * (attempt + 1)));
      }
    }
    return null;
  })();
  demCache.set(key, p);
  demOrder.push(key);
  if (demOrder.length > 120) demCache.delete(demOrder.shift());
  return p;
}

// 월드 좌표의 고도 (zE 단계 DEM, 타일 경계도 이어서 쌍선형 보간)
function makeSampler(zE, tiles) {
  return (x, z) => {
    const t = worldToTile(x, z, zE);
    const px = t.tx * 256 - 0.5, py = t.ty * 256 - 0.5;
    const x0 = Math.floor(px), y0 = Math.floor(py);
    const fx = px - x0, fy = py - y0;
    const v = (ix, iy) => {
      const tx = Math.floor(ix / 256), ty = Math.floor(iy / 256);
      const h = tiles.get(tx * 65536 + ty);
      if (!h) return 0;
      return h[(iy - ty * 256) * 256 + (ix - tx * 256)];
    };
    return (v(x0, y0) * (1 - fx) + v(x0 + 1, y0) * fx) * (1 - fy) + (v(x0, y0 + 1) * (1 - fx) + v(x0 + 1, y0 + 1) * fx) * fy;
  };
}

// ───────── 도로 주변 지형 다듬기용 색인 (선분 격자)
const CELL = 64;
function buildCorridor() {
  const segs = []; // [ax, az, ay, bx, bz, by, left, right, flags, roadId]
  let road = 0;
  for (const rt of routes) {
    const p = rt.xyz;
    for (let i = 0; i < rt.n - 1; i++) {
      segs.push([p[i * 3], p[i * 3 + 1], p[i * 3 + 2], p[i * 3 + 3], p[i * 3 + 4], p[i * 3 + 5],
        rt.leftEdge(i), rt.rightEdge(i) + 0.6, rt.flags[i], road, bankOf(rt.curv[i])]);
    }
    road++;
  }
  for (const r of ramps) {
    for (let i = 0; i < r.n - 1; i++) {
      const a = r.pts.subarray(i * 3, i * 3 + 3), b = r.pts.subarray(i * 3 + 3, i * 3 + 6);
      segs.push([a[0], a[1], a[2], b[0], b[1], b[2], 3.0, 4.0, 0, road, 0]);
    }
    road++;
  }
  const grid = new Map();
  segs.forEach((s, k) => {
    const x0 = Math.floor((Math.min(s[0], s[3]) - 60) / CELL), x1 = Math.floor((Math.max(s[0], s[3]) + 60) / CELL);
    const z0 = Math.floor((Math.min(s[1], s[4]) - 60) / CELL), z1 = Math.floor((Math.max(s[1], s[4]) + 60) / CELL);
    for (let gx = x0; gx <= x1; gx++) {
      for (let gz = z0; gz <= z1; gz++) {
        const key = gx * 100003 + gz;
        let a = grid.get(key);
        if (!a) grid.set(key, (a = []));
        a.push(k);
      }
    }
  });
  corridor = { segs, grid };
}

function nearTile(b, margin) {
  if (!corridor) return false;
  for (let gx = Math.floor((b.x0 - margin) / CELL); gx <= Math.floor((b.x1 + margin) / CELL); gx++) {
    for (let gz = Math.floor((b.z0 - margin) / CELL); gz <= Math.floor((b.z1 + margin) / CELL); gz++) {
      if (corridor.grid.has(gx * 100003 + gz)) return true;
    }
  }
  return false;
}

// 한 점에서 각 도로(본선·램프)까지 가장 가까운 선분을 찾아 지형 높이를 고침
// out.road = 포장 위(나무 금지), out.dist = 가장 가까운 포장 끝까지 거리
const best = new Map();
function carve(x, z, h, out) {
  const cell = corridor.grid.get(Math.floor(x / CELL) * 100003 + Math.floor(z / CELL));
  out.road = false;
  out.dist = 1e9;
  if (!cell) return h;
  best.clear();
  for (const k of cell) {
    const s = corridor.segs[k];
    const dx = s[3] - s[0], dz = s[4] - s[1];
    const L2 = dx * dx + dz * dz || 1;
    const u = Math.min(Math.max(((x - s[0]) * dx + (z - s[1]) * dz) / L2, 0), 1);
    const px = s[0] + dx * u, pz = s[1] + dz * u;
    const d2 = (x - px) ** 2 + (z - pz) ** 2;
    const cur = best.get(s[9]);
    if (!cur || d2 < cur.d2) best.set(s[9], { d2, s, u, px, pz, L: Math.sqrt(L2), dx, dz });
  }
  let t = h;
  let flat = null, flatD = 1e9;
  let cover = -1e9; // 터널 덮개 (이보다 낮으면 안 됨)
  let under = 1e9;  // 교량 아래 (이보다 높으면 안 됨)
  for (const { s, u, px, pz, L, dx, dz } of best.values()) {
    // 오른쪽 + : 진행 방향 (dx,dz) 기준 오른쪽은 (-dz, dx)
    const lat = ((x - px) * -dz + (z - pz) * dx) / L;
    const along = Math.hypot(x - px, z - pz) - Math.abs(lat); // 선분 끝 너머
    const edge = lat >= 0 ? s[7] : s[6];
    const yr = s[2] + (s[5] - s[2]) * u - s[10] * Math.max(-s[6], Math.min(s[7], lat));
    const fl = s[8];
    const d = Math.abs(lat) - edge + along; // 포장 끝에서 바깥쪽 거리 (안쪽이면 음수)
    if (d < out.dist) out.dist = d;
    if (fl & F_TUNNEL) {
      // 터널 위 산은 그대로. 얕은 터널은 지면이 관 안으로 들어오지 않게 덮개를 올림
      if (d < 1) cover = Math.max(cover, yr + 9.5);
      continue;
    }
    if (fl & F_BRIDGE) {
      if (d < 6) { under = Math.min(under, yr - 6.5); out.road = true; }
      continue;
    }
    if (d < 1.2) {
      out.road = true;
      if (d < flatD) { flatD = d; flat = yr - 0.3; }
      continue;
    }
    const e = d - 1.2;
    if (t > yr) t = Math.min(t, yr - 0.3 + e * 0.9);        // 깎은 비탈 (1:1.1)
    else t = Math.max(t, yr - 0.3 - e * 0.6);               // 쌓은 비탈 (1:1.7)
  }
  // 우선순위: 도로 포장 > 터널 덮개 > 교량 아래 > 비탈
  if (flat !== null) return flat;
  t = Math.min(t, under);
  return Math.max(t, cover);
}

// ───────── 위성사진
// 사진 서버가 계속 실패하면(차단·오프라인) 한동안 사진 없이 빠르게 만듦
let imgFails = 0, imgBlockedUntil = 0;
const blankTiles = new Set(); // '사진 없음'으로 확인된 타일 (그 아래 단계도 없음)
function knownBlank(z, x, y) {
  for (let k = z; k >= 12; k--) {
    if (blankTiles.has(`${k}/${x >> (z - k)}/${y >> (z - k)}`)) return true;
  }
  return false;
}
async function fetchImagery(z, x, y) {
  if (!imagery) return null;
  if (Date.now() < imgBlockedUntil) return null;
  let iz = Math.min(z, imagery.maxZ);
  let ix = x >> (z - iz), iy = y >> (z - iz);
  while (iz > 12 && knownBlank(iz, ix, iy)) { iz -= 1; ix >>= 1; iy >>= 1; }
  for (let attempt = 0; attempt < 4; attempt++) {
    try {
      const url = imagery.url.replace('{z}', iz).replace('{x}', ix).replace('{y}', iy);
      const res = await fetch(url, { mode: 'cors' });
      if (!res.ok) throw new Error('http ' + res.status);
      const blob = await res.blob();
      if (blob.size < 1200 && iz > 10) throw new Error('empty'); // 빈 타일
      const bmp = await createImageBitmap(blob, { imageOrientation: 'none' });
      imgFails = 0;
      // 가까운 단계는 '사진 없음' 회색 안내 타일인지 확인 → 한 단계 낮은 사진으로
      if (iz >= 15 && looksBlank(readPixels(bmp))) {
        bmp.close?.();
        blankTiles.add(`${iz}/${ix}/${iy}`);
        if (blankTiles.size > 5000) blankTiles.clear();
        throw new Error('blank');
      }
      return { bmp, iz, ix, iy };
    } catch (e) {
      if (String(e.message).startsWith('http') || e.name === 'TypeError') {
        if (++imgFails > 12) { imgBlockedUntil = Date.now() + 60000; imgFails = 0; postMessage({ type: 'imageryBlocked' }); return null; }
      }
      if (iz <= 12) return null;
      iz -= 1; ix >>= 1; iy >>= 1; // 한 단계 낮은 사진으로
    }
  }
  return null;
}

// Esri 등에서 '사진 없음' 회색 타일인지 / 나무 고를 때 픽셀 읽기
function readPixels(bmp) {
  const cv = new OffscreenCanvas(bmp.width, bmp.height);
  const g = cv.getContext('2d', { willReadFrequently: true });
  g.drawImage(bmp, 0, 0);
  return { data: g.getImageData(0, 0, bmp.width, bmp.height).data, w: bmp.width, h: bmp.height };
}

function looksBlank(px) {
  // 회색 단색에 가까우면 '데이터 없음' 안내 타일로 봄
  let sum = 0, sum2 = 0, sat = 0, n = 0;
  for (let i = 0; i < px.data.length; i += 4 * 97) {
    const r = px.data[i], g = px.data[i + 1], b = px.data[i + 2];
    const v = (r + g + b) / 3;
    sum += v; sum2 += v * v; sat += Math.max(r, g, b) - Math.min(r, g, b); n++;
  }
  const mean = sum / n, varc = sum2 / n - mean * mean;
  return sat / n < 6 && mean > 150 && varc < 600;
}

// 간단한 해시 난수
function hash(x, y) {
  let h = (x * 374761393 + y * 668265263) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

// ───────── 타일 만들기
async function buildTile(msg) {
  if (msg.kind === 'trees') return buildTrees(msg);
  const { id, z, x, y } = msg;
  const tStart = performance.now();
  const b = tileBounds(z, x, y);
  const size = b.size;
  const zE = Math.min(z, DEM_MAX_Z);
  // 필요한 DEM 타일 (가장자리 1px 여유)
  const t0 = worldToTile(b.x0 - size * 0.02, b.z0 - size * 0.02, zE);
  const t1 = worldToTile(b.x1 + size * 0.02, b.z1 + size * 0.02, zE);
  const need = [];
  for (let tx = Math.floor(t0.tx); tx <= Math.floor(t1.tx); tx++) {
    for (let ty = Math.floor(t0.ty); ty <= Math.floor(t1.ty); ty++) need.push([tx, ty]);
  }
  const imgP = fetchImagery(z, x, y);
  const dems = await Promise.all(need.map(([tx, ty]) => getDem(zE, tx, ty)));
  const tiles = new Map();
  need.forEach(([tx, ty], i) => { if (dems[i]) tiles.set(tx * 65536 + ty, dems[i]); });
  const H = makeSampler(zE, tiles);

  const near = z >= 13 && nearTile(b, 80);
  const N = near && z >= 16 ? 64 : near && z >= 14 ? 48 : 32;
  const cx = (b.x0 + b.x1) / 2, cz = (b.z0 + b.z1) / 2;
  const V = (N + 1) * (N + 1);
  const skirtN = 4 * N;
  const total = V + skirtN + 4;
  const pos = new Float32Array(total * 3);
  const nor = new Int8Array(total * 3);
  const uv = new Float32Array(total * 2);
  const col = new Uint8Array(total * 3);
  const hs = new Float32Array(V);
  const out = {};
  let minY = Infinity, maxY = -Infinity;
  const doCarve = near && z >= 14;
  for (let j = 0; j <= N; j++) {
    for (let i = 0; i <= N; i++) {
      const wx = b.x0 + (i / N) * size, wz = b.z0 + (j / N) * size;
      let h = H(wx, wz);
      if (doCarve) h = carve(wx, wz, h, out);
      const k = j * (N + 1) + i;
      hs[k] = h;
      if (h < minY) minY = h;
      if (h > maxY) maxY = h;
    }
  }
  // 위치, 법선, 대체 색(사진이 없을 때)
  const step = size / N;
  for (let j = 0; j <= N; j++) {
    for (let i = 0; i <= N; i++) {
      const k = j * (N + 1) + i;
      const h = hs[k];
      pos[k * 3] = b.x0 + i * step - cx;
      pos[k * 3 + 1] = h;
      pos[k * 3 + 2] = b.z0 + j * step - cz;
      const hl = hs[j * (N + 1) + Math.max(i - 1, 0)], hr = hs[j * (N + 1) + Math.min(i + 1, N)];
      const hu = hs[Math.max(j - 1, 0) * (N + 1) + i], hd = hs[Math.min(j + 1, N) * (N + 1) + i];
      const sx = (i > 0 && i < N ? 2 : 1) * step, sz = (j > 0 && j < N ? 2 : 1) * step;
      let nx = -(hr - hl) / sx, ny = 1, nz = -(hd - hu) / sz;
      const L = Math.hypot(nx, ny, nz);
      nx /= L; ny /= L; nz /= L;
      nor[k * 3] = nx * 127; nor[k * 3 + 1] = ny * 127; nor[k * 3 + 2] = nz * 127;
      uv[k * 2] = i / N;
      uv[k * 2 + 1] = j / N;
      // 대체 색: 높이·경사로 숲/논밭 느낌
      const slope = 1 - ny;
      const n1 = hash(Math.floor((b.x0 + i * step) / 37), Math.floor((b.z0 + j * step) / 37));
      const forest = Math.min(1, slope * 6 + (h > 120 ? 0.5 : 0) + n1 * 0.4);
      const r = 0.42 * (1 - forest) + 0.20 * forest, g = 0.50 * (1 - forest) + 0.34 * forest, bb = 0.30 * (1 - forest) + 0.17 * forest;
      const shade = 0.85 + n1 * 0.25;
      col[k * 3] = Math.min(255, r * shade * 255); col[k * 3 + 1] = Math.min(255, g * shade * 255); col[k * 3 + 2] = Math.min(255, bb * shade * 255);
    }
  }
  // 가장자리 치마(LOD 경계 틈 가리기)
  const skirt = Math.max(size * 0.015, 4);
  const edge = [];
  for (let i = 0; i < N; i++) edge.push(i);                          // 위 (j=0)
  for (let j = 0; j < N; j++) edge.push(j * (N + 1) + N);            // 오른쪽
  for (let i = N; i > 0; i--) edge.push(N * (N + 1) + i);            // 아래
  for (let j = N; j > 0; j--) edge.push(j * (N + 1));                // 왼쪽
  edge.forEach((k, e) => {
    const o = V + e;
    pos[o * 3] = pos[k * 3]; pos[o * 3 + 1] = pos[k * 3 + 1] - skirt; pos[o * 3 + 2] = pos[k * 3 + 2];
    nor[o * 3] = nor[k * 3]; nor[o * 3 + 1] = nor[k * 3 + 1]; nor[o * 3 + 2] = nor[k * 3 + 2];
    uv[o * 2] = uv[k * 2]; uv[o * 2 + 1] = uv[k * 2 + 1];
    col[o * 3] = col[k * 3]; col[o * 3 + 1] = col[k * 3 + 1]; col[o * 3 + 2] = col[k * 3 + 2];
  });
  const idx = new Uint16Array(N * N * 6 + edge.length * 6);
  let q = 0;
  for (let j = 0; j < N; j++) {
    for (let i = 0; i < N; i++) {
      const a = j * (N + 1) + i, bq = a + 1, c = a + N + 1, d = c + 1;
      // 대각선 방향을 번갈아 (지형 결이 덜 보이게)
      if ((i + j) & 1) { idx[q++] = a; idx[q++] = c; idx[q++] = bq; idx[q++] = bq; idx[q++] = c; idx[q++] = d; }
      else { idx[q++] = a; idx[q++] = c; idx[q++] = d; idx[q++] = a; idx[q++] = d; idx[q++] = bq; }
    }
  }
  for (let e = 0; e < edge.length; e++) {
    const k0 = edge[e], k1 = edge[(e + 1) % edge.length];
    const s0 = V + e, s1 = V + ((e + 1) % edge.length);
    idx[q++] = k0; idx[q++] = s0; idx[q++] = k1;
    idx[q++] = k1; idx[q++] = s0; idx[q++] = s1;
  }

  // 위성사진
  let img = null, imgInfo = null;
  const got = await imgP;
  if (got) {
    img = got.bmp;
    imgInfo = { iz: got.iz, ix: got.ix, iy: got.iy };
  }
  const transfer = [pos.buffer, nor.buffer, uv.buffer, col.buffer, idx.buffer];
  if (img) transfer.push(img);
  postMessage({ type: 'tile', id, z, x, y, cx, cz, pos, nor, uv, col, idx, img, imgInfo, minY, maxY, near, ms: performance.now() - tStart }, transfer);
}

// 나무 타일: 위성사진 픽셀로 숲을 찾아 나무 위치(지형 높이 포함)를 돌려줌
async function buildTrees(msg) {
  const { id, z, x, y, density = 0.6 } = msg;
  const b = tileBounds(z, x, y);
  const got = await fetchImagery(z, x, y);
  if (!got || got.iz < z - 1) { got?.bmp.close?.(); postMessage({ type: 'trees', id, trees: null }); return; }
  const px = readPixels(got.bmp);
  got.bmp.close?.();
  if (looksBlank(px)) { postMessage({ type: 'trees', id, trees: null }); return; }
  // 사진이 한 단계 낮으면 해당 1/4 영역만 씀
  let ox = 0, oy = 0, sc = 1;
  if (got.iz < z) { sc = 0.5; ox = (x & 1) * 0.5; oy = (y & 1) * 0.5; }
  const zE = DEM_MAX_Z;
  const t0 = worldToTile(b.x0, b.z0, zE), t1 = worldToTile(b.x1, b.z1, zE);
  const need = [];
  for (let tx = Math.floor(t0.tx - 0.01); tx <= Math.floor(t1.tx + 0.01); tx++) {
    for (let ty = Math.floor(t0.ty - 0.01); ty <= Math.floor(t1.ty + 0.01); ty++) need.push([tx, ty]);
  }
  const dems = await Promise.all(need.map(([tx, ty]) => getDem(zE, tx, ty)));
  const tiles = new Map();
  need.forEach(([tx, ty], i) => { if (dems[i]) tiles.set(tx * 65536 + ty, dems[i]); });
  const H = makeSampler(zE, tiles);
  const trees = pickTrees(px, b, H, density, ox, oy, sc);
  postMessage({ type: 'trees', id, trees }, [trees.buffer]);
}

// 위성사진에서 숲(초록·어두운 녹색) 픽셀을 골라 나무를 심음 (도로·램프 옆 제외)
function pickTrees(px, b, H, density, ox, oy, sc) {
  const size = b.size;
  const spacing = 6;
  const cnt = Math.floor(size / spacing);
  const outArr = [];
  const tmp = {};
  const bx = Math.round(b.x0), bz = Math.round(b.z0);
  for (let j = 0; j < cnt; j++) {
    for (let i = 0; i < cnt; i++) {
      const r1 = hash(i * 31 + bx, j * 17 + bz), r2 = hash(j * 7 + 3 + bx, i * 13 + bz);
      const u = (i + r1) / cnt, v = (j + r2) / cnt;
      const ix = Math.min(px.w - 1, Math.floor((ox + u * sc) * px.w)), iy = Math.min(px.h - 1, Math.floor((oy + v * sc) * px.h));
      const o = (iy * px.w + ix) * 4;
      const R = px.data[o], G = px.data[o + 1], B = px.data[o + 2];
      const lum = (R + G + B) / 3;
      // 숲: 초록이 가장 세고 어두운 편 (논·밭은 밝아서 빠짐)
      if (!(G >= R * 0.98 && G > B * 1.08 && lum < 105 && lum > 14)) continue;
      if (hash(i * 3 + 1 + bx, j * 5 + 2 + bz) > density) continue;
      const wx = b.x0 + u * size, wz = b.z0 + v * size;
      const h = corridor ? carve(wx, wz, H(wx, wz), tmp) : H(wx, wz);
      if (tmp.road || tmp.dist < 6) continue;
      const s = 0.7 + hash(ix + 5, iy * 3) * 0.7;
      const kind = hash(iy, ix * 11) < 0.55 ? 0 : 1; // 0 소나무, 1 활엽수
      outArr.push(wx, h - 0.2, wz, s, kind, R / 255, G / 255, B / 255);
    }
  }
  return new Float32Array(outArr);
}

// ───────── 메시지
const queue = [];
let running = 0;
const MAX_RUN = 6;
const cancelled = new Set();
function pump() {
  while (running < MAX_RUN && queue.length) {
    const msg = queue.shift();
    if (cancelled.has(msg.id)) { cancelled.delete(msg.id); continue; }
    running++;
    buildTile(msg).catch((e) => postMessage({ type: 'error', id: msg.id, kind: msg.kind, error: String(e) })).finally(() => { running--; pump(); });
  }
}

onmessage = (e) => {
  const m = e.data;
  if (m.type === 'init') {
    routes = m.routes.map((r) => new Route(r.name, r.n, r.spacing, r.buf));
    ramps = m.ramps.map((r) => ({ n: r.n, pts: new Float32Array(r.buf) }));
    imagery = m.imagery;
    buildCorridor();
    postMessage({ type: 'ready' });
  } else if (m.type === 'imagery') {
    imagery = m.imagery;
  } else if (m.type === 'tile') {
    queue.push(m);
    queue.sort((a, b) => a.pri - b.pri);
    pump();
  } else if (m.type === 'cancel') {
    const i = queue.findIndex((q) => q.id === m.id);
    if (i >= 0) queue.splice(i, 1);
  } else if (m.type === 'reprioritize') {
    const pri = new Map(m.list);
    for (const q of queue) if (pri.has(q.id)) q.pri = pri.get(q.id);
    queue.sort((a, b) => a.pri - b.pri);
  }
};
