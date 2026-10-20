-- NFL Pick Sheet: database setup.
-- Run this whole file once in the Supabase SQL editor, then run seed.sql.

-- ---------------------------------------------------------------------------
-- Tables
-- ---------------------------------------------------------------------------

-- One row per player, created automatically when someone signs up.
create table if not exists public.profiles (
  id uuid primary key references auth.users (id) on delete cascade,
  display_name text not null check (char_length(display_name) between 1 and 30),
  created_at timestamptz not null default now()
);

-- The schedule and results, kept in sync with ESPN by the jobs at the bottom.
create table if not exists public.games (
  id text primary key,                 -- ESPN event id
  week int not null,
  kickoff timestamptz not null,
  away text not null,                  -- team abbreviation, e.g. KC
  home text not null,
  away_score int,
  home_score int,
  state text not null default 'pre',   -- pre | in | post
  winner text,                         -- team abbreviation, 'TIE', or null until final
  detail text,                         -- ESPN status line, e.g. "Q3 4:12" or "Final"
  intl boolean not null default false, -- played outside the US
  updated_at timestamptz not null default now()
);
create index if not exists games_week_idx on public.games (week);

create table if not exists public.picks (
  user_id uuid not null default auth.uid() references auth.users (id) on delete cascade,
  game_id text not null references public.games (id) on delete cascade,
  team text not null,
  catch_up boolean not null default false,   -- made after kickoff during the 2026 catch-up weeks (set by trigger)
  updated_at timestamptz not null default now(),
  primary key (user_id, game_id)
);
alter table public.picks add column if not exists catch_up boolean not null default false;

-- ---------------------------------------------------------------------------
-- Profiles: created from the display name given at sign-up
-- ---------------------------------------------------------------------------

create or replace function public.handle_new_user()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  insert into public.profiles (id, display_name)
  values (
    new.id,
    left(coalesce(nullif(trim(new.raw_user_meta_data ->> 'display_name'), ''), split_part(new.email, '@', 1)), 30)
  );
  return new;
end $$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- ---------------------------------------------------------------------------
-- Row-level security
-- ---------------------------------------------------------------------------

alter table public.profiles enable row level security;
alter table public.games enable row level security;
alter table public.picks enable row level security;

drop policy if exists "profiles readable by players" on public.profiles;
create policy "profiles readable by players" on public.profiles
  for select to authenticated using (true);

drop policy if exists "players rename themselves" on public.profiles;
create policy "players rename themselves" on public.profiles
  for update to authenticated using (id = auth.uid()) with check (id = auth.uid());

-- Anyone can read the schedule. Only the sync jobs (which run as the database owner) write it.
drop policy if exists "schedule is public" on public.games;
create policy "schedule is public" on public.games
  for select to anon, authenticated using (true);

-- Players see only their own picks. Other people's picks are only ever exposed as totals.
drop policy if exists "read own picks" on public.picks;
create policy "read own picks" on public.picks
  for select to authenticated using (user_id = auth.uid());

-- The kickoff lock: a pick can be made, changed, or cleared only before its game starts.
-- This is enforced here, in the database, so it holds no matter what the browser sends.
create or replace function public.game_is_open(p_game text, p_team text default null)
returns boolean language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from public.games g
    where g.id = p_game
      and g.kickoff > now()
      and g.state = 'pre'
      and (p_team is null or p_team in (g.away, g.home))
  );
$$;

-- Catch-up weeks: the site launched partway through 2026, so for Weeks 1-7 of this season only,
-- players may still pick games that have already kicked off. Those picks are one-time: the
-- update and delete policies below only allow changes while a game is open, so once a
-- catch-up pick is saved it can never be changed or cleared.
create or replace function public.game_is_catch_up(p_game text, p_team text default null)
returns boolean language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from public.games g
    where g.id = p_game
      and g.week <= 7
      and g.kickoff < timestamptz '2027-03-01'   -- 2026 season only
      and (g.kickoff <= now() or g.state <> 'pre')
      and (p_team is null or p_team in (g.away, g.home))
  );
$$;

-- Record which picks were catch-up picks; clients can't set this themselves.
create or replace function public.mark_catch_up()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  new.catch_up := not public.game_is_open(new.game_id);
  return new;
end $$;

drop trigger if exists picks_mark_catch_up on public.picks;
create trigger picks_mark_catch_up
  before insert on public.picks
  for each row execute function public.mark_catch_up();

drop policy if exists "pick before kickoff" on public.picks;
create policy "pick before kickoff" on public.picks
  for insert to authenticated
  with check (user_id = auth.uid() and (public.game_is_open(game_id, team) or public.game_is_catch_up(game_id, team)));

drop policy if exists "change pick before kickoff" on public.picks;
create policy "change pick before kickoff" on public.picks
  for update to authenticated
  using (user_id = auth.uid() and public.game_is_open(game_id))
  with check (user_id = auth.uid() and public.game_is_open(game_id, team));

drop policy if exists "clear pick before kickoff" on public.picks;
create policy "clear pick before kickoff" on public.picks
  for delete to authenticated
  using (user_id = auth.uid() and public.game_is_open(game_id));

