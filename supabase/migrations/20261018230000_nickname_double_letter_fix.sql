-- 修复双写字母漏网：nickname_is_offensive() 会把输入里连续重复的字母压成
-- 一个（为了拦 FuuuK 这类写法），但词表本身没有同样处理，导致带双写字母
-- 的词（asshole、faggot、nigger、pussy）压缩后变成 ashole/fagot/niger/pusy，
-- 永远匹配不上。
--
-- 新做法：对输入同时生成两种形式，分别和对应形式的词表比较：
--   v_two：3 个及以上的重复压成 2 个（"a$$$hole" -> "asshole"，
--          "niggger" -> "nigger"），与*原样*词表比较；
--   v_one：所有重复压成 1 个（"fuuuck" -> "fuck"），与*同样压缩过*的
--          词表比较。
-- 安全词同理：原样安全词从 v_two 系列中剔除，压缩后的安全词从 v_one 系列
-- 中剔除。新增 niger/nigeria/nigerian 为安全词（压缩后 "nigger" 也会变成
-- "niger"，但 v_two 一侧仍能拦住 "nigger"）。
-- 签名不变，start_run() 无需改动、授权保持不变。
-- 前端镜像：web/game.js 的 isNicknameOffensive()，两处改一处须同步另一处。
create or replace function nickname_is_offensive(p_text text) returns boolean
language plpgsql
immutable
as $$
declare
  v_base text;
  v_two text;
  v_one text;
  form text;
  forms text[];
  glued text;
  collapsed text;
  sc text;
  sg text;
  tok text;
  w text;
  i integer;
  -- 短/易误伤词：只做整词匹配。
  whole_words text[] := array[
    'sex', 'dick', 'fag', 'kys', 'cock', 'rape', 'porn', 'sht', 'fck', 'fuk', 'cunt'
  ];
  -- 长词：子串匹配。
  substring_words text[] := array[
    'fuck', 'shit', 'bitch', 'pussy', 'asshole', 'bastard', 'slut', 'whore',
    'nigger', 'nigga', 'faggot', 'retard', 'nazi', 'hitler', 'twat', 'wanker',
    'admin', 'system', 'supabase'
  ];
  safe_words text[] := array[
    'scunthorpe', 'essex', 'sussex', 'middlesex', 'dickens', 'dickson', 'cockburn',
    'hancock', 'peacock', 'shitake', 'shiitake', 'grape', 'therapist', 'assassin',
    'class', 'pass', 'bass', 'niger', 'nigeria', 'nigerian'
  ];
  ww text[];
  sw text[];
  sf text[];
begin
  if p_text is null or p_text = '' then
    return false;
  end if;

  -- 转小写 + leet：0->o 1->i 3->e 4->a 5->s 7->t @->a $->s !->i
  v_base := translate(lower(p_text), '013457@$!', 'oieastasi');
  v_two := regexp_replace(v_base, '(.)\1\1+', '\1\1', 'g');
  v_one := regexp_replace(v_base, '(.)\1+', '\1', 'g');

  -- i=1：v_two 对原样词表；i=2：v_one 对压缩词表
  for i in 1..2 loop
    if i = 1 then
      form := v_two; ww := whole_words; sw := substring_words; sf := safe_words;
    else
      form := v_one;
      select array_agg(regexp_replace(x, '(.)\1+', '\1', 'g')) into ww from unnest(whole_words) x;
      select array_agg(regexp_replace(x, '(.)\1+', '\1', 'g')) into sw from unnest(substring_words) x;
      select array_agg(regexp_replace(x, '(.)\1+', '\1', 'g')) into sf from unnest(safe_words) x;
    end if;

    -- 整词匹配：按分隔符切词元逐个比较，再把分隔符全删掉整体比较一次
    foreach tok in array regexp_split_to_array(form, '[ _.\-]+') loop
      if tok <> '' and tok = any (ww) then
        return true;
      end if;
    end loop;
    glued := regexp_replace(form, '[ _.\-]', '', 'g');
    if glued = any (ww) then
      return true;
    end if;

    -- 子串匹配：分隔符折叠串与无分隔符串都检查，先剔除安全词
    collapsed := btrim(regexp_replace(form, '[ _.\-]+', ' ', 'g'));
    sc := collapsed;
    sg := glued;
    foreach w in array sf loop
      sc := replace(sc, w, '');
      sg := replace(sg, w, '');
    end loop;
    foreach w in array sw loop
      if position(w in sc) > 0 or position(w in sg) > 0 then
        return true;
      end if;
    end loop;

    if collapsed ~ '(傻x|傻逼|白痴|管理员|客服|官方)' then
      return true;
    end if;
  end loop;

  return false;
end;
$$;
