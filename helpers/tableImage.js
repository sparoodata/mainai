// helpers/tableImage.js
/**
 * Build a QuickChart.io URL that renders an array-of-objects as a table PNG.
 * @param {Object[]} data
 * @returns {string} URL to the rendered image
 */
function jsonToTableImage(data) {
  if (!Array.isArray(data) || data.length === 0)
    throw new Error('jsonToTableImage expects a non-empty array');

  const headers = Object.keys(data[0]);
  const rows    = data.map(o => headers.map(h => String(o[h] ?? '')));

  const cfg = {
    type:   'table',
    data:   { header: headers, rows },
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
  // width is fixed (pixels); height is automatic
  return `https://quickchart.io/chart?bkg=white&width=1000&c=${enc}`;
}

module.exports = { jsonToTableImage };
