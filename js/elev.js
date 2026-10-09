// 牆面立面圖：正對一面牆，擺放牆面物件（畫、海報）與窗戶，可用任意邊設定距離
import { S, P, L, lib, isRug, isWall, getImg, checkpoint, changed, emit } from './state.js';
import { V, segDist, cm, clamp } from './util.js';
import { buildRoom, wallEdges, itemCorners, isParallel, cornerName, WALL_T } from './geom.js';

const C = { accent: '#2f7d76', hot: '#d0612a', ink: '#2b2824', dim: '#2f7d76', dark: '#3b3631' };
const NEAR = 800; // 離牆多近的傢俱要畫出側影（mm）

const mk = (a, b, n, i) => ({ a, b, u: V.norm(V.sub(b, a)), n, mid: V.mid(a, b), len: V.len(V.sub(b, a)), i });

// 物件（中心 x,z；寬 w、高 h）的四條邊：0 上、1 右、2 下、3 左
export function objEdges(o) {
  const x0 = o.x - o.w / 2, x1 = o.x + o.w / 2, z0 = o.z - o.h / 2, z1 = o.z + o.h / 2;
  return [
    mk({ x: x0, y: z1 }, { x: x1, y: z1 }, { x: 0, y: 1 }, 0),
    mk({ x: x1, y: z1 }, { x: x1, y: z0 }, { x: 1, y: 0 }, 1),
    mk({ x: x1, y: z0 }, { x: x0, y: z0 }, { x: 0, y: -1 }, 2),
    mk({ x: x0, y: z0 }, { x: x0, y: z1 }, { x: -1, y: 0 }, 3),
  ];
}

export class Elev {
  constructor(plan, wall) {
    Object.assign(this, { p2: plan, wall, scale: 0.2, ox: 0, oy: 0, pick: null, pickTarget: null, drag: null, pinch: null, hover: null, snapHits: [] });
    this.pointers = new Map();
  }
  get ui() { return this.p2.ui; }
  toS(p) { return { x: this.ox + p.x * this.scale, y: this.oy - p.y * this.scale }; }
  toW(x, y) { return { x: (x - this.ox) / this.scale, y: (this.oy - y) / this.scale }; }

