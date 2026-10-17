-- 第三轮审核：finish_run() 校验失败时其实已经按"最后一次被接受心跳"的服务端
-- 状态结算并写入了 leaderboard_best（见 20261017010800 的设计），但返回的
-- 是 ok=false/rank=null，前端据此显示"未能连接排行榜，成绩未上传"——这是
-- 错的，成绩明明已经被记录了，只是被调整过，不是没有上传。
--
-- 这里改成返回 (ok, rank, reason, final_score, adjusted) 五列：
--   - 真正的失败（run_id/client_id 对不上，或这局已经不是 in_progress）：
--     ok=false，rank/final_score/adjusted 都是 null。
--   - 校验通过、按客户端提交的数字原样结算：ok=true, adjusted=false,
--     reason=null, final_score=客户端提交的分数, rank=对应名次。
--   - 校验不通过、按最后一次被接受心跳的状态结算：ok=true, adjusted=true,
--     reason=命中的校验规则名, final_score=服务器结算分, rank=按结算分
--     算出的名次。
-- 返回列变了，CREATE OR REPLACE 不支持改返回类型，要先 drop 再建，这会
-- 清空函数的 EXECUTE 授权，所以最后要重新 revoke/grant。
drop function if exists finish_run(bigint, uuid, integer, integer, integer);

create function finish_run(
  p_run_id bigint,
  p_client_id uuid,
  p_final_score integer,
  p_final_catches integer,
  p_duration_seconds integer
)
returns table(ok boolean, rank bigint, reason text, final_score integer, adjusted boolean)
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
    return query select false, null::bigint, 'invalid_run', null::integer, null::boolean;
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

  -- 不管这次提交有没有被采信，run 已经有了确定的最终状态，名次按
  -- "服务器实际结算的分数"算出来再一起返回——被调整过也应该告诉玩家
  -- 他现在排第几，而不是因为不信任这次提交就什么都不说。
  select best_score into v_my_best from leaderboard_best where client_id = v_run.client_id;
  select count(*) + 1 into v_rank from leaderboard_best where best_score > v_my_best;

  return query select true, v_rank, (case when v_valid then null else v_reason end), v_final_score, (not v_valid);
end;
$$;

revoke execute on function finish_run(bigint, uuid, integer, integer, integer) from public;
grant execute on function finish_run(bigint, uuid, integer, integer, integer) to anon, authenticated;
