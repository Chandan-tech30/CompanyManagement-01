# StartOver Company Portal


<p align="center">
  <a href="https://company-portal-qm50.onrender.com">
    <img src="https://img.shields.io/badge/demo-live-brightgreen?style=for-the-badge&logo=render&logoColor=white" alt="Live Demo">
  </a>
  <img src="https://img.shields.io/badge/node.js-%3E%3D20-339933?style=for-the-badge&logo=node.js&logoColor=white" alt="Node">
  <img src="https://img.shields.io/badge/postgresql-database-4169E1?style=for-the-badge&logo=postgresql&logoColor=white" alt="PostgreSQL">
  <img src="https://img.shields.io/badge/license-ISC-blue?style=for-the-badge" alt="License">
</p>

Two portals (**Admin** and **Employee**) in one Node.js app: live chat, teams and assignments, announcements,
projects with a file store, progress charts, settings. Server-rendered with **EJS + HTMX + Alpine**, live updates
over **Socket.IO**. The app itself is **stateless** — everything permanent lives outside it:

```
                    INTERNET
                        │
                 ┌──────▼──────┐
                 │ Render Free │      (sleeps when idle, wakes on the next request)
                 └──────┬──────┘
                Node.js / Express
      ┌─────────────────┼──────────────────┐
      ▼                 ▼                  ▼
 EJS / HTMX         Socket.IO         API / routes
                        │
            ┌───────────┴────────────┐
            ▼                        ▼
       PostgreSQL            S3-compatible object storage
 users · messages · tasks    (Cloudflare R2 / AWS S3 / …)
 teams · sessions · files    images · attachments · projects · media
 (file metadata + keys)
```

* **Database:** PostgreSQL only (`pg` connection pool, SQL migrations in `db/migrations`). Sessions are in PostgreSQL too,
  so a restart or Render's sleep never logs anyone out.
* **Files:** never on the local disk. Uploads go to your bucket; PostgreSQL stores only the object *key* and metadata
  (`files` table). The bucket stays **private**: the app checks who is asking and redirects to a short-lived signed URL.
* **Real time:** Socket.IO delivers instantly, but every message is written to PostgreSQL **first**. After a dropped
  connection or a Render wake-up the browser reconnects, re-joins its room and reloads the history from the database.

---

## 🚀 Live Demo

