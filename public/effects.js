// Weapon effects on the profile picture: the weapon cursor, strike animations and the marks
// they leave. app.js calls WeaponFX.setup() once, then setWeapon() and reset().
//
// Marks are drawn on two canvases over the photo, in a 260x260 logical space that is scaled
// to the picture's real size: `perm` holds cracks and bullet holes (kept until reset), `temp`
// holds everything that fades on its own and is redrawn every animation frame while visible.
'use strict';

(function () {
  // Tunables. Times are in milliseconds.
  const CONFIG = {
    hammerMaxHits: 5, // Hits that add cracks; later hits still swing but add none.
    markLifetimeMs: 3000, // How long shoe prints and egg splats stay.
    strokeLingerMs: 3000, // How long chain saw and pen marks stay after the drag ends.
    fadeMs: 500, // Temporary marks fade out over the last part of their lifetime.
    shotgunPellets: 9,
    shotgunSpread: 34, // Radius of the pellet pattern, in logical px.
  };

  const SIZE = 260;
  const DRAG_TOOLS = ['Chain Saw', 'Pen'];
  const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');
  const sound = window.WeaponSounds || null;

  // Cursor hotspots, in the 24x24 icon coordinates: where each weapon "hits".
  const HOTSPOTS = {
    Hammer: [16, 6],
    Shoe: [12, 15],
    Egg: [12, 14],
    'Chain Saw': [22, 13],
    Gun: [22, 8],
    Pen: [3, 21],
  };

  // The hammer cursor: its head (30, 30) is the hotspot. `angle` swings it about the handle
  // end, so the raised pose is shown while aiming and the lowered one for a moment on each hit.
  const HAMMER_CURSOR_PX = 72;
  function hammerCursor(angle) {
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${HAMMER_CURSOR_PX}" height="${HAMMER_CURSOR_PX}" viewBox="-6 -6 112 112">
      <g transform="rotate(${angle} 88 88)">
        <path d="M36 36L86 86" stroke="#0b1020" stroke-width="15" stroke-linecap="round"/>
        <path d="M36 36L86 86" stroke="#7a4a1f" stroke-width="10" stroke-linecap="round"/>
        <path d="M38 36L84 82" stroke="#b07a45" stroke-width="3" stroke-linecap="round"/>
        <g transform="rotate(-45 30 30)" stroke="#0b1020" stroke-width="3" paint-order="stroke">
          <rect x="6" y="19" width="48" height="22" rx="3" fill="#8a929e"/>
          <rect x="9" y="21" width="42" height="5" rx="2" fill="#c7ccd4" stroke="none"/>
          <rect x="2" y="21" width="9" height="18" rx="2" fill="#565f6d"/>
        </g>
      </g></svg>`;
    const hot = Math.round(((30 + 6) * HAMMER_CURSOR_PX) / 112);
    return `url("data:image/svg+xml,${encodeURIComponent(svg)}") ${hot} ${hot}, crosshair`;
  }
  const HAMMER_RAISED = hammerCursor(22);
  const HAMMER_DOWN = hammerCursor(0);

  const SHOE_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 120 70">
    <path d="M8 44C7 24 13 14 22 14l18 2c6 10 18 14 32 16l28 6c12 3 16 10 14 16H9z" fill="#dc2626"/>
    <path d="M22 14l18 2c2 5 5 8 9 11" fill="none" stroke="#991b1b" stroke-width="2"/>
    <path d="M44 22l6 9M52 24l6 9M60 27l5 7" stroke="#fff" stroke-width="3" stroke-linecap="round"/>
    <path d="M28 45c20 2 42-5 64-1" fill="none" stroke="#fff" stroke-width="4" stroke-linecap="round"/>
    <path d="M6 52h110c1 6-3 10-10 10H12c-5 0-7-4-6-10z" fill="#f8fafc"/>
    <path d="M7 57h108" stroke="#94a3b8" stroke-width="2"/></svg>`;

  const EGG_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 60 76">
    <defs><radialGradient id="fx-egg-shade" cx="38%" cy="32%" r="72%">
      <stop offset="0" stop-color="#fffdf7"/><stop offset=".7" stop-color="#f3e6cf"/><stop offset="1" stop-color="#d4bf9a"/>
    </radialGradient></defs>
    <path d="M30 3C15 3 4 26 4 44a26 26 0 0 0 52 0C56 26 45 3 30 3z" fill="url(#fx-egg-shade)"/>
    <ellipse cx="21" cy="24" rx="5" ry="9" fill="#fff" opacity=".8" transform="rotate(20 21 24)"/></svg>`;

  // Sprite size in logical px and the point on it that lands where the user clicked.
  const SPRITES = {
    Shoe: { svg: SHOE_SVG, w: 104, h: 61, ax: 0.5, ay: 0.6, origin: '50% 60%' },
    Egg: { svg: EGG_SVG, w: 34, h: 43, ax: 0.5, ay: 0.55, origin: '50% 55%' },
  };

  const rand = (min, max) => min + Math.random() * (max - min);
  const pick = (list) => list[Math.floor(Math.random() * list.length)];

  let stage;
  let photo;
  let spriteLayer;
  let permCtx;
  let tempCtx;
  let bandCanvas;
  let bandCtx;
  let pxPerUnit = 1; // Canvas pixels per logical unit.

  let weapon = null;
  let generation = 0; // Bumped by reset() so in-flight animations don't land afterwards.
  let hammerHits = 0;
  let cracks = [];
  let shots = [];
  let marks = []; // Shoe prints and egg splats.
  let particles = []; // Chain saw sawdust.
  let groups = {}; // Chain saw and pen strokes.
  let activeDrag = null;
  let frameRequest = null;

  function newGroups() {
    return Object.fromEntries(DRAG_TOOLS.map((name) => [name, { strokes: [], drawing: false, releasedAt: 0 }]));
  }

  // ---- Cursor --------------------------------------------------------------------------------

  function cursorFor(w) {
    if (w.name === 'Hammer') return HAMMER_RAISED;
    const size = 40;
    const scale = size / 28; // The icon is drawn in a 28-unit box: 24 plus a 2-unit margin.
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="-2 -2 28 28" fill="none" stroke-linecap="round" stroke-linejoin="round">`
      + `<g color="#0b1020" stroke="#0b1020" stroke-width="4.5">${w.icon}</g>`
      + `<g color="#ffffff" stroke="#ffffff" stroke-width="2">${w.icon}</g></svg>`;
    const [hx, hy] = HOTSPOTS[w.name] || [12, 12];
    const x = Math.round((hx + 2) * scale);
    const y = Math.round((hy + 2) * scale);
    return `url("data:image/svg+xml,${encodeURIComponent(svg)}") ${x} ${y}, crosshair`;
  }

  // ---- Geometry helpers ----------------------------------------------------------------------

  function toLogical(e) {
    const rect = stage.getBoundingClientRect();
    return { x: ((e.clientX - rect.left) * SIZE) / rect.width, y: ((e.clientY - rect.top) * SIZE) / rect.height };
  }

  function cssPerUnit() {
    return stage.getBoundingClientRect().width / SIZE;
  }

  function fadeAlpha(age, life) {
    if (age >= life) return 0;
    return Math.min(1, (life - age) / CONFIG.fadeMs);
  }

  function resetTransform(ctx) {
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, ctx.canvas.width, ctx.canvas.height);
    ctx.setTransform(pxPerUnit, 0, 0, pxPerUnit, 0, 0);
  }

  // Draws the photo as the <img> shows it (object-fit: cover), shifted by (dx, dy).
  function drawPhoto(ctx, dx, dy) {
    const w = photo.naturalWidth;
    const h = photo.naturalHeight;
    if (!photo.complete || !w || !h) return false;
    const scale = Math.max(SIZE / w, SIZE / h);
    ctx.drawImage(photo, (SIZE - w * scale) / 2 + dx, (SIZE - h * scale) / 2 + dy, w * scale, h * scale);
    return true;
  }

  function smoothPath(ctx, pts, offset = () => [0, 0]) {
    ctx.beginPath();
    const p = pts.map((pt, i) => {
      const [ox, oy] = offset(pt, i);
      return { x: pt.x + ox, y: pt.y + oy };
    });
    ctx.moveTo(p[0].x, p[0].y);
    if (p.length === 1) ctx.lineTo(p[0].x + 0.01, p[0].y);
    for (let i = 1; i < p.length - 1; i++) {
      ctx.quadraticCurveTo(p[i].x, p[i].y, (p[i].x + p[i + 1].x) / 2, (p[i].y + p[i + 1].y) / 2);
    }
    if (p.length > 1) ctx.lineTo(p[p.length - 1].x, p[p.length - 1].y);
  }

  // Unit normal of a polyline at point i, for offsetting edges sideways.
  function normalAt(pts, i) {
    const a = pts[Math.max(0, i - 1)];
    const b = pts[Math.min(pts.length - 1, i + 1)];
    const len = Math.hypot(b.x - a.x, b.y - a.y) || 1;
    return [-(b.y - a.y) / len, (b.x - a.x) / len];
  }

  // ---- Hammer: cracks ------------------------------------------------------------------------

  function walk(x, y, angle, length) {
    const pts = [{ x, y }];
    for (let d = 0; d < length; ) {
      const step = rand(5, 10);
      angle += rand(-0.3, 0.3);
      x += Math.cos(angle) * step;
      y += Math.sin(angle) * step;
      pts.push({ x, y });
      d += step;
    }
    return pts;
  }

  function makeCracks(x, y, level) {
    const lines = [];
    const spokes = [];
    const count = 5 + level + Math.floor(rand(0, 3));
    const reach = 26 + level * 16;
    const start = rand(0, Math.PI * 2);
    for (let i = 0; i < count; i++) {
      const angle = start + (i * 2 * Math.PI) / count + rand(-0.35, 0.35);
      const pts = walk(x, y, angle, reach * rand(0.6, 1.15));
      spokes.push(pts);
      lines.push({ pts, w: 1.4 });
      for (let j = 2; j < pts.length - 1; j++) {
        if (Math.random() < 0.2) {
          const side = Math.random() < 0.5 ? -1 : 1;
          lines.push({ pts: walk(pts[j].x, pts[j].y, angle + side * rand(0.5, 1), reach * rand(0.2, 0.4)), w: 0.9 });
        }
      }
    }
    // Rings of cracks joining neighbouring spokes, more of them on later hits.
    for (let ring = 1; ring < Math.min(level, 4); ring++) {
      const f = ring / Math.min(level, 4);
      for (let i = 0; i < spokes.length; i++) {
        if (Math.random() > 0.75) continue;
        const a = spokes[i];
        const b = spokes[(i + 1) % spokes.length];
        const pa = a[Math.floor((a.length - 1) * f)];
        const pb = b[Math.floor((b.length - 1) * f)];
        const mid = { x: (pa.x + pb.x) / 2 + rand(-3, 3), y: (pa.y + pb.y) / 2 + rand(-3, 3) };
        lines.push({ pts: [pa, mid, pb], w: 0.9 });
      }
    }
    return { x, y, level, lines };
  }

  function drawCracks(ctx, c) {
    const glow = ctx.createRadialGradient(c.x, c.y, 0, c.x, c.y, 7 + c.level * 2);
    glow.addColorStop(0, 'rgba(255,255,255,0.75)');
    glow.addColorStop(1, 'rgba(255,255,255,0)');
    ctx.fillStyle = glow;
    ctx.beginPath();
    ctx.arc(c.x, c.y, 7 + c.level * 2, 0, Math.PI * 2);
    ctx.fill();

    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    for (const line of c.lines) {
      ctx.beginPath();
      line.pts.forEach((p, i) => (i ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y)));
      ctx.strokeStyle = 'rgba(10,12,20,0.65)';
      ctx.lineWidth = line.w * 1.4;
      ctx.stroke();
      ctx.save();
      ctx.translate(0.6, 0.6);
      ctx.strokeStyle = 'rgba(255,255,255,0.8)';
      ctx.lineWidth = line.w * 0.6;
      ctx.stroke();
      ctx.restore();
    }
  }

  // ---- Gun: shotgun holes --------------------------------------------------------------------

  function makeShot(x, y) {
    return Array.from({ length: CONFIG.shotgunPellets }, () => {
      const r = CONFIG.shotgunSpread * Math.sqrt(Math.random());
      const a = rand(0, Math.PI * 2);
      return {
        x: x + Math.cos(a) * r,
        y: y + Math.sin(a) * r,
        r: rand(4.5, 7),
        rim: Array.from({ length: 14 }, () => rand(0.85, 1.2)),
        rays: Array.from({ length: 4 + Math.floor(rand(0, 4)) }, () => ({ a: rand(0, Math.PI * 2), len: rand(5, 13) })),
      };
    });
  }

  function rimPath(ctx, h, scale) {
    ctx.beginPath();
    h.rim.forEach((k, i) => {
      const a = (i / h.rim.length) * Math.PI * 2;
      const r = h.r * k * scale;
      ctx.lineTo(h.x + Math.cos(a) * r, h.y + Math.sin(a) * r);
    });
    ctx.closePath();
  }

  function drawHole(ctx, h) {
    const scorch = ctx.createRadialGradient(h.x, h.y, h.r * 0.8, h.x, h.y, h.r * 2.8);
    scorch.addColorStop(0, 'rgba(35,24,14,0.7)');
    scorch.addColorStop(1, 'rgba(35,24,14,0)');
    ctx.fillStyle = scorch;
    ctx.beginPath();
    ctx.arc(h.x, h.y, h.r * 2.8, 0, Math.PI * 2);
    ctx.fill();

    // Hairline cracks radiating from the hole.
    ctx.strokeStyle = 'rgba(255,255,255,0.6)';
    ctx.lineWidth = 0.7;
    for (const ray of h.rays) {
      ctx.beginPath();
      ctx.moveTo(h.x + Math.cos(ray.a) * h.r, h.y + Math.sin(ray.a) * h.r);
      ctx.lineTo(h.x + Math.cos(ray.a + 0.08) * (h.r + ray.len), h.y + Math.sin(ray.a + 0.08) * (h.r + ray.len));
      ctx.stroke();
    }

    // Torn, lighter rim around a dark, deep hole.
    rimPath(ctx, h, 1.25);
    ctx.fillStyle = 'rgba(210,200,185,0.55)';
    ctx.fill();
    rimPath(ctx, h, 1);
    const depth = ctx.createRadialGradient(h.x - h.r * 0.2, h.y - h.r * 0.2, 0, h.x, h.y, h.r * 1.1);
    depth.addColorStop(0, '#000');
    depth.addColorStop(0.7, '#0a0806');
    depth.addColorStop(1, '#2a221b');
    ctx.fillStyle = depth;
    ctx.fill();
    ctx.strokeStyle = 'rgba(0,0,0,0.6)';
    ctx.lineWidth = 0.8;
    ctx.stroke();
  }

  // ---- Shoe print and egg splat sprites ------------------------------------------------------

  // Makes an offscreen canvas of `w` x `h` logical units, drawn at the current resolution.
  function spriteCanvas(w, h) {
    const c = document.createElement('canvas');
    const k = Math.max(pxPerUnit, 1);
    c.width = Math.ceil(w * k);
    c.height = Math.ceil(h * k);
    const ctx = c.getContext('2d');
    ctx.scale(k, k);
    return { c, ctx, w, h };
  }

  function makeShoePrint() {
    const s = spriteCanvas(70, 130);
    const { ctx } = s;
    ctx.translate(35, 65);

    // Sole: toe and heel pads joined by the arch.
    ctx.fillStyle = '#5b3a1e';
    ctx.beginPath();
    ctx.ellipse(0, -24, 25, 34, 0, 0, Math.PI * 2);
    ctx.ellipse(1, 38, 18, 21, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.beginPath();
    ctx.moveTo(-20, -4);
    ctx.quadraticCurveTo(-10, 16, -15, 30);
    ctx.lineTo(17, 30);
    ctx.quadraticCurveTo(22, 12, 22, -4);
    ctx.fill();

    // Mottled dirt.
    ctx.globalCompositeOperation = 'source-atop';
    for (let i = 0; i < 160; i++) {
      ctx.fillStyle = pick(['#3a230f', '#4a2e15', '#6b4423', '#7a5230']);
      ctx.globalAlpha = rand(0.3, 0.7);
      ctx.beginPath();
      ctx.arc(rand(-26, 26), rand(-60, 60), rand(1, 4), 0, Math.PI * 2);
      ctx.fill();
    }

    // Tread grooves.
    // Tread pattern pressed into the dirt.
    ctx.globalAlpha = 0.85;
    ctx.strokeStyle = '#24140a';
    ctx.lineWidth = 2;
    for (let y = -52; y < 58; y += 8) {
      if (y > 2 && y < 18) continue; // Arch has no tread.
      ctx.beginPath();
      for (let i = 0; i <= 10; i++) ctx.lineTo(-30 + i * 6, y + (i % 2) * 3);
      ctx.stroke();
    }
    // A few bare patches where the dirt didn't stick.
    ctx.globalCompositeOperation = 'destination-out';
    for (let i = 0; i < 14; i++) {
      ctx.globalAlpha = rand(0.3, 0.7);
      ctx.beginPath();
      ctx.arc(rand(-22, 22), rand(-55, 55), rand(1.5, 4), 0, Math.PI * 2);
      ctx.fill();
    }

    // Loose dirt around the edge.
    ctx.globalCompositeOperation = 'source-over';
    ctx.fillStyle = '#5b3a1e';
    for (let i = 0; i < 26; i++) {
      const a = rand(0, Math.PI * 2);
      const top = Math.random() < 0.6;
      ctx.globalAlpha = rand(0.4, 0.9);
      ctx.beginPath();
      ctx.arc(Math.cos(a) * rand(27, 33), (top ? -24 : 38) + Math.sin(a) * rand(top ? 35 : 22, top ? 40 : 27), rand(0.6, 1.8), 0, Math.PI * 2);
      ctx.fill();
    }
    return s;
  }

  function blob(ctx, x, y, radius, wobble) {
    const p1 = rand(0, 6);
    const p2 = rand(0, 6);
    ctx.beginPath();
    for (let i = 0; i <= 48; i++) {
      const a = (i / 48) * Math.PI * 2;
      const r = radius * (1 + wobble * (0.6 * Math.sin(3 * a + p1) + 0.4 * Math.sin(7 * a + p2)));
      ctx.lineTo(x + Math.cos(a) * r, y + Math.sin(a) * r);
    }
    ctx.closePath();
  }

  function makeEggSplat() {
    const s = spriteCanvas(160, 160);
    const { ctx } = s;
    ctx.translate(80, 80);

    ctx.fillStyle = 'rgba(255,252,236,0.88)';
    blob(ctx, 0, 0, 40, 0.28);
    ctx.fill();
    for (let i = 0; i < 8; i++) {
      const a = rand(0, Math.PI * 2);
      const d = rand(46, 66);
      blob(ctx, Math.cos(a) * d, Math.sin(a) * d, rand(2.5, 7), 0.2);
      ctx.fill();
    }

    // Glossy edge on the white.
    ctx.strokeStyle = 'rgba(255,255,255,0.8)';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.arc(0, 0, 30, Math.PI * 1.1, Math.PI * 1.45);
    ctx.stroke();

    // Yolk.
    const yx = rand(-8, 8);
    const yy = rand(-8, 8);
    const yolk = ctx.createRadialGradient(yx - 5, yy - 5, 2, yx, yy, 17);
    yolk.addColorStop(0, '#ffe27a');
    yolk.addColorStop(0.6, '#fbbf24');
    yolk.addColorStop(1, '#e98a0b');
    ctx.fillStyle = yolk;
    blob(ctx, yx, yy, 16, 0.08);
    ctx.fill();
    ctx.fillStyle = 'rgba(255,255,255,0.75)';
    ctx.beginPath();
    ctx.ellipse(yx - 6, yy - 6, 4, 2.5, -0.6, 0, Math.PI * 2);
    ctx.fill();

    // Shell pieces.
    for (let i = 0; i < 5; i++) {
      const a = rand(0, Math.PI * 2);
      const d = rand(52, 72);
      const cx = Math.cos(a) * d;
      const cy = Math.sin(a) * d;
      const size = rand(4, 8);
      ctx.fillStyle = '#f3e7d0';
      ctx.strokeStyle = '#c9b48d';
      ctx.lineWidth = 0.8;
      ctx.beginPath();
      for (let j = 0; j < 4; j++) {
        const b = a + (j * Math.PI) / 2 + rand(-0.4, 0.4);
        ctx.lineTo(cx + Math.cos(b) * size * rand(0.5, 1), cy + Math.sin(b) * size * rand(0.5, 1));
      }
      ctx.closePath();
      ctx.fill();
      ctx.stroke();
    }

    // Drips, drawn growing over time in drawMark().
    s.drips = Array.from({ length: 2 + Math.floor(rand(0, 2)) }, () => ({
      x: rand(-30, 30),
      len: rand(22, 42),
      w: rand(5, 8),
    }));
    return s;
  }

  function drawMark(ctx, m, now) {
    const age = now - m.born;
    const alpha = fadeAlpha(age, CONFIG.markLifetimeMs);
    const grow = m.kind === 'egg' ? Math.min(1, 0.35 + age / 140) : 1;
    ctx.save();
    ctx.globalAlpha = alpha * (m.kind === 'shoe' ? 0.85 : 1);
    ctx.translate(m.x, m.y);
    ctx.rotate(m.angle);
    ctx.scale(grow, grow);
    ctx.drawImage(m.sprite.c, -m.sprite.w / 2, -m.sprite.h / 2, m.sprite.w, m.sprite.h);
    if (m.sprite.drips) {
      ctx.rotate(-m.angle); // Drips run straight down.
      const t = Math.min(1, age / 1600);
      ctx.strokeStyle = 'rgba(255,252,236,0.85)';
      ctx.fillStyle = 'rgba(255,252,236,0.85)';
      ctx.lineCap = 'round';
      for (const d of m.sprite.drips) {
        const top = 26;
        const end = top + d.len * t;
        ctx.lineWidth = d.w;
        ctx.beginPath();
        ctx.moveTo(d.x, top);
        ctx.lineTo(d.x, end);
        ctx.stroke();
        ctx.beginPath();
        ctx.arc(d.x, end, d.w * 0.7, 0, Math.PI * 2);
        ctx.fill();
      }
    }
    ctx.restore();
  }

  // ---- Chain saw and pen strokes -------------------------------------------------------------

  function groupAlpha(g, now) {
    if (!g.strokes.length) return 0;
    if (g.drawing) return 1;
    const alpha = fadeAlpha(now - g.releasedAt, CONFIG.strokeLingerMs);
    if (!alpha) g.strokes = [];
    return alpha;
  }

  function drawSawStrokes(ctx, strokes, alpha) {
    // The cut shifts the photo inside a band along the stroke, like material torn apart.
    resetTransform(bandCtx);
    bandCtx.lineCap = 'round';
    bandCtx.lineJoin = 'round';
    bandCtx.lineWidth = 15;
    bandCtx.strokeStyle = '#000';
    for (const pts of strokes) {
      smoothPath(bandCtx, pts);
      bandCtx.stroke();
    }
    bandCtx.globalCompositeOperation = 'source-in';
    const shifted = drawPhoto(bandCtx, 5, -4);
    bandCtx.globalCompositeOperation = 'source-over';

    ctx.save();
    ctx.globalAlpha = alpha;
    if (shifted) {
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.drawImage(bandCanvas, 0, 0);
      ctx.setTransform(pxPerUnit, 0, 0, pxPerUnit, 0, 0);
    }
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    for (const pts of strokes) {
      const jagged = (d) => {
        ctx.beginPath();
        pts.forEach((p, i) => {
          const [nx, ny] = normalAt(pts, i);
          const off = d(p, i);
          const x = p.x + nx * off;
          const y = p.y + ny * off;
          if (i) ctx.lineTo(x, y);
          else ctx.moveTo(x, y);
        });
      };
      // Splintered edges on either side of the cut.
      for (const side of [-1, 1]) {
        jagged((p) => side * (5.5 + Math.abs(p.j) * 2.5));
        ctx.setLineDash([2.5, 2]);
        ctx.strokeStyle = 'rgba(245,228,196,0.75)';
        ctx.lineWidth = 1.2;
        ctx.stroke();
        ctx.setLineDash([]);
      }
      // Tooth scratches torn out sideways from the cut.
      ctx.strokeStyle = 'rgba(28,10,4,0.8)';
      ctx.lineWidth = 1.2;
      for (let i = 1; i < pts.length; i += 2) {
        const [nx, ny] = normalAt(pts, i);
        const side = pts[i].j > 0 ? 1 : -1;
        const len = 4 + Math.abs(pts[i].j) * 5;
        ctx.beginPath();
        ctx.moveTo(pts[i].x, pts[i].y);
        ctx.lineTo(pts[i].x + nx * side * len + pts[i].j, pts[i].y + ny * side * len - pts[i].j);
        ctx.stroke();
      }
      // The cut itself: a dark, ragged gash.
      jagged((p) => p.j * 2.6);
      ctx.strokeStyle = '#140602';
      ctx.lineWidth = 6.5;
      ctx.stroke();
      ctx.strokeStyle = '#5a1b08';
      ctx.lineWidth = 2;
      ctx.stroke();
    }
    ctx.restore();
  }

  function drawPenStrokes(ctx, strokes, alpha) {
    ctx.save();
    ctx.globalAlpha = alpha;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    for (const pts of strokes) {
      smoothPath(ctx, pts);
      ctx.strokeStyle = 'rgba(220,20,30,0.25)';
      ctx.lineWidth = 6;
      ctx.stroke();
      ctx.strokeStyle = '#d7141e';
      ctx.lineWidth = 2.6;
      ctx.stroke();
    }
    ctx.restore();
  }

  function addSawdust(x, y) {
    for (let i = 0; i < 3; i++) {
      particles.push({
        x,
        y,
        vx: rand(-0.12, 0.12),
        vy: rand(-0.16, -0.04),
        r: rand(0.8, 2),
        born: performance.now(),
        life: rand(450, 800),
        color: pick(['#e7cfa0', '#d4b27a', '#f3e2bd']),
      });
    }
  }

  function drawParticles(ctx, now) {
    particles = particles.filter((p) => now - p.born < p.life);
    for (const p of particles) {
      const t = now - p.born;
      ctx.globalAlpha = 1 - t / p.life;
      ctx.fillStyle = p.color;
      ctx.beginPath();
      ctx.arc(p.x + p.vx * t, p.y + p.vy * t + 0.00025 * t * t, p.r, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.globalAlpha = 1;
  }

  // ---- Rendering -----------------------------------------------------------------------------

  function renderPerm() {
    resetTransform(permCtx);
    for (const c of cracks) drawCracks(permCtx, c);
    for (const shot of shots) for (const h of shot) drawHole(permCtx, h);
  }

  // Draws the temporary layer; returns whether anything is still animating.
  function renderTemp(now) {
    resetTransform(tempCtx);
    marks = marks.filter((m) => now - m.born < CONFIG.markLifetimeMs);
    for (const m of marks) drawMark(tempCtx, m, now);

    const saw = groups['Chain Saw'];
    const sawAlpha = groupAlpha(saw, now);
    if (sawAlpha) drawSawStrokes(tempCtx, saw.strokes, sawAlpha);
    const pen = groups.Pen;
    const penAlpha = groupAlpha(pen, now);
    if (penAlpha) drawPenStrokes(tempCtx, pen.strokes, penAlpha);
    drawParticles(tempCtx, now);

    return marks.length > 0 || particles.length > 0 || sawAlpha > 0 || penAlpha > 0;
  }

  function frame(now) {
    frameRequest = renderTemp(now) ? requestAnimationFrame(frame) : null;
  }

  function requestRender() {
    if (!frameRequest) frameRequest = requestAnimationFrame(frame);
  }

  function resize() {
    const rect = stage.getBoundingClientRect();
    if (!rect.width) return;
    const px = Math.round(rect.width * (window.devicePixelRatio || 1));
    for (const ctx of [permCtx, tempCtx, bandCtx]) {
      ctx.canvas.width = px;
      ctx.canvas.height = px;
    }
    pxPerUnit = px / SIZE;
    renderPerm();
    renderTemp(performance.now());
  }

  // ---- Strike animations ---------------------------------------------------------------------

  function shake(strength) {
    if (reducedMotion.matches) return;
    const s = strength;
    stage.animate(
      [
        { transform: 'translate(0, 0)' },
        { transform: `translate(${-s}px, ${s * 0.7}px)` },
        { transform: `translate(${s * 0.8}px, ${-s * 0.5}px)` },
        { transform: `translate(${-s * 0.4}px, ${s * 0.3}px)` },
        { transform: 'translate(0, 0)' },
      ],
      { duration: 180, easing: 'ease-out' },
    );
  }

  function makeSprite(name) {
    const spec = SPRITES[name];
    const k = cssPerUnit();
    const el = document.createElement('div');
    el.className = 'fx-sprite';
    el.innerHTML = spec.svg;
    el.style.width = `${spec.w * k}px`;
    el.style.height = `${spec.h * k}px`;
    el.style.transformOrigin = spec.origin;
    spriteLayer.appendChild(el);
    return { el, k, tx: (x) => x * k - spec.w * k * spec.ax, ty: (y) => y * k - spec.h * k * spec.ay };
  }

  // Runs `keyframes` on a sprite, then calls `land` unless reset() happened in the meantime.
  function fly(name, p, keyframes, duration, land, after) {
    const gen = generation;
    if (reducedMotion.matches) return land();
    const s = makeSprite(name);
    const x = s.tx(p.x);
    const y = s.ty(p.y);
    const k = s.k;
    const anim = s.el.animate(keyframes(x, y, k), { duration, easing: 'cubic-bezier(.5,0,.9,.6)', fill: 'forwards' });
    anim.onfinish = () => {
      if (gen !== generation) return s.el.remove();
      land();
      if (!after) return s.el.remove();
      const out = s.el.animate(after(x, y, k), { duration: 280, easing: 'ease-out', fill: 'forwards' });
      out.onfinish = () => s.el.remove();
    };
  }

  let hammerSwing = null;

  function strikeHammer(p) {
    // Swing the hammer cursor down, then back up.
    stage.style.cursor = HAMMER_DOWN;
    clearTimeout(hammerSwing);
    hammerSwing = setTimeout(() => {
      if (weapon && weapon.name === 'Hammer') stage.style.cursor = HAMMER_RAISED;
    }, 140);

    const cracked = hammerHits < CONFIG.hammerMaxHits;
    if (cracked) {
      hammerHits++;
      cracks.push(makeCracks(p.x, p.y, hammerHits));
      renderPerm();
    }
    if (sound) sound.hammer(cracked ? hammerHits : 0);
    shake(5);
  }

  function throwShoe(p) {
    if (sound && !reducedMotion.matches) sound.whoosh(0.26);
    fly(
      'Shoe',
      p,
      (x, y, k) => [
        { transform: `translate(${x + 150 * k}px, ${y - 170 * k}px) rotate(55deg) scale(1.9)`, opacity: 0 },
        { opacity: 1, offset: 0.2 },
        { transform: `translate(${x}px, ${y}px) rotate(-8deg) scale(1)`, opacity: 1 },
      ],
      260,
      () => {
        marks.push({ kind: 'shoe', x: p.x, y: p.y, angle: rand(-0.5, 0.5), born: performance.now(), sprite: makeShoePrint() });
        if (sound) sound.shoe();
        shake(3);
        requestRender();
      },
      (x, y, k) => [
        { transform: `translate(${x}px, ${y}px) rotate(-8deg) scale(1)`, opacity: 1 },
        { transform: `translate(${x + 30 * k}px, ${y + 80 * k}px) rotate(-45deg) scale(0.85)`, opacity: 0 },
      ],
    );
  }

  function throwEgg(p) {
    if (sound && !reducedMotion.matches) sound.whoosh(0.28);
    fly(
      'Egg',
      p,
      (x, y, k) => [
        { transform: `translate(${x - 160 * k}px, ${y - 160 * k}px) rotate(-320deg) scale(1.9)`, opacity: 0 },
        { opacity: 1, offset: 0.2 },
        { transform: `translate(${x}px, ${y}px) rotate(0deg) scale(1)`, opacity: 1 },
      ],
      280,
      () => {
        marks.push({ kind: 'egg', x: p.x, y: p.y, angle: rand(0, Math.PI * 2), born: performance.now(), sprite: makeEggSplat() });
        if (sound) sound.egg();
        shake(2);
        requestRender();
      },
    );
  }

  function fireGun(p) {
    shots.push(makeShot(p.x, p.y));
    renderPerm();
    if (sound) sound.gun();
    shake(6);
    if (reducedMotion.matches) return;
    const k = cssPerUnit();
    const flash = document.createElement('div');
    flash.className = 'fx-flash';
    flash.style.left = `${p.x * k}px`;
    flash.style.top = `${p.y * k}px`;
    spriteLayer.appendChild(flash);
    flash.animate(
      [
        { transform: 'translate(-50%, -50%) scale(0.4)', opacity: 1 },
        { transform: 'translate(-50%, -50%) scale(1.3)', opacity: 0 },
      ],
      { duration: 120, easing: 'ease-out' },
    ).onfinish = () => flash.remove();
  }

  // ---- Chain saw and pen dragging ------------------------------------------------------------

  function startDrag(e, p) {
    const g = groups[weapon.name];
    const now = performance.now();
    // Marks still on screen stay; the new ones are added to them.
    if (!g.drawing && now - g.releasedAt >= CONFIG.strokeLingerMs) g.strokes = [];
    g.drawing = true;
    g.strokes.push([{ ...p, j: rand(-1, 1) }]);
    activeDrag = { pointerId: e.pointerId, group: g, saw: weapon.name === 'Chain Saw', last: p, lastTime: e.timeStamp };
    activeDrag.voice = sound ? (activeDrag.saw ? sound.saw : sound.pen) : null;
    if (activeDrag.voice) activeDrag.voice.start();
    stage.setPointerCapture(e.pointerId);
    if (activeDrag.saw) {
      stage.classList.add('sawing');
      addSawdust(p.x, p.y);
    }
    requestRender();
  }

  function moveDrag(e) {
    if (!activeDrag || e.pointerId !== activeDrag.pointerId) return;
    const events = e.getCoalescedEvents ? e.getCoalescedEvents() : [e];
    const stroke = activeDrag.group.strokes[activeDrag.group.strokes.length - 1];
    for (const ev of events.length ? events : [e]) {
      const p = toLogical(ev);
      const last = stroke[stroke.length - 1];
      if (Math.hypot(p.x - last.x, p.y - last.y) < 2.5) continue;
      stroke.push({ ...p, j: rand(-1, 1) });
      if (activeDrag.saw && Math.random() < 0.6) addSawdust(p.x, p.y);
    }
    // Speed in logical px per ms; about 1 is a fast drag.
    const p = toLogical(e);
    const dt = Math.max(1, e.timeStamp - activeDrag.lastTime);
    const speed = Math.hypot(p.x - activeDrag.last.x, p.y - activeDrag.last.y) / dt;
    activeDrag.last = p;
    activeDrag.lastTime = e.timeStamp;
    if (activeDrag.voice) activeDrag.voice.speed(speed);
    requestRender();
  }

  function endDrag(e) {
    if (!activeDrag || (e && e.pointerId !== activeDrag.pointerId)) return;
    activeDrag.group.drawing = false;
    activeDrag.group.releasedAt = performance.now();
    if (activeDrag.voice) activeDrag.voice.stop();
    activeDrag = null;
    stage.classList.remove('sawing');
    requestRender();
  }

  function onPointerDown(e) {
    if (!weapon || e.button !== 0) return;
    e.preventDefault();
    const p = toLogical(e);
    if (DRAG_TOOLS.includes(weapon.name)) return startDrag(e, p);
    if (weapon.name === 'Hammer') strikeHammer(p);
    else if (weapon.name === 'Shoe') throwShoe(p);
    else if (weapon.name === 'Egg') throwEgg(p);
    else if (weapon.name === 'Gun') fireGun(p);
  }

  // ---- Public API ----------------------------------------------------------------------------

  function setup(elements) {
    stage = elements.stage;
    photo = elements.photo;
    spriteLayer = elements.sprites;
    permCtx = elements.permCanvas.getContext('2d');
    tempCtx = elements.tempCanvas.getContext('2d');
    bandCanvas = document.createElement('canvas');
    bandCtx = bandCanvas.getContext('2d');
    groups = newGroups();

    stage.addEventListener('pointerdown', onPointerDown);
    stage.addEventListener('pointermove', moveDrag);
    stage.addEventListener('pointerup', endDrag);
    stage.addEventListener('pointercancel', endDrag);
    stage.addEventListener('lostpointercapture', endDrag);
    stage.addEventListener('dragstart', (e) => e.preventDefault());
    new ResizeObserver(resize).observe(stage);
  }

  function setWeapon(next) {
    endDrag();
    weapon = next;
    stage.style.cursor = weapon ? cursorFor(weapon) : '';
    stage.classList.toggle('armed', Boolean(weapon));
  }

  function reset() {
    generation++;
    endDrag();
    hammerHits = 0;
    cracks = [];
    shots = [];
    marks = [];
    particles = [];
    groups = newGroups();
    spriteLayer.replaceChildren();
    renderPerm();
    renderTemp(performance.now());
  }

  window.WeaponFX = { CONFIG, setup, setWeapon, reset };
})();
