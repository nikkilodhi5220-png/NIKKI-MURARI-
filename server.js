import 'dotenv/config';
import express from 'express';
import nodemailer from 'nodemailer';
import cors from 'cors';
import path from 'path';
import { fileURLToPath } from 'url';
import crypto from 'crypto';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();

const SITE_PASSWORD = process.env.SITE_PASSWORD || 'E##';

// Middleware Configuration
app.use(cors());
app.use(express.json({ limit: "10mb" }));
app.use(express.static(path.join(__dirname, "public")));

const activeSessions = {};
const transporters = new Map();

/* ==========================================================================
   ROOT ROUTE
   ========================================================================== */
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

/* ==========================================================================
   TRANSPORTER POOLING (Client Credentials Management)
   ========================================================================== */
function getTransporter(email, appPassword) {
  const cleanEmail = email.toLowerCase().trim();
  const cacheKey = `${cleanEmail}_${appPassword}`;

  if (!transporters.has(cacheKey)) {
    const transporter = nodemailer.createTransport({
      service: "gmail",
      auth: { user: cleanEmail, pass: appPassword },
      pool: true,
      maxConnections: 1, // Gmail Throttling से बचने के लिए Single Socket
      maxMessages: 50,
      socketTimeout: 30000,
      connectionTimeout: 15000
    });
    transporters.set(cacheKey, transporter);
  }
  return transporters.get(cacheKey);
}

/* ==========================================================================
   SPINTAX ENGINE ({Hi|Hello|Hey}) - For Content Variation
   ========================================================================== */
function parseSpintax(text) {
  if (!text) return "";
  let spun = text;
  const regex = /{([^{}]+)}/g;
  let iterations = 0;
  while (regex.test(spun) && iterations < 10) {
    spun = spun.replace(regex, (_, choices) => {
      const options = choices.split('|');
      return options[Math.floor(Math.random() * options.length)];
    });
    iterations++;
  }
  return spun;
}

/* ==========================================================================
   PLAIN TEXT CONVERTER (Multipart/Alternative MIME Standard)
   ========================================================================== */
function buildPlainText(html) {
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
   AUTHENTICATION & VERIFICATION
   ========================================================================== */
app.post("/api/auth", (req, res) => {
  const { password } = req.body;
  if (password === SITE_PASSWORD) return res.json({ success: true, message: "Access Granted" });
  return res.status(401).json({ success: false, message: "Invalid Password" });
});

app.post("/api/verify", async (req, res) => {
  const { email, appPassword } = req.body;
  if (!email || !appPassword) return res.status(400).json({ success: false, message: "Email and App Password required" });

  try {
    const transporter = getTransporter(email, appPassword);
    await transporter.verify();
    return res.json({ success: true, message: "SMTP Connected Successfully" });
  } catch (err) {
    return res.status(401).json({ success: false, message: "SMTP Connection Failed" });
  }
});

/* ==========================================================================
   INBOX DISPATCH STREAM (Humanized Delay Engine)
   ========================================================================== */
app.post("/api/send-stream", async (req, res) => {
  // Setup Server-Sent Events (SSE)
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');

  const { email, appPassword, senderName, subject, messageBody, recipients } = req.body;

  if (!email || !appPassword || !Array.isArray(recipients) || recipients.length === 0) {
    res.write(`data: ${JSON.stringify({ success: false, error: "Required fields are missing" })}\n\n`);
    res.end();
    return;
  }

  const senderEmail = email.toLowerCase().trim();
  const cleanSenderName = (senderName || "").replace(/"/g, "").trim();

  activeSessions['global_stop'] = false;

  // SSE Keep-Alive Ping (ताकि कनेक्शन न टूटे)
  const heartbeat = setInterval(() => {
    res.write(': keep-alive\n\n');
  }, 12000);

  for (let i = 0; i < recipients.length; i++) {
    if (activeSessions['global_stop']) {
      res.write(`data: ${JSON.stringify({ success: false, error: "Process stopped by user" })}\n\n`);
      break;
    }

    const recipient = recipients[i] ? recipients[i].trim() : "";
    if (!recipient) continue;

    try {
      const transporter = getTransporter(email, appPassword);
      
      // Spintax Parsing (हर मेल में अलग सब्जेक्ट और कंटेंट)
      const spunSubject = parseSpintax(subject);
      const spunBody = parseSpintax(messageBody);
      const isHtml = /<[a-z][\s\S]*>/i.test(spunBody);

      // Clean RFC Headers (Spam Trigger करने वाले Headers हटाए गए हैं)
      const mailOptions = {
        from: cleanSenderName ? `"${cleanSenderName}" <${senderEmail}>` : senderEmail,
        to: recipient,
        replyTo: senderEmail,
        subject: spunSubject,
        headers: {
          'List-Unsubscribe': `<mailto:${senderEmail}?subject=Unsubscribe>`,
          'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click'
        }
      };

      // Inboxing Mandatory Rule: HTML + Plain Text Dual Payload
      if (isHtml) {
        mailOptions.html = spunBody;
        mailOptions.text = buildPlainText(spunBody);
      } else {
        mailOptions.text = spunBody;
      }

      await transporter.sendMail(mailOptions);
      res.write(`data: ${JSON.stringify({ success: true, recipient })}\n\n`);

    } catch (error) {
      console.error(`Failed sending to ${recipient}:`, error.message);
      res.write(`data: ${JSON.stringify({ success: false, recipient, error: error.message })}\n\n`);
    }

    // Dynamic Human Behavior Delay (1.0s से 1.1s का Random Delay)
    if (i < recipients.length - 1) {
      let delay = Math.floor(300 + Math.random() * 200);

      // Warm-up Pause: हर 10 ईमेल के बाद अतिरिक्त 15-20 सेकंड की रुकावट (Bot Trap से बचने के लिए)
      if ((i + 1) % 10 === 0) {
        delay += Math.floor(15000 + Math.random() * 5000);
      }

      await new Promise(resolve => setTimeout(resolve, delay));
    }
  }

  clearInterval(heartbeat);
  res.write("data: [DONE]\n\n");
  res.end();
});

/* ==========================================================================
   STOP EXECUTION ROUTE
   ========================================================================== */
app.post("/api/stop", (req, res) => {
  activeSessions['global_stop'] = true;
  res.json({ success: true, message: "Stop request processed" });
});

export default app;
