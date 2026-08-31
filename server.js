import 'dotenv/config';
import express from 'express';
import http from 'http';
import { Server } from 'socket.io';
import nodemailer from 'nodemailer';
import cors from 'cors';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';
import crypto from 'crypto';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: '*', methods: ['GET', 'POST'] }
});

const PORT = process.env.PORT || 3000;
const SITE_PASSWORD = process.env.SITE_PASSWORD || 'Nk@#';
const TURNSTILE_SECRET_KEY = process.env.TURNSTILE_SECRET_KEY || '1x0000000000000000000000000000000AA';

// Session and Connection Pool Maps
const activeSessions = new Map();
const poolMap = new Map();

// Express Middlewares
app.use(cors());
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ limit: '50mb', extended: true }));
app.use(express.static(path.join(process.cwd(), 'public')));
app.use(express.static(path.join(__dirname, 'public')));

// Safe SSE Flush helper function
const safeFlush = (res) => {
  if (typeof res.flush === 'function') {
    res.flush();
  } else if (typeof res.flushHeaders === 'function') {
    res.flushHeaders();
  }
};

io.on('connection', (socket) => {
  socket.on('disconnect', () => {});
});

/* ==========================================================================
   1. CLOUDFLARE TURNSTILE VERIFICATION
   ========================================================================== */
async function verifyTurnstileToken(token, remoteIp) {
  if (!token || TURNSTILE_SECRET_KEY.startsWith('1x0000000000000000000000000000000AA')) {
    return true;
  }

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
  } catch {
    return false;
  }
}

/* ==========================================================================
   2. HIGH-INBOXING TRANSPORTER POOL (6 Concurrent Connections)
   ========================================================================== */
function getPort587Transporter(email, appPassword) {
  const cleanEmail = email.toLowerCase().trim();
  const cleanPass = appPassword.replace(/\s+/g, '').trim();
  const key = `inbox_pro_${cleanEmail}_${cleanPass}`;

  if (!poolMap.has(key)) {
    const transporter = nodemailer.createTransport({
      host: 'smtp.gmail.com',
      port: 587,
      secure: false, // TLS via STARTTLS
      requireTLS: true,
      auth: {
        user: cleanEmail,
        pass: cleanPass
      },
      pool: true,
      maxConnections: 6, // 6 parallel active connections
      maxMessages: 100,
      rateDelta: 1000,
      rateLimit: 6,
      socketTimeout: 30000,
      connectionTimeout: 15000
    });
    poolMap.set(key, transporter);
  }
  return poolMap.get(key);
}

/* ==========================================================================
   3. HELPER FUNCTIONS FOR SANITIZATION & PERSONALIZATION
   ========================================================================== */