-- ---------------------------------------------------------------------------
-- Pool totals and standings (aggregates only; no one sees another player's picks)
-- ---------------------------------------------------------------------------

create or replace function public.pick_split(p_week int)
returns table (game_id text, team text, n bigint)
language sql stable security definer set search_path = public as $$
  select p.game_id, p.team, count(*)
  from public.picks p join public.games g on g.id = p.game_id
  where g.week = p_week
  group by p.game_id, p.team;
$$;

create or replace function public.standings()
returns table (player_id uuid, display_name text, wins bigint, losses bigint, ties bigint, picked bigint)
language sql stable security definer set search_path = public as $$
  select pr.id, pr.display_name,
    count(*) filter (where g.winner is not null and g.winner <> 'TIE' and p.team = g.winner),
    count(*) filter (where g.winner is not null and g.winner <> 'TIE' and p.team <> g.winner),
    count(*) filter (where g.winner = 'TIE'),
    count(p.game_id)
  from public.profiles pr
  left join public.picks p on p.user_id = pr.id
  left join public.games g on g.id = p.game_id
  group by pr.id, pr.display_name;
$$;

revoke all on function public.pick_split(int) from public, anon;
revoke all on function public.standings() from public, anon;
grant execute on function public.pick_split(int) to authenticated;
grant execute on function public.standings() to authenticated;

-- Live score updates reach open pages through Supabase Realtime.
do $$ begin
  alter publication supabase_realtime add table public.games;
exception when duplicate_object then null; end $$;

-- ---------------------------------------------------------------------------
-- Sync with ESPN
-- ---------------------------------------------------------------------------

create extension if not exists http with schema extensions;
create extension if not exists pg_cron;

create or replace function public.sync_week(p_week int)
returns int language plpgsql security definer set search_path = public, extensions as $$
declare
  body jsonb;
  ev jsonb;
  comp jsonb;
  h jsonb;
  a jsonb;
  st text;
  done boolean;
  n int := 0;
begin
  perform extensions.http_set_curlopt('CURLOPT_TIMEOUT_MS', '10000');
  select content::jsonb into body
  from extensions.http_get('https://site.api.espn.com/apis/site/v2/sports/football/nfl/scoreboard?dates=2026&seasontype=2&week=' || p_week);

  for ev in select * from jsonb_array_elements(coalesce(body -> 'events', '[]'::jsonb)) loop
    comp := ev -> 'competitions' -> 0;
    select x into h from jsonb_array_elements(comp -> 'competitors') x where x ->> 'homeAway' = 'home';
    select x into a from jsonb_array_elements(comp -> 'competitors') x where x ->> 'homeAway' = 'away';
    st := comp -> 'status' -> 'type' ->> 'state';
    done := coalesce((comp -> 'status' -> 'type' ->> 'completed')::boolean, false);

    insert into public.games as g (id, week, kickoff, away, home, away_score, home_score, state, winner, detail, intl, updated_at)
    values (
      ev ->> 'id',
      p_week,
      (ev ->> 'date')::timestamptz,
      a -> 'team' ->> 'abbreviation',
      h -> 'team' ->> 'abbreviation',
      case when st <> 'pre' then (a ->> 'score')::int end,
      case when st <> 'pre' then (h ->> 'score')::int end,
      st,
      case
        when coalesce((h ->> 'winner')::boolean, false) then h -> 'team' ->> 'abbreviation'
        when coalesce((a ->> 'winner')::boolean, false) then a -> 'team' ->> 'abbreviation'
        when done and (h ->> 'score') = (a ->> 'score') then 'TIE'
      end,
      comp -> 'status' -> 'type' ->> 'shortDetail',
      coalesce(comp -> 'venue' -> 'address' ->> 'country', 'USA') <> 'USA',
      now()
    )
    on conflict (id) do update set
      week = excluded.week, kickoff = excluded.kickoff, away = excluded.away, home = excluded.home,
      away_score = excluded.away_score, home_score = excluded.home_score, state = excluded.state,
      winner = excluded.winner, detail = excluded.detail, intl = excluded.intl, updated_at = now()
    where (g.kickoff, g.away_score, g.home_score, g.state, g.winner, g.detail)
      is distinct from (excluded.kickoff, excluded.away_score, excluded.home_score, excluded.state, excluded.winner, excluded.detail);
    n := n + 1;
  end loop;
  return n;
end $$;

-- The current week plus its neighbors: catches live scores, late stat corrections, and newly set kickoff times.
create or replace function public.sync_current()
returns int language plpgsql security definer set search_path = public as $$
declare
  cur int;
  total int := 0;
  w int;
begin
  select coalesce(min(week), 18) into cur
  from (select week, max(kickoff) as last_kick from public.games group by week) s
  where last_kick + interval '12 hours' > now();
  for w in select generate_series(greatest(cur - 1, 1), least(cur + 1, 18)) loop
    total := total + public.sync_week(w);
  end loop;
  return total;
end $$;

create or replace function public.sync_all()
returns int language plpgsql security definer set search_path = public as $$
declare total int := 0; w int;
begin
  for w in 1..18 loop total := total + public.sync_week(w); end loop;
  return total;
end $$;

revoke all on function public.sync_week(int) from public, anon, authenticated;
revoke all on function public.sync_current() from public, anon, authenticated;
revoke all on function public.sync_all() from public, anon, authenticated;

-- Every 2 minutes: live scores. Once a night: the whole season, for schedule changes.
select cron.schedule('nfl-sync-current', '*/2 * * * *', 'select public.sync_current()');
select cron.schedule('nfl-sync-all', '0 9 * * *', 'select public.sync_all()');
