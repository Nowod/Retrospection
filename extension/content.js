(async () => {
  "use strict";
  if (globalThis.__retrospectionLoaded) return;
  globalThis.__retrospectionLoaded = true;
  const Fields = globalThis.RetrospectionFields;
  const MAX_VISIBLE_RECORDS = 20;
  await Fields.ready;
  let active = null;
  let ui = null;
  let frame = 0;
  let applying = false;

  const css = `
    :host { all: initial; color-scheme: light; }
    *, *::before, *::after { box-sizing: border-box; }
    .panel { background: #fff; border: 1px solid #dce2de; border-radius: 6px;
      box-shadow: 0 4px 14px #00000014; overflow: hidden;
      color: #29332e; font: 13px/1.5 -apple-system, BlinkMacSystemFont, "Segoe UI", "Microsoft YaHei", sans-serif;
      text-align: left; direction: ltr; -webkit-font-smoothing: antialiased; }
    .arrow { position: absolute; width: 10px; height: 10px; top: -5px; left: 20px;
      margin-left: -5px; background: #fff; border-top: 1px solid #dce2de;
      border-left: 1px solid #dce2de; transform: rotate(45deg); pointer-events: none; }
    .arrow.above { top: auto; bottom: -5px; transform: rotate(225deg); }
    svg { width: 15px; height: 15px; flex-shrink: 0; }
    .list { padding: 3px; overflow-y: auto; overscroll-behavior: contain;
      scrollbar-width: thin; scrollbar-color: #cdd4cf transparent; }
    .list:empty { display: none; }
    .row { display: flex; align-items: center; border-radius: 3px; min-height: 34px; }
    .row.selected { background: #edf3ee; }
    button { font: inherit; cursor: pointer; border: 0; background: transparent; color: inherit; margin: 0; }
    .fill { display: flex; align-items: center; gap: 10px; flex: 1; min-width: 0;
      padding: 7px 6px 7px 9px; text-align: left; }
    .value { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .count { flex-shrink: 0; font-size: 12px; font-variant-numeric: tabular-nums; color: #6e7872; }
    .delete { display: flex; flex: 0 0 24px; align-items: center; justify-content: center;
      width: 24px; height: 24px; margin: 0 4px 0 1px; padding: 4px; border-radius: 3px;
      opacity: 0; visibility: hidden; color: #77817a; }
    .selected .delete, .delete:focus-visible { opacity: 1; visibility: visible; }
    .delete:hover { color: #a3432b; background: #faeee8; }
    .delete:disabled { opacity: .35; cursor: wait; }
    button:focus-visible { outline: 2px solid #527b5b; outline-offset: -2px; }
    .notice { color: #a3432b; font-size: 11px; padding: 8px 12px; }
    .notice:empty { display: none; }
    .sr { position: absolute; width: 1px; height: 1px; overflow: hidden; clip-path: inset(50%); }
    @media (forced-colors: active) { .panel { border: 1px solid CanvasText; } .selected { outline: 1px solid Highlight; } }
  `;

  function node(tag, className, text) {
    const element = document.createElement(tag);
    if (className) element.className = className;
    if (text !== undefined) element.textContent = text;
    return element;
  }

  function icon(name) {
    const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    svg.setAttribute("viewBox", "0 0 24 24");
    svg.setAttribute("fill", "none");
    svg.setAttribute("stroke", "currentColor");
    svg.setAttribute("stroke-width", "1.6");
    svg.setAttribute("stroke-linecap", "round");
    svg.setAttribute("stroke-linejoin", "round");
    svg.setAttribute("aria-hidden", "true");
    const path = document.createElementNS(svg.namespaceURI, "path");
    path.setAttribute("d", name === "delete"
      ? "M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13M10 11v5m4-5v5"
      : "M3 11a9 9 0 1 1 2.6 7M3 5v6h6m3-4v5l3 2");
    svg.append(path);
    return svg;
  }

  function createUI() {
    if (ui) return ui;
    const host = node("div");
    host.id = `retrospection-history-${[...crypto.getRandomValues(new Uint32Array(4))].join("-")}`;
    host.setAttribute("data-retrospection-root", "");
    host.setAttribute("popover", "manual");
    host.style.cssText = "all:initial;position:fixed;inset:auto;margin:0;padding:0;border:0;background:transparent;z-index:2147483647;display:none;color-scheme:light;";
    const shadow = host.attachShadow({ mode: "open" });
    const style = node("style", "", css);
    const panel = node("section", "panel");
    const arrow = node("span", "arrow");
    arrow.setAttribute("aria-hidden", "true");
    panel.setAttribute("aria-label", "输入历史");
    const list = node("div", "list");
    list.setAttribute("role", "listbox");
    list.setAttribute("aria-label", "此输入框的历史记录");
    const notice = node("div", "notice");
    notice.setAttribute("role", "alert");
    const status = node("div", "sr");
    status.setAttribute("role", "status");
    status.setAttribute("aria-live", "polite");
    panel.append(list, notice, status);
    shadow.append(style, panel, arrow);
    document.documentElement.append(host);
    // Preserve the field's focus for both selecting and deleting a record.
    host.addEventListener("pointerdown", event => event.preventDefault());
    host.addEventListener("click", event => event.stopPropagation());
    list.addEventListener("pointerleave", () => {
      if (active?.selectionMode === "pointer") select(-1);
    });
    ui = { host, panel, arrow, list, notice, status, visible: false, items: [] };
    return ui;
  }

  async function request(session, type, details = {}) {
    const requestId = ++session.requestId;
    const message = { type, scope: session.scope, ...details };
    if (session.legacyScope && session.legacyScope !== session.scope) message.legacyScope = session.legacyScope;
    try {
      const response = await chrome.runtime.sendMessage(message);
      if (!response?.ok) throw new Error(response?.error || "DISCONNECTED");
      // A late read must not overwrite a later deletion, save, or focus change.
      if (active === session && requestId === session.requestId) applyHistory(session, response);
      return response;
    } catch (error) {
      if (active === session && requestId === session.requestId) {
        session.disabled ??= false;
        session.error = type === "RECORD" ? "保存失败，请检查插件状态或本地存储空间"
          : type === "DELETE" ? "删除失败，请重试"
          : error.message.includes("context invalidated") ? "插件已更新，请刷新网页后使用"
          : "暂时无法读取本地历史，请重新聚焦输入框";
        render(session);
      }
      throw error;
    }
  }

  function applyHistory(session, response) {
    const wasDisabled = session.disabled === true;
    session.disabled = !response.enabled;
    session.records = response.records;
    session.error = "";
    if (session.disabled || wasDisabled) discardDraft(session);
    if (session.disabled) {
      hide();
      restoreAttributes(session);
    } else {
      render(session);
    }
  }

  function rememberAttributes(element) {
    return Object.fromEntries(["aria-controls", "aria-expanded"].map(name => [name, element.getAttribute(name)]));
  }

  function restoreAttributes(session) {
    for (const [name, value] of Object.entries(session.attributes)) {
      if (value === null) session.element.removeAttribute(name);
      else session.element.setAttribute(name, value);
    }
  }

  function hide(dismiss = false) {
    if (dismiss && active) active.dismissed = true;
    if (!ui) return;
    ui.visible = false;
    try { if (ui.host.matches(":popover-open")) ui.host.hidePopover(); } catch { /* fallback for embedded browsers */ }
    ui.host.style.display = "none";
    if (active?.element.getAttribute("aria-controls") === ui.host.id) active.element.setAttribute("aria-expanded", "false");
  }

  function show(session) {
    if (active !== session || session.dismissed || session.disabled !== false) return;
    if (Fields.readValue(session.element) !== "" || session.composing) {
      hide();
      return;
    }
    const view = createUI();
    // A top-layer popover outside a modal dialog is still inert. Keep it in
    // the field's native dialog, including when the input is in a shadow root.
    let container = document.documentElement;
    for (let node = session.element; node; node = node.parentElement || node.getRootNode().host) {
      if (node instanceof HTMLDialogElement && node.open) { container = node; break; }
    }
    if (view.host.parentNode !== container) {
      hide();
      container.append(view.host);
    }
    view.host.style.display = "block";
    if (!view.host.matches(":popover-open")) {
      try { view.host.showPopover(); } catch { /* fixed-position fallback */ }
    }
    view.visible = true;
    session.element.setAttribute("aria-controls", view.host.id);
    session.element.setAttribute("aria-expanded", "true");
    schedulePosition();
  }

  function schedulePosition() {
    if (frame) return;
    frame = requestAnimationFrame(() => {
      frame = 0;
      position();
    });
  }

  function position() {
    if (!active || !ui?.visible) return;
    if (!active.element.isConnected) {
      commit(active);
      endSession();
      return;
    }
    const rect = active.element.getBoundingClientRect();
    const width = document.documentElement.clientWidth;
    const height = window.innerHeight;
    if (!rect.width || !rect.height || rect.bottom < 0 || rect.top > height) {
      ui.host.style.visibility = "hidden";
      return;
    }
    ui.host.style.visibility = "visible";
    const maxWidth = Math.min(280, width - 20);
    const below = height - rect.bottom - 18;
    const above = rect.top - 18;
    const placeAbove = below < 180 && above > below;
    const available = Math.max(80, placeAbove ? above : below);
    ui.host.style.width = "max-content";
    ui.host.style.minWidth = `${Math.min(160, maxWidth)}px`;
    ui.host.style.maxWidth = `${maxWidth}px`;
    ui.list.style.maxHeight = `${Math.min(268, Math.max(44, available - 8))}px`;
    const { width: panelWidth, height: panelHeight } = ui.host.getBoundingClientRect();
    const left = Math.max(10, Math.min(rect.left, width - panelWidth - 10));
    ui.host.style.left = `${left}px`;
    ui.arrow.classList.toggle("above", placeAbove);
    ui.host.style.top = `${Math.max(8, placeAbove ? rect.top - panelHeight - 8 : rect.bottom + 8)}px`;
  }

  function render(session) {
    if (active !== session || session.dismissed || session.disabled !== false) return;
    const view = createUI();
    if (Fields.readValue(session.element) !== "" || session.composing) {
      session.selected = -1;
      view.items = [];
      view.list.replaceChildren();
      session.element.setAttribute("aria-controls", view.host.id);
      hide();
      return;
    }
    const items = session.records.slice(0, MAX_VISIBLE_RECORDS);
    const selectedValue = view.items[session.selected]?.value;
    const scrollTop = view.list.scrollTop;
    view.items = items;
    view.notice.textContent = session.error || "";
    view.list.replaceChildren();
    session.selected = selectedValue ? items.findIndex(item => item.value === selectedValue) : -1;
    if (!items.length && !session.error) {
      view.status.textContent = "暂无匹配的输入历史";
      session.element.setAttribute("aria-controls", view.host.id);
      hide();
      return;
    }
    items.forEach((record, index) => {
      const row = node("div", "row");
      row.setAttribute("role", "option");
      row.setAttribute("aria-selected", String(index === session.selected));
      row.classList.toggle("selected", index === session.selected);
      const fill = node("button", "fill");
      fill.type = "button";
      fill.tabIndex = -1;
      fill.title = record.value;
      fill.setAttribute("aria-label", `填入：${record.value}，最近七天 ${record.count} 次`);
      const count = node("span", "count", record.count.toLocaleString("zh-CN"));
      count.title = `最近七天 ${record.count} 次`;
      fill.append(node("span", "value", record.value), count);
      const remove = node("button", "delete");
      remove.type = "button";
      remove.tabIndex = -1;
      remove.title = "删除这条历史";
      remove.setAttribute("aria-label", `删除：${record.value}`);
      remove.append(icon("delete"));
      remove.disabled = session.deleting.has(record.value);
      remove.addEventListener("click", event => {
        event.stopPropagation();
        removeRecord(session, record);
      });
      row.append(fill, remove);
      row.addEventListener("click", () => choose(record));
      row.addEventListener("pointerenter", () => {
        session.selectionMode = "pointer";
        select(index);
      });
      view.list.append(row);
    });
    view.list.scrollTop = scrollTop;
    view.status.textContent = items.length ? `有 ${items.length} 条历史，按上下方向键选择，Enter 填入，Delete 删除，Escape 收起` : "暂无匹配的输入历史";
    show(session);
  }

  function select(index, scroll = false) {
    if (!active || !ui) return;
    active.selected = index;
    [...ui.list.children].forEach((row, rowIndex) => {
      row.classList.toggle("selected", rowIndex === index);
      if (row.getAttribute("role") === "option") row.setAttribute("aria-selected", String(rowIndex === index));
    });
    if (index >= 0 && ui.items[index]) {
      const record = ui.items[index];
      ui.status.textContent = `${record.value}，最近七天 ${record.count} 次`;
      if (scroll) ui.list.children[index]?.scrollIntoView({ block: "nearest" });
    }
  }

  function load(session) {
    // request renders a recoverable error for the active field.
    return request(session, "GET_HISTORY").catch(() => {});
  }

  function focusedElement() {
    let element = document.activeElement;
    while (element?.shadowRoot?.activeElement) element = element.shadowRoot.activeElement;
    return element;
  }

  function startSession(element, refresh = false) {
    if (active?.element === element && !refresh) return false;
    const identity = Fields.identityFor(element);
    if (active?.element === element && active.scope === identity.scope) return false;
    if (active) {
      commit(active);
      endSession();
    }
    active = {
      element, ...identity, value: Fields.readValue(element),
      attributes: rememberAttributes(element), dirty: false, composing: false,
      dismissed: false, disabled: null, selected: -1, records: [],
      deleting: new Set(), error: "", requestId: 0, revision: 0
    };
    resizeObserver.observe(element);
    load(active);
    return true;
  }

  function endSession() {
    if (!active) return;
    hide();
    resizeObserver.unobserve(active.element);
    restoreAttributes(active);
    active = null;
  }

  function discardDraft(session) {
    session.dirty = false;
    // A failed request from before clear/pause/reset cannot revive this draft.
    session.revision++;
  }

  async function commit(session) {
    if (session?.pendingReset) { session.pendingReset.commitRequested = true; return; }
    if (!session?.dirty || session.composing || session.disabled) return;
    const value = session.value;
    session.dirty = false; // Synchronous: Enter, submit, and blur share one commit.
    if (!value.trim() || value.length > 4000 || !Fields.isEligible(session.element)) return;
    const revision = session.revision;
    try {
      await request(session, "RECORD", { value });
    } catch {
      if (session.revision === revision) session.dirty = true;
    }
  }

  function choose(record) {
    const session = active;
    if (!session || session.disabled !== false || !Fields.isEligible(session.element)) return;
    if (Fields.readValue(session.element) !== "") { render(session); return; }
    session.dirty = false;
    session.revision++;
    session.element.focus({ preventScroll: true });
    applying = true;
    try {
      Fields.writeValue(session.element, record.value);
    } finally {
      applying = false;
    }
    session.value = Fields.readValue(session.element);
    session.dirty = true;
    hide(true);
    commit(session);
  }

  async function removeRecord(session, record) {
    if (session.deleting.has(record.value)) return;
    const revision = session.revision;
    session.deleting.add(record.value);
    render(session);
    try {
      await request(session, "DELETE", { value: record.value });
      // Deleting the current draft must not resurrect it on the following blur.
      if (session.revision === revision && session.value === record.value) discardDraft(session);
    } catch {
      // request keeps the record visible and shows the retry message.
    } finally {
      session.deleting.delete(record.value);
      render(session);
    }
  }

  const resizeObserver = new ResizeObserver(schedulePosition);

  document.addEventListener("focusin", event => {
    const field = Fields.findField(event);
    if (field) startSession(field);
  }, true);

  document.addEventListener("focusout", event => {
    if (!active || !event.composedPath().includes(active.element)) return;
    const session = active;
    // compositionend can follow focusout in some IMEs.
    queueMicrotask(() => {
      if (active !== session) return;
      session.composing = false;
      commit(session);
      endSession();
    });
  }, true);

  document.addEventListener("input", event => {
    if (applying) return;
    if (!event.isTrusted) {
      if (active && event.composedPath().includes(active.element)) render(active);
      return;
    }
    const field = Fields.findField(event);
    if (!field) return;
    startSession(field);
    active.value = Fields.readValue(field);
    active.revision++;
    active.dirty = active.disabled !== true;
    active.selected = -1;
    active.dismissed = false;
    active.error = active.value.length > 4000 ? "超过 4,000 字的内容不会记录" : "";
    render(active);
  }, true);

  document.addEventListener("compositionstart", event => {
    if (active && event.composedPath().includes(active.element)) {
      active.composing = true;
      render(active);
    }
  }, true);

  document.addEventListener("compositionend", event => {
    if (!active || !event.composedPath().includes(active.element)) return;
    active.composing = false;
    active.value = Fields.readValue(active.element);
    render(active);
  }, true);

  document.addEventListener("keydown", event => {
    const session = active;
    if (!session || !event.composedPath().includes(session.element) || event.isComposing || session.composing || event.keyCode === 229) return;
    const empty = Fields.readValue(session.element) === "";
    const plainKey = !event.altKey && !event.ctrlKey && !event.metaKey && !event.shiftKey;
    if (!empty) render(session);
    const visible = ui?.visible && !session.dismissed;
    if ((event.key === "ArrowDown" || event.key === "ArrowUp") && plainKey) {
      if (session.disabled !== false || !empty) return;
      if (!visible) {
        session.dismissed = false;
        render(session);
      }
      if (!ui?.visible || !ui.items.length || session.disabled) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      session.selectionMode = "keyboard";
      const direction = event.key === "ArrowDown" ? 1 : -1;
      const next = session.selected < 0 ? (direction > 0 ? 0 : ui.items.length - 1)
        : (session.selected + direction + ui.items.length) % ui.items.length;
      select(next, true);
    } else if (event.key === "Enter") {
      if (plainKey && visible && session.selected >= 0 && ui.items[session.selected]) {
        event.preventDefault();
        event.stopImmediatePropagation();
        choose(ui.items[session.selected]);
      } else if ((plainKey && session.element instanceof HTMLInputElement)
        || ((event.ctrlKey || event.metaKey) && !event.altKey && !event.shiftKey)) {
        commit(session);
        hide(true);
      }
    } else if (event.key === "Escape" && plainKey && visible) {
      event.preventDefault();
      event.stopImmediatePropagation();
      hide(true);
    } else if (event.key === "Delete" && plainKey && visible && session.selected >= 0 && session.selectionMode === "keyboard") {
      event.preventDefault();
      event.stopImmediatePropagation();
      removeRecord(session, ui.items[session.selected]);
    }
  }, true);

  document.addEventListener("pointerdown", event => {
    if (event.composedPath().includes(ui?.host)) return;
    const field = Fields.findField(event);
    if (field) {
      // Wait for actual focus before leaving the previous field: its IME may
      // finish after pointerdown, and the page may cancel the focus change.
      if (field !== focusedElement()) { hide(); return; }
      // Browsers can restore an iframe's activeElement without another focusin.
      // Pointer activation must be sufficient to reopen that field's history.
      const started = startSession(field, true);
      active.dismissed = false;
      if (!started) load(active);
      render(active);
    } else {
      hide();
    }
  }, true);

  document.addEventListener("submit", event => {
    if (active?.element.form === event.target) commit(active);
  }, true);
  document.addEventListener("reset", event => {
    const session = active;
    if (!session || session.element.form !== event.target) return;
    const pending = { revision: session.revision, commitRequested: false };
    session.pendingReset = pending;
    // Trusted reset buttons apply their default action after microtasks. Defer
    // until it has completed, while holding any simultaneous blur/submit save.
    setTimeout(() => {
      if (session.pendingReset !== pending) return;
      session.pendingReset = null;
      if (!event.defaultPrevented && session.revision === pending.revision) {
        discardDraft(session);
        session.value = Fields.readValue(session.element);
        session.dismissed = false;
        session.selected = -1;
        session.error = "";
        render(session);
      }
      if (pending.commitRequested || active !== session) commit(session);
    }, 0);
  }, true);
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "hidden") commit(active);
    else if (active) load(active);
  });
  window.addEventListener("pagehide", () => commit(active));
  window.addEventListener("pageshow", event => {
    if (event.persisted && active) load(active);
  });
  for (const event of ["popstate", "hashchange"]) {
    window.addEventListener(event, () => {
      commit(active);
      endSession();
    });
  }
  window.addEventListener("scroll", schedulePosition, true);
  window.addEventListener("resize", schedulePosition);
  window.visualViewport?.addEventListener("resize", schedulePosition);
  window.visualViewport?.addEventListener("scroll", schedulePosition);

  chrome.runtime.onMessage.addListener((message, sender, respond) => {
    if (sender.id !== chrome.runtime.id) return;
    if (message?.type === "PAGE_CONTEXT") {
      respond({ origin: location.origin });
      return;
    }
    if (message?.type === "RETROSPECTION_CHANGED" && active) {
      if (message.action === "CLEAR" && (message.target === "all" || message.origin === location.origin)) discardDraft(active);
      load(active);
    }
  });

  // document_idle may run after the page autofocuses its input.
  const focused = focusedElement();
  if (Fields.isEligible(focused)) startSession(focused);
})().catch(() => console.warn("[Retrospection] 插件初始化失败，请刷新页面后重试。"));
