CREATE TABLE IF NOT EXISTS users (
  id SERIAL PRIMARY KEY,
  full_name TEXT NOT NULL,
  email TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  phone TEXT DEFAULT '',
  role TEXT NOT NULL CHECK(role IN ('admin','employee')) DEFAULT 'employee',
  status TEXT NOT NULL CHECK(status IN ('pending_verification','pending_approval','approved','rejected')) DEFAULT 'pending_verification',
  verification_token TEXT,
  job_role TEXT DEFAULT 'Not assigned yet',
  bio TEXT DEFAULT '',
  skills TEXT DEFAULT '',
  avatar_path TEXT,
  admin_unread INTEGER NOT NULL DEFAULT 0,
  employee_unread INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE TABLE IF NOT EXISTS company (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  name TEXT NOT NULL DEFAULT 'StartOver',
  logo_path TEXT,
  ethics TEXT DEFAULT 'Add your company''s values and code of ethics here from the admin Home tab.',
  agenda TEXT DEFAULT 'Add your company''s mission and agenda here from the admin Home tab.',
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE TABLE IF NOT EXISTS tasks (
  id SERIAL PRIMARY KEY,
  employee_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  description TEXT DEFAULT '',
  deadline TEXT,
  status TEXT NOT NULL CHECK(status IN ('assigned','submitted','approved')) DEFAULT 'assigned',
  submission_note TEXT DEFAULT '',
  submission_file TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE TABLE IF NOT EXISTS messages (
  id SERIAL PRIMARY KEY,
  employee_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  sender_role TEXT NOT NULL CHECK(sender_role IN ('admin','employee')),
  body TEXT DEFAULT '',
  attachment_path TEXT,
  attachment_name TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE TABLE IF NOT EXISTS personal_projects (
  id SERIAL PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  concept TEXT DEFAULT '',
  details TEXT DEFAULT '',
  color TEXT DEFAULT '#6d5ef5',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE TABLE IF NOT EXISTS growth_points (
  id SERIAL PRIMARY KEY,
  label TEXT NOT NULL,
  value REAL NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE TABLE IF NOT EXISTS activity_log (
  id SERIAL PRIMARY KEY,
  employee_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  action TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_tasks_employee ON tasks(employee_id);
CREATE INDEX IF NOT EXISTS idx_messages_employee ON messages(employee_id);
CREATE INDEX IF NOT EXISTS idx_projects_user ON personal_projects(user_id);
CREATE INDEX IF NOT EXISTS idx_activity_employee_date ON activity_log(employee_id, created_at);
