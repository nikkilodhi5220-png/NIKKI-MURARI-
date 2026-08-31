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

function parseSpintax(text) {
    if (!text) return '';
    return text.replace(/\{([^{}]+)\}/g, (match, choices) => {
        const options = choices.split('|');
        return options[Math.floor(Math.random() * options.length)];
    });
}

function stripHtml(html) {
    return html.replace(/<[^>]*>?/gm, '').replace(/\s+/g, ' ').trim();
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

    // Nodemailer Connection Pool Setup - Max Concurrent Connections 6
    const transporter = nodemailer.createTransport({
        service: 'gmail',
        pool: true,
        maxConnections: 6, // 6 concurrent connections allowed
        maxMessages: Infinity,
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

    const total = Number(recipients.length) || 0;
    let sentCount = 0;
    let failedCount = 0;

    sendSSE({ type: 'start', total });

    const BATCH_SIZE = 6; // एक साथ 6 ईमेल

    for (let i = 0; i < recipients.length; i += BATCH_SIZE) {
        const batch = recipients.slice(i, i + BATCH_SIZE);

        const batchPromises = batch.map(async (recipientRaw) => {
            const recipient = recipientRaw.trim();
            if (!recipient) return null;

            const dynamicSubject = parseSpintax(subject);
            const dynamicBody = parseSpintax(body);
            const plainText = stripHtml(dynamicBody);

            const mailOptions = {
                from: `"${senderName}" <${email}>`,
                to: recipient,
                subject: dynamicSubject,
                text: plainText,
                html: dynamicBody
            };

            try {
                await transporter.sendMail(mailOptions);
                return { recipient, success: true };
            } catch (err) {
                return { recipient, success: false, error: err.message };
            }
        });

        // Fire 6 emails concurrently
        const results = await Promise.all(batchPromises);

        results.forEach((resResult) => {
            if (!resResult) return;

            if (resResult.success) {
                sentCount++;
                sendSSE({ 
                    type: 'progress', 
                    status: 'sent', 
                    recipient: resResult.recipient, 
                    sentCount: Number(sentCount), 
                    failedCount: Number(failedCount),
                    total: Number(total) 
                });
            } else {
                failedCount++;
                sendSSE({ 
                    type: 'progress', 
                    status: 'failed', 
                    recipient: resResult.recipient, 
                    error: resResult.error, 
                    sentCount: Number(sentCount), 
                    failedCount: Number(failedCount),
                    total: Number(total) 
                });
            }
        });

        // Exact 1 to 2 seconds random delay after 6 emails sent
        if (i + BATCH_SIZE < recipients.length) {
            const randomWait = Math.floor(Math.random() * 1000) + 1000; // 1000ms to 2000ms (1-2s)
            await delay(randomWait);
        }
    }

    transporter.close();
    sendSSE({ type: 'complete', sentCount, failedCount, total });
    res.end();
});

app.listen(PORT, () => {
    console.log(`Server listening on port ${PORT}`);
});
