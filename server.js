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

const activeSessions = new Set();

// Middlewares
app.use(cors());
app.use(express.json({ limit: "10mb" }));
app.use(express.static(path.join(__dirname, "public")));

/* ==========================================================================
   1. UNIQUE CODE GENERATOR (Inboxing & Fingerprint Avoidance)
   ========================================================================== */
function generateUniqueCode(prefix = 'REF', length = 6) {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let randomStr = '';
  const bytes = crypto.randomBytes(length);
  for (let i = 0; i < length; i++) {
    randomStr += chars[bytes[i] % chars.length];
  }
  return `${prefix}-${randomStr}`;
}

/* ==========================================================================
   2. FIXED & STABLE SMTP TRANSPORTER ENGINE
   ========================================================================== */
function createTransporter(email, appPassword) {
  const cleanEmail = email.toLowerCase().trim();
  // Gmail App Password me spaces hote hain (e.g. "abcd efgh ijkl mnop"), unhe remove karna zaroori hai
  const cleanPass = appPassword ? appPassword.replace(/\s+/g, '').trim() : '';

  return nodemailer.createTransport({
    host: 'smtp.gmail.com',
    port: 587,
    secure: false, // STARTTLS
    auth: {
      user: cleanEmail,
      pass: cleanPass
    },
    tls: {
      rejectUnauthorized: false // Port block aur self-signed certificate failures bypass karne ke liye
    },
    connectionTimeout: 15000, // 15 Seconds
    greetingTimeout: 15000,
    socketTimeout: 20000
  });
}

/* ==========================================================================
   3. SPINTAX & TEXT CLEANER UTILITIES
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
   4. ROUTES & API
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
    const transporter = createTransporter(email, appPassword);
    await transporter.verify();
    return res.json({ success: true, message: "SMTP Connection Verified" });
  } catch (err) {
    console.error("Verification Error:", err.message);
    return res.status(401).json({ success: false, message: `SMTP Connection Failed: ${err.message}` });
  }
});

/* ==========================================================================
   5. STREAMING DISPATCH ENGINE (Fixed Sending Loop)
   ========================================================================== */
