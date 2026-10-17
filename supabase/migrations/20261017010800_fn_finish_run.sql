-- finish_run：玩家点击"结束本局"后的服务端最终结算。做比 heartbeat 严格得多
-- 的终局校验；校验失败也会把 runs.status 置为 finished（否则会被
-- abandon_stale_runs cron 当成异常重复处理），只是不会写入 leaderboard_best。
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
declare
  v_run runs;
  v_valid boolean := true;
  v_reason text;
  v_my_best integer;
  v_rank bigint;
begin
  select * into v_run from runs where id = p_run_id and client_id = p_client_id;
  if v_run.id is null or v_run.status <> 'in_progress' then
    return query select false, null::bigint, 'invalid_run';
    return;
  end if;

  if p_duration_seconds < 5 or p_duration_seconds > 10800 then
    v_valid := false; v_reason := 'duration_out_of_range';
  elsif p_final_catches < 0 or p_final_catches > (p_duration_seconds / 0.15) then
    v_valid := false; v_reason := 'catches_out_of_range';
  elsif p_final_score > 0 and p_final_catches = 0 then
    v_valid := false; v_reason := 'score_without_catches';
  elsif p_final_score > p_final_catches * 250 then
    v_valid := false; v_reason := 'score_exceeds_cap';
  end if;

  update runs
  set status = 'finished',
      finished_at = now(),
      score = p_final_score,
      catches = p_final_catches,
      duration_seconds = p_duration_seconds
  where id = v_run.id;

  insert into score_events (run_id, client_id, seq, event_type, client_ts, score, catches, elapsed_seconds)
  values (v_run.id, p_client_id, v_run.last_seq + 1, 'finish', now(), p_final_score, p_final_catches, p_duration_seconds);

  if not v_valid then
    return query select false, null::bigint, v_reason;
    return;
  end if;

  insert into leaderboard_best (client_id, nickname, best_score, best_duration_seconds, best_catches, updated_at)
  values (v_run.client_id, v_run.nickname, p_final_score, p_duration_seconds, p_final_catches, now())
  on conflict (client_id) do update
    set best_score = excluded.best_score,
        nickname = excluded.nickname,
        best_duration_seconds = excluded.best_duration_seconds,
        best_catches = excluded.best_catches,
        updated_at = excluded.updated_at
    where excluded.best_score > leaderboard_best.best_score;

  select best_score into v_my_best from leaderboard_best where client_id = v_run.client_id;
  select count(*) + 1 into v_rank from leaderboard_best where best_score > v_my_best;

  return query select true, v_rank, null::text;
end;
$$;

grant execute on function finish_run(bigint, uuid, integer, integer, integer) to anon, authenticated;
