const nodemailer = require('nodemailer');

let transporter = null;
const usingRealSmtp = Boolean(process.env.SMTP_HOST && process.env.SMTP_USER && process.env.SMTP_PASS);

if (usingRealSmtp) {
  transporter = nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port: Number(process.env.SMTP_PORT) || 587,
    secure: Number(process.env.SMTP_PORT) === 465,
    auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS }
  });
}

// Always resolves (never throws) so a broken SMTP config can never block
// registration/approval flows. `sent` tells the caller whether real delivery
// happened, so routes can decide whether to show the link on-screen too.
async function sendMail({ to, subject, html }) {
  if (usingRealSmtp) {
    try {
      await transporter.sendMail({
        from: process.env.EMAIL_FROM || 'no-reply@company.local',
        to, subject, html
      });
      return { sent: true };
    } catch (err) {
      console.error(`[mailer] send failed for "${subject}" to ${to}:`, err.message);
    }
  }
  console.log(`\n[DEV EMAIL] To: ${to}\nSubject: ${subject}\n${html.replace(/<[^>]+>/g, ' ').trim()}\n`);
  return { sent: false };
}

function sendVerificationEmail(to, link) {
  return sendMail({
    to,
    subject: 'Verify your email',
    html: `<p>Welcome! Please verify your email to continue your registration.</p><p><a href="${link}">${link}</a></p>`
  });
}

function sendApprovalEmail(to, loginUrl) {
  return sendMail({
    to,
    subject: 'Your account has been approved',
    html: `<p>Good news - your account has been approved. You can now log in.</p><p><a href="${loginUrl}">${loginUrl}</a></p>`
  });
}

function sendRejectionEmail(to) {
  return sendMail({
    to,
    subject: 'Registration update',
    html: `<p>Your registration was not approved at this time. Please contact your company admin for more information.</p>`
  });
}

function sendPasswordResetEmail(to, link) {
  return sendMail({
    to,
    subject: 'Reset your password',
    html: `<p>We got a request to reset your password. This link works once and expires in 1 hour:</p>
           <p><a href="${link}">${link}</a></p>
           <p>If you didn't ask for this, you can safely ignore this email — your password will not change.</p>`
  });
}

module.exports = {
  sendMail, sendVerificationEmail, sendApprovalEmail, sendRejectionEmail, sendPasswordResetEmail, usingRealSmtp,
};
