// 特製模型：IKEA FORSÅ 工作燈（依使用者實物照片建模）。模型內部單位是公分，原點＝底座中心、桌面高度。
import * as THREE from 'three';

const D2R = Math.PI / 180;
export const SPAN = 17.5, LOWER = SPAN * 1.3, UPPER = SPAN; // 上臂約 1 個拇指到食指、下臂約 1.3 個
export const DEFAULT_POSE = { arm: 0, lower: 16, upper: 22, shade: 20, swivel: 0, pivot: 0, roll: 0 };
export const JOINTS = [
  ['arm', '手臂繞立柱旋轉（底座不動）', -180, 180],
  ['lower', '下臂（離垂直往後傾）', -35, 60],
  ['upper', '上臂（離水平往上）', -45, 70],
  ['shade', '燈頭上下擺頭（0°＝開口朝下）', -60, 110],
  ['swivel', '燈罩水平轉向', -180, 180],
  ['pivot', '燈座繞吊架螺絲傾斜（抓調整桿轉）', -110, 30],
  ['roll', '燈罩繞燈座旋轉', -120, 120],
];
// IKEA 出過的 FORSÅ 配色，加上使用者自己的舊燈
export const PALETTES = {
  mine:      { name: '我的燈（黑・舊）', swatch: '#0b0b0c', body: [0x0b0b0c, 0.2, 0.3],   knob: [0xc8b88e, 0.48, 0.85], spring: [0x8a5a38, 0.62, 0.55] },
  black:     { name: '黑色',     swatch: '#151516', body: [0x0b0b0c, 0.2, 0.3],   knob: [0xd8d8d6, 0.2, 1],     spring: [0xbdbdbb, 0.3, 1] },
  white:     { name: '白色',     swatch: '#efeee9', body: [0xefeee9, 0.35, 0.05], knob: [0xd8d8d6, 0.2, 1],     spring: [0xbdbdbb, 0.3, 1] },
  nickel:    { name: '鍍鎳',     swatch: '#cfd0cd', body: [0xcfd0cd, 0.22, 1],    knob: [0xe2e2e0, 0.16, 1],    spring: [0xbdbdbb, 0.3, 1] },
  brass:     { name: '黃銅色',   swatch: '#c6a468', body: [0xc6a468, 0.3, 1],     knob: [0xd9bc7c, 0.28, 1],    spring: [0xbdbdbb, 0.3, 1] },
  turquoise: { name: '土耳其藍', swatch: '#2f9e9a', body: [0x2f9e9a, 0.3, 0.1],   knob: [0xd8d8d6, 0.2, 1],     spring: [0xbdbdbb, 0.3, 1] },
};
export const FOOTPRINT = 150, HEIGHT = 360; // 物品庫用的外框（mm）：底座 Ø15、預設姿勢高約 36 cm

const mat = ([c, r, m], extra = {}) => new THREE.MeshStandardMaterial({ color: c, roughness: r, metalness: m, ...extra });

