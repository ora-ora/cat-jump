-- 时间序列：每次心跳（以及 start/finish 等关键事件）写一行，只用于事后反作弊分析，
-- 不对外公开读取，是真正的高频写入表。容量/保留估算见 PLAN.md 9.7 节。
create table if not exists score_events (
  id bigint generated always as identity primary key,
  run_id bigint not null references runs (id) on delete cascade,
  client_id uuid not null,
  seq integer not null,
  event_type text not null default 'heartbeat'
    check (event_type in ('start', 'heartbeat', 'pause', 'resume', 'finish')),
  server_ts timestamptz not null default now(),
  client_ts timestamptz not null,
  score integer not null,
  catches integer not null,
  catches_grey integer not null default 0,
  catches_brown integer not null default 0,
  catches_gold integer not null default 0,
  combo_max integer not null default 0,
  elapsed_seconds numeric(8, 2) not null,
  suspicion_flags text[] not null default '{}'
);

create index if not exists idx_score_events_run_ts on score_events (run_id, server_ts);
create index if not exists idx_score_events_client_ts on score_events (client_id, server_ts desc);
