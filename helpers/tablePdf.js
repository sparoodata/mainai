// helpers/tablePdf.js
const axios = require('axios');
const { jsonToTableHTML } = require('./tableHtml');

function jsonToTablePDF(data) {
  if (!Array.isArray(data) || data.length === 0)
    throw new Error('jsonToTablePDF expects a non-empty array');

  const headers = Object.keys(data[0]);
  const rows    = data.map(o => headers.map(h => String(o[h] ?? '')));

  const cfg = {
    type: 'table',
    data: { header: headers, rows },
    options: {
      plugins: {
        table: {
          headerBackgroundColor: '#4CAF50',
          headerTextColor:       '#ffffff',
          borderWidth:           1,
          borderColor:           '#ddd',
          striped:               true,
        },
      },
    },
  };

  const enc = encodeURIComponent(JSON.stringify(cfg));

  // Generate the QuickChart URL for a PDF. Using the `format=pdf` query
  // parameter is more reliable than relying on the deprecated `.pdf`
  // path variant, which in some cases produced empty files.
  return `https://quickchart.io/chart?format=pdf&width=1000&backgroundColor=white&c=${enc}`;
}

/**
 * Convert JSON data into an HTML table and return a PDF buffer of that table
 * by using QuickChart's HTML-to-PDF service.
 * @param {Object[]} data
 * @returns {Promise<Buffer>}
 */
async function jsonToHTMLTablePDF(data) {
  if (!Array.isArray(data) || data.length === 0)
    throw new Error('jsonToHTMLTablePDF expects a non-empty array');

  const tableHtml = jsonToTableHTML(data);
  const html = `<!DOCTYPE html><html><body>${tableHtml}</body></html>`;

  const { data: pdfBuf } = await axios.post(
    'https://quickchart.io/pdf',
    { html },
    { responseType: 'arraybuffer' },
  );
  return Buffer.from(pdfBuf);
}

module.exports = { jsonToTablePDF, jsonToHTMLTablePDF };
