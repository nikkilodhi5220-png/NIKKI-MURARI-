const express = require('express');
const nodemailer = require('nodemailer');
const cors = require('cors');
const path = require('path');
require('dotenv').config();

const app = express();

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// HTML से सभी टैग्स और फालतू स्पेस हटाकर प्लेन टेक्स्ट बनाने का फंक्शन
function stripHtml(html) {
    if (!html) return '';
    return html
        .replace(/<style([\s\S]*?)<\/style>/gi, '')
        .replace(/<script([\s\S]*?)<\/script>/gi, '')
        .replace(/<[^>]+>/g, '')
        .replace(/\s+/g, ' ')
        .trim();
}

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

app.post('/api/send-emails', async (req, res) => {
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');

    const { smtp, senderName, subject, htmlBody, recipients } = req.body;

    if (!smtp || !smtp.host || !smtp.user || !smtp.pass || !recipients || recipients.length === 0) {
        res.write(`data: ${JSON.stringify({ type: 'error', message: 'SMTP विवरण या प्राप्तकर्ता सूची अधूरी है!' })}\n\n`);
        return res.end();
    }

    const transporter = nodemailer.createTransport({
        host: smtp.host,
        port: parseInt(smtp.port) || 465,
        secure: parseInt(smtp.port) === 465,
        auth: {
            user: smtp.user,
            pass: smtp.pass
        },
        tls: {
            rejectUnauthorized: false
        },
        pool: false
    });

    try {
        await transporter.verify();
    } catch (err) {
        res.write(`data: ${JSON.stringify({ type: 'error', message: `SMTP कनेक्शन त्रुटि: ${err.message}` })}\n\n`);
        return res.end();
    }

    const total = recipients.length;
    let sentCount = 0;
    let failCount = 0;

    res.write(`data: ${JSON.stringify({ type: 'start', total })}\n\n`);

    // 🔴 STRICT 1-BY-1 BATCH LOOP
    for (let i = 0; i < recipients.length; i++) {
        const recipient = recipients[i].trim();
        if (!recipient) continue;

        const plainText = stripHtml(htmlBody);

        const mailOptions = {
            from: `"${senderName.trim()}" <${smtp.user.trim()}>`,
            to: recipient,
            subject: subject,
            text: plainText,
            html: htmlBody,
            headers: {
                'X-Priority': '3',
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

        // हर 1 ईमेल के बाद 3 से 4.5 सेकंड का रैंडम गैप (Inboxing के लिए)
        if (i < recipients.length - 1) {
            const randomDelay = Math.floor(Math.random() * 1500) + 3000;
            await delay(randomDelay);
        }
    }

    res.write(`data: ${JSON.stringify({ type: 'complete', sentCount, failCount, total })}\n\n`);
    res.end();
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🚀 Server running on port ${PORT}`));
