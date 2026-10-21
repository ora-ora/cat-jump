// 小猫抓老鼠 · 实时生成音频（WebAudio，无任何音频文件）
// - BGM：带种子的生成式音乐，和弦按马尔可夫表走、旋律随机游走 + 动机变奏，不会循环重复；
//   层次 0–3（等级/连击/大招），只在小节线切换；音效触发时自动压低（ducking）；暂停时闷音。
// - 音效：全部实时合成；同时发声上限 24，吱吱声每秒最多 6 次，同名音效 40ms 内不重复。
(function () {
  "use strict";
  function lsGet(k, d) { try { var v = localStorage.getItem(k); return v == null ? d : v; } catch (e) { return d; } }
  function lsSet(k, v) { try { localStorage.setItem(k, v); } catch (e) { /* ignore */ } }
  var S = {
    master: lsGet("catmouse_muted", "0") !== "1",
    bgmOn: lsGet("catmouse_bgm_on", "1") === "1", sfxOn: lsGet("catmouse_sfx_on", "1") === "1",
    bgmVol: +lsGet("catmouse_bgm_vol", "50"), sfxVol: +lsGet("catmouse_sfx_vol", "80")
  };
  var ctx = null, out = null, bgmBus = null, bgmFilter = null, duckG = null, sfxBus = null, noiseBuf = null;
  var stats = { created: 0, ended: 0, dropped: 0, active: 0, bgmActive: 0 };
  var VOICE_CAP = 24, PRI = { evolve: 5, catch: 4, skill: 3, ui: 3, panic: 2, squeak: 1 };
  var lastByName = {}, squeakTimes = [];

  function now() { return ctx ? ctx.currentTime : 0; }
  function applyVolumes() {
    if (!ctx) return;
    var t = now();
    out.gain.setTargetAtTime(S.master ? 0.9 : 0, t, 0.02);
    bgmBus.gain.setTargetAtTime(S.bgmOn ? 0.5 * S.bgmVol / 100 : 0, t, 0.05);
    sfxBus.gain.setTargetAtTime(S.sfxOn ? 0.9 * S.sfxVol / 100 : 0, t, 0.02);
  }
  function unlock() {
    if (!ctx) {
      try {
        var AC = window.AudioContext || window.webkitAudioContext; if (!AC) return;
        ctx = new AC();
        var comp = ctx.createDynamicsCompressor(); comp.connect(ctx.destination);
        out = ctx.createGain(); out.connect(comp);
        bgmFilter = ctx.createBiquadFilter(); bgmFilter.type = "lowpass"; bgmFilter.frequency.value = 18000; bgmFilter.connect(out);
        duckG = ctx.createGain(); duckG.connect(bgmFilter);
        bgmBus = ctx.createGain(); bgmBus.connect(duckG);
        sfxBus = ctx.createGain(); sfxBus.connect(out);
        noiseBuf = ctx.createBuffer(1, ctx.sampleRate, ctx.sampleRate);
        var d = noiseBuf.getChannelData(0); for (var i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
        // iOS：在用户手势里播放 1 帧静音缓冲完成解锁
        var sb = ctx.createBufferSource(); sb.buffer = ctx.createBuffer(1, 1, 22050); sb.connect(ctx.destination); sb.start(0);
        applyVolumes();
      } catch (e) { ctx = null; return; }
    }
    if (ctx.state === "suspended" && !hiddenNow) ctx.resume();
    if (!bgm.timer) bgm.start();
  }

  // ---- 声部（voice）：每个音效 = 1 组节点；结束时计数，超上限丢低优先级 ----
  function canPlay(name, pri, gap) {
    if (!ctx || ctx.state !== "running" || !S.master || !S.sfxOn) return false;
    var t = now();
    if (lastByName[name] != null && t - lastByName[name] < (gap || 0.04)) return false;
    if (stats.active >= VOICE_CAP && pri < 4) { stats.dropped++; return false; }
    if (stats.active >= VOICE_CAP + 8) { stats.dropped++; return false; }
    lastByName[name] = t; return true;
  }
  // 计数：BGM 声部单独计，不占音效的 24 声部上限
  function track(node, stopAt, isBgm) { stats.created++; if (isBgm) stats.bgmActive++; else stats.active++; node.onended = function () { stats.ended++; if (isBgm) stats.bgmActive--; else stats.active--; node.onended = null; }; node.stop(stopAt); }
  function tone(bus, t, f, dur, type, vol, f2, att) {
    var o = ctx.createOscillator(), g = ctx.createGain(); o.type = type || "sine";
    o.frequency.setValueAtTime(f, t); if (f2) o.frequency.exponentialRampToValueAtTime(f2, t + dur);
    g.gain.setValueAtTime(0.0001, t); g.gain.exponentialRampToValueAtTime(vol || 0.2, t + (att || 0.006)); g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    o.connect(g); g.connect(bus); o.start(t); track(o, t + dur + 0.03, bus === bgmBus);
  }
  function noise(bus, t, dur, vol, freq, type) {
    var s = ctx.createBufferSource(), f = ctx.createBiquadFilter(), g = ctx.createGain(); s.buffer = noiseBuf;
    s.loopStart = 0; s.loop = dur > 0.9;
    f.type = type || "highpass"; f.frequency.value = freq || 6000;
    g.gain.setValueAtTime(0.0001, t); g.gain.exponentialRampToValueAtTime(vol || 0.1, t + 0.004); g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    s.connect(f); f.connect(g); g.connect(bus); s.start(t, Math.random() * 0.5); track(s, t + dur + 0.03, bus === bgmBus);
  }
  function duck(db, hold) {
    if (!ctx) return; var t = now(), k = Math.pow(10, -db / 20);
    duckG.gain.cancelScheduledValues(t); duckG.gain.setValueAtTime(duckG.gain.value, t);
    duckG.gain.linearRampToValueAtTime(k, t + 0.02); duckG.gain.setValueAtTime(k, t + 0.02 + hold); duckG.gain.linearRampToValueAtTime(1, t + 0.27 + hold);
  }
  var N = function (m) { return 440 * Math.pow(2, (m - 69) / 12); };

  // ---- 生成式 BGM ----
  function rng(seed) { return function () { seed |= 0; seed = seed + 0x6D2B79F5 | 0; var t = Math.imul(seed ^ seed >>> 15, 1 | seed); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; }; }
  var SCALE_MAJ = [0, 2, 4, 5, 7, 9, 11], SCALE_MIN = [0, 2, 3, 5, 7, 8, 10], SCALE = SCALE_MAJ; // 夜晚换小调
  // 和弦级数（0=I … 5=vi）马尔可夫转移表
  var NEXT = { 0: [3, 4, 5, 1, 3, 4], 1: [4, 4, 3, 6 % 6], 2: [5, 3, 5], 3: [4, 0, 1, 4, 0], 4: [0, 5, 0, 3, 2], 5: [3, 1, 4, 3] };
  var KEYS = [60, 62, 65, 67, 57];
  var bgm = {
    timer: null, seed: (Date.now() & 0xffff) || 7, r: null, tempo: 124, nextT: 0, step: 0, bar: 0,
    level: 0, want: 0, key: 60, deg: 0, motif: null, mel: 72, phrase: 0, paused: false,
    start: function () {
      this.r = rng(this.seed); this.nextT = now() + 0.1; this.step = 0; this.bar = 0; this.newMotif();
      var self = this; this.timer = setInterval(function () { self.tick(); }, 50);
    },
    newMotif: function () { var m = []; for (var i = 0; i < 8; i++) m.push(this.r() < 0.22 ? -1 : Math.floor(this.r() * 5) - 2); this.motif = m; },
    chordNotes: function () { var root = this.key + SCALE[this.deg]; return [0, 2, 4].map(function (k, i) { var d = (this.deg + k) % 7; var n = this.key + SCALE[d] + (this.deg + k >= 7 ? 12 : 0); return n; }, this); },
    tick: function () {
      if (!ctx || this.paused) return;
      var spb = 60 / this.tempo, st = spb / 2;
      if (this.nextT < now() - 0.5) this.nextT = now() + 0.05; // 长时间挂起后重新对齐
      while (this.nextT < now() + 0.2) { this.play(this.nextT, st); this.nextT += st; this.step++; }
    },
    play: function (t, st) {
      var s8 = this.step % 8, r = this.r;
      if (s8 === 0) { // 小节线：切层次、换和弦、偶尔转调/换动机
        this.level = this.want;
        if (this.bar % 4 === 0) { this.phrase++; if (r() < 0.45) this.newMotif(); else this.motif = this.motif.map(function (x) { return x < 0 || r() < 0.7 ? x : x + (r() < 0.5 ? 1 : -1); }); if (this.phrase % 4 === 0 && r() < 0.5) this.key = KEYS[Math.floor(r() * KEYS.length)]; }
        var opts = NEXT[this.deg] || [0]; this.deg = this.bar % 8 === 0 ? 0 : opts[Math.floor(r() * opts.length)];
        SCALE = this.night ? SCALE_MIN : SCALE_MAJ; this.tempo = 120 + this.level * 4 - (this.night ? 10 : 0);
        this.bar++;
      }
      if (!S.master || !S.bgmOn) return;
      var ch = this.chordNotes(), L = this.level, B = bgmBus;
      if (s8 % 2 === 0) tone(B, t, N(ch[0] - 24 + (s8 % 4 ? 12 : 0)), st * 1.6, "triangle", 0.28); // 低音
      tone(B, t, N(ch[(s8 + (this.bar & 1)) % 3] + (s8 >= 4 ? 12 : 0)), st * 0.9, "sine", 0.1); // 木琴琶音
      if (L >= 1 && s8 % 2 === 0) tone(B, t, 70, 0.12, "sine", 0.4, 40);
      if (L >= 1 && s8 % 2 === 1) noise(B, t, 0.035, 0.05, 7000);
      if (L >= 2) { // 旋律：动机 + 随机游走，落在和弦音上
        var mv = this.motif[s8];
        if (mv !== -1 && mv != null) {
          var deg = Math.max(-3, Math.min(10, this.melDeg == null ? 7 : this.melDeg + mv)); this.melDeg = deg;
          if (s8 % 4 === 0) { var best = deg, bd = 99; for (var c = 0; c < 3; c++) for (var o = 0; o < 2; o++) { var cd = ((this.deg + c * 2) % 7) + o * 7; if (Math.abs(cd - deg) < bd) { bd = Math.abs(cd - deg); best = cd; } } deg = best; this.melDeg = deg; }
          var oct = Math.floor(deg / 7), n = this.key + 12 + SCALE[((deg % 7) + 7) % 7] + oct * 12;
          tone(B, t, N(n), st * (r() < 0.2 ? 1.8 : 0.85), "square", 0.045);
        }
      }
      if (L >= 3) { noise(B, t, 0.02, 0.03, 9000); noise(B, t + st / 2, 0.02, 0.025, 9000); }
    },
    stop: function () { if (this.timer) clearInterval(this.timer); this.timer = null; }
  };

  // ---- 音效 ----
  var SKILL = { // [出手, 命中] 的音色参数，按小猫区分
    orange: { f: 900, type: "triangle", f2: 1400 }, black: { f: 220, type: "square", f2: 440 }, white: { f: 300, type: "triangle", f2: 200, noise: 2000 },
    calico: { f: 300, type: "sawtooth", f2: 1200 }, blue: { f: 150, type: "sine", f2: 300, noise: 800, long: 1 }, siamese: { f: 784, type: "sine", f2: 0 }
  };
  var sfx = {
    catch: function (type, beh) {
      if (!canPlay("catch", 4, 0.03)) return; var t = now(), B = sfxBus; duck(6, 0.08);
      var low = beh === "sleepy" ? 0.5 : 1;
      if (type === "gold") { [1046, 1318, 1568, 2093].forEach(function (f, i) { tone(B, t + i * 0.05, f, 0.18, "triangle", 0.13); }); noise(B, t + 0.18, 0.25, 0.04, 8000); }
      else if (type === "brown") { tone(B, t, 660, 0.07, "square", 0.1, 990); tone(B, t + 0.05, 990, 0.07, "square", 0.09); tone(B, t + 0.1, 1320, 0.1, "sine", 0.1); }
      else { tone(B, t, 880 * low, 0.08, "square", 0.1, 1320 * low); tone(B, t + 0.06, 1320 * low, 0.1, "sine", 0.1); }
      if (beh === "thief") tone(B, t + 0.12, 2637, 0.12, "sine", 0.06);
      tone(B, t + 0.02, 300, 0.12, "sine", 0.22, 120); // 咕
    },
    combo: function (n) { if (!canPlay("combo", 3, n >= 10 ? 0.16 : 0.09)) return; /* 高连击时降低密度 */ var t = now(), f = 660 * Math.pow(2, Math.min(n, 12) / 12); var cv = n >= 10 ? 0.7 : 1; tone(sfxBus, t + 0.08, f, 0.09, "square", 0.06 * cv); tone(sfxBus, t + 0.12, f * 1.5, 0.1, "square", 0.05 * cv); },
    evolve: function () { if (!canPlay("evolve", 5, 0.5)) return; var t = now(); duck(12, 1); [60, 64, 67, 72, 76, 79, 84].forEach(function (m, i) { tone(sfxBus, t + i * 0.07, N(m), 0.3, "triangle", 0.12); }); noise(sfxBus, t + 0.45, 0.6, 0.05, 7000); tone(sfxBus, t + 0.5, N(84), 0.8, "sine", 0.09); },
    skill: function (skin, phase, stage) {
      var key = "sk_" + phase; if (!canPlay(key, phase === "fire" ? 3 : 2, phase === "hit" ? 0.08 : 0.05)) return;
      var p = SKILL[skin] || SKILL.orange, t = now(), B = sfxBus, thick = stage >= 3, tail = stage >= 5;
      if (phase === "windup") { tone(B, t, 400, 0.25, "sine", 0.06, 900, 0.05); if (thick) tone(B, t, 800, 0.25, "sine", 0.03, 1800, 0.05); return; }
      if (phase === "cancel") { tone(B, t, 500, 0.14, "sine", 0.04, 250); return; }
      if (phase === "fire") {
        duck(6, 0.08);
        if (skin === "siamese") { var ch = bgm.chordNotes(); ch.forEach(function (n, i) { if (i === 0 || thick) tone(B, t + i * 0.04, N(n + 12), 0.3, "sine", 0.1); }); }
        else tone(B, t, p.f, p.long ? 0.6 : 0.22, p.type, 0.09, p.f2 || undefined);
        if (p.noise) noise(B, t, p.long ? 0.6 : 0.22, 0.08, p.noise, p.long ? "bandpass" : "highpass");
        if (thick) tone(B, t, p.f * 2, 0.18, p.type, 0.04, (p.f2 || p.f) * 2);
        if (tail) tone(B, t + 0.15, p.f * 3, 0.5, "sine", 0.03);
        return;
      }
      // hit
      if (skin === "white") { noise(B, t, 0.1, 0.07, 4000); tone(B, t, 1600, 0.08, "sine", 0.05, 2400); }
      else if (skin === "black") { tone(B, t, 1200, 0.05, "square", 0.05); }
      else tone(B, t, 1000, 0.06, "triangle", 0.06, 700);
    },
    // 通用被动音效
    uni: function (kind, n) {
      if (!canPlay("uni_" + kind, kind === "corner" ? 1 : 2, kind === "corner" ? 0.25 : 0.06)) return;
      var t = now(), B = sfxBus;
      if (kind === "pounce") { noise(B, t, 0.12, 0.06, 2500, "bandpass"); tone(B, t, 300, 0.14, "triangle", 0.08, 700); }
      else if (kind === "chain") { var f = 600 * Math.pow(2, Math.min(n || 1, 5) * 2 / 12); tone(B, t, f, 0.1, "square", 0.05, f * 1.5); noise(B, t, 0.08, 0.04, 4000); }
      else if (kind === "land") { tone(B, t, 160, 0.1, "sine", 0.1, 80); noise(B, t, 0.12, 0.04, 800, "lowpass"); }
      else if (kind === "wave") { tone(B, t, 220, 0.3, "sine", 0.1, 60); noise(B, t, 0.25, 0.05, 1200, "lowpass"); }
      else if (kind === "dash") { noise(B, t, 0.35, 0.05, 3000, "bandpass"); tone(B, t, 500, 0.3, "sawtooth", 0.03, 1400, 0.05); }
      else if (kind === "corner") { tone(B, t, 1800, 0.06, "sine", 0.03, 1400); tone(B, t + 0.07, 1700, 0.06, "sine", 0.025, 1300); }
      else if (kind === "cancel") { tone(B, t, 500, 0.08, "sine", 0.03, 300); }
    },
    nest: function (kind) {
      if (!canPlay("nest_" + kind, kind === "poop" ? 4 : 1, kind === "strain" ? 0.3 : 0.2)) return;
      var t = now(), B = sfxBus;
      if (kind === "strain") tone(B, t, 180 + Math.random() * 40, 0.18, "triangle", 0.06, 150);
      else if (kind === "poop") { duck(8, 0.3); noise(B, t, 0.18, 0.08, 500, "lowpass"); tone(B, t, 260, 0.2, "sine", 0.14, 70); tone(B, t + 0.22, 880, 0.08, "sine", 0.06, 1320); tone(B, t + 0.3, 1320, 0.12, "sine", 0.05); }
      else if (kind === "burst") { noise(B, t, 0.15, 0.06, 2200, "bandpass"); for (var j = 0; j < 6; j++) tone(B, t + 0.03 + j * 0.035, 1800 + Math.random() * 1400, 0.05, "sine", 0.035, 3000); tone(B, t, 400, 0.12, "triangle", 0.06, 900); }
      else if (kind === "respawn") { for (var i = 0; i < 3; i++) tone(B, t + i * 0.08, 2400 + i * 300, 0.05, "sine", 0.035, 3000); }
    },
    squeak: function (near) { // near: 0..1，越远越轻
      if (!ctx) return; var t = now(); while (squeakTimes.length && t - squeakTimes[0] > 1) squeakTimes.shift();
      if (squeakTimes.length >= 4 || !canPlay("squeak", 1, 0.08)) return; squeakTimes.push(t);
      tone(sfxBus, t, 2200 + Math.random() * 1000, 0.05, "sine", 0.04 * (near == null ? 1 : 0.25 + 0.75 * near), 3200);
    },
    panic: function () { if (!canPlay("panic", 2, 0.3)) return; var t = now(); for (var i = 0; i < 6; i++) tone(sfxBus, t + i * 0.045 + Math.random() * 0.02, 2000 + Math.random() * 1500, 0.045, "sine", 0.03, 3200); },
    sparkle: function () { if (!canPlay("sparkle", 1, 1.5)) return; var t = now(); for (var i = 0; i < 4; i++) tone(sfxBus, t + i * 0.08, 3000 + i * 400, 0.1, "sine", 0.025); },
    taunt: function () { if (!canPlay("taunt", 1, 1.0)) return; var t = now(); for (var i = 0; i < 3; i++) tone(sfxBus, t + i * 0.09, 1500, 0.05, "square", 0.025, 1700); },
    click: function () { if (!canPlay("click", 3, 0.03)) return; tone(sfxBus, now(), 1200, 0.04, "square", 0.05); },
    panel: function (open) { if (!canPlay("panel", 3, 0.05)) return; var t = now(); if (open) { tone(sfxBus, t, 880, 0.1, "sine", 0.08, 660); tone(sfxBus, t + 0.08, 660, 0.14, "sine", 0.07, 440); } else { tone(sfxBus, t, 660, 0.1, "sine", 0.07, 880); } },
    endRun: function () { if (!canPlay("end", 4, 0.3)) return; tone(sfxBus, now(), 500, 0.25, "sine", 0.12, 300); }
  };

  var hiddenNow = false, muffled = false;
  function setMuffle(on) {
    if (!ctx || on === muffled) return; muffled = on; var t = now();
    bgmFilter.frequency.cancelScheduledValues(t); bgmFilter.frequency.setTargetAtTime(on ? 400 : 18000, t, 0.08);
    out.gain.setTargetAtTime(S.master ? 0.9 : 0, t, 0.05);
    bgmBus.gain.setTargetAtTime(S.bgmOn ? 0.5 * S.bgmVol / 100 * (on ? 0.3 : 1) : 0, t, 0.08);
  }
  document.addEventListener("visibilitychange", function () {
    hiddenNow = document.hidden;
    if (!ctx) return;
    if (document.hidden) { bgm.paused = true; ctx.suspend(); } else { ctx.resume(); bgm.paused = false; }
  });

  window.CatAudio = {
    unlock: unlock, sfx: sfx, settings: S,
    setNight: function (v) { bgm.night = !!v; },
    setIntensity: function (n) { bgm.want = Math.max(0, Math.min(3, n | 0)); },
    setMuffle: setMuffle,
    set: function (k, v) {
      S[k] = v;
      if (k === "master") lsSet("catmouse_muted", v ? "0" : "1");
      if (k === "bgmOn") lsSet("catmouse_bgm_on", v ? "1" : "0");
      if (k === "sfxOn") lsSet("catmouse_sfx_on", v ? "1" : "0");
      if (k === "bgmVol") lsSet("catmouse_bgm_vol", String(v));
      if (k === "sfxVol") lsSet("catmouse_sfx_vol", String(v));
      applyVolumes(); if (muffled) { muffled = false; setMuffle(true); }
    },
    debug: function () { return { state: ctx ? ctx.state : "none", created: stats.created, ended: stats.ended, active: stats.active, bgmActive: stats.bgmActive, dropped: stats.dropped, bar: bgm.bar, level: bgm.level, key: bgm.key, deg: bgm.deg, tempo: bgm.tempo, muffled: muffled, settings: S }; }
  };
})();
