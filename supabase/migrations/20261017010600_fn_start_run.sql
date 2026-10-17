-- start_run：开局时创建一个 runs 会话行，服务端生成 run_id 与服务端开始时间。
-- 规则对应 PLAN.md 9.4 节：昵称过滤与兜底、并发保护（同一 client_id 不能同时有
-- 两个 in_progress 的局）、24 小时开局频率限制。
create or replace function start_run(p_client_id uuid, p_nickname text)
returns table(ok boolean, run_id bigint, started_at timestamptz, reason text)
language plpgsql
security definer
set search_path = public
as $$
#variable_conflict use_column
declare
  v_nickname text;
  v_existing runs;
  v_run_id bigint;
  v_started_at timestamptz;
  v_recent_count integer;
begin
  -- 昵称过滤：只去掉控制字符、裁剪长度，为空则回退为默认昵称；不会因为昵称问题拒绝开局。
  v_nickname := regexp_replace(coalesce(p_nickname, ''), '[[:cntrl:]]', '', 'g');
  v_nickname := btrim(v_nickname);
  if v_nickname = '' then
    v_nickname := '匿名猫' || floor(random() * 10000)::int;
  end if;
  v_nickname := left(v_nickname, 12);

  select * into v_existing
  from runs
  where client_id = p_client_id and status = 'in_progress'
  order by started_at desc
  limit 1;

  if v_existing.id is not null then
    if v_existing.last_heartbeat_at > now() - interval '10 seconds' then
      return query select false, null::bigint, null::timestamptz, 'already_playing';
      return;
    end if;

    -- 上一局大概率异常退出（关标签页但 finish_run 没发出去），自愈收尾：
    -- 标记为 abandoned 并把当时已知的分数计入历史最佳，再继续创建新局。
    update runs
    set status = 'abandoned',
        finished_at = now(),
        duration_seconds = extract(epoch from (v_existing.last_heartbeat_at - v_existing.started_at))::int
    where id = v_existing.id;

    insert into leaderboard_best (client_id, nickname, best_score, best_duration_seconds, best_catches, updated_at)
    values (
      v_existing.client_id, v_existing.nickname, v_existing.score,
      extract(epoch from (v_existing.last_heartbeat_at - v_existing.started_at))::int,
      v_existing.catches, now()
    )
    on conflict (client_id) do update
      set best_score = excluded.best_score,
          nickname = excluded.nickname,
          best_duration_seconds = excluded.best_duration_seconds,
          best_catches = excluded.best_catches,
          updated_at = excluded.updated_at
      where excluded.best_score > leaderboard_best.best_score;
  end if;

  select count(*) into v_recent_count
  from runs
  where client_id = p_client_id and started_at > now() - interval '1 day';

  if v_recent_count >= 50 then
    return query select false, null::bigint, null::timestamptz, 'rate_limited';
    return;
  end if;

  insert into runs (client_id, nickname)
  values (p_client_id, v_nickname)
  returning id, started_at into v_run_id, v_started_at;

  insert into score_events (run_id, client_id, seq, event_type, client_ts, score, catches, elapsed_seconds)
  values (v_run_id, p_client_id, 0, 'start', now(), 0, 0, 0);

  return query select true, v_run_id, v_started_at, null::text;
end;
$$;

-- CREATE FUNCTION 默认会把 EXECUTE 权限隐式授予 PUBLIC，先收回再只授权给
-- anon/authenticated，避免这个 SECURITY DEFINER 函数被其他角色意外调用。
revoke execute on function start_run(uuid, text) from public;
grant execute on function start_run(uuid, text) to anon, authenticated;
