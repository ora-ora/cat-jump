// Q版美术：全部 canvas 程序化绘制，无外部素材。纯外观，不影响碰撞/计分。
(function () {
  "use strict";
  var TAU = Math.PI * 2;
  var SKINS = [
    { id: "orange", name: "橘子", desc: "活力满满的橘猫", b: "#ffad66", o: "#e07a33", belly: "#fff3e6", stripe: "#e8843d" },
    { id: "black", name: "煤球", desc: "神秘又黏人的小黑", b: "#3b3742", o: "#1f1c24", belly: "#56505e", eye: "#ffd84a", light: 1 },
    { id: "white", name: "雪团", desc: "软绵绵的白团子", b: "#ffffff", o: "#c9c3cf", belly: "#ffffff", eye: "#6cb6ff" },
    { id: "calico", name: "三花", desc: "好运连连的三花", b: "#fff7ee", o: "#c88a55", belly: "#ffffff", patch: 1 },
    { id: "blue", name: "蓝灰", desc: "圆脸蓝猫小胖墩", b: "#9fb0c8", o: "#6a7c96", belly: "#dfe6f0", eye: "#ffb23f" },
    { id: "siamese", name: "暹罗", desc: "蓝眼睛的小煤炭脸", b: "#f3e3c8", o: "#a8835a", belly: "#fff7e8", point: "#6b4a35", eye: "#4aa3ff", light: 1 }
  ];
  var SKIN_MAP = {};
  SKINS.forEach(function (s) { SKIN_MAP[s.id] = s; });
  function skinOf(id) { return SKIN_MAP[id] || SKINS[0]; }

  function E(x, cx, cy, rx, ry, f, s, lw) {
    x.beginPath(); x.ellipse(cx, cy, rx, ry, 0, 0, TAU);
    if (f) { x.fillStyle = f; x.fill(); }
    if (s) { x.strokeStyle = s; x.lineWidth = lw || 3; x.stroke(); }
  }

  // 正面坐姿小猫，原点在身体中心，单位尺寸：约 x∈[-52,44], y∈[-64,48]
  function paintCat(x, k, opt) {
    opt = opt || {};
    var tailWag = opt.tail || 0;
    x.lineCap = "round"; x.lineJoin = "round";
    // 尾巴
    x.strokeStyle = k.o; x.lineWidth = 13;
    x.beginPath(); x.moveTo(-20, 22); x.quadraticCurveTo(-50, 20 + tailWag * 6, -42 + tailWag * 6, -8); x.stroke();
    x.strokeStyle = k.point || k.b; x.lineWidth = 8; x.stroke();
    if (!k.point && k.stripe) { E(x, -42 + tailWag * 6, -8, 4, 4, "#fff3e6"); }
    // 身体
    E(x, 0, 22, 26, 20, k.b, k.o);
    E(x, 0, 26, 14, 12, k.belly);
    if (k.patch) { E(x, -12, 16, 10, 8, "#f29a4a"); E(x, 14, 24, 8, 7, "#3b3742"); }
    var pc = k.point || k.belly;
    E(x, -14, 38, 8, 6, pc, k.o, 2.5); E(x, 14, 38, 8, 6, pc, k.o, 2.5);
    // 耳朵
    function ear(d, col) {
      x.fillStyle = col; x.strokeStyle = k.o; x.lineWidth = 3;
      x.beginPath(); x.moveTo(d * 10, -38); x.quadraticCurveTo(d * 30, -62, d * 34, -30); x.closePath(); x.fill(); x.stroke();
      x.fillStyle = "#ffb3c1";
      x.beginPath(); x.moveTo(d * 16, -38); x.quadraticCurveTo(d * 28, -52, d * 29, -33); x.closePath(); x.fill();
    }
    var ec = k.point || k.b;
    ear(-1, k.patch ? "#3b3742" : ec); ear(1, k.patch ? "#f29a4a" : ec);
    // 头
    E(x, 0, -14, 36, 30, k.b, k.o);
    if (k.patch) {
      x.save(); x.beginPath(); x.ellipse(0, -14, 34.5, 28.5, 0, 0, TAU); x.clip();
      E(x, -24, -32, 20, 16, "#3b3742"); E(x, 26, -30, 18, 16, "#f29a4a"); x.restore();
    }
    if (k.point) E(x, 0, -4, 17, 13, k.point);
    if (k.stripe) {
      x.strokeStyle = k.stripe; x.lineWidth = 3;
      [-7, 0, 7].forEach(function (q) { x.beginPath(); x.moveTo(q, -42); x.lineTo(q, -34); x.stroke(); });
    }
    // 眼睛
    if (opt.happy) {
      x.strokeStyle = k.light ? "#f3e3c8" : "#3a2a2a"; x.lineWidth = 3;
      x.beginPath(); x.moveTo(-19, -15); x.lineTo(-12, -11); x.lineTo(-19, -7); x.stroke();
      x.beginPath(); x.moveTo(19, -15); x.lineTo(12, -11); x.lineTo(19, -7); x.stroke();
    } else {
      var ey = k.eye || "#3a2a2a";
      E(x, -13, -12, 7, 8, ey); E(x, 13, -12, 7, 8, ey);
      if (k.eye) { E(x, -13, -11, 3.5, 6, "#2a2020"); E(x, 13, -11, 3.5, 6, "#2a2020"); }
      E(x, -11, -15, 2.6, 2.6, "#fff"); E(x, 15, -15, 2.6, 2.6, "#fff");
      E(x, -14, -9, 1.2, 1.2, "#fff"); E(x, 12, -9, 1.2, 1.2, "#fff");
    }
    E(x, -24, 0, 6, 3.5, "rgba(255,110,140,.55)"); E(x, 24, 0, 6, 3.5, "rgba(255,110,140,.55)");
    E(x, 0, -3, 3, 2, "#ff7a90");
    x.strokeStyle = k.light ? "#f3e3c8" : "#5a3a30"; x.lineWidth = 2;
    x.beginPath(); x.arc(-3, 0, 3, 0, Math.PI); x.arc(3, 0, 3, 0, Math.PI); x.stroke();
    x.lineWidth = 1.5;
    [-1, 1].forEach(function (d) {
      x.beginPath(); x.moveTo(d * 26, -4); x.lineTo(d * 42, -8); x.moveTo(d * 26, 0); x.lineTo(d * 42, 2); x.stroke();
    });
  }

  var MICE = {
    grey: { b: "#c9ccd6", ear: "#ffc4d0" },
    brown: { b: "#c98a5a", ear: "#ffbfa8" },
    gold: { b: "#ffd84a", ear: "#ffb3a0", crown: 1 }
  };
  // 正面小老鼠，单位尺寸约 x∈[-42,24], y∈[-30,24]
  function paintMouse(x, type) {
    var m = MICE[type] || MICE.grey;
    x.lineCap = "round"; x.lineJoin = "round";
    x.strokeStyle = "#f4a3b4"; x.lineWidth = 3;
    x.beginPath(); x.moveTo(-18, 10); x.bezierCurveTo(-34, 14, -30, -6, -40, -2); x.stroke();
    E(x, -12, -18, 11, 11, m.b, "rgba(0,0,0,.18)", 2); E(x, 12, -18, 11, 11, m.b, "rgba(0,0,0,.18)", 2);
    E(x, -12, -18, 6.5, 6.5, m.ear); E(x, 12, -18, 6.5, 6.5, m.ear);
    E(x, 0, 4, 21, 18, m.b, "rgba(0,0,0,.18)", 2.5);
    E(x, 0, 10, 11, 8, "rgba(255,255,255,.55)");
    E(x, -7, -1, 3.6, 4.2, "#2a2020"); E(x, 7, -1, 3.6, 4.2, "#2a2020");
    E(x, -6, -2.5, 1.3, 1.3, "#fff"); E(x, 8, -2.5, 1.3, 1.3, "#fff");
    E(x, 0, 5, 2.8, 2.2, "#ff7a90");
    E(x, -13, 6, 4, 2.4, "rgba(255,110,140,.5)"); E(x, 13, 6, 4, 2.4, "rgba(255,110,140,.5)");
    if (m.crown) {
      x.fillStyle = "#ffe066"; x.strokeStyle = "#d89a00"; x.lineWidth = 1.5;
      x.beginPath(); x.moveTo(-8, -14); x.lineTo(-8, -24); x.lineTo(-4, -18); x.lineTo(0, -26);
      x.lineTo(4, -18); x.lineTo(8, -24); x.lineTo(8, -14); x.closePath(); x.fill(); x.stroke();
    }
  }

  function star(x, cx, cy, r, col) {
    x.fillStyle = col; x.beginPath();
    for (var i = 0; i < 8; i++) { var rr = i % 2 ? r * 0.38 : r, t = i * Math.PI / 4 - Math.PI / 2; x.lineTo(cx + Math.cos(t) * rr, cy + Math.sin(t) * rr); }
    x.closePath(); x.fill();
  }
  function heart(x, cx, cy, r, col) {
    x.fillStyle = col; x.beginPath();
    x.moveTo(cx, cy + r * 0.9);
    x.bezierCurveTo(cx - r * 1.4, cy - r * 0.1, cx - r * 0.6, cy - r * 1.2, cx, cy - r * 0.35);
    x.bezierCurveTo(cx + r * 0.6, cy - r * 1.2, cx + r * 1.4, cy - r * 0.1, cx, cy + r * 0.9);
    x.fill();
  }

  // 离屏精灵缓存：key = 种类+像素尺寸，绘制时只做 drawImage + 简单变换
  var cache = {};
  function sprite(key, unitW, unitH, ox, oy, pxScale, painter) {
    var k = key + "@" + pxScale.toFixed(3);
    var c = cache[k];
    if (c) return c;
    var cv = document.createElement("canvas");
    cv.width = Math.max(1, Math.ceil(unitW * pxScale)); cv.height = Math.max(1, Math.ceil(unitH * pxScale));
    var x = cv.getContext("2d");
    x.scale(pxScale, pxScale); x.translate(ox, oy);
    painter(x);
    c = { cv: cv, ox: ox * pxScale, oy: oy * pxScale };
    cache[k] = c;
    return c;
  }
  function clearCache() { cache = {}; }

  // 小猫：单位坐标留边 [-58,52]×[-70,54]
  function catSprite(skinId, pxScale, happy) {
    var k = skinOf(skinId);
    return sprite("cat:" + k.id + (happy ? ":h" : ""), 110, 124, 58, 70, pxScale, function (x) { paintCat(x, k, { happy: happy }); });
  }
  function mouseSprite(type, pxScale) {
    return sprite("mouse:" + type, 74, 60, 46, 32, pxScale, function (x) { paintMouse(x, type); });
  }

  function avatarDataUrl(skinId) {
    var k = "avatar:" + skinId;
    if (cache[k]) return cache[k];
    var cv = document.createElement("canvas"); cv.width = 64; cv.height = 64;
    var x = cv.getContext("2d");
    x.translate(32, 40); x.scale(0.62, 0.62);
    paintCat(x, skinOf(skinId), {});
    var url = cv.toDataURL("image/png");
    cache[k] = url;
    return url;
  }

  window.CatArt = {
    SKINS: SKINS, skinOf: skinOf, paintCat: paintCat, paintMouse: paintMouse,
    catSprite: catSprite, mouseSprite: mouseSprite, avatarDataUrl: avatarDataUrl,
    star: star, heart: heart, ellipse: E, clearCache: clearCache
  };
})();
