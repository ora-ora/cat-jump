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
    catAnim = newAnim(); gulp = null; dustPuffs.length = 0;
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
    startGulp(m);
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

  function drawCatAt(x, y, r, a, runCycle, skin) {
    var u = r * CAT_UNIT_PER_R;
    var dirInfo = ANIM.DIR8[gulp ? gulp.dir : a.dir];
    var view = dirInfo[0], flip = dirInfo[1];
    var st;
    if (gulp) st = ["gulp", Math.min(4, Math.floor(gulp.t / (GULP_T / 5)))];
    else st = animFrame(a, runCycle, CAT_SIT_SCHED);
    var sitting = st[0] === "sit" && a.mode === "sit";
    var breathe = sitting ? Math.sin((a.t + a.phase) * 2.4) * 0.03 : 0;
    shadow(x, y + 46 * u, (st[0] === "run" ? 30 : 26) * u);
    drawGulpMouse(x, y, u, view, flip, true);
    blit(ANIM.catSprite(skin, view, st[0], st[1], spritePx(u)), x, y, u, flip, 1 - breathe * 0.5, 1 + breathe, 46);
    drawGulpMouse(x, y, u, view, flip, false);
  }

  function drawCat() {
    drawCatAt(worldToScreenX(cat.x), worldToScreenY(cat.y) - 0, s(cat.r), catAnim, cat.runCycle, currentSkin);
  }

  function drawMice() {
    for (var i = 0; i < mice.length; i++) {
      var m = mice[i];
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

  function loadTopScores() {
    dom.leaderboardList.innerHTML = '<div class="lb-loading">加载中…</div>';
    if (!backendConfigured) {
      dom.leaderboardList.innerHTML = '<div class="lb-error">排行榜未配置</div>';
      return;
    }
    restGet("/rest/v1/leaderboard_live?select=nickname,display_score,is_live,is_paused,skin&order=display_score.desc&limit=" + LEADERBOARD_TOPN_LIMIT)
      .then(function (res) {
        if (!res.ok) { dom.leaderboardList.innerHTML = '<div class="lb-error">暂时无法连接排行榜</div>'; return; }
        if (res.rows.length === 0) { dom.leaderboardList.innerHTML = '<div class="lb-empty">还没有人上榜，来当第一个吧！</div>'; return; }
        var html = "";
        for (var i = 0; i < res.rows.length; i++) {
          var row = res.rows[i];
          var badge = "";
          if (row.is_live) badge = '<span class="lb-badge live">游戏中</span>';
          else if (row.is_paused) badge = '<span class="lb-badge paused">已暂停</span>';
          var skinId = SKIN_IDS.indexOf(row.skin) >= 0 ? row.skin : "orange";
          html += '<div class="lb-row"><span class="lb-rank">' + (i + 1) + '</span>' +
            '<img class="lb-avatar" alt="" src="' + window.CatArt.avatarDataUrl(skinId) + '">' +
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
    drawDust();
    drawMice();
    drawCat();
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
    label.textContent = k.name;
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
    get skin() { return currentSkin; },
    selectSkin: selectSkin,
    setFacing: function (a) { cat.facing = a; },
    get catAnim() { return { mode: catAnim.mode, dir: catAnim.dir, gulp: !!gulp }; },
    get spriteStats() { return ANIM.stats(); },
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
