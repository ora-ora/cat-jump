-- 临时探针：确认 Supabase 经 PostgREST 传入的请求头里有哪些（只返回头名称和国家码，不返回任何 IP）。
-- 下一条迁移会删除此函数。
create or replace function probe_request_geo()
returns json
language sql
stable
as $$
  select json_build_object(
    'header_names', (select json_agg(k order by k) from json_object_keys(coalesce(current_setting('request.headers', true), '{}')::json) k),
    'cf_ipcountry', coalesce(current_setting('request.headers', true), '{}')::json->>'cf-ipcountry'
  )
$$;
grant execute on function probe_request_geo() to anon;
