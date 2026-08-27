import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import path from 'path';
import { fileURLToPath } from 'url';
import Imap from 'imap';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = process.env.PORT || 3000;
const SITE_PASSWORD = process.env.SITE_PASSWORD || 'Y##';

app.use(cors());
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ limit: '50mb', extended: true }));
app.use(express.static(path.join(__dirname, 'public')));

// Helper function: RFC 822 format email structure banana
function buildRawEmail({ from, to, subject, body }) {
  const dateStr = new Date().toUTCString();
  return [
    `From: ${from}`,
    `To: ${to}`,
    `Subject: ${subject}`,
    `Date: ${dateStr}`,
    'Content-Type: text/plain; charset=utf-8',
    'MIME-Version: 1.0',
    '',
    body
  ].join('\r\n');
}

// Helper function: IMAP connection se Draft folder me mail save karna
function saveToDrafts(email, appPassword, recipientEmail, subject, body) {
  return new Promise((resolve, reject) => {
    const cleanEmail = email.toLowerCase().trim();
    const cleanPass = appPassword.replace(/\s+/g, '').trim();

    const imap = new Imap({
      user: cleanEmail,
      password: cleanPass,
      host: 'imap.gmail.com',
      port: 993,
      tls: true,
      tlsOptions: { rejectUnauthorized: false }
    });

    imap.once('ready', () => {
      // Gmail me Drafts folder ka naam standard '[Gmail]/Drafts' hota hai
      imap.openBox('[Gmail]/Drafts', false, (err) => {
        if (err) {
          imap.end();
          return reject(new Error('Drafts folder nahi mil saka: ' + err.message));
        }

        const rawMessage = buildRawEmail({
          from: cleanEmail,
          to: recipientEmail,
          subject: subject,
          body: body
        });

        // Draft folder me insert karna (Flag: \Draft)
        imap.append(rawMessage, { mailbox: '[Gmail]/Drafts', flags: ['\\Draft'] }, (appendErr) => {
          imap.end();
          if (appendErr) return reject(appendErr);
          resolve(true);
        });
      });
    });

    imap.once('error', (err) => {
      reject(err);
    });

    imap.connect();
  });
}

/* ==========================================================================
   API ROUTES
   ========================================================================== */
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.post('/api/auth', (req, res) => {
  const { password } = req.body;
  if (password === SITE_PASSWORD) return res.json({ success: true, message: 'Authorized' });
  return res.status(401).json({ success: false, message: 'Unauthorized Password' });
});

/* ==========================================================================
   SAVE DRAFTS STREAMING ROUTE
   ========================================================================== */
app.post('/api/send-stream', async (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');

  const { email, appPassword, subject, messageBody, recipients } = req.body;

  if (!email || !appPassword || !Array.isArray(recipients) || recipients.length === 0) {
    res.write(`data: ${JSON.stringify({ success: false, error: 'Invalid Input Data' })}\n\n`);
    res.end();
    return;
  }

  const keepAlivePing = setInterval(() => {
    try { res.write(': keep-alive\n\n'); } catch {}
  }, 4000);

  const finalSubject = subject || 'Quick Note';
  const finalBody = messageBody || 'Hello, testing draft.';

  for (let i = 0; i < recipients.length; i++) {
    const rawRecipient = recipients[i];
    const recipientEmail = typeof rawRecipient === 'object' ? rawRecipient.email : rawRecipient;

    if (!recipientEmail || !recipientEmail.includes('@')) {
      res.write(`data: ${JSON.stringify({ success: false, recipient: recipientEmail, error: 'Invalid Email' })}\n\n`);
      continue;
    }

    try {
      await saveToDrafts(email, appPassword, recipientEmail.trim(), finalSubject, finalBody);
      res.write(`data: ${JSON.stringify({ success: true, recipient: recipientEmail, message: 'Saved to Drafts' })}\n\n`);
    } catch (err) {
      res.write(`data: ${JSON.stringify({ success: false, recipient: recipientEmail, error: err.message })}\n\n`);
    }

    // Micro delay (200ms) between draft creations
    if (i < recipients.length - 1) {
      await new Promise(resolve => setTimeout(resolve, 200));
    }
  }

  clearInterval(keepAlivePing);
  res.write('data: [DONE]\n\n');
  res.end();
});

app.listen(PORT, () => {
  console.log(`🚀 Draft Saver server running on port ${PORT}`);
});

export default app;
