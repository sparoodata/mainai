document.getElementById('loginForm').addEventListener('submit', async (event) => {
    event.preventDefault();

    const phoneNumber = document.getElementById('phoneNumber').value;

    document.getElementById('loading').style.display = 'block';
    document.getElementById('resend').style.display = 'none';

    try {
        const response = await fetch('/auth', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ phoneNumber })
        });

        if (response.ok) {
            // Poll for authentication status
            const checkStatus = async () => {
                const statusResponse = await fetch('/auth/status', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ phoneNumber })
                });

                if (statusResponse.ok) {
                    const status = await statusResponse.text();
                    if (status === 'authenticated') {
                        window.location.href = '/dashboard';
                    } else if (status === 'pending') {
                        setTimeout(checkStatus, 5000); // Check every 5 seconds
                    } else if (status === 'timeout') {
                        document.getElementById('loading').style.display = 'none';
                        document.getElementById('resend').style.display = 'block';
                    }
                } else {
                    console.error('Failed to check authentication status:', await statusResponse.text());
                }
            };

            checkStatus();
        } else {
            console.error('Failed to send authentication message:', await response.text());
            alert('Failed to send authentication message.');
        }
    } catch (error) {
        console.error('Error:', error);
        alert('Error sending request.');
    }
});

document.getElementById('resendButton').addEventListener('click', () => {
    document.getElementById('phoneNumber').value = '';
    document.getElementById('loading').style.display = 'none';
    document.getElementById('resend').style.display = 'none';
});
