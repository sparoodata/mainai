# Teraa Assistant

This project hosts the Node.js server that powers the **Teraa Assistant** WhatsApp bot. It uses Express with MongoDB for storing user data and integrates with Razorpay for payment links. Incoming WhatsApp messages are processed using various helper modules located in `helpers/`.

The server entry point is `server.js`. Routes are defined under `routes/` and Mongoose models live in `models/`.

To start the server locally run:

```bash
npm start
```

Make sure to provide a `.env` file with your database connection string and API keys.
