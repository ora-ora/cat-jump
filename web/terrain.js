// v17 MAP2：固定地形（河流 + 桥/踏石浅滩、湖、山丘）。纯几何 + 离屏瓦片渲染，供 game.js 使用。
// 地形只在前端；不影响分数/出鼠规则，也不影响服务端校验。
(function () {
  "use strict";
  var HALF = 1500;
  // ---- 河流中心线（Catmull-Rom 平滑后密采样）----
  var CTRL = [[-1600, -1080], [-1200, -1150], [-830, -880], [-520, -540], [-170, -430], [240, -400], [520, -120], [660, 280], [900, 640], [1180, 900], [1600, 1120]];
  var RIVER_HW = 72;
  var PTS = (function () {
    var out = [], n = CTRL.length;
    for (var i = 0; i < n - 1; i++) {
      var p0 = CTRL[Math.max(0, i - 1)], p1 = CTRL[i], p2 = CTRL[i + 1], p3 = CTRL[Math.min(n - 1, i + 2)];
      for (var k = 0; k < 16; k++) {
        var t = k / 16, t2 = t * t, t3 = t2 * t;
        out.push([0.5 * (2 * p1[0] + (-p0[0] + p2[0]) * t + (2 * p0[0] - 5 * p1[0] + 4 * p2[0] - p3[0]) * t2 + (-p0[0] + 3 * p1[0] - 3 * p2[0] + p3[0]) * t3),
                  0.5 * (2 * p1[1] + (-p0[1] + p2[1]) * t + (2 * p0[1] - 5 * p1[1] + 4 * p2[1] - p3[1]) * t2 + (-p0[1] + 3 * p1[1] - 3 * p2[1] + p3[1]) * t3)]);
      }
    }
    out.push(CTRL[n - 1]); return out;
  })();
  // 河宽轻微变化（看起来更自然）
  function hwAt(i) { return RIVER_HW + Math.sin(i * 0.21) * 10 + Math.sin(i * 0.067 + 1) * 8; }
  function nearestRiver(x, y) {
    var best = 1e18, bi = 0, bt = 0, bx = 0, by = 0;
    for (var i = 0; i < PTS.length - 1; i++) {
      var a = PTS[i], b = PTS[i + 1], ex = b[0] - a[0], ey = b[1] - a[1], L = ex * ex + ey * ey;
      var t = L > 0 ? ((x - a[0]) * ex + (y - a[1]) * ey) / L : 0; t = t < 0 ? 0 : t > 1 ? 1 : t;
      var px = a[0] + ex * t, py = a[1] + ey * t, d = (x - px) * (x - px) + (y - py) * (y - py);
      if (d < best) { best = d; bi = i; bt = t; bx = px; by = py; }
    }
    var a2 = PTS[bi], b2 = PTS[bi + 1], tl = Math.hypot(b2[0] - a2[0], b2[1] - a2[1]) || 1;
    return { d: Math.sqrt(best), px: bx, py: by, i: bi + bt, hw: hwAt(bi + bt), tx: (b2[0] - a2[0]) / tl, ty: (b2[1] - a2[1]) / tl };
  }
  // 过河点：2 座木桥 + 1 处踏石浅滩（idx = 中心线采样下标）
  function crossingAt(idx, kind, w) { var i = Math.floor(idx), p = PTS[i], q = PTS[i + 1], L = Math.hypot(q[0] - p[0], q[1] - p[1]); return { x: p[0], y: p[1], tx: (q[0] - p[0]) / L, ty: (q[1] - p[1]) / L, w: w, kind: kind, hw: hwAt(idx) }; }
  var CROSS = [crossingAt(50, "bridge", 96), crossingAt(110, "bridge", 96), crossingAt(84, "ford", 84), crossingAt(22, "ford", 80)];
  // 湖（左下）
  var LAKE = { x: -960, y: 960, rx: 330, ry: 235 };
  // 山（右上大山 + 两个小丘）：圆的并集
  var ROCKS = [[1130, -1130, 330], [820, -1260, 210], [1290, -820, 230], [940, -900, 160], [1270, -1330, 200], [1380, -1080, 200],
               [-1020, -120, 120], [-1110, -40, 90], [330, 1030, 135], [450, 1110, 95]];
  function inCross(x, y, pad) {
    for (var k = 0; k < CROSS.length; k++) { var c = CROSS[k], a = (x - c.x) * c.tx + (y - c.y) * c.ty; if (Math.abs(a) < c.w / 2 - pad) { var b = -(x - c.x) * c.ty + (y - c.y) * c.tx; if (Math.abs(b) < c.hw + 60) return c; } }
    return null;
  }
  // 是否被地形阻挡（m = 额外外扩距离）
  function blocked(x, y, m) {
    m = m || 0;
    var r = nearestRiver(x, y); if (r.d < r.hw + m && !inCross(x, y, 0)) return true;
    var lx = (x - LAKE.x) / (LAKE.rx + m), ly = (y - LAKE.y) / (LAKE.ry + m); if (lx * lx + ly * ly < 1) return true;
    for (var i = 0; i < ROCKS.length; i++) { var c = ROCKS[i], dx = x - c[0], dy = y - c[1], R = c[2] + m; if (dx * dx + dy * dy < R * R) return true; }
    return false;
  }
  // 圆形实体推出地形（沿岸滑行：只沿法线推出，切向速度保留）
  var NG = 50, NN = Math.ceil(2 * HALF / NG) + 2, near = null;
  function nearCell(x, y) {
    if (!near) { near = new Int8Array(NN * NN); }
    var i = Math.floor((x + HALF) / NG) + 1, j = Math.floor((y + HALF) / NG) + 1; if (i < 0 || j < 0 || i >= NN || j >= NN) return false;
    var k = j * NN + i, v = near[k]; if (v === 0) { v = blocked(-HALF + (i - 0.5) * NG, -HALF + (j - 0.5) * NG, 80) ? 1 : -1; near[k] = v; } return v === 1;
  }
  function push(o) {
    if (!nearCell(o.x, o.y)) return false;
    var r0 = o.r, it, hit = false;
    for (it = 0; it < 3; it++) {
      var moved = false, rv = nearestRiver(o.x, o.y);
      if (rv.d < rv.hw + r0) {
        var c = null, a = 0;
        for (var k = 0; k < CROSS.length; k++) { var cc = CROSS[k], aa = (o.x - cc.x) * cc.tx + (o.y - cc.y) * cc.ty, bb = -(o.x - cc.x) * cc.ty + (o.y - cc.y) * cc.tx; if (Math.abs(aa) < cc.w / 2 + r0 && Math.abs(bb) < cc.hw + 60) { c = cc; a = aa; break; } }
        if (c && Math.abs(a) < c.w / 2 - r0 * 0.6) { /* 在桥/浅滩上 */ }
        else if (c && rv.d < rv.hw - 4) { var lim = c.w / 2 - r0 * 0.6, na = a > 0 ? lim : -lim; o.x += (na - a) * c.tx; o.y += (na - a) * c.ty; moved = true; } // 桥栏：推回桥面
        else { var nx = (o.x - rv.px) / (rv.d || 1), ny = (o.y - rv.py) / (rv.d || 1); if (rv.d < 0.01) { nx = -rv.ty; ny = rv.tx; } o.x = rv.px + nx * (rv.hw + r0); o.y = rv.py + ny * (rv.hw + r0); moved = true; }
      }
      var lx = o.x - LAKE.x, ly = o.y - LAKE.y, n = Math.sqrt(lx * lx / ((LAKE.rx + r0) * (LAKE.rx + r0)) + ly * ly / ((LAKE.ry + r0) * (LAKE.ry + r0)));
      if (n < 1) { if (n < 0.001) { lx = 1; n = 1 / (LAKE.rx + r0); } o.x = LAKE.x + lx / n; o.y = LAKE.y + ly / n; moved = true; }
      for (var i = 0; i < ROCKS.length; i++) { var q = ROCKS[i], dx = o.x - q[0], dy = o.y - q[1], R = q[2] + r0, d2 = dx * dx + dy * dy; if (d2 < R * R) { var d = Math.sqrt(d2) || 1; o.x = q[0] + dx / d * R; o.y = q[1] + dy / d * R; moved = true; } }
      if (!moved) break; hit = true;
    }
    return hit;
  }
  // 粗网格可达性（从出生点 flood-fill），用于老鼠窝选址
  var G = 25, GN = Math.ceil(2 * HALF / G), reach = null;
  function buildReach(rad) {
    var free = new Uint8Array(GN * GN), q = new Int32Array(GN * GN), h = 0, t = 0; reach = new Uint8Array(GN * GN);
    for (var j = 0; j < GN; j++) for (var i = 0; i < GN; i++) free[j * GN + i] = blocked(-HALF + (i + 0.5) * G, -HALF + (j + 0.5) * G, rad) ? 0 : 1;
    var s = (GN >> 1) * GN + (GN >> 1); reach[s] = 1; q[t++] = s;
    while (h < t) { var c = q[h++], ci = c % GN, cj = (c / GN) | 0;
      var nb = [ci > 0 ? c - 1 : -1, ci < GN - 1 ? c + 1 : -1, cj > 0 ? c - GN : -1, cj < GN - 1 ? c + GN : -1];
      for (var k = 0; k < 4; k++) { var v = nb[k]; if (v >= 0 && free[v] && !reach[v]) { reach[v] = 1; q[t++] = v; } } }
    return reach;
  }
  function reachable(x, y) { if (!reach) buildReach(16); var i = Math.floor((x + HALF) / G), j = Math.floor((y + HALF) / G); return i >= 0 && j >= 0 && i < GN && j < GN && reach[j * GN + i] === 1; }

  // ---- 渲染：按瓦片（世界 400×400）离屏缓存 ----
  var TILE = 400;
  function rr(seed) { var s = seed | 0; return function () { s = (s + 0x6D2B79F5) | 0; var t = Math.imul(s ^ (s >>> 15), 1 | s); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }
  function riverPath(g) { g.beginPath(); g.moveTo(PTS[0][0], PTS[0][1]); for (var i = 1; i < PTS.length; i++) g.lineTo(PTS[i][0], PTS[i][1]); }
  // 变宽河流：用沿中心线的一串圆 / 多段描边近似
  function riverStroke(g, extra, color) {
    g.strokeStyle = color; g.lineCap = "round"; g.lineJoin = "round";
    for (var i = 0; i < PTS.length - 1; i++) { g.lineWidth = 2 * (hwAt(i + 0.5) + extra); g.beginPath(); g.moveTo(PTS[i][0], PTS[i][1]); g.lineTo(PTS[i + 1][0], PTS[i + 1][1]); g.stroke(); }
  }
  function ell(g, x, y, rx, ry, col) { g.fillStyle = col; g.beginPath(); g.ellipse(x, y, rx, ry, 0, 0, 7); g.fill(); }
  function drawWorld(g, x0, y0, imgs) {
    var R = rr(1234), M = 260, X0 = x0 - M, Y0 = y0 - M, X1 = x0 + TILE + M, Y1 = y0 + TILE + M;
    function vis(x, y, r) { return x + r > X0 && x - r < X1 && y + r > Y0 && y - r < Y1; }
    var segOn = []; for (var si = 0; si < PTS.length - 1; si++) segOn.push(vis((PTS[si][0] + PTS[si + 1][0]) / 2, (PTS[si][1] + PTS[si + 1][1]) / 2, 140));
    var lakeOn = vis(LAKE.x, LAKE.y, LAKE.rx + 60);
    function riverStroke(g, extra, color) { g.strokeStyle = color; g.lineCap = "round"; g.lineJoin = "round";
      for (var i = 0; i < PTS.length - 1; i++) { if (!segOn[i]) continue; g.lineWidth = 2 * (hwAt(i + 0.5) + extra); g.beginPath(); g.moveTo(PTS[i][0], PTS[i][1]); g.lineTo(PTS[i + 1][0], PTS[i + 1][1]); g.stroke(); } }
    function ell2(g, x, y, rx, ry, col) { if (lakeOn) ell(g, x, y, rx, ry, col); }
    // 1) 岸边沙地 + 湿沙
    riverStroke(g, 34, "#ead9a6"); riverStroke(g, 20, "#dcc78f");
    ell2(g, LAKE.x, LAKE.y, LAKE.rx + 40, LAKE.ry + 36, "#ead9a6"); ell2(g, LAKE.x, LAKE.y, LAKE.rx + 20, LAKE.ry + 18, "#dcc78f");
    // 2) 岸边石头描边
    riverStroke(g, 8, "#8d9690"); ell2(g, LAKE.x, LAKE.y, LAKE.rx + 7, LAKE.ry + 6, "#8d9690");
    // 3) 水：深→浅→高光
    riverStroke(g, 0, "#5bb4e3"); riverStroke(g, -18, "#72c5ee"); riverStroke(g, -42, "#8fd5f6");
    ell2(g, LAKE.x, LAKE.y, LAKE.rx, LAKE.ry, "#5bb4e3"); ell2(g, LAKE.x + 8, LAKE.y - 6, LAKE.rx - 40, LAKE.ry - 32, "#72c5ee"); ell2(g, LAKE.x + 20, LAKE.y - 14, LAKE.rx - 110, LAKE.ry - 90, "#8fd5f6");
    // 岸边圆石子（沿河两岸）
    for (var i = 0; i < PTS.length - 1; i++) {
      var p = PTS[i], q = PTS[i + 1], L = Math.hypot(q[0] - p[0], q[1] - p[1]) || 1, nx = -(q[1] - p[1]) / L, ny = (q[0] - p[0]) / L, hw = hwAt(i);
      for (var sd = -1; sd <= 1; sd += 2) for (var s = 0; s < 2; s++) { if (!segOn[i]) { R(); R(); R(); R(); R(); continue; } var f = R(), bx = p[0] + (q[0] - p[0]) * f + nx * sd * (hw + 4 + R() * 6), by = p[1] + (q[1] - p[1]) * f + ny * sd * (hw + 4 + R() * 6), rs = 6 + R() * 8;
        ell(g, bx + 1.5, by + 2, rs, rs * 0.75, "rgba(60,70,60,.35)"); ell(g, bx, by, rs, rs * 0.75, R() < 0.5 ? "#a9b1ab" : "#bcc3bc"); ell(g, bx - rs * 0.25, by - rs * 0.25, rs * 0.45, rs * 0.3, "rgba(255,255,255,.35)"); }
    }
    R = rr(2000);
    for (var a = 0; a < 6.28 && lakeOn; a += 0.09) { var bx2 = LAKE.x + Math.cos(a) * (LAKE.rx + 5), by2 = LAKE.y + Math.sin(a) * (LAKE.ry + 5), rs2 = 6 + R() * 8; ell(g, bx2, by2, rs2, rs2 * 0.75, R() < 0.5 ? "#a9b1ab" : "#bcc3bc"); }
    R = rr(2001);
    // 水面波纹高光（静态，烘焙）
    g.strokeStyle = "rgba(255,255,255,.55)"; g.lineWidth = 3; g.lineCap = "round";
    for (i = 3; i < PTS.length - 2; i += 3) { var pp = PTS[i], qq = PTS[i + 1], LL = Math.hypot(qq[0] - pp[0], qq[1] - pp[1]) || 1, tx = (qq[0] - pp[0]) / LL, ty = (qq[1] - pp[1]) / LL, off = (R() - 0.5) * hwAt(i) * 1.1;
      g.beginPath(); g.moveTo(pp[0] - ty * off, pp[1] + tx * off); g.lineTo(pp[0] - ty * off + tx * 22, pp[1] + tx * off + ty * 22); g.stroke(); }
    R = rr(2002);
    // 荷叶
    for (i = 0; i < 9 && lakeOn; i++) { var ang = R() * 6.28, rd = Math.sqrt(R()) * 0.75, lx = LAKE.x + Math.cos(ang) * LAKE.rx * rd, ly = LAKE.y + Math.sin(ang) * LAKE.ry * rd, lr = 14 + R() * 10;
      g.fillStyle = "#4f9a3c"; g.beginPath(); g.ellipse(lx + 1, ly + 2, lr, lr * 0.8, 0, 0, 7); g.fill(); g.fillStyle = "#7cc35a"; g.beginPath(); g.moveTo(lx, ly); g.ellipse(lx, ly, lr, lr * 0.8, 0, 0.4, 6.0); g.closePath(); g.fill();
      if (R() < 0.4) ell(g, lx + lr * 0.3, ly - lr * 0.2, 5, 4, "#ffb3c8"); }
    R = rr(2003);
    // 4) 过河点：木桥 / 踏石
    for (var k = 0; k < CROSS.length; k++) {
      var c = CROSS[k]; g.save(); g.translate(c.x, c.y); g.rotate(Math.atan2(c.ty, c.tx));
      var len = c.hw + 34;
      if (c.kind === "bridge") {
        var bw = c.w / 2;
        g.fillStyle = "rgba(30,60,80,.3)"; g.fillRect(-bw + 6, -len + 8, 2 * bw, 2 * len);
        g.fillStyle = "#b9814e"; g.fillRect(-bw, -len, 2 * bw, 2 * len);
        for (var pl = -len; pl < len; pl += 16) { g.fillStyle = (Math.round(pl / 16) & 1) ? "#c99460" : "#b57d4b"; g.fillRect(-bw + 8, pl + 1, 2 * bw - 16, 14); g.fillStyle = "rgba(90,50,25,.5)"; g.fillRect(-bw + 8, pl + 14, 2 * bw - 16, 2); }
        g.fillStyle = "#8a5a32"; g.fillRect(-bw, -len, 9, 2 * len); g.fillRect(bw - 9, -len, 9, 2 * len);
        for (var po = -len; po <= len; po += len / 2) { ell(g, -bw + 4.5, po, 8, 8, "#734a28"); ell(g, bw - 4.5, po, 8, 8, "#734a28"); ell(g, -bw + 3, po - 2, 4, 3, "#9a6a40"); ell(g, bw - 6, po - 2, 4, 3, "#9a6a40"); }
      } else {
        for (var st = -len + 18; st < len - 10; st += 30) { var jx = (R() - 0.5) * c.w * 0.35, sr = 17 + R() * 5; ell(g, jx + 2, st + 3, sr, sr * 0.8, "rgba(40,70,90,.35)"); ell(g, jx, st, sr, sr * 0.8, "#cbbf9e"); ell(g, jx - 4, st - 4, sr * 0.55, sr * 0.4, "#e2d8bb"); }
      }
      g.restore();
    }
    // 5) 山丘：投影 → 崖壁（南侧可见的岩面带竖向裂纹）→ 草顶 → 岩块/灌木
    for (i = 0; i < ROCKS.length; i++) { var o = ROCKS[i]; ell(g, o[0] + 16, o[1] + 26, o[2] + 6, o[2] * 0.96, "rgba(40,70,30,.30)"); }
    for (i = 0; i < ROCKS.length; i++) { o = ROCKS[i]; ell(g, o[0], o[1], o[2] + 3, o[2] + 3, "#4f5a52"); ell(g, o[0], o[1] - 2, o[2], o[2], "#7d8a80"); }
    g.lineCap = "round";
    for (i = 0; i < ROCKS.length; i++) { o = ROCKS[i]; R = rr(555 + i * 97); if (!vis(o[0], o[1], o[2] + 40)) continue;
      for (var aa0 = 0.15; aa0 < 3.0; aa0 += 0.16) { var cx0 = o[0] + Math.cos(aa0) * o[2] * 0.97, cy0 = o[1] + Math.sin(aa0) * o[2] * 0.97, len0 = o[2] * (0.16 + R() * 0.1);
        g.strokeStyle = R() < 0.5 ? "rgba(50,58,52,.55)" : "rgba(170,180,172,.55)"; g.lineWidth = 3 + R() * 3; g.beginPath(); g.moveTo(cx0, cy0); g.lineTo(cx0 + (R() - 0.5) * 6, cy0 - len0); g.stroke(); } }
    for (i = 0; i < ROCKS.length; i++) { o = ROCKS[i]; ell(g, o[0], o[1] - o[2] * 0.2, o[2] * 0.93, o[2] * 0.78, "#3f7a35"); }
    for (i = 0; i < ROCKS.length; i++) { o = ROCKS[i]; ell(g, o[0], o[1] - o[2] * 0.22, o[2] * 0.9, o[2] * 0.75, "#86c862"); ell(g, o[0] - o[2] * 0.15, o[1] - o[2] * 0.32, o[2] * 0.6, o[2] * 0.46, "#9bd674"); }
    for (i = 0; i < ROCKS.length; i++) { o = ROCKS[i]; R = rr(777 + i * 131); if (!vis(o[0], o[1], o[2] + 60)) continue; var nR = Math.round(o[2] / 22);
      for (var j = 0; j < nR; j++) { var aa = 0.1 + R() * 2.9, rx2 = o[0] + Math.cos(aa) * o[2] * 0.9, ry2 = o[1] + Math.sin(aa) * o[2] * 0.9;
        if (imgs && imgs.rock) { var rw = 40 + R() * 36; g.drawImage(imgs.rock, rx2 - rw / 2, ry2 - rw * 0.7, rw, rw * imgs.rock.height / imgs.rock.width); } else ell(g, rx2, ry2, 14, 10, "#a3ada6"); }
      for (j = 0; j < Math.max(1, nR / 2); j++) { aa = R() * 6.28; var rd2 = 0.2 + R() * 0.45, bw2 = 46 + R() * 26, bxx = o[0] + Math.cos(aa) * o[2] * rd2, byy = o[1] - o[2] * 0.25 + Math.sin(aa) * o[2] * rd2 * 0.7;
        if (imgs && R() < 0.35 && imgs.rock) g.drawImage(imgs.rock, bxx - bw2 / 2, byy - bw2 / 2, bw2, bw2 * imgs.rock.height / imgs.rock.width);
        else if (imgs && imgs.bush) g.drawImage(imgs.bush, bxx - bw2 / 2, byy - bw2 / 2, bw2, bw2 * imgs.bush.height / imgs.bush.width); }
    }
    R = rr(2004);
    // 芦苇（水边）
    g.strokeStyle = "#5c9a3a"; g.lineWidth = 3;
    for (i = 2; i < PTS.length - 2; i += 4) { var p3 = PTS[i], q3 = PTS[i + 1], L3 = Math.hypot(q3[0] - p3[0], q3[1] - p3[1]) || 1, n3x = -(q3[1] - p3[1]) / L3, n3y = (q3[0] - p3[0]) / L3, sd3 = R() < 0.5 ? -1 : 1;
      if (inCross(p3[0], p3[1], -60) || !segOn[i]) continue;
      var rx3 = p3[0] + n3x * sd3 * (hwAt(i) - 6), ry3 = p3[1] + n3y * sd3 * (hwAt(i) - 6);
      for (j = 0; j < 4; j++) { var bx3 = rx3 + (R() - 0.5) * 16; g.beginPath(); g.moveTo(bx3, ry3 + 6); g.quadraticCurveTo(bx3 + (R() - 0.5) * 8, ry3 - 14, bx3 + (R() - 0.5) * 12, ry3 - 26 - R() * 10); g.stroke(); }
      ell(g, rx3 + 3, ry3 - 26, 3.5, 8, "#8a5a32"); }
  }
  var tileCache = new Map();
  // 这个瓦片里有没有地形（没有就跳过，大部分草地瓦片为空）
  var tileHas = {};
  function tileNonEmpty(ti, tj) {
    var k = ti + "," + tj; if (k in tileHas) return tileHas[k];
    var x0 = ti * TILE, y0 = tj * TILE, has = false;
    for (var y = y0 - 60; y <= y0 + TILE + 60 && !has; y += 40) for (var x = x0 - 60; x <= x0 + TILE + 60 && !has; x += 40) if (blocked(x, y, 70)) has = true;
    return (tileHas[k] = has);
  }
  function getTile(ti, tj, pxPerUnit, imgs, bg) {
    var q = Math.round(pxPerUnit * 20) / 20, key = ti + "," + tj + "@" + q, c = tileCache.get(key);
    if (c) { tileCache.delete(key); tileCache.set(key, c); return c; }
    var has = tileNonEmpty(ti, tj); if (!has && !bg) return null;
    var size = Math.ceil(TILE * q); c = document.createElement("canvas"); c.width = size; c.height = size;
    var g = c.getContext("2d", { alpha: !bg }); g.scale(q, q); g.translate(-ti * TILE, -tj * TILE);
    if (bg) bg(g, ti * TILE, tj * TILE, TILE); // 草地底图一起烘焙（整块不透明 → 少一层全屏填充）
    if (has) drawWorld(g, ti * TILE, tj * TILE, imgs);
    tileCache.set(key, c); while (tileCache.size > 20) tileCache.delete(tileCache.keys().next().value);
    return c;
  }
  // 小地图底图
  function miniMap(size) {
    var c = document.createElement("canvas"); c.width = c.height = size; var g = c.getContext("2d"), k = size / (2 * HALF);
    g.scale(k, k); g.translate(HALF, HALF); g.fillStyle = "#b8e6a0"; g.fillRect(-HALF, -HALF, 2 * HALF, 2 * HALF);
    riverStroke(g, 0, "#6cc0ea"); ell(g, LAKE.x, LAKE.y, LAKE.rx, LAKE.ry, "#6cc0ea");
    for (var i = 0; i < ROCKS.length; i++) ell(g, ROCKS[i][0], ROCKS[i][1], ROCKS[i][2], ROCKS[i][2], "#8e9a91");
    g.fillStyle = "#b9814e"; for (i = 0; i < CROSS.length; i++) ell(g, CROSS[i].x, CROSS[i].y, 40, 40, CROSS[i].kind === "bridge" ? "#b9814e" : "#cbbf9e");
    return c;
  }
  window.CatTerrain = { clear: function () { tileCache.clear(); }, has: function (ti, tj, p) { return tileCache.has(ti + "," + tj + "@" + Math.round(p * 20) / 20); }, HALF: HALF, TILE: TILE, blocked: blocked, push: push, reachable: reachable, buildReach: buildReach, getTile: getTile, miniMap: miniMap, nearestRiver: nearestRiver, CROSS: CROSS, PTS: PTS, LAKE: LAKE, ROCKS: ROCKS, hwAt: hwAt, inCross: inCross };
})();
