-- 经 Cloudflare Worker（api.12121313.xyz）代理后，Supabase 边缘看到的是 Worker 的出口 IP / 机房国家。
-- Worker 把真实客户端 IP 和国家码放进 x-cat-ip / x-cat-country / x-cat-ts，并用共享密钥做 HMAC-SHA256 签名（x-cat-sig）。
-- 数据库验签通过（且时间戳在 300 秒内）才采用这些头；否则回退到原来的 Supabase/CF 头（直连旧客户端照常工作）。
-- 共享密钥只存在私有表 private_settings（RLS、无策略、对 anon/authenticated 收回全部权限），
-- 由部署工作流用 GitHub secret CAT_PROXY_SECRET 写入，绝不进仓库。
create extension if not exists pgcrypto with schema extensions;

create table if not exists private_settings (
  key text primary key,
  value text not null,
  updated_at timestamptz not null default now()
);
alter table private_settings enable row level security;
revoke all on private_settings from public, anon, authenticated;

create or replace function proxy_signed_ok() returns boolean
language plpgsql stable security definer set search_path = public, extensions as $$
declare v_secret text; v_ip text; v_c text; v_ts text; v_sig text;
begin
  v_sig := request_header('x-cat-sig');
  if v_sig is null then return false; end if;
  select value into v_secret from private_settings where key = 'proxy_secret';
  if v_secret is null or length(v_secret) < 32 then return false; end if;
  v_ip := coalesce(request_header('x-cat-ip'), ''); v_c := coalesce(request_header('x-cat-country'), ''); v_ts := request_header('x-cat-ts');
  if v_ts is null or v_ts !~ '^[0-9]{9,11}$' or abs(extract(epoch from now()) - v_ts::bigint) > 300 then return false; end if;
  return encode(extensions.hmac(v_ip || '|' || v_c || '|' || v_ts, v_secret, 'sha256'), 'hex') = lower(v_sig);
exception when others then
  return false;
end;
$$;
revoke all on function proxy_signed_ok() from public, anon, authenticated;

create or replace function request_client_ip() returns inet
language plpgsql stable security definer set search_path = public as $$
declare v text;
begin
  if proxy_signed_ok() then
    v := request_header('x-cat-ip');
  else
    v := coalesce(request_header('sb-forwarded-for'), request_header('x-real-ip'),
                  request_header('cf-connecting-ip'), request_header('x-forwarded-for'));
  end if;
  v := btrim(split_part(v, ',', 1));
  if v is null or v = '' then return null; end if;
  return v::inet;
exception when others then
  return null;
end;
$$;
revoke all on function request_client_ip() from public, anon, authenticated;

create or replace function request_country() returns text
language plpgsql stable security definer set search_path = public as $$
declare c text;
begin
  c := upper(case when proxy_signed_ok() then request_header('x-cat-country') else request_header('cf-ipcountry') end);
  return case when c ~ '^[A-Z]{2}$' and c not in ('XX', 'T1') then c else null end;
end;
$$;
revoke all on function request_country() from public, anon, authenticated;
