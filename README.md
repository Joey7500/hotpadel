# 🎾 HotPadel

Our weekly padel Americano (4 players, 21 balls per match): live scoring, history of every evening and overall stats.

**Web:** https://joey7500.github.io/hotpadel/

## How it works
- **Hrát:** enter scores during the game. The first saved match automatically creates a new evening with today's date. All phones see the results live.
- **Ukončit večer:** closes the evening and moves it to history. If you forget, it closes itself after 10 hours of inactivity.
- **Historie:** every evening by date. Tap one for the detail view. Tap any match to fix or delete it.
- **Statistiky:** overall table, form, records, best pairs, head-to-head and charts.

## Tech
- Static site (`index.html`, `style.css`, `app.js`) on GitHub Pages, with no build step.
- Database: Supabase (Postgres), tables `sessions` and `matches`. Schema and seed are in `supabase/setup.sql`.
- Backup: the GitHub Action `.github/workflows/backup.yml` downloads all data into `backups/` every day and also keeps Supabase from going to sleep.
- In-app backup: Statistiky → "Stáhnout zálohu dat (JSON)".

## Restoring from a backup
The `backups/YYYY-MM-DD.json` files contain `sessions` and `matches`. Ask Claude to load them back into Supabase.
