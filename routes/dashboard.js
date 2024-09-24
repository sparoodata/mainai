const jwt = require('jsonwebtoken');

// Middleware to verify JWT
function authenticateToken(req, res, next) {
    const token = req.cookies.auth_token; // Or retrieve from the request headers (Authorization Bearer token)

    if (!token) return res.status(401).json({ error: 'Access denied. No token provided.' });

    try {
        const verified = jwt.verify(token, process.env.JWT_SECRET); // Verify the token with the secret
        req.user = verified; // Attach the verified data to the request object (e.g., phone number)
        next(); // Continue to the dashboard
    } catch (error) {
        return res.status(400).json({ error: 'Invalid token.' });
    }
}
