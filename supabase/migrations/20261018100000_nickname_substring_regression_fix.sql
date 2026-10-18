-- 回归修复：20261018080000 把长词表的子串匹配从"完全去掉分隔符"改成了
-- "分隔符折叠成空格"（变量 v 被重新赋值成折叠版本），结果 "f u c k"/
-- "f-u-c-k"/"F.U.C.K"/"fu ck"/"sh it"/"b i t c h"/"s h 1 t" 这类把长词
-- 拆成多段、段间插分隔符的写法全部漏判了——折叠成空格后字母间还夹着空格，
-- "fuck" 这个子串自然不会出现，必须在*完全去掉分隔符*的版本上再查一次
-- 才能逮到。20261018080000/090000 已应用过，不改那两个文件，这里只
-- create or replace nickname_is_offensive()（签名不变，start_run() 不用
-- 跟着改，它只是调用方）。
--
-- 子串匹配现在同时检查两种形态（各自先挖掉安全词）：
--   (a) 分隔符折叠成空格的串——词与词之间还留着边界，更不容易把两个无关
--       单词粘连出意外子串；
--   (b) 分隔符完全去掉的串——专门用来逮上面这种"字母间插分隔符"的写法。
-- 注意：安全词本身带双写字母时（"class"/"pass"/"bass"/"essex"……），待查
-- 串这之前已经做过"连续重复字母压成一个"的规范化，安全词按原样去挖永远
-- 挖不掉自己（比如 "class" 变成了 "clas"，"replace(v,'class','')" 找不到
-- "class"）——这是已知的无效化，但*不*在这里"修"：试过把安全词也压缩成
-- "bas"/"clas"/"pas" 再去挖，结果 "bas" 这种压缩后的残片正好是 "bastard"
-- 的前 3 个字母，会把 "bastard" 挖掉变成 "tard" 从而漏判，比不修还糟。
-- 当前这几个安全词即使完全不生效也不会有问题：它们本来就不是任何长词表
-- 子串的来源（essex/class/pass/bass 都已经在"短词只整词匹配" + 重复字母
-- 压缩这两道前置规则下自然放行了，这里的挖词只是以防未来词表扩充时的
-- 二次保险，不强求对这几个已知双写词生效）。
create or replace function nickname_is_offensive(p_text text) returns boolean
language plpgsql
immutable
as $$
declare
  v text;
  v_glued text;
  v_collapsed text;
  v_scrubbed_collapsed text;
  v_scrubbed_glued text;
  tok text;
  toks text[];
  -- 短/易误伤词：只做整词匹配。
  whole_words text[] := array[
    'sex', 'dick', 'fag', 'kys', 'cock', 'rape', 'porn', 'sht', 'fck', 'fuk', 'cunt'
  ];
  -- 长/基本不会被正常单词包含的词：继续用子串匹配。
  substring_words text := 'fuck|shit|bitch|pussy|asshole|bastard|slut|whore|' ||
    'nigger|nigga|faggot|retard|nazi|hitler|twat|wanker|admin|system|supabase';
  -- 安全词：子串匹配前先从串里挖掉，避免长词表把它们当成命中。
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
  -- 连续重复字母压成一个：fuuuck -> fuck。
  v := regexp_replace(v, '(.)\1+', '\1', 'g');

  -- 整词匹配 1/2：按空格/_/-/. 切分词元（不按数字切分，理由见
  -- 20261018080000 的注释：数字常是 leet 替换剩下的尾巴，按数字切会破坏
  -- leet 还原），每个词元单独判断是否整体等于某个短词。
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

  -- 子串匹配：同时查"分隔符折叠成空格"版和"分隔符完全去掉"版，各自先挖掉
  -- 安全词（原样拼写，不做重复字母压缩，理由见上面的注释）。
  v_collapsed := btrim(regexp_replace(v, '[ _.\-]+', ' ', 'g'));
  v_scrubbed_collapsed := v_collapsed;
  v_scrubbed_glued := v_glued;
  foreach tok in array safe_words loop
    v_scrubbed_collapsed := replace(v_scrubbed_collapsed, tok, '');
    v_scrubbed_glued := replace(v_scrubbed_glued, tok, '');
  end loop;

  if v_scrubbed_collapsed ~ substring_words or v_scrubbed_glued ~ substring_words then
    return true;
  end if;

  -- 中文敏感词 / 仿冒管理员类关键词，沿用原词表，子串匹配（中文没有
  -- Scunthorpe 问题这种英文单词边界的歧义，维持原样）。
  if v_collapsed ~ '(傻x|傻逼|白痴|管理员|客服|官方)' then
    return true;
  end if;

  return false;
end;
$$;