  // 牆面座標：x＝從「站在房內面對這面牆時的左端」往右量（mm），y＝離地高度（mm）
  data() {
    const p = P();
    if (!p) return null;
    const lay = L(p);
    const walls = wallEdges(buildRoom(p.room).poly);
    const W = walls[this.wall];
    if (!W) return null;
    const Lw = W.len, H = p.room.height, n = walls.length;
    const right = { x: W.n.y, y: -W.n.x };
    const flip = V.dot(W.u, right) < 0;
    const X = t => (flip ? Lw - t : t);
    const objs = [];
    (p.room.boxes || []).forEach((b, j) => {
      if (b.wall !== this.wall) return;
      const h = b.toCeil ? H - b.bottom : b.h;
      objs.push({ kind: 'box', id: b.id, ref: b, x: X(b.off + b.w / 2), z: b.bottom + h / 2, w: b.w, h, locked: false, label: `量體 ${j + 1}` });
    });
    (p.room.windows || []).forEach((w, j) => {
      if (w.wall !== this.wall) return;
      objs.push({ kind: 'win', id: w.id, ref: w, x: X(w.off + w.w / 2), z: w.sill + w.h / 2, w: w.w, h: w.h, locked: false, label: `窗 ${j + 1}`, frosted: w.glass === 'frosted' });
    });
    for (const it of lay.items) {
      const li = lib(it.libId);
      if (!li || !isWall(li) || it.wall !== this.wall) continue;
      objs.push({ kind: 'art', id: it.id, ref: it, li, x: X(it.off), z: it.elev, w: li.w, h: li.h, locked: it.locked, label: li.name });
    }
    const doors = (p.room.doors || []).map((d, j) => ({ d, j })).filter(o => o.d.wall === this.wall).map(({ d, j }) => {
      const a = X(d.off), b = X(d.off + d.w);
      return { id: d.id, x0: Math.min(a, b), x1: Math.max(a, b), h: Math.min(d.h, H), label: `門 ${j + 1}` };
    });
    // 靠近這面牆的落地傢俱：投影成側影，頂面可當基準（例如「畫的下緣距櫃子頂面 25 cm」）
    const furn = [];
    for (const it of lay.items) {
      const li = lib(it.libId);
      if (!li || isRug(li) || isWall(li)) continue;
      const cs = itemCorners(it, li);
      const ts = cs.map(c => V.dot(V.sub(c, W.a), W.u)), ds = cs.map(c => V.dot(V.sub(c, W.a), W.n));
      const dmin = Math.min(...ds);
      if (dmin > NEAR || Math.max(...ds) < 0) continue;
      const t0 = Math.max(0, Math.min(...ts)), t1 = Math.min(Lw, Math.max(...ts));
      if (t1 - t0 < 1) continue;
      const a = X(t0), b = X(t1);
      furn.push({ id: it.id, li, x0: Math.min(a, b), x1: Math.max(a, b), h: li.h, dist: dmin });
    }
    furn.sort((a, b) => b.dist - a.dist);

    const refs = [];
    const add = (a, b, nn, label, owner, key) => refs.push({ ...mk(a, b, nn), label, owner, key });
    const lc = cornerName(flip ? (this.wall + 1) % n : this.wall), rc = cornerName(flip ? this.wall : (this.wall + 1) % n);
    add({ x: 0, y: 0 }, { x: Lw, y: 0 }, { x: 0, y: 1 }, '地板', null, 'floor');
    add({ x: 0, y: H }, { x: Lw, y: H }, { x: 0, y: -1 }, '天花板', null, 'ceil');
    add({ x: 0, y: 0 }, { x: 0, y: H }, { x: 1, y: 0 }, `牆角 ${lc}`, null, 'cl');
    add({ x: Lw, y: 0 }, { x: Lw, y: H }, { x: -1, y: 0 }, `牆角 ${rc}`, null, 'cr');
    for (const d of doors) {
      add({ x: d.x0, y: 0 }, { x: d.x0, y: d.h }, { x: -1, y: 0 }, `${d.label} 門框`, d.id, `d0${d.id}`);
      add({ x: d.x1, y: 0 }, { x: d.x1, y: d.h }, { x: 1, y: 0 }, `${d.label} 門框`, d.id, `d1${d.id}`);
      add({ x: d.x0, y: d.h }, { x: d.x1, y: d.h }, { x: 0, y: 1 }, `${d.label} 上緣`, d.id, `d2${d.id}`);
    }
    for (const f of furn) {
      add({ x: f.x0, y: f.h }, { x: f.x1, y: f.h }, { x: 0, y: 1 }, `${f.li.name} 頂面`, f.id, `f0${f.id}`);
      add({ x: f.x0, y: 0 }, { x: f.x0, y: f.h }, { x: -1, y: 0 }, `${f.li.name} 側邊`, f.id, `f1${f.id}`);
      add({ x: f.x1, y: 0 }, { x: f.x1, y: f.h }, { x: 1, y: 0 }, `${f.li.name} 側邊`, f.id, `f2${f.id}`);
    }
    for (const o of objs) objEdges(o).forEach(e => refs.push({ ...e, label: o.label, owner: o.id, key: `o${e.i}${o.id}` }));
    return { p, lay, W, L: Lw, H, flip, objs, doors, furn, refs, lc, rc };
  }

  setPos(D, o, x, z) {
    const t = D.flip ? D.L - x : x;
    if (o.kind === 'art') { o.ref.off = Math.round(t * 10) / 10; o.ref.elev = Math.round(z * 10) / 10; }
    else if (o.kind === 'box') {
      o.ref.off = Math.round((t - o.ref.w / 2) * 10) / 10;
      if (!o.ref.toCeil) o.ref.bottom = Math.round((z - o.ref.h / 2) * 10) / 10; // 頂到天花板的量體只能左右移
    }
    else { o.ref.off = Math.round((t - o.ref.w / 2) * 10) / 10; o.ref.sill = Math.round((z - o.ref.h / 2) * 10) / 10; }
  }

