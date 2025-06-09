const { createWorker } = require('../services/queue');
const { askAI } = require('../helpers/ai');
const { jsonToHTMLTablePDF } = require('../helpers/tablePdf');
const { uploadToWhatsApp } = require('../helpers/pdfHelpers');
const axios = require('axios');

const WHATSAPP_API_URL = 'https://graph.facebook.com/v20.0/110765315459068/messages';
const WHATSAPP_ACCESS_TOKEN = process.env.WHATSAPP_ACCESS_TOKEN;

createWorker('ai-report', async job => {
  const { from, aiQuery } = job.data;
  try {
    const answer = await askAI(aiQuery);
    let parsed;
    try {
      parsed = JSON.parse(answer);
      if (parsed && typeof parsed === 'object' && 'data' in parsed && Array.isArray(parsed.data)) {
        parsed = parsed.data;
      }
    } catch (_) {}

    if (parsed) {
      const pdfBuf = await jsonToHTMLTablePDF(parsed);
      const mediaId = await uploadToWhatsApp(pdfBuf, 'report.pdf', 'application/pdf');
      await axios.post(WHATSAPP_API_URL,
        {
          messaging_product: 'whatsapp',
          to: from,
          type: 'document',
          document: { id: mediaId, filename: 'report.pdf' }
        },
        {
          headers: { Authorization: `Bearer ${WHATSAPP_ACCESS_TOKEN}`, 'Content-Type': 'application/json' }
        }
      );
    } else {
      await axios.post(WHATSAPP_API_URL,
        {
          messaging_product: 'whatsapp',
          to: from,
          text: { body: answer }
        },
        {
          headers: { Authorization: `Bearer ${WHATSAPP_ACCESS_TOKEN}`, 'Content-Type': 'application/json' }
        }
      );
    }
  } catch (err) {
    console.error('AI worker error', err);
  }
});
