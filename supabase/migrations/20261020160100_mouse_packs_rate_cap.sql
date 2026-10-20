-- 老鼠密度提高、新增鼠群（同屏上限 5–10 → 10–18，约 1.8 倍），每秒得分基础上限按同比例从 60 提到 108。
-- 皮肤倍率（game_skin_rate_mult）不变；cheat.sql 中的明显作弊（2 秒 99999 分）仍会被拒绝。
create or replace function game_max_score_per_sec() returns numeric
language sql
immutable
as $$
  select 108::numeric
$$;
