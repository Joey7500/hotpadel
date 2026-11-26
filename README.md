# 🎾 HotPadel

Our weekly padel Americano (4 players, 21 balls per match): live scoring, history of every evening and overall stats.

**Web:** https://joey7500.github.io/hotpadel/

## How it works
- **Hrát:** enter scores during the game. The first saved match automatically creates a new evening with today's date. All phones see the results live.
- **Ukončit večer:** closes the evening and moves it to history. If you forget, it closes itself after 10 hours of inactivity.
- **Historie:** every evening by date. Tap one for the detail view. Tap any match to fix or delete it.
- **Statistiky:** overall table, form, records, best pairs, head-to-head and charts.

## Ranking
The evening table and the overall table are sorted by **points won** (the same order as +/−). Ties are broken by **wins**, then by **rating** (ELO + bonuses) as it was at the start of the evening.

## Animations
- **Evening roles**, following the current evening standings from its first entered match. Once the evening ends they stay until the next one starts:
  - 👑 1st: a rotating crown.
  - 😡 2nd: swinging a baseball bat, with an anger mark.
  - 😰 3rd: shivering and sweating.
  - 🍳 4th: in a pan with smoke.
- **Where roles show:** Tabulka večera (also when it's empty), the Hrát team avatars, the player cards on Statistiky, profiles and the end-of-evening screen. They don't show in Celková tabulka.
- 🔥 **Fire:** a current streak of 3 or more wins in a row. It lasts until the next loss, including over the week between evenings. It shows on large avatars only.
- ✨ **Overall leader** (most points in total): a golden halo with sparkles, shown only on the Statistiky player cards and in Celková tabulka.

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