// 建一盞燈。withLight＝false 時只建骨架（給碰撞與 2D 投影計算用）
export function createForsa({ palette = 'mine', withLight = true } = {}) {
  const P = PALETTES[palette] || PALETTES.mine;
  const own = []; // 這盞燈自己的材質與幾何，丟掉時要釋放
  const keep = m => (own.push(m), m);
  const body = keep(mat(P.body, { envMapIntensity: 0.75 }));
  const chrome = keep(mat([0xdddddd, 0.16, 1], { envMapIntensity: 1.4 }));
  const brass = keep(mat(P.knob));
  const rust = keep(mat(P.spring, { envMapIntensity: 0.8 }));
  const dull = keep(mat([0x9a9893, 0.35, 0.9]));
  const inner = keep(mat([0xf1efe9, 0.6, 0]));
  const bulbMat = keep(new THREE.MeshStandardMaterial({ color: 0xfff3dc, emissive: 0xffdca0, emissiveIntensity: 1.6, roughness: 0.4 }));
  const cableMat = keep(mat([0x111111, 0.55, 0]));
  const white = keep(mat([0xeeebe4, 0.55, 0]));
  const M = (geo, m) => { own.push(geo); const o = new THREE.Mesh(geo, m); o.castShadow = true; o.receiveShadow = true; return o; };
  const knurl = (r, len, segs = 14) => { const k = M(new THREE.CylinderGeometry(r, r, len, segs), brass); k.rotation.x = Math.PI / 2; return k; };
  function spring(len, r, turns) {
    const pts = [];
    for (let i = 0; i <= turns * 16; i++) { const a = (i / 16) * Math.PI * 2; pts.push(new THREE.Vector3(Math.cos(a) * r, (i / (turns * 16)) * len, Math.sin(a) * r)); }
    return new THREE.TubeGeometry(new THREE.CatmullRomCurve3(pts), turns * 16, 0.1, 6, false);
  }

  const root = new THREE.Group();
  // 底座：Ø15 圓盤，上面微微隆起
  const baseProfile = [[0, 0], [7.3, 0], [7.5, 0.4], [7.45, 1.2], [7.0, 1.7], [5.5, 2.15], [3.0, 2.4], [1.4, 2.5], [0, 2.5]].map(([x, y]) => new THREE.Vector2(x, y));
  root.add(M(new THREE.LatheGeometry(baseProfile, 48), body));
  // 立柱在靠近底座邊緣處；立柱以上可以繞立柱旋轉
  const postGroup = new THREE.Group(); postGroup.position.x = -4.6; root.add(postGroup);
  const post = M(new THREE.CylinderGeometry(0.85, 0.95, 3.4, 20), chrome); post.position.y = 3.9; postGroup.add(post);
  const clevis = M(new THREE.BoxGeometry(1.6, 1.8, 3.4), body); clevis.position.y = 5.9; postGroup.add(clevis);

  // 下臂：三根扁桿（前面兩根並排、後面一根），兩條彈簧在前面兩根中間
  const LX = 0.9, LZ = 1.45;
  const pivotA = new THREE.Group(); pivotA.position.y = 6; postGroup.add(pivotA);
  for (const z of [-LZ, LZ]) { const bar = M(new THREE.BoxGeometry(0.95, LOWER, 0.35), body); bar.position.set(LX, LOWER / 2, z); pivotA.add(bar); }
  const backBar = M(new THREE.BoxGeometry(0.95, LOWER, 0.4), body); backBar.position.set(-LX, LOWER / 2, 0); pivotA.add(backBar);
  const frontPin = knurl(0.5, LZ * 2 + 1.0); frontPin.position.set(LX, 0, 0); pivotA.add(frontPin);
  const backPin = knurl(0.42, 1.4); backPin.position.set(-LX, 0, 0); pivotA.add(backPin);
  const tab = M(new THREE.BoxGeometry(1.2, 2.4, LZ * 2 - 0.5), body); tab.position.set(-0.2, 0.9, 0); pivotA.add(tab);
  const lowPinY = 1.9, topPinY = LOWER * 0.6;
  const crossPin = knurl(0.34, LZ * 2 + 0.3); crossPin.position.set(LX, topPinY, 0); pivotA.add(crossPin);
  for (const z of [-0.56, 0.56]) {
    const sp = M(spring(topPinY - lowPinY - 0.5, 0.48, 30), rust); sp.position.set(LX, lowPinY, z); pivotA.add(sp);
  }

  // 手肘＋上臂：兩根扁桿一上一下，兩條彈簧在左右外側
  const UY = 1.1;
  const elbow = new THREE.Group(); elbow.position.y = LOWER; pivotA.add(elbow);
  const plate = new THREE.Shape([new THREE.Vector2(-1.9, -1.9), new THREE.Vector2(2.2, -1.6), new THREE.Vector2(1.8, 2.0), new THREE.Vector2(-1.6, 1.8)]);
  for (const z of [-0.65, 0.65]) {
    const pl = M(new THREE.ExtrudeGeometry(plate, { depth: 0.25, bevelEnabled: false }), body); pl.position.z = z - 0.125; elbow.add(pl);
    const kn = knurl(0.62, 0.7); kn.position.z = z * 1.9; elbow.add(kn);
  }
  for (const y of [-UY, UY]) {
    const bar = M(new THREE.BoxGeometry(UPPER + 3, 0.9, 0.35), body); bar.position.set((UPPER - 3) / 2, y, 0); elbow.add(bar);
    const pin = knurl(0.3, 1.6, 12); pin.position.set(UPPER, y, 0); elbow.add(pin);
  }
  const upPinX = 8.8, upLowX = 1.4, SZ = 0.68;
  for (const x of [upLowX, upPinX]) { const p = knurl(0.28, SZ * 2 + 1.0, 12); p.position.set(x, 0, 0); elbow.add(p); }
  for (const z of [-SZ, SZ]) { const sp = M(spring(upPinX - upLowX - 0.6, 0.42, 22), rust); sp.rotation.z = -Math.PI / 2; sp.position.set(upLowX + 0.3, 0, z); elbow.add(sp); }

  // 燈頭：上臂末端關節（上下擺頭）→ 短立柱 → 倒 U 吊架（水平轉向）→ 吊架螺絲（燈座傾斜）→ 燈座＋燈罩（繞燈座旋轉）
  const head = new THREE.Group(); head.position.x = UPPER; elbow.add(head);
  for (const z of [-1, 1]) { const kn = knurl(0.62, 0.8); kn.position.z = z * 1.25; head.add(kn); }
  const hblock = M(new THREE.BoxGeometry(2.2, 2.6, 1.7), body); hblock.position.y = -0.3; head.add(hblock);
  const conn = M(new THREE.BoxGeometry(0.9, 1.0, 0.9), white); conn.position.y = -2.0; head.add(conn);
  const stem = M(new THREE.CylinderGeometry(0.26, 0.26, 1.4, 12), dull); stem.position.y = -3.2; head.add(stem);
  const swivel = new THREE.Group(); swivel.position.y = -3.9; head.add(swivel);
  const YR = 2.4, legLen = 1.9;
  const yk = [new THREE.Vector3(0, -YR - legLen, -YR), new THREE.Vector3(0, -YR - legLen * 0.5, -YR), new THREE.Vector3(0, -YR, -YR)];
  for (let i = 1; i < 12; i++) { const t = Math.PI * (i / 12); yk.push(new THREE.Vector3(0, -YR + Math.sin(t) * YR, -Math.cos(t) * YR)); }
  yk.push(new THREE.Vector3(0, -YR, YR), new THREE.Vector3(0, -YR - legLen * 0.5, YR), new THREE.Vector3(0, -YR - legLen, YR));
  swivel.add(M(new THREE.TubeGeometry(new THREE.CatmullRomCurve3(yk), 60, 0.2, 8, false), dull));
  const tilt = new THREE.Group(); tilt.position.y = -YR - legLen; swivel.add(tilt);
  for (const z of [-1, 1]) { const sc = knurl(0.36, 0.7, 10); sc.position.z = z * (YR + 0.3); tilt.add(sc); }
  const collar = M(new THREE.CylinderGeometry(1.98, 1.98, 1.1, 28), body); collar.rotation.z = Math.PI / 2; tilt.add(collar);
  const roll = new THREE.Group(); tilt.add(roll);
  const socket = M(new THREE.CylinderGeometry(1.75, 1.75, 4.2, 28), body); socket.rotation.z = Math.PI / 2; socket.position.x = 0.1; roll.add(socket);
  // 半球外殼（開口朝下）：燈座從側邊接入
  const RIM_R = 6.15, RIM_Y = -6.5, JOIN_Y = -3.2;
  const joinX = Math.sin(Math.acos((6.3 + JOIN_Y) / 6.3)) * 6;
  const shade = new THREE.Group(); shade.position.set(2.2 + joinX, -JOIN_Y, 0); roll.add(shade);
  const dome = [];
  for (let i = 0; i <= 24; i++) { const a = (i / 24) * (Math.PI / 2); dome.push(new THREE.Vector2(Math.sin(a) * 6, Math.cos(a) * 6.3 - 6.3)); }
  dome.push(new THREE.Vector2(RIM_R, RIM_Y));
  const shadeOuter = keep(body.clone()); shadeOuter.side = THREE.DoubleSide; shadeOuter.shadowSide = THREE.DoubleSide; // 燈罩要真的擋光
  shade.add(M(new THREE.LatheGeometry([...dome].reverse(), 48), shadeOuter));
  const domeInG = new THREE.LatheGeometry(dome.map(v => new THREE.Vector2(v.x * 0.96, v.y * 0.98 - 0.15)), 48); own.push(domeInG);
  shade.add(new THREE.Mesh(domeInG, inner));
  const BULB = new THREE.Vector3(-joinX + 2.4, JOIN_Y, 0);
  const bulbGeo = new THREE.SphereGeometry(0.9, 20, 14); bulbGeo.scale(1.8, 1, 1); own.push(bulbGeo);
  const bulb = new THREE.Mesh(bulbGeo, bulbMat); bulb.position.copy(BULB); shade.add(bulb);
  // 調整桿：燈座與燈罩交接處的鍍鉻環上，垂直往外伸
  const ring = M(new THREE.CylinderGeometry(1.82, 1.82, 0.5, 28), chrome); ring.rotation.z = Math.PI / 2; ring.position.x = 1.95; roll.add(ring);
  const adj = new THREE.Group(); adj.position.set(1.75, -1.8, 0); roll.add(adj);
  const nut = M(new THREE.CylinderGeometry(0.4, 0.4, 0.55, 6), body); nut.position.y = -0.15; adj.add(nut);
  const rod = M(new THREE.CylinderGeometry(0.15, 0.15, 7, 10), brass); rod.position.y = -3.8; adj.add(rod);
  const tipGeo = new THREE.SphereGeometry(0.48, 12, 8); tipGeo.scale(1, 0.85, 1);
  const tip = M(tipGeo, brass); tip.position.y = -7.4; adj.add(tip);

  // 燈光（房間場景以公尺為單位、燈以公分建模，外層會縮放 0.01；光的距離與陰影範圍用公尺設定）
  let spot = null, glow = null;
  if (withLight) {
    spot = new THREE.SpotLight(0xffdcae, 1.4, 0, 1.22, 0.12, 2);
    spot.castShadow = true;
    spot.shadow.mapSize.set(1024, 1024);
    spot.shadow.camera.near = 0.004; spot.shadow.camera.far = 8;
    spot.shadow.bias = -0.0004;
    spot.position.copy(BULB);
    shade.add(spot);
    const target = new THREE.Object3D(); target.position.set(1.5, -20, 0); shade.add(target);
    spot.target = target;
    glow = new THREE.PointLight(0xffd9a6, 0.02, 0.08, 2); glow.position.copy(BULB); shade.add(glow);
  }

  // 電線：外露三小段（燈頭上方、手肘、底部），其餘穿在手臂裡
  let cable = null;
  function updateCable() {
    root.updateMatrixWorld(true);
    const inv = new THREE.Matrix4().copy(root.matrixWorld).invert();
    const w = (o, x, y, z) => o.localToWorld(new THREE.Vector3(x, y, z)).applyMatrix4(inv);
    const pts = [
      w(roll, -2.1, 0.7, 0), w(roll, -3.0, 1.9, 0), w(head, -0.4, 2.6, 0), w(elbow, UPPER - 0.6, 1.9, 0),
      w(elbow, UPPER - 2.2, 0.45, 0), w(elbow, UPPER * 0.5, 0.45, 0), w(elbow, 2.4, 0.45, 0),
      w(elbow, 0.6, 1.9, 0), w(elbow, -1.0, 1.6, 0),
      w(pivotA, 0, LOWER - 1.4, 0), w(pivotA, 0, LOWER * 0.5, 0), w(pivotA, 0, 2.6, 0),
      w(postGroup, -1.3, 3.4, 1.1), w(postGroup, -2.6, 2.6, 1.8), w(postGroup, -3.6, 2.3, 2.4),
      new THREE.Vector3(-9.3, 0.45, 3.4), new THREE.Vector3(-14, 0.45, 4.6), new THREE.Vector3(-18, 0.45, 5), // 只畫一小段，免得燈靠桌緣時電線懸空
    ];
    if (cable) { root.remove(cable); cable.geometry.dispose(); }
    cable = new THREE.Mesh(new THREE.TubeGeometry(new THREE.CatmullRomCurve3(pts, false, 'catmullrom', 0.35), 160, 0.22, 8, false), cableMat);
    cable.castShadow = true;
    root.add(cable);
  }

  function setPose(p) {
    postGroup.rotation.y = p.arm * D2R;
    pivotA.rotation.z = p.lower * D2R;
    elbow.rotation.z = (p.upper - p.lower) * D2R;
    head.rotation.z = (p.shade - p.upper) * D2R;
    swivel.rotation.y = p.swivel * D2R;
    tilt.rotation.z = p.pivot * D2R;
    roll.rotation.x = p.roll * D2R;
    if (withLight) updateCable();
  }
  function setLight(on) {
    if (spot) spot.intensity = on ? 1.4 : 0;
    if (glow) glow.intensity = on ? 0.02 : 0;
    bulbMat.emissiveIntensity = on ? 1.6 : 0;
  }

  // ---------- 碰撞（在燈自己的座標系裡算）----------
  const samples = [];
  for (let i = 0; i < 16; i++) { const a = (i / 16) * Math.PI * 2; samples.push([shade, new THREE.Vector3(Math.cos(a) * RIM_R, RIM_Y, Math.sin(a) * RIM_R)]); }
  for (let i = 0; i < 12; i++) { const a = (i / 12) * Math.PI * 2; samples.push([shade, new THREE.Vector3(Math.cos(a) * 4.6, -2.2, Math.sin(a) * 4.6)]); }
  samples.push([shade, new THREE.Vector3(0, 0, 0)], [shade, new THREE.Vector3(0, -4, 0)]);
  for (let i = 1; i <= 5; i++) samples.push([adj, new THREE.Vector3(0, -1.5 * i, 0)]);
  for (const v of [[-2, 0, 0], [0, -1.8, 0], [0, 1.8, 0], [2.2, 0, 1.6], [2.2, 0, -1.6]]) samples.push([roll, new THREE.Vector3(...v)]);
  for (const z of [-1, 1]) samples.push([tilt, new THREE.Vector3(0, 0, z * YR)]);
  const armPts = [];
  for (let i = 3; i <= 10; i++) armPts.push([elbow, new THREE.Vector3((UPPER * i) / 10, 0, 0)]);
  const segDist = (p, a, b) => { const ab = b.clone().sub(a), t = Math.max(0, Math.min(1, p.clone().sub(a).dot(ab) / ab.lengthSq())); return p.distanceTo(a.clone().addScaledVector(ab, t)); };
  function collides() {
    root.updateMatrixWorld(true);
    const inv = new THREE.Matrix4().copy(root.matrixWorld).invert();
    const L = (o, v) => o.localToWorld(v.clone()).applyMatrix4(inv);
    const L0 = L(pivotA, new THREE.Vector3()), L1 = L(pivotA, new THREE.Vector3(0, LOWER, 0));
    const U0 = L(elbow, new THREE.Vector3()), U1 = L(elbow, new THREE.Vector3(UPPER - 1.2, 0, 0));
    const underBase = p => p.y < 0.3 || (p.y < 3 && Math.hypot(p.x, p.z) < 7.7);
    for (const [o, v] of samples) { const p = L(o, v); if (underBase(p) || segDist(p, L0, L1) < 2.0 || segDist(p, U0, U1) < 1.6) return true; }
    for (const [o, v] of armPts) { const p = L(o, v); if (underBase(p) || segDist(p, L0, L1.clone().lerp(L0, 0.12)) < 2.2) return true; }
    return false;
  }
  // 平面圖用：立柱、手肘、燈頭、燈罩中心在燈座標系的位置（cm）
  function planPoints() {
    root.updateMatrixWorld(true);
    const inv = new THREE.Matrix4().copy(root.matrixWorld).invert();
    const L = (o, v) => o.localToWorld(v.clone()).applyMatrix4(inv);
    return { post: L(postGroup, new THREE.Vector3(0, 6, 0)), elbow: L(elbow, new THREE.Vector3()), head: L(head, new THREE.Vector3()), shade: L(shade, new THREE.Vector3(0, -3, 0)) };
  }
  function dispose() { for (const o of own) o.dispose?.(); if (cable) cable.geometry.dispose(); }

  setPose(DEFAULT_POSE);
  return { root, setPose, setLight, collides, planPoints, dispose, pickables: root };
}

// 共用的探針燈：用來算碰撞極限與平面圖投影，不畫出來
let probe = null;
const getProbe = () => (probe ||= createForsa({ withLight: false }));
export const fullPose = p => ({ ...DEFAULT_POSE, ...(p || {}) });

// 把某個關節往目標角度轉，碰到就停在碰撞前的角度
export function clampJoint(pose, key, target) {
  const pr = getProbe(), p = fullPose(pose);
  const step = Math.sign(target - p[key]);
  let ok = p[key];
  for (let v = p[key] + step; step && (step > 0 ? v <= target : v >= target); v += step) {
    pr.setPose({ ...p, [key]: v });
    if (pr.collides()) break;
    ok = v;
  }
  return ok;
}
export function planGeom(pose) {
  const pr = getProbe();
  pr.setPose(fullPose(pose));
  return pr.planPoints();
}
