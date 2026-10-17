(function () {
  "use strict";

  // ---------------------------------------------------------------------
  // Setup & responsive canvas
  // ---------------------------------------------------------------------
  var canvas = document.getElementById("game");
  var ctx = canvas.getContext("2d");

  var W = 0, H = 0, DPR = 1, SCALE = 1;
  var REF_W = 400;

  // ---------------------------------------------------------------------
  // Safe storage (localStorage can throw in private/incognito mode or in
  // some embedded WebViews) -- fall back to an in-memory object so the
  // game still boots instead of dying on a top-level exception.
  // ---------------------------------------------------------------------
  var memStore = {};
  function storageGet(key, fallback) {
    try {
      var v = localStorage.getItem(key);
      return v === null ? fallback : v;
    } catch (e) {
      return Object.prototype.hasOwnProperty.call(memStore, key) ? memStore[key] : fallback;
    }
  }
  function storageSet(key, value) {
    try {
      localStorage.setItem(key, value);
    } catch (e) {
      memStore[key] = value;
    }
  }

  function resize() {
    var oldW = W;
    W = window.innerWidth;
    H = window.innerHeight;
    DPR = window.devicePixelRatio || 1;
    canvas.width = Math.round(W * DPR);
    canvas.height = Math.round(H * DPR);
    canvas.style.width = W + "px";
    canvas.style.height = H + "px";
    ctx.setTransform(DPR, 0, 0, DPR, 0, 0);
    SCALE = Math.min(2.0, Math.max(0.75, W / REF_W));

    // Orientation change / browser-chrome resize: keep existing world
    // objects inside the new width instead of letting them end up
    // off-screen or unreachable.
    if (oldW > 0 && W !== oldW) {
      var ratio = W / oldW;
      if (platforms) {
        for (var i = 0; i < platforms.length; i++) {
          var p = platforms[i];
          p.x *= ratio;
          if (p.w > W) p.w = W;
          if (p.x + p.w > W) p.x = W - p.w;
          if (p.x < 0) p.x = 0;
        }
      }
      if (fishes) {
        for (var j = 0; j < fishes.length; j++) {
          fishes[j].x = Math.min(W, Math.max(0, fishes[j].x * ratio));
        }
      }
      if (player) player.x = Math.min(W, Math.max(0, player.x * ratio));
    } else if (player) {
      player.x = Math.min(player.x, W);
    }
  }

  // ---------------------------------------------------------------------
  // Audio (WebAudio synth, no external assets)
  // ---------------------------------------------------------------------
  var audioCtx = null;
  var masterGain = null;
  var muted = storageGet("catjump_muted", "0") === "1";

  function ensureAudio() {
    if (audioCtx) return;
    var AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return;
    audioCtx = new AC();
    masterGain = audioCtx.createGain();
    masterGain.gain.value = muted ? 0 : 0.35;
    masterGain.connect(audioCtx.destination);
  }

  function tone(freq, duration, type, opts) {
    if (!audioCtx || muted) return;
    opts = opts || {};
    var t0 = audioCtx.currentTime;
    var osc = audioCtx.createOscillator();
    var gain = audioCtx.createGain();
    osc.type = type || "sine";
    osc.frequency.setValueAtTime(freq, t0);
    if (opts.slideTo) {
      osc.frequency.exponentialRampToValueAtTime(Math.max(20, opts.slideTo), t0 + duration);
    }
    var peak = opts.volume != null ? opts.volume : 0.3;
    gain.gain.setValueAtTime(0.0001, t0);
    gain.gain.exponentialRampToValueAtTime(peak, t0 + 0.015);
    gain.gain.exponentialRampToValueAtTime(0.0001, t0 + duration);
    osc.connect(gain);
    gain.connect(masterGain);
    osc.start(t0);
    osc.stop(t0 + duration + 0.02);
  }

  function noiseBurst(duration, volume) {
    if (!audioCtx || muted) return;
    var t0 = audioCtx.currentTime;
    var len = Math.floor(audioCtx.sampleRate * duration);
    var buffer = audioCtx.createBuffer(1, len, audioCtx.sampleRate);
    var data = buffer.getChannelData(0);
    for (var i = 0; i < len; i++) {
      data[i] = (Math.random() * 2 - 1) * (1 - i / len);
    }
    var src = audioCtx.createBufferSource();
    src.buffer = buffer;
    var gain = audioCtx.createGain();
    gain.gain.setValueAtTime(volume || 0.25, t0);
    gain.gain.exponentialRampToValueAtTime(0.0001, t0 + duration);
    src.connect(gain);
    gain.connect(masterGain);
    src.start(t0);
  }

  var sfx = {
    jump: function () { tone(320, 0.12, "triangle", { slideTo: 220, volume: 0.25 }); },
    spring: function () { tone(200, 0.28, "sawtooth", { slideTo: 700, volume: 0.22 }); },
    fish: function () {
      tone(880, 0.1, "sine", { volume: 0.22 });
      setTimeout(function () { tone(1320, 0.12, "sine", { volume: 0.2 }); }, 70);
    },
    crack: function () { noiseBurst(0.18, 0.2); },
    gameover: function () { tone(420, 0.5, "sawtooth", { slideTo: 120, volume: 0.22 }); },
    click: function () { tone(520, 0.06, "square", { volume: 0.12 }); }
  };

  function setMuted(v) {
    muted = v;
    storageSet("catjump_muted", muted ? "1" : "0");
    if (masterGain) masterGain.gain.value = muted ? 0 : 0.35;
    muteBtn.textContent = muted ? "🔇" : "🔊";
  }

  // ---------------------------------------------------------------------
  // Game constants (scaled by SCALE for device independence)
  // ---------------------------------------------------------------------
  function s(v) { return v * SCALE; }

  var GRAVITY = 2000;
  var BOUNCE_V = 780;
  var SPRING_V = 1300;
  var BREAK_BOUNCE_V = 620;
  var MOVE_SPEED = 480;
  var CAT_W = 34, CAT_H = 30;
  var PLAT_W = 70, PLAT_H = 16;
  var SPRING_W = 16; // visual width, also used to size the spring's hit zone
  var SPRING_HIT_PAD = 14; // extra horizontal tolerance beyond the spring's own width

  // ---------------------------------------------------------------------
  // Game state
  // ---------------------------------------------------------------------
  var STATE_START = "start", STATE_PLAY = "play", STATE_OVER = "over";
  var state = STATE_START;

  var player, platforms, fishes, clouds;
  var cameraY, score, fishBonus, best;
  var topGenY; // highest (smallest) y generated so far
  var startPlayerY;
  var shakeT = 0;

  var moveDir = 0; // -1, 0, 1 from keyboard/pointer half-press
  var activePointerId = null;

  best = parseInt(storageGet("catjump_best", "0"), 10) || 0;

  var scoreEl = document.getElementById("score");
  var bestStartEl = document.getElementById("bestScoreStart");
  var bestEndEl = document.getElementById("bestScoreEnd");
  var finalScoreEl = document.getElementById("finalScore");
  var startScreen = document.getElementById("startScreen");
  var gameOverScreen = document.getElementById("gameOverScreen");
  var startBtn = document.getElementById("startBtn");
  var restartBtn = document.getElementById("restartBtn");
  var muteBtn = document.getElementById("muteBtn");

  bestStartEl.textContent = best;
  muteBtn.textContent = muted ? "🔇" : "🔊";
  scoreEl.classList.add("hidden"); // no score to show until play starts

  function resetGame() {
    player = {
      x: W / 2,
      y: H * 0.7,
      vx: 0,
      vy: -BOUNCE_V * SCALE,
      facing: 1,
      squash: 0
    };
    startPlayerY = player.y;
    cameraY = 0;
    score = 0;
    fishBonus = 0;
    platforms = [];
    fishes = [];
    clouds = [];

    // starting platform directly under the cat
    var startPlat = {
      x: W / 2 - s(PLAT_W) * 0.8,
      y: H * 0.82,
      w: s(PLAT_W) * 1.6,
      h: s(PLAT_H),
      type: "normal",
      vx: 0,
      spring: false,
      broken: false,
      breakT: 0
    };
    platforms.push(startPlat);
    topGenY = startPlat.y;

    for (var i = 0; i < 14; i++) generateNextPlatform();
    for (var c = 0; c < 6; c++) {
      clouds.push({
        x: Math.random() * W,
        y: -Math.random() * H * 4,
        r: s(26 + Math.random() * 24),
        speed: s(6 + Math.random() * 10)
      });
    }
  }

  function difficultyAt(climbed) {
    return Math.min(1, Math.max(0, climbed / s(5200)));
  }

  function lerp(a, b, t) { return a + (b - a) * t; }

  // -----------------------------------------------------------------------
  // Invariant: the "main chain" (the sequence that advances topGenY) is
  // built ONLY from solid platforms (normal/move), with each consecutive
  // gap <= maxJump*0.86 where maxJump is the height reachable with the
  // guaranteed normal bounce (BOUNCE_V). This means the climb is always
  // possible using nothing but the main chain, regardless of what happens
  // with any breakable platform.
  //
  // Breakable platforms are never part of the main chain -- they are
  // generated as an extra, optional platform placed below the *next*
  // main-chain platform, close enough that even the weaker break-bounce
  // (BREAK_BOUNCE_V) can still reach that next platform. So landing on a
  // breakable is always a safe (if risky-looking) option, never a trap,
  // and since each gap gets at most one, two breakables never chain back
  // to back.
  // -----------------------------------------------------------------------
  function generateNextPlatform() {
    var climbed = Math.max(0, startPlayerY - topGenY);
    var t = difficultyAt(climbed);

    var maxJump = (BOUNCE_V * SCALE) * (BOUNCE_V * SCALE) / (2 * GRAVITY * SCALE);
    var minGap = lerp(s(55), s(78), t);
    var maxGap = Math.min(lerp(s(95), s(132), t), maxJump * 0.86);
    var gap = minGap + Math.random() * (maxGap - minGap);

    var yPrev = topGenY;
    var y = yPrev - gap;
    var w = s(PLAT_W) * lerp(1.0, 0.8, t);
    var x = Math.random() * (W - w);

    var pMove = lerp(0.1, 0.3, t);
    var type = Math.random() < pMove ? "move" : "normal";

    var plat = {
      x: x, y: y, w: w, h: s(PLAT_H),
      type: type,
      vx: type === "move" ? (Math.random() < 0.5 ? -1 : 1) * lerp(s(40), s(115), t) : 0,
      spring: Math.random() < 0.16,
      broken: false,
      breakT: 0
    };
    platforms.push(plat);

    if (Math.random() < 0.16) {
      fishes.push({
        x: Math.min(W - s(18), Math.max(s(18), x + w / 2 + (Math.random() * 2 - 1) * s(40))),
        y: y - s(40) - Math.random() * s(20),
        taken: false,
        bob: Math.random() * Math.PI * 2
      });
    }

    var pBreak = lerp(0.05, 0.22, t);
    if (Math.random() < pBreak) {
      var breakMaxJump = (BREAK_BOUNCE_V * SCALE) * (BREAK_BOUNCE_V * SCALE) / (2 * GRAVITY * SCALE);
      var maxOffset = Math.min(breakMaxJump * 0.8, gap * 0.7);
      var minOffset = Math.min(s(20), maxOffset);
      var offset = minOffset + Math.random() * Math.max(0, maxOffset - minOffset);
      var bw = w * 0.85;
      var bx = Math.random() * (W - bw);
      platforms.push({
        x: bx, y: y + offset, w: bw, h: s(PLAT_H),
        type: "break", vx: 0, spring: false, broken: false, breakT: 0
      });
    }

    topGenY = y;
  }

  // ---------------------------------------------------------------------
  // Input
  // ---------------------------------------------------------------------
  function setDirFromX(px) {
    moveDir = px < W / 2 ? -1 : 1;
  }

  canvas.addEventListener("pointerdown", function (e) {
    ensureAudio();
    if (audioCtx && audioCtx.state === "suspended") audioCtx.resume();
    activePointerId = e.pointerId;
    setDirFromX(e.clientX);
  });
  canvas.addEventListener("pointermove", function (e) {
    if (e.pointerId !== activePointerId) return;
    setDirFromX(e.clientX);
  });
  function releasePointer(e) {
    if (e.pointerId !== activePointerId) return;
    activePointerId = null;
    moveDir = 0;
  }
  canvas.addEventListener("pointerup", releasePointer);
  canvas.addEventListener("pointercancel", releasePointer);
  canvas.addEventListener("pointerleave", releasePointer);

  var keyLeft = false, keyRight = false;
  window.addEventListener("keydown", function (e) {
    if (e.code === "ArrowLeft" || e.code === "KeyA") { keyLeft = true; }
    if (e.code === "ArrowRight" || e.code === "KeyD") { keyRight = true; }
    syncKeyDir();
  });
  window.addEventListener("keyup", function (e) {
    if (e.code === "ArrowLeft" || e.code === "KeyA") { keyLeft = false; }
    if (e.code === "ArrowRight" || e.code === "KeyD") { keyRight = false; }
    syncKeyDir();
  });
  function syncKeyDir() {
    if (activePointerId !== null) return;
    if (keyLeft && !keyRight) moveDir = -1;
    else if (keyRight && !keyLeft) moveDir = 1;
    else moveDir = 0;
  }

  document.addEventListener("contextmenu", function (e) { e.preventDefault(); });
  document.addEventListener("touchmove", function (e) { e.preventDefault(); }, { passive: false });
  document.addEventListener("gesturestart", function (e) { e.preventDefault(); });

  // ---------------------------------------------------------------------
  // UI wiring
  // ---------------------------------------------------------------------
  function overlapRangesX(ax, aw, bx, bw) {
    var shifts = [0, -W, W];
    for (var i = 0; i < shifts.length; i++) {
      var a0 = ax + shifts[i];
      if (a0 + aw > bx && a0 < bx + bw) return true;
    }
    return false;
  }

  function startGame() {
    ensureAudio();
    if (audioCtx && audioCtx.state === "suspended") audioCtx.resume();
    resetGame();
    state = STATE_PLAY;
    startScreen.classList.add("hidden");
    gameOverScreen.classList.add("hidden");
    scoreEl.classList.remove("hidden");
  }

  function endGame() {
    state = STATE_OVER;
    sfx.gameover();
    var total = score;
    if (total > best) {
      best = total;
      storageSet("catjump_best", String(best));
    }
    finalScoreEl.textContent = total;
    bestEndEl.textContent = best;
    gameOverScreen.classList.remove("hidden");
  }

  startBtn.addEventListener("click", function () { sfx.click(); startGame(); });
  restartBtn.addEventListener("click", function () { sfx.click(); startGame(); });
  muteBtn.addEventListener("click", function () {
    ensureAudio();
    setMuted(!muted);
  });

  window.addEventListener("resize", resize);
  window.addEventListener("orientationchange", resize);
  document.addEventListener("visibilitychange", function () {
    if (document.hidden) moveDir = 0;
  });

  // ---------------------------------------------------------------------
  // Update
  // ---------------------------------------------------------------------
  function update(dt) {
    if (state !== STATE_PLAY) return;

    // horizontal movement with smoothing
    var targetVx = moveDir * s(MOVE_SPEED);
    var smoothing = 1 - Math.exp(-dt * 14);
    player.vx += (targetVx - player.vx) * smoothing;
    player.x += player.vx * dt;
    if (player.x < 0) player.x += W;
    if (player.x > W) player.x -= W;
    if (player.vx > 2) player.facing = 1;
    else if (player.vx < -2) player.facing = -1;

    // vertical physics
    var prevFootY = player.y + s(CAT_H) / 2;
    player.vy += GRAVITY * SCALE * dt;
    player.y += player.vy * dt;
    var footY = player.y + s(CAT_H) / 2;

    // platform collision (only when falling, only land on top)
    if (player.vy > 0) {
      for (var i = 0; i < platforms.length; i++) {
        var p = platforms[i];
        if (p.broken) continue;
        if (prevFootY > p.y + 2) continue; // already below/through platform top last frame
        if (footY < p.y) continue;
        if (footY > p.y + p.h + Math.max(24, player.vy * dt)) continue;
        var halfW = s(CAT_W) / 2 * 0.7;
        if (!overlapRangesX(player.x - halfW, halfW * 2, p.x, p.w)) continue;

        // landed
        player.y = p.y - s(CAT_H) / 2;
        player.squash = 1;
        if (p.type === "break") {
          player.vy = -BREAK_BOUNCE_V * SCALE;
          p.broken = true;
          p.breakT = 0;
          sfx.crack();
        } else {
          // Spring only triggers the big bounce if the cat's feet actually
          // land near the spring icon, not anywhere on the platform.
          var springHalfRange = s(SPRING_W) / 2 + s(SPRING_HIT_PAD);
          var springX = p.x + p.w / 2;
          if (p.spring && Math.abs(player.x - springX) <= springHalfRange) {
            player.vy = -SPRING_V * SCALE;
            sfx.spring();
          } else {
            player.vy = -BOUNCE_V * SCALE;
            sfx.jump();
          }
        }
        break;
      }
    }

    // moving platforms
    for (var j = 0; j < platforms.length; j++) {
      var mp = platforms[j];
      if (mp.type === "move" && !mp.broken) {
        mp.x += mp.vx * dt;
        if (mp.x < 0) { mp.x = 0; mp.vx *= -1; }
        if (mp.x + mp.w > W) { mp.x = W - mp.w; mp.vx *= -1; }
      }
      if (mp.broken) mp.breakT += dt;
    }
    platforms = platforms.filter(function (p) { return p.breakT < 0.4; });

    if (player.squash > 0) player.squash = Math.max(0, player.squash - dt * 4);

    // camera: only ever scrolls upward (never back down)
    var pinY = H * 0.42;
    var desiredCam = player.y - pinY;
    if (player.vy < 0 && desiredCam < cameraY) cameraY = desiredCam;

    // ensure platforms ahead exist
    while (topGenY > cameraY - H * 1.3) generateNextPlatform();
    // cull off-screen platforms/fish below view
    platforms = platforms.filter(function (p) { return (p.y - cameraY) < H + s(160); });
    fishes = fishes.filter(function (f) { return !f.taken && (f.y - cameraY) < H + s(160); });

    // fish collection
    var halfCat = s(CAT_W) / 2 * 0.9;
    for (var k = 0; k < fishes.length; k++) {
      var f = fishes[k];
      if (f.taken) continue;
      f.bob += dt * 4;
      var dx = Math.abs(f.x - player.x);
      var dy = Math.abs(f.y - player.y);
      if (dx < halfCat + s(12) && dy < halfCat + s(12)) {
        f.taken = true;
        fishBonus += 5;
        sfx.fish();
      }
    }

    // clouds (decorative, parallax)
    for (var c = 0; c < clouds.length; c++) {
      var cl = clouds[c];
      cl.x += cl.speed * dt * 0.2;
      if (cl.x > W + cl.r) cl.x = -cl.r;
      if ((cl.y - cameraY * 0.6) > H + cl.r) {
        cl.y = cameraY - H * (1 + Math.random() * 3);
        cl.x = Math.random() * W;
      }
    }

    var climbed = Math.max(0, -cameraY);
    score = Math.floor(climbed / s(10)) + fishBonus;
    scoreEl.textContent = score;

    // game over: fell below bottom of screen
    var screenY = player.y - cameraY;
    if (screenY - s(CAT_H) > H) {
      endGame();
    }
  }

  // ---------------------------------------------------------------------
  // Draw
  // ---------------------------------------------------------------------
  function skyColor(climbed) {
    var t = Math.min(1, climbed / s(9000));
    var top = lerpColor([135, 206, 250], [30, 30, 80], t);
    var bot = lerpColor([255, 236, 196], [90, 50, 120], t);
    return [top, bot];
  }
  function lerpColor(a, b, t) {
    return [
      Math.round(lerp(a[0], b[0], t)),
      Math.round(lerp(a[1], b[1], t)),
      Math.round(lerp(a[2], b[2], t))
    ];
  }
  function rgb(c) { return "rgb(" + c[0] + "," + c[1] + "," + c[2] + ")"; }

  function drawBackground() {
    var climbed = Math.max(0, -cameraY);
    var colors = skyColor(climbed);
    var g = ctx.createLinearGradient(0, 0, 0, H);
    g.addColorStop(0, rgb(colors[0]));
    g.addColorStop(1, rgb(colors[1]));
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, W, H);

    ctx.save();
    ctx.globalAlpha = 0.85;
    for (var i = 0; i < clouds.length; i++) {
      var c = clouds[i];
      var sy = c.y - cameraY * 0.6;
      drawCloud(c.x, sy, c.r);
    }
    ctx.restore();
  }

  function drawCloud(x, y, r) {
    ctx.fillStyle = "rgba(255,255,255,0.85)";
    ctx.beginPath();
    ctx.arc(x, y, r * 0.6, 0, Math.PI * 2);
    ctx.arc(x + r * 0.55, y + r * 0.1, r * 0.45, 0, Math.PI * 2);
    ctx.arc(x - r * 0.55, y + r * 0.12, r * 0.42, 0, Math.PI * 2);
    ctx.fill();
  }

  function drawPlatform(p) {
    var sy = p.y - cameraY;
    if (sy < -s(40) || sy > H + s(40)) return;
    var alpha = 1;
    if (p.broken) alpha = Math.max(0, 1 - p.breakT / 0.4);
    var dy = p.broken ? p.breakT * s(260) : 0;

    ctx.save();
    ctx.globalAlpha = alpha;
    ctx.translate(0, dy);

    var colorMain, colorDark;
    if (p.type === "break") { colorMain = "#f7b6c2"; colorDark = "#e08596"; }
    else if (p.type === "move") { colorMain = "#8fd3ff"; colorDark = "#4fa9e8"; }
    else { colorMain = "#b6e38a"; colorDark = "#7fbf52"; }

    roundRect(p.x, sy, p.w, p.h, p.h / 2, colorMain, colorDark);

    if (p.type === "break") {
      ctx.strokeStyle = "rgba(180,60,90,0.5)";
      ctx.lineWidth = Math.max(1, s(1.2));
      ctx.beginPath();
      ctx.moveTo(p.x + p.w * 0.3, sy + 1);
      ctx.lineTo(p.x + p.w * 0.42, sy + p.h - 2);
      ctx.moveTo(p.x + p.w * 0.65, sy + 2);
      ctx.lineTo(p.x + p.w * 0.55, sy + p.h - 1);
      ctx.stroke();
    }

    if (p.spring) {
      drawSpring(p.x + p.w / 2, sy);
    }

    ctx.restore();
  }

  function roundRect(x, y, w, h, r, fill, darkFill) {
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.arcTo(x + w, y, x + w, y + h, r);
    ctx.arcTo(x + w, y + h, x, y + h, r);
    ctx.arcTo(x, y + h, x, y, r);
    ctx.arcTo(x, y, x + w, y, r);
    ctx.closePath();
    ctx.fillStyle = darkFill;
    ctx.fill();
    ctx.save();
    ctx.translate(0, -h * 0.22);
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.arcTo(x + w, y, x + w, y + h, r);
    ctx.arcTo(x + w, y + h, x, y + h, r);
    ctx.arcTo(x, y + h, x, y, r);
    ctx.arcTo(x, y, x + w, y, r);
    ctx.closePath();
    ctx.fillStyle = fill;
    ctx.fill();
    ctx.restore();
  }

  function drawSpring(cx, topY) {
    var w = s(SPRING_W), h = s(20);
    ctx.strokeStyle = "#e8b400";
    ctx.lineWidth = s(3);
    ctx.lineCap = "round";
    ctx.beginPath();
    var n = 3;
    for (var i = 0; i <= n; i++) {
      var yy = topY - (h * i) / n;
      var xx = cx + (i % 2 === 0 ? -w / 2 : w / 2);
      if (i === 0) ctx.moveTo(cx, topY);
      ctx.lineTo(xx, yy);
    }
    ctx.stroke();
  }

  function drawFish(f) {
    var sy = f.y - cameraY + Math.sin(f.bob) * s(4);
    if (sy < -s(30) || sy > H + s(30)) return;
    ctx.save();
    ctx.translate(f.x, sy);
    ctx.fillStyle = "#ffcf6b";
    ctx.strokeStyle = "#e8912e";
    ctx.lineWidth = s(1.5);
    ctx.beginPath();
    ctx.ellipse(0, 0, s(11), s(6), 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(s(9), 0);
    ctx.lineTo(s(16), -s(5));
    ctx.lineTo(s(16), s(5));
    ctx.closePath();
    ctx.fill();
    ctx.stroke();
    ctx.fillStyle = "#6b3f12";
    ctx.beginPath();
    ctx.arc(-s(5), -s(1), s(1.3), 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
  }

  function drawCat() {
    var sy = player.y - cameraY;
    var w = s(CAT_W), h = s(CAT_H);
    var squashY = 1 - player.squash * 0.28;
    var squashX = 1 + player.squash * 0.22;

    ctx.save();
    ctx.translate(player.x, sy + h / 2);
    ctx.scale(player.facing * squashX, squashY);

    // tail
    ctx.strokeStyle = "#f7a65c";
    ctx.lineWidth = s(5);
    ctx.lineCap = "round";
    ctx.beginPath();
    ctx.moveTo(-w * 0.4, h * 0.1);
    ctx.quadraticCurveTo(-w * 0.9, h * 0.3, -w * 0.7, -h * 0.35);
    ctx.stroke();

    // body
    ctx.fillStyle = "#ffb26b";
    ctx.beginPath();
    ctx.ellipse(0, h * 0.08, w * 0.46, h * 0.42, 0, 0, Math.PI * 2);
    ctx.fill();

    // ears
    ctx.beginPath();
    ctx.moveTo(-w * 0.34, -h * 0.28);
    ctx.lineTo(-w * 0.46, -h * 0.62);
    ctx.lineTo(-w * 0.14, -h * 0.4);
    ctx.closePath();
    ctx.fill();
    ctx.beginPath();
    ctx.moveTo(w * 0.34, -h * 0.28);
    ctx.lineTo(w * 0.46, -h * 0.62);
    ctx.lineTo(w * 0.14, -h * 0.4);
    ctx.closePath();
    ctx.fill();

    ctx.fillStyle = "#ff8fb0";
    ctx.beginPath();
    ctx.moveTo(-w * 0.3, -h * 0.32);
    ctx.lineTo(-w * 0.36, -h * 0.5);
    ctx.lineTo(-w * 0.18, -h * 0.38);
    ctx.closePath();
    ctx.fill();
    ctx.beginPath();
    ctx.moveTo(w * 0.3, -h * 0.32);
    ctx.lineTo(w * 0.36, -h * 0.5);
    ctx.lineTo(w * 0.18, -h * 0.38);
    ctx.closePath();
    ctx.fill();

    // face
    ctx.fillStyle = "#2b2b2b";
    ctx.beginPath();
    ctx.arc(-w * 0.15, -h * 0.02, w * 0.055, 0, Math.PI * 2);
    ctx.fill();
    ctx.beginPath();
    ctx.arc(w * 0.15, -h * 0.02, w * 0.055, 0, Math.PI * 2);
    ctx.fill();

    ctx.fillStyle = "#ff7a8a";
    ctx.beginPath();
    ctx.moveTo(-w * 0.04, h * 0.08);
    ctx.lineTo(w * 0.04, h * 0.08);
    ctx.lineTo(0, h * 0.14);
    ctx.closePath();
    ctx.fill();

    ctx.strokeStyle = "#8a5a33";
    ctx.lineWidth = s(1.2);
    ctx.beginPath();
    ctx.moveTo(-w * 0.5, h * 0.05); ctx.lineTo(-w * 0.78, h * 0.0);
    ctx.moveTo(-w * 0.5, h * 0.12); ctx.lineTo(-w * 0.78, h * 0.16);
    ctx.moveTo(w * 0.5, h * 0.05); ctx.lineTo(w * 0.78, h * 0.0);
    ctx.moveTo(w * 0.5, h * 0.12); ctx.lineTo(w * 0.78, h * 0.16);
    ctx.stroke();

    // paws
    ctx.fillStyle = "#ffb26b";
    ctx.beginPath();
    ctx.ellipse(-w * 0.22, h * 0.42, w * 0.14, h * 0.13, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.beginPath();
    ctx.ellipse(w * 0.22, h * 0.42, w * 0.14, h * 0.13, 0, 0, Math.PI * 2);
    ctx.fill();

    ctx.restore();
  }

  function draw() {
    drawBackground();
    if (state === STATE_PLAY || state === STATE_OVER) {
      for (var i = 0; i < platforms.length; i++) drawPlatform(platforms[i]);
      for (var j = 0; j < fishes.length; j++) if (!fishes[j].taken) drawFish(fishes[j]);
      drawCat();
    }
  }

  // ---------------------------------------------------------------------
  // Main loop
  // ---------------------------------------------------------------------
  var lastT = null;
  function loop(now) {
    if (lastT == null) lastT = now;
    var dt = (now - lastT) / 1000;
    lastT = now;
    if (dt > 1 / 30) dt = 1 / 30;

    update(dt);
    draw();

    requestAnimationFrame(loop);
  }

  resize();
  // draw an idle background behind the start screen
  (function initIdleScene() {
    cameraY = 0;
    clouds = [];
    platforms = [];
    fishes = [];
    for (var c = 0; c < 6; c++) {
      clouds.push({
        x: Math.random() * W,
        y: Math.random() * H,
        r: s(26 + Math.random() * 24),
        speed: s(6 + Math.random() * 10)
      });
    }
    player = { x: W / 2, y: H * 2, vx: 0, vy: 0, facing: 1, squash: 0 };
  })();
  requestAnimationFrame(loop);
})();
