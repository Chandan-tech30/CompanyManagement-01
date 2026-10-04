-- ==========================================================================
-- 002 · Portal v2
--   * object-storage file registry (files)         * chat threads (DM + team)
--   * teams, assignments, submissions               * announcements
--   * leave requests, settings, activity tracking   * DB-backed sessions
--   * per-user "delete for me" (hidden_items)
-- Runs once, inside a transaction (see db/index.js).
-- ==========================================================================

-- ---------- users ----------------------------------------------------------
ALTER TABLE users ADD COLUMN IF NOT EXISTS settings JSONB NOT NULL DEFAULT '{}'::jsonb;
ALTER TABLE users ADD COLUMN IF NOT EXISTS last_heartbeat_at TIMESTAMPTZ;
ALTER TABLE users ADD COLUMN IF NOT EXISTS announcements_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW();

-- allow the new 'left' status (employee left the portal)
DO $$
DECLARE c record;
BEGIN
  FOR c IN
    SELECT conname FROM pg_constraint
    WHERE conrelid = 'users'::regclass AND contype = 'c' AND pg_get_constraintdef(oid) LIKE '%pending_verification%'
  LOOP
    EXECUTE format('ALTER TABLE users DROP CONSTRAINT %I', c.conname);
  END LOOP;
END $$;
ALTER TABLE users ADD CONSTRAINT users_status_check
  CHECK (status IN ('pending_verification','pending_approval','approved','rejected','left'));

