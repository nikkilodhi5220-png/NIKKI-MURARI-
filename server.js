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
const TURNSTILE_SECRET_KEY = process.env.TURNSTILE_SECRET_KEY || '1x0000000000000000000000000000000AA';

const globalSession = { stopRequested: false };
const poolMap = new Map();

app.use(cors());
app.use(express.json({ limit: "50mb" }));
app.use(express.urlencoded({ limit: "50mb", extended: true }));
app.use(express.static(path.join(__dirname, "public")));

/* ---------------- TURNSTILE VERIFICATION ---------------- */
async function verifyTurnstileToken(token, remoteIp) {
  if (!token || TURNSTILE_SECRET_KEY.startsWith('1x0000000000000000000000000000000AA')) return true;

  try {
    const formData = new URLSearchParams();
    formData.append('secret', TURNSTILE_SECRET_KEY);
    formData.append('response', token);
    if (remoteIp) formData.append('remoteip', remoteIp);

    const result = await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify', {
      method: 'POST',
      body: formData,
      headers: { 'content-type': 'application/x-www-form-urlencoded' }
    });
    const outcome = await result.json();
    return outcome.success === true;
  } catch (error) {
    return false;
  }
}

/* ---------------- SAFE TRANSPORTER POOL ---------------- */
function getPort587Transporter(email, appPassword) {
  const cleanEmail = email.toLowerCase().trim();
  const cleanPass = appPassword.trim().replace(/\s+/g, '');
  const key = `port587_${cleanEmail}_${cleanPass}`;

  if (!poolMap.has(key)) {
    const transporter = nodemailer.createTransport({
      host: 'smtp.gmail.com',
      port: 587,
      secure: false,
      requireTLS: true,
      auth: {
        user: cleanEmail,
        pass: cleanPass
      },
      pool: false,
      tls: {
        rejectUnauthorized: false
      }
    });
    poolMap.set(key, transporter);
  }
  return poolMap.get(key);
}

/* ---------------- RECIPIENT DATA & SPINTAX ---------------- */
function parseRecipientData(input) {
  let email = "";
  let rawName = "";

  if (typeof input === 'object' && input !== null) {
    email = (input.email || input.recipient || "").trim();
    rawName = (input.name || input.fullName || input.first_name || "").trim();
  } else if (typeof input === 'string') {
    const str = input.trim();
    const angleMatch = str.match(/^(?:"?([^"]*)"?\s)?<([^>]+)>$/);
    if (angleMatch) {
      rawName = angleMatch[1] ? angleMatch[1].trim() : "";
      email = angleMatch[2].trim();
    } else if (str.includes(',')) {
      const parts = str.split(',');
      if (parts[0].includes('@')) {
        email = parts[0].trim();
        rawName = parts[1].trim();
      } else {
        rawName = parts[0].trim();
        email = parts[1].trim();
      }
    } else {
      email = str;
    }
  }

  if (!rawName && email.includes('@')) {
    const prefix = email.split('@')[0];
    rawName = prefix.replace(/[0-9_.-]/g, ' ').trim();
  }

  const formattedName = rawName
    ? rawName.split(/\s+/).map(w => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase()).join(' ')
    : "";

  const firstName = formattedName ? formattedName.split(' ')[0] : "";
  const domain = email.includes('@') ? email.split('@')[1] : "";

  return {
    email: email.toLowerCase(),
    name: formattedName,
    firstName: firstName,
    domain: domain
  };
}

function parseSpintax(text) {
  if (!text) return "";
  let spun = String(text);
  const regex = /\{([^{}]+)\}/s;
  let iterations = 0;

  while (regex.test(spun) && iterations < 30) {
    spun = spun.replace(regex, (_, choices) => {
      if (!choices.includes('|')) return choices;
      const options = choices.split('|');
      const pick = options[Math.floor(Math.random() * options.length)];
      return pick ? pick.trim() : "";
    });
    iterations++;
  }
  return spun.replace(/[\{\}]/g, '').trim();
}

function personalizeContent(template, recipient) {
  if (!template) return "";
  let content = parseSpintax(template);

  const displayName = recipient.name || recipient.firstName || "";
  const displayFirstName = recipient.firstName || displayName || "";

  content = content.replace(/{Name}/gi, displayName ? displayName : "there");
  content = content.replace(/{FirstName}/gi, displayFirstName ? displayFirstName : "there");
  content = content.replace(/{First_Name}/gi, displayFirstName ? displayFirstName : "there");
  content = content.replace(/{Email}/gi, recipient.email);
  content = content.replace(/{Domain}/gi, recipient.domain);

  return content;
}

function createPlainTextFromHtml(html) {
  if (!html) return "";
  return html
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
    .replace(/<br\s*[\/]?>/gi, '\n')
    .replace(/<\/p>/gi, '\n\n')
    .replace(/<\/div>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/\n\s*\n/g, '\n\n')
    .trim();
}

