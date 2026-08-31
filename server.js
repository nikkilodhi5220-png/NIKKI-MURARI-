const express = require('express');
const nodemailer = require('nodemailer');
const cors = require('cors');
const rateLimit = require('express-rate-limit');
const path = require('path');
require('dotenv').config();

const app = express();
app.use(express.json());
app.use(cors());
app.use(express.static(path.join(__dirname, 'public')));

const PORT = process.env.PORT || 3000;
const GATE_PASSWORD = process.env.GATE_PASSWORD || 'admin123';
const TURNSTILE_SECRET = process.env.TURNSTILE_SECRET_KEY || '';

// Login Rate Limiter
const loginLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 10,
    message: { success: false, message: 'Too many login attempts. Try again later.' }
});

app.post('/api/auth', loginLimiter, (req, res) => {
    const { password } = req.body;
    if (password === GATE_PASSWORD) {
        return res.json({ success: true, token: Buffer.from(GATE_PASSWORD).toString('base64') });
    }
    return res.status(401).json({ success: false, message: 'Incorrect password' });
});

// Helper Function: Spintax Parsing {Hi|Hello|Hey}
function parseSpintax(text) {
    if (!text) return '';
    return text.replace(/\{([^{}]+)\}/g, (match, choices) => {
        const options = choices.split('|');
        return options[Math.floor(Math.random() * options.length)];
    });
}

// Helper Function: HTML से Plain Text बनाना
function stripHtml(html) {
    return html.replace(/<[^>]*>?/gm, '').replace(/\s+/g, ' ').trim();
}

const delay = (ms) => new Promise(resolve => setTimeout(resolve, ms));

// Turnstile verification
async function verifyTurnstile(token) {
    if (!TURNSTILE_SECRET || TURNSTILE_SECRET.startsWith('1x00000000')) return true;
    try {
        const response = await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify', {
            method: 'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            body: `secret=${encodeURIComponent(TURNSTILE_SECRET)}&response=${encodeURIComponent(token)}`
        });
        const data = await response.json();
        return data.success;
    } catch (e) {
        return false;
    }
}

app.post('/api/send-stream', async (req, res) => {
    const { senderName, email, appPassword, subject, body, recipients, cfToken, authToken } = req.body;

    // Authorization Verification
    if (authToken !== Buffer.from(GATE_PASSWORD).toString('base64')) {
        return res.status(401).json({ error: 'Unauthorized' });
    }

    // Captcha Validation
    const isHuman = await verifyTurnstile(cfToken);
    if (!isHuman) {
        return res.status(400).json({ error: 'Captcha validation failed' });
    }

    if (!email || !appPassword || !recipients || !Array.isArray(recipients) || recipients.length === 0) {
        return res.status(400).json({ error: 'Missing parameters' });
    }

    // SSE Headers Setup
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');

    const sendSSE = (data) => {
        res.write(`data: ${JSON.stringify(data)}\n\n`);
    };

    // Gmail SMTP Setup
    const transporter = nodemailer.createTransport({
        service: 'gmail',
        pool: false,
        auth: {
            user: email,
            pass: appPassword.replace(/\s+/g, '')
        }
    });

    try {
        await transporter.verify();
    } catch (error) {
        sendSSE({ type: 'fatal_error', message: 'SMTP Auth Failed. Check Gmail & App Password.' });
        return res.end();
    }

    const total = recipients.length;
    let sentCount = 0;
    let failedCount = 0;

    sendSSE({ type: 'start', total });

    // Loop through recipients
    for (let i = 0; i < recipients.length; i++) {
        const recipient = recipients[i];
        
        // Dynamic subject and body for high inbox rate
        const dynamicSubject = parseSpintax(subject);
        const dynamicBody = parseSpintax(body);
        const plainText = stripHtml(dynamicBody);

        const mailOptions = {
            from: `"${senderName}" <${email}>`,
            to: recipient,
            subject: dynamicSubject,
            text: plainText,
            html: dynamicBody,
            headers: {
                'X-Mailer': 'Nodemailer Express Engine',
                'X-Report-Abuse': `Please report abuse to ${email}`
            }
        };

        try {
            await transporter.sendMail(mailOptions);
            sentCount++;
            sendSSE({ type: 'progress', status: 'sent', recipient, sentCount, failedCount });
        } catch (err) {
            failedCount++;
            sendSSE({ type: 'progress', status: 'failed', recipient, error: err.message, sentCount, failedCount });
        }

        // Delay handling
        if (i < recipients.length - 1) {
            // 1. हर 6 मेल भेजने के बाद 30 से 45 सेकंड का ब्रेक (Batch Pause)
            if ((i + 1) % 6 === 0) {
                const batchPause = Math.floor(Math.random() * 15000) + 30000; // 30s to 45s
                sendSSE({ 
                    type: 'info', 
                    message: `Sent 6 mails. Pausing for ${Math.round(batchPause / 1000)} seconds to protect SMTP reputation...` 
                });
                await delay(batchPause);
            } else {
                // 2. सामान्य मेल के बीच 5 से 9 सेकंड की देरी (Inbox-friendly interval)
                const randomWait = Math.floor(Math.random() * 4000) + 5000; 
                await delay(randomWait);
            }
        }
    }

    transporter.close();
    sendSSE({ type: 'complete', sentCount, failedCount, total });
    res.end();
});

app.listen(PORT, () => {
    console.log(`Server listening on port ${PORT}`);
});
