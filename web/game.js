(function () {
  "use strict";

  // =======================================================================
  // Config & constants
  // =======================================================================

  // TODO(站长): 填入 https://<project-ref>.supabase.co
  var SUPABASE_URL = "";
  // TODO(站长): 填入 publishable key (sb_publishable_...)
  var SUPABASE_ANON_KEY = "";

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

  function resize() {
    W = window.innerWidth;
    H = window.innerHeight;
    DPR = window.devicePixelRatio || 1;
    canvas.width = Math.round(W * DPR);
    canvas.height = Math.round(H * DPR);
    canvas.style.width = W + "px";
    canvas.style.height = H + "px";
    ctx.setTransform(DPR, 0, 0, DPR, 0, 0);
    SCALE = Math.min(W, H) / REF_W;
    entityScaleMult = computeEntityScaleMult(Math.min(W, H));
  }

  window.addEventListener("resize", resize);
  window.addEventListener("orientationchange", resize);
  resize();

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
    var range = Math.ceil(LOAD_MARGIN / CHUNK_SIZE) + 1;
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
      if (distance(ccx, ccy, centerX, centerY) > UNLOAD_MARGIN) toDelete.push(key);
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
      if (distance(ccx, ccy, centerX, centerY) < LOAD_MARGIN + CHUNK_SIZE) {
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

  var cat = {
    x: 0, y: 0, vx: 0, vy: 0, r: CAT_RADIUS,
    facing: 0, runCycle: 0, squash: 0
  };

  var moveDir = { x: 0, y: 0 };

  var mice = [];

  function resetWorld() {
    worldSeed = (Math.random() * 2147483647) | 0;
    chunkCache.clear();
    mice.length = 0;
    cat.x = 0; cat.y = 0; cat.vx = 0; cat.vy = 0; cat.facing = 0; cat.runCycle = 0; cat.squash = 0;
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
    cat.x += cat.vx * dt;
    cat.y += cat.vy * dt;

    var obstacles = queryNearbyObstacles(cat.x, cat.y);
    for (var i = 0; i < obstacles.length; i++) resolveCircleAabb(cat, obstacles[i]);

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

  function maxMice(t) { return Math.round(lerp(5, 10, t)); }
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
    for (var i = mice.length - 1; i >= 0; i--) {
      var m = mice[i];
      m.r = MOUSE_RADIUS * entityScaleMult;
      var dToCat = distance(m.x, m.y, cat.x, cat.y);

      if (m.state === "wander") {
        if (dToCat < MOUSE_AWARE_R) { m.state = "flee"; m.awareBuffer = 0; }
      } else if (dToCat > MOUSE_AWARE_R * 1.2) {
        m.awareBuffer += dt;
        if (m.awareBuffer > 0.3) m.state = "wander";
      } else {
        m.awareBuffer = 0;
      }

      if (m.state === "flee") {
        var away = normalize(m.x - cat.x, m.y - cat.y);
        var desiredAngle = Math.atan2(away.y, away.x);
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
        if (m.idleTimer > 0) {
          m.idleTimer -= dt;
          m.vx = 0; m.vy = 0;
        } else {
          m.vx = Math.cos(m.wanderDir) * m.speed * 0.35;
          m.vy = Math.sin(m.wanderDir) * m.speed * 0.35;
        }
      }

      m.x += m.vx * dt;
      m.y += m.vy * dt;

      var obstacles = queryNearbyObstacles(m.x, m.y);
      for (var k = 0; k < obstacles.length; k++) resolveCircleAabb(m, obstacles[k]);

      if (m.vx !== 0 || m.vy !== 0) m.facing = Math.atan2(m.vy, m.vx);
      m.runCycle += dt * (Math.sqrt(m.vx * m.vx + m.vy * m.vy) / 24 + 0.3);

      var dAfter = distance(m.x, m.y, cat.x, cat.y);
      if (dAfter > MOUSE_CLEANUP_R) { mice.splice(i, 1); continue; }
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
    if (m.type === "grey") sfx.catchGrey();
    else if (m.type === "brown") sfx.catchBrown();
    else sfx.catchGold();
    if (combo >= 3) sfx.combo();

    maybeSendHeartbeat(Date.now());
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
    for (var i = 0; i < 5; i++) {
      var a = Math.random() * Math.PI * 2;
      var sp = 40 + Math.random() * 40;
      catchParticles.push({ x: x, y: y, vx: Math.cos(a) * sp, vy: Math.sin(a) * sp, age: 0, life: 0.3 + Math.random() * 0.1 });
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

  var MOUSE_COLORS = { grey: "#9a9a9a", brown: "#a9703f", gold: "#f1c232" };

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

  function drawBackground() {
    ctx.fillStyle = "#8fcf6b";
    ctx.fillRect(0, 0, W, H);
    forEachVisibleChunk(function (chunk) {
      for (var i = 0; i < chunk.decor.length; i++) drawDecor(chunk.decor[i]);
    });
  }

  function drawDecor(d) {
    var sx = worldToScreenX(d.x), sy = worldToScreenY(d.y);
    if (sx < -20 || sx > W + 20 || sy < -20 || sy > H + 20) return;
    ctx.save();
    ctx.translate(sx, sy);
    ctx.rotate(d.rot);
    ctx.scale(d.scale * SCALE, d.scale * SCALE);
    if (d.kind === "grass") {
      ctx.strokeStyle = "rgba(60,120,40,0.55)";
      ctx.lineWidth = 2;
      for (var k = -1; k <= 1; k++) {
        ctx.beginPath();
        ctx.moveTo(k * 3, 0);
        ctx.quadraticCurveTo(k * 5, -6, k * 2, -11);
        ctx.stroke();
      }
    } else if (d.kind === "flower") {
      ctx.fillStyle = "rgba(255,255,255,0.8)";
      for (var p = 0; p < 4; p++) {
        ctx.beginPath();
        ctx.ellipse(Math.cos(p * Math.PI / 2) * 3, Math.sin(p * Math.PI / 2) * 3, 2.6, 1.8, p * Math.PI / 2, 0, Math.PI * 2);
        ctx.fill();
      }
      ctx.fillStyle = "#ffd977";
      ctx.beginPath(); ctx.arc(0, 0, 1.8, 0, Math.PI * 2); ctx.fill();
    } else {
      ctx.fillStyle = "rgba(255,255,255,0.35)";
      ctx.beginPath();
      ctx.ellipse(0, 0, 4, 3, 0, 0, Math.PI * 2);
      ctx.fill();
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
    ctx.save();
    if (o.kind === "crate") {
      ctx.fillStyle = "#c58a4a";
      roundRectPath(sx, sy, sw, sh, 4);
      ctx.fill();
      ctx.strokeStyle = "#8a5a28";
      ctx.lineWidth = 2;
      ctx.stroke();
      ctx.beginPath();
      ctx.moveTo(sx, sy + sh / 2); ctx.lineTo(sx + sw, sy + sh / 2);
      ctx.moveTo(sx + sw / 2, sy); ctx.lineTo(sx + sw / 2, sy + sh);
      ctx.stroke();
    } else if (o.kind === "bush") {
      ctx.fillStyle = "#4f8f3d";
      var r = Math.min(sw, sh) / 2;
      ctx.beginPath(); ctx.arc(sx + sw * 0.3, sy + sh * 0.6, r * 0.8, 0, Math.PI * 2); ctx.fill();
      ctx.beginPath(); ctx.arc(sx + sw * 0.7, sy + sh * 0.6, r * 0.8, 0, Math.PI * 2); ctx.fill();
      ctx.beginPath(); ctx.arc(sx + sw * 0.5, sy + sh * 0.35, r * 0.9, 0, Math.PI * 2); ctx.fill();
    } else {
      ctx.fillStyle = "#9a9a92";
      roundRectPath(sx, sy, sw, sh, sw * 0.3);
      ctx.fill();
      ctx.strokeStyle = "rgba(255,255,255,0.4)";
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.arc(sx + sw * 0.35, sy + sh * 0.35, sw * 0.18, 0, Math.PI);
      ctx.stroke();
    }
    ctx.restore();
  }

  function facing8(angle) { return Math.round(angle / (Math.PI / 4)) * (Math.PI / 4); }

  function drawQuadruped(x, y, r, angle, runCycle, bodyColor, earColor, squash) {
    var dir = facing8(angle);
    var legPhase = Math.sin(runCycle) * r * 0.35;
    ctx.save();
    ctx.translate(x, y);
    ctx.rotate(dir);
    var bodyW = r * 1.5 * (1 + (squash || 0) * 0.3);
    var bodyH = r * 1.0 * (1 - (squash || 0) * 0.25);

    ctx.fillStyle = "rgba(0,0,0,0.15)";
    ctx.beginPath();
    ctx.ellipse(0, bodyH * 0.65, bodyW * 0.5, bodyH * 0.22, 0, 0, Math.PI * 2);
    ctx.fill();

    ctx.fillStyle = bodyColor;
    ctx.beginPath();
    ctx.ellipse(-legPhase * 0.4, bodyH * 0.55, r * 0.22, r * 0.22, 0, 0, Math.PI * 2);
    ctx.ellipse(legPhase * 0.4, bodyH * 0.55, r * 0.22, r * 0.22, 0, 0, Math.PI * 2);
    ctx.fill();

    ctx.beginPath();
    ctx.ellipse(0, 0, bodyW * 0.55, bodyH * 0.5, 0, 0, Math.PI * 2);
    ctx.fill();

    ctx.beginPath();
    ctx.moveTo(-bodyW * 0.75, bodyH * 0.1);
    ctx.quadraticCurveTo(-bodyW * 1.1, bodyH * 0.5, -bodyW * 0.85, bodyH * 0.65);
    ctx.lineWidth = Math.max(1, r * 0.18);
    ctx.strokeStyle = bodyColor;
    ctx.stroke();

    ctx.fillStyle = earColor || bodyColor;
    ctx.beginPath();
    ctx.moveTo(bodyW * 0.25, -bodyH * 0.35);
    ctx.lineTo(bodyW * 0.45, -bodyH * 0.75);
    ctx.lineTo(bodyW * 0.55, -bodyH * 0.25);
    ctx.closePath();
    ctx.fill();
    ctx.beginPath();
    ctx.moveTo(bodyW * 0.5, -bodyH * 0.2);
    ctx.lineTo(bodyW * 0.75, -bodyH * 0.55);
    ctx.lineTo(bodyW * 0.75, -bodyH * 0.05);
    ctx.closePath();
    ctx.fill();

    ctx.fillStyle = "#2a2a2a";
    ctx.beginPath();
    ctx.arc(bodyW * 0.42, -bodyH * 0.08, Math.max(1, r * 0.08), 0, Math.PI * 2);
    ctx.fill();

    ctx.restore();
  }

  function drawCat() {
    drawQuadruped(worldToScreenX(cat.x), worldToScreenY(cat.y), s(cat.r), cat.facing, cat.runCycle, "#ff9d5c", "#ffb27a", cat.squash);
  }

  function drawMice() {
    for (var i = 0; i < mice.length; i++) {
      var m = mice[i];
      var sx = worldToScreenX(m.x), sy = worldToScreenY(m.y);
      if (sx < -40 || sx > W + 40 || sy < -40 || sy > H + 40) continue;
      drawQuadruped(sx, sy, s(m.r), m.facing, m.runCycle, MOUSE_COLORS[m.type], MOUSE_COLORS[m.type], 0);
    }
  }

  function drawEffects() {
    var i;
    for (i = 0; i < catchParticles.length; i++) {
      var c = catchParticles[i];
      var sx = worldToScreenX(c.x), sy = worldToScreenY(c.y);
      var alpha = Math.max(0, 1 - c.age / c.life);
      ctx.fillStyle = "rgba(255,255,255," + alpha + ")";
      ctx.beginPath();
      ctx.arc(sx, sy, 3 * alpha + 1, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.textAlign = "center";
    ctx.font = "bold " + s(16) + "px sans-serif";
    for (i = 0; i < scorePopups.length; i++) {
      var p = scorePopups[i];
      var sx2 = worldToScreenX(p.x), sy2 = worldToScreenY(p.y);
      var a = Math.max(0, 1 - p.age / p.life);
      ctx.fillStyle = "rgba(255,255,255," + a + ")";
      ctx.fillText("+" + p.amount, sx2, sy2 - 20);
    }
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

  function rpcPost(name, body, keepalive) {
    if (!backendConfigured) return Promise.resolve({ ok: false });
    var fetchOpts = { method: "POST", headers: restHeaders(), body: JSON.stringify(body) };
    if (keepalive) fetchOpts.keepalive = true;
    return fetch(restUrl("/rest/v1/rpc/" + name), fetchOpts)
      .then(function (res) {
        if (!res.ok) return { ok: false };
        return res.json().then(function (data) {
          var row = unwrapRpcResult(data);
          row.ok = row.ok !== false;
          return row;
        }).catch(function () { return { ok: true }; });
      })
      .catch(function () { return { ok: false }; });
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
    rpcPost("start_run", { p_client_id: clientId, p_nickname: nickname || "" }).then(function (res) {
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
      p_client_ts: new Date().toISOString()
    };
  }

  function maybeSendHeartbeat(now) {
    if (run.id == null || run.offline) return;
    var since = now - run.lastSentAt;
    if (since < HEARTBEAT_MIN_INTERVAL_MS) return;
    var dueInterval;
    if (state === STATE_PAUSE) dueInterval = HEARTBEAT_PAUSED_INTERVAL_MS;
    else dueInterval = (score !== run.lastSentScore) ? HEARTBEAT_ACTIVE_INTERVAL_MS : HEARTBEAT_IDLE_INTERVAL_MS;
    if (since < dueInterval) return;
    run.lastSentAt = now;
    run.lastSentScore = score;
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
      if (res.ok && res.rank != null) dom.resultRankStatus.textContent = "你是第 " + res.rank + " 名！";
      else dom.resultRankStatus.textContent = "未能连接排行榜，成绩未上传";
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

  function applySnapshotToHud() {
    if (!backendConfigured || leaderboardSnapshot.length === 0) { dom.rankText.textContent = "排名：--"; return; }
    var rank = estimateRank(leaderboardSnapshot, score);
    dom.rankText.textContent = rank > leaderboardSnapshot.length
      ? ("排名：" + leaderboardSnapshot.length + "+ 名")
      : ("当前约第 " + rank + " 名");
  }

  function refreshSnapshotIfDue(now) {
    if (!backendConfigured) return;
    if (leaderboardSnapshotAt !== 0 && now - leaderboardSnapshotAt < LEADERBOARD_POLL_INTERVAL_MS) return;
    leaderboardSnapshotAt = now;
    restGet("/rest/v1/leaderboard_live?select=display_score&order=display_score.desc&limit=" + LEADERBOARD_SNAPSHOT_LIMIT)
      .then(function (res) {
        if (!res.ok) return;
        leaderboardSnapshot = res.rows.map(function (r) { return r.display_score; }).sort(function (a, b) { return b - a; });
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
  function sanitizeNickname(raw) {
    var cleaned = String(raw || "").replace(/[^a-zA-Z0-9_\- 一-鿿]/g, "");
    cleaned = cleaned.replace(/\s+/g, " ");
    return cleaned.slice(0, 12);
  }

  // 镜像 supabase/migrations/20261018070000_nickname_blacklist_v2.sql 里的
  // nickname_is_offensive()：同一套规范化步骤（转小写、去分隔符、leet 替换、
  // 压缩重复字母）+ 同一份词表。两处改一处记得同步另一处。这里只是提前给
  // 用户一个提示，真正兜底仍由服务端 start_run() 决定存成什么昵称。
  var NICKNAME_OFFENSIVE_PATTERN = new RegExp(
    "(傻x|傻逼|白痴|管理员|客服|官方)|" +
    "(fuk|fuck|fck|shit|sht|bitch|cunt|dick|cock|pussy|asshole|bastard|slut|" +
    "whore|nigger|nigga|faggot|fag|retard|rape|nazi|hitler|porn|sex|kys|" +
    "twat|wanker|admin|system|supabase)"
  );

  function normalizeForOffensiveCheck(raw) {
    var v = String(raw || "").toLowerCase();
    v = v.replace(/[ _.\-]/g, "");
    var leet = { "0": "o", "1": "i", "3": "e", "4": "a", "5": "s", "7": "t", "@": "a", "$": "s", "!": "i" };
    v = v.replace(/[013457@$!]/g, function (c) { return leet[c] || c; });
    v = v.replace(/(.)\1+/g, "$1");
    return v;
  }

  function isNicknameOffensive(raw) {
    var v = normalizeForOffensiveCheck(raw);
    return v !== "" && NICKNAME_OFFENSIVE_PATTERN.test(v);
  }

  // 在输入框失焦（blur）或真正提交（beginRun/切换昵称）时调用：命中就把
  // 输入框清空、显示提示文字，并返回空字符串交给调用方——提交给
  // start_run() 时空昵称会被服务端回退成"匿名猫+随机数字"，前后端不需要
  // 各自维护一套随机数生成逻辑也能保持结果一致。不在每次按键时都做这个
  // 检查，否则打到一半的词（比如正在打"Essex"打到"sex"那一刻）就会被
  // 整个清空，体验很差。
  function enforceNicknameNotOffensive(inputEl, hintEl) {
    var value = inputEl.value;
    if (isNicknameOffensive(value)) {
      inputEl.value = "";
      hintEl.classList.remove("hidden");
      return "";
    }
    hintEl.classList.add("hidden");
    return value;
  }

  function loadTopScores() {
    dom.leaderboardList.innerHTML = '<div class="lb-loading">加载中…</div>';
    if (!backendConfigured) {
      dom.leaderboardList.innerHTML = '<div class="lb-error">排行榜未配置</div>';
      return;
    }
    restGet("/rest/v1/leaderboard_live?select=nickname,display_score,is_live,is_paused&order=display_score.desc&limit=" + LEADERBOARD_TOPN_LIMIT)
      .then(function (res) {
        if (!res.ok) { dom.leaderboardList.innerHTML = '<div class="lb-error">暂时无法连接排行榜</div>'; return; }
        if (res.rows.length === 0) { dom.leaderboardList.innerHTML = '<div class="lb-empty">还没有人上榜，来当第一个吧！</div>'; return; }
        var html = "";
        for (var i = 0; i < res.rows.length; i++) {
          var row = res.rows[i];
          var badge = "";
          if (row.is_live) badge = '<span class="lb-badge live">游戏中</span>';
          else if (row.is_paused) badge = '<span class="lb-badge paused">已暂停</span>';
          html += '<div class="lb-row"><span class="lb-rank">' + (i + 1) + '</span>' +
            '<span class="lb-name">' + escapeHtml(row.nickname || "匿名猫") + '</span>' +
            badge + '<span class="lb-score">' + row.display_score + '</span></div>';
        }
        dom.leaderboardList.innerHTML = html;
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
    leaderboardCloseBtn: document.getElementById("leaderboardCloseBtn")
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
    dom.comboText.classList.add("hidden");
    dom.rankText.textContent = "排名：--";
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
    showScreen(dom.pauseScreen);
  }

  function resumePlay() {
    if (state !== STATE_PAUSE) return;
    state = STATE_PLAY;
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

  function openLeaderboard() {
    sfx.click();
    showScreen(dom.leaderboardScreen);
    loadTopScores();
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
    dom.nicknameInput.value = sanitizeNickname(dom.nicknameInput.value);
  });
  dom.nicknameInput.addEventListener("blur", function () {
    enforceNicknameNotOffensive(dom.nicknameInput, dom.nicknameHint);
  });
  dom.nicknameInputResult.addEventListener("input", function () {
    dom.nicknameInputResult.value = sanitizeNickname(dom.nicknameInputResult.value);
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
  dom.leaderboardCloseBtn.addEventListener("click", function () { hideScreen(dom.leaderboardScreen); });

  // =======================================================================
  // Main loop
  // =======================================================================

  function updateHud() {
    dom.scoreText.textContent = String(score);
    if (combo >= 2) {
      dom.comboText.classList.remove("hidden");
      dom.comboText.textContent = "连击 x" + combo;
    } else {
      dom.comboText.classList.add("hidden");
    }
  }

  function update(dt) {
    if (state === STATE_PLAY) {
      elapsedPlayTime += dt;
      updateCat(dt);
      updateCamera(dt);
      ensureChunksAround(camera.x, camera.y);
      pruneFarChunks(dt, camera.x, camera.y);
      updateMice(dt);
      trySpawnMouse();
      updateComboTimer(dt);
      updateEffects(dt);
      updateHud();
      refreshSnapshotIfDue(Date.now());
      maybeSendHeartbeat(Date.now());
    } else if (state === STATE_PAUSE) {
      maybeSendHeartbeat(Date.now());
    }
  }

  var idleRunCycle = 0;
  function drawIdleScene() {
    ctx.fillStyle = "#8fcf6b";
    ctx.fillRect(0, 0, W, H);
    idleRunCycle += 0.016;
    drawQuadruped(W / 2, H / 2 + s(20), s(CAT_RADIUS * entityScaleMult), Math.sin(idleRunCycle * 0.3) * 0.6, idleRunCycle, "#ff9d5c", "#ffb27a", 0);
  }

  function draw() {
    if (state === STATE_START) { drawIdleScene(); return; }
    drawBackground();
    drawObstacles();
    drawMice();
    drawCat();
    drawEffects();
  }

  var lastFrameTime = null;
  function frame(now) {
    if (lastFrameTime == null) lastFrameTime = now;
    var dt = Math.min(0.05, (now - lastFrameTime) / 1000);
    lastFrameTime = now;
    update(dt);
    draw();
    requestAnimationFrame(frame);
  }
  requestAnimationFrame(frame);

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
    forceSpawnMouseNear: function (dx, dy, type) {
      spawnMouseAt(cat.x + (dx || 0), cat.y + (dy || 0), type || "grey", currentDifficulty());
    }
  };

})();
