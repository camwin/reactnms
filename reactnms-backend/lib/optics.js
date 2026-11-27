export const SENSOR_TABLE = '1.3.6.1.2.1.99.1.1';
export const SENSOR_COLUMNS = [1, 2, 3, 4];
export const JUNIPER_DOM_TABLE = '1.3.6.1.4.1.2636.3.60.1.1.1';
export const JUNIPER_DOM_COLUMNS = [5, 7];

const SCALE_EXP = {
  1: -24, 2: -21, 3: -18, 4: -15, 5: -12, 6: -9, 7: -6, 8: -3, 9: 0,
  10: 3, 11: 6, 12: 9, 13: 12, 14: 15, 15: 18, 16: 21, 17: 24,
};

function cell(row, column) {
  if (!row) return undefined;
  return row[column] ?? row[String(column)];
}

export function sensorDbm(type, scale, precision, value) {
  if (Number(type) !== 14) return null;
  const exp = SCALE_EXP[Number(scale)];
  const raw = Number(value);
  const places = Number(precision);
  if (exp == null || !Number.isFinite(raw)) return null;
  const denom = 10 ** (Number.isFinite(places) ? places : 0);
  if (!denom) return null;
  return raw * (10 ** exp) / denom;
}

export function opticDirection(name) {
  const text = String(name || '').toLowerCase();
  if (/(^|[^a-z])(rx|receive|receiver)([^a-z]|$)|input power|rx power/.test(text)) return 'rx';
  if (/(^|[^a-z])(tx|transmit|transmitter)([^a-z]|$)|output power|tx power/.test(text)) return 'tx';
  return '';
}

function opticKey(name) {
  return String(name || '')
    .toLowerCase()
    .replace(/input power|output power|rx power|tx power/g, ' ')
    .replace(/\b(rx|tx|receive|receiver|transmit|transmitter|power)\b/g, ' ')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim() || 'optic';
}

export function pairOptics(names, sensors) {
  const groups = new Map();
  for (const [index, row] of Object.entries(sensors || {})) {
    const dbm = sensorDbm(cell(row, 1), cell(row, 2), cell(row, 3), cell(row, 4));
    if (dbm == null || !Number.isFinite(dbm)) continue;
    const name = String((names || {})[index] || `entity ${index}`);
    const direction = opticDirection(name);
    if (!direction) continue;
    const key = opticKey(name);
    const group = groups.get(key) || { name: key, rx: null, tx: null };
    group[direction] = Math.round(dbm * 100) / 100;
    if (group.name === key) group.name = name.replace(/\b(rx|tx|receive|receiver|transmit|transmitter)\b/ig, '').replace(/\s+/g, ' ').trim() || name;
    groups.set(key, group);
  }
  return [...groups.values()].filter((row) => row.rx != null || row.tx != null);
}

export function juniperOptics(table, names = {}) {
  const optics = [];
  for (const [index, row] of Object.entries(table || {})) {
    const rxRaw = Number(cell(row, 5));
    const txRaw = Number(cell(row, 7));
    const rx = Number.isFinite(rxRaw) ? Math.round(rxRaw) / 100 : null;
    const tx = Number.isFinite(txRaw) ? Math.round(txRaw) / 100 : null;
    if (rx == null && tx == null) continue;
    optics.push({ name: names[index] || `if ${index}`, rx, tx });
  }
  return optics;
}
