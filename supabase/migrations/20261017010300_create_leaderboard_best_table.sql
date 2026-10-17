-- 每个匿名玩家(client_id)的历史最佳成绩：公开排行榜排序的"基准"数据，
-- 只在 finish_run() / abandon_stale_runs cron 里写入。
create table if not exists leaderboard_best (
  client_id uuid primary key,
  nickname text not null,
  best_score integer not null,
  best_duration_seconds integer not null,
  best_catches integer not null,
  updated_at timestamptz not null default now()
);

create index if not exists idx_leaderboard_best_score_desc on leaderboard_best (best_score desc);
