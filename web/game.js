(function () {
  "use strict";

  // =======================================================================
  // Config & constants
  // =======================================================================

  // TODO(站长): 填入 https://<project-ref>.supabase.co
  var SUPABASE_URL = "https://api.12121313.xyz"; // Cloudflare Worker 代理（只转发游戏用到的 RPC 和排行榜视图）到 dzarlikttkosqkcfixbx.supabase.co
  // TODO(站长): 填入 publishable key (sb_publishable_...)
  var SUPABASE_ANON_KEY = "sb_publishable_TOkle8Wiqr-lTZ8hHOIiUg_19ykO4Co";

  var LEADERBOARD_SNAPSHOT_LIMIT = 500;
  var LEADERBOARD_TOPN_LIMIT = 50;
  var LEADERBOARD_POLL_INTERVAL_MS = 20000;

  var HEARTBEAT_MIN_INTERVAL_MS = 2500;
  var HEARTBEAT_ACTIVE_INTERVAL_MS = 7000;
  var HEARTBEAT_IDLE_INTERVAL_MS = 20000;
  var HEARTBEAT_PAUSED_INTERVAL_MS = 25000;

  var REF_W = 480;
  var CHUNK_SIZE = 480;
  var LOAD_MARGIN = CHUNK_SIZE * 0.75;
  var UNLOAD_MARGIN = CHUNK_SIZE * 2.2;
  var CHUNK_PRUNE_INTERVAL = 2;

  var MIN_EASY_MICE = 3;
  var MOUSE_AWARE_R = REF_W * 0.62;
  var MOUSE_CLEANUP_R = UNLOAD_MARGIN + CHUNK_SIZE;

  var DIFFICULTY_SCORE_CAP = 2000;
  var DIFFICULTY_TIME_CAP = 300;
  // v23：公开展示仅守卫战（完整模块见下方 SURVIVORS M1）
  var SURV_ON = true;
  var SURV_CYCLES = 3;

  var COMBO_WINDOW = 2.5;
  var COMBO_MAX_MULT = 2.5;
  var COMBO_STEP = 0.2;

  var STATE_START = "start";
  var STATE_PLAY = "play";
  var STATE_PAUSE = "pause";
  var STATE_RESULT = "result";

  // 手机窄屏下猫/老鼠按 REF_W 等比缩放后视觉上偏小（见第二轮审核），额外加一个
  // 按屏幕短边自适应的放大倍率：短边 <= ENTITY_MOBILE_SHORT_EDGE 时放大到
  // ENTITY_MOBILE_SCALE_MULT，短边 >= ENTITY_DESKTOP_SHORT_EDGE 时不放大
  // （桌面端基本不变），中间线性插值。这个倍率会同时应用到渲染尺寸和碰撞/
  // 捕获判定半径（见 updateCat/updateMice/spawnMouseAt），保证"看起来多大，
  // 判定就按多大"，不会出现视觉变大但手感没变的割裂感。
  var ENTITY_MOBILE_SHORT_EDGE = 390;
  var ENTITY_DESKTOP_SHORT_EDGE = 900;
  var ENTITY_MOBILE_SCALE_MULT = 1.65;

  // =======================================================================
  // Setup & responsive canvas
  // =======================================================================

  var canvas = document.getElementById("game");
  var ctx = canvas.getContext("2d");
  var W = 0, H = 0, DPR = 1, SCALE = 1;
  var entityScaleMult = 1;

  function s(v) { return v * SCALE; }

  function computeEntityScaleMult(shortEdge) {
    if (shortEdge <= ENTITY_MOBILE_SHORT_EDGE) return ENTITY_MOBILE_SCALE_MULT;
    if (shortEdge >= ENTITY_DESKTOP_SHORT_EDGE) return 1;
    var t = (shortEdge - ENTITY_MOBILE_SHORT_EDGE) / (ENTITY_DESKTOP_SHORT_EDGE - ENTITY_MOBILE_SHORT_EDGE);
    return lerp(ENTITY_MOBILE_SCALE_MULT, 1, t);
  }

  // 画布尺寸以 #app 的实际布局尺寸为准（#app 用 100dvh/fixed inset:0 铺满），
  // 不再用 innerHeight 写死内联像素——iOS 地址栏收起/展开、横竖屏切换时
  // innerHeight 与实际可视高度不一致，会在底部留出空白。
  var appEl = document.getElementById("app") || document.body;
  var resScale = 1;
  function resize() {
    var rect = appEl.getBoundingClientRect();
    var vv = window.visualViewport;
    W = Math.max(1, Math.ceil(rect.width || (vv ? vv.width : window.innerWidth)));
    H = Math.max(1, Math.ceil(rect.height || (vv ? vv.height : window.innerHeight)));
    DPR = Math.min(window.devicePixelRatio || 1, 2) * resScale; // v9：主画布 DPR 上限 2，低帧率时自适应降到 ×0.75
    var cw = Math.round(W * DPR), ch = Math.round(H * DPR);
    if (canvas.width !== cw || canvas.height !== ch) { canvas.width = cw; canvas.height = ch; }
    ctx.setTransform(DPR, 0, 0, DPR, 0, 0);
    SCALE = Math.min(W, H) / REF_W;
    entityScaleMult = computeEntityScaleMult(Math.min(W, H));
  }

  window.addEventListener("resize", resize);
  window.addEventListener("orientationchange", function () { resize(); setTimeout(resize, 250); setTimeout(resize, 700); });
  if (window.visualViewport) window.visualViewport.addEventListener("resize", resize);
  if (window.ResizeObserver) new ResizeObserver(function () { resize(); }).observe(appEl);
  resize();
  // 可视区域（世界坐标）对角线的一半：大屏/超长屏时据此扩大区块加载/卸载范围
  function viewRadiusWorld() { return Math.sqrt(W * W + H * H) / (2 * SCALE); }
  function loadMargin() { return Math.max(LOAD_MARGIN, viewRadiusWorld() + 120); }
  function unloadMargin() { return Math.max(UNLOAD_MARGIN, viewRadiusWorld() + 700); }

  function clamp(v, lo, hi) { return v < lo ? lo : (v > hi ? hi : v); }
  function clamp01(v) { return clamp(v, 0, 1); }
  function lerp(a, b, t) { return a + (b - a) * t; }

  // =======================================================================
  // Storage
  // =======================================================================

  function storageGet(key, fallback) {
    try {
      var v = window.localStorage.getItem(key);
      return v === null ? fallback : v;
    } catch (e) {
      return fallback;
    }
  }

  function storageSet(key, value) {
    try {
      window.localStorage.setItem(key, value);
    } catch (e) {
      // localStorage 不可用（隐私模式等）时静默忽略，不影响游戏运行
    }
  }

  // =======================================================================
  // Audio engine (Web Audio 合成，无外部音频文件)
  // =======================================================================

  // 音频全部在 audio.js（CatAudio）里实时合成：生成式 BGM + 音效；这里只做薄封装
  // ---- 体验设置（存 localStorage）：震动/屏幕抖动、减少动效、虚拟摇杆、色弱模式 ----
  function lsBool(k, d) { try { var v = localStorage.getItem(k); return v == null ? d : v === "1"; } catch (e) { return d; } }
  function lsSetBool(k, v) { try { localStorage.setItem(k, v ? "1" : "0"); } catch (e) {} }
  var prefersRM = !!(window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches);
  var shakeOn = lsBool("catmouse_shake", true), reducedMotion = lsBool("catmouse_reduce_motion", prefersRM);
  var joystickOn = false, cbMode = lsBool("catmouse_cb", false);
  var shakeT = 0, shakeAmp = 0;
  function feedback(kind) { // 冲刺/飞扑落地的轻微屏幕抖动 + 手机震动
    if (!shakeOn || reducedMotion) return;
    var amp = kind === "wave" ? 5 : kind === "dash" ? 2.5 : 3; shakeT = 0.15; shakeAmp = Math.max(shakeAmp, amp);
    try { if (navigator.vibrate) navigator.vibrate(kind === "wave" ? 25 : 12); } catch (e) {}
  }
  var CA = window.CatAudio || { unlock: function () {}, sfx: {}, settings: { master: true }, setIntensity: function () {}, setMuffle: function () {}, set: function () {} };
  var muted = !CA.settings.master;
  // 小猫皮肤：纯外观；本地记住上次选择，同时随 start_run 存到服务端（排行榜头像）
  var SKIN_IDS = window.CatArt.SKINS.map(function (k) { return k.id; });
  var currentSkin = storageGet("catmouse_skin", "orange");
  if (SKIN_IDS.indexOf(currentSkin) < 0) currentSkin = "orange";

  function ensureAudio() { CA.unlock(); }
  function sp(name) { var a = Array.prototype.slice.call(arguments, 1); return function () { var f = CA.sfx[name]; if (f) f.apply(null, a.length ? a : arguments); }; }
  var sfx = {
    catchGrey: function (m) { if (CA.sfx.catch) CA.sfx.catch("grey", m && m.beh); },
    catchBrown: function (m) { if (CA.sfx.catch) CA.sfx.catch("brown", m && m.beh); },
    catchGold: function (m) { if (CA.sfx.catch) CA.sfx.catch("gold", m && m.beh); },
    combo: function () { if (CA.sfx.combo) CA.sfx.combo(combo); },
    rankUp: sp("click"),
    click: sp("click"),
    endRun: sp("endRun")
  };
  function skillSfx(phase) { if (ab && CA.sfx.skill) CA.sfx.skill(ab.skin, phase, ab.stage); }

  function toggleMute() {
    muted = !muted;
    CA.set("master", !muted);
    updateMuteBtn();
  }

  // =======================================================================
  // RNG utils
  // =======================================================================

  function mulberry32(seed) {
    return function () {
      seed |= 0;
      seed = (seed + 0x6D2B79F5) | 0;
      var t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  function hashChunkSeed(worldSeed, cx, cy) {
    var h = worldSeed ^ (cx * 374761393) ^ (cy * 668265263);
    h = (h ^ (h >>> 13)) * 1274126177;
    return (h ^ (h >>> 16)) >>> 0;
  }

  function randRange(rng, lo, hi) { return lo + rng() * (hi - lo); }

  function pickWeighted(rng, items) {
    var total = 0;
    var i;
    for (i = 0; i < items.length; i++) total += items[i].weight;
    var r = rng() * total;
    for (i = 0; i < items.length; i++) {
      r -= items[i].weight;
      if (r <= 0) return items[i].value;
    }
    return items[items.length - 1].value;
  }

  function distance(x1, y1, x2, y2) {
    var dx = x2 - x1, dy = y2 - y1;
    return Math.sqrt(dx * dx + dy * dy);
  }

  function normalize(dx, dy) {
    var len = Math.sqrt(dx * dx + dy * dy);
    if (len < 0.0001) return { x: 0, y: 0, len: 0 };
    return { x: dx / len, y: dy / len, len: len };
  }

  function resolveCircleAabb(circle, box) {
    var nearestX = clamp(circle.x, box.x, box.x + box.w);
    var nearestY = clamp(circle.y, box.y, box.y + box.h);
    var dx = circle.x - nearestX, dy = circle.y - nearestY;
    var distSq = dx * dx + dy * dy;
    if (distSq >= circle.r * circle.r || distSq === 0) return;
    var dist = Math.sqrt(distSq);
    var overlap = circle.r - dist;
    circle.x += (dx / dist) * overlap;
    circle.y += (dy / dist) * overlap;
  }

  // =======================================================================
  // World / Chunk system（区块化确定性生成，世界坐标用逻辑单位，不随 DPR/屏幕尺寸变化）
  // =======================================================================

  var worldSeed = 0;
  var chunkCache = new Map();

  function chunkKey(cx, cy) { return cx + "," + cy; }
  function worldToChunk(x, y) { return { cx: Math.floor(x / CHUNK_SIZE), cy: Math.floor(y / CHUNK_SIZE) }; }

  function generateChunk(cx, cy) {
    var rng = mulberry32(hashChunkSeed(worldSeed, cx, cy));
    var baseX = cx * CHUNK_SIZE, baseY = cy * CHUNK_SIZE;
    var i;

    var decor = [];
    var decorCount = 6 + Math.floor(rng() * 6);
    for (i = 0; i < decorCount; i++) {
      decor.push({
        x: baseX + rng() * CHUNK_SIZE,
        y: baseY + rng() * CHUNK_SIZE,
        kind: pickWeighted(rng, [{ value: "grass", weight: 3 }, { value: "flower", weight: 1 }, { value: "pebble", weight: 1 }]),
        rot: rng() * Math.PI * 2,
        scale: 0.8 + rng() * 0.5
      });
    }

    var obstacles = [];
    var obstacleTarget = Math.floor(rng() * 4);
    var attempts = 0;
    while (obstacles.length < obstacleTarget && attempts < 20) {
      attempts++;
      var ow = 28 + rng() * 26, oh = 28 + rng() * 26;
      var ox = baseX + rng() * (CHUNK_SIZE - ow);
      var oy = baseY + rng() * (CHUNK_SIZE - oh);
      var ok = true;
      for (i = 0; i < obstacles.length; i++) {
        var o = obstacles[i];
        var ddx = (ox + ow / 2) - (o.x + o.w / 2);
        var ddy = (oy + oh / 2) - (o.y + o.h / 2);
        if (Math.sqrt(ddx * ddx + ddy * ddy) < 90) { ok = false; break; }
      }
      if (!ok) continue;
      obstacles.push({
        x: ox, y: oy, w: ow, h: oh,
        kind: pickWeighted(rng, [{ value: "crate", weight: 1 }, { value: "bush", weight: 1 }, { value: "rock", weight: 1 }]),
        tint: rng()
      });
    }

    // v14 场景大道具（独立随机数，不改变原有障碍布局）：树（只有树干有碰撞）、花坛、踏脚石小路、草丛
    var r2 = mulberry32(hashChunkSeed(worldSeed, cx, cy) ^ 0x5bd1e995);
    if (r2() < 0.5) {
      for (var tt = 0; tt < 4; tt++) {
        var tx = baseX + 60 + r2() * (CHUNK_SIZE - 120), ty = baseY + 60 + r2() * (CHUNK_SIZE - 120), okT = true;
        if (Math.abs(tx) > 1500 - 140 || Math.abs(ty) > 1500 - 140 || Math.sqrt(tx * tx + ty * ty) < 260) continue;
        for (i = 0; i < obstacles.length; i++) { var oo = obstacles[i]; if (Math.abs(oo.x + oo.w / 2 - tx) < 120 && Math.abs(oo.y + oo.h / 2 - ty) < 110) { okT = false; break; } }
        if (okT && typeof nests !== "undefined") for (i = 0; i < nests.length; i++) if (nests[i].alive && Math.abs(nests[i].x - tx) < 200 && Math.abs(nests[i].y - ty) < 200) { okT = false; break; }
        if (!okT) continue;
        obstacles.push({ x: tx - 16, y: ty - 14, w: 32, h: 18, kind: "tree", tx: tx, ty: ty, fruit: r2() < 0.35, sc: 0.85 + r2() * 0.3 });
        break;
      }
    }
    var nb = r2() < 0.35 ? 1 : 0;
    for (i = 0; i < nb; i++) decor.push({ x: baseX + 80 + r2() * (CHUNK_SIZE - 160), y: baseY + 80 + r2() * (CHUNK_SIZE - 160), kind: "bed", rot: 0, scale: 0.85 + r2() * 0.3 });
    if (r2() < 0.45) { var px0 = baseX + r2() * CHUNK_SIZE, py0 = baseY + r2() * CHUNK_SIZE, pa = r2() * Math.PI * 2; for (i = 0; i < 4; i++) decor.push({ x: px0 + Math.cos(pa) * i * 70, y: py0 + Math.sin(pa) * i * 70, kind: "stones", rot: 0, scale: 0.8 + r2() * 0.3 }); }
    var nt = 1 + Math.floor(r2() * 3); for (i = 0; i < nt; i++) decor.push({ x: baseX + r2() * CHUNK_SIZE, y: baseY + r2() * CHUNK_SIZE, kind: "tuft", rot: 0, scale: 0.8 + r2() * 0.4 });
    decor.sort(function (a, b) { var o = { stones: 0, bed: 1 }; return (o[a.kind] == null ? 2 : o[a.kind]) - (o[b.kind] == null ? 2 : o[b.kind]); });

    var mouseSpawnPoints = [];
    var spawnCount = 2 + Math.floor(rng() * 3);
    for (i = 0; i < spawnCount; i++) {
      mouseSpawnPoints.push({ x: baseX + rng() * CHUNK_SIZE, y: baseY + rng() * CHUNK_SIZE });
    }

    return { cx: cx, cy: cy, decor: decor, obstacles: obstacles, mouseSpawnPoints: mouseSpawnPoints };
  }

  function getChunk(cx, cy) {
    var key = chunkKey(cx, cy);
    var chunk = chunkCache.get(key);
    if (!chunk) {
      chunk = generateChunk(cx, cy);
      if (window.CatTerrain) { // v17：地形上不放装饰/障碍/出鼠点（树要离岸更远）
        var TT = window.CatTerrain;
        chunk.decor = chunk.decor.filter(function (d) { return !TT.blocked(d.x, d.y, d.kind === "bed" ? 70 : 24); });
        chunk.obstacles = chunk.obstacles.filter(function (o) { var r = o.kind === "tree" ? 80 : 40; return !TT.blocked(o.x + o.w / 2, o.y + o.h / 2, r) && !TT.inCross(o.x + o.w / 2, o.y + o.h / 2, -120); });
        chunk.mouseSpawnPoints = chunk.mouseSpawnPoints.filter(function (p) { return !TT.blocked(p.x, p.y, 24) && TT.reachable(p.x, p.y); });
      }
      chunkCache.set(key, chunk);
    }
    return chunk;
  }

  function ensureChunksAround(centerX, centerY) {
    var c0 = worldToChunk(centerX, centerY);
    var range = Math.ceil(loadMargin() / CHUNK_SIZE) + 1;
    for (var dy = -range; dy <= range; dy++) {
      for (var dx = -range; dx <= range; dx++) getChunk(c0.cx + dx, c0.cy + dy);
    }
  }

  var pruneTimer = 0;
  function pruneFarChunks(dt, centerX, centerY) {
    pruneTimer += dt;
    if (pruneTimer < CHUNK_PRUNE_INTERVAL) return;
    pruneTimer = 0;
    var toDelete = [];
    chunkCache.forEach(function (chunk, key) {
      var ccx = chunk.cx * CHUNK_SIZE + CHUNK_SIZE / 2;
      var ccy = chunk.cy * CHUNK_SIZE + CHUNK_SIZE / 2;
      if (distance(ccx, ccy, centerX, centerY) > unloadMargin()) toDelete.push(key);
    });
    for (var i = 0; i < toDelete.length; i++) chunkCache.delete(toDelete[i]);
  }

  function queryNearbyObstacles(x, y) {
    var c = worldToChunk(x, y);
    var list = [];
    for (var dy = -1; dy <= 1; dy++) {
      for (var dx = -1; dx <= 1; dx++) {
        var chunk = chunkCache.get(chunkKey(c.cx + dx, c.cy + dy));
        if (chunk) list = list.concat(chunk.obstacles);
      }
    }
    if (nearEdge(x, y, CHUNK_SIZE * 1.5)) list = list.concat(FENCES);
    return list;
  }

  function nearbyMouseSpawnPoints(centerX, centerY) {
    var points = [];
    chunkCache.forEach(function (chunk) {
      var ccx = chunk.cx * CHUNK_SIZE + CHUNK_SIZE / 2;
      var ccy = chunk.cy * CHUNK_SIZE + CHUNK_SIZE / 2;
      if (distance(ccx, ccy, centerX, centerY) < loadMargin() + CHUNK_SIZE) {
        for (var i = 0; i < chunk.mouseSpawnPoints.length; i++) points.push(chunk.mouseSpawnPoints[i]);
      }
    });
    return points;
  }

  // =======================================================================
  // Entities
  // =======================================================================

  var MOVE_SPEED = 150;
  var CAT_RADIUS = 15;
  var MOUSE_RADIUS = 12;
  var BASE_MOUSE_SPEED = 70;

  // 正面撞上障碍物时的自动绕行：圆-AABB 推出只沿碰撞法线方向顶回去，垂直
  // 撞上一块平面时切向分量恰好是 0，猫会卡住不动（第四轮审核：往右长按
  // 4 秒只走了 131px）。下面两个常量控制"判定为被卡住"的阈值与绕行速度。
  var COLLISION_SLIDE_BLOCK_RATIO = 0.3; // 实际位移 < 期望位移的这个比例，判定为被挡住
  var COLLISION_SLIDE_SPEED = MOVE_SPEED * 0.9;

  var cat = {
    x: 0, y: 0, vx: 0, vy: 0, r: CAT_RADIUS,
    facing: 0, runCycle: 0, squash: 0, slideSign: 0
  };

  var moveDir = { x: 0, y: 0 };

  var mice = [];

  function resetWorld() {
    catAnim = newAnim(); gulp = null; dustPuffs.length = 0; lastPackAt = -999; nextPackSize = null;
    worldSeed = (Math.random() * 2147483647) | 0;
    chunkCache.clear();
    mice.length = 0;
    cat.x = 0; cat.y = 0; cat.vx = 0; cat.vy = 0; cat.facing = 0; cat.runCycle = 0; cat.squash = 0; cat.slideSign = 0;
    camera.x = 0; camera.y = 0;
    ensureChunksAround(0, 0);
    elapsedPlayTime = 0; nestsInit();
  }

  // =======================================================================
  // Camera
  // =======================================================================

  var camera = { x: 0, y: 0 };

  var camLook = { x: 0, y: 0 };
  function updateCamera(dt) {
    var smoothing = 1 - Math.exp(-dt * 9);
    // v13 A8：镜头前瞻——朝移动方向多看一点（关掉"减少动效"时生效）
    var la = reducedMotion ? 0 : 80 * entityScaleMult, pk = 0, pux = 0, puy = 0; if (!reducedMotion && uni && uni.lunge) { pk = 10; pux = uni.lunge.ux; puy = uni.lunge.uy; } else if (!reducedMotion && sig && sig.go) { pk = 10; pux = sig.ux; puy = sig.uy; } camLook.x += ((moveDir.x || 0) * la + pux * pk - camLook.x) * (1 - Math.exp(-dt * 3.5)); camLook.y += ((moveDir.y || 0) * la + puy * pk - camLook.y) * (1 - Math.exp(-dt * 3.5));
    camera.x += (cat.x + camLook.x - camera.x) * smoothing;
    camera.y += (cat.y + camLook.y - camera.y) * smoothing;
    clampCamera();
  }

  function worldToScreenX(x) { return (x - camera.x) * SCALE + W / 2; }
  function worldToScreenY(y) { return (y - camera.y) * SCALE + H / 2; }

  // =======================================================================
  // Input（指针/鼠标/键盘，方向判定相对屏幕中心）
  // =======================================================================

  var activePointerId = null;
  var keysDown = {};
  var DEAD_ZONE_PX = 18, lastPtr = null;

  function computeDirFromPoint(px, py) {
    // v16：方向 = 手指位置 - 小猫在屏幕上的位置（地图边缘镜头被夹住、镜头前瞻时也准确）
    lastPtr = { x: px, y: py };
    var dx = px - worldToScreenX(cat.x), dy = py - worldToScreenY(cat.y);
    var distPx = Math.sqrt(dx * dx + dy * dy);
    if (distPx < s(DEAD_ZONE_PX)) return null;
    var n = normalize(dx, dy);
    return { x: n.x, y: n.y };
  }

  function syncKeyDir() {
    if (activePointerId !== null) return;
    var dx = 0, dy = 0;
    if (keysDown.ArrowLeft || keysDown.a || keysDown.A) dx -= 1;
    if (keysDown.ArrowRight || keysDown.d || keysDown.D) dx += 1;
    if (keysDown.ArrowUp || keysDown.w || keysDown.W) dy -= 1;
    if (keysDown.ArrowDown || keysDown.s || keysDown.S) dy += 1;
    if (dx === 0 && dy === 0) { moveDir.x = 0; moveDir.y = 0; return; }
    var n = normalize(dx, dy);
    moveDir.x = n.x; moveDir.y = n.y;
  }

  // v19 TAP3：纯手势。按住/拖动=跟手指；轻点老鼠=锁定+自动追+招牌扑；轻点空地=跑过去（插小旗）；两指轻点=暂停
  var joy = null; // 摇杆已移除（保留变量供旧代码判断）
  function drawJoystick() {}
  var TAP_MS = 150, TAP_PX = 12, ptrs = new Map(), multi = null;
  var tap = null, lock = null, flag = null, lockFx = [];
  function nowMs() { return performance.now(); }
  function pickMouseAt(px, py) {
    var best = null, bd = 36 * 36;
    for (var i = 0; i < mice.length; i++) { var m = mice[i]; if (!uniOk(m)) continue;
      var sx = worldToScreenX(m.x + (m.vx || 0) * 0.1), sy = worldToScreenY(m.y + (m.vy || 0) * 0.1) - s(6), dx = sx - px, dy = sy - py, d = dx * dx + dy * dy;
      if (d < bd) { bd = d; best = m; } }
    return best;
  }
  function pickNestAt(px, py) {
    var best = null, bd = 48 * 48; // 窝点中略松
    for (var i = 0; i < nests.length; i++) {
      var n = nests[i]; if (!n.alive || n.destroying) continue;
      var sx = worldToScreenX(n.x), sy = worldToScreenY(n.y) - s(8), dx = sx - px, dy = sy - py, d = dx * dx + dy * dy;
      if (d < bd) { bd = d; best = n; } }
    return best;
  }
  function setNestLock(n) {
    lock = { nest: n, t: 0, best: 1e9, prog: 0, born: elapsedPlayTime }; flag = null;
    if (CA.sfx.uni) CA.sfx.uni("chain", 0); buzz(10);
  }
  function screenToWorld(px, py) { return { x: (px - W / 2) / SCALE + camera.x, y: (py - H / 2) / SCALE + camera.y }; }
  function clearTargets() { lock = null; flag = null; }
  function setLock(m) {
    lock = { m: m, seed: m.seed, t: 0, best: 1e9, prog: 0, born: elapsedPlayTime }; flag = null;
    if (CA.sfx.uni) CA.sfx.uni("chain", 0); buzz(10);
  }
  function buzz(ms) { if (!shakeOn || reducedMotion) return; try { if (navigator.vibrate) navigator.vibrate(ms); } catch (e) {} }
  function onPointerDown(e) {
    ensureAudio();
    if (state !== STATE_PLAY) return;
    ptrs.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (ptrs.size >= 2) { // 两指：只用来暂停，不移动
      if (!multi) multi = { t0: nowMs(), moved: false, pts: {} };
      ptrs.forEach(function (p, id) { multi.pts[id] = { x: p.x, y: p.y }; });
      activePointerId = null; tap = null; moveDir.x = 0; moveDir.y = 0; lastPtr = null;
      return;
    }
    if (activePointerId !== null) return;
    activePointerId = e.pointerId;
    tap = { x0: e.clientX, y0: e.clientY, t0: nowMs(), drag: false };
    if (dom && dom.hud) dom.hud.classList.add("steering");
    var dir = computeDirFromPoint(e.clientX, e.clientY); // 降延迟：按下当帧就朝手指起步
    if (dir && !(sig && sig.go) && !bioCatStunned()) { moveDir.x = dir.x; moveDir.y = dir.y; }
  }
  function toDrag() { if (!tap || tap.drag) return; tap.drag = true; clearTargets(); }
  function onPointerMove(e) {
    if (ptrs.has(e.pointerId)) ptrs.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (multi && multi.pts[e.pointerId]) { var p0 = multi.pts[e.pointerId]; if (Math.abs(e.clientX - p0.x) + Math.abs(e.clientY - p0.y) > 30) multi.moved = true; }
    if (e.pointerId !== activePointerId || !tap) return;
    var ev = e; if (e.getCoalescedEvents) { var ce = e.getCoalescedEvents(); if (ce && ce.length) ev = ce[ce.length - 1]; }
    var dx = ev.clientX - tap.x0, dy = ev.clientY - tap.y0;
    if (!tap.drag && (dx * dx + dy * dy >= TAP_PX * TAP_PX || nowMs() - tap.t0 > TAP_MS)) toDrag();
    var dir = computeDirFromPoint(ev.clientX, ev.clientY);
    if (tap.drag) { if (dir) { moveDir.x = dir.x; moveDir.y = dir.y; } else { moveDir.x = 0; moveDir.y = 0; } }
  }
  function onPointerUp(e) {
    ptrs.delete(e.pointerId);
    if (multi) {
      if (ptrs.size === 0) { var quick = nowMs() - multi.t0 < 400 && !multi.moved; multi = null; if (quick && state === STATE_PLAY) enterPause(); }
      if (e.pointerId === activePointerId) activePointerId = null;
      return;
    }
    if (e.pointerId !== activePointerId) return;
    activePointerId = null; lastPtr = null;
    if (dom && dom.hud) dom.hud.classList.remove("steering");
    var t = tap; tap = null; moveDir.x = 0; moveDir.y = 0;
    if (t && !t.drag && e.type === "pointerup" && state === STATE_PLAY) {
      if (SURV_ON) {
        var w0 = screenToWorld(e.clientX, e.clientY); survTryDash(w0.x, w0.y);
      } else {
      var m = pickMouseAt(e.clientX, e.clientY), nst = pickNestAt(e.clientX, e.clientY);
      // 鼠站在窝上：谁更近点谁；纯点窝本体才锁窝
      if (m && nst) {
        var ms = Math.hypot(worldToScreenX(m.x) - e.clientX, worldToScreenY(m.y) - e.clientY);
        var ns = Math.hypot(worldToScreenX(nst.x) - e.clientX, worldToScreenY(nst.y) - e.clientY);
        if (ms <= ns + 6) setLock(m); else setNestLock(nst);
      } else if (m) setLock(m);
      else if (nst) setNestLock(nst);
      else { var w = screenToWorld(e.clientX, e.clientY); flag = { x: w.x, y: w.y, t: 0, best: 1e9, prog: 0 }; lock = null; }
      }
    }
    syncKeyDir();
  }
  // 每帧：按住超过 150ms → 拖动；锁定/小旗 → 自动追
  function tapSteer(dt) {
    if (tap && !tap.drag && activePointerId !== null && nowMs() - tap.t0 > TAP_MS) toDrag();
    if (activePointerId !== null && tap && tap.drag) return;
    if (SURV_ON) { if (lock || flag) clearTargets(); return; }
    if (lock && lock.nest) {
      var nn = lock.nest, okN = nests.indexOf(nn) >= 0 && nn.alive && !nn.destroying;
      lock.t += dt;
      if (okN) { var dn = distance(cat.x, cat.y, nn.x, nn.y); if (dn < lock.best - 4) { lock.best = dn; lock.prog = 0; } else lock.prog += dt;
        if (dn > 450 * entityScaleMult || lock.t > 8 || lock.prog > 2.5) { lockFx.push({ x: nn.x, y: nn.y, age: 0, kind: "x" }); okN = false; } }
      if (!okN) { lock = null; if (activePointerId === null) { moveDir.x = 0; moveDir.y = 0; syncKeyDir(); } }
      else if (!(sig && sig.go) && !nestPoopAnim) { var n2 = normalize(nn.x - cat.x, nn.y - 12 - cat.y); moveDir.x = n2.x; moveDir.y = n2.y; }
    } else if (lock) {
      var m = lock.m, ok = mice.indexOf(m) >= 0 && m.seed === lock.seed && uniOk(m);
      lock.t += dt;
      if (ok) { var d = distance(cat.x, cat.y, m.x, m.y); if (d < lock.best - 4) { lock.best = d; lock.prog = 0; } else lock.prog += dt;
        if (d > 450 * entityScaleMult || lock.t > 6 || lock.prog > 2) { lockFx.push({ x: m.x, y: m.y, age: 0, kind: "x" }); ok = false; } }
      if (!ok) { lock = null; if (activePointerId === null) { moveDir.x = 0; moveDir.y = 0; syncKeyDir(); } }
      else if (!(sig && sig.go)) { var n = normalize(m.x + (m.vx || 0) * 0.15 - cat.x, m.y + (m.vy || 0) * 0.15 - cat.y); moveDir.x = n.x; moveDir.y = n.y; }
    } else if (flag) {
      flag.t += dt; var fd = distance(cat.x, cat.y, flag.x, flag.y);
      if (fd < flag.best - 3) { flag.best = fd; flag.prog = 0; } else flag.prog += dt;
      if (fd < 12 || flag.t > 8 || flag.prog > 1.2) { flag = null; moveDir.x = 0; moveDir.y = 0; syncKeyDir(); }
      else { var fn = normalize(flag.x - cat.x, flag.y - cat.y); moveDir.x = fn.x; moveDir.y = fn.y; }
    }
  }

  canvas.addEventListener("pointerdown", onPointerDown);
  window.addEventListener("pointermove", onPointerMove);
  window.addEventListener("pointerup", onPointerUp);
  window.addEventListener("pointercancel", onPointerUp);
  window.addEventListener("blur", function () { if (state === STATE_PLAY) enterPause(); });

  window.addEventListener("keydown", function (e) {
    if (/^(Arrow|[wasdWASD]$)/.test(e.key)) clearTargets();
    if (!keysDown[e.key]) uniCancel();
    keysDown[e.key] = true;
    syncKeyDir();
  });
  window.addEventListener("keyup", function (e) {
    keysDown[e.key] = false;
    syncKeyDir();
  });

  document.addEventListener("touchmove", function (e) { e.preventDefault(); }, { passive: false });
  document.addEventListener("gesturestart", function (e) { e.preventDefault(); });
  document.addEventListener("contextmenu", function (e) { e.preventDefault(); });

  function updateCat(dt) {
    cat.r = CAT_RADIUS * entityScaleMult;
    tapSteer(dt);
    var spdMul = uniSpeedMul() * (survActive() && surv.moveSp ? surv.moveSp : 1);
    var targetVx = moveDir.x * MOVE_SPEED * spdMul;
    var targetVy = moveDir.y * MOVE_SPEED * spdMul;
    if (sig) { targetVx = 0; targetVy = 0; }
    if (survActive() && surv.dashT > 0) { targetVx = 0; targetVy = 0; cat.vx = 0; cat.vy = 0; }
    // v19 手感：加速/转向更快；反向时先急停
    if (targetVx * cat.vx + targetVy * cat.vy < -0.3 * MOVE_SPEED * MOVE_SPEED) { cat.vx *= 0.25; cat.vy *= 0.25; }
    var smoothing = 1 - Math.exp(-dt * (sig ? 40 : 24));
    cat.vx += (targetVx - cat.vx) * smoothing;
    cat.vy += (targetVy - cat.vy) * smoothing;

    var startX = cat.x, startY = cat.y;
    cat.x += cat.vx * dt;
    cat.y += cat.vy * dt;

    var obstacles = queryNearbyObstacles(cat.x, cat.y);
    var i;
    for (i = 0; i < obstacles.length; i++) resolveCircleAabb(cat, obstacles[i]);
    if (TERR) TERR.push(cat);

    // 自动绕行：这一帧实际走的距离比速度本该带它走的距离少太多，说明被
    // 障碍物正面顶住了（切向分量恰好为 0，普通的圆-AABB 推出没法让它滑
    // 出去）。给它加一点沿障碍边缘的切向速度，往"绕行距离更短"的那一侧
    // 推——用猫当前位置相对被撞那块障碍中心、在切向轴上的投影判断哪一侧
    // 更近。选定方向后记在 cat.slideSign 上，脱离接触前都不重新选边，
    // 避免来回切换导致的抖动。
    var intendedDx = cat.vx * dt, intendedDy = cat.vy * dt;
    var intendedDist = Math.sqrt(intendedDx * intendedDx + intendedDy * intendedDy);
    var actualDx = cat.x - startX, actualDy = cat.y - startY;
    var actualDist = Math.sqrt(actualDx * actualDx + actualDy * actualDy);
    var blocked = (moveDir.x !== 0 || moveDir.y !== 0) &&
      intendedDist > 0.01 && actualDist < intendedDist * COLLISION_SLIDE_BLOCK_RATIO;

    if (blocked) {
      var dirLen = Math.sqrt(moveDir.x * moveDir.x + moveDir.y * moveDir.y);
      var dirX = dirLen > 0 ? moveDir.x / dirLen : 0;
      var dirY = dirLen > 0 ? moveDir.y / dirLen : 0;
      var tangentX = -dirY, tangentY = dirX;

      if (cat.slideSign === 0) {
        // 第一次判定为被挡住：找出真正接触到的那块障碍，用猫相对它中心
        // 在切向轴上的投影符号决定往哪一侧绕——猫已经偏向哪一侧，就说明
        // 那一侧剩下的障碍更少，绕行距离更短。
        var blockingBox = null;
        for (i = 0; i < obstacles.length; i++) {
          var ob = obstacles[i];
          var nx = clamp(cat.x, ob.x, ob.x + ob.w);
          var ny = clamp(cat.y, ob.y, ob.y + ob.h);
          var ddx = cat.x - nx, ddy = cat.y - ny;
          if (ddx * ddx + ddy * ddy < cat.r * cat.r + 1) { blockingBox = ob; break; }
        }
        if (blockingBox) {
          var boxCx = blockingBox.x + blockingBox.w / 2, boxCy = blockingBox.y + blockingBox.h / 2;
          var lateral = (cat.x - boxCx) * tangentX + (cat.y - boxCy) * tangentY;
          cat.slideSign = lateral >= 0 ? 1 : -1;
        } else {
          cat.slideSign = 1;
        }
      }

      cat.x += tangentX * cat.slideSign * COLLISION_SLIDE_SPEED * dt;
      cat.y += tangentY * cat.slideSign * COLLISION_SLIDE_SPEED * dt;
      for (i = 0; i < obstacles.length; i++) resolveCircleAabb(cat, obstacles[i]);
      if (TERR) TERR.push(cat);
    } else {
      cat.slideSign = 0;
    }

    if (activePointerId !== null && !joy && lastPtr) { var pd = computeDirFromPoint(lastPtr.x, lastPtr.y); if (pd) { moveDir.x = pd.x; moveDir.y = pd.y; } else { moveDir.x = 0; moveDir.y = 0; } }
    uniLungeStep(dt);
    sigStep(dt);
    var speed = Math.sqrt(cat.vx * cat.vx + cat.vy * cat.vy);
    if (speed > 4) cat.facing = Math.atan2(cat.vy, cat.vx);
    cat.runCycle += dt * (speed / 24 + 0.3);
    // v15 步幅同步：步态相位按实际移动距离推进（一个完整步态周期 ≈ 1.15 个身长），落脚不打滑
    var g0 = cat.gait || 0; cat.gait = g0 + speed * dt * 1.1 / (115 * cat.r * CAT_UNIT_PER_R );
    if (speed > 150 && !reducedMotion && Math.floor(g0 * 2) !== Math.floor(cat.gait * 2)) spawnDust(cat.x - Math.cos(cat.facing) * cat.r * 0.5, cat.y + cat.r * 46 * CAT_UNIT_PER_R, cat.facing, 5 + Math.random() * 3);
    cat.squash = Math.max(0, cat.squash - dt * 4);
  }

  // =======================================================================
  // Scoring & difficulty
  // =======================================================================

  var score = 0;
  var catches = 0, catchesGrey = 0, catchesBrown = 0, catchesGold = 0;
  var combo = 0, comboTimer = 0, comboMax = 0;
  var elapsedPlayTime = 0;

  function currentDifficulty() {
    if (SURV_ON) return survTimeT ? survTimeT() : clamp01(elapsedPlayTime / Math.max(1, CYCLE_T * (typeof SURV_CYCLES === "number" ? SURV_CYCLES : 1)));
    var byScore = clamp01(score / DIFFICULTY_SCORE_CAP);
    var byTime = clamp01(elapsedPlayTime / DIFFICULTY_TIME_CAP);
    return Math.max(byScore, byTime);
  }

  // ---- v9：老鼠 ×10（同屏 100–180）+ 8 种行为 + 恐慌波 + 对象池 + LOD ----
  // 数值为初版设计值，尚未做平衡调参。
  function maxMice(t) { return Math.round(lerp(100, 180, t)); }
  var lastPackAt = -999, packSeq = 0, nextPackSize = null;
  var BEHS = ["wander", "timid", "flock", "forager", "thief", "burrow", "teaser", "sleepy", "gold"];
  var BEH_NAME = { wander: "闲逛鼠", timid: "胆小鼠", flock: "鼠群", forager: "觅食鼠", thief: "小偷鼠", burrow: "地洞鼠", teaser: "挑衅鼠", sleepy: "瞌睡鼠", gold: "金鼠" };
  var forceBeh = null; // 调试：强制生成某种行为

  function speedMultFor(type, t) {
    if (type === "brown") return lerp(1.4, 1.6, t);
    if (type === "gold") return lerp(1.8, 2.1, t);
    return 1.0;
  }

  // 单只分值（v9 下调）：灰 4 / 棕 8 / 金 25 / 瞌睡 2 / 小偷 ×1.5
  function baseScoreFor(m) {
    if (m.beh === "sleepy") return 2;
    var v = m.type === "brown" ? 8 : m.type === "gold" ? 25 : 4;
    if (m.beh === "thief") v = Math.round(v * 1.5);
    return v;
  }

  function resetScoring() {
    uniReset(); sigReset(); clearTargets(); bioReset(); score = 0; catches = 0; catchesGrey = 0; catchesBrown = 0; catchesGold = 0; missionsInit();
    combo = 0; comboTimer = 0; comboMax = 0; elapsedPlayTime = 0; hitStopT = 0; hitStopCd = 0; impacts.length = 0; flyers.length = 0; comboBanner = null; comboRings.length = 0;
  }

  function updateComboTimer(dt) {
    if (comboTimer > 0) {
      comboTimer -= dt;
      if (comboTimer <= 0) { comboTimer = 0; combo = 0; }
    }
  }

  var lastMiceSpawnAt = { grey: -999, brown: -999, gold: -999 };
  var mousePool = [];
  function countMiceByType(type) { var n = 0; for (var i = 0; i < mice.length; i++) if (mice[i].type === type) n++; return n; }
  function randomAngle() { return Math.random() * Math.PI * 2; }

  // ---- 空间网格（每帧重建；邻居查询/恐慌波/群体规则/自动瞄准共用）----
  var grid = new Map(), gridG = 60;
  function gkey(cx, cy) { return cx * 65536 + cy; }
  function buildGrid() {
    gridG = 60 * entityScaleMult;
    grid.forEach(function (a) { a.length = 0; });
    for (var i = 0; i < mice.length; i++) {
      var m = mice[i]; if (m.hidden || m.under) continue;
      var k = gkey(Math.floor(m.x / gridG), Math.floor(m.y / gridG)), a = grid.get(k);
      if (!a) { a = []; grid.set(k, a); }
      a.push(m);
    }
    if (grid.size > 4000) grid.forEach(function (a, k) { if (!a.length) grid.delete(k); });
  }
  function gridEach(x, y, r, fn) {
    var x0 = Math.floor((x - r) / gridG), x1 = Math.floor((x + r) / gridG), y0 = Math.floor((y - r) / gridG), y1 = Math.floor((y + r) / gridG), r2 = r * r;
    for (var cx = x0; cx <= x1; cx++) for (var cy = y0; cy <= y1; cy++) {
      var a = grid.get(gkey(cx, cy)); if (!a) continue;
      for (var i = 0; i < a.length; i++) { var m = a[i], dx = m.x - x, dy = m.y - y; if (dx * dx + dy * dy <= r2) fn(m, dx * dx + dy * dy); }
    }
  }

  var TERR = window.CatTerrain;
  function inObstacle(x, y, pad) {
    if (TERR && (TERR.blocked(x, y, pad + 8) || !TERR.reachable(x, y))) return true;
    var obs = queryNearbyObstacles(x, y);
    for (var q = 0; q < obs.length; q++) { var o = obs[q]; if (x > o.x - pad && x < o.x + o.w + pad && y > o.y - pad && y < o.y + o.h + pad) return true; }
    return false;
  }
  // 屏幕外环带里找一个空地：可视半径 +80 … +400（开局可在屏内 220 以外）
  function ringPoint(r0, r1) {
    for (var tries = 0; tries < 6; tries++) {
      var a = randomAngle(), r = r0 + Math.random() * (r1 - r0);
      var x = camera.x + Math.cos(a) * r, y = camera.y + Math.sin(a) * r;
      if (!inObstacle(x, y, 14)) return { x: x, y: y };
    }
    return null;
  }

  function spawnMouseAt(x, y, type, t, beh) {
    var m = mousePool.pop() || {};
    for (var k in m) delete m[k];
    m.x = x; m.y = y; m.vx = 0; m.vy = 0; m.r = MOUSE_RADIUS * entityScaleMult;
    m.type = type; m.speed = BASE_MOUSE_SPEED * speedMultFor(type, t);
    m.state = "wander"; m.wanderDir = randomAngle(); m.wanderTimer = 1 + Math.random() * 2; m.idleTimer = 0;
    m.facing = 0; m.runCycle = Math.random() * 10; m.awareBuffer = 0; m.beh = beh || "wander"; m.lodAcc = 0; m.seed = Math.random();
    if (m.beh === "sleepy") { m.asleep = true; m.speed *= 0.8; }
    if (m.beh === "burrow") { m.hole = { x: x, y: y }; m.peekT = 0; }
    if (m.beh === "forager") m.food = null;
    mice.push(m);
    return m;
  }
  function recycleMouse(i) { var m = mice[i]; mice.splice(i, 1); m.anim = null; if (mousePool.length < 400) mousePool.push(m); }

  function pickBeh(t) {
    if (forceBeh) return forceBeh;
    var pool = [{ value: "wander", weight: 30 }, { value: "timid", weight: 14 }, { value: "flock", weight: 3.5 }, { value: "forager", weight: 10 },
      { value: "thief", weight: 4 }, { value: "burrow", weight: 8 }, { value: "teaser", weight: 4 + 6 * t }, { value: "sleepy", weight: 8 },
      { value: "gold", weight: 1 + 3 * t }];
    return pickWeighted(Math.random, pool);
  }
  function typeForBeh(beh, t) {
    if (beh === "gold") return "gold";
    if (beh === "teaser") return "brown";
    if ((beh === "wander" || beh === "timid") && Math.random() < lerp(0.1, 0.35, t)) return "brown";
    return "grey";
  }

  // 同屏目标 = 屏幕 +150 范围内的老鼠数；总数上限 ×1.5（屏外的走远了会回收）
  function rectPoint(inHw, inHh, outHw, outHh, minCat) {
    for (var tries = 0; tries < 8; tries++) {
      var x = camera.x + (Math.random() * 2 - 1) * outHw, y = camera.y + (Math.random() * 2 - 1) * outHh;
      if (Math.abs(x - camera.x) < inHw && Math.abs(y - camera.y) < inHh) continue;
      if (minCat && distance(x, y, cat.x, cat.y) < minCat) continue;
      if (!inObstacle(x, y, 14)) return { x: x, y: y };
    }
    return null;
  }
  function zoneCount(hw, hh) { var n = 0; for (var i = 0; i < mice.length; i++) { var m = mice[i]; if (Math.abs(m.x - camera.x) < hw && Math.abs(m.y - camera.y) < hh) n++; } return n; }
  var noSpawn = false;
  function trySpawnMouse() {
    return; // v11：老鼠只从老鼠窝出来（见 nestSpawn）
    if (noSpawn) return;
    var t = currentDifficulty(), target = maxMice(t);
    var hw = W / (2 * SCALE), hh = H / (2 * SCALE);
    var opening = elapsedPlayTime < 0.2;
    var budget = opening ? 260 : 8, inZone = zoneCount(hw + 60, hh + 60);
    while (budget > 0 && inZone < target && mice.length < target * 2) {
      var pt = opening ? rectPoint(0, 0, hw + 60, hh + 60, 170 * entityScaleMult) : rectPoint(hw + 30, hh + 30, hw + 200, hh + 200, 0);
      var before = mice.length;
      if (!pt) { budget--; continue; }
      var beh = pickBeh(t);
      if (beh === "flock") {
        var n = 4 + Math.floor(Math.random() * 5);
        spawnPack(pt, Math.min(n, Math.max(1, target - mice.length)), t); budget -= n; lastPackAt = elapsedPlayTime;
      } else { spawnMouseAt(pt.x, pt.y, typeForBeh(beh, t), t, beh); budget--; }
      inZone += mice.length - before;
    }
  }

  // 鼠群：4–8 只，领头鼠（packIdx 0）游荡，其余排成康加队跟在后面；被追时四散，安全后重新集合
  function spawnPack(pt, n, t) {
    var id = ++packSeq, dir = randomAngle(), goldUsed = false;
    for (var k = 0; k < n; k++) {
      var type = "grey", r = Math.random();
      if (t >= 0.5 && !goldUsed && r < 0.1) { type = "gold"; goldUsed = true; }
      else if (t >= 0.2 && r < 0.35) type = "brown";
      var x = pt.x - Math.cos(dir) * k * 22, y = pt.y - Math.sin(dir) * k * 22;
      if (inObstacle(x, y, 12)) { x = pt.x + (Math.random() - 0.5) * 20; y = pt.y + (Math.random() - 0.5) * 20; }
      var m = spawnMouseAt(x, y, type, t, "flock");
      m.packId = id; m.packIdx = k; m.wanderDir = dir; m.scatter = 0;
    }
  }
  var packLists = {};
  function computePacks() {
    packLists = {};
    for (var i = 0; i < mice.length; i++) { var m = mice[i]; if (!m.packId) continue; (packLists[m.packId] || (packLists[m.packId] = [])).push(m); }
    for (var k in packLists) packLists[k].sort(function (a, b) { return a.packIdx - b.packIdx; });
  }
  function packLeader(m) { var L = packLists[m.packId]; return L && L[0]; }

  // 恐慌波：受惊老鼠每 0.12 秒把恐慌传给 60 内的邻居，最多 4 层
  function startFlee(m, depth) {
    if (m.asleep || m.under) return;
    if (m.state !== "flee") { m.excl = 0.6; var dsq = distance(m.x, m.y, cat.x, cat.y); if (CA.sfx.squeak && dsq < 300 * entityScaleMult) CA.sfx.squeak(1 - dsq / (300 * entityScaleMult)); }
    if (!depth && CA.sfx.panic && distance(m.x, m.y, cat.x, cat.y) < 400 * entityScaleMult) CA.sfx.panic();
    m.state = "flee"; m.awareBuffer = 0; m.panicIn = 0;
    if (m.beh === "timid" && !(m.trem > 0)) m.trem = 0.5;
    m.scatter = (Math.random() < 0.5 ? -1 : 1) * (0.45 + Math.random() * 0.85);
    depth = depth || 0;
    if (depth >= 4) return;
    gridEach(m.x, m.y, 60 * entityScaleMult, function (o) {
      if (o === m || o.state === "flee" || o.panicIn > 0 || o.asleep || o.beh === "teaser") return;
      o.panicIn = 0.12; o.panicDepth = depth + 1;
    });
    if (m.packId) { var L = packLists[m.packId]; if (L) for (var i = 0; i < L.length; i++) if (L[i].state !== "flee" && !(L[i].panicIn > 0)) { L[i].panicIn = 0.12; L[i].panicDepth = depth + 1; } }
  }
  function alertPack(src) { startFlee(src, 0); }

  function rayBlocked(x, y, angle, dist) {
    var tx = x + Math.cos(angle) * dist, ty = y + Math.sin(angle) * dist;
    return inObstacle(tx, ty, 4);
  }

  function burrowTo(m, awayFromCat) {
    var base = m.hole || { x: m.x, y: m.y };
    for (var tries = 0; tries < 6; tries++) {
      var a = awayFromCat ? Math.atan2(base.y - cat.y, base.x - cat.x) + (Math.random() - 0.5) * 2 : randomAngle();
      var d = (awayFromCat ? 300 : 150 + Math.random() * 150) * entityScaleMult;
      var x = base.x + Math.cos(a) * d, y = base.y + Math.sin(a) * d;
      if (!inObstacle(x, y, 14)) return { x: x, y: y };
    }
    return { x: base.x, y: base.y };
  }

  var catSpeedNow = 0;
  function updateMice(dt) {
    buildGrid();
    computePacks();
    catSpeedNow = Math.sqrt(cat.vx * cat.vx + cat.vy * cat.vy);
    var R = viewRadiusWorld(), esm = entityScaleMult, cullR = R + 350;
    var hw = W / (2 * SCALE) + 60, hh = H / (2 * SCALE) + 60;
    for (var i = mice.length - 1; i >= 0; i--) {
      var m = mice[i];
      m.r = MOUSE_RADIUS * esm;
      if (m.hidden || m.survCtl) continue; // 在纸箱/雪球里 / 守卫战自控（鼠王/小偷）
      var dToCat = distance(m.x, m.y, cat.x, cat.y);
      if (dToCat > cullR) { recycleMouse(i); continue; }
      // 守卫战：近距主动贴猫（金鼠除外）
      if (SURV_ON && m.type !== "gold" && !(m.stun > 0) && !(m.pullT > 0) && dToCat < (m.elite || m.mutant ? 700 : 210) * esm && dToCat > 8) {
        var ch = normalize(cat.x - m.x, cat.y - m.y), spd = (m.type === "brown" ? 1.35 : 1.0) * 95 * esm * (m.hasteT > 0 || m.elite === "haste" ? 1.45 : 1);
        if (m.biting) spd *= 1.6;
        m.vx = ch.x * spd; m.vy = ch.y * spd; m.state = "wander";
        m.x += m.vx * dt; m.y += m.vy * dt; if (TERR) TERR.push(m);
        m.facing = Math.atan2(m.vy, m.vx); m.runCycle += dt * 2.2;
        if (m.flash > 0 && !m.mutant) m.flash -= dt;
        continue;
      }
      // LOD：屏幕外且远离猫的老鼠 AI 每秒只更新 10 次
      var off = Math.abs(m.x - camera.x) > hw || Math.abs(m.y - camera.y) > hh;
      var sdt = dt;
      if (off && dToCat > MOUSE_AWARE_R * 1.3 && !(m.stun > 0) && !(m.pullT > 0)) {
        m.lodAcc += dt; if (m.lodAcc < 0.1) continue;
        sdt = m.lodAcc; m.lodAcc = 0;
      } else m.lodAcc = 0;
      stepMouse(m, sdt, dToCat, i);
      if (m.under) continue;
      var dAfter = distance(m.x, m.y, cat.x, cat.y);
      if (!SURV_ON && dAfter < cat.r + m.r + sigCatchBonus() && !(sig && sig.hide)) { if (tryHitMouse(m)) { onCapture(m); recycleMouse(i); } }
    }
  }

  function stepMouse(m, dt, dToCat, i) {
    var esm = entityScaleMult;
    if (m.mutant && m.biting) { // v21：咬击蓄力时强制冲向猫，不被逃跑 AI 打断
      var dx = cat.x - m.x, dy = cat.y - m.y, d = Math.sqrt(dx * dx + dy * dy) || 1;
      var sp = (m.speed || 120) * 2.4; m.vx = dx / d * sp; m.vy = dy / d * sp; m.state = "wander";
      m.x += m.vx * dt; m.y += m.vy * dt; if (TERR) TERR.push(m);
      if (m.vx || m.vy) m.facing = Math.atan2(m.vy, m.vx);
      m.runCycle += dt * 2; return;
    }
    if (m.mutant && m.infectTarget && m.infectTarget.alive && !m.infectTarget.infected && dToCat > BIO_BITE_R) {
      // 无猫威胁时优先跑向要感染的窝
      var n = m.infectTarget, dx2 = n.x - m.x, dy2 = n.y - m.y, d2 = Math.sqrt(dx2 * dx2 + dy2 * dy2) || 1;
      if (d2 > 20) { var sp2 = (m.speed || 120) * 1.15; m.vx = dx2 / d2 * sp2; m.vy = dy2 / d2 * sp2; }
    }
    if (m.excl > 0) m.excl -= dt;
    if (m.tpCd > 0) m.tpCd -= dt;
    if (m.panicIn > 0) { m.panicIn -= dt; if (m.panicIn <= 0) startFlee(m, m.panicDepth || 1); }
    // ---- 地洞鼠：探头张望，猫靠近就缩回，3 秒后从附近别的洞冒出 ----
    if (m.beh === "burrow") {
      if (m.under) {
        m.underT -= dt; m.vx = 0; m.vy = 0;
        if (m.underT <= 0) { var np = burrowTo(m, false); m.hole = np; m.x = np.x; m.y = np.y; m.under = false; m.state = "wander"; m.peekT = 0; }
        return;
      }
      m.peekT += dt;
      if (dToCat < 150 * esm && !(m.stun > 0) && !(m.pullT > 0)) { m.under = true; m.underT = 3; m.x = m.hole.x; m.y = m.hole.y; return; }
      if (dToCat < MOUSE_AWARE_R * 0.8 || m.peekT > 7) { // 跑回洞口
        var hv = normalize(m.hole.x - m.x, m.hole.y - m.y), hd = distance(m.x, m.y, m.hole.x, m.hole.y);
        m.vx = hd > 3 ? hv.x * m.speed * 0.9 : 0; m.vy = hd > 3 ? hv.y * m.speed * 0.9 : 0;
        if (m.peekT > 7 && hd < 4) { m.under = true; m.underT = 2 + Math.random() * 2; }
      } else wanderStep(m, dt, 0.25, m.hole, 60 * esm);
      return finishStep(m, dt);
    }
    // ---- 瞌睡鼠：睡着不动；猫在附近快跑会被吵醒 ----
    if (m.asleep) {
      m.vx = 0; m.vy = 0;
      if (dToCat < 160 * esm && catSpeedNow > MOVE_SPEED * 0.7) { m.asleep = false; m.excl = 0.6; startFlee(m, 2); }
      return finishStep(m, dt);
    }
    // ---- 挑衅鼠：主动靠近吐舌头，猫一冲就 1.6 倍速逃，跑累了慢下来 ----
    if (m.beh === "teaser") {
      if (m.dashT > 0) { m.dashT -= dt; if (m.dashT <= 0) m.tiredT = 1.5; fleeStep(m, 1.6, i); return finishStep(m, dt); }
      if (m.tiredT > 0) { m.tiredT -= dt; fleeStep(m, 0.6, i); return finishStep(m, dt); }
      m.taunt = false;
      if (dToCat < MOUSE_AWARE_R * 1.3) {
        var tv = normalize(cat.x - m.x, cat.y - m.y), cdot = (cat.vx * -tv.x + cat.vy * -tv.y) / Math.max(catSpeedNow, 1);
        if (dToCat < 90 * esm || (dToCat < 170 * esm && catSpeedNow > MOVE_SPEED * 0.6 && cdot > 0.8)) { m.dashT = 2.5; m.excl = 0.6; m.state = "flee"; fleeStep(m, 1.6, i); return finishStep(m, dt); }
        if (dToCat > 130 * esm) { m.vx = tv.x * m.speed * 0.5; m.vy = tv.y * m.speed * 0.5; }
        else { if (!m.taunt && CA.sfx.taunt) CA.sfx.taunt(); m.vx = 0; m.vy = 0; m.taunt = true; m.facing = Math.atan2(tv.y, tv.x); }
        m.state = "wander";
        return finishStep(m, dt);
      }
      wanderStep(m, dt, 0.35);
      return finishStep(m, dt);
    }
    // ---- 通用：察觉 → 逃跑（恐慌波）----
    var awareR = MOUSE_AWARE_R * (m.beh === "timid" ? 1.4 : 1);
    if (m.state === "wander") {
      if (dToCat < awareR) startFlee(m, 0);
    } else if (dToCat > awareR * 1.2) {
      m.awareBuffer += dt;
      var calm = m.packId ? (dToCat > 300 * esm ? 3 : 1e9) : 0.3; // 鼠群：离猫 >300 持续 3 秒才重新集合
      if (m.awareBuffer > calm) m.state = "wander";
    } else m.awareBuffer = 0;
    if (m.trem > 0) { m.trem -= dt; m.vx = 0; m.vy = 0; return finishStep(m, dt); }
    if (m.state === "flee") {
      if (m.beh === "gold" && dToCat < 200 * esm && !(m.tpCd > 0) && !(m.stun > 0) && !(m.pullT > 0)) { // 金鼠钻洞瞬移
        m.tpCd = 6; fx("hole", m.x, m.y, 0.8, {});
        var tp = burrowTo({ hole: { x: m.x, y: m.y } }, true); m.x = tp.x; m.y = tp.y; fx("hole", m.x, m.y, 0.8, { gold: true });
      }
      fleeStep(m, m.beh === "thief" ? 1.1 : 1, i);
    } else if (m.beh === "flock" && m.packId) {
      flockStep(m, dt);
    } else if (m.beh === "forager") {
      if (!m.food) { var fa = randomAngle(), fd = (80 + Math.random() * 80) * esm; m.food = { x: m.x + Math.cos(fa) * fd, y: m.y + Math.sin(fa) * fd }; if (inObstacle(m.food.x, m.food.y, 10)) m.food = null; m.eatT = 0; }
      if (m.food) {
        var fdist = distance(m.x, m.y, m.food.x, m.food.y);
        if (fdist > 6 * esm) { var fv = normalize(m.food.x - m.x, m.food.y - m.y); m.vx = fv.x * m.speed * 0.4; m.vy = fv.y * m.speed * 0.4; m.eating = false; }
        else { m.vx = 0; m.vy = 0; m.eating = true; m.eatT += dt; if (m.eatT > 2) { m.food = null; m.eating = false; } }
      }
    } else if (m.beh === "thief") wanderStep(m, dt, 0.5);
    else wanderStep(m, dt, 0.35);
    return finishStep(m, dt);
  }

  function fleeStep(m, mult, i) {
    var away = normalize(m.x - cat.x, m.y - cat.y);
    var desired = Math.atan2(away.y, away.x) + (m.scatter || 0) * (m.beh === "teaser" ? 0.3 : 1);
    if (m.beh === "gold") desired += Math.sin(elapsedPlayTime * 8 + m.seed * 10) * 0.9; // 之字形
    var finalA = desired;
    if (rayBlocked(m.x, m.y, desired, m.r * 3)) {
      var tryA = [Math.PI / 6, -Math.PI / 6, Math.PI / 3, -Math.PI / 3], found = false;
      for (var a = 0; a < tryA.length; a++) if (!rayBlocked(m.x, m.y, desired + tryA[a], m.r * 3)) { finalA = desired + tryA[a]; found = true; break; }
      if (!found) finalA = desired + Math.PI / 2;
    }
    finalA += Math.sin(elapsedPlayTime * 5 + i * 13.7) * 0.25;
    m.vx = Math.cos(finalA) * m.speed * mult; m.vy = Math.sin(finalA) * m.speed * mult;
  }

  function wanderStep(m, dt, spd, home, homeR) {
    m.wanderTimer -= dt;
    if (m.wanderTimer <= 0) {
      m.wanderTimer = 1.5 + Math.random() * 2.5;
      if (Math.random() < 0.45) m.wanderDir = randomAngle();
      if (home && distance(m.x, m.y, home.x, home.y) > homeR) m.wanderDir = Math.atan2(home.y - m.y, home.x - m.x);
      m.idleTimer = Math.random() < 0.4 ? (0.6 + Math.random()) : 0;
    }
    if (m.idleTimer > 0) { m.idleTimer -= dt; m.vx = 0; m.vy = 0; return; }
    m.vx = Math.cos(m.wanderDir) * m.speed * spd; m.vy = Math.sin(m.wanderDir) * m.speed * spd;
  }

  // 鼠群：领头鼠游荡；其余跟在前一只后面排成康加队，同时保持间距（分离）
  function flockStep(m, dt) {
    var L = packLists[m.packId], esm = entityScaleMult, idx = L ? L.indexOf(m) : 0;
    if (!L || idx <= 0) { wanderStep(m, dt, 0.3); m.leader = true; return; }
    m.leader = false;
    var ahead = L[idx - 1], gap = 22 * esm;
    var tx = ahead.x - Math.cos(ahead.facing) * gap, ty = ahead.y - Math.sin(ahead.facing) * gap;
    var d = distance(m.x, m.y, tx, ty), v = normalize(tx - m.x, ty - m.y);
    var sp = Math.min(m.speed * (d > 60 * esm ? 0.9 : 0.4), d / Math.max(dt, 1e-3));
    var sx = 0, sy = 0;
    gridEach(m.x, m.y, 16 * esm, function (o) { if (o !== m) { sx += m.x - o.x; sy += m.y - o.y; } });
    m.vx = v.x * sp + sx * 2; m.vy = v.y * sp + sy * 2;
    m.conga = d < 40 * esm;
  }

  function finishStep(m, dt) {
    applyAbilityToMouse(m, dt);
    homePull(m);
    if (m.cornerT > 0) { m.cornerT -= dt; m.vx *= 0.4; m.vy *= 0.4; }
    m.x += m.vx * dt; m.y += m.vy * dt;
    var obstacles = queryNearbyObstacles(m.x, m.y);
    for (var k = 0; k < obstacles.length; k++) resolveCircleAabb(m, obstacles[k]);
    if (TERR) { var px0 = m.x, py0 = m.y;
      if (TERR.push(m)) { // v18：撞到河岸/山崖 → 把“顶墙”的速度转成沿岸滑行（不在岸边原地卡住）
        var nx = m.x - px0, ny = m.y - py0, nl = Math.sqrt(nx * nx + ny * ny);
        if (nl > 1e-4) { nx /= nl; ny /= nl; var vn = m.vx * nx + m.vy * ny;
          if (vn < 0) { var tx = -ny, ty = nx, vt = m.vx * tx + m.vy * ty;
            if (!(m.tsgT > 0)) { m.tsg = Math.abs(vt) > 4 ? (vt > 0 ? 1 : -1) : (m.seed < 0.5 ? 1 : -1); }
            m.tsgT = 1.2; var sp2 = Math.sqrt(m.vx * m.vx + m.vy * m.vy);
            m.vx = tx * m.tsg * sp2; m.vy = ty * m.tsg * sp2; m.x += m.vx * dt * 0.5; m.y += m.vy * dt * 0.5; TERR.push(m); } } }
      if (m.tsgT > 0) m.tsgT -= dt; }
    if (m.vx !== 0 || m.vy !== 0) m.facing = Math.atan2(m.vy, m.vx);
    m.runCycle += dt * (Math.sqrt(m.vx * m.vx + m.vy * m.vy) / 24 + 0.3);
  }

  function onCapture(m) {
    var t = currentDifficulty();
    combo += 1;
    comboTimer = COMBO_WINDOW;
    if (combo > comboMax) comboMax = combo;
    var mult = Math.min(1 + combo * COMBO_STEP, COMBO_MAX_MULT);
    var gained = Math.round(baseScoreFor(m) * mult);
    score += gained;
    catches += 1;
    uniOnCapture(m);
    sigOnCapture(m);
    onMutantCaptureBonus(m); if (!SURV_ON) bioCheckHeartGrowth();
    if (SURV_ON && surv && !m._survXpDone) { m._survXpDone = true; survOnKill(m); }
    if (m.type === "grey") catchesGrey++;
    else if (m.type === "brown") catchesBrown++;
    else catchesGold++;

    spawnScorePopup(m.x, m.y, gained);
    spawnCatchParticles(m.x, m.y);
    juiceCapture(m, gained);
    cat.squash = 1;
    startGulp(m);
    if (m.type === "grey") sfx.catchGrey(m);
    else if (m.type === "brown") sfx.catchBrown(m);
    else sfx.catchGold(m);
    if (combo >= 3) sfx.combo();

    maybeSendHeartbeat(Date.now());
    catchTimes.push(elapsedPlayTime); if (catchTimes.length > 20) catchTimes.shift();
  }
  var catchTimes = [];
  // BGM 层次：开始页 0；局内 1；技能 Lv3+ 或连击 ≥5 → 2；3 秒内抓 ≥4 只或大招 → 3（audio.js 在小节线切换）
  function updateMusic() {
    var lvl = 0;
    if (state === STATE_PLAY || state === STATE_PAUSE) {
      lvl = 1;
      if ((ab && ab.stage >= 3) || combo >= 5) lvl = 2;
      var recent = 0; for (var i = 0; i < catchTimes.length; i++) if (elapsedPlayTime - catchTimes[i] < 3) recent++;
      if (recent >= 4 || (ab && (ab.roll > 0 || ab.evoT > 0))) lvl = 3;
    }
    CA.setIntensity(lvl);
    CA.setMuffle(state === STATE_PAUSE);
  }

  // =======================================================================
  // 被动进化技能（/workspace/skills-design/SKILLS.md）：每只猫 1 个招牌技能，
  // 本局累计抓捕 0/15/40/80/150 进化到 Lv1–Lv5，每级叠加一个新玩法。
  // 技能只做 定身/聚拢/送到嘴边，最后一口必须猫自己吃到（煤球的箱子也要猫去撞）。
  // 数值为初版设计值，尚未做平衡调参。
  // =======================================================================

  var STAGE_AT = [0, 15, 40, 80, 150];
  var SKILLS = {
    orange:  { name: "喵喵小分队", icon: "🐱", lv: [["🐱", "跟屁小橘", "小奶猫每 8 秒扑住附近老鼠"], ["🐭", "叼回来", "按住后叼回你脚边"], ["🐱", "双胞胎包抄", "两只小猫左右包抄赶鼠"], ["🌀", "牧羊阵", "把鼠群圈成一团送到你面前"], ["🚂", "猫猫列车", "急转弯时队伍甩出扫鼠"]], evo: "纸箱打开，跳出新的小猫！" },
    black:   { name: "魔术纸箱", icon: "📦", lv: [["📦", "神秘纸箱", "每 10 秒放纸箱，老鼠钻进去，撞箱全吃"], ["🔒", "自动关盖", "进鼠就关盖，最多关 3 只"], ["🕳", "地道连通", "钻空箱，从鼠多的箱子冒出"], ["⚙️", "传送带", "关住的箱子自动运向你"], ["🎩", "黑猫魔术秀", "每 25 秒开箱，老鼠晕倒排成一排"]], evo: "戴上礼帽，挥一下魔术棒！" },
    white:   { name: "滚滚雪球", icon: "⚪", lv: [["⚪", "小雪球", "每 9 秒滚雪球冻住老鼠"], ["⛄", "越滚越大", "卷鼠变大，炸开晕倒一片"], ["🧊", "冰面滑道", "被冻的老鼠滑向你"], ["☃️", "雪人哨兵", "每 20 秒立雪人自动丢雪球"], ["❄️", "暴风雪舞", "每 30 秒冰环冻住并聚拢"]], evo: "头顶下了一阵小雪！" },
    calico:  { name: "魔法毛线", icon: "🧶", lv: [["🧶", "套索", "每 7 秒套住最近老鼠拉近"], ["🪝", "双钩", "一次套两只"], ["🕸", "毛线网", "障碍之间织网粘住老鼠"], ["🎢", "荡秋千", "套到金鼠就荡过去"], ["⭐", "翻花绳", "每 25 秒星形阵拉到中间"]], evo: "毛线球滚出来，又多一种颜色！" },
    blue:    { name: "圆滚滚旋风", icon: "🌪", lv: [["🌪", "小旋风", "直线跑 2 秒生成旋风吸晕老鼠"], ["🍃", "跟随旋风", "旋风在你身前开路"], ["↪️", "连锁跳", "吸完一群跳下一群"], ["✌️", "分身双旋", "急转弯一分为二"], ["🌀", "大胖龙卷", "每 30 秒团成球卷起全场"]], evo: "鼓起脸颊吹一口气！" },
    siamese: { name: "歌剧喵", icon: "🎵", lv: [["🎵", "高音符", "每 8 秒音符让老鼠跳舞"], ["🎶", "和弦", "3 个音符追 3 只"], ["💃", "康加舞队", "跳舞的老鼠排队走向你"], ["🔦", "聚光灯", "每 20 秒鼠群停下鞠躬"], ["🎤", "老鼠合唱团", "每 30 秒老鼠围成半圆唱歌"]], evo: "戴上领结，“啦~”！" }
  };
  function skillOf(skin) { return SKILLS[skin] || SKILLS.orange; }
  function stageFor(n) { if (SURV_ON) return (ab && ab.stage) || 1; var s2 = 1; for (var i = 1; i < STAGE_AT.length; i++) if (n >= STAGE_AT[i]) s2 = i + 1; return s2; }

  var ab = null;
  function resetAbilities() {
    ab = {
      skin: currentSkin, stage: 1, procs: 0, flash: 0, evoT: 0, hist: [], fx: [],
      t: {}, hold: {}, holds: 0, pend: {}, plans: 0, cancels: 0, tornPlan: null, kittens: [], boxes: [], balls: [], snowmen: [], webs: [], tornados: [], notes: [], spot: null, roll: 0, swing: null,
      lastFacing: cat.facing, turnAcc: 0, straight: 0, straightDir: cat.facing
    };
    ab.stage = SURV_ON ? 1 : stageFor(catches); aimLog.length = 0; planLog.length = 0;
    syncKittens();
  }
  // ---- v9：自动瞄准打分器 aimBest + 不空放（命中数不够就按住，冷却不浪费）----
  function aimW(m) {
    if (m.hidden || m.carried || m.under) return 0;
    var w = m.type === "gold" ? 3 : m.type === "brown" ? 1.5 : 1;
    if (m.beh === "thief") w = 2;
    return w;
  }
  // 沿射线步进检查障碍，返回无遮挡长度
  function clearLen(x, y, a, len) {
    var step = 16 * entityScaleMult, c = Math.cos(a), s2 = Math.sin(a);
    for (var d = step; d <= len; d += step) if (inObstacle(x + c * d, y + s2 * d, 2)) return Math.max(0, d - step);
    return len;
  }
  // 圆形区域内加权计数（带移动预判 lead 秒）
  function countCircle(x, y, r, lead, filt, wfn) {
    var res = { n: 0, hits: 0 }, pad = 120 * entityScaleMult * (lead || 0) + 1;
    gridEach(x, y, r + pad, function (m) {
      if (filt && !filt(m)) return;
      var w = (wfn || aimW)(m); if (!w) return;
      var px = m.x + m.vx * (lead || 0), py = m.y + m.vy * (lead || 0);
      if ((px - x) * (px - x) + (py - y) * (py - y) <= r * r) { res.n += w; res.hits++; }
    });
    return res;
  }
  // 直线走廊计数（弹道宽 halfW、速度 v → 按到达时间预判）
  function countCorridor(x0, y0, a, len, halfW, v, filt) {
    var c = Math.cos(a), s2 = Math.sin(a), res = { n: 0, hits: 0, len: len }, seen = aimStamp++;
    var step = gridG;
    for (var d = 0; d <= len + step; d += step) {
      gridEach(x0 + c * d, y0 + s2 * d, step * 0.75 + halfW, function (m) {
        if (m._aim === seen || (filt && !filt(m))) return; m._aim = seen;
        var w = aimW(m); if (!w) return;
        var proj0 = (m.x - x0) * c + (m.y - y0) * s2, t = Math.max(0, proj0) / v;
        var px = m.x + m.vx * t - x0, py = m.y + m.vy * t - y0, proj = px * c + py * s2, perp = Math.abs(-px * s2 + py * c);
        if (proj > 0 && proj < len && perp < halfW + m.r) { res.n += w; res.hits++; }
      });
    }
    return res;
  }
  var aimStamp = 1;
  // 最密的格子中心（猫周围 maxR 内）
  function denseCells(cx, cy, maxR, k) {
    var out = [], x0 = Math.floor((cx - maxR) / gridG), x1 = Math.floor((cx + maxR) / gridG), y0 = Math.floor((cy - maxR) / gridG), y1 = Math.floor((cy + maxR) / gridG);
    for (var gx = x0; gx <= x1; gx++) for (var gy = y0; gy <= y1; gy++) {
      var a = grid.get(gkey(gx, gy)); if (!a || !a.length) continue;
      var sx = 0, sy = 0, w = 0;
      for (var i = 0; i < a.length; i++) { var ww = aimW(a[i]); if (ww) { sx += a[i].x * ww; sy += a[i].y * ww; w += ww; } }
      if (w) out.push({ x: sx / w, y: sy / w, w: w });
    }
    out.sort(function (p, q) { return q.w - p.w; });
    return out.slice(0, k);
  }
  var aimLog = [];
  var planLog = [];
  function logPlan(k) { planLog.push({ k: k, t: Math.round(elapsedPlayTime * 1000) / 1000 }); if (planLog.length > 200) planLog.shift(); }
  function logAim(kind, hits, n) { aimLog.push({ k: kind, hits: hits, n: Math.round(n * 10) / 10, t: Math.round(elapsedPlayTime * 1000) / 1000 }); if (aimLog.length > 200) aimLog.shift(); }
  // kind: "dir"（弹道）| "point"（落点）| "single"（单体）
  function aimBest(kind, o) {
    var esm = entityScaleMult, best = null, i, sc;
    var ox = o.x == null ? cat.x : o.x, oy = o.y == null ? cat.y : o.y;
    if (kind === "dir") {
      for (i = 0; i < 16; i++) {
        var a = i / 16 * Math.PI * 2, L = clearLen(ox, oy, a, o.len);
        var r = countCorridor(ox, oy, a, L, o.halfW, o.v, o.filt);
        sc = r.n + 0.3 * Math.cos(angDiff(a, cat.facing));
        if (r.hits && (!best || sc > best.score)) best = { a: a, len: L, n: r.n, hits: r.hits, score: sc };
      }
      return best;
    }
    if (kind === "point") {
      var cands = denseCells(ox, oy, o.maxR, 4);
      for (i = 0; i < 12; i++) { var ca = i / 12 * Math.PI * 2, cd = o.maxR * (i & 1 ? 0.45 : 0.85); cands.push({ x: ox + Math.cos(ca) * cd, y: oy + Math.sin(ca) * cd }); }
      for (i = 0; i < cands.length; i++) {
        var p = cands[i], pd = distance(ox, oy, p.x, p.y);
        if (pd > o.maxR || (o.minR && pd < o.minR)) continue;
        if (o.los !== false && pd > 1 && clearLen(ox, oy, Math.atan2(p.y - oy, p.x - ox), pd) < pd - 8 * esm) continue;
        if (inObstacle(p.x, p.y, 6)) continue;
        var rc = countCircle(p.x, p.y, o.r, o.lead || 0, o.filt, o.wfn);
        var fr = pd > 1 ? Math.cos(angDiff(Math.atan2(p.y - oy, p.x - ox), cat.facing)) : 0;
        sc = rc.n + 0.3 * fr;
        if (rc.hits && (!best || sc > best.score)) best = { x: p.x, y: p.y, n: rc.n, hits: rc.hits, score: sc };
      }
      return best;
    }
    // single：权重高 + 近 + 视线不被挡，可排除 o.not 里已选过的
    gridEach(ox, oy, o.maxR, function (m, d2) {
      if (o.filt && !o.filt(m)) return; if (o.not && o.not.indexOf(m) >= 0) return;
      var w = aimW(m); if (!w) return;
      var d = Math.sqrt(d2);
      if (d > 1 && clearLen(ox, oy, Math.atan2(m.y - oy, m.x - ox), d) < d - 10 * esm) return;
      var s3 = w * 2 + (o.cluster ? countCircle(m.x, m.y, 40 * esm, 0).n : 0) - d / o.maxR;
      if (!best || s3 > best.score) best = { m: m, x: m.x, y: m.y, n: w, hits: 1, score: s3 };
    });
    return best;
  }
  // 冷却到了才尝试；fire() 返回 false（命中不够）时按住，0.2 秒后再看，冷却不浪费
  // 两段式：先瞄准并显示指示（预告 0.25 秒），到点后重新瞄准校验再出手；
  // 目标没了/不够最低命中数就取消，冷却不浪费（0.2 秒后重新预告）。
  var AIM_TELEGRAPH = 0.25, aimPlanning = false;
  function cdTry(key, every, dt, fire) {
    ab.t[key] = (ab.t[key] == null ? every * 0.5 : ab.t[key]) - dt;
    if (ab.t[key] > 0) return false;
    aimPlanning = !ab.pend[key];
    var r = fire();
    aimPlanning = false;
    if (r === "plan") { skillSfx("windup"); logPlan(key); ab.pend[key] = 1; ab.t[key] = AIM_TELEGRAPH; ab.plans++; return false; }
    var was = ab.pend[key]; ab.pend[key] = 0;
    if (r) { skillSfx("fire"); ab.t[key] = every; ab.hold[key] = 0; return true; }
    if (was) { ab.cancels++; skillSfx("cancel"); }
    ab.t[key] = 0.2; ab.hold[key] = (ab.hold[key] || 0) + 1; ab.holds++;
    return false;
  }
  function aimPlan(o) { if (!aimPlanning) return false; o.tele = AIM_TELEGRAPH; aimFx(o); return true; }
  function aimFx(o) { fx("aim", o.x, o.y, 0.75, o); }

  function abProc() { ab.procs++; ab.flash = 0.5; }
  function cdReady(key, every, dt) {
    ab.t[key] = (ab.t[key] == null ? every * 0.5 : ab.t[key]) - dt;
    if (ab.t[key] <= 0) { ab.t[key] = every; return true; }
    return false;
  }
  function freeMice() { var o = []; for (var i = 0; i < mice.length; i++) { var m = mice[i]; if (!m.hidden && !m.carried) o.push(m); } return o; }
  function nearestMice(x, y, r, n, filt) {
    var arr = [];
    gridEach(x, y, r, function (m, d2) { if (m.hidden || m.carried || m.under) return; if (filt && !filt(m)) return; arr.push([d2, m]); });
    arr.sort(function (a, b) { return a[0] - b[0]; });
    return arr.slice(0, n).map(function (a) { return a[1]; });
  }
  function stunM(m, t, kind) { if (!m || m.hidden || m.boss || m.shieldT > 0 || m.elite === "shield") return; if (!(m.stun > 0)) skillSfx("hit"); m.stun = Math.max(m.stun || 0, t); m.stunKind = kind; m.state = "wander"; }
  function pullM(m, x, y, speed, t) { m.pullX = x; m.pullY = y; m.pullV = speed; m.pullT = t; }
  function fx(kind, x, y, life, extra) { if (ab.fx.length > 60) ab.fx.shift(); var f = { k: kind, x: x, y: y, age: 0, life: life }; for (var q in extra) f[q] = extra[q]; ab.fx.push(f); }
  function mouthPoint(dist) { return { x: cat.x + Math.cos(cat.facing) * dist, y: cat.y + Math.sin(cat.facing) * dist }; }
  function histAt(delay) {
    var tt = elapsedPlayTime - delay, h = ab.hist;
    if (!h.length) return { x: cat.x, y: cat.y, a: cat.facing };
    for (var i = h.length - 1; i >= 0; i--) if (h[i].t <= tt) return h[i];
    return h[0];
  }
  function angDiff(a, b) { var d = a - b; while (d > Math.PI) d -= Math.PI * 2; while (d < -Math.PI) d += Math.PI * 2; return d; }

  function syncKittens() {
    if (ab.skin !== "orange") return;
    var want = ab.stage >= 5 ? 3 : ab.stage >= 3 ? 2 : 1;
    while (ab.kittens.length < want) ab.kittens.push({ x: cat.x, y: cat.y, mode: "follow", t: 0, target: null, anim: newAnim(), cycle: 0, side: ab.kittens.length ? -1 : 1, idx: ab.kittens.length });
  }

  function checkEvolution() {
    var st = stageFor(catches);
    if (st <= ab.stage) return;
    ab.stage = st; ab.evoT = 1.0; ab.t = {}; // 进化：所有冷却重置 → 立刻演示新形态
    syncKittens();
    var k = skillOf(ab.skin), lv = k.lv[st - 1];
    showEvoBanner("技能进化：" + lv[1] + "！", k.evo);
    updateSkillBadge(true);
    fx("evo", cat.x, cat.y, 1.0, {});
    if (CA.sfx.evolve) CA.sfx.evolve();
  }

  function updateAbilities(dt) {
    if (!ab) resetAbilities();
    buildGrid();
    var esm = entityScaleMult, i, j, m, d;
    ab.flash = Math.max(0, ab.flash - dt); ab.evoT = Math.max(0, ab.evoT - dt);
    checkEvolution();
    ab.hist.push({ t: elapsedPlayTime, x: cat.x, y: cat.y, a: cat.facing });
    while (ab.hist.length > 2 && ab.hist[0].t < elapsedPlayTime - 1.2) ab.hist.shift();
    var speed = Math.sqrt(cat.vx * cat.vx + cat.vy * cat.vy), moving = speed > MOVE_SPEED * 0.5;
    if (speed > 4) ab.turnAcc += Math.abs(angDiff(cat.facing, ab.lastFacing));
    ab.lastFacing = cat.facing; ab.turnAcc *= Math.exp(-dt * 3);
    var sharpTurn = false;
    if (ab.turnAcc > Math.PI / 2) { sharpTurn = true; ab.turnAcc = 0; }
    if (moving && Math.abs(angDiff(cat.facing, ab.straightDir)) < 0.25) ab.straight += dt; else { ab.straight = 0; ab.straightDir = cat.facing; }
    var S = ab.stage;
    for (i = ab.fx.length - 1; i >= 0; i--) { ab.fx[i].age += dt; if (ab.fx[i].age > ab.fx[i].life) ab.fx.splice(i, 1); }

    if (ab.skin === "orange") updateKittens(dt, S, esm, sharpTurn);
    else if (ab.skin === "black") updateBoxes(dt, S, esm);
    else if (ab.skin === "white") updateSnow(dt, S, esm);
    else if (ab.skin === "calico") updateYarn(dt, S, esm);
    else if (ab.skin === "blue") updateWind(dt, S, esm, sharpTurn);
    else if (ab.skin === "siamese") updateOpera(dt, S, esm);
  }

  // ---- 橘子：喵喵小分队 ----
  function updateKittens(dt, S, esm, sharpTurn) {
    var K = ab.kittens, i, k;
    for (i = 0; i < K.length; i++) {
      k = K[i];
      var tx, ty;
      if (S >= 5) { var h = histAt(0.22 * (i + 1)); tx = h.x; ty = h.y; }
      else { var ang = cat.facing + Math.PI + k.side * 0.7; tx = cat.x + Math.cos(ang) * 34 * esm; ty = cat.y + Math.sin(ang) * 34 * esm; }
      var spd = 0;
      k.t -= dt;
      if (k.mode === "follow") {
        var px = k.x, py = k.y;
        k.x += (tx - k.x) * (1 - Math.exp(-dt * 8)); k.y += (ty - k.y) * (1 - Math.exp(-dt * 8));
        spd = distance(px, py, k.x, k.y) / Math.max(dt, 1e-3);
      } else if (k.mode === "dash" || k.mode === "carry" || k.mode === "herd") {
        var gx = k.gx, gy = k.gy;
        if (k.mode === "dash" && k.target && !k.target.hidden && mice.indexOf(k.target) >= 0) { gx = k.target.x; gy = k.target.y; }
        if (k.mode === "carry") { var mp = mouthPoint(30 * esm); gx = mp.x; gy = mp.y; }
        var dv = normalize(gx - k.x, gy - k.y), dd = distance(k.x, k.y, gx, gy), v = (k.mode === "carry" ? 230 : 380) * esm;
        k.x += dv.x * Math.min(dd, v * dt); k.y += dv.y * Math.min(dd, v * dt); spd = v;
        if (k.mode === "carry" && k.target) { k.target.x = k.x + dv.x * 8 * esm; k.target.y = k.y + dv.y * 8 * esm; }
        if (dd < 6 * esm || k.t <= 0) {
          if (k.mode === "dash" && k.target && mice.indexOf(k.target) >= 0) {
            stunM(k.target, 1.5, "pin"); fx("bang", k.x, k.y, 0.5, {}); abProc();
            if (S >= 3) { // 包抄：把目标附近的老鼠一起赶向你
              var grp = nearestMice(k.target.x, k.target.y, 90 * esm, 6);
              for (var g = 0; g < grp.length; g++) { var mp2 = mouthPoint(40 * esm); pullM(grp[g], mp2.x, mp2.y, 150 * esm, 1.0); }
            }
            if (S >= 2 && k.idx === 0) { k.mode = "carry"; k.t = 1.6; k.target.carried = true; continue; }
          }
          if (k.mode === "carry" && k.target) { k.target.carried = false; stunM(k.target, 1.0, "pin"); }
          k.mode = "follow"; k.target = null;
        }
      }
      stepAnim(k.anim, dt, spd > 20, Math.atan2(ty - k.y, tx - k.x));
      if (k.mode !== "follow") k.anim.dir = ANIM.dirOf(Math.atan2((k.gy || k.y) - k.y + 0.001, (k.gx || k.x) - k.x));
      k.cycle += dt * (spd / 24 + 0.3);
    }
    cdTry("pounce", 8, dt, function () {
      var tgts = [], nf = function (m) { return !(m.stun > 0); };
      for (var z = 0; z < K.length; z++) { var pk = aimBest("single", { maxR: 220 * esm, filt: nf, not: tgts, cluster: true }); if (pk) tgts.push(pk.m); }
      if (!tgts.length) return false;
      if (aimPlan({ x: tgts[0].x, y: tgts[0].y, r: 26 * esm, hits: tgts.length, ic: "🐱", fm: tgts[0] })) return "plan";
      logAim("pounce", tgts.length, tgts.length);
      {
        for (i = 0; i < K.length; i++) {
          k = K[i]; if (k.mode !== "follow") continue;
          var tg = tgts[0];
          if (S >= 3 && K.length >= 2 && i < 2) { // 左右包抄同一目标
            var perp = Math.atan2(tg.y - cat.y, tg.x - cat.x) + Math.PI / 2 * (i === 0 ? 1 : -1);
            k.gx = tg.x + Math.cos(perp) * 40 * esm; k.gy = tg.y + Math.sin(perp) * 40 * esm;
          } else { tg = tgts[Math.min(i, tgts.length - 1)]; k.gx = tg.x; k.gy = tg.y; }
          k.target = tg; k.mode = "dash"; k.t = 0.9;
          fx("arc", k.x, k.y, 0.5, { tx: tg.x, ty: tg.y });
        }
      }
      return true;
    });
    if (S >= 4) cdTry("herd", 6, dt, function () { // 牧羊阵：3 只以上的鼠群圈成一团停在你前方
      var hp = aimBest("point", { maxR: 320 * esm, r: 100 * esm, los: false }), best = hp && hp.hits >= 3 ? nearestMice(hp.x, hp.y, 100 * esm, 8) : null;
      if (!best || best.length < 3) return false;
      if (aimPlan({ x: hp.x, y: hp.y, r: 100 * esm, hits: best.length, ic: "🌀" })) return "plan";
      logAim("herd", best.length, hp.n);
      {
        var mp3 = mouthPoint(70 * esm);
        for (i = 0; i < best.length; i++) { pullM(best[i], mp3.x + (Math.random() - 0.5) * 30 * esm, mp3.y + (Math.random() - 0.5) * 30 * esm, 170 * esm, 1.6); stunM(best[i], 2.6, "pin"); }
        fx("ring", best[0].x, best[0].y, 1.0, { r: 70 * esm });
        abProc();
      }
      return true;
    });
    if (S >= 5 && sharpTurn && cdReady("whip", 1.2, 0)) { // 猫猫列车：急转弯甩尾扫鼠
      var hit = false;
      for (i = 0; i < K.length; i++) {
        var near = nearestMice(K[i].x, K[i].y, 90 * esm, 4);
        for (var q = 0; q < near.length; q++) { pullM(near[q], cat.x, cat.y, 260 * esm, 0.6); hit = true; }
      }
      fx("toot", cat.x, cat.y, 0.8, {});
      if (hit) abProc();
    }
  }

  // ---- 煤球：魔术纸箱 ----
  function boxCap(S) { return S >= 2 ? 3 : 99; }
  function updateBoxes(dt, S, esm) {
    var B = ab.boxes, i, b, m;
    cdTry("box", 10, dt, function () { // 纸箱放在前方 220 内"引诱范围里鼠最多"的点，至少 2 只
      var p = aimBest("point", { maxR: 220 * esm, minR: 50 * esm, r: 150 * esm, lead: 0.5, filt: function (m) { return m.beh !== "sleepy" && !(m.stun > 0); } });
      if (!p || p.hits < 2) return false;
      if (aimPlan({ x: p.x, y: p.y, r: 150 * esm, hits: p.hits, ic: "📦" })) return "plan";
      logAim("box", p.hits, p.n);
      if (B.length >= 3) { var old = B.shift(); releaseBox(old, 0); }
      B.push({ x: p.x, y: p.y, mice: [], closed: false, age: 0, shake: 0 }); abProc();
      return true;
    });
    for (i = B.length - 1; i >= 0; i--) {
      b = B[i]; b.age += dt; b.shake = Math.max(0, b.shake - dt);
      // 老鼠好奇钻箱
      if (!b.closed || b.mice.length < boxCap(S)) {
        // 性能：只查箱子 225 半径内的网格，不再每帧遍历全部老鼠
        b.atNest = !!nestNear(b.x, b.y, 120 * esm);
        gridEach(b.x, b.y, 230 * esm * (b.atNest ? 1.5 : 1), function (m) {
          if (m.hidden || m.carried || m.under || m.asleep || m.type === "gold" && Math.random() < 0.5 * dt) return;
          var d = distance(m.x, m.y, b.x, b.y), lureR = (m.beh === "forager" || m.beh === "thief" ? 225 : 150) * esm * (b.atNest ? 1.5 : 1);
          if (d < lureR && !(m.stun > 0)) m.lureX = b.x, m.lureY = b.y;
          if (d < 14 * esm && b.mice.length < boxCap(S)) { m.hidden = true; m.boxT = 3; b.mice.push(m); b.shake = 0.4; if (S >= 2) b.closed = true; }
        });
      }
      // Lv1：没关盖的箱子，老鼠躲 3 秒后跑出来
      if (S < 2) for (var q = b.mice.length - 1; q >= 0; q--) { b.mice[q].boxT -= dt; if (b.mice[q].boxT <= 0) { b.mice[q].hidden = false; b.mice[q].x = b.x + 16 * esm; b.mice.splice(q, 1); } }
      // Lv4 传送带：关住老鼠的箱子运向你
      if (S >= 4 && b.mice.length) { var dv = normalize(cat.x - b.x, cat.y - b.y); b.x += dv.x * 70 * esm * dt; b.y += dv.y * 70 * esm * dt; b.belt = true; } else b.belt = false;
      // 撞箱：吃掉里面所有老鼠
      if (distance(cat.x, cat.y, b.x, b.y) < cat.r + 16 * esm) {
        if (b.mice.length) { eatBox(b); B.splice(i, 1); }
        else if (S >= 3 && !(ab.t.tunnel > 0)) { // 地道：从鼠最多的箱子冒出来
          var best = null; for (var z = 0; z < B.length; z++) if (B[z] !== b && B[z].mice.length && (!best || B[z].mice.length > best.mice.length)) best = B[z];
          if (best) { fx("tunnel", cat.x, cat.y, 0.6, {}); cat.x = best.x; cat.y = best.y; fx("tunnel", cat.x, cat.y, 0.6, {}); ab.t.tunnel = 1.2; abProc(); }
        }
      }
    }
    if (ab.t.tunnel > 0) ab.t.tunnel -= dt;
    if (S >= 5) cdTry("magic", 25, dt, function () { // 魔术秀：箱子全开，老鼠晕倒排成一排（箱里没鼠就等）
      var popped = [], any = 0;
      for (i = 0; i < B.length; i++) if (distance(B[i].x, B[i].y, cat.x, cat.y) < 500 * esm) any += B[i].mice.length;
      if (!any) return false;
      if (aimPlan({ x: cat.x, y: cat.y, r: 80 * esm, hits: any, ic: "🎩" })) return "plan";
      logAim("magic", any, any);
      for (i = 0; i < B.length; i++) { if (distance(B[i].x, B[i].y, cat.x, cat.y) < 500 * esm) { popped = popped.concat(B[i].mice); B[i].mice = []; B[i].closed = false; fx("confetti", B[i].x, B[i].y, 1.2, {}); } }
      var perpA = cat.facing + Math.PI / 2, base = mouthPoint(60 * esm);
      for (i = 0; i < popped.length; i++) {
        m = popped[i]; m.hidden = false;
        var off = (i - (popped.length - 1) / 2) * 24 * esm;
        m.x = base.x + Math.cos(perpA) * off; m.y = base.y + Math.sin(perpA) * off; stunM(m, 3, "dizzy");
      }
      fx("hat", cat.x, cat.y, 1.2, {}); abProc();
      return true;
    });
  }
  function eatBox(b) {
    for (var i = 0; i < b.mice.length; i++) { var m = b.mice[i]; var idx = mice.indexOf(m); if (idx >= 0) { m.hidden = false; m.x = b.x; m.y = b.y; onCapture(m); mice.splice(idx, 1); } }
    b.mice = []; fx("confetti", b.x, b.y, 0.8, {});
  }
  function releaseBox(b) { for (var i = 0; i < b.mice.length; i++) { b.mice[i].hidden = false; b.mice[i].x = b.x; b.mice[i].y = b.y; } b.mice = []; }

  // ---- 雪团：滚滚雪球 ----
  function updateSnow(dt, S, esm) {
    var i, j, m, b;
    cdTry("ball", 9, dt, function () { // 16 个方向里沿弹道（预判）能卷到最多的；Lv1 至少 1 只，Lv2+ 至少 2 只
      var need = S >= 2 ? 2 : 1, len = 240 * esm * (S >= 2 ? 2 : 1.6);
      var bd = aimBest("dir", { len: len, halfW: 12 * esm, v: 240 * esm, filt: function (m) { return !(m.stun > 0); } });
      if (!bd || bd.hits < need) return false;
      if (aimPlan({ x: cat.x, y: cat.y, a: bd.a, len: bd.len, hits: bd.hits, ic: "⚪", fc: true })) return "plan";
      logAim("ball", bd.hits, bd.n);
      ab.balls.push({ x: cat.x, y: cat.y, a: bd.a, t: 0, r: 9, mice: [], rot: 0, trail: [] }); abProc();
      return true;
    });
    for (i = ab.balls.length - 1; i >= 0; i--) {
      b = ab.balls[i]; b.t += dt;
      var v = 240 * esm, nx = b.x + Math.cos(b.a) * v * dt, ny = b.y + Math.sin(b.a) * v * dt;
      b.rot += v * dt / (b.r * esm);
      var obs = queryNearbyObstacles(nx, ny), blocked = false;
      for (j = 0; j < obs.length; j++) { var o = obs[j]; if (nx > o.x - b.r && nx < o.x + o.w + b.r && ny > o.y - b.r && ny < o.y + o.h + b.r) { blocked = true; break; } }
      if (!blocked) { b.x = nx; b.y = ny; }
      if (S >= 3 && (b.trail.length === 0 || distance(b.x, b.y, b.trail[b.trail.length - 1].x, b.trail[b.trail.length - 1].y) > 14 * esm)) { b.trail.push({ x: b.x, y: b.y }); fx("ice", b.x, b.y, 3, {}); }
      var done = blocked || b.t > (S >= 2 ? 2 : 1.6);
      for (j = 0; j < mice.length; j++) {
        m = mice[j]; if (m.hidden || m.carried) continue;
        if (distance(m.x, m.y, b.x, b.y) < (b.r * esm + m.r)) {
          if (S >= 2) { m.hidden = true; b.mice.push(m); b.r = Math.min(26, b.r + 3); }
          else { freezeM(m, 2, S); done = true; break; }
        }
      }
      if (done) {
        if (S >= 2) {
          for (j = 0; j < b.mice.length; j++) { m = b.mice[j]; m.hidden = false; var a2 = j * 2.4; m.x = b.x + Math.cos(a2) * 20 * esm; m.y = b.y + Math.sin(a2) * 20 * esm; freezeM(m, 2.5, S); }
          var near = nearestMice(b.x, b.y, 60 * esm, 8); for (j = 0; j < near.length; j++) freezeM(near[j], 2.0, S);
          fx("burst", b.x, b.y, 0.6, { r: 60 * esm });
        }
        ab.balls.splice(i, 1);
      }
    }
    if (S >= 4) cdTry("snowman", 20, dt, function () { // 雪人立在射程（220）内鼠最多的位置附近
      var sp = aimBest("point", { maxR: 140 * esm, minR: 60 * esm, r: 220 * esm });
      if (!sp || sp.hits < 2) return false;
      if (aimPlan({ x: sp.x, y: sp.y, r: 40 * esm, hits: sp.hits, ic: "☃️" })) return "plan";
      logAim("snowman", sp.hits, sp.n);
      if (ab.snowmen.length >= 2) ab.snowmen.shift();
      ab.snowmen.push({ x: sp.x, y: sp.y, t: 0, life: 25, cd: 1 }); abProc();
      return true;
    });
    for (i = ab.snowmen.length - 1; i >= 0; i--) {
      var sm = ab.snowmen[i]; sm.t += dt; sm.cd -= dt;
      if (sm.t > sm.life) { ab.snowmen.splice(i, 1); continue; }
      if (sm.cd <= 0) {
        var tg = nearestMice(sm.x, sm.y, 220 * esm, 1, function (q) { return !(q.stun > 0); })[0];
        if (tg) { sm.cd = 2.5; ab.notes.push({ k: "snow", x: sm.x, y: sm.y - 20 * esm, tgt: tg, v: 320 }); }
      }
    }
    updateProjectiles(dt, esm, function (m) { freezeM(m, 2, S); });
    if (S >= 5) cdTry("blizzard", 30, dt, function () {
      var ring = nearestMice(cat.x, cat.y, 220 * esm, 20);
      if (ring.length < 4) return false;
      if (aimPlan({ x: cat.x, y: cat.y, r: 220 * esm, hits: ring.length, ic: "❄️" })) return "plan";
      logAim("blizzard", ring.length, ring.length);
      for (i = 0; i < ring.length; i++) { freezeM(ring[i], 3, S); pullM(ring[i], cat.x, cat.y, 130 * esm, 2.5); }
      fx("blizzard", cat.x, cat.y, 1.6, { r: 220 * esm }); abProc();
      return true;
    });
  }
  function freezeM(m, t, S) {
    stunM(m, t, "ice");
    if (m.leader && m.packId && packLists[m.packId]) { var L = packLists[m.packId]; for (var q = 1; q < L.length; q++) if (!(L[q].stun > 0)) stunM(L[q], 1, "dizzy"); } // 冻住领头鼠：整群发呆 1 秒
    if (S >= 3) pullM(m, cat.x, cat.y, 90 * entityScaleMult, t); // 冰面滑道：被冻的老鼠滑向你
  }

  // ---- 三花：魔法毛线 ----
  function updateYarn(dt, S, esm) {
    var i, m;
    cdTry("lasso", 7, dt, function () { // 单体：金鼠/挑衅鼠优先，近、视线不被挡
      var tg = [];
      for (var z = 0; z < (S >= 2 ? 2 : 1); z++) { var pk = aimBest("single", { maxR: 240 * esm, not: tg, filt: function (q) { return !(q.stun > 0); } }); if (pk) tg.push(pk.m); }
      if (!tg.length) return false;
      if (aimPlan({ x: tg[0].x, y: tg[0].y, r: 22 * esm, hits: tg.length, ic: "🧶", fm: tg[0] })) return "plan";
      logAim("lasso", tg.length, tg.length);
      for (i = 0; i < tg.length; i++) {
        m = tg[i];
        var dv = normalize(cat.x - m.x, cat.y - m.y), pd = Math.min(120 * esm, distance(m.x, m.y, cat.x, cat.y) - cat.r);
        pullM(m, m.x + dv.x * pd, m.y + dv.y * pd, 260 * esm, 0.6); stunM(m, 0.9, "rope");
        fx("lasso", cat.x, cat.y, 0.6, { m: m, c: i ? "#8fc8ff" : "#ff8fb1" });
        if (S >= 4 && m.type === "gold") { ab.swing = { x0: cat.x, y0: cat.y, m: m, t: 0 }; }
      }
      abProc();
      return true;
    });
    if (ab.swing) { // 荡秋千：顺着毛线荡到金鼠身边
      var sw = ab.swing; sw.t += dt;
      var k = Math.min(1, sw.t / 0.4);
      if (mice.indexOf(sw.m) < 0) ab.swing = null;
      else { cat.x = sw.x0 + (sw.m.x - sw.x0) * k; cat.y = sw.y0 + (sw.m.y - sw.y0) * k - Math.sin(k * Math.PI) * 30 * esm; if (k >= 1) ab.swing = null; }
    }
    if (S >= 3) {
      var obs = queryNearbyObstacles(cat.x, cat.y), near = [];
      for (i = 0; i < obs.length; i++) { var o = obs[i], cx = o.x + o.w / 2, cy = o.y + o.h / 2; if (distance(cx, cy, cat.x, cat.y) < 220 * esm) near.push({ x: cx, y: cy, d: distance(cx, cy, cat.x, cat.y) }); }
      near.sort(function (a, b) { return a.d - b.d; });
      if (near.length >= 2 && cdReady("web", 3, dt)) {
        var a = near[0], b2 = near[1];
        // 只有猫正好从两块障碍"之间"穿过时才织网
        var vx = b2.x - a.x, vy = b2.y - a.y, L2 = vx * vx + vy * vy, tt = clamp01(((cat.x - a.x) * vx + (cat.y - a.y) * vy) / L2);
        var px = a.x + vx * tt, py = a.y + vy * tt;
        var wn = countCircle((a.x + b2.x) / 2, (a.y + b2.y) / 2, Math.sqrt(L2) / 2 + 60 * esm, 0.5).hits;
        if (tt > 0.15 && tt < 0.85 && distance(px, py, cat.x, cat.y) < 40 * esm && Math.sqrt(L2) < 300 * esm && wn >= 1) {
          logAim("web", wn, wn);
          if (ab.webs.length >= 2) ab.webs.shift();
          ab.webs.push({ x1: a.x, y1: a.y, x2: b2.x, y2: b2.y, t: 0, life: 8 }); abProc();
        } else ab.t.web = 0.2;
      }
    }
    for (i = ab.webs.length - 1; i >= 0; i--) {
      var w = ab.webs[i]; w.t += dt; if (w.t > w.life) { ab.webs.splice(i, 1); continue; }
      for (var j = 0; j < mice.length; j++) {
        m = mice[j]; if (m.hidden || m.stun > 0) continue;
        var wx = w.x2 - w.x1, wy = w.y2 - w.y1, wl = wx * wx + wy * wy, u = clamp01(((m.x - w.x1) * wx + (m.y - w.y1) * wy) / wl);
        if (distance(m.x, m.y, w.x1 + wx * u, w.y1 + wy * u) < 12 * esm) stunM(m, 4, "web");
      }
    }
    if (S >= 5) cdTry("star", 25, dt, function () {
      var st = nearestMice(cat.x, cat.y, 200 * esm, 20);
      if (st.length < 3) return false;
      if (aimPlan({ x: cat.x, y: cat.y, r: 200 * esm, hits: st.length, ic: "⭐" })) return "plan";
      logAim("star", st.length, st.length);
      for (i = 0; i < st.length; i++) { pullM(st[i], cat.x, cat.y, 250 * esm, 1.0); stunM(st[i], 1.2, "rope"); }
      fx("star", cat.x, cat.y, 1.2, { r: 200 * esm }); abProc();
      return true;
    });
  }

  // ---- 蓝灰：圆滚滚旋风 ----
  function updateWind(dt, S, esm, sharpTurn) {
    var i, j, tw, m;
    if (ab.tornados.length === 0 && ab.straight >= 2 && !(ab.t.windCd > 0) && !(ab.t.windWait > 0)) {
      // 落点：前方 200 内鼠最多处（预判 0.4 秒），范围内不足 2 只就按住不放
      var p = aimBest("point", { maxR: 200 * esm, minR: 40 * esm, r: 70 * esm, lead: 0.4 });
      if (p && p.hits >= 2 && !ab.tornPlan) { ab.tornPlan = { t: AIM_TELEGRAPH }; ab.plans++; logPlan("tornado"); skillSfx("windup"); aimFx({ x: p.x, y: p.y, r: 70 * esm, hits: p.hits, ic: "🌪", tele: AIM_TELEGRAPH }); }
      else if (ab.tornPlan && ab.tornPlan.t > 0) { /* 预告中 */ }
      else if (p && p.hits >= 2) {
        ab.tornPlan = null;
        ab.tornados.push({ x: p.x, y: p.y, t: 0, life: S >= 2 ? 4 : 3, r: 60, hops: 0, follow: S >= 2, followAt: 1.2, sucked: 0 }); abProc();
        logAim("tornado", p.hits, p.n); skillSfx("fire");
      } else { if (ab.tornPlan) { ab.tornPlan = null; ab.cancels++; skillSfx("cancel"); } ab.t.windWait = 0.2; ab.holds++; ab.hold.tornado = (ab.hold.tornado || 0) + 1; }
    }
    if (ab.t.windWait > 0) ab.t.windWait -= dt;
    if (ab.tornPlan) { ab.tornPlan.t -= dt; if (!(ab.straight >= 2) && ab.tornPlan.t <= -0.5) ab.tornPlan = null; }
    if (ab.t.windCd > 0) ab.t.windCd -= dt;
    if (S >= 4 && sharpTurn && !(ab.t.splitCd > 0)) {
      ab.t.splitCd = 5;
      for (var sd = -1; sd <= 1; sd += 2) { var aa = cat.facing + sd * Math.PI / 2; ab.tornados.push({ x: cat.x + Math.cos(aa) * 70 * esm, y: cat.y + Math.sin(aa) * 70 * esm, t: 0, life: 2, r: 50, hops: 3, follow: false, vx: Math.cos(aa) * 120, vy: Math.sin(aa) * 120, sucked: 0 }); }
      abProc();
    }
    if (ab.t.splitCd > 0) ab.t.splitCd -= dt;
    for (i = ab.tornados.length - 1; i >= 0; i--) {
      tw = ab.tornados[i]; tw.t += dt;
      if (tw.follow && !tw.hopTo && tw.t > (tw.followAt || 0)) { var fp = mouthPoint(110 * esm); tw.x += (fp.x - tw.x) * (1 - Math.exp(-dt * 5)); tw.y += (fp.y - tw.y) * (1 - Math.exp(-dt * 5)); }
      if (tw.vx) { tw.x += tw.vx * esm * dt; tw.y += tw.vy * esm * dt; }
      if (tw.hopTo) { var hk = Math.min(1, (tw.t - tw.hopT0) / 0.35); tw.x = tw.hx + (tw.hopTo.x - tw.hx) * hk; tw.y = tw.hy + (tw.hopTo.y - tw.hy) * hk; if (hk >= 1) tw.hopTo = null; }
      var got = 0;
      for (j = 0; j < mice.length; j++) {
        m = mice[j]; if (m.hidden || m.carried) continue;
        var d = distance(m.x, m.y, tw.x, tw.y);
        if (d < tw.r * esm && m.under) { m.under = false; m.underT = 0; } // 旋风把地洞鼠卷出洞
        if (d < tw.r * esm && m.asleep) m.asleep = false; // 吹醒瞌睡鼠（先晕）
        if (d < tw.r * esm) { if (!(m.stun > 0)) { stunM(m, 2, "spin"); got++; tw.sucked++; } pullM(m, tw.x, tw.y, 120 * esm, 0.2); }
      }
      if (S >= 3 && tw.sucked > 0 && tw.hops < 3 && !tw.hopTo && tw.t > 0.8) { // 连锁跳
        var nx = aimBest("point", { x: tw.x, y: tw.y, maxR: 260 * esm, minR: tw.r * esm, r: tw.r * esm, lead: 0.35, los: false, filt: function (q) { return !(q.stun > 0); } });
        if (nx && !tw.hopPlan) { tw.hopPlan = tw.t; ab.plans++; logPlan("hop"); skillSfx("windup"); aimFx({ x: nx.x, y: nx.y, r: tw.r * esm, hits: nx.hits, ic: "↪️", tele: AIM_TELEGRAPH }); nx = null; }
        else if (tw.hopPlan && tw.t - tw.hopPlan < AIM_TELEGRAPH) nx = null;
        else if (tw.hopPlan) { tw.hopPlan = 0; if (!nx) ab.cancels++; }
        if (nx) logAim("hop", nx.hits, nx.n);
        if (nx) { tw.hops++; tw.sucked = 0; tw.follow = false; tw.hx = tw.x; tw.hy = tw.y; tw.hopTo = { x: nx.x, y: nx.y }; tw.hopT0 = tw.t; tw.life = tw.t + 1.6; fx("hop", tw.x, tw.y, 0.4, { tx: nx.x, ty: nx.y }); }
      }
      if (tw.t > tw.life) { ab.tornados.splice(i, 1); if (!tw.vx) ab.t.windCd = 4; }
    }
    if (S >= 5) cdTry("bigroll", 30, dt, function () { var c = countCircle(cat.x, cat.y, 210 * esm, 0); if (c.hits < 3) return false; if (aimPlan({ x: cat.x, y: cat.y, r: 210 * esm, hits: c.hits, ic: "🌀" })) return "plan"; logAim("bigroll", c.hits, c.n); ab.roll = 3; abProc(); return true; });
    if (ab.roll > 0) { // 大胖龙卷：团成球滚 3 秒，沿途老鼠卷到嘴边
      ab.roll -= dt;
      var big = nearestMice(cat.x, cat.y, 140 * esm, 20);
      for (i = 0; i < big.length; i++) { stunM(big[i], 0.6, "spin"); pullM(big[i], cat.x, cat.y, 220 * esm, 0.3); }
    }
  }

  // ---- 暹罗：歌剧喵 ----
  function updateOpera(dt, S, esm) {
    var i, m;
    cdTry("note", 8, dt, function () {
      var tg = [];
      for (var z = 0; z < (S >= 2 ? 3 : 1); z++) { var pk = aimBest("single", { maxR: 260 * esm, not: tg, filt: function (q) { return !(q.stun > 0); } }); if (pk) tg.push(pk.m); }
      if (!tg.length) return false;
      if (aimPlan({ x: tg[0].x, y: tg[0].y, r: 22 * esm, hits: tg.length, ic: "🎵", fm: tg[0] })) return "plan";
      logAim("note", tg.length, tg.length);
      var NOTE = ["♪", "♫", "♬"];
      for (i = 0; i < tg.length; i++) ab.notes.push({ k: "note", ch: NOTE[i % 3], c: ["#ff7a9a", "#7ab8ff", "#ffc24a"][i % 3], x: cat.x, y: cat.y - 20 * esm, tgt: tg[i], v: 300 });
      abProc(); fx("sing", cat.x, cat.y, 0.6, {});
      return true;
    });
    updateProjectiles(dt, esm, function (m) { stunM(m, 2, "dance"); m.danceT = 2; });
    if (S >= 3) { // 康加舞队：跳舞的老鼠排队朝你走来
      var dancers = mice.filter(function (q) { return q.stunKind === "dance" && q.stun > 0 && !q.hidden; });
      for (i = 0; i < dancers.length; i++) {
        var slot = mouthPoint((50 + i * 22) * esm);
        pullM(dancers[i], slot.x, slot.y, 55 * esm, 0.2);
      }
    }
    if (S >= 4) cdTry("spot", 20, dt, function () { // 聚光灯：密度最高处（小偷鼠 ×2），至少 3 只
      var best = aimBest("point", { maxR: 360 * esm, r: 100 * esm, los: false, wfn: function (q) { var w = aimW(q); return q.beh === "thief" ? w * 2 : w; } });
      if (!best || best.hits < 3) return false;
      if (aimPlan({ x: best.x, y: best.y, r: 100 * esm, hits: best.hits, ic: "🔦" })) return "plan";
      var bow = nearestMice(best.x, best.y, 100 * esm, 14);
      if (bow.length < 3) return false;
      logAim("spot", bow.length, best.n);
      for (i = 0; i < bow.length; i++) { stunM(bow[i], 2.5, "bow"); if (bow[i].beh === "thief") { bow[i].beh = "forager"; bow[i].food = null; fx("bang", bow[i].x, bow[i].y, 0.4, {}); } }
      ab.spot = { x: best.x, y: best.y, t: 2.5, r: 100 * esm }; abProc(); silenceNests(best.x, best.y, 100 * esm, 5);
      return true;
    });
    if (ab.spot) { ab.spot.t -= dt; if (ab.spot.t <= 0) ab.spot = null; }
    if (S >= 5) cdTry("choir", 30, dt, function () {
      var ch = nearestMice(cat.x, cat.y, 320 * esm, 24);
      if (ch.length < 3) return false;
      if (aimPlan({ x: cat.x, y: cat.y, r: 320 * esm, hits: ch.length, ic: "🎤" })) return "plan";
      logAim("choir", ch.length, ch.length);
      for (i = 0; i < ch.length; i++) {
        var ang = cat.facing - Math.PI / 2 + Math.PI * (ch.length === 1 ? 0.5 : i / (ch.length - 1));
        pullM(ch[i], cat.x + Math.cos(ang) * 90 * esm, cat.y + Math.sin(ang) * 90 * esm, 260 * esm, 1.2);
        stunM(ch[i], 3, "sing");
      }
      fx("choir", cat.x, cat.y, 3, {}); abProc(); silenceNests(cat.x, cat.y, 320 * esm, 5);
      return true;
    });
  }

  function updateProjectiles(dt, esm, onHit) {
    for (var i = ab.notes.length - 1; i >= 0; i--) {
      var n = ab.notes[i];
      if (!n.tgt || mice.indexOf(n.tgt) < 0 || n.tgt.hidden) { ab.notes.splice(i, 1); continue; }
      var d = distance(n.x, n.y, n.tgt.x, n.tgt.y), dv = normalize(n.tgt.x - n.x, n.tgt.y - n.y), st = n.v * esm * dt;
      if (d <= st + 6) { onHit(n.tgt); fx(n.k === "snow" ? "burst" : "bang", n.tgt.x, n.tgt.y, 0.4, { r: 20 * esm }); ab.notes.splice(i, 1); continue; }
      n.x += dv.x * st; n.y += dv.y * st;
    }
  }

  // 在 updateMice 里、位移之前调用：技能对老鼠的影响
  function applyAbilityToMouse(m, dt) {
    if (m.carried) { m.vx = 0; m.vy = 0; m.carryFrame = true; return; }
    if (m.stun > 0) { m.stun -= dt; m.vx = 0; m.vy = 0; if (m.stun <= 0) m.stunKind = null; }
    else if (m.lureX != null && m.state !== "flee") { var lv = normalize(m.lureX - m.x, m.lureY - m.y); m.vx = lv.x * m.speed * 0.6; m.vy = lv.y * m.speed * 0.6; }
    m.lureX = null; m.lureY = null;
    if (m.pullT > 0) {
      m.pullT -= dt;
      var d = distance(m.x, m.y, m.pullX, m.pullY);
      if (d > 3) { var pv = normalize(m.pullX - m.x, m.pullY - m.y), sp = Math.min(m.pullV, d / Math.max(dt, 1e-3)); m.vx = pv.x * sp; m.vy = pv.y * sp; }
      else { m.vx = 0; m.vy = 0; }
    }
  }

  // ---- 技能画面（全部是叠加层/独立小物件，8 个方向通用） ----
  function SX(x) { return worldToScreenX(x); }
  function SY(y) { return worldToScreenY(y); }
  function emojiAt(ch, x, y, size, alpha) {
    ctx.globalAlpha = alpha == null ? 1 : alpha; ctx.font = Math.round(size) + "px sans-serif"; ctx.textAlign = "center"; ctx.textBaseline = "middle";
    ctx.fillText(ch, x, y); ctx.textBaseline = "alphabetic"; ctx.globalAlpha = 1;
  }
  function drawAbilityGround() {
    if (!ab) return;
    var sc = s(1) * entityScaleMult, i, f;
    for (i = 0; i < ab.fx.length; i++) {
      f = ab.fx[i];
      if (f.k === "ice") { ctx.globalAlpha = 0.55 * (1 - f.age / f.life); ctx.fillStyle = "#cfefff"; ctx.beginPath(); ctx.ellipse(SX(f.x), SY(f.y) + 8 * sc, 14 * sc, 7 * sc, 0, 0, Math.PI * 2); ctx.fill(); ctx.globalAlpha = 1; }
    }
    for (i = 0; i < ab.webs.length; i++) {
      var w = ab.webs[i], al = Math.min(1, (w.life - w.t) / 1);
      ctx.strokeStyle = "rgba(255,143,177," + (0.8 * al) + ")"; ctx.lineWidth = 2 * sc;
      var x1 = SX(w.x1), y1 = SY(w.y1), x2 = SX(w.x2), y2 = SY(w.y2), nx = -(y2 - y1), ny = x2 - x1, L = Math.sqrt(nx * nx + ny * ny) || 1;
      nx /= L; ny /= L;
      for (var k = -2; k <= 2; k++) { ctx.beginPath(); ctx.moveTo(x1 + nx * k * 6 * sc, y1 + ny * k * 6 * sc); ctx.lineTo(x2 + nx * k * 6 * sc, y2 + ny * k * 6 * sc); ctx.stroke(); }
      for (var q = 0; q <= 8; q++) { var u = q / 8; ctx.beginPath(); ctx.moveTo(x1 + (x2 - x1) * u - nx * 12 * sc, y1 + (y2 - y1) * u - ny * 12 * sc); ctx.lineTo(x1 + (x2 - x1) * u + nx * 12 * sc, y1 + (y2 - y1) * u + ny * 12 * sc); ctx.stroke(); }
    }
    if (ab.spot) {
      var sp = ab.spot, g = ctx.createRadialGradient(SX(sp.x), SY(sp.y), 0, SX(sp.x), SY(sp.y), s(sp.r));
      g.addColorStop(0, "rgba(255,240,150,.6)"); g.addColorStop(1, "rgba(255,240,150,0)");
      ctx.fillStyle = g; ctx.beginPath(); ctx.arc(SX(sp.x), SY(sp.y), s(sp.r), 0, Math.PI * 2); ctx.fill();
    }
    for (i = 0; i < ab.boxes.length; i++) if (ab.boxes[i].belt) {
      var b = ab.boxes[i], dv = normalize(cat.x - b.x, cat.y - b.y);
      ctx.strokeStyle = "rgba(90,90,110,.5)"; ctx.lineWidth = 10 * sc; ctx.lineCap = "round";
      ctx.beginPath(); ctx.moveTo(SX(b.x), SY(b.y) + 10 * sc); ctx.lineTo(SX(b.x + dv.x * 60), SY(b.y + dv.y * 60) + 10 * sc); ctx.stroke();
      ctx.strokeStyle = "rgba(255,255,255,.6)"; ctx.lineWidth = 2 * sc; ctx.setLineDash([4 * sc, 6 * sc]); ctx.lineDashOffset = -elapsedPlayTime * 30;
      ctx.beginPath(); ctx.moveTo(SX(b.x), SY(b.y) + 10 * sc); ctx.lineTo(SX(b.x + dv.x * 60), SY(b.y + dv.y * 60) + 10 * sc); ctx.stroke(); ctx.setLineDash([]);
    }
  }
  function drawAbilityBehindCat() {
    if (!ab) return;
    var sc = s(1) * entityScaleMult, i;
    for (i = 0; i < ab.boxes.length; i++) {
      var b = ab.boxes[i], x = SX(b.x), y = SY(b.y), sh = b.shake > 0 ? Math.sin(elapsedPlayTime * 60) * 2 * sc : 0;
      shadow(x, y + 14 * sc, 18 * sc);
      ctx.fillStyle = "#e8b77a"; ctx.strokeStyle = "#a8743c"; ctx.lineWidth = 2 * sc;
      ctx.beginPath(); ctx.roundRect(x - 16 * sc + sh, y - 10 * sc, 32 * sc, 24 * sc, 4 * sc); ctx.fill(); ctx.stroke();
      if (b.closed) { ctx.fillStyle = "#d9a466"; ctx.beginPath(); ctx.roundRect(x - 18 * sc + sh, y - 15 * sc, 36 * sc, 7 * sc, 3 * sc); ctx.fill(); ctx.stroke(); }
      else { ctx.fillStyle = "#5a3a20"; ctx.fillRect(x - 12 * sc + sh, y - 9 * sc, 24 * sc, 5 * sc); ctx.fillStyle = "#d9a466"; ctx.beginPath(); ctx.moveTo(x - 16 * sc, y - 10 * sc); ctx.lineTo(x - 24 * sc, y - 20 * sc); ctx.lineTo(x - 12 * sc, y - 18 * sc); ctx.closePath(); ctx.fill(); ctx.stroke(); }
      if (b.mice.length) {
        ctx.strokeStyle = "#ff8fb1"; ctx.lineWidth = 2 * sc; ctx.beginPath(); ctx.moveTo(x + 16 * sc, y + 6 * sc); ctx.quadraticCurveTo(x + 26 * sc, y + 2 * sc, x + 24 * sc, y - 6 * sc + Math.sin(elapsedPlayTime * 8) * 3 * sc); ctx.stroke();
        ctx.font = "900 " + Math.round(11 * sc) + "px sans-serif"; ctx.textAlign = "center"; ctx.fillStyle = "#fff"; ctx.strokeStyle = "#7a4a2a"; ctx.lineWidth = 3;
        var lbl = (b.closed ? "?" : "") + "×" + b.mice.length; ctx.strokeText(lbl, x, y - 20 * sc); ctx.fillText(lbl, x, y - 20 * sc);
      }
    }
    for (i = 0; i < ab.snowmen.length; i++) {
      var sm = ab.snowmen[i], sx = SX(sm.x), sy = SY(sm.y);
      shadow(sx, sy + 16 * sc, 14 * sc);
      ART.ellipse(ctx, sx, sy + 6 * sc, 13 * sc, 12 * sc, "#ffffff", "#bcd8ee", 1.5 * sc);
      ART.ellipse(ctx, sx, sy - 12 * sc, 9 * sc, 9 * sc, "#ffffff", "#bcd8ee", 1.5 * sc);
      ctx.fillStyle = "#333"; ctx.beginPath(); ctx.arc(sx - 3 * sc, sy - 14 * sc, 1.4 * sc, 0, 7); ctx.arc(sx + 3 * sc, sy - 14 * sc, 1.4 * sc, 0, 7); ctx.fill();
      ctx.fillStyle = "#ff8a3d"; ctx.beginPath(); ctx.moveTo(sx, sy - 11 * sc); ctx.lineTo(sx + 8 * sc, sy - 10 * sc); ctx.lineTo(sx, sy - 9 * sc); ctx.fill();
    }
    for (i = 0; i < ab.balls.length; i++) {
      var bl = ab.balls[i], r = bl.r * sc, bx = SX(bl.x), by = SY(bl.y);
      shadow(bx, by + r, r);
      ART.ellipse(ctx, bx, by, r, r, "#ffffff", "#a9cfee", 1.6 * sc);
      ctx.strokeStyle = "rgba(169,207,238,.8)"; ctx.lineWidth = 1.2 * sc; ctx.beginPath(); ctx.arc(bx, by, r * 0.6, bl.rot, bl.rot + 2); ctx.stroke();
      for (var t2 = 0; t2 < bl.mice.length; t2++) { var ta = bl.rot + t2 * 2.2; ctx.strokeStyle = "#ff9ab0"; ctx.beginPath(); ctx.moveTo(bx + Math.cos(ta) * r, by + Math.sin(ta) * r); ctx.lineTo(bx + Math.cos(ta) * (r + 7 * sc), by + Math.sin(ta) * (r + 7 * sc)); ctx.stroke(); }
    }
    for (i = 0; i < ab.tornados.length; i++) {
      var tw = ab.tornados[i], tx = SX(tw.x), ty = SY(tw.y), rr = tw.r * sc, al = Math.min(1, tw.t * 3, (tw.life - tw.t) * 2);
      ctx.globalAlpha = 0.75 * Math.max(0, al);
      for (var ly = 0; ly < 5; ly++) {
        var w2 = rr * (0.35 + ly * 0.16), yy = ty + 14 * sc - ly * 9 * sc, ph = elapsedPlayTime * 9 + ly;
        ctx.strokeStyle = ly % 2 ? "#b7c6dc" : "#e8eef7"; ctx.lineWidth = 3 * sc;
        ctx.beginPath(); ctx.ellipse(tx + Math.sin(ph) * 4 * sc, yy, w2, w2 * 0.28, 0, ph % 6.28, ph % 6.28 + 4.4); ctx.stroke();
      }
      ctx.globalAlpha = 1;
    }
    for (i = 0; i < ab.kittens.length; i++) {
      var k = ab.kittens[i];
      drawCatAt(SX(k.x), SY(k.y), s(cat.r) * 0.55, k.anim, k.cycle, "orange", true);
      if (k.mode === "carry" && k.target) { /* 被叼的老鼠由 drawMice 照常绘制在小猫嘴边 */ }
    }
    if (ab.roll > 0) {
      var cx = SX(cat.x), cy = SY(cat.y), R = s(140 * entityScaleMult);
      ctx.strokeStyle = "rgba(180,200,230,.55)"; ctx.lineWidth = 6 * sc;
      for (var z = 0; z < 3; z++) { ctx.beginPath(); ctx.arc(cx, cy, R * (0.4 + z * 0.25), elapsedPlayTime * 6 + z, elapsedPlayTime * 6 + z + 3.5); ctx.stroke(); }
    }
  }
  var STUN_ICON = { pin: "💢", ice: "", web: "🕸", spin: "💫", dance: "🎵", bow: "🙇", sing: "🎶", rope: "", dizzy: "💫" };
  function drawAbilityOverlay() {
    if (!ab) return;
    var sc = s(1) * entityScaleMult, i, m, cx = SX(cat.x), cy = SY(cat.y);
    for (i = 0; i < mice.length; i++) {
      m = mice[i]; if (m.hidden || !(m.stun > 0)) continue;
      var mx = SX(m.x), my = SY(m.y);
      if (mx < -60 || mx > W + 60 || my < -60 || my > H + 60) continue;
      if (m.stunKind === "ice") { ctx.fillStyle = "rgba(190,230,255,.55)"; ctx.strokeStyle = "rgba(255,255,255,.9)"; ctx.lineWidth = 1.5 * sc; ctx.beginPath(); ctx.roundRect(mx - 16 * sc, my - 18 * sc, 32 * sc, 30 * sc, 6 * sc); ctx.fill(); ctx.stroke(); }
      else if (m.stunKind === "rope") { ctx.strokeStyle = "#ff8fb1"; ctx.lineWidth = 2 * sc; ctx.beginPath(); ctx.ellipse(mx, my, 14 * sc, 6 * sc, 0, 0, 7); ctx.stroke(); }
      var ic = STUN_ICON[m.stunKind];
      if (ic) emojiAt(ic, mx + (m.stunKind === "dance" ? Math.sin(elapsedPlayTime * 10) * 5 * sc : 0), my - 26 * sc, 13 * sc);
    }
    for (i = 0; i < ab.notes.length; i++) {
      var n = ab.notes[i];
      if (n.k === "note") { ctx.font = "900 " + Math.round(20 * sc) + "px sans-serif"; ctx.textAlign = "center"; ctx.lineWidth = 3; ctx.strokeStyle = "#fff"; ctx.strokeText(n.ch, SX(n.x), SY(n.y)); ctx.fillStyle = n.c; ctx.fillText(n.ch, SX(n.x), SY(n.y)); }
      else ART.ellipse(ctx, SX(n.x), SY(n.y), 5 * sc, 5 * sc, "#fff", "#a9cfee", 1.2 * sc);
    }
    for (i = 0; i < ab.fx.length; i++) {
      var f = ab.fx[i], k = f.age / f.life, fx0 = SX(f.x), fy0 = SY(f.y), a = 1 - k;
      if (f.k === "aim") { // 自动瞄准指示：出手前 0.25 秒预告（虚线弹道 / 落点圈 + 预计命中 ×N），出手后淡出
        if (f.fm && mice.indexOf(f.fm) >= 0 && !f.fm.hidden) { f.x = f.fm.x; f.y = f.fm.y; }
        if (f.fc && f.age < (f.tele || 0)) { f.x = cat.x; f.y = cat.y; }
        fx0 = SX(f.x); fy0 = SY(f.y);
        var pre = f.age < (f.tele || 0), aa = pre ? 0.6 + 0.4 * Math.sin(f.age * 40) : Math.min(1, (1 - k) * 1.6), lx, ly;
        ctx.save(); ctx.globalAlpha = aa; ctx.setLineDash([8 * sc, 6 * sc]); ctx.lineWidth = 3 * sc; ctx.strokeStyle = "rgba(255,255,255,.95)";
        if (f.a != null) { var L = s(f.len); ctx.beginPath(); ctx.moveTo(fx0, fy0); ctx.lineTo(fx0 + Math.cos(f.a) * L, fy0 + Math.sin(f.a) * L); ctx.stroke(); lx = fx0 + Math.cos(f.a) * L * 0.6; ly = fy0 + Math.sin(f.a) * L * 0.6; }
        else { var AR = s(f.r) * (0.85 + 0.15 * Math.min(1, k * 4)); ctx.beginPath(); ctx.arc(fx0, fy0, AR, 0, Math.PI * 2); ctx.stroke(); ctx.setLineDash([]); ctx.strokeStyle = "rgba(255,90,120,.9)"; ctx.lineWidth = 2 * sc; ctx.beginPath(); ctx.moveTo(fx0 - 6 * sc, fy0); ctx.lineTo(fx0 + 6 * sc, fy0); ctx.moveTo(fx0, fy0 - 6 * sc); ctx.lineTo(fx0, fy0 + 6 * sc); ctx.stroke(); lx = fx0; ly = fy0 - AR - 10 * sc; }
        ctx.setLineDash([]); ctx.font = "900 " + Math.round(16 * sc) + "px sans-serif"; ctx.textAlign = "center"; ctx.lineWidth = 4 * sc; ctx.strokeStyle = "#5a3a2a";
        var lab = (f.ic || "") + "×" + f.hits; ctx.strokeText(lab, lx, ly); ctx.fillStyle = "#fff"; ctx.fillText(lab, lx, ly);
        ctx.restore();
      } else if (f.k === "hole") { ctx.fillStyle = f.gold ? "rgba(255,210,80," + a + ")" : "rgba(40,30,20," + (0.7 * a) + ")"; ctx.beginPath(); ctx.ellipse(fx0, fy0 + 10 * sc, 20 * sc * (0.6 + k), 8 * sc * (0.6 + k), 0, 0, 7); ctx.fill(); }
      else if (f.k === "lasso" && f.m && mice.indexOf(f.m) >= 0) {
        ctx.strokeStyle = f.c; ctx.lineWidth = 2.5 * sc; ctx.globalAlpha = a; ctx.beginPath(); ctx.moveTo(cx, cy); ctx.quadraticCurveTo((cx + SX(f.m.x)) / 2, Math.min(cy, SY(f.m.y)) - 30 * sc, SX(f.m.x), SY(f.m.y)); ctx.stroke(); ctx.globalAlpha = 1;
      } else if (f.k === "arc" || f.k === "hop") {
        ctx.strokeStyle = "rgba(255,180,90," + a + ")"; ctx.lineWidth = 2 * sc; ctx.setLineDash([5 * sc, 5 * sc]);
        ctx.beginPath(); ctx.moveTo(fx0, fy0); ctx.quadraticCurveTo((fx0 + SX(f.tx)) / 2, Math.min(fy0, SY(f.ty)) - 40 * sc, SX(f.tx), SY(f.ty)); ctx.stroke(); ctx.setLineDash([]);
      } else if (f.k === "bang") emojiAt("💥", fx0, fy0 - 10 * sc, 18 * sc * (0.8 + k * 0.4), a);
      else if (f.k === "ring" || f.k === "burst" || f.k === "blizzard" || f.k === "star") {
        var R = s(f.r || 60) * (f.k === "ring" ? 1 : Math.min(1, k * 1.6));
        ctx.strokeStyle = f.k === "star" ? "rgba(255,143,177," + a + ")" : f.k === "ring" ? "rgba(200,150,90," + a + ")" : "rgba(170,220,255," + a + ")";
        ctx.lineWidth = 4 * sc;
        if (f.k === "star") { ctx.beginPath(); for (var p = 0; p <= 10; p++) { var an = -Math.PI / 2 + p * Math.PI / 5, rad = p % 2 ? R * 0.45 : R; var px = fx0 + Math.cos(an) * rad, py = fy0 + Math.sin(an) * rad; if (p) ctx.lineTo(px, py); else ctx.moveTo(px, py); } ctx.stroke(); }
        else { ctx.beginPath(); ctx.arc(fx0, fy0, R, 0, Math.PI * 2); ctx.stroke(); }
        if (f.k === "blizzard") for (var q = 0; q < 14; q++) emojiAt("❄", fx0 + Math.cos(q * 0.45 + k * 4) * R, fy0 + Math.sin(q * 0.45 + k * 4) * R, 12 * sc, a);
      } else if (f.k === "confetti") { for (var c2 = 0; c2 < 10; c2++) { ctx.fillStyle = ["#ff7a9a", "#ffd84a", "#7ab8ff", "#8fd16a"][c2 % 4]; ctx.globalAlpha = a; ctx.fillRect(fx0 + Math.cos(c2 * 0.63) * 40 * k * sc, fy0 - 30 * k * sc + Math.sin(c2 * 0.63) * 30 * k * sc, 4 * sc, 7 * sc); } ctx.globalAlpha = 1; }
      else if (f.k === "hat") emojiAt("🎩", cx, cy - 46 * sc - Math.sin(k * Math.PI) * 8 * sc, 22 * sc, a);
      else if (f.k === "toot") emojiAt("嘟嘟~", cx, cy - 50 * sc, 14 * sc, a);
      else if (f.k === "sing") emojiAt("♪", cx + 16 * sc, cy - 44 * sc - k * 10 * sc, 18 * sc, a);
      else if (f.k === "choir") emojiAt("🎤", cx + 18 * sc, cy - 40 * sc, 18 * sc, Math.min(1, a * 3));
      else if (f.k === "tunnel") { ctx.fillStyle = "rgba(40,30,50," + (0.6 * a) + ")"; ctx.beginPath(); ctx.ellipse(fx0, fy0 + 10 * sc, 22 * sc * (0.5 + k), 8 * sc * (0.5 + k), 0, 0, 7); ctx.fill(); }
      else if (f.k === "evo") {
        for (var e = 0; e < 10; e++) { var ea = e / 10 * Math.PI * 2 + k * 2; ART.star(ctx, cx + Math.cos(ea) * 50 * sc * (0.6 + k), cy + 10 * sc + Math.sin(ea) * 26 * sc * (0.6 + k), (e % 2 ? 6 : 9) * sc, e % 3 ? "#ffd84a" : "#ff9ab0"); }
        var lv = skillOf(ab.skin).lv[ab.stage - 1];
        var pop = k < 0.15 ? k / 0.15 : 1;
        ctx.globalAlpha = Math.min(1, a * 2);
        ctx.fillStyle = "#ff7a3d"; ctx.strokeStyle = "#fff"; ctx.lineWidth = 3;
        ctx.beginPath(); ctx.roundRect(cx - 34 * sc * pop, cy - 92 * sc, 68 * sc * pop, 28 * sc, 14 * sc); ctx.fill(); ctx.stroke();
        ctx.font = "900 " + Math.round(15 * sc * pop) + "px sans-serif"; ctx.textAlign = "center"; ctx.fillStyle = "#fff"; ctx.fillText(lv[0] + " Lv" + ab.stage, cx, cy - 73 * sc);
        ctx.globalAlpha = 1;
      }
    }
  }
  // 进化时小猫原地小跳（绘制偏移，不改位置/碰撞）
  function evoHop() { return ab && ab.evoT > 0 ? -Math.sin((1 - ab.evoT) * Math.PI * 2) * Math.max(0, ab.evoT - 0.5) * 2 * 14 : 0; }

  // ---- HUD 技能徽章 / 进化横幅 ----
  function updateSkillBadge(flip) {
    if (!ab || !dom.abilityBadge) return;
    var k = skillOf(ab.skin), st = ab.stage, lv = k.lv[st - 1];
    var lo = STAGE_AT[st - 1], hi = st < 5 ? STAGE_AT[st] : null;
    var pct = hi ? Math.round(100 * (catches - lo) / (hi - lo)) : 100;
    var key = st + "|" + pct + "|" + catches;
    if (dom.abilityBadge.dataset.key === key && !flip) return;
    dom.abilityBadge.dataset.key = key;
    if (!dom.abilityBadge.firstChild || flip) {
      dom.abilityBadge.innerHTML = '<span class="ab-ic"></span><span class="ab-txt"><b class="ab-lv"></b><span class="ab-name"></span><i class="ab-bar"><i></i></i><small class="ab-prog"></small></span>';
    }
    var q = function (c) { return dom.abilityBadge.querySelector(c); };
    setText(q(".ab-ic"), lv[0]); setText(q(".ab-lv"), "Lv" + st); setText(q(".ab-name"), lv[1]);
    q(".ab-bar > i").style.width = pct + "%";
    setText(q(".ab-prog"), hi ? (catches + " / " + hi + " → Lv" + (st + 1)) : "MAX");
    toggleCls(dom.abilityBadge, "max", !hi);
    if (flip) { dom.abilityBadge.classList.remove("evo"); void dom.abilityBadge.offsetWidth; dom.abilityBadge.classList.add("evo"); }
  }
  var evoTimer = null;
  function showEvoBanner(title, sub) {
    var el = document.getElementById("evoBanner");
    if (!el) return;
    el.innerHTML = "<b></b><span></span>"; el.firstChild.textContent = title; el.lastChild.textContent = sub;
    el.classList.remove("hidden", "show"); void el.offsetWidth; el.classList.add("show");
    clearTimeout(evoTimer); evoTimer = setTimeout(function () { el.classList.remove("show"); el.classList.add("hidden"); }, 2000);
  }

  // =======================================================================
  // Particles & score popups
  // =======================================================================

  var scorePopups = [];
  var catchParticles = [];

  // 飘字合并：0.3s 内、90px 内的得分并到同一个数字里（显示 +N ♥ ×k），最多 8 个
  function spawnScorePopup(x, y, amount) {
    for (var i = scorePopups.length - 1; i >= 0; i--) {
      var p = scorePopups[i];
      if (p.age < 0.3 && Math.abs(p.x - x) < 90 && Math.abs(p.y - y) < 90) { p.amount += amount; p.n = (p.n || 1) + 1; p.age = Math.min(p.age, 0.12); p.x = (p.x + x) / 2; return; }
    }
    scorePopups.push({ x: x, y: y, amount: amount, age: 0, life: 0.9, n: 1 });
    if (scorePopups.length > 8) scorePopups.shift();
  }

  // ---- v13 打击感（A5/B5）：命中停顿、星形爆点、得分飞向计分板、镜头轻推、连击分级 ----
  var hitStopT = 0, hitStopCd = 0, impacts = [], flyers = [], comboBanner = null, comboRings = [];
  var COMBO_TIERS = [5, 10, 20, 30, 50];
  function juiceCapture(m, gained) {
    var gold = m.type === "gold", now = elapsedPlayTime;
    if (!reducedMotion && now >= hitStopCd) { hitStopT = gold ? 0.07 : 0.045; hitStopCd = now + 0.22; }
    if (impacts.length > 10) impacts.shift();
    impacts.push({ x: m.x, y: m.y, age: 0, life: gold ? 0.45 : 0.3, gold: gold, rot: Math.random() * 6 });
    if (flyers.length < 12) flyers.push({ sx: worldToScreenX(m.x), sy: worldToScreenY(m.y), age: 0, life: 0.55, gold: gold, amt: gained });
    if (!reducedMotion) { var dx = m.x - cat.x, dy = m.y - cat.y, l = Math.sqrt(dx * dx + dy * dy) || 1, k = gold ? 7 : 3.5; camera.x += dx / l * k; camera.y += dy / l * k; }
    if (COMBO_TIERS.indexOf(combo) >= 0 || (combo > 50 && combo % 25 === 0)) {
      comboBanner = { n: combo, age: 0, life: 1.1, tier: COMBO_TIERS.indexOf(combo) };
      comboRings.push({ age: 0, life: 0.6 }); if (CA.sfx.tier) CA.sfx.tier(combo);
      if (dom.comboText) { dom.comboText.classList.remove("tier-pop"); void dom.comboText.offsetWidth; dom.comboText.classList.add("tier-pop"); }
      if (!reducedMotion) hitStopT = Math.max(hitStopT, 0.06);
    }
  }
  var scoreTarget = { x: 70, y: 32, t: 0 };
  function updateJuice(dt) {
    var i;
    for (i = impacts.length - 1; i >= 0; i--) { impacts[i].age += dt; if (impacts[i].age >= impacts[i].life) impacts.splice(i, 1); }
    for (i = comboRings.length - 1; i >= 0; i--) { comboRings[i].age += dt; if (comboRings[i].age >= comboRings[i].life) comboRings.splice(i, 1); }
    if (comboBanner) { comboBanner.age += dt; if (comboBanner.age >= comboBanner.life) comboBanner = null; }
    scoreTarget.t -= dt;
    if (scoreTarget.t <= 0 && dom.scoreText) { var r = dom.scoreText.getBoundingClientRect(); scoreTarget.x = r.left + 22; scoreTarget.y = r.top + r.height / 2; scoreTarget.t = 1; }
    for (i = flyers.length - 1; i >= 0; i--) {
      var f = flyers[i]; f.age += dt;
      if (f.age >= f.life) { flyers.splice(i, 1); if (dom.scoreText) { dom.scoreText.classList.remove("bump"); void dom.scoreText.offsetWidth; dom.scoreText.classList.add("bump"); } }
    }
  }
  function drawJuice() {
    var i, u = s(1) * entityScaleMult;
    for (i = 0; i < impacts.length; i++) {
      var im = impacts[i], k = im.age / im.life, sx = worldToScreenX(im.x), sy = worldToScreenY(im.y) - s(6), e = 1 - Math.pow(1 - k, 3);
      ctx.save(); ctx.translate(sx, sy); ctx.rotate(im.rot + k * 0.6); ctx.globalAlpha = 1 - k;
      var R = (im.gold ? 46 : 32) * u * (0.4 + e), n = 8;
      ctx.fillStyle = im.gold ? "#fff1a8" : "#fffbe6"; ctx.beginPath();
      for (var j = 0; j < n * 2; j++) { var a = j / (n * 2) * 6.2832, rr = j % 2 ? R * 0.42 : R; ctx.lineTo(Math.cos(a) * rr, Math.sin(a) * rr); }
      ctx.closePath(); ctx.fill();
      ctx.strokeStyle = im.gold ? "#ffb700" : "#ffc76b"; ctx.lineWidth = 2.5 * u * (1 - k); ctx.lineCap = "round";
      for (j = 0; j < 6; j++) { var b = j / 6 * 6.2832 + 0.3; ctx.beginPath(); ctx.moveTo(Math.cos(b) * R * 1.05, Math.sin(b) * R * 1.05); ctx.lineTo(Math.cos(b) * R * 1.5, Math.sin(b) * R * 1.5); ctx.stroke(); }
      ctx.restore();
    }
    ctx.globalAlpha = 1;
    var cx = worldToScreenX(cat.x), cy = worldToScreenY(cat.y);
    for (i = 0; i < comboRings.length; i++) { var cr = comboRings[i], kk = cr.age / cr.life; ctx.strokeStyle = "rgba(255,150,60," + (1 - kk) + ")"; ctx.lineWidth = s(6) * (1 - kk) + 1; ctx.beginPath(); ctx.arc(cx, cy, s(40 + kk * 120) * entityScaleMult, 0, 7); ctx.stroke(); }
    for (i = 0; i < flyers.length; i++) {
      var f = flyers[i], t = f.age / f.life, ee = t * t * (3 - 2 * t), arc = Math.sin(t * Math.PI) * s(60);
      var fx2 = f.sx + (scoreTarget.x - f.sx) * ee, fy2 = f.sy + (scoreTarget.y - f.sy) * ee - arc;
      ctx.globalAlpha = 0.5 + 0.5 * (1 - t);
      ctx.fillStyle = f.gold ? "#ffc400" : "#ffe08a"; ctx.strokeStyle = "#c97a1e"; ctx.lineWidth = s(1.5);
      ctx.beginPath(); ctx.arc(fx2, fy2, s(f.gold ? 8 : 6) * (1 - t * 0.4), 0, 7); ctx.fill(); ctx.stroke();
    }
    ctx.globalAlpha = 1;
    if (comboBanner) {
      var cb = comboBanner, a2 = cb.age, pop = a2 < 0.15 ? 0.5 + a2 / 0.15 * 0.7 : 1.2 - Math.min(0.2, (a2 - 0.15) * 1.5);
      var cols = ["#ff9d4d", "#ff6b6b", "#c86bff", "#4db8ff", "#ffcc00"], col = cols[Math.max(0, Math.min(4, cb.tier < 0 ? 4 : cb.tier))];
      ctx.globalAlpha = a2 > cb.life - 0.3 ? (cb.life - a2) / 0.3 : 1;
      ctx.save(); ctx.translate(W / 2, H * 0.3); ctx.scale(pop, pop); ctx.rotate(-0.05);
      ctx.font = "900 " + Math.round(s(40)) + "px sans-serif"; ctx.textAlign = "center"; ctx.textBaseline = "middle"; ctx.lineJoin = "round";
      ctx.lineWidth = s(8); ctx.strokeStyle = "#fff"; ctx.strokeText("连击 x" + cb.n + "！", 0, 0);
      ctx.fillStyle = col; ctx.fillText("连击 x" + cb.n + "！", 0, 0);
      ctx.font = "800 " + Math.round(s(15)) + "px sans-serif"; ctx.lineWidth = s(5); var sub = ["手感来了", "好厉害", "停不下来", "猫中之王", "传说喵"][Math.max(0, Math.min(4, cb.tier < 0 ? 4 : cb.tier))];
      ctx.strokeText(sub, 0, s(32)); ctx.fillStyle = "#7a4a2a"; ctx.fillText(sub, 0, s(32));
      ctx.restore(); ctx.globalAlpha = 1;
    }
  }

  function spawnCatchParticles(x, y) {
    var pcap = resScale < 1 ? 32 : 60; if (catchParticles.length > pcap) catchParticles.splice(0, catchParticles.length - pcap);
    for (var i = 0; i < 8; i++) {
      var a = Math.random() * Math.PI * 2;
      var sp = 50 + Math.random() * 50;
      catchParticles.push({ x: x, y: y, vx: Math.cos(a) * sp, vy: Math.sin(a) * sp, age: 0, life: 0.5 + Math.random() * 0.2 });
    }
  }

  function updateEffects(dt) {
    var i;
    for (i = scorePopups.length - 1; i >= 0; i--) {
      var p = scorePopups[i];
      p.age += dt;
      p.y -= dt * 30;
      if (p.age >= p.life) scorePopups.splice(i, 1);
    }
    for (i = catchParticles.length - 1; i >= 0; i--) {
      var c = catchParticles[i];
      c.age += dt;
      c.x += c.vx * dt;
      c.y += c.vy * dt;
      if (c.age >= c.life) catchParticles.splice(i, 1);
    }
  }

  // =======================================================================
  // Render
  // =======================================================================

  function roundRectPath(x, y, w, h, r) {
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.arcTo(x + w, y, x + w, y + h, r);
    ctx.arcTo(x + w, y + h, x, y + h, r);
    ctx.arcTo(x, y + h, x, y, r);
    ctx.arcTo(x, y, x + w, y, r);
    ctx.closePath();
  }

  function visibleChunkRange() {
    var halfW = W / (2 * SCALE) + CHUNK_SIZE;
    var halfH = H / (2 * SCALE) + CHUNK_SIZE;
    var topLeft = worldToChunk(camera.x - halfW, camera.y - halfH);
    var bottomRight = worldToChunk(camera.x + halfW, camera.y + halfH);
    return { cx0: topLeft.cx, cy0: topLeft.cy, cx1: bottomRight.cx, cy1: bottomRight.cy };
  }

  function forEachVisibleChunk(fn) {
    var range = visibleChunkRange();
    for (var cy = range.cy0; cy <= range.cy1; cy++) {
      for (var cx = range.cx0; cx <= range.cx1; cx++) {
        var chunk = chunkCache.get(chunkKey(cx, cy));
        if (chunk) fn(chunk);
      }
    }
  }

  // ---- Q版画面（美术见 art.js；只换外观，碰撞半径/位置完全沿用 r） ----
  var ART = window.CatArt;
  var CAT_UNIT_PER_R = 1 / 34;   // 小猫精灵单位→屏幕：r 为碰撞半径（屏幕像素）
  var MOUSE_UNIT_PER_R = 1 / 22;
  var TILE = 48;
  var FLOWER_COLORS = ["#ffffff", "#ffb6d0", "#c9b8ff", "#fff3a0"];
  function hash01(a, b) { var h = Math.sin(a * 12.9898 + b * 78.233) * 43758.5453; return h - Math.floor(h); }
  function quant(v) { return Math.max(0.05, Math.round(v * 50) / 50); }

  // v9：地面棋盘格缓存成离屏 2×2 瓦片 + 平铺 pattern，一次 fillRect 画满全屏
  // v13 A1：手绘感草地（离屏一次性绘制、无缝平铺）+ 大尺度树荫/光斑层打散重复感
  var GRASS_T = 512, DAPPLE_T = 1400, grassCv = null, dappleCv = null, groundPat = null, dapplePat = null;
  function wrapDraw(g, T, x, y, r, fn) { for (var ox = -1; ox <= 1; ox++) for (var oy = -1; oy <= 1; oy++) { var X = x + ox * T, Y = y + oy * T; if (X + r < 0 || X - r > T || Y + r < 0 || Y - r > T) continue; fn(X, Y); } }
  function makeGrass(q) {
    var T = GRASS_T, c = document.createElement("canvas"); c.width = c.height = T * q; var g = c.getContext("2d"), R = mulberry(7), i; g.scale(q, q);
    g.fillStyle = "#a4d986"; g.fillRect(0, 0, T, T);
    var tones = ["#9ad37b", "#b0e190", "#bde89e", "#a6da86", "#c6ecA4", "#a2d781"];
    for (i = 0; i < 260; i++) { var x = R() * T, y = R() * T, r = 18 + R() * 52, col = tones[(R() * tones.length) | 0];
      wrapDraw(g, T, x, y, r, function (X, Y) { var gr = g.createRadialGradient(X, Y, 0, X, Y, r); gr.addColorStop(0, col); gr.addColorStop(1, "rgba(164,217,134,0)"); g.globalAlpha = 0.32; g.fillStyle = gr; g.beginPath(); g.ellipse(X, Y, r, r * 0.7, 0, 0, 7); g.fill(); }); }
    g.globalAlpha = 1; g.lineCap = "round";
    for (i = 0; i < 1500; i++) { var x2 = R() * T, y2 = R() * T, l = 3 + R() * 6, a = -Math.PI / 2 + (R() - 0.5) * 0.9, dark = R() < 0.55;
      g.strokeStyle = dark ? "rgba(80,150,62," + (0.22 + R() * 0.25) + ")" : "rgba(220,250,190," + (0.2 + R() * 0.3) + ")"; g.lineWidth = 1 + R() * 1.2;
      wrapDraw(g, T, x2, y2, l, function (X, Y) { g.beginPath(); g.moveTo(X, Y); g.quadraticCurveTo(X + Math.cos(a) * l * 0.5 + 1.5, Y + Math.sin(a) * l * 0.5, X + Math.cos(a) * l, Y + Math.sin(a) * l); g.stroke(); }); }
    for (i = 0; i < 26; i++) { var x3 = R() * T, y3 = R() * T, cl = R() < 0.5 ? "#7fbf62" : "#d9f5b8";
      wrapDraw(g, T, x3, y3, 6, function (X, Y) { g.fillStyle = cl; for (var q = 0; q < 3; q++) { g.beginPath(); g.arc(X + Math.cos(q * 2.1) * 2.2, Y + Math.sin(q * 2.1) * 2.2, 1.9, 0, 7); g.fill(); } }); }
    return c;
  }
  function makeDapple() {
    var T = DAPPLE_T, c = document.createElement("canvas"); c.width = c.height = T / 4; var g = c.getContext("2d"), R = mulberry(11), k = 0.25;
    for (var i = 0; i < 22; i++) { var x = R() * T, y = R() * T, r = 120 + R() * 220, sh = R() < 0.6;
      wrapDraw(g, T, x, y, r, function (X, Y) { var gr = g.createRadialGradient(X * k, Y * k, 0, X * k, Y * k, r * k); gr.addColorStop(0, sh ? "rgba(40,90,40,0.11)" : "rgba(255,252,210,0.14)"); gr.addColorStop(1, "rgba(0,0,0,0)"); g.fillStyle = gr; g.fillRect(0, 0, T * k, T * k); }); }
    return c;
  }
  function mulberry(a) { return function () { a |= 0; a = a + 0x6D2B79F5 | 0; var t = Math.imul(a ^ a >>> 15, 1 | a); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; }; }
  function drawGround() {
    var q = resScale < 1 ? 0.5 : 2; // 弱设备用低清草地贴图（填充更省）
    if (!grassCv || grassCv._q !== q) { grassCv = makeGrass(q); grassCv._q = q; groundPat = null; if (!dappleCv) dappleCv = makeDapple(); }
    if (!groundPat) { groundPat = ctx.createPattern(grassCv, "repeat"); dapplePat = ctx.createPattern(dappleCv, "repeat"); }
    if (groundPat.setTransform && window.DOMMatrix) {
      var ox = worldToScreenX(0), oy = worldToScreenY(0);
      groundPat.setTransform(new DOMMatrix([SCALE / q, 0, 0, SCALE / q, ox, oy]));
      ctx.fillStyle = groundPat; ctx.fillRect(0, 0, W, H);
      if (resScale >= 1 && dayNow.night < 0.5) { dapplePat.setTransform(new DOMMatrix([SCALE * 4, 0, 0, SCALE * 4, ox, oy])); ctx.fillStyle = dapplePat; ctx.fillRect(0, 0, W, H); }
      return;
    }
    ctx.fillStyle = "#a8de8e";
    ctx.fillRect(0, 0, W, H);
    var wx0 = camera.x - W / (2 * SCALE), wy0 = camera.y - H / (2 * SCALE);
    var i0 = Math.floor(wx0 / TILE), j0 = Math.floor(wy0 / TILE);
    var cols = Math.ceil(W / t) + 2, rows = Math.ceil(H / t) + 2;
    ctx.fillStyle = "#b8e6a0";
    for (var j = 0; j < rows; j++) {
      for (var i = 0; i < cols; i++) {
        if (((i0 + i) + (j0 + j)) & 1) {
          var sx = worldToScreenX((i0 + i) * TILE), sy = worldToScreenY((j0 + j) * TILE);
          ctx.fillRect(Math.floor(sx), Math.floor(sy), Math.ceil(t), Math.ceil(t));
        }
      }
    }
  }

  // v17 地形瓦片（离屏缓存；每帧最多预取 1 张）
  var terrImgsReady = false;
  function drawTerrain() {
    if (!TERR) return;
    if (!terrImgsReady && IMG.rock && IMG.bush && IMG.bridge && IMG.ford) { terrImgsReady = true; TERR.clear(); }
    var T = TERR.TILE, hw = W / (2 * SCALE), hh = H / (2 * SCALE), p = SCALE * DPR;
    var i0 = Math.floor((camera.x - hw) / T), i1 = Math.floor((camera.x + hw) / T), j0 = Math.floor((camera.y - hh) / T), j1 = Math.floor((camera.y + hh) / T);
    var imgs = terrImgsReady ? { rock: IMG.rock, bush: IMG.bush, bridge: IMG.bridge, ford: IMG.ford } : null, bg = tileGrassBg;
    for (var j = j0; j <= j1; j++) for (var i = i0; i <= i1; i++) {
      var c = TERR.getTile(i, j, p, imgs, bg); if (!c) continue;
      var sx = Math.floor(worldToScreenX(i * T)), sy = Math.floor(worldToScreenY(j * T)), sz = Math.ceil(T * SCALE) + 1;
      ctx.drawImage(c, sx, sy, sz, sz);
    }
    var pi = Math.floor((camera.x + (moveDir.x || 0) * (hw + T * 0.5)) / T), pj = Math.floor((camera.y + (moveDir.y || 0) * (hh + T * 0.5)) / T), done = false;
    for (var dj = -1; dj <= 1 && !done; dj++) for (var di = -1; di <= 1 && !done; di++) if (!TERR.has(pi + di, pj + dj, p)) { TERR.getTile(pi + di, pj + dj, p, imgs, bg); done = true; }
    if (resScale >= 1 && dayNow.night < 0.3 && !reducedMotion) { // 水面波光（弱设备 / 夜晚 关闭）
      var P = TERR.PTS, t = elapsedPlayTime || 0, any = false; ctx.strokeStyle = "rgba(255,255,255,0.5)"; ctx.lineWidth = Math.max(1, 2.2 * SCALE); ctx.lineCap = "round"; ctx.beginPath();
      for (var k = 1; k < P.length - 1; k += 2) { var x = P[k][0], y = P[k][1]; if (x < camera.x - hw - 80 || x > camera.x + hw + 80 || y < camera.y - hh - 80 || y > camera.y + hh + 80) continue;
        var q = P[k + 1], L = Math.hypot(q[0] - x, q[1] - y) || 1, tx = (q[0] - x) / L, ty = (q[1] - y) / L, hwk = TERR.hwAt(k);
        if (TERR.inCross(x, y, -40)) continue;
        for (var m = 0; m < 2; m++) { var ph = (t * 0.35 + k * 0.37 + m * 0.5) % 1, off = Math.sin(k * 1.7 + m * 2.3) * hwk * 0.55, along = (ph - 0.5) * L * 1.6;
          var ax = x + tx * along - ty * off, ay = y + ty * along + tx * off; ctx.moveTo(worldToScreenX(ax), worldToScreenY(ay)); ctx.lineTo(worldToScreenX(ax + tx * 14), worldToScreenY(ay + ty * 14)); any = true; } }
      if (any) ctx.stroke();
    }
  }
  // 草地底图烘焙进地形瓦片（与 drawGround 同样的贴图/对齐）
  var tileGrassCv = null, tileDapple = null;
  function tileGrassBg(g, x0, y0, T) {
    if (!tileGrassCv) { tileGrassCv = makeGrass(2); tileDapple = makeDapple(); }
    var pat = g.createPattern(tileGrassCv, "repeat"); if (pat.setTransform && window.DOMMatrix) pat.setTransform(new DOMMatrix([0.5, 0, 0, 0.5, 0, 0]));
    g.fillStyle = pat; g.fillRect(x0, y0, T, T);
    var dp = g.createPattern(tileDapple, "repeat"); if (dp.setTransform && window.DOMMatrix) { dp.setTransform(new DOMMatrix([4, 0, 0, 4, 0, 0])); g.fillStyle = dp; g.fillRect(x0, y0, T, T); }
  }
  function drawBackground() {
    if (!TERR || !window.DOMMatrix) drawGround();
    drawTerrain();
    forEachVisibleChunk(function (chunk) {
      for (var i = 0; i < chunk.decor.length; i++) drawDecor(chunk.decor[i]);
    });
  }

  var DECOR_IMG = { bed: ["flowerbed", 150], stones: ["stones", 64], tuft: ["grass", 46] };
  function drawDecor(d) {
    var sx = worldToScreenX(d.x), sy = worldToScreenY(d.y);
    var di = DECOR_IMG[d.kind];
    if (di) { var im = IMG[di[0]]; if (!im) return; var w = di[1] * d.scale * SCALE, h = w * im.height / im.width; if (sx < -w || sx > W + w || sy < -h || sy > H + h) return; ctx.drawImage(fit(im, h), sx - w / 2, sy - h * 0.8, w, h); return; }
    if (sx < -40 || sx > W + 40 || sy < -40 || sy > H + 40) return;
    var h = hash01(d.x, d.y);
    ctx.save();
    ctx.translate(sx, sy);
    var k = d.scale * SCALE;
    ctx.scale(k, k);
    if (d.kind === "grass") {
      ctx.fillStyle = "#86c96a";
      for (var q = -1; q <= 1; q++) {
        ctx.beginPath(); ctx.ellipse(q * 5, -4, 3.2, 7.5, q * 0.4, 0, Math.PI * 2); ctx.fill();
      }
    } else if (d.kind === "flower") {
      var col = FLOWER_COLORS[Math.floor(h * FLOWER_COLORS.length)];
      for (var p = 0; p < 5; p++) {
        var a = p * 1.2566 + d.rot;
        ART.ellipse(ctx, Math.cos(a) * 4.5, Math.sin(a) * 4.5, 3.8, 3.8, col);
      }
      ART.ellipse(ctx, 0, 0, 3, 3, "#ffd84d");
    } else if (h < 0.3) {
      // 奶酪块
      ctx.rotate(d.rot * 0.3);
      ctx.fillStyle = "#ffd34d"; ctx.strokeStyle = "#e0a526"; ctx.lineWidth = 2; ctx.lineJoin = "round";
      ctx.beginPath(); ctx.moveTo(-11, 6); ctx.lineTo(11, 6); ctx.lineTo(11, -2); ctx.lineTo(-11, -6); ctx.closePath();
      ctx.fill(); ctx.stroke();
      ART.ellipse(ctx, -4, 1, 2, 2, "#f2b630"); ART.ellipse(ctx, 5, -0.5, 2.4, 1.8, "#f2b630");
    } else if (h < 0.55) {
      // 毛线球
      ART.ellipse(ctx, 0, 0, 9, 9, "#ff9cc2", "#e46f9c", 2);
      ctx.strokeStyle = "#ffd0e2"; ctx.lineWidth = 1.4;
      for (var y = -1; y <= 1; y++) { ctx.beginPath(); ctx.arc(y * 3.5, -13, 12, 1.15, 2.0); ctx.stroke(); }
      ctx.strokeStyle = "#e46f9c"; ctx.lineWidth = 1.6;
      ctx.beginPath(); ctx.moveTo(8, 4); ctx.quadraticCurveTo(18, 11, 24, 4); ctx.stroke();
    } else {
      // 圆石子
      ART.ellipse(ctx, 0, 0, 5, 3.6, "rgba(255,255,255,0.55)");
      ART.ellipse(ctx, -1.5, -1, 1.6, 1, "rgba(255,255,255,0.8)");
    }
    ctx.restore();
  }

  // 树冠画在小猫/老鼠之上；小猫走到树冠下时树变半透明，不挡视线
  function drawTrees() {
    var csx = worldToScreenX(cat.x), csy = worldToScreenY(cat.y);
    forEachVisibleChunk(function (chunk) {
      for (var i = 0; i < chunk.obstacles.length; i++) {
        var o = chunk.obstacles[i]; if (o.kind !== "tree") continue;
        var im = IMG[o.fruit ? "tree_fruit" : "tree"]; if (!im) continue;
        var ts = SCALE * o.sc, w = 170 * ts, h = w * im.height / im.width, bx = worldToScreenX(o.tx), by = worldToScreenY(o.ty) + 8 * ts;
        if (bx + w / 2 < 0 || bx - w / 2 > W || by < 0 || by - h > H) continue;
        var under = Math.abs(csx - bx) < w * 0.45 && csy < by - 10 * ts && csy > by - h;
        ctx.globalAlpha = under ? 0.42 : 1; ctx.drawImage(fit(im, h), bx - w / 2, by - h, w, h); ctx.globalAlpha = 1;
      }
    });
  }
  function drawObstacles() {
    forEachVisibleChunk(function (chunk) {
      for (var i = 0; i < chunk.obstacles.length; i++) drawObstacle(chunk.obstacles[i]);
    });
  }

  function drawObstacle(o) {
    var sx = worldToScreenX(o.x), sy = worldToScreenY(o.y);
    var sw = o.w * SCALE, sh = o.h * SCALE;
    if (sx + sw < -20 || sx > W + 20 || sy + sh < -20 || sy > H + 20) return;
    var cx = sx + sw / 2, cy = sy + sh / 2;
    if (o.kind === "tree") { var ts = SCALE * o.sc; if (resScale < 1 && dayNow.night > 0.5) return; shadow(worldToScreenX(o.tx) + 34 * ts, worldToScreenY(o.ty) - 4 * ts, 90 * ts); return; }
    var oim = IMG[o.kind];
    if (oim) { shadow(cx + sw * 0.05, sy + sh * 0.95, sw * 0.6); var ow2 = sw * (o.kind === "crate" ? 1.15 : 1.35), oh2 = ow2 * oim.height / oim.width; ctx.drawImage(fit(oim, oh2), cx - ow2 / 2, sy + sh * 1.02 - oh2, ow2, oh2); return; }
    ctx.save();
    ART.ellipse(ctx, cx, sy + sh * 0.96, sw * 0.52, sh * 0.12, "rgba(40,90,30,0.18)");
    if (o.kind === "crate") {
      ctx.fillStyle = "#e8b77a";
      roundRectPath(sx, sy, sw, sh, Math.min(sw, sh) * 0.2);
      ctx.fill();
      ctx.strokeStyle = "#b9824a"; ctx.lineWidth = Math.max(2, sw * 0.05);
      ctx.stroke();
      ctx.lineCap = "round";
      ctx.beginPath();
      ctx.moveTo(sx + sw * 0.18, sy + sh * 0.5); ctx.lineTo(sx + sw * 0.82, sy + sh * 0.5);
      ctx.stroke();
      ctx.fillStyle = "rgba(255,255,255,0.35)";
      roundRectPath(sx + sw * 0.12, sy + sh * 0.1, sw * 0.4, sh * 0.14, sh * 0.07); ctx.fill();
      ART.ellipse(ctx, sx + sw * 0.82, sy + sh * 0.2, sw * 0.05, sw * 0.05, "#b9824a");
    } else if (o.kind === "bush") {
      var r = Math.min(sw, sh) / 2;
      ART.ellipse(ctx, sx + sw * 0.28, sy + sh * 0.62, r * 0.75, r * 0.68, "#6cc05a");
      ART.ellipse(ctx, sx + sw * 0.72, sy + sh * 0.62, r * 0.75, r * 0.68, "#6cc05a");
      ART.ellipse(ctx, cx, sy + sh * 0.4, r * 0.88, r * 0.8, "#7fd06a");
      ART.ellipse(ctx, cx - r * 0.3, sy + sh * 0.25, r * 0.25, r * 0.16, "rgba(255,255,255,0.35)");
      ART.ellipse(ctx, cx + r * 0.4, sy + sh * 0.55, r * 0.1, r * 0.1, "#ff7b8a");
      ART.ellipse(ctx, cx - r * 0.5, sy + sh * 0.7, r * 0.1, r * 0.1, "#ff7b8a");
    } else {
      ctx.fillStyle = "#b9b7c4";
      roundRectPath(sx, sy, sw, sh, Math.min(sw, sh) * 0.45);
      ctx.fill();
      ctx.strokeStyle = "#8f8c9e"; ctx.lineWidth = Math.max(2, sw * 0.05); ctx.stroke();
      ART.ellipse(ctx, sx + sw * 0.34, sy + sh * 0.3, sw * 0.16, sh * 0.09, "rgba(255,255,255,0.5)");
    }
    ctx.restore();
  }

  // ---- 分方向动画（anim.js 精灵；只影响画面）----
  var ANIM = window.CatAnim;
  var SPRITE_DPR_CAP = 2;
  var RUN_SPEED_CAT = 12, RUN_SPEED_MOUSE = 4;
  var SIT_DELAY = 0.25, SIT_DOWN_T = 0.16, STAND_UP_T = 0.12, GULP_T = 0.45;
  var dustPuffs = [];
  var gulp = null; // { t, dir, type }

  function newAnim() { return { mode: "sit", t: 0, still: 1, dir: 2, phase: Math.random() * 3, lastRunFrame: -1, dustT: 0 }; }
  var catAnim = newAnim();

  function stepAnim(a, dt, moving, angle) {
    a.t += dt;
    if (moving) {
      a.dir = ANIM.dirOf(angle);
      a.still = 0;
      if (a.mode === "sit" || a.mode === "sitdown") { a.mode = "stand"; a.t = 0; }
      else if (a.mode === "stand" && a.t >= STAND_UP_T) { a.mode = "run"; a.t = 0; }
    } else {
      a.still += dt;
      if ((a.mode === "run" || a.mode === "stand") && a.still > SIT_DELAY) { a.mode = "sitdown"; a.t = 0; }
      else if (a.mode === "sitdown" && a.t >= SIT_DOWN_T) { a.mode = "sit"; a.t = 0; }
    }
  }
  // 返回 [state, frame]
  var CAT_SIT_SCHED = [[1.2, 2], [1.45, 3], [2.0, 2], [2.3, 4], [2.6, 2], [3.2, 5]];
  var MOUSE_SIT_SCHED = [[0.6, 2], [0.8, 3], [1.1, 2], [1.3, 4], [1.6, 2], [1.9, 5], [2.0, 2]];
  function sitFrame(t, sched) {
    var len = sched[sched.length - 1][0], u = t % len;
    for (var i = 0; i < sched.length; i++) if (u < sched[i][0]) return sched[i][1];
    return 2;
  }
  function animFrame(a, runCycle, sched) {
    if (a.mode === "run") return ["run", Math.floor(runCycle) % 4];
    if (a.mode === "sitdown") return ["sit", a.t < SIT_DOWN_T / 2 ? 0 : 1];
    if (a.mode === "stand") return ["sit", a.t < STAND_UP_T / 2 ? 1 : 0];
    return ["sit", sitFrame(a.t + a.phase, sched)];
  }

  function spawnDust(wx, wy, angle, size) {
    if (dustPuffs.length > 40) dustPuffs.shift();
    dustPuffs.push({ x: wx - Math.cos(angle) * size * 0.8 + (Math.random() - 0.5) * size * 0.4,
      y: wy + size * 0.7, age: 0, life: 0.45, s: size * (0.35 + Math.random() * 0.15) });
  }

  function updateAnims(dt) {
    var catSpeed = Math.sqrt(cat.vx * cat.vx + cat.vy * cat.vy);
    stepAnim(catAnim, dt, catSpeed > RUN_SPEED_CAT, cat.facing);
    if (catAnim.mode === "run") {
      var f = Math.floor(cat.runCycle) % 4;
      if (f !== catAnim.lastRunFrame && (f === 3 || f === 1)) spawnDust(cat.x, cat.y, cat.facing, cat.r);
      catAnim.lastRunFrame = f;
    }
    for (var i = 0; i < mice.length; i++) {
      var m = mice[i];
      if (!m.anim) m.anim = newAnim();
      var sp = Math.abs(m.vx) + Math.abs(m.vy);
      stepAnim(m.anim, dt, sp > RUN_SPEED_MOUSE, m.facing);
      if (m.anim.mode === "run" && m.lodFull) {
        m.anim.dustT += dt;
        if (m.anim.dustT > 0.22) { m.anim.dustT = 0; spawnDust(m.x, m.y, m.facing, m.r * 0.8); }
      }
    }
    for (i = dustPuffs.length - 1; i >= 0; i--) {
      dustPuffs[i].age += dt;
      if (dustPuffs[i].age >= dustPuffs[i].life) dustPuffs.splice(i, 1);
    }
    if (gulp) { gulp.t += dt; if (gulp.t >= GULP_T) gulp = null; }
  }

  function gulpState() { return gulp; }
  function startGulp(m) {
    gulp = { t: 0, dir: catAnim.dir, type: m.type };
  }

  function spritePx(u) { return quant(u * Math.min(DPR, SPRITE_DPR_CAP)); }

  // (x, y) = 精灵单位原点（实体中心）的屏幕坐标；g = 缩放锚点（脚底）相对原点的单位偏移
  function blit(spr, x, y, u, flip, sx, sy, g) {
    g = g || 0;
    ctx.save();
    ctx.translate(x, y + g * u);
    ctx.scale(flip * u / spr.px * (sx || 1), u / spr.px * (sy || 1));
    ctx.drawImage(spr.cv, -spr.ox * spr.px + (spr.dx || 0), -(spr.oy + g) * spr.px + (spr.dy || 0));
    ctx.restore();
  }

  // v13 A3：柔和接触阴影（径向渐变缓存），统一光源在左上 → 影子略偏右下
  var shadowCv = null;
  function shadowSprite() { if (shadowCv) return shadowCv; var c = document.createElement("canvas"); c.width = 128; c.height = 40; var g = c.getContext("2d"); g.translate(64, 20); g.scale(1, 0.3125); var gr = g.createRadialGradient(0, 0, 0, 0, 0, 62); gr.addColorStop(0, "rgba(30,70,25,0.42)"); gr.addColorStop(0.55, "rgba(30,70,25,0.24)"); gr.addColorStop(1, "rgba(30,70,25,0)"); g.fillStyle = gr; g.beginPath(); g.arc(0, 0, 62, 0, 7); g.fill(); return (shadowCv = c); }
  function shadow(x, y, rx) {
    var w = rx * 2.5; ctx.drawImage(shadowSprite(), x - w / 2, y - w * 0.156, w, w * 0.3125);
  }

  function drawDust() {
    for (var i = 0; i < dustPuffs.length; i++) {
      var d = dustPuffs[i];
      var k = d.age / d.life;
      var sx = worldToScreenX(d.x), sy = worldToScreenY(d.y) - k * s(6);
      var r = s(d.s) * (0.7 + k * 0.8);
      ctx.globalAlpha = (1 - k) * 0.85;
      ART.ellipse(ctx, sx, sy, r, r * 0.75, "#f3ead6", "rgba(200,180,140,0.6)", 1.2);
    }
    ctx.globalAlpha = 1;
  }

  // 被吞老鼠：F0-F2 从嘴前方缩小飞入；背面视图画在小猫身后
  var GULP_MOUTH = { front: [0, 6], q34: [14, 6], side: [44, -8], b34: [20, -30], back: [0, -34] };
  function drawGulpMouse(x, y, u, view, flip, behind) {
    if (!gulp) return;
    var isBack = ANIM.isBack(view);
    if (behind !== isBack) return;
    var k = gulp.t / (GULP_T * 0.45);
    if (k >= 1) return;
    var mp = GULP_MOUTH[view];
    var start = isBack ? [mp[0], mp[1] - 40] : (view === "side" ? [mp[0] + 30, mp[1]] : [mp[0] + (view === "q34" ? 20 : 0), mp[1] + 40]);
    var px = start[0] + (mp[0] - start[0]) * k, py = start[1] + (mp[1] - start[1]) * k;
    var mu = u * 0.55 * (1 - k * 0.8);
    ctx.globalAlpha = isBack ? 1 - k * 0.7 : 1;
    if (!paintedMouse(gulp.type, x + px * u * flip, y + py * u, mu, isBack ? "back" : "front", flip, ["sit", 2], 0)) blit(ANIM.mouseSprite(gulp.type, isBack ? "back" : "front", "sit", 2, spritePx(mu)), x + px * u * flip, y + py * u, mu, flip);
    ctx.globalAlpha = 1;
  }

  // v13 A2：橘子改用手绘精灵（img/orange_*.png，正面/侧面/背面 3 张），动作用弹跳 + 挤压拉伸做；其它 5 只猫暂保留原画
  // v14：全部角色/道具改为手绘精灵（img/*.webp，AI 生成后抠图；约 400KB）。加载完成前回退到原来的程序绘制
  var IMG = {}, IMG_LIST = [];
  ["orange", "black", "white", "calico", "blue", "siamese"].forEach(function (k) { IMG_LIST.push(k + "_front", k + "_side", k + "_back"); });
  ["grey", "brown", "gold"].forEach(function (k) { IMG_LIST.push("m_" + k + "_front", "m_" + k + "_side", "m_" + k + "_back"); });
  IMG_LIST.push("bridge", "ford", "nest", "nest_dead", "poop", "crate", "bush", "rock", "tree", "tree_fruit", "flowerbed", "stones", "fence", "grass");
  var imgLoaded = 0;
  // v15：跑步帧按需加载（只加载当前选中的猫），并测量每帧最低爪子到帧底的距离 → 把爪子钉在地面线上
  var runReq = {}, FOOT = {};
  function footScan(k, im, n) {
    try { var c = document.createElement("canvas"); c.width = im.width; c.height = im.height; var g = c.getContext("2d"); g.drawImage(im, 0, 0);
      var d = g.getImageData(0, 0, im.width, im.height).data, fw = Math.floor(im.width / n), gaps = [], tops = [];
      for (var i = 0; i < n; i++) { var lo = -1, hi = -1;
        for (var y = im.height - 1; y >= 0 && lo < 0; y--) for (var x = i * fw; x < (i + 1) * fw; x += 2) if (d[(y * im.width + x) * 4 + 3] > 60) { lo = y; break; }
        for (y = 0; y < im.height && hi < 0; y++) for (x = i * fw; x < (i + 1) * fw; x += 2) if (d[(y * im.width + x) * 4 + 3] > 60) { hi = y; break; }
        gaps.push((im.height - 1 - lo) / im.height); tops.push(hi / im.height); }
      FOOT[k] = { gap: gaps, top: tops };
    } catch (e) { FOOT[k] = null; }
  }
  function loadRun(skin) {
    if (runReq[skin]) return; runReq[skin] = 1;
    [["side", 9], ["front", 8], ["back", 8]].forEach(function (p) { var k = skin + "_run_" + p[0], im = new Image();
      im.onload = function () { footScan(k, im, p[1]); im._n = k; IMG[k] = im; }; im.src = "img/" + k + ".webp?v=" + (window.CAT_BUILD && window.CAT_BUILD.sha || "1"); });
  }
  IMG_LIST.forEach(function (k) { var im = new Image(); im.decoding = "async"; im.onload = function () { im._n = k; IMG[k] = im; imgLoaded++; if (/_front$/.test(k)) setTimeout(function () { try { paintSkinCards(); } catch (e) {} }, 0); }; im.src = "img/" + k + ".webp?v=" + (window.CAT_BUILD && window.CAT_BUILD.sha || "1"); });
  // 预缩放缓存：按屏幕像素高度（量化到 ~3%）把精灵缩放一次，之后每帧近似 1:1 贴图（比每帧缩放大图快很多）
  var fitCache = new Map();
  function fit(im, hCss) {
    var hp = Math.max(4, hCss * DPR), q = Math.round(Math.log(hp) / 0.03), key = im._n + "|" + q, c = fitCache.get(key);
    if (!c) { if (fitCache.size > 400) fitCache.clear(); var h = Math.round(Math.exp(q * 0.03)), w = Math.max(1, Math.round(h * im.width / im.height)); c = document.createElement("canvas"); c.width = w; c.height = h; var g = c.getContext("2d"); g.imageSmoothingQuality = "high"; g.drawImage(im, 0, 0, w, h); fitCache.set(key, c); }
    return c;
  }
  function catImgs(skin) { var f = IMG[skin + "_front"], sd = IMG[skin + "_side"], b = IMG[skin + "_back"]; return f && sd && b ? { front: f, side: sd, back: b } : null; }
  // v14 跑步：每个方向 8 帧真实步态（腿交替摆动、身体起伏、尾巴甩、头部轻晃；img/*_run_*.webp，由手绘原图分层绑定后逐帧生成）
  // 侧面第 9 帧为飞扑；起跑/停下用跑步第 1 帧过渡到坐姿
  var RUN_N = { side: 9, front: 8, back: 8 }, paintPounce = false;
  function runFrameDraw(strip, n, f, x, y, H, flipX, extraRot) {
    var fw = strip.width / n, Wd = H * fw / strip.height, c = fitStrip(strip, H);
    var cw = c.width / n;
    ctx.save(); ctx.translate(x, y); if (extraRot) ctx.rotate(extraRot); ctx.scale(flipX, 1);
    ctx.drawImage(c, f * cw, 0, cw, c.height, -Wd / 2, -H, Wd, H); ctx.restore();
  }
  function fitStrip(im, hCss) { return fit(im, hCss); }
  var paintGait = null, paintSquash = 0;
  // 接触阴影：贴在脚线上、更小更深；身体抬起时变小变淡（另有一层很淡的环境阴影）
  function contactShadow(x, foot, H, lift, air) {
    var k = 1 - Math.min(0.35, lift * 3) - (air ? 0.25 : 0), rx = H * 0.30 * k;
    ctx.drawImage(shadowSprite(), x - rx * 1.6, foot - rx * 0.32, rx * 3.2, rx * 0.64);
    ctx.globalAlpha = 0.55 * k; ctx.drawImage(shadowSprite(), x - rx * 0.95, foot - rx * 0.17, rx * 1.9, rx * 0.34); ctx.globalAlpha = 1;
  }
  function paintedCat(x, y, u, view, flip, st, breathe, runCycle, skin, a) {
    var PAINTED = catImgs(skin); if (!PAINTED) return false;
    var back = view === "back" || view === "b34";
    var dir = back ? "back" : view === "side" ? "side" : "front", strip = IMG[skin + "_run_" + dir];
    loadRun(skin);
    var mode = a ? a.mode : (st[0] === "run" ? "run" : "sit"), gul = st[0] === "gulp", foot = y + 46 * u;
    if (strip && (mode === "run" || mode === "stand" || mode === "sitdown" || paintPounce) && !gul) {
      var H = (dir === "side" ? 92 : 96) * u, f;
      if (paintPounce) f = dir === "side" ? 8 : 3;
      else if (mode === "run") f = paintGait != null ? Math.floor(paintGait * 8 + 800) % 8 : Math.floor(runCycle * 2.4 / (Math.PI * 2) * 8 + 800) % 8;
      else f = 0;
      // 钉脚：帧底到最低爪子的空隙下移抵消，最低爪子正好落在地面线；身体起伏只体现在帧内（脚不动、身体动）
      var fi = FOOT[skin + "_run_" + dir], gap = fi ? fi.gap[f] : 0, lift = fi ? fi.top[f] - Math.min.apply(null, fi.top) : 0;
      if (paintPounce) gap = Math.max(0, gap - 0.05); // 飞扑帧离地一点
      contactShadow(x, foot, H, lift, paintPounce);
      var sq = mode === "stand" || mode === "sitdown" ? 0.05 : 0;
      if (paintSquash > 0.05) sq = paintSquash * 0.16; // 扑击落地挤压
      if (sq) { ctx.save(); ctx.translate(x, foot); ctx.scale(1 + sq * 0.6, 1 - sq); ctx.translate(-x, -foot); }
      runFrameDraw(strip, RUN_N[dir], f, x, foot + gap * H, H, dir === "side" ? flip : dir === "front" ? -flip : flip, paintPounce && dir === "side" ? -0.12 * flip : 0);
      if (sq) ctx.restore();
      return true;
    }
    var key = back ? "back" : "front", im = PAINTED[key];
    var H2 = 98 * u, Wd = H2 * im.width / im.height, sx = 1, sy = 1;
    if (gul) { sy = [1, 0.9, 1.08, 0.95, 1][st[1]] || 1; sx = 2 - sy; }
    else { sx = 1 - breathe * 0.5; sy = 1 + breathe; }
    contactShadow(x, foot, H2 * 0.9, 0, false);
    ctx.save(); ctx.translate(x, foot); ctx.scale(sx, sy);
    ctx.drawImage(fit(im, H2), -Wd / 2, -H2, Wd, H2); ctx.restore();
    return true;
  }
  function paintedMouse(type, x, y, u, view, flip, st, runCycle, alphaK) {
    var t = type === "brown" ? "brown" : type === "gold" ? "gold" : "grey", run = st[0] === "run", back = view === "back" || view === "b34";
    var key = back ? "back" : (run && (view === "side" || view === "q34")) ? "side" : (run && view === "front") ? "front" : (view === "side" || view === "q34") ? "side" : "front";
    var im = IMG["m_" + t + "_" + key]; if (!im) return false;
    var H = (key === "side" ? 34 : 46) * u, Wd = H * im.width / im.height, bob = 0, sy = 1;
    if (run) { var ph = runCycle * 3; bob = Math.abs(Math.sin(ph)) * 1.2 * u; sy = 1 - Math.cos(ph * 2) * 0.05; } // v15：只轻微起伏，脚贴地
    ctx.save(); ctx.translate(x, y + 24 * u - bob); ctx.scale((key === "side" ? flip : 1) * (2 - sy), sy);
    ctx.drawImage(fit(im, H), -Wd / 2, -H, Wd, H); ctx.restore(); return true;
  }
  // ==== v13 B4 每局 3 个小任务（只给星星，不影响分数）+ B7 小鱼干（仅本地）& 帽子小铺 ====
  var MISSION_POOL = [
    { id: "c30", t: "抓住 30 只老鼠", n: 30, v: function () { return catches; } },
    { id: "c60", t: "抓住 60 只老鼠", n: 60, v: function () { return catches; } },
    { id: "g2", t: "抓住 2 只金老鼠", n: 2, v: function () { return catchesGold; } },
    { id: "b8", t: "抓住 8 只棕老鼠", n: 8, v: function () { return catchesBrown; } },
    { id: "k10", t: "打出 10 连击", n: 10, v: function () { return comboMax; } },
    { id: "k20", t: "打出 20 连击", n: 20, v: function () { return comboMax; } },
    { id: "n1", t: "拆掉 1 个老鼠窝", n: 1, v: function () { return nestStats.destroyed; } },
    { id: "night", t: "坚持到夜晚", n: 1, v: function () { return dayNow.night > 0.5 ? 1 : 0; } }
  ];
  var missions = [], missionEl = null;
  function lsNum(k) { var v = parseInt(storageGet(k, "0"), 10); return isFinite(v) ? v : 0; }
  function missionsInit() {
    var pool = MISSION_POOL.slice(), pick = [];
    while (pick.length < 3 && pool.length) { var m = pool.splice((Math.random() * pool.length) | 0, 1)[0]; if (pick.some(function (p) { return p.id.charAt(0) === m.id.charAt(0); })) continue; pick.push(m); }
    missions = pick.map(function (m) { return { m: m, done: false, p: 0 }; });
    if (!missionEl) { missionEl = document.createElement("div"); missionEl.id = "missionChip"; missionEl.className = "hud-pill small mission-chip"; var row = document.querySelector("#hudLeft .hud-row"); if (row && row.parentNode) row.parentNode.insertBefore(missionEl, row.nextSibling); }
    missionEl._k = "";
  }
  function missionsUpdate() {
    if (!missions.length) return;
    var cur = null, ndone = 0;
    for (var i = 0; i < missions.length; i++) { var q = missions[i]; q.p = Math.min(q.m.n, q.m.v());
      if (!q.done && q.p >= q.m.n) { q.done = true; showEvoBanner("⭐ 任务完成！", q.m.t); if (CA.sfx.tier) CA.sfx.tier(5); }
      if (q.done) ndone++; else if (!cur) cur = q; }
    if (!missionEl) return;
    var txt = cur ? "🎯 " + cur.m.t + " " + cur.p + "/" + cur.m.n + " · ⭐" + ndone + "/3" : "🌟 本局任务全部完成！";
    if (missionEl._k !== txt) { missionEl._k = txt; missionEl.textContent = txt; missionEl.classList.toggle("all", !cur); }
  }
  function missionsResult() {
    missionsUpdate();
    var stars = missions.filter(function (q) { return q.done; }).length, fish = Math.floor(score / 25) + stars * 10;
    storageSet("catmouse_fish", String(lsNum("catmouse_fish") + fish)); storageSet("catmouse_stars", String(lsNum("catmouse_stars") + stars));
    var box = document.getElementById("resultMissions");
    if (!box) { box = document.createElement("div"); box.id = "resultMissions"; box.className = "result-missions"; var st = document.querySelector("#resultScreen .result-stats"); st.parentNode.insertBefore(box, st.nextSibling); }
    box.innerHTML = "";
    var h = document.createElement("div"); h.className = "rm-head"; h.textContent = "本局任务 " + "★".repeat(stars) + "☆".repeat(3 - stars); box.appendChild(h);
    missions.forEach(function (q) { var d = document.createElement("div"); d.className = "rm-row" + (q.done ? " ok" : ""); d.textContent = (q.done ? "✅ " : "⬜ ") + q.m.t + "（" + q.p + "/" + q.m.n + "）"; box.appendChild(d); });
    var r = document.createElement("div"); r.className = "rm-reward"; r.textContent = "🐟 获得小鱼干 +" + fish + "（共 " + lsNum("catmouse_fish") + "）· 可在首页「小铺」换帽子"; box.appendChild(r);
    updateShopBtn();
  }
  var HATS = [
    { id: "bow", e: "🎀", name: "蝴蝶结", cost: 60 }, { id: "straw", e: "👒", name: "小草帽", cost: 120 }, { id: "cap", e: "🧢", name: "棒球帽", cost: 150 },
    { id: "top", e: "🎩", name: "魔术礼帽", cost: 200 }, { id: "crown", e: "👑", name: "小皇冠", cost: 320 }
  ];
  function hatsOwned() { try { return JSON.parse(storageGet("catmouse_hats", "[]")) || []; } catch (e) { return []; } }
  var hatCache;
  function hatOn() { if (hatCache !== undefined) return hatCache; hatCache = null; var h = storageGet("catmouse_hat", ""); for (var i = 0; i < HATS.length; i++) if (HATS[i].id === h) hatCache = HATS[i]; return hatCache; }
  function drawHat(x, y, r, a) {
    var h = hatOn(); if (!h) return;
    var u = r * CAT_UNIT_PER_R, d = ANIM.DIR8[a.dir], view = d[0], flip = d[1], run = a.mode === "run";
    var hx = x + (view === "side" ? 14 * flip : view === "q34" ? 6 * flip : 0) * u, hy = y - (run && view === "side" ? 36 : 48) * u;
    if (run && !reducedMotion) hy -= Math.abs(Math.sin(cat.runCycle * 2.4)) * 7 * u;
    emojiQuick(h.e, hx, hy, 30 * u);
  }
  function updateShopBtn() { var b = document.getElementById("shopBtn"); if (b) b.textContent = "🛍️ 小铺 · 🐟" + lsNum("catmouse_fish"); }
  // ---- 守卫战 M3：轻天赋树（每点 ≤5%）+ 轻图鉴（本地）----
  var TALENTS = [
    { id: "swift", e: "🐾", name: "轻步", desc: "移速 +4%/点" },
    { id: "greed", e: "🐟", name: "贪吃", desc: "经验 +5%/点" },
    { id: "dash", e: "💨", name: "疾冲", desc: "冲刺冷却 −4%/点" },
    { id: "magnet", e: "🧲", name: "嗅觉", desc: "拾取范围 +5%/点" },
    { id: "claw", e: "🗡️", name: "快爪", desc: "自动扑击冷却 −4%/点" }
  ];
  var TALENT_MAX = 3;
  function talentsGet() { try { var o = JSON.parse(storageGet("catmouse_talents", "{}")); return o && typeof o === "object" ? o : {}; } catch (e) { return {}; } }
  function talLv(id) { var v = talentsGet()[id] | 0; return Math.max(0, Math.min(TALENT_MAX, v)); }
  function talentCost(lv) { return 40 * (lv + 1); }
  var BEST_ENTRIES = [
    { id: "grey", e: "🐭", name: "灰鼠", desc: "最常见，成群出没。" },
    { id: "brown", e: "🐀", name: "褐鼠", desc: "更结实，经验 ×3。" },
    { id: "gold", e: "👑", name: "金冠鼠", desc: "稀有，经验 ×8。" },
    { id: "mutant", e: "🧪", name: "变异鼠", desc: "夜里多，会咬人，需多次攻击。" },
    { id: "thief", e: "🎒", name: "偷鱼鼠", desc: "偷走地上的小鱼，打倒它就还回来。" },
    { id: "elite", e: "⚠️", name: "精英鼠", desc: "带光环（加速/护盾/回血），掉宝箱。" },
    { id: "boss", e: "🐀👑", name: "鼠王", desc: "9:40 降临，三阶段。击杀或坚持 60 秒迎来黎明。" }
  ];
  function bestGet() { try { var o = JSON.parse(storageGet("catmouse_bestiary", "{}")); return o && typeof o === "object" ? o : {}; } catch (e) { return {}; } }
  var bestPending = {};
  function bestNote(m) {
    var k = m.boss ? "boss" : m.elite ? "elite" : m.thief ? "thief" : m.mutant ? "mutant" : (m.type === "gold" || m.type === "brown") ? m.type : "grey";
    bestPending[k] = (bestPending[k] || 0) + 1;
  }
  function bestFlush() {
    var b = bestGet(), any = false; for (var k in bestPending) { b[k] = (b[k] | 0) + bestPending[k]; any = true; }
    bestPending = {}; if (any) storageSet("catmouse_bestiary", JSON.stringify(b));
  }
  function openShop() {
    var ov = document.getElementById("shopScreen");
    if (!ov) {
      ov = document.createElement("div"); ov.id = "shopScreen"; ov.className = "overlay"; ov.setAttribute("role", "dialog"); ov.setAttribute("aria-label", "帽子小铺");
      ov.innerHTML = '<div class="panel shop-panel"><h2>🛍️ 帽子小铺</h2><div class="shop-bal"></div><div class="shop-grid"></div><h3 class="shop-h">🌟 天赋（守卫战，每点 ≤5%）</h3><div class="shop-tal shop-grid"></div><h3 class="shop-h">📖 图鉴</h3><div class="shop-best"></div><p class="shop-note">小鱼干只存在这台设备上：守卫战结算获得，可换帽子或点天赋。天赋只是小幅加成，服务器按同一规则计分。</p><button class="btn-primary shop-close">好啦</button></div>';
      document.getElementById("app").appendChild(ov);
      ov.querySelector(".shop-close").onclick = function () { sfx.click(); ov.classList.add("hidden"); updateShopBtn(); };
    }
    var grid = ov.querySelector(".shop-grid"), fish = lsNum("catmouse_fish"), own = hatsOwned(), on = storageGet("catmouse_hat", "");
    ov.querySelector(".shop-bal").textContent = "🐟 小鱼干 " + fish + " · ⭐ 累计星星 " + lsNum("catmouse_stars");
    grid.innerHTML = "";
    [{ id: "", e: "🚫", name: "不戴", cost: 0 }].concat(HATS).forEach(function (h) {
      var have = !h.id || own.indexOf(h.id) >= 0, b = document.createElement("button"); b.type = "button"; b.className = "shop-item" + (on === h.id ? " on" : "") + (have ? "" : " lock");
      b.innerHTML = '<span class="si-e"></span><b></b><small></small>'; b.children[0].textContent = h.e; b.children[1].textContent = h.name;
      b.children[2].textContent = on === h.id ? "戴着" : have ? "戴上" : "🐟 " + h.cost;
      if (!have && fish < h.cost) b.classList.add("poor");
      b.onclick = function () {
        sfx.click();
        if (!have) { if (lsNum("catmouse_fish") < h.cost) return; storageSet("catmouse_fish", String(lsNum("catmouse_fish") - h.cost)); own.push(h.id); storageSet("catmouse_hats", JSON.stringify(own)); }
        storageSet("catmouse_hat", h.id); hatCache = undefined; openShop();
      };
      grid.appendChild(b);
    });
    var tal = ov.querySelector(".shop-tal"), tv = talentsGet(); tal.innerHTML = "";
    TALENTS.forEach(function (d) {
      var lv = talLv(d.id), cost = talentCost(lv), b = document.createElement("button"); b.type = "button";
      b.className = "shop-item tal" + (lv >= TALENT_MAX ? " on" : "") + (lv < TALENT_MAX && fish < cost ? " poor" : "");
      b.innerHTML = '<span class="si-e"></span><b></b><small></small><small class="tal-d"></small>';
      b.children[0].textContent = d.e; b.children[1].textContent = d.name + " " + lv + "/" + TALENT_MAX;
      b.children[2].textContent = lv >= TALENT_MAX ? "已满" : "🐟 " + cost; b.children[3].textContent = d.desc;
      b.onclick = function () {
        sfx.click(); var l2 = talLv(d.id), c2 = talentCost(l2);
        if (l2 >= TALENT_MAX || lsNum("catmouse_fish") < c2) return;
        storageSet("catmouse_fish", String(lsNum("catmouse_fish") - c2)); tv[d.id] = l2 + 1; storageSet("catmouse_talents", JSON.stringify(tv)); openShop();
      };
      tal.appendChild(b);
    });
    var bst = ov.querySelector(".shop-best"), bg = bestGet(); bst.innerHTML = "";
    BEST_ENTRIES.forEach(function (d) {
      var n = bg[d.id] | 0, el = document.createElement("div"); el.className = "best-item" + (n ? "" : " lock");
      el.innerHTML = '<span class="si-e"></span><b></b><small></small>';
      el.children[0].textContent = n ? d.e : "❔"; el.children[1].textContent = n ? d.name + " ×" + n : "未发现";
      el.children[2].textContent = n ? d.desc : "在守卫战中击败一只来解锁";
      bst.appendChild(el);
    });
    ov.classList.remove("hidden");
  }
  (function () {
    var lb = document.getElementById("showLeaderboardBtnStart"); if (!lb) return;
    var b = document.createElement("button"); b.id = "shopBtn"; b.type = "button"; b.className = "btn-secondary shop-btn"; lb.parentNode.insertBefore(b, lb.nextSibling);
    b.onclick = function () { sfx.click(); openShop(); }; setTimeout(updateShopBtn, 0);
  })();
  function drawCatAt(x, y, r, a, runCycle, skin, ghost) {
    var u = r * CAT_UNIT_PER_R;
    var gulp = ghost ? null : gulpState();
    var dirInfo = ANIM.DIR8[gulp ? gulp.dir : a.dir];
    var view = dirInfo[0], flip = dirInfo[1];
    var st;
    if (gulp) st = ["gulp", Math.min(4, Math.floor(gulp.t / (GULP_T / 5)))];
    else st = animFrame(a, runCycle, CAT_SIT_SCHED);
    var sitting = st[0] === "sit" && a.mode === "sit";
    var breathe = sitting ? Math.sin((a.t + a.phase) * 2.4) * 0.03 : 0;
    var painted = catImgs(skin);
    if (!painted) shadow(x, y + 46 * u, (st[0] === "run" ? 30 : 26) * u);
    if (!ghost) drawGulpMouse(x, y, u, view, flip, true);
    if (paintedCat(x, y, u, view, flip, st, breathe, runCycle, skin, a)) { if (!ghost) drawGulpMouse(x, y, u, view, flip, false); return; }
    blit(ANIM.catSprite(skin, view, st[0], st[1], spritePx(u)), x, y, u, flip, 1 - breathe * 0.5, 1 + breathe, 46);
    if (!ghost) drawGulpMouse(x, y, u, view, flip, false);
  }

  function drawCat() {
    if (sig && sig.hide) return;
    var sx = worldToScreenX(cat.x), sy = worldToScreenY(cat.y) + s(evoHop()) - s(sig ? sig.z || 0 : 0), stc = sigCatStretch() || uniCatStretch();
    if (poopSitting() && !reducedMotion) sx += Math.sin(elapsedPlayTime * 50) * s(1.5);
    if (stc) { ctx.save(); ctx.translate(sx, sy); ctx.rotate(stc.a); ctx.scale(stc.s, 1 / Math.sqrt(stc.s)); ctx.rotate(-stc.a); ctx.translate(-sx, -sy); }
    paintPounce = !!(uni && uni.lunge) || !!(sig && sig.go); paintGait = cat.gait || 0; paintSquash = reducedMotion ? 0 : cat.squash;
    drawCatAt(sx, sy, s(cat.r), catAnim, cat.runCycle, currentSkin); paintPounce = false; paintGait = null; paintSquash = 0;
    drawHat(sx, sy, s(cat.r), catAnim);
    if (stc) ctx.restore();
  }

  // ---- v9 绘制：LOD（最近 60 只完整动画，其余跑步 2 帧、无尘土）+ 每种行为的外观提示 ----
  var emojiCache = new Map();
  function emojiSprite(ch, px, col) {
    px = Math.max(8, Math.round(px)); var key = ch + "|" + px + "|" + DPR + "|" + (col || ""), c = emojiCache.get(key);
    if (!c) {
      if (emojiCache.size > 300) emojiCache.clear();
      var wide = ch.length > 2 ? ch.length * 0.75 : 1;
      c = document.createElement("canvas"); var d = Math.ceil(px * 1.4 * Math.min(DPR, 2)); c.width = Math.ceil(d * wide); c.height = d;
      var g = c.getContext("2d"); g.font = (col ? "bold " : "") + Math.round(px * Math.min(DPR, 2)) + "px sans-serif"; g.textAlign = "center"; g.textBaseline = "middle";
      if (col) { g.lineWidth = Math.max(2, px * 0.18 * Math.min(DPR, 2)); g.strokeStyle = "rgba(90,58,42,.8)"; g.strokeText(ch, c.width / 2, d / 2); g.fillStyle = col; }
      g.fillText(ch, c.width / 2, d / 2 + d * 0.04); c._wide = wide;
      emojiCache.set(key, c);
    }
    return c;
  }
  function emojiQuick(ch, x, y, px, alpha, col) {
    var c = emojiSprite(ch, px, col), w = px * 1.4, ww = w * (c._wide || 1);
    if (alpha != null) ctx.globalAlpha = alpha;
    ctx.drawImage(c, x - ww / 2, y - w / 2, ww, w);
    if (alpha != null) ctx.globalAlpha = 1;
  }
  var dbgDraw = {};
  var MICE_FULL_LOD = 60, drawStats = { drawn: 0, full: 0 };
  var packHue = function (id) { return (id * 67) % 360; };
  function drawHolesAndFood() {
    for (var i = 0; i < mice.length; i++) {
      var m = mice[i], u = s(m.r) * MOUSE_UNIT_PER_R;
      if (m.beh === "burrow" && m.hole) {
        var hx = worldToScreenX(m.hole.x), hy = worldToScreenY(m.hole.y) + 20 * u;
        if (hx < -60 || hx > W + 60 || hy < -60 || hy > H + 60) continue;
        ctx.fillStyle = "#b08560"; ctx.beginPath(); ctx.ellipse(hx, hy + 2 * u, 30 * u, 13 * u, 0, 0, Math.PI * 2); ctx.fill();
        ctx.fillStyle = "#3b2a1e"; ctx.beginPath(); ctx.ellipse(hx, hy, 20 * u, 8 * u, 0, 0, Math.PI * 2); ctx.fill();
        if (m.under) { // 洞里一双眼睛
          var blink = Math.sin(elapsedPlayTime * 3 + m.seed * 9) > 0.9;
          if (!blink) { ctx.fillStyle = "#fff"; ctx.beginPath(); ctx.arc(hx - 5 * u, hy - 1 * u, 2.6 * u, 0, 7); ctx.arc(hx + 5 * u, hy - 1 * u, 2.6 * u, 0, 7); ctx.fill(); }
        }
      } else if (m.beh === "forager" && m.food) {
        var fxs = worldToScreenX(m.food.x), fys = worldToScreenY(m.food.y);
        if (fxs < -40 || fxs > W + 40 || fys < -40 || fys > H + 40) continue;
        emojiQuick("🧀", fxs, fys + 10 * u, 22 * u);
      }
    }
  }
  function drawMice() {
    drawHolesAndFood();
    var vis = [];
    for (var i = 0; i < mice.length; i++) {
      var m = mice[i]; m.lodFull = false;
      if (m.hidden || m.under) continue;
      var sx = worldToScreenX(m.x), sy = worldToScreenY(m.y);
      if (sx < -60 || sx > W + 60 || sy < -60 || sy > H + 60) continue;
      var dx = m.x - cat.x, dy = m.y - cat.y;
      vis.push({ m: m, sx: sx, sy: sy, d: dx * dx + dy * dy, i: i });
    }
    var fullN = resScale < 1 ? 40 : MICE_FULL_LOD;
    if (vis.length > fullN) {
      var ds = vis.map(function (v) { return v.d; }).sort(function (a, b) { return a - b; }), cut = ds[fullN - 1];
      for (i = 0; i < vis.length; i++) vis[i].full = vis[i].d <= cut;
    } else for (i = 0; i < vis.length; i++) vis[i].full = true;
    vis.sort(function (a, b) { return a.sy - b.sy; });
    drawStats.drawn = vis.length; drawStats.full = 0;
    if (!dbgDraw.noShadow) { // 阴影合并成一次 fill
      for (var q = 0; q < vis.length; q++) { var vm = vis[q].m, uu = s(vm.r) * MOUSE_UNIT_PER_R, rx = (vm.anim && vm.anim.mode === "run" ? 15 : 13) * uu; ctx.drawImage(shadowSprite(), vis[q].sx - rx * 1.5, vis[q].sy + 24 * uu - rx * 0.3, rx * 3, rx * 0.6); }
    }
    var cut20 = Infinity; if (vis.length > 20) { var d20 = vis.map(function (v) { return v.d; }).sort(function (a, b) { return a - b; }); cut20 = d20[19]; }
    for (var k = 0; k < vis.length; k++) {
      var v = vis[k]; m = v.m; sx = v.sx; sy = v.sy; tellNear = v.d <= cut20;
      if (!m.anim) m.anim = newAnim();
      m.lodFull = v.full; if (v.full) drawStats.full++;
      var r = s(m.r) * (m.boss ? 2.8 : m.elite ? 1.45 : 1), u = r * MOUSE_UNIT_PER_R, d = ANIM.DIR8[m.anim.dir];
      var st = animFrame(m.anim, m.runCycle * 1.4, MOUSE_SIT_SCHED);
      if (!v.full && st[0] === "run") st = ["run", st[1] & 2]; // 远处只用 2 帧
      if (!v.full && st[0] === "sit") st = ["sit", 2];
      var ox = 0;
      if (m.cornerT > 0 || m.trem > 0 || (m.beh === "timid" && m.state === "flee" && v.full)) ox = Math.sin(elapsedPlayTime * 60) * 2 * u;
      if (m.asleep) st = ["sit", 2];
      if (dayNow.night > 0.5 && !m.boss && !m.elite && mouseInDark(m)) { var ea = 0.5 + 0.5 * dayNow.night; var blk = Math.sin(elapsedPlayTime * 2.3 + m.seed * 11) > 0.96; if (!blk) { var gw = glowSprite(), gs = s(9); if (resScale >= 1) { ctx.globalAlpha = ea; ctx.drawImage(gw, sx - 5 * u - gs / 2, sy - 8 * u - gs / 2, gs, gs); ctx.drawImage(gw, sx + 5 * u - gs / 2, sy - 8 * u - gs / 2, gs, gs); ctx.globalAlpha = 1; } ctx.fillStyle = "#fff8c0"; ctx.beginPath(); ctx.arc(sx - 5 * u, sy - 8 * u, s(1.6), 0, 7); ctx.arc(sx + 5 * u, sy - 8 * u, s(1.6), 0, 7); ctx.fill(); } continue; }
      if (!dbgDraw.noSprite && !paintedMouse(m.type, sx + ox, sy, u, d[0], d[1], st, m.runCycle)) blit(ANIM.mouseSprite(m.type, d[0], st[0], st[1], spritePx(u)), sx + ox, sy, u, d[1]);
      drawMutantTint(m, sx + ox, sy, u);
      if (!dbgDraw.noTell && (v.full || m.type === "gold" || m.packId)) drawTell(m, sx + ox, sy, u, st, v.full, v.i);
    }
  }
  var tellNear = true;
  function drawTell(m, sx, sy, u, st, full, i) {
    var top = sy + (st[0] === "sit" ? -46 : -32) * u;
    if (m.type === "gold") {
      if (cbMode) { ctx.save(); ctx.setLineDash([5 * u, 4 * u]); ctx.lineWidth = 4 * u; ctx.strokeStyle = "#1a1a1a"; ctx.beginPath(); ctx.arc(sx, sy, 30 * u, 0, 7); ctx.stroke(); ctx.strokeStyle = "#fff"; ctx.lineDashOffset = 4 * u; ctx.stroke(); ctx.restore(); }
      if (full && CA.sfx.sparkle) CA.sfx.sparkle();
      emojiQuick("👑", sx, top - 2 * u, 29 * u);
      if (full) { var tw = (Math.sin(m.runCycle * 3 + i) + 1) / 2; ART.star(ctx, sx + 24 * u, top + 10 * u, (3 + tw * 3) * u * 1.4, "rgba(255,236,140," + (0.5 + tw * 0.5) + ")"); }
    }
    if (m.packId) { // 同色小围巾；领头鼠举小旗
      ctx.strokeStyle = "hsl(" + packHue(m.packId) + ",80%,58%)"; ctx.lineWidth = 4 * u;
      ctx.beginPath(); ctx.arc(sx, sy - 6 * u, 11 * u, 0.15 * Math.PI, 0.85 * Math.PI); ctx.stroke();
      if (m.leader && tellNear) emojiQuick("🚩", sx + 14 * u, top, 26 * u);
    }
    if (m.beh === "timid") { ctx.fillStyle = "#7cc8ff"; ctx.beginPath(); ctx.ellipse(sx + 15 * u, top + 12 * u, 3.2 * u, 4.6 * u, 0, 0, 7); ctx.fill(); }
    if (m.beh === "thief") emojiQuick("🧀", sx + Math.cos(m.facing) * 14 * u, sy + 4 * u, 26 * u);
    if (m.beh === "forager" && m.eating && full) emojiQuick("😋", sx, top, 26 * u);
    if (m.beh === "teaser" && m.taunt) { emojiQuick("😛", sx + 16 * u, top - 4 * u, 29 * u); if (full) emojiQuick("略略略", sx, top - 18 * u, 14 * u, null, "#fff"); }
    if (m.cornerT > 0) emojiQuick("💦", sx - 14 * u, top + 2 * u, 22 * u);
    if (m.beh === "teaser" && m.tiredT > 0) emojiQuick("💦", sx + 14 * u, top, 22 * u);
    if (m.asleep) emojiQuick("💤", sx + 14 * u + Math.sin(elapsedPlayTime * 2 + i) * 3 * u, top - 4 * u - ((elapsedPlayTime + m.seed) % 1.5) * 6 * u, 26 * u);
    if (m.excl > 0 && tellNear) emojiQuick("!", sx, top - 10 * u, 24 * u, null, "#ff4d4d");
  }


  var PARTICLE_COLORS = ["#ff7a9a", "#ffd84a", "#8fd3ff", "#ffffff"];
  function drawEffects() {
    var i;
    for (i = 0; i < catchParticles.length; i++) {
      var c = catchParticles[i];
      var sx = worldToScreenX(c.x), sy = worldToScreenY(c.y);
      var alpha = Math.max(0, 1 - c.age / c.life);
      if (reducedMotion) alpha *= 0.5;
      ctx.globalAlpha = alpha;
      var size = s(7) * (0.6 + alpha * 0.6) * entityScaleMult;
      if (i % 2 === 0) ART.heart(ctx, sx, sy, size, PARTICLE_COLORS[0]);
      else ART.star(ctx, sx, sy, size * 1.2, PARTICLE_COLORS[1 + (i % 3)]);
    }
    ctx.globalAlpha = 1;
    ctx.textAlign = "center";
    ctx.lineJoin = "round";
    for (i = 0; i < scorePopups.length; i++) {
      var p = scorePopups[i];
      var sx2 = worldToScreenX(p.x), sy2 = worldToScreenY(p.y);
      var a = Math.max(0, 1 - p.age / p.life);
      var pop = p.age < 0.12 ? 0.7 + p.age / 0.12 * 0.5 : 1.2 - Math.min(0.2, (p.age - 0.12) * 0.8);
      ctx.globalAlpha = a;
      ctx.font = "900 " + Math.round(s(18) * entityScaleMult * pop) + "px sans-serif";
      ctx.lineWidth = Math.max(3, s(4));
      ctx.strokeStyle = "#ff7a9a";
      // 避让：靠近猫时把飘字推到猫头顶上方，并降低透明度，不挡住猫
      var cx0 = worldToScreenX(cat.x), cy0 = worldToScreenY(cat.y), ty = sy2 - s(26), avoid = s(cat.r * 2.4);
      if (Math.abs(sx2 - cx0) < avoid && Math.abs(ty - cy0) < avoid) { ty = Math.min(ty, cy0 - avoid); ctx.globalAlpha = a * 0.75; }
      var big = p.n > 1 ? 1 + Math.min(0.5, p.n * 0.06) : 1;
      if (big > 1) ctx.font = "900 " + Math.round(s(18) * entityScaleMult * pop * big) + "px sans-serif";
      var txt = "+" + p.amount + " ♥" + (p.n > 1 ? " ×" + p.n : "");
      ctx.strokeText(txt, sx2, ty);
      ctx.fillStyle = "#ffffff";
      ctx.fillText(txt, sx2, ty);
    }
    ctx.globalAlpha = 1;
  }

  // =======================================================================
  // Leaderboard client（第 9 节；SUPABASE_URL/KEY 未配置或请求失败时全部静默降级）
  // =======================================================================

  var backendConfigured = !!(SUPABASE_URL && SUPABASE_ANON_KEY);

  function getClientId() {
    var id = storageGet("catmouse_client_id", "");
    if (id) return id;
    try {
      id = (window.crypto && window.crypto.randomUUID) ? window.crypto.randomUUID() : null;
    } catch (e) { id = null; }
    if (!id) id = "c-" + Date.now().toString(36) + "-" + Math.random().toString(36).slice(2);
    storageSet("catmouse_client_id", id);
    return id;
  }

  var clientId = getClientId();
  var run = { id: null, seq: 0, lastSentAt: 0, lastSentScore: -1, offline: !backendConfigured };

  function restUrl(path) { return SUPABASE_URL.replace(/\/$/, "") + path; }

  function restHeaders() {
    return {
      apikey: SUPABASE_ANON_KEY,
      Authorization: "Bearer " + SUPABASE_ANON_KEY,
      "Content-Type": "application/json"
    };
  }

  function unwrapRpcResult(data) {
    if (Array.isArray(data)) data = data[0];
    return (data && typeof data === "object") ? data : {};
  }

  // 调用方要能区分"根本没联系上后端"（离线/HTTP 非 2xx/响应解析失败，
  // 用 networkError:true 标记）和"后端正常响应了，但函数自己判定 ok:false"
  // 两种情况——前者该提示"未能连接排行榜"，后者该照着函数返回的 reason
  // 显示具体原因（比如 finish_run 的 invalid_run），不能混在一起说成同一
  // 句"未能连接排行榜，成绩未上传"（见第三轮审核）。
  function rpcPost(name, body, keepalive) {
    if (!backendConfigured) return Promise.resolve({ ok: false, networkError: true });
    var fetchOpts = { method: "POST", headers: restHeaders(), body: JSON.stringify(body) };
    if (keepalive) fetchOpts.keepalive = true;
    return fetch(restUrl("/rest/v1/rpc/" + name), fetchOpts)
      .then(function (res) {
        if (!res.ok) return { ok: false, networkError: true };
        return res.json().then(function (data) {
          var row = unwrapRpcResult(data);
          row.ok = row.ok !== false;
          row.networkError = false;
          return row;
        }).catch(function () { return { ok: false, networkError: true }; });
      })
      .catch(function () { return { ok: false, networkError: true }; });
  }

  function restGet(path) {
    if (!backendConfigured) return Promise.resolve({ ok: false, rows: [] });
    return fetch(restUrl(path), { method: "GET", headers: restHeaders() })
      .then(function (res) {
        if (!res.ok) return { ok: false, rows: [] };
        return res.json().then(function (rows) { return { ok: true, rows: rows || [] }; });
      })
      .catch(function () { return { ok: false, rows: [] }; });
  }

  // ---- 守卫榜（surv_runs）：开局 surv_start，结算 surv_finish；分数由服务器按分量重算 ----
  var survNet = { id: null, pending: null };
  function survStartRun(nickname) {
    survNet.id = null; survNet.pending = null;
    if (!backendConfigured) return;
    survNet.pending = rpcPost("surv_start", { p_client_id: clientId, p_nickname: nickname || "", p_skin: currentSkin }).then(function (res) {
      if (res.ok && res.run_id != null) survNet.id = res.run_id; return res;
    });
  }
  function survFinishRun(info, cb) {
    if (!backendConfigured || !survNet.pending) { cb({ ok: false, networkError: true }); return; }
    survNet.pending.then(function () {
      if (survNet.id == null) { cb({ ok: false, networkError: true }); return; }
      var id = survNet.id; survNet.id = null; survNet.lastId = id;
      rpcPost("surv_finish", { p_run_id: id, p_client_id: clientId, p_time_s: info.time, p_kills: info.kills, p_level: info.level, p_boss: info.boss }, true).then(cb);
    });
  }
  function startRun(nickname) {
    run.id = null; run.seq = 0; run.lastSentAt = 0; run.lastSentScore = -1;
    run.offline = !backendConfigured;
    if (!backendConfigured) return;
    rpcPost("start_run", { p_client_id: clientId, p_nickname: nickname || "", p_skin: currentSkin }).then(function (res) {
      if (res.ok && res.run_id != null) {
        run.id = res.run_id;
        // 服务端在插入 runs 行时就把 last_heartbeat_at 设成了 start_run 那一刻，
        // 这里把 lastSentAt 也对齐到"现在"，让 maybeSendHeartbeat 的最小间隔
        // 节流从这一刻起算，否则第一次心跳几乎立刻发出，会被服务端的
        // "两次心跳间隔 < 2 秒"规则拒绝为 too_frequent。
        run.lastSentAt = Date.now();
      } else {
        run.offline = true;
      }
    });
  }

  function heartbeatPayload(playStatus) {
    run.seq += 1;
    return {
      p_run_id: run.id,
      p_client_id: clientId,
      p_seq: run.seq,
      p_play_status: playStatus,
      p_score: Math.round(score),
      p_catches: catches,
      p_catches_grey: catchesGrey,
      p_catches_brown: catchesBrown,
      p_catches_gold: catchesGold,
      p_combo_max: comboMax,
      p_elapsed_seconds: elapsedPlayTime,
      p_ability_procs: ab ? ab.procs : 0,
      p_uni_procs: uni ? uni.stats : null,
      p_nests_destroyed: nestStats.destroyed,
      p_client_ts: new Date().toISOString()
    };
  }

  function maybeSendHeartbeat(now) {
    if (run.id == null || run.offline) return;
    var since = now - run.lastSentAt;
    if (since < HEARTBEAT_MIN_INTERVAL_MS) return;
    var dueInterval;
    if (run.forceNext) dueInterval = HEARTBEAT_MIN_INTERVAL_MS;
    else if (state === STATE_PAUSE) dueInterval = HEARTBEAT_PAUSED_INTERVAL_MS;
    else dueInterval = (score !== run.lastSentScore) ? HEARTBEAT_ACTIVE_INTERVAL_MS : HEARTBEAT_IDLE_INTERVAL_MS;
    if (since < dueInterval) return;
    run.lastSentAt = now;
    run.lastSentScore = score;
    run.forceNext = false;
    rpcPost("heartbeat", heartbeatPayload(state === STATE_PAUSE ? "paused" : "playing"));
  }

  function finishRun() {
    if (!backendConfigured) { dom.resultRankStatus.textContent = "排行榜未配置"; return; }
    if (run.offline || run.id == null) { dom.resultRankStatus.textContent = "未能连接排行榜，成绩未上传"; return; }
    rpcPost("finish_run", {
      p_run_id: run.id,
      p_client_id: clientId,
      p_final_score: Math.round(score),
      p_final_catches: catches,
      p_duration_seconds: Math.round(elapsedPlayTime)
    }).then(function (res) {
      if (res.networkError) {
        // 真的没联系上后端（离线/HTTP 错误/响应解析失败），这局确实没有
        // 上传成功。
        dom.resultRankStatus.textContent = "未能连接排行榜，成绩未上传";
      } else if (res.ok && res.rank != null) {
        // rank 是按玩家历史最佳算的名次，run_rank 是按*这一局*结算分算的
        // 名次——本局分数没有刷新个人最佳时两者会不一样（比如历史最佳
        // 360 分排第 1，这一局结算成 42 分在全榜里只能排第 6），只显示
        // rank 会让玩家误以为这一局排第 1。两者相同时（这一局就是/刷新了
        // 个人最佳）只用一个数字，不用重复说两遍。
        var sameRank = res.run_rank === res.rank;
        var rankText = sameRank
          ? ("你是第 " + res.rank + " 名！")
          : ("本局排名第 " + res.run_rank + " 名；你的最好成绩排名第 " + res.rank + " 名");
        if (res.adjusted) {
          // 服务端没采信这次提交的数字，改用最后一次被接受心跳的状态结算，
          // 但确实已经写进了排行榜——不能说"未上传"，要说清楚结算的是
          // 哪个分数。
          dom.resultRankStatus.textContent = sameRank
            ? ("成绩已按服务器记录结算：" + res.final_score + " 分，" + rankText)
            : ("成绩已按服务器记录结算：" + res.final_score + " 分（" + rankText + "）");
        } else {
          dom.resultRankStatus.textContent = rankText;
        }
        showRankGap(res.final_score != null ? res.final_score : Math.round(score), res.run_rank);
      } else {
        // 后端正常响应了，只是这次调用本身被判定无效（比如 invalid_run），
        // 不是网络问题，不应该说成"未能连接排行榜"。
        dom.resultRankStatus.textContent = "本局成绩未被接受";
      }
    });
  }

  // 结算页：离上一名还差多少分（用局内排行快照：其他人的分数降序）
  function showRankGap(fs, rk) {
    var el = document.getElementById("resultGap"); if (!el) return;
    if (rk === 1) { el.textContent = "🏆 你是第一名！"; el.classList.remove("hidden"); return; }
    var above = null; for (var i = leaderboardSnapshot.length - 1; i >= 0; i--) if (leaderboardSnapshot[i] > fs) { above = leaderboardSnapshot[i]; break; }
    if (above == null) { el.classList.add("hidden"); return; }
    el.textContent = "离上一名还差 " + (above - fs + 1) + " 分，再来一局冲一冲！"; el.classList.remove("hidden");
  }
  window.addEventListener("pagehide", function () {
    if (!backendConfigured || run.offline || run.id == null) return;
    try {
      fetch(restUrl("/rest/v1/rpc/finish_run"), {
        method: "POST",
        keepalive: true,
        headers: restHeaders(),
        body: JSON.stringify({
          p_run_id: run.id,
          p_client_id: clientId,
          p_final_score: Math.round(score),
          p_final_catches: catches,
          p_duration_seconds: Math.round(elapsedPlayTime)
        })
      });
    } catch (e) { /* 页面即将卸载，发送失败也无法补救 */ }
  });

  var leaderboardSnapshot = [];
  var leaderboardSnapshotAt = 0;

  function estimateRank(sortedDesc, myScore) {
    var lo = 0, hi = sortedDesc.length;
    while (lo < hi) {
      var mid = (lo + hi) >> 1;
      if (sortedDesc[mid] < myScore) hi = mid; else lo = mid + 1;
    }
    return lo + 1;
  }

  // 快照：其他人的分数（降序）+ 自己的精确名次（按 live_run_id 识别自己）
  var mySnapshotRank = null;
  function applySnapshotToHud() {
    if (!backendConfigured || (leaderboardSnapshot.length === 0 && mySnapshotRank == null)) { setText(dom.rankText, "排名：未上榜"); return; }
    if (run.id == null) {
      var est = estimateRank(leaderboardSnapshot, score);
      setText(dom.rankText, est > leaderboardSnapshot.length ? ("排名：" + leaderboardSnapshot.length + "+ 名") : ("当前约第 " + est + " 名"));
      return;
    }
    // 名次口径与服务端一致：分数高者在前，同分时别人先达到 → 排在我前面。
    var ahead = 0;
    for (var i = 0; i < leaderboardSnapshot.length; i++) { if (leaderboardSnapshot[i] >= score) ahead++; else break; }
    var rank = ahead + 1;
    if (leaderboardSnapshot.length >= LEADERBOARD_SNAPSHOT_LIMIT - 1 && ahead >= leaderboardSnapshot.length) {
      setText(dom.rankText, "排名：" + LEADERBOARD_SNAPSHOT_LIMIT + "+ 名");
    } else {
      setText(dom.rankText, "排名：第 " + rank + " 名");
    }
    rankToast(rank);
  }

  // v20：名次变化时左上角小提示（约 2 秒，频繁变化合并为最新一条）
  var rtLast = null, rtTimer = 0, rtEl = document.getElementById("rankToast");
  function rankToast(rank) {
    if (!rtEl || state !== STATE_PLAY) { rtLast = rank; return; }
    if (rtLast == null || rtLast === rank) { rtLast = rank; return; }
    var up = rank < rtLast; rtLast = rank;
    rtEl.textContent = (up ? "⬆ 升到第 " : "⬇ 掉到第 ") + rank + " 名";
    rtEl.classList.add("show"); clearTimeout(rtTimer);
    rtTimer = setTimeout(function () { rtEl.classList.remove("show"); }, 2000);
  }
  function refreshSnapshotIfDue(now, force) {
    if (!backendConfigured) return;
    if (!force && leaderboardSnapshotAt !== 0 && now - leaderboardSnapshotAt < LEADERBOARD_POLL_INTERVAL_MS) return;
    leaderboardSnapshotAt = now;
    restGet("/rest/v1/leaderboard_live?select=display_score,rank,live_run_id&order=rank.asc&limit=" + LEADERBOARD_SNAPSHOT_LIMIT)
      .then(function (res) {
        if (!res.ok) return;
        mySnapshotRank = null;
        var others = [];
        for (var i = 0; i < res.rows.length; i++) {
          var r = res.rows[i];
          if (run.id != null && r.live_run_id === run.id) mySnapshotRank = r.rank;
          else others.push(r.display_score);
        }
        leaderboardSnapshot = others.sort(function (a, b) { return b - a; });
        if (state === STATE_PLAY) applySnapshotToHud();
      });
  }

  function escapeHtml(str) {
    return String(str).replace(/[&<>"']/g, function (c) {
      return ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c];
    });
  }

  // 轻量前端提示：镜像服务端 start_run() 的白名单（ASCII 字母数字、CJK 统一
  // 表意文字、空格、下划线、短横线），输入时就去掉非法字符、折叠空白、限长，
  // 不等提交才发现昵称被改写。真正的拒绝/敏感词兜底仍以服务端为准。
  // 最终存储用的严格白名单：ASCII 字母数字、CJK 统一表意文字、空格、下划线、
  // 短横线——不含 !/@/$，这几个符号要留到 isNicknameOffensive() 检查完才能
  // 删（见下面 enforceNicknameNotOffensive 的顺序，镜像
  // supabase/migrations/20261018080000 里 start_run() 的做法）。
  function sanitizeNickname(raw) {
    var cleaned = String(raw || "").replace(/[^a-zA-Z0-9_\- 一-鿿]/g, "");
    cleaned = cleaned.replace(/\s+/g, " ");
    return cleaned.slice(0, 12);
  }

  // 打字过程中实时用的白名单，比 sanitizeNickname() 多留了 !/@/$ 三个
  // leet 触发符号，否则这里先把它们删了，后面 isNicknameOffensive() 的
  // leet 替换就永远没机会命中（第四轮审核发现的漏网问题，跟服务端是
  // 同一个坑：白名单清洗不能在敏感词检查*之前*把这些符号删掉）。
  function sanitizeNicknameLive(raw) {
    var cleaned = String(raw || "").replace(/[^a-zA-Z0-9_\-!@$ 一-鿿]/g, "");
    cleaned = cleaned.replace(/\s+/g, " ");
    return cleaned.slice(0, 12);
  }

  // 镜像 supabase/migrations/20261018230000_nickname_double_letter_fix.sql
  // 里最新版的 nickname_is_offensive()：两处改一处须同步另一处。这里只是
  // 提前给用户一个提示，真正兜底仍由服务端 start_run() 决定存成什么昵称。
  //
  // 输入同时生成两种形式，分别和对应形式的词表比较：
  //   two：3 个及以上的重复压成 2 个（"a$$$hole" -> "asshole"），对原样词表；
  //   one：所有重复压成 1 个（"fuuuck" -> "fuck"），对同样压缩过的词表。
  // 短/易误伤词只做整词匹配；长词做子串匹配（分隔符折叠串和无分隔符串都查，
  // 先剔除安全词）。
  var NICKNAME_WHOLE_WORDS = ["sex", "dick", "fag", "kys", "cock", "rape", "porn", "sht", "fck", "fuk", "cunt"];
  var NICKNAME_SUBSTRING_WORDS = [
    "fuck", "shit", "bitch", "pussy", "asshole", "bastard", "slut", "whore",
    "nigger", "nigga", "faggot", "retard", "nazi", "hitler", "twat", "wanker",
    "admin", "system", "supabase"
  ];
  var NICKNAME_SAFE_WORDS = [
    "scunthorpe", "essex", "sussex", "middlesex", "dickens", "dickson", "cockburn",
    "hancock", "peacock", "shitake", "shiitake", "grape", "therapist", "assassin",
    "class", "pass", "bass", "niger", "nigeria", "nigerian"
  ];
  var NICKNAME_CHINESE_PATTERN = /傻x|傻逼|白痴|管理员|客服|官方/;

  function collapseRepeats(v) { return v.replace(/(.)\1+/g, "$1"); }

  function nicknameForms(raw) {
    var leet = { "0": "o", "1": "i", "3": "e", "4": "a", "5": "s", "7": "t", "@": "a", "$": "s", "!": "i" };
    var base = String(raw || "").toLowerCase().replace(/[013457@$!]/g, function (c) { return leet[c] || c; });
    return [
      { form: base.replace(/(.)\1\1+/g, "$1$1"), whole: NICKNAME_WHOLE_WORDS, sub: NICKNAME_SUBSTRING_WORDS, safe: NICKNAME_SAFE_WORDS },
      { form: collapseRepeats(base), whole: NICKNAME_WHOLE_WORDS.map(collapseRepeats),
        sub: NICKNAME_SUBSTRING_WORDS.map(collapseRepeats), safe: NICKNAME_SAFE_WORDS.map(collapseRepeats) }
    ];
  }

  function isNicknameOffensive(raw) {
    if (String(raw || "") === "") return false;
    var forms = nicknameForms(raw);
    for (var f = 0; f < forms.length; f++) {
      var F = forms[f], i;
      var toks = F.form.split(/[ _.\-]+/);
      for (i = 0; i < toks.length; i++) {
        if (toks[i] !== "" && F.whole.indexOf(toks[i]) !== -1) return true;
      }
      var glued = F.form.replace(/[ _.\-]/g, "");
      if (F.whole.indexOf(glued) !== -1) return true;
      var collapsed = F.form.replace(/[ _.\-]+/g, " ").trim();
      var sc = collapsed, sg = glued;
      for (i = 0; i < F.safe.length; i++) {
        sc = sc.split(F.safe[i]).join("");
        sg = sg.split(F.safe[i]).join("");
      }
      for (i = 0; i < F.sub.length; i++) {
        if (sc.indexOf(F.sub[i]) !== -1 || sg.indexOf(F.sub[i]) !== -1) return true;
      }
      if (NICKNAME_CHINESE_PATTERN.test(collapsed)) return true;
    }
    return false;
  }

  // 在输入框失焦（blur）或真正提交（beginRun/切换昵称）时调用。顺序镜像
  // 服务端 start_run()：先查*原始*输入（这时候 !/@/$ 还在，leet 替换才有
  // 意义），没命中才做严格白名单清洗，清洗完再查一次（清洗可能把原本被
  // 符号隔开的词粘到一起）。命中就把输入框清空、显示提示文字，返回空
  // 字符串交给调用方——提交给 start_run() 时空昵称会被服务端回退成
  // "匿名猫+随机数字"，前后端不需要各自维护一套随机数生成逻辑也能保持
  // 结果一致。不在每次按键时都做这个检查，否则打到一半的词（比如正在打
  // "Essex" 打到 "sex" 那一刻）就会被整个清空，体验很差。
  function enforceNicknameNotOffensive(inputEl, hintEl) {
    var raw = inputEl.value;
    if (isNicknameOffensive(raw)) {
      inputEl.value = "";
      hintEl.classList.remove("hidden");
      return "";
    }
    var cleaned = sanitizeNickname(raw);
    if (isNicknameOffensive(cleaned)) {
      inputEl.value = "";
      hintEl.classList.remove("hidden");
      return "";
    }
    inputEl.value = cleaned;
    hintEl.classList.add("hidden");
    return cleaned;
  }

  var lbSkinFilter = "";
  function buildLbFilter() {
    var html = '<button type="button" class="lb-chip on" data-skin="">全部</button>';
    window.CatArt.SKINS.forEach(function (k) {
      html += '<button type="button" class="lb-chip" data-skin="' + k.id + '" aria-label="' + k.name + '"><img alt="" src="' + window.CatArt.avatarDataUrl(k.id) + '"></button>';
    });
    dom.lbFilter.innerHTML = html;
    dom.lbFilter.addEventListener("click", function (e) {
      var b = e.target.closest ? e.target.closest(".lb-chip") : null;
      if (!b) return;
      lbSkinFilter = b.dataset.skin;
      var chips = dom.lbFilter.querySelectorAll(".lb-chip");
      for (var i = 0; i < chips.length; i++) chips[i].classList.toggle("on", chips[i] === b);
      sfx.click();
      loadTopScores();
    });
  }
  // ---- 排行榜渲染：按行 key 增量更新，数据不变时零 DOM 改动（不闪烁、不丢滚动位置） ----
  var regionNames = null;
  try { regionNames = new Intl.DisplayNames(["zh-CN"], { type: "region" }); } catch (e) { regionNames = null; }
  function flagOf(cc) {
    if (!cc || !/^[A-Z]{2}$/.test(cc)) return "";
    return String.fromCodePoint(0x1F1E6 + cc.charCodeAt(0) - 65, 0x1F1E6 + cc.charCodeAt(1) - 65);
  }
  function countryName(cc) {
    if (!cc) return "";
    try { return (regionNames && regionNames.of(cc)) || cc; } catch (e) { return cc; }
  }
  function setText(el, v) { v = String(v); if (el.textContent !== v) el.textContent = v; }
  function setAttr(el, k, v) { if (el.getAttribute(k) !== v) el.setAttribute(k, v); }
  function toggleCls(el, c, on) { if (el.classList.contains(c) !== on) el.classList.toggle(c, on); }

  var lbRows = new Map();   // key -> { el, parts, rank, score }
  var lbRenderedFilter = null, lbMessageEl = null;
  function lbKey(row) { return row.live_run_id != null ? "r" + row.live_run_id : "n" + (row.nickname || "") + "|" + row.skin; }
  function lbMakeRow() {
    var el = document.createElement("div");
    el.className = "lb-row";
    var p = {
      rank: document.createElement("span"), avatar: document.createElement("img"), name: document.createElement("span"),
      flag: document.createElement("span"), tag: document.createElement("span"), score: document.createElement("span")
    };
    p.rank.className = "lb-rank"; p.avatar.className = "lb-avatar"; p.avatar.alt = ""; p.name.className = "lb-name";
    p.flag.className = "lb-flag"; p.score.className = "lb-score";
    el.appendChild(p.rank); el.appendChild(p.avatar); el.appendChild(p.name); p.name.appendChild(p.flag);
    p.nameText = document.createTextNode(""); p.name.appendChild(p.nameText);
    el.appendChild(p.tag); el.appendChild(p.score);
    return { el: el, parts: p, rank: null, score: null };
  }
  function lbShowMessage(cls, text) {
    // 只在列表里没有任何行时显示提示（首次加载/空榜/首次失败）；刷新失败时保留旧数据
    if (lbRows.size > 0 && cls !== "lb-empty") return;
    lbRows.forEach(function (r) { r.el.remove(); }); lbRows.clear();
    if (!lbMessageEl) lbMessageEl = document.createElement("div");
    if (lbMessageEl.className !== cls) lbMessageEl.className = cls;
    setText(lbMessageEl, text);
    if (lbMessageEl.parentNode !== dom.leaderboardList || dom.leaderboardList.childNodes.length !== 1) {
      dom.leaderboardList.textContent = ""; dom.leaderboardList.appendChild(lbMessageEl);
    }
  }
  function lbRender(rows) {
    var list = dom.leaderboardList;
    if (lbMessageEl && lbMessageEl.parentNode === list) list.removeChild(lbMessageEl);
    var first = lbRows.size === 0;
    var seen = new Set();
    for (var i = 0; i < rows.length; i++) {
      var row = rows[i], key = lbKey(row);
      if (seen.has(key)) key += "#" + i;
      seen.add(key);
      var r = lbRows.get(key);
      if (!r) { r = lbMakeRow(); lbRows.set(key, r); }
      var p = r.parts;
      var rank = row.rank != null ? row.rank : i + 1;
      var skinId = SKIN_IDS.indexOf(row.skin) >= 0 ? row.skin : "orange";
      var myId = lbMode === "surv" ? survNet.lastId : run.id, isMe = myId != null && row.live_run_id === myId;
      var changed = !first && r.rank != null && (r.rank !== rank || r.score !== row.display_score);
      r.rank = rank; r.score = row.display_score;
      setText(p.rank, rank);
      var src = window.CatArt.avatarDataUrl(skinId);
      if (p.avatar.getAttribute("src") !== src) p.avatar.setAttribute("src", src);
      var nm = row.nickname || "匿名猫";
      if (p.nameText.nodeValue !== nm) p.nameText.nodeValue = nm;
      var fl = flagOf(row.country);
      setText(p.flag, fl);
      setAttr(p.flag, "title", fl ? countryName(row.country) : "");
      toggleCls(p.flag, "hidden", !fl);
      var tagCls = "", tagText = "";
      if (isMe) { tagCls = "lb-me-tag"; tagText = "我"; }
      else if (row.boss === "killed") { tagCls = "lb-badge boss"; tagText = "👑 屠王"; }
      else if (row.boss === "survived") { tagCls = "lb-badge dawn"; tagText = "🌅 黎明"; }
      else if (row.is_live) { tagCls = "lb-badge live"; tagText = "游戏中"; }
      else if (row.is_paused) { tagCls = "lb-badge paused"; tagText = "已暂停"; }
      if (p.tag.className !== tagCls) p.tag.className = tagCls;
      setText(p.tag, tagText);
      setText(p.score, row.display_score);
      toggleCls(r.el, "me", isMe);
      if (changed) {
        r.el.classList.remove("lb-changed"); void r.el.offsetWidth; r.el.classList.add("lb-changed");
        clearTimeout(r.hl); r.hl = setTimeout(function (el) { el.classList.remove("lb-changed"); }.bind(null, r.el), 1300);
      }
      var at = list.children[i];
      if (at !== r.el) list.insertBefore(r.el, at || null);
    }
    lbRows.forEach(function (r, key) { if (!seen.has(key)) { r.el.remove(); lbRows.delete(key); } });
  }
  var lbMode = SURV_ON ? "surv" : "classic";
  function lbEnsureModeTabs() {
    var host = document.getElementById("lbFilter"); if (!host) return;
    var tabs = document.getElementById("lbModeTabs");
    if (!tabs) {
      tabs = document.createElement("div"); tabs.id = "lbModeTabs"; tabs.className = "lb-modes"; tabs.setAttribute("role", "tablist");
      [["surv", "🌅 守卫榜"], ["classic", "经典榜（旧）"]].forEach(function (d) {
        var b = document.createElement("button"); b.type = "button"; b.dataset.mode = d[0]; b.textContent = d[1];
        b.onclick = function () { if (lbMode === d[0]) return; sfx.click(); lbMode = d[0]; loadTopScores(); };
        tabs.appendChild(b);
      });
      host.parentNode.insertBefore(tabs, host);
    }
    for (var i = 0; i < tabs.children.length; i++) tabs.children[i].classList.toggle("on", tabs.children[i].dataset.mode === lbMode);
  }
  function loadTopScores() {
    if (!backendConfigured) { lbShowMessage("lb-error", "排行榜未配置"); return; }
    lbEnsureModeTabs();
    if (lbRenderedFilter !== lbSkinFilter + "|" + lbMode) {
      lbRenderedFilter = lbSkinFilter + "|" + lbMode;
      lbRows.forEach(function (r) { r.el.remove(); }); lbRows.clear();
    }
    if (lbRows.size === 0) lbShowMessage("lb-loading", "加载中…");
    var filterAtRequest = lbSkinFilter;
    var lbPath = lbMode === "surv"
      ? "/rest/v1/surv_board?select=nickname,display_score,skin,rank,live_run_id,boss" + (lbSkinFilter ? "&skin=eq." + lbSkinFilter : "") + "&order=rank.asc&limit=" + LEADERBOARD_TOPN_LIMIT
      : "/rest/v1/leaderboard_live?select=nickname,display_score,is_live,is_paused,skin,rank,live_run_id,country" + (lbSkinFilter ? "&skin=eq." + lbSkinFilter : "") + "&order=rank.asc&limit=" + LEADERBOARD_TOPN_LIMIT;
    var modeAtRequest = lbMode;
    restGet(lbPath)
      .then(function (res) {
        if (filterAtRequest !== lbSkinFilter || modeAtRequest !== lbMode) return; // 期间切换了筛选，丢弃旧响应
        if (!res.ok) { lbShowMessage("lb-error", "暂时无法连接排行榜"); return; }
        if (res.rows.length === 0) { lbShowMessage("lb-empty", lbSkinFilter ? "这款小猫还没有人上榜" : "还没有人上榜，来当第一个吧！"); return; }
        lbRender(res.rows);
      });
  }

  // =======================================================================
  // Game state & UI wiring
  // =======================================================================

  var state = STATE_START;

  var dom = {
    hud: document.getElementById("hud"),
    scoreText: document.getElementById("scoreText"),
    comboText: document.getElementById("comboText"),
    rankText: document.getElementById("rankText"),
    pauseBtn: document.getElementById("pauseBtn"),
    hudLbBtn: document.getElementById("hudLbBtn"),
    lbSub: document.getElementById("lbSub"),
    muteBtn: document.getElementById("muteBtn"),
    endRunBtn: document.getElementById("endRunBtn"),
    startScreen: document.getElementById("startScreen"),
    bestScoreStart: document.getElementById("bestScoreStart"),
    nicknameInput: document.getElementById("nicknameInput"),
    nicknameHint: document.getElementById("nicknameHint"),
    startBtn: document.getElementById("startBtn"),
    showLeaderboardBtnStart: document.getElementById("showLeaderboardBtnStart"),
    pauseScreen: document.getElementById("pauseScreen"),
    resumeBtn: document.getElementById("resumeBtn"),
    confirmEndScreen: document.getElementById("confirmEndScreen"),
    confirmEndYesBtn: document.getElementById("confirmEndYesBtn"),
    confirmEndNoBtn: document.getElementById("confirmEndNoBtn"),
    resultScreen: document.getElementById("resultScreen"),
    resultScore: document.getElementById("resultScore"),
    resultCatches: document.getElementById("resultCatches"),
    resultDuration: document.getElementById("resultDuration"),
    resultCombo: document.getElementById("resultCombo"),
    resultBest: document.getElementById("resultBest"),
    resultRankStatus: document.getElementById("resultRankStatus"),
    nicknameInputResult: document.getElementById("nicknameInputResult"),
    nicknameHintResult: document.getElementById("nicknameHintResult"),
    showLeaderboardBtnResult: document.getElementById("showLeaderboardBtnResult"),
    restartBtn: document.getElementById("restartBtn"),
    homeBtn: document.getElementById("homeBtn"),
    leaderboardScreen: document.getElementById("leaderboardScreen"),
    leaderboardList: document.getElementById("leaderboardList"),
    leaderboardCloseBtn: document.getElementById("leaderboardCloseBtn"),
    abilityBadge: document.getElementById("abilityBadge"),
    abilityScreen: document.getElementById("abilityScreen"),
    abTabs: document.getElementById("abTabs"),
    abStages: document.getElementById("abStages"),
    abilityCloseBtn: document.getElementById("abilityCloseBtn"),
    lbFilter: document.getElementById("lbFilter")
  };

  var best = parseInt(storageGet("catmouse_best", "0"), 10) || 0;

  function updateMuteBtn() { dom.muteBtn.textContent = muted ? "🔇" : "🔊"; }
  updateMuteBtn();

  function showScreen(el) { el.classList.remove("hidden"); }
  function hideScreen(el) { el.classList.add("hidden"); }

  function enterStart() {
    state = STATE_START;
    hideScreen(dom.hud); var mm2 = document.getElementById("miniMap"); if (mm2) mm2.classList.add("hidden");
    hideScreen(dom.pauseScreen);
    hideScreen(dom.resultScreen);
    hideScreen(dom.confirmEndScreen);
    dom.bestScoreStart.textContent = String(best);
    dom.nicknameInput.value = ensureSavedNickname();
    dom.nicknameHint.classList.add("hidden");
    showScreen(dom.startScreen);
  }

  function beginRun() {
    ensureAudio();
    var nickname = enforceNicknameNotOffensive(dom.nicknameInput, dom.nicknameHint).trim();
    storageSet("catmouse_nickname", nickname);
    hideScreen(dom.startScreen);
    showScreen(dom.hud);
    resetWorld();
    resetScoring();
    bioReset();
    survReset(); survRefreshStats();
    resetAbilities();
    dom.abilityBadge.dataset.key = ""; updateSkillBadge(true);
    dom.comboText.classList.add("hidden");
    setText(dom.rankText, SURV_ON ? "守卫战" : "排名：未上榜");
    state = STATE_PLAY;
    if (SURV_ON) {
      run.id = null; run.offline = true; // 守卫战不走经典心跳
      try { survStartRun(nickname); } catch (e) {}
      bioShowBanner("拖动走位 · 点按冲刺 · 活到黎明", 2.6);
    } else startRun(nickname);
  }

  function requestEndRun() {
    // "结束本局"只出现在暂停浮层里（见 index.html），所以这里只需要在
    // STATE_PAUSE 下生效；取消时回到暂停浮层而不是直接恢复游戏。
    if (state !== STATE_PAUSE) return;
    sfx.click();
    hideScreen(dom.pauseScreen);
    showScreen(dom.confirmEndScreen);
  }

  function confirmEndRun() {
    hideScreen(dom.confirmEndScreen);
    enterResult();
  }

  function cancelEndRun() {
    hideScreen(dom.confirmEndScreen);
    showScreen(dom.pauseScreen);
  }

  function enterPause() {
    if (state !== STATE_PLAY) return;
    state = STATE_PAUSE;
    run.forceNext = true; // 尽快上报"已暂停"，让服务端跳过暂停期间的时长漂移检查
    showScreen(dom.pauseScreen);
  }

  function resumePlay() {
    if (state !== STATE_PAUSE) return;
    state = STATE_PLAY;
    run.forceNext = true;
    hideScreen(dom.pauseScreen);
  }

  function enterResult() {
    state = STATE_RESULT;
    if (typeof survHidePick === "function") survHidePick();
    hideScreen(dom.hud); var mm2 = document.getElementById("miniMap"); if (mm2) mm2.classList.add("hidden");
    var deathMutant = bioDeath === "mutant";
    var deathHorde = bioDeath === "horde" || bioDeath === "boss";
    var won = survActive() && surv && surv.won;
    bioDeath = null;
    if (SURV_ON && surv) {
      var local = Math.round(elapsedPlayTime * 100 + surv.kills * 10 + surv.level * 50 + (won ? 2000 : 0));
      score = Math.max(score, local);
      var fish = Math.round(surv.level * 5 + surv.kills / 10 + (won ? 50 : 0));
      try { storageSet("catmouse_fish", String(lsNum("catmouse_fish") + fish)); } catch (e) {}
    }
    if (score > best) { best = score; storageSet("catmouse_best", String(best)); }
    dom.resultScore.textContent = String(Math.round(score));
    dom.resultCatches.textContent = String(SURV_ON && surv ? surv.kills : catches);
    dom.resultDuration.textContent = String(Math.round(elapsedPlayTime));
    dom.resultCombo.textContent = String(comboMax);
    dom.resultBest.textContent = String(best);
    var rh = dom.resultScreen && dom.resultScreen.querySelector("h2");
    if (rh) rh.textContent = won ? (surv && surv.bossKilled ? "击败鼠王！黎明到了！" : "黎明到了！") : (deathHorde ? "被鼠潮围咬了…" : (deathMutant ? "被变异鼠搞定了…" : "本局结算"));
    if (SURV_ON && surv) {
      bestFlush();
      var head = (won ? "通关" : "失败") + " · Lv" + surv.level + " · 击杀 " + surv.kills + " · 🐟+" + fish;
      dom.resultRankStatus.textContent = head + " · 守卫榜上传中…";
      var info = { time: Math.floor(elapsedPlayTime), kills: surv.kills, level: surv.level, boss: won ? (surv.bossKilled ? "killed" : "survived") : "none" };
      survFinishRun(info, function (res) {
        if (state !== STATE_RESULT) return;
        if (res.ok && res.final_score != null) { dom.resultRankStatus.textContent = head + " · 守卫榜第 " + res.rank + " 名（" + res.final_score + " 分）"; dom.resultScore.textContent = String(res.final_score); }
        else if (res.networkError) dom.resultRankStatus.textContent = head + " · 未能连接守卫榜，成绩未上传";
        else dom.resultRankStatus.textContent = head + " · 成绩未入榜（" + (res.reason || "rejected") + "）";
      });
    } else dom.resultRankStatus.textContent = "结算中…";
    var rg = document.getElementById("resultGap"); if (rg) rg.classList.add("hidden");
    dom.nicknameInputResult.value = storageGet("catmouse_nickname", "");
    dom.nicknameHintResult.classList.add("hidden");
    missionsResult();
    showScreen(dom.resultScreen);
    sfx.endRun();
    if (!SURV_ON) finishRun();
  }

  var lbFromPlay = false, lbRefreshTimer = null;
  function openLeaderboard() {
    sfx.click();
    showScreen(dom.leaderboardScreen);
    loadTopScores();
  }
  // 局内查看排行榜：暂停游戏（心跳上报 paused），打开期间每 5 秒刷新，关闭后自动继续。
  function openInGameLeaderboard() {
    if (state !== STATE_PLAY) return;
    sfx.click();
    state = STATE_PAUSE;
    run.forceNext = true;
    lbFromPlay = true;
    dom.lbSub.classList.remove("hidden");
    showScreen(dom.leaderboardScreen);
    loadTopScores();
    lbRefreshTimer = setInterval(loadTopScores, 5000);
  }
  function closeLeaderboard() {
    hideScreen(dom.leaderboardScreen);
    dom.lbSub.classList.add("hidden");
    if (lbRefreshTimer) { clearInterval(lbRefreshTimer); lbRefreshTimer = null; }
    if (lbFromPlay) {
      lbFromPlay = false;
      if (state === STATE_PAUSE && dom.pauseScreen.classList.contains("hidden")) {
        state = STATE_PLAY;
        run.forceNext = true;
        refreshSnapshotIfDue(Date.now(), true);
      }
    }
  }

  // ---- v9 技能图鉴：点 Lv 徽章 → 暂停（与局内排行榜相同：心跳上报 paused）→ 关闭后继续 ----
  var abPanelTab = null, abFromPlay = false;
  function renderAbilityPanel() {
    var mine = ab ? ab.skin : currentSkin, tab = abPanelTab || mine, n = catches;
    dom.abTabs.innerHTML = "";
    window.CatArt.SKINS.forEach(function (k) {
      var b = document.createElement("button"); b.className = "ab-tab" + (k.id === tab ? " on" : "") + (k.id === mine ? " mine" : "");
      b.textContent = k.name + " " + skillOf(k.id).icon; b.setAttribute("role", "tab");
      b.addEventListener("click", function () { abPanelTab = k.id; renderAbilityPanel(); });
      dom.abTabs.appendChild(b);
    });
    var ub = document.createElement("button"); ub.className = "ab-tab" + (tab === "uni" ? " on" : ""); ub.textContent = "通用 🐾"; ub.setAttribute("role", "tab");
    ub.addEventListener("click", function () { abPanelTab = "uni"; renderAbilityPanel(); }); dom.abTabs.appendChild(ub);
    dom.abStages.innerHTML = "";
    if (tab === "uni") {
      var cu = stageFor(n), ut = document.createElement("div"); ut.className = "d"; ut.style.textAlign = "center";
      ut.textContent = "所有猫共享 · 本局已抓 " + n + " 只 · 通用 Lv" + cu + "（15/40/80/150 升级）"; dom.abStages.appendChild(ut);
      UNI_INFO.forEach(function (u) {
        var row = document.createElement("div"); row.className = "ab-st cur";
        row.innerHTML = '<span class="ic"></span><div class="tx"><b></b><span class="tag"></span><div class="d"></div><div class="d nx"></div></div>';
        row.querySelector(".ic").textContent = u.icon; row.querySelector("b").textContent = u.name + " Lv" + cu;
        row.querySelector(".tag").textContent = "⭐ 当前"; row.querySelector(".d").textContent = (cu > 1 ? u.lv[0] + " → " : "") + u.lv[cu - 1];
        row.querySelector(".nx").textContent = cu < 5 ? "🔒 Lv" + (cu + 1) + "（抓 " + STAGE_AT[cu] + " 只）：" + u.lv[cu] : "MAX";
        if (cu === 1) row.querySelector(".d").textContent = u.lv[0];
        dom.abStages.appendChild(row);
      });
      return;
    }
    var sk = skillOf(tab), cur = tab === mine ? stageFor(n) : 0;
    var title = document.createElement("div"); title.className = "d"; title.style.textAlign = "center";
    title.textContent = sk.icon + " " + sk.name + (tab === mine ? " · 本局已抓 " + n + " 只" : " · 抓到 0/15/40/80/150 只进化");
    dom.abStages.appendChild(title);
    for (var i = 0; i < 5; i++) {
      var lv = sk.lv[i], row = document.createElement("div");
      var unlocked = tab === mine && i + 1 <= cur, isCur = tab === mine && i + 1 === cur;
      row.className = "ab-st" + (isCur ? " cur" : unlocked ? "" : (tab === mine ? " lock" : ""));
      var tag = isCur ? "⭐ 当前" : unlocked ? "✅" : (tab === mine ? "🔒 抓 " + STAGE_AT[i] + " 只解锁" : "抓 " + STAGE_AT[i] + " 只");
      var bar = "";
      if (tab === mine && i + 1 === cur + 1) { var lo = STAGE_AT[i - 1] || 0, pct = Math.max(0, Math.min(100, (n - lo) / (STAGE_AT[i] - lo) * 100)); bar = '<div class="bar"><i style="width:' + pct.toFixed(0) + '%"></i></div><div class="d">' + n + " / " + STAGE_AT[i] + "</div>"; }
      row.innerHTML = '<span class="ic"></span><div class="tx"><b></b><span class="tag"></span><div class="d"></div>' + bar + "</div>";
      row.querySelector(".ic").textContent = lv[0]; row.querySelector("b").textContent = "Lv" + (i + 1) + " " + lv[1];
      row.querySelector(".tag").textContent = tag; row.querySelector(".d").textContent = lv[2];
      dom.abStages.appendChild(row);
    }
  }
  function openAbilityPanel() {
    if (state !== STATE_PLAY) return;
    sfx.click();
    state = STATE_PAUSE; run.forceNext = true; abFromPlay = true; abPanelTab = null; moveDir.x = 0; moveDir.y = 0; activePointerId = null;
    renderAbilityPanel(); showScreen(dom.abilityScreen); if (CA.sfx.panel) CA.sfx.panel(true);
  }
  function closeAbilityPanel() {
    hideScreen(dom.abilityScreen); if (CA.sfx.panel) CA.sfx.panel(false);
    if (abFromPlay) {
      abFromPlay = false;
      if (state === STATE_PAUSE && dom.pauseScreen.classList.contains("hidden")) { state = STATE_PLAY; run.forceNext = true; }
    }
  }
  dom.abilityBadge.addEventListener("click", function (e) { e.stopPropagation(); openAbilityPanel(); });
  dom.abilityBadge.addEventListener("keydown", function (e) { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); openAbilityPanel(); } });
  ["pointerdown", "touchstart", "mousedown"].forEach(function (ev) {
    dom.abilityBadge.addEventListener(ev, function (e) { e.stopPropagation(); }, { passive: true });
  });
  dom.abilityCloseBtn.addEventListener("click", function () { closeAbilityPanel(); });
  (function () {
    var mm = document.getElementById("miniMap"); if (!mm) return;
    ["pointerdown", "touchstart", "mousedown"].forEach(function (ev) { mm.addEventListener(ev, function (e) { e.stopPropagation(); }, { passive: true }); });
    mm.addEventListener("click", function (e) { e.stopPropagation(); openMap(); });
    mm.addEventListener("keydown", function (e) { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); openMap(); } });
    document.getElementById("mapCloseBtn").addEventListener("click", closeMap);
  })();
  // 音频设置（暂停面板）：音乐/音效分开开关 + 音量，存 localStorage
  (function () {
    var S = CA.settings, q = function (id) { return document.getElementById(id); };
    if (!q("bgmOn")) return;
    q("bgmOn").checked = S.bgmOn !== false; q("sfxOn").checked = S.sfxOn !== false; q("bgmVol").value = S.bgmVol == null ? 50 : S.bgmVol; q("sfxVol").value = S.sfxVol == null ? 80 : S.sfxVol;
    q("bgmOn").addEventListener("change", function () { CA.set("bgmOn", this.checked); });
    q("sfxOn").addEventListener("change", function () { CA.set("sfxOn", this.checked); sfx.click(); });
    q("bgmVol").addEventListener("input", function () { CA.set("bgmVol", +this.value); });
    q("sfxVol").addEventListener("change", function () { CA.set("sfxVol", +this.value); sfx.click(); });
  })();
  (function () {
    var q = function (id) { return document.getElementById(id); };
    [["shakeOn", "catmouse_shake", function (v) { shakeOn = v; if (v) feedback("land"); }],
     ["reduceMotion", "catmouse_reduce_motion", function (v) { reducedMotion = v; document.body.classList.toggle("reduce-motion", v); }],
     ["cbMode", "catmouse_cb", function (v) { cbMode = v; }]].forEach(function (c) {
      var el = q(c[0]); if (!el) return;
      el.checked = { shakeOn: shakeOn, reduceMotion: reducedMotion, joystickOn: joystickOn, cbMode: cbMode }[c[0]];
      el.addEventListener("change", function () { lsSetBool(c[1], this.checked); c[2](this.checked); sfx.click(); });
    });
    document.body.classList.toggle("reduce-motion", reducedMotion);
  })();
  // ---- 首局新手引导（只出现一次）：开始第一局前 3 步说明 ----
  var ONBOARD_STEPS = [
    ["👆", "全靠手势，屏幕上没有按钮", "✋ 按住拖动：小猫跟着手指跑\n🐭 轻点老鼠：锁定，自动追上去放招牌扑\n🚩 轻点空地：跑到那里\n✌️ 两指轻点：暂停（切后台自动暂停）\n屏外老鼠看屏幕边缘的小箭头。"]
  ];
  function maybeOnboard(next) {
    var el = document.getElementById("onboardScreen");
    if (!el || lsBool("catmouse_onboard3_done", false)) { next(); return; }
    var i = 0;
    function render() {
      var st = ONBOARD_STEPS[i];
      el.querySelector(".ob-ic").textContent = st[0]; el.querySelector(".ob-t").textContent = st[1]; el.querySelector(".ob-d").textContent = st[2];
      el.querySelector(".ob-dots").textContent = ONBOARD_STEPS.map(function (_, k) { return k === i ? "●" : "○"; }).join(" ");
      el.querySelector("#onboardNext").textContent = i < ONBOARD_STEPS.length - 1 ? "下一步" : "开始抓老鼠 🐾";
    }
    function done() { lsSetBool("catmouse_onboard3_done", true); hideScreen(el); next(); }
    el.querySelector("#onboardNext").onclick = function () { sfx.click(); if (++i >= ONBOARD_STEPS.length) done(); else render(); };
    el.querySelector("#onboardSkip").onclick = function () { sfx.click(); done(); };
    render(); showScreen(el); el.querySelector("#onboardNext").focus();
  }
  // 第一次点按/按键时解锁音频（iOS 需要在用户手势里）
  ["pointerdown", "touchend", "keydown"].forEach(function (ev) { document.addEventListener(ev, function () { ensureAudio(); }, { passive: true, capture: true }); });

  document.addEventListener("visibilitychange", function () {
    if (document.hidden && state === STATE_PLAY) enterPause();
  });

  dom.startBtn.addEventListener("click", function () { maybeOnboard(beginRun); });
  dom.pauseBtn.addEventListener("click", function () { sfx.click(); enterPause(); });
  dom.resumeBtn.addEventListener("click", function () { sfx.click(); resumePlay(); });
  dom.muteBtn.addEventListener("click", function () { ensureAudio(); toggleMute(); });
  dom.endRunBtn.addEventListener("click", requestEndRun);
  dom.confirmEndYesBtn.addEventListener("click", confirmEndRun);
  dom.confirmEndNoBtn.addEventListener("click", cancelEndRun);
  dom.restartBtn.addEventListener("click", function () { hideScreen(dom.resultScreen); beginRun(); });
  dom.homeBtn.addEventListener("click", function () { hideScreen(dom.resultScreen); enterStart(); });
  dom.nicknameInput.addEventListener("input", function () {
    dom.nicknameInput.value = sanitizeNicknameLive(dom.nicknameInput.value);
  });
  dom.nicknameInput.addEventListener("blur", function () {
    enforceNicknameNotOffensive(dom.nicknameInput, dom.nicknameHint);
  });
  dom.nicknameInputResult.addEventListener("input", function () {
    dom.nicknameInputResult.value = sanitizeNicknameLive(dom.nicknameInputResult.value);
  });
  dom.nicknameInputResult.addEventListener("blur", function () {
    enforceNicknameNotOffensive(dom.nicknameInputResult, dom.nicknameHintResult);
  });
  dom.nicknameInputResult.addEventListener("change", function () {
    var nickname = enforceNicknameNotOffensive(dom.nicknameInputResult, dom.nicknameHintResult).trim();
    storageSet("catmouse_nickname", nickname);
  });
  dom.showLeaderboardBtnStart.addEventListener("click", openLeaderboard);
  dom.showLeaderboardBtnResult.addEventListener("click", openLeaderboard);
  dom.leaderboardCloseBtn.addEventListener("click", closeLeaderboard);
  dom.hudLbBtn.addEventListener("click", openInGameLeaderboard);
  // v19：排行榜/技能/全图/声音 只在暂停菜单
  function fromPause(fn) { return function () { sfx.click(); if (state !== STATE_PAUSE) return; hideScreen(dom.pauseScreen); state = STATE_PLAY; fn(); }; }
  (function () {
    var b1 = document.getElementById("pauseLbBtn"), b2 = document.getElementById("pauseAbBtn"), b3 = document.getElementById("pauseMapBtn"), b4 = document.getElementById("pauseMuteBtn");
    if (b1) b1.onclick = fromPause(openInGameLeaderboard); if (b2) b2.onclick = fromPause(openAbilityPanel); if (b3) b3.onclick = fromPause(openMap);
    if (b4) { var upd = function () { b4.textContent = muted ? "🔇 已静音" : "🔊 声音"; }; b4.onclick = function () { ensureAudio(); toggleMute(); upd(); }; upd(); }
  })();
  // 按钮上的按下事件不传给画布，避免误移动小猫
  ["pointerdown", "touchstart", "mousedown"].forEach(function (ev) {
    dom.hudLbBtn.addEventListener(ev, function (e) { e.stopPropagation(); }, { passive: true });
  });

  // =======================================================================
  // Main loop
  // =======================================================================

  function updateHud() {
    setText(dom.scoreText, "🐭 " + catches);
    if (ab) { toggleCls(dom.abilityBadge, "flash", ab.flash > 0); updateSkillBadge(false); }
    if (combo >= 2) {
      dom.comboText.classList.remove("hidden");
      setText(dom.comboText, "连击 x" + combo);
      dom.comboText.style.setProperty("--cb", (comboTimer / COMBO_WINDOW).toFixed(2));
      var tier = combo >= 20 ? 3 : combo >= 10 ? 2 : combo >= 5 ? 1 : 0;
      if (dom.comboText._tier !== tier) { dom.comboText._tier = tier; dom.comboText.className = "tier" + tier + (dom.comboText.classList.contains("tier-pop") ? " tier-pop" : ""); }
    } else {
      dom.comboText.classList.add("hidden"); dom.comboText._tier = -1;
    }
  }

  // =======================================================================
  // 地图 / 老鼠窝 / 昼夜 / 蹲窝便便（MAP_NEST.md，数值为初始值，未经平衡）
  // =======================================================================
  var MAP_HALF = 1500, FENCE_T = 80;
  var NEST_START = 8, NEST_MAX = 10, NEST_MIN_SPAWN_D = 500, NEST_SPACING = 450, NEST_EDGE = 150, NEST_RESPAWN = 45, NEST_ADD_EVERY = 90;
  var NEST_DAY_IV = 2.5, NEST_NIGHT_IV = 1.4, NEST_OWN_MAX = 12, NEST_ROAM = 350, NIGHT_CAP = 240;
  var DAY_T = 120, DUSK_T = 8, NIGHT_T = 60, DAWN_T = 8, CYCLE_T = DAY_T + DUSK_T + NIGHT_T + DAWN_T;
  var NEST_HIDE_R = 220, NEST_HIDE_R_NIGHT = 160, NEST_STORE_MAX = 6; // 猫靠近窝：停止出鼠、鼠在窝里攒着（初始值，未平衡）
  var NEST_BREAK_MIN = 20, NEST_HIT_R = 70, NEST_SCORE = 30, nestPoopAnim = null;
  var FENCES = [
    { x: -MAP_HALF - FENCE_T, y: -MAP_HALF - FENCE_T, w: 2 * MAP_HALF + 2 * FENCE_T, h: FENCE_T, kind: "fence" },
    { x: -MAP_HALF - FENCE_T, y: MAP_HALF, w: 2 * MAP_HALF + 2 * FENCE_T, h: FENCE_T, kind: "fence" },
    { x: -MAP_HALF - FENCE_T, y: -MAP_HALF, w: FENCE_T, h: 2 * MAP_HALF, kind: "fence" },
    { x: MAP_HALF, y: -MAP_HALF, w: FENCE_T, h: 2 * MAP_HALF, kind: "fence" }
  ];
  var nests = [], poops = [], nestStats = { destroyed: 0 }, nestAddT = 0, ownRecount = 0;
  function nearEdge(x, y, m) { return x < -MAP_HALF + m || x > MAP_HALF - m || y < -MAP_HALF + m || y > MAP_HALF - m; }
  // 昼夜：返回 { night: 0..1, phase: "day"|"dusk"|"night"|"dawn", left: 秒 }
  function dayInfo() {
    var t = elapsedPlayTime % CYCLE_T;
    if (t < DAY_T) return { night: 0, phase: "day", left: DAY_T - t };
    t -= DAY_T; if (t < DUSK_T) return { night: t / DUSK_T, phase: "dusk", left: DUSK_T - t + NIGHT_T };
    t -= DUSK_T; if (t < NIGHT_T) return { night: 1, phase: "night", left: NIGHT_T - t };
    t -= NIGHT_T; return { night: 1 - t / DAWN_T, phase: "dawn", left: DAWN_T - t + DAY_T };
  }
  var dayNow = { night: 0, phase: "day", left: DAY_T };
  function nestSpotOk(x, y, spacing, minCat) {
    if (nearEdge(x, y, NEST_EDGE)) return false;
    if (Math.sqrt(x * x + y * y) < NEST_MIN_SPAWN_D) return false;
    if (TERR && (TERR.blocked(x, y, 120) || !TERR.reachable(x, y) || TERR.inCross(x, y, -150))) return false; // v17：只在草地、可达、离桥头远
    if (minCat && distance(x, y, cat.x, cat.y) < minCat) return false;
    for (var i = 0; i < nests.length; i++) if (nests[i].alive && distance(x, y, nests[i].x, nests[i].y) < spacing) return false;
    var c = worldToChunk(x, y); for (var dy = -1; dy <= 1; dy++) for (var dx = -1; dx <= 1; dx++) getChunk(c.cx + dx, c.cy + dy);
    return !inObstacle(x, y, 40 + 30);
  }
  function placeNest(minCat) {
    var spacing = NEST_SPACING;
    for (var tries = 0; tries < 400; tries++) {
      if (tries === 200) spacing = 350;
      var x = (Math.random() * 2 - 1) * (MAP_HALF - NEST_EDGE), y = (Math.random() * 2 - 1) * (MAP_HALF - NEST_EDGE);
      if (nestSpotOk(x, y, spacing, minCat)) return { x: x, y: y };
    }
    return null;
  }
  function nestsInit() {
    nests.length = 0; poops.length = 0; nestStats.destroyed = 0; nestPoopAnim = null; nestAddT = 0;
    for (var i = 0; i < NEST_START; i++) { var p = placeNest(0); if (p) nests.push(newNest(p)); }
  }
  function newNest(p) { return { x: p.x, y: p.y, alive: true, t: Math.random() * 1.5, owned: 0, silT: 0, deadT: 0, born: elapsedPlayTime, prefilled: false, flash: 0, hide: false, hideT: 0, stored: 0, burstT: 0, infected: false, infectFlash: 0, maxHits: 3, hitsLeft: 3, hitFlash: 0, destroying: false }; }
  function nestSpawnOne(n, t) {
    var a = randomAngle(), d = 18 + Math.random() * 14, x = n.x + Math.cos(a) * d, y = n.y + 18 + Math.abs(Math.sin(a)) * d;
    var beh = pickBeh(t);
    if (beh === "flock") { var k = 4 + Math.floor(Math.random() * 5); spawnPack({ x: x, y: y }, k, t); for (var j = mice.length - k; j < mice.length; j++) if (mice[j]) { mice[j].nest = n; mice[j].home = n; applyMutantRoll(mice[j], n); } n.owned += k; return; }
    var m = spawnMouseAt(x, y, typeForBeh(beh, t), t, beh); m.nest = n; m.home = n; if (beh === "burrow") m.hole = { x: n.x, y: n.y }; applyMutantRoll(m, n); n.owned++;
  }
  function mouseCap() { if (SURV_ON && survIsWeak()) return 120; return dayNow.night > 0 && resScale > 0.6 ? Math.round(lerp(180, NIGHT_CAP, dayNow.night)) : 180; }
  function nestSpawn(dt) {
    if (noSpawn) return;
    var t = currentDifficulty(), R = viewRadiusWorld() + 300, cap = mouseCap();
    var iv = lerp(NEST_DAY_IV, NEST_NIGHT_IV, dayNow.night) / (survActive() && surv.spawnMult ? surv.spawnMult : 1);
    for (var i = 0; i < nests.length; i++) {
      var n = nests[i]; if (!n.alive) continue;
      var dc = distance(n.x, n.y, cat.x, cat.y), hr = (dayNow.night > 0.5 ? NEST_HIDE_R_NIGHT : NEST_HIDE_R) * entityScaleMult;
      if (dc < hr) { // 猫在窝边：不出鼠，老鼠在窝里攒着（最多 6 只）
        if (!n.hide) { n.hide = true; n.hideT = 0; }
        n.hideT += dt; n.t -= dt;
        if (n.t <= 0) { n.t = iv; if (n.stored < NEST_STORE_MAX && n.owned + n.stored < NEST_OWN_MAX) n.stored++; }
        continue;
      }
      if (n.hide) { n.hide = false; if (n.stored > 0) nestBurst(n, t, cap); }
      if (n.silT > 0) { n.silT -= dt; continue; }
      if (dc > R) continue; // 远处的窝休眠（性能）
      if (!n.prefilled) { n.prefilled = true; for (var k = 0; k < 4 && mice.length < cap; k++) nestSpawnOne(n, t); }
      n.t -= dt;
      if (n.t <= 0) { n.t = iv; if (n.owned < NEST_OWN_MAX && mice.length < cap) nestSpawnOne(n, t); }
    }
  }
  function nestBurst(n, t, cap) { // 猫走开：攒着的老鼠一下子全冲出来
    var k = n.stored; n.stored = 0; n.burstT = 0.6; n.prefilled = true;
    for (var i = 0; i < k && mice.length < cap; i++) {
      var a = Math.PI / 2 + (i - (k - 1) / 2) * 0.6 + (Math.random() - 0.5) * 0.2, beh = pickBeh(t); if (beh === "flock") beh = "wander";
      var m = spawnMouseAt(n.x + Math.cos(a) * 16, n.y + 14 + Math.abs(Math.sin(a)) * 10, typeForBeh(beh, t), t, beh);
      m.nest = n; m.home = n; if (beh === "burrow") m.hole = { x: n.x, y: n.y }; applyMutantRoll(m, n); n.owned++;
      var sp = (m.speed || 120) * 1.6; m.vx = Math.cos(a) * sp; m.vy = Math.sin(a) * sp;
    }
    if (CA.sfx.nest) CA.sfx.nest("burst");
  }
  function silenceNests(x, y, r, secs) { for (var i = 0; i < nests.length; i++) if (nests[i].alive && distance(nests[i].x, nests[i].y, x, y) < r) nests[i].silT = Math.max(nests[i].silT, secs); }
  function nestNear(x, y, r) { for (var i = 0; i < nests.length; i++) { var n = nests[i]; if (n.alive && distance(n.x, n.y, x, y) < r) return n; } return null; }
  function destroyNest(n) {
    n.alive = false; n.deadT = 0; n.destroying = false; nestStats.destroyed++; n.stored = 0; n.hide = false;
    poops.push({ x: n.x + 26, y: n.y + 16, age: 0 });
    score += NEST_SCORE; spawnScorePopup(n.x, n.y - 30, NEST_SCORE);
    for (var i = 0; i < mice.length; i++) { var m = mice[i]; if (m.nest === n) { m.nest = null; if (distance(m.x, m.y, n.x, n.y) < NEST_ROAM) { startFlee(m, 4); m.home = null; } } }
    if (lock && lock.nest === n) lock = null;
    if (CA.sfx.nest) CA.sfx.nest("poop"); feedback("wave");
    maybeSendHeartbeat(Date.now());
  }
  function hitNest(n) {
    if (SURV_ON) return false; // M1：不拆窝
    if (!n || !n.alive || n.destroying) return false;
    if (elapsedPlayTime < NEST_BREAK_MIN) { bioShowBanner("开局 " + Math.ceil(NEST_BREAK_MIN - elapsedPlayTime) + "s 后可拆窝", 1.2); return false; }
    n.hitsLeft = Math.max(0, (n.hitsLeft || n.maxHits || 3) - 1); n.hitFlash = 0.25;
    sigFxAdd({ type: "smoke", x: n.x, y: n.y }); buzz(14); hitStopT = Math.max(hitStopT, 0.05);
    if (n.hitsLeft <= 0) { startNestPoopAnim(n); return true; }
    return true;
  }
  function startNestPoopAnim(n) {
    n.destroying = true; nestPoopAnim = { n: n, t: 0, dur: 1.1 };
    clearTargets(); if (sig) sig = null; moveDir.x = 0; moveDir.y = 0;
    bio.iFrames = Math.max(bio.iFrames, 1.2);
    if (CA.sfx.nest) CA.sfx.nest("strain");
  }
  function nestPoopUpdate(dt) {
    if (!nestPoopAnim) return;
    var A = nestPoopAnim, n = A.n; A.t += dt;
    cat.x += (n.x - cat.x) * Math.min(1, dt * 10); cat.y += (n.y - 16 - cat.y) * Math.min(1, dt * 10);
    if (A.t > 0.35 && A.t - dt <= 0.35 && CA.sfx.nest) CA.sfx.nest("strain");
    if (A.t >= A.dur) { nestPoopAnim = null; destroyNest(n); }
  }
  function nestUpdate(dt) {
    dayNow = dayInfo();
    if (CA.setNight) CA.setNight(dayNow.night > 0.5);
    nestSpawn(dt);
    // 每 0.5s 重新统计每个窝在外面的老鼠数（被吃/回收/装箱都会自动扣掉）
    ownRecount -= dt;
    if (ownRecount <= 0) { ownRecount = 0.5; for (var i = 0; i < nests.length; i++) nests[i].owned = 0; for (i = 0; i < mice.length; i++) if (mice[i].nest) mice[i].nest.owned++; }
    // 重生 + 补到上限
    for (i = 0; i < nests.length; i++) {
      var n = nests[i];
      if (n.flash > 0) n.flash -= dt;
      if (n.burstT > 0) n.burstT -= dt;
      if (!n.alive) { n.deadT += dt; if (n.deadT >= NEST_RESPAWN) { var p = placeNest(600); if (p) { n.x = p.x; n.y = p.y; n.alive = true; n.t = 1; n.owned = 0; n.stored = 0; n.hide = false; n.prefilled = false; n.flash = 2; n.infected = false; n.infectFlash = 0; n.maxHits = 3; n.hitsLeft = 3; n.hitFlash = 0; n.destroying = false; if (CA.sfx.nest) CA.sfx.nest("respawn"); } else n.deadT = NEST_RESPAWN - 5; } }
    }
    nestAddT += dt;
    if (nestAddT >= NEST_ADD_EVERY) { nestAddT = 0; if (nests.length < NEST_MAX) { var q = placeNest(600); if (q) { var nn = newNest(q); nn.flash = 2; nests.push(nn); } } }
    for (i = poops.length - 1; i >= 0; i--) { poops[i].age += dt; if (poops[i].age > 10) poops.splice(i, 1); }
    for (i = 0; i < nests.length; i++) if (nests[i].hitFlash > 0) nests[i].hitFlash -= dt;
    nestPoopUpdate(dt);
  }
  function poopSitting() { return !!nestPoopAnim; } // 销毁演出硬直（复用旧门闩）
  // 老鼠在窝附近 350 内游荡
  function homePull(m) {
    var h = m.home; if (!h || m.state !== "wander" || m.asleep || m.packId) return;
    if (!h.alive) { m.home = null; return; }
    var dx = h.x - m.x, dy = h.y - m.y, d = Math.sqrt(dx * dx + dy * dy);
    if (d > NEST_ROAM * entityScaleMult) { var sp = Math.sqrt(m.vx * m.vx + m.vy * m.vy) || m.speed * 0.5; m.vx = dx / d * sp; m.vy = dy / d * sp; }
  }
  function clampCamera() {
    var hw = W / (2 * SCALE), hh = H / (2 * SCALE);
    var lx = MAP_HALF + FENCE_T * 0.5 - hw, ly = MAP_HALF + FENCE_T * 0.5 - hh;
    camera.x = lx > 0 ? clamp(camera.x, -lx, lx) : 0; camera.y = ly > 0 ? clamp(camera.y, -ly, ly) : 0;
  }

  // ---- 美术：Q 版老鼠窝 / 便便 / 篱笆（离屏缓存） ----
  var nestSprCache = {};
  function imgSpr(name, w, ox, oy) { var im = IMG[name]; if (!im) return null; if (!im._w) { im._w = w; im._h = w * im.height / im.width; im._ox = ox * w; im._oy = oy * im._h; } return im; }
  function nestSprite(dead, px) {
    var pi = dead ? imgSpr("nest_dead", 110, 0.5, 0.55) : imgSpr("nest", 112, 0.41, 0.74); if (pi) return pi;
    var key = (dead ? "d" : "a") + "|" + Math.round(px * 10) + "|" + DPR;
    if (nestSprCache[key]) return nestSprCache[key];
    var sc = px * DPR, c = document.createElement("canvas"); c.width = Math.ceil(120 * sc); c.height = Math.ceil(100 * sc);
    var g = c.getContext("2d"); g.scale(sc, sc); g.translate(60, 62); g.lineJoin = "round"; g.lineCap = "round";
    // 投影
    g.fillStyle = "rgba(40,90,30,.22)"; g.beginPath(); g.ellipse(0, 22, 54, 13, 0, 0, 7); g.fill();
    if (!dead) {
      // 土丘（圆润，带高光）
      var gr = g.createLinearGradient(0, -40, 0, 22); gr.addColorStop(0, "#e2a66a"); gr.addColorStop(1, "#b97842");
      g.fillStyle = gr; g.strokeStyle = "#7d4c26"; g.lineWidth = 3.5;
      g.beginPath(); g.moveTo(-50, 18); g.bezierCurveTo(-52, -20, -26, -42, 0, -42); g.bezierCurveTo(26, -42, 52, -20, 50, 18); g.quadraticCurveTo(0, 28, -50, 18); g.closePath(); g.fill(); g.stroke();
      g.fillStyle = "rgba(255,240,210,.45)"; g.beginPath(); g.ellipse(-18, -26, 14, 6, -0.5, 0, 7); g.fill();
      // 草叶
      g.strokeStyle = "#5fae4a"; g.lineWidth = 3;
      [[-34, -22, -40, -34], [-30, -24, -27, -38], [22, -34, 18, -48], [26, -33, 32, -46], [40, -10, 50, -18]].forEach(function (l) { g.beginPath(); g.moveTo(l[0], l[1]); g.quadraticCurveTo(l[0] + (l[2] - l[0]) * 0.3, l[3] + 6, l[2], l[3]); g.stroke(); });
      // 小石子
      g.fillStyle = "#cdbca6"; g.beginPath(); g.ellipse(32, 8, 5, 3.5, 0, 0, 7); g.ellipse(-36, 6, 4, 3, 0, 0, 7); g.fill();
      // 拱形门洞 + 木门框
      g.fillStyle = "#3b2416"; g.beginPath(); g.moveTo(-17, 16); g.lineTo(-17, -2); g.arc(0, -2, 17, Math.PI, 0); g.lineTo(17, 16); g.quadraticCurveTo(0, 20, -17, 16); g.fill();
      g.strokeStyle = "#a0683a"; g.lineWidth = 4; g.beginPath(); g.moveTo(-19, 16); g.lineTo(-19, -2); g.arc(0, -2, 19, Math.PI, 0); g.lineTo(19, 16); g.stroke();
      // 门里一对发亮小眼睛
      g.fillStyle = "#fff"; g.beginPath(); g.arc(-6, 2, 2.6, 0, 7); g.arc(6, 2, 2.6, 0, 7); g.fill();
      g.fillStyle = "#ffb3c6"; g.beginPath(); g.ellipse(0, 8, 2.4, 1.6, 0, 0, 7); g.fill();
      // 奶酪小旗
      g.strokeStyle = "#7d4c26"; g.lineWidth = 2.5; g.beginPath(); g.moveTo(30, -26); g.lineTo(30, -58); g.stroke();
      g.fillStyle = "#ffd23f"; g.strokeStyle = "#d39a1c"; g.lineWidth = 1.8; g.beginPath(); g.moveTo(31, -58); g.lineTo(52, -50); g.lineTo(31, -42); g.closePath(); g.fill(); g.stroke();
      g.fillStyle = "#e9b52a"; g.beginPath(); g.arc(38, -51, 2, 0, 7); g.arc(43, -48, 1.4, 0, 7); g.fill();
    } else {
      // 塌掉的窝：扁平灰土堆 + 裂纹 + 倒下的旗
      g.fillStyle = "#b6a58e"; g.strokeStyle = "#7c6c58"; g.lineWidth = 3;
      g.beginPath(); g.moveTo(-52, 18); g.bezierCurveTo(-46, -6, -20, -14, 0, -12); g.bezierCurveTo(22, -14, 48, -6, 52, 18); g.quadraticCurveTo(0, 26, -52, 18); g.closePath(); g.fill(); g.stroke();
      g.strokeStyle = "#7c6c58"; g.lineWidth = 2.2; g.beginPath(); g.moveTo(-20, -6); g.lineTo(-12, 2); g.lineTo(-18, 10); g.moveTo(10, -9); g.lineTo(16, 0); g.lineTo(12, 8); g.stroke();
      g.fillStyle = "#3b2416"; g.beginPath(); g.ellipse(0, 12, 10, 3.5, 0, 0, 7); g.fill();
      g.strokeStyle = "#7d4c26"; g.lineWidth = 2.5; g.beginPath(); g.moveTo(30, 14); g.lineTo(52, 4); g.stroke();
      g.fillStyle = "#e6c35a"; g.beginPath(); g.moveTo(52, 4); g.lineTo(60, 18); g.lineTo(46, 14); g.closePath(); g.fill();
    }
    c._w = 120; c._h = 100; c._ox = 60; c._oy = 62;
    return (nestSprCache[key] = c);
  }
  var poopSprCache = {};
  function poopSprite(px) {
    var pi = imgSpr("poop", 54, 0.5, 0.9); if (pi) return pi;
    var key = Math.round(px * 10) + "|" + DPR; if (poopSprCache[key]) return poopSprCache[key];
    var sc = px * DPR, c = document.createElement("canvas"); c.width = Math.ceil(64 * sc); c.height = Math.ceil(64 * sc);
    var g = c.getContext("2d"); g.scale(sc, sc); g.translate(32, 50); g.lineJoin = "round";
    g.fillStyle = "rgba(60,40,20,.2)"; g.beginPath(); g.ellipse(0, 6, 26, 6, 0, 0, 7); g.fill();
    var tiers = [[0, 0, 26, 11, "#8b5a2b"], [0, -13, 20, 9.5, "#9b6633"], [0, -25, 13, 8, "#ad7440"]];
    tiers.forEach(function (e) { g.fillStyle = e[4]; g.strokeStyle = "#5a3818"; g.lineWidth = 2.4; g.beginPath(); g.ellipse(e[0], e[1], e[2], e[3], 0, 0, 7); g.fill(); g.stroke(); g.fillStyle = "rgba(255,230,200,.35)"; g.beginPath(); g.ellipse(e[0] - e[2] * 0.4, e[1] - e[3] * 0.35, e[2] * 0.3, e[3] * 0.28, -0.3, 0, 7); g.fill(); });
    g.fillStyle = "#ad7440"; g.strokeStyle = "#5a3818"; g.lineWidth = 2.2; g.beginPath(); g.moveTo(-4, -31); g.quadraticCurveTo(0, -46, 9, -40); g.quadraticCurveTo(5, -34, -4, -31); g.fill(); g.stroke();
    g.fillStyle = "#2a190c"; g.beginPath(); g.arc(-7, -3, 2.8, 0, 7); g.arc(7, -3, 2.8, 0, 7); g.fill();
    g.fillStyle = "#fff"; g.beginPath(); g.arc(-6, -4, 1.1, 0, 7); g.arc(8, -4, 1.1, 0, 7); g.fill();
    g.strokeStyle = "#2a190c"; g.lineWidth = 1.8; g.beginPath(); g.arc(0, 1, 3.6, 0.15, Math.PI - 0.15); g.stroke();
    g.fillStyle = "rgba(255,120,150,.6)"; g.beginPath(); g.ellipse(-13, 2, 3.6, 2.2, 0, 0, 7); g.ellipse(13, 2, 3.6, 2.2, 0, 0, 7); g.fill();
    c._w = 64; c._h = 64; c._ox = 32; c._oy = 50;
    return (poopSprCache[key] = c);
  }
  function blitSpr(c, sx, sy, scale, alpha) {
    if (alpha != null) ctx.globalAlpha = alpha;
    if (c._n) { ctx.drawImage(fit(c, c._h * scale), sx - c._ox * scale, sy - c._oy * scale, c._w * scale, c._h * scale); if (alpha != null) ctx.globalAlpha = 1; return; }
    ctx.drawImage(c, sx - c._ox * scale, sy - c._oy * scale, c._w * scale, c._h * scale);
    if (alpha != null) ctx.globalAlpha = 1;
  }
  function drawFences() {
    var hw = W / (2 * SCALE) + 60, hh = H / (2 * SCALE) + 60;
    if (!nearEdge(camera.x, camera.y, Math.max(hw, hh) + 80)) return;
    // 地图外：深一点的草地
    ctx.fillStyle = "rgba(60,110,50,.45)";
    var L = worldToScreenX(-MAP_HALF), R = worldToScreenX(MAP_HALF), T = worldToScreenY(-MAP_HALF), B = worldToScreenY(MAP_HALF);
    if (L > 0) ctx.fillRect(0, 0, L, H); if (R < W) ctx.fillRect(R, 0, W - R, H); if (T > 0) ctx.fillRect(Math.max(0, L), 0, Math.min(W, R) - Math.max(0, L), T); if (B < H) ctx.fillRect(Math.max(0, L), B, Math.min(W, R) - Math.max(0, L), H - B);
    // 木篱笆：每 40 一根桩 + 两道横栏
    var step = 40, x0 = Math.max(-MAP_HALF, Math.floor((camera.x - hw) / step) * step), x1 = Math.min(MAP_HALF, camera.x + hw);
    var y0 = Math.max(-MAP_HALF, Math.floor((camera.y - hh) / step) * step), y1 = Math.min(MAP_HALF, camera.y + hh);
    function post(wx, wy) { var sx = worldToScreenX(wx), sy = worldToScreenY(wy), w = s(10), h = s(34); ctx.fillStyle = "#c98a55"; ctx.strokeStyle = "#7d4c26"; ctx.lineWidth = Math.max(1.5, s(2.5)); ctx.beginPath(); ctx.moveTo(sx - w / 2, sy); ctx.lineTo(sx - w / 2, sy - h + w / 2); ctx.lineTo(sx, sy - h); ctx.lineTo(sx + w / 2, sy - h + w / 2); ctx.lineTo(sx + w / 2, sy); ctx.closePath(); ctx.fill(); ctx.stroke(); }
    function rail(ax, ay, bx, by) { ctx.strokeStyle = "#7d4c26"; ctx.lineWidth = s(7); ctx.beginPath(); ctx.moveTo(ax, ay); ctx.lineTo(bx, by); ctx.stroke(); ctx.strokeStyle = "#e0a86f"; ctx.lineWidth = s(4); ctx.stroke(); }
    var e, wx, wy;
    [[-MAP_HALF, "h"], [MAP_HALF, "h"]].forEach(function (f) {
      e = f[0]; if (Math.abs(e - camera.y) > hh + 40) return;
      var sy = worldToScreenY(e), fim = IMG.fence;
      if (fim) { var fw = 160, fx0 = Math.floor(x0 / fw) * fw, fh = s(fw) * fim.height / fim.width; for (wx = fx0; wx < x1; wx += fw) ctx.drawImage(fit(fim, fh), worldToScreenX(wx), sy - fh * 0.92, s(fw) + 1, fh); return; }
      rail(worldToScreenX(x0), sy - s(12), worldToScreenX(x1), sy - s(12)); rail(worldToScreenX(x0), sy - s(24), worldToScreenX(x1), sy - s(24));
      for (wx = x0; wx <= x1; wx += step) post(wx, e);
    });
    [[-MAP_HALF, "v"], [MAP_HALF, "v"]].forEach(function (f) {
      e = f[0]; if (Math.abs(e - camera.x) > hw + 40) return;
      var sx = worldToScreenX(e); rail(sx - s(3), worldToScreenY(y0) - s(18), sx - s(3), worldToScreenY(y1) - s(18));
      for (wy = y0; wy <= y1; wy += step) post(e, wy);
    });
  }
  function drawNestsGround() {
    var u = s(1) * entityScaleMult * 0.8, i;
    for (i = 0; i < nests.length; i++) {
      var n = nests[i], sx = worldToScreenX(n.x), sy = worldToScreenY(n.y);
      if (sx < -80 || sx > W + 80 || sy < -90 || sy > H + 80) continue;
      if (IMG.nest) shadow(sx + s(2), sy + 24 * u, 58 * u);
      var nestTilt = 0;
      if (n.alive && n.hitsLeft < n.maxHits) {
        if ((n.maxHits || 3) - n.hitsLeft >= 2) nestTilt = -0.14;
      }
      if (nestTilt) { ctx.save(); ctx.translate(sx, sy); ctx.rotate(nestTilt); ctx.translate(-sx, -sy); }
      if (!n.alive && n.deadT < 0.4) { var k = n.deadT / 0.4; blitSpr(nestSprite(false, u), sx, sy, u * (1 - k * 0.3), 1 - k); }
      blitSpr(nestSprite(!n.alive, u), sx, sy, u, n.alive ? 1 : Math.min(1, n.deadT / 0.4) * 0.9);
      if (nestTilt) ctx.restore();
      if (n.alive && n.hitsLeft < n.maxHits) { // v22：损毁档（无血条）；按已失击数分档
        var lost = (n.maxHits || 3) - n.hitsLeft;
        ctx.save();
        if (lost >= 1) { // 裂开：碎石 + 裂纹（画在土堆中上部，避免被猫挡住）
          ctx.fillStyle = "rgba(70,45,28,.9)"; for (var ri = 0; ri < 6; ri++) { ctx.beginPath(); ctx.arc(sx + s(-22 + ri * 9), sy + s(-6 + (ri % 3) * 6), s(4 + (ri % 3)), 0, 7); ctx.fill(); }
          ctx.strokeStyle = "rgba(30,18,10,.85)"; ctx.lineWidth = s(3); ctx.beginPath(); ctx.moveTo(sx - s(24), sy - s(18)); ctx.lineTo(sx - s(2), sy + s(2)); ctx.lineTo(sx + s(20), sy - s(14)); ctx.stroke();
          ctx.beginPath(); ctx.moveTo(sx - s(8), sy - s(28)); ctx.lineTo(sx + s(10), sy - s(6)); ctx.stroke();
          ctx.beginPath(); ctx.moveTo(sx + s(4), sy - s(22)); ctx.lineTo(sx + s(22), sy - s(2)); ctx.stroke(); }
        if (lost >= 2) { // 冒烟 + 歪斜感
          var sm = reducedMotion ? 0.4 : ((elapsedPlayTime * 1.5 + i) % 1);
          ctx.globalAlpha = (1 - sm) * 0.75; ctx.fillStyle = n.infected ? "#7dffa0" : "#d0d0d0";
          ctx.beginPath(); ctx.ellipse(sx + s(10), sy - s(48) - sm * s(28), s(12 + sm * 8), s(8 + sm * 5), 0, 0, 7); ctx.fill();
          ctx.globalAlpha = (1 - sm) * 0.5; ctx.beginPath(); ctx.ellipse(sx - s(8), sy - s(40) - sm * s(20), s(9 + sm * 5), s(6 + sm * 3), 0, 0, 7); ctx.fill();
          ctx.globalAlpha = 1; emojiQuick("💨", sx + s(18), sy - s(56) - sm * s(10), s(16), 0.85); }
        if (n.hitFlash > 0) { ctx.globalAlpha = n.hitFlash / 0.25 * 0.55; ctx.fillStyle = "#fff"; ctx.beginPath(); ctx.ellipse(sx, sy, s(42), s(28), 0, 0, 7); ctx.fill(); ctx.globalAlpha = 1; }
        ctx.restore();
      }
      if (n.alive && n.infected) {
        var ig = resScale < 1 ? 0.25 : (0.35 + 0.2 * Math.sin(elapsedPlayTime * 3));
        ctx.fillStyle = "rgba(60,220,80," + ig + ")"; ctx.beginPath(); ctx.ellipse(sx, sy + s(6), s(38), s(22), 0, 0, 7); ctx.fill();
        if (resScale >= 1) { ctx.strokeStyle = "rgba(120,255,140,.55)"; ctx.lineWidth = s(2); ctx.beginPath(); ctx.arc(sx, sy, s(34 + Math.sin(elapsedPlayTime * 4) * 3), 0, 7); ctx.stroke(); }
        if (n.infectFlash > 0) { n.infectFlash -= 1/60; ctx.strokeStyle = "rgba(100,255,120," + (n.infectFlash / 1.2) + ")"; ctx.lineWidth = s(5); ctx.beginPath(); ctx.arc(sx, sy, s(70) * (1.3 - n.infectFlash * 0.2), 0, 7); ctx.stroke(); }
      }
      if (n.alive && n.flash > 0) { ctx.strokeStyle = "rgba(255,210,80," + (n.flash / 2) + ")"; ctx.lineWidth = s(4); ctx.beginPath(); ctx.arc(sx, sy, s(60) * (1.4 - n.flash * 0.2), 0, 7); ctx.stroke(); }
      if (n.alive && n.hide) { // 窝口两只发抖的小眼睛 + 💦
        var tr = reducedMotion ? 0 : Math.sin(elapsedPlayTime * 40) * s(1.2), ey = sy + s(4), ap = Math.min(1, n.hideT * 3);
        ctx.globalAlpha = ap;
        for (var e = -1; e <= 1; e += 2) { ctx.fillStyle = "#fff"; ctx.beginPath(); ctx.ellipse(sx + e * s(7) + tr, ey, s(5), s(6), 0, 0, 7); ctx.fill(); ctx.fillStyle = "#222"; ctx.beginPath(); ctx.arc(sx + e * s(7) + tr - e * s(1), ey + s(1), s(2.6), 0, 7); ctx.fill(); ctx.fillStyle = "#fff"; ctx.fillRect(sx + e * s(7) + tr - e * s(1) - s(1.2), ey - s(0.6), s(1.2), s(1.2)); }
        emojiQuick("💦", sx + s(20), sy - s(40) + (reducedMotion ? 0 : Math.sin(elapsedPlayTime * 6) * s(2)), s(16));
        if (n.stored > 0) emojiQuick("×" + n.stored, sx - s(24), sy - s(38), s(12), null, "#fff");
        ctx.globalAlpha = 1;
      }
      if (n.alive && n.burstT > 0 && !reducedMotion) { var bk = 1 - n.burstT / 0.6; ctx.strokeStyle = "rgba(255,240,180," + (1 - bk) + ")"; ctx.lineWidth = s(3); for (var b2 = 0; b2 < 8; b2++) { var ba = b2 / 8 * 6.283, r1 = s(20 + bk * 40), r2 = s(30 + bk * 55); ctx.beginPath(); ctx.moveTo(sx + Math.cos(ba) * r1, sy + Math.sin(ba) * r1); ctx.lineTo(sx + Math.cos(ba) * r2, sy + Math.sin(ba) * r2); ctx.stroke(); } emojiQuick("💨", sx, sy - s(30) - bk * s(20), s(18), 1 - bk); }
      if (n.alive && n.silT > 0) emojiQuick("🔇", sx + s(30), sy - s(50), s(18));
      if (!n.alive && n.deadT < 6 && !reducedMotion) { // 绿色臭气小云
        for (var q = 0; q < 3; q++) { var ph = (n.deadT * 0.8 + q / 3) % 1; ctx.globalAlpha = (1 - ph) * 0.6; ctx.fillStyle = "#9fd27a"; ctx.beginPath(); ctx.arc(sx + s(-14 + q * 14) + Math.sin(ph * 6 + q) * s(5), sy - s(10) - ph * s(40), s(6 + ph * 6), 0, 7); ctx.fill(); }
        ctx.globalAlpha = 1;
      }
    }
    for (i = 0; i < poops.length; i++) {
      var p = poops[i], px = worldToScreenX(p.x), py = worldToScreenY(p.y);
      if (px < -40 || px > W + 40 || py < -60 || py > H + 40) continue;
      var pop = p.age < 0.25 ? 0.5 + p.age * 2.4 + Math.sin(p.age / 0.25 * Math.PI) * 0.25 : 1;
      blitSpr(poopSprite(u), px, py, u * 1.1 * pop, p.age > 9 ? 10 - p.age : 1);
      if (p.age < 3 && !reducedMotion) emojiQuick("✨", px + s(18), py - s(40) - p.age * s(6), s(14), 1 - p.age / 3);
    }
  }
  // 蹲窝进度环（画在猫头顶）
  function drawPoopRing() {
    if (!nestPoopAnim) return;
    var A = nestPoopAnim, sx = worldToScreenX(cat.x), sy = worldToScreenY(cat.y) - s(8), p = Math.min(1, A.t / A.dur);
    ctx.lineCap = "round"; ctx.lineWidth = s(5); ctx.strokeStyle = "rgba(255,255,255,.7)"; ctx.beginPath(); ctx.arc(sx, sy, s(40), 0, 7); ctx.stroke();
    ctx.strokeStyle = "#c4a574"; ctx.beginPath(); ctx.arc(sx, sy, s(40), -Math.PI / 2, -Math.PI / 2 + p * Math.PI * 2); ctx.stroke(); ctx.lineCap = "butt";
    emojiQuick("💩", sx + s(18), sy - s(36) - Math.sin(A.t * 10) * s(2), s(20));
    if (A.t > 0.4) emojiQuick("💨", sx - s(20), sy - s(40), s(14), Math.min(1, (A.t - 0.4) * 2));
  }
  // 夜晚：整体压暗 + 猫身边暖光圈 + 星星；黄昏/黎明偏橙
  var STARS = []; for (var si = 0; si < 40; si++) STARS.push([Math.random(), Math.random() * 0.45, 0.4 + Math.random() * 0.6]);
  // v13 A4：移轴景深感（上下边缘柔光雾 + 暗角），预渲染一张屏幕大小的图；弱设备（降分辨率后）关闭
  var depthCv = null, depthKey = "";
  function drawDepth() {
    if (resScale < 1 || dayNow.night > 0.5) return; // 夜晚已有暗角，不再叠加
    var key = W + "x" + H + "|" + (dayNow.night > 0.5 ? 1 : 0);
    if (key !== depthKey) {
      depthKey = key; var c = depthCv || document.createElement("canvas"), sc = 0.5; c.width = Math.ceil(W * sc); c.height = Math.ceil(H * sc); var g = c.getContext("2d"), w = c.width, h = c.height;
      g.clearRect(0, 0, w, h); var night = dayNow.night > 0.5, hz = night ? "20,30,70" : "255,248,225";
      var t = g.createLinearGradient(0, 0, 0, h); t.addColorStop(0, "rgba(" + hz + ",0.38)"); t.addColorStop(0.16, "rgba(" + hz + ",0)"); t.addColorStop(0.84, "rgba(" + hz + ",0)"); t.addColorStop(1, "rgba(" + hz + ",0.32)");
      g.fillStyle = t; g.fillRect(0, 0, w, h);
      depthCv = c;
    }
    var cw = depthCv.width, ch = depthCv.height, bh = Math.ceil(ch * 0.2); // 只画上下两条渐变（中间透明区不画，省填充）
    ctx.drawImage(depthCv, 0, 0, cw, bh, 0, 0, W, H * bh / ch);
    ctx.drawImage(depthCv, 0, ch - bh, cw, bh, 0, H - H * bh / ch, W, H * bh / ch);
  }
  function drawNight() {
    var k = dayNow.night; if (k <= 0.001) return;
    var sx = worldToScreenX(cat.x), sy = worldToScreenY(cat.y), r1 = s(190 * entityScaleMult), r0 = s(60 * entityScaleMult);
    if (dayNow.phase === "dusk" || dayNow.phase === "dawn") { ctx.fillStyle = "rgba(255,140,60," + (0.18 * Math.sin(k * Math.PI)) + ")"; ctx.fillRect(0, 0, W, H); }
    var g = ctx.createRadialGradient(sx, sy, r0, sx, sy, r1);
    g.addColorStop(0, "rgba(25,45,110," + (0.16 * k) + ")"); g.addColorStop(1, "rgba(12,26,70," + (0.7 * k) + ")");
    ctx.fillStyle = g; ctx.fillRect(0, 0, W, H);
    ctx.fillStyle = "rgba(255,240,200," + (0.05 * k) + ")"; ctx.beginPath(); ctx.arc(sx, sy, r0 * 1.4, 0, 7); ctx.fill();
    if (k > 0.5) for (var i = 0; i < STARS.length; i++) { var st = STARS[i], tw = reducedMotion ? 1 : 0.6 + 0.4 * Math.sin(elapsedPlayTime * 2 + i); ctx.fillStyle = "rgba(255,255,220," + (st[2] * tw * (k - 0.5) * 2) + ")"; ctx.fillRect(st[0] * W, 60 + st[1] * H, 2, 2); }
  }
  // v13 A6：夜晚萤火虫 + 小猫身边的暖色灯光（加色混合）；弱设备不画萤火虫
  var glowCv = null, flies = [];
  function glowSprite() { if (glowCv) return glowCv; var c = document.createElement("canvas"); c.width = c.height = 64; var g = c.getContext("2d"), gr = g.createRadialGradient(32, 32, 0, 32, 32, 32); gr.addColorStop(0, "rgba(255,250,190,1)"); gr.addColorStop(0.25, "rgba(255,230,120,.65)"); gr.addColorStop(1, "rgba(255,200,80,0)"); g.fillStyle = gr; g.fillRect(0, 0, 64, 64); return (glowCv = c); }
  function drawNightGlow() {
    var k = dayNow.night; if (k <= 0.05 || resScale < 1) return;
    var sx = worldToScreenX(cat.x), sy = worldToScreenY(cat.y), r = s(150 * entityScaleMult);
    ctx.save(); ctx.globalCompositeOperation = "lighter";
    var g = ctx.createRadialGradient(sx, sy, 0, sx, sy, r); g.addColorStop(0, "rgba(255,150,60," + (0.16 * k) + ")"); g.addColorStop(0.6, "rgba(255,120,40," + (0.06 * k) + ")"); g.addColorStop(1, "rgba(255,150,50,0)");
    ctx.fillStyle = g; ctx.fillRect(sx - r, sy - r, r * 2, r * 2);
    if (resScale >= 1 && !reducedMotion) {
      var n = Math.round(22 * k); while (flies.length < n) flies.push({ x: Math.random(), y: Math.random(), p: Math.random() * 6.28, sp: 0.4 + Math.random() * 0.6 });
      var gw = glowSprite(), t = elapsedPlayTime;
      for (var i = 0; i < n; i++) { var f = flies[i]; var fx = ((f.x + Math.sin(t * 0.13 * f.sp + f.p) * 0.06 - (camera.x * 0.00015)) % 1 + 1) % 1 * W, fy = ((f.y + Math.cos(t * 0.11 * f.sp + f.p * 1.3) * 0.05 - (camera.y * 0.00015)) % 1 + 1) % 1 * H;
        var tw = 0.35 + 0.65 * Math.max(0, Math.sin(t * 2 * f.sp + f.p)), z = s(26 + 14 * f.sp); ctx.globalAlpha = tw * k; ctx.drawImage(gw, fx - z / 2, fy - z / 2, z, z); ctx.drawImage(gw, fx - z / 6, fy - z / 6, z / 3, z / 3); }
      ctx.globalAlpha = 1;
    }
    ctx.restore();
  }
  function mouseInDark(m) { return dayNow.night > 0.5 && distance(m.x, m.y, cat.x, cat.y) > 200 * entityScaleMult; }
  // 屏幕外最近 3 个窝：边缘箭头
  function drawNestArrows() {
    var list = [], hw = W / 2, hh = H / 2, i;
    for (i = 0; i < nests.length; i++) {
      var n = nests[i]; if (!n.alive) continue;
      var sx = worldToScreenX(n.x), sy = worldToScreenY(n.y);
      if (sx > 0 && sx < W && sy > 0 && sy < H) continue;
      list.push({ n: n, d: distance(n.x, n.y, cat.x, cat.y), sx: sx, sy: sy });
    }
    list.sort(function (a, b) { return a.d - b.d; });
    for (i = 0; i < Math.min(3, list.length); i++) {
      var L = list[i], dx = L.sx - hw, dy = L.sy - hh, a = Math.atan2(dy, dx);
      var m = 26, kx = (hw - m) / Math.abs(Math.cos(a) || 1e-6), ky = (hh - m - 40) / Math.abs(Math.sin(a) || 1e-6), kk = Math.min(kx, ky);
      var ax = hw + Math.cos(a) * kk, ay = hh + Math.sin(a) * kk, al = clamp(1.2 - L.d / 2000, 0.35, 1);
      ctx.save(); ctx.globalAlpha = al; ctx.translate(ax, ay); ctx.rotate(a);
      ctx.fillStyle = L.n.flash > 0 ? "#ffd23f" : "#c98a55"; ctx.strokeStyle = "#fff"; ctx.lineWidth = 3; ctx.beginPath(); ctx.moveTo(14, 0); ctx.lineTo(-9, -11); ctx.lineTo(-4, 0); ctx.lineTo(-9, 11); ctx.closePath(); ctx.stroke(); ctx.fill();
      ctx.restore();
      emojiQuick("🕳️", ax - Math.cos(a) * 24, ay - Math.sin(a) * 24, 16, al);
    }
  }
  // v19：屏外老鼠边缘箭头（最多 3 个，越远越淡；小地图已移除）
  function drawMouseArrows() {
    var list = [], hw = W / 2, hh = H / 2, i;
    for (i = 0; i < mice.length; i++) { var m = mice[i]; if (!uniOk(m)) continue; var sx = worldToScreenX(m.x), sy = worldToScreenY(m.y);
      if (sx > -10 && sx < W + 10 && sy > -10 && sy < H + 10) continue; var d = distance(m.x, m.y, cat.x, cat.y); if (d > 900) continue; list.push({ m: m, d: d, sx: sx, sy: sy }); }
    list.sort(function (a, b) { return (b.m.mutant?1:0) - (a.m.mutant?1:0) || a.d - b.d; });
    for (i = 0; i < Math.min(3, list.length); i++) {
      var L = list[i], a = Math.atan2(L.sy - hh, L.sx - hw), mg = 18, kx = (hw - mg) / Math.abs(Math.cos(a) || 1e-6), ky = (hh - mg - 30) / Math.abs(Math.sin(a) || 1e-6), kk = Math.min(kx, ky);
      var ax = hw + Math.cos(a) * kk, ay = hh + Math.sin(a) * kk, al = clamp(1.1 - L.d / 900, 0.3, 0.95);
      ctx.save(); ctx.globalAlpha = al; ctx.translate(ax, ay); ctx.rotate(a); ctx.fillStyle = L.m.mutant ? "#ff4a4a" : (L.m.type === "gold" ? "#ffd23f" : "#ffffff"); ctx.strokeStyle = "rgba(60,40,30,.7)"; ctx.lineWidth = 2;
      ctx.beginPath(); ctx.moveTo(9, 0); ctx.lineTo(-6, -7); ctx.lineTo(-6, 7); ctx.closePath(); ctx.fill(); ctx.stroke(); ctx.restore();
    }
  }
  // ---- 小地图 ----
  var miniT = 0;
  var miniBase = null;
  function drawMiniTo(c, size) {
    var g = c.getContext("2d"), d = Math.min(2, window.devicePixelRatio || 1); if (c.width !== size * d) { c.width = size * d; c.height = size * d; }
    g.setTransform(d, 0, 0, d, 0, 0); g.clearRect(0, 0, size, size);
    var k = size / (2 * MAP_HALF), X = function (x) { return (x + MAP_HALF) * k; };
    if (TERR) { if (!miniBase || miniBase.width !== Math.round(size * d)) miniBase = TERR.miniMap(Math.round(size * d)); g.drawImage(miniBase, 0, 0, size, size); } else { g.fillStyle = "#b8e6a0"; g.fillRect(0, 0, size, size); }
    if (dayNow.night > 0) { g.fillStyle = "rgba(10,15,50," + (0.4 * dayNow.night) + ")"; g.fillRect(0, 0, size, size); }
    for (var i = 0; i < nests.length; i++) { var n = nests[i]; if (n.alive) { g.fillStyle = n.flash > 0 ? "#ffd23f" : (n.infected ? "#4dff6a" : "#a0683a"); g.beginPath(); g.arc(X(n.x), X(n.y), Math.max(3, size / 30), 0, 7); g.fill(); } else { g.strokeStyle = "#8a8a8a"; g.lineWidth = 1.5; var q = size / 40; g.beginPath(); g.moveTo(X(n.x) - q, X(n.y) - q); g.lineTo(X(n.x) + q, X(n.y) + q); g.moveTo(X(n.x) + q, X(n.y) - q); g.lineTo(X(n.x) - q, X(n.y) + q); g.stroke(); } }
    var hw = W / (2 * SCALE), hh = H / (2 * SCALE); g.strokeStyle = "rgba(122,74,42,.6)"; g.lineWidth = 1.2; g.strokeRect(X(camera.x - hw), X(camera.y - hh), 2 * hw * k, 2 * hh * k);
    g.fillStyle = "#ff8a3d"; g.strokeStyle = "#fff"; g.lineWidth = 1.5; g.beginPath(); g.arc(X(cat.x), X(cat.y), Math.max(3.5, size / 26), 0, 7); g.fill(); g.stroke();
  }
  function updateMini(dt) {
    miniT -= dt; if (miniT > 0) return; miniT = 0.25;
    var c = document.getElementById("miniMap"); if (c) drawMiniTo(c, 96);
    var dt2 = document.getElementById("dayText");
    if (dt2) { var night = dayNow.phase === "night" || dayNow.phase === "dusk", L = Math.ceil(dayNow.left), txt = (night ? "🌙 夜晚 " : "☀️ 白天 ") + Math.floor(L / 60) + ":" + ("0" + (L % 60)).slice(-2); setText(dt2, txt); toggleCls(dt2, "night", night); }
  }
  function openMap() {
    if (state !== STATE_PLAY) return; sfx.click();
    state = STATE_PAUSE; run.forceNext = true; moveDir.x = 0; moveDir.y = 0; activePointerId = null;
    var el = document.getElementById("mapScreen"), c = document.getElementById("bigMap");
    drawMiniTo(c, Math.min(320, Math.floor(Math.min(W, H) - 60)));
    setText(document.getElementById("mapInfo"), "老鼠窝 " + nests.filter(function (n) { return n.alive; }).length + " 个 · 已摧毁 " + nestStats.destroyed + " 个");
    showScreen(el); if (CA.sfx.panel) CA.sfx.panel(true);
  }
  function closeMap() {
    hideScreen(document.getElementById("mapScreen")); if (CA.sfx.panel) CA.sfx.panel(false);
    if (state === STATE_PAUSE && dom.pauseScreen.classList.contains("hidden")) { state = STATE_PLAY; run.forceNext = true; }
  }

  // =======================================================================
  // 通用被动（所有猫）：#1 飞扑 · #2 连环扑 · #6 顺势冲刺 · #8 墙角逼宫
  // 只在玩家当前移动方向的扇形内动作；任何新点击立即取消；不让猫掉头。等级 = 本局抓捕数（15/40/80/150）
  // =======================================================================
  var UNI_INFO = [
    { id: "pounce", icon: "🐾", name: "飞扑", lv: ["身前 ±60° · 60px 内有鼠自动扑（冷却 1.2s）", "范围 70px", "冷却 0.9s", "扑中后立刻可再扑", "落地小冲击波，晕住周围老鼠（不计分）"] },
    { id: "chain", icon: "💫", name: "连环扑", lv: ["扑中后 0.4s 内 80px 还有鼠（移动方向 ±90°）再扑，最多 2 连", "最多 2 连", "最多 3 连", "最多 4 连", "最多 5 连"] },
    { id: "dash", icon: "💨", name: "顺势冲刺", lv: ["同方向直走 ≥1s 且前方 150px 有鼠：速度 ×1.3，1.0s", "×1.35，1.2s", "×1.4，1.5s", "×1.45，1.8s", "×1.5，2.2s"] },
    { id: "poop", icon: "🕳️", name: "拆老鼠窝", lv: ["点窝锁定 → 招牌扑砸窝；普通窝 3 击 / 感染窝 4 击；最后一击播便便收尾动画 +30 分（开局 20 秒后可拆）", "同上", "同上", "同上", "同上"] },
    { id: "corner", icon: "😰", name: "墙角逼宫", lv: ["老鼠背靠障碍且猫在 100px 内：发抖冒汗，速度 -60%", "同上", "两侧 50px 内的老鼠也被吓住", "同上", "同上"] }
  ];
  var uni = null;
  function uniReset() {
    uni = { cd: 0, lunge: null, chainLeft: 0, chainN: 0, chainWin: 0, straightT: 0, lastDx: 0, lastDy: 0, dashT: 0, dashMul: 1,
      ghosts: [], pops: [], waves: [], stats: { pounce: 0, chain: 0, dash: 0, corner: 0, maxChain: 0 } };
  }
  uniReset();
  function uniStage() { return stageFor(catches); }
  function uniOk(m) { return !m.hidden && !m.under && !m.carried; }
  // 找扇形内最近的鼠：dir=移动方向，half=半角
  function uniFind(R, half) {
    var best = null, bd = 1e9, cosH = Math.cos(half);
    gridEach(cat.x, cat.y, R + 20, function (m) {
      if (!uniOk(m)) return;
      var dx = m.x - cat.x, dy = m.y - cat.y, d = Math.sqrt(dx * dx + dy * dy);
      if (d > R || d < 1) return;
      if ((dx * moveDir.x + dy * moveDir.y) / d < cosH) return;
      if (d < bd) { bd = d; best = m; }
    });
    return best;
  }
  function uniCancel() {
    if (!uni) return;
    if (uni.lunge || uni.dashT > 0) { if (CA.sfx.uni) CA.sfx.uni("cancel"); }
    uni.lunge = null; uni.chainLeft = 0; uni.chainWin = 0; uni.dashT = 0; uni.dashMul = 1; uni.straightT = 0;
  }
  function uniStartLunge(m, chain) {
    var esm = entityScaleMult, dx = m.x - cat.x, dy = m.y - cat.y, d = Math.sqrt(dx * dx + dy * dy) || 1;
    var len = Math.min(80 * esm, d + 4), ux = dx / d, uy = dy / d;
    uni.lunge = { sx: cat.x, sy: cat.y, ux: ux, uy: uy, len: len, t: 0, dur: 0.21, wind: chain ? 0 : 0.05, hit: false, chain: chain, done: 0 };
    if (chain) { uni.chainN++; uni.stats.chain++; if (uni.chainN + 1 > uni.stats.maxChain) uni.stats.maxChain = uni.chainN + 1; }
    else { uni.chainN = 0; uni.stats.pounce++; }
    if (CA.sfx.uni) CA.sfx.uni(chain ? "chain" : "pounce", uni.chainN);
  }
  function uniSpeedMul() { return uni && uni.dashT > 0 ? uni.dashMul : 1; }
  // 在 updateCat 末尾调用：飞扑位移（沿玩家方向扇形内，带障碍碰撞）
  function uniLungeStep(dt) {
    var L = uni.lunge; if (!L) return;
    var prev = L.done; L.t += dt; var w0 = L.wind || 0; if (L.t < w0) return; var k = Math.min(1, (L.t - w0) / (L.dur - w0)), e = 1 - (1 - k) * (1 - k);
    var step = L.len * e - prev; L.done = L.len * e;
    cat.x += L.ux * step; cat.y += L.uy * step;
    var obs = queryNearbyObstacles(cat.x, cat.y); for (var i = 0; i < obs.length; i++) resolveCircleAabb(cat, obs[i]); if (TERR) TERR.push(cat);
    if (L.chain && !reducedMotion && Math.random() < 0.6) uni.ghosts.push({ x: cat.x, y: cat.y, a: 0.45 });
  }
  function uniOnCapture(m) {
    if (uni && uni.lunge && !uni.lunge.hit) { uni.lunge.hit = true; if (uni.lunge.chain) uni.pops.push({ x: m.x, y: m.y - 20, txt: "×" + (uni.chainN + 1), age: 0 }); }
  }
  function uniUpdate(dt) {
    var st = uniStage(), esm = entityScaleMult, moving = moveDir.x !== 0 || moveDir.y !== 0, i;
    uni.cd = Math.max(0, uni.cd - dt);
    // 顺势冲刺：方向保持不变的时间
    if (moving && uni.lastDx * moveDir.x + uni.lastDy * moveDir.y > 0.995) uni.straightT += dt;
    else { if (uni.dashT > 0) uniCancel(); uni.straightT = 0; }
    uni.lastDx = moveDir.x; uni.lastDy = moveDir.y;
    if (!moving && !(uni.lunge && uni.lunge.keep)) { uni.lunge = null; uni.chainLeft = 0; uni.chainWin = 0; }
    if (uni.dashT > 0) { uni.dashT -= dt; if (uni.dashT <= 0) uni.dashMul = 1; if (!reducedMotion && Math.random() < 0.5) uni.ghosts.push({ x: cat.x, y: cat.y, a: 0.2, line: true, ang: Math.atan2(moveDir.y, moveDir.x), off: (Math.random() - 0.5) * 30 }); }
    else if (moving && uni.straightT >= 1 && uniFind(150 * esm, Math.PI / 6)) {
      uni.dashMul = [1.3, 1.35, 1.4, 1.45, 1.5][st - 1]; uni.dashT = [1.0, 1.2, 1.5, 1.8, 2.2][st - 1]; uni.stats.dash++;
      if (CA.sfx.uni) CA.sfx.uni("dash"); feedback("dash");
    }
    // 飞扑 / 连环扑
    var L = uni.lunge;
    if (L && L.t >= L.dur) {
      uni.lunge = null; cat.squash = 1; for (i = 0; i < 4; i++) spawnDust(cat.x, cat.y, Math.atan2(L.uy, L.ux) + (i - 1.5) * 0.9, 10 * esm);
      if (CA.sfx.uni) CA.sfx.uni("land"); feedback("land");
      if (L.hit) {
        if (st >= 5) { // 小冲击波：晕眩不计分
          uni.waves.push({ x: cat.x, y: cat.y, age: 0 });
          gridEach(cat.x, cat.y, 70 * esm, function (m) { if (uniOk(m) && distance(m.x, m.y, cat.x, cat.y) < 60 * esm) stunM(m, 0.8, "wave"); });
          if (CA.sfx.uni) CA.sfx.uni("wave"); feedback("wave");
        }
        if (st >= 4) uni.cd = 0;
        if (!L.chain) uni.chainLeft = [2, 2, 3, 4, 5][st - 1] - 1;
        uni.chainWin = uni.chainLeft > 0 ? 0.4 : 0;
      } else { uni.chainLeft = 0; uni.chainWin = 0; }
    }
    if (!uni.lunge && moving && !poopSitting() && !sig) {
      if (uni.chainWin > 0) {
        uni.chainWin -= dt;
        var cm = uniFind(80 * esm, Math.PI / 2);
        if (cm && uni.chainLeft > 0) { uni.chainLeft--; uni.chainWin = 0; uniStartLunge(cm, true); }
        else if (uni.chainWin <= 0) uni.chainLeft = 0;
      } else if (uni.cd <= 0) {
        var pm = uniFind((st >= 2 ? 70 : 60) * esm, Math.PI / 3);
        if (pm) { uniStartLunge(pm, false); uni.cd = st >= 3 ? 0.9 : 1.2; }
      }
    }
    // 墙角逼宫
    var near = [];
    gridEach(cat.x, cat.y, 110 * esm, function (m) {
      if (!uniOk(m) || m.stun > 0) return;
      var dx = m.x - cat.x, dy = m.y - cat.y, d = Math.sqrt(dx * dx + dy * dy);
      if (d > 100 * esm || d < 1) return;
      var px = m.x + dx / d * (m.r + 10 * esm), py = m.y + dy / d * (m.r + 10 * esm), obs = queryNearbyObstacles(px, py);
      if (nestNear(px, py, 40 * esm)) { near.push(m); return; }
      for (var j = 0; j < obs.length; j++) { var o = obs[j]; if (px >= o.x && px <= o.x + o.w && py >= o.y && py <= o.y + o.h) { near.push(m); break; } }
    });
    for (i = 0; i < near.length; i++) {
      var m0 = near[i]; if (!(m0.cornerT > 0)) { uni.stats.corner++; if (CA.sfx.uni) CA.sfx.uni("corner"); } m0.cornerT = 0.3;
      if (st >= 3) gridEach(m0.x, m0.y, 50 * esm, function (m) { if (m !== m0 && uniOk(m) && distance(m.x, m.y, m0.x, m0.y) < 50 * esm) m.cornerT = Math.max(m.cornerT || 0, 0.3); });
    }
    for (i = uni.ghosts.length - 1; i >= 0; i--) { uni.ghosts[i].a -= dt * 1.6; if (uni.ghosts[i].a <= 0) uni.ghosts.splice(i, 1); }
    if (uni.ghosts.length > 40) uni.ghosts.splice(0, uni.ghosts.length - 40);
    for (i = uni.pops.length - 1; i >= 0; i--) { uni.pops[i].age += dt; if (uni.pops[i].age > 0.8) uni.pops.splice(i, 1); }
    for (i = uni.waves.length - 1; i >= 0; i--) { uni.waves[i].age += dt; if (uni.waves[i].age > 0.35) uni.waves.splice(i, 1); }
  }
  function uniDrawUnder() {
    for (var i = 0; i < uni.ghosts.length; i++) {
      var g = uni.ghosts[i], sx = worldToScreenX(g.x), sy = worldToScreenY(g.y);
      if (g.line) { // 速度线
        var px = -Math.sin(g.ang), py = Math.cos(g.ang); ctx.strokeStyle = "rgba(255,255,255," + g.a * 3 + ")"; ctx.lineWidth = s(2);
        ctx.beginPath(); ctx.moveTo(sx + px * s(g.off) - Math.cos(g.ang) * s(10), sy + s(14) + py * s(g.off) - Math.sin(g.ang) * s(10));
        ctx.lineTo(sx + px * s(g.off) - Math.cos(g.ang) * s(40), sy + s(14) + py * s(g.off) - Math.sin(g.ang) * s(40)); ctx.stroke();
      } else { ctx.globalAlpha = g.a; drawCatAt(sx, sy, s(cat.r), catAnim, cat.runCycle, currentSkin, true); ctx.globalAlpha = 1; }
    }
    for (i = 0; i < uni.waves.length; i++) {
      var w = uni.waves[i], k = w.age / 0.35; ctx.strokeStyle = "rgba(255,240,200," + (1 - k) + ")"; ctx.lineWidth = s(4);
      ctx.beginPath(); ctx.arc(worldToScreenX(w.x), worldToScreenY(w.y) + s(10), s(60 * entityScaleMult) * k, 0, 7); ctx.stroke();
    }
  }
  function uniDrawOver() {
    for (var i = 0; i < uni.pops.length; i++) {
      var p = uni.pops[i], k = p.age / 0.8; emojiQuick(p.txt, worldToScreenX(p.x), worldToScreenY(p.y) - s(30 * k), s(22) * (1 + 0.4 * Math.max(0, 1 - k * 4)), 1 - k * k, "#ffd23f");
    }
  }
  // 猫身拉伸：飞扑时沿扑击方向拉长、冲刺时略拉长
  function uniCatStretch() {
    if (reducedMotion) return null;
    if (uni.lunge) { var k = uni.lunge.t / uni.lunge.dur; return { a: Math.atan2(uni.lunge.uy, uni.lunge.ux), s: 1 + 0.35 * Math.sin(Math.PI * Math.min(1, k)) }; }
    if (uni.dashT > 0) return { a: Math.atan2(moveDir.y, moveDir.x), s: 1.12 };
    return null;
  }

  // =======================================================================
  // v19 TAP2 爽快版：锁定目标后放「招牌扑」。最后一口仍由猫身体碰到才算抓（范围效果只冻住/拉近）
  // =======================================================================
  var SIG_BASE = {
    orange: { name: "弹簧大跳", R: 140, half: 45, cd: 1.6, max: 2 },
    black: { name: "影子闪现", R: 180, half: 180, cd: 3.0, max: 1 },
    white: { name: "雪球肚压", R: 90, half: 60, cd: 2.5, max: 1 },
    calico: { name: "毛线钩", R: 220, half: 30, cd: 2.0, max: 1 },
    blue: { name: "滚滚碾压", R: 160, half: 20, cd: 2.2, max: 3 },
    siamese: { name: "高音连扑", R: 100, half: 60, cd: 1.8, max: 3 }
  };
  // v20：点老鼠触发距离 = 固定 220 世界单位（全猫一致、任意方向；手机默认视野短边约 480 单位，半宽 240）
  var SIG_RANGE = 220, SIG_DASH_V = 1500;
  var SIG_COL = { orange: "#ff8a2a", black: "#8a5cff", white: "#6cc8ff", calico: "#ff6fa8", blue: "#5b8cff", siamese: "#3fa9ff" };
  var sig = null, sigCd = 0, sigFx = [], sigFlash = 0, sigCount = { fired: 0, caught: 0 };
  function sigParams() {
    var b = SIG_BASE[currentSkin] || SIG_BASE.orange, st = uniStage(), esm = entityScaleMult;
    var p = { kind: currentSkin, R: b.R * (st >= 2 ? 1.1 : 1) * esm, half: b.half * Math.PI / 180, cd: b.cd * (st >= 3 ? 0.85 : 1), max: b.max };
    if (st >= 4) { if (currentSkin === "black" || currentSkin === "calico") p.cd *= 0.85; else p.max += 1; }
    p.lv5 = st >= 5; return p;
  }
  function sigReset() { rtLast = null; sig = null; sigCd = 0; sigFx.length = 0; sigFlash = 0; sigCount = { fired: 0, caught: 0 }; }
  function terrLineClear(x0, y0, x1, y1) {
    if (!TERR) return true; var d = distance(x0, y0, x1, y1), n = Math.ceil(d / 18);
    for (var i = 1; i <= n; i++) { var k = i / n; if (TERR.blocked(x0 + (x1 - x0) * k, y0 + (y1 - y0) * k, 0)) return false; } return true;
  }
  function sigFxAdd(o) { if (o.opt && resScale < 1 && (dayNow.night > 0.5 || Math.random() < 0.5)) return; /* v19：弱设备夜晚去掉额外特效 */ o.age = 0; sigFx.push(o); }
  function sigStart(m, p) {
    var dx = m.x - cat.x, dy = m.y - cat.y, d = Math.sqrt(dx * dx + dy * dy) || 1;
    sig = { kind: p.kind, p: p, m: m, seed: m.seed, ph: "wind", t: 0, wind: 0.06, ux: dx / d, uy: dy / d, caught: 0, hitStopped: false, go: false, hide: false, z: 0, n: 0 };
    sigCd = p.cd; uniCancel(); sigCount.fired++;
    if (CA.sfx.uni) CA.sfx.uni("pounce", 0); buzz(12);
  }
  var SIG_APP = { orange: 0.45, white: 0.4, calico: 0.55, blue: 0.4, siamese: 0.5 };
  function sigDash() {
    var S = sig, d = distance(S.m.x, S.m.y, cat.x, cat.y);
    S.app = S.kind === "black" ? 1e9 : SIG_APP[S.kind] * S.p.R;
    if (d <= S.app) { sigGo(); return; }
    S.ph = "dash"; S.t = 0; S.go = true; if (CA.sfx.uni) CA.sfx.uni("dash");
  }
  function sigGo() {
    var S = sig, m = S.m, p = S.p, esm = entityScaleMult; S.ph = "go"; S.t = 0; S.go = true;
    var tx = m.x + (m.vx || 0) * 0.12, ty = m.y + (m.vy || 0) * 0.12, dx = tx - cat.x, dy = ty - cat.y, d = Math.sqrt(dx * dx + dy * dy) || 1;
    S.ux = dx / d; S.uy = dy / d; S.sx = cat.x; S.sy = cat.y;
    if (S.kind === "orange") { S.dur = 0.3; S.len = Math.min(p.R + 20 * esm, d); }
    else if (S.kind === "black") {
      var bx = m.x - S.ux * cat.r * 0.6, by = m.y - S.uy * cat.r * 0.6;
      S.dur = 0.08; S.bx = bx; S.by = by; S.hide = true;
      sigFxAdd({ type: "smoke", x: cat.x, y: cat.y }); sigFxAdd({ type: "eye", x: cat.x, y: cat.y, x2: bx, y2: by });
    }
    else if (S.kind === "white") { S.dur = 0.16; S.len = Math.min(p.R + 10 * esm, d + 6); }
    else if (S.kind === "calico") { S.dur = 0.25; S.gold = m.type === "gold"; S.len = d; S.mx0 = m.x; S.my0 = m.y; if (CA.sfx.uni) CA.sfx.uni("dash"); }
    else if (S.kind === "blue") { S.dur = 0.35; S.len = Math.min(p.R, d + 60 * esm); if (CA.sfx.uni) CA.sfx.uni("dash"); }
    else { S.dur = 0.12; S.len = d + 4; }
    S.done = 0;
  }
  function sigCanFire(m, p) {
    var dx = m.x - cat.x, dy = m.y - cat.y, d = Math.sqrt(dx * dx + dy * dy); if (d > SIG_RANGE || d < 1) return false;
    if (p.kind !== "black" && !terrLineClear(cat.x, cat.y, m.x, m.y)) return false;
    if (p.kind === "black") { var bx = m.x - dx / d * cat.r * 0.6, by = m.y - dy / d * cat.r * 0.6; if (!terrLineClear(cat.x, cat.y, bx, by) || (TERR && TERR.blocked(bx, by, cat.r * 0.8))) return false; }
    if (p.kind === "calico" || p.kind === "blue") { if (!terrLineClear(cat.x, cat.y, m.x, m.y)) return false; }
    return true;
  }
  function sigUpdate(dt) {
    sigCd = Math.max(0, sigCd - dt); if (sigFlash > 0) sigFlash -= dt;
    for (var i = sigFx.length - 1; i >= 0; i--) { sigFx[i].age += dt; if (sigFx[i].age > (sigFx[i].life || 0.5)) sigFx.splice(i, 1); }
    if (sigFx.length > 60) sigFx.splice(0, sigFx.length - 60);
    for (i = lockFx.length - 1; i >= 0; i--) { lockFx[i].age += dt; if (lockFx[i].age > 0.6) lockFx.splice(i, 1); }
    if (!SURV_ON && !sig && lock && sigCd <= 0 && !poopSitting() && !(uni && uni.lunge) && !bioCatStunned()) {
      var p = sigParams();
      if (lock.nest) { if (sigCanFireNest(lock.nest, p)) sigStartNest(lock.nest, p); }
      else if (lock.m && sigCanFire(lock.m, p)) sigStart(lock.m, p);
    }
  }
  function sigCanFireNest(n, p) {
    if (!n || !n.alive || n.destroying) return false;
    var dx = n.x - cat.x, dy = n.y - cat.y, d = Math.sqrt(dx * dx + dy * dy); if (d > SIG_RANGE || d < 1) return false;
    if (p.kind !== "black" && !terrLineClear(cat.x, cat.y, n.x, n.y)) return false;
    return true;
  }
  function sigStartNest(n, p) {
    var proxy = { x: n.x, y: n.y - 8, vx: 0, vy: 0, seed: n.x * 0.13 + n.y, nestTarget: n, type: "grey" };
    sigStart(proxy, p); sig.nestTarget = n; sig.nestHit = false;
  }
  function trySigHitNest() {
    var S = sig; if (!S || !S.nestTarget || S.nestHit) return;
    var n = S.nestTarget; if (!n.alive || n.destroying) return;
    if (distance(cat.x, cat.y, n.x, n.y) <= NEST_HIT_R) { S.nestHit = true; hitNest(n); }
  }
  function sigEnd() {
    var S = sig; if (S && S.nestTarget) trySigHitNest();
    sig = null; if (!S) return; cat.squash = 1;
    for (var i = 0; i < 4; i++) spawnDust(cat.x, cat.y, Math.atan2(S.uy, S.ux) + (i - 1.5) * 0.9, 10 * entityScaleMult);
    feedback("land");
  }
  function sigNextBounce() { // 暹罗：90 内找下一只
    var S = sig, best = null, bd = 90 * entityScaleMult;
    gridEach(cat.x, cat.y, bd + 20, function (m) { if (!uniOk(m) || m === S.m) return; var d = distance(m.x, m.y, cat.x, cat.y); if (d < bd) { bd = d; best = m; } });
    return best;
  }
  // 在 updateCat 里调用（位移类）
  function sigStep(dt) {
    var S = sig; if (!S) return; var esm = entityScaleMult;
    var alive = S.nestTarget ? (S.nestTarget.alive && !S.nestTarget.destroying) : (mice.indexOf(S.m) >= 0 && S.m.seed === S.seed && uniOk(S.m));
    if (S.nestTarget) { S.m.x = S.nestTarget.x; S.m.y = S.nestTarget.y - 8; }
    S.t += dt;
    if (S.ph === "wind") { if (!alive) { sig = null; sigCd = Math.min(sigCd, 0.3); return; } if (S.t >= S.wind) sigDash(); return; }
    if (S.ph === "dash") { // v20：快速冲刺贴近，再放招牌效果
      if (!alive) { sig = null; sigCd = Math.min(sigCd, 0.3); return; }
      var dm = S.m, ddx = dm.x - cat.x, ddy = dm.y - cat.y, dd = Math.sqrt(ddx * ddx + ddy * ddy) || 1;
      if (dd <= S.app || S.t > 0.3) { sigGo(); return; }
      var st0 = Math.min(SIG_DASH_V * dt, dd - S.app), ox = cat.x, oy = cat.y; S.ux = ddx / dd; S.uy = ddy / dd;
      cat.x += S.ux * st0; cat.y += S.uy * st0; cat.facing = Math.atan2(S.uy, S.ux);
      var ob2 = queryNearbyObstacles(cat.x, cat.y); for (var j = 0; j < ob2.length; j++) resolveCircleAabb(cat, ob2[j]); if (TERR) TERR.push(cat);
      if (!reducedMotion) sigFxAdd({ type: "wind", x: cat.x, y: cat.y, a: Math.atan2(S.uy, S.ux), off: (Math.random() - 0.5) * 24, opt: 1 });
      if (distance(ox, oy, cat.x, cat.y) < st0 * 0.35) sigGo(); // 撞墙就地出招
      return;
    }
    var k = Math.min(1, S.t / S.dur), e, step, px = cat.x, py = cat.y;
    if (S.kind === "black") {
      if (k >= 1 && !S.arrived) { S.arrived = true; cat.x = S.bx; cat.y = S.by; S.hide = false; sigFxAdd({ type: "smoke", x: cat.x, y: cat.y }); if (CA.sfx.uni) CA.sfx.uni("land"); trySigHitNest(); }
      else if (S.arrived && S.t >= S.dur + 0.08) sigEnd();
      return;
    }
    if (S.nestTarget && S.kind === "calico") { // 打窝：钩子也只算位移贴近
      if (k >= 1 || !alive) { trySigHitNest(); sigEnd(); } return;
    }
    if (S.kind === "calico" && !S.gold) { // 拉鼠到嘴边
      if (alive) { var m = S.m; m.stun = Math.max(m.stun || 0, 0.1); m.stunKind = "hook"; m.x = S.mx0 + (cat.x - S.mx0) * k * k; m.y = S.my0 + (cat.y - S.my0) * k * k; }
      if (k >= 1 || !alive) sigEnd(); return;
    }
    if (S.kind === "orange") { e = k; S.z = Math.sin(Math.PI * k) * 42 * esm; }
    else if (S.kind === "blue") e = k;
    else e = 1 - (1 - k) * (1 - k);
    step = S.len * e - S.done; S.done = S.len * e;
    cat.x += S.ux * step; cat.y += S.uy * step;
    var obs = queryNearbyObstacles(cat.x, cat.y);
    if (S.kind !== "orange") { for (var i = 0; i < obs.length; i++) resolveCircleAabb(cat, obs[i]); if (TERR) TERR.push(cat); }
    if (S.kind === "blue") {
      if (!reducedMotion && Math.random() < 0.6) sigFxAdd({ type: "wind", x: cat.x, y: cat.y, a: Math.atan2(S.uy, S.ux), off: (Math.random() - 0.5) * 30, opt: 1 });
      var moved = distance(px, py, cat.x, cat.y); if (step > 0.5 && moved < step * 0.35) { S.bumped = true; k = 1; } // 撞障碍弹停
    }
    if (k >= 1) {
      if (S.kind === "orange") { S.z = 0; for (i = 0; i < obs.length; i++) resolveCircleAabb(cat, obs[i]); if (TERR) TERR.push(cat); sigFxAdd({ type: "ring", x: cat.x, y: cat.y, col: "rgba(255,220,170,", r: 40 });
        if (S.caught < S.p.max) { var nb = null, nd = 40 * esm + cat.r; gridEach(cat.x, cat.y, nd + 10, function (mm) { if (uniOk(mm)) { var dd = distance(mm.x, mm.y, cat.x, cat.y); if (dd < nd) { nd = dd; nb = mm; } } }); if (nb) { sigEnd(); uniStartLunge(nb, true); uni.lunge.keep = true; return; } } }
      if (!S.nestTarget && S.kind === "siamese" && S.caught > 0 && S.caught < S.p.max) { var nx = sigNextBounce(); if (nx) { S.m = nx; S.seed = nx.seed; S.n++; sigGo(); return; } }
      if (S.nestTarget) trySigHitNest();
      sigEnd();
    } else if (S.nestTarget) trySigHitNest();
  }
  function sigCatchBonus() { return sig && sig.go && sig.kind === "blue" && sig.caught < sig.p.max ? 15 * entityScaleMult : 0; }
  function sigOnCapture(m) {
    if (!sig || !sig.go) return;
    sig.caught++; sigCount.caught++;
    if (!sig.hitStopped && !reducedMotion) { sig.hitStopped = true; hitStopT = Math.max(hitStopT, 0.06); sigFlash = 0.034; }
    buzz(18);
    if (sig.kind === "white") {
      sigFxAdd({ type: "ice", x: cat.x, y: cat.y, r: 70, life: 0.6 });
      gridEach(cat.x, cat.y, 80 * entityScaleMult, function (o) { if (o !== m && uniOk(o) && distance(o.x, o.y, cat.x, cat.y) < 70 * entityScaleMult) stunM(o, 1.2, "ice"); });
    }
    if (sig.kind === "siamese") { sigFxAdd({ type: "note", x: m.x, y: m.y - 20, n: sig.n, life: 0.8 }); if (CA.sfx.uni) CA.sfx.uni("chain", sig.n + 1); }
    if (sig.kind === "orange" || sig.kind === "blue") sigFxAdd({ type: "ring", x: m.x, y: m.y, col: "rgba(255,255,255,", r: 26 });
  }
  function sigCatStretch() {
    if (!sig || reducedMotion) return null;
    if (sig.ph === "wind") return { a: Math.atan2(sig.uy, sig.ux), s: 0.86 };
    if (sig.kind === "blue") return { a: Math.atan2(sig.uy, sig.ux), s: 0.9 };
    return { a: Math.atan2(sig.uy, sig.ux), s: 1 + 0.3 * Math.sin(Math.PI * Math.min(1, sig.t / (sig.dur || 1))) };
  }
  // ---- 画：锁定准星 / 小旗 / 预告扇形 / 冷却环（猫下面） ----
  function sigDrawUnder() {
    var col = SIG_COL[currentSkin] || "#ff8a2a", t = elapsedPlayTime, csx = worldToScreenX(cat.x), csy = worldToScreenY(cat.y);
    if (flag) { var fx0 = worldToScreenX(flag.x), fy0 = worldToScreenY(flag.y); ctx.fillStyle = "rgba(0,0,0,.18)"; ctx.beginPath(); ctx.ellipse(fx0, fy0, s(9), s(4), 0, 0, 7); ctx.fill();
      ctx.strokeStyle = "#6b4a2a"; ctx.lineWidth = s(2.5); ctx.beginPath(); ctx.moveTo(fx0, fy0); ctx.lineTo(fx0, fy0 - s(28)); ctx.stroke();
      ctx.fillStyle = col; ctx.beginPath(); ctx.moveTo(fx0, fy0 - s(28)); ctx.lineTo(fx0 + s(16), fy0 - s(23) + Math.sin(t * 8) * s(1.5)); ctx.lineTo(fx0, fy0 - s(17)); ctx.fill(); }
    if (lock && !sig) { ctx.strokeStyle = "rgba(255,255,255,.22)"; ctx.lineWidth = s(1.5); ctx.setLineDash([s(6), s(8)]); ctx.beginPath(); ctx.arc(csx, csy + s(10), s(SIG_RANGE), 0, 7); ctx.stroke(); ctx.setLineDash([]); }
    if (lock && lock.nest) {
      var nx0 = worldToScreenX(lock.nest.x), ny0 = worldToScreenY(lock.nest.y) + s(4), nr = s(28) + Math.sin(t * 9) * s(1.5);
      ctx.strokeStyle = "#c4a574"; ctx.lineWidth = s(3.5); ctx.lineCap = "round";
      for (var qn = 0; qn < 4; qn++) { var a1 = qn * Math.PI / 2 + t * 1.5; ctx.beginPath(); ctx.arc(nx0, ny0, nr, a1 + 0.25, a1 + 1.1); ctx.stroke(); }
      emojiQuick("🕳️", nx0, ny0 - s(40), s(18));
    } else if (lock && lock.m) { var m = lock.m, mx = worldToScreenX(m.x), my = worldToScreenY(m.y) + s(4), r = s(20) + Math.sin(t * 9) * s(1.5);
      if (lock.t < 0.6) { ctx.globalAlpha = 1 - lock.t / 0.6; ctx.setLineDash([s(5), s(5)]); ctx.strokeStyle = "#fff"; ctx.lineWidth = s(2); ctx.beginPath(); ctx.moveTo(csx, csy); ctx.lineTo(mx, my); ctx.stroke(); ctx.setLineDash([]); ctx.globalAlpha = 1; }
      ctx.strokeStyle = col; ctx.lineWidth = s(3.5); ctx.lineCap = "round";
      for (var q = 0; q < 4; q++) { var a0 = q * Math.PI / 2 + t * 1.5; ctx.beginPath(); ctx.arc(mx, my, r, a0 + 0.25, a0 + 1.1); ctx.stroke(); }
      ctx.fillStyle = col; ctx.beginPath(); var ty = my - s(40) - Math.abs(Math.sin(t * 6)) * s(4); ctx.moveTo(mx - s(6), ty); ctx.lineTo(mx + s(6), ty); ctx.lineTo(mx, ty + s(8)); ctx.fill(); }
    for (var i = 0; i < lockFx.length; i++) { var L = lockFx[i]; emojiQuick("✖", worldToScreenX(L.x), worldToScreenY(L.y) - s(30), s(18), 1 - L.age / 0.6, "#888"); }
    if (sig && sig.ph === "wind") { // 预告：扇形/直线亮一下
      var p = sig.p, a = Math.atan2(sig.uy, sig.ux), R = s(p.R); ctx.fillStyle = col; ctx.globalAlpha = 0.22;
      ctx.beginPath(); if (p.kind === "blue") { ctx.save(); ctx.translate(csx, csy + s(10)); ctx.rotate(a); ctx.fillRect(0, -s(15), R, s(30)); ctx.restore(); }
      else if (p.half >= Math.PI) { ctx.arc(csx, csy + s(10), R, 0, 7); ctx.fill(); }
      else { ctx.moveTo(csx, csy + s(10)); ctx.arc(csx, csy + s(10), R, a - p.half, a + p.half); ctx.closePath(); ctx.fill(); }
      ctx.globalAlpha = 1; }
    if (sigCd > 0 && lock) { var P = sigParams(), fr = 1 - sigCd / P.cd; ctx.strokeStyle = "rgba(255,255,255,.75)"; ctx.lineWidth = s(2); ctx.beginPath(); ctx.arc(csx, csy + s(14), s(22), -Math.PI / 2, -Math.PI / 2 + fr * 6.283); ctx.stroke(); }
    // 毛线 / 眼光
    if (sig && sig.ph === "go" && sig.kind === "calico") { var mm = sig.m; ctx.strokeStyle = "#ff6fa8"; ctx.lineWidth = s(3); ctx.beginPath(); ctx.moveTo(csx, csy); ctx.quadraticCurveTo((csx + worldToScreenX(mm.x)) / 2, (csy + worldToScreenY(mm.y)) / 2 - s(20), worldToScreenX(mm.x), worldToScreenY(mm.y)); ctx.stroke();
      ctx.strokeStyle = "#ffd23f"; ctx.lineWidth = s(1.5); ctx.stroke(); emojiQuick("🧶", worldToScreenX(mm.x), worldToScreenY(mm.y) - s(8), s(18), 1); }
    if (sig && sig.ph === "go" && sig.kind === "orange") { ctx.setLineDash([s(4), s(6)]); ctx.strokeStyle = "rgba(255,138,42,.8)"; ctx.lineWidth = s(2.5); ctx.beginPath(); ctx.moveTo(worldToScreenX(sig.sx), worldToScreenY(sig.sy));
      var ex = sig.sx + sig.ux * sig.len, ey = sig.sy + sig.uy * sig.len; ctx.quadraticCurveTo(worldToScreenX((sig.sx + ex) / 2), worldToScreenY((sig.sy + ey) / 2) - s(84 * entityScaleMult), worldToScreenX(ex), worldToScreenY(ey)); ctx.stroke(); ctx.setLineDash([]); }
  }
  function sigDrawOver() {
    for (var i = 0; i < sigFx.length; i++) { var f = sigFx[i], life = f.life || 0.5, k = f.age / life, x = worldToScreenX(f.x), y = worldToScreenY(f.y);
      if (f.type === "smoke") { ctx.fillStyle = "rgba(60,40,90," + (0.7 * (1 - k)) + ")"; for (var j = 0; j < 5; j++) { var aa = j * 1.26 + f.x; ctx.beginPath(); ctx.arc(x + Math.cos(aa) * s(16) * k, y + Math.sin(aa) * s(10) * k, s(10) * (1 - k * 0.5), 0, 7); ctx.fill(); } }
      else if (f.type === "eye") { ctx.strokeStyle = "rgba(255,220,60," + (1 - k) + ")"; ctx.lineWidth = s(3); ctx.beginPath(); ctx.moveTo(x, y - s(10)); ctx.lineTo(worldToScreenX(f.x2), worldToScreenY(f.y2) - s(10)); ctx.stroke(); }
      else if (f.type === "ring") { ctx.strokeStyle = f.col + (1 - k) + ")"; ctx.lineWidth = s(3); ctx.beginPath(); ctx.ellipse(x, y + s(12), s(f.r) * (0.4 + k), s(f.r) * (0.4 + k) * 0.5, 0, 0, 7); ctx.stroke(); }
      else if (f.type === "ice") { ctx.strokeStyle = "rgba(150,220,255," + (1 - k) + ")"; ctx.lineWidth = s(5); ctx.beginPath(); ctx.ellipse(x, y + s(10), s(f.r) * Math.min(1, k * 3), s(f.r) * 0.55 * Math.min(1, k * 3), 0, 0, 7); ctx.stroke(); if (k < 0.5) emojiQuick("❄️", x + s(30), y - s(10), s(16), 1 - k * 2); }
      else if (f.type === "wind") { ctx.strokeStyle = "rgba(255,255,255," + (1 - k) * 0.8 + ")"; ctx.lineWidth = s(2); var c = Math.cos(f.a), sn = Math.sin(f.a), ox = -sn * s(f.off), oy = c * s(f.off); ctx.beginPath(); ctx.moveTo(x + ox - c * s(10), y + s(12) + oy - sn * s(10)); ctx.lineTo(x + ox - c * s(38), y + s(12) + oy - sn * s(38)); ctx.stroke(); }
      else if (f.type === "note") { emojiQuick(["♪", "♫", "🎶", "⭐"][Math.min(3, f.n)], x, y - s(30) * k, s(20 + f.n * 3), 1 - k, "#3fa9ff"); }
    }
    if (sigFlash > 0) { ctx.fillStyle = "rgba(255,255,255,0.35)"; ctx.fillRect(0, 0, W, H); }
  }

  // =======================================================================
  // v21 BIOHAZARD2：捕捉驱动变异概率 + 窝感染 + 3 心眩晕复活（服务端零改）
  // =======================================================================
  var BIO_INFECT_R = 80, BIO_INFECT_T = 1.5, BIO_BITE_R = 90, BIO_BITE_WIND = 0.4;
  var BIO_HEARTS_MAX0 = 3, bioFishBonus = 0, bioDeath = null;
  var bio = { seen: false, hearts: 3, maxHearts: 3, stun: 0, iFrames: 0, banner: null, bannerT: 0, nightCount: 0, wasNight: false, blood: false };
  function maxHeartsFor(C) { return C >= 80 ? 6 : C >= 40 ? 5 : C >= 15 ? 4 : 3; }
  function bioReset() {
    bio.seen = SURV_ON ? true : false; bio.hearts = 3; bio.maxHearts = 3; bio.stun = 0; bio.iFrames = 0;
    bio.banner = null; bio.bannerT = 0; bio.nightCount = 0; bio.wasNight = false; bio.blood = false; bioFishBonus = 0; bioDeath = null;
  }
  function bioCheckHeartGrowth() {
    var mh = maxHeartsFor(catches);
    if (mh > bio.maxHearts) {
      bio.maxHearts = mh; bio.hearts = Math.min(bio.maxHearts, bio.hearts + 1);
      bioShowBanner("上限 +1 · 现在 " + bio.maxHearts + " 心", 2.0); buzz(12);
    }
  }
  function mutantP(C) {
    if (SURV_ON) return 0; // M1：关闭捕捉驱动变异
    if (C < 15) return 0;
    if (C < 40) return 0.05 + (C - 15) / 25 * 0.07;
    if (C < 80) return 0.12 + (C - 40) / 40 * 0.16;
    if (C < 150) return 0.28 + (C - 80) / 70 * 0.17;
    return 0.50;
  }
  function applyMutantRoll(m, nest) {
    if (!m) return m;
    if (m.type === "gold") { // 金鼠优先；感染窝可带绿边但不改分
      if (nest && nest.infected) m.tainted = true;
      return m;
    }
    var force = !SURV_ON && nest && nest.infected, p = force ? 1 : mutantP(catches);
    if (force || Math.random() < p) {
      m.mutant = true; m.hp = 2; m.infectAcc = 0; m.biteT = 0; m.biteCd = 0; m.biting = false;
      if (!bio.seen) { bio.seen = true; bioShowBanner("⚠ 变异鼠出现了！", 2.4); }
    }
    return m;
  }
  function infectNest(n) {
    if (!n || !n.alive || n.infected) return;
    n.infected = true; n.infectFlash = 1.2;
    if (n.maxHits < 4) { n.maxHits = 4; n.hitsLeft = Math.min(n.hitsLeft + 1, 4); }
    if (CA.sfx.nest) CA.sfx.nest("burst");
    bioShowBanner("🦠 老鼠窝被感染！", 2.2); buzz(18);
  }
  function bioInfectRatio() {
    var a = 0, t = 0; for (var i = 0; i < nests.length; i++) if (nests[i].alive) { t++; if (nests[i].infected) a++; }
    return t ? a / t : 0;
  }
  function bioShowBanner(txt, sec) { bio.banner = txt; bio.bannerT = sec || 2; }
  function tryHitMouse(m) {
    // 返回 true = 已消灭；false = 未死。招牌扑（冲刺/出招）一击；普攻 2 击，带短暂无敌
    if (!m.mutant) return true;
    if (m.hitInv > 0) return false;
    var sigKill = !!(sig && sig.go);
    if (sigKill) return true;
    m.hp = (m.hp == null ? 2 : m.hp) - 1; m.hitInv = 0.4; m.flash = 0.35;
    if (m.hp <= 0) return true;
    var a = Math.atan2(m.y - cat.y, m.x - cat.x); m.vx = Math.cos(a) * 220; m.vy = Math.sin(a) * 220;
    m.stun = Math.max(m.stun || 0, 0.25); m.excl = 0.5; buzz(8); return false;
  }
  function onMutantCaptureBonus(m) {
    if (!m.mutant) return;
    bioFishBonus++;
    try { storageSet("catmouse_fish", String(lsNum("catmouse_fish") + 1)); } catch (e) {}
  }
  function bioCatStunned() { return !!nestPoopAnim; }
  function bioTakeBite() {
    if (bio.iFrames > 0 || nestPoopAnim) return;
    bio.hearts = Math.max(0, bio.hearts - 1); bio.iFrames = 0.8 + (SURV_ON && surv ? survPassLv("armor") * 0.15 : 0);
    if (SURV_ON && surv && surv.dmgSrc) { survNoteDmg(survPendingSrc || "变异鼠咬"); survPendingSrc = null; } hitStopT = Math.max(hitStopT, 0.08);
    feedback("wave"); buzz(30);
    if (bio.hearts <= 0) {
      if (!bioDeath) bioDeath = SURV_ON ? "horde" : "mutant";
      clearTargets(); if (sig) sig = null; moveDir.x = 0; moveDir.y = 0;
      enterResult();
    }
  }
  function bioUpdate(dt) {
    if (bio.bannerT > 0) { bio.bannerT -= dt; if (bio.bannerT <= 0) bio.banner = null; }
    if (bio.iFrames > 0) bio.iFrames = Math.max(0, bio.iFrames - dt);
    var night = dayNow.night > 0.5;
    if (night && !bio.wasNight) bio.nightCount++;
    bio.wasNight = night;
    var ir = bioInfectRatio();
    bio.blood = night && (ir >= 0.5 || catches >= 80) && bio.nightCount >= 1;
    // 变异鼠：感染窝 + 咬猫
    for (var i = 0; i < mice.length; i++) {
      var m = mice[i]; if (!m.mutant || !uniOk(m) || m.boss) continue;
      if (m.hitInv > 0) m.hitInv -= dt;
      if (m.flash > 0) m.flash -= dt;
      if (m.biteCd > 0) m.biteCd -= dt;
      // 不愿上坡（喘气点）：山体附近减速
      if (TERR && TERR.blocked && m.state !== "flee") {
        // 轻量：朝窝走时用 infect 行为
      }
      // 感染：锁定最近普通窝；靠近累计 / 钻入即染
      if (m.noInfect) { m.infectTarget = null; } else if (!m.infectTarget || !m.infectTarget.alive || m.infectTarget.infected) {
        var best = null, bd = 1e9;
        for (var j = 0; j < nests.length; j++) { var n0 = nests[j]; if (!n0.alive || n0.infected) continue; var dd = distance(m.x, m.y, n0.x, n0.y); if (dd < bd) { bd = dd; best = n0; } }
        m.infectTarget = best; m.infectAcc = 0;
      }
      if (m.infectTarget) {
        var n = m.infectTarget, dn = distance(m.x, m.y, n.x, n.y);
        if (dn < BIO_INFECT_R) {
          m.infectAcc = (m.infectAcc || 0) + dt;
          if (m.infectAcc >= BIO_INFECT_T || dn < 28) infectNest(n);
        } else m.infectAcc = Math.max(0, (m.infectAcc || 0) - dt * 0.5);
      }
      // 咬：进 90 世界单位蓄力 0.4s（固定值，不乘 entityScaleMult）
      if (bio.seen && bio.stun <= 0 && !(m.biteCd > 0) && !(sig && sig.hide) && !(bio.iFrames > 0)) {
        var dc = distance(m.x, m.y, cat.x, cat.y);
        if (dc < BIO_BITE_R) {
          if (!m.biting) { m.biting = true; m.biteT = BIO_BITE_WIND; }
          m.biteT -= dt;
          if (m.biteT <= 0) {
            m.biting = false; m.biteT = 0; m.biteCd = 1.4;
            if (distance(m.x, m.y, cat.x, cat.y) < BIO_BITE_R + 25) bioTakeBite();
          }
        } else { m.biting = false; m.biteT = 0; }
      } else if (m.biteCd > 0) { m.biting = false; }
    }
  }
  function drawBioHud() {
    if ((!bio.seen && !SURV_ON) || (state !== STATE_PLAY && state !== STATE_PAUSE)) return;
    var x0 = 14 + (typeof CSS !== "undefined" ? 0 : 0);
    // 心：左上计数下方
    var hx = 18, hy = 48; try { var sa = getComputedStyle(document.documentElement); } catch (e) {}
    hx = 18; hy = 52;
    for (var i = 0; i < bio.maxHearts; i++) {
      var on = i < bio.hearts; ctx.globalAlpha = on ? 1 : 0.35;
      emojiQuick(on ? "❤️" : "🖤", hx + i * 20, hy, 16);
    }
    ctx.globalAlpha = 1;
    // 感染细条
    var ir = bioInfectRatio();
    if (ir > 0) {
      var bw = 72, bx = W / 2 - bw / 2, by = 36;
      ctx.fillStyle = "rgba(0,0,0,.35)"; ctx.fillRect(bx, by, bw, 5);
      ctx.fillStyle = "rgba(80,220,90,.85)"; ctx.fillRect(bx, by, bw * ir, 5);
    }
    if (bio.banner && bio.bannerT > 0) {
      ctx.globalAlpha = Math.min(1, bio.bannerT * 2); ctx.fillStyle = "rgba(20,30,20,.55)";
      var tw = Math.min(W - 40, 280); ctx.fillRect(W / 2 - tw / 2, 70, tw, 28);
      ctx.fillStyle = "#e8ffe8"; ctx.font = "bold 14px system-ui,sans-serif"; ctx.textAlign = "center";
      ctx.fillText(bio.banner, W / 2, 89); ctx.globalAlpha = 1;
    }
  }
  function drawBioOverlays() {
    // 咬电报
    for (var i = 0; i < mice.length; i++) {
      var m = mice[i]; if (!m.mutant || !(m.biteT > 0)) continue;
      var sx = worldToScreenX(m.x), sy = worldToScreenY(m.y);
      if (sx < -40 || sx > W + 40 || sy < -40 || sy > H + 40) continue;
      var k = 1 - m.biteT / BIO_BITE_WIND;
      ctx.strokeStyle = "rgba(255,60,60," + (0.45 + 0.5 * k) + ")"; ctx.lineWidth = s(3);
      ctx.beginPath(); ctx.arc(sx, sy, s(28 + k * 18), 0, 7); ctx.stroke();
      emojiQuick("!", sx, sy - s(36), s(22), null, "#ff3030");
    }
    // 变异鼠受伤闪
    for (i = 0; i < mice.length; i++) {
      m = mice[i]; if (!m.mutant || !(m.flash > 0)) continue;
      sx = worldToScreenX(m.x); sy = worldToScreenY(m.y);
      ctx.globalAlpha = m.flash / 0.35 * 0.5; ctx.fillStyle = "#7CFF7A";
      ctx.beginPath(); ctx.arc(sx, sy, s(22), 0, 7); ctx.fill(); ctx.globalAlpha = 1;
    }
  }
  function drawBioAtmosphere() {
    if (!bio.seen) return;
    var ir = bioInfectRatio();
    // 不安：淡绿雾（弱设备跳过）
    if (resScale >= 1 && !reducedMotion && ir < 0.5 && !bio.blood) {
      ctx.fillStyle = "rgba(40,120,50," + (0.04 + 0.06 * Math.min(1, ir * 2)) + ")";
      ctx.fillRect(0, 0, W, H * 0.18); ctx.fillRect(0, H * 0.82, W, H * 0.18);
    }
    // 血月
    if (bio.blood) {
      var a = resScale < 1 ? 0.12 : 0.22;
      ctx.fillStyle = "rgba(140,20,30," + a + ")"; ctx.fillRect(0, 0, W, H);
      if (resScale >= 1) {
        ctx.fillStyle = "rgba(255,60,40,.55)"; ctx.beginPath();
        ctx.arc(W * 0.78, H * 0.12, s(28), 0, 7); ctx.fill();
      }
    }
  }
  function drawMutantTint(m, sx, sy, u) {
    if (!m.mutant && !m.tainted) return;
    ctx.save();
    ctx.globalAlpha = 0.55;
    ctx.fillStyle = m.mutant ? "#5cff6a" : "#9dff9a";
    ctx.beginPath(); ctx.ellipse(sx, sy + 2 * u, 16 * u, 10 * u, 0, 0, 7); ctx.fill();
    if (m.mutant) {
      ctx.globalAlpha = 0.9; ctx.fillStyle = "#ff3a3a";
      ctx.beginPath(); ctx.arc(sx - 5 * u, sy - 8 * u, 2.2 * u, 0, 7); ctx.arc(sx + 5 * u, sy - 8 * u, 2.2 * u, 0, 7); ctx.fill();
      if (m.hp === 1) { ctx.globalAlpha = 0.7; emojiQuick("💢", sx + 14 * u, sy - 28 * u, 12 * u); }
    }
    ctx.restore();
  }

  // =======================================================================
  // v23 SURVIVORS M1：《猫猫守卫战》— 见 skills-design/survivors/SURVIVORS_FINAL.md
  // =======================================================================
  var SURV_DASH_CD = 3, SURV_DASH_DUR = 0.22, SURV_DASH_SPD = 720, SURV_DASH_IFRAME = 0.3;
  var SURV_AUTO_CD0 = 0.8, SURV_AUTO_R = 105;
  var SURV_CONTACT_R = 28, SURV_CONTACT_WIND = 0.35, SURV_CONTACT_CD = 1.0;
  var SURV_GEM_MERGE = 40, SURV_GEM_LIFE_DAY = 20, SURV_GEM_LIFE_NIGHT = 12;
  var surv = null;
  var survPickEl = null;
  function survXpNeed(lv) {
    // 近似定稿曲线压缩到 1 循环：约 Lv10≈420
    var tab = [0, 5, 12, 25, 45, 75, 115, 165, 230, 310, 400, 500, 620, 760, 920];
    return tab[Math.min(lv, tab.length - 1)] || (920 + (lv - 14) * 180);
  }
  function survWeaponDefs() {
    return {
      chain: { name: "连环扑咬", icon: "🐾", kind: "weapon", desc: function (lv) { return "每 " + (4 - lv * 0.25).toFixed(1) + "s 扑咬最近 " + Math.min(5, lv) + " 只"; } },
      yarn: { name: "毛线飞球", icon: "🧶", kind: "weapon", desc: function (lv) { return "每 3s 发射 " + lv + " 枚穿透毛线球"; } },
      fear: { name: "恐惧光环", icon: "😱", kind: "weapon", desc: function (lv) { return "每 8s 定身周围鼠 " + (0.8 + lv * 0.4).toFixed(1) + "s"; } }
    };
  }
  function survPassiveDefs() {
    return {
      speed: { name: "疾跑鞋", icon: "👟", kind: "passive", desc: function (lv) { return "移速 +" + (lv * 6) + "%"; } },
      magnet: { name: "磁力项圈", icon: "🧲", kind: "passive", desc: function (lv) { return "拾取半径 +" + (lv * 40) + "%"; } },
      tempo: { name: "节拍器", icon: "⏱", kind: "passive", desc: function (lv) { return "攻击冷却 -" + (lv * 6) + "%"; } },
      fur: { name: "厚皮毛", icon: "🛡️", kind: "passive", desc: function (lv) { return "心心上限 +1 并回 1（唯一）"; } },
      soup: { name: "鱼汤", icon: "🍲", kind: "passive", desc: function (lv) { return "立刻回复 1 心"; } }
    };
  }
  function survAllDefs() { var W = survWeaponDefs(), P = survPassiveDefs(); survAddDefs(W, P); return { W: W, P: P }; }
  function survReset() {
    surv = {
      level: 1, xp: 0, kills: 0, gems: [], weapons: {}, passives: {},
      dashCd: 0, dashT: 0, dashUx: 1, dashUy: 0, autoCd: 0,
      spawnMult: 1, panicAt: -1, panicDone: false, won: false, picking: false,
      nightSeen: 0, contactT: 0, yarn: [], fearT: 0, chainT: 0,
      moveSp: 1, magnet: 1, tempo: 1, invuln: false, autoOff: false
    };
    surv.weapons.chain = 1; // 开局自带一件通用武，保证有输出反馈
    survM2Reset();
    survHidePick();
  }
  function survActive() { return SURV_ON && !!surv; }
  function survRunDur() { return SURV_CYCLES >= 3 ? SURV_BOSS_AT + SURV_BOSS_SURVIVE + 5 : CYCLE_T * SURV_CYCLES; }
  function survTimeT() { return clamp01(elapsedPlayTime / Math.max(1, survRunDur())); }
  function survPassLv(id) { return (surv && surv.passives[id]) || 0; }
  function survWeapLv(id) { return (surv && surv.weapons[id]) || 0; }
  function survRefreshStats() {
    if (!surv) return;
    surv.moveSp = (1 + survPassLv("speed") * 0.06) * (1 + talLv("swift") * 0.04);
    surv.magnet = (1 + survPassLv("magnet") * 0.4) * (1 + talLv("magnet") * 0.05);
    surv.tempo = Math.max(0.55, 1 - survPassLv("tempo") * 0.06);
    surv.talClaw = 1 - talLv("claw") * 0.04; surv.talDash = 1 - talLv("dash") * 0.04; surv.talXp = 1 + talLv("greed") * 0.05;
  }
  function survDropGem(x, y, v) {
    if (!surv) return;
    surv.gems.push({ x: x, y: y, v: v || 1, age: 0, life: dayNow.night > 0.5 ? SURV_GEM_LIFE_NIGHT : SURV_GEM_LIFE_DAY, merge: false });
  }
  function survOnKill(m) {
    if (!survActive()) return;
    surv.kills++; bestNote(m);
    var v = m.type === "gold" ? 8 : m.type === "brown" ? 3 : 1;
    if (m.mutant) v = 12;
    if (m.elite) v = 30;
    if (m.boss) v = 0;
    if (v > 0) survDropGem(m.x, m.y, v);
    survM2OnKill(m);
  }
  function survAddXp(v) {
    if (!surv || surv.picking) return;
    surv.xp += v * (1 + survPassLv("growth") * 0.1) * (surv.talXp || 1);
    var guard = 0;
    while (surv.xp >= survXpNeed(surv.level) && guard++ < 8) {
      surv.xp -= survXpNeed(surv.level);
      surv.level++;
      survOpenPick();
      if (surv.picking) break;
    }
  }
  function survCardPool() {
    var AD = survAllDefs(), W = AD.W, P = AD.P, out = [];
    var wCount = 0; for (var k in surv.weapons) if (surv.weapons[k] > 0 && k !== "main") wCount++;
    var pCount = 0; for (k in surv.passives) if (surv.passives[k] > 0 && k !== "soup") pCount++;
    for (k in W) {
      var lv = survWeapLv(k);
      if (lv <= 0 && wCount >= 3) continue; // 通用武器槽 3 + 招牌
      if (lv >= 5) continue;
      out.push({ id: k, def: W[k], lv: lv, next: lv + 1 });
    }
    for (k in P) {
      lv = survPassLv(k);
      if (k === "fur" && lv >= 1) continue;
      if (k === "soup") { out.push({ id: k, def: P[k], lv: 0, next: 1, once: true }); continue; }
      if (lv <= 0 && pCount >= 4) continue; // 被动槽 4
      if (lv >= 5) continue;
      out.push({ id: k, def: P[k], lv: lv, next: lv + 1 });
    }
    // shuffle
    for (var i = out.length - 1; i > 0; i--) { var j = Math.floor(Math.random() * (i + 1)); var t = out[i]; out[i] = out[j]; out[j] = t; }
    out = survAwakCards(false).concat(out);
    return out.slice(0, 3);
  }
  function survApplyCard(c) {
    if (!c) return;
    if (c.awk) { surv.awak[c.awk] = 1; bioShowBanner("✨ " + c.def.name, 2); survRefreshStats(); return; }
    if (c.def.kind === "weapon") surv.weapons[c.id] = (surv.weapons[c.id] || 0) + 1;
    else if (c.id === "soup") { bio.hearts = Math.min(bio.maxHearts, bio.hearts + 1); bioShowBanner("🍲 回复 1 心", 1.4); }
    else if (c.id === "fur") {
      surv.passives.fur = 1; bio.maxHearts = Math.min(5, bio.maxHearts + 1);
      bio.hearts = Math.min(bio.maxHearts, bio.hearts + 1); bioShowBanner("🛡️ 厚皮毛 · 上限 +1", 1.6);
    } else surv.passives[c.id] = (surv.passives[c.id] || 0) + 1;
    survRefreshStats();
  }
  function survEnsurePickUI() {
    if (survPickEl) return survPickEl;
    var el = document.createElement("div");
    el.id = "survPick"; el.className = "overlay hidden"; el.innerHTML = '<div class="panel surv-pick-panel"><h2>升级！选一张</h2><div class="surv-cards" id="survCards"></div></div>';
    document.body.appendChild(el);
    survPickEl = el; return el;
  }
  function survHidePick() {
    if (surv) surv.picking = false;
    var el = document.getElementById("survPick"); if (el) el.classList.add("hidden");
  }
  var survDbgAutoPick = false;
  function survOpenPick(forced, title) {
    if (!surv || surv.picking) return;
    var cards = forced || survCardPool();
    if (!cards.length) return;
    if (survDbgAutoPick) { survApplyCard(cards[0]); survRefreshStats && survRefreshStats(); if (surv.chestQ > 0) { surv.chestQ--; survOpenChest(); } return; }
    surv.picking = true;
    var el = survEnsurePickUI();
    var h2 = el.querySelector("h2"); if (h2) h2.textContent = title || "升级！选一张";
    var box = el.querySelector("#survCards"); box.innerHTML = "";
    cards.forEach(function (c) {
      var b = document.createElement("button"); b.type = "button"; b.className = "surv-card";
      b.innerHTML = "<div class=\"ic\">" + c.def.icon + "</div><div class=\"nm\">" + c.def.name + (c.once ? "" : (" Lv" + c.next)) + "</div><div class=\"ds\">" + c.def.desc(c.next) + "</div>";
      b.addEventListener("click", function () {
        survApplyCard(c); el.classList.add("hidden"); surv.picking = false;
        // 若经验仍够连升
        if (surv.chestQ > 0) { surv.chestQ--; survOpenChest(); }
        else if (surv.xp >= survXpNeed(surv.level)) survAddXp(0);
      });
      box.appendChild(b);
    });
    el.classList.remove("hidden");
  }
  function survTryDash(wx, wy) {
    if (!survActive() || surv.picking || surv.dashCd > 0 || surv.dashT > 0) return false;
    var dx = wx - cat.x, dy = wy - cat.y, d = Math.sqrt(dx * dx + dy * dy);
    if (d < 8) { dx = Math.cos(cat.facing) || 1; dy = Math.sin(cat.facing) || 0; d = 1; }
    surv.dashUx = dx / d; surv.dashUy = dy / d; surv.dashT = SURV_DASH_DUR; surv.dashCd = Math.max(1.2, SURV_DASH_CD - survPassLv("dashp") * 0.3) * (surv.talDash || 1);
    bio.iFrames = Math.max(bio.iFrames, SURV_DASH_IFRAME);
    buzz(12); feedback("wave");
    return true;
  }
  function survDamageMouse(m, dmg) {
    if (!m || !uniOk(m)) return false;
    dmg = dmg || 1;
    if (!m.mutant) {
      // 普鼠：直接击杀（AutoPounce / 武器）
      var idx = mice.indexOf(m); if (idx < 0) return false;
      m._survXpDone = false; onCapture(m); recycleMouse(idx); return true;
    }
    if (m.hitInv > 0) return false;
    m.hp = (m.hp == null ? 2 : m.hp) - dmg; m.hitInv = 0.25; m.flash = 0.3;
    if (m.hp <= 0) { var i2 = mice.indexOf(m); if (i2 >= 0) { m._survXpDone = false; onCapture(m); recycleMouse(i2); } return true; }
    buzz(6); return false;
  }
  function survNearestMice(n, r) {
    var arr = [];
    for (var i = 0; i < mice.length; i++) {
      var m = mice[i]; if (!uniOk(m)) continue;
      var d = distance(m.x, m.y, cat.x, cat.y); if (d <= r) arr.push({ m: m, d: d });
    }
    arr.sort(function (a, b) { return a.d - b.d; });
    return arr.slice(0, n);
  }
  function survAutoPounce() {
    var list = survNearestMice(1, SURV_AUTO_R * entityScaleMult);
    if (!list.length) return;
    var m = list[0].m;
    survDamageMouse(m, 1);
    sigFxAdd({ type: "ring", x: m.x, y: m.y, r: 18, col: "rgba(255,180,80,", life: 0.25 });
    cat.squash = 1; buzz(8);
  }
  function survFireChain() {
    var lv = survWeapLv("chain"); if (lv <= 0) return;
    var list = survNearestMice(Math.min(5, lv) * (surv.awak && surv.awak.chain ? 2 : 1), 160 * entityScaleMult);
    for (var i = 0; i < list.length; i++) survDamageMouse(list[i].m, 1);
  }
  function survFireYarn() {
    var lv = survWeapLv("yarn"); if (lv <= 0) return;
    var yn = lv + (surv.awak && surv.awak.yarn ? 2 : 0);
    for (var i = 0; i < yn; i++) {
      var a = cat.facing + (i - (yn - 1) / 2) * 0.35;
      surv.yarn.push({ x: cat.x, y: cat.y, ux: Math.cos(a), uy: Math.sin(a), life: 0.7, hit: {} });
    }
  }
  function survFireFear() {
    var lv = survWeapLv("fear"); if (lv <= 0) return;
    var R = (70 + lv * 18) * entityScaleMult, st = 0.8 + lv * 0.4;
    for (var i = 0; i < mice.length; i++) {
      var m = mice[i]; if (!uniOk(m)) continue;
      if (distance(m.x, m.y, cat.x, cat.y) < R) { if (surv.awak && surv.awak.fear && !m.mutant) survDamageMouse(m, 1); else stunM(m, st, "dizzy"); }
    }
    sigFxAdd({ type: "ring", x: cat.x, y: cat.y, r: R / entityScaleMult, col: "rgba(180,120,255,", life: 0.4 });
  }
  function survDirector(dt) {
    if (!surv || surv.won || surv.picking) return;
    var cycleT = elapsedPlayTime % CYCLE_T;
    var cycleIdx = Math.floor(elapsedPlayTime / CYCLE_T);
    // 教学低压
    if (elapsedPlayTime < 90) surv.spawnMult = 0.55;
    else if (dayNow.phase === "dusk") surv.spawnMult = 1.2;
    else if (dayNow.phase === "night") surv.spawnMult = 1.85;
    else surv.spawnMult = 1.0;
    // 黄昏恐慌波：每循环一次
    var panicKey = cycleIdx;
    if (dayNow.phase === "dusk" && cycleT >= DAY_T + 1 && !surv.panicDone) {
      surv.panicDone = true;
      var ang = Math.random() * Math.PI * 2, dist = 280 * entityScaleMult;
      for (var p = 0; p < 3; p++) {
        var px = cat.x + Math.cos(ang) * (dist + p * 40), py = cat.y + Math.sin(ang) * (dist + p * 40);
        spawnPack({ x: px, y: py }, 5, survTimeT());
      }
      bioShowBanner("⚠ 鼠潮来袭！", 2.0); buzz(20);
    }
    if (dayNow.phase === "day") surv.panicDone = false;
    // 夜数涨心：进入 night 且 nightCount 增加时（bioUpdate 已计 nightCount）
    if (bio.nightCount > surv.nightSeen) {
      surv.nightSeen = bio.nightCount;
      var want = Math.min(5, 3 + bio.nightCount);
      if (want > bio.maxHearts) {
        bio.maxHearts = want; bio.hearts = Math.min(bio.maxHearts, bio.hearts + 1);
        bioShowBanner("上限 +1 · 现在 " + bio.maxHearts + " 心", 2.0);
      }
    }
    // 黎明胜利（完成配置循环数）
    if (elapsedPlayTime >= survRunDur() - 0.05) {
      surv.won = true; bioDeath = null;
      // 溃逃
      for (var i = 0; i < mice.length; i++) startFlee(mice[i], 1);
      score += 2000;
      bioShowBanner("🌅 黎明到了！", 2.5);
      setTimeout(function () { if (state === STATE_PLAY) enterResult(); }, 1200);
    }
  }
  // =======================================================================
  // v24 SURVIVORS M2：3 循环 / 精英词缀 / 鼠王 / 宝箱 / 六猫主武 / 全池+觉醒 / 小偷鼠 / 弱机上限
  // =======================================================================
  var SURV_BOSS_AT = 580, SURV_BOSS_SURVIVE = 60, SURV_ELITE_AT = [150, 280, 400, 470, 520];
  var SURV_MAIN = {
    orange: { name: "橘风旋扑", sup: "猛虎扑杀", icon: "🌀", cd: 5, desc: function (lv) { return "每 " + (5 - lv * 0.4).toFixed(1) + "s 震开周围鼠并眩晕"; } },
    black: { name: "影缚", sup: "暗影处决", icon: "🌑", cd: 4.5, desc: function (lv) { return "定身最近 " + (2 + lv) + " 只 1.5s"; } },
    white: { name: "霜环", sup: "绝对零度", icon: "❄️", cd: 6, desc: function (lv) { return "冰冻周围 " + (1 + lv * 0.2).toFixed(1) + "s"; } },
    calico: { name: "招财铃", sup: "金币雨", icon: "🔔", cd: 6, desc: function (lv) { return "吸来 " + (250 + lv * 50) + " 内鱼干并震晕近鼠"; } },
    blue: { name: "重压", sup: "陨星压", icon: "💥", cd: 5.5, desc: function (lv) { return "砸地击退+眩晕 1s（半径 " + (90 + lv * 10) + "）"; } },
    siamese: { name: "声波", sup: "裂空啸", icon: "📢", cd: 4, desc: function (lv) { return "前方声波定身 1.2s，长 " + (240 + lv * 20); } }
  };
  var SURV_AWAK = { // 通用觉醒：武器 Lv5 + 指定被动
    chain: { need: "tempo", name: "雷霆连扑", icon: "⚡" },
    yarn: { need: "magnet", name: "磁暴毛线", icon: "🧲" },
    fear: { need: "armor", name: "夜王威压", icon: "👑" },
    claw: { need: "speed", name: "千刃风", icon: "🗡️" },
    bell: { need: "fur", name: "圣铃结界", icon: "🔔" },
    milk: { need: "growth", name: "奶海", icon: "🥛" }
  };
  var SURV_AFFIX = {
    haste: { name: "疾风", col: "rgba(120,220,255,", ic: "💨" },
    shield: { name: "护盾", col: "rgba(255,230,120,", ic: "🛡️" },
    regen: { name: "再生", col: "rgba(120,255,140,", ic: "💚" }
  };
  function survMainDef() { return SURV_MAIN[currentSkin] || SURV_MAIN.orange; }
  function survIsWeak() { return resScale < 1 || (navigator.hardwareConcurrency || 8) <= 4 || (navigator.deviceMemory || 8) <= 3; }
  function survM2Reset() {
    surv.weapons.main = 1; surv.awak = {}; surv.chestsOnMap = []; surv.eliteDone = {}; surv.boss = null; surv.bossSpawned = false;
    surv.bossKilled = false; surv.thiefT = 22; surv.mainT = 1.2; surv.clawT = 1; surv.bellA = 0; surv.milk = []; surv.milkT = 2;
    surv.fx = []; surv.dmgSrc = {}; surv.lastHitBy = null; surv.chestOpen = false; surv.stolenTotal = 0;
  }
  function survAddDefs(W, P) {
    var md = survMainDef();
    W.main = { name: "招牌·" + md.name, icon: md.icon, kind: "weapon", main: true, desc: md.desc };
    W.claw = { name: "利爪横扫", icon: "🐾", kind: "weapon", desc: function (lv) { return "前方扇形斩杀 " + (1 + lv) + " 只"; } };
    W.bell = { name: "守护铃", icon: "🔔", kind: "weapon", desc: function (lv) { return lv + " 个环绕铃，碰到即击退眩晕"; } };
    W.milk = { name: "牛奶滩", icon: "🥛", kind: "weapon", desc: function (lv) { return "脚下留奶滩，鼠踩上减速，半径 " + (60 + lv * 10); } };
    P.armor = { name: "软垫", icon: "🧸", kind: "passive", desc: function (lv) { return "受伤无敌 +" + (lv * 0.15).toFixed(2) + "s"; } };
    P.growth = { name: "学识", icon: "📖", kind: "passive", desc: function (lv) { return "经验 +" + (lv * 10) + "%"; } };
    P.dashp = { name: "猫步", icon: "🐈", kind: "passive", desc: function (lv) { return "冲刺冷却 -" + (lv * 0.3).toFixed(1) + "s"; } };
  }
  function survAwakCards(includeMain) {
    var out = [];
    for (var k in SURV_AWAK) {
      var a = SURV_AWAK[k];
      if (survWeapLv(k) >= 5 && survPassLv(a.need) >= 1 && !surv.awak[k])
        out.push({ id: "awk_" + k, awk: k, def: { name: "觉醒·" + a.name, icon: a.icon, kind: "awak", desc: function () { return "武器进化，可击杀"; } }, lv: 0, next: 1, once: true });
    }
    if (includeMain && survWeapLv("main") >= 5 && !surv.awak.main) {
      var md = survMainDef();
      out.unshift({ id: "awk_main", awk: "main", def: { name: "专属超武·" + md.sup, icon: "🌟", kind: "awak", desc: function () { return "招牌技能可直接击杀"; } }, lv: 0, next: 1, once: true });
    }
    return out;
  }
  function survChestCards() {
    var aw = survAwakCards(true);
    var AD = survAllDefs(), W = AD.W, P = AD.P, up = [];
    for (var k in surv.weapons) if (surv.weapons[k] > 0 && surv.weapons[k] < 5 && W[k]) up.push({ id: k, def: W[k], lv: surv.weapons[k], next: surv.weapons[k] + 1 });
    for (k in surv.passives) if (surv.passives[k] > 0 && surv.passives[k] < 5 && P[k] && k !== "fur") up.push({ id: k, def: P[k], lv: surv.passives[k], next: surv.passives[k] + 1 });
    for (var i = up.length - 1; i > 0; i--) { var j = Math.floor(Math.random() * (i + 1)); var t = up[i]; up[i] = up[j]; up[j] = t; }
    var out = aw.concat(up);
    if (!out.length) out = [{ id: "soup", def: P.soup, lv: 0, next: 1, once: true }];
    return out.slice(0, 3);
  }
  // ---- 精英 ----
  function survSpawnElite(affix, at) {
    var keys = Object.keys(SURV_AFFIX); affix = affix || keys[Math.floor(Math.random() * keys.length)];
    var p = at || ringPointNear(260);
    var m = spawnMouseAt(p.x, p.y, "brown", survTimeT(), "wander");
    m.mutant = true; m.elite = affix; m.hp = m.maxHp = Math.round((10 + 14 * survTimeT()) * (affix === "shield" ? 1.6 : 1));
    m.biteCd = 0; m.biting = false; m.infectAcc = 0; m.infectTarget = null; m.noInfect = true;
    bioShowBanner("⚠ 精英鼠 · " + SURV_AFFIX[affix].name, 2); buzz(15);
    return m;
  }
  function ringPointNear(r) {
    for (var t = 0; t < 8; t++) { var a = Math.random() * 6.283, x = cat.x + Math.cos(a) * r * entityScaleMult, y = cat.y + Math.sin(a) * r * entityScaleMult; if (!inObstacle(x, y, 14)) return { x: x, y: y }; }
    return { x: cat.x + r, y: cat.y };
  }
  // ---- 鼠王 ----
  function survSpawnBoss() {
    var p = ringPointNear(300);
    var m = spawnMouseAt(p.x, p.y, "brown", 1, "wander");
    m.mutant = true; m.boss = true; m.survCtl = true; m.noInfect = true; m.hp = m.maxHp = 260; m.phase = 1; m.bT = 3; m.charge = 0;
    surv.boss = m; surv.bossSpawned = true; surv.bossAt = elapsedPlayTime;
    bioShowBanner("👑 鼠王降临！击杀或坚持 " + SURV_BOSS_SURVIVE + "s", 3); buzz(40); shakeT = 0.3; shakeAmp = 6;
  }
  function survBossUpdate(dt) {
    var b = surv.boss; if (!b) return;
    if (mice.indexOf(b) < 0) { surv.boss = null; return; }
    var esm = entityScaleMult, f = b.hp / b.maxHp;
    var ph = f > 0.66 ? 1 : f > 0.33 ? 2 : 3;
    if (ph !== b.phase) { b.phase = ph; bioShowBanner(ph === 2 ? "鼠王召唤鼠群！" : "鼠王狂暴！", 2); shakeT = 0.25; shakeAmp = 5; }
    if (b.hitInv > 0) b.hitInv -= dt; if (b.flash > 0) b.flash -= dt;
    if (b.regenT > 0) b.regenT -= dt;
    var dx = cat.x - b.x, dy = cat.y - b.y, d = Math.sqrt(dx * dx + dy * dy) || 1;
    var sp = (ph === 3 ? 125 : 85) * esm;
    if (b.charge > 0) { b.charge -= dt; b.x += b.cux * 430 * esm * dt; b.y += b.cuy * 430 * esm * dt; }
    else if (b.wind > 0) { b.wind -= dt; if (b.wind <= 0) { b.charge = 0.55; b.cux = dx / d; b.cuy = dy / d; } }
    else { b.x += dx / d * sp * dt; b.y += dy / d * sp * dt; }
    if (TERR) TERR.push(b);
    b.vx = dx / d; b.vy = dy / d; b.facing = Math.atan2(dy, dx); b.runCycle += dt * 3;
    b.bT -= dt;
    if (b.bT <= 0) {
      if (ph === 1) { b.wind = 0.7; b.bT = 5; }
      else if (ph === 2) { b.bT = 6; for (var i = 0; i < 8 && mice.length < mouseCap(); i++) { var a = i / 8 * 6.283; spawnMouseAt(b.x + Math.cos(a) * 40, b.y + Math.sin(a) * 40, "grey", 1, "wander"); } b.wind = 0.7; }
      else { b.bT = 4; b.wind = 0.5; surv.fx.push({ t: "wave", x: b.x, y: b.y, r: 20, life: 1.6, hit: false }); }
    }
    // 接触（大体型）
    if (d < (46 * esm + cat.r) && bio.iFrames <= 0) { surv.lastHitBy = "鼠王"; survPendingSrc = "鼠王"; bioTakeBite(); if (bioDeath) bioDeath = "boss"; }
  }
  function survNoteDmg(src) { surv.dmgSrc[src] = (surv.dmgSrc[src] || 0) + 1; surv.lastHitBy = src; }
  // ---- 小偷鼠 ----
  function survSpawnThief() {
    if (!surv.gems.length) return null;
    var p = ringPointNear(240);
    var m = spawnMouseAt(p.x, p.y, "grey", survTimeT(), "wander");
    m.thief = true; m.survCtl = true; m.stolen = 0; m.thiefT = 14; return m;
  }
  function survThiefStep(m, dt) {
    var esm = entityScaleMult; m.thiefT -= dt; if (m.stun > 0) { m.stun -= dt; return; }
    var tx, ty, flee = m.thiefT <= 0 || m.stolen >= 12;
    if (!flee) {
      var best = null, bd = 1e9;
      for (var i = 0; i < surv.gems.length; i++) { var g = surv.gems[i], dd = distance(g.x, g.y, m.x, m.y); if (dd < bd) { bd = dd; best = i; } }
      if (best == null) flee = true;
      else {
        var g2 = surv.gems[best]; tx = g2.x; ty = g2.y;
        if (bd < 16 * esm) { m.stolen += g2.v; surv.stolenTotal += g2.v; surv.gems.splice(best, 1); }
      }
    }
    if (flee) { tx = m.x + (m.x - cat.x); ty = m.y + (m.y - cat.y); }
    var dx = tx - m.x, dy = ty - m.y, d = Math.sqrt(dx * dx + dy * dy) || 1, sp = 150 * esm;
    m.vx = dx / d * sp; m.vy = dy / d * sp; m.x += m.vx * dt; m.y += m.vy * dt; m.facing = Math.atan2(dy, dx); m.runCycle += dt * 3;
    if (TERR) TERR.push(m);
    if (flee && distance(m.x, m.y, cat.x, cat.y) > 650 * esm) { var idx = mice.indexOf(m); if (idx >= 0) recycleMouse(idx); }
  }
  // ---- 武器 ----
  function survAoe(R, fn) { for (var i = mice.length - 1; i >= 0; i--) { var m = mice[i]; if (!m || !uniOk(m)) continue; var d = distance(m.x, m.y, cat.x, cat.y); if (d < R) fn(m, d); } }
  function survPush(m, k) { if (m.boss) return; var a = Math.atan2(m.y - cat.y, m.x - cat.x); m.vx = Math.cos(a) * k; m.vy = Math.sin(a) * k; m.x += Math.cos(a) * k * 0.08; m.y += Math.sin(a) * k * 0.08; }
  function survFireMain() {
    var lv = survWeapLv("main"), sup = !!surv.awak.main, esm = entityScaleMult, sk = currentSkin, kill = [];
    var hit = function (m, st, kind) { if (sup) kill.push(m); else stunM(m, st, kind); };
    if (sk === "black") {
      var list = survNearestMice(2 + lv, 200 * esm); list.forEach(function (o) { hit(o.m, 1.5, "dizzy"); surv.fx.push({ t: "ring", x: o.m.x, y: o.m.y, r: 14, life: 0.3, c: "rgba(120,80,200," }); });
    } else if (sk === "white") {
      var R = (70 + lv * 15) * esm; survAoe(R, function (m) { hit(m, 1 + lv * 0.2, "ice"); }); surv.fx.push({ t: "ring", x: cat.x, y: cat.y, r: R / esm, life: 0.4, c: "rgba(160,220,255," });
    } else if (sk === "calico") {
      var Rg = (250 + lv * 50) * esm; surv.gems.forEach(function (g) { if (distance(g.x, g.y, cat.x, cat.y) < Rg) { g.x = cat.x + (g.x - cat.x) * 0.15; g.y = cat.y + (g.y - cat.y) * 0.15; } });
      survAoe(70 * esm, function (m) { hit(m, 0.8, "dizzy"); }); surv.fx.push({ t: "ring", x: cat.x, y: cat.y, r: 70, life: 0.35, c: "rgba(255,210,90," });
      if (sup) for (var q = 0; q < 3; q++) survDropGem(cat.x + (Math.random() - 0.5) * 120 * esm, cat.y + (Math.random() - 0.5) * 120 * esm, 2);
    } else if (sk === "blue") {
      var Rb = (90 + lv * 10) * esm; survAoe(Rb, function (m) { survPush(m, 360); hit(m, 1, "wave"); }); surv.fx.push({ t: "ring", x: cat.x, y: cat.y, r: Rb / esm, life: 0.4, c: "rgba(140,160,200," }); shakeT = 0.12; shakeAmp = 3;
    } else if (sk === "siamese") {
      var L = (240 + lv * 20) * esm, ux = Math.cos(cat.facing), uy = Math.sin(cat.facing);
      survAoe(L, function (m) { var px = m.x - cat.x, py = m.y - cat.y, along = px * ux + py * uy, perp = Math.abs(px * uy - py * ux); if (along > 0 && perp < 40 * esm) hit(m, 1.2, "dizzy"); });
      surv.fx.push({ t: "line", x: cat.x, y: cat.y, ux: ux, uy: uy, L: L / esm, life: 0.3 });
    } else { // orange
      var Ro = (80 + lv * 12) * esm; survAoe(Ro, function (m) { survPush(m, 300); hit(m, 0.5, "wave"); }); surv.fx.push({ t: "ring", x: cat.x, y: cat.y, r: Ro / esm, life: 0.35, c: "rgba(255,160,70," });
    }
    kill.forEach(function (m) { survDamageMouse(m, 3); });
  }
  function survFireClaw() {
    var lv = survWeapLv("claw"); if (lv <= 0) return;
    var aw = !!surv.awak.claw, R = (90 + lv * 10) * entityScaleMult * (aw ? 1.4 : 1), half = aw ? Math.PI : 0.7, n = (1 + lv) * (aw ? 2 : 1), ux = Math.cos(cat.facing), uy = Math.sin(cat.facing);
    var c = survNearestMice(30, R).filter(function (o) { var a = Math.atan2(o.m.y - cat.y, o.m.x - cat.x) - cat.facing; a = Math.atan2(Math.sin(a), Math.cos(a)); return Math.abs(a) < half; }).slice(0, n);
    c.forEach(function (o) { survDamageMouse(o.m, 1); });
    surv.fx.push({ t: "arc", x: cat.x, y: cat.y, r: R / entityScaleMult, a: cat.facing, h: half, life: 0.2 });
  }
  function survUpdateBells(dt) {
    var lv = survWeapLv("bell"); if (lv <= 0) return;
    var aw = !!surv.awak.bell, n = lv + (aw ? 2 : 0), R = 70 * entityScaleMult; surv.bellA += dt * 2.6;
    for (var i = 0; i < n; i++) {
      var a = surv.bellA + i / n * 6.283, bx = cat.x + Math.cos(a) * R, by = cat.y + Math.sin(a) * R;
      for (var k = mice.length - 1; k >= 0; k--) { var m = mice[k]; if (!uniOk(m) || (m.bellCd > elapsedPlayTime)) continue;
        if (distance(m.x, m.y, bx, by) < 20 * entityScaleMult) { m.bellCd = elapsedPlayTime + 0.6; if (aw) survDamageMouse(m, 1); else { survPush(m, 260); stunM(m, 0.6, "wave"); } } }
    }
  }
  function survUpdateMilk(dt) {
    var lv = survWeapLv("milk"); if (lv <= 0) return;
    var aw = !!surv.awak.milk; surv.milkT -= dt;
    if (surv.milkT <= 0) { surv.milkT = 6 * surv.tempo; surv.milk.push({ x: cat.x, y: cat.y, r: (60 + lv * 10) * (aw ? 1.6 : 1), life: 4, tick: 0 }); if (surv.milk.length > 4) surv.milk.shift(); }
    for (var i = surv.milk.length - 1; i >= 0; i--) {
      var p = surv.milk[i]; p.life -= dt; p.tick -= dt; if (p.life <= 0) { surv.milk.splice(i, 1); continue; }
      if (p.tick <= 0) { p.tick = 0.5; var R = p.r * entityScaleMult;
        for (var k = mice.length - 1; k >= 0; k--) { var m = mice[k]; if (!uniOk(m)) continue; if (distance(m.x, m.y, p.x, p.y) < R) { if (aw && !m.mutant && Math.random() < 0.25) survDamageMouse(m, 1); else stunM(m, 0.45, "ice"); } } }
    }
  }
  // ---- 主循环钩子 ----
  function survM2Update(dt) {
    if (!surv.awak) survM2Reset();
    var t = elapsedPlayTime;
    surv.mainT -= dt; if (surv.mainT <= 0) { surv.mainT = Math.max(1.6, (survMainDef().cd - survWeapLv("main") * 0.4)) * surv.tempo; survFireMain(); }
    surv.clawT -= dt; if (survWeapLv("claw") > 0 && surv.clawT <= 0) { surv.clawT = 2.2 * surv.tempo; survFireClaw(); }
    survUpdateBells(dt); survUpdateMilk(dt);
    // 精英时间轴（仅 3 循环版本）
    if (SURV_CYCLES >= 3) for (var i = 0; i < SURV_ELITE_AT.length; i++) if (t >= SURV_ELITE_AT[i] && !surv.eliteDone[i]) { surv.eliteDone[i] = true; survSpawnElite(); }
    if (SURV_CYCLES >= 3 && !surv.bossSpawned && t >= SURV_BOSS_AT) survSpawnBoss();
    survBossUpdate(dt);
    // 精英光环
    for (i = 0; i < mice.length; i++) {
      var e = mice[i]; if (!e.elite) continue;
      if (e.elite === "regen") e.hp = Math.min(e.maxHp, e.hp + dt * 0.8);
      var A = 110 * entityScaleMult;
      gridEach(e.x, e.y, A, function (o) { if (o === e) return; if (e.elite === "haste") o.hasteT = 0.3; else if (e.elite === "shield") o.shieldT = 0.3; else if (o.mutant && o.hp < 2) o.hp += dt * 0.3; });
    }
    // 小偷鼠
    surv.thiefT -= dt; if (surv.thiefT <= 0) { surv.thiefT = 25 + Math.random() * 10; survSpawnThief(); }
    for (i = mice.length - 1; i >= 0; i--) { var m = mice[i]; if (m && m.thief) survThiefStep(m, dt); if (m) { if (m.hasteT > 0) m.hasteT -= dt; if (m.shieldT > 0) m.shieldT -= dt; } }
    // 宝箱拾取
    for (i = surv.chestsOnMap.length - 1; i >= 0; i--) {
      var c = surv.chestsOnMap[i]; c.age = (c.age || 0) + dt;
      if (distance(c.x, c.y, cat.x, cat.y) < 30 * entityScaleMult + cat.r) { surv.chestsOnMap.splice(i, 1); survOpenChest(); break; }
    }
    // fx
    for (i = surv.fx.length - 1; i >= 0; i--) {
      var f = surv.fx[i]; f.life -= dt;
      if (f.t === "wave") { f.r += 240 * dt; var dd = distance(cat.x, cat.y, f.x, f.y) / entityScaleMult; if (!f.hit && Math.abs(dd - f.r) < 18 && bio.iFrames <= 0) { f.hit = true; survPendingSrc = "鼠王冲击波"; bioTakeBite(); if (bioDeath) bioDeath = "boss"; } }
      if (f.life <= 0) surv.fx.splice(i, 1);
    }
    // 鼠王幸存胜利
    if (surv.bossSpawned && !surv.won && t >= surv.bossAt + SURV_BOSS_SURVIVE) survWin(false);
  }
  function survWin(killed) {
    if (surv.won) return;
    surv.won = true; surv.bossKilled = !!killed; bioDeath = null;
    for (var i = 0; i < mice.length; i++) if (!mice[i].boss) startFlee(mice[i], 1);
    score += killed ? 5000 : 2000;
    bioShowBanner(killed ? "👑 鼠王被击败！黎明到了！" : "🌅 撑过鼠王，黎明到了！", 2.5);
    setTimeout(function () { if (state === STATE_PLAY) enterResult(); }, 1200);
  }
  function survOpenChest() {
    if (surv.picking) { surv.chestQ = (surv.chestQ || 0) + 1; return; }
    var cards = survChestCards(); if (!cards.length) return;
    survOpenPick(cards, "🎁 宝箱！选一项");
  }
  function survM2OnKill(m) {
    if (m.elite) { surv.chestsOnMap.push({ x: m.x, y: m.y }); bioShowBanner("🎁 精英掉落宝箱", 1.6); }
    if (m.thief && m.stolen > 0) survDropGem(m.x, m.y, m.stolen);
    if (m.boss) { surv.boss = null; survWin(true); }
  }
  function survM2Draw() {
    var esm = entityScaleMult, i;
    for (i = 0; i < surv.milk.length; i++) { var p = surv.milk[i]; ctx.globalAlpha = Math.min(0.45, p.life * 0.3); ctx.fillStyle = "#fffaf0"; ctx.beginPath(); ctx.arc(worldToScreenX(p.x), worldToScreenY(p.y), s(p.r * esm), 0, 6.283); ctx.fill(); }
    ctx.globalAlpha = 1;
    var bl = survWeapLv("bell"); if (bl > 0) { var n = bl + (surv.awak.bell ? 2 : 0); for (i = 0; i < n; i++) { var a = surv.bellA + i / n * 6.283; emojiQuick("🔔", worldToScreenX(cat.x + Math.cos(a) * 70 * esm), worldToScreenY(cat.y + Math.sin(a) * 70 * esm), s(14)); } }
    for (i = 0; i < surv.chestsOnMap.length; i++) { var c = surv.chestsOnMap[i]; emojiQuick("🎁", worldToScreenX(c.x), worldToScreenY(c.y) - s(4 + Math.sin(elapsedPlayTime * 4) * 3), s(20)); }
    for (i = 0; i < mice.length; i++) {
      var m = mice[i], sx = worldToScreenX(m.x), sy = worldToScreenY(m.y);
      if (sx < -80 || sx > W + 80 || sy < -80 || sy > H + 80) continue;
      if (m.elite) { var af = SURV_AFFIX[m.elite]; ctx.strokeStyle = af.col + ".7)"; ctx.lineWidth = s(3); ctx.beginPath(); ctx.arc(sx, sy, s(22 * esm), 0, 6.283); ctx.stroke(); ctx.globalAlpha = 0.12; ctx.fillStyle = af.col + "1)"; ctx.beginPath(); ctx.arc(sx, sy, s(110 * esm), 0, 6.283); ctx.fill(); ctx.globalAlpha = 1; emojiQuick(af.ic, sx, sy - s(30), s(14)); survBar(sx - s(18), sy - s(22), s(36), m.hp / m.maxHp, "#ff6a4a"); }
      if (m.thief && m.stolen > 0) { emojiQuick("🐟", sx, sy - s(24), s(12)); ctx.fillStyle = "#fff"; ctx.font = "800 " + Math.round(s(10)) + "px sans-serif"; ctx.textAlign = "left"; ctx.fillText("×" + m.stolen, sx + s(7), sy - s(20)); }
      else if (m.thief) emojiQuick("🦹", sx, sy - s(22), s(11));
      if (m.boss) { emojiQuick("👑", sx, sy - s(62 * esm), s(30)); if (m.wind > 0) { ctx.strokeStyle = "rgba(255,60,60,.8)"; ctx.lineWidth = s(4); ctx.beginPath(); ctx.arc(sx, sy, s(50 * esm), 0, 6.283); ctx.stroke(); } }
    }
    for (i = 0; i < surv.fx.length; i++) {
      var f = surv.fx[i], fx = worldToScreenX(f.x), fy = worldToScreenY(f.y);
      if (f.t === "ring") { ctx.strokeStyle = f.c + Math.max(0, f.life * 2).toFixed(2) + ")"; ctx.lineWidth = s(3); ctx.beginPath(); ctx.arc(fx, fy, s(f.r * esm), 0, 6.283); ctx.stroke(); }
      else if (f.t === "wave") { ctx.strokeStyle = "rgba(255,70,70," + Math.min(0.9, f.life).toFixed(2) + ")"; ctx.lineWidth = s(6); ctx.beginPath(); ctx.arc(fx, fy, s(f.r * esm), 0, 6.283); ctx.stroke(); }
      else if (f.t === "line") { ctx.strokeStyle = "rgba(200,180,255," + (f.life * 2.5).toFixed(2) + ")"; ctx.lineWidth = s(30); ctx.beginPath(); ctx.moveTo(fx, fy); ctx.lineTo(fx + f.ux * s(f.L * esm), fy + f.uy * s(f.L * esm)); ctx.stroke(); }
      else if (f.t === "arc") { ctx.fillStyle = "rgba(255,255,255," + (f.life * 2).toFixed(2) + ")"; ctx.beginPath(); ctx.moveTo(fx, fy); ctx.arc(fx, fy, s(f.r * esm), f.a - f.h, f.a + f.h); ctx.closePath(); ctx.fill(); }
    }
    // Boss 血条 + 生存进度
    if (surv.boss) {
      var b = surv.boss, bw = Math.min(W - 60, 300), bx = (W - bw) / 2;
      ctx.fillStyle = "rgba(0,0,0,.5)"; ctx.fillRect(bx - 2, 104, bw + 4, 14);
      survBar(bx, 106, bw, b.hp / b.maxHp, b.phase === 3 ? "#ff2a2a" : "#c84aff", 10);
      var sv = clamp01((elapsedPlayTime - surv.bossAt) / SURV_BOSS_SURVIVE); survBar(bx, 120, bw, sv, "#ffd23f", 5);
      ctx.fillStyle = "#fff"; ctx.font = "800 12px sans-serif"; ctx.textAlign = "center"; ctx.fillText("👑 鼠王 P" + b.phase + " · 击杀 +5000 / 坚持 " + Math.ceil(SURV_BOSS_SURVIVE - (elapsedPlayTime - surv.bossAt)) + "s +2000", W / 2, 100);
    }
  }
  function survBar(x, y, w, f, col, h) { h = h || 4; ctx.fillStyle = "rgba(0,0,0,.45)"; ctx.fillRect(x, y, w, h); ctx.fillStyle = col; ctx.fillRect(x, y, w * clamp01(f), h); }
  var survPendingSrc = null;
  function survUpdate(dt) {
    if (!survActive() || state !== STATE_PLAY) return;
    if (surv.picking) return;
    if (surv.invuln) bio.iFrames = Math.max(bio.iFrames, 1);
    surv.dashCd = Math.max(0, surv.dashCd - dt);
    surv.autoCd = Math.max(0, surv.autoCd - dt);
    surv.chainT -= dt; surv.fearT -= dt;
    // dash move
    if (surv.dashT > 0) {
      surv.dashT -= dt;
      var step = SURV_DASH_SPD * entityScaleMult * dt;
      cat.x += surv.dashUx * step; cat.y += surv.dashUy * step; cat.facing = Math.atan2(surv.dashUy, surv.dashUx);
      var ob = queryNearbyObstacles(cat.x, cat.y); for (var j = 0; j < ob.length; j++) resolveCircleAabb(cat, ob[j]); if (TERR) TERR.push(cat);
      for (var i = 0; i < mice.length; i++) {
        var m = mice[i]; if (!uniOk(m)) continue;
        if (distance(m.x, m.y, cat.x, cat.y) < 50 * entityScaleMult) {
          m.vx = surv.dashUx * 320; m.vy = surv.dashUy * 320; m.stun = Math.max(m.stun || 0, 0.25);
        }
      }
    }
    // AutoPounce
    if (!surv.autoOff && surv.autoCd <= 0 && surv.dashT <= 0) {
      surv.autoCd = SURV_AUTO_CD0 * surv.tempo * (surv.talClaw || 1);
      survAutoPounce();
    }
    // weapons
    var clv = survWeapLv("chain");
    if (clv > 0 && surv.chainT <= 0) { surv.chainT = (4 - clv * 0.25) * surv.tempo; survFireChain(); }
    var ylv = survWeapLv("yarn");
    if (ylv > 0) {
      // fire timer stored in passives yarnT
      surv._yarnT = (surv._yarnT || 0) - dt;
      if (surv._yarnT <= 0) { surv._yarnT = 3 * surv.tempo; survFireYarn(); }
    }
    var flv = survWeapLv("fear");
    if (flv > 0 && surv.fearT <= 0) { surv.fearT = 8 * surv.tempo; survFireFear(); }
    // yarn projectiles
    for (i = surv.yarn.length - 1; i >= 0; i--) {
      var y = surv.yarn[i]; y.life -= dt; y.x += y.ux * 420 * entityScaleMult * dt; y.y += y.uy * 420 * entityScaleMult * dt;
      for (var k = 0; k < mice.length; k++) {
        var mm = mice[k]; if (!uniOk(mm) || y.hit[mm.seed]) continue;
        if (distance(mm.x, mm.y, y.x, y.y) < 22 * entityScaleMult) { y.hit[mm.seed] = 1; survDamageMouse(mm, 1); }
      }
      if (y.life <= 0) surv.yarn.splice(i, 1);
    }
    // gems
    var pickR = 42 * entityScaleMult * surv.magnet;
    for (i = surv.gems.length - 1; i >= 0; i--) {
      var g = surv.gems[i]; g.age += dt;
      if (g.age > g.life) { surv.gems.splice(i, 1); continue; }
      var dg = distance(g.x, g.y, cat.x, cat.y);
      if (dg < pickR * 2.2) { // magnet pull
        var pull = Math.min(1, dt * (2.5 + surv.magnet)); g.x += (cat.x - g.x) * pull; g.y += (cat.y - g.y) * pull;
      }
      if (dg < pickR * 0.55 || distance(g.x, g.y, cat.x, cat.y) < 18 * entityScaleMult) {
        survAddXp(g.v); surv.gems.splice(i, 1); buzz(4);
      }
    }
    if (surv.gems.length > SURV_GEM_MERGE) {
      // merge farthest half into one big
      surv.gems.sort(function (a, b) { return distance(b.x, b.y, cat.x, cat.y) - distance(a.x, a.y, cat.x, cat.y); });
      var mergeN = Math.min(12, surv.gems.length - 20), sum = 0, mx = 0, my = 0;
      for (i = 0; i < mergeN; i++) { sum += surv.gems[i].v; mx += surv.gems[i].x; my += surv.gems[i].y; }
      surv.gems.splice(0, mergeN);
      if (sum > 0) surv.gems.push({ x: mx / mergeN, y: my / mergeN, v: sum, age: 0, life: SURV_GEM_LIFE_DAY, merge: true });
    }
    // contact damage: any mouse close
    var biting = false;
    for (i = 0; i < mice.length; i++) {
      m = mice[i]; if (!uniOk(m) || m.type === "gold") continue;
      if (m.boss || m.thief) continue; if (distance(m.x, m.y, cat.x, cat.y) < SURV_CONTACT_R * entityScaleMult + cat.r) { biting = true; survPendingSrc = m.elite ? "精英鼠" : (m.type === "brown" ? "棕鼠" : "灰鼠"); break; }
    }
    if (biting && bio.iFrames <= 0) {
      surv.contactT += dt;
      if (surv.contactT >= SURV_CONTACT_WIND) { surv.contactT = -SURV_CONTACT_CD; bioTakeBite(); if (bioDeath) bioDeath = "horde"; }
    } else if (surv.contactT > 0) surv.contactT = Math.max(0, surv.contactT - dt * 2);
    else if (surv.contactT < 0) surv.contactT = Math.min(0, surv.contactT + dt); // CD 倒数

    survM2Update(dt);
    survDirector(dt);
  }
  function survDraw() {
    if (!survActive()) return;
    if (surv.awak) survM2Draw();
    // gems
    for (var i = 0; i < surv.gems.length; i++) {
      var g = surv.gems[i], sx = worldToScreenX(g.x), sy = worldToScreenY(g.y);
      if (sx < -20 || sx > W + 20 || sy < -20 || sy > H + 20) continue;
      var al = g.age > g.life - 2 ? Math.max(0.2, (g.life - g.age) / 2) : 1;
      emojiQuick(g.merge || g.v >= 8 ? "🐟" : "🐟", sx, sy - s(4), s(g.merge || g.v >= 5 ? 16 : 12), al);
    }
    // yarn
    for (i = 0; i < surv.yarn.length; i++) {
      var y = surv.yarn[i]; emojiQuick("🧶", worldToScreenX(y.x), worldToScreenY(y.y), s(14), Math.min(1, y.life * 2));
    }
    // dash CD ring at feet
    if (surv.dashCd > 0 || surv.dashT > 0) {
      var csx = worldToScreenX(cat.x), csy = worldToScreenY(cat.y) + s(14);
      var fr = 1 - surv.dashCd / SURV_DASH_CD; if (surv.dashT > 0) fr = 1;
      ctx.strokeStyle = "rgba(255,220,120,.85)"; ctx.lineWidth = s(3);
      ctx.beginPath(); ctx.arc(csx, csy, s(20), -Math.PI / 2, -Math.PI / 2 + fr * 6.283); ctx.stroke();
    }
    // level chip
    ctx.globalAlpha = 0.9; ctx.fillStyle = "rgba(40,24,16,.55)";
    ctx.beginPath(); if (ctx.roundRect) ctx.roundRect(14, 72, 86, 22, 10); else ctx.rect(14, 72, 86, 22); ctx.fill();
    ctx.fillStyle = "#ffe6b0"; ctx.font = "800 12px sans-serif"; ctx.textAlign = "left";
    ctx.fillText("Lv" + surv.level + "  " + Math.floor(surv.xp) + "/" + survXpNeed(surv.level), 22, 87);
    ctx.globalAlpha = 1;
  }

  function update(dt) {
    updateMusic();
    if (state === STATE_PLAY) {
      if (survActive() && surv.picking) { updateHud(); return; } // 选卡暂停世界
      elapsedPlayTime += dt;
      var sdt = dt; if (hitStopT > 0) { hitStopT -= dt; sdt = dt * 0.12; } // 命中停顿：只放慢动作，不影响计时
      updateCat(sdt);
      nestUpdate(dt);
      bioUpdate(sdt);
      if (!SURV_ON) sigUpdate(sdt);
      uniUpdate(sdt);
      updateAbilities(sdt);
      survUpdate(sdt);
      updateCamera(dt);
      ensureChunksAround(camera.x, camera.y);
      pruneFarChunks(dt, camera.x, camera.y);
      updateMice(sdt);
      trySpawnMouse();
      updateComboTimer(dt);
      updateEffects(dt);
      updateJuice(dt);
      updateAnims(dt);
      updateHud();
      missionsUpdate(dt);
      updateMini(dt);
      refreshSnapshotIfDue(Date.now());
      maybeSendHeartbeat(Date.now());
    } else if (state === STATE_PAUSE) {
      maybeSendHeartbeat(Date.now());
    }
  }

  var idleRunCycle = 0;
  function drawIdleScene() {
    drawGround();
    idleRunCycle += 0.016;
    catAnim.t += 0.016;
    drawCatAt(W / 2, H / 2 + s(20), s(CAT_RADIUS * entityScaleMult), catAnim, idleRunCycle, currentSkin);
  }

  function draw() {
    if (state === STATE_START) { drawIdleScene(); return; }
    var shaking = shakeT > 0 && state === STATE_PLAY;
    if (shaking) { shakeT -= 1 / 60; var k0 = shakeAmp * Math.max(0, shakeT / 0.15); ctx.save(); ctx.translate((Math.random() - 0.5) * 2 * k0, (Math.random() - 0.5) * 2 * k0); if (shakeT <= 0) shakeAmp = 0; }
    drawBackground();
    drawFences();
    drawObstacles();
    drawNestsGround();
    drawAbilityGround();
    drawDust();
    uniDrawUnder();
    sigDrawUnder();
    drawMice();
    drawAbilityBehindCat();
    if (typeof survDraw === "function") survDraw();
    drawCat();
    drawTrees();
    drawAbilityOverlay();
    drawNight();
    drawNightGlow();
    drawBioAtmosphere();
    drawDepth();
    drawPoopRing();
    drawEffects();
    drawJuice();
    uniDrawOver();
    sigDrawOver();
    drawBioOverlays();
    drawBioHud();
    drawNestArrows();
    drawMouseArrows();
    drawJoystick();
    if (shaking) ctx.restore();
  }


  // ---- 皮肤选择 & 随机昵称 ----
  // 形容词 + 猫/零食/小动物名词 + 可选后缀；组合数足够多，首次打开也能感觉「像专属」
  var RANDOM_NAME_ADJ = ["软糯", "奶呼呼", "元气", "迷糊", "毛茸茸", "甜甜", "圆滚滚", "小懒", "暖乎乎", "胖嘟嘟", "香喷喷", "蓬松", "乖巧", "呆萌", "爱睡", "小跳跳", "机灵", "呼噜", "懒洋洋", "亮晶晶", "粉扑扑", "小淘气"];
  var RANDOM_NAME_NOUN = ["小团子", "布丁", "汤圆", "麻薯", "饭团", "奶糖", "年糕", "鱼干", "棉花糖", "豆包", "糯米糍", "小橘", "奶盖", "芝麻球", "毛线球", "泡芙", "小猫", "橘猫", "狸花", "喵星人", "爪爪", "小鱼", "松子", "豆豆"];
  var RANDOM_NAME_SUFFIX = ["", "", "喵", "酱", "仔"];
  function allRandomNames() {
    var out = [];
    for (var a = 0; a < RANDOM_NAME_ADJ.length; a++)
      for (var n = 0; n < RANDOM_NAME_NOUN.length; n++)
        for (var x = 0; x < RANDOM_NAME_SUFFIX.length; x++) {
          var name = RANDOM_NAME_ADJ[a] + RANDOM_NAME_NOUN[n] + RANDOM_NAME_SUFFIX[x];
          if (out.indexOf(name) < 0) out.push(name);
        }
    return out;
  }
  function randomNameOk(name) {
    return name.length >= 2 && name.length <= 12 && sanitizeNickname(name) === name && !isNicknameOffensive(name);
  }
  var lastRandomName = "";
  function randomCuteName() {
    for (var tries = 0; tries < 20; tries++) {
      var name = RANDOM_NAME_ADJ[Math.floor(Math.random() * RANDOM_NAME_ADJ.length)] +
        RANDOM_NAME_NOUN[Math.floor(Math.random() * RANDOM_NAME_NOUN.length)] +
        RANDOM_NAME_SUFFIX[Math.floor(Math.random() * RANDOM_NAME_SUFFIX.length)];
      if (name !== lastRandomName && randomNameOk(name)) { lastRandomName = name; return name; }
    }
    return "软糯小团子";
  }
  // 首次打开（本地无昵称）自动生成并写入；已有则不覆盖，输入框仍可改 / 可点骰子重随
  function ensureSavedNickname() {
    var saved = (storageGet("catmouse_nickname", "") || "").trim();
    if (saved) return saved;
    var name = randomCuteName();
    storageSet("catmouse_nickname", name);
    return name;
  }

  var skinGrid = document.getElementById("skinGrid");
  var skinPreview = document.getElementById("skinPreview");
  var skinPreviewCtx = skinPreview.getContext("2d");
  var skinNameEl = document.getElementById("skinName");
  var skinDescEl = document.getElementById("skinDesc");
  var skinAbilityEl = document.getElementById("skinAbility");
  var diceBtn = document.getElementById("diceBtn");
  var skinCards = [];

  function paintSkinCanvas(cv, skinId, scale, cy, opt) {
    var dpr = window.devicePixelRatio || 1;
    var w = cv.clientWidth || cv.width, h = cv.clientHeight || cv.height;
    if (cv.width !== Math.round(w * dpr)) { cv.width = Math.round(w * dpr); cv.height = Math.round(h * dpr); }
    var x = cv.getContext("2d");
    x.setTransform(dpr, 0, 0, dpr, 0, 0);
    x.clearRect(0, 0, w, h);
    x.translate(w / 2, h * cy);
    x.scale(scale * w / 110, scale * w / 110);
    var pc = catImgs(skinId); if (pc) { var im = pc.front, H = 96, Wd = H * im.width / im.height; x.drawImage(im, -Wd / 2, 46 - H, Wd, H); return; }
    window.CatArt.paintCat(x, window.CatArt.skinOf(skinId), opt || {});
  }

  function selectSkin(id) {
    if (SKIN_IDS.indexOf(id) < 0) id = "orange";
    currentSkin = id;
    storageSet("catmouse_skin", id);
    var k = window.CatArt.skinOf(id);
    skinNameEl.textContent = k.name;
    skinDescEl.textContent = k.desc;
    var sk = skillOf(id);
    var html = '<b>' + sk.icon + ' ' + sk.name + '</b><span class="evo-row">';
    for (var li = 0; li < sk.lv.length; li++) html += '<span class="evo-step" title="' + sk.lv[li][1] + '：' + sk.lv[li][2] + '"><em>' + sk.lv[li][0] + '</em>Lv' + (li + 1) + '</span>';
    if (SURV_ON) { var md = SURV_MAIN[id] || SURV_MAIN.orange; skinAbilityEl.innerHTML = '<b>' + md.icon + ' 招牌·' + md.name + '</b><span class="evo-desc">' + md.desc(1) + ' · 升级卡强化，Lv5 开宝箱觉醒专属超武「' + md.sup + '」</span>'; }
    else skinAbilityEl.innerHTML = html + '</span><span class="evo-desc">Lv1 ' + sk.lv[0][1] + '：' + sk.lv[0][2] + ' · 抓 15/40/80/150 只依次进化</span>';
    for (var i = 0; i < skinCards.length; i++) {
      var on = skinCards[i].dataset.skin === id;
      skinCards[i].classList.toggle("selected", on);
      skinCards[i].setAttribute("aria-checked", on ? "true" : "false");
    }
  }

  window.CatArt.SKINS.forEach(function (k) {
    var b = document.createElement("button");
    b.type = "button";
    b.className = "skin-card";
    b.dataset.skin = k.id;
    b.setAttribute("role", "radio");
    var cv = document.createElement("canvas");
    b.appendChild(cv);
    var label = document.createElement("div");
    label.textContent = skillOf(k.id).icon + k.name;
    b.appendChild(label);
    b.addEventListener("click", function () { selectSkin(k.id); });
    skinGrid.appendChild(b);
    skinCards.push(b);
  });
  function paintSkinCards() {
    for (var i = 0; i < skinCards.length; i++) {
      paintSkinCanvas(skinCards[i].querySelector("canvas"), skinCards[i].dataset.skin, 0.95, 0.6);
    }
  }
  var previewT = 0;
  function animateSkinPreview(dt) {
    if (state !== STATE_START) return;
    previewT += dt;
    var w = skinPreview.clientWidth || 128;
    var breathe = 1 + Math.sin(previewT * 2.4) * 0.025;
    paintSkinCanvas(skinPreview, currentSkin, 0.92 * breathe, 0.6, { tail: Math.sin(previewT * 3) });
    void w;
  }
  selectSkin(currentSkin);
  requestAnimationFrame(paintSkinCards);
  window.addEventListener("resize", paintSkinCards);

  diceBtn.addEventListener("click", function () {
    var name = randomCuteName();
    dom.nicknameInput.value = name;
    dom.nicknameHint.classList.add("hidden");
    storageSet("catmouse_nickname", name);
    diceBtn.classList.remove("rolling");
    void diceBtn.offsetWidth;
    diceBtn.classList.add("rolling");
    if (sfx && sfx.catchGrey) { try { sfx.catchGrey(); } catch (e) { /* 静音/无音频时忽略 */ } }
  });

  var lastFrameTime = null;
  // 自适应分辨率：每 2 秒统计一次平均帧率，<45 降到 ×0.75；>57 连续 10 秒再恢复
  var perfWin = { t: 0, n: 0, good: 0, last: 0, hist: [], upd: 0, drw: 0 };
  function adaptRes(rawDt) {
    if (state !== STATE_PLAY) { perfWin.t = 0; perfWin.n = 0; return; }
    perfWin.t += rawDt; perfWin.n++;
    if (perfWin.t < 2) return;
    var fps = perfWin.n / perfWin.t; perfWin.last = fps; perfWin.hist.push(Math.round(fps)); if (perfWin.hist.length > 30) perfWin.hist.shift();
    perfWin.t = 0; perfWin.n = 0;
    if (fps < 45 && resScale === 1 && ((window.devicePixelRatio || 1) > 1.2 || W * H > 900000)) { resScale = 0.75; perfWin.good = 0; resize(); }
    else if (fps < 38 && resScale === 0.75) { resScale = 0.6; perfWin.good = 0; resize(); } // 低端机再降一档渲染分辨率（不改老鼠数量）
    else if (fps > 57 && resScale < 1) { perfWin.good += 2; if (perfWin.good >= 10) { resScale = resScale < 0.75 ? 0.75 : 1; perfWin.good = 0; resize(); } }
    else perfWin.good = 0;
  }
  function frame(now) {
    if (lastFrameTime == null) lastFrameTime = now;
    var rawDt = (now - lastFrameTime) / 1000;
    var dt = Math.min(0.05, rawDt);
    lastFrameTime = now;
    adaptRes(rawDt);
    var tA = performance.now();
    update(dt);
    var tB = performance.now();
    draw();
    var tC = performance.now();
    perfWin.upd = perfWin.upd * 0.95 + (tB - tA) * 0.05; perfWin.drw = perfWin.drw * 0.95 + (tC - tB) * 0.05;
    animateSkinPreview(dt);
    requestAnimationFrame(frame);
  }
  requestAnimationFrame(frame);

  (function () { // 版本号
    var b = window.CAT_BUILD || {}, el = document.getElementById("buildTag");
    if (el) { el.textContent = b.version || "dev"; if (b.sha) { var sm = document.createElement("small"); sm.textContent = " · " + b.sha; el.appendChild(sm); } }
  })();
  buildLbFilter();
  enterStart();

  // =======================================================================
  // Debug hook（只读，供自动化测试使用，不影响正常游戏逻辑）
  // =======================================================================

  window.__catDebug = {
    get state() { return state; },
    get cat() { return { x: cat.x, y: cat.y, vx: cat.vx, vy: cat.vy }; },
    get camera() { return { x: camera.x, y: camera.y }; },
    get mice() { return mice.map(function (m) { return { id: m.seed, x: m.x, y: m.y, type: m.type, state: m.state, beh: m.beh, under: !!m.under, asleep: !!m.asleep, leader: !!m.leader, packId: m.packId || 0, stun: m.stun > 0, mutant: !!m.mutant, hp: m.hp || 0, biteT: m.biteT || 0 }; }); },
    get behCounts() { var c = {}; mice.forEach(function (m) { c[m.beh] = (c[m.beh] || 0) + 1; }); return c; },
    get aimLog() { return aimLog.slice(); },
    get planLog() { return planLog.slice(); },
    get holds() { return ab ? { total: ab.holds, by: ab.hold, plans: ab.plans, cancels: ab.cancels } : null; },
    get aimFxLive() { return ab ? ab.fx.filter(function (f) { return f.k === "aim"; }).map(function (f) { return { age: f.age, tele: f.tele, hits: f.hits, ic: f.ic }; }) : []; },
    get drawStats() { return { drawn: drawStats.drawn, full: drawStats.full, pool: mousePool.length, total: mice.length }; },
    rankToast: function (r) { rankToast(r); },
    get perf() { return { last: perfWin.last, hist: perfWin.hist.slice(), resScale: resScale, dpr: DPR, updMs: Math.round(perfWin.upd * 100) / 100, drawMs: Math.round(perfWin.drw * 100) / 100 }; },
    setForceBeh: function (b) { forceBeh = b || null; },
    setNoSpawn: function (v) { noSpawn = !!v; },
    setDrawFlags: function (f) { dbgDraw = f || {}; },
    setResScale: function (v) { resScale = v; resize(); },
    clearMice: function () { if (ab) ab.boxes.forEach(function (b) { b.mice = []; }); while (mice.length) recycleMouse(mice.length - 1); },
    spawnBehNear: function (dx, dy, beh, n) { for (var i = 0; i < (n || 1); i++) spawnMouseAt(cat.x + dx + (Math.random() - 0.5) * 30, cat.y + dy + (Math.random() - 0.5) * 30, typeForBeh(beh, currentDifficulty()), currentDifficulty(), beh); },
    get abilityPanelOpen() { return !dom.abilityScreen.classList.contains("hidden"); },
    get score() { return score; },
    get catches() { return catches; },
    get nests() { return { list: nests.map(function (n) { return { x: n.x, y: n.y, alive: n.alive, owned: n.owned, silT: n.silT, hide: n.hide, stored: n.stored, infected: !!n.infected, hitsLeft: n.hitsLeft, maxHits: n.maxHits, destroying: !!n.destroying }; }), destroyed: nestStats.destroyed, poopAnim: !!nestPoopAnim, day: dayNow, cap: mouseCap() }; },
    setElapsed: function (t) { elapsedPlayTime = t; },
    nestHere: function (dx, dy) { var n = newNest({ x: cat.x + (dx || 0), y: cat.y + (dy || 0) }); nests.push(n); return nests.length - 1; },
    clearNests: function () { nests.length = 0; },
    get uni() { return { cd: uni.cd, lunge: !!uni.lunge, chainN: uni.chainN, dashT: uni.dashT, dashMul: uni.dashMul, straightT: uni.straightT, stats: uni.stats, corner: mice.filter(function (m) { return m.cornerT > 0; }).length }; },
    get audio() { return window.CatAudio ? window.CatAudio.debug() : null; },
    get combo() { return combo; },
    get chunkCount() { return chunkCache.size; },
    get rankText() { return dom.rankText.textContent; },
    get runId() { return run.id; },
    get myRank() { return mySnapshotRank; },
    get skin() { return currentSkin; },
    get ability() {
      if (!ab) return null;
      return { skin: ab.skin, stage: ab.stage, procs: ab.procs, kittens: ab.kittens.length, boxes: ab.boxes.map(function (b) { return b.mice.length; }),
        balls: ab.balls.length, snowmen: ab.snowmen.length, webs: ab.webs.length, tornados: ab.tornados.length, notes: ab.notes.length,
        stunned: mice.filter(function (m) { return m.stun > 0; }).map(function (m) { return m.stunKind; }), hidden: mice.filter(function (m) { return m.hidden; }).length };
    },
    setCatches: function (n) { catches = n; },
    fireAll: function () { if (ab) for (var k in ab.t) ab.t[k] = 0; },
    setStraight: function (v) { if (ab) ab.straight = v; },
    turn: function () { if (ab) ab.turnAcc = Math.PI; },
    obstaclesNear: function () { return queryNearbyObstacles(cat.x, cat.y).map(function (o) { return { x: o.x - cat.x, y: o.y - cat.y, w: o.w, h: o.h }; }); },
    get sigInfo() { return { cd: sigCd, active: !!sig, kind: sig && sig.kind, fired: sigCount.fired, caught: sigCount.caught, lock: !!lock, flag: !!flag, p: sigParams() }; },
    get miceScreen() { return mice.filter(uniOk).map(function (m) { return { x: worldToScreenX(m.x), y: worldToScreenY(m.y), d: distance(m.x, m.y, cat.x, cat.y), type: m.type }; }); },
    lockNearest: function (maxD) { var b = null, bd = maxD || 1e9; mice.forEach(function (m) { if (!uniOk(m)) return; var d = distance(m.x, m.y, cat.x, cat.y); if (d < bd) { bd = d; b = m; } }); if (b) setLock(b); return !!b; },
    get catScreen() { return { x: worldToScreenX(cat.x), y: worldToScreenY(cat.y) }; },
    teleport: function (x, y) { cat.x = x; cat.y = y; if (TERR) TERR.push(cat); camera.x = x; camera.y = y; },
    setMove: function (x, y) { moveDir.x = x; moveDir.y = y; },
    stepSim: function (sec) { var n = Math.round(sec * 60); for (var i = 0; i < n; i++) update(1 / 60); },
    selectSkin: selectSkin,
    setFacing: function (a) { cat.facing = a; },
    get catAnim() { return { mode: catAnim.mode, dir: catAnim.dir, gulp: !!gulp }; },
    get spriteStats() { return ANIM.stats(); },
    get packs() { var c = {}; mice.forEach(function (m) { if (m.packId) c[m.packId] = (c[m.packId] || 0) + 1; }); return c; },
    spawnPackNear: function (dx, dy, n) { spawnPack({ x: cat.x + dx, y: cat.y + dy }, n || 5, currentDifficulty()); },
    spawnMouseRaw: function (dx, dy, type, beh) { var m = spawnMouseAt(cat.x + dx, cat.y + dy, type || "grey", currentDifficulty(), beh || "wander"); return !!m; },
    spawnMutant: function (dx, dy) { var m = spawnMouseAt(cat.x + (dx||0), cat.y + (dy||0), "grey", currentDifficulty(), "wander"); m.mutant = true; m.hp = 2; m.infectAcc = 0; m.biteCd = 0; m.biting = false; bio.seen = true; return !!m; },
    get bio() { return { seen: bio.seen, hearts: bio.hearts, maxHearts: bio.maxHearts, stun: bio.stun, p: mutantP(catches), ratio: bioInfectRatio(), blood: bio.blood, nightCount: bio.nightCount, fishBonus: bioFishBonus, infected: nests.filter(function(n){return n.alive&&n.infected;}).length, nests: nests.filter(function(n){return n.alive;}).length, iFrames: bio.iFrames }; },
    infectNearestNest: function () { var b=null,bd=1e9; nests.forEach(function(n){ if(!n.alive)return; var d=distance(n.x,n.y,cat.x,cat.y); if(d<bd){bd=d;b=n;} }); if(b) infectNest(b); },
    nearestNest: function () { var b=null,bd=1e9; nests.forEach(function(n){ if(!n.alive)return; var d=distance(n.x,n.y,cat.x,cat.y); if(d<bd){bd=d;b=n;} }); return b?{x:b.x,y:b.y,infected:!!b.infected,hitsLeft:b.hitsLeft,maxHits:b.maxHits}:null; },
    lockNearestNest: function () { var b=null,bd=1e9; nests.forEach(function(n){ if(!n.alive||n.destroying)return; var d=distance(n.x,n.y,cat.x,cat.y); if(d<bd){bd=d;b=n;} }); if(b) setNestLock(b); return !!b; },
    hitNearestNest: function () { var b=null,bd=1e9; nests.forEach(function(n){ if(!n.alive)return; var d=distance(n.x,n.y,cat.x,cat.y); if(d<bd){bd=d;b=n;} }); if(b) return hitNest(b); },
    survDash: function (dx, dy) { if (!survActive()) return false; if (surv.picking) return false; return survTryDash(cat.x + (dx == null ? 120 : dx), cat.y + (dy || 0)); },
    survSkipTo: function (sec) {
      if (!survActive()) return;
      survHidePick();
      elapsedPlayTime = Math.max(0, sec); dayNow = dayInfo();
      // 预热夜计数：已过的夜按循环估算，避免 skip 丢成长
      var nights = 0; for (var c = 0; c < SURV_CYCLES; c++) { var base = c * CYCLE_T; if (elapsedPlayTime >= base + DAY_T + DUSK_T) nights++; }
      if (nights > bio.nightCount) {
        bio.nightCount = nights; bio.wasNight = dayNow.night > 0.5;
        var want = Math.min(5, 3 + bio.nightCount);
        if (want > bio.maxHearts) { bio.maxHearts = want; bio.hearts = Math.min(bio.maxHearts, bio.hearts + 1); }
        surv.nightSeen = bio.nightCount;
      }
    },
    survForceLevel: function () { if (!survActive()) return; surv.xp = survXpNeed(surv.level); survAddXp(0); },
    survGod: function (on) { if (!surv) return; surv.invuln = on !== false; if (!surv.invuln) bio.iFrames = 0; },
    survHurt: function (n) {
      if (!survActive()) return bio.hearts;
      var times = Math.max(1, n == null ? 1 : n | 0);
      for (var i = 0; i < times; i++) {
        if (state !== STATE_PLAY) break;
        bio.iFrames = 0; surv.invuln = false; surv.contactT = SURV_CONTACT_WIND;
        bioTakeBite(); if (bioDeath) bioDeath = "horde";
      }
      return bio.hearts;
    },
    survDisarm: function () {
      if (!surv) return;
      surv.weapons = {}; surv.autoOff = true; surv.autoCd = 9999; surv.chainT = 9999; surv.fearT = 9999; surv.yarn = [];
    },
    survAutoPick: function (on) { survDbgAutoPick = on !== false; },
    survSetCycles: function (n) { SURV_CYCLES = Math.max(1, n|0); },
    survSpawnElite: function (af) { var m = survSpawnElite(af, { x: cat.x + 120, y: cat.y }); return { hp: m.hp, elite: m.elite }; },
    survSpawnBoss: function () { survSpawnBoss(); return !!surv.boss; },
    survBossHit: function (n) { var b = surv && surv.boss; if (!b) return null; b.hp -= (n || 10); if (b.hp <= 0) { b.hp = 1; b.hitInv = 0; survDamageMouse(b, 5); } return surv.boss ? surv.boss.hp : 0; },
    get survBoss() { var b = surv && surv.boss; return b ? { hp: b.hp, maxHp: b.maxHp, phase: b.phase, x: b.x, y: b.y } : null; },
    survGive: function (id, lv) { if (!surv) return; var AD = survAllDefs(); if (AD.W[id]) surv.weapons[id] = lv || 1; else if (id.indexOf("awk_") === 0) surv.awak[id.slice(4)] = 1; else surv.passives[id] = lv || 1; survRefreshStats(); },
    survOpenChest: function () { survOpenChest(); return surv.picking; },
    survChestCards: function () { return survChestCards().map(function (c) { return c.def.name; }); },
    survSpawnThief: function () { for (var i = 0; i < 6; i++) survDropGem(cat.x + 150 + i * 10, cat.y + 40, 2); var m = survSpawnThief(); if (m) { m.x = cat.x + 100; m.y = cat.y + 40; } return !!m; },
    get survThieves() { return mice.filter(function (m) { return m.thief; }).map(function (m) { return { stolen: m.stolen, x: m.x, y: m.y }; }); },
    get survExt() { return surv ? { awak: Object.assign({}, surv.awak), chests: surv.chestsOnMap.length, dmgSrc: Object.assign({}, surv.dmgSrc), bossKilled: surv.bossKilled, dur: survRunDur(), cap: mouseCap(), weak: survIsWeak(), elites: mice.filter(function (m) { return m.elite; }).length } : null; },
    get surv() { return surv ? { level: surv.level, xp: surv.xp, kills: surv.kills, gems: surv.gems.length, dashCd: surv.dashCd, weapons: Object.assign({}, surv.weapons), passives: Object.assign({}, surv.passives), won: surv.won, cycles: SURV_CYCLES, spawnMult: surv.spawnMult } : null; },

    forceBiteCheck: function () { return { biteR: BIO_BITE_R, infectR: BIO_INFECT_R, esm: entityScaleMult }; },
    resetNestInfection: function () { nests.forEach(function(n){ n.infected=false; n.infectFlash=0; }); },
    placeMutantAt: function(x,y){ var m=spawnMouseAt(x,y,"grey",currentDifficulty(),"wander"); m.mutant=true; m.hp=2; bio.seen=true; return {x:m.x,y:m.y}; },


    freezeMice: function () { mice.forEach(function (m) { m.speed = 0; m.vx = 0; m.vy = 0; }); },
    allRandomNames: allRandomNames,
    randomNameOk: randomNameOk,
    randomCuteName: randomCuteName,
    isNicknameOffensive: function (n) { return isNicknameOffensive(n); },
    forceSpawnMouseNear: function (dx, dy, type) {
      spawnMouseAt(cat.x + (dx || 0), cat.y + (dy || 0), type || "grey", currentDifficulty());
    }
  };

})();
