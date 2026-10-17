-- finish_run：玩家点击"结束本局"后的服务端最终结算。做比 heartbeat 严格得多
-- 的终局校验；校验失败也会把 runs.status 置为 finished（否则会被
-- abandon_stale_runs cron 当成异常重复处理）。
--
-- 关键信任边界（第二轮审核发现：原实现完全信任客户端提交的
-- p_final_score/p_final_catches/p_duration_seconds，可以直接伪造一个
-- 远超实际游玩情况的分数并把它写进 leaderboard_best）：
--   1) 时长不能明显超过服务端算出的已过时间（started_at 到 now()）。
--   2) 最终分数/捕获数不能比"最后一次被服务端接受的心跳"按理论最高速率
--      再往后推算出的上限还高。
--   3) 任何一条不满足时，不使用客户端提交的数字结算——而是按"最后一次被
--      接受心跳时的服务端状态"结算（分数/捕获数/时长全部来自 runs 表当时
--      已经校验过的值），既不会让作弊得分写进榜单，也不会让玩家已经被
--      服务端确认过的真实进度丢失。score_events 里仍然如实记录客户端这次
--      提交的原始数字（供 9.8 节的事后分析 SQL 用来定位异常），只是
--      runs/leaderboard_best 这两张"对外生效"的表不会采信它们。
create or replace function finish_run(
  p_run_id bigint,
  p_client_id uuid,
  p_final_score integer,
  p_final_catches integer,
  p_duration_seconds integer
)
returns table(ok boolean, rank bigint, reason text)
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
    return query select false, null::bigint, 'invalid_run';
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
    v_allowed_score := v_run.score + game_max_score_per_sec() * v_dt_since_hb + 30;
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

  if not v_valid then
    return query select false, null::bigint, v_reason;
    return;
  end if;

  select best_score into v_my_best from leaderboard_best where client_id = v_run.client_id;
  select count(*) + 1 into v_rank from leaderboard_best where best_score > v_my_best;

  return query select true, v_rank, null::text;
end;
$$;

revoke execute on function finish_run(bigint, uuid, integer, integer, integer) from public;
grant execute on function finish_run(bigint, uuid, integer, integer, integer) to anon, authenticated;
