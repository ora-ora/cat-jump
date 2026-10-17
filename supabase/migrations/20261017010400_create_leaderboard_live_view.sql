-- 公开视图：把"历史最佳"与"当前进行中的局"合并成一行，只暴露必要列。
--
-- 千万不要在这个 select 列表里加回 client_id：它是玩家的匿名身份凭证，
-- start_run/heartbeat/finish_run 都靠它鉴别"这一局是不是你的"，一旦公开
-- 暴露，任何人都能拿别人的 client_id 冒用身份开局、改昵称、耗尽频率限额
-- （内部 join 条件里用 r.client_id/lb.client_id 完全没问题，只是不能出现
-- 在最终的 select 输出列里）。
--
-- 注意：这里不设置 `security_invoker = true`（Postgres 15+ 的可选项）。
-- 保持默认的 security_invoker = false，让视图以属主权限执行，这样只需要
-- `grant select on leaderboard_live` 给 anon，而不必把 runs/leaderboard_best
-- 两张表直接暴露给 anon（见 20261017010500_rls_and_grants.sql）。
-- 先把 runs 过滤到只剩 in_progress（每个 client_id 至多一行，由 start_run 的
-- 并发保护保证），再按 client_id 单独做一次干净的等值 full outer join。
-- 不能像最初写法那样把 `r.status = 'in_progress'` 放进 join 条件本身：
-- full outer join 的 ON 条件一旦对某一对行不成立，两侧会各自单独吐出一行
-- （而不是合并），导致任何已经 finished/abandoned 的玩家在视图里出现两行
-- （一行来自 leaderboard_best，一行来自 runs），实测已验证会复现这个重复。
create or replace view leaderboard_live as
with live_runs as (
  select client_id, nickname, score, play_status, last_heartbeat_at
  from runs
  where status = 'in_progress'
)
select
  coalesce(r.nickname, lb.nickname) as nickname,
  greatest(coalesce(lb.best_score, 0), coalesce(r.score, 0)) as display_score,
  coalesce(r.score, 0) as live_score,
  (r.client_id is not null and r.last_heartbeat_at > now() - interval '60 seconds') as is_live,
  (r.client_id is not null and r.play_status = 'paused'
    and r.last_heartbeat_at > now() - interval '60 seconds') as is_paused
from leaderboard_best lb
full outer join live_runs r
  on r.client_id = lb.client_id;