  fit() {
    const D = this.data();
    const w = this.p2.w, h = this.p2.h;
    if (!D || !w) return;
    const mobile = w <= 760;
    const aw = w - (mobile ? 0 : 290);
    const m = mobile ? 62 : 80, top = mobile ? 120 : 110;
    const bottom = h - (mobile ? Math.min(300, h * 0.36) : m); // 手機下方留給物件面板
    const s = clamp(Math.min((aw - 2 * m) / D.L, (bottom - top) / D.H), 0.02, 3);
    this.scale = s;
    this.ox = (aw - D.L * s) / 2;
    this.oy = (top + bottom) / 2 + (D.H * s) / 2;
  }
  zoomAt(px, py, k) {
    const ns = clamp(this.scale * k, 0.02, 3);
    const wx = (px - this.ox) / this.scale, wy = (this.oy - py) / this.scale;
    this.scale = ns; this.ox = px - wx * ns; this.oy = py + wy * ns;
    this.p2.draw();
  }

  // ---------- 繪製 ----------
  rect(ctx, x0, z0, x1, z1) {
    const A = this.toS({ x: x0, y: z1 }), B = this.toS({ x: x1, y: z0 });
    ctx.beginPath(); ctx.rect(A.x, A.y, B.x - A.x, B.y - A.y);
    return { x: A.x, y: A.y, w: B.x - A.x, h: B.y - A.y };
  }
  seg(ctx, a, b, color, width) {
    const A = this.toS(a), B = this.toS(b);
    ctx.beginPath(); ctx.moveTo(A.x, A.y); ctx.lineTo(B.x, B.y);
    ctx.strokeStyle = color; ctx.lineWidth = width; ctx.lineCap = 'round'; ctx.stroke();
  }
  dim(ctx, p1, p2, text, color) {
    const A = this.toS(p1), B = this.toS(p2);
    const d = V.norm(V.sub(B, A)), nn = { x: -d.y * 5, y: d.x * 5 };
    ctx.beginPath();
    ctx.moveTo(A.x, A.y); ctx.lineTo(B.x, B.y);
    ctx.moveTo(A.x - nn.x, A.y - nn.y); ctx.lineTo(A.x + nn.x, A.y + nn.y);
    ctx.moveTo(B.x - nn.x, B.y - nn.y); ctx.lineTo(B.x + nn.x, B.y + nn.y);
    ctx.strokeStyle = color; ctx.lineWidth = 1.3; ctx.stroke();
    ctx.font = '600 11px -apple-system, sans-serif'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    const m = V.mid(A, B);
    this.p2.pill(ctx, m.x, m.y, text, color, '#fff');
  }
  label(ctx, x, y, text, size = 12, color = C.ink) {
    ctx.font = `600 ${size}px -apple-system, "PingFang TC", sans-serif`;
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.lineWidth = 3; ctx.strokeStyle = 'rgba(255,255,255,.85)'; ctx.strokeText(text, x, y);
    ctx.fillStyle = color; ctx.fillText(text, x, y);
  }

