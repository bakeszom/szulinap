-- Buliapp v3: buli fotók (bárki feltölthet, mindenki látja, a sajátját törölheti)
-- Supabase → SQL Editor → New query → bemásol → Run
create table if not exists public.photos (
  id bigint generated always as identity primary key,
  player_id uuid references public.players(id) on delete cascade,
  player_name text not null,
  url text not null,
  created_at timestamptz not null default now()
);
create index if not exists photos_created_idx on public.photos (created_at desc);
alter table public.photos enable row level security;
grant select, insert, delete on public.photos to anon;
drop policy if exists "buli photos read" on public.photos;
drop policy if exists "buli photos insert" on public.photos;
drop policy if exists "buli photos delete" on public.photos;
create policy "buli photos read"   on public.photos for select to anon using (true);
create policy "buli photos insert" on public.photos for insert to anon with check (true);
create policy "buli photos delete" on public.photos for delete to anon using (true);
