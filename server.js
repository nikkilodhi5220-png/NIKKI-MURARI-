import 'dotenv/config';
import express from 'express';
import nodemailer from 'nodemailer';
import cors from 'cors';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = process.env.PORT || 3000;
const SITE_PASSWORD = process.env.SITE_PASSWORD || 'Y##';

// Standard Express Setup
app.use(cors());
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ limit: '50mb', extended: true }));
app.use(express.static(path.join(__dirname, 'public')));

// Safe Transporter Generator (Strict Port 465 SSL for Guaranteed Handshake)
function createDirectTransporter(email, appPassword) {
  const cleanEmail = email.toLowerCase().trim();
  const cleanPass = appPassword.replace(/\s+/g, '').trim();

  return nodemailer.createTransport({
    host: 'smtp.gmail.com',
    port: 465,
    secure: true,
    auth: {
      user: cleanEmail,
      pass: cleanPass
    },
    tls: {
      rejectUnauthorized: false
    },
    connectionTimeout: 20000,
    greetingTimeout: 20000,
    socketTimeout: 20000
  });
}

function parseRecipient(input) {
  if (typeof input === 'object' && input !== null) {
    return (input.email || input.recipient || '').trim();
  }
  return String(input || '').trim();
}

/* ==========================================================================
   ROUTES
   ========================================================================== */
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.post('/api/auth', (req, res) => {
  const { password } = req.body;
  if (password === SITE_PASSWORD) return res.json({ success: true, message: 'Authorized' });
  return res.status(401).json({ success: false, message: 'Unauthorized Password' });
});

// Single & Stream Handlers for Compatibility with Both UI Types
app.post(['/api/send-stream', '/api/send'], async (req, res) => {
  const isSSE = req.headers.accept && req.headers.accept.includes('text/event-stream');

  if (isSSE) {
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache, no-transform');
    res.setHeader('Connection', 'keep-alive');
  }

  const { email, appPassword, senderName, subject, messageBody, recipients } = req.body;

  if (!email || !appPassword || !Array.isArray(recipients) || recipients.length === 0) {
    const errResp = { success: false, error: 'Missing required fields' };
    if (isSSE) {
      res.write(`data: ${JSON.stringify(errResp)}\n\n`);
      return res.end();
    }
    return res.status(400).json(errResp);
  }

  const cleanSender = (senderName || '').trim();
  const cleanEmail = email.toLowerCase().trim();
  const transporter = createDirectTransporter(email, appPassword);

  // Verify SMTP Connection first
  try {
    await transporter.verify();
  } catch (verifyErr) {
    const authErr = { success: false, error: `Gmail Auth Error: ${verifyErr.message}` };
    if (isSSE) {
      res.write(`data: ${JSON.stringify(authErr)}\n\n`);
      return res.end();
    }
    return res.status(401).json(authErr);
  }

  const results = [];

  for (let i = 0; i < recipients.length; i++) {
    const targetEmail = parseRecipient(recipients[i]);
    if (!targetEmail || !targetEmail.includes('@')) continue;

    const mailOptions = {
      from: cleanSender ? `"${cleanSender}" <${cleanEmail}>` : cleanEmail,
      to: targetEmail,
      subject: subject || 'No Subject',
      text: messageBody || '',
      html: `<div style="font-family: sans-serif; font-size: 14px; color: #111;">${(messageBody || '').replace(/\n/g, '<br>')}</div>`
    };

    try {
      await transporter.sendMail(mailOptions);
      const successItem = { success: true, recipient: targetEmail };
      results.push(successItem);

      if (isSSE) {
        res.write(`data: ${JSON.stringify(successItem)}\n\n`);
      }
    } catch (sendErr) {
      const failItem = { success: false, recipient: targetEmail, error: sendErr.message };
      results.push(failItem);

      if (isSSE) {
        res.write(`data: ${JSON.stringify(failItem)}\n\n`);
      }
    }
  }

  if (isSSE) {
    res.write('data: [DONE]\n\n');
    return res.end();
  } else {
    return res.json({ success: true, results: results });
  }
});

app.post('/api/stop', (req, res) => {
  res.json({ success: true, message: 'Stopped' });
});

app.listen(PORT, () => {
  console.log(`🚀 Mailer active on port ${PORT}`);
});

export default app;