  draw() {
    const ctx = this.p2.ctx, s = this.scale;
    const D = this.data();
    this.D = D;
    if (!D) return;
    const T = WALL_T * s;
    // 地面、兩側牆、樓板
    const g = this.toS({ x: 0, y: 0 });
    ctx.fillStyle = '#e4ddd2'; ctx.fillRect(0, g.y, this.p2.w, this.p2.h - g.y);
    const A = this.toS({ x: 0, y: D.H }), B = this.toS({ x: D.L, y: 0 });
    ctx.fillStyle = C.dark;
    ctx.fillRect(A.x - T, A.y - T, B.x - A.x + 2 * T, B.y - A.y + T);
    ctx.fillStyle = D.p.room.wallColor;
    ctx.fillRect(A.x, A.y, B.x - A.x, B.y - A.y);
    // 門
    for (const d of D.doors) {
      this.rect(ctx, d.x0, 0, d.x1, d.h);
      ctx.fillStyle = '#d8d0c4'; ctx.fill();
      ctx.strokeStyle = '#8b7b6b'; ctx.lineWidth = 3; ctx.stroke();
      const c = this.toS({ x: (d.x0 + d.x1) / 2, y: d.h / 2 });
      this.label(ctx, c.x, c.y, d.label, 12, '#6b5f52');
    }
    // 傢俱側影（離牆越遠越淡）
    for (const f of D.furn) {
      ctx.globalAlpha = 0.75 - (f.dist / NEAR) * 0.4;
      this.rect(ctx, f.x0, 0, f.x1, f.h);
      ctx.fillStyle = f.li.color; ctx.fill();
      ctx.globalAlpha = 1;
      ctx.setLineDash([5, 4]); ctx.strokeStyle = 'rgba(60,50,40,.6)'; ctx.lineWidth = 1; ctx.stroke(); ctx.setLineDash([]);
      const c = this.toS({ x: (f.x0 + f.x1) / 2, y: f.h / 2 });
      if ((f.x1 - f.x0) * s > 40) this.label(ctx, c.x, c.y, f.li.name, 11, '#5b524a');
    }
    // 窗戶、牆面物件
    for (const o of D.objs) {
      const r = this.rect(ctx, o.x - o.w / 2, o.z - o.h / 2, o.x + o.w / 2, o.z + o.h / 2);
      if (o.kind === 'box') {
        ctx.fillStyle = 'rgba(90,80,70,.13)'; ctx.fill();
        ctx.strokeStyle = '#6b5f52'; ctx.lineWidth = 1.5; ctx.stroke();
      } else if (o.kind === 'win') {
        ctx.fillStyle = o.frosted ? '#eef1ef' : '#d4e6ee'; ctx.fill();
        ctx.strokeStyle = '#6f858f'; ctx.lineWidth = 3; ctx.stroke();
        ctx.beginPath(); ctx.moveTo(r.x + r.w / 2, r.y); ctx.lineTo(r.x + r.w / 2, r.y + r.h);
        ctx.lineWidth = 1.5; ctx.stroke();
      } else {
        ctx.fillStyle = o.li.color; ctx.fill();
        const img = o.li.tex && o.li.texMode !== 'none' ? getImg(o.li.tex) : null;
        if (img) {
          if (o.li.texMode === 'fit') ctx.drawImage(img, r.x, r.y, r.w, r.h);
          else {
            ctx.save(); ctx.clip();
            const pat = ctx.createPattern(img, 'repeat');
            const k = (o.li.tileW || 300) * s / img.naturalWidth;
            pat.setTransform(new DOMMatrix().translate(r.x, r.y).scale(k, ((o.li.tileH || 300) * s) / img.naturalHeight));
            ctx.fillStyle = pat; ctx.fillRect(r.x, r.y, r.w, r.h);
            ctx.restore();
          }
        }
        this.rect(ctx, o.x - o.w / 2, o.z - o.h / 2, o.x + o.w / 2, o.z + o.h / 2);
        ctx.strokeStyle = 'rgba(40,30,20,.55)'; ctx.lineWidth = 1.5; ctx.stroke();
      }
      const c = this.toS({ x: o.x, y: o.z - o.h / 2 });
      this.label(ctx, c.x, c.y + 12, (o.locked ? '🔒 ' : '') + o.label, 11);
    }
    // 牆長、天花板高
    ctx.font = '600 11px -apple-system, sans-serif'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    this.p2.pill(ctx, (A.x + B.x) / 2, A.y - T - 14, `牆 ${this.wall + 1}・${cm(D.L)} cm`, 'rgba(255,253,249,.95)', '#5b524a');
    this.p2.pill(ctx, A.x - T - 30, (A.y + B.y) / 2, `高 ${cm(D.H)}`, 'rgba(255,253,249,.95)', '#5b524a');
    this.label(ctx, A.x, B.y + 14, D.lc, 12, '#8a8076');
    this.label(ctx, B.x, B.y + 14, D.rc, 12, '#8a8076');

    const sel = D.objs.find(o => o.id === S.sel);
    if (sel) this.drawSel(ctx, sel, D);
    if (this.pick) this.drawPick(ctx, D);
    for (const r of this.snapHits) this.seg(ctx, r.a, r.b, C.hot, 3);
  }

