-- 通用被动触发次数随心跳上报（仅记录，不参与校验）。p_uni_procs 为可选参数，旧客户端不传也能用。
alter table score_events add column if not exists uni_procs jsonb;
-- 只保留已知键，数值截断到 0..100000，其他内容丢弃
create or replace function game_clean_uni_procs(p jsonb) returns jsonb language sql immutable as $$
  select case when p is null or jsonb_typeof(p) <> 'object' then null else (
    select coalesce(jsonb_object_agg(k, least(greatest(floor((p->>k)::numeric), 0), 100000)), '{}'::jsonb)
    from unnest(array['pounce','chain','dash','corner','maxChain']) k
    where jsonb_typeof(p->k) = 'number') end
$$;
drop function if exists heartbeat(bigint, uuid, integer, text, integer, integer, integer, integer, integer, integer, numeric, timestamptz, integer);
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
  p_client_ts timestamptz,
  p_ability_procs integer default null,
  p_uni_procs jsonb default null
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
  v_max_score_per_sec numeric;
begin
  select * into v_run from runs where id = p_run_id and client_id = p_client_id;
  if v_run.id is null or v_run.status <> 'in_progress' then
    return query select false, 'invalid_run', now();
    return;
  end if;

  v_max_score_per_sec := game_max_score_per_sec() * game_skill_rate_mult(v_run.skin, game_skill_stage(v_run.catches));

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
  if v_d_catches > 0 and (v_d_score < v_d_catches * game_min_score_per_catch() or v_d_score > v_d_catches * game_max_score_per_catch()) then
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
    catches_grey, catches_brown, catches_gold, combo_max, elapsed_seconds, suspicion_flags, ability_procs, uni_procs
  ) values (
    v_run.id, p_client_id, p_seq, 'heartbeat', p_client_ts, p_score, p_catches,
    p_catches_grey, p_catches_brown, p_catches_gold, p_combo_max, p_elapsed_seconds, v_flags, greatest(p_ability_procs, 0), game_clean_uni_procs(p_uni_procs)
  );

  if game_skill_stage(p_catches) > game_skill_stage(v_run.catches) then
    insert into score_events (run_id, client_id, seq, event_type, client_ts, score, catches, elapsed_seconds, stage)
    values (v_run.id, p_client_id, p_seq, 'stage_up', p_client_ts, p_score, p_catches, p_elapsed_seconds, game_skill_stage(p_catches));
  end if;

  return query select true, null::text, now();
end;
$$;

revoke execute on function heartbeat(
  bigint, uuid, integer, text, integer, integer, integer, integer, integer, integer, numeric, timestamptz, integer, jsonb
) from public;
grant execute on function heartbeat(
  bigint, uuid, integer, text, integer, integer, integer, integer, integer, integer, numeric, timestamptz, integer, jsonb
) to anon, authenticated;
