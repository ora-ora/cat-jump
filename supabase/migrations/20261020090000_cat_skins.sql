-- 小猫皮肤（纯外观）：runs/leaderboard_best 增加 skin 列，start_run 增加可选
-- p_skin 参数（旧前端不传也照常工作），leaderboard_live 末尾暴露 skin。
alter table runs add column if not exists skin text not null default 'orange'
  check (skin in ('orange','black','white','calico','blue','siamese'));
alter table leaderboard_best add column if not exists skin text not null default 'orange'
  check (skin in ('orange','black','white','calico','blue','siamese'));

-- leaderboard_best 有 start_run/finish_run/cron 三处写入，用触发器统一把
-- skin 同步成该玩家最近一局的选择，避免改动三处计分逻辑。
create or replace function leaderboard_best_sync_skin() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  new.skin := coalesce(
    (select r.skin from runs r where r.client_id = new.client_id order by r.started_at desc limit 1),
    new.skin, 'orange');
  return new;
end;
$$;
drop trigger if exists trg_leaderboard_best_skin on leaderboard_best;
create trigger trg_leaderboard_best_skin before insert or update on leaderboard_best
  for each row execute function leaderboard_best_sync_skin();
revoke all on function leaderboard_best_sync_skin() from public, anon, authenticated;

drop function if exists start_run(uuid, text);

create or replace function start_run(p_client_id uuid, p_nickname text, p_skin text default 'orange')
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
  v_skin text;
begin
  -- 皮肤纯外观，不影响计分；非法值回退 orange，不拒绝开局。
  v_skin := case when p_skin in ('orange','black','white','calico','blue','siamese') then p_skin else 'orange' end;
  -- 先用*原始*输入检查敏感词（这时候 !/@/$ 等符号还没被白名单删掉，leet
  -- 替换才有意义）；没命中再做白名单清洗（只留 ASCII 字母数字、CJK 统一
  -- 表意文字一(U+4E00)-鿿(U+9FFF)、空格、下划线、短横线），清洗完再查一次
  -- （清洗可能把原本被符号隔开的词粘到一起）；折叠连续空白；**先查后
  -- 截断**——顺序反过来会把词正好切在中间漏判（上一轮已修）。命中或结果
  -- 为空都回退默认昵称。不会因为昵称问题拒绝开局。两处改一处记得同步
  -- web/game.js 的 normalizeForOffensiveCheck()/isNicknameOffensive()。
  v_nickname := coalesce(p_nickname, '');
  if nickname_is_offensive(v_nickname) then
    v_nickname := '';
  else
    v_nickname := regexp_replace(v_nickname, '[^a-zA-Z0-9_ 一-鿿-]', '', 'g');
    v_nickname := btrim(regexp_replace(v_nickname, '\s+', ' ', 'g'));
    if nickname_is_offensive(v_nickname) then
      v_nickname := '';
    end if;
  end if;
  v_nickname := left(v_nickname, 12);
  if v_nickname = '' then
    v_nickname := '匿名猫' || floor(random() * 10000)::int;
  end if;

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

  insert into runs (client_id, nickname, skin)
  values (p_client_id, v_nickname, v_skin)
  returning id, started_at into v_run_id, v_started_at;

  insert into score_events (run_id, client_id, seq, event_type, client_ts, score, catches, elapsed_seconds)
  values (v_run_id, p_client_id, 0, 'start', now(), 0, 0, 0);

  -- 历史最佳行的头像跟随玩家最近一次选择（触发器会从 runs 取最新 skin）。
  update leaderboard_best set skin = v_skin where client_id = p_client_id;

  return query select true, v_run_id, v_started_at, null::text;
end;
$$;

revoke all on function start_run(uuid, text, text) from public;
grant execute on function start_run(uuid, text, text) to anon, authenticated;

-- 视图加列只能追加在末尾（create or replace view 要求），保持原有列不变。
create or replace view leaderboard_live as
with live_runs as (
  select client_id, nickname, score, play_status, last_heartbeat_at, skin
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
  coalesce(r.skin, lb.skin, 'orange') as skin
from leaderboard_best lb
full outer join live_runs r
  on r.client_id = lb.client_id;

grant select on leaderboard_live to anon, authenticated;
