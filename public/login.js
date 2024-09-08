document.addEventListener('DOMContentLoaded', () => {
    const form = document.getElementById('login-form');
    const statusMessage = document.getElementById('status-message');

    form.addEventListener('submit', async (e) => {
        e.preventDefault();

        const phoneNumber = document.getElementById('phoneNumber').value;
        statusMessage.innerHTML = 'Sending authentication request...';

        try {
            const response = await fetch('/send-auth', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ phoneNumber })
            });
            const data = await response.json();

            if (response.ok) {
                statusMessage.innerHTML = 'Authentication request sent. Waiting for confirmation...';
                const sessionId = data.sessionId;
                await checkAuthStatus(sessionId);
            } else {
                statusMessage.innerHTML = 'Failed to send authentication request.';
            }
        } catch (error) {
            statusMessage.innerHTML = 'Error: ' + error.message;
        }
    });

    async function checkAuthStatus(sessionId) {
        const timeout = 30000; // 30 seconds
        const startTime = Date.now();

        const checkInterval = setInterval(async () => {
            try {
                const response = await fetch(`/auth/status/${sessionId}`);
                const data = await response.json();

                if (data.status === 'authenticated') {
                    clearInterval(checkInterval);
                    window.location.href = '/dashboard';
                } else if (data.status === 'denied') {
                    clearInterval(checkInterval);
                    statusMessage.innerHTML = 'Access denied.';
                } else if (Date.now() - startTime > timeout) {
                    clearInterval(checkInterval);
                    statusMessage.innerHTML = 'Authentication request timed out. Please try again.';
                }
            } catch (error) {
                statusMessage.innerHTML = 'Error checking status: ' + error.message;
                clearInterval(checkInterval);
            }
        }, 5000); // Check every 5 seconds
    }
});
