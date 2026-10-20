-- 进化技能（取代 6 个旧被动能力）：本局累计抓捕 0/15/40/80/150 → Lv1–Lv5。
-- * 服务器按自己已认可的抓捕数（runs.catches）推算等级，不信客户端上报的等级。
-- * 每款猫 × 每级一个得分速率倍率（宽松，未经平衡模拟），乘在 game_max_score_per_sec()（108）上。
-- * 心跳中等级提升时写一条 score_events(event_type='stage_up')，stage 列记录新等级。
create or replace function game_skill_stage(p_catches integer) returns integer
language sql immutable as $$
  select case when p_catches >= 150 then 5 when p_catches >= 80 then 4 when p_catches >= 40 then 3
              when p_catches >= 15 then 2 else 1 end
$$;

create or replace function game_skill_rate_mult(p_skin text, p_stage integer) returns numeric
language sql immutable as $$
  -- 基础：Lv1 1.15 → Lv5 1.55；Lv5 有群体大招（魔术秀/暴风雪/龙卷/合唱团/翻花绳/列车）的再 +0.15
  select (1.05 + 0.10 * least(greatest(p_stage, 1), 5)
          + case when p_stage >= 5 then 0.15 else 0 end
          + case when p_skin = 'black' and p_stage >= 2 then 0.10 else 0 end  -- 撞一个箱子一次吃 3 只
         )::numeric
$$;

alter table score_events drop constraint if exists score_events_event_type_check;
alter table score_events add constraint score_events_event_type_check
  check (event_type in ('start', 'heartbeat', 'pause', 'resume', 'finish', 'stage_up'));
alter table score_events add column if not exists stage integer;

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
  p_ability_procs integer default null
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
    catches_grey, catches_brown, catches_gold, combo_max, elapsed_seconds, suspicion_flags, ability_procs
  ) values (
    v_run.id, p_client_id, p_seq, 'heartbeat', p_client_ts, p_score, p_catches,
    p_catches_grey, p_catches_brown, p_catches_gold, p_combo_max, p_elapsed_seconds, v_flags, greatest(p_ability_procs, 0)
  );

  if game_skill_stage(p_catches) > game_skill_stage(v_run.catches) then
    insert into score_events (run_id, client_id, seq, event_type, client_ts, score, catches, elapsed_seconds, stage)
    values (v_run.id, p_client_id, p_seq, 'stage_up', p_client_ts, p_score, p_catches, p_elapsed_seconds, game_skill_stage(p_catches));
  end if;

  return query select true, null::text, now();
end;
$$;

create or replace function finish_run(
  p_run_id bigint,
  p_client_id uuid,
  p_final_score integer,
  p_final_catches integer,
  p_duration_seconds integer
)
returns table(ok boolean, rank bigint, reason text, final_score integer, adjusted boolean, run_rank bigint)
language plpgsql
security definer
set search_path = public
as $$
#variable_conflict use_column
declare
  v_run runs;
  v_valid boolean := true;
  v_reason text;
  v_my_best integer;
  v_rank bigint;
  v_run_rank bigint;
  v_server_elapsed numeric;
  v_dt_since_hb numeric;
  v_effective_duration numeric;
  v_allowed_score numeric;
  v_allowed_catches numeric;
  v_final_score integer;
  v_final_catches integer;
  v_final_duration integer;
  v_flags text[] := '{}';
