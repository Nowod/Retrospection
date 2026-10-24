const $ = id => document.getElementById(id);
let origin = null;
let status = null;
let clearTarget = null;
let busy = false;
let nativeBusy = false;
let nativeListenerAttached = false;
let nativeReadId = 0;
let nativeState = null;

function renderNative(state) {
  nativeState = state;
  $("native-enabled").checked = state.enabled === true;
  $("native-enabled").indeterminate = state.enabled === null;
  $("native-enabled").disabled = nativeBusy || (state.granted && !state.canChange);
  $("native-status").textContent = !state.granted ? "点击开关授权管理" : !state.canChange
    ? (state.level === "controlled_by_other_extensions" ? "此设置由其他扩展控制" : "此设置由浏览器策略锁定")
    : "";
}

async function refreshNative() {
  const id = ++nativeReadId;
  try {
    const state = await send("GET_NATIVE_HISTORY");
    if (id !== nativeReadId) return;
    renderNative(state);
    if (state.granted && !nativeListenerAttached) {
      chrome.privacy.services.autofillAddressEnabled.onChange.addListener(() => refreshNative());
      nativeListenerAttached = true;
    }
  } catch {
    if (id !== nativeReadId) return;
    $("native-enabled").disabled = true;
    $("native-status").textContent = "无法读取 Chrome 设置，请重新打开插件";
  }
}

async function changeNative(enabled) {
  if (nativeBusy) return;
  nativeBusy = true;
  $("native-enabled").disabled = true;
  message("");
  try {
    // Keep the permission request in this switch's user gesture, before any await.
    if (!nativeState?.granted && !await chrome.permissions.request({ permissions: ["privacy"] })) {
      message("未授予权限，Chrome 原设置保持不变");
      return;
    }
    await send("SET_NATIVE_HISTORY", { enabled });
  } catch (error) {
    message(error.message === "NATIVE_LOCKED" ? "此设置受策略或其他扩展控制，无法修改" : "无法修改 Chrome 设置，请重试", true);
  } finally {
    nativeBusy = false;
    await refreshNative();
  }
}

$("native-enabled").addEventListener("change", event => {
  changeNative(event.target.checked);
});
chrome.permissions.onRemoved.addListener(() => refreshNative());
chrome.permissions.onAdded.addListener(() => refreshNative());
refreshNative();

async function send(type, details = {}) {
  const result = await chrome.runtime.sendMessage({ type, origin, ...details });
  if (!result?.ok) throw new Error(result?.error || "DISCONNECTED");
  return result;
}

function message(text, error = false) {
  $("message").textContent = text;
  $("message").classList.toggle("error", error);
}

function render(result) {
  status = result;
  const { settings, stats } = result;
  $("site-enabled").checked = Boolean(origin && settings.enabledOrigins.includes(origin));
  $("site-enabled").disabled = busy || !origin;
  $("clear-site").disabled = busy || !origin || !stats.siteRecords;
  $("clear-all").disabled = busy || !stats.records;
  $("site-record-count").textContent = origin ? `${stats.siteRecords} 条` : "";
  $("all-record-count").textContent = `${stats.records} 条`;
}

async function update(type, details, success = "") {
  if (busy) return;
  busy = true;
  // Keep the user's new switch position while the worker saves it.
  for (const id of ["site-enabled", "clear-site", "clear-all"]) $(id).disabled = true;
  message("");
  try {
    render(await send(type, details));
    message(success);
  } catch {
    message("操作失败，请重新打开插件后重试", true);
  } finally {
    busy = false;
    render(status);
  }
}

$("site-enabled").addEventListener("change", event => update("SET_SITE_ENABLED", { enabled: event.target.checked }));

function confirmClear(target) {
  clearTarget = target;
  $("confirmation-message").textContent = target === "all"
    ? "清空全部网站的输入历史？此操作无法撤销。"
    : "清空当前网站所有输入框的历史？此操作无法撤销。";
  $("confirmation").hidden = false;
  $("cancel-clear").focus();
}

$("clear-site").addEventListener("click", () => confirmClear("site"));
$("clear-all").addEventListener("click", () => confirmClear("all"));
$("cancel-clear").addEventListener("click", () => { $("confirmation").hidden = true; clearTarget = null; });
$("confirm-clear").addEventListener("click", () => {
  if (!clearTarget) return;
  const target = clearTarget;
  clearTarget = null;
  $("confirmation").hidden = true;
  update("CLEAR", { target }, target === "all" ? "全部输入历史已清空" : "本站输入历史已清空");
});

async function init() {
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (tab?.id) {
      const context = await chrome.tabs.sendMessage(tab.id, { type: "PAGE_CONTEXT" }, { frameId: 0 }).catch(() => null);
      const url = new URL(context?.origin || "about:blank");
      if (["http:", "https:"].includes(url.protocol)) origin = url.origin;
    }
    $("site-name").textContent = origin ? new URL(origin).host : "此页面不支持输入历史";
    $("site-name").title = origin || "Chrome 内置页面和扩展商店无法注入插件";
    render(await send("STATUS"));
  } catch {
    message("暂时无法读取插件状态，请关闭后重试", true);
    $("site-name").textContent = "无法读取当前网站";
  }
}

init();
