-- 地图/老鼠窝/昼夜：
-- * 昼夜周期 196s（白天 120 · 黄昏 8 · 夜晚 60 · 黎明 8），夜晚（含过渡）得分速率上限 ×1.5，由服务器墙钟推算（见 heartbeat 注释）。
-- * 心跳新增可选参数 p_nests_destroyed（本局累计摧毁老鼠窝数，每个 +30 分不吃连击）；超出时长上限拒绝。旧客户端不传也能用。
-- 数值为初始值，未经平衡。
alter table runs add column if not exists nests_destroyed integer not null default 0;
alter table score_events add column if not exists nests_destroyed integer;
create or replace function game_day_cycle_seconds() returns numeric language sql immutable as $$ select 196::numeric $$;
create or replace function game_is_night(p_sec numeric) returns boolean language sql immutable as $$ select mod(greatest(p_sec, 0), game_day_cycle_seconds()) >= 120 $$;
create or replace function game_night_rate_mult() returns numeric language sql immutable as $$ select 1.5::numeric $$;
create or replace function game_nest_score() returns integer language sql immutable as $$ select 30 $$;
drop function if exists heartbeat(bigint, uuid, integer, text, integer, integer, integer, integer, integer, integer, numeric, timestamptz, integer, jsonb);
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
  p_uni_procs jsonb default null,
  p_nests_destroyed integer default null
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
  v_night boolean;
  v_d_nests integer := 0;
  v_nest_cap integer;
  v_wall numeric;
  v_claim numeric;
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
  -- 昼夜：服务器按开局后的墙钟时间推算；客户端游戏时长（暂停不走）截断到墙钟时间以内，两者任一处于夜晚（含黄昏/黎明）就按夜晚 ×1.5
  v_wall := extract(epoch from (now() - v_run.started_at));
  v_claim := least(greatest(coalesce(p_elapsed_seconds, 0), 0), v_wall);
  v_night := game_is_night(v_wall) or game_is_night(v_claim) or game_is_night(greatest(v_claim - v_dt_secs, 0));
  if v_night then v_max_score_per_sec := v_max_score_per_sec * game_night_rate_mult(); end if;
  -- 摧毁老鼠窝：可选参数；上限 = 10 + 10 × floor(墙钟时长 / 48s)（3s 蹲 + 45s 重生），开局 20s 内为 0
  if p_nests_destroyed is not null then
    v_nest_cap := case when v_wall < 20 then 0 else 10 + 10 * floor(v_wall / 48)::int end;
    if p_nests_destroyed > v_nest_cap or p_nests_destroyed < coalesce(v_run.nests_destroyed, 0) then
      return query select false, 'nests_over_cap', now();
      return;
    end if;
    v_d_nests := p_nests_destroyed - coalesce(v_run.nests_destroyed, 0);
  end if;
  if v_d_score > v_max_score_per_sec * v_dt_secs + v_d_nests * game_nest_score() then
    return query select false, 'score_rate_exceeded', now();
    return;
  end if;

  -- 以下只打标记，不拒绝写入。
  v_d_catches := p_catches - v_run.catches;
  if v_d_catches > 0 and (v_d_score - v_d_nests * game_nest_score() < v_d_catches * game_min_score_per_catch() or v_d_score - v_d_nests * game_nest_score() > v_d_catches * game_max_score_per_catch()) then
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
      nests_destroyed = greatest(coalesce(v_run.nests_destroyed, 0), coalesce(p_nests_destroyed, 0)),
      last_seq = p_seq,
      last_heartbeat_at = now(),
      play_status = v_play_status,
      suspicion_flags = array_cat(v_run.suspicion_flags, v_flags),
      suspicion_score = v_run.suspicion_score + coalesce(array_length(v_flags, 1), 0)
  where id = v_run.id;

  insert into score_events (
    run_id, client_id, seq, event_type, client_ts, score, catches,
    catches_grey, catches_brown, catches_gold, combo_max, elapsed_seconds, suspicion_flags, ability_procs, uni_procs, nests_destroyed
  ) values (
    v_run.id, p_client_id, p_seq, 'heartbeat', p_client_ts, p_score, p_catches,
    p_catches_grey, p_catches_brown, p_catches_gold, p_combo_max, p_elapsed_seconds, v_flags, greatest(p_ability_procs, 0), game_clean_uni_procs(p_uni_procs), p_nests_destroyed
  );

  if game_skill_stage(p_catches) > game_skill_stage(v_run.catches) then
    insert into score_events (run_id, client_id, seq, event_type, client_ts, score, catches, elapsed_seconds, stage)
    values (v_run.id, p_client_id, p_seq, 'stage_up', p_client_ts, p_score, p_catches, p_elapsed_seconds, game_skill_stage(p_catches));
  end if;

  return query select true, null::text, now();
end;
$$;
revoke execute on function heartbeat(
  bigint, uuid, integer, text, integer, integer, integer, integer, integer, integer, numeric, timestamptz, integer, jsonb, integer
) from public;
grant execute on function heartbeat(
  bigint, uuid, integer, text, integer, integer, integer, integer, integer, integer, numeric, timestamptz, integer, jsonb, integer
) to anon, authenticated;
