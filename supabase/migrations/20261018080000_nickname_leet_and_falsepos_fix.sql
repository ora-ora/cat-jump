-- 第四轮审核发现两个问题，这里一次性修（20261018070000/20261018071000 已
-- 应用过，不再改那两个文件，直接 create or replace 覆盖 nickname_is_offensive
-- 和 start_run，签名都不变，不需要 drop/重新 grant）：
--
-- 1) leet 替换漏网：旧版 start_run 先用白名单把原始输入清洗一遍（白名单里
--    没有 !/@/$），再把清洗后的结果交给 nickname_is_offensive() 检查——但
--    这时候 !/@/$ 已经被白名单删掉了，nickname_is_offensive() 内部的
--    leet 替换表里 !->i/@->a/$->s 永远没机会命中，"B!tch99" 就被存成了
--    "Btch99"。修法：先对*原始*输入调用 nickname_is_offensive()（这时候
--    !/@/$ 还都在），命中就直接回退；没命中才做白名单清洗，清洗完再查一次
--    （清洗本身也可能把原本被符号隔开的词粘到一起，所以两次检查都要有）。
--
-- 2) 短词子串匹配误伤：sex/dick/fag/kys/cock/rape/porn/sht/fck/fuk/cunt
--    这些词本身或作为子串都很短，容易出现在正常单词里（Essex、Dickens、
--    Sussex、Cockburn、grape、therapist、Scunthorpe……这就是经典的
--    "Scunthorpe problem"）。修法：这些词只做*整词匹配*，不再用子串匹配；
--    长、基本不会被正常单词包含的词（fuck、shit、bitch、asshole……）继续
--    用子串匹配，不然随便加个前后缀就能绕过去。另外加一份安全词白名单，
--    命中就先从待检串里挖掉再做子串匹配，兜底 shiitake 之类长词表也会
--    误伤的情况。
create or replace function nickname_is_offensive(p_text text) returns boolean
language plpgsql
immutable
as $$
declare
  v text;
  v_glued text;
  v_scrubbed text;
  tok text;
  toks text[];
  -- 短/易误伤词：只做整词匹配。
  whole_words text[] := array[
    'sex', 'dick', 'fag', 'kys', 'cock', 'rape', 'porn', 'sht', 'fck', 'fuk', 'cunt'
  ];
  -- 长/基本不会被正常单词包含的词：继续用子串匹配。
  substring_words text := 'fuck|shit|bitch|pussy|asshole|bastard|slut|whore|' ||
    'nigger|nigga|faggot|retard|nazi|hitler|twat|wanker|admin|system|supabase';
  -- 安全词：子串匹配前先从串里挖掉，避免长词表把它们当成命中
  -- （scunthorpe/essex/sussex/middlesex/dickens/dickson/cockburn/hancock/
  -- peacock 这几个其实已经被"短词只整词匹配"规则保护了，这里连同
  -- shiitake/grape/therapist/assassin/class/pass/bass 一起再加一层保险，
  -- 双重防护不嫌多）。
  safe_words text[] := array[
    'scunthorpe', 'essex', 'sussex', 'middlesex', 'dickens', 'dickson', 'cockburn',
    'hancock', 'peacock', 'shitake', 'shiitake', 'grape', 'therapist', 'assassin',
    'class', 'pass', 'bass'
  ];
begin
  if p_text is null or p_text = '' then
    return false;
  end if;

  v := lower(p_text);
  -- leet 替换要在任何"删掉符号"的步骤之前做：0->o 1->i 3->e 4->a 5->s
  -- 7->t @->a $->s !->i。
  v := translate(v, '013457@$!', 'oieastasi');
  -- 连续重复字母压成一个：fuuuck -> fuck（Postgres 高级正则的模式内
  -- 反向引用 \1，不只能用在替换串里）。
  v := regexp_replace(v, '(.)\1+', '\1', 'g');

  -- 整词匹配 1/2：按空格/_/-/. 切分词元（这里特意不按数字切分——数字经常
  -- 是前面 leet 替换剩下的"非字母数字"部分，比如 "bitch99" 里的 "99"，
  -- 按数字切开反而会把 "b1tch" 切成 "b"+"tch" 破坏掉 leet 还原；短词表要
  -- 挡的是"整个词元正好等于这个短词"，不是"词元里包含数字"的情况），每个
  -- 词元单独判断是否整体等于某个短词。
  toks := regexp_split_to_array(v, '[ _.\-]+');
  foreach tok in array toks loop
    if tok <> '' and tok = any (whole_words) then
      return true;
    end if;
  end loop;

  -- 整词匹配 2/2：把分隔符整个删掉（不是折叠成空格）再整体比较一次，堵住
  -- "s-e-x" 这种每个字母间插分隔符、按词元切分会被拆散的写法。
  v_glued := regexp_replace(v, '[ _.\-]', '', 'g');
  if v_glued = any (whole_words) then
    return true;
  end if;

  -- 子串匹配：先挖掉安全词，再检查长词表。
  v := btrim(regexp_replace(v, '[ _.\-]+', ' ', 'g'));
  v_scrubbed := v;
  foreach tok in array safe_words loop
    v_scrubbed := replace(v_scrubbed, tok, '');
  end loop;
  if v_scrubbed ~ substring_words then
    return true;
  end if;

  -- 中文敏感词 / 仿冒管理员类关键词，沿用原词表，子串匹配（中文没有
  -- Scunthorpe 问题这种英文单词边界的歧义，维持原样）。
  if v ~ '(傻x|傻逼|白痴|管理员|客服|官方)' then
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

  insert into runs (client_id, nickname)
  values (p_client_id, v_nickname)
  returning id, started_at into v_run_id, v_started_at;

  insert into score_events (run_id, client_id, seq, event_type, client_ts, score, catches, elapsed_seconds)
  values (v_run_id, p_client_id, 0, 'start', now(), 0, 0, 0);

  return query select true, v_run_id, v_started_at, null::text;
end;
$$;
