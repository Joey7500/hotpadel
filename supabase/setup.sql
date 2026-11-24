-- HOTPADEL – jednorázové nastavení databáze
-- Vlož celý tento soubor do Supabase → SQL Editor → Run.

create table if not exists public.sessions (
  id          bigint generated always as identity primary key,
  played_on   date        not null default (now() at time zone 'Europe/Prague')::date,
  finished    boolean     not null default false,
  note        text,
  created_at  timestamptz not null default now()
);

create table if not exists public.matches (
  id          bigint generated always as identity primary key,
  session_id  bigint      not null references public.sessions(id) on delete cascade,
  match_no    int         not null check (match_no > 0),
  team_a      text[]      not null check (array_length(team_a, 1) = 2),
  team_b      text[]      not null check (array_length(team_b, 1) = 2),
  score_a     int         not null check (score_a between 0 and 21),
  score_b     int         not null check (score_b between 0 and 21),
  created_at  timestamptz not null default now(),
  constraint total_21 check (score_a + score_b = 21),
  constraint unique_match_in_session unique (session_id, match_no)
);

create index if not exists matches_session_idx on public.matches(session_id);

-- Vždy maximálně jeden rozehraný večer (chrání proti dvěma telefonům najednou)
create unique index if not exists one_open_session on public.sessions ((true)) where not finished;

-- Přístup bez přihlášení (aplikace je jen pro partu)
alter table public.sessions enable row level security;
alter table public.matches  enable row level security;

drop policy if exists "open sessions" on public.sessions;
create policy "open sessions" on public.sessions for all to anon, authenticated using (true) with check (true);

drop policy if exists "open matches" on public.matches;
create policy "open matches" on public.matches for all to anon, authenticated using (true) with check (true);

-- Práva pro webovou aplikaci (nové Supabase projekty je nedávají automaticky)
grant usage on schema public to anon, authenticated;
grant select, insert, update, delete on public.sessions, public.matches to anon, authenticated;
grant usage, select on all sequences in schema public to anon, authenticated;

-- Živé aktualizace mezi telefony
do $$ begin
  alter publication supabase_realtime add table public.sessions, public.matches;
exception when duplicate_object then null; end $$;

-- ===== Seed: večer 23. 11. 2026 =====
do $$
declare sid bigint;
begin
  if not exists (select 1 from public.sessions where played_on = '2026-11-23') then
    insert into public.sessions (played_on, finished, created_at)
      values ('2026-11-23', true, '2026-11-23 20:00:00+01') returning id into sid;
    insert into public.matches (session_id, match_no, team_a, team_b, score_a, score_b, created_at) values
      (sid,  1, '{Honza,Martin}', '{Pepa,Matouš}',   12,  9, '2026-11-23 20:05+01'),
      (sid,  2, '{Honza,Pepa}',   '{Martin,Matouš}',  7, 14, '2026-11-23 20:12+01'),
      (sid,  3, '{Honza,Matouš}', '{Martin,Pepa}',   12,  9, '2026-11-23 20:19+01'),
      (sid,  4, '{Honza,Martin}', '{Pepa,Matouš}',   11, 10, '2026-11-23 20:26+01'),
      (sid,  5, '{Honza,Pepa}',   '{Martin,Matouš}',  3, 18, '2026-11-23 20:33+01'),
      (sid,  6, '{Honza,Matouš}', '{Martin,Pepa}',   11, 10, '2026-11-23 20:40+01'),
      (sid,  7, '{Honza,Martin}', '{Pepa,Matouš}',    9, 12, '2026-11-23 20:47+01'),
      (sid,  8, '{Honza,Pepa}',   '{Martin,Matouš}', 11, 10, '2026-11-23 20:54+01'),
      (sid,  9, '{Honza,Matouš}', '{Martin,Pepa}',   13,  8, '2026-11-23 21:01+01'),
      (sid, 10, '{Honza,Martin}', '{Pepa,Matouš}',    7, 14, '2026-11-23 21:08+01'),
      (sid, 11, '{Honza,Pepa}',   '{Martin,Matouš}', 12,  9, '2026-11-23 21:15+01'),
      (sid, 12, '{Honza,Matouš}', '{Martin,Pepa}',   11, 10, '2026-11-23 21:22+01'),
      (sid, 13, '{Honza,Martin}', '{Pepa,Matouš}',   12,  9, '2026-11-23 21:29+01'),
      (sid, 14, '{Honza,Pepa}',   '{Martin,Matouš}', 14,  7, '2026-11-23 21:36+01'),
      (sid, 15, '{Honza,Matouš}', '{Martin,Pepa}',   11, 10, '2026-11-23 21:43+01');
  end if;
end $$;
