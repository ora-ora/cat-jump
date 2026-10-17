-- RLS：runs/score_events/leaderboard_best 三张表不给 anon 任何直接
-- select/insert/update/delete 权限（启用 RLS 且不写任何策略，等价于默认拒绝一切）。
-- 所有读写只能经过 start_run/heartbeat/finish_run 三个 SECURITY DEFINER 函数
-- （函数以属主权限运行，绕开 RLS），对外公开只读的是 leaderboard_live 视图。
alter table runs enable row level security;
alter table score_events enable row level security;
alter table leaderboard_best enable row level security;

revoke all on runs from anon, authenticated;
revoke all on score_events from anon, authenticated;
revoke all on leaderboard_best from anon, authenticated;

grant select on leaderboard_live to anon, authenticated;
