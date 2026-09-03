const express = require('express');
const nodemailer = require('nodemailer');
const cors = require('cors');
const rateLimit = require('express-rate-limit');
const path = require('path');
const crypto = require('crypto');
require('dotenv').config();

const app = express();
app.use(express.json({ limit: '50mb' }));
app.use(cors());
app.use(express.static(path.join(__dirname, 'public')));

const PORT = process.env.PORT || 3000;
const GATE_PASSWORD = process.env.GATE_PASSWORD || 'admin123';
const TURNSTILE_SECRET = process.env.TURNSTILE_SECRET_KEY || '';

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

// Spintax syntax parser
function parseSpintax(text) {
    if (!text) return '';
    return text.replace(/\{([^{}]+)\}/g, (match, choices) => {
        const options = choices.split('|');
        return options[Math.floor(Math.random() * options.length)];
    });
}

function stripHtml(html) {
    if (!html) return '';
    return html.replace(/<[^>]*>?/gm, '').replace(/\s+/g, ' ').trim();
}

// Random Unique Reference Code Generator
function generateRefCode() {
    return `[Ref-ID: ${crypto.randomBytes(3).toString('hex').toUpperCase()}]`;
}

const delay = (ms) => new Promise(resolve => setTimeout(resolve, ms));

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

    const transporter = nodemailer.createTransport({
        service: 'gmail',
        pool: true,
        maxConnections: 6,
        maxMessages: Infinity,
        auth: {
            user: email.trim(),
            pass: appPassword.replace(/\s+/g, '')
        },
        connectionTimeout: 15000,
        socketTimeout: 15000
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

    const BATCH_SIZE = 6;

    for (let i = 0; i < recipients.length; i += BATCH_SIZE) {
        const batch = recipients.slice(i, i + BATCH_SIZE);

        const batchPromises = batch.map(async (recipient) => {
            const dynamicSubject = parseSpintax(subject);
            const dynamicBody = parseSpintax(body);
            const refCode = generateRefCode();

            // Append Reference Code to HTML and Text Content
            const isHtml = /<[a-z][\s\S]*>/i.test(dynamicBody);
            
            const finalHtml = isHtml 
                ? `${dynamicBody}<br><br><span style="font-size:11px;color:#888888;font-family:monospace;">${refCode}</span>`
                : `<div style="font-family:sans-serif;font-size:14px;line-height:1.5;color:#111111;">${dynamicBody.replace(/\n/g, '<br>')}<br><br><span style="font-size:11px;color:#888888;font-family:monospace;">${refCode}</span></div>`;

            const finalPlainText = `${stripHtml(dynamicBody)}\n\n${refCode}`;

            const mailOptions = {
                from: senderName ? `"${senderName.trim()}" <${email.trim()}>` : email.trim(),
                to: recipient.trim(),
                subject: dynamicSubject,
                text: finalPlainText,
                html: finalHtml,
                textEncoding: 'quoted-printable',
                encoding: 'utf-8',
                headers: {
                    'X-Mailer': 'NodeMailer Engine',
                    'X-Report-Abuse': `Please report abuse to ${email.trim()}`
                }
            };

            try {
                await transporter.sendMail(mailOptions);
                return { recipient, success: true };
            } catch (err) {
                return { recipient, success: false, error: err.message };
            }
        });

        const results = await Promise.all(batchPromises);

        results.forEach((resResult) => {
            if (resResult.success) {
                sentCount++;
                sendSSE({ type: 'progress', status: 'sent', recipient: resResult.recipient, sentCount, failedCount });
            } else {
                failedCount++;
                sendSSE({ type: 'progress', status: 'failed', recipient: resResult.recipient, error: resResult.error, sentCount, failedCount });
            }
        });

        // 1 se 2 second (1000ms - 2000ms) gap between batches
        if (i + BATCH_SIZE < recipients.length) {
            const fastGap = Math.floor(1000 + Math.random() * 1000);
            await delay(fastGap);
        }
    }

    transporter.close();
    sendSSE({ type: 'complete', sentCount, failedCount, total });
    res.end();
});

app.listen(PORT, () => {
    console.log(`Server listening on port ${PORT}`);
});
