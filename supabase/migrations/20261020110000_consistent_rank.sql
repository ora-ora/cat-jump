-- 统一名次口径：分数降序 → 先达到该分数者在前（achieved_at 升序）→ client_id（仅作确定性兜底，不对外暴露）。
-- 之前 finish_run 用"严格比我高的人数+1"（并列同名次，且不含进行中的局），
-- 而排行榜按 display_score 排序、并列顺序不确定且包含进行中的局，导致结算页名次与榜上位置不一致。

alter table runs add column if not exists score_changed_at timestamptz not null default now();
create or replace function runs_touch_score_changed_at() returns trigger
language plpgsql set search_path = public as $$
begin
  if new.score is distinct from old.score then new.score_changed_at := now(); end if;
  return new;
end;
$$;
drop trigger if exists trg_runs_score_changed_at on runs;
create trigger trg_runs_score_changed_at before update on runs
  for each row execute function runs_touch_score_changed_at();
revoke all on function runs_touch_score_changed_at() from public, anon, authenticated;

-- 内部视图（含 client_id，不授权给 anon）：唯一、确定的名次。
create or replace view leaderboard_ranked as
select t.*, row_number() over (order by t.display_score desc, t.achieved_at asc, t.client_id asc) as rank
from (with live_runs as (
  select client_id, nickname, score, play_status, last_heartbeat_at, skin, score_changed_at
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
       else lb.updated_at end as achieved_at
from leaderboard_best lb
full outer join live_runs r
  on r.client_id = lb.client_id) t;
revoke all on leaderboard_ranked from public, anon, authenticated;

-- 公开视图：原有列顺序不变，末尾追加 achieved_at、rank（仍不暴露 client_id）。
create or replace view leaderboard_live as
select nickname, display_score, live_score, is_live, is_paused, skin, achieved_at, rank
from leaderboard_ranked;
grant select on leaderboard_live to anon, authenticated;

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
