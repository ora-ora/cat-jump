(function () {
  "use strict";

  // =======================================================================
  // Config & constants
  // =======================================================================

  // TODO(站长): 填入 https://<project-ref>.supabase.co
  var SUPABASE_URL = "https://dzarlikttkosqkcfixbx.supabase.co";
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
  var COMBO_MAX_MULT = 3.0;
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
  function resize() {
    var rect = appEl.getBoundingClientRect();
    var vv = window.visualViewport;
    W = Math.max(1, Math.ceil(rect.width || (vv ? vv.width : window.innerWidth)));
    H = Math.max(1, Math.ceil(rect.height || (vv ? vv.height : window.innerHeight)));
    DPR = Math.min(window.devicePixelRatio || 1, 3);
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

  var audioCtx = null;
  var masterGain = null;
  var muted = storageGet("catmouse_muted", "0") === "1";
  // 小猫皮肤：纯外观；本地记住上次选择，同时随 start_run 存到服务端（排行榜头像）
  var SKIN_IDS = window.CatArt.SKINS.map(function (k) { return k.id; });
  var currentSkin = storageGet("catmouse_skin", "orange");
  if (SKIN_IDS.indexOf(currentSkin) < 0) currentSkin = "orange";

  function ensureAudio() {
    if (audioCtx) {
      if (audioCtx.state === "suspended") audioCtx.resume();
      return;
    }
    try {
      var AC = window.AudioContext || window.webkitAudioContext;
      audioCtx = new AC();
      masterGain = audioCtx.createGain();
      masterGain.gain.value = muted ? 0 : 0.35;
      masterGain.connect(audioCtx.destination);
    } catch (e) {
      audioCtx = null;
    }
  }

  function tone(freq, duration, type, opts) {
    if (!audioCtx || !masterGain) return;
    opts = opts || {};
    var t0 = audioCtx.currentTime;
    var osc = audioCtx.createOscillator();
    var gain = audioCtx.createGain();
    osc.type = type || "sine";
    osc.frequency.setValueAtTime(freq, t0);
    if (opts.slideTo) osc.frequency.exponentialRampToValueAtTime(opts.slideTo, t0 + duration);
    var vol = opts.volume != null ? opts.volume : 0.5;
    gain.gain.setValueAtTime(0.0001, t0);
    gain.gain.exponentialRampToValueAtTime(vol, t0 + Math.min(0.015, duration * 0.3));
    gain.gain.exponentialRampToValueAtTime(0.0001, t0 + duration);
    osc.connect(gain);
    gain.connect(masterGain);
    osc.start(t0);
    osc.stop(t0 + duration + 0.02);
  }

  function noiseBurst(duration, volume) {
    if (!audioCtx || !masterGain) return;
    var t0 = audioCtx.currentTime;
    var bufferSize = Math.max(1, Math.floor(audioCtx.sampleRate * duration));
    var buffer = audioCtx.createBuffer(1, bufferSize, audioCtx.sampleRate);
    var data = buffer.getChannelData(0);
    for (var i = 0; i < bufferSize; i++) data[i] = (Math.random() * 2 - 1) * (1 - i / bufferSize);
    var src = audioCtx.createBufferSource();
    src.buffer = buffer;
    var gain = audioCtx.createGain();
    gain.gain.setValueAtTime(volume == null ? 0.2 : volume, t0);
    gain.gain.exponentialRampToValueAtTime(0.0001, t0 + duration);
    src.connect(gain);
    gain.connect(masterGain);
    src.start(t0);
  }

  var sfx = {
    catchGrey: function () { tone(700, 0.08, "sine", { slideTo: 1000, volume: 0.45 }); },
    catchBrown: function () {
      tone(820, 0.09, "sine", { slideTo: 1200, volume: 0.45 });
      setTimeout(function () { tone(1100, 0.08, "sine", { slideTo: 1500, volume: 0.35 }); }, 55);
    },
    catchGold: function () {
      tone(900, 0.07, "triangle", { slideTo: 1300, volume: 0.4 });
      setTimeout(function () { tone(1300, 0.07, "triangle", { slideTo: 1700, volume: 0.4 }); }, 60);
      setTimeout(function () { tone(1700, 0.1, "triangle", { slideTo: 2200, volume: 0.4 }); }, 120);
      setTimeout(function () { noiseBurst(0.08, 0.1); }, 120);
    },
    combo: function () { tone(500, 0.05, "square", { volume: 0.18 }); },
    rankUp: function () { tone(600, 0.06, "sine", { slideTo: 900, volume: 0.22 }); },
    click: function () { tone(500, 0.04, "sine", { slideTo: 650, volume: 0.3 }); },
    endRun: function () { tone(500, 0.18, "sine", { slideTo: 300, volume: 0.35 }); },
  };

  function toggleMute() {
    muted = !muted;
    storageSet("catmouse_muted", muted ? "1" : "0");
    if (masterGain) masterGain.gain.value = muted ? 0 : 0.35;
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
  }

  // =======================================================================
  // Camera
  // =======================================================================

  var camera = { x: 0, y: 0 };

  function updateCamera(dt) {
    var smoothing = 1 - Math.exp(-dt * 6);
    camera.x += (cat.x - camera.x) * smoothing;
    camera.y += (cat.y - camera.y) * smoothing;
  }

  function worldToScreenX(x) { return (x - camera.x) * SCALE + W / 2; }
  function worldToScreenY(y) { return (y - camera.y) * SCALE + H / 2; }

  // =======================================================================
  // Input（指针/鼠标/键盘，方向判定相对屏幕中心）
  // =======================================================================

  var activePointerId = null;
  var keysDown = {};
  var DEAD_ZONE_PX = 18;

  function computeDirFromPoint(px, py) {
    var dx = px - W / 2, dy = py - H / 2;
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

  function onPointerDown(e) {
    ensureAudio();
    if (state !== STATE_PLAY) return;
    if (activePointerId !== null) return;
    activePointerId = e.pointerId;
    var dir = computeDirFromPoint(e.clientX, e.clientY);
    if (dir) { moveDir.x = dir.x; moveDir.y = dir.y; }
  }

  function onPointerMove(e) {
    if (e.pointerId !== activePointerId) return;
    var dir = computeDirFromPoint(e.clientX, e.clientY);
    if (dir) { moveDir.x = dir.x; moveDir.y = dir.y; }
  }

  function onPointerUp(e) {
    if (e.pointerId !== activePointerId) return;
    activePointerId = null;
    moveDir.x = 0; moveDir.y = 0;
    syncKeyDir();
  }

  canvas.addEventListener("pointerdown", onPointerDown);
  window.addEventListener("pointermove", onPointerMove);
  window.addEventListener("pointerup", onPointerUp);
  window.addEventListener("pointercancel", onPointerUp);
  window.addEventListener("pointerleave", onPointerUp);

  window.addEventListener("keydown", function (e) {
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
    var targetVx = moveDir.x * MOVE_SPEED;
    var targetVy = moveDir.y * MOVE_SPEED;
    var smoothing = 1 - Math.exp(-dt * 14);
    cat.vx += (targetVx - cat.vx) * smoothing;
    cat.vy += (targetVy - cat.vy) * smoothing;

    var startX = cat.x, startY = cat.y;
    cat.x += cat.vx * dt;
    cat.y += cat.vy * dt;

    var obstacles = queryNearbyObstacles(cat.x, cat.y);
    var i;
    for (i = 0; i < obstacles.length; i++) resolveCircleAabb(cat, obstacles[i]);

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
    } else {
      cat.slideSign = 0;
    }

    var speed = Math.sqrt(cat.vx * cat.vx + cat.vy * cat.vy);
    if (speed > 4) cat.facing = Math.atan2(cat.vy, cat.vx);
    cat.runCycle += dt * (speed / 24 + 0.3);
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

  function maxMice(t) { return Math.round(lerp(10, 18, t)); }
  function packChance(t) { return lerp(0.35, 0.6, t); }
  function packCooldownFor(t) { return lerp(4, 2, t); }
  var lastPackAt = -999, packSeq = 0, nextPackSize = null;
  function spawnCooldownFor(t) { return lerp(2.2, 0.9, t); }

  function speedMultFor(type, t) {
    if (type === "brown") return lerp(1.4, 1.6, t);
    if (type === "gold") return lerp(1.8, 2.1, t);
    return 1.0;
  }

  function baseScoreFor(type, t) {
    if (type === "brown") return 20;
    if (type === "gold") return Math.round(50 * (1 + 0.5 * t));
    return 10;
  }

  function resetScoring() {
    score = 0; catches = 0; catchesGrey = 0; catchesBrown = 0; catchesGold = 0;
    combo = 0; comboTimer = 0; comboMax = 0; elapsedPlayTime = 0;
  }

  function updateComboTimer(dt) {
    if (comboTimer > 0) {
      comboTimer -= dt;
      if (comboTimer <= 0) { comboTimer = 0; combo = 0; }
    }
  }

  // =======================================================================
  // Mouse manager（生成/清理/AI 状态机）
  // =======================================================================

  var lastMiceSpawnAt = { grey: -999, brown: -999, gold: -999 };

  function countMiceByType(type) {
    var n = 0;
    for (var i = 0; i < mice.length; i++) if (mice[i].type === type) n++;
    return n;
  }

  function randomAngle() { return Math.random() * Math.PI * 2; }

  function pickSpawnPoint(points) {
    var buffer = 40;
    var valid = [];
    for (var i = 0; i < points.length; i++) {
      var p = points[i];
      var sx = worldToScreenX(p.x), sy = worldToScreenY(p.y);
      if (sx < -buffer || sx > W + buffer || sy < -buffer || sy > H + buffer) valid.push(p);
    }
    if (valid.length === 0) return null;
    return valid[Math.floor(Math.random() * valid.length)];
  }

  function spawnMouseAt(x, y, type, t) {
    mice.push({
      x: x, y: y, vx: 0, vy: 0, r: MOUSE_RADIUS * entityScaleMult,
      type: type,
      speed: BASE_MOUSE_SPEED * speedMultFor(type, t),
      state: "wander",
      wanderDir: randomAngle(),
      wanderTimer: 1 + Math.random() * 2,
      idleTimer: 0,
      facing: 0,
      runCycle: Math.random() * 10,
      awareBuffer: 0
    });
  }

  function trySpawnMouse() {
    var t = currentDifficulty();
    if (mice.length >= maxMice(t)) return;

    var room = maxMice(t) - mice.length;
    if (nextPackSize == null) nextPackSize = 3 + Math.floor(Math.random() * 4);
    if (room >= nextPackSize && elapsedPlayTime - lastPackAt >= packCooldownFor(t) && Math.random() < packChance(t)) {
      var ppt = pickSpawnPoint(nearbyMouseSpawnPoints(camera.x, camera.y));
      if (ppt) { spawnPack(ppt, nextPackSize, t); lastPackAt = elapsedPlayTime; nextPackSize = null; return; }
    }

    // 单只老鼠最多占到上限 -6，给鼠群（3–6 只）留位置
    if (room <= 6 && countMiceByType("grey") >= MIN_EASY_MICE) return;
    var type;
    if (countMiceByType("grey") < MIN_EASY_MICE) {
      type = "grey";
    } else {
      var pool = [{ value: "grey", weight: 2 }];
      if (t >= 0.2) pool.push({ value: "brown", weight: lerp(0.5, 2.2, clamp01((t - 0.2) / 0.8)) });
      if (t >= 0.5) pool.push({ value: "gold", weight: lerp(0.3, 1.3, clamp01((t - 0.5) / 0.5)) });
      type = pickWeighted(Math.random, pool);
      if (elapsedPlayTime - lastMiceSpawnAt[type] < spawnCooldownFor(t)) return;
    }

    var points = nearbyMouseSpawnPoints(camera.x, camera.y);
    var pt = pickSpawnPoint(points);
    if (!pt) return;

    spawnMouseAt(pt.x, pt.y, type, t);
    lastMiceSpawnAt[type] = elapsedPlayTime;
  }

  // 鼠群：3–6 只混合类型，聚在一起游荡；被追时四散奔逃
  function spawnPack(pt, n, t) {
    var id = ++packSeq, dir = randomAngle(), goldUsed = false;
    for (var k = 0; k < n; k++) {
      var type = "grey";
      var r = Math.random();
      if (t >= 0.5 && !goldUsed && r < 0.15) { type = "gold"; goldUsed = true; }
      else if (t >= 0.2 && r < 0.15 + lerp(0.2, 0.45, clamp01((t - 0.2) / 0.8))) type = "brown";
      var a = (k / n) * Math.PI * 2 + Math.random() * 0.6, d = k === 0 ? 0 : 22 + Math.random() * 22;
      var x = pt.x + Math.cos(a) * d, y = pt.y + Math.sin(a) * d;
      var obs = queryNearbyObstacles(x, y), bad = false;
      for (var q = 0; q < obs.length; q++) { var o = obs[q]; if (x > o.x - 12 && x < o.x + o.w + 12 && y > o.y - 12 && y < o.y + o.h + 12) { bad = true; break; } }
      if (bad) { x = pt.x; y = pt.y; }
      spawnMouseAt(x, y, type, t);
      var m = mice[mice.length - 1];
      m.packId = id; m.wanderDir = dir; m.scatter = 0;
      lastMiceSpawnAt[type] = elapsedPlayTime;
    }
  }
  var packCenters = {};
  function computePackCenters() {
    packCenters = {};
    for (var i = 0; i < mice.length; i++) {
      var m = mice[i]; if (!m.packId) continue;
      var c = packCenters[m.packId] || (packCenters[m.packId] = { x: 0, y: 0, n: 0, dir: m.wanderDir });
      c.x += m.x; c.y += m.y; c.n++;
    }
    for (var k in packCenters) { packCenters[k].x /= packCenters[k].n; packCenters[k].y /= packCenters[k].n; }
  }
  function alertPack(src) {
    for (var i = 0; i < mice.length; i++) {
      var o = mice[i];
      if (o === src || o.packId !== src.packId || o.state === "flee") continue;
      if (distance(o.x, o.y, src.x, src.y) < 140) startFlee(o);
    }
  }
  function startFlee(m) {
    m.state = "flee"; m.awareBuffer = 0;
    if (m.packId) m.scatter = (Math.random() < 0.5 ? -1 : 1) * (0.45 + Math.random() * 0.85);
  }

  function rayBlocked(x, y, angle, dist) {
    var tx = x + Math.cos(angle) * dist, ty = y + Math.sin(angle) * dist;
    var obstacles = queryNearbyObstacles(x, y);
    for (var i = 0; i < obstacles.length; i++) {
      var o = obstacles[i];
      if (tx >= o.x - 4 && tx <= o.x + o.w + 4 && ty >= o.y - 4 && ty <= o.y + o.h + 4) return true;
    }
    return false;
  }

  function updateMice(dt) {
    computePackCenters();
    for (var i = mice.length - 1; i >= 0; i--) {
      var m = mice[i];
      m.r = MOUSE_RADIUS * entityScaleMult;
      if (m.hidden) continue; // 在纸箱/雪球里
      var dToCat = distance(m.x, m.y, cat.x, cat.y);

      if (m.state === "wander") {
        if (dToCat < MOUSE_AWARE_R) { startFlee(m); if (m.packId) alertPack(m); }
      } else if (dToCat > MOUSE_AWARE_R * 1.2) {
        m.awareBuffer += dt;
        if (m.awareBuffer > 0.3) m.state = "wander";
      } else {
        m.awareBuffer = 0;
      }

      if (m.state === "flee") {
        var away = normalize(m.x - cat.x, m.y - cat.y);
        var desiredAngle = Math.atan2(away.y, away.x) + (m.scatter || 0);
        var finalAngle = desiredAngle;
        if (rayBlocked(m.x, m.y, desiredAngle, m.r * 3)) {
          var tryAngles = [Math.PI / 6, -Math.PI / 6, Math.PI / 3, -Math.PI / 3];
          var found = false;
          for (var a = 0; a < tryAngles.length; a++) {
            var candidate = desiredAngle + tryAngles[a];
            if (!rayBlocked(m.x, m.y, candidate, m.r * 3)) { finalAngle = candidate; found = true; break; }
          }
          if (!found) finalAngle = desiredAngle + Math.PI / 2;
        }
        finalAngle += Math.sin(elapsedPlayTime * 5 + i * 13.7) * 0.25;
        m.vx = Math.cos(finalAngle) * m.speed;
        m.vy = Math.sin(finalAngle) * m.speed;
      } else {
        m.wanderTimer -= dt;
        if (m.wanderTimer <= 0) {
          m.wanderTimer = 1.5 + Math.random() * 2.5;
          if (Math.random() < 0.45) m.wanderDir = randomAngle();
          m.idleTimer = Math.random() < 0.4 ? (0.6 + Math.random()) : 0;
        }
        var pc = m.packId ? packCenters[m.packId] : null;
        if (pc && pc.n > 1) {
          // 鼠群成员：共享游荡方向，离群太远时向群中心靠拢
          var wd = pc.dir, toC = distance(m.x, m.y, pc.x, pc.y);
          if (toC > 45) { var cv2 = normalize(pc.x - m.x, pc.y - m.y); wd = Math.atan2(cv2.y + Math.sin(wd) * 0.5, cv2.x + Math.cos(wd) * 0.5); }
          m.vx = Math.cos(wd) * m.speed * 0.35; m.vy = Math.sin(wd) * m.speed * 0.35;
          if (m.idleTimer > 0) { m.idleTimer -= dt; m.vx *= 0.2; m.vy *= 0.2; }
        } else if (m.idleTimer > 0) {
          m.idleTimer -= dt;
          m.vx = 0; m.vy = 0;
        } else {
          m.vx = Math.cos(m.wanderDir) * m.speed * 0.35;
          m.vy = Math.sin(m.wanderDir) * m.speed * 0.35;
        }
      }

      applyAbilityToMouse(m, dt);
      m.x += m.vx * dt;
      m.y += m.vy * dt;

      var obstacles = queryNearbyObstacles(m.x, m.y);
      for (var k = 0; k < obstacles.length; k++) resolveCircleAabb(m, obstacles[k]);

      if (m.vx !== 0 || m.vy !== 0) m.facing = Math.atan2(m.vy, m.vx);
      m.runCycle += dt * (Math.sqrt(m.vx * m.vx + m.vy * m.vy) / 24 + 0.3);

      var dAfter = distance(m.x, m.y, cat.x, cat.y);
      if (dAfter > Math.max(MOUSE_CLEANUP_R, unloadMargin() + CHUNK_SIZE)) { mice.splice(i, 1); continue; }
      if (dAfter < cat.r + m.r) { onCapture(m); mice.splice(i, 1); }
    }
  }

  function onCapture(m) {
    var t = currentDifficulty();
    combo += 1;
    comboTimer = COMBO_WINDOW;
    if (combo > comboMax) comboMax = combo;
    var mult = Math.min(1 + combo * COMBO_STEP, COMBO_MAX_MULT);
    var gained = Math.round(baseScoreFor(m.type, t) * mult);
    score += gained;
    catches += 1;
    if (m.type === "grey") catchesGrey++;
    else if (m.type === "brown") catchesBrown++;
    else catchesGold++;

    spawnScorePopup(m.x, m.y, gained);
    spawnCatchParticles(m.x, m.y);
    cat.squash = 1;
    startGulp(m);
    if (m.type === "grey") sfx.catchGrey();
    else if (m.type === "brown") sfx.catchBrown();
    else sfx.catchGold();
    if (combo >= 3) sfx.combo();

    maybeSendHeartbeat(Date.now());
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
      t: {}, kittens: [], boxes: [], balls: [], snowmen: [], webs: [], tornados: [], notes: [], spot: null, roll: 0, swing: null,
      lastFacing: cat.facing, turnAcc: 0, straight: 0, straightDir: cat.facing
    };
    ab.stage = stageFor(catches);
    syncKittens();
  }
  function abProc() { ab.procs++; ab.flash = 0.5; }
  function cdReady(key, every, dt) {
    ab.t[key] = (ab.t[key] == null ? every * 0.5 : ab.t[key]) - dt;
    if (ab.t[key] <= 0) { ab.t[key] = every; return true; }
    return false;
  }
  function freeMice() { var o = []; for (var i = 0; i < mice.length; i++) { var m = mice[i]; if (!m.hidden && !m.carried) o.push(m); } return o; }
  function nearestMice(x, y, r, n, filt) {
    var arr = [];
    for (var i = 0; i < mice.length; i++) {
      var m = mice[i]; if (m.hidden || m.carried) continue;
      if (filt && !filt(m)) continue;
      var d = distance(x, y, m.x, m.y); if (d <= r) arr.push([d, m]);
    }
    arr.sort(function (a, b) { return a[0] - b[0]; });
    return arr.slice(0, n).map(function (a) { return a[1]; });
  }
  function stunM(m, t, kind) { if (!m || m.hidden) return; m.stun = Math.max(m.stun || 0, t); m.stunKind = kind; m.state = "wander"; }
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
    if (sfx && sfx.rankUp) { try { sfx.rankUp(); setTimeout(sfx.rankUp, 120); } catch (e) { /* ignore */ } }
  }

  function updateAbilities(dt) {
    if (!ab) resetAbilities();
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
    if (cdReady("pounce", 8, dt)) {
      var tgts = nearestMice(cat.x, cat.y, 220 * esm, K.length, function (m) { return !(m.stun > 0); });
      if (tgts.length) {
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
    }
    if (S >= 4 && cdReady("herd", 6, dt)) { // 牧羊阵：3 只以上的鼠群圈成一团停在你前方
      var fm = freeMice(), best = null, bestN = 0;
      for (i = 0; i < fm.length; i++) {
        if (distance(fm[i].x, fm[i].y, cat.x, cat.y) > 320 * esm) continue;
        var nb = nearestMice(fm[i].x, fm[i].y, 100 * esm, 8);
        if (nb.length > bestN) { bestN = nb.length; best = nb; }
      }
      if (best && bestN >= 3) {
        var mp3 = mouthPoint(70 * esm);
        for (i = 0; i < best.length; i++) { pullM(best[i], mp3.x + (Math.random() - 0.5) * 30 * esm, mp3.y + (Math.random() - 0.5) * 30 * esm, 170 * esm, 1.6); stunM(best[i], 2.6, "pin"); }
        fx("ring", best[0].x, best[0].y, 1.0, { r: 70 * esm });
        abProc();
      }
    }
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
    if (cdReady("box", 10, dt)) {
      var p = mouthPoint(150 * esm);
      if (B.length >= 3) { var old = B.shift(); releaseBox(old, 0); }
      B.push({ x: p.x, y: p.y, mice: [], closed: false, age: 0, shake: 0 }); abProc();
    }
    for (i = B.length - 1; i >= 0; i--) {
      b = B[i]; b.age += dt; b.shake = Math.max(0, b.shake - dt);
      // 老鼠好奇钻箱
      if (!b.closed || b.mice.length < boxCap(S)) {
        for (var k = 0; k < mice.length; k++) {
          m = mice[k]; if (m.hidden || m.carried || m.type === "gold" && Math.random() < 0.5 * dt) continue;
          var d = distance(m.x, m.y, b.x, b.y);
          if (d < 150 * esm && !(m.stun > 0)) m.lureX = b.x, m.lureY = b.y;
          if (d < 14 * esm && b.mice.length < boxCap(S)) { m.hidden = true; m.boxT = 3; b.mice.push(m); b.shake = 0.4; if (S >= 2) b.closed = true; }
        }
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
    if (S >= 5 && cdReady("magic", 25, dt)) { // 魔术秀：箱子全开，老鼠晕倒排成一排
      var popped = [];
      for (i = 0; i < B.length; i++) { if (distance(B[i].x, B[i].y, cat.x, cat.y) < 500 * esm) { popped = popped.concat(B[i].mice); B[i].mice = []; B[i].closed = false; fx("confetti", B[i].x, B[i].y, 1.2, {}); } }
      var perpA = cat.facing + Math.PI / 2, base = mouthPoint(60 * esm);
      for (i = 0; i < popped.length; i++) {
        m = popped[i]; m.hidden = false;
        var off = (i - (popped.length - 1) / 2) * 24 * esm;
        m.x = base.x + Math.cos(perpA) * off; m.y = base.y + Math.sin(perpA) * off; stunM(m, 3, "dizzy");
      }
      fx("hat", cat.x, cat.y, 1.2, {}); abProc();
    }
  }
  function eatBox(b) {
    for (var i = 0; i < b.mice.length; i++) { var m = b.mice[i]; var idx = mice.indexOf(m); if (idx >= 0) { m.hidden = false; m.x = b.x; m.y = b.y; onCapture(m); mice.splice(idx, 1); } }
    b.mice = []; fx("confetti", b.x, b.y, 0.8, {});
  }
  function releaseBox(b) { for (var i = 0; i < b.mice.length; i++) { b.mice[i].hidden = false; b.mice[i].x = b.x; b.mice[i].y = b.y; } b.mice = []; }

  // ---- 雪团：滚滚雪球 ----
  function updateSnow(dt, S, esm) {
    var i, j, m, b;
    if (cdReady("ball", 9, dt)) { ab.balls.push({ x: cat.x, y: cat.y, a: cat.facing, t: 0, r: 9, mice: [], rot: 0, trail: [] }); abProc(); }
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
    if (S >= 4 && cdReady("snowman", 20, dt)) {
      if (ab.snowmen.length >= 2) ab.snowmen.shift();
      var sa = cat.facing + Math.PI / 2 * (ab.snowmen.length ? -1 : 1);
      ab.snowmen.push({ x: cat.x + Math.cos(sa) * 90 * esm, y: cat.y + Math.sin(sa) * 90 * esm, t: 0, life: 25, cd: 1 }); abProc();
    }
    for (i = ab.snowmen.length - 1; i >= 0; i--) {
      var sm = ab.snowmen[i]; sm.t += dt; sm.cd -= dt;
      if (sm.t > sm.life) { ab.snowmen.splice(i, 1); continue; }
      if (sm.cd <= 0) {
        var tg = nearestMice(sm.x, sm.y, 220 * esm, 1, function (q) { return !(q.stun > 0); })[0];
        if (tg) { sm.cd = 2.5; ab.notes.push({ k: "snow", x: sm.x, y: sm.y - 20 * esm, tgt: tg, v: 320 }); }
      }
    }
    updateProjectiles(dt, esm, function (m) { freezeM(m, 2, S); });
    if (S >= 5 && cdReady("blizzard", 30, dt)) {
      var ring = nearestMice(cat.x, cat.y, 220 * esm, 20);
      for (i = 0; i < ring.length; i++) { freezeM(ring[i], 3, S); pullM(ring[i], cat.x, cat.y, 130 * esm, 2.5); }
      fx("blizzard", cat.x, cat.y, 1.6, { r: 220 * esm }); abProc();
    }
  }
  function freezeM(m, t, S) {
    stunM(m, t, "ice");
    if (S >= 3) pullM(m, cat.x, cat.y, 90 * entityScaleMult, t); // 冰面滑道：被冻的老鼠滑向你
  }

  // ---- 三花：魔法毛线 ----
  function updateYarn(dt, S, esm) {
    var i, m;
    if (cdReady("lasso", 7, dt)) {
      var tg = nearestMice(cat.x, cat.y, 240 * esm, S >= 2 ? 2 : 1);
      for (i = 0; i < tg.length; i++) {
        m = tg[i];
        var dv = normalize(cat.x - m.x, cat.y - m.y), pd = Math.min(120 * esm, distance(m.x, m.y, cat.x, cat.y) - cat.r);
        pullM(m, m.x + dv.x * pd, m.y + dv.y * pd, 260 * esm, 0.6); stunM(m, 0.9, "rope");
        fx("lasso", cat.x, cat.y, 0.6, { m: m, c: i ? "#8fc8ff" : "#ff8fb1" });
        if (S >= 4 && m.type === "gold") { ab.swing = { x0: cat.x, y0: cat.y, m: m, t: 0 }; }
      }
      if (tg.length) abProc();
    }
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
        if (tt > 0.15 && tt < 0.85 && distance(px, py, cat.x, cat.y) < 40 * esm && Math.sqrt(L2) < 300 * esm) {
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
    if (S >= 5 && cdReady("star", 25, dt)) {
      var st = nearestMice(cat.x, cat.y, 200 * esm, 20);
      for (i = 0; i < st.length; i++) { pullM(st[i], cat.x, cat.y, 250 * esm, 1.0); stunM(st[i], 1.2, "rope"); }
      fx("star", cat.x, cat.y, 1.2, { r: 200 * esm }); abProc();
    }
  }

  // ---- 蓝灰：圆滚滚旋风 ----
  function updateWind(dt, S, esm, sharpTurn) {
    var i, j, tw, m;
    if (ab.tornados.length === 0 && ab.straight >= 2 && !(ab.t.windCd > 0)) {
      var p = mouthPoint(120 * esm);
      ab.tornados.push({ x: p.x, y: p.y, t: 0, life: S >= 2 ? 4 : 3, r: 60, hops: 0, follow: S >= 2, sucked: 0 }); abProc();
    }
    if (ab.t.windCd > 0) ab.t.windCd -= dt;
    if (S >= 4 && sharpTurn && !(ab.t.splitCd > 0)) {
      ab.t.splitCd = 5;
      for (var sd = -1; sd <= 1; sd += 2) { var aa = cat.facing + sd * Math.PI / 2; ab.tornados.push({ x: cat.x + Math.cos(aa) * 70 * esm, y: cat.y + Math.sin(aa) * 70 * esm, t: 0, life: 2, r: 50, hops: 3, follow: false, vx: Math.cos(aa) * 120, vy: Math.sin(aa) * 120, sucked: 0 }); }
      abProc();
    }
    if (ab.t.splitCd > 0) ab.t.splitCd -= dt;
    for (i = ab.tornados.length - 1; i >= 0; i--) {
      tw = ab.tornados[i]; tw.t += dt;
      if (tw.follow && !tw.hopTo) { var fp = mouthPoint(110 * esm); tw.x += (fp.x - tw.x) * (1 - Math.exp(-dt * 5)); tw.y += (fp.y - tw.y) * (1 - Math.exp(-dt * 5)); }
      if (tw.vx) { tw.x += tw.vx * esm * dt; tw.y += tw.vy * esm * dt; }
      if (tw.hopTo) { var hk = Math.min(1, (tw.t - tw.hopT0) / 0.35); tw.x = tw.hx + (tw.hopTo.x - tw.hx) * hk; tw.y = tw.hy + (tw.hopTo.y - tw.hy) * hk; if (hk >= 1) tw.hopTo = null; }
      var got = 0;
      for (j = 0; j < mice.length; j++) {
        m = mice[j]; if (m.hidden || m.carried) continue;
        var d = distance(m.x, m.y, tw.x, tw.y);
        if (d < tw.r * esm) { if (!(m.stun > 0)) { stunM(m, 2, "spin"); got++; tw.sucked++; } pullM(m, tw.x, tw.y, 120 * esm, 0.2); }
      }
      if (S >= 3 && tw.sucked > 0 && tw.hops < 3 && !tw.hopTo && tw.t > 0.8) { // 连锁跳
        var nx = nearestMice(tw.x, tw.y, 260 * esm, 1, function (q) { return !(q.stun > 0) && distance(q.x, q.y, tw.x, tw.y) > tw.r * esm; })[0];
        if (nx) { tw.hops++; tw.sucked = 0; tw.follow = false; tw.hx = tw.x; tw.hy = tw.y; tw.hopTo = { x: nx.x, y: nx.y }; tw.hopT0 = tw.t; tw.life = tw.t + 1.6; fx("hop", tw.x, tw.y, 0.4, { tx: nx.x, ty: nx.y }); }
      }
      if (tw.t > tw.life) { ab.tornados.splice(i, 1); if (!tw.vx) ab.t.windCd = 4; }
    }
    if (S >= 5 && cdReady("bigroll", 30, dt)) { ab.roll = 3; abProc(); }
    if (ab.roll > 0) { // 大胖龙卷：团成球滚 3 秒，沿途老鼠卷到嘴边
      ab.roll -= dt;
      var big = nearestMice(cat.x, cat.y, 140 * esm, 20);
      for (i = 0; i < big.length; i++) { stunM(big[i], 0.6, "spin"); pullM(big[i], cat.x, cat.y, 220 * esm, 0.3); }
    }
  }

  // ---- 暹罗：歌剧喵 ----
  function updateOpera(dt, S, esm) {
    var i, m;
    if (cdReady("note", 8, dt)) {
      var tg = nearestMice(cat.x, cat.y, 260 * esm, S >= 2 ? 3 : 1, function (q) { return !(q.stun > 0); });
      var NOTE = ["♪", "♫", "♬"];
      for (i = 0; i < tg.length; i++) ab.notes.push({ k: "note", ch: NOTE[i % 3], c: ["#ff7a9a", "#7ab8ff", "#ffc24a"][i % 3], x: cat.x, y: cat.y - 20 * esm, tgt: tg[i], v: 300 });
      if (tg.length) { abProc(); fx("sing", cat.x, cat.y, 0.6, {}); }
    }
    updateProjectiles(dt, esm, function (m) { stunM(m, 2, "dance"); m.danceT = 2; });
    if (S >= 3) { // 康加舞队：跳舞的老鼠排队朝你走来
      var dancers = mice.filter(function (q) { return q.stunKind === "dance" && q.stun > 0 && !q.hidden; });
      for (i = 0; i < dancers.length; i++) {
        var slot = mouthPoint((50 + i * 22) * esm);
        pullM(dancers[i], slot.x, slot.y, 55 * esm, 0.2);
      }
    }
    if (S >= 4 && cdReady("spot", 20, dt)) {
      var fm = freeMice(), best = null, bestN = 0;
      for (i = 0; i < fm.length; i++) { if (distance(fm[i].x, fm[i].y, cat.x, cat.y) > 360 * esm) continue; var nb = nearestMice(fm[i].x, fm[i].y, 100 * esm, 10); if (nb.length > bestN) { bestN = nb.length; best = fm[i]; } }
      if (best) {
        var bow = nearestMice(best.x, best.y, 100 * esm, 10);
        for (i = 0; i < bow.length; i++) stunM(bow[i], 2.5, "bow");
        ab.spot = { x: best.x, y: best.y, t: 2.5, r: 100 * esm }; abProc();
      }
    }
    if (ab.spot) { ab.spot.t -= dt; if (ab.spot.t <= 0) ab.spot = null; }
    if (S >= 5 && cdReady("choir", 30, dt)) {
      var ch = nearestMice(cat.x, cat.y, 320 * esm, 9);
      for (i = 0; i < ch.length; i++) {
        var ang = cat.facing - Math.PI / 2 + Math.PI * (ch.length === 1 ? 0.5 : i / (ch.length - 1));
        pullM(ch[i], cat.x + Math.cos(ang) * 90 * esm, cat.y + Math.sin(ang) * 90 * esm, 260 * esm, 1.2);
        stunM(ch[i], 3, "sing");
      }
      fx("choir", cat.x, cat.y, 3, {}); abProc();
    }
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
      if (f.k === "lasso" && f.m && mice.indexOf(f.m) >= 0) {
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

  function spawnScorePopup(x, y, amount) {
    scorePopups.push({ x: x, y: y, amount: amount, age: 0, life: 0.9 });
  }

  function spawnCatchParticles(x, y) {
    if (catchParticles.length > 60) catchParticles.splice(0, catchParticles.length - 60);
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

  function drawGround() {
    ctx.fillStyle = "#a8de8e";
    ctx.fillRect(0, 0, W, H);
    var t = TILE * SCALE;
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

  function drawBackground() {
    drawGround();
    forEachVisibleChunk(function (chunk) {
      for (var i = 0; i < chunk.decor.length; i++) drawDecor(chunk.decor[i]);
    });
  }

  function drawDecor(d) {
    var sx = worldToScreenX(d.x), sy = worldToScreenY(d.y);
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
      if (m.anim.mode === "run") {
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
    ctx.drawImage(spr.cv, -spr.ox * spr.px, -(spr.oy + g) * spr.px);
    ctx.restore();
  }

  function shadow(x, y, rx) {
    ART.ellipse(ctx, x, y, rx, rx * 0.28, "rgba(40,90,30,0.2)");
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
    var spr = ANIM.mouseSprite(gulp.type, isBack ? "back" : "front", "sit", 2, spritePx(mu));
    ctx.globalAlpha = isBack ? 1 - k * 0.7 : 1;
    blit(spr, x + px * u * flip, y + py * u, mu, flip);
    ctx.globalAlpha = 1;
  }

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
    shadow(x, y + 46 * u, (st[0] === "run" ? 30 : 26) * u);
    if (!ghost) drawGulpMouse(x, y, u, view, flip, true);
    blit(ANIM.catSprite(skin, view, st[0], st[1], spritePx(u)), x, y, u, flip, 1 - breathe * 0.5, 1 + breathe, 46);
    if (!ghost) drawGulpMouse(x, y, u, view, flip, false);
  }

  function drawCat() {
    drawCatAt(worldToScreenX(cat.x), worldToScreenY(cat.y) + s(evoHop()), s(cat.r), catAnim, cat.runCycle, currentSkin);
  }

  function drawMice() {
    for (var i = 0; i < mice.length; i++) {
      var m = mice[i];
      if (m.hidden) continue;
      var sx = worldToScreenX(m.x), sy = worldToScreenY(m.y);
      if (sx < -60 || sx > W + 60 || sy < -60 || sy > H + 60) continue;
      if (!m.anim) m.anim = newAnim();
      var r = s(m.r);
      var u = r * MOUSE_UNIT_PER_R;
      var d = ANIM.DIR8[m.anim.dir];
      var st = animFrame(m.anim, m.runCycle * 1.4, MOUSE_SIT_SCHED);
      shadow(sx, sy + 24 * u, (st[0] === "run" ? 20 : 16) * u);
      blit(ANIM.mouseSprite(m.type, d[0], st[0], st[1], spritePx(u)), sx, sy, u, d[1]);
      if (m.type === "gold") {
        var tw = (Math.sin(m.runCycle * 3 + i) + 1) / 2;
        var top = st[0] === "sit" ? -40 : -24;
        ART.star(ctx, sx + 24 * u, sy + top * u, (3 + tw * 3) * u * 1.4, "rgba(255,236,140," + (0.5 + tw * 0.5) + ")");
        ART.star(ctx, sx - 26 * u, sy + (top + 18) * u, (2 + (1 - tw) * 3) * u * 1.4, "rgba(255,236,140," + (1 - tw * 0.5) + ")");
      }
    }
  }

  var PARTICLE_COLORS = ["#ff7a9a", "#ffd84a", "#8fd3ff", "#ffffff"];
  function drawEffects() {
    var i;
    for (i = 0; i < catchParticles.length; i++) {
      var c = catchParticles[i];
      var sx = worldToScreenX(c.x), sy = worldToScreenY(c.y);
      var alpha = Math.max(0, 1 - c.age / c.life);
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
      ctx.strokeText("+" + p.amount + " ♥", sx2, sy2 - s(26));
      ctx.fillStyle = "#ffffff";
      ctx.fillText("+" + p.amount + " ♥", sx2, sy2 - s(26));
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
      } else {
        // 后端正常响应了，只是这次调用本身被判定无效（比如 invalid_run），
        // 不是网络问题，不应该说成"未能连接排行榜"。
        dom.resultRankStatus.textContent = "本局成绩未被接受";
      }
    });
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
    if (!backendConfigured || (leaderboardSnapshot.length === 0 && mySnapshotRank == null)) { setText(dom.rankText, "排名：--"); return; }
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
    lbFilter: document.getElementById("lbFilter")
  };

  var best = parseInt(storageGet("catmouse_best", "0"), 10) || 0;

  function updateMuteBtn() { dom.muteBtn.textContent = muted ? "🔇" : "🔊"; }
  updateMuteBtn();

  function showScreen(el) { el.classList.remove("hidden"); }
  function hideScreen(el) { el.classList.add("hidden"); }

  function enterStart() {
    state = STATE_START;
    hideScreen(dom.hud);
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
    showScreen(dom.hud);
    resetWorld();
    resetScoring();
    resetAbilities();
    dom.abilityBadge.dataset.key = ""; updateSkillBadge(true);
    dom.comboText.classList.add("hidden");
    setText(dom.rankText, "排名：--");
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
    hideScreen(dom.hud);
    if (score > best) { best = score; storageSet("catmouse_best", String(best)); }
    dom.resultScore.textContent = String(score);
    dom.resultCatches.textContent = String(catches);
    dom.resultDuration.textContent = String(Math.round(elapsedPlayTime));
    dom.resultCombo.textContent = String(comboMax);
    dom.resultBest.textContent = String(best);
    dom.resultRankStatus.textContent = "结算中…";
    dom.nicknameInputResult.value = storageGet("catmouse_nickname", "");
    dom.nicknameHintResult.classList.add("hidden");
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

  document.addEventListener("visibilitychange", function () {
    if (document.hidden && state === STATE_PLAY) enterPause();
  });

  dom.startBtn.addEventListener("click", beginRun);
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
    } else {
      dom.comboText.classList.add("hidden");
    }
  }

  function update(dt) {
    if (state === STATE_PLAY) {
      elapsedPlayTime += dt;
      updateCat(dt);
      updateAbilities(dt);
      updateCamera(dt);
      ensureChunksAround(camera.x, camera.y);
      pruneFarChunks(dt, camera.x, camera.y);
      updateMice(dt);
      trySpawnMouse();
      updateComboTimer(dt);
      updateEffects(dt);
      updateAnims(dt);
      updateHud();
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
    drawBackground();
    drawObstacles();
    drawAbilityGround();
    drawDust();
    drawMice();
    drawAbilityBehindCat();
    drawCat();
    drawAbilityOverlay();
    drawEffects();
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
  function frame(now) {
    if (lastFrameTime == null) lastFrameTime = now;
    var dt = Math.min(0.05, (now - lastFrameTime) / 1000);
    lastFrameTime = now;
    update(dt);
    draw();
    animateSkinPreview(dt);
    requestAnimationFrame(frame);
  }
  requestAnimationFrame(frame);

  buildLbFilter();
  enterStart();

  // =======================================================================
  // Debug hook（只读，供自动化测试使用，不影响正常游戏逻辑）
  // =======================================================================

  window.__catDebug = {
    get state() { return state; },
    get cat() { return { x: cat.x, y: cat.y, vx: cat.vx, vy: cat.vy }; },
    get camera() { return { x: camera.x, y: camera.y }; },
    get mice() { return mice.map(function (m) { return { x: m.x, y: m.y, type: m.type, state: m.state }; }); },
    get score() { return score; },
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
    teleport: function (x, y) { cat.x = x; cat.y = y; camera.x = x; camera.y = y; },
    setMove: function (x, y) { moveDir.x = x; moveDir.y = y; },
    stepSim: function (sec) { var n = Math.round(sec * 60); for (var i = 0; i < n; i++) update(1 / 60); },
    selectSkin: selectSkin,
    setFacing: function (a) { cat.facing = a; },
    get catAnim() { return { mode: catAnim.mode, dir: catAnim.dir, gulp: !!gulp }; },
    get spriteStats() { return ANIM.stats(); },
    get packs() { var c = {}; mice.forEach(function (m) { if (m.packId) c[m.packId] = (c[m.packId] || 0) + 1; }); return c; },
    spawnPackNear: function (dx, dy, n) { spawnPack({ x: cat.x + dx, y: cat.y + dy }, n || 5, currentDifficulty()); },
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
