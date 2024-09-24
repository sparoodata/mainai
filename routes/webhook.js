// Unified Webhook Callback
app.post('/webhook', async (req, res) => {
    const { entry } = req.body;

    if (entry && entry.length > 0) {
        const changes = entry[0].changes;
        if (changes && changes.length > 0) {
            const messages = changes[0].value.messages;
            if (messages && messages.length > 0) {
                const message = messages[0];
                const phoneNumber = message.from.replace(/^\+/, ''); // Remove '+' prefix
                const text = message.text ? message.text.body.trim() : null;
                const payload = message.button ? message.button.payload : null;
                const text1 = message.button ? message.button.text : null;
              console.log(messages);

                // Handle OTP Verification
                if (text && /^\d{6}$/.test(text)) { // Check if the message is a 6-digit OTP
                    try {
                        const user = await User.findOne({ phoneNumber });

                        if (user && user.otp === text && user.otpExpiresAt > Date.now()) {
                            user.verified = true;
                            user.otp = undefined;
                            user.otpExpiresAt = undefined;
                            await user.save();

                            console.log('User verified via WhatsApp:', phoneNumber);

                            // Send confirmation message
                            await axios.post(WHATSAPP_API_URL, {
                                messaging_product: 'whatsapp',
                                to: phoneNumber,
                                type: 'template',
                                template: {
                                    name: 'otp_success',  // Ensure this template exists
                                    language: { code: 'en' }
                                }
                            }, {
                                headers: {
                                    'Authorization': `Bearer ${WHATSAPP_ACCESS_TOKEN}`,
                                    'Content-Type': 'application/json'
                                }
                            });

                        } else {
                            console.log('Invalid or expired OTP for:', phoneNumber);
                            // Send failure message
                            await axios.post(WHATSAPP_API_URL, {
                                messaging_product: 'whatsapp',
                                to: phoneNumber,
                                type: 'template',
                                template: {
                                    name: 'otp_failure',  // Ensure this template exists
                                    language: { code: 'en' }
                                }
                            }, {
                                headers: {
                                    'Authorization': `Bearer ${WHATSAPP_ACCESS_TOKEN}`,
                                    'Content-Type': 'application/json'
                                }
                            });
                        }
                    } catch (error) {
                        console.error('Error verifying OTP:', error.response ? error.response.data : error);
                    }
                }

                // Handle Authentication Payloads
                if (payload) {
                    for (const [sessionId, session] of Object.entries(sessions)) {
                        if (session.phoneNumber.replace(/^\+/, '') === phoneNumber) {
                            if (payload === 'Yes') {
                                session.status = 'authenticated';
                                console.log('User authenticated successfully');

                                // Save session data in express session
                                req.session.user = { phoneNumber, sessionId };
                                console.log('Session after setting user:', req.session);

                                // Optionally, send a success message
                                // await axios.post(WHATSAPP_API_URL, {
                                //     messaging_product: 'whatsapp',
                                //     to: phoneNumber,
                                //     type: 'template',
                                //     template: {
                                //         name: 'auth_success',  // Ensure this template exists
                                //         language: { code: 'en' }
                                //     }
                                // }, {
                                //     headers: {
                                //         'Authorization': `Bearer ${WHATSAPP_ACCESS_TOKEN}`,
                                //         'Content-Type': 'application/json'
                                //     }
                                // });

                            } else if (payload === 'No') {
                                session.status = 'denied';
                                console.log('Authentication denied');

                                // Optionally, send a denial message
                                await axios.post(WHATSAPP_API_URL, {
                                    messaging_product: 'whatsapp',
                                    to: phoneNumber,
                                    type: 'template',
                                    template: {
                                        name: 'auth_denied',  // Ensure this template exists
                                        language: { code: 'en' }
                                    }
                                }, {
                                    headers: {
                                        'Authorization': `Bearer ${WHATSAPP_ACCESS_TOKEN}`,
                                        'Content-Type': 'application/json'
                                    }
                                });
                            }
                            break;
                        }
                    }
                }

                // Handle Rent Payment Payload
                if (text1 === 'Rent paid') {
                    // Extract tenant_id from the message text or payload
                    const tenantId = payload.split('-')[1].split(' ')[0]; // Assuming tenant_id is sent in the message text
                    console.log(tenantId);
                    try {
                        const tenant = await Tenant.findOne({ tenant_id: tenantId });

                        if (tenant) {
                            tenant.status = 'PAID';
                            await tenant.save();

                            console.log('Tenant rent status updated to PAID:', tenantId);
let extractedPart = payload.match(/[A-Za-z]+-T\d+/)[0]; 
                            // Optionally, send a confirmation message
await axios.post(WHATSAPP_API_URL, {
    messaging_product: 'whatsapp',
    to: phoneNumber,
    type: 'text',
    text: {
        body: `*${extractedPart}* marked as PAID 🙂👍`
    }
}, {
    headers: {
        'Authorization': `Bearer ${WHATSAPP_ACCESS_TOKEN}`,
        'Content-Type': 'application/json'
    }
});


                        } else {
                            console.log('Tenant not found for tenant_id:', tenantId);
                        }
                    } catch (error) {
                        console.error('Error updating rent status:', error.response ? error.response.data : error);
                    }
                }
            }
        }
    }

    res.sendStatus(200);
});

