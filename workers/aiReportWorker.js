const { createWorker } = require('../services/queue');
const { askAI } = require('../helpers/ai');
const { jsonToHTMLTablePDF } = require('../helpers/tablePdf');
const { uploadToWhatsApp } = require('../helpers/pdfHelpers');
const { api: whatsappApi } = require('../helpers/whatsapp');

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
      await whatsappApi.post('', {
        messaging_product: 'whatsapp',
        to: from,
        type: 'document',
        document: { id: mediaId, filename: 'report.pdf' }
      });
    } else {
      await whatsappApi.post('', {
        messaging_product: 'whatsapp',
        to: from,
        text: { body: answer }
      });
    }
  } catch (err) {
    console.error('AI worker error', err);
  }
});
