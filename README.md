# Secure Mail Console

A high-performance bulk email sender optimized for primary inbox delivery.

## Features
- Dynamic batch sending (**Batch Size: 2**) with safe delays (3s-5s).
- Primary Inbox optimization headers (`Message-ID`, `List-Unsubscribe`, `MIME-Version`).
- Spintax & Personalization placeholders (`{Name}`, `{FirstName}`, `{Email}`, `{Domain}`).
- Server Auth & Cloudflare Turnstile protection.
- Real-time Event Streaming (SSE) for send status.
