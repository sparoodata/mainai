// helpers/tableHtml.js
function escapeHtml(str = '') {
  return String(str).replace(/[&<>"']/g, s =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[s])
  );
}

/**
 * Convert an array-of-objects (or single object) into an HTML <table>.
 * @param {Object|Object[]} json
 * @returns {string} HTML
 */
function jsonToTableHTML(json) {
  const rows = Array.isArray(json) ? json : [json];
  if (rows.length === 0) return '<table></table>';

  const headers = Object.keys(rows[0]);

  const thead = `<thead><tr>${
    headers.map(h => `<th>${escapeHtml(h)}</th>`).join('')
  }</tr></thead>`;

  const tbody = `<tbody>${
    rows.map(r =>
      `<tr>${headers
        .map(h => `<td>${escapeHtml(r[h] ?? '')}</td>`)
        .join('')}</tr>`).join('')
  }</tbody>`;

  return `<table border="1" cellpadding="4" cellspacing="0" style="border-collapse:collapse;">${thead}${tbody}</table>`;
}

module.exports = { jsonToTableHTML };
