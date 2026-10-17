-- 心跳/结算校验用到的几个阈值常量，提取成 immutable SQL 函数，
-- 保证 heartbeat()/finish_run() 两处（以及以后新增的校验）用的是同一个值，
-- 不会因为复制粘贴漂移出不一致的数字。纯常量、无副作用，不需要限制 EXECUTE 权限。
create or replace function game_max_score_per_sec() returns numeric
language sql
immutable
as $$
  -- 金老鼠满难度分值(约75) × 连击倍率上限(3) / 理论最快连续捕获间隔(0.15s)
  -- 量级，留出余量取整为常量，实现阶段可按实际数值重新核算。
  select 60::numeric
$$;

create or replace function game_min_catch_interval_seconds() returns numeric
language sql
immutable
as $$
  select 0.15::numeric
$$;

create or replace function game_min_score_per_catch() returns numeric
language sql
immutable
as $$
  select 5::numeric
$$;

create or replace function game_max_score_per_catch() returns numeric
language sql
immutable
as $$
  select 250::numeric
$$;
