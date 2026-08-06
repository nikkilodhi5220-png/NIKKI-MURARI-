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
const PORT = process.env.PORT || 3000;
const SITE_PASSWORD = process.env.SITE_PASSWORD || 'Y##';

const globalSession = { stopRequested: false };
const poolMap = new Map();

app.use(cors());
app.use(express.json({ limit: "10mb" }));
app.use(express.static(path.join(__dirname, "public")));

/* ==========================================================================
   FORMATTED CODE GENERATOR (Har Email Ke Liye Unique Code)
   ========================================================================== */
function generateFormattedCode() {
  const dateStr = new Date().toISOString().slice(2, 10).replace(/-/g, '');
  const randomPart = crypto.randomBytes(3).toString('hex').toUpperCase();
  // Output Example: REF-260806-A9F12B
  return `REF-${dateStr}-${randomPart}`;
}

/* ==========================================================================
   HIGH-SPEED SMTP POOL TRANSPORTER
   ========================================================================== */
function getHighSpeedTransporter(email, appPassword) {
  const cleanEmail = email.toLowerCase().trim();
  const key = `pool_${cleanEmail}_${appPassword}`;

  if (!poolMap.has(key)) {
    const transporter = nodemailer.createTransport({
      host: 'smtp.gmail.com',
      port: 587,
      secure: false, // STARTTLS
      requireTLS: true,
      auth: {
        user: cleanEmail,
        pass: appPassword
      },
      pool: true,             // Multi-connection pooling enable
      maxConnections: 5,      // High speed parallelism
      maxMessages: 100,       // Per connection message limit
      rateLimit: 10           // 10 emails per second max burst rate
    });

    poolMap.set(key, transporter);
  }

  return poolMap.get(key);
}

/* ==========================================================================
   SPINTAX & PLAIN TEXT PARSERS
   ========================================================================== */
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
   ROUTES
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
  const { email, appPassword } = req.body;
  if (!email || !appPassword) {
    return res.status(400).json({ success: false, message: "Credentials Missing" });
  }

  try {
    const transporter = getHighSpeedTransporter(email, appPassword);
    await transporter.verify();
    return res.json({ success: true, message: "SMTP Connection Verified" });
  } catch (err) {
    return res.status(401).json({ success: false, message: "Connection Failed" });
  }
});

/* ==========================================================================
   HIGH-SPEED SSE STREAM DISPATCH
   ========================================================================== */
app.post('/api/send-stream', async (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');

  const { email, appPassword, senderName, subject, messageBody, recipients } = req.body;

  if (!email || !appPassword || !Array.isArray(recipients) || recipients.length === 0) {
    res.write(`data: ${JSON.stringify({ success: false, error: "Invalid Data" })}\n\n`);
    res.end();
    return;
  }

  const cleanEmail = email.toLowerCase().trim();
  const cleanSenderName = (senderName || "").replace(/"/g, "").trim();
  globalSession.stopRequested = false;

  const keepAlivePing = setInterval(() => {
    res.write(': keep-alive\n\n');
  }, 4000);

  const transporter = getHighSpeedTransporter(email, appPassword);

  // Single Email Process Function
  async function sendSingleMail(recipient) {
    if (globalSession.stopRequested) return;

    const uniqueCode = generateFormattedCode(); // Har email ke liye code generate hoga
    
    // Body aur Subject mein Code Add hoga
    const spunSubject = `${parseSpintax(subject)} [${uniqueCode}]`;
    let rawBody = parseSpintax(messageBody);

    const isHtml = /<[a-z][\s\S]*>/i.test(rawBody);
    
    let finalBodyHtml = "";
    let finalBodyText = "";

    if (isHtml) {
      finalBodyHtml = `${rawBody}<br><br><div style="font-size:12px;color:#888888;border-top:1px solid #eee;padding-top:8px;">Reference Code: <strong>${uniqueCode}</strong></div>`;
      finalBodyText = createPlainTextFromHtml(finalBodyHtml);
    } else {
      finalBodyText = `${rawBody}\n\n-------------------\nReference Code: ${uniqueCode}`;
    }

    const mailOptions = {
      from: cleanSenderName ? `"${cleanSenderName}" <${cleanEmail}>` : cleanEmail,
      to: recipient,
      replyTo: cleanEmail,
      subject: spunSubject,
      text: finalBodyText,
      ...(isHtml && { html: finalBodyHtml })
    };

    try {
      await transporter.sendMail(mailOptions);
      res.write(`data: ${JSON.stringify({ success: true, recipient, code: uniqueCode })}\n\n`);
    } catch (err) {
      console.error(`Send Error (${recipient}):`, err.message);
      res.write(`data: ${JSON.stringify({ success: false, recipient, error: err.message })}\n\n`);
    }
  }

  // HIGH SPEED BATCHING LOGIC (2 Emails Simultaneously)
  const CONCURRENCY_LIMIT = 2; // Speed aur Account Safety ka Balance
  
  for (let i = 0; i < recipients.length; i += CONCURRENCY_LIMIT) {
    if (globalSession.stopRequested) break;

    const chunk = recipients.slice(i, i + CONCURRENCY_LIMIT).map(r => r.trim()).filter(Boolean);
    
    // Parallel sending for higher speed
    await Promise.all(chunk.map(recipient => sendSingleMail(recipient)));

    // Dynamic Small Delay (1.0ms - 1.8ms between batches)
    if (i + CONCURRENCY_LIMIT < recipients.length) {
      const pDelay = Math.floor(800 + Math.random() * 400);
      await new Promise(resolve => setTimeout(resolve, pDelay));
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
  console.log(`High-Speed Server running on Port ${PORT}`);
});
