// 3D 檢視：環繞（看整體）與走動（第一人稱）。只負責「看」，擺放在 2D 做。
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { S, P, L, lib, isRug, isRound, isWall, getImg } from './state.js';
import { buildRoom, wallEdges } from './geom.js';
import { V, pointInPoly, segDist, clamp } from './util.js';

const M = 0.001; // mm → m
const BODY_R = 180; // 走動時身體半徑（mm）

// 平面多邊形 → 網格；map 把 (u,v) 轉成 3D，want 指定法線方向
function planar(contour, map, want, uvScale = [M, M], holes = []) {
  const pts = contour.map(([u, v]) => new THREE.Vector2(u, v));
  const hs = holes.map(h => h.map(([u, v]) => new THREE.Vector2(u, v)));
  const tris = THREE.ShapeUtils.triangulateShape(pts, hs);
  const pos = [], uv = [];
  for (const q of [...pts, ...hs.flat()]) { pos.push(...map(q.x, q.y)); uv.push(q.x * uvScale[0], q.y * uvScale[1]); }
  const idx = [];
  for (const t of tris) idx.push(t[0], t[1], t[2]);
  if (idx.length >= 3) {
    const g = i => new THREE.Vector3(pos[i * 3], pos[i * 3 + 1], pos[i * 3 + 2]);
    const a = g(idx[0]), b = g(idx[1]), c = g(idx[2]);
    const n = b.clone().sub(a).cross(c.clone().sub(a));
    if (n.dot(want) < 0) for (let i = 0; i < idx.length; i += 3) [idx[i + 1], idx[i + 2]] = [idx[i + 2], idx[i + 1]];
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  geo.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  geo.setIndex(idx);
  geo.computeVertexNormals();
  return geo;
}

function dedupe(c) {
  return c.filter((q, i) => { const p = c[(i - 1 + c.length) % c.length]; return Math.abs(q[0] - p[0]) > 0.5 || Math.abs(q[1] - p[1]) > 0.5; });
}

export class View3D {
  constructor(el, ui) {
    this.el = el; this.ui = ui;
    const r = (this.renderer = new THREE.WebGLRenderer({ antialias: true }));
    r.setPixelRatio(Math.min(devicePixelRatio, 2));
    r.shadowMap.enabled = true;
    r.shadowMap.type = THREE.PCFSoftShadowMap;
    r.outputColorSpace = THREE.SRGBColorSpace;
    r.toneMapping = THREE.ACESFilmicToneMapping;
    r.toneMappingExposure = 1.05;
    r.domElement.style.touchAction = 'none';
    el.appendChild(r.domElement);

    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color('#dde3e4');
    this.camera = new THREE.PerspectiveCamera(50, 1, 0.03, 200);
    this.camera.rotation.order = 'YXZ';
    this.controls = new OrbitControls(this.camera, r.domElement);
    this.controls.enableDamping = true;
    this.controls.maxPolarAngle = Math.PI * 0.49;

    this.scene.add(new THREE.HemisphereLight(0xffffff, 0x8f7f6a, 1.2));
    this.scene.add(new THREE.AmbientLight(0xffffff, 0.25));
    const sun = (this.sun = new THREE.DirectionalLight(0xfff3e2, 1.5));
    sun.castShadow = true;
    sun.shadow.mapSize.set(2048, 2048);
    sun.shadow.bias = -0.0004;
    sun.shadow.normalBias = 0.02;
    this.scene.add(sun, sun.target);

    this.group = new THREE.Group();
    this.scene.add(this.group);
    this.disposables = [];
    this.texCache = new Map();
    this.mode = 'orbit';
    this.keys = new Set();
    this.yaw = 0; this.pitch = 0; this.px = 0; this.pz = 0;
    this.eye = (S.settings.stature - 110) * M;
    this.joy = { x: 0, y: 0 };
    this.dirty = true; this.active = false; this.framed = false;
    this.clock = new THREE.Clock();
    new ResizeObserver(() => this.resize()).observe(el);
    this.bindWalk();
  }

  show(on) {
    this.active = on;
    if (!on) { if (document.pointerLockElement) document.exitPointerLock(); return; }
    this.resize();
    if (this.dirty) this.rebuild();
    this.clock.getDelta();
    requestAnimationFrame(this.loop);
  }
  markDirty() { this.dirty = true; if (this.active) this.rebuild(); }

  resize() {
    const w = this.el.clientWidth, h = this.el.clientHeight;
    if (!w || !h) return;
    this.renderer.setSize(w, h);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
  }

  loop = () => {
    if (!this.active) return;
    requestAnimationFrame(this.loop);
    const dt = Math.min(this.clock.getDelta(), 0.05);
    this.update(dt);
    this.renderer.render(this.scene, this.camera);
  };

  // ---------- 材質 ----------
  baseTex(id, img) {
    let t = this.texCache.get(id);
    if (t && t.image === img) return t;
    t = new THREE.Texture(img);
    t.colorSpace = THREE.SRGBColorSpace;
    t.anisotropy = 8;
    t.needsUpdate = true;
    this.texCache.set(id, t);
    return t;
  }
  tiled(id, img, rx, ry) {
    const t = this.baseTex(id, img).clone();
    t.wrapS = t.wrapT = THREE.RepeatWrapping;
    t.repeat.set(rx, ry);
    t.needsUpdate = true;
    this.disposables.push(t);
    return t;
  }
  mat(li, face, fw, fh) {
    const img = li.tex && li.texMode && li.texMode !== 'none' ? getImg(li.tex) : null;
    let map = null;
    if (img && li.texMode === 'fit' && face === 'top') map = this.baseTex(li.tex, img);
    else if (img && li.texMode === 'tile' && face !== 'bottom') map = this.tiled(li.tex, img, fw / (li.tileW || 300), fh / (li.tileH || 300));
    const m = new THREE.MeshStandardMaterial({ color: map ? 0xffffff : new THREE.Color(li.color || '#cbbfae'), map, roughness: isRug(li) ? 0.95 : 0.72 });
    this.disposables.push(m);
    return m;
  }

  // ---------- 建立場景 ----------
  clear() {
    for (const o of [...this.group.children]) {
      o.traverse(c => { if (c.geometry) c.geometry.dispose(); });
      this.group.remove(o);
    }
    for (const d of this.disposables) d.dispose();
    this.disposables = [];
  }

  rebuild() {
    this.clear();
    this.dirty = false;
    const p = P();
    if (!p) return;
    const lay = L(p);
    const room = p.room;
    const poly = buildRoom(room).poly;
    const walls = wallEdges(poly);
    const H = room.height;
    const xs = poly.map(q => q.x), ys = poly.map(q => q.y);
    const b = { x0: Math.min(...xs), x1: Math.max(...xs), y0: Math.min(...ys), y1: Math.max(...ys) };
    b.cx = ((b.x0 + b.x1) / 2) * M; b.cz = ((b.y0 + b.y1) / 2) * M;
    b.sx = (b.x1 - b.x0) * M; b.sz = (b.y1 - b.y0) * M;
    this.bounds = b;
    const contour = poly.map(q => [q.x, q.y]);

    // 地板
    const fImg = room.floorTex ? getImg(room.floorTex) : null;
    let fMap = null;
    if (fImg) { fMap = this.tiled(room.floorTex, fImg, 1, 1); }
    const ft = room.floorTile || 300;
    const floorMat = new THREE.MeshStandardMaterial({ color: fMap ? 0xffffff : new THREE.Color(room.floorColor), map: fMap, roughness: 0.8 });
    this.disposables.push(floorMat);
    const floor = new THREE.Mesh(planar(contour, (u, v) => [u * M, 0, v * M], new THREE.Vector3(0, 1, 0), [1 / ft, 1 / ft]), floorMat);
    floor.receiveShadow = true;
    this.group.add(floor);

    // 天花板（只朝下，從上方環繞時自動看穿）
    const ceilMat = new THREE.MeshStandardMaterial({ color: '#f7f5f1', roughness: 0.95 });
    this.disposables.push(ceilMat);
    const ceil = new THREE.Mesh(planar(contour, (u, v) => [u * M, H * M, v * M], new THREE.Vector3(0, -1, 0)), ceilMat);
    this.group.add(ceil);

    // 牆：單面朝內的平面，從外面看會自動透明（像娃娃屋）
    const wallMat = new THREE.MeshStandardMaterial({ color: new THREE.Color(room.wallColor), roughness: 0.92 });
    const capMat = new THREE.MeshStandardMaterial({ color: '#4a443e', roughness: 0.8 });
    const frameMat = new THREE.MeshStandardMaterial({ color: '#8b7b6b', roughness: 0.7 });
    const winMat = new THREE.MeshStandardMaterial({ color: '#f3f1ec', roughness: 0.6 });
    const glassMat = new THREE.MeshStandardMaterial({ color: '#cfe3ec', transparent: true, opacity: 0.22, roughness: 0.1, side: THREE.DoubleSide, depthWrite: false });
    this.disposables.push(wallMat, capMat, frameMat, winMat, glassMat);
    walls.forEach((w, i) => {
      const doors = (room.doors || []).filter(d => d.wall === i).sort((a, c) => a.off - c.off);
      const c = [[0, 0]];
      for (const d of doors) {
        const s = clamp(d.off, 0, w.len), e = clamp(d.off + d.w, 0, w.len), dh = Math.min(d.h, H - 20);
        c.push([s, 0], [s, dh], [e, dh], [e, 0]);
      }
      c.push([w.len, 0], [w.len, H], [0, H]);
      const map = (u, v) => [(w.a.x + w.u.x * u) * M, v * M, (w.a.y + w.u.y * u) * M];
      // 窗戶＝牆上的洞（夾在牆內，不碰到牆邊）
      const wins = (room.windows || []).filter(x => x.wall === i).map(x => {
        const u0 = clamp(x.off, 5, w.len - 5), u1 = clamp(x.off + x.w, 5, w.len - 5);
        const v0 = clamp(x.sill, 5, H - 5), v1 = clamp(x.sill + x.h, 5, H - 5);
        return { u0, u1, v0, v1 };
      }).filter(x => x.u1 - x.u0 > 10 && x.v1 - x.v0 > 10);
      const holes = wins.map(x => [[x.u0, x.v0], [x.u1, x.v0], [x.u1, x.v1], [x.u0, x.v1]]);
      const mesh = new THREE.Mesh(planar(dedupe(c), map, new THREE.Vector3(w.n.x, 0, w.n.y), [M, M], holes), wallMat);
      mesh.receiveShadow = true;
      this.group.add(mesh);
      // 牆頂壓條：讓俯視時看得出牆的輪廓
      const cap = new THREE.Mesh(new THREE.BoxGeometry(w.len * M + 0.1, 0.03, 0.1), capMat);
      const mid = V.add(w.mid, V.scale(w.n, -50));
      cap.position.set(mid.x * M, H * M + 0.015, mid.y * M);
      cap.rotation.y = -Math.atan2(w.u.y, w.u.x);
      this.group.add(cap);
      // 窗框與玻璃
      for (const x of wins) {
        const add = (u, len, hgt, v) => {
          const fr = new THREE.Mesh(new THREE.BoxGeometry(len * M, hgt * M, 0.12), winMat);
          const pt = V.add(V.add(w.a, V.scale(w.u, u)), V.scale(w.n, -40));
          fr.position.set(pt.x * M, v * M, pt.y * M);
          fr.rotation.y = -Math.atan2(w.u.y, w.u.x);
          this.group.add(fr);
        };
        const ww = x.u1 - x.u0, hh = x.v1 - x.v0;
        add(x.u0 - 15, 30, hh + 60, (x.v0 + x.v1) / 2);
        add(x.u1 + 15, 30, hh + 60, (x.v0 + x.v1) / 2);
        add((x.u0 + x.u1) / 2, ww, 30, x.v1 + 15);
        add((x.u0 + x.u1) / 2, ww + 80, 40, x.v0 - 20);
        add((x.u0 + x.u1) / 2, 30, hh, (x.v0 + x.v1) / 2); // 中間窗框
        const glass = new THREE.Mesh(new THREE.PlaneGeometry(ww * M, hh * M), glassMat);
        const gp = V.add(V.add(w.a, V.scale(w.u, (x.u0 + x.u1) / 2)), V.scale(w.n, -40));
        glass.position.set(gp.x * M, ((x.v0 + x.v1) / 2) * M, gp.y * M);
        glass.rotation.y = -Math.atan2(w.u.y, w.u.x);
        this.group.add(glass);
      }
      // 門框
      for (const d of doors) {
        const dh = Math.min(d.h, H - 20);
        const add = (u, len, hgt, y) => {
          const fr = new THREE.Mesh(new THREE.BoxGeometry(len * M, hgt * M, 0.11), frameMat);
          const pt = V.add(V.add(w.a, V.scale(w.u, u)), V.scale(w.n, -45));
          fr.position.set(pt.x * M, y * M, pt.y * M);
          fr.rotation.y = -Math.atan2(w.u.y, w.u.x);
          this.group.add(fr);
        };
        add(d.off - 15, 30, dh, dh / 2);
        add(d.off + d.w + 15, 30, dh, dh / 2);
        add(d.off + d.w / 2, d.w + 60, 30, dh + 15);
      }
    });

    // 物件
    let rugN = 0;
    this.col = { poly, walls, items: [], door: null };
    const d0 = (room.doors || [])[0];
    if (d0 && walls[d0.wall]) {
      const w = walls[d0.wall];
      const pt = V.add(V.add(w.a, V.scale(w.u, d0.off + d0.w / 2)), V.scale(w.n, BODY_R + 350));
      this.col.door = { x: pt.x * M, z: pt.y * M, nx: w.n.x, nz: w.n.y };
    }
    for (const it of lay.items) {
      const li = lib(it.libId);
      if (!li) continue;
      if (isWall(li)) { const m = this.makeArt(it, li, walls); if (m) this.group.add(m); continue; }
      const rug = isRug(li);
      const mesh = this.makeItem(it, li, rug ? rugN++ : 0);
      this.group.add(mesh);
      if (!rug && li.h > 250) this.col.items.push({ it, li });
    }

    // 陰影範圍
    const s = Math.max(b.sx, b.sz) / 2 + 1;
    const sc = this.sun.shadow.camera;
    sc.left = -s; sc.right = s; sc.top = s; sc.bottom = -s; sc.near = 0.1; sc.far = 30;
    sc.updateProjectionMatrix();
    this.sun.position.set(b.cx + 2.5, 8, b.cz + 1.5);
    this.sun.target.position.set(b.cx, 0, b.cz);

    if (!this.framed) { this.frame(); this.framed = true; }
    if (this.mode === 'walk' && !this.free(this.px, this.pz)) this.placeWalker();
  }

  makeItem(it, li, rugIdx) {
    const w = li.w * M, d = li.d * M, h = Math.max(li.h, 3) * M;
    const rug = isRug(li);
    let geo, mats;
    if (isRound(li)) {
      geo = new THREE.CylinderGeometry(0.5, 0.5, 1, 56);
      mats = [this.mat(li, 'side', (Math.PI * (li.w + li.d)) / 2, li.h), this.mat(li, 'top', li.w, li.d), this.mat(li, 'bottom', li.w, li.d)];
    } else {
      geo = new THREE.BoxGeometry(w, h, d);
      mats = [
        this.mat(li, 'side', li.d, li.h), this.mat(li, 'side', li.d, li.h),
        this.mat(li, 'top', li.w, li.d), this.mat(li, 'bottom', li.w, li.d),
        this.mat(li, 'side', li.w, li.h), this.mat(li, 'side', li.w, li.h),
      ];
    }
    const mesh = new THREE.Mesh(geo, mats);
    if (isRound(li)) mesh.scale.set(w, h, d);
    mesh.position.set(it.x * M, h / 2 + (rug ? rugIdx * 0.0006 : 0), it.y * M);
    mesh.rotation.y = (-it.rot * Math.PI) / 180;
    mesh.castShadow = !rug;
    mesh.receiveShadow = true;
    if (!rug) {
      const lm = new THREE.LineBasicMaterial({ color: 0x3b3631, transparent: true, opacity: 0.35 });
      this.disposables.push(lm);
      mesh.add(new THREE.LineSegments(new THREE.EdgesGeometry(geo, 30), lm));
    }
    return mesh;
  }

  // 牆面物件：正面朝房內，厚度往房內凸出
  makeArt(it, li, walls) {
    const W = walls[it.wall];
    if (!W) return null;
    const w = li.w * M, h = li.h * M, d = Math.max(li.d, 2) * M;
    const mats = [
      this.mat(li, 'side', li.d, li.h), this.mat(li, 'side', li.d, li.h),
      this.mat(li, 'side', li.w, li.d), this.mat(li, 'side', li.w, li.d),
      this.mat(li, 'top', li.w, li.h), this.mat(li, 'bottom', li.w, li.h),
    ];
    const mesh = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), mats);
    const right = { x: W.n.y, y: -W.n.x }; // 站在房內面對牆時的右手方向＝物件的 +x
    const c = V.add(V.add(W.a, V.scale(W.u, it.off)), V.scale(W.n, (d / M) / 2 + 1));
    mesh.position.set(c.x * M, it.elev * M, c.y * M);
    mesh.rotation.y = Math.atan2(-right.y, right.x);
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    return mesh;
  }

  frame() {
    const b = this.bounds;
    if (!b) return;
    const s = Math.max(b.sx, b.sz, 2);
    this.controls.target.set(b.cx, 0.5, b.cz);
    this.camera.position.set(b.cx - s * 0.55, s * 1.45 + 1.2, b.cz + s * 1.35);
    this.controls.update();
  }

  // ---------- 走動 ----------
  setMode(m) {
    this.mode = m;
    if (m === 'walk') {
      this.controls.enabled = false;
      this.camera.fov = 70;
      // 有門就從門口走進來、面向房內；沒有門就站在中間、面向最開闊的方向
      const door = this.col?.door;
      if (door && this.free(door.x, door.z)) {
        this.px = door.x; this.pz = door.z;
        this.yaw = Math.atan2(-door.nx, -door.nz);
      } else {
        this.placeWalker();
        this.yaw = this.openYaw();
      }
      this.pitch = -0.3;
    } else {
      if (document.pointerLockElement) document.exitPointerLock();
      this.controls.enabled = true;
      this.camera.fov = 50;
      this.frame();
    }
    this.camera.updateProjectionMatrix();
  }

  placeWalker() {
    const b = this.bounds;
    if (!b) return;
    this.px = b.cx; this.pz = b.cz;
    if (this.free(this.px, this.pz)) return;
    for (let r = 0.2; r < 4; r += 0.2)
      for (let a = 0; a < Math.PI * 2; a += Math.PI / 8) {
        const x = b.cx + Math.cos(a) * r, z = b.cz + Math.sin(a) * r;
        if (this.free(x, z)) { this.px = x; this.pz = z; return; }
      }
  }

  // 面向最開闊的方向，避免一進來就對著牆
  openYaw() {
    let best = 0, bd = -1;
    for (let i = 0; i < 16; i++) {
      const yaw = (i / 16) * Math.PI * 2, fx = -Math.sin(yaw), fz = -Math.cos(yaw);
      let d = 0;
      while (d < 8 && this.free(this.px + fx * d, this.pz + fz * d)) d += 0.1;
      if (d > bd) { bd = d; best = yaw; }
    }
    return best;
  }

  free(x, z) {
    const c = this.col;
    if (!c) return true;
    const p = { x: x / M, y: z / M };
    if (!pointInPoly(p, c.poly)) return false;
    for (const w of c.walls) if (segDist(p, w.a, w.b) < BODY_R) return false;
    for (const { it, li } of c.items) {
      const l = V.rot(V.sub(p, it), (-it.rot * Math.PI) / 180);
      const a = li.w / 2 + BODY_R, bb = li.d / 2 + BODY_R;
      if (isRound(li) ? (l.x / a) ** 2 + (l.y / bb) ** 2 < 1 : Math.abs(l.x) < a && Math.abs(l.y) < bb) return false;
    }
    return true;
  }

  setEye(cm) { this.eye = cm / 100; }

  update(dt) {
    if (this.mode !== 'walk') { this.controls.update(); return; }
    const k = this.keys;
    let f = 0, r = 0;
    if (k.has('KeyW') || k.has('ArrowUp')) f += 1;
    if (k.has('KeyS') || k.has('ArrowDown')) f -= 1;
    if (k.has('KeyD') || k.has('ArrowRight')) r += 1;
    if (k.has('KeyA') || k.has('ArrowLeft')) r -= 1;
    f += -this.joy.y; r += this.joy.x;
    if (k.has('KeyR') || k.has('KeyF')) {
      this.eye = clamp(this.eye + (k.has('KeyR') ? 1 : -1) * dt * 0.6, 0.3, 2.2);
      this.ui.onEye?.(Math.round(this.eye * 100));
    }
    const sp = (k.has('ShiftLeft') || k.has('ShiftRight') ? 2.6 : 1.3) * dt;
    const sin = Math.sin(this.yaw), cos = Math.cos(this.yaw);
    const dx = (-sin * f + cos * r) * sp, dz = (-cos * f - sin * r) * sp;
    if (dx && this.free(this.px + dx, this.pz)) this.px += dx;
    if (dz && this.free(this.px, this.pz + dz)) this.pz += dz;
    this.camera.position.set(this.px, this.eye, this.pz);
    this.camera.rotation.set(this.pitch, this.yaw, 0);
  }

  look(dx, dy, k = 0.0042) {
    this.yaw -= dx * k;
    this.pitch = clamp(this.pitch - dy * k, -1.45, 1.45);
  }

  lockPointer() { this.renderer.domElement.requestPointerLock?.(); }

  bindWalk() {
    const cv = this.renderer.domElement;
    let last = null;
    cv.addEventListener('pointerdown', e => {
      if (this.mode !== 'walk' || document.pointerLockElement) return;
      last = { id: e.pointerId, x: e.clientX, y: e.clientY };
      cv.setPointerCapture(e.pointerId);
    });
    cv.addEventListener('pointermove', e => {
      if (this.mode !== 'walk') return;
      if (document.pointerLockElement === cv) { this.look(e.movementX, e.movementY, 0.0025); return; }
      if (!last || last.id !== e.pointerId) return;
      this.look(e.clientX - last.x, e.clientY - last.y);
      last.x = e.clientX; last.y = e.clientY;
    });
    const end = e => { if (last && last.id === e.pointerId) last = null; };
    cv.addEventListener('pointerup', end);
    cv.addEventListener('pointercancel', end);

    const typing = () => /INPUT|TEXTAREA|SELECT/.test(document.activeElement?.tagName || '');
    window.addEventListener('keydown', e => {
      if (!this.active || this.mode !== 'walk' || typing() || e.metaKey || e.ctrlKey) return;
      this.keys.add(e.code);
      if (e.code.startsWith('Arrow') || e.code === 'Space') e.preventDefault();
    });
    window.addEventListener('keyup', e => this.keys.delete(e.code));
    window.addEventListener('blur', () => this.keys.clear());
  }

  bindJoystick(el) {
    const knob = el.firstElementChild;
    let id = null;
    const set = e => {
      const r = el.getBoundingClientRect();
      let x = (e.clientX - r.left - r.width / 2) / (r.width / 2), y = (e.clientY - r.top - r.height / 2) / (r.height / 2);
      const l = Math.hypot(x, y);
      if (l > 1) { x /= l; y /= l; }
      this.joy = { x, y };
      knob.style.transform = `translate(${x * 34}px, ${y * 34}px)`;
    };
    el.addEventListener('pointerdown', e => { id = e.pointerId; el.setPointerCapture(id); set(e); });
    el.addEventListener('pointermove', e => { if (e.pointerId === id) set(e); });
    const end = e => { if (e.pointerId !== id) return; id = null; this.joy = { x: 0, y: 0 }; knob.style.transform = ''; };
    el.addEventListener('pointerup', end);
    el.addEventListener('pointercancel', end);
  }
}
