import {
  HISTORY_PREFIX, normalizeHistory, mergeHistories, recordUsage, deleteRecord, rankRecords,
  normalizeSettings, enabledFor, validValue
} from "./history.js";

const FIELD_TYPES = new Set(["GET_HISTORY", "RECORD", "DELETE"]);
const KNOWN_ERRORS = new Set([
  "INVALID_VALUE", "INVALID_SCOPE", "UNSUPPORTED_PAGE", "FORBIDDEN",
  "INVALID_SETTING", "INVALID_TARGET", "UNKNOWN_MESSAGE"
]);

// Keep storage in trusted extension contexts. Content scripts can only request
// their own field's history through the worker, never enumerate other sites.
const ready = chrome.storage.local.setAccessLevel({ accessLevel: "TRUSTED_CONTEXTS" });
let queue = Promise.resolve();

function serialize(task) {
  const result = queue.then(() => ready).then(task);
  queue = result.catch(() => {});
  return result;
}

function webOrigin(url) {
  try {
    const parsed = new URL(url);
    return ["http:", "https:"].includes(parsed.protocol) ? parsed.origin : null;
  } catch {
    return null;
  }
}

async function fieldKey(origin, scope) {
  if (typeof scope !== "string" || !scope.length || scope.length > 12000) throw new Error("INVALID_SCOPE");
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(`${origin}\n${scope}`));
  return HISTORY_PREFIX + [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, "0")).join("");
}

async function settings() {
  return normalizeSettings((await chrome.storage.local.get("settings")).settings);
}

function notifyTabs(details = {}) {
  // No values are broadcast. Visible lists re-query their own field.
  chrome.tabs.query({}).then(tabs => {
    for (const tab of tabs) {
      if (tab.id) chrome.tabs.sendMessage(tab.id, { type: "RETROSPECTION_CHANGED", ...details }).catch(() => {});
    }
  }).catch(() => {});
}

async function readFieldHistory(key, legacyKey, origin, now) {
  let stored = (await chrome.storage.local.get(key))[key];
  const migratedKeys = Array.isArray(stored?.migratedKeys)
    ? stored.migratedKeys.filter(value => typeof value === "string" && value.startsWith(HISTORY_PREFIX)) : [];
  // Import only the current field's previous key, never guess which unrelated
  // field an old hash belonged to. Mark before removing for restart-safe counts.
  if (legacyKey && legacyKey !== key) {
    const legacy = (await chrome.storage.local.get(legacyKey))[legacyKey];
    if (legacy && !migratedKeys.includes(legacyKey)) {
      migratedKeys.push(legacyKey);
      stored = { ...mergeHistories([stored, legacy], now), origin, updatedAt: now, migratedKeys };
      await chrome.storage.local.set({ [key]: stored });
    }
    if (legacy) await chrome.storage.local.remove(legacyKey);
  }
  return { history: normalizeHistory(stored, now), migratedKeys };
}

async function handleField(message, sender) {
  const origin = webOrigin(sender.url);
  if (!origin || !sender.tab || sender.tab.incognito) throw new Error("UNSUPPORTED_PAGE");
  const config = await settings();
  if (!enabledFor(config, origin)) return { enabled: false, records: [] };
  if (message.type !== "GET_HISTORY" && !validValue(message.value)) throw new Error("INVALID_VALUE");
  const key = await fieldKey(origin, message.scope);
  const legacyKey = message.legacyScope ? await fieldKey(origin, message.legacyScope) : null;
  const now = Date.now();
  let { history, migratedKeys } = await readFieldHistory(key, legacyKey, origin, now);
  if (message.type === "RECORD" || message.type === "DELETE") {
    history = message.type === "RECORD"
      ? recordUsage(history, message.value, now)
      : deleteRecord(history, message.value, now);
    if (history.records.length) {
      await chrome.storage.local.set({ [key]: { ...history, origin, updatedAt: now,
        ...(migratedKeys.length ? { migratedKeys } : {}) } });
    } else {
      await chrome.storage.local.remove(key);
    }
    notifyTabs();
  }
  return { enabled: true, records: rankRecords(history, now) };
}

async function getStatus(origin) {
  const [config, all, bytes] = await Promise.all([
    settings(), chrome.storage.local.get(null), chrome.storage.local.getBytesInUse(null)
  ]);
  const stats = { fields: 0, records: 0, weekCount: 0, siteRecords: 0 };
  for (const [key, history] of Object.entries(all)) {
    if (!key.startsWith(HISTORY_PREFIX)) continue;
    const records = rankRecords(history);
    if (records.length) stats.fields++;
    stats.records += records.length;
    stats.weekCount += records.reduce((sum, item) => sum + item.count, 0);
    if (history?.origin === origin) stats.siteRecords += records.length;
  }
  return { settings: config, stats, bytes };
}

async function handlePopup(message, sender) {
  if (!sender.url?.startsWith(chrome.runtime.getURL(""))) throw new Error("FORBIDDEN");
  const origin = webOrigin(message.origin);
  if (message.type === "STATUS") return getStatus(origin);
  if (message.type === "SET_ENABLED") {
    if (typeof message.enabled !== "boolean") throw new Error("INVALID_SETTING");
    const config = await settings();
    config.enabled = message.enabled;
    await chrome.storage.local.set({ settings: config });
  } else if (message.type === "SET_SITE_ENABLED") {
    if (!origin || typeof message.enabled !== "boolean") throw new Error("INVALID_SETTING");
    const config = await settings();
    config.disabledOrigins = config.disabledOrigins.filter(item => item !== origin);
    if (!message.enabled) config.disabledOrigins.push(origin);
    await chrome.storage.local.set({ settings: config });
  } else if (message.type === "CLEAR") {
    if (message.target !== "all" && (message.target !== "site" || !origin)) throw new Error("INVALID_TARGET");
    const all = await chrome.storage.local.get(null);
    const keys = Object.keys(all).filter(key => key.startsWith(HISTORY_PREFIX) &&
      (message.target === "all" || all[key]?.origin === origin));
    if (keys.length) await chrome.storage.local.remove(keys);
  } else {
    throw new Error("UNKNOWN_MESSAGE");
  }
  notifyTabs(message.type === "CLEAR" ? { action: "CLEAR", target: message.target, origin } : {});
  return getStatus(origin);
}

chrome.runtime.onMessage.addListener((message, sender, respond) => {
  if (sender.id !== chrome.runtime.id || typeof message?.type !== "string") return;
  serialize(() => FIELD_TYPES.has(message.type) ? handleField(message, sender) : handlePopup(message, sender))
    .then(data => respond({ ok: true, ...data }))
    .catch(error => {
      respond({ ok: false, error: KNOWN_ERRORS.has(error.message) ? error.message : "STORAGE_ERROR" });
    });
  // Compatible with versions before promise-returning message listeners.
  return true;
});
