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
   1. DYNAMIC FORMATTED CODE GENERATOR (Har Mail Ke Liye Unique Pattern)
   ==========================================================================
   Format Patterns:
   - 'REF-XXXXXX'    -> REF-A9K8L2 (Uppercase Letters + Numbers)
   - 'INV-####-XX'   -> INV-8392-KP (Digits & Letters)
   - 'TXN-XXXXXXXX'  -> TXN-7K2P9M4L
   ========================================================================== */
function generateFormattedCode(pattern = 'REF-XXXXXX') {
  const letters = 'ABCDEFGHJKLMNPQRSTUVWXYZ'; // Avoid confusing letters like I, O
  const numbers = '23456789';                 // Avoid 0, 1
  const allChars = letters + numbers;

  return pattern.replace(/[X#]/g, (match) => {
    const randomBytes = crypto.randomBytes(1);
    if (match === 'X') {
      return letters[randomBytes[0] % letters.length];
    } else if (match === '#') {
      return numbers[randomBytes[0] % numbers.length];
    }
    return match;
  });
}

/* ==========================================================================
   2. RELIABLE SMTP TRANSPORTER (Fixed TLS & Timeouts)
   ========================================================================== */
function createTransporter(email, appPassword) {
  const cleanEmail = email.toLowerCase().trim();
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
      rejectUnauthorized: false
    },
    connectionTimeout: 12000,
    greetingTimeout: 10000,
    socketTimeout: 15000
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
   4. ROUTES
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
    return res.status(401).json({ success: false, message: `SMTP Connection Failed: ${err.message}` });
  }
});

/* ==========================================================================
   5. STREAMING DISPATCH (Per-Recipient Formatted Code & Progress Engine)
   ========================================================================== */
