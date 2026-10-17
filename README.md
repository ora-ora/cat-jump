# 🐱 小猫抓老鼠 Cat Mouse Chase

纯前端 HTML5 小游戏：俯视角无限卷轴抓老鼠。小猫在四方向都能无限延展的世界里奔跑，点击/按住屏幕任意方向移动，靠近老鼠自动抓住它。没有体力限制、不会自动结束，想玩多久玩多久，随时可以结束本局去排行榜上争名次。

游戏本体（`web/`）无需构建、无外部依赖（不使用 CDN、图片或字体资源），所有画面均由 Canvas 绘制，音效由 WebAudio 实时合成。公开排行榜依赖 Supabase（见下文），未配置时游戏完全可玩，只是看不到排名。

## 目录结构

```
web/                    游戏本体，GitHub Pages 只发布这个目录
  index.html
  style.css
  game.js
supabase/               数据库 schema（迁移文件），GitHub Actions 自动部署到 Supabase
  config.toml
  migrations/
  seed.sql              仅本地/CI 测试数据，不含真实玩家信息
.github/workflows/      CI/CD：Pages 发布、Supabase 迁移部署与校验、保活
SETUP.md                站长（部署这个项目的人）需要做的配置步骤
PLAN.md                 设计与排期文档（.gitignore 排除，仅本地留存）
```

## 本地运行游戏

```bash
cd web
python3 -m http.server 8000
```

然后在浏览器访问 `http://localhost:8000`。也可以直接双击 `web/index.html` 打开。

## 操作方式

- **手机端**：按住屏幕任意方向移动小猫，拖动手指可实时转向
- **桌面端**：方向键 / WASD
- 点击暂停图标可暂停；点击喇叭图标静音（状态会保存在本地）

## 排行榜（可选）

游戏支持一个公开的实时排行榜：开局创建会话、游玩中持续上报分数，其他玩家能看到"谁正在游戏中、当前多少分"。这部分依赖 Supabase 作为后端，完整的搭建步骤见 [`SETUP.md`](./SETUP.md)。

在 `web/game.js` 顶部填入你自己的 Supabase 项目信息之前，`SUPABASE_URL`/`SUPABASE_ANON_KEY` 为空，排行榜相关 UI 会显示"未配置"，不影响游戏本身。

## 设计文档

完整的玩法设计、数据库 schema 设计、反作弊规则、部署流水线设计等，见本地的 `PLAN.md`（已加入 `.gitignore`，不随代码一起发布）。
