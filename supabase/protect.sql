-- HOTPADEL – ochrana historie PINem
-- Ukončené večery jsou jen pro čtení. Smazání / úprava / znovuotevření jde jen přes funkce s PINem.
-- Během živého večera se dá volně přidávat, vracet a upravovat.
-- POZOR: <<PIN_SHA256>> nahraď SHA-256 hashem PINu (hex). Skutečný PIN do veřejného repa nepatří.

-- 1) Nové pravidla (RLS) místo "všechno povoleno"
drop policy if exists "open sessions" on public.sessions;
drop policy if exists "open matches" on public.matches;
drop policy if exists "sessions read" on public.sessions;
drop policy if exists "sessions insert" on public.sessions;
drop policy if exists "sessions update open" on public.sessions;
drop policy if exists "sessions delete empty open" on public.sessions;
drop policy if exists "matches read" on public.matches;
drop policy if exists "matches insert open" on public.matches;
drop policy if exists "matches update open" on public.matches;
drop policy if exists "matches delete open" on public.matches;

create policy "sessions read" on public.sessions for select to anon, authenticated using (true);
create policy "sessions insert" on public.sessions for insert to anon, authenticated with check (not finished);
-- rozehraný večer jde ukončit, ukončený už nejde změnit
create policy "sessions update open" on public.sessions for update to anon, authenticated using (not finished) with check (true);
-- bez PINu jde smazat jen prázdný rozehraný večer
create policy "sessions delete empty open" on public.sessions for delete to anon, authenticated
  using (not finished and not exists (select 1 from public.matches m where m.session_id = sessions.id));

create policy "matches read" on public.matches for select to anon, authenticated using (true);
create policy "matches insert open" on public.matches for insert to anon, authenticated
  with check (exists (select 1 from public.sessions s where s.id = session_id and not s.finished));
create policy "matches update open" on public.matches for update to anon, authenticated
  using (exists (select 1 from public.sessions s where s.id = session_id and not s.finished))
  with check (exists (select 1 from public.sessions s where s.id = session_id and not s.finished));
create policy "matches delete open" on public.matches for delete to anon, authenticated
  using (exists (select 1 from public.sessions s where s.id = session_id and not s.finished));

-- 2) Kontrola PINu (hash, ne čistý text)
create or replace function public._pin_ok(p text) returns boolean
language plpgsql security definer set search_path = public as $$
begin
  if encode(sha256(convert_to(coalesce(p, ''), 'UTF8')), 'hex') = '<<PIN_SHA256>>' then
    return true;
  end if;
  perform pg_sleep(1); -- zpomalí hádání
  return false;
end $$;
revoke all on function public._pin_ok(text) from public, anon, authenticated;

-- 3) Chráněné akce
create or replace function public.admin_delete_session(p_id bigint, p_pin text) returns void
language plpgsql security definer set search_path = public as $$
begin
  if not public._pin_ok(p_pin) then raise exception 'WRONG_PIN'; end if;
  delete from public.sessions where id = p_id;
end $$;

create or replace function public.admin_reopen_session(p_id bigint, p_pin text) returns void
language plpgsql security definer set search_path = public as $$
begin
  if not public._pin_ok(p_pin) then raise exception 'WRONG_PIN'; end if;
  update public.sessions set finished = false where id = p_id;
end $$;

create or replace function public.admin_update_match(p_id bigint, p_a int, p_b int, p_pin text) returns void
language plpgsql security definer set search_path = public as $$
begin
  if not public._pin_ok(p_pin) then raise exception 'WRONG_PIN'; end if;
  update public.matches set score_a = p_a, score_b = p_b where id = p_id;
end $$;

create or replace function public.admin_delete_match(p_id bigint, p_pin text) returns void
language plpgsql security definer set search_path = public as $$
begin
  if not public._pin_ok(p_pin) then raise exception 'WRONG_PIN'; end if;
  delete from public.matches where id = p_id;
end $$;

revoke all on function public.admin_delete_session(bigint, text) from public;
revoke all on function public.admin_reopen_session(bigint, text) from public;
revoke all on function public.admin_update_match(bigint, int, int, text) from public;
revoke all on function public.admin_delete_match(bigint, text) from public;
grant execute on function public.admin_delete_session(bigint, text) to anon, authenticated;
grant execute on function public.admin_reopen_session(bigint, text) to anon, authenticated;
grant execute on function public.admin_update_match(bigint, int, int, text) to anon, authenticated;
grant execute on function public.admin_delete_match(bigint, text) to anon, authenticated;

notify pgrst, 'reload schema';
