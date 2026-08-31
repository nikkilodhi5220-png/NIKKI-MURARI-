require('dotenv').config();
const express = require('express');
const nodemailer = require('nodemailer');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;
const SITE_PASSWORD = process.env.SITE_PASSWORD || '123456';
const TURNSTILE_SECRET_KEY = process.env.TURNSTILE_SECRET_KEY || '';

// Active streams for target cancellation tracking
const activeStreams = new Map();

app.use(express.json());
app.use(express.static(path.join(__dirname)));

// Verify Cloudflare Turnstile Token
async function verifyTurnstile(token) {
    if (!TURNSTILE_SECRET_KEY) return true; // Skip if key not configured
    if (!token) return false;

    try {
        const response = await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify', {
            method: 'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            body: new URLSearchParams({
                secret: TURNSTILE_SECRET_KEY,
                response: token
            })
        });
        const data = await response.json();
        return data.success;
    } catch (err) {
        console.error('Turnstile verification error:', err);
        return false;
    }
}

// Spintax Parsing Helper: {Hi|Hello|Hey} -> Random choice
function parseSpintax(text) {
    if (!text) return '';
    return text.replace(/\{([^{}]+)\}/g, (match, choices) => {
        const options = choices.split('|');
        return options[Math.floor(Math.random() * options.length)];
    });
}

// 1. Password Auth API
app.post('/api/auth', (req, res) => {
    const { password } = req.body;
    if (password === SITE_PASSWORD) {
        return res.json({ success: true });
    }
    return res.status(401).json({ success: false, message: 'Invalid password' });
});

// 2. Verify SMTP Credentials API
app.post('/api/verify', async (req, res) => {
    const { email, appPassword, cfToken } = req.body;

    const isHuman = await verifyTurnstile(cfToken);
    if (!isHuman) {
        return res.status(400).json({ success: false, message: 'Turnstile verification failed.' });
    }

    if (!email || !appPassword) {
        return res.status(400).json({ success: false, message: 'Email and App Password required.' });
    }

    const transporter = nodemailer.createTransport({
        service: 'gmail',
        auth: { user: email, pass: appPassword }
    });

    try {
        await transporter.verify();
        return res.json({ success: true, message: 'SMTP credentials valid.' });
    } catch (err) {
        console.error('SMTP Auth Failure:', err.message);
        return res.status(401).json({ success: false, message: 'SMTP authentication failed. Check credentials.' });
    }
});

// 3. Send Bulk Email Stream Endpoint (SSE)
app.post('/api/send-stream', async (req, res) => {
    const { email, appPassword, senderName, subject, messageBody, recipients, cfToken, streamId } = req.body;

    const isHuman = await verifyTurnstile(cfToken);
    if (!isHuman) {
        return res.status(400).json({ success: false, message: 'Turnstile verification failed.' });
    }

    if (!email || !appPassword || !recipients || !Array.isArray(recipients) || recipients.length === 0) {
        return res.status(400).json({ success: false, message: 'Invalid payload.' });
    }

    // Assign session stream tracking ID
    const currentStreamId = streamId || Date.now().toString();
    activeStreams.set(currentStreamId, { stopRequested: false });

    // Header Setup for SSE
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');

    const transporter = nodemailer.createTransport({
        service: 'gmail',
        auth: { user: email, pass: appPassword },
        maxConnections: 5,
        maxMessages: 100
    });

    for (let i = 0; i < recipients.length; i++) {
        const streamState = activeStreams.get(currentStreamId);
        if (streamState && streamState.stopRequested) {
            res.write(`data: ${JSON.stringify({ stopped: true, message: 'Stopped by user.' })}\n\n`);
            break;
        }

        const recipient = recipients[i];
        const processedSubject = parseSpintax(subject);
        const processedBody = parseSpintax(messageBody);

        const mailOptions = {
            from: `"${senderName}" <${email}>`,
            to: recipient,
            subject: processedSubject,
            html: processedBody
        };

        try {
            await transporter.sendMail(mailOptions);
            res.write(`data: ${JSON.stringify({ success: true, recipient, index: i + 1, total: recipients.length })}\n\n`);
        } catch (err) {
            console.error(`Failed to send to ${recipient}:`, err.message);
            res.write(`data: ${JSON.stringify({ success: false, recipient, error: err.message, index: i + 1, total: recipients.length })}\n\n`);
        }

        // Small delay (~150ms) to ensure smooth streaming without hitting Google rate limiters
        await new Promise(resolve => setTimeout(resolve, 150));
    }

    res.write('data: [DONE]\n\n');
    activeStreams.delete(currentStreamId);
    res.end();
});

// 4. Stop Email Sending Endpoint
app.post('/api/stop', (req, res) => {
    const { streamId } = req.body;
    if (streamId && activeStreams.has(streamId)) {
        activeStreams.get(streamId).stopRequested = true;
    } else {
        // Fallback: stop all streams if no specific ID provided
        for (const [id, state] of activeStreams.entries()) {
            state.stopRequested = true;
        }
    }
    return res.json({ success: true, message: 'Stop signal registered.' });
});

app.listen(PORT, () => {
    console.log(`Server running smoothly on http://localhost:${PORT}`);
});
