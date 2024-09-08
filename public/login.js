document.getElementById('loginForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const phoneNumber = document.getElementById('phoneNumber').value;
    
    const response = await fetch('/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ phoneNumber })
    });
    
    if (response.ok) {
        alert('Authentication request sent!');
    } else {
        alert('Error sending request.');
    }
});