function parseRecipientData(input) {
  let email = '';
  let rawName = '';

  if (typeof input === 'object' && input !== null) {
    email = (input.email || input.recipient || '').trim();
    rawName = (input.name || input.fullName || input.first_name || '').trim();
  } else if (typeof input === 'string') {
    const str = input.trim();
    const angleMatch = str.match(/^(?:"?([^"]*)"?\s)?<([^>]+)>$/);
    if (angleMatch) {
      rawName = angleMatch[1] ? angleMatch[1].trim() : '';
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

  // Prevent Header Injections
  email = email.replace(/[\r\n]/g, '').trim();
  rawName = rawName.replace(/[\r\n]/g, '').trim();

  if (!rawName && email.includes('@')) {
    const prefix = email.split('@')[0];
    rawName = prefix.replace(/[0-9_.-]/g, ' ').trim();
  }

  const formattedName = rawName
    ? rawName.split(/\s+/).map(w => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase()).join(' ')
    : '';

  return {
    email: email.toLowerCase(),
    name: formattedName,
    firstName: formattedName ? formattedName.split(' ')[0] : '',
    domain: email.includes('@') ? email.split('@')[1] : ''
  };
}

function parseSpintax(text) {
  if (!text) return '';
  let spun = String(text);
  const regex = /\{([^{}]+)\}/s;
  let iterations = 0;

  while (regex.test(spun) && iterations < 35) {
    spun = spun.replace(regex, (_, choices) => {
      if (!choices.includes('|')) return choices;
      const options = choices.split('|');
      const pick = options[Math.floor(Math.random() * options.length)];
      return pick ? pick.trim() : '';
    });
    iterations++;
  }
  return spun.replace(/[\{\}]/g, '').trim();
}

function sanitizeText(text) {
  if (!text) return '';
  return String(text).trim().replace(/^[\s!?,.-]+/g, '').trim();
}

function personalizeContent(template, recipient) {
  if (!template) return '';
  let content = parseSpintax(template);
  const fallback = recipient.firstName || recipient.name || 'there';

  content = content.replace(/{Name}/gi, recipient.name || fallback);
  content = content.replace(/{FirstName}/gi, recipient.firstName || fallback);
  content = content.replace(/{First_Name}/gi, recipient.firstName || fallback);
  content = content.replace(/{Email}/gi, recipient.email);
  content = content.replace(/{Domain}/gi, recipient.domain);

  return sanitizeText(content);
}

function createCleanPlainText(text) {
  if (!text) return '';
  return text
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

/* ==========================================================================
   4. API ROUTES
   ========================================================================== */
app.post('/api/auth', (req, res) => {
  const { password } = req.body;
  if (password === SITE_PASSWORD) return res.json({ success: true, message: 'Authorized' });
  return res.status(401).json({ success: false, message: 'Unauthorized Password' });
});

app.post('/api/verify', async (req, res) => {
  const { email, appPassword, cfToken } = req.body;
  const clientIp = req.headers['x-forwarded-for'] || req.socket.remoteAddress;

  if (!email || !appPassword) {
    return res.status(400).json({ success: false, message: 'Credentials required' });
  }

  if (cfToken) {
    const isHuman = await verifyTurnstileToken(cfToken, clientIp);
    if (!isHuman) {
      return res.status(403).json({ success: false, message: 'Security Verification Failed' });
    }
  }

  try {
    const transporter = getPort587Transporter(email, appPassword);
    await transporter.verify();
    return res.json({ success: true, message: 'SMTP verified successfully' });
  } catch (error) {
    return res.status(401).json({
      success: false,
      message: error.message || 'SMTP Auth Failed. Check 16-char App Password.'
    });
  }
});

/* ==========================================================================
   5. STREAMING SENDING ROUTE (6 PARALLEL MAILS & OPTIMIZED DELIVERABILITY)
   ========================================================================== */
app.post('/api/send-stream', async (req, res) => {
  const { email, appPassword, senderName, subject, messageBody, recipients, cfToken, sessionId } = req.body;
  const clientIp = req.headers['x-forwarded-for'] || req.socket.remoteAddress;

  if (cfToken) {
    const isHuman = await verifyTurnstileToken(cfToken, clientIp);
    if (!isHuman) {
      return res.status(403).json({ success: false, error: 'Turnstile Verification Failed' });
    }
  }

  if (!email || !appPassword || !Array.isArray(recipients) || recipients.length === 0) {
    return res.status(400).json({ success: false, error: 'Invalid Request Data' });
  }

  // Setup Event Stream
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache, no-transform',
    'Connection': 'keep-alive',
    'X-Accel-Buffering': 'no',
    'Content-Encoding': 'identity'
  });
  safeFlush(res);

  const activeId = sessionId || `sess_${Date.now()}_${crypto.randomBytes(4).toString('hex')}`;
  activeSessions.set(activeId, { stopRequested: false });

  const cleanEmail = email.toLowerCase().trim();
  const cleanSenderName = (senderName || '').replace(/[\r\n"]/g, '').trim();

  // SSE Keep-Alive Ping
  const keepAlivePing = setInterval(() => {
    try {
      res.write(': keep-alive\n\n');
      safeFlush(res);
    } catch {
      clearInterval(keepAlivePing);
    }
  }, 2500);

  // Connection Close Clean up
  req.on('close', () => {
    clearInterval(keepAlivePing);
    activeSessions.delete(activeId);
  });

  const transporter = getPort587Transporter(email, appPassword);
  
  // High-Speed Concurrency: 6 Emails sent in parallel per batch
  const BATCH_SIZE = 6;

  for (let i = 0; i < recipients.length; i += BATCH_SIZE) {
    const currentSession = activeSessions.get(activeId);
    if (!currentSession || currentSession.stopRequested) {
      res.write(`data: ${JSON.stringify({ success: false, error: 'Stopped by User', sessionId: activeId })}\n\n`);
      break;
    }

    const batch = recipients.slice(i, i + BATCH_SIZE);

    // Parallel execution of batch
    await Promise.all(
      batch.map(async (rawRecipient) => {
        const sessState = activeSessions.get(activeId);
        if (!sessState || sessState.stopRequested) return;

        const recipient = parseRecipientData(rawRecipient);

        if (!recipient.email) {
          const errPayload = { success: false, recipient: '', error: 'Invalid Email Format', sessionId: activeId };
          res.write(`data: ${JSON.stringify(errPayload)}\n\n`);
          safeFlush(res);
          return;
        }

        try {
          // Micro jitter delay (150ms - 350ms) to ensure smooth socket handling & inbox placement
          const jitterDelay = Math.floor(150 + Math.random() * 200);
          await new Promise(resolve => setTimeout(resolve, jitterDelay));

          // Clean subject line to prevent CRLF injection
          const rawSubject = personalizeContent(subject, recipient) || 'Quick note';
          const personalizedSubject = rawSubject.replace(/[\r\n]/g, ' ').trim();

          const personalizedBody = personalizeContent(messageBody, recipient);
          const hasHtml = /<[a-z][\s\S]*>/i.test(personalizedBody);
          const cleanRawText = createCleanPlainText(personalizedBody);

          const cleanHtmlFormatted = `<!DOCTYPE html><html><head><meta charset="utf-8"></head><body style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; font-size: 15px; color: #222222; line-height: 1.6; background-color: #ffffff; margin: 0; padding: 10px 0;"><div dir="ltr">${hasHtml ? personalizedBody : cleanRawText.replace(/\n/g, '<br>')}</div></body></html>`;

          const domain = cleanEmail.split('@')[1] || 'gmail.com';
          const customMsgId = `<${Date.now()}.${crypto.randomBytes(6).toString('hex')}@${domain}>`;

          const mailOptions = {
            from: cleanSenderName ? `"${cleanSenderName}" <${cleanEmail}>` : cleanEmail,
            to: recipient.name ? `"${recipient.name}" <${recipient.email}>` : recipient.email,
            replyTo: cleanEmail,
            date: new Date(),
            messageId: customMsgId,
            subject: personalizedSubject,
            html: cleanHtmlFormatted,
            text: cleanRawText,
            headers: {
              'X-Mailer': 'Gmail Direct Engine',
              'X-Priority': '3',
              'Importance': 'normal'
            }
          };

          await transporter.sendMail(mailOptions);

          const payload = { success: true, recipient: recipient.email, name: recipient.name, sessionId: activeId };
          res.write(`data: ${JSON.stringify(payload)}\n\n`);
          safeFlush(res);
          io.emit('mail_sent', payload);

        } catch (err) {
          const errPayload = { success: false, recipient: recipient.email, error: err.message, sessionId: activeId };
          res.write(`data: ${JSON.stringify(errPayload)}\n\n`);
          safeFlush(res);
          io.emit('mail_error', errPayload);
        }
      })
    );

    // Optimized Pacing Delay between 6-Mail Batches (300ms - 600ms)
    const sessStateEnd = activeSessions.get(activeId);
    if (i + BATCH_SIZE < recipients.length && sessStateEnd && !sessStateEnd.stopRequested) {
      const batchDelay = Math.floor(300 + Math.random() * 300);
      await new Promise(resolve => setTimeout(resolve, batchDelay));
    }
  }

  clearInterval(keepAlivePing);
  activeSessions.delete(activeId);
  res.write('data: [DONE]\n\n');
  safeFlush(res);
  res.end();
});

/* ==========================================================================
   6. SAFE STOP ROUTE
   ========================================================================== */
app.post('/api/stop', (req, res) => {
  const { sessionId } = req.body;

  if (sessionId && activeSessions.has(sessionId)) {
    activeSessions.get(sessionId).stopRequested = true;
    return res.json({ success: true, message: `Session ${sessionId} stopped successfully.` });
  }

  for (const session of activeSessions.values()) {
    session.stopRequested = true;
  }

  res.json({ success: true, message: 'All active processes stopped.' });
});

app.get('*', (req, res) => {
  const filePath1 = path.join(__dirname, 'public', 'index.html');
  const filePath2 = path.join(process.cwd(), 'public', 'index.html');

  if (fs.existsSync(filePath1)) {
    return res.sendFile(filePath1);
  } else if (fs.existsSync(filePath2)) {
    return res.sendFile(filePath2);
  }
  return res.status(200).send('<h1>Server Running</h1>');
});

if (process.env.NODE_ENV !== 'production' && !process.env.VERCEL) {
  server.listen(PORT, () => {
    console.log(`🚀 Secure Fast Mailer running on port ${PORT}`);
  });
}

export default app;
