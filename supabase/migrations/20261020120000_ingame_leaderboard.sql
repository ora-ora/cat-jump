-- 局内排行榜：
-- 1) leaderboard_live 末尾追加 live_run_id（进行中局的 run id），前端用 start_run 返回的 run_id 精确识别"自己"那一行。
--    run_id 单独无法冒用（heartbeat/finish_run 还需要 client_id），client_id 仍不暴露。
-- 2) heartbeat：暂停（含局内看排行榜）不再触发 elapsed_drift 可疑标记。

create or replace view leaderboard_ranked as
select t.nickname, t.display_score, t.live_score, t.is_live, t.is_paused, t.skin, t.client_id, t.achieved_at,
  row_number() over (order by t.display_score desc, t.achieved_at asc, t.client_id asc) as rank,
  t.live_run_id
from (with live_runs as (
  select id, client_id, nickname, score, play_status, last_heartbeat_at, skin, score_changed_at
  from runs
  where status = 'in_progress'
)
select
  coalesce(r.nickname, lb.nickname) as nickname,
  greatest(coalesce(lb.best_score, 0), coalesce(r.score, 0)) as display_score,
  coalesce(r.score, 0) as live_score,
  (r.client_id is not null and r.last_heartbeat_at > now() - interval '60 seconds') as is_live,
  (r.client_id is not null and r.play_status = 'paused'
    and r.last_heartbeat_at > now() - interval '60 seconds') as is_paused,
  coalesce(r.skin, lb.skin, 'orange') as skin,
  coalesce(r.client_id, lb.client_id) as client_id,
  case when lb.client_id is null or coalesce(r.score, 0) > lb.best_score then r.score_changed_at
       else lb.updated_at end as achieved_at,
  r.id as live_run_id
from leaderboard_best lb
full outer join live_runs r
  on r.client_id = lb.client_id) t;
revoke all on leaderboard_ranked from public, anon, authenticated;

create or replace view leaderboard_live as
select nickname, display_score, live_score, is_live, is_paused, skin, achieved_at, rank, live_run_id
from leaderboard_ranked;
grant select on leaderboard_live to anon, authenticated;

create or replace function heartbeat(
  p_run_id bigint,
  p_client_id uuid,
  p_seq integer,
  p_play_status text,
  p_score integer,
  p_catches integer,
  p_catches_grey integer,
  p_catches_brown integer,
  p_catches_gold integer,
  p_combo_max integer,
  p_elapsed_seconds numeric,
  p_client_ts timestamptz
)
returns table(ok boolean, reason text, server_now timestamptz)
language plpgsql
security definer
set search_path = public
as $$
#variable_conflict use_column
declare
  v_run runs;
  v_dt_secs numeric;
  v_d_score integer;
  v_d_catches integer;
  v_last_elapsed numeric;
  v_last_server_ts timestamptz;
  v_flags text[] := '{}';
  v_play_status text;
  v_max_score_per_sec numeric := game_max_score_per_sec();
begin
  select * into v_run from runs where id = p_run_id and client_id = p_client_id;
  if v_run.id is null or v_run.status <> 'in_progress' then
    return query select false, 'invalid_run', now();
    return;
  end if;

  if now() - v_run.last_heartbeat_at < interval '2 seconds' then
    return query select false, 'too_frequent', now();
    return;
  end if;

  if p_seq <= v_run.last_seq then
    return query select false, 'stale_seq', now();
    return;
  end if;

  if now() - v_run.started_at > interval '3 hours' then
    update runs
    set status = 'finished',
        finished_at = now(),
        duration_seconds = extract(epoch from (now() - v_run.started_at))::int,
        score = p_score,
        catches = p_catches
    where id = v_run.id;
    return query select false, 'run_expired', now();
    return;
  end if;

  if p_score < v_run.score then
    return query select false, 'score_regression', now();
    return;
  end if;

  v_dt_secs := greatest(extract(epoch from (now() - v_run.last_heartbeat_at)), 0.001);
  v_d_score := p_score - v_run.score;
  if v_d_score > v_max_score_per_sec * v_dt_secs then
    return query select false, 'score_rate_exceeded', now();
    return;
  end if;

  -- 以下只打标记，不拒绝写入。
  v_d_catches := p_catches - v_run.catches;
  if v_d_catches > 0 and (v_d_score < v_d_catches * 5 or v_d_score > v_d_catches * 250) then
    v_flags := array_append(v_flags, 'catches_score_mismatch');
  end if;

  select elapsed_seconds, server_ts into v_last_elapsed, v_last_server_ts
  from score_events
  where run_id = v_run.id
  order by server_ts desc
  limit 1;

  -- 暂停期间客户端游戏时长不走而服务器时间照走：本次或上一次心跳处于暂停时
  -- 跳过 elapsed_drift 检查，避免正常暂停（含局内查看排行榜）被记为可疑。
  if v_last_elapsed is not null and p_play_status <> 'paused' and v_run.play_status <> 'paused' then
    if abs((p_elapsed_seconds - v_last_elapsed) - extract(epoch from (now() - v_last_server_ts))) > 3 then
      v_flags := array_append(v_flags, 'elapsed_drift');
    end if;
  end if;

  v_play_status := case when p_play_status = 'paused' then 'paused' else 'playing' end;

  update runs
  set score = p_score,
      catches = p_catches,
      last_seq = p_seq,
      last_heartbeat_at = now(),
      play_status = v_play_status,
      suspicion_flags = array_cat(v_run.suspicion_flags, v_flags),
      suspicion_score = v_run.suspicion_score + coalesce(array_length(v_flags, 1), 0)
  where id = v_run.id;

  insert into score_events (
    run_id, client_id, seq, event_type, client_ts, score, catches,
    catches_grey, catches_brown, catches_gold, combo_max, elapsed_seconds, suspicion_flags
  ) values (
    v_run.id, p_client_id, p_seq, 'heartbeat', p_client_ts, p_score, p_catches,
    p_catches_grey, p_catches_brown, p_catches_gold, p_combo_max, p_elapsed_seconds, v_flags
  );

  return query select true, null::text, now();
end;
$$;

revoke execute on function heartbeat(
  bigint, uuid, integer, text, integer, integer, integer, integer, integer, integer, numeric, timestamptz
) from public;
grant execute on function heartbeat(
  bigint, uuid, integer, text, integer, integer, integer, integer, integer, integer, numeric, timestamptz
) to anon, authenticated;
