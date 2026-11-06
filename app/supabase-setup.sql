-- Ádám szülinapi buliapp — adatbázis beállítás
-- Supabase → SQL Editor → New query → bemásol → Run

-- Játékosok
create table if not exists public.players (
  id uuid primary key default gen_random_uuid(),
  name text not null check (char_length(name) between 1 and 40),
  level int check (level between 1 and 3),
  created_at timestamptz not null default now()
);

-- Teljesített side questek
create table if not exists public.completions (
  id bigint generated always as identity primary key,
  player_id uuid not null references public.players(id) on delete cascade,
  player_name text not null,
  quest_id text not null,
  points numeric not null default 0,
  photo_url text,
  created_at timestamptz not null default now(),
  unique (player_id, quest_id)
);
create index if not exists completions_created_idx on public.completions (created_at desc);

-- Kvízeredmények (kind: 'adam' vagy 'pyramid')
create table if not exists public.scores (
  player_id uuid not null references public.players(id) on delete cascade,
  player_name text not null,
  kind text not null,
  score int not null default 0,
  time_ms int not null default 0,
  updated_at timestamptz not null default now(),
  primary key (player_id, kind)
);

-- Ranglista nézet
create or replace view public.leaderboard with (security_invoker = on) as
  select p.id as player_id, p.name,
         coalesce(sum(c.points), 0) as points,
         count(c.id) as quests
  from public.players p
  left join public.completions c on c.player_id = p.id
  group by p.id, p.name;

-- Jogosultságok (a buliapp bejelentkezés nélkül megy, a nyilvános kulccsal)
alter table public.players enable row level security;
alter table public.completions enable row level security;
alter table public.scores enable row level security;

grant select, insert, update on public.players to anon;
grant select, insert, delete on public.completions to anon;
grant select, insert, update on public.scores to anon;
grant select on public.leaderboard to anon;

drop policy if exists "buli players read" on public.players;
drop policy if exists "buli players insert" on public.players;
drop policy if exists "buli players update" on public.players;
create policy "buli players read"   on public.players for select to anon using (true);
create policy "buli players insert" on public.players for insert to anon with check (true);
create policy "buli players update" on public.players for update to anon using (true) with check (true);

drop policy if exists "buli completions read" on public.completions;
drop policy if exists "buli completions insert" on public.completions;
drop policy if exists "buli completions delete" on public.completions;
create policy "buli completions read"   on public.completions for select to anon using (true);
create policy "buli completions insert" on public.completions for insert to anon with check (true);
create policy "buli completions delete" on public.completions for delete to anon using (true);

drop policy if exists "buli scores read" on public.scores;
drop policy if exists "buli scores insert" on public.scores;
drop policy if exists "buli scores update" on public.scores;
create policy "buli scores read"   on public.scores for select to anon using (true);
create policy "buli scores insert" on public.scores for insert to anon with check (true);
create policy "buli scores update" on public.scores for update to anon using (true) with check (true);

-- Fotótároló a bizonyítékképeknek (nyilvánosan olvasható, max 5 MB/kép)
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('proofs', 'proofs', true, 5242880, array['image/jpeg','image/png','image/webp'])
on conflict (id) do update set public = true;

drop policy if exists "buli proofs upload" on storage.objects;
create policy "buli proofs upload" on storage.objects for insert to anon
  with check (bucket_id = 'proofs');
