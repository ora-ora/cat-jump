-- heartbeat：游玩中周期性上报最新分数。分两类规则（PLAN.md 9.4 节）：
--   1) 即时拒绝/截断规则：命中后直接返回失败，不写入 score_events、不更新 runs。
--   2) 仅标记规则：正常写入，但把命中的规则名追加进 suspicion_flags，不打断玩家。
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
declare
  v_run runs;
  v_dt_secs numeric;
  v_d_score integer;
  v_d_catches integer;
  v_last_elapsed numeric;
  v_last_server_ts timestamptz;
  v_flags text[] := '{}';
  v_play_status text;
  -- 金老鼠满难度分值(约75) × 连击倍率上限(3) / 理论最快连续捕获间隔(0.15s)
  -- 量级，留出余量取整为常量，实现阶段可按实际数值重新核算。
  v_max_score_per_sec numeric := 60;
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

  if v_last_elapsed is not null then
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

grant execute on function heartbeat(
  bigint, uuid, integer, text, integer, integer, integer, integer, integer, integer, numeric, timestamptz
) to anon, authenticated;
