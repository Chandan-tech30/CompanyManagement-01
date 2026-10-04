# Migration notes (v1 → v2)

## What the old project actually used
The code you sent was **already on PostgreSQL** (`pg`) — only the old README still talked about `node:sqlite`, and there
was no `data/app.db` in the zip. File uploads went to **Supabase Storage if configured, otherwise to the local disk**
(`data/uploads`), which Render Free wipes on every deploy and wake-up. v2 removes the local-disk path and the Supabase SDK entirely.

## Steps
1. **Back up the database** (migration 002 restructures `messages` and drops old columns; it cannot be undone):
   `pg_dump "$DATABASE_URL" > backup-before-v2.sql`
2. Replace the code with v2, delete the old `package-lock.json`, run `npm install`.
3. Set the new environment variables (`S3_*`, `SESSION_SECRET`, `APP_TIMEZONE`, …) and remove `SUPABASE_*` and `DATA_DIR`.
4. Start the app. `db/migrations/002_portal_v2.sql` runs once, in a single transaction (all or nothing).

## What migration 002 does to existing data
| Old | New |
|---|---|
| `messages.employee_id` (one chat per employee) | `threads` (`dm` per employee, `team` per team) + `messages.thread_id`. Every old message is moved to its employee's thread. |
| `messages.attachment_path/_name` | one row in `files` per attachment (`legacy_url` kept), old columns dropped |
| `tasks.submission_file` | one row in `files` (`ref_type='task'`), column dropped |
| in-memory sessions | `session` table (PostgreSQL) |
| — | new tables: `files, teams, team_members, team_assignments, team_submissions, hidden_items, announcements, announcement_recipients, leave_requests, daily_activity`; new columns on `users`, `tasks`, `personal_projects` |

## Old files
* Files that already live at a public Supabase URL keep working: `/files/:id` redirects to the stored `legacy_url`.
* Files that were on the local disk (`/uploads/...`) are gone on Render Free; the app tells the viewer to ask for a re-upload.
* Company logo / avatars stored as old URLs keep working until you upload a new one; new uploads are stored in your bucket.
* To move existing Supabase files into R2 you would download them and upload them again (not automated).

## If you also have a real SQLite `app.db` from an even older version
It is not touched or read (there is no SQLite code left). Export it (`sqlite3 app.db .dump` or CSV per table), then import
into PostgreSQL with `psql`/`\copy`, matching the tables in `db/migrations/001_initial.sql`, before starting v2.

## Rollback
Restore the `pg_dump` from step 1 and redeploy the old code.
