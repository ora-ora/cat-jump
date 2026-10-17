-- 两个 pg_cron 定时任务（PLAN.md 9.5 节）。写成"先判断已存在则 unschedule，
-- 再 schedule"的形式，保证这份 SQL 可以被重复执行（例如以后新建迁移文件调整
-- 保留天数），不会因为 job 名已存在而报错。
do $$
begin
  if exists (select 1 from cron.job where jobname = 'abandon_stale_runs') then
    perform cron.unschedule('abandon_stale_runs');
  end if;
end $$;

-- 每 5 分钟扫一次：心跳超过 5 分钟没更新的 in_progress 局，视为异常退出
-- （关标签页但 keepalive 请求没发出去、断网、浏览器崩溃），收尾为 abandoned
-- 并把当时已知的分数计入个人历史最佳。
select cron.schedule('abandon_stale_runs', '*/5 * * * *', $job$
  with stale as (
    update runs
    set status = 'abandoned',
        finished_at = now(),
        duration_seconds = extract(epoch from (last_heartbeat_at - started_at))::int
    where status = 'in_progress' and last_heartbeat_at < now() - interval '5 minutes'
    returning client_id, nickname, score, duration_seconds, catches
  )
  insert into leaderboard_best (client_id, nickname, best_score, best_duration_seconds, best_catches, updated_at)
  select client_id, nickname, score, duration_seconds, catches, now() from stale
  on conflict (client_id) do update
    set best_score = excluded.best_score,
        nickname = excluded.nickname,
        best_duration_seconds = excluded.best_duration_seconds,
        best_catches = excluded.best_catches,
        updated_at = excluded.updated_at
    where excluded.best_score > leaderboard_best.best_score;
$job$);

do $$
begin
  if exists (select 1 from cron.job where jobname = 'score_events_retention') then
    perform cron.unschedule('score_events_retention');
  end if;
end $$;

-- 每天凌晨清理超过保留期（默认 30 天）的原始心跳历史，容量估算见 PLAN.md 9.7 节。
select cron.schedule('score_events_retention', '15 3 * * *', $job$
  delete from score_events where server_ts < now() - interval '30 days';
$job$);
