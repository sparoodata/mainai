// helpers/tableImage.js
/**
 * Turn an array-of-objects into a QuickChart “table” image URL.
 * @param {Object[]} data
 * @returns {string} https:// link WhatsApp can fetch
 */
function jsonToTableImage(data) {
  if (!Array.isArray(data) || data.length === 0) {
    throw new Error('jsonToTableImage expects a non-empty array');
  }

  const headers = Object.keys(data[0]);
  const rows    = data.map(obj => headers.map(h => String(obj[h] ?? '')));

  const chartConfig = {
    type: 'table',
    data: { header: headers, rows },
    options: {
      plugins: {
        table: {
          headerBackgroundColor: '#4CAF50',
          headerTextColor:     '#ffffff',
          borderWidth:         1,
          borderColor:         '#ddd',
          striped:             true,
        },
      },
    },
  };

  // Build the QuickChart URL (URL-encode, not base64, and no “auto” height)
  const cfg = encodeURIComponent(JSON.stringify(chartConfig));
  return `https://quickchart.io/chart?bkg=white&width=1000&c=${cfg}`;
}

module.exports = { jsonToTableImage };
