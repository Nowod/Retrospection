const allowedLevels = new Set(["controllable_by_this_extension", "controlled_by_this_extension"]);

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
  return result;
}

export async function releaseNativeHistory(api = chrome) {
  const state = await readNativeHistory(api);
  if (state.level === "controlled_by_this_extension") {
    await api.privacy.services.autofillAddressEnabled.clear({ scope: "regular" });
  }
  return readNativeHistory(api);
}
