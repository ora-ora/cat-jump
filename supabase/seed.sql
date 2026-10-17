-- 仅本地 `supabase db reset` / CI（supabase db start）用的演示数据。
-- 全部为虚构测试数据，绝不含真实玩家信息；`supabase db push` 不会把本文件
-- 推送到生产（db push 只应用 migrations/）。
insert into leaderboard_best (client_id, nickname, best_score, best_duration_seconds, best_catches, updated_at)
values
  ('00000000-0000-0000-0000-000000000001', '测试猫1', 320, 180, 28, now()),
  ('00000000-0000-0000-0000-000000000002', '测试猫2', 150, 90, 12, now()),
  ('00000000-0000-0000-0000-000000000003', '测试猫3', 80, 60, 7, now())
on conflict (client_id) do nothing;