  autoDims(o, D) {
    const out = [];
    for (const e of objEdges(o)) {
      let best = null;
      for (const r of D.refs) {
        if (r.owner === o.id || !isParallel(e, r)) continue;
        const s = V.dot(V.sub(r.a, e.mid), e.n);
        if (s < -0.5) continue;
        const ta = V.dot(V.sub(r.a, e.a), e.u), tb = V.dot(V.sub(r.b, e.a), e.u);
        const lo = Math.max(0, Math.min(ta, tb)), hi = Math.min(e.len, Math.max(ta, tb));
        if (hi - lo < 1) continue;
        if (!best || s < best.s) best = { s, t: (lo + hi) / 2 };
      }
      if (best) { const p1 = V.add(e.a, V.scale(e.u, best.t)); out.push({ p1, p2: V.add(p1, V.scale(e.n, best.s)), d: best.s }); }
    }
    return out;
  }

  drawSel(ctx, o, D) {
    this.rect(ctx, o.x - o.w / 2, o.z - o.h / 2, o.x + o.w / 2, o.z + o.h / 2);
    ctx.strokeStyle = C.accent; ctx.lineWidth = 2; ctx.stroke();
    if (this.pick) return;
    for (const dm of this.autoDims(o, D)) this.dim(ctx, dm.p1, dm.p2, cm(dm.d), C.dim);
    objEdges(o).forEach((e, i) => {
      const hot = this.hover?.type === 'edge' && this.hover.i === i;
      if (hot) this.seg(ctx, e.a, e.b, C.hot, 5);
      const m = this.toS(e.mid);
      ctx.beginPath(); ctx.arc(m.x, m.y, hot ? 6 : 4.5, 0, Math.PI * 2);
      ctx.fillStyle = '#fff'; ctx.fill(); ctx.strokeStyle = hot ? C.hot : C.accent; ctx.lineWidth = 2; ctx.stroke();
    });
  }

  drawPick(ctx, D) {
    const o = D.objs.find(x => x.id === this.pick.id);
    if (!o) return;
    const src = objEdges(o)[this.pick.edge];
    for (const r of D.refs) {
      if (r.owner === o.id) continue;
      const par = isParallel(src, r);
      const hot = (this.hover?.type === 'ref' && this.hover.key === r.key) || this.pickTarget?.key === r.key;
      this.seg(ctx, r.a, r.b, hot ? C.hot : par ? 'rgba(47,125,118,.75)' : 'rgba(47,125,118,.18)', hot ? 6 : par ? 4 : 2);
    }
    this.seg(ctx, src.a, src.b, C.hot, 6);
  }

  // ---------- 命中 ----------
  hitObj(w, D, pad = 0) {
    // 畫作優先於窗戶（畫可能掛在窗邊重疊）
    const rank = { box: 0, win: 1, art: 2 }; // 量體在最下層，窗和畫優先被點到
    const order = [...D.objs].sort((a, b) => rank[b.kind] - rank[a.kind]);
    return order.find(o => Math.abs(w.x - o.x) <= o.w / 2 + pad && Math.abs(w.y - o.z) <= o.h / 2 + pad) || null;
  }
  hitOwnEdge(o, w, tol) {
    let best = -1, bd = tol;
    objEdges(o).forEach((e, i) => { const d = segDist(w, e.a, e.b); if (d < bd) { bd = d; best = i; } });
    return best;
  }
  hitRef(w, tol, filter) {
    let best = null, bd = tol;
    for (const r of this.D?.refs || []) {
      if (filter && !filter(r)) continue;
      const d = segDist(w, r.a, r.b);
      if (d < bd) { bd = d; best = r; }
    }
    return best;
  }

