// helpers/tableText.js
/**
 * Convert an array-of-objects (or single object) to a monospace table string.
 * The result is wrapped in ``` so WhatsApp shows it in a code block.
 * @param {Object|Object[]} json
 * @returns {string}
 */
function jsonToTableText(json) {
  const rows = Array.isArray(json) ? json : [json];
  if (rows.length === 0) return '```<empty>```';

  const headers = Object.keys(rows[0]);
  const colWidths = headers.map(h =>
    Math.max(
      h.length,
      ...rows.map(r => String(r[h] ?? '').length),
    ),
  );

  const pad = (str, i) =>
    String(str ?? '').padEnd(colWidths[i], ' ');

  const headerLine = headers
    .map(pad)
    .join(' │ ');

  const sepLine = colWidths
    .map(w => '─'.repeat(w))
    .join('─┼─');

  const bodyLines = rows.map(r =>
    headers.map((h, i) => pad(r[h], i)).join(' │ '),
  );

  return '```text\n' +
    headerLine + '\n' +
    sepLine    + '\n' +
    bodyLines.join('\n') +
    '\n```';
}

module.exports = { jsonToTableText };