**[company-portal-qm50.onrender.com](https://company-portal-qm50.onrender.com)**

> Hosted on Render's free tier — if it's been idle a few minutes, the first load can take 30–50s to wake up. That's normal, not a bug.

| Portal | Path |
|---|---|
| Employee | [`/register`](https://company-portal-qm50.onrender.com/register) — create an account and look around |
| Admin | `/login/admin` — kept private, not for public demo use |


## 1. Run it locally (Windows / macOS / Linux, with Docker Desktop)

You do **not** need to install PostgreSQL or a storage server: `docker-compose.yml` starts both in Docker.
You only install **Node.js** (LTS, version 20 or newer).

1. Install **Docker Desktop** and start it (wait until it says it is running).
2. Install **Node.js LTS** from <https://nodejs.org>, then open a *new* terminal and check `node -v` and `npm -v`.
3. In the project folder (the one containing `package.json`):

   ```bash
   docker compose up -d                 # PostgreSQL + file storage (first run downloads images)
   docker compose ps                    # both should say "running"
   ```

   Copy the ready-made settings to `.env`:

   | Terminal | Command |
   |---|---|
   | Windows Command Prompt | `copy .env.docker.example .env` |
   | Windows PowerShell | `Copy-Item .env.docker.example .env` |
   | macOS / Linux | `cp .env.docker.example .env` |

   ```bash
   npm install                          # once (a few minutes)
   npm start                            # http://localhost:3000
   ```
4. Open <http://localhost:3000>. Admin login: <http://localhost:3000/login/admin> with `ADMIN_EMAIL` / `ADMIN_PASSWORD`
   from `.env` (`admin@startover.local` / `Admin@12345` by default). Change the password in the ⚙ Settings.

On start the app applies the SQL migrations, creates the first admin (only if no admin exists) and creates the storage
bucket (`S3_AUTO_CREATE_BUCKET=true`). `npm run seed` resets the admin's password, `npm run migrate` only runs migrations,
`npm run dev` restarts on file changes.

Everyday use: `docker compose up -d` then `npm start`; stop with `Ctrl+C` and `docker compose stop`.
`docker compose down -v` deletes the local database and files (fresh start).

* Storage web console: <http://localhost:9001> (user `portaladmin`, password `portaladmin-secret`).
* The download links are opened by your browser, so `S3_ENDPOINT` must stay `http://localhost:9000` — not a Docker-internal name.
* The storage container is **SILO**, a maintained fork of MinIO (MinIO itself no longer publishes Docker images).
  Prefer the real thing? Use a Cloudflare R2 bucket instead (see below) and skip the `storage` service.

### Without Docker
* **PostgreSQL:** install it natively, or use a hosted free tier (Neon, Supabase) and paste its connection string into `DATABASE_URL`.
* **Storage:** **Cloudflare R2** (same as production): create a bucket, then *R2 → Manage API tokens → Create token* with
  **Object Read & Write** for that bucket. `S3_ENDPOINT=https://<ACCOUNT_ID>.r2.cloudflarestorage.com`, `S3_REGION=auto`,
  `S3_BUCKET`, `S3_ACCESS_KEY_ID`, `S3_SECRET_ACCESS_KEY`.

If the bucket or keys are wrong, the server log says so at start-up (`[storage] COULD NOT REACH BUCKET …`) and
uploads show a clear message on screen.

### Employees, locally
Employees register at `/register`. Without SMTP, the verification link is shown on screen and printed in the server log.
The admin approves them under **Registrations**, then they log in at `/login/employee`. Use a second browser (or a private
window) to be admin and employee at the same time.

---

## 2. Deploy on Render (free)

1. **Push the project to GitHub** (`.env` is git-ignored — never commit secrets). Delete `package-lock.json` if it is
   still there and run `npm install` once so a fresh one is committed.
2. **Database.** Create a free PostgreSQL at Neon or Supabase and copy the connection string.
   Use the *direct* (non-pooled) string if the provider offers both.
   > Render's own free PostgreSQL is deleted after 30 days, so it is not a good home for permanent data.
3. **Bucket.** Create a private Cloudflare R2 bucket and an API token (see above). Keep the endpoint, key id and secret handy.
   R2 may ask for a payment method when you enable it; the free allowance covers a small company portal.
4. **Web service.** Render → *New → Web Service* → your repo.
   * Runtime **Node**, Build command `npm install`, Start command `npm start`, Instance type **Free**
   * Advanced → **Health Check Path** `/healthz`
   * (or use the included `render.yaml` via *New → Blueprint*)
5. **Environment variables** (Render → your service → *Environment*):

   | Variable | Value |
   |---|---|
   | `NODE_VERSION` | `22` |
   | `NODE_ENV` | `production` |
   | `SESSION_SECRET` | long random string (`node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"`) |
   | `APP_BASE_URL` | your Render URL, e.g. `https://company-portal.onrender.com` |
   | `APP_TIMEZONE` | your IANA timezone (e.g. `Asia/Kolkata`) — where a "day" ends in the activity chart |
   | `DATABASE_URL` | PostgreSQL connection string |
   | `S3_ENDPOINT` | `https://<ACCOUNT_ID>.r2.cloudflarestorage.com` |
   | `S3_REGION` | `auto` |
   | `S3_BUCKET` | your bucket name |
   | `S3_ACCESS_KEY_ID` / `S3_SECRET_ACCESS_KEY` | from the R2 API token |
   | `ADMIN_NAME`, `ADMIN_EMAIL`, `ADMIN_PASSWORD` | first admin account (created automatically on first boot) |
   | `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASS`, `EMAIL_FROM` | optional, for real e-mails |
   | `MAX_UPLOAD_MB` / `MAX_MEDIA_MB` / `MAX_FILES_PER_UPLOAD` | optional, defaults 25 / 50 / 50 |

6. **Deploy**, open the URL, log in at `/login/admin`, change the admin password (⚙ Settings).

**How the free tier behaves.** Render Free stops the service after 15 minutes without traffic and wakes it on the next
request (the first page after a nap can take up to about a minute). Nothing is lost: data is in PostgreSQL, files in the
bucket, logins in the session table. Open chats show *Reconnecting…*, then reload their history by themselves. While
employees use the portal it also sends a small heartbeat, so it stays awake during working hours.

**Uploads and memory.** Files pass through the server's memory on their way to the bucket (Render Free has 512 MB), which is why
the defaults are 25 MB per file / 50 MB for announcement videos. Don't upload `node_modules`-sized folders.

---

## 3. What is where

| Area | Files |
|---|---|
| Config & start-up | `server.js`, `.env.example`, `render.yaml` |
| Database | `db/index.js` (pool, transactions, migration runner), `db/migrations/*.sql`, `db/bootstrap.js` |
| Object storage | `utils/storage.js` (S3/R2 client, signed URLs), `utils/upload.js` (multer), `services/files.js` |
| Chat & sockets | `routes/chat.js`, `services/chat.js`, `services/sockets.js`, `public/js/chat.js`, `views/partials/chat-*.ejs` |
| Uploads UI | `public/js/uploader.js`, `views/partials/uploader.ejs` |
| Projects | `routes/projects.js`, `views/partials/project-*.ejs` |
| Teams | `routes/admin-teams.js`, `routes/employee-teams.js`, `services/teams.js` |
| Announcements | `routes/admin-announcements.js`, `services/announcements.js` |
| Progress | `services/activity.js`, `public/js/activity.js`, `views/partials/activity-chart.ejs` |
| Settings | `routes/settings.js`, `views/partials/settings-modal.ejs`, `public/js/ui.js` |

## 4. Troubleshooting

* **"Could not save your file(s) to storage"** → check `S3_*` variables; the server log has the exact provider error.
* **Boot fails with `DATABASE_URL is not set` / `SESSION_SECRET must be set`** → add the variable in the Render dashboard.
* **Chart is empty** → time is recorded while the employee actively uses the portal (heartbeat every 30 s); a brand-new account has no history.
* **Uploads fail with a network error on very large folders** → reduce the folder size or raise `MAX_FILES_PER_UPLOAD` carefully.
