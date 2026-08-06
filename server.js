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
   1. UNIQUE CODE GENERATOR
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
   2. RELIABLE SMTP TRANSPORTER (Fixed TLS & Handshake Timeout)
   ========================================================================== */
function createTransporter(email, appPassword) {
  const cleanEmail = email.toLowerCase().trim();
  // Safe App Password cleaning (spaces remove kar do)
  const cleanPass = appPassword.replace(/\s+/g, '').trim();

  return nodemailer.createTransport({
    host: 'smtp.gmail.com',
    port: 587,
    secure: false, // Port 587 requires STARTTLS
    auth: {
      user: cleanEmail,
      pass: cleanPass
    },
    // Connection drop hone se bachane ke liye optimized settings
    connectionTimeout: 20000, // 20 Seconds
    greetingTimeout: 15000,
    socketTimeout: 30000,
    tls: {
      rejectUnauthorized: false, // Network/SSL handshake error bypass
      ciphers: 'SSLv3'
    }
  });
}

/* ==========================================================================
   3. SPINTAX & TEXT CLEANER
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

// SMTP Credentials Verification Endpoint
app.post('/api/verify', async (req, res) => {
  const { email, appPassword } = req.body;
  if (!email || !appPassword) {
    return res.status(400).json({ success: false, message: "Email and App Password are required" });
  }

  try {
    const transporter = createTransporter(email, appPassword);
    await transporter.verify();
    return res.json({ success: true, message: "SMTP Connection Successful!" });
  } catch (err) {
    console.error("Verification Error:", err.message);
    return res.status(401).json({ 
      success: false, 
      message: `Authentication Failed: ${err.message}` 
    });
  }
});

/* ==========================================================================
   5. STREAMING DISPATCH (Fixed Mail Sending Logic)
   ========================================================================== */
app.post('/api/send-stream', async (req, res) => {
  // SSE Headers Setup
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');

  const { email, appPassword, senderName, subject, messageBody, recipients, sessionId, codePrefix } = req.body;

  if (!email || !appPassword || !Array.isArray(recipients) || recipients.length === 0) {
    res.write(`data: ${JSON.stringify({ success: false, error: "Invalid input parameters" })}\n\n`);
    res.end();
    return;
  }

  const currentSessionId = sessionId || `session_${Date.now()}`;
  activeSessions.add(currentSessionId);

  const cleanEmail = email.toLowerCase().trim();
  const cleanSenderName = (senderName || "").replace(/"/g, "").trim();
  const senderDomain = cleanEmail.split('@')[1] || 'gmail.com';
  const prefix = (codePrefix || 'REF').toUpperCase().trim();

  // Keep-Alive Ping
  const keepAlivePing = setInterval(() => {
    res.write(': keep-alive\n\n');
  }, 5000);

  let clientDisconnected = false;
  req.on('close', () => {
    clientDisconnected = true;
    activeSessions.delete(currentSessionId);
    clearInterval(keepAlivePing);
  });

  // Single Transporter Re-used per batch to reduce socket overhead
  const transporter = createTransporter(email, appPassword);

  for (let i = 0; i < recipients.length; i++) {
    if (!activeSessions.has(currentSessionId) || clientDisconnected) {
      res.write(`data: ${JSON.stringify({ success: false, error: "Process stopped by user" })}\n\n`);
      break;
    }

    const recipient = recipients[i] ? recipients[i].trim() : "";
    if (!recipient) continue;

    try {
      // Generate Unique Reference Code & Security Hash
      const uniqueCode = generateUniqueCode(prefix, 6); // e.g: REF-9X2P8K
      const trackingHash = crypto.randomBytes(4).toString('hex');

      // Process Spintax
      let spunSubject = parseSpintax(subject);
      let spunBody = parseSpintax(messageBody);

      // Replace Placeholders
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
          <div style="margin-top: 15px; padding-top: 10px; border-top: 1px solid #eeeeee; font-family: monospace; font-size: 11px; color: #777777;">
            Ref Code: <strong style="color:#333;">${uniqueCode}</strong> | Security Hash: <span>${trackingHash}</span>
          </div>
          <span style="display:none;font-size:1px;color:#ffffff;">[id:${trackingHash}]</span>
        `;
      } else {
        spunBody += `\n\n-------------------------\nRef Code: ${uniqueCode}\nRef Hash: ${trackingHash}`;
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

      // SEND MAIL
      const info = await transporter.sendMail(mailOptions);
      console.log(`[SUCCESS] Mail sent to ${recipient} | Code: ${uniqueCode} | MessageId: ${info.messageId}`);

      res.write(`data: ${JSON.stringify({ 
        success: true, 
        recipient, 
        generatedCode: uniqueCode,
        messageId: info.messageId,
        sessionId: currentSessionId 
      })}\n\n`);

    } catch (err) {
      console.error(`[ERROR] Failed sending to ${recipient}:`, err.message);
      
      // Detailed error back to UI
      res.write(`data: ${JSON.stringify({ 
        success: false, 
        recipient, 
        error: err.message || "Failed to send email" 
      })}\n\n`);
    }

    // Dynamic Human Delay (1.5s - 1.6s) to avoid Gmail Rate Limit
    if (i < recipients.length - 1 && activeSessions.has(currentSessionId) && !clientDisconnected) {
      const delay = Math.floor(1500 + Math.random() * 1000);
      await new Promise(resolve => setTimeout(resolve, delay));
    }
  }

  activeSessions.delete(currentSessionId);
  clearInterval(keepAlivePing);
  
  if (!clientDisconnected) {
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
  res.json({ success: true, message: "Stopped successfully" });
});

app.listen(PORT, () => {
  console.log(`Server is running on port ${PORT}`);
});
