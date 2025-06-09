# Teraa Assistant

This project hosts the Node.js server that powers the **Teraa Assistant** WhatsApp bot. It uses Express with MongoDB for storing user data and integrates with Razorpay for payment links. Incoming WhatsApp messages are processed using various helper modules located in `helpers/`.

The server entry point is `server.js`. Routes are defined under `routes/` and Mongoose models live in `models/`.

Redis is used to persist conversation state and BullMQ handles background jobs such as AI report generation. To enable error monitoring provide a `SENTRY_DSN`.

To start the server locally run:

```bash
npm start
node workers/aiReportWorker.js &
```

Make sure to provide a `.env` file with your database connection string and API keys.

At minimum the following environment variable is required:

- `MCP_API_KEY` – your API key for the AI service used by `helpers/ai.js`. The
 server sends prompts to `https://getai-sooty.vercel.app/prompt` by default.
- `MCP_URL` *(optional)* – override the default AI endpoint if it changes.
- `REDIS_URL` *(optional)* – connection string for Redis used to store session data.
- `SENTRY_DSN` *(optional)* – enable Sentry error monitoring.
- `WHATSAPP_APP_SECRET` *(optional)* – used to verify incoming WhatsApp webhook signatures.
