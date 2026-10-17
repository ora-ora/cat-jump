# 站长部署指南

这份文档给要把这个游戏部署成"带公开排行榜的在线小游戏"的人看。游戏本体（`web/`）不需要任何后端就能玩；只有想要公开排行榜功能时，才需要按下面的步骤配置 Supabase 和 GitHub Actions。

跳过这份文档直接发布 `web/` 三个文件也完全可以——`SUPABASE_URL`/`SUPABASE_ANON_KEY` 留空时，排行榜 UI 会显示"未配置"，不影响正常游戏。

## 0. 总览：会用到的东西

- **Supabase**：免费的 Postgres 后端，存排行榜数据，做分数校验与限频。
- **GitHub Actions**：自动把 `supabase/migrations/` 里的 SQL 部署到 Supabase（不用手动在控制台粘贴 SQL），自动把 `web/` 发布到 GitHub Pages，定时保活 Supabase 项目。
- 你需要准备：一个 Supabase 账号、一个 GitHub 仓库（例如 `ora-ora/cat-jump`）。

## 1. 注册并创建 Supabase 项目

1. 用邮箱或 GitHub 账号注册 [supabase.com](https://supabase.com)，免费层即可，不需要信用卡。
2. 点 **New Project**，选一个离目标玩家较近的区域，设置一个数据库密码（记下来，下面会用到）。
3. 等项目初始化完成（一两分钟）。

## 2. 拿到前端需要的两个值，填进 `web/game.js`

在 Supabase 控制台 **Project Settings → API** 页面，复制：

- **Project URL**（形如 `https://xxxxxxxx.supabase.co`）
- **anon / publishable key**（形如 `sb_publishable_...`，旧称 anon key）

打开 `web/game.js`，找到文件最开头的这两行，把值填进去：

```js
var SUPABASE_URL = "";       // 填入 https://<project-ref>.supabase.co
var SUPABASE_ANON_KEY = "";  // 填入 publishable key (sb_publishable_...)
```

这两个值设计上就是给前端公开用的，**不是秘密**，出现在 `web/game.js` 里和出现在仓库里都没问题；权限边界由数据库侧的 RLS 和下面几个函数把关。

## 3. 拿到部署用的三个凭证（这些是秘密，只进 GitHub Secrets，绝不进仓库任何文件）

| 要填的名字 | 从哪里拿 |
|---|---|
| `SUPABASE_ACCESS_TOKEN` | 控制台右上角头像 → **Account → Access Tokens**，生成一个新 token |
| `SUPABASE_DB_PASSWORD` | 建项目时设置的数据库密码；忘记了就在 **Project Settings → Database → Reset database password** 重置 |
| `SUPABASE_PROJECT_ID` | 项目控制台网址 `https://supabase.com/dashboard/project/<这一段>` 里的那一段（也叫 project ref） |

## 4. 配置 GitHub 仓库的 Secrets 和 Variables

仓库 **Settings → Secrets and variables → Actions**：

- **Secrets** 标签页，新增三个（名字必须完全一致）：
  - `SUPABASE_ACCESS_TOKEN`
  - `SUPABASE_DB_PASSWORD`
  - `SUPABASE_PROJECT_ID`
- **Variables** 标签页，新增两个（这两个不是秘密，用 Variables 存就够了，直接抄第 2 步填进 `game.js` 的那两个值）：
  - `SUPABASE_URL`
  - `SUPABASE_ANON_KEY`（给 `.github/workflows/supabase-keepalive.yml` 用）

如果想给"部署到生产数据库"这个动作加一道人工审批：仓库 **Settings → Environments → New environment**，建一个叫 `production` 的 environment，勾选 **Required reviewers**。`supabase-deploy.yml` 已经引用了这个 environment 名字，建好之后会自动生效；不建也没关系，不配置就是直接自动部署。

## 5. 把 GitHub Pages 的发布方式切到 Actions

仓库 **Settings → Pages → Build and deployment → Source**，从默认的 "Deploy from a branch" 改成 **GitHub Actions**。这样 `.github/workflows/pages-deploy.yml` 才会生效，且只发布 `web/` 目录的内容。

## 6. 首次部署顺序

1. 先确认 `supabase/` 目录的改动已经推送到 `main`（或手动触发一次 `supabase-deploy.yml` 的 `workflow_dispatch`），等它跑完——这一步会把建表、视图、RLS、三个 RPC 函数、两个 `pg_cron` 定时任务部署到你的 Supabase 项目。
2. 确认上一步成功后（在 Supabase 控制台 **Table Editor** 应该能看到 `runs`/`score_events`/`leaderboard_best` 三张表），再推 `web/` 目录的改动（或手动触发 `pages-deploy.yml`），把网页发布出去。
3. 顺序颠倒问题不大（网页里 `SUPABASE_URL`/`SUPABASE_ANON_KEY` 没填之前本来就是"未配置"状态），但先部署数据库、确认没报错，再发布网页，排查问题更简单。

## 7. 如果 `pg_cron` 那条迁移失败

极少数情况下，第一条迁移 `create extension if not exists pg_cron;` 可能因为项目权限问题失败（Actions 日志会显示报错）。遇到这种情况：

1. 去 Supabase 控制台 **Database → Extensions**，搜索 `pg_cron`，手动点启用。
2. 重新触发一次 `supabase-deploy.yml`（这条迁移本身写的是 `if not exists`，手动启用过之后重新跑不会报错，会继续往下执行剩下的迁移）。

## 8. 关于定时任务（keepalive）失效的两件事

- **Supabase 免费层 7 天无数据库活动会自动暂停项目**（提前发邮件通知，控制台一键恢复，不丢数据）。`supabase-keepalive.yml` 每 3 天请求一次排行榜接口，用来防止这个。
- **GitHub 对 60 天没有任何提交（commit）的仓库，会自动停用里面所有的 `schedule` 定时工作流**（`workflow_dispatch` 手动触发不受影响）。如果这个项目进入长期不改代码的阶段，`supabase-keepalive.yml` 自己也会先失效。应对方式：
  - 每隔一两个月去仓库 **Actions** 页面手动点一次 `workflow_dispatch` 触发 `supabase-keepalive.yml`；
  - 就算两边都失效、Supabase 项目也被暂停了，游戏本体依旧完整可玩，只是暂时看不到排行榜，登录控制台一键恢复即可，不是数据丢失级别的问题。

## 9. 哪些东西绝对不能进仓库

- `service_role` / secret key（和第 2 步的 publishable key 不是同一个东西，绝不要把它填进 `game.js` 或任何仓库文件）
- 数据库密码、`SUPABASE_ACCESS_TOKEN`——只能存在 GitHub Secrets 里，经 `${{ secrets.XXX }}` 在 Actions 运行时注入
- 任何真实玩家数据（`supabase/seed.sql` 只能放虚构的测试数据）
- `.env`、`supabase/.temp/`、`supabase/.branches/`——已经写进 `.gitignore`，正常使用 Supabase CLI 不会意外提交它们
- `PLAN.md` 及其他内部设计/排期文档——已经写进 `.gitignore`，这些文件只在本地留存，不随代码一起发布
