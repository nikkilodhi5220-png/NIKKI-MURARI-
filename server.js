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

// Global Session & Transporter Pool
const globalSession = { stopRequested: false };
const poolMap = new Map();

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

// Convert HTML to Clean Plain Text (Crucial for MIME Compliance & Inboxing)
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
   2. CLEAN TEMPLATE ENGINE (No Fake Badges / Spam Triggers)
   ========================================================================== */
function processEmailTemplate(templateType, rawBodyContent, cleanEmail) {
  const cleanBody = parseSpintax(rawBodyContent);
  const isHtml = /<[a-z][\s\S]*>/i.test(cleanBody);

  let htmlBody = "";
  let plainTextBody = "";

  // Standard Compliant Footer (Professional & Clean)
  const unsubscribeFooterHtml = `
    <br><br>
    <div style="border-top: 1px solid #eeeeee; padding-top: 12px; margin-top: 20px; font-family: Arial, sans-serif; font-size: 11px; color: #888888;">
      This message was sent to you as part of our communication. 
      If you wish to stop receiving these emails, please reply with "UNSUBSCRIBE".
    </div>
  `;

  const unsubscribeFooterText = `\n\n---\nTo unsubscribe from future emails, please reply with "UNSUBSCRIBE".`;

  if (isHtml) {
    htmlBody = `${cleanBody}${unsubscribeFooterHtml}`;
    plainTextBody = `${createPlainTextFromHtml(cleanBody)}${unsubscribeFooterText}`;
  } else {
    htmlBody = `<div style="font-family: Arial, sans-serif; font-size: 14px; color: #333333; line-height: 1.5;">${cleanBody.replace(/\n/g, '<br>')}</div>${unsubscribeFooterHtml}`;
    plainTextBody = `${cleanBody}${unsubscribeFooterText}`;
  }

  return { htmlBody, plainTextBody };
}

/* ==========================================================================
   3. SMTP TRANSPORTER POOL
   ========================================================================== */
function getTransporter(email, appPassword, customHost = null, customPort = null) {
  const cleanEmail = email.toLowerCase().trim();
  const host = customHost || 'smtp.gmail.com';
  const port = customPort || 587;
  const key = `smtp_${cleanEmail}_${host}_${port}`;

  if (!poolMap.has(key)) {
    const transporter = nodemailer.createTransport({
      host: host,
      port: port,
      secure: port === 465, // TLS for 465, STARTTLS for 587
      requireTLS: port === 587,
      auth: {
        user: cleanEmail,
        pass: appPassword
      },
      pool: true,
      maxConnections: 3,
      maxMessages: 100
    });

    poolMap.set(key, transporter);
  }

  return poolMap.get(key);
}

/* ==========================================================================
   4. ROUTES & AUTHENTICATION
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
  const { email, appPassword, smtpHost, smtpPort } = req.body;
  if (!email || !appPassword) {
    return res.status(400).json({ success: false, message: "Credentials Missing" });
  }

  try {
    const transporter = getTransporter(email, appPassword, smtpHost, smtpPort);
    await transporter.verify();
    return res.json({ success: true, message: "SMTP Connection Verified Successfully" });
  } catch (err) {
    return res.status(401).json({ success: false, message: "SMTP Verification Failed: " + err.message });
  }
});

/* ==========================================================================
   5. STREAM DISPATCH ENGINE (INBOXING OPTIMIZED)
   ========================================================================== */
app.post('/api/send-stream', async (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');

  const { email, appPassword, senderName, subject, messageBody, recipients, templateModule, smtpHost, smtpPort } = req.body;

  if (!email || !appPassword || !Array.isArray(recipients) || recipients.length === 0) {
    res.write(`data: ${JSON.stringify({ success: false, error: "Invalid Data or Missing Recipients" })}\n\n`);
    res.end();
    return;
  }

  const cleanEmail = email.toLowerCase().trim();
  const cleanSenderName = (senderName || "").replace(/"/g, "").trim();
  globalSession.stopRequested = false;

  const keepAlivePing = setInterval(() => {
    res.write(': keep-alive\n\n');
  }, 4000);

  const transporter = getTransporter(email, appPassword, smtpHost, smtpPort);

  for (let i = 0; i < recipients.length; i++) {
    if (globalSession.stopRequested) {
      res.write(`data: ${JSON.stringify({ success: false, error: "Stopped by User" })}\n\n`);
      break;
    }

    const recipient = recipients[i] ? recipients[i].trim() : "";
    if (!recipient) continue;

    try {
      // 1. Process Subject (Pure Spintax, No Fake Codes)
      const finalSubject = parseSpintax(subject);

      // 2. Process Body into Clean HTML + Plain Text (Multipart MIME)
      const { htmlBody, plainTextBody } = processEmailTemplate(templateModule, messageBody, cleanEmail);

      // 3. RFC Compliant Mail Options
      const mailOptions = {
        from: cleanSenderName ? `"${cleanSenderName}" <${cleanEmail}>` : cleanEmail,
        to: recipient,
        replyTo: cleanEmail,
        subject: finalSubject,
        text: plainTextBody,   // MANDATORY: Plain text version for Gmail Trust
        html: htmlBody,         // Clean HTML
        headers: {
          'List-Unsubscribe': `<mailto:${cleanEmail}?subject=Unsubscribe>`,
          'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click',
          'X-Mailer': 'Enterprise-Mailer-v2'
        }
      };

      await transporter.sendMail(mailOptions);
      res.write(`data: ${JSON.stringify({ success: true, recipient, status: "Sent" })}\n\n`);

    } catch (err) {
      console.error(`Send Error (${recipient}):`, err.message);
      res.write(`data: ${JSON.stringify({ success: false, recipient, error: err.message })}\n\n`);
    }

    // NATURAL SENDING DELAYS (To prevent Gmail IP throttling)
    if (i < recipients.length - 1) {
      const currentMailNumber = i + 1;

      // Batch Pause: Every 10 Mails -> 12 to 18 seconds delay
      if (currentMailNumber % 10 === 0) {
        const batchPauseMs = Math.floor(12000 + Math.random() * 6000);
        const pauseSeconds = Math.floor(batchPauseMs / 1000);

        for (let p = 0; p < pauseSeconds; p++) {
          if (globalSession.stopRequested) break;
          await new Promise(resolve => setTimeout(resolve, 1000));
          res.write(': keep-alive\n\n');
        }
      } 
      // Per Email Delay: 1.5s to 2s delay between single emails
      else {
        const perMailDelayMs = Math.floor(500 + Math.random() * 400);
        const delaySeconds = Math.floor(perMailDelayMs / 1000);

        for (let d = 0; d < delaySeconds; d++) {
          if (globalSession.stopRequested) break;
          await new Promise(resolve => setTimeout(resolve, 1000));
          res.write(': keep-alive\n\n');
        }
      }
    }
  }

  clearInterval(keepAlivePing);
  res.write("data: [DONE]\n\n");
  res.end();
});

app.post('/api/stop', (req, res) => {
  globalSession.stopRequested = true;
  res.json({ success: true, message: "Process stopped successfully" });
});

app.listen(PORT, () => {
  console.log(`Email Dispatcher listening on Port ${PORT}`);
});
