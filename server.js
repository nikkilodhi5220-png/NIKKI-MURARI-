const express = require('express');
const nodemailer = require('nodemailer');
const cors = require('cors');
const rateLimit = require('express-rate-limit');
const path = require('path');
const crypto = require('crypto');
require('dotenv').config();

const app = express();
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ limit: '50mb', extended: true }));
app.use(cors());
app.use(express.static(path.join(__dirname, 'public')));

const PORT = process.env.PORT || 3000;
const GATE_PASSWORD = process.env.GATE_PASSWORD || 'admin123';
const TURNSTILE_SECRET = process.env.TURNSTILE_SECRET_KEY || '';

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

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

// Standard Spintax Processor
function parseSpintax(text) {
    if (!text) return '';
    let result = String(text);
    const regex = /\{([^{}]+)\}/s;
    let count = 0;
    while (regex.test(result) && count < 20) {
        result = result.replace(regex, (_, choices) => {
            const arr = choices.split('|');
            return arr[Math.floor(Math.random() * arr.length)].trim();
        });
        count++;
    }
    return result;
}

function cleanPlainText(html) {
    if (!html) return '';
    return html
        .replace(/<style([\s\S]*?)<\/style>/gi, '')
        .replace(/<script([\s\S]*?)<\/script>/gi, '')
        .replace(/<br\s*[\/]?>/gi, '\n')
        .replace(/<\/p>/gi, '\n\n')
        .replace(/<[^>]+>/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
}

// Generate Legitimate Reference ID for Audit/Tracking
function generateRefCode() {
    return `[Ref-ID: ${crypto.randomBytes(3).toString('hex').toUpperCase()}]`;
}

async function verifyTurnstile(token) {
    if (!TURNSTILE_SECRET || TURNSTILE_SECRET.startsWith('1x00000000')) return true;
    try {
        const response = await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify', {
            method: 'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            body: `secret=${encodeURIComponent(TURNSTILE_SECRET)}&response=${encodeURIComponent(token)}`
        });
        const data = await response.json();
        return data.success === true;
    } catch (e) {
        return false;
    }
}

app.post('/api/send-stream', async (req, res) => {
    const { senderName, email, appPassword, subject, body, recipients, cfToken, authToken } = req.body;

    if (authToken !== Buffer.from(GATE_PASSWORD).toString('base64')) {
        return res.status(401).json({ error: 'Unauthorized' });
    }

    const isHuman = await verifyTurnstile(cfToken);
    if (!isHuman) {
        return res.status(400).json({ error: 'Captcha validation failed' });
    }

    if (!email || !appPassword || !recipients || !Array.isArray(recipients) || recipients.length === 0) {
        return res.status(400).json({ error: 'Missing parameters' });
    }

    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');

    const sendSSE = (data) => {
        res.write(`data: ${JSON.stringify(data)}\n\n`);
    };

    const cleanEmail = email.toLowerCase().trim();
    const cleanSenderName = (senderName || '').replace(/["\r\n]/g, '').trim();

    // Standard STARTTLS Connection setup
    const transporter = nodemailer.createTransport({
        host: 'smtp.gmail.com',
        port: 587,
        secure: false, // TLS via STARTTLS
        requireTLS: true,
        pool: true,
        maxConnections: 5,
        maxMessages: Infinity,
        socketTimeout: 30000,
        connectionTimeout: 30000,
        auth: {
            user: cleanEmail,
            pass: appPassword.replace(/\s+/g, '').trim()
        }
    });

    try {
        await transporter.verify();
    } catch (error) {
        sendSSE({ type: 'fatal_error', message: 'SMTP Auth Failed. Check Gmail address and App Password.' });
        return res.end();
    }

    const total = recipients.length;
    let sentCount = 0;
    let failedCount = 0;

    sendSSE({ type: 'start', total });

    // Batching Configuration (6 Emails per batch with 1-2 sec pacing delay)
    const BATCH_SIZE = 6;

    for (let i = 0; i < recipients.length; i += BATCH_SIZE) {
        const batch = recipients.slice(i, i + BATCH_SIZE);

        const batchPromises = batch.map(async (recipient) => {
            const cleanRecipient = recipient.trim();
            if (!cleanRecipient) return { success: false, recipient: '', error: 'Empty recipient' };

            const dynamicSubject = parseSpintax(subject);
            const dynamicBody = parseSpintax(body);
            const plainText = cleanPlainText(dynamicBody);
            const isHtml = /<[a-z][\s\S]*>/i.test(dynamicBody);
            const refCode = generateRefCode();

            const finalHtml = isHtml 
                ? `<div style="font-family: Arial, sans-serif; font-size: 14px; color: #111111; line-height: 1.5;">${dynamicBody}<br><br><span style="font-size: 11px; color: #888888;">${refCode}</span></div>`
                : `<div style="font-family: Arial, sans-serif; font-size: 14px; color: #111111; line-height: 1.5;">${dynamicBody.replace(/\n/g, '<br>')}<br><br><span style="font-size: 11px; color: #888888;">${refCode}</span></div>`;

            const finalPlainText = `${plainText}\n\n${refCode}`;

            const mailOptions = {
                from: cleanSenderName ? `"${cleanSenderName}" <${cleanEmail}>` : cleanEmail,
                to: cleanRecipient,
                replyTo: cleanEmail,
                subject: dynamicSubject || 'Notification',
                text: finalPlainText,
                html: finalHtml,
                textEncoding: 'quoted-printable',
                encoding: 'utf-8'
            };

            try {
                await transporter.sendMail(mailOptions);
                return { success: true, recipient: cleanRecipient };
            } catch (err) {
                return { success: false, recipient: cleanRecipient, error: err.message };
            }
        });

        const results = await Promise.allSettled(batchPromises);

        results.forEach((resItem) => {
            if (resItem.status === 'fulfilled') {
                const val = resItem.value;
                if (val.success) {
                    sentCount++;
                    sendSSE({ type: 'progress', status: 'sent', recipient: val.recipient, sentCount, failedCount });
                } else {
                    failedCount++;
                    sendSSE({ type: 'progress', status: 'failed', recipient: val.recipient, error: val.error, sentCount, failedCount });
                }
            }
        });

        // 1 se 2 second delay between batches for steady sending speed
        if (i + BATCH_SIZE < recipients.length) {
            const randomPause = Math.floor(Math.random() * 1000) + 1000;
            await delay(randomPause);
        }
    }

    transporter.close();
    sendSSE({ type: 'complete', sentCount, failedCount, total });
    res.end();
});

app.get('*', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

if (process.env.NODE_ENV !== 'production' && !process.env.VERCEL) {
    app.listen(PORT, () => {
        console.log(`Server running safely on port ${PORT}`);
    });
}

module.exports = app;
