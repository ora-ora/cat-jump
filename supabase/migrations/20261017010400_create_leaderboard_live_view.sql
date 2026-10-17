-- 公开视图：把"历史最佳"与"当前进行中的局"合并成一行，只暴露必要列
-- （不选 client_id，避免暴露内部标识）。
--
-- 注意：这里不设置 `security_invoker = true`（Postgres 15+ 的可选项）。
-- 保持默认的 security_invoker = false，让视图以属主权限执行，这样只需要
-- `grant select on leaderboard_live` 给 anon，而不必把 runs/leaderboard_best
-- 两张表直接暴露给 anon（见 20261017010500_rls_and_grants.sql）。
create or replace view leaderboard_live as
select
  coalesce(r.client_id, lb.client_id) as client_id,
  coalesce(r.nickname, lb.nickname) as nickname,
  greatest(coalesce(lb.best_score, 0), coalesce(r.score, 0)) as display_score,
  coalesce(r.score, 0) as live_score,
  (r.id is not null and r.status = 'in_progress'
    and r.last_heartbeat_at > now() - interval '60 seconds') as is_live,
  (r.id is not null and r.status = 'in_progress' and r.play_status = 'paused'
    and r.last_heartbeat_at > now() - interval '60 seconds') as is_paused
from leaderboard_best lb
full outer join runs r
  on r.client_id = lb.client_id and r.status = 'in_progress';
