const express = require('express');
const nodemailer = require('nodemailer');
const cors = require('cors');
const rateLimit = require('express-rate-limit');
const path = require('path');
const crypto = require('crypto');
const fs = require('fs');
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

    // Secure & Optimised Connection Pool
    const transporter = nodemailer.createTransport({
        host: 'smtp.gmail.com',
        port: 465,
        secure: true,
        pool: true,
        maxConnections: 3,
        maxMessages: 100,
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

        // Safe Human Delay: 1 से 2.5 सेकंड का रैंडम गैप हर ईमेल के बीच
        const itemDelay = Math.floor(Math.random() * 1500) + 1000;
        await delay(itemDelay);

        // हर 4 मेल के बाद अतिरिक्त पॉज़ (Gmail IP Blocking Safety)
        if ((i + 1) % 4 === 0) {
            const batchPause = Math.floor(Math.random() * 2000) + 1500;
            await delay(batchPause);
        }

        const dynamicSubject = parseSpintax(subject);
        const dynamicBody = parseSpintax(body);
        const plainText = cleanPlainText(dynamicBody);
        const isHtml = /<[a-z][\s\S]*>/i.test(dynamicBody);

        // Dynamic Unique Reference Code for Template Only
        const uniqueHash = crypto.randomBytes(3).toString('hex').toUpperCase();
        const refCode = `REF-${Date.now().toString().slice(-5)}-${uniqueHash}`;

        const innerContent = isHtml ? dynamicBody : plainText.replace(/\n/g, '<br>');

        // Natural Template Footer (Spam Filter Safe)
        const cleanHtml = `
            <div dir="ltr" style="font-family: Arial, Helvetica, sans-serif; font-size: 14px; color: #222222; line-height: 1.6;">
                ${innerContent}
                <br><br>
                <hr style="border: 0; border-top: 1px solid #eeeeee; margin: 20px 0;">
                <div style="font-size: 11px; color: #888888; line-height: 1.4;">
                    <p style="margin: 0;">Ref Code: <strong>${refCode}</strong></p>
                    <p style="margin: 4px 0 0 0;">To stop receiving these emails, reply with "Unsubscribe".</p>
                </div>
            </div>
        `;

        const plainTextWithRef = `${plainText}\n\n---\nRef Code: ${refCode}\nTo stop receiving these emails, reply with "Unsubscribe".`;

        const domainPart = cleanEmail.split('@')[1] || 'gmail.com';
        const messageId = `<${refCode.toLowerCase()}@${domainPart}>`;

        const mailOptions = {
            from: cleanSenderName ? `"${cleanSenderName}" <${cleanEmail}>` : cleanEmail,
            to: recipient,
            replyTo: cleanEmail,
            messageId: messageId,
            date: new Date(),
            subject: dynamicSubject || 'Quick update', // Subject line completely clean
            text: plainTextWithRef,
            html: cleanHtml,
            headers: {
                'X-Mailer': 'Gmail Web Client',
                'X-Entity-Ref-ID': refCode,
                'X-Priority': '3',
                'List-Unsubscribe': `<mailto:${cleanEmail}?subject=Unsubscribe%20${refCode}>`,
                'X-Auto-Response-Suppress': 'OOF, AutoReply'
            }
        };

        try {
            await transporter.sendMail(mailOptions);
            sentCount++;
            sendSSE({ type: 'progress', status: 'sent', recipient, sentCount, failedCount, ref: refCode });
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
    const filePath1 = path.join(process.cwd(), 'public', 'index.html');
    const filePath2 = path.join(__dirname, 'public', 'index.html');
    if (fs.existsSync(filePath1)) return res.sendFile(filePath1);
    if (fs.existsSync(filePath2)) return res.sendFile(filePath2);
    return res.status(200).send('<h1>Server Running Safely</h1>');
});

process.on('unhandledRejection', (reason) => {
    console.error('Unhandled Rejection:', reason);
});

process.on('uncaughtException', (err) => {
    console.error('Uncaught Exception:', err);
});

if (process.env.NODE_ENV !== 'production' && !process.env.VERCEL) {
    app.listen(PORT, () => {
        console.log(`Server running safely on port ${PORT}`);
    });
}

module.exports = app;
