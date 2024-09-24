// Send WhatsApp Authentication Request
app.post('/send-auth', async (req, res) => {
    const { phoneNumber } = req.body;
    const sessionId = Date.now().toString(); // Generate a unique session ID

    sessions[sessionId] = { phoneNumber, status: 'pending' }; // Track session

    try {
        const response = await axios.post(WHATSAPP_API_URL, {
            messaging_product: 'whatsapp',
            to: phoneNumber,
            type: 'template',
            template: {
                name: 'authorize', // Ensure this template exists
                language: { code: 'en' }
            }
        }, {
            headers: {
                'Authorization': `Bearer ${WHATSAPP_ACCESS_TOKEN}`,
                'Content-Type': 'application/json'
            }
        });

        console.log('Authentication message sent successfully:', response.data);
        res.json({ message: 'Authentication message sent', sessionId });
    } catch (error) {
        console.error('Failed to send authentication message:', error.response ? error.response.data : error);
        res.status(500).json({ error: 'Failed to send authentication message' });
    }
});
