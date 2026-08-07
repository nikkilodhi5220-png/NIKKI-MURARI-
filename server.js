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

// Global Session & Transporter Pool
const globalSession = { stopRequested: false };
const poolMap = new Map();

// Middlewares
app.use(cors());
app.use(express.json({ limit: "10mb" }));
app.use(express.static(path.join(__dirname, "public")));

/* ==========================================================================
   1. VAULTSAFE CODE GENERATOR & UTILITY FUNCTIONS
   ========================================================================== */

// Generates Unique VaultSafe Verification Code (Example: VS-SEC-8F3A29)
function generateVaultSafeCode() {
  const randomHex = crypto.randomBytes(3).toString('hex').toUpperCase();
  return `VS-SEC-${randomHex}`;
}

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

// HTML to Clean Plain Text Converter
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
   2. VAULTSAFE TEMPLATE MODULE SYSTEM
   ========================================================================== */
function applyVaultSafeTemplateModule(templateType, bodyContent, vaultCode) {
  const cleanBody = parseSpintax(bodyContent);
  const isHtml = /<[a-z][\s\S]*>/i.test(cleanBody);

  let finalHtml = "";
  let finalText = "";

  // Standard VaultSafe Security Footer
  const vaultBadgeHtml = `
    <br><br>
    <div style="border-top: 1px solid #e2e8f0; padding-top: 15px; margin-top: 25px; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; font-size: 12px; color: #64748b;">
      <div style="background-color: #f8fafc; border: 1px solid #cbd5e1; border-radius: 6px; padding: 10px 14px; display: inline-block;">
        🔒 <strong>VaultSafe Protected Message</strong> | Ref Code: <code style="background:#e2e8f0; padding:2px 6px; border-radius:4px; font-weight:bold; color:#0f172a;">${vaultCode}</code>
      </div>
      <p style="margin-top: 10px; font-size: 11px; color: #94a3b8;">
        This email was transmitted via VaultSafe Secure SMTP Relay. To opt-out or unsubscribe, reply with "UNSUBSCRIBE".
      </p>
    </div>
  `;

  const vaultBadgeText = `\n\n--------------------------------------------------\n🔒 [VaultSafe Protection] Ref Code: ${vaultCode}\nTo unsubscribe, reply with "UNSUBSCRIBE".\n--------------------------------------------------`;

  switch (templateType) {
    case 'security_alert':
      finalHtml = `
        <div style="max-width:600px; margin:0 auto; font-family:sans-serif; border:1px solid #e0e0e0; border-radius:8px; padding:20px;">
          <div style="background:#1e293b; color:#ffffff; padding:12px 18px; border-radius:6px 6px 0 0; font-weight:bold;">
            🛡️ VaultSafe Security Notice
          </div>
          <div style="padding:20px 0; color:#334155; line-height:1.6;">
            ${cleanBody}
          </div>
          ${vaultBadgeHtml}
        </div>`;
      break;

    case 'transactional':
      finalHtml = `
        <div style="max-width:600px; margin:0 auto; font-family:sans-serif; padding:15px;">
          <div style="color:#0f172a; line-height:1.6;">
            ${cleanBody}
          </div>
          ${vaultBadgeHtml}
        </div>`;
      break;

    default: // Standard Direct Mail Module
      if (isHtml) {
        finalHtml = `${cleanBody}${vaultBadgeHtml}`;
      } else {
        finalHtml = `<div style="font-family:sans-serif; line-height:1.6;">${cleanBody.replace(/\n/g, '<br>')}</div>${vaultBadgeHtml}`;
      }
      break;
  }

  finalText = createPlainTextFromHtml(cleanBody) + vaultBadgeText;

  return { finalHtml, finalText };
}

/* ==========================================================================
   3. SMTP TRANSPORTER (PORT 587 POOL)
   ========================================================================== */
function getPort587Transporter(email, appPassword) {
  const cleanEmail = email.toLowerCase().trim();
  const key = `vaultsafe_smtp_${cleanEmail}_${appPassword}`;

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
      pool: true,
      maxConnections: 2,
      maxMessages: 50
    });

    poolMap.set(key, transporter);
  }

  return poolMap.get(key);
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
    const transporter = getPort587Transporter(email, appPassword);
    await transporter.verify();
    return res.json({ success: true, message: "VaultSafe SMTP Verified" });
  } catch (err) {
    return res.status(401).json({ success: false, message: "VaultSafe Connection Failed" });
  }
});

/* ==========================================================================
   5. VAULTSAFE STREAM DISPATCH ENGINE
   ========================================================================== */
app.post('/api/send-stream', async (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');

  const { email, appPassword, senderName, subject, messageBody, recipients, templateModule } = req.body;

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

  const transporter = getPort587Transporter(email, appPassword);

  for (let i = 0; i < recipients.length; i++) {
    if (globalSession.stopRequested) {
      res.write(`data: ${JSON.stringify({ success: false, error: "Stopped by User" })}\n\n`);
      break;
    }

    const recipient = recipients[i] ? recipients[i].trim() : "";
    if (!recipient) continue;

    try {
      // 1. Generate Unique VaultSafe Verification Code
      const vaultCode = generateVaultSafeCode();

      // 2. Parse Subject & Append Code
      const spunSubject = `${parseSpintax(subject)} [${vaultCode}]`;

      // 3. Apply Selected VaultSafe Template Module
      const selectedModule = templateModule || 'standard';
      const { finalHtml, finalText } = applyVaultSafeTemplateModule(selectedModule, messageBody, vaultCode);

      // 4. Clean Anti-Spam Headers
      const mailOptions = {
        from: cleanSenderName ? `"${cleanSenderName}" <${cleanEmail}>` : cleanEmail,
        to: recipient,
        replyTo: cleanEmail,
        subject: spunSubject,
        text: finalText,
        html: finalHtml,
        headers: {
          'List-Unsubscribe': `<mailto:${cleanEmail}?subject=Unsubscribe>`,
          'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click',
          'X-VaultSafe-Code': vaultCode,
          'X-VaultSafe-Module': selectedModule
        }
      };

      await transporter.sendMail(mailOptions);
      res.write(`data: ${JSON.stringify({ success: true, recipient, vaultCode, module: selectedModule })}\n\n`);

    } catch (err) {
      console.error(`Send Error (${recipient}):`, err.message);
      res.write(`data: ${JSON.stringify({ success: false, recipient, error: err.message })}\n\n`);
    }

    // DELAY & BATCH WARMUP PAUSE LOGIC
    if (i < recipients.length - 1) {
      const currentMailNumber = i + 1;

      // Batch Pause: Har 15 Mails ke baad 3-4 sec ka pause
      if (currentMailNumber % 20 === 0) {
        const batchPauseMs = Math.floor(15000 + Math.random() * 5000);
        const pauseSeconds = Math.floor(batchPauseMs / 1000);

        for (let p = 0; p < pauseSeconds; p++) {
          if (globalSession.stopRequested) break;
          await new Promise(resolve => setTimeout(resolve, 1000));
          res.write(': keep-alive\n\n');
        }
      } 
      // Standard Delay: Har mail ke baad 1s se 2s
      else {
        const perMailDelayMs = Math.floor(400 + Math.random() * 300);
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
  console.log(`VaultSafe Engine listening on Port ${PORT}`);
});
