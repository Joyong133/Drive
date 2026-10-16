// 하늘·해·구름·안개·빛: 실제 날짜와 시각, 차의 위도·경도로 해 위치를 계산
import * as THREE from 'three';

const RAD = Math.PI / 180;

// 해의 고도/방위 (NOAA 간이식). 방위는 북쪽에서 시계 방향
export function sunPosition(date, lat, lon) {
  const d = date.getTime() / 86400000 - 10957.5; // J2000 기준 일수
  const g = ((357.529 + 0.98560028 * d) % 360) * RAD;
  const q = (280.459 + 0.98564736 * d) % 360;
  const L = (q + 1.915 * Math.sin(g) + 0.02 * Math.sin(2 * g)) * RAD;
  const e = (23.439 - 0.00000036 * d) * RAD;
  const ra = Math.atan2(Math.cos(e) * Math.sin(L), Math.cos(L));
  const dec = Math.asin(Math.sin(e) * Math.sin(L));
  const gmst = (18.697374558 + 24.06570982441908 * d) % 24;
  const ha = (gmst * 15 + lon) * RAD - ra;
  const la = lat * RAD;
  const alt = Math.asin(Math.sin(la) * Math.sin(dec) + Math.cos(la) * Math.cos(dec) * Math.cos(ha));
  const az = Math.atan2(-Math.sin(ha), Math.tan(dec) * Math.cos(la) - Math.sin(la) * Math.cos(ha));
  return { alt, az };
}

// 반복되는 구름 무늬 (fbm) — 한 번만 만들어 텍스처로
function cloudTexture(size = 512) {
  const c = document.createElement('canvas');
  c.width = c.height = size;
  const g = c.getContext('2d');
  const img = g.createImageData(size, size);
  const grid = (n, seed) => {
    const a = new Float32Array(n * n);
    let s = seed;
    for (let i = 0; i < a.length; i++) { s = (s * 16807) % 2147483647; a[i] = s / 2147483647; }
    return a;
  };
  const oct = [[8, 0.5, 11], [16, 0.25, 23], [32, 0.14, 37], [64, 0.08, 53], [128, 0.04, 71]];
  const grids = oct.map(([n, , seed]) => grid(n, seed));
  const val = (x, y, n, a) => {
    const fx = (x / size) * n, fy = (y / size) * n;
    const x0 = Math.floor(fx), y0 = Math.floor(fy);
    const tx = fx - x0, ty = fy - y0;
    const sx = tx * tx * (3 - 2 * tx), sy = ty * ty * (3 - 2 * ty);
    const at = (i, j) => a[((j % n + n) % n) * n + ((i % n + n) % n)];
    return (at(x0, y0) * (1 - sx) + at(x0 + 1, y0) * sx) * (1 - sy) + (at(x0, y0 + 1) * (1 - sx) + at(x0 + 1, y0 + 1) * sx) * sy;
  };
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let v = 0;
      oct.forEach(([n, amp], k) => { v += val(x, y, n, grids[k]) * amp; });
      v = v / 1.01;
      const o = (y * size + x) * 4;
      img.data[o] = img.data[o + 1] = img.data[o + 2] = Math.max(0, Math.min(255, v * 255));
      img.data[o + 3] = 255;
    }
  }
  g.putImageData(img, 0, 0);
  const t = new THREE.CanvasTexture(c);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.colorSpace = THREE.NoColorSpace;
  return t;
}

const SKY_VERT = /* glsl */`
  varying vec3 vDir;
  void main() {
    vDir = normalize((modelMatrix * vec4(position, 0.0)).xyz);
    vec4 p = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
    gl_Position = p.xyww; // 항상 가장 먼 곳
  }
`;

const SKY_FRAG = /* glsl */`
  uniform vec3 zenith;
  uniform vec3 horizon;
  uniform vec3 ground;
  uniform vec3 sunDir;
  uniform vec3 sunGlow;
  uniform float cover;
  uniform float cloudLight;
  uniform vec2 wind;
  uniform sampler2D clouds;
  varying vec3 vDir;
  void main() {
    vec3 d = normalize(vDir);
    float h = d.y;
    vec3 col = mix(horizon, zenith, pow(clamp(h, 0.0, 1.0), 0.55));
    col = mix(col, ground, smoothstep(0.0, -0.06, h));
    float mu = max(dot(d, sunDir), 0.0);
    col += sunGlow * (pow(mu, 8.0) * 0.35 + pow(mu, 64.0) * 0.6);
    // 해
    col += sunGlow * smoothstep(0.9995, 0.99975, mu) * 6.0;
    // 구름 (평면에 투영)
    if (h > 0.0) {
      vec2 uv = d.xz / (h + 0.08) * 0.22 + wind;
      float n = texture2D(clouds, uv).r * 0.65 + texture2D(clouds, uv * 2.7 + 0.3).r * 0.35;
      float c = smoothstep(1.0 - cover, 1.0 - cover + 0.32, n) * smoothstep(0.0, 0.18, h);
      vec3 cc = mix(horizon, vec3(1.0), 0.5) * cloudLight + sunGlow * pow(mu, 4.0) * 0.25;
      col = mix(col, cc, c * 0.92);
    }
    gl_FragColor = vec4(col, 1.0);
    #include <colorspace_fragment>
  }
`;

const lerpC = (a, b, t) => a.clone().lerp(b, t);

