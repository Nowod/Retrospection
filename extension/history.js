// A rolling 168-hour window, independent of calendar dates and time zones.
export const WINDOW_MS = 7 * 24 * 60 * 60 * 1000;
export const MAX_RECORDS = 100;
export const MAX_VALUE_LENGTH = 4000;
export const HISTORY_PREFIX = "history:";

export function validValue(value) {
  return typeof value === "string" && value.length <= MAX_VALUE_LENGTH && value.trim().length > 0;
}

export function normalizeHistory(history, now = Date.now()) {
  const unique = new Map();
  for (const record of Array.isArray(history?.records) ? history.records : []) {
    if (!validValue(record?.value)) continue;
    const events = (Array.isArray(record.events) ? record.events : [])
      .filter(time => Number.isFinite(time) && time > now - WINDOW_MS && time <= now)
      .sort((a, b) => a - b);
    const lastUsed = Number.isFinite(record.lastUsed) ? Math.min(record.lastUsed, now) : (events.at(-1) ?? 0);
    const previous = unique.get(record.value);
    if (!previous || lastUsed > previous.lastUsed) {
      unique.set(record.value, { value: record.value, events, lastUsed });
    }
  }
  return {
    version: 1,
    records: [...unique.values()].sort((a, b) => b.lastUsed - a.lastUsed).slice(0, MAX_RECORDS)
  };
}

export function recordUsage(history, value, now = Date.now()) {
  if (!validValue(value)) throw new Error("INVALID_VALUE");
  const next = normalizeHistory(history, now);
  let record = next.records.find(item => item.value === value);
  if (!record) {
    record = { value, events: [], lastUsed: now };
    next.records.unshift(record);
  }
  record.events.push(now);
  record.lastUsed = now;
  next.records.sort((a, b) => b.lastUsed - a.lastUsed);
  next.records = next.records.slice(0, MAX_RECORDS);
  return next;
}

export function deleteRecord(history, value, now = Date.now()) {
  const next = normalizeHistory(history, now);
  next.records = next.records.filter(record => record.value !== value);
  return next;
}

// Migration combines uses from separate groups, including uses at the same
// millisecond. Deduplicating timestamps here would silently lose real counts.
export function mergeHistories(histories, now = Date.now()) {
  const merged = new Map();
  for (const history of histories) {
    for (const record of normalizeHistory(history, now).records) {
      const previous = merged.get(record.value);
      merged.set(record.value, previous ? {
        value: record.value,
        events: [...previous.events, ...record.events],
        lastUsed: Math.max(previous.lastUsed, record.lastUsed)
      } : record);
    }
  }
  return normalizeHistory({ records: [...merged.values()] }, now);
}

export function rankRecords(history, now = Date.now()) {
  return normalizeHistory(history, now).records
    .map(({ value, events, lastUsed }) => ({ value, count: events.length, lastUsed }))
    .sort((a, b) => b.count - a.count || b.lastUsed - a.lastUsed || a.value.localeCompare(b.value));
}

export function normalizeSettings(settings) {
  return {
    enabled: typeof settings?.enabled === "boolean" ? settings.enabled : true,
    disabledOrigins: [...new Set((Array.isArray(settings?.disabledOrigins) ? settings.disabledOrigins : [])
      .filter(value => typeof value === "string" && /^https?:\/\//.test(value)))]
  };
}

export function enabledFor(settings, origin) {
  const normalized = normalizeSettings(settings);
  return normalized.enabled && !normalized.disabledOrigins.includes(origin);
}
