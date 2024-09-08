document.getElementById('loginForm').addEventListener('submit', async (event) => {
    event.preventDefault();

    const phoneNumber = document.getElementById('phoneNumber').value;

    try {
        const response = await fetch('/auth', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ phoneNumber })
        });

        if (response.ok) {
            alert('Authentication message sent. Please check your WhatsApp.');
        } else {
            alert('Failed to send authentication message.');
        }
    } catch (error) {
        console.error('Error:', error);
        alert('Error sending request.');
    }
});
