# 🎾 HotPadel

Our weekly padel Americano (4 players, 21 balls per match): live scoring, history of every evening and overall stats.

**Web:** https://joey7500.github.io/hotpadel/

## How it works
- **Hrát:** enter scores during the game. The first saved match automatically creates a new evening with today's date. All phones see the results live.
- **Ukončit večer:** closes the evening and moves it to history. If you forget, it closes itself after 10 hours of inactivity.
- **Historie:** every evening by date. Tap one for the detail view. Tap any match to fix or delete it.
- **Statistiky:** overall table, form, records, best pairs, head-to-head and charts.

## ELO and bonuses
The number shown next to each name is **ELO from matches + bonuses**.
- **ELO from matches:** a team's rating is the average of its two players. Bigger wins count more. It starts at 1000, uses K = 24, and is recalculated from the first evening every time anything changes.
- **Bonuses** are never taken away, and they **don't** affect the win percentages:
  - Playing a finished evening: **+10**.
  - Evening placement: 1st **+12**, 2nd **+8**, 3rd **+4**, 4th **0**. Players tied on wins and points split the bonus.
  - Every 5 wins in a row: **+5**. The streak carries over between evenings.
  - 15 or more balls won in a match: **+5** for each player of that team.
- The win percentages before each match come from match ELO only, so they stay a fair estimate.

## Tech
- Static site (`index.html`, `style.css`, `app.js`) on GitHub Pages, with no build step.
- Database: Supabase (Postgres), tables `sessions` and `matches`. Schema and seed are in `supabase/setup.sql`.
- Backup: the GitHub Action `.github/workflows/backup.yml` downloads all data into `backups/` every day and also keeps Supabase from going to sleep.
- In-app backup: Statistiky → "Stáhnout zálohu dat (JSON)".

## Restoring from a backup
The `backups/YYYY-MM-DD.json` files contain `sessions` and `matches`. Ask Claude to load them back into Supabase.
