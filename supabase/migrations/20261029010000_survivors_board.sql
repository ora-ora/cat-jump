-- 守卫战（survivors）独立排行榜：新表 surv_runs + RPC surv_start / surv_finish + 视图 surv_board。
-- 旧经典榜（runs / leaderboard_best / leaderboard_live）不动，继续可读。
-- 分数由服务器按分量计算：存活秒×100 + 击杀×10 + 等级×50 + 黎明 +2000（坚持）/ +5000（击杀鼠王）。
-- 上限（对合法上限留足余量）：存活秒 ≤ 开局墙钟 + 3 且 ≤ 660；击杀 ≤ 50 + 600/分钟（墙钟）；等级 ≤ 80；
-- 击杀鼠王需存活 ≥ 575s，坚持胜利需 ≥ 635s。超限直接拒绝（不入榜）。
create table if not exists surv_runs (
  id bigint generated always as identity primary key,
  client_id uuid not null,
  nickname text not null,
  skin text not null default 'orange',
  started_at timestamptz not null default now(),
  finished_at timestamptz,
  status text not null default 'in_progress' check (status in ('in_progress','finished','rejected')),
  time_s integer, kills integer, level integer, boss text, score integer,
  reject_reason text
);
create index if not exists surv_runs_client_idx on surv_runs (client_id, started_at desc);
create index if not exists surv_runs_board_idx on surv_runs (status, score desc);
alter table surv_runs enable row level security;
revoke all on surv_runs from anon, authenticated;

create or replace function surv_start(p_client_id uuid, p_nickname text, p_skin text default 'orange')
returns table(ok boolean, run_id bigint, reason text)
language plpgsql security definer set search_path = public as $$
declare v_nick text; v_skin text; v_n integer; v_id bigint;
begin
  v_skin := case when p_skin in ('orange','black','white','calico','blue','siamese') then p_skin else 'orange' end;
  v_nick := coalesce(p_nickname, '');
  if nickname_is_offensive(v_nick) then v_nick := '';
  else
    v_nick := btrim(regexp_replace(regexp_replace(v_nick, '[^a-zA-Z0-9_ 一-鿿-]', '', 'g'), '\s+', ' ', 'g'));
    if nickname_is_offensive(v_nick) then v_nick := ''; end if;
  end if;
  v_nick := left(v_nick, 12);
  if v_nick = '' then v_nick := '匿名猫' || floor(random() * 10000)::int; end if;
  select count(*) into v_n from surv_runs where client_id = p_client_id and started_at > now() - interval '1 hour';
  if v_n >= 40 then return query select false, null::bigint, 'too_many_runs'; return; end if;
  insert into surv_runs (client_id, nickname, skin) values (p_client_id, v_nick, v_skin) returning id into v_id;
  return query select true, v_id, null::text;
end $$;

create or replace function surv_finish(p_run_id bigint, p_client_id uuid, p_time_s integer, p_kills integer, p_level integer, p_boss text default 'none')
returns table(ok boolean, reason text, final_score integer, rank bigint)
language plpgsql security definer set search_path = public as $$
declare v_run surv_runs; v_wall numeric; v_reason text; v_boss text; v_score integer; v_rank bigint;
begin
  select * into v_run from surv_runs where id = p_run_id and client_id = p_client_id;
  if v_run.id is null or v_run.status <> 'in_progress' then return query select false, 'invalid_run', null::integer, null::bigint; return; end if;
  v_wall := extract(epoch from (now() - v_run.started_at));
  v_boss := case when p_boss in ('killed','survived') then p_boss else 'none' end;
  if p_time_s is null or p_kills is null or p_level is null or p_time_s < 0 or p_kills < 0 or p_level < 1 then v_reason := 'bad_input';
  elsif v_wall > 3 * 3600 then v_reason := 'run_expired';
  elsif p_time_s > v_wall + 3 or p_time_s > 660 then v_reason := 'time_over_cap';
  elsif p_kills > 50 + 600 * v_wall / 60 then v_reason := 'kills_over_cap';
  elsif p_level > 80 then v_reason := 'level_over_cap';
  elsif v_boss = 'killed' and p_time_s < 575 then v_reason := 'boss_too_early';
  elsif v_boss = 'survived' and p_time_s < 635 then v_reason := 'dawn_too_early';
  end if;
  if v_reason is not null then
    update surv_runs set status = 'rejected', reject_reason = v_reason, finished_at = now() where id = v_run.id;
    return query select false, v_reason, null::integer, null::bigint; return;
  end if;
  v_score := p_time_s * 100 + p_kills * 10 + p_level * 50 + case v_boss when 'killed' then 5000 when 'survived' then 2000 else 0 end;
  update surv_runs set status = 'finished', finished_at = now(), time_s = p_time_s, kills = p_kills, level = p_level, boss = v_boss, score = v_score where id = v_run.id;
  select count(*) + 1 into v_rank from (
    select client_id, max(score) s from surv_runs where status = 'finished' group by client_id
  ) b where b.s > v_score;
  return query select true, null::text, v_score, v_rank;
end $$;

revoke all on function surv_start(uuid, text, text) from public;
revoke all on function surv_finish(bigint, uuid, integer, integer, integer, text) from public;
grant execute on function surv_start(uuid, text, text) to anon, authenticated;
grant execute on function surv_finish(bigint, uuid, integer, integer, integer, text) to anon, authenticated;

-- 每个 client 取最高分一行
create or replace view surv_board with (security_invoker = false) as
select nickname, score as display_score, skin, boss, time_s, kills, level,
       rank() over (order by score desc, finished_at asc) as rank,
       id as live_run_id, null::text as country, false as is_live, false as is_paused, finished_at as achieved_at
from (
  select distinct on (client_id) * from surv_runs where status = 'finished'
  order by client_id, score desc, finished_at asc
) b;
grant select on surv_board to anon, authenticated;

-- 清理：未结束超过 1 天的、被拒绝超过 7 天的
do $$ begin
  if exists (select 1 from pg_extension where extname = 'pg_cron') then
    perform cron.schedule('surv_runs_cleanup', '17 4 * * *',
      $c$delete from surv_runs where (status = 'in_progress' and started_at < now() - interval '1 day') or (status = 'rejected' and finished_at < now() - interval '7 days')$c$);
  end if;
end $$;
