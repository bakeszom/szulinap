-- Buliapp v4: kártyás gyűjtés az esküvőre (SumUp Solo) + szelfigép-számláló
-- Supabase → SQL Editor → New query → bemásol → Run (a bakeszom's Project / nrxalvrmupcgorkzobru projektben)
--
-- Hogyan működik:
--   1. A vendég a buliappban (vagy a gyűjtőgép helyi oldalán) összeget választ → új sor a donation_requests-ben.
--   2. A gyűjtőszolgáltatás (adomany/, a laptopon fut) sorban elküldi a kéréseket a SumUp terminálra.
--   3. Sikeres fizetés után sor kerül a donations táblába; a kivetítő (progress.html) a progress_feed()-ből olvas.
--   4. A szelfigép nyomatszámát a szolgáltatás a counters táblába írja ('photos').
-- Írni (fizetést rögzíteni, státuszt állítani) csak a szolgáltatás tud: a bridge_* függvények egy titkot várnak,
-- amelynek itt csak a SHA-256 hash-e szerepel. A titok az adomany/.env BRIDGE_SECRET értéke.

-- Fizetési kérések (sor a terminál előtt)
create table if not exists public.donation_requests (
  id bigint generated always as identity primary key,
  player_id uuid references public.players(id) on delete set null,
  name text not null check (char_length(name) between 1 and 40),
  amount int not null check (amount between 500 and 500000),
  source text not null default 'app' check (source in ('app', 'kiosk')),
  status text not null default 'pending'
    check (status in ('pending', 'sent', 'paid', 'failed', 'cancelled', 'expired')),
  cancel_requested boolean not null default false,
  info text,
  tx_code text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists donation_requests_status_idx on public.donation_requests (status, id);
-- egy játékosnak egyszerre csak egy nyitott kérése lehet
create unique index if not exists donation_requests_one_open
  on public.donation_requests (player_id) where status in ('pending', 'sent') and player_id is not null;

-- Sikeres befizetések (kártya vagy kézzel rögzített készpénz)
create table if not exists public.donations (
  id bigint generated always as identity primary key,
  request_id bigint unique references public.donation_requests(id) on delete set null,
  tx_code text unique,
  name text not null,
  amount int not null check (amount > 0),
  created_at timestamptz not null default now()
);

-- Számlálók (pl. 'photos' = a szelfigép nyomatszáma)
create table if not exists public.counters (
  key text primary key,
  value bigint not null default 0,
  updated_at timestamptz not null default now()
);

-- A szolgáltatás titkának hash-e (anon nem látja)
create table if not exists public.bridge_keys (
  id int primary key default 1 check (id = 1),
  secret_sha256 text not null
);
insert into public.bridge_keys (id, secret_sha256)
values (1, '17737e23d62b14cc8c1e57d58737fbd51cf77303f8a481fa6c98edc7ab3fe3f8')
on conflict (id) do update set secret_sha256 = excluded.secret_sha256;

alter table public.donation_requests enable row level security;
alter table public.donations enable row level security;
alter table public.counters enable row level security;
alter table public.bridge_keys enable row level security;
revoke all on public.bridge_keys from anon, authenticated;

-- anon: olvasás mindenhol; új kérés csak 'pending' állapotban, a megengedett oszlopokkal
revoke all on public.donation_requests from anon;
grant select on public.donation_requests to anon;
grant insert (player_id, name, amount, source) on public.donation_requests to anon;
grant select on public.donations to anon;
grant select on public.counters to anon;

drop policy if exists "buli donreq read" on public.donation_requests;
drop policy if exists "buli donreq insert" on public.donation_requests;
create policy "buli donreq read"   on public.donation_requests for select to anon using (true);
create policy "buli donreq insert" on public.donation_requests for insert to anon with check (status = 'pending');
drop policy if exists "buli donations read" on public.donations;
create policy "buli donations read" on public.donations for select to anon using (true);
drop policy if exists "buli counters read" on public.counters;
create policy "buli counters read" on public.counters for select to anon using (true);

-- Vendég: a saját kérésének visszavonása. Ha már a terminálon van, a szolgáltatás szakítja meg.
create or replace function public.cancel_donation_request(p_id bigint)
returns text language plpgsql security definer set search_path = public as $$
declare s text;
begin
  update donation_requests set status = 'cancelled', info = 'Visszavonva', updated_at = now()
    where id = p_id and status = 'pending' returning status into s;
  if s is not null then return s; end if;
  update donation_requests set cancel_requested = true, updated_at = now()
    where id = p_id and status = 'sent' returning status into s;
  return coalesce(s, (select status from donation_requests where id = p_id));
end $$;
revoke all on function public.cancel_donation_request(bigint) from public;
grant execute on function public.cancel_donation_request(bigint) to anon;

-- A kivetítő (progress.html) és a buliapp egyetlen lekérdezése
create or replace function public.progress_feed()
returns json language sql stable security definer set search_path = public as $$
  select json_build_object(
    'total',  coalesce((select sum(amount) from donations), 0),
    'count',  (select count(*) from donations),
    'max',    coalesce((select max(amount) from donations), 0),
    'photos', (select value from counters where key = 'photos'),
    'queue',  (select count(*) from donation_requests where status in ('pending', 'sent')),
    'last',   (select json_build_object('id', 'd' || id, 'amount', amount, 'name', name)
                 from donations order by id desc limit 1)
  );
$$;
revoke all on function public.progress_feed() from public;
grant execute on function public.progress_feed() to anon;

-- ---------- a gyűjtőszolgáltatás függvényei (titokkal) ----------
create or replace function public._bridge_ok(p_secret text)
returns boolean language sql stable security definer set search_path = public as $$
  select exists (select 1 from bridge_keys
                 where secret_sha256 = encode(sha256(convert_to(coalesce(p_secret, ''), 'UTF8')), 'hex'));
$$;
revoke all on function public._bridge_ok(text) from public, anon, authenticated;

create or replace function public.bridge_update_request(p_secret text, p_id bigint, p_status text, p_info text, p_tx_code text)
returns void language plpgsql security definer set search_path = public as $$
begin
  if not _bridge_ok(p_secret) then raise exception 'bridge: rossz titok' using errcode = '42501'; end if;
  update donation_requests
     set status = p_status, info = p_info, tx_code = coalesce(p_tx_code, tx_code), updated_at = now()
   where id = p_id;
end $$;

-- Sikeres befizetés rögzítése. Idempotens: ugyanaz a kérés / tranzakció kétszer nem számít.
create or replace function public.bridge_add_donation(p_secret text, p_request_id bigint, p_tx_code text, p_name text, p_amount int)
returns bigint language plpgsql security definer set search_path = public as $$
declare v_id bigint;
begin
  if not _bridge_ok(p_secret) then raise exception 'bridge: rossz titok' using errcode = '42501'; end if;
  select id into v_id from donations
   where (p_request_id is not null and request_id = p_request_id) or (p_tx_code is not null and tx_code = p_tx_code)
   limit 1;
  if v_id is null then
    insert into donations (request_id, tx_code, name, amount)
    values (p_request_id, p_tx_code, left(coalesce(nullif(trim(p_name), ''), 'Valaki'), 40), p_amount)
    returning id into v_id;
  end if;
  if p_request_id is not null then
    update donation_requests set status = 'paid', info = 'Sikeres fizetés', tx_code = coalesce(p_tx_code, tx_code), updated_at = now()
     where id = p_request_id;
  end if;
  return v_id;
end $$;

create or replace function public.bridge_set_counter(p_secret text, p_key text, p_value bigint)
returns void language plpgsql security definer set search_path = public as $$
begin
  if not _bridge_ok(p_secret) then raise exception 'bridge: rossz titok' using errcode = '42501'; end if;
  insert into counters (key, value, updated_at) values (p_key, p_value, now())
  on conflict (key) do update set value = excluded.value, updated_at = now();
end $$;

-- Tesztadatok törlése a buli előtt (befizetések, kérések, számlálók)
create or replace function public.bridge_reset(p_secret text)
returns void language plpgsql security definer set search_path = public as $$
begin
  if not _bridge_ok(p_secret) then raise exception 'bridge: rossz titok' using errcode = '42501'; end if;
  delete from donations where true;
  delete from donation_requests where true;
  delete from counters where true;
end $$;

revoke all on function public.bridge_update_request(text, bigint, text, text, text) from public;
revoke all on function public.bridge_add_donation(text, bigint, text, text, int) from public;
revoke all on function public.bridge_set_counter(text, text, bigint) from public;
revoke all on function public.bridge_reset(text) from public;
grant execute on function public.bridge_update_request(text, bigint, text, text, text) to anon;
grant execute on function public.bridge_add_donation(text, bigint, text, text, int) to anon;
grant execute on function public.bridge_set_counter(text, text, bigint) to anon;
grant execute on function public.bridge_reset(text) to anon;

-- PostgREST séma-gyorsítótár frissítése (hogy az új táblák és függvények azonnal elérhetők legyenek)
notify pgrst, 'reload schema';
