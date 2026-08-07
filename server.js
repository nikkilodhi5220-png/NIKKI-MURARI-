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
const poolMap = new Map();

app.use(cors());
app.use(express.json({ limit: "10mb" }));
app.use(express.static(path.join(__dirname, "public")));

/* ==========================================================================
   1. SECURE SMTP TRANSPORTER (TLS 1.2 / Standard Port 587)
   ========================================================================== */
function getPort587Transporter(email, appPassword) {
  const cleanEmail = email.toLowerCase().trim();
  const key = `port587_${cleanEmail}_${appPassword}`;

  if (!poolMap.has(key)) {
    const transporter = nodemailer.createTransport({
      host: 'smtp.gmail.com',
      port: 587,
      secure: false,        // STARTTLS
      requireTLS: true,     // Force secure connection
      auth: {
        user: cleanEmail,
        pass: appPassword
      },
      pool: true,
      maxConnections: 1,    // Google guidelines ke mutabiq stable speed
      maxMessages: 100
    });

    poolMap.set(key, transporter);
  }

  return poolMap.get(key);
}

/* ==========================================================================
   2. TEMPLATE PERSONALIZATION (Genuine Human-like Variable Mapping)
   ========================================================================== */
// {Name} ya {Company} jaise variables ko real dynamic data se replace karna
function personalizeContent(template, recipientData) {
  if (!template) return "";
  let content = template;

  // Real data parameters (e.g., Name, Domain, etc.)
  const name = recipientData.name || recipientData.email.split('@')[0];
  
  content = content.replace(/{Name}/gi, name);
  content = content.replace(/{Email}/gi, recipientData.email);

  return content;
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
   3. ROUTES
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

/* ==========================================================================
   4. STREAMING DISPATCH ENGINE (Natural Speed & Human Timing)
   ========================================================================== */
app.post('/api/send-stream', async (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');

  // recipients structure: Array of objects [{ email: "user@example.com", name: "Rahul" }]
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
  }, 5000);

  const transporter = getPort587Transporter(email, appPassword);

  for (let i = 0; i < recipients.length; i++) {
    if (globalSession.stopRequested) {
      res.write(`data: ${JSON.stringify({ success: false, error: "Stopped by User" })}\n\n`);
      break;
    }

    const recipientObj = typeof recipients[i] === 'string' 
      ? { email: recipients[i].trim(), name: "" }
      : recipients[i];

    const recipientEmail = recipientObj.email ? recipientObj.email.trim() : "";
    if (!recipientEmail) continue;

    try {
      // Direct Personalization (No hidden codes/fake IDs)
      const personalizedSubject = personalizeContent(subject, recipientObj);
      const personalizedBody = personalizeContent(messageBody, recipientObj);

      const isHtml = /<[a-z][\s\S]*>/i.test(personalizedBody);

      const mailOptions = {
        from: cleanSenderName ? `"${cleanSenderName}" <${cleanEmail}>` : cleanEmail,
        to: recipientEmail,
        replyTo: cleanEmail,
        subject: personalizedSubject,
        headers: {
          'List-Unsubscribe': `<mailto:${cleanEmail}?subject=Unsubscribe>`,
          'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click'
        }
      };

      if (isHtml) {
        mailOptions.html = personalizedBody;
        mailOptions.text = createPlainTextFromHtml(personalizedBody);
      } else {
        mailOptions.text = personalizedBody;
      }

      await transporter.sendMail(mailOptions);
      res.write(`data: ${JSON.stringify({ success: true, recipient: recipientEmail, status: "Sent" })}\n\n`);

    } catch (err) {
      console.error(`Send Failure to ${recipientEmail}:`, err.message);
      res.write(`data: ${JSON.stringify({ success: false, recipient: recipientEmail, error: err.message })}\n\n`);
    }

    // Dynamic Human Jitter (1.5 to 2 Seconds Delay for Safe Inbox Delivery)
    if (i < recipients.length - 1) {
      const delay = Math.floor(3000 + Math.random() * 3000); // 1.5s to 2s
      await new Promise(resolve => setTimeout(resolve, delay));
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
  console.log(`Server listening on Port ${PORT}`);
});