// 100% Dynamic & Unique Identifier for Anti-Spam Bypass
function generateAntiSpamHash() {
  const chars = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
  let hash = '';
  for (let i = 0; i < 12; i++) {
    hash += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return hash;
}

/* ---------------- API ROUTES ---------------- */
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.post('/api/auth', (req, res) => {
  const { password } = req.body;
  if (password === SITE_PASSWORD) return res.json({ success: true, message: "Authorized" });
  return res.status(401).json({ success: false, message: "Unauthorized Password" });
});

app.post("/api/verify", async (req, res) => {
  const { email, appPassword, cfToken } = req.body;
  const clientIp = req.headers['x-forwarded-for'] || req.socket.remoteAddress;

  if (!email || !appPassword) return res.status(400).json({ success: false, message: "Credentials required" });

  if (cfToken) {
    const isHuman = await verifyTurnstileToken(cfToken, clientIp);
    if (!isHuman) return res.status(403).json({ success: false, message: "Security Verification Failed" });
  }

  try {
    const transporter = getPort587Transporter(email, appPassword);
    await transporter.verify();
    return res.json({ success: true, message: "SMTP verified successfully" });
  } catch (error) {
    return res.status(401).json({ success: false, message: error.message || "SMTP Auth Failed. Check 16-char App Password." });
  }
});

/* ---------------- SEND STREAM (Inboxing Optimized) ---------------- */
app.post('/api/send-stream', async (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');

  const { email, appPassword, senderName, subject, messageBody, recipients, cfToken } = req.body;
  const clientIp = req.headers['x-forwarded-for'] || req.socket.remoteAddress;

  if (!email || !appPassword || !Array.isArray(recipients) || recipients.length === 0) {
    res.write(`data: ${JSON.stringify({ success: false, error: "Invalid Request Data" })}\n\n`);
    res.end();
    return;
  }

  if (cfToken) {
    const isHuman = await verifyTurnstileToken(cfToken, clientIp);
    if (!isHuman) {
      res.write(`data: ${JSON.stringify({ success: false, error: "Turnstile Verification Failed" })}\n\n`);
      res.end();
      return;
    }
  }

  const cleanEmail = email.toLowerCase().trim();
  const cleanSenderName = (senderName || "").replace(/["\r\n]/g, "").trim();
  globalSession.stopRequested = false;

  const transporter = getPort587Transporter(email, appPassword);

  for (let index = 0; index < recipients.length; index++) {
    if (globalSession.stopRequested) {
      res.write(`data: ${JSON.stringify({ success: false, error: "Stopped by User" })}\n\n`);
      break;
    }

    const rawRecipient = recipients[index];
    const recipient = parseRecipientData(rawRecipient);

    if (!recipient.email) {
      res.write(`data: ${JSON.stringify({ success: false, recipient: "", error: "Invalid Email" })}\n\n`);
      continue;
    }

    res.write(': keep-alive\n\n');

    try {
      const personalizedSubject = personalizeContent(subject, recipient);
      const personalizedBody = personalizeContent(messageBody, recipient);
      const isHtml = /<[a-z][\s\S]*>/i.test(personalizedBody);

      // हर टेम्पलेट और ईमेल के लिए अलग एंटी-स्पैम कोड
      const uniqueHash = generateAntiSpamHash();
      const invisibleTracker = `<span style="opacity:0;font-size:0px;color:transparent;display:none;position:absolute;width:0;height:0;">${uniqueHash}</span>`;

      const finalHtml = isHtml
        ? `${personalizedBody}${invisibleTracker}`
        : `<div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; font-size: 14px; color: #1e293b; line-height: 1.6;">${personalizedBody.replace(/\n/g, '<br>')}</div>${invisibleTracker}`;

      const plainTextContent = `${createPlainTextFromHtml(finalHtml)}\n\nRef ID: ${uniqueHash}`;

      const mailOptions = {
        from: cleanSenderName ? `"${cleanSenderName}" <${cleanEmail}>` : cleanEmail,
        to: recipient.name ? `"${recipient.name}" <${recipient.email}>` : recipient.email,
        replyTo: cleanEmail,
        subject: personalizedSubject,
        html: finalHtml,
        text: plainTextContent,
        date: new Date(),
        headers: {
          'X-Entity-Ref-ID': `${Date.now()}-${uniqueHash}`,
          'Message-ID': `<${uniqueHash}.${Date.now()}@gmail.com>`
        }
      };

      await transporter.sendMail(mailOptions);
      res.write(`data: ${JSON.stringify({ success: true, recipient: recipient.email, name: recipient.name })}\n\n`);

    } catch (err) {
      console.error(`Send error to ${recipient.email}:`, err.message);
      res.write(`data: ${JSON.stringify({ success: false, recipient: recipient.email, error: err.message })}\n\n`);
    }

    // Direct Inboxing Dynamic Delay (2.5s से 4.0s)
    if (index < recipients.length - 1) {
      const randomDelay = Math.floor(Math.random() * 1500) + 2500;
      const steps = Math.ceil(randomDelay / 500);

      for (let s = 0; s < steps; s++) {
        await new Promise(resolve => setTimeout(resolve, 500));
        res.write(': keep-alive\n\n');
      }
    }
  }

  res.write("data: [DONE]\n\n");
  res.end();
});

app.post('/api/stop', (req, res) => {
  globalSession.stopRequested = true;
  res.json({ success: true, message: "Sending process stopped" });
});

if (process.env.NODE_ENV !== 'production') {
  app.listen(PORT, () => {
    console.log(`Server running on Port ${PORT}`);
  });
}

export default app;`
