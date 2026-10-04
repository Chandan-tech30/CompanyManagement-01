// Time-worked tracking (heartbeat) + the data behind the Progress chart.
const db = require('../db');
const { appTimezone, todayKey, addDaysKey } = require('../utils/helpers');

// The browser sends a heartbeat every ~30 s while the employee is actually using the portal
// (tab visible + recent mouse/keyboard). We credit the time since the previous heartbeat,
// so spamming the endpoint cannot add more than real elapsed time.
async function recordHeartbeat(user) {
  const now = Date.now();
  const last = user.last_heartbeat_at ? new Date(user.last_heartbeat_at).getTime() : 0;
  const gap = Math.round((now - last) / 1000);
  if (last && gap < 5) return 0;
  const add = last && gap <= 90 ? gap : 30; // first beat after a break = one interval
  await db.run(
    `INSERT INTO daily_activity (user_id, day, active_seconds) VALUES (?, (NOW() AT TIME ZONE ?::text)::date, ?)
     ON CONFLICT (user_id, day) DO UPDATE SET active_seconds = daily_activity.active_seconds + EXCLUDED.active_seconds`,
    [user.id, appTimezone(), add]
  );
  await db.run('UPDATE users SET last_heartbeat_at = NOW() WHERE id = ?', [user.id]);
  return add;
}

function dayLabel(key) {
  return new Date(`${key}T00:00:00Z`).toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' });
}

// { days: [{ date, label, seconds, hours, completed: [{title, kind}] }], totals... }
async function getActivity(userId, range = 14) {
  const tz = appTimezone();
  const today = todayKey(tz);
  const start = addDaysKey(today, -(range - 1));

  const rows = await db.all(
    `SELECT day::text AS day, active_seconds FROM daily_activity WHERE user_id = ? AND day >= ?::date`,
    [userId, start]
  );
  const secondsByDay = Object.fromEntries(rows.map((r) => [r.day, r.active_seconds]));

  // Things the employee finished: approved tasks, completed personal projects, approved team submissions.
  const done = await db.all(
    `SELECT to_char(timezone(?::text, t.approved_at), 'YYYY-MM-DD') AS day, t.title AS title, 'task' AS kind
       FROM tasks t WHERE t.employee_id = ? AND t.status = 'approved' AND t.approved_at >= NOW() - INTERVAL '60 days'
     UNION ALL
     SELECT to_char(timezone(?::text, p.completed_at), 'YYYY-MM-DD'), p.name, 'project'
       FROM personal_projects p WHERE p.user_id = ? AND p.completed_at >= NOW() - INTERVAL '60 days'
     UNION ALL
     SELECT to_char(timezone(?::text, s.reviewed_at), 'YYYY-MM-DD'), a.title, 'team'
       FROM team_submissions s JOIN team_assignments a ON a.id = s.assignment_id
       WHERE s.member_id = ? AND s.status = 'approved' AND s.reviewed_at >= NOW() - INTERVAL '60 days'`,
    [tz, userId, tz, userId, tz, userId]
  );
  const completedByDay = {};
  done.forEach((d) => { (completedByDay[d.day] = completedByDay[d.day] || []).push({ title: d.title, kind: d.kind }); });

  const days = [];
  for (let i = range - 1; i >= 0; i--) {
    const date = addDaysKey(today, -i);
    const seconds = secondsByDay[date] || 0;
    days.push({ date, label: dayLabel(date), seconds, hours: Math.round((seconds / 3600) * 100) / 100, completed: completedByDay[date] || [] });
  }
  const totalSeconds = days.reduce((s, d) => s + d.seconds, 0);
  const activeDays = days.filter((d) => d.seconds > 0).length;
  return {
    range, tz, days, totalSeconds, activeDays,
    totalHours: Math.round((totalSeconds / 3600) * 10) / 10,
    avgHours: activeDays ? Math.round((totalSeconds / activeDays / 3600) * 10) / 10 : 0,
    completedCount: days.reduce((s, d) => s + d.completed.length, 0),
  };
}

// CSV for Excel / Tableau / Power BI. Cells starting with = + - @ are prefixed to block formula injection.
function csvCell(v) {
  let s = String(v ?? '');
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}
function activityCsv(activity) {
  const lines = ['date,active_hours,active_minutes,completed_count,completed_items'];
  activity.days.forEach((d) => {
    lines.push([d.date, d.hours, Math.round(d.seconds / 60), d.completed.length, d.completed.map((c) => `${c.title} (${c.kind})`).join('; ')].map(csvCell).join(','));
  });
  return lines.join('\r\n') + '\r\n';
}

module.exports = { recordHeartbeat, getActivity, activityCsv };
