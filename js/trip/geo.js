// 좌표계: 웹 메르카토르(지도 타일과 같은 투영)를 경로 가운데 위도의 축척으로 줄인 평면 (단위 m)
// 월드 x = 동쪽, 월드 -z = 북쪽, y = 해발고도. tools/build_trip_data.py와 같은 식을 씀.
export const R_EARTH = 6378137;
export const LON0 = 128.0;
export const LAT0 = 36.4;
export const K = Math.cos((LAT0 * Math.PI) / 180);
const MX0 = R_EARTH * ((LON0 * Math.PI) / 180);
const MY0 = R_EARTH * Math.log(Math.tan(Math.PI / 4 + (LAT0 * Math.PI) / 360));
const HALF = Math.PI * R_EARTH; // 메르카토르 세계 절반 폭
const WORLD = 2 * HALF;

export function toWorld(lon, lat) {
  const mx = R_EARTH * ((lon * Math.PI) / 180);
  const my = R_EARTH * Math.log(Math.tan(Math.PI / 4 + (lat * Math.PI) / 360));
  return { x: (mx - MX0) * K, z: -(my - MY0) * K };
}

export function toLonLat(x, z) {
  const mx = x / K + MX0;
  const my = -z / K + MY0;
  return {
    lon: ((mx / R_EARTH) * 180) / Math.PI,
    lat: ((2 * Math.atan(Math.exp(my / R_EARTH)) - Math.PI / 2) * 180) / Math.PI,
  };
}

// 타일(z, tx, ty)의 월드 범위. z0 = 북쪽 가장자리(작은 z)
export function tileBounds(z, tx, ty) {
  const W = WORLD / 2 ** z;
  const mx0 = -HALF + tx * W;
  const my0 = HALF - ty * W;
  const x0 = (mx0 - MX0) * K;
  const x1 = (mx0 + W - MX0) * K;
  const z0 = -(my0 - MY0) * K;
  const z1 = -(my0 - W - MY0) * K;
  return { x0, x1, z0, z1, size: W * K };
}

// 월드 좌표 → 타일 좌표(실수)
export function worldToTile(x, z, zoom) {
  const n = 2 ** zoom;
  const mx = x / K + MX0;
  const my = -z / K + MY0;
  return { tx: ((mx + HALF) / WORLD) * n, ty: ((HALF - my) / WORLD) * n };
}

export function tileSize(z) {
  return (WORLD / 2 ** z) * K;
}
