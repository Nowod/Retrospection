(() => {
  "use strict";
  const inputTypes = new Set(["text", "search", "email", "url", "tel", "number"]);
  const sensitive = /(?:password|passwd|passphrase|secret|token|api[\s_-]*key|credit[\s_-]*card|card[\s_-]*(?:number|no)|cvv|cvc|security[\s_-]*code|(?:^|[\s_-])(?:otp|pin|ssn)(?:$|[\s_-])|one[\s_-]*time|verification|captcha|密码|口令|验证码|校验码|密钥|银行卡|信用卡|身份证)/i;
  const sensitiveAutocomplete = /(?:password|one-time-code|cc-|webauthn)/i;
  const dialogSelector = 'dialog, [role="dialog"], [role="alertdialog"], [aria-modal="true"], .el-dialog, .ant-modal, .modal-content';
  const fieldSelector = "input, textarea, [contenteditable]";
  const excludedSelector = '[data-retrospection-root], [data-retrospection="off"], [inert]';

  function labelFor(element) {
    const root = element.getRootNode();
    const labelled = (element.getAttribute("aria-labelledby") || "").split(/\s+/)
      .map(id => id ? root.getElementById?.(id)?.textContent || "" : "").join(" ");
    const item = element.closest(".el-form-item, .ant-form-item, .form-group");
    const label = element.labels?.[0]?.textContent || element.getAttribute("aria-label") || labelled.trim()
      || item?.querySelector("label, .el-form-item__label, .ant-form-item-label")?.textContent || "";
    return cleanText(label);
  }

  function cleanText(text) {
    return text.replace(/\s+/g, " ").trim().replace(/^[*＊\s]+|[:：*＊\s]+$/g, "").slice(0, 160);
  }

  function isEligible(element) {
    if (!(element instanceof Element)) return false;
    const tag = element.tagName.toLowerCase();
    if (tag === "input") {
      if (!inputTypes.has(element.type)) return false;
    } else if (tag !== "textarea" && !element.isContentEditable) {
      return false;
    }
    if (element.matches(":disabled") || element.readOnly || closestAcrossRoots(element, excludedSelector)) return false;
    if (sensitiveAutocomplete.test(element.getAttribute("autocomplete") || "")) return false;
    const hints = [element.id, element.getAttribute("name"), element.getAttribute("placeholder"), labelFor(element)];
    return !sensitive.test(hints.filter(Boolean).join(" "));
  }

  function findField(event) {
    for (const node of event.composedPath()) {
      if (!(node instanceof Element)) continue;
      if (node.matches("input, textarea")) return isEligible(node) ? node : null;
      if (node.isContentEditable) {
        let root = node;
        while (root.parentElement?.isContentEditable) root = root.parentElement;
        return isEligible(root) ? root : null;
      }
    }
    return null;
  }

  function stableId(element) {
    const id = element.id;
    if (!id || /^(:r|radix-|headlessui-|react-select-)/i.test(id)) return null;
    const root = element.getRootNode();
    return root.querySelectorAll(`[id="${CSS.escape(id)}"]`).length === 1 ? id : null;
  }

  function pathFor(element, stableOnly = false) {
    const parts = [];
    let node = element;
    while (node?.nodeType === 1) {
      const id = stableOnly && !stableToken(node.id) ? null : stableId(node);
      if (id) {
        parts.unshift(`${node.localName}#${id}`);
        const root = node.getRootNode();
        if (root.nodeType === 11 && root.host) {
          parts.unshift("::shadow");
          node = root.host;
          continue;
        }
        break;
      }
      const siblings = node.parentElement?.children || node.getRootNode().children || [];
      const peers = [...siblings].filter(other => other.localName === node.localName);
      parts.unshift(`${node.localName}:${peers.indexOf(node) + 1}`);
      if (node.parentElement) node = node.parentElement;
      else if (node.getRootNode().nodeType === 11 && node.getRootNode().host) {
        parts.unshift("::shadow");
        node = node.getRootNode().host;
      } else break;
    }
    return parts.join(">");
  }

  // Keep the v1 identity byte-for-byte compatible for existing history imports.
  function legacyFieldIdentity(element) {
    const kind = `${element.localName}:${element.type || "editable"}`;
    const root = element.getRootNode();
    // Include the shadow host, since ids are only unique within each shadow tree.
    const shadow = root instanceof ShadowRoot ? pathFor(root.host) : "";
    const explicit = element.getAttribute("data-retrospection-key");
    if (explicit) return [kind, "key", explicit, shadow];
    const id = stableId(element);
    if (id) return [kind, "id", id, shadow];
    const name = element.getAttribute("name");
    if (name) {
      const container = element.form || root;
      const peers = [...container.querySelectorAll(fieldSelector)]
        .filter(other => other.localName === element.localName && other.getAttribute("name") === name);
      return [kind, "name", name, peers.indexOf(element), shadow];
    }
    return [kind, "path", pathFor(element)];
  }

  function frameIdentity() {
    const parts = [];
    let current = window;
    try {
      while (current !== current.top) {
        if (!current.frameElement) {
          parts.unshift(`cross-origin:${current.name || location.pathname}`);
          break;
        }
        parts.unshift(pathFor(current.frameElement));
        current = current.parent;
      }
    } catch {
      parts.unshift(`cross-origin:${window.name || location.pathname}`);
    }
    return parts;
  }

  // Parent frames identify the embedding element. This keeps two anonymous,
  // cross-origin iframes with the same src separate without relying on the
  // transient Chrome frameId (which changes when the page is reloaded).
  let frameScope = frameIdentity();
  const frameChannel = "retrospection:frame-scope:v1";
  function embeddingElement(source, root = document) {
    for (const element of root.querySelectorAll("iframe, frame")) {
      if (element.contentWindow === source) return element;
    }
    for (const element of root.querySelectorAll("*")) {
      if (element.shadowRoot) {
        const found = embeddingElement(source, element.shadowRoot);
        if (found) return found;
      }
    }
    return null;
  }

  const frameReady = window === window.top ? Promise.resolve() : new Promise(resolve => {
    const token = [...crypto.getRandomValues(new Uint32Array(4))].join("-");
    let attempts = 0;
    let timer;
    const receive = event => {
      if (event.source !== window.parent || event.data?.channel !== frameChannel || event.data?.token !== token || event.data?.kind !== "response") return;
      if (!Array.isArray(event.data.scope) || event.data.scope.some(part => typeof part !== "string") || event.data.scope.length > 64) return;
      frameScope = event.data.scope;
      finish();
    };
    function finish() {
      clearTimeout(timer);
      window.removeEventListener("message", receive);
      resolve();
    }
    function ask() {
      if (attempts++ >= 15) { finish(); return; }
      window.parent.postMessage({ channel: frameChannel, kind: "request", token }, "*");
      timer = setTimeout(ask, 100);
    }
    window.addEventListener("message", receive);
    ask();
  });

  window.addEventListener("message", async event => {
    if (event.data?.channel !== frameChannel || event.data?.kind !== "request" || typeof event.data.token !== "string" || event.data.token.length > 64 || !event.source || event.source === window) return;
    const embedding = embeddingElement(event.source);
    if (!embedding) return;
    await frameReady;
    const route = /^#!?\//.test(location.hash) ? location.hash.split("?")[0] : "";
    event.source.postMessage({ channel: frameChannel, kind: "response", token: event.data.token,
      scope: [...frameScope, `${location.origin}${location.pathname}${route}`, pathFor(embedding)] }, event.origin === "null" ? "*" : event.origin);
  });

  function legacyScopeFor(element) {
    const hashRoute = /^#!?\//.test(location.hash) ? location.hash.split("?")[0] : "";
    const form = element.form;
    return JSON.stringify({
      v: 1, path: location.pathname, route: hashRoute, frame: frameScope,
      form: form ? pathFor(form) : "", field: legacyFieldIdentity(element)
    });
  }

  function closestAcrossRoots(element, selector) {
    let node = element;
    while (node) {
      const match = node.closest(selector);
      if (match) return match;
      node = node.getRootNode().host;
    }
    return null;
  }

  function stableToken(value) {
    if (!value || /^(?::r|_r_|radix-|headlessui-|react-select-|el-id-|rc[-_:])/i.test(value)) return "";
    if (/(?:^|[-_])(?:generated|random)(?:[-_]|$)|\d{8,}|[a-f\d]{8}-(?:[a-f\d]{4}-){3}[a-f\d]{12}/i.test(value)) return "";
    if (/^(?:input|field)[-_]?\d+$|^[a-f\d]{12,}$/i.test(value)) return "";
    return value;
  }

  function fieldFeatures(element) {
    const kind = `${element.localName}:${element.type || "editable"}`;
    const explicit = element.getAttribute("data-retrospection-key");
    if (explicit) return [kind, "key", explicit];
    const id = stableToken(element.id);
    const name = stableToken(element.getAttribute("name"));
    const label = labelFor(element);
    let placeholder = cleanText(element.getAttribute("placeholder") || "");
    if (/^(?:请输入|请选择|输入内容|please enter|enter|search)[.。…\s]*$/i.test(placeholder)) placeholder = "";
    return id || name || label || placeholder ? [kind, "attributes", id, name, label, placeholder] : null;
  }

  function fieldIndex(element, field) {
    // form.elements also includes controls linked with a form="..." attribute.
    // A dialog outside a shadow root cannot enumerate that root's controls.
    const container = element.closest(dialogSelector) || element.getRootNode();
    // A control named "elements" can shadow the form's normal property.
    const controls = element.form && Object.getOwnPropertyDescriptor(HTMLFormElement.prototype, "elements").get.call(element.form);
    const peers = controls || container.querySelectorAll(fieldSelector);
    const signature = JSON.stringify(field);
    let index = 0;
    for (const peer of peers) {
      if (peer === element) return index;
      if (JSON.stringify(fieldFeatures(peer)) === signature) index++;
    }
    return 0;
  }

  function identityFor(element) {
    const field = fieldFeatures(element);
    const root = element.getRootNode();
    const shadow = root instanceof ShadowRoot ? pathFor(root.host, true) : "";
    // Anonymous fields still need a structural fallback to stay distinguishable.
    const identity = !field ? { v: 4, frame: frameScope, shadow,
      path: location.pathname, route: /^#!?\//.test(location.hash) ? location.hash.split("?")[0] : "",
      field: [`${element.localName}:${element.type || "editable"}`, "path", pathFor(element, true)] }
      : { v: 4, frame: frameScope, shadow, field, index: fieldIndex(element, field) };
    const context = globalThis.RetrospectionContext.forField(element);
    if (Object.keys(context).length) {
      // v4 groups may already mix several pages. Preserve them rather than
      // importing the same ambiguous records into each newly isolated group.
      return { scope: JSON.stringify({ ...identity, v: 5, context }), legacyScope: null };
    }
    return { scope: JSON.stringify(identity), legacyScope: legacyScopeFor(element) };
  }

  function readValue(element) {
    if (!element.isContentEditable) return element.value;
    // After deleting all text, Chrome can leave <br> inside a lone paragraph.
    // Preserve real spaces and multiple blank paragraphs as nonempty input.
    let placeholder = element;
    while (placeholder.childNodes.length === 1) {
      placeholder = placeholder.firstChild;
      if (placeholder.nodeName === "BR") return "";
      if (placeholder.nodeName !== "DIV" && placeholder.nodeName !== "P") break;
    }
    return element.innerText.replace(/\r\n/g, "\n");
  }

  function writeValue(element, value) {
    if (element.isContentEditable) {
      // Plain text with line breaks must remain visually multiline, including
      // editors whose normal whitespace styling collapses text-node newlines.
      element.innerText = value;
    } else {
      const prototype = element instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
      Object.getOwnPropertyDescriptor(prototype, "value").set.call(element, value);
    }
    element.dispatchEvent(new InputEvent("input", { bubbles: true, composed: true, inputType: "insertReplacementText", data: value }));
    element.dispatchEvent(new Event("change", { bubbles: true, composed: true }));
    if (!element.isContentEditable && typeof element.setSelectionRange === "function") {
      try { element.setSelectionRange(value.length, value.length); } catch { /* number/email inputs do not expose selection */ }
    } else if (element.isContentEditable) {
      const range = document.createRange();
      range.selectNodeContents(element);
      range.collapse(false);
      const selection = element.getRootNode().getSelection?.() || window.getSelection();
      selection.removeAllRanges();
      selection.addRange(range);
    }
  }

  globalThis.RetrospectionFields = Object.freeze({ ready: frameReady, isEligible, findField, identityFor, readValue, writeValue });
})();
