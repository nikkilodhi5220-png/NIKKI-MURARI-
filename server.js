const express = require('express');
const nodemailer = require('nodemailer');
const cors = require('cors');
const path = require('path');
require('dotenv').config();

const app = express();

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// HTML से सभी स्टाइल, स्क्रिप्ट और टैग्स हटाकर प्लेन टेक्स्ट बनाने का फंक्शन (Spam Protection)
function stripHtml(html) {
    if (!html) return '';
    return html
        .replace(/<style([\s\S]*?)<\/style>/gi, '')
        .replace(/<script([\s\S]*?)<\/script>/gi, '')
        .replace(/<[^>]+>/g, '')
        .replace(/\s+/g, ' ')
        .trim();
}

// रैंडम डिले फंक्शन (Human behavior mimic करने के लिए)
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

app.post('/api/send-emails', async (req, res) => {
    // SSE (Server-Sent Events) - लाइव प्रोग्रेस स्ट्रीमिंग
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');

    const { smtp, senderName, subject, htmlBody, recipients } = req.body;

    if (!smtp || !smtp.host || !smtp.user || !smtp.pass || !recipients || recipients.length === 0) {
        res.write(`data: ${JSON.stringify({ type: 'error', message: 'सर्वर् कॉन्फ़िगरेशन या प्राप्तकर्ता फ़ील्ड अधूरी है!' })}\n\n`);
        return res.end();
    }

    // SMTP ट्रांसपोर्टर सेट करें
    const transporter = nodemailer.createTransport({
        host: smtp.host,
        port: parseInt(smtp.port) || 465,
        secure: parseInt(smtp.port) === 465, // 465 के लिए true, 587 के लिए false
        auth: {
            user: smtp.user,
            pass: smtp.pass
        },
        // Anti-Spam Socket Connection Settings
        tls: {
            rejectUnauthorized: false
        },
        pool: false // Batch connections से बचने के लिए single connection
    });

    try {
        await transporter.verify();
    } catch (err) {
        res.write(`data: ${JSON.stringify({ type: 'error', message: `SMTP कनेक्ट करने में विफल: ${err.message}` })}\n\n`);
        return res.end();
    }

    const total = recipients.length;
    let sentCount = 0;
    let failCount = 0;

    res.write(`data: ${JSON.stringify({ type: 'start', total })}\n\n`);

    // 🔴 STRICT RULE: 1 ईमेल 1 बैच में (1 Email per Request with Interval)
    for (let i = 0; i < recipients.length; i++) {
        const recipient = recipients[i].trim();
        if (!recipient) continue;

        // प्लेन-टेक्स्ट वर्ज़न बनाएं (यह ईमेल को Spams/Promotions में जाने से रोकता है)
        const plainText = stripHtml(htmlBody);

        const mailOptions = {
            from: `"${senderName.trim()}" <${smtp.user.trim()}>`,
            to: recipient,
            subject: subject,
            text: plainText,
            html: htmlBody,
            // 🛑 CLEAN HEADERS: स्पैम ट्रिगर करने वाले सभी हेडर्स हटा दिए गए हैं
            headers: {
                'X-Priority': '3', // Normal Priority (1 or High usually flags spam)
                'Importance': 'normal'
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

        // हर ईमेल के बाद 3.5 सेकंड का डिले (Primary Inbox Delivery Ensure करने के लिए)
        if (i < recipients.length - 1) {
            const randomDelay = Math.floor(Math.random() * 1500) + 3000; // 3.0s से 4.5s का Random Wait
            await delay(randomDelay);
        }
    }

    res.write(`data: ${JSON.stringify({ type: 'complete', sentCount, failCount, total })}\n\n`);
    res.end();
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🚀 Server running on port ${PORT}`));
