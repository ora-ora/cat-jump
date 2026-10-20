// 分方向动画美术（5 视图 × 跑/坐/吞），程序化绘制并缓存成精灵；纯外观。
(function(){"use strict";
var x=null;var BLINK=false;var A=window.CatArt;
function E(cx,cy,rx,ry,f,s,lw){A.ellipse(x,cx,cy,rx,ry,f,s,lw)}
function crownStub(){}
// 跑步参数：p=步相位 0..3；bob 身体上下, leg 前后爪偏移, ear 耳朵弹, tail 尾巴摆
function pose(f){if(f<0)return{bob:0,legA:0,legB:0,ear:0,tail:0};const P=[[3,6,-6,1,1],[8,0,0,3,0],[3,-6,6,1,-1],[0,0,0,-2,0]][f];return{bob:P[0],legA:P[1],legB:P[2],ear:P[3],tail:P[4]}}
function tail(k,x0,y0,cx,cy,x1,y1){x.strokeStyle=k.o;x.lineWidth=13;x.lineCap='round';x.beginPath();x.moveTo(x0,y0);x.quadraticCurveTo(cx,cy,x1,y1);x.stroke();x.strokeStyle=k.point||k.b;x.lineWidth=8;x.stroke()}
function ear(k,d,s,col,dx,dy){x.fillStyle=col||k.point||k.b;x.strokeStyle=k.o;x.lineWidth=3;x.beginPath();x.moveTo(d*10*s+dx,-38);x.quadraticCurveTo(d*30*s+dx,-62+dy,d*34*s+dx,-30);x.closePath();x.fill();x.stroke()}
function inner(d,s,dx,dy){x.fillStyle='#ffb3c1';x.beginPath();x.moveTo(d*16*s+dx,-38);x.quadraticCurveTo(d*28*s+dx,-52+dy,d*29*s+dx,-33);x.closePath();x.fill()}
function eyes(k,pts){if(BLINK){x.strokeStyle=k.light?'#f3e3c8':'#3a2a2a';x.lineWidth=2.6;pts.forEach(([ex,w])=>{x.beginPath();x.arc(ex,-13,w,0.3,2.84);x.stroke()});return}const ey=k.eye||'#3a2a2a';pts.forEach(([ex,w])=>{E(ex,-12,w,8,ey);if(k.eye)E(ex,-11,w*.5,6,'#2a2020');E(ex+2,-15,2.4,2.4,'#fff')})}
function paws(k,p,xs){const pc=k.point||k.belly;E(xs[0],38-Math.max(0,p.legA)*.5,8,6,pc,k.o,2.5);E(xs[1],38-Math.max(0,p.legB)*.5,8,6,pc,k.o,2.5);if(xs[2]!=null){E(xs[2]+p.legA,40,7,5,pc,k.o,2.5);E(xs[3]+p.legB,40,7,5,pc,k.o,2.5)}}
function front(k,p){tail(k,-20,22,-50,20+p.tail*8,-42+p.tail*8,-8-p.ear);E(0,22,26,20,k.b,k.o);E(0,26,14,12,k.belly);if(k.patch){E(-12,16,10,8,'#f29a4a');E(14,24,8,7,'#3b3742')}
 paws(k,p,[-14,14]);head(k,'front',p)}
function head(k,v,p){x.save();if(p.dip)x.translate(0,p.dip);head0(k,v,p);if(p.mouth)mouth(k,v,p.mouth);x.restore()}
function mouth(k,v,o){if(v=='back'||v=='b34')return;x.fillStyle='#7a2a3a';if(v=='side'){x.beginPath();x.moveTo(36,-10);x.lineTo(50,-10+o*12);x.lineTo(46,-6);x.closePath();x.fill();return}const mx=v=='q34'?14:0;x.beginPath();x.ellipse(mx,4,6+o*6,4+o*7,0,0,7);x.fill();E(mx,7+o*3,4+o*2,2+o,'#ff8aa0')}
function head0(k,v,p){const e=p.ear||0;
 if(v=='front'||v=='q34'){const s=v=='q34'?[0.8,1.05]:[1,1],dx=v=='q34'?6:0;
  ear(k,-1,s[0],k.patch?'#3b3742':null,dx,-e);inner(-1,s[0],dx,-e);ear(k,1,s[1],k.patch?'#f29a4a':null,dx,-e);inner(1,s[1],dx,-e);
  x.save();x.translate(dx,0);E(0,-14,35,30,k.b,k.o);
  if(k.patch){x.save();x.beginPath();x.ellipse(0,-14,33.5,28.5,0,0,7);x.clip();E(-24,-32,20,16,'#3b3742');E(26,-30,18,16,'#f29a4a');x.restore()}
  if(k.point)E(v=='q34'?6:0,-4,17,13,k.point);
  if(k.stripe){x.strokeStyle=k.stripe;x.lineWidth=3;(v=='q34'?[-4,3,10]:[-7,0,7]).forEach(q=>{x.beginPath();x.moveTo(q,-42);x.lineTo(q,-34);x.stroke()})}
  eyes(k,v=='q34'?[[-8,5.5],[17,7]]:[[-13,7],[13,7]]);
  const m=v=='q34'?8:0;E(-24+m*1.4,0,5.5,3.2,'rgba(255,110,140,.55)');E(24+m,0,6,3.5,'rgba(255,110,140,.55)');E(m,-3,3,2,'#ff7a90');
  x.strokeStyle=k.light?'#f3e3c8':'#5a3a30';x.lineWidth=2;x.beginPath();x.arc(m-3,0,3,0,3.14);x.arc(m+3,0,3,0,3.14);x.stroke();x.restore()}
 else if(v=='back'||v=='b34'){const dx=v=='b34'?-6:0;ear(k,-1,1,k.patch?'#3b3742':null,dx,-e);ear(k,1,v=='b34'?0.8:1,k.patch?'#f29a4a':null,dx,-e);
  E(dx,-14,35,30,k.point&&v=='back'?k.b:k.b,k.o);
  if(k.patch){x.save();x.beginPath();x.ellipse(dx,-14,33.5,28.5,0,0,7);x.clip();E(dx+22,-30,20,16,'#3b3742');E(dx-24,-28,18,16,'#f29a4a');x.restore()}
  if(k.stripe){x.strokeStyle=k.stripe;x.lineWidth=3;[-10,0,10].forEach(q=>{x.beginPath();x.moveTo(q+dx,-40);x.lineTo(q+dx,-26);x.stroke()})}
  if(v=='b34'){E(dx+26,-2,11,10,k.b,k.o);E(dx+24,-2,10,9,k.b);inner(1,0.8,dx,-e);x.strokeStyle=k.light?'#f3e3c8':'#5a3a30';x.lineWidth=1.5;x.beginPath();x.moveTo(dx+34,-4);x.lineTo(dx+48,-8);x.moveTo(dx+34,0);x.lineTo(dx+48,2);x.stroke()}}
 else{ // side
  x.save();x.translate(14,-14);ear(k,1,0.6,k.patch?'#f29a4a':null,-12,-e);E(0,-2,30,26,k.b,k.o);
  if(k.patch){x.save();x.beginPath();x.ellipse(0,-2,28.5,24.5,0,0,7);x.clip();E(-18,-20,18,14,'#3b3742');x.restore()}
  if(k.point)E(14,6,16,12,k.point);
  E(22,6,10,7,k.point||k.b);
  if(k.stripe){x.strokeStyle=k.stripe;x.lineWidth=3;[-10,-2].forEach(q=>{x.beginPath();x.moveTo(q,-26);x.lineTo(q,-18);x.stroke()})}
  const ey=k.eye||'#3a2a2a';E(12,-6,6,7,ey);if(k.eye)E(13,-5,3,5,'#2a2020');E(14,-9,2.2,2.2,'#fff');
  E(14,8,5,3,'rgba(255,110,140,.55)');E(31,2,2.5,2,'#ff7a90');x.restore()}}
function back(k,p){E(0,22,26,20,k.b,k.o);if(k.patch)E(10,18,10,8,'#3b3742');paws(k,p,[-14,14]);tail(k,4,36,30+p.tail*12,40,36+p.tail*14,8-p.ear*2);head(k,'back',p)}
function side(k,p){tail(k,-24,24,-52,20+p.tail*8,-46,-6+p.tail*6);
 const pc=k.point||k.belly;E(-20+p.legB,40,7,5,pc,k.o,2.5);E(14+p.legA,40,7,5,pc,k.o,2.5);
 E(-4,22,30,19,k.b,k.o);E(2,28,14,10,k.belly);if(k.patch)E(-12,18,10,8,'#f29a4a');
 E(-12+p.legA,40,7,5,pc,k.o,2.5);E(22+p.legB,40,7,5,pc,k.o,2.5);head(k,'side',p)}
function q34(k,p){tail(k,-22,22,-50,18+p.tail*8,-44+p.tail*6,-8-p.ear);E(-2,22,27,20,k.b,k.o);E(4,26,13,11,k.belly);if(k.patch)E(-12,16,10,8,'#f29a4a');
 paws(k,p,[-10,18]);head(k,'q34',p)}
function b34(k,p){E(2,22,27,20,k.b,k.o);if(k.patch)E(10,18,10,8,'#3b3742');paws(k,p,[-12,16]);tail(k,10,32,34+p.tail*12,34,40+p.tail*14,4-p.ear*2);head(k,'b34',p)}

const T={grey:{b:'#c9ccd6',ear:'#ffc4d0'},brown:{b:'#c98a5a',ear:'#ffbfa8'},gold:{b:'#ffd84a',ear:'#ffb3a0',crown:1}};
const OL='rgba(0,0,0,.2)';
function mpose(f){if(f<0)return{bob:0,a:0,b:0,ear:0,tw:0};return[{bob:2,a:4,b:-4,ear:1,tw:1},{bob:5,a:0,b:0,ear:3,tw:0},{bob:2,a:-4,b:4,ear:1,tw:-1},{bob:0,a:0,b:0,ear:-1,tw:0}][f]}
function tailW(x0,y0,dir,p){x.strokeStyle='#f4a3b4';x.lineWidth=3;x.lineCap='round';x.beginPath();x.moveTo(x0,y0);x.bezierCurveTo(x0+dir*14,y0+6+p.tw*6,x0+dir*12,y0-10-p.tw*6,x0+dir*24,y0-6+p.tw*4);x.stroke()}
function feet(xs,p){xs.forEach((fx,i)=>E(fx+(i%2?p.b:p.a),22-(i%2?Math.max(0,p.b):Math.max(0,p.a))*.4,4.5,3,'#f4a3b4'))}
function crown(cx,cy){x.fillStyle='#ffe066';x.strokeStyle='#d89a00';x.lineWidth=1.5;x.beginPath();x.moveTo(cx-8,cy+10);x.lineTo(cx-8,cy);x.lineTo(cx-4,cy+6);x.lineTo(cx,cy-2);x.lineTo(cx+4,cy+6);x.lineTo(cx+8,cy);x.lineTo(cx+8,cy+10);x.closePath();x.fill();x.stroke()}
function sparkle(m,f){if(!m.crown)return;const t=(f+2)/5;A.star(x,26,-22,4+t*3,'rgba(255,236,140,.95)');A.star(x,-28,-4,3+(1-t)*3,'rgba(255,236,140,.85)')}
function face(eyes,nose,cheeks){eyes.forEach(([ex,w])=>{E(ex,-1,w,4.2,'#2a2020');E(ex+1,-2.5,1.3,1.3,'#fff')});E(nose[0],nose[1],2.8,2.2,'#ff7a90');cheeks.forEach(cx=>E(cx,6,4,2.4,'rgba(255,110,140,.5)'))}
const V={
front(m,p){tailW(-14,12,-1,p);feet([-10,10],p);E(-12,-18-p.ear,11,11,m.b,OL,2);E(12,-18-p.ear,11,11,m.b,OL,2);E(-12,-18-p.ear,6.5,6.5,m.ear);E(12,-18-p.ear,6.5,6.5,m.ear);E(0,4,21,18,m.b,OL,2.5);E(0,10,11,8,'rgba(255,255,255,.55)');face([[-7,3.6],[7,3.6]],[0,5],[-13,13]);if(m.crown)crown(0,-24)},
q34(m,p){tailW(-16,12,-1,p);feet([-8,14],p);E(-9,-18-p.ear,9,9.5,m.b,OL,2);E(15,-17-p.ear,11,11,m.b,OL,2);E(-9,-18-p.ear,5,5.5,m.ear);E(15,-17-p.ear,6.5,6.5,m.ear);E(2,4,21,18,m.b,OL,2.5);E(6,10,10,7,'rgba(255,255,255,.55)');face([[-2,3],[11,3.8]],[8,5],[-6,17]);if(m.crown)crown(4,-24)},
side(m,p){tailW(-20,10,-1,p);feet([-12,-4,8,16],p);E(-2,6,22,15,m.b,OL,2.5);E(4,-14-p.ear,10,11,m.b,OL,2);E(4,-14-p.ear,5.5,6.5,m.ear);E(14,2,10,9,m.b);E(10,-1,3.4,4.2,'#2a2020');E(11,-2.5,1.3,1.3,'#fff');E(23,3,2.6,2.2,'#ff7a90');E(13,7,3.5,2.2,'rgba(255,110,140,.5)');if(m.crown)crown(2,-26)},
b34(m,p){feet([-10,12],p);E(-2,4,21,18,m.b,OL,2.5);E(-12,-16-p.ear,10,10.5,m.b,OL,2);E(10,-17-p.ear,11,11,m.b,OL,2);E(16,0,6,5,m.b);tailW(-6,16,-1,p);if(m.crown)crown(0,-24)},
back(m,p){feet([-10,10],p);E(0,4,21,18,m.b,OL,2.5);E(-12,-17-p.ear,11,11,m.b,OL,2);E(12,-17-p.ear,11,11,m.b,OL,2);x.strokeStyle='#f4a3b4';x.lineWidth=3;x.lineCap='round';x.beginPath();x.moveTo(0,18);x.bezierCurveTo(8+p.tw*8,26,-8-p.tw*8,32,4+p.tw*6,38);x.stroke();if(m.crown)crown(0,-26)}};

// ===== 坐姿：小猫 =====
function catTailWrap(k,pts){x.strokeStyle=k.o;x.lineWidth=12;x.lineCap='round';x.beginPath();x.moveTo(...pts[0]);x.quadraticCurveTo(...pts[1],...pts[2]);x.stroke();x.strokeStyle=k.point||k.b;x.lineWidth=7;x.stroke()}
function lickPaw(k,px,py){const pc=k.point||k.belly;E(px,py,7.5,6.5,pc,k.o,2.5);E(px-6,py+1,3,2,'#ff8aa0')}
const SIT={
front(k,s){E(0,28,24,20,k.b,k.o);E(0,30,13,13,k.belly);if(k.patch){E(-12,22,9,8,'#f29a4a');E(13,30,7,6,'#3b3742')}
 const pc=k.point||k.belly;E(-6,44,7,5,pc,k.o,2.5);E(6,44,7,5,pc,k.o,2.5);
 catTailWrap(k,[[20,38],[26,52],[-14,49]]);
 x.save();x.translate(0,6);x.rotate(s.tilt);head(k,'front',{ear:s.ear});x.restore();if(s.lick)lickPaw(k,10,10)},
q34(k,s){E(0,28,24,20,k.b,k.o);E(5,30,12,12,k.belly);if(k.patch)E(-12,22,9,8,'#f29a4a');
 const pc=k.point||k.belly;E(0,44,7,5,pc,k.o,2.5);E(13,44,7,5,pc,k.o,2.5);
 catTailWrap(k,[[-20,38],[-24,52],[18,50]]);
 x.save();x.translate(0,6);x.rotate(s.tilt);head(k,'q34',{ear:s.ear});x.restore();if(s.lick)lickPaw(k,18,10)},
side(k,s){catTailWrap(k,[[-26,40],[-10,54],[24,48]]);E(-8,30,20,17,k.b,k.o);E(6,24,13,18,k.b,k.o);E(9,28,7,12,k.belly);if(k.patch)E(-14,26,9,7,'#f29a4a');
 const pc=k.point||k.belly;E(-14,44,9,5,pc,k.o,2.5);E(12,44,7,5,pc,k.o,2.5);
 x.save();x.translate(-6,8);x.rotate(s.tilt);head(k,'side',{ear:s.ear});x.restore();if(s.lick)lickPaw(k,26,4)},
b34(k,s){E(0,28,25,20,k.b,k.o);if(k.patch)E(10,22,10,8,'#3b3742');catTailWrap(k,[[-6,44],[20,54],[26,40]]);
 x.save();x.translate(0,6);x.rotate(s.tilt);head(k,'b34',{ear:s.ear});x.restore()},
back(k,s){E(0,28,25,20,k.b,k.o);if(k.patch)E(10,22,10,8,'#3b3742');catTailWrap(k,[[0,44],[26,52],[24,30]]);
 x.save();x.translate(0,6);x.rotate(s.tilt);head(k,'back',{ear:s.ear});x.restore()}};
// ===== 坐姿：老鼠（后腿坐起、前爪合拢）=====
function mFace(m,s,cx){const n=s.nose;E(cx-7,-17,3.4,4,'#2a2020');E(cx+7,-17,3.4,4,'#2a2020');E(cx-6,-18.5,1.2,1.2,'#fff');E(cx+8,-18.5,1.2,1.2,'#fff');E(cx,-11+n,2.8,2.2,'#ff7a90');
 x.strokeStyle='rgba(90,60,60,.5)';x.lineWidth=1;[-1,1].forEach(d=>{x.beginPath();x.moveTo(cx+d*4,-10+n);x.lineTo(cx+d*14,-12+n*2);x.moveTo(cx+d*4,-9+n);x.lineTo(cx+d*14,-7);x.stroke()});E(cx-11,-10,3.6,2.2,'rgba(255,110,140,.5)');E(cx+11,-10,3.6,2.2,'rgba(255,110,140,.5)')}
function mEars(m,cx,s,sc){const L=s.flick?-5:0;E(cx-11*sc[0],-32+L,9*sc[0],9.5,m.b,OL,2);E(cx-11*sc[0],-32+L,5*sc[0],5.5,m.ear);E(cx+11*sc[1],-32,9*sc[1],9.5,m.b,OL,2);E(cx+11*sc[1],-32,5*sc[1],5.5,m.ear)}
function mTailCurl(pts){x.strokeStyle='#f4a3b4';x.lineWidth=3;x.lineCap='round';x.beginPath();x.moveTo(...pts[0]);x.bezierCurveTo(...pts[1],...pts[2],...pts[3]);x.stroke()}
function mBlinkFix(){} 
const MSIT={
front(m,s){mTailCurl([[10,20],[26,24],[26,10],[18,8]]);E(-8,22,5,3,'#f4a3b4');E(8,22,5,3,'#f4a3b4');E(0,6,15,17,m.b,OL,2.5);E(0,10,9,11,'rgba(255,255,255,.55)');E(-3,2,3.6,3,'#f4a3b4');E(3,2,3.6,3,'#f4a3b4');
 mEars(m,0,s,[1,1]);E(0,-17,15,13,m.b,OL,2.5);mFace(m,s,0);if(m.crown)crown(0,-38)},
q34(m,s){mTailCurl([[-8,20],[-26,24],[-24,8],[-16,8]]);E(-4,22,5,3,'#f4a3b4');E(10,22,5,3,'#f4a3b4');E(2,6,15,17,m.b,OL,2.5);E(5,10,8,11,'rgba(255,255,255,.55)');E(4,2,3.6,3,'#f4a3b4');E(10,2,3.4,3,'#f4a3b4');
 mEars(m,4,s,[.8,1]);E(4,-17,15,13,m.b,OL,2.5);mFace(m,s,6);if(m.crown)crown(4,-38)},
side(m,s){mTailCurl([[-12,20],[-30,24],[-30,8],[-22,6]]);E(-4,22,7,3,'#f4a3b4');E(-2,6,13,17,m.b,OL,2.5);E(4,10,6,10,'rgba(255,255,255,.55)');E(9,2,3.6,3,'#f4a3b4');
 E(-2,-34+(s.flick?-5:0),8,10,m.b,OL,2);E(-2,-34+(s.flick?-5:0),4.5,6,m.ear);E(2,-18,13,12,m.b,OL,2.5);E(12,-15,8,7,m.b);
 E(6,-20,3.2,4,'#2a2020');E(7,-21.5,1.2,1.2,'#fff');E(19,-14+s.nose,2.6,2.2,'#ff7a90');x.strokeStyle='rgba(90,60,60,.5)';x.lineWidth=1;x.beginPath();x.moveTo(16,-13+s.nose);x.lineTo(28,-16+s.nose*2);x.moveTo(16,-12);x.lineTo(28,-9);x.stroke();E(10,-11,3.4,2.2,'rgba(255,110,140,.5)');if(m.crown)crown(0,-40)},
b34(m,s){E(-6,22,5,3,'#f4a3b4');E(8,22,5,3,'#f4a3b4');E(0,6,16,17,m.b,OL,2.5);mTailCurl([[-4,20],[-22,30],[-28,14],[-20,10]]);mEars(m,-2,s,[1,.8]);E(-2,-17,15,13,m.b,OL,2.5);E(11,-12,5,4,m.b);if(m.crown)crown(-2,-38)},
back(m,s){E(-8,22,5,3,'#f4a3b4');E(8,22,5,3,'#f4a3b4');E(0,6,16,17,m.b,OL,2.5);mTailCurl([[0,20],[14,30],[24,22],[20,10]]);mEars(m,0,s,[1,1]);E(0,-17,15,13,m.b,OL,2.5);if(m.crown)crown(0,-38)}};

var RUNV={front:front,back:back,side:side,q34:q34,b34:b34};
var BACKV={b34:1,back:1};
var CAT_SIT=[{sq:1},{sq:2},{},{blink:1},{ear:-4},{lick:1,tilt:0.18}];
var MOUSE_SIT=[{sq:1},{sq:2},{},{nose:2},{flick:1},{nose:-1}];
function stretch(view,amt){var fb=view=='front'||view=='back';x.scale(fb?1-0.06*amt:1+0.14*amt,fb?1+0.07*amt:1-0.1*amt)}
function paintCatFrame(k,view,state,f){x.lineJoin='round';
 if(state=='run'){var p=pose(f);x.translate(0,-p.bob);x.translate(0,46);stretch(view,1);x.translate(0,-46);RUNV[view](k,p);return}
 if(state=='gulp'){var g={bob:0,legA:0,legB:0,ear:[1,3,2,-2,0][f],tail:f==3?2.5:(f==4?-1:0),mouth:BACKV[view]?0:[0.35,0.85,1,0,0][f],dip:BACKV[view]?[3,8,10,4,0][f]:0};
  BLINK=f>=3&&!BACKV[view];if(f==3){x.translate(0,46);x.scale(1.06,0.95);x.translate(0,-46)}RUNV[view](k,g);BLINK=false;
  if(f>=3){A.heart(x,30,-56,7,'#ff7a9a');A.star(x,-34,-50,6,'#ffd84a')}
  if(BACKV[view]&&f>=3){x.fillStyle='#ff7a9a';x.font='bold 16px sans-serif';x.fillText('\u266a',26,-46)}return}
 var q=CAT_SIT[f];var s={ear:q.ear||0,tilt:(BACKV[view]&&q.lick)?0.2:(q.tilt||0),lick:q.lick&&!BACKV[view]};
 if(q.sq==1){x.translate(0,50);x.scale(1.14,0.84);x.translate(0,-50)}if(q.sq==2){x.translate(0,50);x.scale(0.96,1.04);x.translate(0,-50)}
 BLINK=!!q.blink&&!BACKV[view];SIT[view](k,s);BLINK=false;
 if(q.ear){x.strokeStyle='#e07a33';x.lineWidth=2.2;x.lineCap='round';var ex=view=='side'?16:34,ey=view=='side'?-44:-40;for(var i=0;i<2;i++){x.beginPath();x.arc(ex,ey,8+i*6,-1.2,-0.2);x.stroke()}}}
function paintMouseFrame(type,view,state,f){var m=T[type];x.lineJoin='round';
 if(state=='run'){var p=mpose(f);x.translate(0,-p.bob);x.translate(0,24);stretch(view,1.1);x.translate(0,-24);V[view](m,p);return}
 var q=MOUSE_SIT[f];var s={nose:q.nose||0,flick:q.flick};
 if(q.sq==1){x.translate(0,24);x.scale(1.15,0.8);x.translate(0,-24)}if(q.sq==2){x.translate(0,24);x.scale(0.95,1.05);x.translate(0,-24)}
 MSIT[view](m,s);
 if(q.flick){x.strokeStyle='#b0a0b0';x.lineWidth=1.6;x.lineCap='round';for(var i=0;i<2;i++){x.beginPath();x.arc(-14,-44,5+i*4,-2.6,-1.6);x.stroke()}}
 if(q.nose){x.strokeStyle='#ff9ab0';x.lineWidth=1.4;var nx=view=='side'?24:(view=='q34'?10:4);for(var j=0;j<2;j++){x.beginPath();x.arc(nx,-12,4+j*3,-0.6,0.6);x.stroke()}}}
// 精灵缓存（DPR 上限 2）
var cache=new Map(),bytes=0;
function sprite(key,w,h,ox,oy,px,painter){var k=key+'@'+px;var c=cache.get(k);if(c)return c;
 var cv=document.createElement('canvas');cv.width=Math.max(1,Math.ceil(w*px));cv.height=Math.max(1,Math.ceil(h*px));
 var prev=x;x=cv.getContext('2d');x.scale(px,px);x.translate(ox,oy);painter();x=prev;
 c={cv:cv,ox:ox,oy:oy,px:px};cache.set(k,c);bytes+=cv.width*cv.height*4;return c}
function catSprite(skin,view,state,f,px){var k=A.skinOf(skin);return sprite('c:'+k.id+':'+view+':'+state+f,150,140,75,78,px,function(){paintCatFrame(k,view,state,f)})}
function mouseSprite(type,view,state,f,px){return sprite('m:'+type+':'+view+':'+state+f,100,92,50,58,px,function(){paintMouseFrame(type,view,state,f)})}
function dropSkin(skin){cache.forEach(function(v,k){if(k.indexOf('c:'+skin+':')===0){bytes-=v.cv.width*v.cv.height*4;cache.delete(k)}})}
function clear(){cache.clear();bytes=0}
// 8 方向：0=→ 1=↘ 2=↓ 3=↙ 4=← 5=↖ 6=↑ 7=↗（canvas y 向下）
var DIR8=[['side',1],['q34',1],['front',1],['q34',-1],['side',-1],['b34',-1],['back',1],['b34',1]];
function dirOf(angle){var i=Math.round(angle/(Math.PI/4));return ((i%8)+8)%8}
window.CatAnim={DIR8:DIR8,dirOf:dirOf,catSprite:catSprite,mouseSprite:mouseSprite,dropSkin:dropSkin,clear:clear,
 stats:function(){return{count:cache.size,bytes:bytes}},isBack:function(v){return !!BACKV[v]}};
})();
