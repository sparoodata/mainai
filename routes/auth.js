const express = require('express');
const router = express.Router();
const axios = require('axios');

// Send authentication request via WhatsApp
router.post('/login', async (req, res) => {
    const { phoneNumber } = req.body;
    const message = `Please authenticate by replying "YES" or "NO".`;
    
    try {
        await axios.post('https://api.whatsapp.com/send', {
            phone: phoneNumber,
            message: message,
            key: 'EABkIvofy2pMBO7m8SrPKiAgzXfFCHW2Mso4W4jXxc3dApHv55Vw6WNwrjT22oWFk6MdvU3GXxM1BSeunpl5MbTWkID0CMIKQgFhiRYYZC57IBMPUZBkPo2HlzuWmc0mxHezS6DZAXyfjpzsSEmSCKA65L0qRkuRJMHihPo9LCRFvsrzUBi1O3JiBVWm3sLi'
        });
        res.status(200).send('Authentication request sent.');
    } catch (error) {
        res.status(500).send('Error sending authentication request.');
    }
});

// Handle WhatsApp reply (this part needs webhook setup)
router.post('/verify', (req, res) => {
    const { phoneNumber, response } = req.body;
    
    if (response === 'YES') {
        // Redirect to dashboard (implement actual redirection logic here)
        res.redirect('/dashboard');
    } else {
        res.send('Please re-enter your phone number.');
    }
});

module.exports = router;
