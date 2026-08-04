import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import path from 'path';
import { fileURLToPath } from 'url';

import { getOrCreateTransporter, buildMailOptions } from './utils/mailer.js';
import { parseSpintax, stripHtmlToPlain } from './utils/textUtils.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = process.env.PORT || 3000;
const SITE_PASSWORD = process.env.SITE_PASSWORD || 'E##';

// State Tracker
const globalSession = { isStopped: false };

// Express Setup
app.use(cors());
app.use(express.json({ limit: '10mb' }));
app.use(express.static(path.join(__dirname, 'public')));

/* ==========================================================================
   ROUTES
   ========================================================================== */

app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Authentication Endpoint
app.post('/api/auth', (req, res) => {
  const { password } = req.body;
  if (password === SITE_PASSWORD) {
    return res.json({ success: true, message: "Authorized" });
  }
  return res.status(401).json({ success: false, message: "Unauthorized password" });
});

// SMTP Verification Endpoint
app.post('/api/verify', async (req, res) => {
  const { email, appPassword } = req.body;
  if (!email || !appPassword) {
    return res.status(400).json({ success: false, message: "Email and App Password required" });
  }

  try {
    const transporter = getOrCreateTransporter(email, appPassword);
    await transporter.verify();
    return res.json({ success: true, message: "SMTP credentials verified" });
  } catch (err) {
    return res.status(401).json({ success: false, message: "SMTP Connection failed" });
  }
});

// Main Streaming Endpoint
app.post('/api/send-stream', async (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');

  const { email, appPassword, senderName, subject, messageBody, recipients } = req.body;

  if (!email || !appPassword || !Array.isArray(recipients) || recipients.length === 0) {
    res.write(`data: ${JSON.stringify({ success: false, error: "Invalid payload parameters" })}\n\n`);
    res.end();
    return;
  }

  const senderEmail = email.toLowerCase().trim();
  globalSession.isStopped = false;

  // Keep Connection Alive during long delays
  const heartbeat = setInterval(() => {
    res.write(': keep-alive\n\n');
  }, 10000);

  for (let i = 0; i < recipients.length; i++) {
    if (globalSession.isStopped) {
      res.write(`data: ${JSON.stringify({ success: false, error: "Process stopped by user" })}\n\n`);
      break;
    }

    const recipient = recipients[i] ? recipients[i].trim() : "";
    if (!recipient) continue;

    try {
      const transporter = getOrCreateTransporter(email, appPassword);
      
      const spunSubject = parseSpintax(subject);
      const spunBody = parseSpintax(messageBody);

      const mailOptions = buildMailOptions(
        senderEmail,
        senderName,
        recipient,
        spunSubject,
        spunBody
      );

      // Add Plain Text fallback if sending HTML
      if (mailOptions.html) {
        mailOptions.text = stripHtmlToPlain(spunBody);
      }

      await transporter.sendMail(mailOptions);
      res.write(`data: ${JSON.stringify({ success: true, recipient })}\n\n`);

    } catch (error) {
      console.error(`Dispatch failed for ${recipient}:`, error.message);
      res.write(`data: ${JSON.stringify({ success: false, recipient, error: error.message })}\n\n`);
    }

    // Dynamic Human Pacing: 1.0s to 1.2s randomized delay
    if (i < recipients.length - 1) {
      let delay = Math.floor(400 + Math.random() * 300);

      // Batch Pause: Adds 15-20 second cooldown every 10 emails
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

// Stop Execution Endpoint
app.post('/api/stop', (req, res) => {
  globalSession.isStopped = true;
  res.json({ success: true, message: "Stop signal received" });
});

// Start Express Server
app.listen(PORT, () => {
  console.log(`Server listening on port ${PORT}`);
});
