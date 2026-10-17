-- 第三轮审核：原 start_run() 的敏感词黑名单只覆盖中文与"仿冒管理员"类关键词，
-- 没有英文脏话/侮辱/歧视词过滤。20261017010600_fn_start_run.sql 已经部署过，
-- 按迁移纪律不再修改那个文件，这里用 create or replace 重新定义 start_run()
-- （签名不变，所以不需要 drop，原有的 EXECUTE 授权也会随函数一起保留）。
--
-- 新增 nickname_is_offensive(text)：规范化（转小写、去掉常见分隔符、leet 替
-- 换、压缩重复字母）之后再做子串匹配，这样 "F.U.C.K"、"fuuuck"、"f4g" 这类
-- 变体不需要在词表里逐一列出就能被挡住。
create or replace function nickname_is_offensive(p_text text) returns boolean
language plpgsql
immutable
as $$
declare
  v text;
begin
  v := lower(coalesce(p_text, ''));
  -- 去掉常见用来拆开关键词躲避匹配的分隔符
  v := regexp_replace(v, '[ _.\-]', '', 'g');
  -- 常见 leet 替换：0->o 1->i 3->e 4->a 5->s 7->t @->a $->s !->i
  v := translate(v, '013457@$!', 'oieastasi');
  -- 连续重复字母压成一个：fuuuck -> fuck（Postgres 高级正则支持模式内反向
  -- 引用 \1，不仅能用在替换串里）
  v := regexp_replace(v, '(.)\1+', '\1', 'g');

  if v = '' then
    return false;
  end if;

  -- 中文敏感词 / 仿冒管理员类关键词（沿用原 start_run 里的词表）。
  if v ~ '(傻x|傻逼|白痴|管理员|客服|官方)' then
    return true;
  end if;

  -- 英文脏话/侮辱/歧视词 + 仿冒系统身份类关键词，子串匹配。
  -- 权衡：fag/sex/rape 这类较短或有常见正常用法的词（Essex、sextant、
  -- unisex...）理论上会误伤极少数合法昵称，但这里只是一个"昵称不合适就
  -- 回退成默认昵称"的兜底，不是账号处罚，误伤成本很低；换成整词匹配
  -- （\y word \y）反而容易被加个后缀/前缀绕过，所以统一用子串匹配。
  if v ~ 'fuk|fuck|fck|shit|sht|bitch|cunt|dick|cock|pussy|asshole|bastard|slut|whore|nigger|nigga|faggot|fag|retard|rape|nazi|hitler|porn|sex|kys|twat|wanker|admin|system|supabase' then
    return true;
  end if;

  return false;
end;
$$;

create or replace function start_run(p_client_id uuid, p_nickname text)
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
begin
  -- 昵称过滤：白名单只保留 ASCII 字母数字、CJK 统一表意文字（显式码点范围
  -- 一(U+4E00)-鿿(U+9FFF)，不依赖 locale 的 [:alpha:]/[:alnum:]）、空格、
  -- 下划线、短横线；折叠连续空白；用上面的 nickname_is_offensive() 做敏感
  -- 词/脏话兜底过滤（与 web/game.js 的 sanitizeNickname() 保持同一套白名单
  -- 字符集与词表，两处互相指向，改一处记得同步另一处）；**先敏感词检测，
  -- 再截断到 12 字符**——顺序反过来会有漏判：比如 "f-u-c-k 管理员" 截断到
  -- 12 字符后刚好把最后一个字母切掉，变成检测不到的 "scriptf-u-c-"，之前
  -- 这个实现就是这样（已用本地 Postgres 验证复现），现在先对完整的
  -- （已过白名单+折叠空白，但未截断的）字符串做敏感词检测，再截断，不会
  -- 因为截断点凑巧落在词中间而漏判；命中或结果为空都回退默认昵称。不会
  -- 因为昵称问题拒绝开局。
  v_nickname := regexp_replace(coalesce(p_nickname, ''), '[^a-zA-Z0-9_ 一-鿿-]', '', 'g');
  v_nickname := btrim(regexp_replace(v_nickname, '\s+', ' ', 'g'));
  if nickname_is_offensive(v_nickname) then
    v_nickname := '';
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

  insert into runs (client_id, nickname)
  values (p_client_id, v_nickname)
  returning id, started_at into v_run_id, v_started_at;

  insert into score_events (run_id, client_id, seq, event_type, client_ts, score, catches, elapsed_seconds)
  values (v_run_id, p_client_id, 0, 'start', now(), 0, 0, 0);

  return query select true, v_run_id, v_started_at, null::text;
end;
$$;

-- start_run 的签名（参数与返回列）没变，CREATE OR REPLACE 会保留函数 OID，
-- 原有的 EXECUTE 授权不会丢，不需要重新 grant。nickname_is_offensive() 是
-- 纯计算、不碰表，默认的 PUBLIC EXECUTE 权限不需要收回（和
-- game_max_score_per_sec() 等几个常量函数同样处理，见 20261017010550）。
