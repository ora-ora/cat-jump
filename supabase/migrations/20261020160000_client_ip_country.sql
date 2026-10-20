-- 记录玩家 IP 与国家：
-- * 探针结果（20261020150000）：Supabase 经 Cloudflare 转发，PostgREST 的 request.headers 里有
--   cf-ipcountry（国家码）、sb-forwarded-for / x-real-ip / cf-connecting-ip / x-forwarded-for。
-- * IP 只存在私有表 run_client_info（开 RLS、无任何策略、对 anon/authenticated 收回全部权限），任何公开视图都不暴露。
-- * 国家码直接取 cf-ipcountry（不需要外部 GeoIP 服务或密钥），只把两位国家码放进 runs/leaderboard_best 和排行榜视图。
drop function if exists probe_request_geo();

create table if not exists run_client_info (
  run_id bigint primary key references runs(id) on delete cascade,
  client_id uuid not null,
  ip inet,
  country text,
  created_at timestamptz not null default now()
);
alter table run_client_info enable row level security;
revoke all on run_client_info from public, anon, authenticated;
create index if not exists run_client_info_client_idx on run_client_info (client_id);
create index if not exists run_client_info_ip_idx on run_client_info (ip);

alter table runs add column if not exists country text check (country ~ '^[A-Z]{2}$');
alter table leaderboard_best add column if not exists country text check (country ~ '^[A-Z]{2}$');

create or replace function request_header(p_name text) returns text
language plpgsql stable set search_path = public as $$
begin
  return nullif(btrim(coalesce(nullif(current_setting('request.headers', true), ''), '{}')::json->>p_name), '');
exception when others then
  return null; -- 头信息缺失/格式异常时绝不影响开局
end;
$$;
revoke all on function request_header(text) from public, anon, authenticated;

create or replace function request_client_ip() returns inet
language plpgsql stable set search_path = public as $$
declare v text;
begin
  v := coalesce(request_header('sb-forwarded-for'), request_header('x-real-ip'),
                request_header('cf-connecting-ip'), request_header('x-forwarded-for'));
  v := btrim(split_part(v, ',', 1));
  if v is null or v = '' then return null; end if;
  return v::inet;
exception when others then
  return null;
end;
$$;
revoke all on function request_client_ip() from public, anon, authenticated;

create or replace function request_country() returns text
language sql stable set search_path = public as $$
  select case when c ~ '^[A-Z]{2}$' and c not in ('XX', 'T1') then c else null end
  from (select upper(request_header('cf-ipcountry')) as c) z
$$;
revoke all on function request_country() from public, anon, authenticated;

-- start_run 插入 runs 时由触发器补国家码并写私有 IP 记录，start_run 本身不用改。
create or replace function runs_capture_client_info() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if tg_op = 'INSERT' and new.country is null then
    new.country := request_country();
  end if;
  return new;
end;
$$;
create or replace function runs_store_client_ip() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  insert into run_client_info (run_id, client_id, ip, country)
  values (new.id, new.client_id, request_client_ip(), new.country)
  on conflict (run_id) do nothing;
  return null;
end;
$$;
revoke all on function runs_capture_client_info() from public, anon, authenticated;
revoke all on function runs_store_client_ip() from public, anon, authenticated;
drop trigger if exists trg_runs_capture_client_info on runs;
create trigger trg_runs_capture_client_info before insert on runs
  for each row execute function runs_capture_client_info();
drop trigger if exists trg_runs_store_client_ip on runs;
create trigger trg_runs_store_client_ip after insert on runs
  for each row execute function runs_store_client_ip();

-- leaderboard_best：沿用皮肤同步触发器，国家码同步为该玩家最近一局（有国家码的）那一局。
create or replace function leaderboard_best_sync_skin() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  new.skin := coalesce(
    (select r.skin from runs r where r.client_id = new.client_id order by r.started_at desc limit 1),
    new.skin, 'orange');
  new.country := coalesce(
    (select r.country from runs r where r.client_id = new.client_id and r.country is not null order by r.started_at desc limit 1),
    new.country);
  return new;
end;
$$;

create or replace view leaderboard_ranked as
select t.nickname, t.display_score, t.live_score, t.is_live, t.is_paused, t.skin, t.client_id, t.achieved_at,
  row_number() over (order by t.display_score desc, t.achieved_at asc, t.client_id asc) as rank,
  t.live_run_id, t.country
from (with live_runs as (
  select id, client_id, nickname, score, play_status, last_heartbeat_at, skin, score_changed_at, country
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
       else lb.updated_at end as achieved_at,
  r.id as live_run_id,
  coalesce(r.country, lb.country) as country
from leaderboard_best lb
full outer join live_runs r
  on r.client_id = lb.client_id) t;
revoke all on leaderboard_ranked from public, anon, authenticated;

create or replace view leaderboard_live as
select nickname, display_score, live_score, is_live, is_paused, skin, achieved_at, rank, live_run_id, country
from leaderboard_ranked;
grant select on leaderboard_live to anon, authenticated;
