(() => {
  "use strict";
  const dialogSelector = 'dialog, [role="dialog"], [role="alertdialog"], [aria-modal="true"], .ant-modal, .el-dialog, .modal-content';
  const paneSelector = '[role="tabpanel"], .ant-tabs-tabpane, .el-tab-pane, .tab-pane';
  const tabSelector = '[role="tab"], .ant-tabs-tab, .el-tabs__item, .nav-tabs .nav-link, .nav-tabs > li > a, .nav-pills .nav-link';
  const activeTabSelector = '[role="tab"][aria-selected="true"], .ant-tabs-tab-active, .el-tabs__item.is-active, .nav-tabs .nav-link.active, .nav-tabs > li.active > a, .nav-pills .nav-link.active';
  const tabGroupSelector = '.ant-tabs, .el-tabs, .tabs, [data-tabs]';
  const breadcrumbSelector = 'nav[aria-label*="breadcrumb" i], [role="navigation"][aria-label*="breadcrumb" i], nav[aria-label*="面包屑"], [role="navigation"][aria-label*="面包屑"], .ant-breadcrumb, .el-breadcrumb, .breadcrumb, [itemtype$="/BreadcrumbList"]';
  const decorationSelector = 'script, style, svg, input, textarea, select, [contenteditable], [hidden], [aria-hidden="true"], [role="separator"], .ant-badge-count, .ant-badge-dot, .el-badge__content, .badge, .ant-tabs-tab-remove, .ant-breadcrumb-separator, .el-breadcrumb__separator, .ant-modal-close, .el-dialog__headerbtn, .close';
  const dialogPages = new WeakMap();
  let activation = null;
  let dialogObserver = null;
  let captureTimer = 0;

  function parentOf(element) {
    return element.parentElement || element.getRootNode().host || null;
  }

  function closest(element, selector) {
    for (let node = element; node; node = parentOf(node)) {
      if (node.matches(selector)) return node;
    }
    return null;
  }

  function rootsFor(element) {
    const roots = [];
    for (let root = element.getRootNode(); root; root = root.host?.getRootNode()) roots.push(root);
    return roots;
  }

  function visible(element) {
    if (!element?.isConnected || closest(element, '[hidden], [aria-hidden="true"], [inert]')) return false;
    const style = getComputedStyle(element);
    return style.visibility !== "hidden" && style.visibility !== "collapse" && element.getClientRects().length > 0;
  }

  function cleanText(text) {
    return text.replace(/\s+/g, " ").trim().replace(/^[*＊\s]+|[:：*＊\s]+$/g, "").slice(0, 160);
  }

  function textOf(element) {
    if (!element || element.matches(decorationSelector)) return "";
    // Read just the label subtree, without creating or modifying DOM nodes.
    const walker = document.createTreeWalker(element, NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT, {
      acceptNode(node) {
        if (node.nodeType === Node.TEXT_NODE) return NodeFilter.FILTER_ACCEPT;
        return node.matches(decorationSelector) ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_SKIP;
      }
    });
    let text = "";
    for (let node = walker.nextNode(); node; node = walker.nextNode()) text += node.nodeValue;
    return cleanText(text);
  }

  function labelledText(element) {
    const root = element.getRootNode();
    return (element.getAttribute("aria-labelledby") || "").split(/\s+/)
      .map(id => id ? textOf(root.getElementById?.(id)) : "").filter(Boolean).join(" ").slice(0, 160);
  }

  function tabName(tab) {
    return cleanText(tab.getAttribute("aria-label") || "") || textOf(tab);
  }

  function paneName(pane) {
    const labelled = labelledText(pane);
    if (labelled) return labelled;
    const root = pane.getRootNode();
    if (pane.id) {
      for (const tab of root.querySelectorAll(tabSelector)) {
        const controls = (tab.getAttribute("aria-controls") || "").split(/\s+/);
        if (visible(tab) && (controls.includes(pane.id) || tab.getAttribute("href") === `#${pane.id}`)) return tabName(tab);
      }
    }
    const group = pane.closest(tabGroupSelector);
    if (!group) return "";
    const tab = [...group.querySelectorAll(activeTabSelector)]
      .find(tab => tab.closest(tabGroupSelector) === group && visible(tab));
    return tab ? tabName(tab) : "";
  }

  function ancestorTabs(element, boundary = null) {
    const names = [];
    for (let node = element; node && node !== boundary && names.length < 8; node = parentOf(node)) {
      if (node.matches(paneSelector) && visible(node)) {
        const name = paneName(node);
        if (name) names.unshift(name);
      }
    }
    return names;
  }

  function activePageTabs(element) {
    const chains = new Map();
    for (const root of rootsFor(element)) {
      for (const tab of root.querySelectorAll(activeTabSelector)) {
        if (!visible(tab) || closest(tab, dialogSelector)) continue;
        const name = tabName(tab);
        if (!name) continue;
        const chain = [...ancestorTabs(tab), name];
        chains.set(JSON.stringify(chain), chain);
      }
    }
    // Nested tab groups form one chain. Independent groups have no unique
    // "current" tab; only a containing pane or dialog opener can resolve them.
    const leaves = [...chains.values()].filter(chain => ![...chains.values()].some(other =>
      other.length > chain.length && chain.every((name, index) => other[index] === name)));
    return leaves.length === 1 ? leaves[0] : [];
  }

  function breadcrumbName(breadcrumb) {
    const current = [...breadcrumb.querySelectorAll('[aria-current="page"], [aria-current="location"], [aria-current="true"]')]
      .filter(visible).at(-1);
    if (current) return textOf(current);
    const items = [...breadcrumb.querySelectorAll('.ant-breadcrumb-link, .el-breadcrumb__inner, .breadcrumb-item, [itemprop="name"], li')]
      .filter(item => visible(item) && textOf(item));
    if (items.length) return textOf(items.at(-1));
    let leaf = breadcrumb;
    while (true) {
      const child = [...leaf.children].filter(item => !item.matches(decorationSelector) && visible(item) && textOf(item)).at(-1);
      if (!child) return textOf(leaf);
      leaf = child;
    }
  }

  function breadcrumbFor(element) {
    const candidates = rootsFor(element).flatMap(root => [...root.querySelectorAll(breadcrumbSelector)])
      .filter(item => visible(item) && !closest(item, dialogSelector));
    for (let node = element; node; node = parentOf(node)) {
      const names = [...new Set(candidates.filter(item => node.contains(item)).map(breadcrumbName).filter(Boolean))];
      if (names.length) return names.length === 1 ? names[0] : "";
    }
    return "";
  }

  function pageFor(element) {
    const containingTabs = ancestorTabs(element);
    const tabs = containingTabs.length ? containingTabs : activePageTabs(element);
    const breadcrumb = breadcrumbFor(element);
    return { ...(tabs.length ? { tabs } : {}), ...(breadcrumb ? { breadcrumb } : {}) };
  }

  function dialogTitle(dialog) {
    const labelled = labelledText(dialog);
    if (labelled) return labelled;
    const ariaLabel = cleanText(dialog.getAttribute("aria-label") || "");
    if (ariaLabel) return ariaLabel;
    const title = [...dialog.querySelectorAll('.ant-modal-title, .el-dialog__title, .modal-title, [data-dialog-title], h1, h2, h3')]
      .find(title => closest(title, dialogSelector) === dialog && visible(title));
    return textOf(title);
  }

  function route() {
    return `${location.pathname}${location.hash.split("?")[0]}`;
  }

  function openedBy(dialog, source) {
    return source && source.route === route() && source.dialog !== dialog
      && !source.visibleDialogs.has(dialog) && !dialog.contains(source.target);
  }

  function rememberDialog(dialog, source) {
    dialogPages.set(dialog, { page: source.page, route: source.route });
    source.visibleDialogs.add(dialog);
    return source.page;
  }

  function pageForDialog(dialog) {
    const cached = dialogPages.get(dialog);
    if (openedBy(dialog, activation) && performance.now() - activation.time < 5000) {
      return rememberDialog(dialog, activation);
    }
    if (cached?.route === route()) return cached.page;
    const page = pageFor(dialog);
    dialogPages.set(dialog, { page, route: route() });
    return page;
  }

  function pageWithinDialog(element, dialog) {
    const page = pageForDialog(dialog);
    const tabs = [...(page.tabs || []), ...ancestorTabs(element, dialog)];
    return { ...page, ...(tabs.length ? { tabs } : {}) };
  }

  function forField(element) {
    const dialog = closest(element, dialogSelector);
    if (!dialog) return pageFor(element);
    const page = pageWithinDialog(element, dialog);
    const title = dialogTitle(dialog);
    return { ...page, ...(title ? { dialog: title } : {}) };
  }

  function stopDialogCapture() {
    dialogObserver?.disconnect();
    dialogObserver = null;
    clearTimeout(captureTimer);
    captureTimer = 0;
  }

  function captureOpenedDialogs(source) {
    stopDialogCapture();
    // Bind the source when the dialog appears, even when it does not autofocus.
    // Observe only briefly after an action; inspect changed subtrees, not the page.
    dialogObserver = new MutationObserver(records => {
      if (source !== activation || source.route !== route()) { stopDialogCapture(); return; }
      const candidates = new Set();
      const add = node => {
        if (!(node instanceof Element) || closest(node, '[data-retrospection-root]')) return;
        const dialog = closest(node, dialogSelector);
        if (dialog) candidates.add(dialog);
        node.querySelectorAll(dialogSelector).forEach(item => candidates.add(item));
      };
      for (const record of records) {
        if (record.type === "attributes") add(record.target);
        else record.addedNodes.forEach(add);
      }
      for (const dialog of candidates) {
        if (openedBy(dialog, source) && visible(dialog)) rememberDialog(dialog, source);
      }
    });
    for (const root of rootsFor(source.target)) {
      dialogObserver.observe(root, { subtree: true, childList: true, attributes: true,
        attributeFilter: ["hidden", "style", "class", "open", "aria-hidden"] });
    }
    captureTimer = setTimeout(stopDialogCapture, 5000);
  }

  function rememberActivation(event) {
    const target = event.composedPath().find(node => node instanceof Element);
    if (!target || closest(target, '[data-retrospection-root], input, textarea, [contenteditable]')) return;
    if (event.type === "click" && activation?.target === target && performance.now() - activation.time < 1000) return;
    const dialog = closest(target, dialogSelector);
    const page = dialog ? pageWithinDialog(target, dialog) : pageFor(target);
    const visibleDialogs = new WeakSet(rootsFor(target).flatMap(root => [...root.querySelectorAll(dialogSelector)]).filter(visible));
    activation = { target, page, dialog, visibleDialogs, route: route(), time: performance.now() };
    captureOpenedDialogs(activation);
  }

  document.addEventListener("pointerdown", rememberActivation, true);
  document.addEventListener("click", rememberActivation, true);
  document.addEventListener("keydown", event => {
    if (!event.repeat && (event.key === "Enter" || event.key === " ")) rememberActivation(event);
  }, true);
  for (const event of ["pagehide", "popstate", "hashchange"]) window.addEventListener(event, () => {
    stopDialogCapture();
    activation = null;
  });
  globalThis.RetrospectionContext = Object.freeze({ forField });
})();
