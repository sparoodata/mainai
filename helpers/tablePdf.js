// helpers/tablePdf.js
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

module.exports = { jsonToTablePDF };