begin
  select * into v_run from runs where id = p_run_id and client_id = p_client_id;
  if v_run.id is null or v_run.status <> 'in_progress' then
    return query select false, null::bigint, 'invalid_run', null::integer, null::boolean, null::bigint;
    return;
  end if;

  v_server_elapsed := extract(epoch from (now() - v_run.started_at));
  v_dt_since_hb := greatest(extract(epoch from (now() - v_run.last_heartbeat_at)), 0);
  -- 合理性校验统一用"客户端声称的时长"与"服务端已过时长"两者中较小的一个，
  -- 避免有人靠谎报很长的 duration 去撑大 catches 的允许上限。
  v_effective_duration := least(p_duration_seconds, v_server_elapsed);

  if p_duration_seconds < 5 or p_duration_seconds > 10800 then
    v_valid := false; v_reason := 'duration_out_of_range';
  elsif p_duration_seconds > v_server_elapsed + 5 then
    v_valid := false; v_reason := 'duration_exceeds_server_time';
  elsif p_final_catches < 0 or p_final_catches > (v_effective_duration / game_min_catch_interval_seconds()) then
    v_valid := false; v_reason := 'catches_out_of_range';
  elsif p_final_score > 0 and p_final_catches = 0 then
    v_valid := false; v_reason := 'score_without_catches';
  elsif p_final_score > p_final_catches * game_max_score_per_catch() then
    v_valid := false; v_reason := 'score_exceeds_cap';
  else
    -- 服务端信任边界：结算分数/捕获数不能比"最后一次被接受的心跳"再往后
    -- 按理论最高速率推算出的量 + 一点余量 涨得更多。
    v_allowed_score := v_run.score + game_max_score_per_sec() * game_skill_rate_mult(v_run.skin, game_skill_stage(v_run.catches)) * v_dt_since_hb + 30;
    v_allowed_catches := v_run.catches + ceil(v_dt_since_hb / game_min_catch_interval_seconds()) + 2;
    if p_final_score > v_allowed_score then
      v_valid := false; v_reason := 'score_exceeds_accepted_rate';
    elsif p_final_catches > v_allowed_catches then
      v_valid := false; v_reason := 'catches_exceeds_accepted_rate';
    end if;
  end if;

  if v_valid then
    v_final_score := p_final_score;
    v_final_catches := p_final_catches;
    v_final_duration := p_duration_seconds;
  else
    -- 不信任这次提交的数字：按最后一次被接受心跳时的服务端状态结算。
    v_flags := array_append(v_flags, v_reason);
    v_final_score := v_run.score;
    v_final_catches := v_run.catches;
    v_final_duration := greatest(5, round(extract(epoch from (v_run.last_heartbeat_at - v_run.started_at)))::int);
  end if;

  update runs
  set status = 'finished',
      finished_at = now(),
      score = v_final_score,
      catches = v_final_catches,
      duration_seconds = v_final_duration,
      suspicion_flags = array_cat(v_run.suspicion_flags, v_flags),
      suspicion_score = v_run.suspicion_score + coalesce(array_length(v_flags, 1), 0)
  where id = v_run.id;

  -- score_events 如实记录客户端这次提交的原始数字（即使不被采信），
  -- 供事后分析定位"声称 vs 实际结算"的差异。
  insert into score_events (
    run_id, client_id, seq, event_type, client_ts, score, catches, elapsed_seconds, suspicion_flags
  )
  values (
    v_run.id, p_client_id, v_run.last_seq + 1, 'finish', now(),
    p_final_score, p_final_catches, p_duration_seconds, v_flags
  );

  insert into leaderboard_best (client_id, nickname, best_score, best_duration_seconds, best_catches, updated_at)
  values (v_run.client_id, v_run.nickname, v_final_score, v_final_duration, v_final_catches, now())
  on conflict (client_id) do update
    set best_score = excluded.best_score,
        nickname = excluded.nickname,
        best_duration_seconds = excluded.best_duration_seconds,
        best_catches = excluded.best_catches,
        updated_at = excluded.updated_at
    where excluded.best_score > leaderboard_best.best_score;

  -- rank：按玩家历史最佳（这次写入/保留下来的 best_score）算的名次。
  -- run_rank：按*这一局*最终结算分算的名次——哪怕这一局没有刷新个人最佳
  -- （此时 v_final_score 可能小于 v_my_best），也按 v_final_score 本身
  -- 在全榜里能排第几算，不混用 v_my_best。
  select best_score into v_my_best from leaderboard_best where client_id = v_run.client_id;
  -- 名次统一取自 leaderboard_ranked（与公开排行榜同一排序：分数降序 → 先达到者在前 → client_id），
  -- 包含正在进行中的局，保证结算页名次 = 排行榜上的位置。
  select lr.rank into v_rank from leaderboard_ranked lr where lr.client_id = v_run.client_id;
  if v_final_score >= v_my_best then
    v_run_rank := v_rank;
  else
    -- 这一局分数是"刚刚达到"的，同分的人都比它早，排在它前面。
    select count(*) + 1 into v_run_rank from leaderboard_ranked lr
    where lr.display_score >= v_final_score;  -- 含自己的历史最佳（必然更高），与旧语义一致
  end if;

  return query select true, v_rank, (case when v_valid then null else v_reason end), v_final_score, (not v_valid), v_run_rank;
end;
$$;

drop function if exists game_skin_rate_mult(text);
