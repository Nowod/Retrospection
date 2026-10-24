const allowedLevels = new Set(["controllable_by_this_extension", "controlled_by_this_extension"]);
const configuredKey = "nativeAutofillConfigured";

export async function readNativeHistory(api = chrome) {
  if (!await api.permissions.contains({ permissions: ["privacy"] })) {
    return { granted: false, enabled: null, canChange: false, level: null };
  }
  const setting = api.privacy?.services?.autofillAddressEnabled;
  if (!setting) throw new Error("NATIVE_UNAVAILABLE");
  const details = await setting.get({});
  return { granted: true, enabled: details.value, level: details.levelOfControl,
    canChange: allowedLevels.has(details.levelOfControl) };
}

export async function setNativeHistory(enabled, api = chrome) {
  if (typeof enabled !== "boolean") throw new Error("INVALID_SETTING");
  const state = await readNativeHistory(api);
  if (!state.granted) throw new Error("NATIVE_PERMISSION");
  if (!state.canChange) throw new Error("NATIVE_LOCKED");
  await api.privacy.services.autofillAddressEnabled.set({ value: enabled, scope: "regular" });
  const result = await readNativeHistory(api);
  if (result.enabled !== enabled) throw new Error("NATIVE_LOCKED");
  await api.storage.local.set({ [configuredKey]: true });
  return result;
}

export async function initializeNativeHistory(api = chrome) {
  const state = await readNativeHistory(api);
  if (!state.granted || !state.canChange) return state;
  if ((await api.storage.local.get(configuredKey))[configuredKey] === true) return state;
  // Apply the default once; preserve manual choices across popup and worker restarts.
  return setNativeHistory(false, api);
}
