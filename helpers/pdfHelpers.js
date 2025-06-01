// helpers/pdfHelpers.js
const pdf = require('html-pdf-node');
const axios = require('axios');
const FormData = require('form-data');

/**
 * Convert raw HTML (string) to a Buffer containing an A4 PDF.
 * @param {string} html
 * @returns {Promise<Buffer>}
 */
async function htmlToPdfBuffer(html) {
  const file = { content: html };
  return pdf.generatePdf(file, {
    format:   'A4',
    printBackground: true,
    margin: { top: 10, bottom: 10, left: 10, right: 10 },
  });
}

/**
 * Upload a file buffer to the WhatsApp Cloud API and return the media ID.
 * @param {Buffer} buffer
 * @param {string} filename  e.g. "report.pdf"
 * @param {string} mime      e.g. "application/pdf"
 * @returns {Promise<string>}  media_id
 */
async function uploadToWhatsApp(buffer, filename, mime) {
  const form = new FormData();
  form.append('file', buffer, { filename, contentType: mime });
  form.append('type', mime);
  form.append('messaging_product', 'whatsapp');  // ✅ REQUIRED!

  const { data } = await axios.post(
    `https://graph.facebook.com/v20.0/${process.env.PHONE_NUMBER_ID}/media`,
    form,
    {
      headers: {
        ...form.getHeaders(),
        Authorization: `Bearer ${process.env.WHATSAPP_ACCESS_TOKEN}`,
      },
    },
  );

  return data.id;                     // media_id
}

module.exports = { htmlToPdfBuffer, uploadToWhatsApp };