  // ---------- 指標 ----------
  down(e, pos) {
    this.pointers.set(e.pointerId, pos);
    if (this.pointers.size === 2) {
      this.drag = null;
      const [a, b] = [...this.pointers.values()];
      this.pinch = { d: Math.hypot(a.x - b.x, a.y - b.y), cx: (a.x + b.x) / 2, cy: (a.y + b.y) / 2, scale: this.scale, ox: this.ox, oy: this.oy };
      return;
    }
    if (this.pointers.size > 2) return;
    const D = this.D || this.data();
    if (!D) return;
    const touch = e.pointerType === 'touch';
    const w = this.toW(pos.x, pos.y), tol = (touch ? 22 : 10) / this.scale;
    const base = { pos, w, tol, ox: this.ox, oy: this.oy, moved: false };
    if (this.pick) { this.drag = { ...base, type: 'tapPick' }; return; }
    const sel = D.objs.find(o => o.id === S.sel);
    if (sel) {
      const ei = this.hitOwnEdge(sel, w, tol);
      if (ei >= 0) { this.drag = { ...base, type: 'obj', id: sel.id, edge: ei, orig: { x: sel.x, z: sel.z } }; return; }
    }
    const hit = this.hitObj(w, D, touch ? 6 / this.scale : 0);
    if (hit) {
      if (S.sel !== hit.id) { S.sel = hit.id; emit('selection'); }
      this.drag = { ...base, type: 'obj', id: hit.id, edge: -1, orig: { x: hit.x, z: hit.z } };
      this.p2.draw();
      return;
    }
    this.drag = { ...base, type: 'pan' };
  }

  move(e, pos) {
    if (this.pointers.has(e.pointerId)) this.pointers.set(e.pointerId, pos);
    if (this.pinch && this.pointers.size >= 2) {
      const [a, b] = [...this.pointers.values()], pc = this.pinch;
      const ns = clamp(pc.scale * (Math.hypot(a.x - b.x, a.y - b.y) / pc.d), 0.02, 3);
      const wx = (pc.cx - pc.ox) / pc.scale, wy = (pc.oy - pc.cy) / pc.scale;
      this.scale = ns; this.ox = (a.x + b.x) / 2 - wx * ns; this.oy = (a.y + b.y) / 2 + wy * ns;
      this.p2.draw();
      return;
    }
    const dr = this.drag;
    if (!dr) { if (e.pointerType === 'mouse') this.updateHover(pos); return; }
    const dx = pos.x - dr.pos.x, dy = pos.y - dr.pos.y;
    if (!dr.moved && Math.hypot(dx, dy) < 5) return;
    const first = !dr.moved;
    dr.moved = true;
    const D = this.D;
    const o = dr.type === 'obj' ? D.objs.find(x => x.id === dr.id) : null;
    if (o && o.locked) { if (first) this.ui.toast('這個物件已鎖定'); dr.type = 'pan'; }
    if (dr.type === 'pan' || dr.type === 'tapPick') { this.ox = dr.ox + dx; this.oy = dr.oy + dy; this.p2.draw(); return; }
    if (first) checkpoint();
    const step = e.shiftKey ? 1 : 10;
    let x = dr.orig.x + Math.round(dx / this.scale / step) * step;
    let z = dr.orig.z - Math.round(dy / this.scale / step) * step;
    this.snapHits = [];
    if (!e.shiftKey) ({ x, z } = this.snap(o, x, z, (e.pointerType === 'touch' ? 14 : 8) / this.scale, D));
    this.setPos(D, o, x, z);
    this.p2.draw();
  }

  up(e, cancel) {
    this.pointers.delete(e.pointerId);
    if (this.pinch) { if (this.pointers.size < 2) this.pinch = null; this.drag = null; return; }
    const dr = this.drag;
    this.drag = null; this.snapHits = [];
    if (!dr || cancel) { this.p2.draw(); return; }
    if (dr.moved) { if (dr.type === 'obj') changed(); this.p2.draw(); return; }
    if (dr.type === 'pan' && S.sel) { S.sel = null; emit('selection'); }
    if (dr.type === 'obj' && dr.edge >= 0) {
      const o = this.D.objs.find(x => x.id === dr.id);
      if (o?.locked) this.ui.toast('這個物件已鎖定，解鎖後才能用距離移動它');
      else { this.pick = { id: dr.id, edge: dr.edge }; this.pickTarget = null; this.ui.updateHint(); }
    }
    if (dr.type === 'tapPick') {
      const r = this.hitRef(dr.w, dr.tol, x => x.owner !== this.pick.id);
      if (r) this.finishPick(r); else this.cancelPick();
    }
    this.p2.draw();
  }

