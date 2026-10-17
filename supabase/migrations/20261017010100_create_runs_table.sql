-- 一局的会话记录：开局（start_run）时创建一行，游玩期间被心跳（heartbeat）持续更新，
-- 结束（finish_run）或超时收尾（abandon_stale_runs cron）时写终态。
-- 行数 = 开局次数，不是心跳次数，增长速度远小于 score_events。
create table if not exists runs (
  id bigint generated always as identity primary key,
  client_id uuid not null,
  nickname text not null,
  started_at timestamptz not null default now(),
  status text not null default 'in_progress'
    check (status in ('in_progress', 'finished', 'abandoned')),
  play_status text not null default 'playing'
    check (play_status in ('playing', 'paused')),
  last_seq integer not null default 0,
  score integer not null default 0,
  catches integer not null default 0,
  last_heartbeat_at timestamptz not null default now(),
  finished_at timestamptz,
  duration_seconds integer,
  suspicion_flags text[] not null default '{}',
  suspicion_score integer not null default 0
);

create index if not exists idx_runs_client_status on runs (client_id, status);
create index if not exists idx_runs_status_heartbeat on runs (status, last_heartbeat_at);