app.post('/api/send-stream', async (req, res) => {
  // SSE Headers Setup
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');

  if (typeof res.flushHeaders === 'function') {
    res.flushHeaders();
  }

  const { 
    email, 
    appPassword, 
    senderName, 
    subject, 
    messageBody, 
    recipients, 
    sessionId, 
    codePattern // Example: 'REF-XXXXXX' or 'INV-####-XX'
  } = req.body;

  if (!email || !appPassword || !Array.isArray(recipients) || recipients.length === 0) {
    res.write(`data: ${JSON.stringify({ success: false, error: "Invalid Data Parameters" })}\n\n`);
    res.end();
    return;
  }

  const currentSessionId = sessionId || `session_${Date.now()}`;
  activeSessions.add(currentSessionId);

  const cleanEmail = email.toLowerCase().trim();
  const cleanSenderName = (senderName || "").replace(/"/g, "").trim();
  const senderDomain = cleanEmail.split('@')[1] || 'gmail.com';
  
  // Format Template Pattern (Default: REF-XXXXXX)
  const patternTemplate = (codePattern || 'REF-XXXXXX').trim();

  const totalRecipients = recipients.length;
  let successCount = 0;
  let failedCount = 0;

  const transporter = createTransporter(email, appPassword);

  const keepAlivePing = setInterval(() => {
    if (!res.writableEnded) {
      res.write(': keep-alive\n\n');
    }
  }, 4000);

  let clientDisconnected = false;
  req.on('close', () => {
    clientDisconnected = true;
    activeSessions.delete(currentSessionId);
    clearInterval(keepAlivePing);
  });

  for (let i = 0; i < totalRecipients; i++) {
    if (!activeSessions.has(currentSessionId) || clientDisconnected) {
      if (!res.writableEnded) {
        res.write(`data: ${JSON.stringify({ success: false, error: "Stopped by User" })}\n\n`);
      }
      break;
    }

    const recipient = recipients[i] ? recipients[i].trim() : "";
    if (!recipient) {
      failedCount++;
      const currentProgress = Math.round(((i + 1) / totalRecipients) * 100);
      res.write(`data: ${JSON.stringify({
        success: false,
        recipient: "N/A",
        error: "Empty Recipient",
        current: i + 1,
        total: totalRecipients,
        progress: currentProgress,
        successCount,
        failedCount
      })}\n\n`);
      continue;
    }

    try {
      // 1. HAR EMAIL ID KE LIYE NAYA UNIQ CODE GENERATE HOGA
      const uniqueFormattedCode = generateFormattedCode(patternTemplate); // e.g. REF-X9K2P4
      const securityHash = crypto.randomBytes(3).toString('hex');

      // 2. Spintax Process
      let spunSubject = parseSpintax(subject);
      let spunBody = parseSpintax(messageBody);

      // 3. Subject & Body Placeholder Replacement ({CODE}, {REF}, {ID})
      spunSubject = spunSubject
        .replace(/{CODE}/g, uniqueFormattedCode)
        .replace(/\[\[CODE\]\]/g, uniqueFormattedCode)
        .replace(/{REF}/g, uniqueFormattedCode)
        .replace(/{ID}/g, uniqueFormattedCode);

      spunBody = spunBody
        .replace(/{CODE}/g, uniqueFormattedCode)
        .replace(/\[\[CODE\]\]/g, uniqueFormattedCode)
        .replace(/{REF}/g, uniqueFormattedCode)
        .replace(/{ID}/g, uniqueFormattedCode);

      const isHtml = /<[a-z][\s\S]*>/i.test(spunBody);

      // 4. Auto Attach Unique Security Footer (Anti-Spam Feature)
      if (isHtml) {
        spunBody += `
          <br><br>
          <div style="margin-top: 15px; padding-top: 10px; border-top: 1px solid #f0f0f0; font-family: monospace, sans-serif; font-size: 11px; color: #888888;">
            Unique Ref Code: <strong style="color:#333333;">${uniqueFormattedCode}</strong> | Hash: <span>${securityHash}</span>
          </div>
          <span style="display:none;font-size:1px;color:#ffffff;">[id:${uniqueFormattedCode}_${securityHash}]</span>
        `;
      } else {
        spunBody += `\n\n-------------------------\nUnique Ref Code: ${uniqueFormattedCode}\nHash: ${securityHash}`;
      }

      // 5. Unique RFC Message ID & Headers
      const uniqueMsgId = `<${Date.now()}.${uniqueFormattedCode.replace(/[^a-zA-Z0-9]/g, '')}@${senderDomain}>`;

      const mailOptions = {
        from: cleanSenderName ? `"${cleanSenderName}" <${cleanEmail}>` : cleanEmail,
        to: recipient,
        replyTo: cleanEmail,
        subject: spunSubject,
        messageId: uniqueMsgId,
        headers: {
          'X-Entity-Ref-ID': uniqueFormattedCode,
          'X-Delivery-Context': securityHash,
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

      // 6. Send Mail Execution
      const sendInfo = await transporter.sendMail(mailOptions);
      successCount++;

      const currentProgress = Math.round(((i + 1) / totalRecipients) * 100);

      if (!res.writableEnded && !clientDisconnected) {
        res.write(`data: ${JSON.stringify({ 
          success: true, 
          recipient, 
          generatedCode: uniqueFormattedCode,
          messageId: sendInfo.messageId,
          current: i + 1,
          total: totalRecipients,
          progress: currentProgress,
          successCount,
          failedCount,
          sessionId: currentSessionId 
        })}\n\n`);
      }

    } catch (err) {
      failedCount++;
      const currentProgress = Math.round(((i + 1) / totalRecipients) * 100);

      console.error(`[FAILED] -> ${recipient}:`, err.message);

      if (!res.writableEnded && !clientDisconnected) {
        res.write(`data: ${JSON.stringify({ 
          success: false, 
          recipient, 
          error: err.message || "Failed to send email",
          current: i + 1,
          total: totalRecipients,
          progress: currentProgress,
          successCount,
          failedCount,
          sessionId: currentSessionId 
        })}\n\n`);
      }
    }

    // Dynamic Safe Delay (1.0s - 1.5s)
    if (i < totalRecipients - 1 && activeSessions.has(currentSessionId) && !clientDisconnected) {
      const delay = Math.floor(1000 + Math.random() * 700);
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
  res.json({ success: true, message: "Stopped successfully" });
});

app.listen(PORT, () => {
  console.log(`Server running on Port ${PORT} with Per-Recipient Formatted Code Generator`);
});
