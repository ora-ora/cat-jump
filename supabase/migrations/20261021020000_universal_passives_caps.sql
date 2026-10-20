-- 通用被动（飞扑 / 连环扑 / 顺势冲刺 / 墙角逼宫）：所有猫共享，等级同样由服务器已认可的抓捕数推算（game_skill_stage(runs.catches)）。
-- 宽松上限（未经平衡模拟）：
-- * 得分速率倍率额外 × 通用倍率 1.10（Lv1）→ 1.50（Lv5）：飞扑/连扑带来的额外抓捕 + 冲刺 ×1.5 速度留余量。
-- * 最短捕获间隔 0.06 → 0.04 秒（一次连扑最多 5 只，0.4s 窗口内连吃）。
-- 晕眩/减速（冲击波、墙角逼宫）不计分，无需额外上限。
create or replace function game_universal_rate_mult(p_stage integer) returns numeric
language sql immutable as $$ select (1.0 + 0.10 * least(greatest(p_stage, 1), 5))::numeric $$;

create or replace function game_skill_rate_mult(p_skin text, p_stage integer) returns numeric
language sql immutable as $$
  select ((1.05 + 0.10 * least(greatest(p_stage, 1), 5)
          + case when p_stage >= 5 then 0.15 else 0 end
          + case when p_skin = 'black' and p_stage >= 2 then 0.10 else 0 end)
         * game_universal_rate_mult(p_stage))::numeric
$$;

create or replace function game_min_catch_interval_seconds() returns numeric language sql immutable as $$ select 0.04::numeric $$;