-- ---------- files (metadata; the bytes live in object storage) --------------
-- ref_type/ref_id say what a file belongs to:
--   message | task | project | team_submission | announcement | avatar | public
-- `key` is the object key in the bucket. `legacy_url` is only used for files that
-- were uploaded before the move to object storage.
CREATE TABLE IF NOT EXISTS files (
  id SERIAL PRIMARY KEY,
  ref_type TEXT NOT NULL,
  ref_id INTEGER,
  key TEXT,
  legacy_url TEXT,
  name TEXT NOT NULL,
  rel_path TEXT,
  mime TEXT,
  size INTEGER NOT NULL DEFAULT 0,
  uploader_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_files_ref ON files(ref_type, ref_id);

-- ---------- teams -----------------------------------------------------------
CREATE TABLE IF NOT EXISTS teams (
  id SERIAL PRIMARY KEY,
  name TEXT NOT NULL,
  description TEXT DEFAULT '',
  chat_mode TEXT NOT NULL DEFAULT 'all' CHECK (chat_mode IN ('all','admin_only','selected')),
  created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE TABLE IF NOT EXISTS team_members (
  team_id INTEGER NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  can_post BOOLEAN NOT NULL DEFAULT TRUE,
  joined_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (team_id, user_id)
);
CREATE INDEX IF NOT EXISTS idx_team_members_user ON team_members(user_id);
CREATE TABLE IF NOT EXISTS team_assignments (
  id SERIAL PRIMARY KEY,
  team_id INTEGER NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  description TEXT DEFAULT '',
  deadline TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_team_assignments_team ON team_assignments(team_id);
CREATE TABLE IF NOT EXISTS team_submissions (
  id SERIAL PRIMARY KEY,
  assignment_id INTEGER NOT NULL REFERENCES team_assignments(id) ON DELETE CASCADE,
  member_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  note TEXT DEFAULT '',
  status TEXT NOT NULL DEFAULT 'submitted' CHECK (status IN ('submitted','approved','rejected')),
  admin_feedback TEXT DEFAULT '',
  submitted_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  reviewed_at TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_team_submissions_assignment ON team_submissions(assignment_id);
CREATE INDEX IF NOT EXISTS idx_team_submissions_member ON team_submissions(member_id);

-- ---------- chat threads ----------------------------------------------------
CREATE TABLE IF NOT EXISTS threads (
  id SERIAL PRIMARY KEY,
  type TEXT NOT NULL CHECK (type IN ('dm','team')),
  employee_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
  team_id INTEGER REFERENCES teams(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_threads_dm ON threads(employee_id) WHERE type = 'dm';
CREATE UNIQUE INDEX IF NOT EXISTS uq_threads_team ON threads(team_id) WHERE type = 'team';

-- ---------- messages: move from "one chat per employee" to threads ----------
ALTER TABLE messages ADD COLUMN IF NOT EXISTS thread_id INTEGER REFERENCES threads(id) ON DELETE CASCADE;
ALTER TABLE messages ADD COLUMN IF NOT EXISTS sender_id INTEGER REFERENCES users(id) ON DELETE SET NULL;
ALTER TABLE messages ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ;

INSERT INTO threads (type, employee_id)
SELECT 'dm'::text, m.employee_id FROM messages m GROUP BY m.employee_id
ON CONFLICT DO NOTHING;

UPDATE messages m SET thread_id = t.id
FROM threads t
WHERE t.type = 'dm' AND t.employee_id = m.employee_id AND m.thread_id IS NULL;

UPDATE messages SET sender_id = employee_id WHERE sender_role = 'employee' AND sender_id IS NULL;
UPDATE messages SET sender_id = (SELECT id FROM users WHERE role = 'admin' ORDER BY id LIMIT 1)
WHERE sender_role = 'admin' AND sender_id IS NULL;

-- keep links of files uploaded before object storage existed
INSERT INTO files (ref_type, ref_id, legacy_url, name, size, uploader_id, created_at)
SELECT 'message', m.id, m.attachment_path,
       COALESCE(NULLIF(m.attachment_name, ''), NULLIF(regexp_replace(m.attachment_path, '^.*/', ''), ''), 'attachment'),
       0, m.sender_id, m.created_at
FROM messages m
WHERE m.attachment_path IS NOT NULL AND m.attachment_path <> '';

ALTER TABLE messages ALTER COLUMN thread_id SET NOT NULL;
ALTER TABLE messages DROP COLUMN employee_id;
ALTER TABLE messages DROP COLUMN attachment_path;
ALTER TABLE messages DROP COLUMN attachment_name;
CREATE INDEX IF NOT EXISTS idx_messages_thread ON messages(thread_id, id);

-- ---------- tasks -----------------------------------------------------------
ALTER TABLE tasks ADD COLUMN IF NOT EXISTS approved_at TIMESTAMPTZ;
UPDATE tasks SET approved_at = updated_at WHERE status = 'approved' AND approved_at IS NULL;

INSERT INTO files (ref_type, ref_id, legacy_url, name, size, uploader_id, created_at)
SELECT 'task', t.id, t.submission_file,
       COALESCE(NULLIF(regexp_replace(t.submission_file, '^.*/', ''), ''), 'submitted file'),
       0, t.employee_id, t.updated_at
FROM tasks t
WHERE t.submission_file IS NOT NULL AND t.submission_file <> '';
ALTER TABLE tasks DROP COLUMN submission_file;

-- ---------- personal projects ----------------------------------------------
ALTER TABLE personal_projects ADD COLUMN IF NOT EXISTS completed_at TIMESTAMPTZ;

-- ---------- "delete for me" (messages, tasks, team assignments) -------------
CREATE TABLE IF NOT EXISTS hidden_items (
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind TEXT NOT NULL,
  item_id INTEGER NOT NULL,
  hidden_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (user_id, kind, item_id)
);

-- ---------- announcements ---------------------------------------------------
CREATE TABLE IF NOT EXISTS announcements (
  id SERIAL PRIMARY KEY,
  topic TEXT NOT NULL,
  description TEXT DEFAULT '',
  link_url TEXT,
  audience TEXT NOT NULL DEFAULT 'all' CHECK (audience IN ('all','selected')),
  created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE TABLE IF NOT EXISTS announcement_recipients (
  announcement_id INTEGER NOT NULL REFERENCES announcements(id) ON DELETE CASCADE,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  PRIMARY KEY (announcement_id, user_id)
);
CREATE INDEX IF NOT EXISTS idx_announcement_recipients_user ON announcement_recipients(user_id);

-- ---------- leave requests --------------------------------------------------
-- kind: time_off = a normal leave of absence, leave_portal = employee wants to leave the portal / company
CREATE TABLE IF NOT EXISTS leave_requests (
  id SERIAL PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('time_off','leave_portal')),
  start_date DATE,
  end_date DATE,
  reason TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','approved','rejected')),
  admin_note TEXT DEFAULT '',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  decided_at TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_leave_requests_user ON leave_requests(user_id);
CREATE INDEX IF NOT EXISTS idx_leave_requests_status ON leave_requests(status);

-- ---------- time worked per day (feeds the Progress chart) ------------------
CREATE TABLE IF NOT EXISTS daily_activity (
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  day DATE NOT NULL,
  active_seconds INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (user_id, day)
);

-- ---------- Express sessions (connect-pg-simple) ----------------------------
CREATE TABLE IF NOT EXISTS session (
  sid VARCHAR NOT NULL PRIMARY KEY,
  sess JSON NOT NULL,
  expire TIMESTAMP(6) NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_session_expire ON session(expire);
