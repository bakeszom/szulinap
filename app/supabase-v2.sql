-- Buliapp v2: belépőkód, piaszámláló, italos ranglista
-- Supabase → SQL Editor → New query → bemásol → Run (a bakeszom's Project / nrxalvrmupcgorkzobru projektben)

alter table public.players add column if not exists code text;

revoke select, update on public.players from anon;
grant select (id, name, level, created_at) on public.players to anon;
grant update (level) on public.players to anon;

create or replace function public.resume_player(p_name text, p_code text)
returns table (id uuid, name text, level int)
language sql stable security definer set search_path = public
as $$
  select p.id, p.name, p.level from public.players p
  where lower(p.name) = lower(trim(p_name)) and p.code = trim(p_code)
  order by p.created_at desc limit 1;
$$;
revoke all on function public.resume_player(text, text) from public;
grant execute on function public.resume_player(text, text) to anon;

create table if not exists public.drinks (
  id bigint generated always as identity primary key,
  player_id uuid not null references public.players(id) on delete cascade,
  player_name text not null,
  kind text not null,
  created_at timestamptz not null default now()
);
create index if not exists drinks_player_idx on public.drinks (player_id);
alter table public.drinks enable row level security;
grant select, insert, delete on public.drinks to anon;

drop policy if exists "buli drinks read" on public.drinks;
drop policy if exists "buli drinks insert" on public.drinks;
drop policy if exists "buli drinks delete" on public.drinks;
create policy "buli drinks read"   on public.drinks for select to anon using (true);
create policy "buli drinks insert" on public.drinks for insert to anon with check (true);
create policy "buli drinks delete" on public.drinks for delete to anon using (true);

drop view if exists public.leaderboard;
create view public.leaderboard with (security_invoker = on) as
select p.id as player_id, p.name,
  coalesce(c.points, 0) as points,
  coalesce(c.quests, 0) as quests,
  coalesce(d.beers, 0) as beers,
  coalesce(d.wines, 0) as wines,
  coalesce(d.longdrinks, 0) as longdrinks,
  coalesce(d.shots, 0) as shots,
  coalesce(d.waters, 0) as waters
from public.players p
left join (select player_id, sum(points) as points,
                  count(*) filter (where quest_id like 'q%') as quests
           from public.completions group by player_id) c on c.player_id = p.id
left join (select player_id,
                  count(*) filter (where kind = 'sor') as beers,
                  count(*) filter (where kind = 'bor') as wines,
                  count(*) filter (where kind = 'longdrink') as longdrinks,
                  count(*) filter (where kind = 'feles') as shots,
                  count(*) filter (where kind = 'viz') as waters
           from public.drinks group by player_id) d on d.player_id = p.id;
grant select on public.leaderboard to anon;
