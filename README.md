# NFL Pick Sheet

Pick the winner of every 2026 NFL regular-season game. Each player has an account, picks lock at kickoff, scores update on their own, and a standings page ranks everyone.

- **Site:** plain HTML, CSS and JavaScript. There's no build step, so Vercel serves the folder as is.
- **Backend:** [Supabase](https://supabase.com) holds accounts, picks and the schedule.
- **Kickoff lock:** enforced in the database, so nobody can change a pick after a game starts, whatever their browser sends.
- **Scores:** the database pulls live scores and schedule changes from ESPN every 2 minutes, and open pages update as they come in.
- **Privacy:** players only see their own picks. Everyone else's show up only as the pool's percentages and on the standings.
- **Catch-up weeks (2026 only):** the site opened partway through the season, so everyone starts fresh but can still pick games from Weeks 1–7 that were already played. Each of those picks takes two taps to lock in and can never be changed or cleared afterward. From Week 8 on, picks lock at kickoff. The database enforces both rules. To change the cutoff, edit `g.week <= 7` in `game_is_catch_up` (in `schema.sql`) and `CATCH_UP_LAST_WEEK` in `app.js`.

## 1. Create the Supabase project

1. Sign up at supabase.com and create a new project. Any name and region work; save the database password it gives you.
2. Open **SQL Editor**, paste all of [`supabase/schema.sql`](supabase/schema.sql), and click **Run**.
3. Open a new query, paste all of [`supabase/seed.sql`](supabase/seed.sql), and run it. This loads the full schedule.
4. Optional check: run `select public.sync_current();`. It should return a number around 40, meaning it fetched the current week and its neighbors from ESPN.

### Sign-in settings

Under **Authentication**:

- **URL Configuration:** set **Site URL** to your Vercel address once you have it (step 3), e.g. `https://nfl-pick-sheet.vercel.app`. Add the same address under **Redirect URLs**. Confirmation and password-reset emails link back to it.
- **Providers → Email:** this is on by default. **Confirm email** is also on by default, so new players must click a link in an email before they can sign in. To let people play right after signing up, turn it off.
- Supabase's built-in email sender only allows a few emails per hour. That's fine for a small group; for a bigger pool, add your own SMTP under **Project Settings → Authentication**.

## 2. Connect the site to Supabase

In **Project Settings → API**, copy the **Project URL** and the **anon public** key into [`config.js`](config.js):

```js
export const CONFIG = {
  supabaseUrl: "https://abcdefgh.supabase.co",
  supabaseAnonKey: "eyJhbGciOi...",
};
```

The anon key is designed to be public. The database's row-level security rules are what protect the data. Never put the **service_role** key in this file.

## 3. Deploy on Vercel

1. Put this folder in a GitHub repository.
2. At vercel.com, choose **Add New → Project**, import the repository, and leave every setting at its default (Framework: **Other**, no build command).
3. Click **Deploy**. Every push to the repository redeploys the site.
4. Copy the address Vercel gives you back into the Supabase **Site URL** (step 1).

## Trying it locally

Any static file server works:

```bash
python -m http.server 8000
```

Then open http://localhost:8000. To have sign-up emails link back to your local copy, add `http://localhost:8000` to the Supabase Redirect URLs.

## Files

| Path | What it is |
|---|---|
| `index.html`, `styles.css`, `app.js` | The site: sign-in, pick sheet, standings |
| `config.js` | Your Supabase URL and anon key |
| `teams.js`, `logos/` | Team names, colors and logos |
| `supabase/schema.sql` | Tables, security rules, pool totals, standings, ESPN sync jobs |
| `supabase/seed.sql` | The 2026 schedule as of October 20, 2026 |

## Next season

Change `dates=2026` to the new year in `sync_week` (in `schema.sql`), rerun that function definition, clear the old games and picks, and run `select public.sync_all();`. Catch-up picking only applies to 2026 games, so a new season starts with normal kickoff locks.
