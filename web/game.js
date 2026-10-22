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
  var joystickOn = lsBool("catmouse_joystick", false), cbMode = lsBool("catmouse_cb", false);
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
    var smoothing = 1 - Math.exp(-dt * 6);
    // v13 A8：镜头前瞻——朝移动方向多看一点（关掉"减少动效"时生效）
    var la = reducedMotion ? 0 : 55 * entityScaleMult; camLook.x += ((moveDir.x || 0) * la - camLook.x) * (1 - Math.exp(-dt * 2.2)); camLook.y += ((moveDir.y || 0) * la - camLook.y) * (1 - Math.exp(-dt * 2.2));
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

  // 虚拟摇杆：按下处为圆心，拖动方向即移动方向（可在暂停面板开启）
  var joy = null;
  function joyDir(px, py) {
    var dx = px - joy.x, dy = py - joy.y, d = Math.sqrt(dx * dx + dy * dy);
    joy.kx = d > 50 ? joy.x + dx / d * 50 : px; joy.ky = d > 50 ? joy.y + dy / d * 50 : py;
    if (d < 10) return null; return { x: dx / d, y: dy / d };
  }
  function drawJoystick() {
    if (!joy) return;
    ctx.globalAlpha = 0.35; ctx.fillStyle = "#fff"; ctx.beginPath(); ctx.arc(joy.x, joy.y, 50, 0, 7); ctx.fill();
    ctx.globalAlpha = 0.7; ctx.fillStyle = "#ff9d4d"; ctx.beginPath(); ctx.arc(joy.kx, joy.ky, 22, 0, 7); ctx.fill(); ctx.globalAlpha = 1;
  }
  function onPointerDown(e) {
    ensureAudio();
    if (state !== STATE_PLAY) return;
    if (activePointerId !== null) return;
    activePointerId = e.pointerId;
    uniCancel();
    if (dom && dom.hud) dom.hud.classList.add("steering"); // 拖动中手指划过右上角按钮不会误触
    if (joystickOn) { joy = { x: e.clientX, y: e.clientY, kx: e.clientX, ky: e.clientY }; return; }
    var dir = computeDirFromPoint(e.clientX, e.clientY);
    if (dir) { moveDir.x = dir.x; moveDir.y = dir.y; }
  }

  function onPointerMove(e) {
    if (e.pointerId !== activePointerId) return;
    var dir = joy ? joyDir(e.clientX, e.clientY) : computeDirFromPoint(e.clientX, e.clientY);
    if (dir) { if (joy && (dir.x * moveDir.x + dir.y * moveDir.y) < 0.9) uniCancel(); moveDir.x = dir.x; moveDir.y = dir.y; }
    else if (joy) { moveDir.x = 0; moveDir.y = 0; }
  }

  function onPointerUp(e) {
    if (e.pointerId !== activePointerId) return;
    activePointerId = null; joy = null; lastPtr = null;
    if (dom && dom.hud) dom.hud.classList.remove("steering");
    moveDir.x = 0; moveDir.y = 0;
    syncKeyDir();
  }

  canvas.addEventListener("pointerdown", onPointerDown);
  window.addEventListener("pointermove", onPointerMove);
  window.addEventListener("pointerup", onPointerUp);
  window.addEventListener("pointercancel", onPointerUp);
  window.addEventListener("pointerleave", onPointerUp);

  window.addEventListener("keydown", function (e) {
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
    var spdMul = uniSpeedMul();
    var targetVx = moveDir.x * MOVE_SPEED * spdMul;
    var targetVy = moveDir.y * MOVE_SPEED * spdMul;
    var smoothing = 1 - Math.exp(-dt * 14);
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
    var speed = Math.sqrt(cat.vx * cat.vx + cat.vy * cat.vy);
    if (speed > 4) cat.facing = Math.atan2(cat.vy, cat.vx);
    cat.runCycle += dt * (speed / 24 + 0.3);
    // v15 步幅同步：步态相位按实际移动距离推进（一个完整步态周期 ≈ 1.15 个身长），落脚不打滑
    var g0 = cat.gait || 0; cat.gait = g0 + speed * dt / (115 * cat.r * CAT_UNIT_PER_R );
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
    uniReset(); score = 0; catches = 0; catchesGrey = 0; catchesBrown = 0; catchesGold = 0; missionsInit();
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
      if (m.hidden) continue; // 在纸箱/雪球里
      var dToCat = distance(m.x, m.y, cat.x, cat.y);
      if (dToCat > cullR) { recycleMouse(i); continue; }
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
      if (dAfter < cat.r + m.r) { onCapture(m); recycleMouse(i); }
    }
  }

  function stepMouse(m, dt, dToCat, i) {
    var esm = entityScaleMult;
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
    if (TERR) TERR.push(m);
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
  function stageFor(n) { var s2 = 1; for (var i = 1; i < STAGE_AT.length; i++) if (n >= STAGE_AT[i]) s2 = i + 1; return s2; }

  var ab = null;
  function resetAbilities() {
    ab = {
      skin: currentSkin, stage: 1, procs: 0, flash: 0, evoT: 0, hist: [], fx: [],
      t: {}, hold: {}, holds: 0, pend: {}, plans: 0, cancels: 0, tornPlan: null, kittens: [], boxes: [], balls: [], snowmen: [], webs: [], tornados: [], notes: [], spot: null, roll: 0, swing: null,
      lastFacing: cat.facing, turnAcc: 0, straight: 0, straightDir: cat.facing
    };
    ab.stage = stageFor(catches); aimLog.length = 0; planLog.length = 0;
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
  function stunM(m, t, kind) { if (!m || m.hidden) return; if (!(m.stun > 0)) skillSfx("hit"); m.stun = Math.max(m.stun || 0, t); m.stunKind = kind; m.state = "wander"; }
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
    if (!reducedMotion && now >= hitStopCd) { hitStopT = gold ? 0.07 : 0.035; hitStopCd = now + 0.22; }
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
    if (!terrImgsReady && IMG.rock && IMG.bush) { terrImgsReady = true; TERR.clear(); }
    var T = TERR.TILE, hw = W / (2 * SCALE), hh = H / (2 * SCALE), p = SCALE * DPR;
    var i0 = Math.floor((camera.x - hw) / T), i1 = Math.floor((camera.x + hw) / T), j0 = Math.floor((camera.y - hh) / T), j1 = Math.floor((camera.y + hh) / T);
    var imgs = terrImgsReady ? { rock: IMG.rock, bush: IMG.bush } : null, bg = tileGrassBg;
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
  IMG_LIST.push("nest", "nest_dead", "poop", "crate", "bush", "rock", "tree", "tree_fruit", "flowerbed", "stones", "fence", "grass");
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
    { id: "n1", t: "便便摧毁 1 个老鼠窝", n: 1, v: function () { return nestStats.destroyed; } },
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
  function openShop() {
    var ov = document.getElementById("shopScreen");
    if (!ov) {
      ov = document.createElement("div"); ov.id = "shopScreen"; ov.className = "overlay"; ov.setAttribute("role", "dialog"); ov.setAttribute("aria-label", "帽子小铺");
      ov.innerHTML = '<div class="panel shop-panel"><h2>🛍️ 帽子小铺</h2><div class="shop-bal"></div><div class="shop-grid"></div><p class="shop-note">小鱼干只存在这台设备上，只换装扮，不影响分数和排行榜。</p><button class="btn-primary shop-close">好啦</button></div>';
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
    var sx = worldToScreenX(cat.x), sy = worldToScreenY(cat.y) + s(evoHop()), stc = uniCatStretch();
    if (poopSitting() && !reducedMotion) sx += Math.sin(elapsedPlayTime * 50) * s(1.5);
    if (stc) { ctx.save(); ctx.translate(sx, sy); ctx.rotate(stc.a); ctx.scale(stc.s, 1 / Math.sqrt(stc.s)); ctx.rotate(-stc.a); ctx.translate(-sx, -sy); }
    paintPounce = !!(uni && uni.lunge); paintGait = cat.gait || 0; paintSquash = reducedMotion ? 0 : cat.squash;
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
      var r = s(m.r), u = r * MOUSE_UNIT_PER_R, d = ANIM.DIR8[m.anim.dir];
      var st = animFrame(m.anim, m.runCycle * 1.4, MOUSE_SIT_SCHED);
      if (!v.full && st[0] === "run") st = ["run", st[1] & 2]; // 远处只用 2 帧
      if (!v.full && st[0] === "sit") st = ["sit", 2];
      var ox = 0;
      if (m.cornerT > 0 || m.trem > 0 || (m.beh === "timid" && m.state === "flee" && v.full)) ox = Math.sin(elapsedPlayTime * 60) * 2 * u;
      if (m.asleep) st = ["sit", 2];
      if (dayNow.night > 0.5 && mouseInDark(m)) { var ea = 0.5 + 0.5 * dayNow.night; var blk = Math.sin(elapsedPlayTime * 2.3 + m.seed * 11) > 0.96; if (!blk) { var gw = glowSprite(), gs = s(9); ctx.globalAlpha = resScale < 1 ? 0 : ea; ctx.drawImage(gw, sx - 5 * u - gs / 2, sy - 8 * u - gs / 2, gs, gs); ctx.drawImage(gw, sx + 5 * u - gs / 2, sy - 8 * u - gs / 2, gs, gs); ctx.globalAlpha = 1; ctx.fillStyle = "#fff8c0"; ctx.beginPath(); ctx.arc(sx - 5 * u, sy - 8 * u, s(1.6), 0, 7); ctx.arc(sx + 5 * u, sy - 8 * u, s(1.6), 0, 7); ctx.fill(); } continue; }
      if (!dbgDraw.noSprite && !paintedMouse(m.type, sx + ox, sy, u, d[0], d[1], st, m.runCycle)) blit(ANIM.mouseSprite(m.type, d[0], st[0], st[1], spritePx(u)), sx + ox, sy, u, d[1]);
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
      var isMe = run.id != null && row.live_run_id === run.id;
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
  function loadTopScores() {
    if (!backendConfigured) { lbShowMessage("lb-error", "排行榜未配置"); return; }
    if (lbRenderedFilter !== lbSkinFilter) {
      lbRenderedFilter = lbSkinFilter;
      lbRows.forEach(function (r) { r.el.remove(); }); lbRows.clear();
    }
    if (lbRows.size === 0) lbShowMessage("lb-loading", "加载中…");
    var filterAtRequest = lbSkinFilter;
    restGet("/rest/v1/leaderboard_live?select=nickname,display_score,is_live,is_paused,skin,rank,live_run_id,country" + (lbSkinFilter ? "&skin=eq." + lbSkinFilter : "") + "&order=rank.asc&limit=" + LEADERBOARD_TOPN_LIMIT)
      .then(function (res) {
        if (filterAtRequest !== lbSkinFilter) return; // 期间切换了筛选，丢弃旧响应
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
    dom.nicknameInput.value = storageGet("catmouse_nickname", "");
    dom.nicknameHint.classList.add("hidden");
    showScreen(dom.startScreen);
  }

  function beginRun() {
    ensureAudio();
    var nickname = enforceNicknameNotOffensive(dom.nicknameInput, dom.nicknameHint).trim();
    storageSet("catmouse_nickname", nickname);
    hideScreen(dom.startScreen);
    showScreen(dom.hud); var mm = document.getElementById("miniMap"); if (mm) mm.classList.remove("hidden");
    resetWorld();
    resetScoring();
    resetAbilities();
    dom.abilityBadge.dataset.key = ""; updateSkillBadge(true);
    dom.comboText.classList.add("hidden");
    setText(dom.rankText, "排名：未上榜");
    state = STATE_PLAY;
    startRun(nickname);
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
    hideScreen(dom.hud); var mm2 = document.getElementById("miniMap"); if (mm2) mm2.classList.add("hidden");
    if (score > best) { best = score; storageSet("catmouse_best", String(best)); }
    dom.resultScore.textContent = String(score);
    dom.resultCatches.textContent = String(catches);
    dom.resultDuration.textContent = String(Math.round(elapsedPlayTime));
    dom.resultCombo.textContent = String(comboMax);
    dom.resultBest.textContent = String(best);
    dom.resultRankStatus.textContent = "结算中…"; var rg = document.getElementById("resultGap"); if (rg) rg.classList.add("hidden");
    dom.nicknameInputResult.value = storageGet("catmouse_nickname", "");
    dom.nicknameHintResult.classList.add("hidden");
    missionsResult();
    showScreen(dom.resultScreen);
    sfx.endRun();
    finishRun();
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
     ["joystickOn", "catmouse_joystick", function (v) { joystickOn = v; }],
     ["cbMode", "catmouse_cb", function (v) { cbMode = v; }]].forEach(function (c) {
      var el = q(c[0]); if (!el) return;
      el.checked = { shakeOn: shakeOn, reduceMotion: reducedMotion, joystickOn: joystickOn, cbMode: cbMode }[c[0]];
      el.addEventListener("change", function () { lsSetBool(c[1], this.checked); c[2](this.checked); sfx.click(); });
    });
    document.body.classList.toggle("reduce-motion", reducedMotion);
  })();
  // ---- 首局新手引导（只出现一次）：开始第一局前 3 步说明 ----
  var ONBOARD_STEPS = [
    ["👆", "按住屏幕边缘，小猫就朝那个方向跑", "手指在哪边，小猫往哪边跑；松手就停下。也可以在暂停面板开启「虚拟摇杆」。桌面端用方向键 / WASD。"],
    ["🐾", "靠近老鼠会自动飞扑", "老鼠只从老鼠窝 🕳️ 里出来（屏幕边缘箭头指路，夜晚出得更多）。靠近老鼠会自动飞扑；蹲在窝上不动 3 秒会便便 💩，把窝摧毁！"],
    ["⭐", "点左上角 Lv 徽章看技能", "每只猫有专属招牌技能，抓 15/40/80/150 只进化。点徽章会暂停并显示全部技能说明。"]
  ];
  function maybeOnboard(next) {
    var el = document.getElementById("onboardScreen");
    if (!el || lsBool("catmouse_onboard_done", false)) { next(); return; }
    var i = 0;
    function render() {
      var st = ONBOARD_STEPS[i];
      el.querySelector(".ob-ic").textContent = st[0]; el.querySelector(".ob-t").textContent = st[1]; el.querySelector(".ob-d").textContent = st[2];
      el.querySelector(".ob-dots").textContent = ONBOARD_STEPS.map(function (_, k) { return k === i ? "●" : "○"; }).join(" ");
      el.querySelector("#onboardNext").textContent = i < ONBOARD_STEPS.length - 1 ? "下一步" : "开始抓老鼠 🐾";
    }
    function done() { lsSetBool("catmouse_onboard_done", true); hideScreen(el); next(); }
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
  // 按钮上的按下事件不传给画布，避免误移动小猫
  ["pointerdown", "touchstart", "mousedown"].forEach(function (ev) {
    dom.hudLbBtn.addEventListener(ev, function (e) { e.stopPropagation(); }, { passive: true });
  });

  // =======================================================================
  // Main loop
  // =======================================================================

  function updateHud() {
    setText(dom.scoreText, score);
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
  var POOP_T = 3, POOP_R = 40, POOP_MIN_RUN = 20, NEST_SCORE = 30;
  var FENCES = [
    { x: -MAP_HALF - FENCE_T, y: -MAP_HALF - FENCE_T, w: 2 * MAP_HALF + 2 * FENCE_T, h: FENCE_T, kind: "fence" },
    { x: -MAP_HALF - FENCE_T, y: MAP_HALF, w: 2 * MAP_HALF + 2 * FENCE_T, h: FENCE_T, kind: "fence" },
    { x: -MAP_HALF - FENCE_T, y: -MAP_HALF, w: FENCE_T, h: 2 * MAP_HALF, kind: "fence" },
    { x: MAP_HALF, y: -MAP_HALF, w: FENCE_T, h: 2 * MAP_HALF, kind: "fence" }
  ];
  var nests = [], poops = [], nestStats = { destroyed: 0 }, poopSit = { t: 0, nest: null }, nestAddT = 0, ownRecount = 0;
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
    nests.length = 0; poops.length = 0; nestStats.destroyed = 0; poopSit.t = 0; poopSit.nest = null; nestAddT = 0;
    for (var i = 0; i < NEST_START; i++) { var p = placeNest(0); if (p) nests.push(newNest(p)); }
  }
  function newNest(p) { return { x: p.x, y: p.y, alive: true, t: Math.random() * 1.5, owned: 0, silT: 0, deadT: 0, born: elapsedPlayTime, prefilled: false, flash: 0, hide: false, hideT: 0, stored: 0, burstT: 0 }; }
  function nestSpawnOne(n, t) {
    var a = randomAngle(), d = 18 + Math.random() * 14, x = n.x + Math.cos(a) * d, y = n.y + 18 + Math.abs(Math.sin(a)) * d;
    var beh = pickBeh(t);
    if (beh === "flock") { var k = 4 + Math.floor(Math.random() * 5); spawnPack({ x: x, y: y }, k, t); for (var j = mice.length - k; j < mice.length; j++) if (mice[j]) { mice[j].nest = n; mice[j].home = n; } n.owned += k; return; }
    var m = spawnMouseAt(x, y, typeForBeh(beh, t), t, beh); m.nest = n; m.home = n; if (beh === "burrow") m.hole = { x: n.x, y: n.y }; n.owned++;
  }
  function mouseCap() { return dayNow.night > 0 && resScale > 0.6 ? Math.round(lerp(180, NIGHT_CAP, dayNow.night)) : 180; }
  function nestSpawn(dt) {
    if (noSpawn) return;
    var t = currentDifficulty(), R = viewRadiusWorld() + 300, cap = mouseCap();
    var iv = lerp(NEST_DAY_IV, NEST_NIGHT_IV, dayNow.night);
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
      m.nest = n; m.home = n; if (beh === "burrow") m.hole = { x: n.x, y: n.y }; n.owned++;
      var sp = (m.speed || 120) * 1.6; m.vx = Math.cos(a) * sp; m.vy = Math.sin(a) * sp;
    }
    if (CA.sfx.nest) CA.sfx.nest("burst");
  }
  function silenceNests(x, y, r, secs) { for (var i = 0; i < nests.length; i++) if (nests[i].alive && distance(nests[i].x, nests[i].y, x, y) < r) nests[i].silT = Math.max(nests[i].silT, secs); }
  function nestNear(x, y, r) { for (var i = 0; i < nests.length; i++) { var n = nests[i]; if (n.alive && distance(n.x, n.y, x, y) < r) return n; } return null; }
  function destroyNest(n) {
    n.alive = false; n.deadT = 0; nestStats.destroyed++; n.stored = 0; n.hide = false;
    poops.push({ x: n.x + 26, y: n.y + 16, age: 0 });
    score += NEST_SCORE; spawnScorePopup(n.x, n.y - 30, NEST_SCORE);
    for (var i = 0; i < mice.length; i++) { var m = mice[i]; if (m.nest === n) { m.nest = null; if (distance(m.x, m.y, n.x, n.y) < NEST_ROAM) { startFlee(m, 4); m.home = null; } } }
    if (CA.sfx.nest) CA.sfx.nest("poop"); feedback("wave");
    maybeSendHeartbeat(Date.now());
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
      if (!n.alive) { n.deadT += dt; if (n.deadT >= NEST_RESPAWN) { var p = placeNest(600); if (p) { n.x = p.x; n.y = p.y; n.alive = true; n.t = 1; n.owned = 0; n.stored = 0; n.hide = false; n.prefilled = false; n.flash = 2; if (CA.sfx.nest) CA.sfx.nest("respawn"); } else n.deadT = NEST_RESPAWN - 5; } }
    }
    nestAddT += dt;
    if (nestAddT >= NEST_ADD_EVERY) { nestAddT = 0; if (nests.length < NEST_MAX) { var q = placeNest(600); if (q) { var nn = newNest(q); nn.flash = 2; nests.push(nn); } } }
    for (i = poops.length - 1; i >= 0; i--) { poops[i].age += dt; if (poops[i].age > 10) poops.splice(i, 1); }
    // 蹲窝便便：在窝中心 40 内、没有方向输入、开局 20s 后，静止 3s
    var on = nestNear(cat.x, cat.y, POOP_R), still = moveDir.x === 0 && moveDir.y === 0 && !(uni && uni.lunge);
    if (on && still && elapsedPlayTime >= POOP_MIN_RUN) {
      if (poopSit.nest !== on) { poopSit.nest = on; poopSit.t = 0; }
      var before = poopSit.t; poopSit.t += dt;
      if (Math.floor(before * 2) !== Math.floor(poopSit.t * 2) && CA.sfx.nest) CA.sfx.nest("strain");
      cat.x += (on.x - cat.x) * Math.min(1, dt * 8); cat.y += (on.y - 16 - cat.y) * Math.min(1, dt * 8); // 吸到窝顶（坐在土丘上）
      if (poopSit.t >= POOP_T) { destroyNest(on); poopSit.t = 0; poopSit.nest = null; }
    } else { poopSit.t = 0; poopSit.nest = null; }
  }
  function poopSitting() { return poopSit.nest && poopSit.t > 0; }
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
      if (!n.alive && n.deadT < 0.4) { var k = n.deadT / 0.4; blitSpr(nestSprite(false, u), sx, sy, u * (1 - k * 0.3), 1 - k); }
      blitSpr(nestSprite(!n.alive, u), sx, sy, u, n.alive ? 1 : Math.min(1, n.deadT / 0.4) * 0.9);
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
    if (!poopSitting()) return;
    var sx = worldToScreenX(cat.x), sy = worldToScreenY(cat.y) - s(8), r = s(44), p = Math.min(1, poopSit.t / POOP_T);
    ctx.lineCap = "round"; ctx.lineWidth = s(6); ctx.strokeStyle = "rgba(255,255,255,.75)"; ctx.beginPath(); ctx.arc(sx, sy, r, 0, 7); ctx.stroke();
    ctx.strokeStyle = "#ff9d4d"; ctx.beginPath(); ctx.arc(sx, sy, r, -Math.PI / 2, -Math.PI / 2 + p * Math.PI * 2); ctx.stroke(); ctx.lineCap = "butt";
    emojiQuick("嗯~ " + (Math.min(POOP_T, poopSit.t)).toFixed(1) + "s", sx, sy - r - s(14), s(13), null, "#fff");
    if (!reducedMotion) emojiQuick("💦", sx + s(26), sy - s(26) + Math.sin(poopSit.t * 8) * s(2), s(16));
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
  // ---- 小地图 ----
  var miniT = 0;
  var miniBase = null;
  function drawMiniTo(c, size) {
    var g = c.getContext("2d"), d = Math.min(2, window.devicePixelRatio || 1); if (c.width !== size * d) { c.width = size * d; c.height = size * d; }
    g.setTransform(d, 0, 0, d, 0, 0); g.clearRect(0, 0, size, size);
    var k = size / (2 * MAP_HALF), X = function (x) { return (x + MAP_HALF) * k; };
    if (TERR) { if (!miniBase || miniBase.width !== Math.round(size * d)) miniBase = TERR.miniMap(Math.round(size * d)); g.drawImage(miniBase, 0, 0, size, size); } else { g.fillStyle = "#b8e6a0"; g.fillRect(0, 0, size, size); }
    if (dayNow.night > 0) { g.fillStyle = "rgba(10,15,50," + (0.4 * dayNow.night) + ")"; g.fillRect(0, 0, size, size); }
    for (var i = 0; i < nests.length; i++) { var n = nests[i]; if (n.alive) { g.fillStyle = n.flash > 0 ? "#ffd23f" : "#a0683a"; g.beginPath(); g.arc(X(n.x), X(n.y), Math.max(3, size / 30), 0, 7); g.fill(); } else { g.strokeStyle = "#8a8a8a"; g.lineWidth = 1.5; var q = size / 40; g.beginPath(); g.moveTo(X(n.x) - q, X(n.y) - q); g.lineTo(X(n.x) + q, X(n.y) + q); g.moveTo(X(n.x) + q, X(n.y) - q); g.lineTo(X(n.x) - q, X(n.y) + q); g.stroke(); } }
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
    { id: "poop", icon: "💩", name: "蹲窝便便", lv: ["停在老鼠窝上、不按方向静止 3 秒：便便摧毁老鼠窝 +30 分（开局 20 秒后可用；窝 45 秒后在别处重生）", "同上", "同上", "同上", "同上"] },
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
    uni.lunge = { sx: cat.x, sy: cat.y, ux: ux, uy: uy, len: len, t: 0, dur: 0.25, hit: false, chain: chain, done: 0 };
    if (chain) { uni.chainN++; uni.stats.chain++; if (uni.chainN + 1 > uni.stats.maxChain) uni.stats.maxChain = uni.chainN + 1; }
    else { uni.chainN = 0; uni.stats.pounce++; }
    if (CA.sfx.uni) CA.sfx.uni(chain ? "chain" : "pounce", uni.chainN);
  }
  function uniSpeedMul() { return uni && uni.dashT > 0 ? uni.dashMul : 1; }
  // 在 updateCat 末尾调用：飞扑位移（沿玩家方向扇形内，带障碍碰撞）
  function uniLungeStep(dt) {
    var L = uni.lunge; if (!L) return;
    var prev = L.done; L.t += dt; var k = Math.min(1, L.t / L.dur), e = 1 - (1 - k) * (1 - k);
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
    if (!moving) { uni.lunge = null; uni.chainLeft = 0; uni.chainWin = 0; }
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
    if (!uni.lunge && moving && !poopSitting()) {
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

  function update(dt) {
    updateMusic();
    if (state === STATE_PLAY) {
      elapsedPlayTime += dt;
      var sdt = dt; if (hitStopT > 0) { hitStopT -= dt; sdt = dt * 0.12; } // 命中停顿：只放慢动作，不影响计时
      updateCat(sdt);
      nestUpdate(dt);
      uniUpdate(sdt);
      updateAbilities(sdt);
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
    drawMice();
    drawAbilityBehindCat();
    drawCat();
    drawTrees();
    drawAbilityOverlay();
    drawNight();
    drawNightGlow();
    drawDepth();
    drawPoopRing();
    drawEffects();
    drawJuice();
    uniDrawOver();
    drawNestArrows();
    drawJoystick();
    if (shaking) ctx.restore();
  }


  // ---- 皮肤选择 & 随机昵称 ----
  var RANDOM_NAME_ADJ = ["软糯", "奶呼呼", "元气", "迷糊", "毛茸茸", "甜甜", "圆滚滚", "小懒", "暖乎乎", "胖嘟嘟", "香喷喷", "蓬松", "乖巧", "呆萌", "爱睡", "小跳跳"];
  var RANDOM_NAME_NOUN = ["小团子", "布丁", "汤圆", "麻薯", "饭团", "奶糖", "年糕", "鱼干", "棉花糖", "豆包", "糯米糍", "小橘", "奶盖", "芝麻球", "毛线球", "泡芙"];
  var RANDOM_NAME_SUFFIX = ["", "", "", "喵", "酱"];
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
    skinAbilityEl.innerHTML = html + '</span><span class="evo-desc">Lv1 ' + sk.lv[0][1] + '：' + sk.lv[0][2] + ' · 抓 15/40/80/150 只依次进化</span>';
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
    get mice() { return mice.map(function (m) { return { x: m.x, y: m.y, type: m.type, state: m.state, beh: m.beh, under: !!m.under, asleep: !!m.asleep, leader: !!m.leader, packId: m.packId || 0, stun: m.stun > 0 }; }); },
    get behCounts() { var c = {}; mice.forEach(function (m) { c[m.beh] = (c[m.beh] || 0) + 1; }); return c; },
    get aimLog() { return aimLog.slice(); },
    get planLog() { return planLog.slice(); },
    get holds() { return ab ? { total: ab.holds, by: ab.hold, plans: ab.plans, cancels: ab.cancels } : null; },
    get aimFxLive() { return ab ? ab.fx.filter(function (f) { return f.k === "aim"; }).map(function (f) { return { age: f.age, tele: f.tele, hits: f.hits, ic: f.ic }; }) : []; },
    get drawStats() { return { drawn: drawStats.drawn, full: drawStats.full, pool: mousePool.length, total: mice.length }; },
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
    get nests() { return { list: nests.map(function (n) { return { x: n.x, y: n.y, alive: n.alive, owned: n.owned, silT: n.silT, hide: n.hide, stored: n.stored }; }), destroyed: nestStats.destroyed, poop: poopSit.t, day: dayNow, cap: mouseCap() }; },
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
    spawnMouseRaw: function (dx, dy, type, beh) { return !!spawnMouseAt(cat.x + dx, cat.y + dy, type || "grey", currentDifficulty(), beh || "wander"); },
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
