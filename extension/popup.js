import { readNativeHistory, setNativeHistory, releaseNativeHistory } from "./native-history.js";

const $ = id => document.getElementById(id);
let origin = null;
let status = null;
let clearTarget = null;
let busy = false;
let nativeBusy = false;
let nativeListenerAttached = false;
let nativeReadId = 0;

function renderNative(state) {
  $("native-enabled").checked = state.enabled === true;
  $("native-enabled").indeterminate = state.enabled === null;
  $("native-enabled").disabled = nativeBusy || !state.canChange;
  $("native-grant").hidden = state.granted;
  $("native-grant").disabled = nativeBusy;
  $("native-release").hidden = state.level !== "controlled_by_this_extension";
  $("native-release").disabled = nativeBusy;
  $("native-status").textContent = !state.granted ? "授权后读取 Chrome 当前状态" : !state.canChange
    ? (state.level === "controlled_by_other_extensions" ? "此设置由其他扩展控制" : "此设置由浏览器策略锁定")
    : "";
  $("native-actions").hidden = state.granted && state.canChange && state.level !== "controlled_by_this_extension";
}

async function refreshNative() {
  const id = ++nativeReadId;
  try {
    const state = await readNativeHistory();
    if (id !== nativeReadId) return;
    renderNative(state);
    if (state.granted && !nativeListenerAttached) {
      chrome.privacy.services.autofillAddressEnabled.onChange.addListener(() => refreshNative());
      nativeListenerAttached = true;
    }
  } catch {
    if (id !== nativeReadId) return;
    $("native-enabled").disabled = true;
    $("native-actions").hidden = false;
    $("native-status").textContent = "无法读取 Chrome 设置，请重新打开插件";
  }
}

async function changeNative(action) {
  if (nativeBusy) return;
  nativeBusy = true;
  for (const id of ["native-enabled", "native-grant", "native-release"]) $(id).disabled = true;
  message("");
  try {
    await action();
  } catch (error) {
    message(error.message === "NATIVE_LOCKED" ? "此设置受策略或其他扩展控制，无法修改" : "无法修改 Chrome 设置，请重试", true);
  } finally {
    nativeBusy = false;
    await refreshNative();
  }
}

$("native-grant").addEventListener("click", async () => {
  // Must run directly inside the click gesture; granting does not change Chrome's setting.
  try {
    const granted = await chrome.permissions.request({ permissions: ["privacy"] });
    if (!granted) message("未授予权限，Chrome 原设置保持不变");
    await refreshNative();
  } catch {
    message("无法申请权限，请重新打开插件后重试", true);
  }
});
$("native-enabled").addEventListener("change", event => {
  const enabled = event.target.checked;
  changeNative(() => setNativeHistory(enabled));
});
$("native-release").addEventListener("click", () => changeNative(() => releaseNativeHistory()));
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
  $("enabled").checked = settings.enabled;
  $("enabled").disabled = busy;
  $("site-enabled").checked = Boolean(origin && !settings.disabledOrigins.includes(origin));
  $("site-enabled").disabled = busy || !origin || !settings.enabled;
  $("clear-site").disabled = busy || !origin || !stats.siteRecords;
  $("clear-all").disabled = busy || !stats.records;
  $("site-record-count").textContent = origin ? `${stats.siteRecords} 条` : "";
}

async function update(type, details, success = "") {
  if (busy) return;
  busy = true;
  // Keep the user's new switch position while the worker saves it.
  for (const id of ["enabled", "site-enabled", "clear-site", "clear-all"]) $(id).disabled = true;
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

$("enabled").addEventListener("change", event => update("SET_ENABLED", { enabled: event.target.checked }));
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
