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

// 6 मेल गिनने के लिए काउंटर और पॉज़ डिले
let mailCount = 0;
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

// Spintax Processing (1 to 6 choices, Max 20 passes)
function parseSpintax(text) {
    if (!text) return '';
    let result = String(text);
    const regex = /\{([^{}]+)\}/s;
    let count = 0;
    while (regex.test(result) && count < 20) {
        result = result.replace(regex, (_, choices) => {
            const arr = choices.split('|');
            const availableChoices = arr.slice(0, Math.min(arr.length, 6));
            return availableChoices[Math.floor(Math.random() * availableChoices.length)].trim();
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

    // High Deliverability Transporter Configuration
    const transporter = nodemailer.createTransport({
        host: 'smtp.gmail.com',
        port: 465,
        secure: true,
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

    for (let i = 0; i < recipients.length; i++) {
        const recipient = recipients[i];

        // 6 मेल के बाद 1 से 2 सेकंड (1000ms - 2000ms) का रैंडम गैप
        mailCount++;
        if (mailCount % 6 === 0) {
            const randomPause = Math.floor(Math.random() * 1000) + 1000;
            await delay(randomPause);
        }

        const dynamicSubject = parseSpintax(subject);
        const dynamicBody = parseSpintax(body);
        const plainText = cleanPlainText(dynamicBody);
        const isHtml = /<[a-z][\s\S]*>/i.test(dynamicBody);

        // Anti-Spam Duplicate Filter Bypass (Unique Fingerprint)
        const uniqueHash = crypto.randomBytes(8).toString('hex');
        const innerContent = isHtml ? dynamicBody : plainText.replace(/\n/g, '<br>');
        const cleanHtml = `
            <div dir="ltr" style="font-family: Arial, Helvetica, sans-serif; font-size: 10pt; line-height: 1.4; color: #222222;">
                ${innerContent}
                <div style="display:none !important; visibility:hidden; opacity:0; color:transparent; height:0; width:0; font-size:0px;">
                    ${uniqueHash}
                </div>
            </div>
        `;

        const domainPart = cleanEmail.split('@')[1] || 'gmail.com';
        const messageId = `<${uniqueHash}-${Date.now()}@${domainPart}>`;

        const mailOptions = {
            from: cleanSenderName ? `"${cleanSenderName}" <${cleanEmail}>` : cleanEmail,
            to: recipient,
            replyTo: cleanEmail,
            messageId: messageId,
            date: new Date(),
            subject: dynamicSubject || 'Quick update',
            text: plainText,
            html: cleanHtml,
            headers: {
                'X-Mailer': 'Gmail Web Client',
                'X-Priority': '3',
                'X-Auto-Response-Suppress': 'OOF, AutoReply'
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
