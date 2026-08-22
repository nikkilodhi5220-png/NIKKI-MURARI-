const express = require('express');
const nodemailer = require('nodemailer');
const cors = require('cors');
const path = require('path');
const crypto = require('crypto');
require('dotenv').config();

const app = express();

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// HTML से टैग्स हटाकर साफ प्लेन-टेक्स्ट बनाने का फ़ंक्शन
function stripHtml(html) {
    if (!html) return '';
    return html
        .replace(/<style([\s\S]*?)<\/style>/gi, '')
        .replace(/<script([\s\S]*?)<\/script>/gi, '')
        .replace(/<[^>]+>/g, '')
        .replace(/\s+/g, ' ')
        .trim();
}

// रैंडम यूनिक नंबर/आईडी जनरेट करने का फ़ंक्शन
function generateUniqueId() {
    const randomHex = crypto.randomBytes(4).toString('hex').toUpperCase();
    const timestamp = Date.now().toString().slice(-6);
    return `REF-${timestamp}-${randomHex}`;
}

// रैंडम डिले (Min-Max Milliseconds)
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

app.post('/api/send-emails', async (req, res) => {
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');

    const { smtp, senderName, subject, htmlBody, recipients } = req.body;

    const smtpHost = (smtp && smtp.host && smtp.host.trim()) ? smtp.host.trim() : 'smtp.gmail.com';
    const smtpPort = (smtp && smtp.port && parseInt(smtp.port)) ? parseInt(smtp.port) : 465;

    if (!smtp || !smtp.user || !smtp.pass || !recipients || recipients.length === 0) {
        res.write(`data: ${JSON.stringify({ type: 'error', message: 'Gmail ID या App Password दर्ज करना अनिवार्य है!' })}\n\n`);
        return res.end();
    }

    const cleanUser = smtp.user.trim();
    const cleanPass = smtp.pass.trim().replace(/\s+/g, '');

    // प्रॉपर और सेफ SMTP ट्रांसपोर्टर सेटिंग्स
    const transporter = nodemailer.createTransport({
        host: smtpHost,
        port: smtpPort,
        secure: smtpPort === 465, // 465 पर SSL true, 587 पर false
        auth: {
            user: cleanUser,
            pass: cleanPass
        },
        tls: {
            rejectUnauthorized: false
        },
        pool: false
    });

    try {
        await transporter.verify();
    } catch (err) {
        res.write(`data: ${JSON.stringify({ type: 'error', message: `Gmail/SMTP कनेक्शन त्रुटि: ${err.message}` })}\n\n`);
        return res.end();
    }

    const total = recipients.length;
    let sentCount = 0;
    let failCount = 0;

    res.write(`data: ${JSON.stringify({ type: 'start', total })}\n\n`);

    for (let i = 0; i < recipients.length; i++) {
        const recipient = recipients[i].trim();
        if (!recipient) continue;

        // हर ईमेल के लिए एक पूरी तरह से यूनिक ट्रैकिंग/रैंडम कोड
        const trackingId = generateUniqueId();
        const domainName = cleanUser.split('@')[1] || 'gmail.com';

        // 1. यूनिक HTML बॉडी (नीचे सेफ यूनिक नंबर और हिडन रिफ कोड जोड़ा गया है)
        const customHtmlBody = `
            ${htmlBody}
            <br><br>
            <hr style="border: none; border-top: 1px solid #e0e0e0; margin-top: 20px;">
            <div style="font-size: 11px; color: #888888; font-family: Arial, sans-serif;">
                <p style="margin: 2px 0;">Ref ID: <strong>${trackingId}</strong></p>
                <p style="margin: 2px 0; display: none;">Security Code: ${crypto.randomUUID()}</p>
            </div>
        `;

        // 2. यूनिक Plain Text बॉडी
        const basePlainText = stripHtml(htmlBody);
        const customPlainText = `${basePlainText}\n\n-------------------------\nRef ID: ${trackingId}`;

        // 3. एंटी-स्पैम हेडर्स जो मेल को Inbox में लैंड कराते हैं
        const mailOptions = {
            from: `"${senderName.trim()}" <${cleanUser}>`,
            to: recipient,
            subject: subject.trim(),
            text: customPlainText,
            html: customHtmlBody,
            headers: {
                'X-Entity-Ref-ID': trackingId,
                'X-Mailer': 'NodeMailer Standard Client',
                'Message-ID': `<${Date.now()}.${trackingId}@${domainName}>`,
                'List-Unsubscribe': `<mailto:${cleanUser}?subject=unsubscribe>`
            }
        };

        try {
            await transporter.sendMail(mailOptions);
            sentCount++;
            res.write(`data: ${JSON.stringify({ 
                type: 'progress', 
                status: 'success', 
                recipient, 
                sentCount, 
                failCount, 
                index: i + 1, 
                total 
            })}\n\n`);
        } catch (error) {
            failCount++;
            res.write(`data: ${JSON.stringify({ 
                type: 'progress', 
                status: 'failed', 
                recipient, 
                error: error.message, 
                sentCount, 
                failCount, 
                index: i + 1, 
                total 
            })}\n\n`);
        }

        // 🔴 सेफ इनबॉक्सिंग स्पीड: हर ईमेल के बीच 5 से 9 सेकंड का रैंडम डिले
        if (i < recipients.length - 1) {
            const safeRandomDelay = Math.floor(Math.random() * 4000) + 5000; // 5000ms - 9000ms
            await delay(safeRandomDelay);
        }
    }

    res.write(`data: ${JSON.stringify({ type: 'complete', sentCount, failCount, total })}\n\n`);
    res.end();
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🚀 Safe Mailer Server running on port ${PORT}`));