export class Sky {
  constructor(scene, terrainShared, { haze = 'normal', clouds = 0.35 } = {}) {
    this.scene = scene;
    this.shared = terrainShared;
    this.uniforms = {
      zenith: { value: new THREE.Color() },
      horizon: { value: new THREE.Color() },
      ground: { value: new THREE.Color() },
      sunDir: { value: new THREE.Vector3(0, 1, 0) },
      sunGlow: { value: new THREE.Color() },
      cover: { value: clouds },
      cloudLight: { value: 1 },
      wind: { value: new THREE.Vector2() },
      clouds: { value: cloudTexture() },
    };
    const mat = new THREE.ShaderMaterial({
      vertexShader: SKY_VERT, fragmentShader: SKY_FRAG, uniforms: this.uniforms,
      side: THREE.BackSide, depthWrite: false, depthTest: true, fog: false,
    });
    this.mesh = new THREE.Mesh(new THREE.SphereGeometry(1000, 32, 16), mat);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = -10;
    scene.add(this.mesh);
    this.sun = new THREE.DirectionalLight(0xffffff, 2);
    this.sun.position.set(0, 1, 0);
    scene.add(this.sun);
    scene.add(this.sun.target);
    this.hemi = new THREE.HemisphereLight(0xbcd4ff, 0x5a5a48, 1);
    scene.add(this.hemi);
    this.fog = new THREE.FogExp2(0xc9d6e2, 3e-5);
    scene.fog = this.fog;
    this.setHaze(haze);
    this.tunnel = 0;
    this.info = { alt: 0, az: 0 };
  }

  setHaze(h) {
    // 시정: 맑음 60 km, 보통 30 km, 뿌옇게 15 km
    this.hazeDensity = { clear: 1.6e-5, normal: 2.8e-5, hazy: 5.2e-5 }[h] || 2.8e-5;
    this.hazeKey = h;
  }

  setClouds(v) { this.uniforms.cover.value = v; }

  // date: 실제 시각(Date), lon/lat: 차 위치, cam: 카메라 위치(하늘 구 중심)
  update(date, lat, lon, cam, dt, inTunnel = 0) {
    const { alt, az } = sunPosition(date, lat, lon);
    this.info.alt = alt; this.info.az = az;
    const dir = new THREE.Vector3(Math.sin(az) * Math.cos(alt), Math.sin(alt), -Math.cos(az) * Math.cos(alt));
    const u = this.uniforms;
    u.sunDir.value.copy(dir);
    const e = alt / RAD; // 해 고도(도)
    const day = THREE.MathUtils.smoothstep(e, -6, 12);
    const golden = 1 - THREE.MathUtils.smoothstep(Math.abs(e - 3), 0, 14);
    const night = 1 - THREE.MathUtils.smoothstep(e, -14, -3);
    // 색 (sRGB로 정한 뒤 선형으로)
    const S = (hex) => new THREE.Color(hex);
    const zen = lerpC(lerpC(S(0x0b1430), S(0x3d6fb8), day), S(0x4a6aa0), golden * 0.4);
    const hazeAmt = this.hazeKey === 'hazy' ? 0.55 : this.hazeKey === 'clear' ? 0.1 : 0.3;
    let hor = lerpC(lerpC(S(0x1a2238), S(0xb9cde0), day), S(0xe7a76a), golden * 0.7);
    hor = lerpC(hor, lerpC(S(0x1a1d26), S(0xd9dcd8), day), hazeAmt);
    u.zenith.value.copy(zen);
    u.horizon.value.copy(hor);
    u.ground.value.copy(lerpC(hor, S(0x404840), 0.5));
    u.sunGlow.value.copy(lerpC(S(0x000000), lerpC(S(0xfff2d8), S(0xffa050), golden), Math.min(1, day + golden)));
    u.cloudLight.value = 0.15 + 0.85 * day;
    u.wind.value.x += dt * 0.0016;
    u.wind.value.y += dt * 0.0007;
    this.mesh.position.copy(cam);
    // 안개 = 지평선 색
    this.fog.color.copy(hor);
    this.fog.density = this.hazeDensity * (1 + night * 0.5);
    // 빛: Lambert 재질용(π배) + 지형/도로 셰이더용
    const sunI = Math.max(0, Math.sin(alt)) ** 0.6 * day;
    const sunC = lerpC(S(0xffffff), S(0xffb070), golden).multiplyScalar(sunI);
    const ambC = lerpC(S(0x0d1220), lerpC(S(0x9fb3cc), S(0xd2b8a0), golden * 0.5), Math.max(day, 0.02));
    const ambI = 0.06 + 0.94 * day;
    // 터널 안: 해는 꺼지고 따뜻한 조명
    const t = inTunnel;
    const tunC = S(0xffd9a8);
    this.sun.color.copy(sunC).multiplyScalar(1 - t);
    this.sun.intensity = Math.PI * 1.15;
    this.sun.position.copy(cam).addScaledVector(dir, 1000);
    this.sun.target.position.copy(cam);
    this.hemi.color.copy(ambC).lerp(tunC, t);
    this.hemi.groundColor.copy(ambC).multiplyScalar(0.55).lerp(tunC.clone().multiplyScalar(0.6), t);
    this.hemi.intensity = Math.PI * (ambI * 0.75 * (1 - t) + 0.55 * t);
    // 사진 지형: 그림자가 이미 찍혀 있으므로 대부분 주변광
    this.shared.sunDir.value.copy(dir);
    this.shared.sunCol.value.copy(sunC).multiplyScalar(0.32);
    this.shared.ambCol.value.copy(lerpC(S(0x10141c), S(0xe8ecf2), Math.max(day, 0.03))).multiplyScalar(0.62 + 0.4 * day);
    return { alt, day, night };
  }
}
