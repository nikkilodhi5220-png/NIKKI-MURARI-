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

const globalSession = { stopRequested: false };

// Middlewares
app.use(cors());
app.use(express.json({ limit: "10mb" }));
app.use(express.static(path.join(__dirname, "public")));

/* ==========================================================================
   1. UTILITY FUNCTIONS & SPINTAX
   ========================================================================== */

// Spintax Processor: {Hello|Hi|Greetings}
function parseSpintax(text) {
  if (!text) return "";
  let spun = text;
  const regex = /{([^{}]+)}/g;
  let passes = 0;

  while (regex.test(spun) && passes < 10) {
    spun = spun.replace(regex, (_, choices) => {
      const options = choices.split('|');
      return options[Math.floor(Math.random() * options.length)];
    });
    passes++;
  }
  return spun;
}

// Convert HTML to Clean Plain Text (Crucial for Multipart MIME)
function createPlainTextFromHtml(html) {
  if (!html) return "";
  return html
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/p>/gi, '\n\n')
    .replace(/<\/div>/gi, '\n')
    .replace(/<[^>]*>/g, '')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/\n\s*\n/g, '\n\n')
    .trim();
}

/* ==========================================================================
   2. DYNAMIC TRANSPORTER (Supports Gmail, SES, Mailgun, Custom SMTP)
   ========================================================================== */
function createSmtpTransporter(smtpConfig) {
  const { host, port, user, pass } = smtpConfig;

  return nodemailer.createTransport({
    host: host || 'smtp.gmail.com',
    port: parseInt(port) || 587,
    secure: parseInt(port) === 465, // True for 465, False for 587
    auth: { user, pass },
    pool: true,
    maxConnections: 3,
    maxMessages: 100,
    tls: {
      rejectUnauthorized: true
    }
  });
}

/* ==========================================================================
   3. ROUTES & SSE DISPATCH ENGINE
   ========================================================================== */

app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.post('/api/auth', (req, res) => {
  const { password } = req.body;
  if (password === SITE_PASSWORD) {
    return res.json({ success: true, message: "Authorized" });
  }
  return res.status(401).json({ success: false, message: "Unauthorized Password" });
});

app.post('/api/verify', async (req, res) => {
  const { host, port, user, pass } = req.body;
  if (!user || !pass) {
    return res.status(400).json({ success: false, message: "Credentials Missing" });
  }

  try {
    const transporter = createSmtpTransporter({ host, port, user, pass });
    await transporter.verify();
    return res.json({ success: true, message: "SMTP Connection Verified Successfully" });
  } catch (err) {
    return res.status(401).json({ success: false, message: `SMTP Failed: ${err.message}` });
  }
});

app.post('/api/send-stream', async (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');

  const { smtpHost, smtpPort, email, appPassword, senderName, subject, messageBody, recipients } = req.body;

  if (!email || !appPassword || !Array.isArray(recipients) || recipients.length === 0) {
    res.write(`data: ${JSON.stringify({ success: false, error: "Invalid Request Payload" })}\n\n`);
    res.end();
    return;
  }

  const cleanEmail = email.toLowerCase().trim();
  const cleanSenderName = (senderName || "").replace(/"/g, "").trim();
  globalSession.stopRequested = false;

  const keepAlivePing = setInterval(() => {
    res.write(': keep-alive\n\n');
  }, 4000);

  const transporter = createSmtpTransporter({
    host: smtpHost,
    port: smtpPort,
    user: cleanEmail,
    pass: appPassword
  });

  for (let i = 0; i < recipients.length; i++) {
    if (globalSession.stopRequested) {
      res.write(`data: ${JSON.stringify({ success: false, error: "Process Stopped by User" })}\n\n`);
      break;
    }

    const recipient = recipients[i] ? recipients[i].trim() : "";
    if (!recipient) continue;

    try {
      const spunSubject = parseSpintax(subject);
      const spunBody = parseSpintax(messageBody);
      const plainTextBody = createPlainTextFromHtml(spunBody);

      // Clean RFC-Compliant Mail Structure
      const mailOptions = {
        from: cleanSenderName ? `"${cleanSenderName}" <${cleanEmail}>` : cleanEmail,
        to: recipient,
        replyTo: cleanEmail,
        subject: spunSubject,
        text: plainTextBody,       // Essential Plain-Text Version
        html: spunBody,            // HTML Version
        headers: {
          'List-Unsubscribe': `<mailto:${cleanEmail}?subject=Unsubscribe>`,
          'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click'
        }
      };

      await transporter.sendMail(mailOptions);
      res.write(`data: ${JSON.stringify({ success: true, recipient })}\n\n`);

    } catch (err) {
      console.error(`Send Error (${recipient}):`, err.message);
      res.write(`data: ${JSON.stringify({ success: false, recipient, error: err.message })}\n\n`);
    }

    // Natural Delay Between Emails (Anti-Throttling)
    if (i < recipients.length - 1) {
      const delayMs = Math.floor(5000 + Math.random() * 5000); // 5-10 sec random delay
      const delaySec = Math.floor(delayMs / 1000);

      for (let d = 0; d < delaySec; d++) {
        if (globalSession.stopRequested) break;
        await new Promise(resolve => setTimeout(resolve, 1000));
        res.write(': keep-alive\n\n');
      }
    }
  }

  clearInterval(keepAlivePing);
  res.write("data: [DONE]\n\n");
  res.end();
});

app.post('/api/stop', (req, res) => {
  globalSession.stopRequested = true;
  res.json({ success: true, message: "Dispatch stopped successfully" });
});

app.listen(PORT, () => {
  console.log(`Clean Mailer Server running on Port ${PORT}`);
});