  updateHover(pos) {
    if (!this.D) return;
    const w = this.toW(pos.x, pos.y), tol = 10 / this.scale;
    let h = null, cursor = 'default';
    if (this.pick) {
      const r = this.hitRef(w, tol, x => x.owner !== this.pick.id);
      if (r) { h = { type: 'ref', key: r.key }; cursor = 'pointer'; }
    } else {
      const sel = this.D.objs.find(o => o.id === S.sel);
      const ei = sel ? this.hitOwnEdge(sel, w, tol) : -1;
      if (ei >= 0) { h = { type: 'edge', i: ei }; cursor = 'pointer'; }
      else if (this.hitObj(w, this.D)) cursor = 'move';
    }
    this.p2.c.style.cursor = cursor;
    if (JSON.stringify(h) !== JSON.stringify(this.hover)) { this.hover = h; this.p2.draw(); }
  }

  snap(o, x, z, tol, D) {
    const refs = D.refs.filter(r => r.owner !== o.id);
    const pass = (cx, cz, exclN) => {
      let b = null;
      for (const e of objEdges({ ...o, x: cx, z: cz })) for (const r of refs) {
        if (!isParallel(e, r) || (exclN && Math.abs(V.dot(r.n, exclN)) > 0.5)) continue;
        const ta = V.dot(V.sub(r.a, e.a), e.u), tb = V.dot(V.sub(r.b, e.a), e.u);
        if (Math.min(e.len, Math.max(ta, tb)) - Math.max(0, Math.min(ta, tb)) < -tol) continue;
        const s = V.dot(V.sub(e.mid, r.a), r.n);
        if (Math.abs(s) < tol && (!b || Math.abs(s) < Math.abs(b.s))) b = { s, r };
      }
      return b;
    };
    const b1 = pass(x, z, null);
    if (b1) {
      x -= b1.r.n.x * b1.s; z -= b1.r.n.y * b1.s; this.snapHits.push(b1.r);
      const b2 = pass(x, z, b1.r.n);
      if (b2) { x -= b2.r.n.x * b2.s; z -= b2.r.n.y * b2.s; this.snapHits.push(b2.r); }
    }
    return { x, z };
  }

  nudge(dx, dz) {
    const D = this.data();
    const o = D?.objs.find(x => x.id === S.sel);
    if (!o) return false;
    if (o.locked) { this.ui.toast('已鎖定'); return true; }
    checkpoint();
    this.setPos(D, o, o.x + dx, o.z + dz);
    changed();
    return true;
  }

  // ---------- 以邊設定距離 ----------
  cancelPick() {
    this.pick = null; this.pickTarget = null;
    this.ui.hideDistance(); this.ui.updateHint(); this.p2.draw();
  }
  finishPick(r) {
    const { id, edge } = this.pick;
    const o = this.D.objs.find(x => x.id === id);
    if (!o) return this.cancelPick();
    const e = objEdges(o)[edge];
    if (!isParallel(e, r)) { this.ui.toast('請選同方向的邊：水平對水平、垂直對垂直'); return; }
    const s0 = V.dot(V.sub(e.mid, r.a), r.n);
    this.pickTarget = r;
    this.ui.showDistance({
      current: Math.abs(s0), rot: 0, from: o.label, to: r.label, noPin: true,
      onApply: (dmm, _pin, flip) => {
        checkpoint();
        const D2 = this.data();
        const o2 = D2.objs.find(x => x.id === id);
        if (!o2) return;
        const e2 = objEdges(o2)[edge];
        const s2 = V.dot(V.sub(e2.mid, r.a), r.n);
        let side = Math.sign(s2) || Math.sign(V.dot(V.sub({ x: o2.x, y: o2.z }, r.a), r.n)) || 1;
        if (flip) side = -side;
        const mv = side * dmm - s2;
        this.setPos(D2, o2, o2.x + r.n.x * mv, o2.z + r.n.y * mv);
        changed();
        this.cancelPick();
      },
      onCancel: () => this.cancelPick(),
    });
    this.p2.draw();
  }
}
