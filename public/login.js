document.getElementById('loginForm').addEventListener('submit', async function(event) {
    event.preventDefault();
    const phoneNumber = document.getElementById('phoneNumber').value;
    const statusMessage = document.getElementById('statusMessage');

    // Show loading message
    statusMessage.textContent = 'Loading...';

    try {
        // Send phone number to backend for WhatsApp authentication
        await fetch('/auth', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ phoneNumber })
        });

        // Poll for authentication status
        let isAuthenticated = false;
        const startTime = Date.now();
        const timeout = 30000; // 30 seconds

        while (Date.now() - startTime < timeout) {
            const response = await fetch('/auth/status', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ phoneNumber })
            });
          
            const result = await response.json();

            if (result.status === 'authenticated') {
                isAuthenticated = true;
                break;
            } else if (result.status === 'denied') {
                break;
            }
            await new Promise(resolve => setTimeout(resolve, 2000)); // Poll every 2 seconds
        }

        // Handle authentication result
        if (isAuthenticated) {
            window.location.href = '/dashboard'; // Redirect to dashboard
        } else {
            statusMessage.textContent = 'Access denied or timeout. Please try again.';
        }
    } catch (error) {
        console.error('Login failed:', error);
        statusMessage.textContent = 'An error occurred. Please try again.';
    }
});
