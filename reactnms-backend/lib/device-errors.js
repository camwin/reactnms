function cell(row, column) {
  if (!row) return undefined;
  return row[column] ?? row[String(column)];
}

function counter(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : 0;
}

export function interfaceErrorRows(table) {
  const rows = [];
  for (const [index, row] of Object.entries(table || {})) {
    const item = {
      index: String(index),
      name: String(cell(row, 2) || `if ${index}`),
      inDiscards: counter(cell(row, 13)),
      inErrors: counter(cell(row, 14)),
      outDiscards: counter(cell(row, 19)),
      outErrors: counter(cell(row, 20)),
    };
    if (item.inDiscards || item.inErrors || item.outDiscards || item.outErrors) rows.push(item);
  }
  return rows;
}

export function classifyEvents(events) {
  const reachability = [];
  const link = [];
  const switching = [];
  for (const event of events || []) {
    const summary = String(event.summary || '');
    if (event.kind === 'reachability' && /ICMP down/i.test(summary)) reachability.push(event);
    else if (event.kind === 'interface' && /→ down/i.test(summary)) link.push(event);
    else if (event.kind === 'spanning-tree' && /→ (blocking|broken|disabled)/i.test(summary)) switching.push(event);
  }
  return { reachability, link, switching };
}