app.post('/api/send-stream', async (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');

  const { email, appPassword, senderName, subject, messageBody, recipients, sessionId, codePrefix } = req.body;

  if (!email || !appPassword || !Array.isArray(recipients) || recipients.length === 0) {
    res.write(`data: ${JSON.stringify({ success: false, error: "Invalid Data" })}\n\n`);
    res.end();
    return;
  }

  const currentSessionId = sessionId || `session_${Date.now()}_${Math.random().toString(36).substring(7)}`;
  activeSessions.add(currentSessionId);

  const cleanEmail = email.toLowerCase().trim();
  const cleanSenderName = (senderName || "").replace(/"/g, "").trim();
  const senderDomain = cleanEmail.split('@')[1] || 'gmail.com';
  const prefix = (codePrefix || 'REF').toUpperCase().trim();

  // Create standard transporter instance for this batch session
  const transporter = createTransporter(email, appPassword);

  const keepAlivePing = setInterval(() => {
    if (!res.writableEnded) {
      res.write(': keep-alive\n\n');
    }
  }, 5000);

  let clientDisconnected = false;
  req.on('close', () => {
    clientDisconnected = true;
    activeSessions.delete(currentSessionId);
    clearInterval(keepAlivePing);
  });

  for (let i = 0; i < recipients.length; i++) {
    if (!activeSessions.has(currentSessionId) || clientDisconnected) {
      if (!res.writableEnded) {
        res.write(`data: ${JSON.stringify({ success: false, error: "Stopped by User" })}\n\n`);
      }
      break;
    }

    const recipient = recipients[i] ? recipients[i].trim() : "";
    if (!recipient) continue;

    try {
      // 1. Generate Unique Code & Tracking Hash
      const uniqueCode = generateUniqueCode(prefix, 6); // Output: e.g. REF-8K2P9X
      const trackingHash = crypto.randomBytes(4).toString('hex');

      // 2. Parse Spintax
      let spunSubject = parseSpintax(subject);
      let spunBody = parseSpintax(messageBody);

      // 3. Replace {CODE}, [[CODE]], {REF} Placeholders
      spunSubject = spunSubject
        .replace(/{CODE}/g, uniqueCode)
        .replace(/\[\[CODE\]\]/g, uniqueCode)
        .replace(/{REF}/g, uniqueCode);

      spunBody = spunBody
        .replace(/{CODE}/g, uniqueCode)
        .replace(/\[\[CODE\]\]/g, uniqueCode)
        .replace(/{REF}/g, uniqueCode);

      const isHtml = /<[a-z][\s\S]*>/i.test(spunBody);

      if (isHtml) {
        spunBody += `
          <br><br>
          <div style="margin-top: 15px; padding-top: 10px; border-top: 1px solid #f0f0f0; font-family: monospace, sans-serif; font-size: 11px; color: #888888;">
            Reference Code: <strong style="color:#444444;">${uniqueCode}</strong> | Security Hash: <span>${trackingHash}</span>
          </div>
          <span style="display:none;font-size:1px;color:#ffffff;">[id:${trackingHash}]</span>
        `;
      } else {
        spunBody += `\n\n-------------------------\nReference Code: ${uniqueCode}\nRef Hash: ${trackingHash}`;
      }

      const uniqueMsgId = `<${Date.now()}.${uniqueCode.replace('-', '')}@${senderDomain}>`;

      const mailOptions = {
        from: cleanSenderName ? `"${cleanSenderName}" <${cleanEmail}>` : cleanEmail,
        to: recipient,
        replyTo: cleanEmail,
        subject: spunSubject,
        messageId: uniqueMsgId,
        headers: {
          'X-Entity-Ref-ID': uniqueCode,
          'X-Delivery-Context': trackingHash,
          'List-Unsubscribe': `<mailto:${cleanEmail}?subject=Unsubscribe>`,
          'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click'
        }
      };

      if (isHtml) {
        mailOptions.html = spunBody;
        mailOptions.text = createPlainTextFromHtml(spunBody);
      } else {
        mailOptions.text = spunBody;
      }

      // Send Mail Execution
      const sendInfo = await transporter.sendMail(mailOptions);
      console.log(`[SUCCESS] Email Sent -> ${recipient} | Code: ${uniqueCode}`);

      if (!res.writableEnded && !clientDisconnected) {
        res.write(`data: ${JSON.stringify({ 
          success: true, 
          recipient, 
          generatedCode: uniqueCode,
          messageId: sendInfo.messageId,
          sessionId: currentSessionId 
        })}\n\n`);
      }

    } catch (err) {
      console.error(`[SEND FAILURE] -> ${recipient}:`, err.message);
      
      if (!res.writableEnded && !clientDisconnected) {
        res.write(`data: ${JSON.stringify({ 
          success: false, 
          recipient, 
          error: err.message || "Email sending failed" 
        })}\n\n`);
      }
    }

    // Dynamic Human Delay (1.2s - 1.8s)
    if (i < recipients.length - 1 && activeSessions.has(currentSessionId) && !clientDisconnected) {
      const delay = Math.floor(1200 + Math.random() * 600);
      await new Promise(resolve => setTimeout(resolve, delay));
    }
  }

  activeSessions.delete(currentSessionId);
  clearInterval(keepAlivePing);
  
  if (!clientDisconnected && !res.writableEnded) {
    res.write("data: [DONE]\n\n");
    res.end();
  }
});

app.post('/api/stop', (req, res) => {
  const { sessionId } = req.body;
  if (sessionId) {
    activeSessions.delete(sessionId);
  } else {
    activeSessions.clear();
  }
  res.json({ success: true, message: "Process stopped successfully" });
});

app.listen(PORT, () => {
  console.log(`Server running on Port ${PORT}`);
});
