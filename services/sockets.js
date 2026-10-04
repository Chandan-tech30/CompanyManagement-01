// Socket.IO wiring. Authentication uses the SAME session cookie as the website (sessions live in
// PostgreSQL), so there is nothing to expire while a tab stays open and a reconnect after Render
// woke up just works: the browser reconnects, re-joins its room and reloads the history.
const db = require('../db');
const { getThreadContext } = require('./chat');

function attachSockets(io, sessionMiddleware) {
  io.engine.use(sessionMiddleware);

  io.use(async (socket, next) => {
    try {
      const userId = socket.request.session && socket.request.session.userId;
      if (!userId) return next(new Error('unauthorized'));
      const user = await db.get('SELECT * FROM users WHERE id = ?', [userId]);
      if (!user || (user.role === 'employee' && user.status !== 'approved')) return next(new Error('unauthorized'));
      socket.data.user = user;
      next();
    } catch (err) { next(err); }
  });

  io.on('connection', (socket) => {
    const user = socket.data.user;
    socket.join(`user-${user.id}`);                                   // personal notifications
    socket.join(user.role === 'admin' ? 'admins' : 'employees');      // broadcast groups

    // Client asks to (re-)join a chat room. Access is re-checked in the database every time.
    socket.on('join', async (payload, ack) => {
      try {
        const ctx = await getThreadContext(user, Number(payload && payload.threadId));
        if (!ctx) return typeof ack === 'function' && ack({ ok: false });
        socket.join(`thread-${ctx.thread.id}`);
        if (typeof ack === 'function') ack({ ok: true });
      } catch (err) {
        console.error('[socket] join failed:', err.message);
        if (typeof ack === 'function') ack({ ok: false });
      }
    });

    socket.on('leave', (payload) => {
      const id = Number(payload && payload.threadId);
      if (Number.isInteger(id)) socket.leave(`thread-${id}`);
    });
  });
}

module.exports = { attachSockets };
