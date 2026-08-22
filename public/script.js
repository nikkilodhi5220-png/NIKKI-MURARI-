document.addEventListener('DOMContentLoaded', () => {
    // 🔴 DOUBLE CLICK LOGOUT SYSTEM
    const logoutBtn = document.getElementById('logout-btn');
    const logoutText = document.getElementById('logout-text');
    let logoutClicks = 0;
    let logoutTimer = null;

    if (logoutBtn) {
        logoutBtn.addEventListener('click', () => {
            logoutClicks++;

            if (logoutClicks === 1) {
                if (logoutText) logoutText.textContent = "पुष्टि के लिए पुनः क्लिक करें!";
                logoutBtn.style.backgroundColor = "var(--danger-color)";
                logoutBtn.style.color = "#ffffff";

                logoutTimer = setTimeout(() => {
                    logoutClicks = 0;
                    if (logoutText) logoutText.textContent = "लॉग आउट";
                    logoutBtn.style.backgroundColor = "";
                    logoutBtn.style.color = "";
                }, 3000);
            } else if (logoutClicks === 2) {
                clearTimeout(logoutTimer);
                sessionStorage.clear();
                localStorage.clear();
                window.location.reload();
            }
        });
    }

    // TOGGLE PASSWORD VISIBILITY
    const togglePassBtn = document.getElementById('toggle-pass');
    const smtpPassInput = document.getElementById('smtp-pass');
    
    if (togglePassBtn && smtpPassInput) {
        togglePassBtn.addEventListener('click', () => {
            const type = smtpPassInput.getAttribute('type') === 'password' ? 'text' : 'password';
            smtpPassInput.setAttribute('type', type);
            const icon = togglePassBtn.querySelector('i');
            if (icon) {
                icon.classList.toggle('fa-eye');
                icon.classList.toggle('fa-eye-slash');
            }
        });
    }

    // RECIPIENT COUNT
    const recipientsInput = document.getElementById('recipients-input');
    const recipientCountBadge = document.getElementById('recipient-count');

    if (recipientsInput && recipientCountBadge) {
        recipientsInput.addEventListener('input', () => {
            const lines = recipientsInput.value
                .split('\n')
                .map(e => e.trim())
                .filter(e => e.length > 0);
            recipientCountBadge.textContent = `${lines.length} ईमेल`;
        });
    }

    // FORM SUBMIT
    const emailForm = document.getElementById('email-form');
    const sendBtn = document.getElementById('send-btn');
    const progressBar = document.getElementById('progress-bar');
    const statusSpinner = document.getElementById('status-spinner');
    const statusText = document.getElementById('status-text');

    const statTotal = document.getElementById('stat-total');
    const statSent = document.getElementById('stat-sent');
    const statFailed = document.getElementById('stat-failed');
    const statRemaining = document.getElementById('stat-remaining');

    if (emailForm) {
        emailForm.addEventListener('submit', async (e) => {
            e.preventDefault();

            const recipientsArr = recipientsInput.value
                .split('\n')
                .map(e => e.trim())
                .filter(e => e.length > 0);

            if (recipientsArr.length === 0) {
                alert('कृपया कम से कम एक प्राप्तकर्ता ईमेल दर्ज करें!');
                return;
            }

            const payload = {
                smtp: {
                    host: document.getElementById('smtp-host').value.trim(),
                    port: document.getElementById('smtp-port').value.trim(),
                    user: document.getElementById('smtp-user').value.trim(),
                    pass: document.getElementById('smtp-pass').value.trim()
                },
                senderName: document.getElementById('sender-name').value.trim(),
                subject: document.getElementById('email-subject').value.trim(),
                htmlBody: document.getElementById('message-body').value,
                recipients: recipientsArr
            };

            sendBtn.disabled = true;
            sendBtn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> भेजा जा रहा है...';
            if (statusSpinner) statusSpinner.classList.remove('hidden');
            if (statusText) statusText.textContent = 'Gmail SMTP कनेक्ट किया जा रहा है...';

            try {
                const response = await fetch('/api/send-emails', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify(payload)
                });

                const reader = response.body.getReader();
                const decoder = new TextDecoder();
                let buffer = '';

                while (true) {
                    const { done, value } = await reader.read();
                    if (done) break;

                    buffer += decoder.decode(value, { stream: true });
                    const lines = buffer.split('\n\n');
                    buffer = lines.pop();

                    for (const line of lines) {
                        if (line.startsWith('data: ')) {
                            const data = JSON.parse(line.replace('data: ', ''));
                            handleSSEMessage(data);
                        }
                    }
                }
            } catch (error) {
                if (statusText) {
                    statusText.textContent = `त्रुटि: ${error.message}`;
                    statusText.className = 'text-danger';
                }
            } finally {
                sendBtn.disabled = false;
                sendBtn.innerHTML = '<i class="fa-solid fa-paper-plane"></i> इनबॉक्स में भेजें';
                if (statusSpinner) statusSpinner.classList.add('hidden');
            }
        });
    }

    function handleSSEMessage(data) {
        if (data.type === 'start') {
            if (statTotal) statTotal.textContent = data.total;
            if (statSent) statSent.textContent = '0';
            if (statFailed) statFailed.textContent = '0';
            if (statRemaining) statRemaining.textContent = data.total;
            if (progressBar) progressBar.style.width = '0%';
            if (statusText) {
                statusText.textContent = '1-by-1 इनबॉक्स डिलीवरी जारी है...';
                statusText.className = 'text-primary';
            }
        } 
        else if (data.type === 'progress') {
            if (statSent) statSent.textContent = data.sentCount;
            if (statFailed) statFailed.textContent = data.failCount;
            const remaining = data.total - (data.sentCount + data.failCount);
            if (statRemaining) statRemaining.textContent = remaining;

            const percent = Math.round(((data.sentCount + data.failCount) / data.total) * 100);
            if (progressBar) progressBar.style.width = `${percent}%`;

            if (statusText) {
                if (data.status === 'success') {
                    statusText.textContent = `[${data.index}/${data.total}] इनबॉक्स ➔ ${data.recipient}`;
                    statusText.className = 'text-success';
                } else {
                    statusText.textContent = `[${data.index}/${data.total}] विफल ➔ ${data.recipient}`;
                    statusText.className = 'text-danger';
                }
            }
        } 
        else if (data.type === 'complete') {
            if (statusText) {
                statusText.textContent = `सभी ईमेल सफलतापूर्वक प्रोसेस हो चुके हैं!`;
                statusText.className = 'text-success';
            }
            if (progressBar) progressBar.style.width = '100%';
        } 
        else if (data.type === 'error') {
            if (statusText) {
                statusText.textContent = data.message;
                statusText.className = 'text-danger';
            }
        }
    }
});
