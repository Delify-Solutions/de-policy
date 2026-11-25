/**
 * RedTeam console —— browser half (hand-written bundle)
 *
 * Format matches the shell's module loader: window.__ModuleLoader__.load({ id, factory }).
 * scripts/build-client.mjs extracts this file into a factory fragment inside root client.js (id: de-policy).
 * Not loaded as a standalone browser module; the id is a source placeholder for the build.
 * No deps beyond the base: only react and ctx.slots from the platform seed.
 */
window.__ModuleLoader__.load({
  id: 'de-policy',
  factory: (require) => {
/* __DSH_PURGE_FULLSCREEN_BEGIN__ */
function resolveRuntimeDocument(options) {
  if (options && Object.prototype.hasOwnProperty.call(options, 'document')) {
    return options.document || null
  }
  return typeof document !== 'undefined' ? document : null
}

function resolveRuntimeWindow(options) {
  if (options && Object.prototype.hasOwnProperty.call(options, 'window')) {
    return options.window || null
  }
  return typeof window !== 'undefined' ? window : null
}

function containsNode(parent, node) {
  if (!parent || !node || parent === node) return false
  return typeof parent.contains === 'function' && parent.contains(node)
}

// Shadow DOM hosts may retarget document.fullscreenElement to the host.
// Read the target's own root first and keep unrelated fullscreen elements intact.
function nativeFullscreenElement(runtimeDocument, target) {
  let root = null
  try { root = target?.getRootNode?.() } catch { /* restricted host */ }
  const current = root?.fullscreenElement || root?.webkitFullscreenElement
    || runtimeDocument?.fullscreenElement || runtimeDocument?.webkitFullscreenElement || null
  if (current) return current
  try { if (target?.matches?.(':fullscreen')) return target } catch { /* older browser */ }
  try { if (target?.matches?.(':-webkit-full-screen')) return target } catch { /* unsupported selector */ }
  return null
}

function nativeExitMethod(runtimeDocument) {
  const method = runtimeDocument?.exitFullscreen || runtimeDocument?.webkitExitFullscreen || runtimeDocument?.webkitCancelFullScreen
  return typeof method === 'function' ? method.bind(runtimeDocument) : null
}

function safelyExitNative(runtimeDocument, target, requestRecord = null) {
  if (requestRecord?.exitRequested) return
  const current = nativeFullscreenElement(runtimeDocument, target)
  const ownsFullscreen = Boolean(
    target && (current === target || containsNode(target, current)),
  )
  if (!ownsFullscreen || !nativeExitMethod(runtimeDocument)) return

  if (requestRecord) requestRecord.exitRequested = true
  try {
    Promise.resolve(nativeExitMethod(runtimeDocument)()).catch(() => {})
  } catch {
    // Native exit is best-effort while a canceled request settles.
  }
}

/**
 * Keep a workbench in a CSS-expanded state while opportunistically using the
 * browser fullscreen API. The runtime objects are injectable so the hook can
 * be exercised without a browser.
 */
function useWorkbenchFullscreen(React, elementRef, options = {}) {
  const [expanded, setExpanded] = React.useState(false)
  const activeRef = React.useRef(false)
  const nativeTargetRef = React.useRef(null)
  const mountedRef = React.useRef(false)
  const operationRef = React.useRef(0)
  const pendingRequestRef = React.useRef(null)
  const ownedExitRef = React.useRef(null)
  const targetRef = React.useRef(null)
  const documentRef = React.useRef(null)
  const windowRef = React.useRef(null)

  if (elementRef?.current) targetRef.current = elementRef.current
  documentRef.current = resolveRuntimeDocument(options)
  windowRef.current = resolveRuntimeWindow(options)

  const readTarget = () => {
    const target = elementRef?.current || null
    if (target) targetRef.current = target
    return target
  }

  const setActive = React.useCallback((next) => {
    const value = Boolean(next)
    activeRef.current = value
    if (mountedRef.current) setExpanded(value)
  }, [setExpanded])

  const enter = React.useCallback(async () => {
    const operation = ++operationRef.current
    ownedExitRef.current = null
    const target = readTarget()
    const runtimeDocument = documentRef.current

    // Mark the CSS fallback synchronously so a user gesture is not lost while
    // requestFullscreen waits for the browser's permission/gesture handling.
    setActive(true)

    if (!target || typeof target.requestFullscreen !== 'function') return true

    const requestRecord = {
      operation,
      target,
      cancelled: false,
      exitRequested: false,
    }
    pendingRequestRef.current = requestRecord

    let request
    try {
      request = target.requestFullscreen()
    } catch {
      if (pendingRequestRef.current === requestRecord) pendingRequestRef.current = null
      return true
    }

    try {
      await request
    } catch {
      // A rejected native request leaves the CSS viewport-max fallback active.
      if (pendingRequestRef.current === requestRecord) pendingRequestRef.current = null
      return true
    }

    const stillPending = pendingRequestRef.current === requestRecord
    if (stillPending) pendingRequestRef.current = null
    if (!mountedRef.current || operationRef.current !== operation) {
      if (stillPending && requestRecord.cancelled) {
        safelyExitNative(runtimeDocument, target, requestRecord)
      }
      return false
    }
    if (nativeFullscreenElement(runtimeDocument, target) === target) {
      nativeTargetRef.current = target
    }
    return true
  }, [elementRef, setActive])

  const exit = React.useCallback(async () => {
    const operation = ++operationRef.current
    const pendingRequest = pendingRequestRef.current
    if (pendingRequest) pendingRequest.cancelled = true
    const target = readTarget()
    const runtimeDocument = documentRef.current
    const current = nativeFullscreenElement(runtimeDocument, target)
    const ownsFullscreen = Boolean(
      target && (current === target || containsNode(target, current)),
    )

    const exitRecord = ownsFullscreen ? { operation, target } : null
    ownedExitRef.current = exitRecord

    setActive(false)
    nativeTargetRef.current = null

    if (!ownsFullscreen || !nativeExitMethod(runtimeDocument)) {
      if (ownedExitRef.current === exitRecord) ownedExitRef.current = null
      return false
    }

    let exited = false
    for (let attempt = 0; attempt < 8; attempt += 1) {
      if (operationRef.current !== operation || ownedExitRef.current !== exitRecord) break

      const fullscreenElement = nativeFullscreenElement(runtimeDocument, target)
      const stillOwned = fullscreenElement === target || containsNode(target, fullscreenElement)
      if (!stillOwned || !nativeExitMethod(runtimeDocument)) break

      if (pendingRequest) pendingRequest.exitRequested = true
      let request
      try {
        request = nativeExitMethod(runtimeDocument)()
      } catch {
        break
      }
      try { await request } catch { break }
      exited = true

      // A browser may pop a nested child to its parent workbench in one call.
      // Re-check and drain again, but stop when the API is stuck at one level.
      if (nativeFullscreenElement(runtimeDocument, target) === fullscreenElement) break
    }

    if (ownedExitRef.current === exitRecord) {
      ownedExitRef.current = null
      if (operationRef.current === operation) setActive(false)
    }
    return exited
  }, [elementRef, setActive])

  const toggle = React.useCallback(() => (
    activeRef.current ? exit() : enter()
  ), [enter, exit])

  const isExpanded = React.useCallback(() => activeRef.current, [])

  React.useEffect(() => {
    const runtimeDocument = documentRef.current
    const runtimeWindow = windowRef.current
    const eventTarget = runtimeDocument && typeof runtimeDocument.addEventListener === 'function'
      ? runtimeDocument
      : runtimeWindow && typeof runtimeWindow.addEventListener === 'function'
        ? runtimeWindow
        : null

    const onFullscreenChange = () => {
      const target = readTarget()
      const current = nativeFullscreenElement(runtimeDocument, target)
      if (!target) return

      if (current === target) {
        const ownedExit = ownedExitRef.current
        if (ownedExit?.target === target && ownedExit.operation === operationRef.current) {
          nativeTargetRef.current = null
          setActive(false)
          return
        }
        const pendingRequest = pendingRequestRef.current
        if (pendingRequest?.target === target && pendingRequest.cancelled) {
          nativeTargetRef.current = null
          setActive(false)
          safelyExitNative(runtimeDocument, target, pendingRequest)
          return
        }
        nativeTargetRef.current = target
        setActive(true)
        return
      }

      // A nested SessionMap or shot overlay owns its own fullscreen session.
      // It must not activate the outer workbench, and it must not deactivate an
      // already-active fallback/native workbench while the child is open.
      if (containsNode(target, current)) return

      if (nativeTargetRef.current === target) {
        nativeTargetRef.current = null
        setActive(false)
      }
    }

    const onKeyDown = (event) => {
      if (event?.key !== 'Escape' || !activeRef.current) return

      const target = readTarget()
      const current = nativeFullscreenElement(runtimeDocument, target)
      if (containsNode(target, current)) return

      const nestedOverlay = typeof target?.querySelector === 'function'
        && target.querySelector(
          '.rt-session-map-expanded,.rt-shot-zoom,.dshp-modal-bg,.dshp-restart-mask,.dshp-auth-mask,.rt-modal,[role="dialog"][aria-modal="true"]',
        )
      if (nestedOverlay) return

      event.preventDefault?.()
      event.stopPropagation?.()
      void exit()
    }

    mountedRef.current = true
    eventTarget?.addEventListener('fullscreenchange', onFullscreenChange)
    eventTarget?.addEventListener('keydown', onKeyDown)
    onFullscreenChange()

    return () => {
      mountedRef.current = false
      ++operationRef.current
      const pendingRequest = pendingRequestRef.current
      if (pendingRequest) pendingRequest.cancelled = true
      eventTarget?.removeEventListener('fullscreenchange', onFullscreenChange)
      eventTarget?.removeEventListener('keydown', onKeyDown)

      const target = elementRef?.current || targetRef.current
      const current = nativeFullscreenElement(runtimeDocument, target)
      const ownsFullscreen = Boolean(
        target
          && (
            nativeTargetRef.current === target
              || pendingRequest?.target === target
          )
          && (current === target || containsNode(target, current)),
      )
      nativeTargetRef.current = null
      activeRef.current = false

      if (ownsFullscreen) safelyExitNative(runtimeDocument, target, pendingRequest)
    }
  }, [elementRef, exit, setActive])

  return { expanded, enter, exit, toggle, isExpanded }
}
/* __DSH_PURGE_FULLSCREEN_END__ */
    var module = { exports: {} }
    var exports = module.exports
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' })

    /* __DSH_PURGE_THEME_BEGIN__ */
/*
 * Shared product theme state.
 *
 * This file is intentionally dependency-free because it is embedded into both
 * client factories by scripts/build-client.mjs. Keep the browser guards here:
 * the settings shell can be rendered by host test doubles and in restricted
 * webviews where localStorage, MutationObserver, or matchMedia is unavailable.
 */
const PRODUCT_THEME_KEY = "de-policy-ui-theme";
const PRODUCT_THEME_EVENT = "de-policy-ui-theme-change";
const PRODUCT_THEME_MODES = Object.freeze(["dusk", "white", "system"]);
const PRODUCT_THEME_DEFAULT = "system";

function productThemeWindow(options) {
	if (options && Object.prototype.hasOwnProperty.call(options, "window")) return options.window;
	return typeof window !== "undefined" ? window : undefined;
}

function productThemeDocument(options, win) {
	if (options && Object.prototype.hasOwnProperty.call(options, "document")) return options.document;
	return typeof document !== "undefined" ? document : win && win.document;
}

function productThemeStorage(options, win) {
	if (options && Object.prototype.hasOwnProperty.call(options, "storage")) return options.storage;
	try { return win && win.localStorage; } catch { return undefined; }
}

function productThemeMode(value) {
	return PRODUCT_THEME_MODES.includes(value) ? value : "";
}

function productThemeMedia(options = {}) {
	const win = productThemeWindow(options);
	try {
		if (!win || typeof win.matchMedia !== "function") return "";
		const media = win.matchMedia("(prefers-color-scheme: dark)");
		if (!media || typeof media.matches !== "boolean") return "";
		return media.matches ? "dusk" : "white";
	} catch { /* restricted webviews may throw */ }
	return "";
}

function productThemeBooleanAttribute(target, name) {
	if (!target || !target.hasAttribute?.(name)) return false;
	const value = String(target.getAttribute?.(name) ?? "").trim().toLowerCase();
	return !["false", "0", "off", "no"].includes(value);
}

function productThemeHost(options = {}) {
	const win = productThemeWindow(options);
	const doc = productThemeDocument(options, win);
	const targets = [doc && doc.body, doc && doc.documentElement];
	try {
		for (const target of targets) {
			if (!target) continue;
			if (productThemeBooleanAttribute(target, "data-ds-dark-theme") || productThemeBooleanAttribute(target, "dark")) return "dusk";
			const attr = String(target.getAttribute?.("data-theme") || "").toLowerCase();
			if (attr === "dusk" || attr === "dark") return "dusk";
			if (attr === "white" || attr === "light") return "white";
		}

		const root = doc && doc.documentElement;
		const view = (doc && doc.defaultView) || win;
		const computed = typeof options.getComputedStyle === "function"
			? options.getComputedStyle(root)
			: (view && typeof view.getComputedStyle === "function" ? view.getComputedStyle(root) : null);
		const scheme = String(
			(root && root.style && root.style.colorScheme)
			|| (computed && (computed.colorScheme || computed.getPropertyValue?.("color-scheme")))
			|| "",
		).toLowerCase();
		const schemes = scheme.split(/\s+/).filter(Boolean);
		if (schemes.includes("dark") && schemes.includes("light")) {
			const media = productThemeMedia({ ...options, window: win, document: doc });
			if (media) return media;
			return schemes[0] === "dark" ? "dusk" : "white";
		}
		if (schemes.includes("dark")) return "dusk";
		if (schemes.includes("light")) return "white";
	} catch { /* host inspection is best effort */ }

	const media = productThemeMedia({ ...options, window: win, document: doc });
	if (media) return media;
	return "white";
}

function createProductTheme(options = {}) {
	const win = productThemeWindow(options);
	const doc = productThemeDocument(options, win);
	const storage = productThemeStorage(options, win);
	const listeners = new Set();
	let volatileMode = "";
	let storageUnavailable = !storage;
	let teardown = null;

	const readStoredMode = () => {
		if (!storage || typeof storage.getItem !== "function") {
			storageUnavailable = true;
			return "";
		}
		try {
			const stored = productThemeMode(storage.getItem(PRODUCT_THEME_KEY));
			storageUnavailable = false;
			return stored;
		} catch {
			storageUnavailable = true;
			return "";
		}
	};

	const mode = () => {
		if (volatileMode) return volatileMode;
		const stored = readStoredMode();
		if (stored) return stored;
		return PRODUCT_THEME_DEFAULT;
	};

	const host = () => productThemeHost({ ...options, window: win, document: doc });
	const system = () => productThemeMedia({ ...options, window: win, document: doc }) || host();
	const read = () => {
		const selected = mode();
		return selected === "system" ? system() : selected;
	};

	const notify = () => {
		const resolved = read();
		const selected = mode();
		for (const listener of [...listeners]) {
			try { listener(resolved, selected); } catch { /* one subscriber cannot break the others */ }
		}
	};

	const dispatch = () => {
		if (!win || typeof win.dispatchEvent !== "function") {
			notify();
			return;
		}
		try {
			const EventCtor = win.CustomEvent
				|| (typeof CustomEvent !== "undefined" ? CustomEvent : undefined)
				|| (typeof Event !== "undefined" ? Event : undefined);
			if (typeof EventCtor === "function") {
				win.dispatchEvent(new EventCtor(PRODUCT_THEME_EVENT, { detail: { mode: mode() } }));
				return;
			}
		} catch { /* fall through to direct notification */ }
		notify();
	};

	const start = () => {
		if (teardown) return;
		const cleanups = [];
		const onThemeEvent = (event) => {
			const selected = productThemeMode(event && event.detail && event.detail.mode);
			if (selected) volatileMode = selected;
			notify();
		};
		const onStorage = (event) => {
			if (!event || event.key === PRODUCT_THEME_KEY || event.key === null) {
				volatileMode = "";
				notify();
			}
		};
		const add = (target, type, listener, optionsArg) => {
			if (!target || typeof target.addEventListener !== "function") return false;
			try {
				target.addEventListener(type, listener, optionsArg);
				cleanups.push(() => {
					try { target.removeEventListener?.(type, listener, optionsArg); } catch { /* ignore */ }
				});
				return true;
			} catch { return false; }
		};

		add(win, PRODUCT_THEME_EVENT, onThemeEvent);
		add(win, "storage", onStorage);

		let media;
		try {
			media = win && typeof win.matchMedia === "function" ? win.matchMedia("(prefers-color-scheme: dark)") : null;
			if (media) {
				const onMedia = () => notify();
				if (typeof media.addEventListener === "function") {
					media.addEventListener("change", onMedia);
					cleanups.push(() => { try { media.removeEventListener?.("change", onMedia); } catch { /* ignore */ } });
				} else if (typeof media.addListener === "function") {
					media.addListener(onMedia);
					cleanups.push(() => { try { media.removeListener?.(onMedia); } catch { /* ignore */ } });
				}
			}
		} catch { /* matchMedia is optional */ }

		const Observer = (options && options.MutationObserver)
			|| (win && win.MutationObserver)
			|| (doc && doc.MutationObserver)
			|| (typeof MutationObserver !== "undefined" ? MutationObserver : undefined);
		try {
			if (Observer && doc) {
				const observer = new Observer(() => notify());
				const config = { attributes: true, attributeFilter: ["data-ds-dark-theme", "data-theme", "dark", "class", "style"] };
				if (doc.body) observer.observe(doc.body, config);
				if (doc.documentElement) observer.observe(doc.documentElement, config);
				cleanups.push(() => { try { observer.disconnect?.(); } catch { /* ignore */ } });
			}
		} catch { /* MutationObserver is optional */ }

		teardown = () => {
			for (const cleanup of cleanups.splice(0)) cleanup();
			teardown = null;
		};
	};

	const subscribe = (listener) => {
		if (typeof listener !== "function") return () => {};
		listeners.add(listener);
		start();
		return () => {
			listeners.delete(listener);
			if (listeners.size === 0 && teardown) teardown();
		};
	};

	const set = (next) => {
		const selected = productThemeMode(next);
		if (!selected) return read();
		let persisted = false;
		if (storage && typeof storage.setItem === "function") {
			try {
				storage.setItem(PRODUCT_THEME_KEY, selected);
				storageUnavailable = false;
				persisted = true;
			} catch { storageUnavailable = true; }
		}
		volatileMode = persisted ? "" : selected;
		dispatch();
		return read();
	};

	return Object.freeze({
		key: PRODUCT_THEME_KEY,
		event: PRODUCT_THEME_EVENT,
		modes: PRODUCT_THEME_MODES,
		defaultMode: PRODUCT_THEME_DEFAULT,
		mode,
		read,
		set,
		subscribe,
		host,
	});
}

const productTheme = createProductTheme();
/* __DSH_PURGE_THEME_END__ */

    const React = require('react')
    const rawH = React.createElement
    const renderInline = (text, depth) => {
      if (typeof text !== 'string' || text === '') return text
      if (text.indexOf('**') < 0 && text.indexOf('`') < 0) return text
      const level = depth || 0
      if (level > 4) return text
      const re = /(`[^`\n]+`|\*\*[^\n]+?\*\*)/g
      const out = []
      let last = 0
      let m
      while ((m = re.exec(text)) !== null) {
        if (m.index > last) out.push(text.slice(last, m.index))
        const token = m[0]
        if (token.charCodeAt(0) === 96) {
          out.push(rawH('code', { key: 'c' + m.index, className: 'rt-inline-code' }, token.slice(1, -1)))
        } else {
          const before = m.index > 0 ? text[m.index - 1] : ''
          const after = m.index + token.length < text.length ? text[m.index + token.length] : ''
          const inner = token.slice(2, -2)
          if (/[\\/]/.test(before) || /[\\/]/.test(after)
            || inner.startsWith('/') || inner.endsWith('/')
            || before === '*' || after === '*' || /^[/*\s]+$/.test(inner)) {
            out.push(token)
          } else {
            out.push(rawH('strong', { key: 'b' + m.index }, renderInline(inner, level + 1)))
          }
        }
        last = m.index + token.length
      }
      if (out.length === 0) return text
      if (last < text.length) out.push(text.slice(last))
      return rawH(React.Fragment, null, ...out)
    }
    const MD_RAW_TAGS = new Set(['pre', 'code', 'textarea', 'option', 'script', 'style'])
    const MD_RAW_CLASS = /(?:^|\s)(?:rt-mono|rt-rep-http|rt-atest-notes|rt-textarea)(?:\s|$)/
    const h = (type, props, ...children) => {
      if (children.length > 0
        && (typeof type !== 'string' || !MD_RAW_TAGS.has(type))
        && !(props && typeof props.className === 'string' && MD_RAW_CLASS.test(props.className))) {
        let changed = false
        const mapped = children.map((child) => {
          if (typeof child !== 'string') return child
          const rich = renderInline(child)
          if (rich !== child) changed = true
          return rich
        })
        if (changed) children = mapped
      }
      return rawH(type, props, ...children)
    }
    function SecretText(props) {
      const value = String(props.value === undefined || props.value === null ? '' : props.value)
      const [shown, setShown] = React.useState(false)
      if (value === '') return h('span', { className: 'rt-secret-none' }, props.empty || 'Chưa ghi nhận')
      return h('span', {
        className: props.className || 'rt-mono',
        style: { display: 'inline-flex', alignItems: 'center', gap: 6, maxWidth: '100%' },
      },
        h('span', { style: { wordBreak: 'break-all' } }, shown ? value : '••••••••'),
        h('button', {
          className: 'rt-btn', style: { padding: '0 12px', fontSize: 'var(--ui-text-control)' },
          onClick: (e) => { e.stopPropagation(); setShown((v) => !v) },
        }, shown ? 'Ẩn' : 'Hiện'))
    }

    const splitTableRow = (line) => {
      /* A `\|` inside a table cell is an escaped pipe (asset names/evidence in reports may contain one),
         so splitting on a bare `|` is not allowed or the whole row shifts. */
      const s = line.trim().replace(/^\|/, '').replace(/\|$/, '')
      const cells = []
      let cur = ''
      for (let i = 0; i < s.length; i += 1) {
        const ch = s[i]
        if (ch === '\\' && s[i + 1] === '|') { cur += '|'; i += 1; continue }
        if (ch === '|') { cells.push(cur.trim()); cur = ''; continue }
        cur += ch
      }
      cells.push(cur.trim())
      return cells
    }

    const isTableSep = (line) => /^\s*\|?\s*:?-{3,}:?\s*(?:\|\s*:?-{3,}:?\s*)+\|?\s*$/.test(line)

    /**
     * Block-level Markdown rendering (skill bodies, Markdown attack files).
     * Supports headings / paragraphs / ordered and unordered lists / tables / quotes / fences / rules.
     */
    function Markdown(props) {
      const text = String(props.text === undefined || props.text === null ? '' : props.text)
      const lines = text.replace(/\r\n?/g, '\n').split('\n')
      const out = []
      let i = 0
      let key = 0
      while (i < lines.length) {
        const line = lines[i]
        if (line.trim() === '') { i += 1; continue }

        /* Fenced code: shown verbatim inside, no inline parsing */
        const fence = /^\s*```\s*([\w.+-]*)\s*$/.exec(line)
        if (fence !== null) {
          const body = []
          i += 1
          while (i < lines.length && !/^\s*```\s*$/.test(lines[i])) { body.push(lines[i]); i += 1 }
          if (i < lines.length) i += 1
          out.push(rawH('pre', { key: 'f' + key++, className: 'rt-md-code' },
            rawH('code', fence[1] ? { 'data-lang': fence[1] } : null, body.join('\n'))))
          continue
        }

        /* Heading: `#` also starts at h2 in the panel, so one skill title cannot blow up the layout */
        const heading = /^(#{1,6})\s+(.*)$/.exec(line)
        if (heading !== null) {
          out.push(rawH('h' + Math.min(heading[1].length + 1, 6), { key: 'h' + key++ },
            renderInline(heading[2])))
          i += 1
          continue
        }

        if (/^\s*(?:---|\*\*\*|___)\s*$/.test(line)) {
          out.push(rawH('hr', { key: 'r' + key++ }))
          i += 1
          continue
        }

        /* Quote: contents keep rendering as Markdown */
        if (/^\s*>\s?/.test(line)) {
          const body = []
          while (i < lines.length && /^\s*>\s?/.test(lines[i])) {
            body.push(lines[i].replace(/^\s*>\s?/, ''))
            i += 1
          }
          out.push(rawH('blockquote', { key: 'q' + key++ },
            rawH(Markdown, { text: body.join('\n') })))
          continue
        }

        /* Table: header row + separator row + data rows */
        if (line.indexOf('|') >= 0 && i + 1 < lines.length && isTableSep(lines[i + 1])) {
          const head = splitTableRow(line)
          i += 2
          const rows = []
          while (i < lines.length && lines[i].trim() !== '' && lines[i].indexOf('|') >= 0) {
            rows.push(splitTableRow(lines[i]))
            i += 1
          }
          out.push(rawH('table', { key: 't' + key++ },
            rawH('thead', null, rawH('tr', null,
              head.map((cell, ci) => rawH('th', { key: 'th' + ci }, renderInline(cell))))),
            rawH('tbody', null, rows.map((row, ri) => rawH('tr', { key: 'tr' + ri },
              head.map((_, ci) => rawH('td', { key: 'td' + ci }, renderInline(row[ci] || ''))))))))
          continue
        }

        /* Lists: simple lists (skill docs are almost all flat); indented sub-items shown at the same level */
        const list = /^\s*([-*+]|\d+[.)])\s+(.*)$/.exec(line)
        if (list !== null) {
          const ordered = /^\d/.test(list[1])
          const items = []
          while (i < lines.length) {
            const item = /^\s*([-*+]|\d+[.)])\s+(.*)$/.exec(lines[i])
            if (item === null) break
            let body = item[2]
            i += 1
            /* Continuation: blank lines or content before the next item merge into the current item */
            while (i < lines.length && lines[i].trim() !== ''
              && !/^\s*([-*+]|\d+[.)])\s+/.test(lines[i])
              && !/^\s*```/.test(lines[i])
              && !/^(#{1,6})\s+/.test(lines[i])) {
              body += '\n' + lines[i].trim()
              i += 1
            }
            items.push(rawH('li', { key: 'li' + key++ }, renderInline(body)))
          }
          out.push(rawH(ordered ? 'ol' : 'ul', { key: 'l' + key++ }, items))
          continue
        }

        /* Paragraph: ends at a blank line or the next block; newlines kept (CSS white-space: pre-wrap) */
        const para = [line]
        i += 1
        while (i < lines.length && lines[i].trim() !== ''
          && !/^\s*```/.test(lines[i])
          && !/^(#{1,6})\s+/.test(lines[i])
          && !/^\s*>\s?/.test(lines[i])
          && !/^\s*([-*+]|\d+[.)])\s+/.test(lines[i])
          && !/^\s*(?:---|\*\*\*|___)\s*$/.test(lines[i])
          && !(lines[i].indexOf('|') >= 0 && i + 1 < lines.length && isTableSep(lines[i + 1]))) {
          para.push(lines[i])
          i += 1
        }
        out.push(rawH('p', { key: 'p' + key++ }, renderInline(para.join('\n'))))
      }
      return rawH('div', { className: props.className || 'rt-markdown', style: props.style }, out)
    }

    /*
     * The workbench is its own floating window: position:fixed, placed with left/top/width/height.
     * No padding on the official frame, no change to its input width. Purge-embedded uses .rt-embedded.
     */
    const CSS = `
.rt-dock{position:fixed;top:max(12px,var(--dsh-frame-chrome-top,var(--dsh-frame-top-clearance,var(--dsh-windows-titlebar-height,12px))));right:12px;z-index:20;display:flex;flex-direction:column;box-sizing:border-box;
  background:var(--rt-bg-surface,#fff);
  border:1px solid var(--rt-border,#dce3eb);
  border-radius:12px;
  box-shadow:0 18px 48px rgba(15,23,42,.16);pointer-events:auto;color:var(--dsw-alias-label-primary,#18212f);
  font-size:var(--ui-text-body);line-height:var(--ui-leading-body)}
.rt-dock.rt-embedded{position:relative;inset:auto;width:100%;height:100%;max-width:none;border:0;border-radius:0;box-shadow:none;background:var(--rt-bg-base,#f3f5f8)!important}
.rt-grip,.rt-resize-r,.rt-resize-b,.rt-resize-c{position:absolute;z-index:3;touch-action:none}
.rt-grip{left:-3px;top:0;bottom:0;width:8px;cursor:ew-resize;background:transparent}
.rt-resize-r{right:-3px;top:0;bottom:14px;width:8px;cursor:ew-resize}
.rt-resize-b{left:8px;right:14px;bottom:-3px;height:8px;cursor:ns-resize}
.rt-resize-c{right:0;bottom:0;width:16px;height:16px;cursor:nwse-resize}
.rt-head{display:flex;align-items:center;gap:8px;padding:10px 12px;border-bottom:1px solid var(--dsw-alias-border-l1);overflow:visible;flex-wrap:nowrap}
.rt-title{font-weight:600;font-size:var(--ui-text-body);line-height:var(--ui-leading-body);display:flex;align-items:center;gap:6px;white-space:nowrap;overflow:visible;flex:0 0 auto}
.rt-dot{width:8px;height:8px;border-radius:50%;background:var(--dsw-alias-brand-primary)}
.rt-spacer{flex:1}
.rt-btn{border:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-2);color:inherit;
  border-radius:6px;padding:5px 10px;font-size:var(--ui-text-control);line-height:var(--ui-leading-control);height:auto;min-height:28px;
  cursor:pointer;font-family:var(--ui-font);white-space:nowrap;overflow:visible;flex:0 0 auto}
.rt-btn:hover{border-color:var(--dsw-alias-border-l2)}
.rt-btn-primary{background:var(--dsw-alias-brand-primary);border-color:var(--dsw-alias-brand-primary);color:#fff}
.rt-btn-primary:hover{opacity:.9}
.rt-btn:disabled{opacity:.5;cursor:default}
.rt-tabs{display:flex;flex-wrap:wrap;gap:2px;padding:6px 12px 0;border-bottom:1px solid var(--dsw-alias-border-l1);
  overflow-x:auto;overflow-y:hidden;scrollbar-width:thin;-webkit-overflow-scrolling:touch}
.rt-tab{padding:8px 10px 7px;border-radius:0;cursor:pointer;font-size:var(--ui-text-control);line-height:var(--ui-leading-control);color:var(--dsw-alias-label-secondary);
  display:inline-flex;align-items:center;gap:5px;border-bottom:2px solid transparent;margin-bottom:-1px;background:transparent;
  white-space:nowrap;overflow:visible;flex:0 0 auto}
.rt-tab:hover{color:var(--dsw-alias-label-primary)}
.rt-tab.on{color:var(--dsw-alias-label-primary);background:transparent;font-weight:600;border-bottom-color:var(--dsw-alias-brand-primary,#6dbf8c)}
/* Unread dot: tab has new content (asset/vuln/score/step…); clears once viewed */
.rt-tab-dot{width:7px;height:7px;border-radius:50%;background:#ef4444;flex:none;
  box-shadow:0 0 0 2px color-mix(in srgb, #ef4444 22%, transparent)}
.rt-body{flex:1;min-height:0;display:flex;flex-direction:column}
.rt-split{flex:1;min-height:0;display:flex}
.rt-side{width:200px;flex:none;border-right:1px solid var(--dsw-alias-border-l1);overflow:auto;padding:8px}
.rt-main{flex:1;min-width:0;min-height:0;display:flex;flex-direction:column;overflow:hidden}
.rt-seg{padding:7px 8px;border-radius:6px;cursor:pointer;margin-bottom:4px;border:1px solid transparent}
.rt-seg:hover{background:var(--dsw-alias-bg-layer-2)}
.rt-seg.on{background:var(--dsw-alias-bg-layer-2);border-color:var(--dsw-alias-brand-primary)}
.rt-seg-cidr{font-family:var(--ui-mono);font-size:var(--ui-text-helper)}
.rt-seg-meta{font-size:var(--ui-text-helper);color:var(--dsw-alias-label-secondary);margin-top:2px}
.rt-toolbar{display:flex;gap:6px;padding:8px 10px;border-bottom:1px solid var(--dsw-alias-border-l1);flex-wrap:wrap;align-items:center}
.rt-input{background:var(--dsw-alias-bg-layer-2);border:1px solid var(--dsw-alias-border-l1);color:inherit;
  border-radius:6px;padding:4px 8px;font-size:var(--ui-text-control);font-family:var(--ui-font);outline:none;min-width:0}
.rt-input:focus{border-color:var(--dsw-alias-brand-primary)}
.rt-input option,.rt-eng-select option{background:var(--dsw-alias-bg-layer-1,#1c1c1c);color:var(--dsw-alias-label-primary,#f2f2f2)}
.rt-eng-select{color:var(--dsw-alias-label-primary,#f2f2f2);background:var(--dsw-alias-bg-layer-2,#2a2a2a)}
.rt-table{flex:1;overflow:auto}
.rt-row{display:grid;grid-template-columns:150px 74px 104px 1.15fr 1fr;gap:8px;padding:6px 10px;
  border-bottom:1px solid var(--dsw-alias-border-l1);align-items:center;cursor:pointer;font-size:var(--ui-text-helper)}
.rt-row:hover{background:var(--dsw-alias-bg-layer-2)}
.rt-row.head{cursor:default;color:var(--dsw-alias-label-secondary);font-size:var(--ui-text-helper);font-weight:600;position:sticky;top:0;
  background:var(--dsw-alias-bg-layer-1);z-index:1}
.rt-row.head:hover{background:var(--dsw-alias-bg-layer-1)}
.rt-mono{font-family:var(--ui-mono)}
.rt-tag{display:inline-block;padding:0 5px;border-radius:4px;font-size:var(--ui-text-helper);margin-right:4px;
  border:1px solid var(--dsw-alias-border-l1);color:var(--dsw-alias-label-secondary);white-space:nowrap}
.rt-tag-passive{color:#8b5cf6;border-color:#8b5cf655;background:#8b5cf61a}
.rt-tag-active{color:#f59e0b;border-color:#f59e0b55;background:#f59e0b1a}
.rt-tag-live{color:#10b981;border-color:#10b98155;background:#10b9811a}
.rt-tag-warn{color:#ef4444;border-color:#ef444455;background:#ef44441a}
/* Discipline banner: pinned on top when delivery rules fail (no Behinder/Godzilla shell, no suo5 tunnel) */
.rt-hint{border-radius:6px;padding:7px 9px;margin-bottom:8px;font-size:var(--ui-text-helper);line-height:var(--ui-leading-body);
  border:1px dashed #ef444488;background:#ef44440f;color:var(--dsw-alias-label-primary)}
.rt-hint b{color:#ef4444}
.rt-tag-dead{color:var(--dsw-alias-label-secondary)}
.rt-expand{grid-column:1/-1;padding:8px 4px 10px;font-size:var(--ui-text-helper);color:var(--dsw-alias-label-secondary)}
.rt-kv{display:flex;gap:8px;margin-bottom:3px;align-items:baseline}
.rt-kv b{color:var(--dsw-alias-label-primary);font-weight:600;min-width:64px;flex:none}
/* Graph view removed (see AssetsTab: relations handled by the domain view + redteam_attack_path tool) */
.rt-pane{flex:1;min-height:0;overflow:auto;padding:12px}
.rt-session-map{border:1px solid var(--rt-border,#dce3eb);border-radius:8px;background:var(--rt-bg-surface,#fff);color:var(--rt-ink,#18212f);margin-bottom:12px;overflow:hidden}
.rt-session-map-head{display:flex;align-items:center;gap:8px;flex-wrap:wrap;padding:10px 12px;border-bottom:1px solid var(--rt-border,#dce3eb);background:var(--rt-bg-surface,#fff)}
.rt-session-map-title{font-weight:600;font-size:var(--ui-text-body);line-height:var(--ui-leading-body)}
.rt-session-map-subtitle{font-size:var(--ui-text-helper);color:var(--rt-muted,#64748b);line-height:var(--ui-leading-body)}
.rt-session-map-status{display:inline-flex;align-items:center;gap:5px;font-size:var(--ui-text-helper);color:var(--rt-muted,#64748b)}
.rt-session-map-status-dot{width:7px;height:7px;border-radius:50%;background:var(--rt-success,#10b981);flex:none}
.rt-session-map-status-dot.stale{background:var(--rt-warning,#f59e0b)}
.rt-session-map-toolbar{display:flex;gap:6px;align-items:center;flex-wrap:wrap;padding:8px 10px;border-bottom:1px solid var(--rt-border,#dce3eb);background:var(--rt-bg-surface,#fff)}
.rt-session-map-toolbar .rt-session-map-search{flex:1 1 180px;min-width:120px}
.rt-session-map-toolbar .rt-session-map-filter{width:92px}
.rt-session-map-note{padding:7px 10px;font-size:var(--ui-text-helper);line-height:var(--ui-leading-body);color:var(--rt-muted,#64748b);border-bottom:1px solid var(--rt-border,#dce3eb);background:var(--rt-bg-surface,#fff)}
.rt-session-map-alert{padding:7px 10px;font-size:var(--ui-text-helper);line-height:var(--ui-leading-body);color:var(--rt-warning,#92400e);border-bottom:1px solid var(--rt-warning,#f59e0b);background:var(--rt-warning-bg,#fffbeb)}
.rt-session-map-empty{padding:28px 18px;text-align:center;font-size:var(--ui-text-helper);line-height:var(--ui-leading-body);color:var(--rt-muted,#64748b);background:var(--rt-bg-surface,#fff)}
.rt-session-map-layout{display:grid;grid-template-columns:minmax(0,1.65fr) minmax(236px,.8fr);min-height:340px;background:var(--rt-bg-surface,#fff)}
.rt-session-map-graph-pane{min-width:0;min-height:340px;overflow:auto;border-right:1px solid var(--rt-border,#dce3eb);background:var(--rt-bg-base,#f3f5f8)}
.rt-session-map-graph{display:block;min-width:100%;min-height:340px;background:var(--rt-bg-base,#f3f5f8)}
.rt-session-map-edge{fill:none;stroke:var(--rt-border,#94a3b8);stroke-width:1.5;stroke-dasharray:0}
.rt-session-map-edge.orphan{stroke:var(--rt-warning,#f59e0b);stroke-dasharray:4 4}
.rt-session-map-node{cursor:pointer;outline:none}
.rt-session-map-node rect{fill:var(--rt-bg-surface,#fff);stroke:var(--rt-border,#cbd5e1);stroke-width:1.2}
.rt-session-map-node:hover rect,.rt-session-map-node.selected rect{stroke:var(--rt-accent,#6dbf8c);stroke-width:2}
.rt-session-map-node.orphan rect{stroke:var(--rt-warning,#f59e0b);stroke-dasharray:4 3}
.rt-session-map-node-id{font:600 var(--ui-text-helper)/var(--ui-leading-body) var(--ui-font);fill:var(--rt-ink,#18212f)}
.rt-session-map-node-meta{font:400 var(--ui-text-helper)/var(--ui-leading-body) var(--ui-font);fill:var(--rt-muted,#64748b)}
.rt-session-map-node-dot.running{fill:var(--rt-success,#10b981);background:var(--rt-success,#10b981)}.rt-session-map-node-dot.idle{fill:var(--rt-muted,#94a3b8);background:var(--rt-muted,#94a3b8)}.rt-session-map-node-dot.unknown{fill:var(--rt-warning,#f59e0b);background:var(--rt-warning,#f59e0b)}
/* Shared task-board stage tones: cards and the read-only map use the same four states. */
.rt-session-map-node-stage{font:600 var(--ui-text-helper)/var(--ui-leading-body) var(--ui-font);fill:var(--rt-muted,#64748b)}
.rt-session-map-node-stage.is-wait{fill:var(--rt-warning,#d97706)}
.rt-session-map-node-stage.is-live{fill:var(--rt-success,#059669)}
.rt-session-map-node-stage.is-fail{fill:var(--rt-danger,#b63f3f)}
.rt-session-map-node-stage.is-done{fill:var(--rt-muted,#64748b)}
.rt-session-map-node.is-wait rect{fill:var(--rt-warning-bg,#3b2f12);stroke:var(--rt-warning,#f59e0b);stroke-width:2}
.rt-session-map-node.is-live rect{fill:var(--rt-success-bg,#163a31);stroke:var(--rt-success,#10b981);stroke-width:2}
.rt-session-map-node.is-fail rect{fill:var(--rt-danger-bg,#fbeeed);stroke:var(--rt-danger,#b63f3f);stroke-width:2}
.rt-session-map-node.is-done rect{fill:var(--rt-bg-surface,#151f2b);stroke:var(--rt-border,#cbd5e1);stroke-dasharray:0;opacity:.72}
.rt-session-map-node.is-wait .rt-session-map-node-dot{fill:var(--rt-warning,#f59e0b);background:var(--rt-warning,#f59e0b)}
.rt-session-map-node.is-live .rt-session-map-node-dot{fill:var(--rt-success,#10b981);background:var(--rt-success,#10b981)}
.rt-session-map-node.is-fail .rt-session-map-node-dot{fill:var(--rt-danger,#b63f3f);background:var(--rt-danger,#b63f3f)}
.rt-session-map-detail{min-width:0;min-height:340px;overflow:auto;padding:12px;background:var(--rt-bg-surface,#fff)}
.rt-session-map-detail-title{font-weight:600;font-size:var(--ui-text-section);line-height:var(--ui-leading-title);overflow-wrap:anywhere;color:var(--rt-ink,#18212f)}
.rt-session-map-detail-status{display:inline-flex;align-items:center;gap:6px;margin-top:6px;font-size:var(--ui-text-helper);color:var(--rt-muted,#64748b)}
.rt-session-map-detail-grid{display:grid;grid-template-columns:74px minmax(0,1fr);gap:5px 8px;margin-top:12px;font-size:var(--ui-text-helper);line-height:var(--ui-leading-body)}
.rt-session-map-detail-grid dt{color:var(--rt-muted,#64748b)}
.rt-session-map-detail-grid dd{margin:0;overflow-wrap:anywhere;color:var(--rt-ink,#18212f)}
.rt-session-map-detail-unknown{color:var(--rt-muted,#64748b)}
.rt-session-map-foot{display:flex;gap:12px;flex-wrap:wrap;padding:7px 10px;border-top:1px solid var(--rt-border,#dce3eb);font-size:var(--ui-text-helper);line-height:var(--ui-leading-body);color:var(--rt-muted,#64748b);background:var(--rt-bg-surface,#fff)}
.rt-session-map-button{padding:4px 8px;min-height:26px}
@media(max-width:760px){.rt-session-map-layout{grid-template-columns:minmax(0,1fr)}.rt-session-map-graph-pane{border-right:0;border-bottom:1px solid var(--rt-border,#dce3eb)}.rt-session-map-detail{min-height:0}.rt-session-map-graph{min-height:300px}}
.rt-card{border:1px solid var(--rt-border,#dce3eb);border-radius:8px;padding:10px;margin-bottom:10px;
  background:var(--rt-bg-surface,#fff)}
.rt-card h4{margin:0 0 6px;font-size:var(--ui-text-section)}
.rt-textarea{width:100%;min-height:260px;background:var(--dsw-alias-bg-base);border:1px solid var(--dsw-alias-border-l1);
  color:inherit;border-radius:6px;padding:8px;font-size:var(--ui-text-control);font-family:var(--ui-mono);
  line-height:var(--ui-leading-control);resize:vertical;outline:none;box-sizing:border-box}
.rt-textarea:focus{border-color:var(--dsw-alias-brand-primary)}
.rt-list{width:210px;flex:none;border-right:1px solid var(--dsw-alias-border-l1);overflow:auto;padding:8px}
.rt-item{padding:7px 8px;border-radius:6px;cursor:pointer;margin-bottom:4px;border:1px solid transparent}
.rt-item:hover{background:var(--dsw-alias-bg-layer-2)}
.rt-item.on{background:var(--dsw-alias-bg-layer-2);border-color:var(--dsw-alias-brand-primary)}
.rt-item-name{font-weight:600;font-size:var(--ui-text-helper)}
.rt-item-desc{font-size:var(--ui-text-helper);color:var(--dsw-alias-label-secondary);margin-top:2px;
  display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden}
.rt-empty{padding:24px;text-align:center;color:var(--dsw-alias-label-secondary);font-size:var(--ui-text-helper)}
.rt-err{color:var(--dsw-alias-state-error-primary);font-size:var(--ui-text-helper);padding:6px 10px}
.rt-foot{padding:8px 12px;border-top:1px solid var(--dsw-alias-border-l1);font-size:var(--ui-text-helper);
  color:var(--dsw-alias-label-secondary);display:flex;gap:12px;flex-wrap:wrap;align-items:center}
.rt-icon-btn{display:flex;align-items:center;justify-content:center;gap:6px;width:100%;border:1px solid var(--dsw-alias-border-l1);
  background:transparent;color:inherit;border-radius:6px;padding:6px 8px;cursor:pointer;font-family:inherit;font-size:12.5px}
.rt-icon-btn:hover{background:var(--dsw-alias-bg-layer-2)}
.rt-icon-btn.on{border-color:var(--dsw-alias-brand-primary);color:var(--dsw-alias-brand-primary)}
.rt-hbtn{border:1px solid var(--dsw-alias-border-l1);background:transparent;color:inherit;border-radius:6px;
  padding:2px 8px;font-size:var(--ui-text-control);cursor:pointer;font-family:var(--ui-font);display:flex;align-items:center;gap:5px}
.rt-hbtn:hover{background:var(--dsw-alias-bg-layer-2)}
.rt-hbtn.on{border-color:var(--dsw-alias-brand-primary);color:var(--dsw-alias-brand-primary)}
.rt-test{display:inline-block;padding:0 5px;border-radius:4px;font-size:var(--ui-text-helper);white-space:nowrap;
  border:1px solid var(--dsw-alias-border-l1);color:var(--dsw-alias-label-secondary)}
.rt-test-testing{color:#f59e0b;border-color:#f59e0b55;background:#f59e0b1a}
.rt-test-tested{color:#10b981;border-color:#10b98155;background:#10b9811a}
.rt-test-blocked{color:#fff;background:#ef4444;border-color:#ef4444}
.rt-test-abandoned{color:#94a3b8;border-color:#94a3b855;background:#94a3b81a}
.rt-test-no_surface{color:#6366f1;border-color:#6366f155;background:#6366f11a}
.rt-scope-testing{color:#5b21b6;background:#ddd6fe}
.rt-pri{display:inline-block;padding:0 6px;border-radius:4px;font-size:var(--ui-text-helper);font-weight:600;white-space:nowrap}
.rt-pri-high{color:#fff;background:#ef4444}
.rt-pri-medium{color:#fff;background:#f59e0b}
.rt-pri-low{color:#fff;background:#94a3b8}
.rt-score-row{display:grid;grid-template-columns:16px 62px minmax(0,1fr) 116px 66px;gap:8px;padding:7px 10px;
  border-bottom:1px solid var(--dsw-alias-border-l1);align-items:center;font-size:var(--ui-text-helper);cursor:pointer}
.rt-score-row:hover{background:var(--dsw-alias-bg-layer-2)}
.rt-score-row.head{cursor:default;color:var(--dsw-alias-label-secondary);font-size:var(--ui-text-helper);font-weight:600;
  position:sticky;top:0;background:var(--dsw-alias-bg-layer-1);z-index:1}
.rt-score-detail{grid-column:1/-1;padding:8px 4px 10px;font-size:var(--ui-text-helper);color:var(--dsw-alias-label-secondary)}
/* Score targets grouped by the merged 8 categories: category head + items by score asc */
.rt-score-group{display:flex;align-items:center;gap:8px;padding:7px 10px 5px;margin-top:2px;
  font-size:var(--ui-text-helper);font-weight:600;border-top:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-2)}
.rt-score-group:first-child{border-top:none}
.rt-score-group .rt-sg-sub{font-weight:400;font-size:var(--ui-text-helper);color:var(--dsw-alias-label-secondary)}
/* ── Session & entry: each card splits into title / facts / commands / notes ── */
.rt-sess-facts{display:flex;flex-direction:column;gap:2px;margin-top:5px}
.rt-sess-fact{display:flex;gap:6px;font-size:var(--ui-text-helper);line-height:var(--ui-leading-body)}
.rt-sess-fact>b{flex:none;min-width:62px;font-weight:600;color:var(--dsw-alias-label-secondary)}
.rt-sess-fact>span{min-width:0;overflow-wrap:anywhere}
.rt-sess-cmd{margin-top:6px}
.rt-sess-cmd>b{display:block;font-size:var(--ui-text-helper);color:var(--dsw-alias-label-secondary);margin-bottom:3px;font-weight:600}
.rt-sess-fold{margin-top:6px;font-size:var(--ui-text-helper)}
.rt-sess-fold>summary{cursor:pointer;color:var(--dsw-alias-label-secondary);user-select:none}
.rt-sess-fold>summary:hover{color:var(--dsw-alias-label-primary)}
.rt-score-row .rt-scope{font-size:var(--ui-text-helper);color:var(--dsw-alias-label-secondary)}
.rt-score-form{display:grid;grid-template-columns:1fr 1fr;gap:6px;margin-bottom:6px}
.rt-score-form input,.rt-score-form select{width:100%;box-sizing:border-box}
.rt-vrow{display:grid;grid-template-columns:62px minmax(0,1fr) 132px 108px 74px 52px;gap:8px;padding:6px 10px;
  border-bottom:1px solid var(--dsw-alias-border-l1);align-items:center;font-size:var(--ui-text-helper);cursor:pointer}
.rt-vrow:hover{background:var(--dsw-alias-bg-layer-2)}
.rt-vrow.head{cursor:default;color:var(--dsw-alias-label-secondary);font-size:var(--ui-text-helper);font-weight:600;
  position:sticky;top:0;background:var(--dsw-alias-bg-layer-1);z-index:1}
.rt-vdetail{grid-column:1/-1;padding:8px 4px 10px;font-size:var(--ui-text-helper);color:var(--dsw-alias-label-secondary)}
.rt-vdetail .rt-kv{margin-bottom:4px}
.rt-actions{display:flex;gap:6px;margin-top:6px}
.rt-section{padding:8px 10px 2px;font-size:var(--ui-text-helper);font-weight:600;color:var(--dsw-alias-label-secondary)}
.rt-link{color:var(--dsw-alias-brand-primary);text-decoration:none;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.rt-link:hover{text-decoration:underline}
.rt-full{position:fixed;top:var(--dsh-frame-chrome-top,var(--dsh-frame-top-clearance,var(--dsh-windows-titlebar-height,0px)));right:0;bottom:0;left:0;z-index:60;display:flex;flex-direction:column;
  background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary);font-size:var(--ui-text-body);line-height:var(--ui-leading-body);
  border-top:3px solid var(--dsw-alias-brand-primary)}
.rt-full .rt-head{padding:12px 18px}
.rt-full .rt-tabs{padding:10px 18px 0;gap:6px;flex-wrap:nowrap;overflow-x:auto}
.rt-full .rt-side{width:260px}
.rt-full .rt-list{width:280px}
.rt-full .rt-row{grid-template-columns:190px 90px 130px 1.4fr 1.2fr}
.rt-full .rt-vrow{grid-template-columns:80px minmax(0,1.6fr) 200px 150px 90px 64px}
.rt-full .rt-pane{padding:18px}
.rt-full .rt-textarea{min-height:60vh}
.rt-full .rt-foot{padding:10px 18px;font-size:var(--ui-text-helper)}
.rt-full .rt-body{max-width:1400px;width:100%;margin:0 auto;flex:1;min-height:0;display:flex;flex-direction:column}
.rt-chain{flex:1;overflow:auto;padding:10px 12px}
.rt-step{display:flex;gap:10px;padding:8px 6px;border-left:2px solid var(--dsw-alias-border-l1);margin-left:6px}
.rt-step:last-child{border-left-color:transparent}
.rt-step-dot{width:22px;height:22px;flex:none;border-radius:50%;display:flex;align-items:center;justify-content:center;
  font-size:var(--ui-text-helper);font-weight:600;color:#fff;background:#64748b;margin-left:-13px}
.rt-step-body{min-width:0}
.rt-step-title{font-weight:600;font-size:var(--ui-text-body)}
.rt-step-meta{font-size:var(--ui-text-helper);color:var(--dsw-alias-label-secondary);margin-top:2px;word-break:break-word}
.rt-stage-recon{background:#6366f1}
.rt-stage-vuln{background:#f59e0b}
.rt-stage-exploit{background:#ef4444}
.rt-stage-access{background:#10b981}
.rt-stage-pivot{background:#8b5cf6}
.rt-stage-data{background:#0ea5e9}
.rt-stage-other{background:#64748b}
.rt-step-head{display:flex;align-items:baseline;gap:6px;flex-wrap:wrap}
.rt-step-time{font-size:var(--ui-text-helper);color:var(--dsw-alias-label-secondary);margin-left:auto;white-space:nowrap}
.rt-step-detail{font-size:var(--ui-text-helper);margin-top:5px;white-space:pre-wrap;word-break:break-word;
  border-left:2px solid var(--dsw-alias-border-l1);padding:2px 0 2px 9px;line-height:var(--ui-leading-body)}
.rt-chip{display:inline-flex;align-items:center;gap:5px;font-size:var(--ui-text-helper);padding:1px 7px;border-radius:5px;
  border:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-2);margin:4px 5px 0 0;max-width:100%}
.rt-chip>i{font-style:normal;color:var(--dsw-alias-label-secondary);font-size:var(--ui-text-helper)}
.rt-chip>span{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:420px}
.rt-stage-tag{display:inline-block;padding:0 6px;border-radius:4px;font-size:var(--ui-text-helper);color:#fff;font-weight:600}
.rt-st-recon{background:#6366f1}.rt-st-vuln{background:#f59e0b}.rt-st-exploit{background:#ef4444}
.rt-st-access{background:#10b981}.rt-st-pivot{background:#8b5cf6}.rt-st-data{background:#0ea5e9}.rt-st-other{background:#64748b}
.rt-sev{display:inline-block;padding:0 6px;border-radius:4px;font-size:var(--ui-text-helper);font-weight:600;border:1px solid transparent}
.rt-sev-critical{color:#fff;background:#b91c1c}.rt-sev-high{color:#fff;background:#ef4444}
.rt-sev-medium{color:#7c2d12;background:#fdba74}.rt-sev-low{color:#1e3a8a;background:#bfdbfe}
.rt-sev-info{color:var(--dsw-alias-label-secondary);background:var(--dsw-alias-bg-layer-2);border-color:var(--dsw-alias-border-l1)}
.rt-dot-on{display:inline-block;width:7px;height:7px;border-radius:50%;background:#10b981;box-shadow:0 0 0 3px #10b98133}
.rt-dot-off{display:inline-block;width:7px;height:7px;border-radius:50%;background:#ef4444;box-shadow:0 0 0 3px #ef444433}
.rt-dot-unk{display:inline-block;width:7px;height:7px;border-radius:50%;background:#94a3b8;box-shadow:0 0 0 3px #94a3b833}
.rt-sess-grid{display:grid;grid-template-columns:1fr;gap:8px;padding:10px 12px}
.rt-sess{border:1px solid var(--dsw-alias-border-l1);border-radius:8px;padding:9px 10px;background:var(--dsw-alias-bg-layer-2)}
.rt-sess-head{display:flex;align-items:center;gap:7px;flex-wrap:wrap}
.rt-sess-title{font-weight:600;font-size:var(--ui-text-helper);font-family:var(--ui-mono);word-break:break-all}
.rt-sess-sub{font-size:var(--ui-text-helper);color:var(--dsw-alias-label-secondary);margin-top:3px;word-break:break-word}
.rt-code{font-family:var(--ui-mono);font-size:var(--ui-text-helper);background:var(--dsw-alias-bg-base);
  border:1px solid var(--dsw-alias-border-l1);border-radius:4px;padding:1px 5px;cursor:pointer;word-break:break-all}
.rt-code:hover{border-color:var(--dsw-alias-brand-primary)}
.rt-evi{border:1px solid var(--dsw-alias-border-l1);border-radius:8px;overflow:hidden;margin-top:8px}
.rt-evi-head{display:flex;align-items:center;gap:8px;padding:5px 9px;background:var(--dsw-alias-bg-layer-2);
  font-size:var(--ui-text-helper);font-weight:600;border-bottom:1px solid var(--dsw-alias-border-l1)}
.rt-evi-body{margin:0;padding:9px 11px;font-family:var(--ui-mono);font-size:var(--ui-text-helper);line-height:var(--ui-leading-body);
  white-space:pre-wrap;word-break:break-word;max-height:340px;overflow:auto;background:var(--dsw-alias-bg-base)}
.rt-evi-body.req{max-height:220px}
.rt-hl-req{color:#10b981;font-weight:600}
.rt-hl-res{color:#0ea5e9;font-weight:600}
.rt-gain{display:inline-flex;align-items:center;gap:5px;font-size:var(--ui-text-helper);font-weight:600;padding:2px 8px;border-radius:12px;
  color:#065f46;background:#a7f3d0;border:1px solid #10b98155}
.rt-total{font-size:var(--ui-text-metric);font-weight:600;font-family:var(--ui-mono)}
.rt-sidehead{padding:7px 8px 2px;font-size:var(--ui-text-helper);font-weight:600;color:var(--dsw-alias-label-secondary);
  display:flex;align-items:center;gap:5px}
.rt-sidehead-btn{cursor:pointer;outline:none;padding:6px 6px 5px;border-radius:5px;user-select:none}
.rt-sidehead-btn:hover{color:var(--dsw-alias-label-primary);background:var(--dsw-alias-bg-layer-1)}
.rt-sidehead-btn:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:-2px}
.rt-scope{display:inline-block;padding:0 4px;border-radius:3px;font-size:var(--ui-text-helper);font-weight:600;line-height:15px;flex:none}
.rt-scope-internal{color:#0e7490;background:#a5f3fc}
.rt-scope-external{color:#9a3412;background:#fed7aa}
.rt-hits{display:flex;flex-direction:column;gap:6px;margin-top:7px}
.rt-hit{border:1px solid var(--dsw-alias-border-l1);border-left:3px solid #10b981;border-radius:6px;
  padding:7px 9px;background:var(--dsw-alias-bg-layer-2)}
.rt-hit-head{display:flex;align-items:center;gap:7px;flex-wrap:wrap}
.rt-hit-idx{width:16px;height:16px;border-radius:50%;background:#10b981;color:#fff;font-size:var(--ui-text-helper);font-weight:600;
  display:inline-flex;align-items:center;justify-content:center;flex:none}
.rt-hit-target{font-family:var(--ui-mono);font-weight:600;font-size:var(--ui-text-helper);word-break:break-all}
.rt-hit-time{margin-left:auto;font-size:var(--ui-text-helper);color:var(--dsw-alias-label-secondary);white-space:nowrap}
.rt-hit-evi{font-family:var(--ui-mono);font-size:var(--ui-text-helper);line-height:var(--ui-leading-body);white-space:pre-wrap;word-break:break-word;
  background:var(--dsw-alias-bg-base);border:1px solid var(--dsw-alias-border-l1);border-radius:5px;padding:6px 8px;margin-top:5px}
.rt-hit-note{font-size:var(--ui-text-helper);color:var(--dsw-alias-label-secondary);margin-top:4px}
.rt-cred{border:1px solid var(--dsw-alias-border-l1);border-left:3px solid #f59e0b;border-radius:6px;
  padding:8px 10px;background:var(--dsw-alias-bg-layer-2);margin-bottom:7px}
.rt-cred-head{display:flex;align-items:center;gap:7px;flex-wrap:wrap}
.rt-cred-host{font-family:var(--ui-mono);font-weight:600;font-size:var(--ui-text-helper);word-break:break-all}
.rt-secret{font-family:var(--ui-mono);font-size:var(--ui-text-helper);line-height:var(--ui-leading-body);background:#fef3c7;color:#78350f;
  border:1px solid #f59e0b66;border-radius:5px;padding:6px 9px;margin-top:6px;white-space:pre-wrap;word-break:break-all;
  user-select:all;cursor:text}
.rt-secret-none{font-family:var(--ui-mono);font-size:var(--ui-text-helper);color:var(--dsw-alias-state-error-primary);
  border:1px dashed var(--dsw-alias-state-error-primary);border-radius:5px;padding:5px 9px;margin-top:6px}
.rt-cred-meta{font-size:var(--ui-text-helper);color:var(--dsw-alias-label-secondary);margin-top:5px;word-break:break-word}
.rt-stage-score{background:#10b981}
.rt-counted{font-family:var(--ui-mono);font-size:var(--ui-text-helper);font-weight:600;color:#065f46;background:#a7f3d0;border:1px solid #10b98155;border-radius:9px;padding:0 7px}
.rt-scorepts{font-size:var(--ui-text-helper);font-weight:600;color:#065f46;background:#a7f3d0;border:1px solid #10b98155;
  border-radius:10px;padding:0 7px;white-space:nowrap}
.rt-livebar{display:flex;align-items:center;gap:7px;padding:7px 12px;border-bottom:1px solid var(--dsw-alias-border-l1);
  background:var(--dsw-alias-bg-layer-2);flex-wrap:wrap}
.rt-live-dot{width:8px;height:8px;border-radius:50%;background:#10b981;flex:none;animation:rt-pulse 1.6s ease-in-out infinite}
.rt-live-dot.idle{background:#94a3b8;animation:none}
@keyframes rt-pulse{0%,100%{opacity:1;box-shadow:0 0 0 0 #10b98166}50%{opacity:.5;box-shadow:0 0 0 5px #10b98100}}
.rt-live-body{padding:8px 12px 2px;max-height:44vh;overflow:auto}
.rt-atest{border:1px solid var(--dsw-alias-border-l1);border-left:3px solid #10b981;border-radius:6px;
  padding:7px 10px;background:var(--dsw-alias-bg-layer-2);margin-bottom:6px}
.rt-atest.past{border-left-color:#94a3b8;opacity:.85}
.rt-atest-head{display:flex;align-items:center;gap:7px;flex-wrap:wrap}
.rt-atest-ip{font-family:var(--ui-mono);font-weight:600;font-size:var(--ui-text-helper);word-break:break-all}
.rt-atest-meta{font-size:var(--ui-text-helper);color:var(--dsw-alias-label-secondary);margin-top:3px;word-break:break-word}
.rt-atest-notes{font-family:var(--ui-mono);font-size:var(--ui-text-helper);line-height:var(--ui-leading-body);white-space:pre-wrap;
  word-break:break-word;background:var(--dsw-alias-bg-base);border-radius:4px;padding:5px 7px;margin-top:4px;max-height:76px;overflow:auto}
.rt-concl{display:flex;align-items:center;gap:4px;padding:6px 12px;border-bottom:1px solid var(--dsw-alias-border-l1);
  background:var(--dsw-alias-bg-layer-2);flex-wrap:wrap}
.rt-concl-i{display:inline-flex;align-items:baseline;gap:4px;padding:2px 8px;border-radius:6px;cursor:pointer;
  border:1px solid transparent}
.rt-concl-i:hover{border-color:var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-1)}
.rt-concl-i.on{border-color:var(--dsw-alias-brand-primary);background:var(--dsw-alias-bg-layer-1)}
.rt-concl-i b{font-family:var(--ui-mono);font-size:var(--ui-text-body);font-weight:600}
.rt-concl-i>span{color:var(--dsw-alias-label-secondary);font-size:var(--ui-text-helper)}
.rt-more{color:var(--dsw-alias-brand-primary);font-size:var(--ui-text-helper);cursor:pointer;user-select:none;margin-top:4px;display:inline-block}
.rt-more:hover{text-decoration:underline}
.rt-subtabs{display:flex;gap:4px;padding:6px 10px 0;border-bottom:1px solid var(--dsw-alias-border-l1);align-items:center}
.rt-subtab{padding:4px 10px;border-radius:6px 6px 0 0;cursor:pointer;font-size:var(--ui-text-control);color:var(--dsw-alias-label-secondary)}
.rt-subtab.on{color:var(--dsw-alias-label-primary);background:var(--dsw-alias-bg-layer-2);font-weight:600}
.rt-sevbar{width:3px;border-radius:2px;align-self:stretch;flex:none;margin-right:2px}
/* ── Fold hierarchy ────────────────────────────────────────────────────────
   L1 header .rt-sec   : full width, no radius/border, left color bar, dark — always flat
   L2 card .rt-atest/.rt-hit/.rt-cred/.rt-evi: inset, bordered, rounded — raised
   L3 detail/long text .rt-clip-body / .rt-evi-body : borderless, lightest, mono
   L4 child container .rt-sec-body: left indent + vertical guide line, belongs to the head
   ──────────────────────────────────────────────────────────────────────── */
.rt-sec-wrap{margin:0}
.rt-sec{display:flex;align-items:center;gap:8px;padding:7px 12px 7px 9px;cursor:pointer;
  background:var(--dsw-alias-bg-layer-2);border-left:3px solid var(--dsw-alias-border-l2);
  border-top:1px solid var(--dsw-alias-border-l1);user-select:none;outline:none}
.rt-sec:hover{background:var(--dsw-alias-bg-layer-1)}
.rt-sec:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:-2px}
.rt-sec.flat{cursor:default}
.rt-sec.flat:hover{background:var(--dsw-alias-bg-layer-2)}
.rt-sec-caret{flex:none;width:11px;font-size:var(--ui-text-helper);color:var(--dsw-alias-label-secondary);text-align:center}
.rt-sec-title{font-weight:600;font-size:var(--ui-text-body);white-space:nowrap}
.rt-sec-count{font-size:var(--ui-text-helper);color:var(--dsw-alias-label-secondary);white-space:nowrap}
.rt-sec-sub{font-size:var(--ui-text-helper);color:var(--dsw-alias-label-secondary);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.rt-sec-right{margin-left:auto;font-size:var(--ui-text-helper);color:var(--dsw-alias-label-secondary);white-space:nowrap;flex:none}
.rt-sec.t-stage{border-left-color:#8b5cf6}
.rt-sec.t-target{border-left-color:#0ea5e9}
.rt-sec.t-folder{border-left-color:#64748b}
.rt-sec.t-test{border-left-color:#10b981}
.rt-sec.t-queue{border-left-color:#f59e0b}
.rt-sec.t-past{border-left-color:#94a3b8}
.rt-sec-body{margin-left:12px;border-left:1px solid var(--dsw-alias-border-l1);padding:7px 0 3px 10px}
.rt-sec-body>.rt-atest:last-child,.rt-sec-body>.rt-hit:last-child{margin-bottom:2px}
/* Long-text fold (L3): 2-line faded preview by default; expands to capped scroll */
.rt-clip{margin-top:6px}
.rt-clip-head{display:flex;align-items:center;gap:6px}
.rt-clip-label{font-size:var(--ui-text-helper);color:var(--dsw-alias-label-secondary);font-weight:600}
.rt-clip-body{font-family:var(--ui-mono);font-size:var(--ui-text-helper);line-height:var(--ui-leading-body);white-space:pre-wrap;
  word-break:break-word;background:var(--dsw-alias-bg-base);border-radius:5px;padding:6px 8px;margin-top:3px}
.rt-clip:not(.open) .rt-clip-body{max-height:46px;overflow:hidden;
  -webkit-mask-image:linear-gradient(180deg,#000 55%,transparent);mask-image:linear-gradient(180deg,#000 55%,transparent)}
.rt-clip.open .rt-clip-body{max-height:340px;overflow:auto}
.rt-flow{padding:10px 12px 16px}
.rt-flow-start,.rt-flow-end{font-size:var(--ui-text-helper);color:var(--dsw-alias-label-secondary);padding:4px 0}
.rt-flow-end{font-weight:600;color:var(--dsw-alias-label-primary)}
.rt-flow-link{display:flex;align-items:center;gap:8px;padding:3px 0 3px 10px}
.rt-flow-arrow{color:var(--dsw-alias-border-l2);font-size:var(--ui-text-helper);flex:none}
.rt-flow-action{font-size:var(--ui-text-helper);color:var(--dsw-alias-label-secondary);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.rt-flow-action.inferred{opacity:.7;font-style:italic}
.rt-flow-node{border:1px solid var(--dsw-alias-border-l1);border-left:3px solid #10b981;border-radius:8px;
  padding:8px 11px;background:var(--dsw-alias-bg-layer-2);cursor:pointer;outline:none}
.rt-flow-node:hover{border-color:var(--dsw-alias-border-l2)}
.rt-flow-node:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:-2px}
.rt-flow-node.overflow{border-left-color:#94a3b8;opacity:.75}
.rt-flow-head{display:flex;align-items:center;gap:8px;flex-wrap:wrap}
.rt-flow-idx{width:18px;height:18px;border-radius:50%;background:#10b981;color:#fff;font-size:var(--ui-text-helper);font-weight:600;
  display:inline-flex;align-items:center;justify-content:center;flex:none}
.rt-flow-node.overflow .rt-flow-idx{background:#94a3b8}
.rt-flow-name{font-weight:600;font-size:var(--ui-text-body)}
.rt-flow-pts{margin-left:auto;font-family:var(--ui-mono);font-size:var(--ui-text-helper);font-weight:600;color:#065f46;
  background:#a7f3d0;border:1px solid #10b98155;border-radius:10px;padding:0 8px;white-space:nowrap}
.rt-flow-pts.off{color:var(--dsw-alias-label-secondary);background:var(--dsw-alias-bg-layer-1);border-color:var(--dsw-alias-border-l1)}
.rt-flow-times{font-size:var(--ui-text-helper);color:var(--dsw-alias-label-secondary)}
.rt-flow-target{font-family:var(--ui-mono);font-size:var(--ui-text-helper);margin-top:4px;word-break:break-all;
  color:var(--dsw-alias-label-secondary)}
.rt-flow-gain{font-size:var(--ui-text-helper);margin-top:3px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.rt-flow-detail{margin-top:7px;padding-top:7px;border-top:1px dashed var(--dsw-alias-border-l1)}
.rt-hflow-wrap{flex:1;min-height:0;display:flex;flex-direction:column;overflow:auto}
.rt-hflow{display:flex;align-items:center;gap:0;padding:16px 12px;overflow-x:auto;flex-wrap:nowrap}
.rt-hflow-item{display:flex;align-items:center;flex:none}
.rt-hflow-start,.rt-hflow-end{font-size:var(--ui-text-helper);color:var(--dsw-alias-label-secondary);white-space:nowrap;padding:0 4px}
.rt-hflow-end{font-weight:600;color:var(--dsw-alias-label-primary)}
.rt-hflow-arrow{color:var(--dsw-alias-border-l2);padding:0 5px;font-size:var(--ui-text-body);flex:none}
.rt-hflow-node{display:flex;align-items:center;gap:5px;border:1px solid var(--dsw-alias-border-l1);
  border-left:3px solid #10b981;border-radius:7px;padding:5px 8px;background:var(--dsw-alias-bg-layer-2);
  cursor:pointer;white-space:nowrap;outline:none}
.rt-hflow-node:hover{border-color:var(--dsw-alias-border-l2)}
.rt-hflow-node:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:-2px}
.rt-hflow-node.overflow{border-left-color:#94a3b8;opacity:.72}
.rt-hflow-node.open{border-color:var(--dsw-alias-brand-primary)}
.rt-hflow-pts{font-family:var(--ui-mono);font-size:var(--ui-text-helper);font-weight:600;color:#065f46;background:#a7f3d0;
  border-radius:8px;padding:0 6px}
.rt-hflow-node.overflow .rt-hflow-pts{color:var(--dsw-alias-label-secondary);background:var(--dsw-alias-bg-layer-1)}
.rt-hflow-name{font-size:var(--ui-text-helper)}
.rt-hflow-n{font-size:var(--ui-text-helper);color:var(--dsw-alias-label-secondary)}
.rt-rep-list{padding:10px 12px 14px}
.rt-rep-tools{display:flex;gap:6px;justify-content:flex-end;margin-bottom:8px}
.rt-rep{border:1px solid var(--dsw-alias-border-l1);border-left:3px solid #10b981;border-radius:8px;
  padding:9px 11px;margin-bottom:10px;background:var(--dsw-alias-bg-layer-2)}
.rt-rep-head{display:flex;align-items:center;gap:8px;flex-wrap:wrap}
.rt-rep-idx{font-size:var(--ui-text-body);color:#10b981;font-weight:600;flex:none}
.rt-rep-name{font-weight:600;font-size:var(--ui-text-body)}
.rt-rep-meta{font-size:var(--ui-text-helper);margin-top:4px;color:var(--dsw-alias-label-secondary);word-break:break-word}
.rt-rep-meta b{color:var(--dsw-alias-label-primary);font-weight:600;margin-right:2px}
.rt-rep-missing{font-size:var(--ui-text-helper);color:var(--dsw-alias-state-error-primary);margin-top:6px;
  border:1px dashed var(--dsw-alias-state-error-primary);border-radius:5px;padding:5px 8px}
.rt-rep-req{margin-top:7px;border:1px solid var(--dsw-alias-border-l1);border-radius:6px;overflow:hidden}
.rt-rep-req-head{display:flex;align-items:center;gap:7px;padding:4px 8px;font-size:var(--ui-text-helper);font-weight:600;
  background:var(--dsw-alias-bg-layer-1);border-bottom:1px solid var(--dsw-alias-border-l1)}
.rt-rep-http{margin:0;padding:8px 10px;font-family:var(--ui-mono);font-size:var(--ui-text-helper);line-height:var(--ui-leading-body);white-space:pre-wrap;word-break:break-word;max-height:240px;overflow:auto;background:var(--dsw-alias-bg-base)}
/* ── Report "how this step happened": actions / commands / creds / tunnels ── */
.rt-rep-trace{margin-top:8px;border:1px solid var(--dsw-alias-border-l1);border-radius:7px;padding:8px 10px;
  background:var(--dsw-alias-bg-base)}
.rt-rep-trace-head{display:flex;align-items:center;gap:7px;margin-bottom:5px}
.rt-rep-trace-title{font-weight:600;font-size:var(--ui-text-helper)}
.rt-rep-trace-how{font-size:var(--ui-text-helper);color:var(--dsw-alias-label-secondary);margin-bottom:6px}
.rt-rep-step{border-left:2px solid var(--dsw-alias-border-l1);padding:2px 0 6px 9px;margin-bottom:6px}
.rt-rep-step-head{display:flex;align-items:center;gap:6px;flex-wrap:wrap}
.rt-rep-step-no{width:17px;height:17px;border-radius:50%;background:var(--dsw-alias-brand-primary);color:#fff;
  font-size:var(--ui-text-helper);display:flex;align-items:center;justify-content:center;flex:none}
.rt-rep-step-title{font-weight:600;font-size:var(--ui-text-helper)}
.rt-rep-step-detail{font-size:var(--ui-text-helper);color:var(--dsw-alias-label-secondary);margin-top:2px}
.rt-rep-step-cmd{font-size:var(--ui-text-helper);margin-top:4px;display:flex;gap:6px;align-items:flex-start;flex-wrap:wrap}
.rt-rep-step-cmd .rt-mono{background:var(--dsw-alias-bg-layer-2);border:1px solid var(--dsw-alias-border-l1);
  border-radius:5px;padding:2px 6px;word-break:break-all}
.rt-rep-step-result{font-size:var(--ui-text-helper);margin-top:3px;word-break:break-word}
.rt-rep-src{margin-top:6px;padding-top:6px;border-top:1px dashed var(--dsw-alias-border-l1)}
.rt-rep-src-title{font-weight:600;font-size:var(--ui-text-helper);margin-bottom:3px}
/* ── Full-chain attack path graph ──────────────────────────────── */
.rt-ap{padding:10px 12px 18px;overflow:auto}
.rt-ap-stage{margin-bottom:2px}
.rt-ap-head{display:flex;align-items:center;gap:8px;padding:7px 10px;background:var(--dsw-alias-bg-layer-2);
  border-left:4px solid #64748b;border-top:1px solid var(--dsw-alias-border-l1);border-radius:6px 6px 0 0}
.rt-ap-no{width:20px;height:20px;border-radius:5px;color:#fff;font-size:var(--ui-text-helper);font-weight:600;flex:none;
  display:inline-flex;align-items:center;justify-content:center}
.rt-ap-name{font-weight:600;font-size:var(--ui-text-body)}
.rt-ap-en{font-size:var(--ui-text-helper);color:var(--dsw-alias-label-secondary);letter-spacing:normal}
.rt-ap-phase{font-size:var(--ui-text-helper);color:var(--dsw-alias-label-secondary);white-space:nowrap}
.rt-ap-goal{display:flex;align-items:baseline;gap:8px;padding:6px 10px 6px 9px;font-size:var(--ui-text-helper);
  border-left:4px solid #64748b;background:var(--dsw-alias-bg-layer-1)}
.rt-ap-goal-tag{font-size:var(--ui-text-helper);font-weight:600;border:1px solid;border-radius:4px;padding:0 5px;white-space:nowrap;flex:none}
.rt-ap-result{padding:7px 10px 3px;border-left:4px solid transparent}
.rt-ap-result-head{display:flex;align-items:center;gap:8px;margin-bottom:5px;flex-wrap:wrap}
.rt-ap-pts{font-family:var(--ui-mono);font-size:var(--ui-text-helper);font-weight:600;color:#065f46;background:#a7f3d0;
  border:1px solid #10b98155;border-radius:10px;padding:0 7px;white-space:nowrap}
.rt-ap-pts.off{color:var(--dsw-alias-label-secondary);background:var(--dsw-alias-bg-layer-1);border-color:var(--dsw-alias-border-l1)}
/* Hits capped per service or self-built (unscored): grey points (+0), not a gain */
.rt-ap-pts.uncounted{color:var(--dsw-alias-label-secondary);background:var(--dsw-alias-bg-layer-1);border-color:var(--dsw-alias-border-l1)}
.rt-ap-nth{font-size:var(--ui-text-helper);color:var(--dsw-alias-label-secondary);white-space:nowrap}
.rt-ap-hit{border:1px solid var(--dsw-alias-border-l1);border-left:3px solid #10b981;border-radius:6px;
  padding:6px 9px;margin-bottom:5px;background:var(--dsw-alias-bg-layer-2);cursor:pointer;outline:none}
.rt-ap-hit:hover{border-color:var(--dsw-alias-border-l2)}
.rt-ap-hit:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:-2px}
.rt-ap-hit.overflow{border-left-color:#94a3b8;opacity:.75}
.rt-ap-hit-head{display:flex;align-items:center;gap:7px;flex-wrap:wrap}
.rt-ap-hit-name{font-weight:600;font-size:var(--ui-text-helper)}
.rt-ap-hit-target{font-family:var(--ui-mono);font-size:var(--ui-text-helper);color:var(--dsw-alias-label-secondary);
  margin-left:auto;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:46%}
.rt-ap-act{font-size:var(--ui-text-helper);color:var(--dsw-alias-label-secondary);margin-top:3px}
.rt-ap-act.inferred{font-style:italic;opacity:.75}
.rt-ap-none{font-size:var(--ui-text-helper);color:var(--dsw-alias-label-secondary);padding:2px 0 4px}
.rt-ap-trans{display:flex;align-items:center;gap:7px;padding:2px 0 2px 14px}
.rt-ap-trans-t{font-size:var(--ui-text-helper);color:var(--dsw-alias-label-secondary)}
/* Lateral path graph */
.rt-ap-h{display:flex;align-items:stretch;padding:10px 12px 14px;overflow-x:auto;flex:1;min-height:0}
.rt-ap-col{display:flex;align-items:stretch;flex:none}
.rt-ap-col-arrow{align-self:center;color:var(--dsw-alias-border-l2);padding:0 6px;font-size:var(--ui-text-helper);flex:none}
.rt-hcol{width:228px;display:flex;flex-direction:column;border:1px solid var(--dsw-alias-border-l1);
  border-top:3px solid #64748b;border-radius:7px;background:var(--dsw-alias-bg-layer-1);overflow:hidden}
.rt-hcol-goal{font-size:var(--ui-text-helper);color:var(--dsw-alias-label-secondary);padding:5px 8px;line-height:var(--ui-leading-body);
  border-bottom:1px solid var(--dsw-alias-border-l1);display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden}
.rt-hcol-body{padding:6px 8px;flex:1;min-height:0;overflow:auto}
.rt-hcol-hit{display:flex;align-items:center;gap:5px;font-size:var(--ui-text-helper);margin-bottom:3px}
.rt-hcol-hit.off{opacity:.6}
.rt-hcol-pts{font-family:var(--ui-mono);font-size:var(--ui-text-helper);font-weight:600;color:#065f46;background:#a7f3d0;
  border-radius:7px;padding:0 5px;flex:none}
.rt-hcol-hit.off .rt-hcol-pts{color:var(--dsw-alias-label-secondary);background:var(--dsw-alias-bg-layer-2)}
.rt-hcol-name{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.rt-hcol-none{font-size:var(--ui-text-helper);color:var(--dsw-alias-label-secondary)}
.rt-hcol-secs{display:flex;flex-wrap:wrap;gap:3px;margin-top:6px}
.rt-hcol-sec{font-size:var(--ui-text-helper);color:var(--dsw-alias-label-secondary);border:1px solid var(--dsw-alias-border-l1);
  border-radius:4px;padding:0 4px}
.rt-hcol-attck{font-family:var(--ui-mono);font-size:var(--ui-text-helper);color:var(--dsw-alias-label-secondary);
  padding:4px 8px;border-top:1px solid var(--dsw-alias-border-l1);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.rt-ap-cum{font-size:var(--ui-text-helper);color:var(--dsw-alias-label-secondary);white-space:nowrap}
.rt-ap-sub{font-size:var(--ui-text-helper);font-weight:600;color:var(--dsw-alias-label-secondary);margin:6px 0 3px}
.rt-ap-assets,.rt-ap-tunnels{display:flex;flex-direction:column;gap:3px}
.rt-ap-asset{display:flex;align-items:center;gap:6px;font-size:var(--ui-text-helper);padding:3px 6px;border-radius:5px;
  background:var(--dsw-alias-bg-layer-1);border:1px solid var(--dsw-alias-border-l1)}
.rt-ap-tunnel{display:flex;align-items:center;gap:6px;font-size:var(--ui-text-helper);padding:4px 7px;border-radius:5px;
  background:var(--dsw-alias-bg-layer-1);border:1px solid var(--dsw-alias-border-l1);border-left:3px solid #f59e0b}
.rt-hcol-sub{font-size:var(--ui-text-helper);color:var(--dsw-alias-label-secondary);margin-bottom:2px;
  overflow:hidden;text-overflow:ellipsis;white-space:nowrap;display:flex;gap:5px;align-items:center}
.rt-hcol-sub.off{opacity:.6}
.rt-hit-row{display:flex;flex-wrap:wrap;align-items:center;gap:2px 7px;font-size:var(--ui-text-helper);padding:4px 7px;border-radius:5px;
  background:var(--dsw-alias-bg-layer-1);border:1px solid var(--dsw-alias-border-l1);margin-bottom:3px}
/* Asset and text wrap freely: long domains/passwords/results wrap, never ellipsized */
.rt-hit-asset{font-family:var(--ui-mono);font-weight:600;flex:0 1 auto;max-width:100%;
  overflow-wrap:anywhere;word-break:break-word}
.rt-hit-txt{flex:1 1 100%;color:var(--dsw-alias-label-primary);line-height:var(--ui-leading-body);
  white-space:pre-wrap;overflow-wrap:anywhere;word-break:break-word}
.rt-hit-txt.none{color:var(--dsw-alias-state-error-primary)}
.rt-hit-row .rt-hit-time{flex:none;margin-left:auto}
/* Self-registered/self-built account: recorded but unscored, row dimmed */
.rt-hit-row.self-created{opacity:.72;border-left:3px solid #ef444488}
/* Duplicate account/DB grant on same asset+port: service already capped, trace only */
.rt-hit-row.service-capped{opacity:.72;border-left:3px solid #f59e0b88}
.rt-hit-row.service-capped .rt-hit-idx{background:#f59e0b}
.rt-rep-group{margin-bottom:14px}
.rt-rep-stage{display:flex;align-items:center;gap:8px;padding:7px 10px;margin-bottom:7px;
  background:var(--dsw-alias-bg-layer-2);border-left:4px solid #64748b;border-radius:6px;
  cursor:pointer;outline:none;user-select:none}
.rt-rep-stage:hover{background:var(--dsw-alias-bg-layer-1)}
.rt-rep-stage:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:-2px}
.rt-rep-no{width:20px;height:20px;border-radius:5px;color:#fff;font-size:var(--ui-text-helper);font-weight:600;flex:none;
  display:inline-flex;align-items:center;justify-content:center}
.rt-rep-stage-name{font-weight:600;font-size:var(--ui-text-body)}
.rt-rep-stage-n{font-size:var(--ui-text-helper);color:var(--dsw-alias-label-secondary)}
/* Points stay in the header so the stage score is visible when folded */
.rt-rep-pts{font-size:var(--ui-text-helper);font-weight:600;padding:1px 6px;border-radius:5px;border:1px solid transparent;flex:none}
.rt-rep-body{padding-left:6px}
/* ── Knowledge base (POC/EXP) ──────────────────────────────── */
.rt-kb-filter{display:flex;align-items:center;gap:7px;padding:8px 10px;border-bottom:1px solid var(--dsw-alias-border-l1)}
/* KB category overview: one tag row, click a tag to filter by that class */
.rt-kb-cats{display:flex;flex-wrap:wrap;gap:6px;padding:8px 10px;border-bottom:1px solid var(--dsw-alias-border-l1)}
/* KB group header (one row per group when grouped by category) */
.rt-kb-cat{display:flex;align-items:center;gap:7px;padding:7px 10px;background:var(--dsw-alias-bg-layer-2);
  border-bottom:1px solid var(--dsw-alias-border-l1);position:sticky;top:0;z-index:1}
.rt-kb-cat-name{font-weight:600;font-size:var(--ui-text-helper)}
/* Skill availability badge (skills tab) */
.rt-avail{display:inline-block;padding:0 5px;border-radius:4px;font-size:var(--ui-text-helper);white-space:nowrap;
  border:1px solid var(--dsw-alias-border-l1);color:var(--dsw-alias-label-secondary)}
.rt-avail-available{color:#10b981;border-color:#10b98155;background:#10b9811a}
.rt-avail-broken{color:#ef4444;border-color:#ef444455;background:#ef44441a}
.rt-avail-unknown{color:#94a3b8;border-color:#94a3b855;background:#94a3b81a}
/* Version / update dialog */
.rt-modal{position:fixed;inset:0;z-index:200;background:rgba(0,0,0,.45);display:flex;align-items:center;justify-content:center}
.rt-modal-box{width:min(560px,92vw);max-height:80vh;overflow:auto;background:var(--dsw-alias-bg-layer-1);
  border:1px solid var(--dsw-alias-border-l1);border-radius:10px;padding:14px 16px;font-size:var(--ui-text-helper);line-height:var(--ui-leading-body);
  box-shadow:0 18px 48px rgba(0,0,0,.35);color:var(--dsw-alias-label-primary)}
.rt-modal-box .rt-kv b{min-width:76px}
.rt-kb-check{display:flex;align-items:center;gap:5px;font-size:var(--ui-text-helper);color:var(--dsw-alias-label-secondary);white-space:nowrap;cursor:pointer}
.rt-kb{border:1px solid var(--dsw-alias-border-l1);border-radius:7px;margin:0 0 8px;overflow:hidden;
  background:var(--dsw-alias-bg-layer-2)}
.rt-kb.open{border-color:var(--dsw-alias-brand-primary)}
.rt-kb-head{display:flex;align-items:center;gap:7px;padding:7px 9px;cursor:pointer;outline:none;flex-wrap:wrap}
.rt-kb-head:hover{background:var(--dsw-alias-bg-layer-1)}
.rt-kb-head:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:-2px}
.rt-kb-title{font-weight:600;font-size:var(--ui-text-helper);overflow-wrap:anywhere}
.rt-kb-kind{font-size:var(--ui-text-helper);font-weight:600;letter-spacing:normal;padding:1px 5px;border-radius:4px;
  color:#fff;background:#64748b;flex:none}
.rt-kb-kind.k-exp{background:#ef4444}
.rt-kb-kind.k-poc{background:#f59e0b}
.rt-kb-kind.k-template{background:#8b5cf6}
.rt-kb-kind.k-script{background:#0ea5e9}
.rt-kb-kind.k-payload{background:#10b981}
.rt-kb-sub{font-size:var(--ui-text-helper);color:var(--dsw-alias-label-secondary);padding:0 9px 7px;overflow-wrap:anywhere}
.rt-kb-body{padding:0 9px 9px}
.rt-kb-actions{display:flex;gap:6px;margin:7px 0}
.rt-kb-body .rt-kv span{overflow-wrap:anywhere;word-break:break-word}
/* Local nuclei template hits: path must be fully visible (copy as command) */
.rt-kb-tpl{margin-top:12px;border-top:1px dashed var(--dsw-alias-border-l1);padding-top:8px}
.rt-kb-tpl-row{display:flex;align-items:center;gap:7px;font-size:var(--ui-text-helper);padding:3px 7px;border-radius:5px;
  background:var(--dsw-alias-bg-layer-1);border:1px solid var(--dsw-alias-border-l1);margin-bottom:3px}
.rt-kb-tpl-path{flex:0 1 auto;font-weight:600;overflow-wrap:anywhere}
.rt-kb-tpl-name{flex:1 1 auto;min-width:0;color:var(--dsw-alias-label-secondary);overflow-wrap:anywhere}
.rt-md{flex:1;overflow:auto;margin:0;padding:14px 16px;font-family:var(--ui-mono);font-size:var(--ui-text-helper);
  line-height:var(--ui-leading-body);white-space:pre-wrap;word-break:break-word;background:var(--dsw-alias-bg-base)}
.rt-weblink{display:block;font-size:var(--ui-text-helper);margin-top:1px;max-width:100%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.rt-shots{margin:8px 0 4px;padding:7px 8px;border:1px solid var(--dsw-alias-border-l1);border-radius:7px;
  background:var(--dsw-alias-bg-layer-1)}
.rt-shots-head{display:flex;align-items:baseline;gap:8px;font-size:var(--ui-text-helper);margin-bottom:6px}
.rt-shots-n{color:var(--dsw-alias-label-secondary)}
.rt-shot-row{display:flex;gap:8px;flex-wrap:wrap}
.rt-shot{display:flex;flex-direction:column;gap:3px;max-width:220px}
.rt-shot-thumb{border:1px solid var(--dsw-alias-border-l1);border-radius:5px;background:#0b1020;
  object-fit:contain;display:block;width:auto;max-width:216px}
.rt-shot-loading{display:flex;align-items:center;justify-content:center;width:150px;font-size:var(--ui-text-helper);
  color:var(--dsw-alias-label-secondary)}
.rt-shot-cap{display:flex;align-items:center;gap:5px;font-size:var(--ui-text-helper);overflow-wrap:anywhere}
.rt-shot-label{color:var(--dsw-alias-label-secondary);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:170px}
.rt-shot-zoom{position:fixed;inset:0;z-index:9999;background:rgba(0,0,0,.82);display:flex;flex-direction:column;
  align-items:center;justify-content:center;gap:10px;cursor:zoom-out;padding:18px}
.rt-shot-zoom img{max-width:96vw;max-height:86vh;border-radius:6px;box-shadow:0 18px 48px rgba(0,0,0,.5)}
.rt-shot-zoom-cap{color:#e5e7eb;font-size:var(--ui-text-helper);text-align:center;max-width:90vw;overflow-wrap:anywhere}
/* ── Situation overview: brief bar + stage stepper, readable in narrow panes ── */
.rt-ov{padding:0;min-height:0}
.rt-ov-head{display:flex;align-items:center;gap:10px;padding:10px 14px 8px}
.rt-ov-heading{min-width:0}
.rt-ov-eyebrow{display:none}
.rt-ov-title-row{display:flex;align-items:center;gap:8px;min-width:0}
.rt-ov-title{font-size:var(--ui-text-body);font-weight:600;letter-spacing:normal;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:46vw}
.rt-ov-stage-chip{font-size:var(--ui-text-helper);border:1px solid var(--dsw-alias-border-l1);border-radius:6px;padding:2px 8px;color:var(--dsw-alias-label-secondary);white-space:nowrap}
.rt-ov-scroll{overflow:auto;padding:0 14px 16px;flex:1;min-height:0}
.rt-ov-hero{display:flex;flex-direction:column;gap:10px}
.rt-ov-score{display:flex;align-items:center;gap:14px;flex-wrap:wrap;min-height:0;padding:12px 14px;
  border:1px solid var(--dsw-alias-border-l1);border-radius:10px;
  background:var(--dsw-alias-bg-layer-1);position:relative;overflow:hidden}
.rt-ov-score-label{font-size:var(--ui-text-helper);color:var(--dsw-alias-label-secondary);min-width:52px}
.rt-ov-score-num{font-size:var(--ui-text-metric);line-height:var(--ui-leading-body);font-weight:600;letter-spacing:normal;color:var(--dsw-alias-brand-primary);font-variant-numeric:tabular-nums}
.rt-ov-score-num small{font-size:var(--ui-text-metric);font-weight:500;margin-left:3px;letter-spacing:0;color:var(--dsw-alias-label-secondary)}
.rt-ov-score-sub{font-size:var(--ui-text-helper);color:var(--dsw-alias-label-secondary);flex:1 1 140px;min-width:0}
.rt-ov-score .rt-btn{margin-left:auto}
.rt-ov-rail{border:1px solid var(--dsw-alias-border-l1);border-radius:10px;padding:10px 12px;background:var(--dsw-alias-bg-layer-1);min-width:0}
.rt-ov-rail-head{font-size:var(--ui-text-helper);font-weight:600;color:var(--dsw-alias-label-secondary);margin-bottom:8px}
.rt-ov-stages{display:flex;align-items:stretch;gap:0;min-width:0}
.rt-ov-stage{position:relative;flex:1 1 0;min-width:0;padding:4px 8px 2px;border:0;border-radius:0;background:transparent}
.rt-ov-stage:not(:last-child)::after{content:'';position:absolute;top:14px;left:26px;right:-2px;height:1px;
  background:var(--dsw-alias-border-l1);z-index:0}
.rt-ov-stage.on{background:transparent;box-shadow:none}
.rt-ov-node{width:22px;height:22px;border-radius:50%;display:flex;align-items:center;justify-content:center;font-size:var(--ui-text-helper);font-weight:600;color:#fff;background:var(--stage,var(--dsw-alias-label-secondary));opacity:.55;margin-bottom:6px;position:relative;z-index:1}
.rt-ov-stage.has .rt-ov-node{opacity:1}
.rt-ov-stage.on .rt-ov-node{opacity:1;box-shadow:0 0 0 3px var(--dsw-alias-brand-primary)}
.rt-ov-stage-name{font-size:var(--ui-text-helper);font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;color:var(--dsw-alias-label-primary)}
.rt-ov-stage.on .rt-ov-stage-name{color:var(--stage,var(--dsw-alias-label-primary))}
.rt-ov-stage-pts{font-size:var(--ui-text-helper);font-weight:600;margin-top:2px;color:var(--stage,var(--dsw-alias-label-primary));font-variant-numeric:tabular-nums}
.rt-ov-stage-cum{font-size:var(--ui-text-helper);color:var(--dsw-alias-label-secondary);margin-top:1px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.rt-ov-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:12px;margin-top:12px}
.rt-ov-card{border:1px solid var(--dsw-alias-border-l1);border-radius:12px;background:var(--dsw-alias-bg-layer-1);padding:12px 14px;min-width:0}
.rt-ov-card-wide{grid-column:1/-1}
.rt-ov-card-head{display:flex;align-items:center;gap:8px;margin-bottom:7px}
.rt-ov-card-title{font-size:var(--ui-text-section);font-weight:600}
.rt-ov-card-sub{font-size:var(--ui-text-helper);color:var(--dsw-alias-label-secondary)}
.rt-ov-gaps{display:flex;flex-direction:column;gap:1px}
.rt-ov-gap{display:flex;align-items:center;gap:10px;padding:7px 8px;border-radius:8px;cursor:pointer;min-width:0}
.rt-ov-gap:hover{background:var(--dsw-alias-bg-layer-2)}
.rt-ov-rank{width:20px;flex:none;font-size:var(--ui-text-helper);color:var(--dsw-alias-label-secondary);font-variant-numeric:tabular-nums;letter-spacing:normal}
.rt-ov-gap-main{flex:1;min-width:0}
.rt-ov-gap-name{font-size:var(--ui-text-helper);font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.rt-ov-gap-meta{font-size:var(--ui-text-helper);color:var(--dsw-alias-label-secondary);margin-top:2px;display:flex;align-items:center;gap:6px;min-height:15px}
.rt-ov-bar{height:4px;border-radius:99px;background:var(--dsw-alias-border-l1);overflow:hidden;margin-top:4px}
.rt-ov-bar>div{height:100%;border-radius:99px}
.rt-ov-pts{flex:none;font-size:var(--ui-text-helper);font-weight:600;color:var(--dsw-alias-brand-primary);font-variant-numeric:tabular-nums}
.rt-ov-metric-row{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:8px}
.rt-ov-card:last-child .rt-ov-metric-row{grid-template-columns:repeat(3,minmax(0,1fr))}
.rt-ov-metric{border:1px solid var(--dsw-alias-border-l1);border-radius:9px;padding:8px 9px;background:var(--dsw-alias-bg-layer-2);min-width:0}
.rt-ov-metric-value{font-size:var(--ui-text-metric);font-weight:600;line-height:var(--ui-leading-body);font-variant-numeric:tabular-nums}
.rt-ov-metric-label{font-size:var(--ui-text-helper);color:var(--dsw-alias-label-secondary);margin-top:2px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.rt-ov-metric-sub{font-size:var(--ui-text-helper);color:var(--dsw-alias-label-secondary);opacity:.8}
.rt-ov-metric-ok .rt-ov-metric-value{color:#10b981}
.rt-ov-metric-warn .rt-ov-metric-value{color:#f59e0b}
.rt-ov-metric-mute .rt-ov-metric-value{color:var(--dsw-alias-label-secondary)}
.rt-ov-entry-list{margin-top:7px}
.rt-ov-entry{display:grid;grid-template-columns:8px 104px 54px minmax(0,1fr);align-items:center;gap:6px;padding:5px 0;border-top:1px solid var(--dsw-alias-border-l1);min-width:0}
.rt-ov-dot{width:6px;height:6px;border-radius:50%;background:#10b981;box-shadow:0 0 0 2px rgba(16,185,129,.16)}
.rt-ov-entry-addr{font-family:var(--ui-mono);font-size:var(--ui-text-helper);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.rt-ov-entry-kind{font-size:var(--ui-text-helper);color:var(--dsw-alias-label-secondary);border:1px solid var(--dsw-alias-border-l1);border-radius:999px;padding:1px 5px;text-align:center;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.rt-ov-entry-reach{font-size:var(--ui-text-helper);color:var(--dsw-alias-label-secondary);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.rt-ov-actions{display:flex;gap:6px;margin-top:8px}
.rt-ov-empty{font-size:var(--ui-text-helper);color:var(--dsw-alias-label-secondary);padding:8px 0}
@media(max-width:980px){.rt-ov-hero{grid-template-columns:1fr}.rt-ov-grid{grid-template-columns:1fr}.rt-ov-card-wide{grid-column:auto}.rt-ov-score{min-height:0}}

/* ── Opaque workbench theme ──────────────────────────────────────────────── */
.rt-dock,.rt-full{
  --rt-bg-base:#f3f5f8;
  --rt-bg-surface:#fff;
  --rt-bg-subtle:#f7f9fb;
  --rt-surf-2:var(--rt-bg-subtle);
  --rt-bg-raised:#fff;
  --rt-ink:#18212f;
  --rt-muted:#657488;
  --rt-border:#dce3eb;
  --rt-border-strong:#dce3eb;
  --rt-accent:#06716b;
  --rt-accent-strong:#06716b;
  --rt-accent-soft:#e5f5f2;
  --rt-accent-ink:#fff;
  --rt-danger:#dc2626;
  --rt-warning:#b45309;
  --rt-success:#059669;
  --rt-danger-bg:#fef2f2;
  --rt-warning-bg:#fffbeb;
  --rt-success-bg:#ecfdf5;
  --rt-shadow:rgba(15,23,42,.16);
  --dsw-alias-bg-base:var(--rt-bg-base);
  --dsw-alias-bg-layer-1:var(--rt-bg-surface);
  --dsw-alias-bg-layer-2:var(--rt-bg-subtle);
  --dsw-alias-label-primary:var(--rt-ink);
  --dsw-alias-label-secondary:var(--rt-muted);
  --dsw-alias-border-l1:var(--rt-border);
  --dsw-alias-border-l2:var(--rt-border-strong);
  --dsw-alias-brand-primary:var(--rt-accent);
  --dsw-alias-state-error-primary:var(--rt-danger);
  --dsw-alias-state-warn-primary:var(--rt-warning);
  color-scheme:light;
  background:var(--rt-bg-base);
  color:var(--rt-ink);
  font-size:var(--ui-text-body);
  line-height:var(--ui-leading-body);
  container-type:inline-size;
  container-name:rt;
}
.rt-dock[data-theme="dusk"],.rt-full[data-theme="dusk"],
.rt-dock[data-theme="dark"],.rt-full[data-theme="dark"],
.dshp-dock[data-theme="dusk"] .rt-dock,.dshp-dock[data-theme="dark"] .rt-dock,
:is(html[data-ds-dark-theme],body[data-ds-dark-theme]) :where(.rt-dock:not([data-theme="white"]):not([data-theme="light"])),
:is(html[data-ds-dark-theme],body[data-ds-dark-theme]) :where(.rt-full:not([data-theme="white"]):not([data-theme="light"])){
  --rt-bg-base:#0d141c;
  --rt-bg-surface:#151f2b;
  --rt-bg-subtle:#1c2a38;
  --rt-bg-raised:#151f2b;
  --rt-ink:#e8eff7;
  --rt-muted:#a5b5c7;
  --rt-border:#2b3c4c;
  --rt-border-strong:#2b3c4c;
  --rt-accent:#62d9c7;
  --rt-accent-strong:#62d9c7;
  --rt-accent-soft:#173e3b;
  --rt-accent-ink:#0d141c;
  --rt-danger:#f87171;
  --rt-warning:#fbbf24;
  --rt-success:#34d399;
  --rt-danger-bg:#40212a;
  --rt-warning-bg:#3b2f12;
  --rt-success-bg:#163a31;
  --rt-shadow:rgba(0,0,0,.42);
  color-scheme:dark;
}
.rt-dock[data-theme="white"],.rt-full[data-theme="white"],
.rt-dock[data-theme="light"],.rt-full[data-theme="light"],
.dshp-dock[data-theme="white"] .rt-dock,.dshp-dock[data-theme="light"] .rt-dock{
  --rt-bg-base:#f3f5f8;
  --rt-bg-surface:#fff;
  --rt-bg-subtle:#f7f9fb;
  --rt-bg-raised:#fff;
  --rt-ink:#18212f;
  --rt-muted:#657488;
  --rt-border:#dce3eb;
  --rt-border-strong:#dce3eb;
  --rt-accent:#06716b;
  --rt-accent-strong:#06716b;
  --rt-accent-soft:#e5f5f2;
  --rt-accent-ink:#fff;
  --rt-danger:#dc2626;
  --rt-warning:#b45309;
  --rt-success:#059669;
  --rt-danger-bg:#fef2f2;
  --rt-warning-bg:#fffbeb;
  --rt-success-bg:#ecfdf5;
  --rt-shadow:rgba(15,23,42,.16);
  color-scheme:light;
}
.rt-dock{background:var(--rt-bg-surface);border-color:var(--rt-border);box-shadow:0 18px 48px var(--rt-shadow)}
.rt-dock.rt-embedded{background:var(--rt-bg-base)!important}
.rt-full{background:var(--rt-bg-base);border-top-color:var(--rt-accent)}

.rt-chrome{display:flex;align-items:center;gap:8px;flex-wrap:wrap;border-bottom:1px solid var(--rt-border);background:var(--rt-bg-surface)}
.rt-cmd{display:flex;align-items:center;gap:6px;flex:0 1 auto;min-width:0}
.rt-chrome{padding:8px 10px;background:var(--rt-bg-surface);border-color:var(--rt-border)}
.rt-head{background:var(--rt-bg-surface);border-color:var(--rt-border)}
.rt-title{color:var(--rt-ink);font-size:var(--ui-text-body);font-weight:600;letter-spacing:normal}
.rt-dot{background:var(--rt-accent);box-shadow:0 0 0 3px var(--rt-accent-soft)}
.rt-nav{display:flex;flex:1 1 220px;min-width:0;gap:2px;background:var(--rt-bg-subtle);border:1px solid var(--rt-border);border-radius:8px;padding:2px}
.rt-tab-group{flex:1 1 0;display:inline-flex;align-items:center;justify-content:center;gap:5px;padding:6px 8px;font-size:var(--ui-text-control);min-height:30px;border:1px solid transparent;border-radius:6px;color:var(--rt-muted);background:var(--rt-bg-subtle);font-weight:600}
.rt-tab-group:hover{color:var(--rt-ink);background:var(--rt-bg-raised)}
.rt-tab-group.on{color:var(--rt-accent);background:var(--rt-accent-soft);border-color:var(--rt-border-strong);box-shadow:none}
.rt-subnav,.rt-tabs{background:var(--rt-bg-surface);border-color:var(--rt-border)}
.rt-subnav{display:flex;overflow-x:auto;flex-wrap:nowrap;border-bottom:1px solid var(--rt-border);scrollbar-width:thin;padding:6px 10px 8px;gap:4px}
.rt-tab{border:1px solid transparent;border-radius:6px;margin:0;padding:5px 10px;border-bottom:0;font-size:var(--ui-text-control);color:var(--rt-muted);background:var(--rt-bg-surface);transition:background .15s,color .15s,border-color .15s}
.rt-tab:hover{color:var(--rt-ink);background:var(--rt-bg-subtle)}
.rt-tab.on{color:var(--rt-accent);background:var(--rt-accent-soft);border-color:var(--rt-border-strong);font-weight:600}
.rt-tab-dot{box-shadow:0 0 0 2px var(--rt-bg-surface)}

.rt-btn,.rt-icon-btn,.rt-hbtn{border:1px solid var(--rt-border);border-radius:6px;color:var(--rt-ink);background:var(--rt-bg-surface)}
.rt-btn{padding:5px 10px;min-height:30px;font-weight:500}
.rt-btn{transition:background .15s,border-color .15s,color .15s}
.rt-icon-btn{width:100%;padding:6px 8px}
.rt-hbtn{padding:2px 8px}
.rt-btn:hover,.rt-icon-btn:hover,.rt-hbtn:hover{color:var(--rt-ink);background:var(--rt-bg-subtle);border-color:var(--rt-border-strong)}
.rt-btn-primary{background:var(--rt-accent);border-color:var(--rt-accent);color:var(--rt-accent-ink);box-shadow:none}
.rt-btn-primary:hover{background:var(--rt-accent-strong);border-color:var(--rt-accent-strong);color:var(--rt-accent-ink);filter:none}
.rt-btn:disabled{opacity:.5}
.rt-input,.rt-eng-select,.rt-textarea,.rt-score-form input,.rt-score-form select{color:var(--rt-ink);background:var(--rt-bg-surface);border:1px solid var(--rt-border);border-radius:6px}
.rt-input,.rt-eng-select{min-height:30px;padding:5px 8px}
.rt-input:hover,.rt-eng-select:hover{border-color:var(--rt-border-strong)}
.rt-input:focus,.rt-eng-select:focus,.rt-textarea:focus{border-color:var(--rt-accent);box-shadow:0 0 0 2px var(--rt-accent-soft);outline:none}
.rt-input option,.rt-eng-select option{background:var(--rt-bg-surface);color:var(--rt-ink)}
.rt-textarea{background:var(--rt-bg-surface);padding:8px}
.rt-cmd .rt-eng-select{min-width:132px;max-width:200px;flex:1 1 160px}
.rt-follow-dot{width:6px;height:6px;border-radius:50%;background:currentColor;flex:none}
.rt-follow{display:inline-flex;align-items:center;gap:5px;padding:0 8px;border:1px solid var(--rt-border);border-radius:6px;font-size:var(--ui-text-helper);white-space:nowrap;cursor:default;height:28px;background:var(--rt-bg-subtle);color:var(--rt-muted)}
.rt-follow.on{color:var(--rt-success);border-color:var(--rt-success);background:var(--rt-success-bg)}
.rt-follow.warn{color:var(--rt-warning);border-color:var(--rt-warning);background:var(--rt-warning-bg);cursor:pointer}

.rt-body,.rt-main,.rt-pane,.rt-table,.rt-chain,.rt-ap,.rt-ap-h,.rt-hflow-wrap,.rt-rep-list,.rt-ov-scroll{background:var(--rt-bg-base)}
.rt-side,.rt-list{background:var(--rt-bg-subtle);border-color:var(--rt-border);padding:8px}
.rt-seg,.rt-item{border:1px solid transparent;border-radius:6px;background:var(--rt-bg-subtle);transition:background .12s,border-color .12s}
.rt-seg:hover,.rt-item:hover{background:var(--rt-bg-surface);border-color:var(--rt-border)}
.rt-seg.on,.rt-item.on{background:var(--rt-accent-soft);border-color:var(--rt-accent);color:var(--rt-ink)}
.rt-toolbar{gap:6px;padding:8px 10px;background:var(--rt-bg-surface);border-bottom:1px solid var(--rt-border)}
.rt-toolbar-stack{flex-direction:column;align-items:stretch;gap:8px}
.rt-toolbar-row{display:flex;flex-wrap:wrap;align-items:center;gap:6px}
.rt-toolbar .rt-input{max-width:280px}
.rt-toolbar>span:first-child{font-size:var(--ui-text-body);font-weight:600;color:var(--rt-ink)}
.rt-livebar,.rt-concl,.rt-subtabs{background:var(--rt-bg-surface);border-color:var(--rt-border)}
.rt-concl{padding:6px 10px;gap:6px}
.rt-subtabs{padding:6px 10px 0;gap:4px}
.rt-concl-i{background:var(--rt-bg-surface);border-color:transparent;min-height:28px}
.rt-concl-i:hover{background:var(--rt-bg-subtle);border-color:var(--rt-border-strong)}
.rt-concl-i.on{background:var(--rt-accent-soft);border-color:var(--rt-accent);color:var(--rt-accent)}
.rt-subtab{background:var(--rt-bg-surface);color:var(--rt-muted)}
.rt-subtab:hover{background:var(--rt-bg-subtle);color:var(--rt-ink)}
.rt-subtab.on{background:var(--rt-accent-soft);color:var(--rt-accent);box-shadow:inset 0 -2px 0 var(--rt-accent)}

.rt-card,.rt-ov-score,.rt-ov-rail,.rt-ov-card,.rt-ov-metric,.rt-ov-score-tab,.rt-rep,.rt-hcol,.rt-evi,.rt-shots,.rt-modal-box{background:var(--rt-bg-surface);border-color:var(--rt-border);box-shadow:none}
.rt-card{border-radius:10px;padding:12px}
.rt-card h4{color:var(--rt-ink);font-size:var(--ui-text-section)}
.rt-ov-score-tab{color:var(--rt-ink)}
.rt-ov-score-tabs{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:8px;margin:2px 0 8px}
.rt-ov-score-tab{display:flex;flex-direction:column;gap:2px;text-align:left;font-family:var(--ui-font);cursor:pointer;padding:8px 10px;border:1px solid var(--rt-border);border-radius:8px;background:var(--rt-bg-surface)}
.rt-ov-score-tab:hover{background:var(--rt-bg-subtle)}
.rt-ov-score-tab.on{background:var(--rt-accent-soft);border-color:var(--rt-accent)}
.rt-ov-score-tab-label{font-size:var(--ui-text-helper);color:var(--rt-muted)}
.rt-ov-score-tab-value{font-size:var(--ui-text-metric);font-weight:600;letter-spacing:normal;font-variant-numeric:tabular-nums}
.rt-ov-score-tab-sub{font-size:var(--ui-text-helper);color:var(--rt-muted)}
.rt-ov-pts-got{color:#10b981}
.rt-ov-metric{background:var(--rt-bg-subtle)}
.rt-ov-gap:hover{background:var(--rt-bg-subtle)}
.rt-ov-stage.on{background:var(--rt-accent-soft)}
.rt-ov-stage:not(:last-child)::after{background:var(--rt-border)}
.rt-ov-node{box-shadow:none;opacity:1;background:var(--rt-bg-subtle);color:var(--rt-muted);border:1px solid var(--rt-border)}
.rt-ov-stage.has .rt-ov-node,.rt-ov-stage.on .rt-ov-node{background:var(--rt-accent);color:var(--rt-accent-ink);border-color:var(--rt-accent)}
.rt-ov-stage-name,.rt-ov-stage.on .rt-ov-stage-name,.rt-ov-stage-pts{color:var(--rt-ink)}
.rt-ov-stage.on .rt-ov-node{box-shadow:0 0 0 3px var(--rt-accent-soft)}
.rt-row,.rt-vrow,.rt-score-row{background:var(--rt-bg-surface);border-color:var(--rt-border);transition:background .12s}
.rt-row:hover,.rt-vrow:hover,.rt-score-row:hover{background:var(--rt-accent-soft)}
.rt-row.head,.rt-vrow.head,.rt-score-row.head{background:var(--rt-bg-subtle);color:var(--rt-muted);border-bottom-color:var(--rt-border-strong)}
.rt-row.head:hover,.rt-vrow.head:hover,.rt-score-row.head:hover{background:var(--rt-bg-subtle)}
.rt-score-group{background:var(--rt-bg-subtle);border-color:var(--rt-border);border-radius:6px}
.rt-empty{margin:16px auto;max-width:420px;padding:22px 16px;background:var(--rt-bg-subtle);border:1px dashed var(--rt-border-strong);border-radius:10px;color:var(--rt-muted)}
.rt-hint{border-radius:8px;border-style:solid;border-width:1px;background:var(--rt-warning-bg);border-color:var(--rt-warning);color:var(--rt-ink)}
.rt-err{color:var(--rt-danger)}
.rt-foot{background:var(--rt-bg-surface);border-color:var(--rt-border);padding:6px 12px;color:var(--rt-muted)}
.rt-tag{background:var(--rt-bg-subtle);border-color:var(--rt-border);color:var(--rt-muted)}
.rt-sev-info{background:var(--rt-bg-subtle);border-color:var(--rt-border);color:var(--rt-muted)}
.rt-code,.rt-clip-body,.rt-evi-body,.rt-hit-evi,.rt-atest-notes,.rt-rep-http,.rt-rep-trace,.rt-md{background:var(--rt-bg-subtle);border-color:var(--rt-border);color:var(--rt-ink)}
.rt-chip,.rt-flow-node,.rt-hflow-node,.rt-hit,.rt-atest,.rt-ap-hit,.rt-hit-row,.rt-ap-asset,.rt-ap-tunnel{background:var(--rt-bg-surface);border-color:var(--rt-border)}
.rt-evi-head,.rt-rep-req-head,.rt-ap-head,.rt-ap-goal,.rt-rep-stage,.rt-sec{background:var(--rt-bg-subtle);border-color:var(--rt-border)}
.rt-evi-body{border-top:0}
.rt-rep-tools{background:var(--rt-bg-base)}
.rt-rep{border-left-color:var(--rt-success)}
.rt-rep:hover{border-color:var(--rt-accent)}
.rt-foot-stats{letter-spacing:normal}
.rt-sec:hover,.rt-rep-stage:hover{background:var(--rt-bg-surface)}
.rt-modal{background:#0f172a}
.rt-modal-box{color:var(--rt-ink)}
.rt-shot-zoom{background:#0b1020}

.rt-dock *::-webkit-scrollbar,.rt-full *::-webkit-scrollbar{width:8px;height:8px}
.rt-dock *::-webkit-scrollbar-thumb,.rt-full *::-webkit-scrollbar-thumb{background:var(--rt-border-strong);border-radius:99px;border:2px solid transparent;background-clip:padding-box}
.rt-dock *::-webkit-scrollbar-thumb:hover,.rt-full *::-webkit-scrollbar-thumb:hover{background:var(--rt-muted)}
.rt-dock *::-webkit-scrollbar-track,.rt-full *::-webkit-scrollbar-track{background:var(--rt-bg-subtle)}

.rt-full .rt-body{max-width:1600px;padding-left:20px;padding-right:20px}
.rt-full .rt-chrome{padding:10px 18px}
.rt-full .rt-subnav{padding:8px 18px 10px}

.rt-ov-score-tabs{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:8px;margin:2px 0 8px}
.rt-ov-score-tab{display:flex;flex-direction:column;gap:2px;text-align:left;font-family:var(--ui-font);color:inherit;cursor:pointer;
  border:1px solid var(--rt-border);border-radius:8px;padding:8px 10px;background:var(--rt-bg-surface);transition:background .15s,border-color .15s}
.rt-ov-score-tab:hover{background:var(--rt-bg-subtle)}
.rt-ov-score-tab.on{border-color:var(--rt-accent);background:var(--rt-accent-soft)}
.rt-ov-score-tab-label{font-size:var(--ui-text-helper);color:var(--rt-muted)}
.rt-ov-score-tab-value{font-size:var(--ui-text-metric);font-weight:600;letter-spacing:normal;font-variant-numeric:tabular-nums}
.rt-ov-score-tab-sub{font-size:var(--ui-text-helper);color:var(--rt-muted)}
.rt-ov-pts-got{color:#10b981}

/* Preserve the existing semantic tag colors over the neutral chip surface. */
.rt-tag.rt-tag-passive{color:#8b5cf6;border-color:#8b5cf655;background:#8b5cf61a}
.rt-tag.rt-tag-active{color:#f59e0b;border-color:#f59e0b55;background:#f59e0b1a}
.rt-tag.rt-tag-live{color:#10b981;border-color:#10b98155;background:#10b9811a}
.rt-tag.rt-tag-warn{color:#ef4444;border-color:#ef444455;background:#ef44441a}

@container rt (max-width: 720px){
  .rt-ov-grid{grid-template-columns:1fr}
  .rt-ov-card-wide{grid-column:auto}
  .rt-ov-card:last-child .rt-ov-metric-row{grid-template-columns:repeat(2,minmax(0,1fr))}
  .rt-ov-stages{overflow-x:auto}
  .rt-ov-stage{min-width:72px}
}
@container rt (max-width: 560px){
  .rt-nav{flex:1 1 100%}
  .rt-cmd{flex:1 1 100%}
  .rt-cmd .rt-eng-select{max-width:none}
}
/* ── Report v2: templated delivery report ────────────────────────── */
.rt-r2{display:flex;flex-direction:column;min-height:0;height:100%}
.rt-r2-toolbar{flex-wrap:wrap}
.rt-r2-scroll{flex:1;min-height:0;overflow:auto;padding:14px 16px 28px}
.rt-r2-section{margin:0 0 26px}
.rt-r2-h2{font-size:var(--ui-text-section);font-weight:600;margin:0 0 10px;padding-bottom:7px;border-bottom:1px solid var(--dsw-alias-border-l1)}
.rt-r2-h3{font-size:var(--ui-text-section);font-weight:600;margin:14px 0 7px}
.rt-r2-h4{font-size:var(--ui-text-section);font-weight:600;margin:12px 0 5px}
.rt-r2-h5{font-size:var(--ui-text-section);font-weight:600;margin:10px 0 4px}
.rt-r2-proof-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(280px,1fr));gap:10px}
.rt-r2-proof{border:1px solid var(--dsw-alias-border-l1);border-radius:9px;padding:10px 11px;background:var(--dsw-alias-bg-layer-1);min-width:0}
.rt-r2-proof-head{display:flex;align-items:center;gap:7px;flex-wrap:wrap}
.rt-r2-proof-line{font-size:var(--ui-text-helper);margin-top:6px;line-height:var(--ui-leading-body);word-break:break-word}
.rt-r2-muted{font-size:var(--ui-text-helper);color:var(--dsw-alias-label-secondary)}
.rt-r2-empty{font-size:var(--ui-text-helper);color:var(--dsw-alias-label-secondary);padding:7px 0}
.rt-r2-table-wrap{overflow:auto;border:1px solid var(--dsw-alias-border-l1);border-radius:8px;margin:7px 0}
.rt-r2-table{width:100%;border-collapse:collapse;font-size:var(--ui-text-helper);min-width:520px}
.rt-r2-table th,.rt-r2-table td{padding:6px 8px;border-bottom:1px solid var(--dsw-alias-border-l1);text-align:left;vertical-align:top;word-break:break-word}
.rt-r2-table th{background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-secondary);font-weight:600;white-space:nowrap}
.rt-r2-table tr:last-child td{border-bottom:0}
.rt-r2-code{border:1px solid var(--dsw-alias-border-l1);border-radius:7px;margin:6px 0;overflow:hidden}
.rt-r2-code-head{display:flex;align-items:center;gap:6px;padding:4px 7px;background:var(--dsw-alias-bg-layer-2);font-size:var(--ui-text-helper);color:var(--dsw-alias-label-secondary)}
.rt-r2-pre{margin:0;padding:8px;max-height:260px;overflow:auto;white-space:pre-wrap;word-break:break-all;font-size:var(--ui-text-helper);line-height:var(--ui-leading-body);font-family:var(--ui-mono);background:var(--dsw-alias-bg-base)}
.rt-r2-item{border-left:2px solid color-mix(in srgb,var(--dsw-alias-brand-primary) 35%,transparent);padding:2px 0 3px 9px;margin:8px 0 10px}
.rt-r2-item-line{font-size:var(--ui-text-helper);line-height:var(--ui-leading-body);margin-top:3px;word-break:break-word}
.rt-r2-gap{border:1px dashed var(--dsw-alias-state-error-primary);color:var(--dsw-alias-state-error-primary);border-radius:5px;padding:5px 7px;margin-top:5px;font-size:var(--ui-text-helper)}
.rt-r2-group{border-top:1px dashed var(--dsw-alias-border-l1);padding-top:4px;margin-top:8px}
.rt-r2-asset{margin-left:4px}
@media(max-width:720px){.rt-r2-scroll{padding:10px}.rt-r2-table{min-width:460px}}

/* Product workspace layout: persistent navigation, project context, content. */
.dshp-dock-body{container-type:inline-size;container-name:workspace}
.dshp-dock-body .rt-dock.rt-embedded,.rt-full{display:grid!important;grid-template-columns:164px minmax(0,1fr);grid-template-rows:minmax(54px,auto) auto minmax(0,1fr) auto;gap:0;overflow:hidden;background:var(--rt-bg-base);font-family:var(--ui-font);font-size:var(--ui-text-body);line-height:var(--ui-leading-body)}
.rt-embedded>.rt-chrome,.rt-full>.rt-chrome{display:contents}
.rt-full>.rt-chrome>.rt-title{display:none}
.rt-embedded>.rt-chrome>.rt-nav,.rt-full>.rt-chrome>.rt-nav{grid-column:1;grid-row:1/-1;display:flex;flex-direction:column;justify-content:flex-start;align-items:stretch;gap:5px;min-width:0;margin:0;padding:22px 12px;background:#10232e;border:0;border-right:1px solid #233c47;border-radius:0;overflow:auto;color:#b7cad6}
.rt-embedded .rt-nav::before,.rt-full .rt-nav::before{content:"Điều hướng công việc";display:block;padding:0 13px 14px;color:#88a7b7;font-size:var(--ui-text-helper);font-weight:600;letter-spacing:normal}
.rt-embedded .rt-nav .rt-tab-group,.rt-full .rt-nav .rt-tab-group{position:relative;display:flex;align-items:center;justify-content:flex-start;flex:0 0 auto;gap:10px;min-height:42px;margin:0;padding:10px 12px;border:1px solid transparent;border-radius:7px;background:transparent;color:#b7cad6;font-size:var(--ui-text-control);font-weight:500;white-space:nowrap;box-shadow:none;transition:background .15s,color .15s}
.rt-embedded .rt-nav .rt-tab-group:hover,.rt-full .rt-nav .rt-tab-group:hover{color:#fff;background:#1c3642}
.rt-embedded .rt-nav .rt-tab-group.on,.rt-full .rt-nav .rt-tab-group.on{background:#1a4449;color:#a4f4e5;border-color:#2b5b5e;font-weight:600}
.rt-nav .rt-tab-group::before{content:"";display:block;flex:none;width:17px;height:17px;background:currentColor;mask-repeat:no-repeat;mask-position:center;mask-size:contain;-webkit-mask-repeat:no-repeat;-webkit-mask-position:center;-webkit-mask-size:contain}
.rt-nav .rt-tab-group .rt-tab-dot{margin-left:auto}
.rt-embedded>.rt-chrome>.rt-cmd,.rt-full>.rt-chrome>.rt-cmd{grid-column:2;grid-row:1;display:flex;align-items:center;justify-content:flex-end;flex-wrap:wrap;gap:8px;width:100%;min-width:0;padding:10px 24px;background:var(--rt-bg-surface);border-bottom:1px solid var(--rt-border)}
.rt-embedded .rt-cmd::before,.rt-full .rt-cmd::before{content:"Dự án hiện tại";margin-right:auto;color:var(--rt-muted);font-size:var(--ui-text-helper);font-weight:600;letter-spacing:normal}
.rt-embedded .rt-cmd .rt-eng-select,.rt-full .rt-cmd .rt-eng-select{flex:0 1 260px;min-width:120px;max-width:300px;background:var(--rt-bg-subtle);border-color:var(--rt-border);font-weight:500}
.rt-embedded>.rt-subnav,.rt-full>.rt-subnav{grid-column:2;grid-row:2;display:flex;gap:4px;padding:8px 24px;background:var(--rt-bg-surface);border-bottom:1px solid var(--rt-border);overflow:auto}
.dshp-dock-body .rt-subnav .rt-tab,.rt-full>.rt-subnav .rt-tab{padding:7px 12px;border:1px solid transparent;border-radius:6px;margin:0;background:var(--rt-bg-surface);color:var(--rt-muted);font-size:var(--ui-text-control);white-space:nowrap}
.dshp-dock-body .rt-subnav .rt-tab.on,.rt-full>.rt-subnav .rt-tab.on{background:var(--rt-accent-soft);border-color:var(--rt-border);color:var(--rt-accent);font-weight:600}
.rt-embedded>.rt-body,.rt-full>.rt-body{grid-column:2;grid-row:3;display:flex;min-height:0;min-width:0;width:100%;max-width:none;margin:0;padding:0;overflow:hidden;background:var(--rt-bg-base)}
.rt-embedded>.rt-foot,.rt-full>.rt-foot{grid-column:2;grid-row:4;display:flex;flex-wrap:wrap;align-items:center;gap:6px;min-height:32px;padding:7px 24px;border-top:1px solid var(--rt-border);background:var(--rt-bg-surface);font-size:var(--ui-text-helper);color:var(--rt-muted)}
.rt-ov-head{padding:22px 24px 16px;gap:12px}
.rt-ov-title{font-size:var(--ui-text-metric);line-height:var(--ui-leading-body);font-weight:600;letter-spacing:normal;max-width:none}
.rt-ov-stage-chip{font-size:var(--ui-text-helper);padding:3px 8px;background:var(--rt-bg-surface);border-color:var(--rt-border);border-radius:5px}
.rt-ov-scroll{padding:0 24px 24px}
.rt-ov-hero{display:grid;grid-template-columns:minmax(230px,.85fr) minmax(0,1.5fr);gap:16px}
.rt-ov-score{display:grid;grid-template-columns:minmax(0,1fr) auto;grid-template-rows:auto 1fr auto;gap:4px 12px;min-height:156px;padding:22px 24px;border:1px solid var(--rt-border);border-radius:10px;background:var(--rt-bg-surface);box-shadow:0 2px 3px #0b172508}
.rt-ov-score-label{grid-column:1;grid-row:1;font-size:var(--ui-text-helper);letter-spacing:normal}
.rt-ov-score-num{grid-column:1;grid-row:2;align-self:center;font-size:var(--ui-text-metric);font-weight:600;letter-spacing:normal;color:var(--rt-accent)}
.rt-ov-score-sub{grid-column:1;grid-row:3;min-width:0;font-size:var(--ui-text-helper)}
.rt-ov-score>.rt-btn{grid-column:2;grid-row:1/4;align-self:center;margin:0}
.rt-ov-rail{display:flex;flex-direction:column;justify-content:center;padding:20px 18px;border:1px solid var(--rt-border);border-radius:10px;background:var(--rt-bg-surface)}
.rt-ov-rail-head{font-size:var(--ui-text-helper);letter-spacing:normal;margin-bottom:14px}
.rt-ov-stage{padding:5px 9px;border-radius:7px}
.rt-ov-stage.on{background:var(--rt-accent-soft);border-radius:7px}
.rt-ov-node{width:24px;height:24px;margin-bottom:8px;font-size:var(--ui-text-helper)}
.rt-ov-stage:not(:last-child)::after{top:17px;left:32px;right:0}
.rt-ov-stage-name{font-size:var(--ui-text-helper);font-weight:600}
.rt-ov-stage-pts{font-size:var(--ui-text-body);line-height:var(--ui-leading-body)}
.rt-ov-stage-cum{font-size:var(--ui-text-helper)}
.rt-ov-grid{gap:16px;margin-top:16px}
.rt-ov-card{border:1px solid var(--rt-border);border-radius:10px;padding:18px 20px;background:var(--rt-bg-surface);box-shadow:0 2px 3px #0b172505}
.rt-ov-card-title{font-size:var(--ui-text-section);font-weight:600}
.rt-ov-score-tabs{gap:10px;margin:6px 0 10px}
.rt-ov-score-tab{padding:14px;border:1px solid var(--rt-border);border-radius:8px;background:var(--rt-bg-surface)}
.rt-ov-score-tab.on{background:var(--rt-accent-soft);border-color:var(--rt-accent)}
.rt-ov-score-tab-value{font-size:var(--ui-text-metric);line-height:var(--ui-leading-body);font-weight:600}
.rt-ov-score-tab-label,.rt-ov-score-tab-sub{font-size:var(--ui-text-helper)}
.rt-ov-metric{padding:13px;border:0;background:var(--rt-bg-subtle);border-radius:7px}
.rt-ov-metric-value{font-size:var(--ui-text-metric);font-weight:600;letter-spacing:normal}
.rt-card{padding:18px 20px;margin-bottom:16px;border:1px solid var(--rt-border);border-radius:10px;background:var(--rt-bg-surface);box-shadow:none}
.rt-card h4{font-size:var(--ui-text-section);font-weight:600;margin-bottom:12px}
.rt-toolbar{padding:12px 24px;gap:8px;background:var(--rt-bg-surface);border-color:var(--rt-border)}
.rt-toolbar-row{gap:8px}
.rt-input,.rt-eng-select{min-height:34px;padding:7px 10px;border-radius:6px;background:var(--rt-bg-surface);font-size:var(--ui-text-control)}
.rt-btn{min-height:32px;padding:6px 12px;border-radius:6px;background:var(--rt-bg-surface);font-size:var(--ui-text-control);font-weight:500;border-color:var(--rt-border);box-shadow:none}
.rt-btn-primary{background:var(--rt-accent);border-color:var(--rt-accent);color:var(--rt-accent-ink)}
.rt-btn-primary:hover{background:var(--rt-accent-strong);color:var(--rt-accent-ink)}
.rt-concl{padding:10px 24px;background:var(--rt-bg-subtle);gap:8px}
.rt-subtabs{padding:8px 24px 0;background:var(--rt-bg-surface)}
.rt-subtab{font-size:var(--ui-text-control);padding:8px 12px}
.rt-row,.rt-vrow,.rt-score-row{padding:10px 16px;min-height:42px;font-size:var(--ui-text-helper);border-bottom-color:var(--rt-border)}
.rt-row.head,.rt-vrow.head,.rt-score-row.head{min-height:36px;padding:9px 16px;background:var(--rt-bg-subtle);font-size:var(--ui-text-helper);font-weight:600;letter-spacing:normal}
.rt-tag,.rt-sev,.rt-test,.rt-pri{border-radius:5px;font-size:var(--ui-text-helper);padding:2px 6px}
.rt-side,.rt-list{padding:12px;background:var(--rt-bg-subtle)}
.rt-item,.rt-seg{padding:10px 12px;border-radius:6px;margin-bottom:6px}
.rt-pane{padding:20px 24px}
.rt-empty{max-width:520px;margin:32px auto;padding:32px 24px;border:1px dashed var(--rt-border-strong);border-radius:10px;background:var(--rt-bg-surface);font-size:var(--ui-text-helper);line-height:var(--ui-leading-body)}
.rt-kb,.rt-kb-cat,.rt-evi,.rt-shots{border-radius:8px;box-shadow:none}
.rt-kb-head{padding:12px 14px}
.rt-kb-sub{padding:0 14px 12px}
.rt-kb-body{padding:0 14px 14px}
.rt-markdown{font-size:13px;line-height:1.8}
.rt-markdown h1,.rt-markdown h2,.rt-markdown h3{letter-spacing:-.02em}
.rt-code,.rt-md,.rt-rep-http,.rt-clip-body,.rt-evi-body{border-radius:6px;padding:12px 14px;font-size:var(--ui-text-helper);line-height:var(--ui-leading-body)}
.rt-rep-list{padding:20px 24px}
.rt-rep-tools{gap:8px;padding:0 0 14px}
.rt-rep{border:1px solid var(--rt-border);border-left:3px solid var(--rt-accent);border-radius:8px;margin-bottom:12px;padding:14px;background:var(--rt-bg-surface)}
.rt-dock button:focus-visible,.rt-full button:focus-visible,.rt-tab-group:focus-visible{outline:2px solid var(--rt-accent);outline-offset:2px}
@container rt (max-width:1080px){.rt-ov-hero{grid-template-columns:minmax(0,1fr)}.rt-ov-score{min-height:132px}.rt-ov-score-num{font-size:var(--ui-text-metric)}}
@container workspace (max-width:760px){
 .dshp-dock-body .rt-dock.rt-embedded{grid-template-columns:112px minmax(0,1fr)}
 .rt-embedded>.rt-chrome>.rt-nav{padding:16px 7px}
 .rt-embedded .rt-nav::before{padding:0 9px 12px;font-size:var(--ui-text-helper)}
 .rt-embedded .rt-nav .rt-tab-group{font-size:var(--ui-text-control);padding:9px 8px;gap:7px}
 .rt-embedded .rt-nav .rt-tab-group::before{width:15px;height:15px}
 .rt-embedded>.rt-chrome>.rt-cmd,.rt-embedded>.rt-subnav,.rt-embedded>.rt-foot{padding-left:16px;padding-right:16px}
 .rt-ov-head{padding:18px 16px 12px}.rt-ov-scroll{padding:0 16px 16px}.rt-pane{padding:16px}.rt-toolbar{padding:10px 16px}.rt-concl{padding:8px 16px}.rt-subtabs{padding-left:16px;padding-right:16px}.rt-rep-list{padding:16px}
 .rt-ov-title{font-size:var(--ui-text-body)}.rt-ov-card{padding:16px}.rt-ov-score{padding:18px}.rt-ov-rail{padding:16px 12px}
}
@container workspace (max-width:560px){
 .dshp-dock-body .rt-dock.rt-embedded{grid-template-columns:minmax(0,1fr);grid-template-rows:auto auto auto minmax(0,1fr) auto}
 .rt-embedded>.rt-chrome>.rt-nav{grid-column:1;grid-row:1;flex-direction:row;gap:4px;padding:8px;overflow-x:auto;border-right:0}
 .rt-embedded .rt-nav::before,.rt-embedded .rt-nav .rt-tab-group::before{display:none}
 .rt-embedded .rt-nav .rt-tab-group{flex:1 0 auto;min-height:34px;padding:7px 10px;justify-content:center;font-size:var(--ui-text-control)}
 .rt-embedded>.rt-chrome>.rt-cmd{grid-column:1;grid-row:2;padding:10px 12px}
 .rt-embedded .rt-cmd::before{display:none}
 .rt-embedded .rt-cmd .rt-eng-select{max-width:none;flex:1;min-width:0}
 .rt-embedded>.rt-subnav{grid-column:1;grid-row:3;padding:7px 12px}
 .rt-embedded>.rt-body{grid-column:1;grid-row:4}
 .rt-embedded>.rt-foot{grid-column:1;grid-row:5;padding:7px 12px}
 .rt-ov-head{padding:16px 12px 12px}.rt-ov-scroll{padding:0 12px 12px}.rt-ov-card{padding:14px}.rt-toolbar{padding:10px 12px}.rt-pane,.rt-rep-list{padding:12px}
 .rt-ov-score{grid-template-columns:minmax(0,1fr);padding:18px}.rt-ov-score>.rt-btn{grid-column:1;grid-row:4;justify-self:start;margin-top:8px}
}
@media(max-width:760px){.rt-full{grid-template-columns:112px minmax(0,1fr)}.rt-full>.rt-chrome>.rt-nav{padding:16px 7px}.rt-full .rt-nav .rt-tab-group{font-size:var(--ui-text-control);padding:9px 8px;gap:7px}.rt-full .rt-nav::before{font-size:var(--ui-text-helper);padding:0 9px 12px}.rt-full .rt-nav .rt-tab-group::before{width:15px;height:15px}}
@media(max-width:560px){.rt-full{grid-template-columns:minmax(0,1fr);grid-template-rows:auto auto auto minmax(0,1fr) auto}.rt-full>.rt-chrome>.rt-nav{grid-column:1;grid-row:1;flex-direction:row;gap:4px;padding:8px;overflow-x:auto;border-right:0}.rt-full .rt-nav::before,.rt-full .rt-nav .rt-tab-group::before{display:none}.rt-full .rt-nav .rt-tab-group{flex:1 0 auto;min-height:34px;padding:7px 10px;justify-content:center;font-size:var(--ui-text-control)}.rt-full>.rt-chrome>.rt-cmd{grid-column:1;grid-row:2;padding:10px 12px}.rt-full .rt-cmd::before{display:none}.rt-full .rt-cmd .rt-eng-select{max-width:none;flex:1;min-width:0}.rt-full>.rt-subnav{grid-column:1;grid-row:3;padding:7px 12px}.rt-full>.rt-body{grid-column:1;grid-row:4}.rt-full>.rt-foot{grid-column:1;grid-row:5;padding:7px 12px}}
@media(prefers-reduced-motion:reduce){.rt-tab-group,.rt-btn,.rt-row,.rt-vrow,.rt-score-row{transition:none}}
.rt-nav .rt-tab-group:nth-of-type(1)::before{mask-image:url("data:image/svg+xml,%3Csvg%20xmlns%3D%22http%3A%2F%2Fwww.w3.org%2F2000%2Fsvg%22%20viewBox%3D%220%200%2024%2024%22%20fill%3D%22none%22%20stroke%3D%22black%22%20stroke-width%3D%221.6%22%20stroke-linecap%3D%22round%22%20stroke-linejoin%3D%22round%22%3E%3Cpath%20d%3D%22M4%2019V5m0%2014h16M8%2015l4-5%204%202%204-7%22%2F%3E%3C%2Fsvg%3E");-webkit-mask-image:url("data:image/svg+xml,%3Csvg%20xmlns%3D%22http%3A%2F%2Fwww.w3.org%2F2000%2Fsvg%22%20viewBox%3D%220%200%2024%2024%22%20fill%3D%22none%22%20stroke%3D%22black%22%20stroke-width%3D%221.6%22%20stroke-linecap%3D%22round%22%20stroke-linejoin%3D%22round%22%3E%3Cpath%20d%3D%22M4%2019V5m0%2014h16M8%2015l4-5%204%202%204-7%22%2F%3E%3C%2Fsvg%3E")}
.rt-nav .rt-tab-group:nth-of-type(2)::before{mask-image:url("data:image/svg+xml,%3Csvg%20xmlns%3D%22http%3A%2F%2Fwww.w3.org%2F2000%2Fsvg%22%20viewBox%3D%220%200%2024%2024%22%20fill%3D%22none%22%20stroke%3D%22black%22%20stroke-width%3D%221.6%22%20stroke-linecap%3D%22round%22%20stroke-linejoin%3D%22round%22%3E%3Crect%20x%3D%224%22%20y%3D%224%22%20width%3D%226%22%20height%3D%226%22%20rx%3D%221%22%2F%3E%3Crect%20x%3D%2214%22%20y%3D%224%22%20width%3D%226%22%20height%3D%226%22%20rx%3D%221%22%2F%3E%3Crect%20x%3D%224%22%20y%3D%2214%22%20width%3D%226%22%20height%3D%226%22%20rx%3D%221%22%2F%3E%3Crect%20x%3D%2214%22%20y%3D%2214%22%20width%3D%226%22%20height%3D%226%22%20rx%3D%221%22%2F%3E%3C%2Fsvg%3E");-webkit-mask-image:url("data:image/svg+xml,%3Csvg%20xmlns%3D%22http%3A%2F%2Fwww.w3.org%2F2000%2Fsvg%22%20viewBox%3D%220%200%2024%2024%22%20fill%3D%22none%22%20stroke%3D%22black%22%20stroke-width%3D%221.6%22%20stroke-linecap%3D%22round%22%20stroke-linejoin%3D%22round%22%3E%3Crect%20x%3D%224%22%20y%3D%224%22%20width%3D%226%22%20height%3D%226%22%20rx%3D%221%22%2F%3E%3Crect%20x%3D%2214%22%20y%3D%224%22%20width%3D%226%22%20height%3D%226%22%20rx%3D%221%22%2F%3E%3Crect%20x%3D%224%22%20y%3D%2214%22%20width%3D%226%22%20height%3D%226%22%20rx%3D%221%22%2F%3E%3Crect%20x%3D%2214%22%20y%3D%2214%22%20width%3D%226%22%20height%3D%226%22%20rx%3D%221%22%2F%3E%3C%2Fsvg%3E")}
.rt-nav .rt-tab-group:nth-of-type(3)::before{mask-image:url("data:image/svg+xml,%3Csvg%20xmlns%3D%22http%3A%2F%2Fwww.w3.org%2F2000%2Fsvg%22%20viewBox%3D%220%200%2024%2024%22%20fill%3D%22none%22%20stroke%3D%22black%22%20stroke-width%3D%221.6%22%20stroke-linecap%3D%22round%22%20stroke-linejoin%3D%22round%22%3E%3Cpath%20d%3D%22m12%203%208%204v5c0%205-8%209-8%209s-8-4-8-9V7l8-4Z%22%2F%3E%3Cpath%20d%3D%22m8%2012%203%203%205-6%22%2F%3E%3C%2Fsvg%3E");-webkit-mask-image:url("data:image/svg+xml,%3Csvg%20xmlns%3D%22http%3A%2F%2Fwww.w3.org%2F2000%2Fsvg%22%20viewBox%3D%220%200%2024%2024%22%20fill%3D%22none%22%20stroke%3D%22black%22%20stroke-width%3D%221.6%22%20stroke-linecap%3D%22round%22%20stroke-linejoin%3D%22round%22%3E%3Cpath%20d%3D%22m12%203%208%204v5c0%205-8%209-8%209s-8-4-8-9V7l8-4Z%22%2F%3E%3Cpath%20d%3D%22m8%2012%203%203%205-6%22%2F%3E%3C%2Fsvg%3E")}
.rt-nav .rt-tab-group:nth-of-type(4)::before{mask-image:url("data:image/svg+xml,%3Csvg%20xmlns%3D%22http%3A%2F%2Fwww.w3.org%2F2000%2Fsvg%22%20viewBox%3D%220%200%2024%2024%22%20fill%3D%22none%22%20stroke%3D%22black%22%20stroke-width%3D%221.6%22%20stroke-linecap%3D%22round%22%20stroke-linejoin%3D%22round%22%3E%3Cpath%20d%3D%22M14%203H5v18h14V8l-5-5Z%22%2F%3E%3Cpath%20d%3D%22M14%203v5h5M8%2012h8M8%2016h6%22%2F%3E%3C%2Fsvg%3E");-webkit-mask-image:url("data:image/svg+xml,%3Csvg%20xmlns%3D%22http%3A%2F%2Fwww.w3.org%2F2000%2Fsvg%22%20viewBox%3D%220%200%2024%2024%22%20fill%3D%22none%22%20stroke%3D%22black%22%20stroke-width%3D%221.6%22%20stroke-linecap%3D%22round%22%20stroke-linejoin%3D%22round%22%3E%3Cpath%20d%3D%22M14%203H5v18h14V8l-5-5Z%22%2F%3E%3Cpath%20d%3D%22M14%203v5h5M8%2012h8M8%2016h6%22%2F%3E%3C%2Fsvg%3E")}
.rt-nav .rt-tab-group:nth-of-type(5)::before{mask-image:url("data:image/svg+xml,%3Csvg%20xmlns%3D%22http%3A%2F%2Fwww.w3.org%2F2000%2Fsvg%22%20viewBox%3D%220%200%2024%2024%22%20fill%3D%22none%22%20stroke%3D%22black%22%20stroke-width%3D%221.6%22%20stroke-linecap%3D%22round%22%20stroke-linejoin%3D%22round%22%3E%3Cpath%20d%3D%22M3%207V5h7l2%203h9v12H3V7Z%22%2F%3E%3C%2Fsvg%3E");-webkit-mask-image:url("data:image/svg+xml,%3Csvg%20xmlns%3D%22http%3A%2F%2Fwww.w3.org%2F2000%2Fsvg%22%20viewBox%3D%220%200%2024%2024%22%20fill%3D%22none%22%20stroke%3D%22black%22%20stroke-width%3D%221.6%22%20stroke-linecap%3D%22round%22%20stroke-linejoin%3D%22round%22%3E%3Cpath%20d%3D%22M3%207V5h7l2%203h9v12H3V7Z%22%2F%3E%3C%2Fsvg%3E")}

/* A collapsed report disclosure must not reserve half of the content pane. */
.rt-dock details.rt-pane,.rt-full details.rt-pane{flex:0 0 auto;min-height:0;max-height:46%;margin:16px 24px 0!important;padding:14px 16px;border:1px solid var(--rt-border);border-radius:8px;background:var(--rt-bg-surface);overflow:auto}
.rt-dock details.rt-pane:not([open]),.rt-full details.rt-pane:not([open]){max-height:none;overflow:visible}
.rt-dock details.rt-pane>summary,.rt-full details.rt-pane>summary{font-size:var(--ui-text-helper);color:var(--rt-ink);line-height:var(--ui-leading-body)}
.rt-dock details.rt-pane[open]>summary,.rt-full details.rt-pane[open]>summary{padding-bottom:12px;border-bottom:1px solid var(--rt-border);margin-bottom:12px}
@container workspace (max-width:560px){.rt-dock details.rt-pane{margin:12px 12px 0!important;padding:12px}}
/* __DSH_PRODUCT_SKIN_BEGIN__ */
/* One product palette for the outer frame, clean workspace, drill and dialogs.
 * Component styles consume these tokens; they do not define local palettes. */
:where(.dshp-dock,.dshp-root,.dshp-auth-mask,.dshp-modal-bg,.dshp-restart-mask,.rt-dock,.rt-full) {
  --ui-canvas:#f1f4f8;
  --ui-surface:#ffffff;
  --ui-subtle:#f6f8fb;
  --ui-hover:#e9eef6;
  --ui-line:#d8e1ed;
  --ui-line-strong:#a3b5cc;
  --ui-text:#1b2b40;
  --ui-muted:#43566d;
  --ui-primary:#336acb;
  --ui-primary-hover:#2a59ad;
  --ui-on-primary:#ffffff;
  --ui-link:#285fbb;
  --ui-selected:#e6effd;
  --ui-selected-text:#204f9b;
  --ui-nav:#ffffff;
  --ui-success:#237650;
  --ui-success-bg:#e9f5ee;
  --ui-warning:#8e641a;
  --ui-warning-bg:#fcf4e4;
  --ui-danger:#b63f3f;
  --ui-danger-bg:#fbeeed;
  --ui-on-danger:#ffffff;
  --ui-radius-control:9px;
  --ui-radius-panel:16px;
  --ui-control-height:34px;
  --ui-feature-surface:#193858;
  --ui-feature-line:#45698e;
  --ui-feature-text:#f0f6ff;
  --ui-feature-muted:#bed2ea;
  --ui-feature-accent:#91baff;
  --ui-feature-hover:#254c73;
  --ui-panel-shadow:0 4px 14px rgb(27 43 64 / .04);

  --ui-glass-surface:rgb(249 253 255 / .66);
  --ui-glass-chrome:rgb(238 249 255 / .72);
  --ui-glass-dense:rgb(245 251 255 / .9);
  --ui-glass-edge:rgb(255 255 255 / .82);
  --ui-glass-rim:rgb(255 255 255 / .94);
  --ui-glass-glint:rgb(255 255 255 / .44);
  --ui-glass-shadow:0 14px 34px rgb(35 77 104 / .09),inset 0 1px 0 var(--ui-glass-rim),inset 1px 0 0 rgb(255 255 255 / .35),inset 0 -1px 0 rgb(38 83 113 / .08);
  --ui-glass-control-shadow:inset 0 1px 0 rgb(255 255 255 / .6),0 2px 5px rgb(33 64 90 / .04);
  --ui-water-base:#c8e0ec;
  --ui-water-deep:#b6cbdf;
  --ui-water-light:rgb(238 255 255 / .92);
  --ui-water-blue:rgb(128 181 219 / .54);
  --ui-water-refraction:rgb(255 255 255 / .36);
  --ui-text-display:40px;
  --ui-text-body:13px;
  --ui-text-control:13px;
  --ui-text-label:12px;
  --ui-text-helper:12px;
  --ui-text-table:12px;
  --ui-text-title:22px;
  --ui-text-section:14px;
  --ui-text-metric:24px;
  --ui-leading-body:1.6;
  --ui-leading-control:1.3;
  --ui-leading-title:1.35;
  --ui-space-1:4px;
  --ui-space-2:8px;
  --ui-space-3:12px;
  --ui-space-4:16px;
  --ui-space-5:24px;
  --ui-font:-apple-system,BlinkMacSystemFont,"Segoe UI","PingFang SC",sans-serif;
  --ui-mono:"SFMono-Regular",Consolas,"Liberation Mono",monospace;
  font-family:var(--ui-font);
  --ui-scheme:light;
  accent-color:var(--ui-primary);
  -webkit-tap-highlight-color:transparent;
}

/* Explicit host/theme choices take precedence over the system fallback. */
@media (prefers-color-scheme:dark) {
  :where(.dshp-dock,.dshp-root,.dshp-auth-mask,.dshp-modal-bg,.dshp-restart-mask,.rt-dock,.rt-full):where(:not([data-theme=white]):not([data-theme=light])) {
    --ui-canvas:#111820;--ui-surface:#1b2430;--ui-subtle:#222e3d;--ui-hover:#29394b;
    --ui-line:#344253;--ui-line-strong:#52657b;--ui-text:#e9f0f8;--ui-muted:#a5b3c5;
    --ui-link:#9ac3ff;--ui-selected:#243c5c;--ui-selected-text:#bed9ff;--ui-nav:#141c26;
    --ui-success:#82c7a4;--ui-success-bg:#1d342b;--ui-warning:#dfbd78;--ui-warning-bg:#382f20;
    --ui-danger:#f0a3a2;--ui-danger-bg:#3a2529;--ui-on-danger:#25161b;
    --ui-feature-surface:#18304c;--ui-feature-line:#3b5e86;--ui-feature-text:#f0f6ff;--ui-feature-muted:#aec7e8;--ui-feature-hover:#234568;
    --ui-panel-shadow:0 5px 16px rgb(0 0 0 / .14);
    --ui-glass-surface:rgb(22 48 66 / .68);
    --ui-glass-chrome:rgb(15 34 49 / .74);
    --ui-glass-dense:rgb(17 37 53 / .93);
    --ui-glass-edge:rgb(173 220 248 / .24);
    --ui-glass-rim:rgb(211 239 255 / .3);
    --ui-glass-glint:rgb(190 229 255 / .1);
    --ui-glass-shadow:0 14px 34px rgb(0 10 22 / .2),inset 0 1px 0 var(--ui-glass-rim),inset 1px 0 0 rgb(185 228 255 / .09),inset 0 -1px 0 rgb(0 11 25 / .26);
    --ui-glass-control-shadow:inset 0 1px 0 rgb(216 241 255 / .12),0 2px 5px rgb(0 10 22 / .12);
    --ui-water-base:#0b2333;
    --ui-water-deep:#10293f;
    --ui-water-light:rgb(70 166 191 / .42);
    --ui-water-blue:rgb(49 101 177 / .43);
    --ui-water-refraction:rgb(175 235 255 / .13);
    --ui-scheme:dark;
  }
}
:where([dark],[data-theme=dusk],[data-theme=dark],html[data-ds-dark-theme],body[data-ds-dark-theme]) :where(.dshp-dock,.dshp-root,.dshp-auth-mask,.dshp-modal-bg,.dshp-restart-mask,.rt-dock,.rt-full):where(:not([data-theme=white]):not([data-theme=light])),
:where(.dshp-dock,.dshp-root,.dshp-auth-mask,.dshp-modal-bg,.dshp-restart-mask,.rt-dock,.rt-full):is([dark],[data-theme=dusk],[data-theme=dark]) {
  --ui-canvas:#111820;--ui-surface:#1b2430;--ui-subtle:#222e3d;--ui-hover:#29394b;
  --ui-line:#344253;--ui-line-strong:#52657b;--ui-text:#e9f0f8;--ui-muted:#a5b3c5;
  --ui-link:#9ac3ff;--ui-selected:#243c5c;--ui-selected-text:#bed9ff;--ui-nav:#141c26;
  --ui-success:#82c7a4;--ui-success-bg:#1d342b;--ui-warning:#dfbd78;--ui-warning-bg:#382f20;
  --ui-danger:#f0a3a2;--ui-danger-bg:#3a2529;--ui-on-danger:#25161b;
  --ui-feature-surface:#18304c;--ui-feature-line:#3b5e86;--ui-feature-text:#f0f6ff;--ui-feature-muted:#aec7e8;--ui-feature-hover:#234568;
  --ui-panel-shadow:0 5px 16px rgb(0 0 0 / .14);

  --ui-glass-surface:rgb(22 48 66 / .68);
  --ui-glass-chrome:rgb(15 34 49 / .74);
  --ui-glass-dense:rgb(17 37 53 / .93);
  --ui-glass-edge:rgb(173 220 248 / .24);
  --ui-glass-rim:rgb(211 239 255 / .3);
  --ui-glass-glint:rgb(190 229 255 / .1);
  --ui-glass-shadow:0 14px 34px rgb(0 10 22 / .2),inset 0 1px 0 var(--ui-glass-rim),inset 1px 0 0 rgb(185 228 255 / .09),inset 0 -1px 0 rgb(0 11 25 / .26);
  --ui-glass-control-shadow:inset 0 1px 0 rgb(216 241 255 / .12),0 2px 5px rgb(0 10 22 / .12);
  --ui-water-base:#0b2333;
  --ui-water-deep:#10293f;
  --ui-water-light:rgb(70 166 191 / .42);
  --ui-water-blue:rgb(49 101 177 / .43);
  --ui-water-refraction:rgb(175 235 255 / .13);
  --ui-scheme:dark;
}
:where([data-theme=white],[data-theme=light]) :where(.dshp-dock,.dshp-root,.dshp-auth-mask,.dshp-modal-bg,.dshp-restart-mask,.rt-dock,.rt-full):where(:not([data-theme=dusk]):not([data-theme=dark]):not([dark])),
:where(.dshp-dock,.dshp-root,.dshp-auth-mask,.dshp-modal-bg,.dshp-restart-mask,.rt-dock,.rt-full):is([data-theme=white],[data-theme=light]) {
  --ui-canvas:#f1f4f8;--ui-surface:#ffffff;--ui-subtle:#f6f8fb;--ui-hover:#e9eef6;
  --ui-line:#d8e1ed;--ui-line-strong:#a3b5cc;--ui-text:#1b2b40;--ui-muted:#43566d;
  --ui-link:#285fbb;--ui-selected:#e6effd;--ui-selected-text:#204f9b;--ui-nav:#ffffff;
  --ui-success:#237650;--ui-success-bg:#e9f5ee;--ui-warning:#8e641a;--ui-warning-bg:#fcf4e4;
  --ui-danger:#b63f3f;--ui-danger-bg:#fbeeed;--ui-on-danger:#ffffff;
  --ui-feature-surface:#193858;--ui-feature-line:#45698e;--ui-feature-text:#f0f6ff;--ui-feature-muted:#bed2ea;--ui-feature-hover:#254c73;
  --ui-panel-shadow:0 4px 14px rgb(27 43 64 / .04);

  --ui-glass-surface:rgb(249 253 255 / .66);
  --ui-glass-chrome:rgb(238 249 255 / .72);
  --ui-glass-dense:rgb(245 251 255 / .9);
  --ui-glass-edge:rgb(255 255 255 / .82);
  --ui-glass-rim:rgb(255 255 255 / .94);
  --ui-glass-glint:rgb(255 255 255 / .44);
  --ui-glass-shadow:0 14px 34px rgb(35 77 104 / .09),inset 0 1px 0 var(--ui-glass-rim),inset 1px 0 0 rgb(255 255 255 / .35),inset 0 -1px 0 rgb(38 83 113 / .08);
  --ui-glass-control-shadow:inset 0 1px 0 rgb(255 255 255 / .6),0 2px 5px rgb(33 64 90 / .04);
  --ui-water-base:#c8e0ec;
  --ui-water-deep:#b6cbdf;
  --ui-water-light:rgb(238 255 255 / .92);
  --ui-water-blue:rgb(128 181 219 / .54);
  --ui-water-refraction:rgb(255 255 255 / .36);
  --ui-scheme:light;
}

:where(.dshp-dock,.dshp-root,.dshp-auth-mask,.dshp-modal-bg,.dshp-restart-mask,.rt-dock,.rt-full) :where(button,input,select,textarea) {
  font-family:inherit;
  touch-action:manipulation;
}
:where(.dshp-dock,.dshp-root,.dshp-auth-mask,.dshp-modal-bg,.dshp-restart-mask,.rt-dock,.rt-full) :where(button,input,select,textarea,summary,[tabindex]):focus-visible {
  outline:2px solid var(--ui-link);
  outline-offset:2px;
}
:where(.dshp-dock,.dshp-root,.rt-dock,.rt-full) :where(table,.dshp-metric,.rt-ov-metric,.rt-session-map-stat) {
  font-variant-numeric:tabular-nums;
}

/* Typography is a product contract, including nested host components. */
:is(.dshp-dock,.dshp-root,.dshp-auth-mask,.dshp-modal-bg,.dshp-restart-mask,.rt-dock,.rt-full) * {
  font-family:var(--ui-font) !important;
  letter-spacing:normal;
}
:is(.dshp-dock,.dshp-root,.dshp-auth-mask,.dshp-modal-bg,.dshp-restart-mask,.rt-dock,.rt-full) :is(pre,code,kbd,.rt-mono,.rt-code,.rt-md-code,.rt-r2-code,.rt-r2-pre,.rt-rep-http,.rt-skills-content,.rt-skills-diagnostics-content,.dshp-area,.dshp-editor),
:is(.dshp-dock,.dshp-root,.rt-dock,.rt-full) :is(pre,code,.rt-mono,.rt-code,.rt-md-code,.rt-r2-code,.rt-r2-pre,.rt-rep-http,.rt-skills-content,.rt-skills-diagnostics-content) * {
  font-family:var(--ui-mono) !important;
  font-variant-ligatures:none;
}
:is(.dshp-dock,.dshp-root,.dshp-auth-mask,.dshp-modal-bg,.dshp-restart-mask,.rt-dock,.rt-full) :is(.dshp-btn,.dshp-dock-head button,.dshp-dock-tab,.dshp-auth-ops button,.rt-btn,.rt-icon-btn,.rt-hbtn,.rt-session-map-button,.rt-tab,.rt-subtab,.rt-concl-i,.rt-settings-localnav button) {
  min-height:var(--ui-control-height);
  border-radius:var(--ui-radius-control) !important;
  font-family:var(--ui-font) !important;
  font-size:var(--ui-text-control) !important;
  font-weight:500 !important;
  line-height:var(--ui-leading-control) !important;
}
:is(.dshp-dock,.dshp-root,.rt-dock,.rt-full) :is(.dshp-title,.rt-workspace-pagehead h1,.rt-ledger-heading h1,.rt-skills-pagehead h1,.rt-sessions-pagehead h1,.rt-settings-pagehead h1,.rt-collab-pagehead h1) {
  font-size:var(--ui-text-title) !important;
  font-weight:600;
  line-height:var(--ui-leading-title);
}
:is(.dshp-dock,.dshp-root) .dshp-btn.dshp-btn-solid-danger {
  background:var(--ui-danger-bg);
  border-color:var(--ui-danger);
  color:var(--ui-danger);
}
:is(.dshp-dock,.dshp-root) .dshp-btn.dshp-btn-solid-danger:hover:not(:disabled) {
  background:var(--ui-danger);
  color:var(--ui-canvas);
}
:is(.dshp-dock,.dshp-root,.rt-dock,.rt-full) :is(.dshp-pill,.dshp-cwd-badge,.dshp-now-mark,.rt-tag,.rt-sev,.rt-test,.rt-pri,.rt-avail,.rt-skills-badge,.rt-skills-card-badge,.rt-collab-readonly-badge,.rt-collab-config-badge,.rt-kb-kind,.rt-stage-tag,.rt-scorepts,.rt-ov-stage-chip) {
  display:inline-flex;
  align-items:center;
  min-height:22px !important;
  padding:1px 6px !important;
  border-radius:4px !important;
  font-family:var(--ui-font) !important;
  font-size:var(--ui-text-label) !important;
  font-weight:500 !important;
  line-height:var(--ui-leading-control) !important;
  white-space:nowrap;
}
:is(.dshp-dock,.dshp-root,.rt-dock,.rt-full) :is(.dshp-field,.rt-input,.rt-eng-select,select) {
  font-size:var(--ui-text-control) !important;
  font-weight:400 !important;
  line-height:var(--ui-leading-control) !important;
  border-radius:var(--ui-radius-control) !important;
}
/* A CSS caret keeps selects aligned with inputs across native widget themes. */
:is(.dshp-dock,.dshp-root,.rt-dock,.rt-full) select {
  appearance:none !important;
  height:var(--ui-control-height) !important;
  padding:0 30px 0 12px !important;
  background-image:linear-gradient(45deg,transparent 50%,var(--ui-muted) 50%),linear-gradient(135deg,var(--ui-muted) 50%,transparent 50%) !important;
  background-position:calc(100% - 14px) 50%,calc(100% - 10px) 50% !important;
  background-size:4px 4px !important;
  background-repeat:no-repeat !important;
}

/* Older skins cannot reset native widgets to a different scheme. */
:is(.dshp-dock,.dshp-root,.rt-dock,.rt-full) select option {
  background:var(--ui-surface);
  color:var(--ui-text);
}
:is(.dshp-dock,.dshp-root,.dshp-auth-mask,.dshp-modal-bg,.dshp-restart-mask,.rt-dock,.rt-full){color-scheme:var(--ui-scheme)!important;}


/* Product design: opaque graphite / lavender workspace. */
.rt-dock,.rt-full{
  --rt-bg-base:var(--ui-canvas);--rt-bg-surface:var(--ui-surface);--rt-bg-subtle:var(--ui-subtle);--rt-bg-raised:var(--ui-hover);--rt-rail:var(--ui-surface);
  --rt-border:var(--ui-line);--rt-border-strong:var(--ui-line-strong);--rt-ink:var(--ui-text);--rt-muted:var(--ui-muted);--rt-mute:var(--ui-muted);--rt-ink-soft:var(--ui-muted);--rt-bg-elevated:var(--ui-surface);
  --rt-accent:var(--ui-link);--rt-primary:var(--ui-primary);--rt-accent-strong:var(--ui-primary-hover);--rt-accent-soft:var(--ui-selected);--rt-accent-ink:var(--ui-on-primary);
  --rt-success:var(--ui-success);--rt-success-bg:var(--ui-success-bg);--rt-warning:var(--ui-warning);--rt-warning-bg:var(--ui-warning-bg);--rt-danger:var(--ui-danger);--rt-danger-bg:var(--ui-danger-bg);
  --rt-shadow:rgba(34,27,61,.045);
  --dsw-alias-bg-base:var(--rt-bg-base);--dsw-alias-bg-layer-1:var(--rt-bg-surface);--dsw-alias-bg-layer-2:var(--rt-bg-subtle);
  --dsw-alias-label-primary:var(--rt-ink);--dsw-alias-label-secondary:var(--rt-muted);--dsw-alias-border-l1:var(--rt-border);--dsw-alias-brand-primary:var(--rt-accent);
  font-family:var(--ui-font);font-size:var(--ui-text-body);line-height:var(--ui-leading-body);color:var(--rt-ink);
}
.rt-dock[data-theme=dusk],.rt-dock[data-theme=dark],.rt-full[data-theme=dusk],.rt-full[data-theme=dark],
.dshp-dock[data-theme=dusk] .rt-dock,.dshp-dock[data-theme=dark] .rt-dock,
:is(html[data-ds-dark-theme],body[data-ds-dark-theme]) :where(.rt-dock:not([data-theme=white]):not([data-theme=light]),.rt-full:not([data-theme=white]):not([data-theme=light])){
  --rt-bg-base:var(--ui-canvas);--rt-bg-surface:var(--ui-surface);--rt-bg-subtle:var(--ui-subtle);--rt-bg-raised:var(--ui-hover);--rt-rail:var(--ui-surface);
  --rt-border:var(--ui-line);--rt-border-strong:var(--ui-line-strong);--rt-ink:var(--ui-text);--rt-muted:var(--ui-muted);
  --rt-accent:var(--ui-link);--rt-primary:var(--ui-primary);--rt-accent-strong:var(--ui-primary-hover);--rt-accent-soft:var(--ui-selected);--rt-accent-ink:var(--ui-on-primary);
  --rt-success:var(--ui-success);--rt-success-bg:var(--ui-success-bg);--rt-warning:var(--ui-warning);--rt-warning-bg:var(--ui-warning-bg);--rt-danger:var(--ui-danger);--rt-danger-bg:var(--ui-danger-bg);
  --rt-shadow:rgba(0,0,0,.12);
}
.rt-dock[data-theme=white],.rt-dock[data-theme=light],.rt-full[data-theme=white],.rt-full[data-theme=light],.dshp-dock[data-theme=white] .rt-dock,.dshp-dock[data-theme=light] .rt-dock{
  --rt-bg-base:var(--ui-canvas);--rt-bg-surface:var(--ui-surface);--rt-bg-subtle:var(--ui-subtle);--rt-bg-raised:var(--ui-hover);--rt-rail:var(--ui-surface);
  --rt-border:var(--ui-line);--rt-border-strong:var(--ui-line-strong);--rt-ink:var(--ui-text);--rt-muted:var(--ui-muted);--rt-accent:var(--ui-link);--rt-primary:var(--ui-primary);--rt-accent-strong:var(--ui-primary-hover);--rt-accent-soft:var(--ui-selected);--rt-accent-ink:var(--ui-on-primary);
  --rt-success:var(--ui-success);--rt-success-bg:var(--ui-success-bg);--rt-warning:var(--ui-warning);--rt-warning-bg:var(--ui-warning-bg);--rt-danger:var(--ui-danger);--rt-danger-bg:var(--ui-danger-bg);
}
.rt-dock *,.rt-full *{box-sizing:border-box}
.dshp-dock-body .rt-dock.rt-embedded,.rt-full{grid-template-columns:216px minmax(0,1fr);grid-template-rows:64px auto minmax(0,1fr) auto;background:var(--rt-bg-base);border:0}
.rt-embedded>.rt-chrome>.rt-nav,.rt-full>.rt-chrome>.rt-nav{grid-column:1;grid-row:1/-1;gap:0;padding:26px 14px 16px;background:var(--rt-rail);border-right:1px solid var(--rt-border);color:var(--rt-muted);overflow:auto}
.rt-embedded .rt-nav::before,.rt-full .rt-nav::before,.rt-nav .rt-tab-group::before{display:none!important;content:none!important}
.rt-workspace-brand{display:flex;align-items:center;gap:10px;padding:0 3px 27px;font-size:var(--ui-text-body);font-weight:600;letter-spacing:normal;color:var(--rt-ink)}
.rt-workspace-brand small{display:block;font-size:var(--ui-text-helper);font-weight:400;color:var(--rt-muted);letter-spacing:normal;margin-top:2px}
.rt-workspace-mark{width:31px;height:32px;display:grid;place-items:center;flex:none;border-radius:9px;background:var(--rt-primary);color:#fff;font-size:20px;font-weight:750}
.rt-project-card{display:flex;gap:7px;align-items:center;align-self:flex-start;width:168px;max-width:100%;min-width:0;min-height:50px;margin:0 0 25px;padding:8px;border:1px solid var(--rt-border);border-radius:10px;background:var(--rt-bg-surface);font-size:var(--ui-text-helper)}
.rt-project-card:focus-within{outline:2px solid var(--rt-accent);outline-offset:2px}
.rt-project-avatar{display:grid;place-items:center;flex:none;width:24px;height:26px;border:1px solid var(--rt-border);border-radius:7px;background:var(--rt-bg-subtle);color:var(--rt-ink);font-weight:600}
.rt-project-info{display:flex;align-items:center;min-width:0;flex:1;overflow:hidden}.rt-project-info small{display:none}
.rt-project-card .rt-eng-select{display:block;width:100%;min-width:0;max-width:100%;height:32px;min-height:32px;padding:0 18px 0 0;border:0!important;border-radius:0;background:var(--rt-bg-surface);box-shadow:none!important;outline:0;font-family:var(--ui-font);font-size:var(--ui-text-control);line-height:var(--ui-leading-control);color:var(--rt-ink);text-align:left;text-overflow:ellipsis;white-space:nowrap}
.rt-nav-section{font-size:var(--ui-text-helper);letter-spacing:normal;color:var(--rt-muted);padding:0 9px 12px}
.rt-nav-groups{display:flex;flex-direction:column;gap:7px}
.rt-embedded .rt-nav .rt-tab-group,.rt-full .rt-nav .rt-tab-group{display:flex;align-items:center;flex:0 0 auto;gap:11px;min-height:43px;min-width:0;margin:0;padding:10px 10px;border:1px solid transparent;border-radius:8px;background:transparent;color:var(--rt-muted);font-size:var(--ui-text-control);font-weight:500;white-space:nowrap}
.rt-embedded .rt-nav .rt-tab-group:hover,.rt-full .rt-nav .rt-tab-group:hover{background:var(--rt-bg-subtle);color:var(--rt-ink)}
.rt-embedded .rt-nav .rt-tab-group.on,.rt-full .rt-nav .rt-tab-group.on{background:var(--rt-accent-soft);border-color:transparent;color:var(--rt-accent);font-weight:550}
.rt-nav-symbol{display:grid;place-items:center;width:20px;height:20px;flex:none;color:inherit;font-size:18px;line-height:1}
.rt-nav-symbol svg{width:18px;height:18px;display:block;stroke:currentColor;fill:none;stroke-width:1.6;stroke-linecap:round;stroke-linejoin:round}
.rt-nav-label{overflow:hidden;text-overflow:ellipsis}.rt-nav .rt-tab-dot{margin-left:auto;flex:none}
.rt-nav .rt-tab-group[data-group=resources]{margin-top:35px;position:relative}
.rt-nav .rt-tab-group[data-group=resources]::after{content:"Tài nguyên và cấu hình";position:absolute;left:9px;top:-28px;font-size:var(--ui-text-control);letter-spacing:normal;font-weight:400;color:var(--rt-muted)}
.rt-nav-bottom{margin-top:auto;padding:60px 9px 4px;font-size:var(--ui-text-helper);color:var(--rt-muted)}
.rt-nav-bottom span{display:block;border-top:1px solid var(--rt-border);padding-top:14px}.rt-nav-bottom small{display:block;font-size:var(--ui-text-helper);margin-top:6px;color:var(--rt-muted)}
.rt-embedded>.rt-chrome>.rt-cmd,.rt-full>.rt-chrome>.rt-cmd{grid-column:2;grid-row:1;min-height:64px;padding:12px 26px;background:var(--rt-rail);border-bottom:1px solid var(--rt-border);gap:9px;flex-wrap:nowrap;color:var(--rt-ink)}
.rt-cmd::before{display:none!important;content:none!important}.rt-breadcrumb{display:flex;align-items:center;gap:13px;min-width:0;max-width:70%;font-size:var(--ui-text-helper);color:var(--rt-muted)}
.rt-breadcrumb i{font-style:normal;opacity:.6}.rt-breadcrumb strong{font-weight:500;color:var(--rt-ink);white-space:nowrap}.rt-breadcrumb-project{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:220px}
.rt-embedded>.rt-subnav,.rt-full>.rt-subnav{padding:9px 26px;background:var(--rt-bg-base);border:0;border-bottom:1px solid var(--rt-border);gap:8px}
.rt-subnav .rt-tab{padding:7px 12px;border-radius:6px;background:transparent;color:var(--rt-muted);border:0;font-size:var(--ui-text-helper)}
.rt-subnav .rt-tab.on{background:var(--rt-accent-soft);color:var(--rt-accent)}
.rt-embedded>.rt-body,.rt-full>.rt-body{grid-column:2;grid-row:3;display:flex;flex-direction:column;min-width:0;min-height:0;background:var(--rt-bg-base);overflow:hidden}
.rt-page-content{display:flex;flex-direction:column;flex:1;min-width:0;min-height:0;overflow:hidden;background:var(--rt-bg-base)}
.rt-page-content>.rt-main,.rt-page-content>.rt-r2{flex:1;min-height:0;min-width:0}
.rt-workspace-pagehead{padding:26px 28px 12px;flex:none;background:var(--rt-bg-base)}
.rt-workspace-pagehead h1{margin:0;font-size:var(--ui-text-title);line-height:var(--ui-leading-title);letter-spacing:normal;font-weight:600;color:var(--rt-ink)}
.rt-workspace-pagehead p{margin:7px 0 0;font-size:var(--ui-text-helper);color:var(--rt-muted);line-height:1.7}
.rt-embedded>.rt-foot,.rt-full>.rt-foot{grid-column:2;grid-row:4;padding:10px 26px;border-top:1px solid var(--rt-border);background:var(--rt-bg-base);color:var(--rt-muted);font-size:var(--ui-text-helper);min-height:36px;line-height:1.5}
.rt-btn{min-height:34px;border-radius:7px;background:var(--rt-bg-surface);color:var(--rt-ink);border-color:var(--rt-border);font-size:var(--ui-text-control);padding:7px 12px;font-weight:450}
.rt-btn:hover{border-color:var(--rt-border-strong);background:var(--rt-bg-raised);color:var(--rt-ink)}
.rt-btn-primary{background:var(--rt-primary);border-color:var(--rt-primary);color:#fff}.rt-btn-primary:hover{background:var(--rt-accent-strong);border-color:var(--rt-accent-strong);color:#fff}
.rt-input,.rt-textarea{border-radius:7px;background:var(--rt-bg-base);border-color:var(--rt-border);color:var(--rt-ink);font-size:var(--ui-text-helper)}.rt-input{min-height:34px;padding:7px 10px}
.rt-input:focus-visible,.rt-btn:focus-visible,.rt-tab-group:focus-visible,.rt-tab:focus-visible,.rt-dock summary:focus-visible{outline:2px solid var(--rt-accent);outline-offset:3px;box-shadow:none}
.rt-card{background:var(--rt-bg-surface);border:1px solid var(--rt-border);border-radius:12px;padding:20px;box-shadow:0 2px 8px var(--rt-shadow)}
.rt-toolbar{background:var(--rt-bg-base);border-color:var(--rt-border);padding:14px 26px}.rt-pane{background:var(--rt-bg-base);padding:20px 26px}
.rt-row.head,.rt-vrow.head,.rt-score-row.head{background:var(--rt-bg-subtle);color:var(--rt-muted);font-size:var(--ui-text-helper);font-weight:450}
.rt-row,.rt-vrow,.rt-score-row{background:var(--rt-bg-surface);border-color:var(--rt-border)}
.rt-tag,.rt-sev,.rt-test,.rt-pri{border-radius:5px;font-size:var(--ui-text-helper);font-weight:450}
.rt-ov-head{padding:27px 28px 18px}.rt-ov-title{font-size:var(--ui-text-metric);font-weight:600;letter-spacing:-.7px}.rt-ov-scroll{padding:0 28px 24px}.rt-ov-card{border-radius:12px;padding:20px;background:var(--rt-bg-surface);border-color:var(--rt-border)}
.rt-ov-grid{gap:20px}.rt-ov-score-tab,.rt-ov-metric{border-radius:8px;background:var(--rt-bg-subtle)}
.rt-r2-scroll,.rt-rep-list{padding:18px 26px 28px}.rt-r2-proof,.rt-r2-code,.rt-rep-group{border-color:var(--rt-border);background:var(--rt-bg-surface);border-radius:9px}
.rt-session-map{background:var(--rt-bg-surface);border-color:var(--rt-border);border-radius:12px;box-shadow:none}
.rt-session-map-head,.rt-session-map-detail,.rt-session-map-toolbar{background:var(--rt-bg-surface)}.rt-session-map-graph-pane{background:var(--rt-bg-base)}
.rt-session-map-node rect{fill:var(--rt-bg-surface);stroke:var(--rt-border)}.rt-session-map-node.selected rect{fill:var(--rt-accent-soft);stroke:var(--rt-accent)}
.rt-session-map-edge{stroke:var(--rt-border-strong)}.rt-session-map-node-id{fill:var(--rt-ink)}.rt-session-map-node-meta{fill:var(--rt-muted)}
.rt-dock .rt-main,.rt-full .rt-main{color:var(--rt-ink)}
@container workspace (max-width:1000px){
  .dshp-dock-body .rt-dock.rt-embedded{grid-template-columns:178px minmax(0,1fr)}
  .rt-embedded>.rt-chrome>.rt-nav{padding:22px 10px 14px}.rt-workspace-brand{font-size:var(--ui-text-helper);gap:7px}.rt-project-avatar{display:none}
  .rt-embedded>.rt-chrome>.rt-cmd{padding:12px 18px}.rt-breadcrumb{gap:9px}.rt-breadcrumb-project{max-width:130px}
  .rt-embedded .rt-nav .rt-tab-group{padding:9px;font-size:var(--ui-text-control);gap:9px}
}
@container workspace (max-width:720px){
  .dshp-dock-body .rt-dock.rt-embedded{grid-template-columns:minmax(0,1fr);grid-template-rows:auto auto auto minmax(0,1fr) auto}
  .rt-embedded>.rt-chrome>.rt-nav{grid-column:1;grid-row:1;display:block;padding:9px 12px;background:var(--rt-rail);border-right:0;border-bottom:1px solid var(--rt-border);overflow:auto}
  .rt-embedded .rt-workspace-brand,.rt-embedded .rt-nav-section,.rt-embedded .rt-nav-bottom{display:none}
  .rt-embedded .rt-project-card{width:168px;max-width:100%;margin:0 0 8px;padding:5px 8px}.rt-embedded .rt-project-info small{display:none}.rt-embedded .rt-project-avatar{display:none}
  .rt-embedded .rt-nav-groups{display:flex;flex-direction:row;gap:5px;width:max-content;min-width:100%}
  .rt-embedded .rt-nav .rt-tab-group{padding:7px 11px;min-height:35px;flex:0 0 auto;font-size:var(--ui-text-control);gap:6px}
  .rt-embedded .rt-nav .rt-tab-group[data-group=resources]{margin-top:0}.rt-embedded .rt-nav .rt-tab-group[data-group=resources]::after{display:none}
  .rt-embedded .rt-nav-symbol{display:none}.rt-embedded>.rt-chrome>.rt-cmd{grid-column:1;grid-row:2;min-height:50px;padding:10px 12px}
  .rt-embedded>.rt-subnav{grid-column:1;grid-row:3;padding:7px 12px}.rt-embedded>.rt-body{grid-column:1;grid-row:4}.rt-embedded>.rt-foot{grid-column:1;grid-row:5;padding:8px 12px}
  .rt-breadcrumb{gap:8px;font-size:var(--ui-text-helper);max-width:60%}.rt-breadcrumb>span:first-child,.rt-breadcrumb>i:first-of-type{display:none}
  .rt-breadcrumb-project{max-width:100px}.rt-workspace-pagehead{padding:20px 16px 8px}.rt-workspace-pagehead h1{font-size:22px}
  .rt-pane,.rt-toolbar,.rt-r2-scroll,.rt-rep-list{padding:14px 16px}
}
@media(max-width:720px){
  .rt-full{grid-template-columns:minmax(0,1fr);grid-template-rows:auto auto auto minmax(0,1fr) auto}
  .rt-full>.rt-chrome>.rt-nav{grid-column:1;grid-row:1;display:block;padding:9px 12px;overflow:auto;border-right:0;border-bottom:1px solid var(--rt-border)}
  .rt-full .rt-workspace-brand,.rt-full .rt-nav-section,.rt-full .rt-nav-bottom{display:none}
  .rt-full .rt-project-card{width:168px;max-width:100%;margin:0 0 8px;padding:5px 8px}.rt-full .rt-project-info small,.rt-full .rt-project-avatar{display:none}
  .rt-full .rt-nav-groups{flex-direction:row;min-width:max-content}.rt-full .rt-nav .rt-tab-group{padding:7px 10px;min-height:35px;flex:0 0 auto;font-size:var(--ui-text-helper)}
  .rt-full .rt-nav .rt-tab-group[data-group=resources]{margin-top:0}.rt-full .rt-nav .rt-tab-group[data-group=resources]::after{display:none}.rt-full .rt-nav-symbol{display:none}
  .rt-full>.rt-chrome>.rt-cmd{grid-column:1;grid-row:2;padding:10px 12px;min-height:50px}.rt-full>.rt-subnav{grid-column:1;grid-row:3;padding:7px 12px}.rt-full>.rt-body{grid-column:1;grid-row:4}.rt-full>.rt-foot{grid-column:1;grid-row:5}
}
@media(prefers-reduced-motion:reduce){.rt-dock *,.rt-full *{scroll-behavior:auto!important;transition:none!important}}

/* Resource accordions: bound inner scrolling without clipping the page. */
.rt-artifacts-page>.rt-toolbar{flex:none}
.rt-artifacts-page>.rt-artifacts-scroll{display:block;flex:1 1 0;min-width:0;min-height:0;overflow:auto;padding:16px 26px 24px;scrollbar-gutter:stable}
.rt-artifacts-page .rt-artifacts-section{min-width:0;max-width:100%;padding:0;overflow:hidden}
.rt-artifacts-page .rt-artifacts-section>summary{padding:14px 18px;line-height:var(--ui-leading-body);color:var(--rt-ink)}
.rt-artifacts-page .rt-artifacts-content{max-height:52vh;max-height:min(52vh,560px);min-height:0;min-width:0;overflow:auto;overscroll-behavior:contain;scrollbar-gutter:stable;border-top:1px solid var(--rt-border);background:var(--rt-bg-base)}
.rt-artifacts-page .rt-artifacts-content:focus-visible{outline:2px solid var(--rt-accent);outline-offset:-3px}
.rt-artifacts-page .rt-artifacts-content>.rt-pane{flex:none;overflow:visible;padding:14px 18px}
.rt-artifacts-page .rt-artifacts-content>.rt-main{flex:none;overflow:visible}
.rt-artifacts-page .rt-artifacts-content>.rt-main>.rt-body{flex:none;overflow:visible!important}
@container workspace (max-width:720px){.rt-artifacts-page>.rt-artifacts-scroll{padding:12px 14px 18px}}
@container rt (max-width:720px){.rt-artifacts-page>.rt-artifacts-scroll{padding:12px 14px 18px}}


/* Asset ledger presentation. The host embeds this file with the red-team UI. */
.rt-ledger-page {
  --rt-ledger-radius:var(--ui-radius-panel);
  --rt-ledger-gap: 12px;
  display: flex;
  flex: 1 1 auto;
  min-width: 0;
  min-height: 0;
  flex-direction: column;
  gap: 16px;
  overflow: auto;
  box-sizing: border-box;
  padding: 24px 28px 30px;
  color: var(--rt-ink, #eef0ff);
  background: var(--rt-bg-base, #12141d);
}

.rt-ledger-page,
.rt-ledger-page * {
  box-sizing: border-box;
}

.rt-ledger-page button,
.rt-ledger-page input,
.rt-ledger-page select,
.rt-ledger-page summary {
  font: inherit;
}

.rt-ledger-header {
  display: flex;
  min-width: 0;
  align-items: flex-start;
  justify-content: space-between;
  gap: 18px;
}

.rt-ledger-heading {
  min-width: 0;
}

.rt-ledger-eyebrow {
  margin-bottom: 4px;
  color: var(--rt-mute, #8b93ad);
  font-size:var(--ui-text-helper);
  line-height:var(--ui-leading-body);
  letter-spacing:normal;
}

.rt-ledger-heading h1,
.rt-ledger-segments-head h3,
.rt-ledger-detail h2,
.rt-ledger-detail-empty h2 {
  margin: 0;
  color: var(--rt-ink, #eef0ff);
  font-weight:600;
  letter-spacing:normal;
}

.rt-ledger-heading h1 {
  font-size:var(--ui-text-title);
  line-height:var(--ui-leading-title);
}

.rt-ledger-heading p {
  margin: 7px 0 0;
  color: var(--rt-mute, #8b93ad);
  font-size:var(--ui-text-helper);
  line-height:var(--ui-leading-body);
}

.rt-ledger-header-actions {
  display: flex;
  min-width: 0;
  flex: 0 1 auto;
  align-items: center;
  gap: 8px;
  padding-top: 4px;
}

.rt-ledger-target {
  max-width: min(34vw, 260px);
  overflow: hidden;
  color: var(--rt-mute, #8b93ad);
  font-size:var(--ui-text-helper);
  line-height:var(--ui-leading-body);
  text-overflow: ellipsis;
  white-space: nowrap;
}

.rt-ledger-page .rt-btn {
  min-height: 30px;
  padding: 5px 10px;
  border: 1px solid var(--rt-border, #30354a);
  border-radius: 7px;
  color: var(--rt-ink, #eef0ff);
  background: var(--rt-bg-surface, #1a1d29);
  cursor: pointer;
}

.rt-ledger-page .rt-btn:hover,
.rt-ledger-page .rt-btn:focus-visible {
  border-color: var(--rt-accent, #9c8cff);
  outline: none;
}

.rt-ledger-page .rt-btn-primary {
  border-color: var(--rt-accent, #9c8cff);
  color: var(--rt-ink, #eef0ff);
  background: var(--rt-accent, #7566e8);
}

.rt-ledger-page .rt-btn:disabled {
  cursor: default;
  opacity: .5;
}

.rt-ledger-stats {
  display: grid;
  min-width: 0;
  grid-template-columns: repeat(4, minmax(0, 1fr));
  gap: 1px;
  overflow: hidden;
  border: 1px solid var(--rt-border, #30354a);
  border-radius: var(--rt-ledger-radius);
  background: var(--rt-border, #30354a);
}

.rt-ledger-stat {
  display: grid;
  min-width: 0;
  grid-template-columns: auto minmax(0, 1fr);
  grid-template-rows: auto auto;
  column-gap: 9px;
  align-items: center;
  padding: 14px 16px;
  background: var(--rt-bg-surface, #1a1d29);
}

.rt-ledger-stat-icon {
  display: inline-flex;
  width: 28px;
  height: 28px;
  grid-row: 1 / span 2;
  align-items: center;
  justify-content: center;
  border: 1px solid var(--rt-border, #30354a);
  border-radius: 8px;
  color: var(--rt-mute, #8b93ad);
  background: var(--rt-bg-subtle, #222536);
  font-size: 14px;
}

.rt-ledger-stat-accent .rt-ledger-stat-icon {
  border-color: var(--rt-accent, #9c8cff);
  color: var(--rt-accent, #9c8cff);
}

.rt-ledger-stat-warn .rt-ledger-stat-icon {
  color: var(--rt-accent, #9c8cff);
}

.rt-ledger-stat-value {
  min-width: 0;
  color: var(--rt-ink, #eef0ff);
  font-size:var(--ui-text-metric);
  font-weight:600;
  line-height:var(--ui-leading-body);
  font-variant-numeric: tabular-nums;
}

.rt-ledger-stat-label {
  min-width: 0;
  margin-top: 3px;
  overflow: hidden;
  color: var(--rt-mute, #8b93ad);
  font-size:var(--ui-text-helper);
  line-height:var(--ui-leading-body);
  text-overflow: ellipsis;
  white-space: nowrap;
}

.rt-ledger-layout {
  display: grid;
  min-width: 0;
  min-height: 0;
  flex: 1 1 auto;
  grid-template-columns: minmax(0, 1fr);
  gap: var(--rt-ledger-gap);
}

.rt-ledger-layout.rt-ledger-layout-segments-open {
  grid-template-columns: minmax(164px, 188px) minmax(0, 1fr);
}

.rt-ledger-segments {
  width: auto;
  min-width: 0;
  overflow: hidden;
  padding: 0;
  border: 1px solid var(--rt-border, #30354a);
  border-radius: var(--rt-ledger-radius);
  background: var(--rt-bg-surface, #1a1d29);
}

.rt-ledger-segments.rt-ledger-segments-hidden {
  display: none;
}

.rt-ledger-segments-head {
  padding: 14px 14px 12px;
  border-bottom: 1px solid var(--rt-border, #30354a);
}

.rt-ledger-segments-head h3 {
  font-size:var(--ui-text-section);
  line-height:var(--ui-leading-title);
}

.rt-ledger-segments-head > span {
  display: block;
  margin-top: 4px;
  color: var(--rt-mute, #8b93ad);
  font-size:var(--ui-text-helper);
  line-height:var(--ui-leading-body);
}

.rt-ledger-segments-body {
  min-height: 0;
  overflow: auto;
  padding: 10px;
}

.rt-ledger-segments .rt-seg {
  margin-bottom: 5px;
  padding: 9px 10px;
  border: 1px solid transparent;
  border-radius: 8px;
  color: var(--rt-ink, #eef0ff);
  background: transparent;
}

.rt-ledger-segments .rt-seg:hover,
.rt-ledger-segments .rt-seg:focus-visible {
  border-color: var(--rt-border, #30354a);
  outline: none;
  background: var(--rt-bg-subtle, #222536);
}

.rt-ledger-segments .rt-seg.on {
  border-color: var(--rt-accent, #9c8cff);
  background: var(--rt-bg-subtle, #222536);
}

.rt-ledger-segments .rt-sidehead {
  display: flex;
  min-width: 0;
  align-items: center;
  gap: 5px;
  margin: 12px 2px 5px;
  padding: 5px 2px;
  color: var(--rt-mute, #8b93ad);
  font-size:var(--ui-text-helper);
}

.rt-ledger-segments .rt-sidehead:first-child {
  margin-top: 0;
}

.rt-ledger-segments .rt-seg-cidr {
  color: var(--rt-ink, #eef0ff);
  font-size:var(--ui-text-helper);
}

.rt-ledger-segments .rt-seg-meta {
  color: var(--rt-mute, #8b93ad);
  font-size:var(--ui-text-helper);
}

.rt-ledger-main {
  min-width: 0;
  overflow: hidden;
  background: transparent;
}

.rt-ledger-toolbar {
  gap: 10px;
  padding: 0 0 10px;
  border: 0;
  background: transparent;
}

.rt-ledger-primary-tools,
.rt-ledger-filter-view-row {
  min-width: 0;
  align-items: center;
  gap: 8px;
}

.rt-ledger-primary-tools > .rt-input:first-child {
  flex: 1 1 240px;
}

.rt-ledger-page .rt-input {
  min-height: 32px;
  border-color: var(--rt-border, #30354a);
  border-radius: 7px;
  color: var(--rt-ink, #eef0ff);
  background: var(--rt-bg-surface, #1a1d29);
}

.rt-ledger-page .rt-input::placeholder {
  color: var(--rt-mute, #8b93ad);
}

.rt-ledger-page .rt-input:focus {
  border-color: var(--rt-accent, #9c8cff);
  box-shadow: 0 0 0 2px var(--rt-bg-subtle, #222536);
  outline: none;
}

.rt-ledger-filter-view-row {
  align-items: flex-start;
}

.rt-ledger-advanced {
  min-width: 0;
  flex: 1 1 auto;
  border: 1px solid var(--rt-border, #30354a);
  border-radius: 8px;
  background: var(--rt-bg-surface, #1a1d29);
}

.rt-ledger-advanced > summary {
  display: inline-flex;
  min-height: 30px;
  align-items: center;
  padding: 5px 9px;
  color: var(--rt-mute, #8b93ad);
  cursor: pointer;
  font-size:var(--ui-text-helper);
  list-style: none;
  user-select: none;
}

.rt-ledger-advanced > summary::-webkit-details-marker {
  display: none;
}

.rt-ledger-advanced > summary::before {
  margin-right: 6px;
  color: var(--rt-accent, #9c8cff);
  content: '▾';
}

.rt-ledger-advanced:not([open]) > summary::before {
  content: '▸';
}

.rt-ledger-advanced > summary:focus-visible {
  border-radius: 7px;
  outline: 2px solid var(--rt-accent, #9c8cff);
  outline-offset: -2px;
}

.rt-ledger-advanced-controls {
  display: flex;
  flex-wrap: wrap;
  gap: 7px;
  padding: 0 9px 9px;
}

.rt-ledger-advanced-controls .rt-input {
  flex: 1 1 120px;
  min-width: 110px;
}

.rt-ledger-view-tools {
  display: flex;
  flex: 0 1 auto;
  flex-wrap: wrap;
  gap: 6px;
}

.rt-ledger-view-tabs {
  display: flex;
  flex: 0 1 auto;
  flex-wrap: wrap;
  gap: 6px;
}

.rt-ledger-view-tabs .rt-btn {
  white-space: nowrap;
}

.rt-ledger-segments-toggle {
  border-color: var(--rt-accent, #9c8cff);
  color: var(--rt-accent, #9c8cff);
  background: var(--rt-bg-subtle, #222536);
}

.rt-ledger-conclusion {
  display: flex;
  min-width: 0;
  flex-wrap: wrap;
  align-items: center;
  gap: 6px;
  margin-bottom: 10px;
  padding: 7px 0;
  border: 0;
  background: transparent;
}

.rt-ledger-conclusion .rt-concl-i {
  min-height: 30px;
  padding: 5px 9px;
  border: 1px solid var(--rt-border, #30354a);
  border-radius: 7px;
  color: var(--rt-mute, #8b93ad);
  background: var(--rt-bg-surface, #1a1d29);
}

.rt-ledger-conclusion .rt-concl-i:hover,
.rt-ledger-conclusion .rt-concl-i:focus-visible {
  border-color: var(--rt-accent, #9c8cff);
  outline: none;
}

.rt-ledger-conclusion .rt-concl-i.on {
  border-color: var(--rt-accent, #9c8cff);
  color: var(--rt-ink, #eef0ff);
  background: var(--rt-bg-subtle, #222536);
}

.rt-ledger-conclusion .rt-concl-i b {
  margin-right: 4px;
  color: var(--rt-ink, #eef0ff);
  font-variant-numeric: tabular-nums;
}

.rt-ledger-list-detail {
  display: grid;
  min-width: 0;
  min-height: 0;
  flex: 1 1 auto;
  grid-template-columns: minmax(0, 1.3fr) minmax(270px, .7fr);
  gap: var(--rt-ledger-gap);
  overflow: hidden;
}

.rt-ledger-list-pane {
  min-width: 0;
  min-height: 300px;
  overflow: auto;
  border: 1px solid var(--rt-border, #30354a);
  border-radius: var(--rt-ledger-radius);
  background: var(--rt-bg-surface, #1a1d29);
}

.rt-ledger-list-pane > .rt-row {
  grid-template-columns: minmax(145px, 1.2fr) minmax(64px, .55fr) minmax(100px, .9fr) minmax(150px, 1.2fr) minmax(110px, 1fr);
  min-width: 680px;
  padding: 12px 14px;
  border-bottom-color: var(--rt-border, #30354a);
  color: var(--rt-ink, #eef0ff);
  background: transparent;
}

.rt-ledger-list-pane > .rt-row:hover,
.rt-ledger-list-pane > .rt-row:focus-visible {
  background: var(--rt-bg-subtle, #222536);
  outline: none;
}

.rt-ledger-list-pane > .rt-ledger-row.selected {
  border-left: 3px solid var(--rt-accent, #9c8cff);
  padding-left: 11px;
  background: var(--rt-bg-subtle, #222536);
}

.rt-ledger-list-pane > .rt-ledger-table-head {
  min-height: 38px;
  padding-top: 9px;
  padding-bottom: 9px;
  color: var(--rt-mute, #8b93ad);
  background: var(--rt-bg-subtle, #222536);
}

.rt-ledger-detail {
  display: flex;
  min-width: 0;
  min-height: 300px;
  flex-direction: column;
  overflow: hidden;
  border: 1px solid var(--rt-border, #30354a);
  border-radius: var(--rt-ledger-radius);
  color: var(--rt-ink, #eef0ff);
  background: var(--rt-bg-surface, #1a1d29);
}

.rt-ledger-detail-head {
  min-width: 0;
  min-height: 0;
  flex: 0 1 auto;
  max-height: min(40%, 220px);
  overflow: auto;
  overscroll-behavior: contain;
  scrollbar-gutter: stable;
  padding: 16px;
  border-bottom: 1px solid var(--rt-border, #30354a);
}

.rt-ledger-detail h2 {
  overflow-wrap: anywhere;
  font-size:var(--ui-text-section);
  line-height:var(--ui-leading-title);
}

.rt-ledger-detail-ip {
  margin-top: 5px;
  overflow-wrap: anywhere;
  color: var(--rt-mute, #8b93ad);
  font-size:var(--ui-text-helper);
}

.rt-ledger-detail-status {
  display: flex;
  min-width: 0;
  flex-wrap: wrap;
  align-items: center;
  gap: 5px;
  margin-top: 11px;
}

.rt-ledger-detail-close {
  width: 28px;
  min-width: 28px;
  min-height: 28px !important;
  margin-left: auto;
  padding: 2px !important;
  border-radius: 50% !important;
  color: var(--rt-mute, #8b93ad) !important;
  line-height:var(--ui-leading-body);
}

.rt-ledger-detail-close:hover,
.rt-ledger-detail-close:focus-visible {
  color: var(--rt-ink, #eef0ff) !important;
}

.rt-ledger-detail-scope {
  color: var(--rt-mute, #8b93ad);
  font-size:var(--ui-text-helper);
}

.rt-ledger-detail-body {
  min-height: 0;
  flex: 1 1 0;
  overflow: auto;
  overscroll-behavior: contain;
  scrollbar-gutter: stable;
  padding: 14px 16px 18px;
}

.rt-ledger-detail-body .rt-expand {
  min-width: 0;
  padding: 0;
  color: var(--rt-mute, #8b93ad);
}

.rt-ledger-detail-body .rt-kv {
  display: grid;
  min-width: 0;
  grid-template-columns: minmax(58px, .42fr) minmax(0, 1fr);
  gap: 7px;
  margin-bottom: 8px;
  align-items: start;
  line-height:var(--ui-leading-body);
}

.rt-ledger-detail-body .rt-kv > * {
  min-width: 0;
  overflow-wrap: anywhere;
}

.rt-ledger-detail-body .rt-kv b {
  min-width: 0;
  color: var(--rt-mute, #8b93ad);
  font-weight:500;
}

.rt-ledger-detail-body .rt-more {
  display: inline-flex;
  margin: 7px 0 13px;
  padding: 4px 0;
  color: var(--rt-accent, #9c8cff);
  cursor: pointer;
  font-size:var(--ui-text-helper);
}

.rt-ledger-detail-empty {
  align-items: center;
  justify-content: center;
  padding: 24px;
  text-align: center;
}

.rt-ledger-empty-icon {
  display: inline-flex;
  width: 36px;
  height: 36px;
  align-items: center;
  justify-content: center;
  margin-bottom: 10px;
  border: 1px solid var(--rt-border, #30354a);
  border-radius: 50%;
  color: var(--rt-accent, #9c8cff);
}

.rt-ledger-detail-empty p {
  max-width: 220px;
  margin: 8px 0 0;
  color: var(--rt-mute, #8b93ad);
  font-size:var(--ui-text-helper);
  line-height:var(--ui-leading-body);
}

.rt-ledger-page .rt-table:not(.rt-ledger-list-pane) {
  min-width: 0;
  min-height: 300px;
  overflow: auto;
  border: 1px solid var(--rt-border, #30354a);
  border-radius: var(--rt-ledger-radius);
  background: var(--rt-bg-surface, #1a1d29);
}

.rt-ledger-page .rt-table:not(.rt-ledger-list-pane) > .rt-row {
  min-width: 640px;
  padding: 12px 14px;
  border-bottom-color: var(--rt-border, #30354a);
  background: transparent;
}

.rt-ledger-page .rt-table:not(.rt-ledger-list-pane) > .rt-row.head {
  background: var(--rt-bg-subtle, #222536);
}

.rt-ledger-page .rt-pane {
  min-width: 0;
  min-height: 0;
  padding: 0;
  background: transparent;
}

.rt-ledger-page .rt-err {
  margin-bottom: 8px;
  border: 1px solid var(--rt-border, #30354a);
  border-radius: 8px;
  background: var(--rt-bg-surface, #1a1d29);
}

@media (max-width: 1120px) {
  .rt-ledger-list-detail {
    grid-template-columns: minmax(0, 1fr) minmax(250px, .62fr);
  }
}

@media (max-width: 900px) {
  .rt-ledger-page {
    padding: 20px;
  }

  .rt-ledger-layout {
    grid-template-columns: 1fr;
  }

  .rt-ledger-segments {
    max-height: 220px;
  }

  .rt-ledger-segments-body {
    display: grid;
    grid-template-columns: repeat(2, minmax(0, 1fr));
    gap: 0 8px;
  }

  .rt-ledger-segments .rt-sidehead {
    grid-column: 1 / -1;
  }

  .rt-ledger-list-detail {
    grid-template-columns: 1fr;
    overflow: visible;
  }

  .rt-ledger-detail {
    max-height: 48vh;
  }
}

@media (max-width: 640px) {
  .rt-ledger-page {
    gap: 12px;
    padding: 16px;
  }

  .rt-ledger-header {
    flex-direction: column;
    gap: 10px;
  }

  .rt-ledger-header-actions {
    width: 100%;
    justify-content: space-between;
  }

  .rt-ledger-target {
    max-width: 70vw;
  }

  .rt-ledger-heading h1 {
    font-size:var(--ui-text-title);
  }

  .rt-ledger-stats {
    grid-template-columns: repeat(2, minmax(0, 1fr));
  }

  .rt-ledger-layout.rt-ledger-layout-segments-open {
    grid-template-columns: 1fr;
  }

  .rt-ledger-segments {
    max-height: 220px;
  }

  .rt-ledger-stat {
    padding: 12px;
  }

  .rt-ledger-primary-tools,
  .rt-ledger-filter-view-row {
    align-items: stretch;
    flex-direction: column;
  }

  .rt-ledger-primary-tools > .rt-input:first-child,
  .rt-ledger-advanced,
  .rt-ledger-view-tools,
  .rt-ledger-view-tabs {
    width: 100%;
  }

  .rt-ledger-view-tools {
    align-items: stretch;
    flex-direction: column;
  }

  .rt-ledger-view-tools > .rt-ledger-segments-toggle {
    width: 100%;
  }

  .rt-ledger-view-tabs .rt-btn {
    flex: 1 1 auto;
  }

  .rt-ledger-advanced-controls {
    display: grid;
    grid-template-columns: 1fr 1fr;
  }

  .rt-ledger-advanced-controls .rt-input {
    min-width: 0;
  }

  .rt-ledger-conclusion {
    align-items: stretch;
  }

  .rt-ledger-conclusion .rt-concl-i {
    flex: 1 1 auto;
    text-align: center;
  }

  .rt-ledger-conclusion .rt-spacer {
    display: none;
  }

  .rt-ledger-conclusion > .rt-input {
    width: 100%;
  }
}

/* Shared product focus and primary-button contrast. */
.rt-ledger-page .rt-btn:focus-visible{outline:2px solid var(--rt-accent);outline-offset:3px}
.rt-ledger-page .rt-btn-primary{background:var(--rt-primary);border-color:var(--rt-primary);color:#fff}

/* Keep the workspace heading steady while list and details scroll independently. */
.rt-ledger-page{overflow:hidden}
.rt-ledger-header,.rt-ledger-stats{flex:0 0 auto}
.rt-ledger-main>.rt-ledger-toolbar,.rt-ledger-main>.rt-ledger-conclusion{flex:0 0 auto}
.rt-ledger-toolbar{flex-wrap:nowrap;align-content:stretch}
.rt-ledger-filter-view-row{justify-content:space-between}
.rt-ledger-advanced{flex:0 0 auto;min-width:128px;align-self:flex-start}
.rt-ledger-advanced[open]{flex:1 1 420px}
.rt-ledger-view-tools{margin-left:auto}
.rt-ledger-list-detail{height:0;min-height:0}
.rt-ledger-list-pane,.rt-ledger-detail{min-height:0}
@container workspace (max-width:950px){
 .rt-ledger-page{overflow:auto;padding:20px 16px}
 .rt-ledger-layout{flex:0 0 auto;min-height:450px}
 .rt-ledger-main{overflow:visible}
 .rt-ledger-list-detail{height:auto;min-height:450px;overflow:visible;grid-template-columns:minmax(0,1fr)}
 .rt-ledger-list-pane{max-height:480px;min-height:260px}
 .rt-ledger-detail{min-height:280px;max-height:500px}
 .rt-ledger-filter-view-row{flex-wrap:wrap}
 .rt-ledger-advanced[open]{flex:1 1 100%}
 .rt-ledger-view-tools{margin-left:0}
}

/* Floating and full-page shells use the rt size container. */
@container rt (max-width:950px){
 .rt-ledger-page{overflow:auto;padding:20px 16px}
 .rt-ledger-layout{flex:0 0 auto;min-height:450px}
 .rt-ledger-main{overflow:visible}
 .rt-ledger-list-detail{height:auto;min-height:450px;overflow:visible;grid-template-columns:minmax(0,1fr)}
 .rt-ledger-list-pane{max-height:480px;min-height:260px}
 .rt-ledger-detail{min-height:280px;max-height:500px}
 .rt-ledger-filter-view-row{flex-wrap:wrap}
 .rt-ledger-advanced[open]{flex:1 1 100%}
 .rt-ledger-view-tools{margin-left:0}
}


/* Agent collaboration page: page-scoped styles only, so other RedTeam tabs are untouched. */
.rt-collab-page {
  min-height: 100%;
  background: var(--rt-bg-base, #151923);
  color: var(--rt-ink, #eef1fb);
}

.rt-collab-page .rt-collab-toolbar {
  min-height: 44px;
  padding: 8px 14px;
  border-bottom: 1px solid var(--rt-border, #303647);
  background: var(--rt-bg-surface, #1d2230);
}

.rt-collab-page .rt-collab-toolbar-label {
  color: var(--rt-ink, #eef1fb);
}

.rt-collab-page .rt-collab-pane {
  display: block;
  overflow: auto;
  padding: 18px 16px 26px;
  background: var(--rt-bg-base, #151923);
}

.rt-collab-page .rt-collab-hero {
  max-width: 980px;
  margin: 0 auto 18px;
  padding: 2px 2px 0;
}

.rt-collab-page .rt-collab-eyebrow {
  margin-bottom: 6px;
  color: var(--rt-accent, #a99aff);
  font-size:var(--ui-text-helper);
  font-weight:600;
  letter-spacing:normal;
  text-transform: uppercase;
}

.rt-collab-page .rt-collab-title {
  margin: 0;
  color: var(--rt-ink, #f5f6ff);
  font-size:var(--ui-text-title);
  font-weight:600;
  letter-spacing:normal;
  line-height:var(--ui-leading-title);
}

.rt-collab-page .rt-collab-description {
  max-width: 680px;
  margin: 7px 0 0;
  color: var(--rt-muted, #9da5bd);
  font-size:var(--ui-text-body);
  line-height:var(--ui-leading-body);
}

.rt-collab-page .rt-collab-section,
.rt-collab-page .rt-collab-config {
  max-width: 980px;
  margin: 0 auto 14px;
}

.rt-collab-page .rt-collab-section {
  border: 1px solid var(--rt-border, #303647);
  border-radius: 12px;
  background: var(--rt-bg-surface, #1d2230);
  box-shadow: 0 12px 30px rgb(5 8 18 / 18%);
  overflow: hidden;
}

.rt-collab-page .rt-collab-section-head,
.rt-collab-page .rt-collab-card-heading {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 12px;
}

.rt-collab-page .rt-collab-section-head {
  padding: 15px 16px 12px;
}

.rt-collab-page .rt-collab-section-head h2,
.rt-collab-page .rt-collab-card-heading h3 {
  margin: 0;
  color: var(--rt-ink, #eef1fb);
  font-size:var(--ui-text-section);
  font-weight:600;
  line-height:var(--ui-leading-title);
}

.rt-collab-page .rt-collab-section-head p,
.rt-collab-page .rt-collab-card-heading p {
  margin: 4px 0 0;
  color: var(--rt-muted, #9da5bd);
  font-size:var(--ui-text-helper);
  line-height:var(--ui-leading-body);
}

.rt-collab-page .rt-collab-readonly-badge,
.rt-collab-page .rt-collab-config-badge {
  flex: none;
  border: 1px solid rgb(169 154 255 / 32%);
  border-radius: 999px;
  padding: 4px 8px;
  color: var(--rt-accent, #b5a8ff);
  background: rgb(126 106 239 / 14%);
  font-size:var(--ui-text-helper);
  line-height:var(--ui-leading-body);
  white-space: nowrap;
}

.rt-collab-page .rt-collab-scope > .rt-session-map {
  margin: 0;
  border: 0;
  border-top: 1px solid var(--rt-border, #303647);
  border-radius: 0;
  background: var(--rt-bg-surface, #1d2230);
}

.rt-collab-page .rt-collab-scope > .rt-session-map .rt-session-map-head,
.rt-collab-page .rt-collab-scope > .rt-session-map .rt-session-map-toolbar,
.rt-collab-page .rt-collab-scope > .rt-session-map .rt-session-map-note,
.rt-collab-page .rt-collab-scope > .rt-session-map .rt-session-map-foot {
  background: var(--rt-bg-surface, #1d2230);
}

.rt-collab-page .rt-collab-config {
  border: 1px solid var(--rt-border, #303647);
  border-radius: 12px;
  background: var(--rt-bg-surface, #1d2230);
  box-shadow: 0 12px 30px rgb(5 8 18 / 14%);
}

.rt-collab-page .rt-collab-config-summary {
  display: flex;
  align-items: center;
  gap: 10px;
  min-height: 52px;
  box-sizing: border-box;
  padding: 10px 16px;
  color: var(--rt-ink, #eef1fb);
  cursor: pointer;
  list-style: none;
}

.rt-collab-page .rt-collab-config-summary:focus-visible {
  outline: 2px solid var(--rt-accent, #a99aff);
  outline-offset: -2px;
}

.rt-collab-page .rt-collab-config-summary::-webkit-details-marker {
  display: none;
}

.rt-collab-page .rt-collab-config-summary::before {
  width: 8px;
  height: 8px;
  margin-left: 1px;
  border-right: 1px solid var(--rt-muted, #9da5bd);
  border-bottom: 1px solid var(--rt-muted, #9da5bd);
  content: '';
  transform: rotate(-45deg);
  transition: transform .16s ease;
}

.rt-collab-page .rt-collab-config[open] > .rt-collab-config-summary::before {
  transform: rotate(45deg) translate(-2px, -2px);
}

.rt-collab-page .rt-collab-config-summary-icon {
  display: grid;
  place-items: center;
  width: 28px;
  height: 28px;
  border: 1px solid rgb(169 154 255 / 28%);
  border-radius: 8px;
  color: var(--rt-accent, #b5a8ff);
  background: rgb(126 106 239 / 14%);
  font-size: 14px;
}

.rt-collab-page .rt-collab-config-summary strong,
.rt-collab-page .rt-collab-config-summary small {
  display: block;
}

.rt-collab-page .rt-collab-config-summary strong {
  font-size:var(--ui-text-body);
  line-height:var(--ui-leading-body);
}

.rt-collab-page .rt-collab-config-summary small {
  margin-top: 2px;
  color: var(--rt-muted, #9da5bd);
  font-size:var(--ui-text-helper);
  line-height:var(--ui-leading-body);
}

.rt-collab-page .rt-collab-config-summary-state {
  margin-left: auto;
  color: var(--rt-muted, #9da5bd);
  font-size:var(--ui-text-helper);
  white-space: nowrap;
}

.rt-collab-page .rt-collab-config-body {
  display: grid;
  gap: 12px;
  padding: 0 12px 12px;
  border-top: 1px solid var(--rt-border, #303647);
}

.rt-collab-page .rt-collab-card {
  margin: 0;
  border: 1px solid var(--rt-border, #303647);
  border-radius: 10px;
  padding: 14px;
  background: var(--rt-bg-elevated, #202635);
}

.rt-collab-page .rt-collab-card-heading {
  margin-bottom: 12px;
}

.rt-collab-page .rt-collab-rule-copy {
  color: var(--rt-ink-soft, #d8dced);
  font-size:var(--ui-text-helper);
  line-height:var(--ui-leading-body);
}

.rt-collab-page .rt-collab-role-grid {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: 10px;
}

.rt-collab-page .rt-collab-role-card {
  min-width: 0;
  border: 1px solid var(--rt-border, #303647);
  border-radius: 9px;
  padding: 12px;
  background: var(--rt-bg-surface, #1d2230);
}

.rt-collab-page .rt-collab-role-card-head {
  display: flex;
  align-items: flex-start;
  gap: 9px;
  margin-bottom: 10px;
}

.rt-collab-page .rt-collab-role-no {
  display: grid;
  place-items: center;
  width: 26px;
  height: 26px;
  flex: none;
  border-radius: 7px;
  color: var(--rt-accent, #b5a8ff);
  background: rgb(126 106 239 / 18%);
  font-size:var(--ui-text-helper);
  font-weight:600;
  letter-spacing:normal;
}

.rt-collab-page .rt-collab-role-card h4 {
  margin: 0;
  color: var(--rt-ink, #eef1fb);
  font-size:var(--ui-text-section);
  line-height:var(--ui-leading-title);
}

.rt-collab-page .rt-collab-role-card code {
  display: inline-block;
  margin-top: 3px;
  color: var(--rt-accent, #b5a8ff);
  font-size:var(--ui-text-helper);
  line-height:var(--ui-leading-body);
}

.rt-collab-page .rt-collab-role-card p {
  min-height: 42px;
  margin: 0;
  color: var(--rt-ink-soft, #d8dced);
  font-size:var(--ui-text-helper);
  line-height:var(--ui-leading-body);
}

.rt-collab-page .rt-collab-concurrency-editor .rt-card,
.rt-collab-page .rt-collab-prompts .rt-card {
  border: 0;
  padding: 0;
  background: transparent;
}

.rt-collab-page .rt-collab-prompts {
  overflow: hidden;
}

.rt-collab-page .rt-collab-prompts > .rt-split {
  min-height: 380px;
  margin: 0 -14px -14px;
  border-top: 1px solid var(--rt-border, #303647);
  background: var(--rt-bg-surface, #1d2230);
}

.rt-collab-page .rt-collab-prompts .rt-list,
.rt-collab-page .rt-collab-prompts .rt-main {
  min-width: 0;
  background: var(--rt-bg-surface, #1d2230);
}

.rt-collab-page .rt-collab-prompts .rt-list {
  border-right-color: var(--rt-border, #303647);
}

.rt-collab-page .rt-collab-prompts .rt-textarea {
  min-height: 300px;
}

.rt-collab-page .rt-collab-pane > .rt-err {
  max-width: 980px;
  margin: 0 auto 12px;
}

@media (max-width: 860px) {
  .rt-collab-page .rt-collab-role-grid {
    grid-template-columns: repeat(2, minmax(0, 1fr));
  }
}

@media (max-width: 620px) {
  .rt-collab-page .rt-collab-pane {
    padding: 14px 10px 22px;
  }

  .rt-collab-page .rt-collab-section-head,
  .rt-collab-page .rt-collab-card-heading {
    display: block;
  }

  .rt-collab-page .rt-collab-readonly-badge,
  .rt-collab-page .rt-collab-config-badge {
    display: inline-block;
    margin-top: 8px;
  }

  .rt-collab-page .rt-collab-role-grid {
    grid-template-columns: minmax(0, 1fr);
  }

  .rt-collab-page .rt-collab-config-summary {
    padding: 10px 12px;
  }

  .rt-collab-page .rt-collab-config-summary-state {
    display: none;
  }

  .rt-collab-page .rt-collab-config-body {
    padding-right: 8px;
    padding-left: 8px;
  }
}

@media (prefers-reduced-motion: reduce) {
  .rt-collab-page .rt-collab-config-summary::before {
    transition: none;
  }
}

/* Shared alignment and real panel-width responsiveness. */
.rt-collab-page .rt-collab-pane{padding:24px 28px 28px}
.rt-collab-page .rt-collab-hero,.rt-collab-page .rt-collab-section,.rt-collab-page .rt-collab-config{max-width:none;margin-left:0;margin-right:0}
.rt-collab-page .rt-collab-title{font-size:var(--ui-text-title);font-weight:600;letter-spacing:-.6px}
.rt-collab-page .rt-session-map-layout{min-height:320px;max-height:360px}
.rt-collab-page .rt-session-map-graph-pane{height:320px;min-height:0}
.rt-collab-page .rt-session-map-detail{max-height:320px;overflow:auto}
.rt-collab-page .rt-collab-readonly-badge,.rt-collab-page .rt-collab-config-badge{background:var(--rt-accent-soft);border-color:var(--rt-border)}
@container workspace (max-width:1050px){
 .rt-collab-page .rt-collab-role-grid{grid-template-columns:repeat(2,minmax(0,1fr))}
 .rt-collab-page .rt-collab-prompts>.rt-split{flex-direction:column}
 .rt-collab-page .rt-collab-prompts .rt-list{width:auto;max-height:210px;border-right:0;border-bottom:1px solid var(--rt-border)}
 .rt-collab-page .rt-session-map-layout{grid-template-columns:minmax(0,1fr);max-height:none}
 .rt-collab-page .rt-session-map-graph-pane{border-right:0;border-bottom:1px solid var(--rt-border);height:280px}
 .rt-collab-page .rt-session-map-detail{max-height:280px}
 .rt-collab-page .rt-session-map-toolbar{flex-wrap:wrap}
}
@container workspace (max-width:720px){
 .rt-collab-page .rt-collab-pane{padding:20px 16px}
 .rt-collab-page .rt-collab-role-grid{grid-template-columns:minmax(0,1fr)}
 .rt-collab-page .rt-collab-section-head,.rt-collab-page .rt-collab-card-heading{display:block}
 .rt-collab-page .rt-collab-config-summary-state{display:none}
 .rt-collab-page .rt-collab-config-body{padding:12px 8px}
}

/* Floating and full-page shells use the rt size container. */
@container rt (max-width:1050px){
 .rt-collab-page .rt-collab-role-grid{grid-template-columns:repeat(2,minmax(0,1fr))}
 .rt-collab-page .rt-collab-prompts>.rt-split{flex-direction:column}
 .rt-collab-page .rt-collab-prompts .rt-list{width:auto;max-height:210px;border-right:0;border-bottom:1px solid var(--rt-border)}
 .rt-collab-page .rt-session-map-layout{grid-template-columns:minmax(0,1fr);max-height:none}
 .rt-collab-page .rt-session-map-graph-pane{border-right:0;border-bottom:1px solid var(--rt-border);height:280px}
 .rt-collab-page .rt-session-map-detail{max-height:280px}
 .rt-collab-page .rt-session-map-toolbar{flex-wrap:wrap}
}
@container rt (max-width:720px){
 .rt-collab-page .rt-collab-pane{padding:20px 16px}
 .rt-collab-page .rt-collab-role-grid{grid-template-columns:minmax(0,1fr)}
 .rt-collab-page .rt-collab-section-head,.rt-collab-page .rt-collab-card-heading{display:block}
 .rt-collab-page .rt-collab-config-summary-state{display:none}
 .rt-collab-page .rt-collab-config-body{padding:12px 8px}
}

/* Session map interaction stays local to the read-only visualization. */
.rt-session-map .rt-session-map-graph-pane{position:relative;overflow:hidden;cursor:grab;touch-action:none;user-select:none}
.rt-session-map .rt-session-map-graph-pane[data-dragging=true],.rt-session-map .rt-session-map-graph-pane[data-dragging=true] *{cursor:grabbing}
.rt-session-map .rt-session-map-graph{display:block;width:100%;height:100%;min-width:0;min-height:0}
.rt-session-map .rt-session-map-node-id{font:600 12px -apple-system,BlinkMacSystemFont,"Segoe UI","PingFang SC",sans-serif}
.rt-session-map .rt-session-map-node:focus-visible rect{stroke:var(--rt-accent);stroke-width:3}
.rt-session-map .rt-session-map-graph-pane:focus-visible{outline:2px solid var(--rt-accent);outline-offset:-3px}
.rt-session-map-zoom{font-variant-numeric:tabular-nums;font-size:var(--ui-text-helper);color:var(--rt-muted);min-width:34px;text-align:center}
.rt-session-map.rt-session-map-expanded,.rt-session-map:fullscreen{position:fixed!important;inset:0!important;width:100vw!important;height:100vh!important;max-width:none!important;max-height:none!important;margin:0!important;border-radius:0!important;z-index:2147483000;display:flex;flex-direction:column;background:var(--rt-bg-base,#15181f);color:var(--rt-ink,#ececf4);overflow:hidden}
.rt-session-map.rt-session-map-expanded>.rt-session-map-layout,.rt-session-map:fullscreen>.rt-session-map-layout{flex:1;min-height:0;max-height:none;grid-template-columns:minmax(0,1fr) minmax(260px,320px)}
.rt-session-map.rt-session-map-expanded .rt-session-map-graph-pane,.rt-session-map:fullscreen .rt-session-map-graph-pane{height:100%;min-height:0}
.rt-session-map.rt-session-map-expanded .rt-session-map-detail,.rt-session-map:fullscreen .rt-session-map-detail{max-height:none;min-height:0;height:100%}
.rt-session-map.rt-session-map-expanded>.rt-session-map-head,.rt-session-map.rt-session-map-expanded>.rt-session-map-toolbar,.rt-session-map.rt-session-map-expanded>.rt-session-map-note,.rt-session-map.rt-session-map-expanded>.rt-session-map-foot{flex:none}
@media(max-width:720px){
 .rt-session-map.rt-session-map-expanded>.rt-session-map-layout,.rt-session-map:fullscreen>.rt-session-map-layout{grid-template-columns:minmax(0,1fr);grid-template-rows:minmax(200px,1fr) minmax(140px,.55fr)}
 .rt-session-map.rt-session-map-expanded .rt-session-map-graph-pane{border-right:0;border-bottom:1px solid var(--rt-border)}
}

/* Abbreviate SVG captions only; detail names remain complete and selectable. */
.rt-session-map .rt-session-map-detail-title,.rt-session-map .rt-session-map-detail-name{display:block;white-space:pre-wrap;overflow:visible;text-overflow:clip;-webkit-line-clamp:unset;max-height:none;overflow-wrap:anywhere;word-break:normal;user-select:text}
.rt-session-map .rt-session-map-detail-title{font-size:var(--ui-text-section);line-height:var(--ui-leading-title);margin-bottom:6px}
.rt-session-map .rt-session-map-detail-grid dd{min-width:0}

/* Read-only session map: dense enough for a project overview, readable enough for
 * the complete task and relationship data. Keep every rule under the
 * collaboration page so the shared session-map widget keeps its other skins. */
.rt-collab-page .rt-session-map {
  color: var(--rt-ink, #282a37);
  background: var(--rt-bg-surface, #fff);
}

.rt-collab-page .rt-session-map .rt-session-map-head,
.rt-collab-page .rt-session-map .rt-session-map-toolbar,
.rt-collab-page .rt-session-map .rt-session-map-note,
.rt-collab-page .rt-session-map .rt-session-map-foot {
  flex: none;
  background: var(--rt-bg-surface, #fff);
}

.rt-collab-page .rt-session-map .rt-session-map-stats {
  display: grid;
  grid-template-columns: repeat(4, minmax(0, 1fr));
  gap: 8px;
  padding: 10px 12px;
  border-bottom: 1px solid var(--rt-border, #e3e3ed);
  background: var(--rt-bg-base, #f6f5fb);
}

.rt-collab-page .rt-session-map .rt-session-map-stat {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 7px;
  min-width: 0;
  border: 1px solid var(--rt-border, #e3e3ed);
  border-radius: 8px;
  padding: 7px 9px;
  background: var(--rt-bg-surface, #fff);
}

.rt-collab-page .rt-session-map .rt-session-map-stat small {
  min-width: 0;
  overflow: hidden;
  color: var(--rt-muted, #7c8090);
  font-size:var(--ui-text-helper);
  line-height:var(--ui-leading-body);
  text-overflow: ellipsis;
  white-space: nowrap;
}

.rt-collab-page .rt-session-map .rt-session-map-stat b {
  flex: none;
  color: var(--rt-ink, #282a37);
  font-size:var(--ui-text-metric);
  font-variant-numeric: tabular-nums;
  line-height:var(--ui-leading-body);
}

.rt-collab-page .rt-session-map .rt-session-map-stat[data-activity="running"] b {
  color: var(--rt-success, #3b8567);
}

.rt-collab-page .rt-session-map .rt-session-map-stat[data-activity="idle"] b {
  color: var(--rt-muted, #7c8090);
}

.rt-collab-page .rt-session-map .rt-session-map-stat[data-activity="unknown"] b {
  color: var(--rt-warning, #9c741e);
}

/* The graph has room for the task and provenance captions added to each node. */
.rt-collab-page .rt-session-map .rt-session-map-layout {
  grid-template-columns: minmax(0, 1fr) minmax(340px, 380px);
  height: clamp(480px, 62vh, 560px);
  min-height: 480px;
  max-height: 560px;
}

.rt-collab-page .rt-session-map .rt-session-map-graph-pane {
  height: 100%;
  min-height: 0;
  border-right-color: var(--rt-border, #e3e3ed);
  background: var(--rt-bg-base, #f6f5fb);
}

.rt-collab-page .rt-session-map .rt-session-map-graph {
  min-height: 100%;
}

.rt-collab-page .rt-session-map .rt-session-map-node rect {
  fill: var(--rt-bg-surface, #fff);
  stroke: var(--rt-border-strong, #cdc9df);
}

.rt-collab-page .rt-session-map .rt-session-map-node:hover rect,
.rt-collab-page .rt-session-map .rt-session-map-node.selected rect {
  stroke: var(--rt-accent, #7661d3);
}

.rt-collab-page .rt-session-map .rt-session-map-node-id {
  fill: var(--rt-ink, #282a37);
  font:600 var(--ui-text-helper)/var(--ui-leading-body) var(--ui-font);
}

.rt-collab-page .rt-session-map .rt-session-map-node-meta,
.rt-collab-page .rt-session-map .rt-session-map-node-foot {
  fill: var(--rt-muted, #7c8090);
  font:400 var(--ui-text-helper)/var(--ui-leading-body) var(--ui-font);
}

.rt-collab-page .rt-session-map .rt-session-map-node-task {
  fill: var(--rt-ink-soft, var(--rt-ink, #282a37));
  font:400 var(--ui-text-helper)/var(--ui-leading-body) var(--ui-font);
}

.rt-collab-page .rt-session-map .rt-session-map-detail {
  display: block;
  height: 100%;
  min-height: 0;
  max-height: none;
  overflow: auto;
  overscroll-behavior: contain;
  padding: 18px 18px 20px;
  background: var(--rt-bg-surface, #fff);
  scrollbar-gutter: stable;
}

.rt-collab-page .rt-session-map .rt-session-map-detail-heading {
  min-width: 0;
  padding-bottom: 13px;
  border-bottom: 1px solid var(--rt-border, #e3e3ed);
}

.rt-collab-page .rt-session-map .rt-session-map-detail-heading > small,
.rt-collab-page .rt-session-map .rt-session-map-detail-kicker {
  display: block;
  margin-bottom: 5px;
  color: var(--rt-accent, #7661d3);
  font-size:var(--ui-text-helper);
  font-weight:600;
  letter-spacing:normal;
  line-height:var(--ui-leading-body);
  text-transform: uppercase;
}

.rt-collab-page .rt-session-map .rt-session-map-detail-heading .rt-session-map-detail-title {
  margin: 0;
  color: var(--rt-ink, #282a37);
  font-size:var(--ui-text-section);
  font-weight:600;
  line-height:var(--ui-leading-title);
}

.rt-collab-page .rt-session-map .rt-session-map-detail-heading .rt-session-map-detail-status {
  margin-top: 7px;
  color: var(--rt-muted, #7c8090);
  font-size:var(--ui-text-helper);
  line-height:var(--ui-leading-body);
}

.rt-collab-page .rt-session-map .rt-session-map-detail-section {
  margin-top: 15px;
  padding-top: 13px;
  border-top: 1px solid var(--rt-border, #e3e3ed);
}

.rt-collab-page .rt-session-map .rt-session-map-detail-section h4 {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 8px;
  margin: 0;
  color: var(--rt-ink, #282a37);
  font-size:var(--ui-text-section);
  font-weight:600;
  line-height:var(--ui-leading-title);
}

.rt-collab-page .rt-session-map .rt-session-map-detail-section h4 small {
  flex: none;
  color: var(--rt-muted, #7c8090);
  font-size:var(--ui-text-section);
  font-weight:500;
  line-height:var(--ui-leading-title);
}

.rt-collab-page .rt-session-map .rt-session-map-detail-section > p,
.rt-collab-page .rt-session-map .rt-session-map-task-summary,
.rt-collab-page .rt-session-map .rt-session-map-status-explainer {
  margin: 7px 0 0;
  color: var(--rt-muted, #7c8090);
  font-size:var(--ui-text-helper);
  line-height:var(--ui-leading-body);
  overflow-wrap: anywhere;
  white-space: normal;
}

.rt-collab-page .rt-session-map .rt-session-map-task-summary {
  color: var(--rt-ink-soft, var(--rt-ink, #282a37));
}

.rt-collab-page .rt-session-map .rt-session-map-todos {
  display: grid;
  gap: 7px;
  margin: 9px 0 0;
  padding-left: 22px;
  color: var(--rt-ink-soft, var(--rt-ink, #282a37));
  font-size:var(--ui-text-helper);
  line-height:var(--ui-leading-body);
}

.rt-collab-page .rt-session-map .rt-session-map-todo {
  min-width: 0;
  padding-left: 2px;
  overflow-wrap: anywhere;
}

.rt-collab-page .rt-session-map .rt-session-map-todo::marker {
  color: var(--rt-muted, #7c8090);
  font-size:var(--ui-text-helper);
}

.rt-collab-page .rt-session-map .rt-session-map-todo-state {
  display: inline-block;
  margin-right: 6px;
  border: 1px solid var(--rt-border, #e3e3ed);
  border-radius: 999px;
  padding: 2px 6px;
  color: var(--rt-muted, #7c8090);
  background: var(--rt-bg-subtle, #f5f4f9);
  font-size:var(--ui-text-helper);
  font-weight:600;
  line-height:var(--ui-leading-body);
  vertical-align: 1px;
  white-space: nowrap;
}

.rt-collab-page .rt-session-map .rt-session-map-todo[data-status="in_progress"] .rt-session-map-todo-state {
  border-color: color-mix(in srgb, var(--rt-accent, #7661d3) 34%, var(--rt-border, #e3e3ed));
  color: var(--rt-accent, #7661d3);
  background: var(--rt-accent-soft, #eeeafb);
}

.rt-collab-page .rt-session-map .rt-session-map-todo[data-status="completed"] .rt-session-map-todo-state {
  border-color: color-mix(in srgb, var(--rt-success, #3b8567) 35%, var(--rt-border, #e3e3ed));
  color: var(--rt-success, #3b8567);
  background: var(--rt-success-bg, #e9f4ed);
}

.rt-collab-page .rt-session-map .rt-session-map-todo[data-status="completed"] .rt-session-map-todo-content {
  color: var(--rt-muted, #7c8090);
  text-decoration: line-through;
  text-decoration-color: color-mix(in srgb, var(--rt-muted, #7c8090) 45%, transparent);
}

.rt-collab-page .rt-session-map .rt-session-map-clipped {
  margin-top: 8px;
  color: var(--rt-warning, #9c741e);
  font-size:var(--ui-text-helper);
  line-height:var(--ui-leading-body);
}

.rt-collab-page .rt-session-map .rt-session-map-task-progress {
  position: relative;
  height: 7px;
  margin-top: 10px;
  overflow: hidden;
  border: 1px solid var(--rt-border, #e3e3ed);
  border-radius: 999px;
  background: var(--rt-bg-subtle, #f5f4f9);
}

.rt-collab-page .rt-session-map .rt-session-map-task-progress > i,
.rt-collab-page .rt-session-map .rt-session-map-task-progress > span,
.rt-collab-page .rt-session-map .rt-session-map-task-progress > [style*="width"] {
  display: block;
  height: 100%;
  min-width: 0;
  border-radius: inherit;
  background: var(--rt-accent, #7661d3);
}

.rt-collab-page .rt-session-map .rt-session-map-empty-info {
  margin-top: 9px;
  border: 1px dashed var(--rt-border-strong, #cdc9df);
  border-radius: 8px;
  padding: 10px 11px;
  color: var(--rt-muted, #7c8090);
  background: var(--rt-bg-base, #f6f5fb);
  font-size:var(--ui-text-helper);
  line-height:var(--ui-leading-body);
}

.rt-collab-page .rt-session-map .rt-session-map-relations {
  display: grid;
  gap: 7px;
  margin-top: 9px;
}

.rt-collab-page .rt-session-map .rt-session-map-relation {
  display: grid;
  grid-template-columns: auto minmax(0, 1fr);
  grid-template-areas: "role name" "role state";
  align-items: baseline;
  column-gap: 8px;
  width: 100%;
  min-width: 0;
  border: 1px solid var(--rt-border, #e3e3ed);
  border-radius: 8px;
  padding: 8px 9px;
  cursor: pointer;
  font: inherit;
  color: var(--rt-ink, #282a37);
  background: var(--rt-bg-surface, #fff);
  text-align: left;
}

.rt-collab-page .rt-session-map .rt-session-map-relation:hover {
  border-color: var(--rt-border-strong, #cdc9df);
  background: var(--rt-bg-subtle, #f5f4f9);
}

.rt-collab-page .rt-session-map .rt-session-map-relation > span,
.rt-collab-page .rt-session-map .rt-session-map-relation .role {
  grid-area: role;
  align-self: center;
  color: var(--rt-accent, #7661d3);
  font-size:var(--ui-text-helper);
  font-weight:600;
  letter-spacing:normal;
  line-height:var(--ui-leading-body);
  text-transform: uppercase;
}

.rt-collab-page .rt-session-map .rt-session-map-relation strong {
  grid-area: name;
  min-width: 0;
  overflow-wrap: anywhere;
  color: var(--rt-ink, #282a37);
  font-size:var(--ui-text-helper);
  font-weight:600;
  line-height:var(--ui-leading-body);
}

.rt-collab-page .rt-session-map .rt-session-map-relation small {
  grid-area: state;
  min-width: 0;
  color: var(--rt-muted, #7c8090);
  font-size:var(--ui-text-helper);
  line-height:var(--ui-leading-body);
}

.rt-collab-page .rt-session-map .rt-session-map-lineage {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 5px 3px;
  margin-top: 9px;
  color: var(--rt-muted, #7c8090);
  font-size:var(--ui-text-helper);
  line-height:var(--ui-leading-body);
}

.rt-collab-page .rt-session-map .rt-session-map-ancestor {
  min-width: 0;
  border: 0;
  padding: 2px 4px;
  cursor: pointer;
  font-family:var(--ui-font);
  color: var(--rt-accent, #7661d3);
  background: transparent;
  font-size: inherit;
  line-height: inherit;
  text-align: left;
}

.rt-collab-page .rt-session-map .rt-session-map-ancestor:hover {
  color: var(--rt-accent-strong, #6852ce);
  text-decoration: underline;
}

.rt-collab-page .rt-session-map .rt-session-map-metadata {
  display: block;
  margin-top: 15px;
  border-top: 1px solid var(--rt-border, #e3e3ed);
  padding-top: 12px;
}

.rt-collab-page .rt-session-map .rt-session-map-metadata > summary {
  cursor: pointer;
  color: var(--rt-muted, #7c8090);
  font-size:var(--ui-text-helper);
  font-weight:600;
  line-height:var(--ui-leading-body);
}

.rt-collab-page .rt-session-map .rt-session-map-metadata > summary::marker {
  color: var(--rt-accent, #7661d3);
}

.rt-collab-page .rt-session-map .rt-session-map-metadata[open] > summary {
  color: var(--rt-ink, #282a37);
}

.rt-collab-page .rt-session-map .rt-session-map-metadata .rt-session-map-detail-grid {
  margin-top: 11px;
  grid-template-columns: 82px minmax(0, 1fr);
  gap: 6px 9px;
  color: var(--rt-ink, #282a37);
}

.rt-collab-page .rt-session-map .rt-session-map-metadata .rt-session-map-detail-grid dt {
  color: var(--rt-muted, #7c8090);
}

.rt-collab-page .rt-session-map .rt-session-map-metadata .rt-session-map-detail-grid dd {
  color: var(--rt-ink, #282a37);
  overflow-wrap: anywhere;
  white-space: pre-wrap;
}

/* Expanded maps use the available height while keeping the details rail
 * independently scrollable. The stats row and controls never collapse away. */
.rt-collab-page .rt-session-map.rt-session-map-expanded,
.rt-collab-page .rt-session-map:fullscreen {
  background: var(--rt-bg-base, #15181f);
  color: var(--rt-ink, #ececf4);
}

.rt-collab-page .rt-session-map.rt-session-map-expanded > .rt-session-map-stats,
.rt-collab-page .rt-session-map:fullscreen > .rt-session-map-stats {
  flex: none;
}

.rt-collab-page .rt-session-map.rt-session-map-expanded > .rt-session-map-layout,
.rt-collab-page .rt-session-map:fullscreen > .rt-session-map-layout {
  display: grid;
  flex: 1 1 0;
  grid-template-columns: minmax(0, 1fr) minmax(340px, 400px);
  height: auto;
  min-height: 0;
  max-height: none;
}

.rt-collab-page .rt-session-map.rt-session-map-expanded .rt-session-map-graph-pane,
.rt-collab-page .rt-session-map:fullscreen .rt-session-map-graph-pane,
.rt-collab-page .rt-session-map.rt-session-map-expanded .rt-session-map-detail,
.rt-collab-page .rt-session-map:fullscreen .rt-session-map-detail {
  height: 100%;
  min-height: 0;
  max-height: none;
}

.rt-collab-page .rt-session-map.rt-session-map-expanded .rt-session-map-detail,
.rt-collab-page .rt-session-map:fullscreen .rt-session-map-detail {
  overflow: auto;
}

/* Normal narrow containers stack the two panes, but cap each inner panel so
 * the collaboration page itself remains the outer scroll surface. */
@container workspace (max-width: 1050px) {
  .rt-collab-page .rt-session-map .rt-session-map-layout {
    grid-template-columns: minmax(0, 1fr);
    grid-template-rows: minmax(300px, 380px) minmax(240px, auto);
    height: auto;
    min-height: 0;
    max-height: none;
  }

  .rt-collab-page .rt-session-map .rt-session-map-graph-pane {
    height: 360px;
    min-height: 300px;
    border-right: 0;
    border-bottom: 1px solid var(--rt-border, #e3e3ed);
  }

  .rt-collab-page .rt-session-map .rt-session-map-detail {
    height: auto;
    min-height: 240px;
    max-height: 380px;
  }
}

@container rt (max-width: 1050px) {
  .rt-collab-page .rt-session-map .rt-session-map-layout {
    grid-template-columns: minmax(0, 1fr);
    grid-template-rows: minmax(300px, 380px) minmax(240px, auto);
    height: auto;
    min-height: 0;
    max-height: none;
  }

  .rt-collab-page .rt-session-map .rt-session-map-graph-pane {
    height: 360px;
    min-height: 300px;
    border-right: 0;
    border-bottom: 1px solid var(--rt-border, #e3e3ed);
  }

  .rt-collab-page .rt-session-map .rt-session-map-detail {
    height: auto;
    min-height: 240px;
    max-height: 380px;
  }
}

@container workspace (max-width: 720px) {
  .rt-collab-page .rt-session-map .rt-session-map-stats {
    grid-template-columns: repeat(2, minmax(0, 1fr));
  }

  .rt-collab-page .rt-session-map .rt-session-map-graph-pane {
    height: 300px;
  }

  .rt-collab-page .rt-session-map .rt-session-map-detail {
    max-height: 300px;
    padding: 15px 14px 18px;
  }
}

@container rt (max-width: 720px) {
  .rt-collab-page .rt-session-map .rt-session-map-stats {
    grid-template-columns: repeat(2, minmax(0, 1fr));
  }

  .rt-collab-page .rt-session-map .rt-session-map-graph-pane {
    height: 300px;
  }

  .rt-collab-page .rt-session-map .rt-session-map-detail {
    max-height: 300px;
    padding: 15px 14px 18px;
  }
}

@media (max-width: 720px) {
  .rt-collab-page .rt-session-map .rt-session-map-stats {
    grid-template-columns: repeat(2, minmax(0, 1fr));
  }

  .rt-collab-page .rt-session-map:not(.rt-session-map-expanded):not(:fullscreen) .rt-session-map-layout {
    grid-template-columns: minmax(0, 1fr);
    grid-template-rows: minmax(280px, 300px) minmax(220px, auto);
    height: auto;
    min-height: 0;
    max-height: none;
  }

  .rt-collab-page .rt-session-map:not(.rt-session-map-expanded):not(:fullscreen) .rt-session-map-graph-pane {
    height: 300px;
    min-height: 280px;
    border-right: 0;
    border-bottom: 1px solid var(--rt-border, #e3e3ed);
  }

  .rt-collab-page .rt-session-map:not(.rt-session-map-expanded):not(:fullscreen) .rt-session-map-detail {
    height: auto;
    min-height: 220px;
    max-height: 300px;
    padding: 15px 14px 18px;
  }

  .rt-collab-page .rt-session-map.rt-session-map-expanded > .rt-session-map-layout,
  .rt-collab-page .rt-session-map:fullscreen > .rt-session-map-layout {
    grid-template-columns: minmax(0, 1fr);
    grid-template-rows: minmax(200px, 1fr) minmax(180px, .55fr);
    height: auto;
    max-height: calc(100vh - 1px);
  }

  .rt-collab-page .rt-session-map.rt-session-map-expanded .rt-session-map-graph-pane,
  .rt-collab-page .rt-session-map:fullscreen .rt-session-map-graph-pane {
    height: auto;
    min-height: 200px;
    border-right: 0;
    border-bottom: 1px solid var(--rt-border, #e3e3ed);
  }

  .rt-collab-page .rt-session-map.rt-session-map-expanded .rt-session-map-detail,
  .rt-collab-page .rt-session-map:fullscreen .rt-session-map-detail {
    height: auto;
    min-height: 180px;
    max-height: none;
  }
}

.rt-collab-page .rt-session-map .rt-session-map-detail-updated{display:block;margin-top:8px;color:var(--rt-muted);font-size:var(--ui-text-helper);line-height:1.5}
.rt-collab-page .rt-session-map .rt-session-map-execution-grid{display:grid;gap:9px;margin-top:12px}
.rt-collab-page .rt-session-map .rt-session-map-execution-grid>div{display:grid;grid-template-columns:110px minmax(0,1fr);gap:10px;font-size:var(--ui-text-helper);line-height:1.6}
.rt-collab-page .rt-session-map .rt-session-map-execution-grid span{color:var(--rt-muted)}
.rt-collab-page .rt-session-map .rt-session-map-execution-grid b{color:var(--rt-ink);font-weight:500;overflow-wrap:anywhere}
.rt-collab-page .rt-session-map .rt-session-map-detail-heading>.rt-session-map-detail-updated{color:var(--rt-muted);font-size:var(--ui-text-helper);font-weight:400;letter-spacing:0;text-transform:none}

/* Keep every control and the footer reachable in short fullscreen windows. */
@media(max-height:720px){
  .rt-collab-page .rt-session-map.rt-session-map-expanded,
  .rt-collab-page .rt-session-map:fullscreen{overflow-y:auto;overscroll-behavior:contain}
  .rt-collab-page .rt-session-map.rt-session-map-expanded>.rt-session-map-layout,
  .rt-collab-page .rt-session-map:fullscreen>.rt-session-map-layout{flex:1 0 380px;min-height:380px}
}

/* Compact the collaboration header and reserve the first screen for the map. */
:is(.rt-dock,.rt-full)>.rt-body[data-page=agents]>.rt-workspace-pagehead{padding:12px var(--rt-page-x) 6px}
:is(.rt-dock,.rt-full)>.rt-body[data-page=agents]>.rt-workspace-pagehead .rt-workspace-heading{display:flex;align-items:baseline;flex-wrap:wrap;gap:4px 12px}
:is(.rt-dock,.rt-full)>.rt-body[data-page=agents]>.rt-workspace-pagehead .rt-workspace-eyebrow{margin:0}
:is(.rt-dock,.rt-full)>.rt-body[data-page=agents]>.rt-workspace-pagehead h1{font-size:var(--ui-text-title);line-height:1.3}
:is(.rt-dock,.rt-full)>.rt-body[data-page=agents]>.rt-workspace-pagehead p{margin:0;font-size:var(--ui-text-helper);line-height:1.5}
:is(.rt-dock,.rt-full) .rt-page-content[data-page=agents]>.rt-collab-page>.rt-collab-toolbar{min-height:0;padding:0 var(--rt-page-x) 6px;gap:7px}
:is(.rt-dock,.rt-full) .rt-page-content[data-page=agents]>.rt-collab-page>.rt-collab-pane{display:flex;flex-direction:column;gap:12px;padding:10px var(--rt-page-x) 16px}
.rt-collab-page .rt-collab-scope{display:flex;flex-direction:column;flex:0 0 auto;min-height:calc(100% - 12px);margin-bottom:0}
.rt-collab-page .rt-collab-config{flex:none;margin-bottom:0}
.rt-collab-page .rt-collab-scope>.rt-collab-section-head{flex:none;align-items:center;padding:9px 12px}
.rt-collab-page .rt-collab-scope>.rt-collab-section-head>div{display:flex;align-items:baseline;flex-wrap:wrap;gap:4px 12px}
.rt-collab-page .rt-collab-scope>.rt-collab-section-head h2{font-size:var(--ui-text-helper)}
.rt-collab-page .rt-collab-scope>.rt-collab-section-head p{margin:0;font-size:var(--ui-text-helper)}
.rt-collab-page .rt-collab-scope>.rt-session-map:not(.rt-session-map-expanded):not(:fullscreen){display:flex;flex-direction:column;flex:1;min-height:0}
.rt-collab-page .rt-collab-scope>.rt-session-map>.rt-session-map-head{padding:7px 10px}
.rt-collab-page .rt-collab-scope>.rt-session-map>.rt-session-map-note{padding:4px 10px;font-size:var(--ui-text-helper)}
.rt-collab-page .rt-collab-scope>.rt-session-map>.rt-session-map-stats{padding:6px 10px;gap:6px}
.rt-collab-page .rt-collab-scope>.rt-session-map .rt-session-map-stat{padding:5px 8px}
.rt-collab-page .rt-collab-scope>.rt-session-map>.rt-session-map-toolbar{padding:6px 10px}
.rt-collab-page .rt-collab-scope>.rt-session-map:not(.rt-session-map-expanded):not(:fullscreen)>.rt-session-map-layout{flex:1 0 340px;height:auto;min-height:340px;max-height:none}
.rt-collab-page .rt-collab-scope>.rt-session-map:not(.rt-session-map-expanded):not(:fullscreen) .rt-session-map-graph-pane{height:100%;min-height:0}
.rt-collab-page .rt-collab-scope>.rt-session-map:not(.rt-session-map-expanded):not(:fullscreen) .rt-session-map-detail{height:100%;min-height:0;max-height:none}
@container workspace (max-width:1050px){
 .rt-collab-page .rt-collab-scope>.rt-session-map:not(.rt-session-map-expanded):not(:fullscreen)>.rt-session-map-layout{flex:none;height:auto;min-height:0;grid-template-rows:360px minmax(240px,auto)}
 .rt-collab-page .rt-collab-scope>.rt-session-map:not(.rt-session-map-expanded):not(:fullscreen) .rt-session-map-detail{height:auto;max-height:360px}
}
@container rt (max-width:1050px){
 .rt-collab-page .rt-collab-scope>.rt-session-map:not(.rt-session-map-expanded):not(:fullscreen)>.rt-session-map-layout{flex:none;height:auto;min-height:0;grid-template-rows:360px minmax(240px,auto)}
 .rt-collab-page .rt-collab-scope>.rt-session-map:not(.rt-session-map-expanded):not(:fullscreen) .rt-session-map-detail{height:auto;max-height:360px}
}


/* Environment & settings page: scoped to EnvTab's rt-settings subtree. */
.rt-settings {
  --rt-settings-card-gap: 16px;
  background: var(--rt-bg-base, #f3f5f8);
  color: var(--rt-ink, #18212f);
}

.rt-settings-toolbar {
  background: var(--rt-bg-surface, #fff);
  border-bottom-color: var(--rt-border, #dce3eb);
  color: var(--rt-ink, #18212f);
  padding: 10px 20px;
  min-height: 46px;
}

.rt-settings-scroll {
  background: var(--rt-bg-base, #f3f5f8);
  color: var(--rt-ink, #18212f);
  overflow: auto;
  padding: 28px 32px 36px;
}

.rt-settings-pagehead {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 24px;
  max-width: 1180px;
  margin: 0 auto 20px;
}

.rt-settings-pagehead-copy {
  min-width: 0;
}

.rt-settings-eyebrow {
  color: var(--rt-accent, #6d56c7);
  font-size:var(--ui-text-helper);
  font-weight:600;
  letter-spacing:normal;
  line-height:var(--ui-leading-body);
  margin-bottom: 6px;
  text-transform: uppercase;
}

.rt-settings-pagehead h1 {
  color: var(--rt-ink, #18212f);
  font-size:var(--ui-text-title);
  line-height:var(--ui-leading-title);
  margin: 0;
}

.rt-settings-pagehead p,
.rt-settings-section-head p,
.rt-settings-card-head p {
  color: var(--rt-muted, #64748b);
  font-size:var(--ui-text-helper);
  line-height:var(--ui-leading-body);
  margin: 7px 0 0;
}

.rt-settings-pagehead-context {
  align-items: flex-end;
  background: var(--rt-bg-surface, #fff);
  border: 1px solid var(--rt-border, #dce3eb);
  border-radius: 8px;
  display: flex;
  flex-direction: column;
  gap: 3px;
  max-width: min(42%, 360px);
  padding: 8px 11px;
}

.rt-settings-context-label {
  color: var(--rt-muted, #64748b);
  font-size:var(--ui-text-helper);
}

.rt-settings-context-value {
  color: var(--rt-ink, #18212f);
  font-family:var(--ui-mono);
  font-size:var(--ui-text-helper);
  max-width: 100%;
  overflow-wrap: anywhere;
  text-align: right;
}

.rt-settings-summary {
  display: grid;
  gap: 0;
  grid-template-columns: repeat(4, minmax(0, 1fr));
  max-width: 1180px;
  margin: 0 auto 22px;
}

.rt-settings-summary-card {
  align-items: center;
  background: var(--rt-bg-surface, #fff);
  border-bottom: 1px solid var(--rt-border, #dce3eb);
  border-top: 1px solid var(--rt-border, #dce3eb);
  display: flex;
  gap: 11px;
  min-height: 82px;
  min-width: 0;
  padding: 14px 18px;
}

.rt-settings-summary-card:first-child {
  border-left: 1px solid var(--rt-border, #dce3eb);
  border-radius: 10px 0 0 10px;
}

.rt-settings-summary-card:last-child {
  border-right: 1px solid var(--rt-border, #dce3eb);
  border-radius: 0 10px 10px 0;
}

.rt-settings-summary-card + .rt-settings-summary-card {
  border-left: 1px solid var(--rt-border, #dce3eb);
}

.rt-settings-summary-icon {
  align-items: center;
  background: var(--rt-bg-subtle, #f0edff);
  border: 1px solid var(--rt-border, #dce3eb);
  border-radius: 7px;
  color: var(--rt-accent, #6d56c7);
  display: inline-flex;
  flex: 0 0 30px;
  font-size: 16px;
  height: 30px;
  justify-content: center;
  width: 30px;
}

.rt-settings-summary-card > div {
  min-width: 0;
}

.rt-settings-summary-card strong,
.rt-settings-summary-card span:not(.rt-settings-summary-icon) {
  display: block;
  min-width: 0;
  overflow-wrap: anywhere;
}

.rt-settings-summary-card strong {
  color: var(--rt-ink, #18212f);
  font-size:var(--ui-text-body);
  line-height:var(--ui-leading-body);
}

.rt-settings-summary-card span:not(.rt-settings-summary-icon) {
  color: var(--rt-muted, #64748b);
  font-size:var(--ui-text-helper);
  line-height: 1.45;
  margin-top: 3px;
}

.rt-settings-localnav {
  align-items: center;
  display: flex;
  gap: 6px;
  max-width: 1180px;
  margin: 0 auto 22px;
  overflow-x: auto;
  padding-bottom: 1px;
  scrollbar-width: thin;
}

.rt-settings-localnav a {
  background: transparent;
  border: 1px solid transparent;
  border-radius: 7px;
  color: var(--rt-muted, #64748b);
  flex: 0 0 auto;
  font-size:var(--ui-text-helper);
  line-height:var(--ui-leading-body);
  padding: 7px 10px;
  text-decoration: none;
}

.rt-settings-localnav a:first-child,
.rt-settings-localnav a:hover,
.rt-settings-localnav a:focus-visible {
  background: var(--rt-bg-subtle, #f0edff);
  border-color: var(--rt-border, #dce3eb);
  color: var(--rt-accent, #6d56c7);
}

.rt-settings-section {
  max-width: 1180px;
  margin: 0 auto 28px;
  scroll-margin-top: 16px;
}

.rt-settings-section-head {
  align-items: flex-end;
  display: flex;
  justify-content: space-between;
  margin-bottom: 11px;
}

.rt-settings-section-head h2 {
  color: var(--rt-ink, #18212f);
  font-size:var(--ui-text-section);
  line-height:var(--ui-leading-title);
  margin: 0;
}

.rt-settings-card {
  background: var(--rt-bg-surface, #fff);
  border: 1px solid var(--rt-border, #dce3eb);
  border-radius: 10px;
  box-shadow: 0 2px 7px rgba(28, 39, 58, .04);
  margin-bottom: var(--rt-settings-card-gap);
  min-width: 0;
  padding: 17px 18px;
}

.rt-settings-note-card {
  border-left: 3px solid var(--rt-accent, #6d56c7);
}

.rt-settings-card-head {
  margin-bottom: 14px;
}

.rt-settings-card-head h3,
.rt-settings-card > h3 {
  color: var(--rt-ink, #18212f);
  font-size:var(--ui-text-section);
  line-height:var(--ui-leading-title);
  margin: 0;
}

.rt-settings-card-label {
  color: var(--rt-ink, #18212f);
  font-size:var(--ui-text-helper);
  font-weight:600;
  line-height:var(--ui-leading-body);
  margin-bottom: 6px;
}

.rt-settings-card-copy {
  color: var(--rt-muted, #64748b);
  font-size:var(--ui-text-helper);
  line-height:var(--ui-leading-body);
  margin: 0;
  overflow-wrap: anywhere;
}

.rt-settings-muted-copy {
  margin-bottom: 13px;
}

.rt-settings-inline-form {
  align-items: stretch;
  display: flex;
  gap: 9px;
}

.rt-settings-inline-form .rt-settings-control {
  flex: 1 1 auto;
  min-width: 0;
}

.rt-settings-action {
  flex: 0 0 auto;
}

.rt-settings-form-grid {
  display: grid;
  gap: var(--rt-settings-card-gap);
  grid-template-columns: repeat(2, minmax(0, 1fr));
}

.rt-settings-form-grid .rt-settings-card {
  margin-bottom: 0;
}

.rt-settings-card-wide {
  grid-column: 1 / -1;
}

.rt-settings-field-list {
  display: grid;
  gap: 12px;
  margin-top: 14px;
}

.rt-settings-field {
  color: var(--rt-ink, #18212f);
  display: block;
  font-size:var(--ui-text-helper);
  line-height:var(--ui-leading-body);
}

.rt-settings-control {
  background: var(--rt-bg-surface, #fff);
  border-color: var(--rt-border, #dce3eb);
  box-sizing: border-box;
  color: var(--rt-ink, #18212f);
  display: block;
  margin-top: 6px;
  min-height: 34px;
  padding: 7px 9px;
  width: 100%;
}

.rt-settings-control::placeholder {
  color: var(--rt-muted, #64748b);
  opacity: .86;
}

.rt-settings-control:focus {
  border-color: var(--rt-accent, #6d56c7) !important;
  box-shadow: 0 0 0 2px var(--rt-bg-subtle, #f0edff);
}

.rt-settings-control option {
  background: var(--rt-bg-surface, #fff);
  color: var(--rt-ink, #18212f);
}

.rt-settings-textarea {
  font-family:var(--ui-mono);
  line-height:var(--ui-leading-body);
  min-height: 76px;
  resize: vertical;
}

.rt-settings-tool-row {
  border-top: 1px solid var(--rt-border, #dce3eb);
  margin-top: 12px;
  padding-top: 12px;
}

.rt-settings-tool-head {
  align-items: center;
  display: flex;
  flex-wrap: wrap;
  gap: 7px;
  margin-bottom: 4px;
}

.rt-settings-tool-name {
  color: var(--rt-ink, #18212f);
  flex: 0 0 auto;
  font-size:var(--ui-text-helper);
  font-weight:600;
  min-width: 88px;
}

.rt-settings-tool-head .rt-tag {
  margin-right: 0;
}

.rt-settings-tool-path {
  color: var(--rt-muted, #64748b);
  display: block;
  font-size:var(--ui-text-helper);
  margin-top: 4px;
  opacity: 1;
  overflow-wrap: anywhere;
}

.rt-settings-config-foot,
.rt-settings-footer-note {
  color: var(--rt-muted, #64748b);
  font-size:var(--ui-text-helper);
  line-height:var(--ui-leading-body);
  margin-top: 14px;
  padding: 8px 0 0;
}

.rt-settings-config-foot {
  border-top: 1px solid var(--rt-border, #dce3eb);
}

.rt-settings-config-path {
  background: var(--rt-bg-subtle, #f0edff);
  border: 1px solid var(--rt-border, #dce3eb);
  border-radius: var(--ui-radius-control);
  color: var(--rt-ink, #18212f);
  font-family: var(--ui-mono);
  font-size: var(--ui-text-helper);
  line-height: var(--ui-leading-body);
  overflow-wrap: anywhere;
  padding: 8px 10px;
  white-space: pre-wrap;
}

.rt-settings-egress-list {
  display: grid;
  gap: 7px;
  margin-top: 13px;
}

.rt-settings-egress-list .rt-mono {
  background: var(--rt-bg-subtle, #f0edff);
  border: 1px solid var(--rt-border, #dce3eb);
  border-radius: 6px;
  color: var(--rt-ink, #18212f);
  font-size:var(--ui-text-helper);
  line-height:var(--ui-leading-body);
  overflow-wrap: anywhere;
  padding: 7px 9px;
}

.rt-settings-egress-note {
  color: var(--rt-muted, #64748b);
  font-size:var(--ui-text-helper);
  line-height:var(--ui-leading-body);
  margin-top: 8px;
  overflow-wrap: anywhere;
}

.rt-settings-diagnostic-empty,
.rt-settings-loading {
  color: var(--rt-muted, #64748b);
  font-size:var(--ui-text-helper);
  line-height:var(--ui-leading-body);
  text-align: left;
}

.rt-settings-alert {
  border: 1px solid var(--rt-border, #dce3eb);
  border-radius: 8px;
  margin: 0 auto 14px;
  max-width: 1180px;
}

.rt-settings-alert-error {
  background: var(--rt-bg-surface, #fff);
  color: var(--rt-ink, #18212f);
}

.rt-settings .rt-btn-primary {
  background: var(--rt-accent, #6d56c7);
  border-color: var(--rt-accent, #6d56c7);
}

@media (max-width: 900px) {
  .rt-settings-scroll {
    padding: 22px 20px 30px;
  }

  .rt-settings-summary {
    grid-template-columns: repeat(2, minmax(0, 1fr));
  }

  .rt-settings-summary-card:first-child,
  .rt-settings-summary-card:last-child {
    border-radius: 0;
  }

  .rt-settings-summary-card:first-child {
    border-radius: 10px 0 0 0;
  }

  .rt-settings-summary-card:nth-child(2) {
    border-radius: 0 10px 0 0;
    border-right: 1px solid var(--rt-border, #dce3eb);
  }

  .rt-settings-summary-card:nth-child(3) {
    border-left: 1px solid var(--rt-border, #dce3eb);
    border-radius: 0 0 0 10px;
    border-top: 0;
  }

  .rt-settings-summary-card:last-child {
    border-radius: 0 0 10px 0;
    border-top: 0;
  }

  .rt-settings-form-grid {
    grid-template-columns: minmax(0, 1fr);
  }

  .rt-settings-card-wide {
    grid-column: auto;
  }
}

@media (max-width: 640px) {
  .rt-settings-toolbar {
    padding: 8px 12px;
  }

  .rt-settings-scroll {
    padding: 18px 12px 24px;
  }

  .rt-settings-pagehead {
    flex-direction: column;
    gap: 12px;
  }

  .rt-settings-pagehead-context {
    align-items: flex-start;
    max-width: none;
    width: 100%;
  }

  .rt-settings-context-value {
    text-align: left;
  }

  .rt-settings-summary {
    grid-template-columns: minmax(0, 1fr);
  }

  .rt-settings-summary-card,
  .rt-settings-summary-card:first-child,
  .rt-settings-summary-card:nth-child(2),
  .rt-settings-summary-card:nth-child(3),
  .rt-settings-summary-card:last-child {
    border-radius: 0;
    border-left: 1px solid var(--rt-border, #dce3eb);
    border-right: 1px solid var(--rt-border, #dce3eb);
    border-top: 0;
  }

  .rt-settings-summary-card:first-child {
    border-radius: 10px 10px 0 0;
    border-top: 1px solid var(--rt-border, #dce3eb);
  }

  .rt-settings-summary-card:last-child {
    border-radius: 0 0 10px 10px;
  }

  .rt-settings-section-head {
    align-items: flex-start;
  }

  .rt-settings-inline-form {
    flex-direction: column;
  }

  .rt-settings-action {
    width: 100%;
  }
}

/* Match the reference: chapter rail beside a focused settings card. */
.rt-settings [hidden]{display:none!important}
.rt-settings-scroll{padding:26px 28px 30px}
.rt-settings-pagehead,.rt-settings-summary{max-width:none;margin-left:0;margin-right:0}
.rt-settings-workspace{display:grid;grid-template-columns:170px minmax(0,1fr);gap:22px;align-items:start}
.rt-settings-localnav{grid-column:1;grid-row:1;display:flex;flex-direction:column;align-items:stretch;gap:8px;max-width:none;width:100%;margin:0;padding:6px 0;overflow:visible}
.rt-settings-localnav button{border:1px solid transparent;border-radius:8px;background:transparent;color:var(--rt-muted);text-align:left;font:inherit;font-size:var(--ui-text-control);padding:12px 13px;cursor:pointer}
.rt-settings-localnav button:hover{background:var(--rt-bg-subtle);color:var(--rt-ink)}
.rt-settings-localnav button[aria-selected=true]{background:var(--rt-accent-soft);color:var(--rt-accent)}
.rt-settings-localnav button:focus-visible{outline:2px solid var(--rt-accent);outline-offset:3px}
.rt-settings-workspace>.rt-settings-section{grid-column:2;grid-row:1;min-width:0;max-width:none;width:100%;margin:0}
.rt-settings .rt-btn-primary{background:var(--rt-primary);border-color:var(--rt-primary);color:#fff}
@container workspace (max-width:1000px){
 .rt-settings-summary{grid-template-columns:repeat(2,minmax(0,1fr))}
 .rt-settings-summary-card{border:1px solid var(--rt-border)!important;border-radius:0!important}
 .rt-settings-summary-card:first-child{border-radius:10px 0 0 0!important}
 .rt-settings-summary-card:nth-child(2){border-radius:0 10px 0 0!important}
 .rt-settings-summary-card:nth-child(3){border-radius:0 0 0 10px!important}
 .rt-settings-summary-card:last-child{border-radius:0 0 10px 0!important}
 .rt-settings-workspace{grid-template-columns:135px minmax(0,1fr);gap:15px}
 .rt-settings-form-grid{grid-template-columns:minmax(0,1fr)}
 .rt-settings-pagehead{flex-direction:column;gap:12px}
 .rt-settings-pagehead-context{max-width:100%;align-items:flex-start}
}
@container workspace (max-width:720px){
 .rt-settings-scroll{padding:20px 16px}
 .rt-settings-workspace{display:flex;flex-direction:column;gap:15px}
 .rt-settings-localnav{flex-direction:row;flex-wrap:wrap;gap:6px;padding:0}
 .rt-settings-localnav button{padding:9px 10px;font-size:var(--ui-text-helper)}
 .rt-settings-section-head{flex-direction:column;align-items:flex-start}
 .rt-settings-field-grid{grid-template-columns:minmax(0,1fr)}
 .rt-settings-summary-card{padding:12px;min-height:74px}
 .rt-settings-summary-card strong{font-size:16px}
 .rt-settings .rt-toolbar{flex-wrap:wrap}
}
@container workspace (max-width:420px){
 .rt-settings-summary{grid-template-columns:minmax(0,1fr)}
 .rt-settings-summary-card{border-radius:0!important}
 .rt-settings-summary-card:first-child{border-radius:10px 10px 0 0!important}
 .rt-settings-summary-card:last-child{border-radius:0 0 10px 10px!important}
}

/* Floating and full-page shells use the rt size container. */
@container rt (max-width:1000px){
 .rt-settings-summary{grid-template-columns:repeat(2,minmax(0,1fr))}
 .rt-settings-summary-card{border:1px solid var(--rt-border)!important;border-radius:0!important}
 .rt-settings-summary-card:first-child{border-radius:10px 0 0 0!important}
 .rt-settings-summary-card:nth-child(2){border-radius:0 10px 0 0!important}
 .rt-settings-summary-card:nth-child(3){border-radius:0 0 0 10px!important}
 .rt-settings-summary-card:last-child{border-radius:0 0 10px 0!important}
 .rt-settings-workspace{grid-template-columns:135px minmax(0,1fr);gap:15px}
 .rt-settings-form-grid{grid-template-columns:minmax(0,1fr)}
 .rt-settings-pagehead{flex-direction:column;gap:12px}
 .rt-settings-pagehead-context{max-width:100%;align-items:flex-start}
}
@container rt (max-width:720px){
 .rt-settings-scroll{padding:20px 16px}
 .rt-settings-workspace{display:flex;flex-direction:column;gap:15px}
 .rt-settings-localnav{flex-direction:row;flex-wrap:wrap;gap:6px;padding:0}
 .rt-settings-localnav button{padding:9px 10px;font-size:var(--ui-text-helper)}
 .rt-settings-section-head{flex-direction:column;align-items:flex-start}
 .rt-settings-field-grid{grid-template-columns:minmax(0,1fr)}
 .rt-settings-summary-card{padding:12px;min-height:74px}
 .rt-settings-summary-card strong{font-size:16px}
 .rt-settings .rt-toolbar{flex-wrap:wrap}
}
@container rt (max-width:420px){
 .rt-settings-summary{grid-template-columns:minmax(0,1fr)}
 .rt-settings-summary-card{border-radius:0!important}
 .rt-settings-summary-card:first-child{border-radius:10px 10px 0 0!important}
 .rt-settings-summary-card:last-child{border-radius:0 0 10px 10px!important}
}

/* Proxy controls share settings typography, surfaces and interaction states. */
.rt-proxy-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 16px; align-items: start; }
.rt-proxy-settings { min-width: 0; }
.rt-proxy-settings > .rt-settings-card { margin-bottom: 16px; }
.rt-proxy-grid > .rt-settings-card { min-width: 0; margin: 0; }
.rt-proxy-fields { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 14px; }
.rt-proxy-wide { grid-column: 1 / -1; }
.rt-proxy-toggle { display: flex; align-items: center; gap: 8px; margin: 16px 0; font-size: var(--ui-text-body); }
.rt-proxy-toggle input { accent-color: var(--rt-accent); }
.rt-proxy-actions { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; margin: 16px 0 10px; }
.rt-proxy-settings .rt-settings-field { min-width: 0; }
.rt-proxy-settings .rt-settings-control { width: 100%; min-width: 0; box-sizing: border-box; }
.rt-proxy-yaml { font-family: var(--ui-mono); min-height: 180px; resize: vertical; }
.rt-proxy-file::file-selector-button { font: inherit; border: 0; border-radius: var(--ui-radius-control, 9px); background: var(--rt-bg-subtle); color: var(--rt-ink); padding: 6px 10px; margin-right: 8px; cursor: pointer; }
.rt-proxy-candidates { display: grid; gap: 10px; }
.rt-proxy-candidate { display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: 10px; border: 1px solid var(--rt-border); border-radius: var(--ui-radius-control, 9px); background: var(--rt-bg-subtle); padding: 12px; }
.rt-proxy-candidate > div { min-width: 0; }
.rt-proxy-candidate p { overflow-wrap: anywhere; margin: 5px 0 0; color: var(--rt-muted); font-size: var(--ui-text-helper); }
@container workspace (max-width: 1050px) { .rt-proxy-grid { grid-template-columns: minmax(0, 1fr); } }
@container workspace (max-width: 540px) { .rt-proxy-fields { grid-template-columns: minmax(0, 1fr); } }

@container rt (max-width: 1050px) { .rt-proxy-grid { grid-template-columns: minmax(0, 1fr); } }
@container rt (max-width: 540px) { .rt-proxy-fields { grid-template-columns: minmax(0, 1fr); } }
.rt-proxy-settings .rt-settings-alert {
  padding: 12px 14px;
  border-radius: var(--ui-radius-card, 16px);
  background: var(--ui-material-reading, var(--rt-bg-subtle));
  color: var(--ui-text, var(--rt-ink));
  font-size: var(--ui-text-helper);
  line-height: var(--ui-leading-body);
  overflow-wrap: anywhere;
}
.rt-proxy-settings .rt-settings-alert.rt-err { color: var(--ui-danger); border-color: var(--ui-danger); }
.rt-proxy-dropzone {
  padding: 18px;
  margin: 0 0 16px;
  border: 1px dashed var(--ui-glass-edge, var(--rt-border));
  border-radius: var(--ui-radius-card, 16px);
  background: var(--ui-material-reading, var(--rt-bg-subtle));
  transition: border-color 140ms ease, background-color 140ms ease;
}
.rt-proxy-dropzone > strong { display: block; font-size: var(--ui-text-body); font-weight: 600; }
.rt-proxy-dropzone > p { margin: 6px 0 14px; font-size: var(--ui-text-helper); color: var(--rt-muted); }
.rt-proxy-dropzone-active { border: 2px dashed var(--ui-primary, var(--rt-accent)); padding: 17px; background: var(--ui-selected, var(--rt-bg-subtle)); }
.rt-proxy-dropzone[aria-busy=true] { opacity: .65; }
@media (prefers-reduced-motion: reduce) { .rt-proxy-dropzone { transition: none; } }

.rt-proxy-policy-controls { display: flex; flex-wrap: wrap; align-items: flex-end; gap: 12px 18px; }
.rt-proxy-policy-controls .rt-proxy-toggle { min-height: 34px; margin: 0; }
.rt-proxy-timeout { width: 144px; }
.rt-proxy-list-head { display: flex; justify-content: space-between; align-items: center; gap: 16px; }
.rt-proxy-list-head-actions { display: flex; flex-wrap: wrap; align-items: center; justify-content: flex-end; gap: 6px; }
.rt-proxy-list-status { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; margin: 12px 0; }
.rt-proxy-bulk-confirm { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; margin: 12px 0; padding: 12px 14px; border: 1px solid var(--ui-danger, var(--rt-border)); border-radius: var(--ui-radius-control, 9px); background: var(--ui-material-reading, var(--rt-bg-subtle)); }
.rt-proxy-bulk-confirm span { color: var(--rt-muted); font-size: var(--ui-text-helper); }
.rt-proxy-table-scroll { overflow: auto; border: 1px solid var(--ui-glass-edge, var(--rt-border)); border-radius: var(--ui-radius-control, 9px); margin: 14px 0; }
.rt-proxy-table { width: 100%; min-width: 740px; border-collapse: collapse; font-size: var(--ui-text-body); }
.rt-proxy-table :is(th, td) { padding: 12px; border-bottom: 1px solid var(--rt-border); text-align: left; vertical-align: top; }
.rt-proxy-table th { font-size: var(--ui-text-helper); color: var(--rt-muted); font-weight: 600; white-space: nowrap; background: var(--ui-material-reading, var(--rt-bg-subtle)); }
.rt-proxy-table tbody tr:last-child td { border-bottom: 0; }
.rt-proxy-table .rt-proxy-row-selected { background: var(--ui-selected); }
.rt-proxy-table td:first-child { min-width: 130px; max-width: 240px; overflow-wrap: anywhere; }
.rt-proxy-table td:nth-child(2) { overflow-wrap: anywhere; max-width: 260px; }
.rt-proxy-table td:nth-child(3) { min-width: 110px; max-width: 240px; }
.rt-proxy-node-name { display: flex; align-items: baseline; gap: 8px; margin-bottom: 5px; }
.rt-proxy-node-name strong { font-weight: 600; }
.rt-proxy-order { color: var(--rt-muted); font-size: var(--ui-text-helper); font-variant-numeric: tabular-nums; }
.rt-proxy-node-error, .rt-proxy-node-check { margin-top: 5px; font-size: var(--ui-text-helper); overflow-wrap: anywhere; }
.rt-proxy-node-error { color: var(--ui-danger); }
.rt-proxy-node-check { color: var(--rt-muted); }
.rt-proxy-row-actions { display: flex; flex-wrap: wrap; gap: 6px; min-width: 170px; }
.rt-proxy-page-select, .rt-proxy-node-name { display: flex; align-items: center; gap: 8px; }
.rt-proxy-page-select input, .rt-proxy-select { accent-color: var(--rt-accent); }
.rt-proxy-pagination { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; margin: 12px 0 2px; }
.rt-proxy-pagination > label { display: inline-flex; align-items: center; gap: 6px; font-size: var(--ui-text-helper); color: var(--rt-muted); }
.rt-proxy-pagination .rt-settings-control { width: auto; min-width: 68px; padding: 4px 8px; }
.rt-proxy-pagination > span { margin-right: auto; font-size: var(--ui-text-helper); color: var(--rt-muted); font-variant-numeric: tabular-nums; }
.rt-proxy-candidate-pagination { margin-top: 12px; }
.rt-proxy-log-card > summary { display: flex; align-items: center; gap: 10px; cursor: pointer; font-size: var(--ui-text-body); font-weight: 600; }
.rt-proxy-log-card > summary::before { content: '›'; color: var(--rt-muted); }
.rt-proxy-log-card[open] > summary::before { content: '⌄'; }
.rt-proxy-log-scroll { max-height: 240px; overflow: auto; overscroll-behavior: contain; margin: 12px 0; scrollbar-gutter: stable; border: 1px solid var(--ui-glass-edge, var(--rt-border)); border-radius: var(--ui-radius-control, 9px); }
.rt-proxy-log-list { list-style: none; padding: 0; margin: 0; }
.rt-proxy-log-list li { display: grid; grid-template-columns: 168px 40px minmax(0, 1fr); gap: 10px; padding: 10px 12px; border-bottom: 1px solid var(--rt-border); font-size: var(--ui-text-helper); line-height: var(--ui-leading-body); overflow-wrap: anywhere; }
.rt-proxy-log-list li:last-child { border-bottom: 0; }
.rt-proxy-log-list time { color: var(--rt-muted); font-variant-numeric: tabular-nums; }
.rt-proxy-log-level { font-weight: 600; }
.rt-proxy-log-error .rt-proxy-log-level { color: var(--ui-danger); }
.rt-proxy-log-warn .rt-proxy-log-level { color: var(--ui-warning, var(--rt-muted)); }
@container workspace (max-width: 650px) { .rt-proxy-log-list li { grid-template-columns: minmax(0, 1fr) 40px; } .rt-proxy-log-list li > span:last-child { grid-column: 1 / -1; } }
@container rt (max-width: 650px) { .rt-proxy-log-list li { grid-template-columns: minmax(0, 1fr) 40px; } .rt-proxy-log-list li > span:last-child { grid-column: 1 / -1; } }
.rt-proxy-engine-path { margin-top: 16px; max-width: 680px; }
.rt-proxy-candidates[role=region] { max-height: 360px; overflow: auto; overscroll-behavior: contain; scrollbar-gutter: stable; }


/* Skills catalog presentation. Every rule stays inside the SkillsTab root. */
.rt-skills-workspace {
  display: flex;
  min-width: 0;
  min-height: 0;
  flex: 1 1 auto;
  flex-direction: column;
  gap: 14px;
  overflow: hidden;
  box-sizing: border-box;
  padding: 22px 26px 24px;
  color: var(--rt-ink, #282a37);
  background: var(--rt-bg-base, #f6f5fb);
}

.rt-skills-workspace,
.rt-skills-workspace * {
  box-sizing: border-box;
}

.rt-skills-workspace button,
.rt-skills-workspace input,
.rt-skills-workspace select,
.rt-skills-workspace summary {
  font: inherit;
}

.rt-skills-workspace button {
  text-align: left;
}

.rt-skills-workspace h1,
.rt-skills-workspace h2,
.rt-skills-workspace h3,
.rt-skills-workspace h4,
.rt-skills-workspace p,
.rt-skills-workspace dl,
.rt-skills-workspace dd {
  margin-top: 0;
}

.rt-skills-overview {
  display: grid;
  min-width: 0;
  flex: 0 0 auto;
  grid-template-columns: repeat(4, minmax(0, 1fr));
  gap: 1px;
  overflow: hidden;
  border: 1px solid var(--rt-border, #e3e3ed);
  border-radius: 11px;
  background: var(--rt-border, #e3e3ed);
}

.rt-skills-stat {
  display: flex;
  min-width: 0;
  min-height: 70px;
  flex-direction: column;
  justify-content: center;
  padding: 12px 15px;
  background: var(--rt-bg-surface, #fff);
}

.rt-skills-stat strong,
.rt-skills-stat small {
  display: block;
  min-width: 0;
  overflow-wrap: anywhere;
}

.rt-skills-stat strong {
  color: var(--rt-ink, #282a37);
  font-size:var(--ui-text-metric);
  font-weight:600;
  line-height:var(--ui-leading-body);
  font-variant-numeric: tabular-nums;
}

.rt-skills-stat small {
  margin-top: 4px;
  color: var(--rt-muted, #7c8090);
  font-size:var(--ui-text-helper);
  line-height:var(--ui-leading-body);
}

.rt-skills-layout {
  display: grid;
  min-width: 0;
  min-height: 0;
  flex: 1 1 auto;
  grid-template-columns: clamp(300px, 30%, 390px) minmax(0, 1fr);
  gap: 14px;
}

.rt-skills-catalog,
.rt-skills-detail {
  min-width: 0;
  min-height: 0;
  border: 1px solid var(--rt-border, #e3e3ed);
  border-radius: 11px;
  background: var(--rt-bg-surface, #fff);
}

.rt-skills-catalog {
  display: flex;
  flex-direction: column;
  overflow: hidden;
}

.rt-skills-catalog-head {
  display: flex;
  min-width: 0;
  align-items: flex-start;
  justify-content: space-between;
  gap: 10px;
  padding: 13px 14px 10px;
  border-bottom: 1px solid var(--rt-border, #e3e3ed);
  background: var(--rt-bg-surface, #fff);
}

.rt-skills-catalog-head h2,
.rt-skills-catalog-head h3 {
  min-width: 0;
  margin: 0;
  color: var(--rt-ink, #282a37);
  font-size:var(--ui-text-section);
  font-weight:600;
  line-height:var(--ui-leading-title);
}

.rt-skills-catalog-head p,
.rt-skills-catalog-count {
  margin: 3px 0 0;
  color: var(--rt-muted, #7c8090);
  font-size:var(--ui-text-helper);
  line-height:var(--ui-leading-body);
}

.rt-skills-catalog-count {
  flex: none;
  margin: 1px 0 0;
  white-space: nowrap;
}

.rt-skills-filters {
  display: flex;
  min-width: 0;
  flex: 0 0 auto;
  flex-direction: column;
  gap: 8px;
  padding: 11px 12px;
  border-bottom: 1px solid var(--rt-border, #e3e3ed);
  background: var(--rt-bg-surface, #fff);
}

.rt-skills-filter-heading {
  display: flex;
  min-width: 0;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  color: var(--rt-ink, #282a37);
  font-size:var(--ui-text-helper);
  line-height:var(--ui-leading-body);
}

.rt-skills-filter-heading strong,
.rt-skills-filter-heading span {
  min-width: 0;
  overflow-wrap: anywhere;
}

.rt-skills-filter-heading strong {
  font-weight:600;
}

.rt-skills-filter-heading span {
  color: var(--rt-muted, #7c8090);
  font-size:var(--ui-text-helper);
  white-space: nowrap;
}

.rt-skills-search-field {
  display: block;
  min-width: 0;
}

.rt-skills-search-label {
  display: block;
  margin: 0 0 4px;
  color: var(--rt-muted, #7c8090);
  font-size:var(--ui-text-control);
  line-height:var(--ui-leading-control);
}

.rt-skills-search,
.rt-skills-filters .rt-input,
.rt-skills-filters input[type='search'],
.rt-skills-filters input[type='text'],
.rt-skills-filters input:not([type='checkbox']) {
  display: block;
  width: 100%;
  min-width: 0;
  min-height: 33px;
  padding: 7px 9px;
  border: 1px solid var(--rt-border, #e3e3ed);
  border-radius: 7px;
  outline: 0;
  color: var(--rt-ink, #282a37);
  background: var(--rt-bg-base, #f6f5fb);
  font-size:var(--ui-text-control);
}

.rt-skills-search::placeholder,
.rt-skills-filters input::placeholder {
  color: var(--rt-muted, #7c8090);
  opacity: .86;
}

.rt-skills-filter-checks {
  display: flex;
  min-width: 0;
  flex-wrap: wrap;
  gap: 6px 10px;
}

.rt-skills-filter-check,
.rt-skills-check,
.rt-skills-filters .rt-kb-check {
  display: inline-flex;
  min-width: 0;
  align-items: flex-start;
  gap: 6px;
  color: var(--rt-muted, #7c8090);
  font-size:var(--ui-text-helper);
  line-height:var(--ui-leading-body);
  cursor: pointer;
}

.rt-skills-filter-check input[type='checkbox'],
.rt-skills-check input[type='checkbox'],
.rt-skills-filters .rt-kb-check input[type='checkbox'],
.rt-skills-filters input[type='checkbox'] {
  width: 13px;
  height: 13px;
  flex: 0 0 auto;
  margin: 1px 0 0;
  accent-color: var(--rt-primary, #7864df);
}

.rt-skills-filter-check:hover,
.rt-skills-check:hover,
.rt-skills-filters .rt-kb-check:hover {
  color: var(--rt-ink, #282a37);
}

.rt-skills-list {
  display: flex;
  min-width: 0;
  min-height: 0;
  flex: 1 1 auto;
  flex-direction: column;
  gap: 6px;
  overflow: auto;
  padding: 9px;
  background: var(--rt-bg-base, #f6f5fb);
  scrollbar-width: thin;
  overscroll-behavior: contain;
}

.rt-skills-group {
  display: flex;
  min-width: 0;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  margin: 0;
  padding: 4px 5px 5px;
  color: var(--rt-muted, #7c8090);
  font-size:var(--ui-text-helper);
  font-weight:600;
  letter-spacing:normal;
  line-height:var(--ui-leading-body);
  text-transform: uppercase;
}

.rt-skills-group + .rt-skills-group {
  margin-top: 6px;
}

.rt-skills-list > section {
  min-width: 0;
}

.rt-skills-list > section + section {
  margin-top: 6px;
}

.rt-skills-list > section > .rt-skills-group > span {
  color: var(--rt-muted, #7c8090);
  font-size:var(--ui-text-helper);
  font-weight:500;
  letter-spacing: 0;
  text-transform: none;
}

.rt-skills-group-header {
  display: flex;
  min-width: 0;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  padding: 4px 5px 5px;
  color: var(--rt-muted, #7c8090);
  font-size:var(--ui-text-helper);
  font-weight:600;
  letter-spacing:normal;
  line-height:var(--ui-leading-body);
  text-transform: uppercase;
}

.rt-skills-group-header > * {
  min-width: 0;
}

.rt-skills-group-header small,
.rt-skills-group-count {
  color: var(--rt-muted, #7c8090);
  font-size:var(--ui-text-helper);
  font-weight:500;
  letter-spacing: 0;
  text-transform: none;
}

.rt-skills-card {
  display: block;
  width: 100%;
  min-width: 0;
  margin: 0;
  padding: 10px 11px;
  border: 1px solid var(--rt-border, #e3e3ed);
  border-radius: 8px;
  color: var(--rt-ink, #282a37);
  background: var(--rt-bg-surface, #fff);
  cursor: pointer;
  appearance: none;
  transition: border-color .14s ease, background-color .14s ease, box-shadow .14s ease;
}

.rt-skills-card + .rt-skills-card {
  margin-top: 6px;
}

.rt-skills-card:hover {
  border-color: var(--rt-accent, #7661d3);
  background: var(--rt-bg-subtle, #f5f4f9);
}

.rt-skills-card[aria-pressed=true] {
  border-color: var(--rt-accent, #7661d3);
  background: var(--rt-accent-soft, #eeeafb);
  box-shadow: inset 3px 0 0 var(--rt-accent, #7661d3);
}

.rt-skills-card:disabled {
  cursor: default;
  opacity: .65;
}

.rt-skills-card-top {
  display: flex;
  min-width: 0;
  align-items: center;
  gap: 7px;
}

.rt-skills-name {
  min-width: 0;
  flex: 1 1 auto;
  overflow: hidden;
  color: var(--rt-ink, #282a37);
  font-size:var(--ui-text-helper);
  font-weight:600;
  line-height:var(--ui-leading-body);
  text-overflow: ellipsis;
  white-space: nowrap;
}

.rt-skills-description {
  display: -webkit-box;
  min-width: 0;
  margin: 5px 0 0;
  overflow: hidden;
  color: var(--rt-muted, #7c8090);
  font-size:var(--ui-text-helper);
  line-height:var(--ui-leading-body);
  overflow-wrap: anywhere;
  -webkit-box-orient: vertical;
  -webkit-line-clamp: 2;
}

.rt-skills-source {
  display: block;
  min-width: 0;
  margin-top: 6px;
  overflow: hidden;
  color: var(--rt-muted, #7c8090);
  font-size:var(--ui-text-helper);
  line-height:var(--ui-leading-body);
  text-overflow: ellipsis;
  white-space: nowrap;
}

.rt-skills-no-results {
  display: flex;
  min-width: 0;
  min-height: 120px;
  align-items: center;
  justify-content: center;
  padding: 18px 12px;
  color: var(--rt-muted, #7c8090);
  font-size:var(--ui-text-helper);
  line-height:var(--ui-leading-body);
  text-align: center;
}

.rt-skills-card-warning {
  display: block;
  min-width: 0;
  margin-top: 6px;
  overflow-wrap: anywhere;
  color: var(--rt-warning, #9c741e);
  font-size:var(--ui-text-helper);
  line-height:var(--ui-leading-body);
}

.rt-skills-badge,
.rt-skills-card-badge,
.rt-skills-status-row .rt-tag,
.rt-skills-status-row .rt-avail,
.rt-skills-card .rt-tag,
.rt-skills-card .rt-avail {
  display: inline-flex;
  min-width: 0;
  align-items: center;
  flex: 0 0 auto;
  gap: 4px;
  padding: 3px 6px;
  border: 1px solid var(--rt-border, #e3e3ed);
  border-radius: 999px;
  color: var(--rt-muted, #7c8090);
  background: var(--rt-bg-subtle, #f5f4f9);
  font-size:var(--ui-text-helper);
  font-weight:600;
  line-height:var(--ui-leading-body);
  white-space: nowrap;
}

.rt-skills-card .rt-avail-available,
.rt-skills-status-row .rt-avail-available,
.rt-skills-badge.is-available,
.rt-skills-badge[data-status='available'] {
  border-color: var(--rt-success, #3b8567);
  color: var(--rt-success, #3b8567);
  background: var(--rt-success-bg, #e9f4ed);
}

.rt-skills-card .rt-avail-broken,
.rt-skills-status-row .rt-avail-broken,
.rt-skills-badge.is-broken,
.rt-skills-badge[data-status='broken'] {
  border-color: var(--rt-danger, #c54c66);
  color: var(--rt-danger, #c54c66);
  background: var(--rt-danger-bg, #faedf0);
}

.rt-skills-card .rt-avail-unknown,
.rt-skills-status-row .rt-avail-unknown,
.rt-skills-badge.is-unknown,
.rt-skills-badge[data-status='unknown'] {
  border-color: var(--rt-border, #e3e3ed);
  color: var(--rt-muted, #7c8090);
  background: var(--rt-bg-subtle, #f5f4f9);
}

.rt-skills-detail {
  display: flex;
  flex-direction: column;
  overflow: hidden;
}

.rt-skills-detail-toolbar {
  display: flex;
  min-width: 0;
  min-height: 58px;
  flex: 0 0 auto;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding: 10px 16px;
  border-bottom: 1px solid var(--rt-border, #e3e3ed);
  background: var(--rt-bg-surface, #fff);
}

.rt-skills-heading {
  min-width: 0;
  flex: 1 1 auto;
  margin: 0;
  overflow-wrap: anywhere;
  color: var(--rt-ink, #282a37);
  font-size:var(--ui-text-body);
  font-weight:600;
  letter-spacing:normal;
  line-height:var(--ui-leading-body);
}

.rt-skills-detail-toolbar > div:first-child {
  min-width: 0;
  flex: 1 1 auto;
}

.rt-skills-heading h1,
.rt-skills-heading h2,
.rt-skills-heading h3 {
  min-width: 0;
  margin: 0;
  overflow-wrap: anywhere;
  color: var(--rt-ink, #282a37);
  font-size:var(--ui-text-title);
  font-weight:600;
  letter-spacing:normal;
  line-height:var(--ui-leading-title);
}

.rt-skills-kicker {
  display: block;
  min-width: 0;
  margin-bottom: 3px;
  overflow: hidden;
  color: var(--rt-accent, #7661d3);
  font-size:var(--ui-text-helper);
  font-weight:600;
  letter-spacing:normal;
  line-height:var(--ui-leading-body);
  text-overflow: ellipsis;
  text-transform: uppercase;
  white-space: nowrap;
}

.rt-skills-detail-actions {
  display: flex;
  min-width: 0;
  flex: 0 0 auto;
  align-items: center;
  gap: 7px;
}

.rt-skills-actions {
  display: flex;
  min-width: 0;
  flex: 0 0 auto;
  align-items: center;
  gap: 7px;
}

.rt-skills-detail-actions button,
.rt-skills-actions button,
.rt-skills-detail-toolbar .rt-btn {
  min-height: 30px;
  padding: 5px 9px;
  border: 1px solid var(--rt-border, #e3e3ed);
  border-radius: 7px;
  color: var(--rt-ink, #282a37);
  background: var(--rt-bg-surface, #fff);
  cursor: pointer;
  font-size:var(--ui-text-control);
}

.rt-skills-detail-actions button:hover,
.rt-skills-detail-actions button:focus-visible,
.rt-skills-actions button:hover,
.rt-skills-actions button:focus-visible,
.rt-skills-detail-toolbar .rt-btn:hover,
.rt-skills-detail-toolbar .rt-btn:focus-visible {
  border-color: var(--rt-accent, #7661d3);
  background: var(--rt-bg-subtle, #f5f4f9);
}

.rt-skills-detail-actions button:disabled,
.rt-skills-actions button:disabled,
.rt-skills-detail-toolbar .rt-btn:disabled {
  cursor: default;
  opacity: .55;
}

.rt-skills-detail-scroll {
  display: block;
  min-width: 0;
  min-height: 0;
  flex: 1 1 auto;
  overflow: auto;
  padding: 15px 16px 20px;
  background: var(--rt-bg-base, #f6f5fb);
  scrollbar-width: thin;
  overscroll-behavior: contain;
}

.rt-skills-section {
  min-width: 0;
  margin: 0 0 11px;
  padding: 14px 15px;
  border: 1px solid var(--rt-border, #e3e3ed);
  border-radius: 9px;
  background: var(--rt-bg-surface, #fff);
}

.rt-skills-section:last-child {
  margin-bottom: 0;
}

.rt-skills-section-heading {
  display: flex;
  min-width: 0;
  align-items: flex-start;
  justify-content: space-between;
  gap: 10px;
  margin-bottom: 10px;
}

.rt-skills-section h2,
.rt-skills-section h3,
.rt-skills-section-heading h2,
.rt-skills-section-heading h3 {
  min-width: 0;
  margin: 0;
  color: var(--rt-ink, #282a37);
  font-size:var(--ui-text-section);
  font-weight:600;
  line-height:var(--ui-leading-title);
}

.rt-skills-section-heading p,
.rt-skills-section > p {
  margin: 4px 0 0;
  color: var(--rt-muted, #7c8090);
  font-size:var(--ui-text-helper);
  line-height:var(--ui-leading-body);
}

.rt-skills-facts {
  display: grid;
  min-width: 0;
  grid-template-columns: minmax(112px, .28fr) minmax(0, 1fr);
  column-gap: 16px;
  row-gap: 8px;
  margin: 0;
}

.rt-skills-facts dt,
.rt-skills-facts dd {
  min-width: 0;
  margin: 0;
  overflow-wrap: anywhere;
  word-break: break-word;
}

.rt-skills-facts dt {
  color: var(--rt-muted, #7c8090);
  font-size:var(--ui-text-helper);
  line-height:var(--ui-leading-body);
}

.rt-skills-facts dd {
  color: var(--rt-ink, #282a37);
  font-size:var(--ui-text-helper);
  line-height:var(--ui-leading-body);
}

.rt-skills-facts code,
.rt-skills-diagnostics code,
.rt-skills-path {
  max-width: 100%;
  overflow-wrap: anywhere;
  word-break: break-word;
  color: var(--rt-ink, #282a37);
  font-family:var(--ui-mono);
  font-size:var(--ui-text-helper);
}

.rt-skills-status-row {
  display: flex;
  min-width: 0;
  align-items: center;
  flex-wrap: wrap;
  gap: 6px;
  margin-top: 11px;
}

.rt-skills-content {
  display: block;
  width: 100%;
  min-width: 0;
  max-width: 100%;
  max-height: none !important;
  margin: 0;
  padding: 13px 14px;
  overflow-x: auto;
  overflow-y: visible;
  border: 1px solid var(--rt-border, #e3e3ed);
  border-radius: 7px;
  color: var(--rt-ink, #282a37);
  background: var(--rt-bg-subtle, #f5f4f9);
  font-family:var(--ui-mono);
  font-size:var(--ui-text-helper);
  line-height:var(--ui-leading-body);
  white-space: pre;
}

.rt-skills-content pre,
.rt-skills-content > pre {
  display: block;
  width: 100%;
  min-width: 0;
  max-width: 100%;
  max-height: none !important;
  margin: 0;
  padding: 13px 14px;
  overflow-x: auto;
  overflow-y: visible;
  border: 1px solid var(--rt-border, #e3e3ed);
  border-radius: 7px;
  color: var(--rt-ink, #282a37);
  background: var(--rt-bg-subtle, #f5f4f9);
  font-family:var(--ui-mono);
  font-size:var(--ui-text-helper);
  line-height:var(--ui-leading-body);
  tab-size: 2;
  white-space: pre;
}

.rt-skills-content code {
  color: inherit;
  font-family:var(--ui-font);
  font-size: inherit;
}

.rt-skills-content p,
.rt-skills-content ul,
.rt-skills-content ol {
  margin: 0 0 9px;
}

.rt-skills-content > :last-child {
  margin-bottom: 0;
}

.rt-skills-empty {
  display: flex;
  min-width: 0;
  min-height: 220px;
  align-items: center;
  justify-content: center;
  flex-direction: column;
  padding: 30px 22px;
  color: var(--rt-muted, #7c8090);
  text-align: center;
}

.rt-skills-empty-icon {
  display: grid;
  width: 42px;
  height: 42px;
  place-items: center;
  margin-bottom: 12px;
  border: 1px solid var(--rt-border, #e3e3ed);
  border-radius: 11px;
  color: var(--rt-accent, #7661d3);
  background: var(--rt-accent-soft, #eeeafb);
  font-size: 18px;
}

.rt-skills-empty-title,
.rt-skills-empty h2,
.rt-skills-empty h3 {
  margin: 0;
  color: var(--rt-ink, #282a37);
  font-size:var(--ui-text-section);
  font-weight:600;
  line-height:var(--ui-leading-title);
}

.rt-skills-empty-help,
.rt-skills-empty p {
  max-width: 410px;
  margin: 6px 0 0;
  color: var(--rt-muted, #7c8090);
  font-size:var(--ui-text-helper);
  line-height:var(--ui-leading-body);
}

.rt-skills-diagnostics {
  min-width: 0;
  margin-top: 11px;
  overflow: hidden;
  border: 1px solid var(--rt-border, #e3e3ed);
  border-radius: 8px;
  background: var(--rt-bg-surface, #fff);
}

.rt-skills-diagnostics > summary {
  display: flex;
  min-width: 0;
  align-items: center;
  gap: 8px;
  min-height: 40px;
  padding: 9px 11px;
  color: var(--rt-ink, #282a37);
  cursor: pointer;
  list-style: none;
  user-select: none;
}

.rt-skills-diagnostics > summary::-webkit-details-marker {
  display: none;
}

.rt-skills-diagnostics > summary::before {
  width: 7px;
  height: 7px;
  flex: 0 0 auto;
  border-right: 1px solid var(--rt-muted, #7c8090);
  border-bottom: 1px solid var(--rt-muted, #7c8090);
  content: '';
  transform: rotate(-45deg);
  transition: transform .14s ease;
}

.rt-skills-diagnostics[open] > summary::before {
  transform: rotate(45deg) translate(-2px, -2px);
}

.rt-skills-diagnostics > summary strong,
.rt-skills-diagnostics > summary span {
  min-width: 0;
  overflow-wrap: anywhere;
}

.rt-skills-diagnostics > summary strong {
  font-size:var(--ui-text-helper);
  font-weight:600;
  line-height:var(--ui-leading-body);
}

.rt-skills-diagnostics > summary span {
  color: var(--rt-muted, #7c8090);
  font-size:var(--ui-text-helper);
  line-height:var(--ui-leading-body);
}

.rt-skills-diagnostics-content {
  min-width: 0;
  padding: 11px;
  border-top: 1px solid var(--rt-border, #e3e3ed);
  color: var(--rt-muted, #7c8090);
  font-size:var(--ui-text-helper);
  line-height:var(--ui-leading-body);
  overflow-wrap: anywhere;
  word-break: break-word;
}

.rt-skills-diagnostics-content pre,
.rt-skills-diagnostics-content .rt-mono {
  max-width: 100%;
  margin: 0;
  overflow-wrap: anywhere;
  word-break: break-word;
  white-space: pre-wrap;
}

.rt-skills-diagnostics > p {
  min-width: 0;
  margin: 0 11px 8px;
  color: var(--rt-muted, #7c8090);
  font-size:var(--ui-text-helper);
  line-height:var(--ui-leading-body);
  overflow-wrap: anywhere;
  word-break: break-word;
}

.rt-skills-diagnostics > summary + p,
.rt-skills-diagnostics > summary + dl {
  padding-top: 11px;
  border-top: 1px solid var(--rt-border, #e3e3ed);
}

.rt-skills-diagnostics > dl {
  min-width: 0;
  margin: 0 11px 11px;
}

.rt-skills-status,
.rt-skills-loading {
  flex: 0 0 auto;
  padding: 8px 11px;
  border: 1px solid var(--rt-border, #e3e3ed);
  border-radius: 7px;
  color: var(--rt-muted, #7c8090);
  background: var(--rt-bg-surface, #fff);
  font-size:var(--ui-text-helper);
  line-height:var(--ui-leading-body);
}

.rt-skills-workspace .rt-err {
  flex: 0 0 auto;
  margin: 0;
  padding: 9px 11px;
  border: 1px solid var(--rt-danger, #c54c66);
  border-radius: 7px;
  color: var(--rt-danger, #c54c66);
  background: var(--rt-danger-bg, #faedf0);
  font-size:var(--ui-text-helper);
  line-height:var(--ui-leading-body);
  overflow-wrap: anywhere;
}

.rt-skills-workspace button:focus-visible,
.rt-skills-workspace input:focus-visible,
.rt-skills-workspace select:focus-visible,
.rt-skills-workspace summary:focus-visible {
  outline: 2px solid var(--rt-accent, #7661d3);
  outline-offset: 2px;
  box-shadow: none;
}

.rt-skills-workspace .rt-skills-search:focus-visible,
.rt-skills-workspace .rt-skills-filters input:focus-visible {
  border-color: var(--rt-accent, #7661d3);
}

@container workspace (max-width: 900px) {
  .rt-skills-workspace {
    padding: 18px 20px 20px;
  }

  .rt-skills-overview {
    grid-template-columns: repeat(2, minmax(0, 1fr));
  }

  .rt-skills-card {
    width: 100%;
    max-width: 100%;
  }
}

@container workspace (max-width: 720px) {
  .rt-skills-workspace {
    overflow: auto;
    padding: 15px 14px 18px;
  }

  .rt-skills-layout {
    display: flex;
    min-height: 0;
    flex: 0 1 auto;
    flex-direction: column;
    overflow: visible;
  }

  .rt-skills-catalog {
    height: 300px;
    min-height: 300px;
    max-height: 300px;
  }

  .rt-skills-detail {
    min-height: 320px;
  }

  .rt-skills-detail-toolbar {
    align-items: flex-start;
    flex-wrap: wrap;
  }

  .rt-skills-detail-actions,
  .rt-skills-actions {
    width: 100%;
  }

  .rt-skills-facts {
    grid-template-columns: minmax(0, 1fr);
    row-gap: 3px;
  }

  .rt-skills-facts dd + dt {
    margin-top: 7px;
  }
}

@media (max-width: 900px) {
  .rt-skills-workspace {
    padding: 18px 20px 20px;
  }

  .rt-skills-overview {
    grid-template-columns: repeat(2, minmax(0, 1fr));
  }

  .rt-skills-card {
    width: 100%;
    max-width: 100%;
  }
}

@media (max-width: 720px) {
  .rt-skills-workspace {
    overflow: auto;
    padding: 15px 14px 18px;
  }

  .rt-skills-layout {
    display: flex;
    min-height: 0;
    flex: 0 1 auto;
    flex-direction: column;
    overflow: visible;
  }

  .rt-skills-catalog {
    height: 300px;
    min-height: 300px;
    max-height: 300px;
  }

  .rt-skills-detail {
    min-height: 320px;
  }

  .rt-skills-detail-toolbar {
    align-items: flex-start;
    flex-wrap: wrap;
  }

  .rt-skills-detail-actions,
  .rt-skills-actions {
    width: 100%;
  }

  .rt-skills-facts {
    grid-template-columns: minmax(0, 1fr);
    row-gap: 3px;
  }

  .rt-skills-facts dd + dt {
    margin-top: 7px;
  }
}

@media (prefers-reduced-motion: reduce) {
  .rt-skills-workspace * {
    scroll-behavior: auto !important;
    transition: none !important;
  }
}

/* Floating/full-page shells use the rt container instead of workspace. */
@container rt (max-width: 900px) {
  .rt-skills-workspace {
    padding: 18px 20px 20px;
  }

  .rt-skills-overview {
    grid-template-columns: repeat(2, minmax(0, 1fr));
  }

  .rt-skills-card {
    width: 100%;
    max-width: 100%;
  }
}
@container rt (max-width: 720px) {
  .rt-skills-workspace {
    overflow: auto;
    padding: 15px 14px 18px;
  }

  .rt-skills-layout {
    display: flex;
    min-height: 0;
    flex: 0 1 auto;
    flex-direction: column;
    overflow: visible;
  }

  .rt-skills-catalog {
    height: 300px;
    min-height: 300px;
    max-height: 300px;
  }

  .rt-skills-detail {
    min-height: 320px;
  }

  .rt-skills-detail-toolbar {
    align-items: flex-start;
    flex-wrap: wrap;
  }

  .rt-skills-detail-actions,
  .rt-skills-actions {
    width: 100%;
  }

  .rt-skills-facts {
    grid-template-columns: minmax(0, 1fr);
    row-gap: 3px;
  }

  .rt-skills-facts dd + dt {
    margin-top: 7px;
  }
}


/* Sessions and tunnels page. The data/actions remain owned by SessionTab. */
.rt-sessions-page {
  --rt-sessions-page-x: var(--rt-page-x, 26px);
  display: flex;
  flex: 1 1 auto;
  min-width: 0;
  min-height: 0;
  flex-direction: column;
  overflow: hidden;
  color: var(--rt-ink);
  background: var(--rt-bg-base);
}

.rt-sessions-page,
.rt-sessions-page * {
  box-sizing: border-box;
}

.rt-sessions-page button {
  min-height: 32px;
}

.rt-sessions-page :is(.rt-sess-title, .rt-sess-sub, .rt-sess-fact,
  .rt-sess-fact > span, .rt-sess-fold, .rt-sess-cmd, .rt-code,
  .rt-atest-meta, .rt-hint) {
  min-width: 0;
  max-width: 100%;
  overflow-wrap: anywhere;
  word-break: break-word;
}

/* The global page heading is useful context, but should not compete with the ledger. */
:is(.rt-dock, .rt-full) > .rt-body[data-page='sessions'] > .rt-workspace-pagehead {
  padding-top: 14px;
  padding-bottom: 10px;
}

:is(.rt-dock, .rt-full) > .rt-body[data-page='sessions'] > .rt-workspace-pagehead h1 {
  font-size:var(--ui-text-title);
  line-height:var(--ui-leading-title);
}

:is(.rt-dock, .rt-full) > .rt-body[data-page='sessions'] > .rt-workspace-pagehead p {
  margin-top: 5px;
  font-size:var(--ui-text-helper);
  line-height:var(--ui-leading-body);
}

.rt-sessions-page > .rt-sessions-toolbar,
:is(.rt-dock, .rt-full) .rt-page-content > .rt-main.rt-sessions-page > .rt-sessions-toolbar {
  display: flex;
  flex: 0 0 auto;
  min-width: 0;
  align-items: center;
  flex-wrap: wrap;
  gap: 10px;
  padding: 10px var(--rt-sessions-page-x) 12px;
  border-bottom: 1px solid var(--rt-border);
  background: var(--rt-bg-base);
}

.rt-sessions-toolbar-copy {
  display: flex;
  min-width: 0;
  flex: 0 1 auto;
  flex-direction: column;
  gap: 1px;
}

.rt-sessions-toolbar-copy strong {
  color: var(--rt-ink);
  font-size:var(--ui-text-body);
  font-weight:600;
  line-height:var(--ui-leading-body);
}

.rt-sessions-toolbar-copy small {
  color: var(--rt-muted);
  font-size:var(--ui-text-helper);
  line-height:var(--ui-leading-body);
}

.rt-sessions-toolbar > .rt-spacer {
  min-width: 12px;
  flex: 1 1 12px;
}

.rt-sessions-page :is(.rt-sessions-toolbar, .rt-sessions-summary) button,
.rt-sessions-page .rt-sessions-toolbar .rt-btn {
  min-height: 32px;
  white-space: nowrap;
}

.rt-sessions-summary {
  display: grid;
  flex: 0 0 auto;
  min-width: 0;
  grid-template-columns: repeat(4, minmax(0, 1fr));
  gap: 1px;
  margin: 0 var(--rt-sessions-page-x) 12px;
  overflow: hidden;
  border: 1px solid var(--rt-border);
  border-radius: 10px;
  background: var(--rt-border);
}

.rt-sessions-stat {
  display: flex;
  min-width: 0;
  flex-direction: column;
  gap: 2px;
  padding: 11px 13px;
  background: var(--rt-bg-surface);
}

.rt-sessions-stat span {
  min-width: 0;
  overflow-wrap: anywhere;
  color: var(--rt-muted);
  font-size:var(--ui-text-helper);
  line-height:var(--ui-leading-body);
}

.rt-sessions-stat b {
  min-width: 0;
  overflow-wrap: anywhere;
  color: var(--rt-ink);
  font-size:var(--ui-text-metric);
  font-variant-numeric: tabular-nums;
  font-weight:600;
  letter-spacing:normal;
  line-height:var(--ui-leading-body);
}

.rt-sessions-stat small {
  min-width: 0;
  overflow-wrap: anywhere;
  color: var(--rt-muted);
  font-size:var(--ui-text-helper);
  line-height:var(--ui-leading-body);
}

.rt-sessions-scroll,
:is(.rt-dock, .rt-full) .rt-page-content > .rt-main.rt-sessions-page > .rt-sessions-scroll {
  display: block;
  flex: 1 1 0;
  min-width: 0;
  min-height: 0;
  overflow: auto !important;
  overflow-x: hidden !important;
  padding: 0 var(--rt-sessions-page-x) var(--rt-page-y, 24px);
  overscroll-behavior: contain;
  scrollbar-gutter: stable;
}

.rt-sessions-page > :is(.rt-err, .rt-foot) {
  flex: 0 0 auto;
  min-width: 0;
  margin-right: var(--rt-sessions-page-x);
  margin-left: var(--rt-sessions-page-x);
}

.rt-sessions-feedback {
  flex: 0 0 auto;
  min-width: 0;
  margin-right: var(--rt-sessions-page-x);
  margin-left: var(--rt-sessions-page-x);
}

.rt-sessions-feedback > :is(.rt-err, .rt-foot) {
  min-width: 0;
  overflow-wrap: anywhere;
}

.rt-sessions-loading {
  display: grid;
  min-height: 180px;
  place-items: center;
  padding: 24px 16px;
  color: var(--rt-muted);
  font-size:var(--ui-text-helper);
  line-height:var(--ui-leading-body);
  text-align: center;
}

.rt-sessions-empty-banner {
  display: flex;
  min-width: 0;
  align-items: flex-start;
  gap: 11px;
  margin-bottom: 12px;
  padding: 13px 15px;
  border: 1px dashed var(--rt-border);
  border-radius: 10px;
  color: var(--rt-ink);
  background: var(--rt-bg-surface);
}

.rt-sessions-empty-icon {
  display: grid;
  width: 26px;
  height: 26px;
  flex: 0 0 auto;
  place-items: center;
  border: 1px solid var(--rt-border);
  border-radius: 50%;
  color: var(--rt-accent);
  background: var(--rt-bg-subtle);
  font-size:var(--ui-text-helper);
  line-height: 1;
}

.rt-sessions-empty-banner > div {
  min-width: 0;
}

.rt-sessions-empty-banner strong {
  display: block;
  color: var(--rt-ink);
  font-size:var(--ui-text-helper);
  font-weight:600;
  line-height:var(--ui-leading-body);
}

.rt-sessions-empty-banner p {
  margin: 3px 0 0;
  color: var(--rt-muted);
  font-size:var(--ui-text-helper);
  line-height:var(--ui-leading-body);
  overflow-wrap: anywhere;
}

.rt-sessions-notices {
  display: flex;
  min-width: 0;
  flex-direction: column;
  gap: 8px;
  margin-bottom: 12px;
}

.rt-sessions-notices .rt-hint {
  min-width: 0;
  margin: 0;
  padding: 10px 12px;
}

.rt-sessions-groups {
  display: grid;
  min-width: 0;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  align-items: start;
  gap: 12px;
}

.rt-sessions-group {
  min-width: 0;
  overflow: hidden;
  border: 1px solid var(--rt-border);
  border-radius: 10px;
  color: var(--rt-ink);
  background: var(--rt-bg-surface);
}

.rt-sessions-group > .rt-sec-wrap {
  min-width: 0;
  margin: 0;
}

.rt-sessions-group .rt-sec {
  min-width: 0;
  min-height: 44px;
  padding: 10px 13px 10px 11px;
  border: 0;
  border-left: 3px solid var(--rt-accent);
  border-radius: 0;
  color: var(--rt-ink);
  background: var(--rt-bg-surface);
}

.rt-sessions-group .rt-sec:hover {
  background: var(--rt-bg-subtle);
}

.rt-sessions-group .rt-sec:focus-visible {
  outline: 2px solid var(--rt-accent);
  outline-offset: -3px;
}

.rt-sessions-group .rt-sec[aria-expanded='true'] {
  border-bottom: 1px solid var(--rt-border);
}

.rt-sessions-group .rt-sec-title {
  min-width: 0;
  overflow-wrap: anywhere;
  color: var(--rt-ink);
  font-size:var(--ui-text-section);
  line-height:var(--ui-leading-title);
}

.rt-sessions-group .rt-sec-count,
.rt-sessions-group .rt-sec-sub,
.rt-sessions-group .rt-sec-right {
  min-width: 0;
  overflow-wrap: anywhere;
  color: var(--rt-muted);
}

.rt-sessions-group .rt-sec-sub {
  text-overflow: ellipsis;
}

.rt-sessions-group .rt-sec-body {
  min-width: 0;
  margin: 0;
  padding: 0;
  border: 0;
  background: var(--rt-bg-base);
}

.rt-sessions-group-content {
  display: block;
  min-width: 0;
  max-width: 100%;
  max-height: min(52vh, 680px);
  overflow: auto;
  padding: 12px;
  background: var(--rt-bg-base);
  overscroll-behavior: contain;
  scrollbar-gutter: stable;
}

.rt-sessions-group-content:focus-visible {
  outline: 2px solid var(--rt-accent);
  outline-offset: -3px;
}

.rt-sessions-group-content.is-empty {
  display: grid;
  min-height: 180px;
  place-items: center;
  padding: 20px 16px;
}

.rt-sessions-group-content.is-empty .rt-atest-meta {
  margin: 0;
  color: var(--rt-muted);
  font-size:var(--ui-text-helper);
  line-height:var(--ui-leading-body);
  text-align: center;
}

.rt-sessions-group-content > .rt-sess-grid {
  display: grid;
  min-width: 0;
  grid-template-columns: minmax(0, 1fr);
  gap: 10px;
  padding: 0;
}

.rt-sessions-group-content .rt-sess {
  min-width: 0;
  max-width: 100%;
  padding: 12px;
  border: 1px solid var(--rt-border);
  border-radius: 10px;
  color: var(--rt-ink);
  background: var(--rt-bg-surface);
  box-shadow: none;
}

.rt-sessions-group-content .rt-sess-head {
  min-width: 0;
  align-items: flex-start;
  gap: 6px;
}

.rt-sessions-group-content .rt-sess-title {
  min-width: 0;
  flex: 1 1 180px;
  color: var(--rt-ink);
  line-height:var(--ui-leading-title);
  overflow-wrap: anywhere;
  word-break: break-all;
}

.rt-sessions-group-content .rt-sess-head > .rt-spacer {
  min-width: 8px;
  flex: 1 1 8px;
}

.rt-sessions-group-content .rt-sess-head .rt-btn {
  min-height: 32px;
  flex: 0 0 auto;
  white-space: nowrap;
}

.rt-sessions-group-content .rt-sess-facts {
  min-width: 0;
  gap: 5px;
  margin-top: 10px;
  padding-top: 9px;
  border-top: 1px solid var(--rt-border);
}

.rt-sessions-group-content .rt-sess-fact {
  display: grid;
  min-width: 0;
  grid-template-columns: minmax(62px, auto) minmax(0, 1fr);
  gap: 8px;
  color: var(--rt-ink);
  line-height:var(--ui-leading-body);
}

.rt-sessions-group-content .rt-sess-fact > b {
  min-width: 0;
  color: var(--rt-muted);
  font-size:var(--ui-text-helper);
  line-height:var(--ui-leading-body);
}

.rt-sessions-group-content .rt-sess-fact > span {
  min-width: 0;
  color: var(--rt-ink);
  overflow-wrap: anywhere;
  word-break: break-word;
}

.rt-sessions-group-content .rt-sess-fold {
  min-width: 0;
  margin-top: 9px;
}

.rt-sessions-group-content .rt-sess-fold > summary {
  min-width: 0;
  color: var(--rt-muted);
  line-height:var(--ui-leading-body);
  overflow-wrap: anywhere;
}

.rt-sessions-group-content .rt-sess-fold > summary:hover {
  color: var(--rt-accent);
}

.rt-sessions-group-content .rt-code,
.rt-sessions-group-content .rt-sess-cmd {
  min-width: 0;
  max-width: 100%;
  overflow-wrap: anywhere;
  word-break: break-all;
}

@container rt (max-width: 1100px) {
  .rt-sessions-groups {
    grid-template-columns: minmax(0, 1fr);
  }
}

@container workspace (max-width: 1100px) {
  .rt-sessions-groups {
    grid-template-columns: minmax(0, 1fr);
  }
}

@media (max-width: 1100px) {
  .rt-sessions-groups {
    grid-template-columns: minmax(0, 1fr);
  }
}

@container rt (max-width: 720px) {
  .rt-sessions-page {
    --rt-sessions-page-x: 16px;
  }

  .rt-sessions-page > .rt-sessions-toolbar {
    align-items: flex-start;
    padding-right: 16px;
    padding-left: 16px;
  }

  .rt-sessions-summary {
    grid-template-columns: repeat(2, minmax(0, 1fr));
    margin-right: 16px;
    margin-left: 16px;
  }

  .rt-sessions-scroll {
    padding-right: 16px;
    padding-left: 16px;
  }
}

@container workspace (max-width: 720px) {
  .rt-sessions-page {
    --rt-sessions-page-x: 16px;
  }

  .rt-sessions-page > .rt-sessions-toolbar {
    align-items: flex-start;
    padding-right: 16px;
    padding-left: 16px;
  }

  .rt-sessions-summary {
    grid-template-columns: repeat(2, minmax(0, 1fr));
    margin-right: 16px;
    margin-left: 16px;
  }

  .rt-sessions-scroll {
    padding-right: 16px;
    padding-left: 16px;
  }
}

@media (max-width: 720px) {
  .rt-sessions-page {
    --rt-sessions-page-x: 16px;
  }

  .rt-sessions-page > .rt-sessions-toolbar {
    align-items: flex-start;
    padding-right: 16px;
    padding-left: 16px;
  }

  .rt-sessions-summary {
    grid-template-columns: repeat(2, minmax(0, 1fr));
    margin-right: 16px;
    margin-left: 16px;
  }

  .rt-sessions-scroll {
    padding-right: 16px;
    padding-left: 16px;
  }
}

@container rt (max-width: 460px) {
  .rt-sessions-summary {
    grid-template-columns: repeat(2, minmax(0, 1fr));
  }

  .rt-sessions-toolbar-copy {
    flex-basis: 100%;
  }

  .rt-sessions-toolbar > .rt-spacer {
    display: none;
  }
}

@container workspace (max-width: 460px) {
  .rt-sessions-summary {
    grid-template-columns: repeat(2, minmax(0, 1fr));
  }

  .rt-sessions-toolbar-copy {
    flex-basis: 100%;
  }

  .rt-sessions-toolbar > .rt-spacer {
    display: none;
  }
}

@media (max-width: 460px) {
  .rt-sessions-summary {
    grid-template-columns: repeat(2, minmax(0, 1fr));
  }

  .rt-sessions-toolbar-copy {
    flex-basis: 100%;
  }

  .rt-sessions-toolbar > .rt-spacer {
    display: none;
  }
}

/* Keep long record identifiers on their own row instead of squeezing them
 * between status tags and action buttons. */
.rt-sessions-page .rt-sess-head{flex-wrap:wrap}
.rt-sessions-page .rt-sess-head>.rt-sess-title{flex:1 1 calc(100% - 18px);word-break:normal;overflow-wrap:anywhere}
.rt-sessions-page .rt-sess-head>:is(.rt-dot-on,.rt-dot-off,.rt-dot-unk){flex:none;margin-top:5px}


/* Shared page rhythm. Page-specific layouts keep ownership of scrolling. */
.rt-dock,.rt-full{--rt-page-x:28px;--rt-page-y:24px;--rt-gap:16px;--rt-card-radius:var(--ui-radius-panel);--rt-control-radius:7px}
:is(.rt-embedded,.rt-full)>.rt-body{position:relative}
:is(.rt-dock,.rt-full) .rt-workspace-pagehead{padding:var(--rt-page-y) var(--rt-page-x) 18px;background:var(--rt-bg-base);flex:none}
:is(.rt-dock,.rt-full) .rt-workspace-heading{min-width:0}
:is(.rt-dock,.rt-full) .rt-workspace-eyebrow{margin:0 0 4px;font-size:var(--ui-text-helper);line-height:var(--ui-leading-body);letter-spacing:normal;color:var(--rt-muted)}
:is(.rt-dock,.rt-full) .rt-workspace-pagehead h1{margin:0;font-size:var(--ui-text-title);font-weight:600;line-height:var(--ui-leading-title);letter-spacing:normal;color:var(--rt-ink)}
:is(.rt-dock,.rt-full) .rt-workspace-pagehead p{margin:7px 0 0;font-size:var(--ui-text-helper);line-height:var(--ui-leading-body);color:var(--rt-muted)}
:is(.rt-dock,.rt-full) .rt-page-content>.rt-main>.rt-toolbar{flex:none;padding:0 var(--rt-page-x) 14px;min-height:0;background:var(--rt-bg-base);gap:8px}
:is(.rt-dock,.rt-full) .rt-page-content>.rt-main>.rt-pane{padding:20px var(--rt-page-x) var(--rt-page-y)}
:is(.rt-dock,.rt-full) .rt-page-content>.rt-main>.rt-body{padding:20px var(--rt-page-x) var(--rt-page-y)}

/* One visible page heading; retain every original status and action control. */
:is(.rt-dock,.rt-full) .rt-ledger-heading,
:is(.rt-dock,.rt-full) .rt-collab-hero,
:is(.rt-dock,.rt-full) .rt-settings-pagehead-copy{display:none}
:is(.rt-dock,.rt-full) .rt-ledger-page{padding:0 var(--rt-page-x) var(--rt-page-y);gap:var(--rt-gap)}
:is(.rt-dock,.rt-full) .rt-ledger-header{position:absolute;top:var(--rt-page-y);right:var(--rt-page-x);gap:0}
:is(.rt-dock,.rt-full) .rt-ledger-header-actions{padding-top:0}
:is(.rt-dock,.rt-full)>.rt-body[data-page=assets]>.rt-workspace-pagehead{padding-right:330px}
:is(.rt-dock,.rt-full) .rt-ov-head{padding:0 var(--rt-page-x) 16px;gap:var(--rt-gap)}
:is(.rt-dock,.rt-full) .rt-ov-title{font-size:var(--ui-text-body);line-height:var(--ui-leading-body);letter-spacing:0;font-weight:600;color:var(--rt-ink)}
:is(.rt-dock,.rt-full) .rt-ov-scroll{padding:0 var(--rt-page-x) var(--rt-page-y)}
:is(.rt-dock,.rt-full) .rt-skills-workspace{padding:0 var(--rt-page-x) var(--rt-page-y);gap:var(--rt-gap)}
:is(.rt-dock,.rt-full) .rt-collab-page .rt-collab-pane{padding:20px var(--rt-page-x) var(--rt-page-y)}
:is(.rt-dock,.rt-full) .rt-settings-scroll{padding:20px var(--rt-page-x) var(--rt-page-y)}
:is(.rt-dock,.rt-full) .rt-settings-pagehead{margin:0 0 16px;max-width:none;justify-content:flex-end}
:is(.rt-dock,.rt-full) .rt-settings-pagehead-context{max-width:100%;padding:8px 12px;border-radius:var(--rt-control-radius)}
:is(.rt-dock,.rt-full) .rt-settings-summary{margin-bottom:20px}
:is(.rt-dock,.rt-full) .rt-artifacts-scroll{padding:20px var(--rt-page-x) var(--rt-page-y)}
:is(.rt-dock,.rt-full) .rt-chain,
:is(.rt-dock,.rt-full) .rt-ap,
:is(.rt-dock,.rt-full) .rt-r2-scroll,
:is(.rt-dock,.rt-full) .rt-rep-list{padding:20px var(--rt-page-x) var(--rt-page-y)}
:is(.rt-dock,.rt-full) .rt-page-content[data-page=knowledge]>.rt-split{margin:0 var(--rt-page-x) var(--rt-page-y);border:1px solid var(--rt-border);border-radius:var(--rt-card-radius);overflow:hidden}
:is(.rt-dock,.rt-full) .rt-page-content[data-page=knowledge]>.rt-split>.rt-list{width:300px;padding:14px;background:var(--rt-bg-surface)}
:is(.rt-dock,.rt-full) .rt-page-content[data-page=findings] .rt-table{margin:0 var(--rt-page-x) var(--rt-page-y);border:1px solid var(--rt-border);border-radius:var(--rt-card-radius)}
:is(.rt-dock,.rt-full) .rt-ledger-stats,
:is(.rt-dock,.rt-full) .rt-skills-overview{border-radius:var(--rt-card-radius);background:var(--rt-border)}
:is(.rt-dock,.rt-full) .rt-ledger-stat,
:is(.rt-dock,.rt-full) .rt-skills-stat,
:is(.rt-dock,.rt-full) .rt-settings-summary-card{min-height:76px;padding:14px 18px}
:is(.rt-dock,.rt-full) .rt-ledger-stat-value,
:is(.rt-dock,.rt-full) .rt-skills-stat strong,
:is(.rt-dock,.rt-full) .rt-settings-summary-card strong{font-size:var(--ui-text-metric);line-height:var(--ui-leading-body);font-weight:600;font-variant-numeric:tabular-nums}
:is(.rt-dock,.rt-full) .rt-ledger-stat-label,
:is(.rt-dock,.rt-full) .rt-skills-stat small{font-size:var(--ui-text-helper);line-height:var(--ui-leading-body);color:var(--rt-muted)}
@container workspace (max-width:900px){
 .rt-dock{--rt-page-x:18px;--rt-page-y:20px}
 :is(.rt-dock,.rt-full) .rt-ledger-header{position:static;justify-content:flex-end}
 :is(.rt-dock,.rt-full)>.rt-body[data-page=assets]>.rt-workspace-pagehead{padding-right:var(--rt-page-x)}
}
@container rt (max-width:900px){
 :is(.rt-dock,.rt-full) .rt-ledger-header{position:static;justify-content:flex-end}
 :is(.rt-dock,.rt-full)>.rt-body[data-page=assets]>.rt-workspace-pagehead{padding-right:var(--rt-page-x)}
}
@container workspace (max-width:720px){
 .rt-dock{--rt-page-x:16px;--rt-page-y:20px}
 :is(.rt-dock,.rt-full) .rt-workspace-pagehead h1{font-size:var(--ui-text-title)}
 :is(.rt-dock,.rt-full) .rt-page-content[data-page=knowledge]>.rt-split{flex-direction:column}
 :is(.rt-dock,.rt-full) .rt-page-content[data-page=knowledge]>.rt-split>.rt-list{width:auto;max-height:240px;border-right:0;border-bottom:1px solid var(--rt-border)}
}
@container rt (max-width:720px){
 :is(.rt-dock,.rt-full) .rt-workspace-pagehead h1{font-size:var(--ui-text-title)}
 :is(.rt-dock,.rt-full) .rt-page-content[data-page=knowledge]>.rt-split{flex-direction:column}
 :is(.rt-dock,.rt-full) .rt-page-content[data-page=knowledge]>.rt-split>.rt-list{width:auto;max-height:240px;border-right:0;border-bottom:1px solid var(--rt-border)}
}
@media(max-width:720px){.rt-full{--rt-page-x:16px;--rt-page-y:20px}}
/* Keep the configuration-file context aligned with header actions. */
:is(.rt-dock,.rt-full) .rt-settings-pagehead{position:absolute;top:var(--rt-page-y);right:var(--rt-page-x);margin:0;max-width:300px}
:is(.rt-dock,.rt-full)>.rt-body[data-page=env]>.rt-workspace-pagehead{padding-right:350px}
@container workspace (max-width:900px){:is(.rt-dock,.rt-full) .rt-settings-pagehead{position:static;max-width:none;margin-bottom:16px}:is(.rt-dock,.rt-full)>.rt-body[data-page=env]>.rt-workspace-pagehead{padding-right:var(--rt-page-x)}}
@container rt (max-width:900px){:is(.rt-dock,.rt-full) .rt-settings-pagehead{position:static;max-width:none;margin-bottom:16px}:is(.rt-dock,.rt-full)>.rt-body[data-page=env]>.rt-workspace-pagehead{padding-right:var(--rt-page-x)}}

/* A floating dock must respond to its own width as well as its host workspace. */
@container rt (max-width:720px){
 :is(.rt-dock,.rt-full) :is(.rt-workspace-pagehead,.rt-page-content,.rt-cmd){--rt-page-x:16px;--rt-page-y:20px}
 :is(.rt-dock,.rt-full)>.rt-chrome>.rt-cmd{flex-wrap:wrap;gap:6px;padding:12px 16px}
 :is(.rt-dock,.rt-full) .rt-breadcrumb{max-width:100%;flex:1 1 100%}
 :is(.rt-dock,.rt-full) .rt-breadcrumb-project{max-width:140px}
 :is(.rt-dock,.rt-full) .rt-breadcrumb>span:first-child,:is(.rt-dock,.rt-full) .rt-breadcrumb>i:first-of-type{display:none}
}


/* Shared inner visuals. Loaded after page skins; layout stays with each source component. */

/* Opaque cards: one border, one radius, no elevation. */
:is(.rt-dock, .rt-full) :is(.rt-card, .rt-ov-card, .rt-ov-score, .rt-ov-rail,
  .rt-ledger-table, .rt-ledger-list-pane, .rt-ledger-detail, .rt-skills-section,
  .rt-skills-card, .rt-skills-catalog, .rt-skills-detail, .rt-settings-card,
  .rt-collab-section, .rt-collab-config, .rt-collab-card, .rt-collab-role,
  .rt-collab-role-card,
  .rt-r2-proof, .rt-rep, .rt-evi, .rt-shots, .rt-kb) {
  border: 1px solid var(--rt-border);
  border-radius: 10px;
  color: var(--rt-ink);
  background: var(--rt-bg-surface);
  box-shadow: none;
}

:is(.rt-dock, .rt-full) .rt-settings-note-card {
  border-left-width: 3px;
  border-left-color: var(--rt-accent);
}

:is(.rt-dock, .rt-full) .rt-rep {
  border-left-width: 3px;
  border-left-color: var(--rt-success);
}

:is(.rt-dock, .rt-full) :is(.rt-skills-card[aria-pressed='true']) {
  border-color: var(--rt-accent);
  background: var(--rt-accent-soft);
  box-shadow: none;
}

:is(.rt-dock, .rt-full) :is(.rt-card h4, .rt-ov-card-title, .rt-skills-section h2,
  .rt-skills-section h3, .rt-settings-card > h3, .rt-settings-card-head h3,
  .rt-collab-role-card h4, .rt-r2-h3, .rt-r2-h4, .rt-r2-h5) {
  color: var(--rt-ink);
  line-height:var(--ui-leading-title);
}

/* Controls. Textareas retain their source min-height and typeface. */
:is(.rt-dock, .rt-full) :is(.rt-btn, .rt-icon-btn, .rt-hbtn, .rt-session-map-button,
  .rt-settings-localnav button, .rt-skills-detail-actions button, .rt-skills-actions button) {
  min-height: 32px;
  border: 1px solid var(--rt-border);
  border-radius: 7px;
  color: var(--rt-ink);
  background: var(--rt-bg-surface);
  box-shadow: none;
  font-size:var(--ui-text-helper);
  line-height: 1.35;
}

:is(.rt-dock, .rt-full) :is(.rt-btn:hover:not(:disabled), .rt-icon-btn:hover:not(:disabled), .rt-hbtn:hover:not(:disabled),
  .rt-session-map-button:hover:not(:disabled), .rt-settings-localnav button:hover:not(:disabled),
  .rt-skills-detail-actions button:hover:not(:disabled), .rt-skills-actions button:hover:not(:disabled)) {
  border-color: var(--rt-border-strong);
  color: var(--rt-ink);
  background: var(--rt-bg-raised);
}

:is(.rt-dock, .rt-full) :is(.rt-btn.rt-btn-primary, .rt-btn[data-variant='primary']) {
  border-color: var(--rt-primary, var(--rt-accent));
  color: var(--rt-accent-ink, #fff);
  background: var(--rt-primary, var(--rt-accent));
}

:is(.rt-dock, .rt-full) :is(.rt-btn.rt-btn-danger, .rt-btn[data-variant='danger']) {
  border-color: var(--rt-danger);
  color: var(--rt-danger);
  background: var(--rt-danger-bg);
}

:is(.rt-dock, .rt-full) .rt-settings-localnav button[aria-selected='true'] {
  border-color: var(--rt-border);
  color: var(--rt-accent);
  background: var(--rt-accent-soft);
}

:is(.rt-dock, .rt-full) :is(.rt-btn.rt-btn-primary:hover:not(:disabled), .rt-btn[data-variant='primary']:hover:not(:disabled)) {
  border-color: var(--rt-accent-strong, var(--rt-primary, var(--rt-accent)));
  color: var(--rt-accent-ink, #fff);
  background: var(--rt-accent-strong, var(--rt-primary, var(--rt-accent)));
}

:is(.rt-dock, .rt-full) :is(.rt-btn.rt-btn-danger:hover:not(:disabled), .rt-btn[data-variant='danger']:hover:not(:disabled)) {
  border-color: var(--rt-danger);
  color: var(--rt-danger);
  background: var(--rt-danger-bg);
}

:is(.rt-dock, .rt-full) :is(.rt-input, .rt-eng-select, .rt-score-form input,
  .rt-score-form select, .rt-session-map-search, .rt-session-map-filter,
  .rt-settings-control:not(.rt-settings-textarea), .rt-skills-search,
  .rt-skills-filters input[type='search'], .rt-skills-filters input[type='text']) {
  min-height: 32px;
  border: 1px solid var(--rt-border);
  border-radius: 7px;
  color: var(--rt-ink);
  background: var(--rt-bg-surface);
  font-size:var(--ui-text-control);
}

:is(.rt-dock, .rt-full) :is(.rt-textarea, .rt-settings-textarea) {
  border: 1px solid var(--rt-border);
  border-radius: 7px;
  color: var(--rt-ink);
  background: var(--rt-bg-surface);
  font-size:var(--ui-text-control);
}

:is(.rt-dock, .rt-full) :is(.rt-input, .rt-eng-select, .rt-textarea, .rt-settings-control,
  .rt-skills-search)::placeholder {
  color: var(--rt-muted);
  opacity: .86;
}

/* Div-based findings, score, and access tables keep display/grid/overflow/height rules. */
:is(.rt-dock, .rt-full) :is(.rt-row, .rt-vrow, .rt-score-row) {
  padding: 10px 12px;
  color: var(--rt-ink);
  background: var(--rt-bg-surface);
  border-color: var(--rt-border);
  font-size:var(--ui-text-helper);
}

:is(.rt-dock, .rt-full) :is(.rt-row.head, .rt-vrow.head, .rt-score-row.head,
  .rt-ledger-table-head) {
  padding: 10px 12px;
  color: var(--rt-muted);
  background: var(--rt-bg-subtle);
  border-color: var(--rt-border-strong);
  font-size:var(--ui-text-helper);
  font-weight:600;
}

:is(.rt-dock, .rt-full) :is(.rt-row:hover:not(:disabled), .rt-vrow:hover:not(:disabled), .rt-score-row:hover:not(:disabled)) {
  background: var(--rt-accent-soft);
}

:is(.rt-dock, .rt-full) .rt-score-group {
  padding: 10px 12px;
  color: var(--rt-muted);
  background: var(--rt-bg-subtle);
  border-color: var(--rt-border);
  font-size:var(--ui-text-helper);
}

/* Native report/markdown tables use the same body/header rhythm. */
:is(.rt-dock, .rt-full) :is(.rt-r2-table, .rt-markdown table) :is(th, td) {
  padding: 10px 12px;
  color: var(--rt-ink);
  border-color: var(--rt-border);
}

:is(.rt-dock, .rt-full) :is(.rt-r2-table, .rt-markdown table) thead {
  color: var(--rt-muted);
  font-size:var(--ui-text-helper);
}

:is(.rt-dock, .rt-full) :is(.rt-r2-table, .rt-markdown table) tbody {
  color: var(--rt-ink);
  font-size:var(--ui-text-helper);
}

/* Badges keep their semantic distinctions instead of becoming one accent color. */
:is(.rt-dock, .rt-full) :is(.rt-tag, .rt-sev, .rt-test, .rt-pri, .rt-avail,
  .rt-skills-badge, .rt-skills-card-badge, .rt-collab-readonly-badge,
  .rt-collab-config-badge, .rt-kb-kind, .rt-stage-tag, .rt-scope, .rt-scorepts,
  .rt-ov-stage-chip) {
  border-radius: 5px;
  font-size:var(--ui-text-helper);
  line-height:var(--ui-leading-body);
}

:is(.rt-dock, .rt-full) :is(.rt-tag-live, .rt-test-tested, .rt-avail-available,
  .rt-skills-badge.is-available, .rt-skills-badge[data-status='available']) {
  color: var(--rt-success);
  border-color: var(--rt-success);
  background: var(--rt-success-bg);
}

:is(.rt-dock, .rt-full) :is(.rt-tag-active, .rt-tag-warn, .rt-test-testing, .rt-sev-medium,
  .rt-avail-unknown, .rt-skills-badge.is-unknown, .rt-skills-badge[data-status='unknown']) {
  color: var(--rt-warning);
  border-color: var(--rt-warning);
  background: var(--rt-warning-bg);
}

:is(.rt-dock, .rt-full) :is(.rt-avail-broken,
  .rt-skills-badge.is-broken, .rt-skills-badge[data-status='broken'], .rt-sev-high) {
  color: var(--rt-danger);
  border-color: var(--rt-danger);
  background: var(--rt-danger-bg);
}

:is(.rt-dock, .rt-full) .rt-pri-high {
  color: var(--rt-danger);
  border-color: var(--rt-danger);
  background: var(--rt-danger-bg);
}

:is(.rt-dock, .rt-full) .rt-pri-medium {
  color: var(--rt-ink);
  border-color: var(--rt-warning);
  background: var(--rt-warning-bg);
}

:is(.rt-dock, .rt-full) .rt-pri-low {
  color: var(--rt-muted);
  border-color: var(--rt-border);
  background: var(--rt-bg-subtle);
}

/* Critical/blocked remain strong danger badges; primary badges retain their own colors. */
:is(.rt-dock, .rt-full) :is(.rt-test-blocked, .rt-sev-critical) {
  color: #fff;
  border-color: #c54c66;
  background: #c54c66;
}

/* Empty, loading, help, and error states share a clear hierarchy. */
:is(.rt-dock, .rt-full) :is(.rt-empty, .rt-r2-empty, .rt-skills-empty,
  .rt-skills-no-results, .rt-skills-status, .rt-skills-loading,
  .rt-settings-diagnostic-empty, .rt-settings-loading) {
  color: var(--rt-muted);
  background: var(--rt-bg-subtle);
  border: 1px dashed var(--rt-border-strong);
  border-radius: 8px;
  font-size:var(--ui-text-helper);
  line-height:var(--ui-leading-body);
}

:is(.rt-dock, .rt-full) :is(.rt-hint, .rt-note) {
  border: 1px solid var(--rt-warning);
  border-radius: 7px;
  color: var(--rt-ink);
  background: var(--rt-warning-bg);
  font-size:var(--ui-text-helper);
  line-height:var(--ui-leading-body);
}

:is(.rt-dock, .rt-full) :is(.rt-err, .rt-settings-alert-error) {
  border: 1px solid var(--rt-danger);
  border-radius: 7px;
  color: var(--rt-danger);
  background: var(--rt-danger-bg);
  font-size:var(--ui-text-helper);
  line-height:var(--ui-leading-body);
}

:is(.rt-dock, .rt-full) .rt-settings-alert:not(.rt-settings-alert-error) {
  border: 1px solid var(--rt-border);
  border-radius: 7px;
  color: var(--rt-muted);
  background: var(--rt-bg-subtle);
  font-size:var(--ui-text-helper);
  line-height:var(--ui-leading-body);
}

/* Code stays monospace while sharing the same opaque surface and border. */
:is(.rt-dock, .rt-full) :is(.rt-inline-code, .rt-code, .rt-md, .rt-md-code,
  .rt-r2-code, .rt-r2-pre, .rt-rep-http, .rt-clip-body, .rt-evi-body, .rt-hit-evi,
  .rt-atest-notes, .rt-skills-content, .rt-skills-diagnostics-content) {
  color: var(--rt-ink);
  background: var(--rt-bg-subtle);
  border-color: var(--rt-border);
}

:is(.rt-dock, .rt-full) :is(.rt-code, .rt-md, .rt-md-code, .rt-r2-code, .rt-r2-pre,
  .rt-rep-http, .rt-clip-body, .rt-evi-body, .rt-hit-evi, .rt-atest-notes,
  .rt-skills-content, .rt-skills-diagnostics-content) {
  border-radius: 7px;
}

:is(.rt-dock, .rt-full) .rt-inline-code {
  padding: 0 4px;
  border: 1px solid var(--rt-border);
  border-radius: 4px;
  color: var(--rt-accent);
  background: var(--rt-accent-soft);
}

/* Native report tables and session cards use the same paper surface. */
:is(.rt-dock,.rt-full) .rt-r2-table-wrap{border-color:var(--rt-border);border-radius:10px;background:var(--rt-bg-surface)}
:is(.rt-dock,.rt-full) .rt-r2-table{background:var(--rt-bg-surface)}
:is(.rt-dock,.rt-full) .rt-r2-table th{background:var(--rt-bg-subtle);color:var(--rt-muted)}
:is(.rt-dock,.rt-full) .rt-sess{border-color:var(--rt-border);border-radius:10px;background:var(--rt-bg-surface);box-shadow:none}

/* Disabled controls retain their visual variant while pointer hover is inert. */
:is(.rt-dock,.rt-full) .rt-btn:disabled{background:var(--rt-bg-surface);color:var(--rt-ink);border-color:var(--rt-border);opacity:.45;cursor:not-allowed}
:is(.rt-dock,.rt-full) .rt-btn.rt-btn-primary:disabled{background:var(--rt-primary);border-color:var(--rt-primary);color:var(--rt-accent-ink,#fff)}
:is(.rt-dock,.rt-full) .rt-btn.rt-btn-danger:disabled{background:var(--rt-danger-bg);border-color:var(--rt-danger);color:var(--rt-danger)}


/*
 * Studio skin
 *
 * This file is intentionally scoped to the panel roots carrying rt-studio.
 * It is loaded after the shared RedTeam skins, so the shell can keep its
 * existing DOM and page-owned scrolling while this layer supplies the visual
 * system and the top navigation layout.
 */

/* Semantic aliases only. Palette and type scales live in ../ui-theme.css. */
:is(.rt-dock.rt-studio, .rt-full.rt-studio) {
  --rt-studio-bg:var(--ui-canvas);
  --rt-studio-ink:var(--ui-text);
  --rt-studio-muted:var(--ui-muted);
  --rt-studio-soft:var(--ui-subtle);
  --rt-studio-line:var(--ui-line);
  --rt-studio-strong-line:var(--ui-line-strong);
  --rt-studio-hover:var(--ui-hover);
  --rt-studio-white:var(--ui-surface);
  --rt-studio-dark:var(--ui-surface);
  --rt-studio-dark-ink:var(--ui-text);
  --rt-studio-dark-muted:var(--ui-muted);
  --rt-studio-dark-line:var(--ui-line);
  --rt-studio-dark-hover:var(--ui-hover);
  --rt-studio-detail:var(--ui-surface);
  --rt-studio-detail-soft:var(--ui-subtle);
  --rt-studio-detail-ink:var(--ui-text);
  --rt-studio-detail-muted:var(--ui-muted);
  --rt-studio-primary:var(--ui-primary);
  --rt-studio-primary-ink:var(--ui-on-primary);
  --rt-studio-success:var(--ui-success);
  --rt-studio-success-bg:var(--ui-success-bg);
  --rt-studio-warning:var(--ui-warning);
  --rt-studio-warning-bg:var(--ui-warning-bg);
  --rt-studio-danger:var(--ui-danger);
  --rt-studio-danger-bg:var(--ui-danger-bg);
  --rt-bg-base:var(--ui-canvas);
  --rt-bg-surface:var(--ui-surface);
  --rt-bg-subtle:var(--ui-subtle);
  --rt-bg-raised:var(--ui-hover);
  --rt-bg-elevated:var(--ui-surface);
  --rt-rail:var(--ui-surface);
  --rt-border:var(--ui-line);
  --rt-border-strong:var(--ui-line-strong);
  --rt-ink:var(--ui-text);
  --rt-muted:var(--ui-muted);
  --rt-mute:var(--ui-muted);
  --rt-ink-soft:var(--ui-muted);
  --rt-accent:var(--ui-link);
  --rt-primary:var(--ui-primary);
  --rt-accent-strong:var(--ui-primary-hover);
  --rt-accent-soft:var(--ui-selected);
  --rt-accent-ink:var(--ui-on-primary);
  --rt-success:var(--ui-success);
  --rt-success-bg:var(--ui-success-bg);
  --rt-warning:var(--ui-warning);
  --rt-warning-bg:var(--ui-warning-bg);
  --rt-danger:var(--ui-danger);
  --rt-danger-bg:var(--ui-danger-bg);
  --rt-shadow:transparent;
  --rt-card-radius:var(--ui-radius-panel);
  --rt-control-radius:var(--ui-radius-control);
  --rt-ledger-radius:var(--ui-radius-panel);
  --rt-gap:var(--ui-space-4);
  --rt-page-x:var(--ui-space-5);
  --rt-page-y:var(--ui-space-4);
  --dsw-alias-bg-base:var(--ui-canvas);
  --dsw-alias-bg-layer-1:var(--ui-surface);
  --dsw-alias-bg-layer-2:var(--ui-subtle);
  --dsw-alias-label-primary:var(--ui-text);
  --dsw-alias-label-secondary:var(--ui-muted);
  --dsw-alias-border-l1:var(--ui-line);
  --dsw-alias-border-l2:var(--ui-line-strong);
  --dsw-alias-brand-primary:var(--ui-primary);
  --dsw-alias-state-error-primary:var(--ui-danger);
  --dsw-alias-state-warn-primary:var(--ui-warning);
  color:var(--ui-text);
  background:var(--ui-canvas);
  font:400 var(--ui-text-body)/var(--ui-leading-body) var(--ui-font);
}

:is(.rt-dock.rt-studio, .rt-full.rt-studio) *,
:is(.rt-dock.rt-studio, .rt-full.rt-studio) *::before,
:is(.rt-dock.rt-studio, .rt-full.rt-studio) *::after {
  box-sizing: border-box;
}

/* ------------------------------------------------------------------------- */
/* Shell: top navigation, command row, sub-navigation, body, footer.        */

:is(.rt-dock.rt-studio[data-open="1"], .rt-dock.rt-studio.rt-embedded, .rt-full.rt-studio) {
  display: grid !important;
  grid-template-columns: minmax(0, 1fr);
  grid-template-rows: auto auto auto minmax(0, 1fr) auto;
  grid-template-areas: "nav" "cmd" "sub" "body" "foot";
  min-width: 0;
  min-height: 0;
  overflow: hidden;
  border: 1px solid var(--rt-studio-line);
  border-radius: var(--ui-radius-panel);
  background: var(--rt-studio-bg) !important;
  color: var(--rt-studio-ink);
}

:is(.rt-full.rt-studio) {
  border-radius: 0;
}

:is(.rt-dock.rt-studio.rt-embedded) {
  border-radius: var(--ui-radius-panel);
}

:is(.rt-dock.rt-studio, .rt-full.rt-studio) > .rt-chrome {
  display: contents !important;
}

:is(.rt-dock.rt-studio, .rt-full.rt-studio) > .rt-chrome > .rt-nav {
  grid-area: nav !important;
  grid-column: 1 !important;
  grid-row: 1 !important;
  display: flex !important;
  flex: none;
  align-items: center;
  align-content: flex-start;
  width: 100%;
  min-width: 0;
  gap: 10px;
  flex-direction: row !important;
  flex-wrap: wrap;
  overflow: visible;
  padding:12px 16px;
  border: 0;
  border-bottom: 1px solid var(--rt-studio-line);
  border-radius: 0;
  background: var(--rt-studio-bg) !important;
  color: var(--rt-studio-ink);
}

:is(.rt-dock.rt-studio, .rt-full.rt-studio) .rt-workspace-brand {
  order: 1;
  display: flex;
  flex: 0 1 auto;
  align-items: center;
  min-width: max-content;
  gap: 8px;
  padding: 0;
  color: var(--rt-studio-ink);
  font-size:var(--ui-text-body);
  font-weight:600;
  letter-spacing: normal;
  white-space: nowrap;
}

:is(.rt-dock.rt-studio, .rt-full.rt-studio) .rt-workspace-brand small {
  display: block;
  margin-top: 1px;
  color: var(--rt-studio-muted);
  font-size: var(--ui-text-helper);
  font-weight:400;
  letter-spacing: normal;
}

:is(.rt-dock.rt-studio, .rt-full.rt-studio) .rt-workspace-mark {
  display: grid;
  width: 32px;
  height: 32px;
  flex: none;
  place-items: center;
  border: 1px solid var(--rt-studio-primary);
  border-radius: var(--ui-radius-control);
  background: var(--ui-primary);
  color: var(--ui-on-primary);
  font-size: 18px;
  font-weight: 700;
}

:is(.rt-dock.rt-studio, .rt-full.rt-studio) .rt-project-card {
  order: 2;
  display: flex;
  width: min(218px, 100%);
  min-width: 140px;
  min-height: var(--ui-control-height);
  flex: 0 1 218px;
  align-items: center;
  gap: 7px;
  margin: 0;
  padding: 4px 8px;
  border: 1px solid var(--rt-studio-dark-line);
  border-radius: var(--ui-radius-control);
  background: var(--rt-studio-dark-hover);
  color: var(--rt-studio-dark-ink);
  font-size: var(--ui-text-body);
}

:is(.rt-dock.rt-studio, .rt-full.rt-studio) .rt-project-card:focus-within {
  outline: 2px solid var(--rt-studio-primary);
  outline-offset: 2px;
}

:is(.rt-dock.rt-studio, .rt-full.rt-studio) .rt-project-avatar {
  display: grid;
  width: 24px;
  height: 24px;
  flex: none;
  place-items: center;
  border: 1px solid var(--rt-studio-dark-line);
  border-radius: 7px;
  background: var(--rt-studio-dark);
  color: var(--rt-studio-dark-ink);
  font-size: var(--ui-text-helper);
  font-weight: 600;
}

:is(.rt-dock.rt-studio, .rt-full.rt-studio) .rt-project-info {
  display: flex;
  min-width: 0;
  flex: 1 1 auto;
  align-items: center;
  flex-wrap: wrap;
  overflow: hidden;
}

:is(.rt-dock.rt-studio, .rt-full.rt-studio) .rt-project-info small {
  display: block;
  flex: 1 1 100%;
  min-width: 0;
  margin-top: 1px;
  overflow: hidden;
  color: var(--rt-studio-dark-muted);
  font-size: var(--ui-text-helper);
  line-height:var(--ui-leading-body);
  text-overflow: ellipsis;
  white-space: nowrap;
}

:is(.rt-dock.rt-studio, .rt-full.rt-studio) .rt-project-card .rt-eng-select {
  display: block;
  width: 100%;
  min-width: 0;
  max-width: 100%;
  height: var(--ui-control-height);
  min-height: var(--ui-control-height);
  padding: 0 18px 0 0;
  border: 0 !important;
  border-radius: 0;
  outline: 0;
  background-color: var(--rt-studio-dark-hover) !important;
  box-shadow: none !important;
  color: var(--rt-studio-dark-ink) !important;
  color-scheme: var(--ui-scheme);
  font-size:var(--ui-text-control);
  text-align: left;
  text-overflow: ellipsis;
  white-space: nowrap;
}

:is(.rt-dock.rt-studio, .rt-full.rt-studio) .rt-project-card .rt-eng-select option {
  background-color: var(--ui-surface) !important;
  color: var(--ui-text) !important;
}

/* The project selector lives in the command row in the studio shell. Keep it
 * on the paper surface there; the dark selector rules above only serve older
 * hosts that still place this card in the navigation container. */
:is(.rt-dock.rt-studio, .rt-full.rt-studio) .rt-cmd .rt-project-card {
  order: 0;
  display: flex;
  width: min(218px, 100%);
  min-width: 140px;
  min-height: var(--ui-control-height);
  flex: 0 1 218px;
  margin: 0;
  padding: 4px 8px;
  border: 1px solid var(--rt-studio-line);
  border-radius: var(--ui-radius-control);
  background: var(--rt-studio-white) !important;
  color: var(--rt-studio-ink);
}

:is(.rt-dock.rt-studio, .rt-full.rt-studio) .rt-cmd .rt-project-card .rt-project-avatar {
  border-color: var(--rt-studio-line);
  background: var(--rt-studio-soft);
  color: var(--rt-studio-ink);
}

:is(.rt-dock.rt-studio, .rt-full.rt-studio) .rt-cmd .rt-project-info small {
  color: var(--rt-studio-muted);
}

:is(.rt-dock.rt-studio, .rt-full.rt-studio) .rt-cmd .rt-project-card .rt-eng-select {
  border: 0 !important;
  background-color: var(--rt-studio-white) !important;
  color: var(--rt-studio-ink) !important;
  color-scheme: inherit;
}

:is(.rt-dock.rt-studio, .rt-full.rt-studio) .rt-cmd .rt-project-card .rt-eng-select option {
  background-color: var(--ui-surface) !important;
  color: var(--ui-text) !important;
}

:is(.rt-dock.rt-studio, .rt-full.rt-studio) .rt-nav-section {
  order: 3;
  display: block;
  min-width: max-content;
  padding: 0;
  color: var(--rt-studio-dark-muted);
  font-size: var(--ui-text-helper);
  letter-spacing: normal;
  white-space: nowrap;
}

:is(.rt-dock.rt-studio, .rt-full.rt-studio) .rt-nav-groups {
  order: 4;
  display: flex;
  min-width: 250px;
  max-width: 100%;
  flex: 1 1 360px;
  align-items: center;
  align-content: flex-start;
  gap: 4px;
  flex-direction: row !important;
  flex-wrap: wrap;
  padding: 4px;
  border: 1px solid var(--rt-studio-dark-line);
  border-radius: var(--ui-radius-panel);
  background: var(--ui-canvas);
}

:is(.rt-dock.rt-studio, .rt-full.rt-studio) .rt-nav .rt-tab-group {
  display: inline-flex;
  min-width: max-content;
  min-height: var(--ui-control-height);
  flex: 1 1 auto;
  align-items: center;
  justify-content: center;
  gap: 7px;
  margin: 0;
  padding: 7px 12px;
  border: 1px solid transparent;
  border-radius: var(--ui-radius-control);
  background: transparent;
  color: var(--rt-studio-dark-muted);
  font-size:var(--ui-text-control);
  font-weight:500;
  line-height:var(--ui-leading-control);
  white-space: nowrap;
  transition: background-color .15s ease, border-color .15s ease, color .15s ease;
}

:is(.rt-dock.rt-studio, .rt-full.rt-studio) .rt-nav .rt-tab-group:hover:not(:disabled) {
  border-color: var(--rt-studio-dark-line);
  background: var(--rt-studio-dark-hover);
  color: var(--rt-studio-dark-ink);
}

:is(.rt-dock.rt-studio, .rt-full.rt-studio) .rt-nav .rt-tab-group.on,
:is(.rt-dock.rt-studio, .rt-full.rt-studio) .rt-nav .rt-tab-group.on:hover:not(:disabled) {
  border-color: var(--rt-studio-primary);
  background: var(--ui-selected);
  color: var(--ui-selected-text);
  font-weight:600;
}

:is(.rt-dock.rt-studio, .rt-full.rt-studio) .rt-nav-symbol {
  display: grid;
  width: 17px;
  height: 17px;
  flex: none;
  place-items: center;
  color: currentColor;
  font-size: 15px;
  line-height: 1;
}

:is(.rt-dock.rt-studio, .rt-full.rt-studio) .rt-nav-symbol svg {
  display: block;
  width: 16px;
  height: 16px;
  fill: none;
  stroke: currentColor;
  stroke-linecap: round;
  stroke-linejoin: round;
  stroke-width: 1.5;
}

:is(.rt-dock.rt-studio, .rt-full.rt-studio) .rt-nav-label {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
}

:is(.rt-dock.rt-studio, .rt-full.rt-studio) .rt-nav .rt-tab-dot {
  margin-left: auto;
  box-shadow: 0 0 0 2px var(--rt-studio-dark);
}

:is(.rt-dock.rt-studio, .rt-full.rt-studio) .rt-nav .rt-tab-group.on .rt-tab-dot {
  box-shadow: 0 0 0 2px var(--rt-studio-primary);
}

:is(.rt-dock.rt-studio, .rt-full.rt-studio) .rt-nav-bottom {
  order: 5;
  display: flex;
  min-width: 0;
  flex: 0 1 auto;
  align-items: center;
  gap: 8px;
  margin: 0 0 0 auto;
  padding: 0 0 0 10px;
  border-left: 1px solid var(--rt-studio-dark-line);
  color: var(--rt-studio-dark-muted);
  font-size: var(--ui-text-helper);
  line-height:var(--ui-leading-body);
  white-space: nowrap;
}

:is(.rt-dock.rt-studio, .rt-full.rt-studio) .rt-nav-bottom span {
  display: inline;
  padding: 0;
  border: 0;
}

:is(.rt-dock.rt-studio, .rt-full.rt-studio) .rt-nav-bottom small {
  display: inline;
  margin: 0;
  color: var(--rt-studio-dark-muted);
  font-size: var(--ui-text-helper);
}

:is(.rt-dock.rt-studio, .rt-full.rt-studio) > .rt-chrome > .rt-cmd {
  grid-area: cmd !important;
  display: flex !important;
  width: 100%;
  min-width: 0;
  min-height: 52px;
  align-items: center;
  justify-content: flex-start;
  gap: 8px;
  flex-wrap: wrap;
  padding:8px 16px;
  border: 0;
  border-bottom: 1px solid var(--rt-studio-line);
  background: var(--rt-studio-white) !important;
  color: var(--rt-studio-ink);
}

:is(.rt-dock.rt-studio, .rt-full.rt-studio) .rt-breadcrumb {
  display: flex;
  min-width: 0;
  max-width: none;
  flex: 1 1 auto;
  align-items: center;
  gap: 9px;
  color: var(--rt-studio-muted);
  font-size: var(--ui-text-helper);
  line-height:var(--ui-leading-body);
}

:is(.rt-dock.rt-studio, .rt-full.rt-studio) .rt-breadcrumb strong {
  color: var(--rt-studio-ink);
  font-weight:600;
}

:is(.rt-dock.rt-studio, .rt-full.rt-studio) .rt-breadcrumb-project {
  max-width: min(260px, 30vw);
}

:is(.rt-dock.rt-studio, .rt-full.rt-studio) .rt-breadcrumb > span:first-child,
:is(.rt-dock.rt-studio, .rt-full.rt-studio) .rt-breadcrumb > i:first-of-type {
  display: inline;
}

:is(.rt-dock.rt-studio, .rt-full.rt-studio) .rt-cmd > .rt-spacer {
  flex: 1 1 16px;
}

:is(.rt-dock.rt-studio, .rt-full.rt-studio) > .rt-subnav {
  grid-area: sub !important;
  display: flex;
  width: 100%;
  min-width: 0;
  min-height: 48px;
  align-items: center;
  gap: 6px;
  flex-wrap: wrap;
  overflow: auto;
  padding: 6px 18px 7px;
  border: 0;
  border-bottom: 1px solid var(--rt-studio-line);
  background: var(--rt-studio-bg) !important;
}

:is(.rt-dock.rt-studio, .rt-full.rt-studio) .rt-subnav .rt-tab {
  display: inline-flex;
  min-height: var(--ui-control-height);
  flex: 0 0 auto;
  align-items: center;
  gap: 6px;
  padding: 7px 12px;
  border: 1px solid var(--rt-studio-line);
  border-radius: var(--ui-radius-control);
  background: var(--rt-studio-white);
  color: var(--rt-studio-muted);
  font-size:var(--ui-text-control);
  line-height:var(--ui-leading-control);
  white-space: nowrap;
}

:is(.rt-dock.rt-studio, .rt-full.rt-studio) .rt-subnav .rt-tab:hover:not(:disabled) {
  border-color: var(--rt-studio-strong-line);
  background: var(--rt-studio-hover);
  color: var(--rt-studio-ink);
}

:is(.rt-dock.rt-studio, .rt-full.rt-studio) .rt-subnav .rt-tab.on,
:is(.rt-dock.rt-studio, .rt-full.rt-studio) .rt-subnav .rt-tab.on:hover:not(:disabled) {
  border-color: var(--rt-studio-primary);
  background: var(--ui-selected);
  color: var(--ui-selected-text);
  font-weight:600;
}

:is(.rt-dock.rt-studio, .rt-full.rt-studio) > .rt-body {
  grid-area: body !important;
  display: flex;
  width: 100%;
  min-width: 0;
  min-height: 0;
  flex-direction: column;
  overflow: hidden;
  background: var(--rt-studio-bg) !important;
  color: var(--rt-studio-ink);
}

:is(.rt-dock.rt-studio, .rt-full.rt-studio) > .rt-foot {
  grid-area: foot !important;
  display: flex;
  min-width: 0;
  min-height: 32px;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
  padding: 6px 18px;
  border: 0;
  border-top: 1px solid var(--rt-studio-line);
  background: var(--rt-studio-soft) !important;
  color: var(--rt-studio-muted);
  font-size: var(--ui-text-helper);
  line-height:var(--ui-leading-body);
}

:is(.rt-dock.rt-studio, .rt-full.rt-studio) > .rt-foot .rt-nav-bottom {
  order: 0;
  display: inline-flex;
  min-width: 0;
  flex: 0 1 auto;
  align-items: center;
  gap: 6px;
  margin: 0;
  padding: 0;
  border: 0;
  color: var(--rt-studio-muted);
  font-size: var(--ui-text-helper);
  line-height:var(--ui-leading-body);
  white-space: nowrap;
}

:is(.rt-dock.rt-studio, .rt-full.rt-studio) > .rt-foot .rt-nav-bottom span,
:is(.rt-dock.rt-studio, .rt-full.rt-studio) > .rt-foot .rt-nav-bottom small {
  display: inline;
  margin: 0;
  padding: 0;
  border: 0;
  color: var(--rt-studio-muted);
  font-size: inherit;
  line-height: inherit;
}

:is(.rt-dock.rt-studio, .rt-full.rt-studio) > .rt-foot .rt-nav-section {
  order: 0;
  display: inline;
  min-width: 0;
  margin: 0;
  padding: 0;
  border: 0;
  color: var(--rt-studio-muted);
  font-size: var(--ui-text-helper);
  letter-spacing: normal;
  line-height:var(--ui-leading-body);
  white-space: nowrap;
}

/* Keep the flex/overflow chain intact: pages still own their own scrolling. */
:is(.rt-dock.rt-studio, .rt-full.rt-studio) :is(.rt-page-content, .rt-main, .rt-pane, .rt-table, .rt-chain, .rt-ap, .rt-ap-h, .rt-hflow-wrap, .rt-rep-list, .rt-ov-scroll, .rt-settings-scroll, .rt-sessions-scroll, .rt-artifacts-scroll, .rt-skills-detail-scroll) {
  min-width: 0;
  min-height: 0;
  color: var(--rt-studio-ink);
  background: var(--rt-studio-bg);
}

:is(.rt-dock.rt-studio, .rt-full.rt-studio) .rt-page-content {
  display: flex;
  min-width: 0;
  min-height: 0;
  flex: 1 1 auto;
  flex-direction: column;
  overflow: hidden;
}

:is(.rt-dock.rt-studio, .rt-full.rt-studio) .rt-workspace-pagehead {
  flex: 0 0 auto;
  padding:16px 24px;
  background: var(--rt-studio-bg);
  color: var(--rt-studio-ink);
}

:is(.rt-dock.rt-studio, .rt-full.rt-studio) .rt-workspace-pagehead h1 {
  margin: 0;
  color: var(--rt-studio-ink);
  font-size:var(--ui-text-title);
  font-weight:600;
  letter-spacing: normal;
  line-height:var(--ui-leading-title);
}

:is(.rt-dock.rt-studio, .rt-full.rt-studio) .rt-workspace-pagehead p {
  margin: 6px 0 0;
  color: var(--rt-studio-muted);
  font-size: var(--ui-text-body);
  line-height:var(--ui-leading-body);
}

:is(.rt-dock.rt-studio, .rt-full.rt-studio) .rt-workspace-eyebrow {
  margin: 0 0 4px;
  color: var(--rt-studio-muted);
  font-size: var(--ui-text-helper);
  letter-spacing: normal;
  line-height:var(--ui-leading-body);
}

/* ------------------------------------------------------------------------- */
/* Shared controls consume the product control height and radius. */

:is(.rt-dock.rt-studio, .rt-full.rt-studio) :is(
  .rt-btn,
  .rt-icon-btn,
  .rt-hbtn,
  .rt-session-map-button,
  .rt-tab,
  .rt-subtab,
  .rt-concl-i,
  .rt-settings-localnav button,
  .rt-skills-detail-actions button,
  .rt-skills-actions button,
  .rt-ov-score-tab
) {
  min-height: var(--ui-control-height);
  border: 1px solid var(--rt-studio-line);
  border-radius: var(--ui-radius-control);
  color: var(--rt-studio-ink);
  background: var(--rt-studio-white);
  box-shadow: none;
  font-size: var(--ui-text-body);
  line-height: 1.35;
}

:is(.rt-dock.rt-studio, .rt-full.rt-studio) :is(.rt-btn, .rt-icon-btn, .rt-hbtn, .rt-session-map-button) {
  padding: 7px 12px;
  cursor: pointer;
  font-family: inherit;
  white-space: nowrap;
}

:is(.rt-dock.rt-studio, .rt-full.rt-studio) :is(
  .rt-btn:hover:not(:disabled),
  .rt-icon-btn:hover:not(:disabled),
  .rt-hbtn:hover:not(:disabled),
  .rt-session-map-button:hover:not(:disabled),
  .rt-settings-localnav button:hover:not(:disabled),
  .rt-skills-detail-actions button:hover:not(:disabled),
  .rt-skills-actions button:hover:not(:disabled),
  .rt-ov-score-tab:hover:not(:disabled)
) {
  border-color: var(--rt-studio-strong-line);
  background: var(--rt-studio-hover);
  color: var(--rt-studio-ink);
}

:is(.rt-dock.rt-studio, .rt-full.rt-studio) :is(
  .rt-btn:disabled,
  .rt-icon-btn:disabled,
  .rt-hbtn:disabled,
  .rt-session-map-button:disabled,
  .rt-settings-localnav button:disabled,
  .rt-skills-detail-actions button:disabled,
  .rt-skills-actions button:disabled,
  .rt-ov-score-tab:disabled
) {
  cursor: not-allowed;
  opacity: .48;
}

:is(.rt-dock.rt-studio, .rt-full.rt-studio) :is(
  .rt-btn-primary,
  .rt-btn[data-variant="primary"],
  .rt-settings-action
) {
  border-color: var(--rt-studio-primary) !important;
  background: var(--ui-primary) !important;
  color: var(--ui-on-primary) !important;
}

:is(.rt-dock.rt-studio, .rt-full.rt-studio) :is(
  .rt-btn-primary:hover:not(:disabled),
  .rt-btn[data-variant="primary"]:hover:not(:disabled),
  .rt-settings-action:hover:not(:disabled)
) {
  border-color: var(--ui-primary-hover) !important;
  background: var(--ui-primary-hover) !important;
  color: var(--ui-on-primary) !important;
  filter:none;
}

:is(.rt-dock.rt-studio, .rt-full.rt-studio) :is(
  .rt-btn-danger,
  .rt-btn[data-variant="danger"]
) {
  border-color: var(--rt-studio-danger);
  background: var(--rt-studio-danger-bg);
  color: var(--rt-studio-danger);
}

:is(.rt-dock.rt-studio, .rt-full.rt-studio) :is(
  .rt-btn-danger:hover:not(:disabled),
  .rt-btn[data-variant="danger"]:hover:not(:disabled)
) {
  border-color: var(--rt-studio-danger);
  background: var(--rt-studio-danger-bg);
  color: var(--rt-studio-danger);
}

:is(.rt-dock.rt-studio, .rt-full.rt-studio) :is(
  .rt-input,
  .rt-eng-select,
  .rt-score-form input,
  .rt-score-form select,
  .rt-session-map-search,
  .rt-session-map-filter,
  .rt-settings-control:not(.rt-settings-textarea),
  .rt-skills-search,
  .rt-skills-filters input[type="search"],
  .rt-skills-filters input[type="text"],
  input[type="text"],
  input[type="search"],
  input[type="url"],
  input[type="number"],
  input[type="date"],
  select
) {
  min-height: var(--ui-control-height);
  border: 1px solid var(--rt-studio-line);
  border-radius: var(--ui-radius-control);
  color: var(--rt-studio-ink);
  background-color: var(--rt-studio-white);
  box-shadow: none;
  font-size:var(--ui-text-control);
}

:is(.rt-dock.rt-studio, .rt-full.rt-studio) :is(
  .rt-input,
  .rt-eng-select,
  .rt-score-form input,
  .rt-score-form select,
  .rt-session-map-search,
  .rt-session-map-filter,
  .rt-settings-control:not(.rt-settings-textarea),
  .rt-skills-search,
  .rt-skills-filters input[type="search"],
  .rt-skills-filters input[type="text"],
  input[type="text"],
  input[type="search"],
  input[type="url"],
  input[type="number"],
  input[type="date"],
  select
) {
  padding: 7px 10px;
}

:is(.rt-dock.rt-studio, .rt-full.rt-studio) :is(.rt-textarea, .rt-settings-textarea, textarea) {
  border: 1px solid var(--rt-studio-line);
  border-radius: var(--ui-radius-control);
  color: var(--rt-studio-ink);
  background: var(--rt-studio-white);
  box-shadow: none;
  font-size:var(--ui-text-control);
}

:is(.rt-dock.rt-studio, .rt-full.rt-studio) :is(input, select, textarea, button):focus-visible,
:is(.rt-dock.rt-studio, .rt-full.rt-studio) summary:focus-visible {
  outline: 2px solid var(--ui-link);
  outline-offset: 3px;
  box-shadow: none;
}

:is(.rt-dock.rt-studio, .rt-full.rt-studio) .rt-nav :is(button, input, select):focus-visible,
:is(.rt-dock.rt-studio, .rt-full.rt-studio) .rt-session-map-toolbar :is(button, input, select):focus-visible {
  outline-color: var(--rt-studio-primary);
}

:is(.rt-dock.rt-studio, .rt-full.rt-studio) :is(input, select, textarea)::placeholder {
  color: var(--rt-studio-muted);
  opacity: .9;
}

:is(.rt-dock.rt-studio, .rt-full.rt-studio) :is(.rt-follow, .rt-follow.on, .rt-follow.warn) {
  display: inline-flex;
  min-height: var(--ui-control-height);
  align-items: center;
  gap: 6px;
  padding: 7px 11px;
  border: 1px solid var(--rt-studio-line);
  border-radius: var(--ui-radius-control);
  background: var(--rt-studio-soft);
  color: var(--rt-studio-muted);
  font-size: var(--ui-text-body);
  line-height:var(--ui-leading-body);
}

:is(.rt-dock.rt-studio, .rt-full.rt-studio) .rt-follow.on {
  border-color: var(--rt-studio-success);
  background: var(--rt-studio-success-bg);
  color: var(--rt-studio-success);
}

:is(.rt-dock.rt-studio, .rt-full.rt-studio) .rt-follow.warn {
  border-color: var(--rt-studio-warning);
  background: var(--rt-studio-warning-bg);
  color: var(--rt-studio-warning);
  cursor: pointer;
}

/* Navigation and filters use the same selection state. */
:is(.rt-dock.rt-studio, .rt-full.rt-studio) :is(
  .rt-tab.on,
  .rt-tab[aria-selected="true"],
  .rt-subtab.on,
  .rt-subtab[aria-selected="true"],
  .rt-concl-i.on,
  .rt-settings-localnav button[aria-selected="true"],
  .rt-ov-score-tab.on
),
:is(.rt-dock.rt-studio, .rt-full.rt-studio) :is(
  .rt-tab.on:hover,
  .rt-tab[aria-selected="true"]:hover,
  .rt-subtab.on:hover,
  .rt-subtab[aria-selected="true"]:hover,
  .rt-concl-i.on:hover,
  .rt-settings-localnav button[aria-selected="true"]:hover,
  .rt-ov-score-tab.on:hover
) {
  border-color: var(--rt-studio-primary) !important;
  background: var(--ui-selected) !important;
  color: var(--ui-selected-text) !important;
}

/* ------------------------------------------------------------------------- */
/* Shared opaque page surfaces and readable content.                         */

:is(.rt-dock.rt-studio, .rt-full.rt-studio) :is(
  .rt-card,
  .rt-ov-card,
  .rt-ov-score,
  .rt-ov-rail,
  .rt-ov-metric,
  .rt-ov-score-tab,
  .rt-ledger-table,
  .rt-ledger-segments,
  .rt-ledger-detail,
  .rt-skills-section,
  .rt-skills-card,
  .rt-skills-catalog,
  .rt-skills-detail,
  .rt-settings-card,
  .rt-collab-section,
  .rt-collab-config,
  .rt-collab-card,
  .rt-collab-role-card,
  .rt-r2-proof,
  .rt-rep,
  .rt-evi,
  .rt-shots,
  .rt-kb,
  .rt-r2-table-wrap,
  .rt-sess
) {
  border: 1px solid var(--rt-studio-line);
  border-radius: var(--ui-radius-panel);
  color: var(--rt-studio-ink);
  background: var(--rt-studio-white);
  box-shadow:var(--ui-panel-shadow);
}

:is(.rt-dock.rt-studio, .rt-full.rt-studio) :is(
  .rt-toolbar,
  .rt-livebar,
  .rt-concl,
  .rt-subtabs,
  .rt-r2-toolbar,
  .rt-rep-tools,
  .rt-settings-toolbar,
  .rt-sessions-toolbar,
  .rt-collab-toolbar,
  .rt-evi-head,
  .rt-rep-req-head,
  .rt-ap-head,
  .rt-ap-goal,
  .rt-rep-stage,
  .rt-sec
) {
  border-color: var(--rt-studio-line);
  background: var(--rt-studio-white);
  color: var(--rt-studio-ink);
}

:is(.rt-dock.rt-studio, .rt-full.rt-studio) :is(h1, h2, h3, h4, h5, strong, b) {
  color: var(--rt-studio-ink);
}

:is(.rt-dock.rt-studio, .rt-full.rt-studio) :is(.rt-row, .rt-vrow, .rt-score-row) {
  border-color: var(--rt-studio-line);
  background: var(--rt-studio-white);
  color: var(--rt-studio-ink);
  font-size: var(--ui-text-body);
}

:is(.rt-dock.rt-studio, .rt-full.rt-studio) :is(.rt-row.head, .rt-vrow.head, .rt-score-row.head, .rt-ledger-table-head) {
  border-color: var(--rt-studio-line);
  background: var(--rt-studio-soft);
  color: var(--rt-studio-muted);
  font-size: var(--ui-text-helper);
  font-weight:600;
}

:is(.rt-dock.rt-studio, .rt-full.rt-studio) :is(.rt-row:hover, .rt-vrow:hover, .rt-score-row:hover) {
  background: var(--rt-studio-detail-soft);
  color: var(--rt-studio-detail-ink);
}

:is(.rt-dock.rt-studio, .rt-full.rt-studio) :is(.rt-score-group, .rt-sec, .rt-rep-stage, .rt-evi-head, .rt-ap-head) {
  border-color: var(--rt-studio-line);
  background: var(--rt-studio-soft);
  color: var(--rt-studio-ink);
}

:is(.rt-dock.rt-studio, .rt-full.rt-studio) :is(.rt-r2-table, .rt-markdown table) {
  border-color: var(--rt-studio-line);
  background: var(--rt-studio-white);
  color: var(--rt-studio-ink);
}

:is(.rt-dock.rt-studio, .rt-full.rt-studio) :is(.rt-r2-table, .rt-markdown table) :is(th, td) {
  border-color: var(--rt-studio-line);
  color: var(--rt-studio-ink);
}

:is(.rt-dock.rt-studio, .rt-full.rt-studio) :is(.rt-r2-table, .rt-markdown table) th {
  background: var(--rt-studio-soft);
  color: var(--rt-studio-muted);
}

:is(.rt-dock.rt-studio, .rt-full.rt-studio) :is(
  .rt-code,
  .rt-md,
  .rt-md-code,
  .rt-r2-code,
  .rt-r2-pre,
  .rt-rep-http,
  .rt-clip-body,
  .rt-evi-body,
  .rt-hit-evi,
  .rt-atest-notes,
  .rt-skills-content,
  .rt-skills-diagnostics-content
) {
  border-color: var(--rt-studio-line);
  border-radius: var(--ui-radius-control);
  background: var(--rt-studio-soft);
  color: var(--rt-studio-ink);
}

:is(.rt-dock.rt-studio, .rt-full.rt-studio) :is(.rt-empty, .rt-r2-empty, .rt-skills-empty, .rt-skills-no-results, .rt-skills-status, .rt-skills-loading, .rt-settings-diagnostic-empty, .rt-settings-loading) {
  border-color: var(--rt-studio-strong-line);
  border-radius: var(--ui-radius-control);
  background: var(--rt-studio-soft);
  color: var(--rt-studio-muted);
}

:is(.rt-dock.rt-studio, .rt-full.rt-studio) :is(.rt-hint, .rt-note) {
  border-color: var(--rt-studio-warning);
  border-radius: var(--ui-radius-control);
  background: var(--rt-studio-warning-bg);
  color: var(--rt-studio-ink);
}

:is(.rt-dock.rt-studio, .rt-full.rt-studio) :is(.rt-err, .rt-settings-alert-error) {
  border-color: var(--rt-studio-danger);
  border-radius: var(--ui-radius-control);
  background: var(--rt-studio-danger-bg);
  color: var(--rt-studio-danger);
}

:is(.rt-dock.rt-studio, .rt-full.rt-studio) :is(.rt-tag, .rt-sev, .rt-test, .rt-pri, .rt-avail, .rt-skills-badge, .rt-skills-card-badge, .rt-collab-readonly-badge, .rt-collab-config-badge, .rt-kb-kind, .rt-stage-tag, .rt-scope, .rt-scorepts, .rt-ov-stage-chip) {
  border-radius: 4px;
  font-size: var(--ui-text-helper);
  line-height:var(--ui-leading-body);
}

:is(.rt-dock.rt-studio, .rt-full.rt-studio) :is(.rt-tag-live, .rt-test-tested, .rt-avail-available, .rt-skills-badge.is-available, .rt-skills-badge[data-status="available"]) {
  border-color: var(--rt-studio-success);
  background: var(--rt-studio-success-bg);
  color: var(--rt-studio-success);
}

:is(.rt-dock.rt-studio, .rt-full.rt-studio) :is(.rt-tag-warn, .rt-test-testing, .rt-sev-medium, .rt-avail-unknown, .rt-skills-badge.is-unknown, .rt-skills-badge[data-status="unknown"]) {
  border-color: var(--rt-studio-warning);
  background: var(--rt-studio-warning-bg);
  color: var(--rt-studio-warning);
}

:is(.rt-dock.rt-studio, .rt-full.rt-studio) :is(.rt-avail-broken, .rt-skills-badge.is-broken, .rt-skills-badge[data-status="broken"], .rt-sev-high, .rt-pri-high) {
  border-color: var(--rt-studio-danger);
  background: var(--rt-studio-danger-bg);
  color: var(--rt-studio-danger);
}

:is(.rt-dock.rt-studio, .rt-full.rt-studio) :is(.rt-test-blocked, .rt-sev-critical) {
  border-color: var(--rt-studio-danger);
  background: var(--rt-studio-danger);
  color: #fff;
}

/* ------------------------------------------------------------------------- */
/* Consistent list / detail compositions.                            */

:is(.rt-dock.rt-studio, .rt-full.rt-studio) :where(
  .rt-ledger-list-pane,
  .rt-skills-catalog,
  .rt-page-content[data-page="knowledge"] > .rt-split > .rt-list,
  .rt-page-content[data-page="agents"] .rt-collab-prompts > .rt-split > .rt-list
) {
  border-color: var(--rt-studio-dark-line);
  background: var(--rt-studio-dark);
  color: var(--rt-studio-dark-ink);
}

:is(.rt-dock.rt-studio, .rt-full.rt-studio) :where(
  .rt-ledger-list-pane > .rt-row,
  .rt-skills-catalog .rt-skills-catalog-head,
  .rt-skills-catalog .rt-skills-filters,
  .rt-skills-catalog .rt-skills-list,
  .rt-page-content[data-page="knowledge"] > .rt-split > .rt-list .rt-item,
  .rt-page-content[data-page="agents"] .rt-collab-prompts > .rt-split > .rt-list .rt-item
) {
  border-color: var(--rt-studio-dark-line);
  background: var(--rt-studio-dark);
  color: var(--rt-studio-dark-ink);
}

:is(.rt-dock.rt-studio, .rt-full.rt-studio) :where(
  .rt-ledger-list-pane > .rt-row:hover,
  .rt-skills-catalog .rt-skills-card:hover,
  .rt-page-content[data-page="knowledge"] > .rt-split > .rt-list .rt-item:hover,
  .rt-page-content[data-page="agents"] .rt-collab-prompts > .rt-split > .rt-list .rt-item:hover
) {
  border-color: var(--rt-studio-dark-line);
  background: var(--rt-studio-dark-hover);
  color: var(--rt-studio-dark-ink);
}

:is(.rt-dock.rt-studio, .rt-full.rt-studio) :where(
  .rt-ledger-list-pane > .rt-ledger-table-head,
  .rt-skills-catalog .rt-skills-group,
  .rt-skills-catalog .rt-skills-group-header
) {
  border-color: var(--rt-studio-dark-line);
  background: var(--rt-studio-dark-hover);
  color: var(--rt-studio-dark-muted);
}

:is(.rt-dock.rt-studio, .rt-full.rt-studio) :where(
  .rt-ledger-list-pane > .rt-ledger-row.selected,
  .rt-skills-catalog .rt-skills-card[aria-pressed="true"],
  .rt-page-content[data-page="knowledge"] > .rt-split > .rt-list .rt-item.on,
  .rt-page-content[data-page="agents"] .rt-collab-prompts > .rt-split > .rt-list .rt-item.on
) {
  border-color: var(--ui-line);
  background: var(--ui-selected);
  color: var(--ui-selected-text);
}

:is(.rt-dock.rt-studio, .rt-full.rt-studio) :where(
  .rt-ledger-list-pane > .rt-row .rt-muted,
  .rt-ledger-list-pane > .rt-row small,
  .rt-skills-catalog .rt-skills-description,
  .rt-skills-catalog .rt-skills-source,
  .rt-skills-catalog .rt-skills-group-count,
  .rt-page-content[data-page="knowledge"] > .rt-split > .rt-list .rt-item-desc,
  .rt-page-content[data-page="agents"] .rt-collab-prompts > .rt-split > .rt-list .rt-item-desc
) {
  color: var(--rt-studio-dark-muted);
}

/* Skills catalog text has explicit light-surface tokens in skills-view.css.
 * Keep headings and filter labels readable on the graphite catalog surface. */
:is(.rt-dock.rt-studio, .rt-full.rt-studio) .rt-skills-catalog :is(
  .rt-skills-catalog-head h2,
  .rt-skills-catalog-head h3,
  .rt-skills-filter-heading,
  .rt-skills-filter-heading strong,
  .rt-skills-group,
  .rt-skills-group-header,
  .rt-skills-name
) {
  color: var(--rt-studio-dark-ink) !important;
}

:is(.rt-dock.rt-studio, .rt-full.rt-studio) .rt-skills-catalog :is(
  .rt-skills-catalog-head p,
  .rt-skills-catalog-count,
  .rt-skills-filter-heading span,
  .rt-skills-search-label,
  .rt-skills-filter-check,
  .rt-skills-check,
  .rt-skills-filters .rt-kb-check,
  .rt-skills-list > section > .rt-skills-group > span,
  .rt-skills-group-header small,
  .rt-skills-group-count
) {
  color: var(--rt-studio-dark-muted) !important;
}

/* A selected catalog/list row keeps its selection tint on hover; its secondary
 * copy must follow the detail palette instead of the graphite palette. */
:is(.rt-dock.rt-studio, .rt-full.rt-studio) :where(
  .rt-ledger-list-pane > .rt-ledger-row.selected,
  .rt-skills-catalog .rt-skills-card[aria-pressed="true"],
  .rt-page-content[data-page="knowledge"] > .rt-split > .rt-list .rt-item.on,
  .rt-page-content[data-page="agents"] .rt-collab-prompts > .rt-split > .rt-list .rt-item.on
):hover {
  border-color: var(--ui-line) !important;
  background: var(--ui-selected) !important;
  color: var(--ui-selected-text) !important;
}

:is(.rt-dock.rt-studio, .rt-full.rt-studio) :where(
  .rt-skills-catalog .rt-skills-card[aria-pressed="true"],
  .rt-page-content[data-page="knowledge"] > .rt-split > .rt-list .rt-item.on,
  .rt-page-content[data-page="agents"] .rt-collab-prompts > .rt-split > .rt-list .rt-item.on
) :where(.rt-skills-name, .rt-item-name) {
  color: var(--rt-studio-detail-ink) !important;
}

:is(.rt-dock.rt-studio, .rt-full.rt-studio) :where(
  .rt-skills-catalog .rt-skills-card[aria-pressed="true"],
  .rt-page-content[data-page="knowledge"] > .rt-split > .rt-list .rt-item.on,
  .rt-page-content[data-page="agents"] .rt-collab-prompts > .rt-split > .rt-list .rt-item.on
) :where(.rt-skills-description, .rt-skills-source, .rt-item-desc) {
  color: var(--rt-studio-detail-muted) !important;
}

:is(.rt-dock.rt-studio, .rt-full.rt-studio) .rt-ledger-list-pane > .rt-ledger-row.selected {
  color: var(--rt-studio-detail-ink) !important;
}

:is(.rt-dock.rt-studio, .rt-full.rt-studio) .rt-ledger-list-pane > .rt-ledger-row.selected :is(.rt-muted, small) {
  color: var(--rt-studio-detail-muted) !important;
}

:is(.rt-dock.rt-studio, .rt-full.rt-studio) .rt-ledger-list-pane > .rt-ledger-row.selected > .rt-mono > span[style*="font-size"] {
  color: var(--rt-studio-detail-muted) !important;
}

:is(.rt-dock.rt-studio, .rt-full.rt-studio) :where(
  .rt-ledger-detail,
  .rt-skills-detail,
  .rt-page-content[data-page="knowledge"] > .rt-split > .rt-main,
  .rt-page-content[data-page="agents"] .rt-collab-prompts > .rt-split > .rt-main
) {
  border-color: var(--ui-line);
  background: var(--rt-studio-detail);
  color: var(--rt-studio-detail-ink);
}

:is(.rt-dock.rt-studio, .rt-full.rt-studio) :where(
  .rt-ledger-detail-head,
  .rt-ledger-detail-body,
  .rt-skills-detail-toolbar,
  .rt-skills-detail-scroll,
  .rt-page-content[data-page="knowledge"] > .rt-split > .rt-main > .rt-toolbar,
  .rt-page-content[data-page="knowledge"] > .rt-split > .rt-main > .rt-pane,
  .rt-page-content[data-page="agents"] .rt-collab-prompts > .rt-split > .rt-main > .rt-toolbar,
  .rt-page-content[data-page="agents"] .rt-collab-prompts > .rt-split > .rt-main > .rt-pane
) {
  border-color: var(--ui-line);
  background: var(--rt-studio-detail);
  color: var(--rt-studio-detail-ink);
}

:is(.rt-dock.rt-studio, .rt-full.rt-studio) :where(
  .rt-ledger-detail .rt-card,
  .rt-ledger-detail .rt-table,
  .rt-skills-detail .rt-skills-section,
  .rt-page-content[data-page="knowledge"] > .rt-split > .rt-main .rt-kb
) {
  border-color: var(--ui-line);
  background: var(--rt-studio-detail-soft);
  color: var(--rt-studio-detail-ink);
}

:is(.rt-dock.rt-studio, .rt-full.rt-studio) :where(.rt-ledger-detail h2, .rt-ledger-detail h3, .rt-ledger-detail h4, .rt-skills-detail h1, .rt-skills-detail h2, .rt-skills-detail h3, .rt-page-content[data-page="knowledge"] > .rt-split > .rt-main h2, .rt-page-content[data-page="knowledge"] > .rt-split > .rt-main h3) {
  color: var(--rt-studio-detail-ink);
}

:is(.rt-dock.rt-studio, .rt-full.rt-studio) :where(.rt-ledger-detail .rt-ledger-detail-ip, .rt-ledger-detail .rt-ledger-detail-scope, .rt-ledger-detail .rt-kv b, .rt-skills-detail .rt-skills-kicker, .rt-skills-detail .rt-skills-description, .rt-skills-detail .rt-skills-facts dt, .rt-page-content[data-page="knowledge"] > .rt-split > .rt-main .rt-kb-sub) {
  color: var(--rt-studio-detail-muted);
}

/* ------------------------------------------------------------------------- */
/* Session map and related graph surfaces.                                   */

:is(.rt-dock.rt-studio, .rt-full.rt-studio) .rt-session-map {
  border-color: var(--rt-studio-line);
  border-radius: var(--ui-radius-panel);
  background: var(--rt-studio-white);
  color: var(--rt-studio-ink);
  box-shadow: none;
}

:is(.rt-dock.rt-studio, .rt-full.rt-studio) :is(.rt-session-map-head, .rt-session-map-toolbar, .rt-session-map-note, .rt-session-map-foot) {
  border-color: var(--rt-studio-dark-line);
  background: var(--rt-studio-dark);
  color: var(--rt-studio-dark-ink);
}

:is(.rt-dock.rt-studio, .rt-full.rt-studio) :is(.rt-session-map-subtitle, .rt-session-map-status, .rt-session-map-zoom, .rt-session-map-foot) {
  color: var(--rt-studio-dark-muted);
}

:is(.rt-dock.rt-studio, .rt-full.rt-studio) .rt-session-map-toolbar :is(.rt-input, .rt-session-map-button) {
  border-color: var(--rt-studio-dark-line);
  background: var(--rt-studio-dark-hover);
  color: var(--rt-studio-dark-ink);
}

:is(.rt-dock.rt-studio, .rt-full.rt-studio) .rt-session-map-toolbar :is(.rt-input, .rt-session-map-button):hover:not(:disabled) {
  border-color: var(--rt-studio-primary);
  background: var(--rt-studio-dark-hover);
  color: var(--rt-studio-dark-ink);
}

:is(.rt-dock.rt-studio, .rt-full.rt-studio) .rt-session-map-toolbar :is(.rt-session-map-search, .rt-session-map-filter)::placeholder {
  color: var(--rt-studio-dark-muted) !important;
  opacity: .9;
}

:is(.rt-dock.rt-studio, .rt-full.rt-studio) .rt-session-map-graph-pane,
:is(.rt-dock.rt-studio, .rt-full.rt-studio) .rt-session-map-graph {
  border-color: var(--rt-studio-dark-line);
  background: var(--ui-canvas);
}

:is(.rt-dock.rt-studio, .rt-full.rt-studio) .rt-session-map-detail {
  border-color: var(--ui-line);
  background: var(--rt-studio-detail);
  color: var(--rt-studio-detail-ink);
}

:is(.rt-dock.rt-studio, .rt-full.rt-studio) .rt-session-map-detail :is(.rt-session-map-detail-title, .rt-session-map-detail-name, .rt-session-map-detail-grid dd, .rt-session-map-detail-section b) {
  color: var(--rt-studio-detail-ink);
}

:is(.rt-dock.rt-studio, .rt-full.rt-studio) .rt-session-map-detail :is(.rt-session-map-detail-status, .rt-session-map-detail-updated, .rt-session-map-detail-grid dt, .rt-session-map-status-explainer, .rt-session-map-detail-section p, .rt-session-map-subtitle) {
  color: var(--rt-studio-detail-muted);
}

:is(.rt-dock.rt-studio, .rt-full.rt-studio) .rt-session-map-detail :is(.rt-session-map-detail-section, .rt-session-map-metadata) {
  border-color: var(--ui-line);
}

:is(.rt-dock.rt-studio, .rt-full.rt-studio) .rt-session-map-detail .rt-session-map-detail-section h4 {
  color: var(--rt-studio-detail-ink) !important;
}

:is(.rt-dock.rt-studio, .rt-full.rt-studio) .rt-session-map-detail .rt-session-map-detail-section h4 small {
  color: var(--rt-studio-detail-muted) !important;
}

:is(.rt-dock.rt-studio, .rt-full.rt-studio) .rt-session-map-detail :is(
  .rt-session-map-todos,
  .rt-session-map-todo,
  .rt-session-map-todo-content,
  .rt-session-map-task-summary
) {
  color: var(--rt-studio-detail-ink) !important;
}

:is(.rt-dock.rt-studio, .rt-full.rt-studio) .rt-session-map-detail .rt-session-map-todo::marker {
  color: var(--rt-studio-detail-muted) !important;
}

:is(.rt-dock.rt-studio, .rt-full.rt-studio) .rt-session-map-detail .rt-session-map-todo-state {
  border-color: var(--ui-line) !important;
  color: var(--rt-studio-detail-muted) !important;
  background: var(--rt-studio-detail-soft) !important;
}

:is(.rt-dock.rt-studio, .rt-full.rt-studio) .rt-session-map-detail .rt-session-map-todo[data-status="in_progress"] .rt-session-map-todo-state {
  border-color: var(--ui-line) !important;
  color: var(--rt-studio-detail-ink) !important;
  background: var(--rt-studio-detail-soft) !important;
}

:is(.rt-dock.rt-studio, .rt-full.rt-studio) .rt-session-map-detail .rt-session-map-todo[data-status="completed"] .rt-session-map-todo-state {
  border-color: var(--rt-studio-success) !important;
  color: var(--rt-studio-success) !important;
  background: var(--rt-studio-success-bg) !important;
}

:is(.rt-dock.rt-studio, .rt-full.rt-studio) .rt-session-map-detail .rt-session-map-todo[data-status="completed"] .rt-session-map-todo-content {
  color: var(--rt-studio-detail-muted) !important;
  text-decoration-color: var(--rt-studio-detail-muted) !important;
}

:is(.rt-dock.rt-studio, .rt-full.rt-studio) .rt-session-map-detail .rt-session-map-clipped {
  display: block;
  width: max-content;
  max-width: 100%;
  padding: 2px 5px;
  border-radius: 6px;
  color: var(--rt-studio-warning) !important;
  background: var(--rt-studio-warning-bg);
}

:is(.rt-dock.rt-studio, .rt-full.rt-studio) .rt-session-map-detail .rt-session-map-empty-info {
  border-color: var(--ui-line);
  background: var(--rt-studio-detail-soft);
  color: var(--rt-studio-detail-muted) !important;
}

:is(.rt-dock.rt-studio, .rt-full.rt-studio) .rt-session-map-node rect {
  fill: var(--rt-studio-dark-hover);
  stroke: var(--rt-studio-dark-line);
}

:is(.rt-dock.rt-studio, .rt-full.rt-studio) .rt-session-map-node:hover rect {
  stroke: var(--rt-studio-detail-muted);
}

:is(.rt-dock.rt-studio, .rt-full.rt-studio) .rt-session-map-node.selected rect {
  fill: var(--ui-selected);
  stroke: var(--rt-studio-primary);
}

:is(.rt-dock.rt-studio, .rt-full.rt-studio) .rt-session-map-edge {
  stroke: var(--rt-studio-dark-line);
  stroke-width: 1.3;
  stroke-linecap: round;
  stroke-linejoin: round;
  opacity: .72;
}

:is(.rt-dock.rt-studio, .rt-full.rt-studio) :is(.rt-session-map-node-id, .rt-session-map-node-task, .rt-session-map-node-foot) {
  fill: var(--rt-studio-dark-ink);
}

:is(.rt-dock.rt-studio, .rt-full.rt-studio) .rt-session-map-node-meta {
  fill: var(--rt-studio-dark-muted);
}

:is(.rt-dock.rt-studio, .rt-full.rt-studio) .rt-session-map-node.selected :is(.rt-session-map-node-id, .rt-session-map-node-meta, .rt-session-map-node-task, .rt-session-map-node-foot) {
  fill: var(--ui-selected-text);
}

:is(.rt-dock.rt-studio, .rt-full.rt-studio) :is(.rt-session-map-ancestor, .rt-session-map-relation) {
  border-color: var(--ui-line);
  border-radius: var(--ui-radius-control);
  background: var(--rt-studio-detail-soft);
  color: var(--rt-studio-detail-ink);
}

:is(.rt-dock.rt-studio, .rt-full.rt-studio) :is(.rt-session-map-ancestor, .rt-session-map-relation):hover {
  border-color: var(--rt-studio-primary);
  background: var(--ui-selected);
  color: var(--ui-selected-text);
}

/* ------------------------------------------------------------------------- */
/* Page families not covered by a dedicated component stylesheet.             */

:is(.rt-dock.rt-studio, .rt-full.rt-studio) :is(.rt-ov-score, .rt-ov-rail, .rt-ov-card, .rt-ov-metric, .rt-ov-score-tab, .rt-ov-entry, .rt-ov-gap) {
  border-color: var(--rt-studio-line);
  background: var(--rt-studio-white);
  color: var(--rt-studio-ink);
}

:is(.rt-dock.rt-studio, .rt-full.rt-studio) :is(.rt-ov-score, .rt-ov-rail) {
  border-radius: var(--ui-radius-panel);
  background: var(--rt-studio-detail);
  color: var(--rt-studio-detail-ink);
}

:is(.rt-dock.rt-studio, .rt-full.rt-studio) :is(.rt-ov-score-tab.on, .rt-ov-score-tab.on:hover) {
  border-color: var(--rt-studio-primary);
  background: var(--ui-selected);
  color: var(--ui-selected-text);
}

:is(.rt-dock.rt-studio, .rt-full.rt-studio) :is(.rt-collab-section, .rt-collab-config, .rt-collab-card, .rt-collab-role-card, .rt-settings-card, .rt-sessions-group, .rt-sessions-empty-banner) {
  border-color: var(--rt-studio-line);
  border-radius: var(--ui-radius-panel);
  background: var(--rt-studio-white);
  color: var(--rt-studio-ink);
  box-shadow: none;
}

:is(.rt-dock.rt-studio, .rt-full.rt-studio) :is(.rt-collab-readonly-badge, .rt-collab-config-badge, .rt-settings-pagehead-context) {
  border-color: var(--ui-line);
  background: var(--rt-studio-detail-soft);
  color: var(--rt-studio-detail-ink);
}

:is(.rt-dock.rt-studio, .rt-full.rt-studio) .rt-settings-pagehead-copy {
  display: block;
  color: var(--rt-studio-ink);
}

:is(.rt-dock.rt-studio, .rt-full.rt-studio) .rt-collab-config-summary-state {
  display: inline;
  color: var(--rt-studio-muted);
}

:is(.rt-dock.rt-studio, .rt-full.rt-studio) :is(.rt-artifacts-section, .rt-artifacts-content, .rt-r2-section, .rt-r2-group, .rt-r2-item, .rt-ap-stage, .rt-ap-col, .rt-rep-group, .rt-rep-step, .rt-clip, .rt-hit-row, .rt-atest, .rt-kb-cat, .rt-kb-tpl) {
  border-color: var(--rt-studio-line);
  border-radius: var(--ui-radius-panel);
  background: var(--rt-studio-white);
  color: var(--rt-studio-ink);
}

:is(.rt-dock.rt-studio, .rt-full.rt-studio) :is(.rt-artifacts-content, .rt-r2-section, .rt-r2-group, .rt-rep-step, .rt-clip-body, .rt-kb-body) {
  background: var(--rt-studio-soft);
}

:is(.rt-dock.rt-studio, .rt-full.rt-studio) :is(.rt-settings-summary-card, .rt-skills-stat, .rt-ledger-stat, .rt-sessions-stat) {
  border-color: var(--rt-studio-line);
  border-radius: var(--ui-radius-panel);
  background: var(--rt-studio-white);
  color: var(--rt-studio-ink);
}

:is(.rt-dock.rt-studio, .rt-full.rt-studio) .rt-settings-localnav {
  border-color: var(--rt-studio-line);
  border-radius: var(--ui-radius-panel);
  background: var(--rt-studio-soft);
}

:is(.rt-dock.rt-studio, .rt-full.rt-studio) .rt-settings-localnav button {
  background: transparent;
  color: var(--rt-studio-muted);
}

:is(.rt-dock.rt-studio, .rt-full.rt-studio) .rt-settings-localnav button[aria-selected="true"] {
  border-color: var(--rt-studio-primary);
  background: var(--ui-selected);
  color: var(--ui-selected-text);
}

/* Opaque overlays and menus stay legible in either theme. */
:is(.rt-dock.rt-studio, .rt-full.rt-studio) :is(.rt-modal, .rt-modal-box, .rt-shot-zoom, [role="dialog"], [role="menu"]) {
  border-color: var(--rt-studio-line);
  border-radius: var(--ui-radius-panel);
  background: var(--rt-studio-white);
  color: var(--rt-studio-ink);
  box-shadow: none;
}

:is(.rt-dock.rt-studio, .rt-full.rt-studio) .rt-modal {
  background: var(--ui-canvas);
}

:is(.rt-dock.rt-studio, .rt-full.rt-studio) .rt-shot-zoom {
  background: var(--rt-studio-dark);
  color: var(--rt-studio-dark-ink);
}

/* ------------------------------------------------------------------------- */
/* Narrow containers: wrap the six groups rather than hiding any of them.    */

@container workspace (max-width: 900px) {
  :is(.rt-dock.rt-studio, .rt-full.rt-studio) > .rt-chrome > .rt-nav,
  :is(.rt-dock.rt-studio, .rt-full.rt-studio) > .rt-chrome > .rt-cmd,
  :is(.rt-dock.rt-studio, .rt-full.rt-studio) > .rt-subnav {
    padding-right: 14px;
    padding-left: 14px;
  }

  :is(.rt-dock.rt-studio, .rt-full.rt-studio) .rt-nav-groups {
    min-width: 0;
    flex-basis: 100%;
  }

  :is(.rt-dock.rt-studio, .rt-full.rt-studio) .rt-nav-bottom {
    flex-basis: 100%;
    margin-left: 0;
    padding-top: 6px;
    padding-left: 0;
    border-top: 1px solid var(--rt-studio-dark-line);
    border-left: 0;
  }

  :is(.rt-dock.rt-studio, .rt-full.rt-studio) .rt-breadcrumb-project {
    max-width: 180px;
  }
}

@container rt (max-width: 900px) {
  :is(.rt-dock.rt-studio, .rt-full.rt-studio) > .rt-chrome > .rt-nav,
  :is(.rt-dock.rt-studio, .rt-full.rt-studio) > .rt-chrome > .rt-cmd,
  :is(.rt-dock.rt-studio, .rt-full.rt-studio) > .rt-subnav {
    padding-right: 14px;
    padding-left: 14px;
  }

  :is(.rt-dock.rt-studio, .rt-full.rt-studio) .rt-nav-groups {
    min-width: 0;
    flex-basis: 100%;
  }

  :is(.rt-dock.rt-studio, .rt-full.rt-studio) .rt-nav-bottom {
    flex-basis: 100%;
    margin-left: 0;
    padding-top: 6px;
    padding-left: 0;
    border-top: 1px solid var(--rt-studio-dark-line);
    border-left: 0;
  }

  :is(.rt-dock.rt-studio, .rt-full.rt-studio) .rt-breadcrumb-project {
    max-width: 180px;
  }
}

@container workspace (max-width: 620px) {
  :is(.rt-dock.rt-studio, .rt-full.rt-studio) > .rt-chrome > .rt-nav {
    align-items: stretch;
    padding: 10px 12px;
  }

  :is(.rt-dock.rt-studio, .rt-full.rt-studio) .rt-workspace-brand,
  :is(.rt-dock.rt-studio, .rt-full.rt-studio) .rt-project-card,
  :is(.rt-dock.rt-studio, .rt-full.rt-studio) .rt-nav-section,
  :is(.rt-dock.rt-studio, .rt-full.rt-studio) .rt-nav-groups,
  :is(.rt-dock.rt-studio, .rt-full.rt-studio) .rt-nav-bottom {
    flex-basis: 100%;
  }

  :is(.rt-dock.rt-studio, .rt-full.rt-studio) .rt-project-card {
    width: 100%;
    max-width: none;
  }

  :is(.rt-dock.rt-studio, .rt-full.rt-studio) .rt-nav-section {
    padding-top: 2px;
  }

  :is(.rt-dock.rt-studio, .rt-full.rt-studio) .rt-nav-groups {
    justify-content: flex-start;
  }

  :is(.rt-dock.rt-studio, .rt-full.rt-studio) .rt-nav .rt-tab-group {
    flex: 1 1 auto;
  }

  :is(.rt-dock.rt-studio, .rt-full.rt-studio) > .rt-chrome > .rt-cmd {
    align-items: stretch;
    padding: 8px 12px;
  }

  :is(.rt-dock.rt-studio, .rt-full.rt-studio) .rt-breadcrumb {
    flex-basis: 100%;
    max-width: 100%;
  }

  :is(.rt-dock.rt-studio, .rt-full.rt-studio) .rt-breadcrumb-project {
    max-width: 130px;
  }

  :is(.rt-dock.rt-studio, .rt-full.rt-studio) .rt-workspace-pagehead {
    padding: 18px 16px 12px;
  }

  :is(.rt-dock.rt-studio, .rt-full.rt-studio) .rt-workspace-pagehead h1 {
    font-size:var(--ui-text-title);
  }
}

@container rt (max-width: 620px) {
  :is(.rt-dock.rt-studio, .rt-full.rt-studio) > .rt-chrome > .rt-nav {
    align-items: stretch;
    padding: 10px 12px;
  }

  :is(.rt-dock.rt-studio, .rt-full.rt-studio) .rt-workspace-brand,
  :is(.rt-dock.rt-studio, .rt-full.rt-studio) .rt-project-card,
  :is(.rt-dock.rt-studio, .rt-full.rt-studio) .rt-nav-section,
  :is(.rt-dock.rt-studio, .rt-full.rt-studio) .rt-nav-groups,
  :is(.rt-dock.rt-studio, .rt-full.rt-studio) .rt-nav-bottom {
    flex-basis: 100%;
  }

  :is(.rt-dock.rt-studio, .rt-full.rt-studio) .rt-project-card {
    width: 100%;
    max-width: none;
  }

  :is(.rt-dock.rt-studio, .rt-full.rt-studio) .rt-nav-section {
    padding-top: 2px;
  }

  :is(.rt-dock.rt-studio, .rt-full.rt-studio) .rt-nav-groups {
    justify-content: flex-start;
  }

  :is(.rt-dock.rt-studio, .rt-full.rt-studio) .rt-nav .rt-tab-group {
    flex: 1 1 auto;
  }

  :is(.rt-dock.rt-studio, .rt-full.rt-studio) > .rt-chrome > .rt-cmd {
    align-items: stretch;
    padding: 8px 12px;
  }

  :is(.rt-dock.rt-studio, .rt-full.rt-studio) .rt-breadcrumb {
    flex-basis: 100%;
    max-width: 100%;
  }

  :is(.rt-dock.rt-studio, .rt-full.rt-studio) .rt-breadcrumb-project {
    max-width: 130px;
  }

  :is(.rt-dock.rt-studio, .rt-full.rt-studio) .rt-workspace-pagehead {
    padding: 18px 16px 12px;
  }

  :is(.rt-dock.rt-studio, .rt-full.rt-studio) .rt-workspace-pagehead h1 {
    font-size:var(--ui-text-title);
  }
}

@media (max-width: 720px) {
  :is(.rt-full.rt-studio) > .rt-chrome > .rt-nav,
  :is(.rt-full.rt-studio) > .rt-chrome > .rt-cmd,
  :is(.rt-full.rt-studio) > .rt-subnav {
    padding-right: 12px;
    padding-left: 12px;
  }
}

@media (prefers-reduced-motion: reduce) {
  :is(.rt-dock.rt-studio, .rt-full.rt-studio) *,
  :is(.rt-dock.rt-studio, .rt-full.rt-studio) *::before,
  :is(.rt-dock.rt-studio, .rt-full.rt-studio) *::after {
    scroll-behavior: auto !important;
    transition: none !important;
  }
}

/* Numeric and rich-text children follow the selected control's foreground. */
:is(.rt-dock.rt-studio, .rt-full.rt-studio) :is(.rt-concl-i.on,.rt-ov-score-tab.on,.rt-btn-primary,.rt-tab-group.on,.rt-settings-localnav button[aria-selected="true"]) :is(b,strong,span){color:inherit;}
:is(.rt-dock.rt-studio, .rt-full.rt-studio) :is(.rt-test-blocked,.rt-sev-critical){color:var(--ui-on-primary);}

/* Small docks scroll their shell instead of collapsing the functional page. */
:is(.rt-dock.rt-studio[data-open="1"],.rt-dock.rt-studio.rt-embedded,.rt-full.rt-studio){
  grid-template-rows:auto auto auto minmax(300px,1fr) auto;
  overflow:auto;
  scrollbar-gutter:stable;
  overscroll-behavior:contain;
}

/* Details, filters and table text keep the same role across all 12 pages. */
:is(.rt-dock.rt-studio,.rt-full.rt-studio) :is(b,strong) {font-weight:600;}
:is(.rt-dock.rt-studio,.rt-full.rt-studio) .rt-concl-i>span {font-size:var(--ui-text-control);line-height:var(--ui-leading-control);color:inherit;}
:is(.rt-dock.rt-studio,.rt-full.rt-studio) .rt-concl-i>b {font-size:var(--ui-text-control);font-weight:600;line-height:var(--ui-leading-control);}
:is(.rt-dock.rt-studio,.rt-full.rt-studio) :is(.rt-tag,.rt-sev,.rt-test,.rt-pri,.rt-avail,.rt-scope) {font-family:var(--ui-font)!important;font-size:var(--ui-text-label);font-weight:500;line-height:var(--ui-leading-control);border-radius:4px;}
:is(.rt-dock.rt-studio,.rt-full.rt-studio) :is(.rt-scope-external,.rt-pri-low,.rt-test-untested,.rt-test-abandoned) {background:var(--ui-subtle);color:var(--ui-muted);border-color:var(--ui-line);}
:is(.rt-dock.rt-studio,.rt-full.rt-studio) :is(.rt-scope-internal,.rt-test-no_surface) {background:var(--ui-selected);color:var(--ui-selected-text);border-color:var(--ui-line);}
:is(.rt-dock.rt-studio,.rt-full.rt-studio) .rt-pri-medium {background:var(--ui-warning-bg);color:var(--ui-warning);border-color:var(--ui-warning);}
:is(.rt-dock.rt-studio,.rt-full.rt-studio) :is(.rt-sev-critical,.rt-test-blocked) {background:var(--ui-danger-bg);color:var(--ui-danger);border-color:var(--ui-danger);}
:is(.rt-dock.rt-studio,.rt-full.rt-studio) .rt-ledger-stat-icon {background:var(--ui-subtle);color:var(--ui-muted);border-color:var(--ui-line);}
:is(.rt-dock.rt-studio,.rt-full.rt-studio) .rt-ledger-stat-accent .rt-ledger-stat-icon {background:var(--ui-selected);color:var(--ui-selected-text);border-color:var(--ui-line);}
:is(.rt-dock.rt-studio,.rt-full.rt-studio) .rt-ledger-stat-warn .rt-ledger-stat-icon {background:var(--ui-warning-bg);color:var(--ui-warning);border-color:var(--ui-line);}
:is(.rt-dock.rt-studio,.rt-full.rt-studio) .rt-session-map-toolbar :is(.rt-input,.rt-session-map-button) {background:var(--ui-surface);border-color:var(--ui-line);}
:is(.rt-dock.rt-studio,.rt-full.rt-studio) .rt-nav-groups {flex:0 1 auto;margin-left:auto;padding:0;border:0;background:transparent;gap:4px;}
:is(.rt-dock.rt-studio,.rt-full.rt-studio) .rt-nav .rt-tab-group {flex:0 1 auto;border-radius:var(--ui-radius-control);}
:is(.rt-dock.rt-studio,.rt-full.rt-studio) .rt-nav .rt-tab-group.on {border-color:var(--ui-line);}
:is(.rt-dock.rt-studio,.rt-full.rt-studio) .rt-cmd .rt-project-info small {display:none;}
:is(.rt-dock.rt-studio,.rt-full.rt-studio) .rt-cmd .rt-project-card {padding:0 8px;min-height:var(--ui-control-height);}
:is(.rt-dock.rt-studio,.rt-full.rt-studio) :is(input,select,textarea) {line-height:var(--ui-leading-control);}

/* Embedded mode already has the product identity in the outer frame. */
.rt-embedded.rt-studio .rt-workspace-brand {display:none;}
:is(.rt-dock.rt-studio,.rt-full.rt-studio) .rt-nav .rt-tab-group[data-group=resources]::after {display:none;content:none;}
:is(.rt-dock.rt-studio,.rt-full.rt-studio) .rt-nav .rt-tab-group[data-group=resources] {margin-top:0;}
:is(.rt-dock.rt-studio,.rt-full.rt-studio) .rt-nav-groups {justify-content:flex-start;margin-left:0;}
:is(.rt-dock.rt-studio,.rt-full.rt-studio) .rt-settings-pagehead-copy :is(h1,.rt-settings-eyebrow) {display:none;}
:is(.rt-dock.rt-studio,.rt-full.rt-studio) .rt-settings-pagehead-copy p {margin:0;}

/* Semantic markers share one palette, including populated records. */
:is(.rt-dock.rt-studio,.rt-full.rt-studio) :is(.rt-tag-passive,.rt-sev-info,.rt-kb-kind.k-template,.rt-kb-kind.k-script) {color:var(--ui-link);background:var(--ui-selected);border-color:var(--ui-line);}
:is(.rt-dock.rt-studio,.rt-full.rt-studio) :is(.rt-tag-active,.rt-kb-kind.k-poc) {color:var(--ui-warning);background:var(--ui-warning-bg);border-color:var(--ui-warning);}
:is(.rt-dock.rt-studio,.rt-full.rt-studio) :is(.rt-sev-low,.rt-kb-kind.k-payload,.rt-scorepts) {color:var(--ui-success);background:var(--ui-success-bg);border-color:var(--ui-success);}
:is(.rt-dock.rt-studio,.rt-full.rt-studio) .rt-kb-kind.k-exp {color:var(--ui-danger);background:var(--ui-danger-bg);border-color:var(--ui-danger);}
:is(.rt-dock.rt-studio,.rt-full.rt-studio) :is(.rt-ov-pts-got,.rt-ov-metric-ok .rt-ov-metric-value,.rt-rep-idx,.rt-hl-req) {color:var(--ui-success);}
:is(.rt-dock.rt-studio,.rt-full.rt-studio) .rt-session-map-note {font-size:var(--ui-text-helper);line-height:var(--ui-leading-body);}
:is(.rt-dock.rt-studio,.rt-full.rt-studio) .rt-session-map-node :is(.rt-session-map-node-id,.rt-session-map-node-meta,.rt-session-map-node-task,.rt-session-map-node-foot) {font-size:var(--ui-text-helper);font-family:var(--ui-font)!important;}

:is(.rt-dock.rt-studio,.rt-full.rt-studio) .rt-workspace-eyebrow {display:none;}

:is(.rt-dock.rt-studio,.rt-full.rt-studio) :is(.rt-stage-recon,.rt-st-recon,.rt-stage-pivot,.rt-st-pivot,.rt-stage-data,.rt-st-data){background:var(--ui-selected);color:var(--ui-selected-text);}
:is(.rt-dock.rt-studio,.rt-full.rt-studio) :is(.rt-stage-vuln,.rt-st-vuln){background:var(--ui-warning-bg);color:var(--ui-warning);}
:is(.rt-dock.rt-studio,.rt-full.rt-studio) :is(.rt-stage-exploit,.rt-st-exploit){background:var(--ui-danger-bg);color:var(--ui-danger);}
:is(.rt-dock.rt-studio,.rt-full.rt-studio) :is(.rt-stage-access,.rt-st-access){background:var(--ui-success-bg);color:var(--ui-success);}
:is(.rt-dock.rt-studio,.rt-full.rt-studio) :is(.rt-stage-other,.rt-st-other){background:var(--ui-subtle);color:var(--ui-muted);}
:is(.rt-dock.rt-studio,.rt-full.rt-studio) :is(.rt-hit-idx,.rt-rep-step-no){background:var(--ui-selected);color:var(--ui-selected-text);}

/* Navigation, command row and content form three distinct surface levels. */
:is(.rt-dock.rt-studio,.rt-full.rt-studio)>.rt-chrome>.rt-nav{min-height:48px;padding:6px 16px;background:var(--ui-nav)!important}
:is(.rt-dock.rt-studio,.rt-full.rt-studio)>.rt-chrome>.rt-cmd{min-height:46px;padding:6px 20px;background:var(--ui-surface)!important}
:is(.rt-dock.rt-studio,.rt-full.rt-studio) .rt-workspace-pagehead{padding-top:18px;padding-bottom:14px}
:is(.rt-dock.rt-studio,.rt-full.rt-studio) .rt-nav .rt-tab-group{padding:8px 14px}
:is(.rt-dock.rt-studio,.rt-full.rt-studio) .rt-nav .rt-tab-group.on{position:relative;color:var(--ui-selected-text);border-color:var(--ui-line-strong)}
:is(.rt-dock.rt-studio,.rt-full.rt-studio) .rt-nav .rt-tab-group.on::after{content:"";position:absolute;left:14px;right:14px;bottom:0;height:2px;border-radius:1px;background:var(--ui-link)}


/* Overview composition. All values are real snapshot/score data; this module
 * changes the visual hierarchy without replacing the existing controls. */
:is(.rt-dock.rt-studio,.rt-full.rt-studio) .rt-ov-scroll {
  display:flex;
  flex-direction:column;
  gap:16px;
  padding-bottom:24px;
}
:is(.rt-dock.rt-studio,.rt-full.rt-studio) .rt-ov-head {
  min-height:34px;
  margin-bottom:12px;
  align-items:center;
}
:is(.rt-dock.rt-studio,.rt-full.rt-studio) .rt-ov-title-row {gap:8px;}
:is(.rt-dock.rt-studio,.rt-full.rt-studio) .rt-ov-title {
  max-width:55ch;
  font-size:var(--ui-text-body);
  font-weight:500;
  color:var(--ui-muted);
}
:is(.rt-dock.rt-studio,.rt-full.rt-studio) .rt-ov-facts {
  display:grid;
  grid-template-columns:repeat(4,minmax(0,1fr));
  border:1px solid var(--ui-line);
  border-radius:var(--ui-radius-panel);
  background:var(--ui-surface);
  box-shadow:var(--ui-panel-shadow);
}
:is(.rt-dock.rt-studio,.rt-full.rt-studio) .rt-ov-fact {
  position:relative;
  display:grid;
  min-width:0;
  grid-template-columns:minmax(0,1fr) auto;
  gap:4px 12px;
  padding:14px 20px;
  border:0;
  border-right:1px solid var(--ui-line);
  background:transparent;
  color:var(--ui-text);
  text-align:left;
  cursor:pointer;
  font:inherit;
}
:is(.rt-dock.rt-studio,.rt-full.rt-studio) .rt-ov-fact:last-child {border-right:0;}
:is(.rt-dock.rt-studio,.rt-full.rt-studio) .rt-ov-fact:hover {background:var(--ui-hover);}
:is(.rt-dock.rt-studio,.rt-full.rt-studio) .rt-ov-fact-label {
  color:var(--ui-muted);
  font-size:var(--ui-text-label);
}
:is(.rt-dock.rt-studio,.rt-full.rt-studio) .rt-ov-fact-value {
  grid-column:1;
  font-size:var(--ui-text-metric);
  font-weight:600;
  line-height:1.25;
  font-variant-numeric:tabular-nums;
}
:is(.rt-dock.rt-studio,.rt-full.rt-studio) .rt-ov-fact-go {
  grid-column:2;
  grid-row:1/3;
  align-self:center;
  color:var(--ui-muted);
  font-size:16px;
}
:is(.rt-dock.rt-studio,.rt-full.rt-studio) .rt-ov-hero {
  display:grid;
  grid-template-columns:minmax(240px,.72fr) minmax(0,1.65fr);
  gap:16px;
}
:is(.rt-dock.rt-studio,.rt-full.rt-studio) .rt-ov-score-feature {
  position:relative;
  display:grid;
  min-height:184px;
  grid-template-columns:minmax(0,1fr) auto;
  grid-template-rows:auto 1fr auto;
  gap:12px;
  padding:20px 24px;
  border:1px solid var(--ui-feature-line);
  border-radius:var(--ui-radius-panel);
  background:var(--ui-feature-surface);
  color:var(--ui-feature-text);
  box-shadow:var(--ui-panel-shadow);
}
:is(.rt-dock.rt-studio,.rt-full.rt-studio) .rt-ov-score-feature::before {
  content:"";
  position:absolute;
  top:20px;
  bottom:20px;
  left:0;
  width:3px;
  border-radius:0 2px 2px 0;
  background:var(--ui-feature-accent);
}
:is(.rt-dock.rt-studio,.rt-full.rt-studio) .rt-ov-score-feature .rt-ov-score-label {
  grid-column:1/-1;
  font-size:var(--ui-text-label);
  color:var(--ui-feature-muted);
}
:is(.rt-dock.rt-studio,.rt-full.rt-studio) .rt-ov-score-feature .rt-ov-score-num {
  grid-column:1/-1;
  align-self:center;
  color:var(--ui-feature-text);
  font-size:var(--ui-text-display);
  font-weight:600;
  line-height:1.1;
  font-variant-numeric:tabular-nums;
  white-space:nowrap;
}
:is(.rt-dock.rt-studio,.rt-full.rt-studio) .rt-ov-score-feature .rt-ov-score-num small {
  margin-left:8px;
  color:var(--ui-feature-muted);
  font-size:var(--ui-text-section);
  font-weight:400;
}
:is(.rt-dock.rt-studio,.rt-full.rt-studio) .rt-ov-score-feature .rt-ov-score-sub {
  grid-column:1/-1;
  grid-row:3;
  padding-bottom:44px;
  color:var(--ui-feature-muted);
  font-size:var(--ui-text-helper);
  line-height:var(--ui-leading-body);
}
:is(.rt-dock.rt-studio,.rt-full.rt-studio) .rt-ov-score-feature>.rt-btn-inverse {
  position:absolute;
  right:20px;
  bottom:16px;
  margin:0;
  background:transparent;
  border-color:var(--ui-feature-line);
  color:var(--ui-feature-text);
}
:is(.rt-dock.rt-studio,.rt-full.rt-studio) .rt-ov-score-feature>.rt-btn-inverse:hover:not(:disabled) {
  background:var(--ui-feature-hover);
  border-color:var(--ui-feature-muted);
  color:var(--ui-feature-text);
}
:is(.rt-dock.rt-studio,.rt-full.rt-studio) .rt-ov-rail {
  display:flex;
  justify-content:flex-start;
  padding:20px;
  border:1px solid var(--ui-line);
  background:var(--ui-surface);
  box-shadow:var(--ui-panel-shadow);
}
:is(.rt-dock.rt-studio,.rt-full.rt-studio) .rt-ov-rail-head {
  display:flex;
  align-items:center;
  justify-content:space-between;
  gap:12px;
  margin-bottom:20px;
  font-size:var(--ui-text-section);
  font-weight:600;
  color:var(--ui-text);
}
:is(.rt-dock.rt-studio,.rt-full.rt-studio) .rt-ov-rail-caption {
  color:var(--ui-muted);
  font-size:var(--ui-text-helper);
  font-weight:400;
}
:is(.rt-dock.rt-studio,.rt-full.rt-studio) .rt-ov-stages {
  display:grid;
  grid-template-columns:repeat(5,minmax(0,1fr));
  gap:8px;
  align-items:stretch;
}
:is(.rt-dock.rt-studio,.rt-full.rt-studio) .rt-ov-stage {
  position:relative;
  min-width:0;
  padding:0 8px 10px;
  background:transparent;
  border-radius:var(--ui-radius-control);
}
:is(.rt-dock.rt-studio,.rt-full.rt-studio) .rt-ov-stage.on {background:var(--ui-selected);}
:is(.rt-dock.rt-studio,.rt-full.rt-studio) .rt-ov-node {
  display:grid;
  width:28px;
  height:28px;
  margin-bottom:12px;
  place-items:center;
  border:1px solid var(--ui-line-strong);
  border-radius:50%;
  background:var(--ui-subtle);
  color:var(--ui-muted);
  font-size:var(--ui-text-label);
  font-weight:600;
}
:is(.rt-dock.rt-studio,.rt-full.rt-studio) .rt-ov-stage.has .rt-ov-node {
  border-color:var(--ui-primary);
  background:var(--ui-primary);
  color:var(--ui-on-primary);
}
:is(.rt-dock.rt-studio,.rt-full.rt-studio) .rt-ov-stage:not(:last-child)::after {
  top:14px;
  left:44px;
  right:-8px;
  height:1px;
  background:var(--ui-line);
}
:is(.rt-dock.rt-studio,.rt-full.rt-studio) .rt-ov-stage-name {
  min-height:2.6em;
  font-size:var(--ui-text-label);
  font-weight:500;
  line-height:1.3;
  overflow-wrap:anywhere;
}
:is(.rt-dock.rt-studio,.rt-full.rt-studio) .rt-ov-stage-pts {
  margin:6px 0 2px;
  font-size:var(--ui-text-section);
  font-weight:600;
  font-variant-numeric:tabular-nums;
}
:is(.rt-dock.rt-studio,.rt-full.rt-studio) .rt-ov-stage-cum {
  color:var(--ui-muted);
  font-size:var(--ui-text-helper);
}
:is(.rt-dock.rt-studio,.rt-full.rt-studio) .rt-ov-stage-share {
  height:3px;
  margin-top:12px;
  overflow:hidden;
  border-radius:2px;
  background:var(--ui-line);
}
:is(.rt-dock.rt-studio,.rt-full.rt-studio) .rt-ov-stage-share i {
  display:block;
  height:100%;
  background:var(--ui-link);
}
:is(.rt-dock.rt-studio,.rt-full.rt-studio) .rt-ov-grid {
  display:grid;
  grid-template-columns:minmax(0,1.65fr) minmax(260px,.8fr);
  grid-template-rows:auto auto;
  gap:16px;
  margin:0;
  align-items:start;
}
:is(.rt-dock.rt-studio,.rt-full.rt-studio) .rt-ov-card {
  min-width:0;
  padding:18px 20px;
  border:1px solid var(--ui-line);
  border-radius:var(--ui-radius-panel);
  background:var(--ui-surface);
  box-shadow:var(--ui-panel-shadow);
}
:is(.rt-dock.rt-studio,.rt-full.rt-studio) .rt-ov-score-detail {
  grid-column:1;
  grid-row:1/3;
  min-height:100%;
}
:is(.rt-dock.rt-studio,.rt-full.rt-studio) .rt-ov-entry-card {grid-column:2;grid-row:1;}
:is(.rt-dock.rt-studio,.rt-full.rt-studio) .rt-ov-team-card {grid-column:2;grid-row:2;}
:is(.rt-dock.rt-studio,.rt-full.rt-studio) .rt-ov-card-head {margin-bottom:14px;gap:8px;}
:is(.rt-dock.rt-studio,.rt-full.rt-studio) .rt-ov-score-tabs {
  display:flex;
  flex-wrap:wrap;
  gap:8px;
  margin:0 0 8px;
  padding-bottom:14px;
  border-bottom:1px solid var(--ui-line);
}
:is(.rt-dock.rt-studio,.rt-full.rt-studio) .rt-ov-score-tabs .rt-ov-score-tab {
  display:flex;
  min-width:0;
  flex:0 1 auto;
  align-items:center;
  gap:8px;
  padding:8px 12px;
  text-align:left;
}
:is(.rt-dock.rt-studio,.rt-full.rt-studio) .rt-ov-score-tabs .rt-ov-score-tab :is(.rt-ov-score-tab-label,.rt-ov-score-tab-value,.rt-ov-score-tab-sub) {
  display:inline;
  margin:0;
  font-size:var(--ui-text-control);
  line-height:var(--ui-leading-control);
  color:inherit;
}
:is(.rt-dock.rt-studio,.rt-full.rt-studio) .rt-ov-score-tabs .rt-ov-score-tab .rt-ov-score-tab-value {font-weight:600;}
:is(.rt-dock.rt-studio,.rt-full.rt-studio) .rt-ov-score-tabs .rt-ov-score-tab .rt-ov-score-tab-sub {font-size:var(--ui-text-helper);opacity:.8;}
:is(.rt-dock.rt-studio,.rt-full.rt-studio) .rt-ov-gaps {gap:0;}
:is(.rt-dock.rt-studio,.rt-full.rt-studio) .rt-ov-gap {
  display:grid;
  min-width:0;
  grid-template-columns:24px minmax(0,1fr) auto;
  gap:12px;
  padding:14px 0;
  border:0;
  border-bottom:1px solid var(--ui-line);
  border-radius:0;
  background:transparent;
}
:is(.rt-dock.rt-studio,.rt-full.rt-studio) .rt-ov-gap:last-child {border-bottom:0;}
:is(.rt-dock.rt-studio,.rt-full.rt-studio) .rt-ov-gap:hover {background:var(--ui-hover);}
:is(.rt-dock.rt-studio,.rt-full.rt-studio) .rt-ov-rank {
  display:grid;
  width:24px;
  height:24px;
  place-items:center;
  border:1px solid var(--ui-line);
  border-radius:4px;
  background:var(--ui-subtle);
  color:var(--ui-muted);
  font-size:var(--ui-text-helper);
  font-variant-numeric:tabular-nums;
}
:is(.rt-dock.rt-studio,.rt-full.rt-studio) .rt-ov-gap-name {font-size:var(--ui-text-body);font-weight:500;line-height:var(--ui-leading-body);}
:is(.rt-dock.rt-studio,.rt-full.rt-studio) .rt-ov-gap-meta {margin-top:3px;font-size:var(--ui-text-helper);color:var(--ui-muted);}
:is(.rt-dock.rt-studio,.rt-full.rt-studio) .rt-ov-bar {height:3px;margin-top:8px;border-radius:2px;}
:is(.rt-dock.rt-studio,.rt-full.rt-studio) .rt-ov-pts {align-self:center;font-size:var(--ui-text-section);font-weight:600;font-variant-numeric:tabular-nums;}
:is(.rt-dock.rt-studio,.rt-full.rt-studio) .rt-ov-metric-row {gap:12px;}
:is(.rt-dock.rt-studio,.rt-full.rt-studio) .rt-ov-metric {padding:0 12px 0 0;border:0;border-right:1px solid var(--ui-line);border-radius:0;background:transparent;}
:is(.rt-dock.rt-studio,.rt-full.rt-studio) .rt-ov-metric:last-child {border-right:0;}
:is(.rt-dock.rt-studio,.rt-full.rt-studio) .rt-ov-entry-list {margin-top:14px;}
:is(.rt-dock.rt-studio,.rt-full.rt-studio) .rt-ov-actions {margin-top:14px;gap:8px;}
:is(.rt-dock.rt-studio,.rt-full.rt-studio) .rt-ov-empty {padding:12px 0;color:var(--ui-muted);font-size:var(--ui-text-helper);}

@container rt (max-width:1000px) {
  :is(.rt-dock.rt-studio,.rt-full.rt-studio) .rt-ov-hero {grid-template-columns:minmax(210px,.7fr) minmax(0,1.6fr);}
  :is(.rt-dock.rt-studio,.rt-full.rt-studio) .rt-ov-score-feature {padding:18px;}
  :is(.rt-dock.rt-studio,.rt-full.rt-studio) .rt-ov-rail {padding:18px 14px;}
  :is(.rt-dock.rt-studio,.rt-full.rt-studio) .rt-ov-stage {padding-right:4px;padding-left:4px;}
  :is(.rt-dock.rt-studio,.rt-full.rt-studio) .rt-ov-rail-caption {max-width:15ch;text-align:right;}
}
@container rt (max-width:760px) {
  :is(.rt-dock.rt-studio,.rt-full.rt-studio) .rt-ov-hero,
  :is(.rt-dock.rt-studio,.rt-full.rt-studio) .rt-ov-grid {grid-template-columns:minmax(0,1fr);}
  :is(.rt-dock.rt-studio,.rt-full.rt-studio) :is(.rt-ov-score-detail,.rt-ov-entry-card,.rt-ov-team-card) {grid-column:1;grid-row:auto;}
  :is(.rt-dock.rt-studio,.rt-full.rt-studio) .rt-ov-score-feature {min-height:176px;}
  :is(.rt-dock.rt-studio,.rt-full.rt-studio) .rt-ov-facts {grid-template-columns:repeat(2,minmax(0,1fr));}
  :is(.rt-dock.rt-studio,.rt-full.rt-studio) .rt-ov-fact:nth-child(2) {border-right:0;}
  :is(.rt-dock.rt-studio,.rt-full.rt-studio) .rt-ov-fact:nth-child(-n+2) {border-bottom:1px solid var(--ui-line);}
}
@container rt (max-width:460px) {
  :is(.rt-dock.rt-studio,.rt-full.rt-studio) .rt-ov-stages {grid-template-columns:minmax(0,1fr);gap:8px;}
  :is(.rt-dock.rt-studio,.rt-full.rt-studio) .rt-ov-stage {display:grid;grid-template-columns:28px minmax(0,1fr) auto;gap:4px 12px;padding:10px;}
  :is(.rt-dock.rt-studio,.rt-full.rt-studio) .rt-ov-node {grid-row:1/3;margin:0;}
  :is(.rt-dock.rt-studio,.rt-full.rt-studio) .rt-ov-stage-name {min-height:0;}
  :is(.rt-dock.rt-studio,.rt-full.rt-studio) .rt-ov-stage-pts {grid-column:3;grid-row:1;margin:0;}
  :is(.rt-dock.rt-studio,.rt-full.rt-studio) .rt-ov-stage-cum {grid-column:2;grid-row:2;}
  :is(.rt-dock.rt-studio,.rt-full.rt-studio) .rt-ov-stage-share {grid-column:2/4;margin-top:4px;}
  :is(.rt-dock.rt-studio,.rt-full.rt-studio) .rt-ov-stage:not(:last-child)::after {display:none;}
  :is(.rt-dock.rt-studio,.rt-full.rt-studio) .rt-ov-rail-head {align-items:flex-start;}
  :is(.rt-dock.rt-studio,.rt-full.rt-studio) .rt-ov-score-tabs .rt-ov-score-tab {flex:1 1 100%;flex-wrap:wrap;}
}

/* Project context and refresh share the workspace heading rather than a row. */
:is(.rt-dock.rt-studio,.rt-full.rt-studio)>.rt-body[data-page=overview]>.rt-workspace-pagehead{padding-right:480px}
:is(.rt-dock.rt-studio,.rt-full.rt-studio) .rt-ov-head{position:absolute;top:18px;right:24px;max-width:430px;margin:0;padding:0;z-index:1}
:is(.rt-dock.rt-studio,.rt-full.rt-studio) .rt-ov-title-row{flex-wrap:nowrap}
:is(.rt-dock.rt-studio,.rt-full.rt-studio) .rt-ov-title{max-width:25ch;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
:is(.rt-dock.rt-studio,.rt-full.rt-studio) .rt-ov-score-tabs .rt-ov-score-tab{flex-direction:row}
@container rt (max-width:1000px){
 :is(.rt-dock.rt-studio,.rt-full.rt-studio)>.rt-body[data-page=overview]>.rt-workspace-pagehead{padding-right:24px}
 :is(.rt-dock.rt-studio,.rt-full.rt-studio) .rt-ov-head{position:static;max-width:none;margin-bottom:12px;padding:0 var(--rt-page-x);z-index:auto}
}

/* "Anything that needs me now" — the prototype panel's first question.
 * Hidden entirely when the queue is empty and coverage has no gaps, so no empty state. */
:is(.rt-dock.rt-studio,.rt-full.rt-studio) .rt-ov-attn {
  /* .rt-ov-scroll is a column flex; default flex-shrink:1 squashes this block to 2px.
     It is the first screen the operator must see, so pin its own height. */
  flex:0 0 auto;
  border:1px solid var(--ui-line);
  border-left:3px solid var(--ui-warning);
  border-radius:var(--ui-radius-panel);
  background:var(--ui-surface);
  box-shadow:var(--ui-panel-shadow);
  overflow:hidden;
}
:is(.rt-dock.rt-studio,.rt-full.rt-studio) .rt-ov-attn-live {
  border-left-color:var(--ui-danger);
}
:is(.rt-dock.rt-studio,.rt-full.rt-studio) .rt-ov-attn-head {
  display:flex;
  align-items:center;
  gap:10px;
  padding:12px 16px;
  border-bottom:1px solid var(--ui-line);
  background:var(--ui-subtle);
}
:is(.rt-dock.rt-studio,.rt-full.rt-studio) .rt-ov-attn-title {
  font-size:var(--ui-text-control);
  font-weight:600;
  color:var(--ui-text);
}
:is(.rt-dock.rt-studio,.rt-full.rt-studio) .rt-ov-attn-count {
  display:inline-flex;
  min-width:20px;
  height:20px;
  align-items:center;
  justify-content:center;
  padding:0 6px;
  border-radius:99px;
  background:var(--ui-warning-bg);
  color:var(--ui-warning);
  font-size:var(--ui-text-label);
  font-weight:600;
  font-variant-numeric:tabular-nums;
}
:is(.rt-dock.rt-studio,.rt-full.rt-studio) .rt-ov-attn-live .rt-ov-attn-count {
  background:var(--ui-danger-bg);
  color:var(--ui-danger);
}
:is(.rt-dock.rt-studio,.rt-full.rt-studio) .rt-ov-attn-list {
  display:flex;
  flex-direction:column;
}
:is(.rt-dock.rt-studio,.rt-full.rt-studio) .rt-ov-attn-row {
  display:flex;
  align-items:flex-start;
  gap:12px;
  padding:10px 16px;
  border-bottom:1px solid var(--ui-line);
}
:is(.rt-dock.rt-studio,.rt-full.rt-studio) .rt-ov-attn-row:last-child {border-bottom:0;}
:is(.rt-dock.rt-studio,.rt-full.rt-studio) .rt-ov-attn-stage {
  flex:0 0 auto;
  min-width:64px;
  padding:2px 8px;
  border-radius:var(--ui-radius-control);
  font-size:var(--ui-text-label);
  font-weight:600;
  text-align:center;
  white-space:nowrap;
}
:is(.rt-dock.rt-studio,.rt-full.rt-studio) .rt-ov-attn-ask {background:var(--ui-warning-bg);color:var(--ui-warning);}
:is(.rt-dock.rt-studio,.rt-full.rt-studio) .rt-ov-attn-review {background:var(--ui-selected);color:var(--ui-selected-text);}
:is(.rt-dock.rt-studio,.rt-full.rt-studio) .rt-ov-attn-bad {background:var(--ui-danger-bg);color:var(--ui-danger);}
:is(.rt-dock.rt-studio,.rt-full.rt-studio) .rt-ov-attn-run {background:var(--ui-subtle);color:var(--ui-muted);}
:is(.rt-dock.rt-studio,.rt-full.rt-studio) .rt-ov-attn-main {
  min-width:0;
  flex:1 1 auto;
  display:flex;
  flex-direction:column;
  gap:3px;
}
:is(.rt-dock.rt-studio,.rt-full.rt-studio) .rt-ov-attn-who {
  font-size:var(--ui-text-control);
  font-weight:500;
  color:var(--ui-text);
}
:is(.rt-dock.rt-studio,.rt-full.rt-studio) .rt-ov-attn-reason {
  font-size:var(--ui-text-label);
  color:var(--ui-muted);
  overflow-wrap:anywhere;
}
:is(.rt-dock.rt-studio,.rt-full.rt-studio) .rt-ov-attn-needs {
  display:flex;
  flex-wrap:wrap;
  gap:6px;
  margin-top:2px;
}
:is(.rt-dock.rt-studio,.rt-full.rt-studio) .rt-ov-attn-empty {
  padding:14px 16px;
  color:var(--ui-muted);
  font-size:var(--ui-text-label);
}
:is(.rt-dock.rt-studio,.rt-full.rt-studio) .rt-ov-attn-foot {
  display:flex;
  gap:8px;
  padding:10px 16px;
  border-top:1px solid var(--ui-line);
}
/* Summary numbers use readable semantic tones in both product themes. */
:is(.rt-dock,.rt-full) .rt-ov-metric-ok .rt-ov-metric-value { color:var(--ui-success); }
:is(.rt-dock,.rt-full) .rt-ov-metric-warn .rt-ov-metric-value { color:var(--ui-warning); }


/* Narrow-window adaptation: the right dock is only 620px wide, so layout switches
 * on container width, not viewport; wide (full browse) uses viewport media queries. */

/* ── Dock: below 860px narrow the left nav, drop the title slot, wrap the toolbar ── */
@container workspace (max-width: 860px) {
  .dshp-dock-body .rt-dock.rt-embedded { grid-template-columns: 132px minmax(0, 1fr); }
  .rt-embedded > .rt-chrome > .rt-nav { padding: 16px 8px; }
  .rt-embedded .rt-nav::before { display: none; content: none; }
  .rt-embedded .rt-nav .rt-tab-group { gap: 8px; padding: 9px 8px; font-size: var(--ui-text-control); }
  .rt-embedded .rt-nav .rt-tab-group::before { width: 16px; height: 16px; }
  .rt-embedded > .rt-chrome > .rt-cmd,
  .rt-embedded > .rt-subnav,
  .rt-embedded > .rt-foot { padding-left: 14px; padding-right: 14px; }
  .rt-embedded .rt-cmd::before { display: none; content: none; }
  .rt-embedded .rt-cmd .rt-eng-select { flex: 1 1 220px; min-width: 0; max-width: none; }
}

/* ── Dock: below 720px the nav goes horizontal and the body takes full width ── */
@container workspace (max-width: 720px) {
  .dshp-dock-body .rt-dock.rt-embedded {
    grid-template-columns: minmax(0, 1fr);
    grid-template-rows: auto auto auto minmax(0, 1fr) auto;
  }
  .rt-embedded > .rt-chrome > .rt-nav {
    grid-column: 1;
    grid-row: 1;
    flex-direction: row;
    align-items: center;
    gap: 4px;
    padding: 8px;
    overflow-x: auto;
    border-right: 0;
    border-bottom: 1px solid var(--rt-border);
  }
  .rt-embedded .rt-nav .rt-tab-group { flex: 1 0 auto; min-height: 34px; justify-content: center; gap: 8px; padding: 7px 10px; }
  .rt-embedded .rt-nav .rt-tab-group::before { display: none; }
  .rt-embedded > .rt-chrome > .rt-cmd { grid-column: 1; grid-row: 2; }
  .rt-embedded > .rt-subnav { grid-column: 1; grid-row: 3; }
  .rt-embedded > .rt-body { grid-column: 1; grid-row: 4; }
  .rt-embedded > .rt-foot { grid-column: 1; grid-row: 5; }
}

/* ── Both modes: no child may overflow a narrow container, multi-column grids go 1-up ── */
@container workspace (max-width: 720px) {
  :where(.rt-dock.rt-embedded, .rt-full) > .rt-body,
  :where(.rt-dock.rt-embedded, .rt-full) > .rt-body > * { min-width: 0; max-width: 100%; }
  .rt-dock.rt-embedded .rt-body { overflow: auto; }
  .rt-dock.rt-embedded .rt-body :where(
    .rt-ov-grid, .rt-ov-hero, .rt-ov-metric-row, .rt-ov-stages,
    .rt-collab-role-grid, .rt-settings-summary, .rt-settings-workspace,
    .rt-skills-grid, .rt-kb-list, .rt-assets-grid, .rt-ws-grid,
    .rt-r2-proof-grid, .rt-session-map
  ) { grid-template-columns: minmax(0, 1fr) !important; }
  .rt-dock.rt-embedded .rt-body :where(pre, table, .rt-r2-table-wrap) { max-width: 100%; }
  .rt-dock.rt-embedded .rt-body :where(.rt-r2-table, .rt-skills-table, .rt-settings-table) { min-width: 0; }
}

/* ── Full browse: steps by window width (was 760/560, the middle step was skipped) ── */
@media (max-width: 1180px) {
  .rt-full { grid-template-columns: 148px minmax(0, 1fr); }
  .rt-full .rt-nav .rt-tab-group { padding: 9px 10px; gap: 8px; }
  .rt-full .rt-nav::before { padding: 0 10px 12px; }
}

@media (max-width: 960px) {
  .rt-full {
    grid-template-columns: minmax(0, 1fr);
    grid-template-rows: auto auto auto minmax(0, 1fr) auto;
  }
  .rt-full > .rt-chrome > .rt-nav {
    grid-column: 1;
    grid-row: 1;
    flex-direction: row;
    align-items: center;
    gap: 4px;
    padding: 8px;
    overflow-x: auto;
    border-right: 0;
    border-bottom: 1px solid var(--rt-border);
  }
  .rt-full .rt-nav::before { display: none; content: none; }
  .rt-full .rt-nav .rt-tab-group { flex: 1 0 auto; min-height: 34px; justify-content: center; padding: 7px 10px; }
  .rt-full .rt-nav .rt-tab-group::before { display: none; }
  .rt-full > .rt-chrome > .rt-cmd { grid-column: 1; grid-row: 2; padding: 10px 14px; }
  .rt-full .rt-cmd::before { display: none; content: none; }
  .rt-full > .rt-subnav { grid-column: 1; grid-row: 3; padding: 7px 14px; }
  .rt-full > .rt-body { grid-column: 1; grid-row: 4; }
  .rt-full > .rt-foot { grid-column: 1; grid-row: 5; padding: 7px 14px; }
}


/* Glass is a material layer; layout, semantic colours and interactions stay
 * owned by the existing components. No host content is used as a backdrop. */
:is(.dshp-dock,.dshp-root,.dshp-auth-mask,.dshp-modal-bg,.dshp-restart-mask,.rt-dock,.rt-full) {
  --ui-glass-blur:blur(22px) saturate(145%);
  --ui-glass-mask-blur:blur(10px) saturate(110%);
  --ui-glass-wash:linear-gradient(128deg,var(--ui-glass-glint),transparent 42%,transparent 72%,var(--ui-glass-glint));
  --ui-material-card:var(--ui-glass-wash),var(--ui-glass-surface);
  --ui-material-inset:var(--ui-glass-chrome);
  --ui-material-reading:var(--ui-glass-dense);
  --ui-water-backdrop:radial-gradient(ellipse at 8% 0%,var(--ui-water-light),transparent 62%),radial-gradient(ellipse at 95% 85%,var(--ui-water-blue),transparent 70%),var(--ui-water-texture),radial-gradient(ellipse at 72% 32%,var(--ui-water-refraction),transparent 52%),linear-gradient(135deg,var(--ui-water-base),var(--ui-water-deep));
  --ui-water-texture:none;
}

/* Self-contained, static caustics. The refracted contour light lives behind
 * the UI, never on text or controls, so it cannot distort their hit targets. */
:is(.dshp-dock,.dshp-root,.rt-dock,.rt-full) {
  --ui-water-texture:url("data:image/svg+xml,%3Csvg%20xmlns%3D%22http%3A%2F%2Fwww.w3.org%2F2000%2Fsvg%22%20width%3D%221400%22%20height%3D%221000%22%20viewBox%3D%220%200%201400%201000%22%3E%3Cdefs%3E%3Cfilter%20id%3D%22water%22%20x%3D%22-20%25%22%20y%3D%22-20%25%22%20width%3D%22140%25%22%20height%3D%22140%25%22%3E%3CfeTurbulence%20type%3D%22fractalNoise%22%20baseFrequency%3D%22.004%20.007%22%20numOctaves%3D%222%22%20seed%3D%228%22%20result%3D%22noise%22%2F%3E%3CfeDisplacementMap%20in%3D%22SourceGraphic%22%20in2%3D%22noise%22%20scale%3D%22100%22%20xChannelSelector%3D%22R%22%20yChannelSelector%3D%22G%22%2F%3E%3CfeGaussianBlur%20stdDeviation%3D%221.3%22%2F%3E%3C%2Ffilter%3E%3ClinearGradient%20id%3D%22light%22%20x2%3D%221%22%20y2%3D%221%22%3E%3Cstop%20stop-color%3D%22%23d5fbff%22%20stop-opacity%3D%22.05%22%2F%3E%3Cstop%20offset%3D%22.45%22%20stop-color%3D%22%23d5fbff%22%20stop-opacity%3D%22.6%22%2F%3E%3Cstop%20offset%3D%221%22%20stop-color%3D%22%23d5fbff%22%20stop-opacity%3D%22.04%22%2F%3E%3C%2FlinearGradient%3E%3C%2Fdefs%3E%3Cg%20filter%3D%22url%28%23water%29%22%20fill%3D%22none%22%20stroke%3D%22url%28%23light%29%22%3E%3Cpath%20stroke-width%3D%222%22%20d%3D%22M-100%20175C90-40%20395%2065%20555%20225S925%20425%201490%20100M-110%20310C120%2095%20330%20175%20540%20330S1000%20520%201490%20235M-100%20455C100%20230%20380%20290%20605%20455S1030%20645%201490%20390M-100%20615C130%20390%20370%20440%20600%20590S1055%20780%201490%20540M-100%20780C180%20555%20440%20610%20670%20760S1100%20905%201490%20700M-100%20930C200%20715%20430%20770%20695%20910S1130%201060%201490%20875%22%2F%3E%3Cpath%20stroke-width%3D%229%22%20opacity%3D%22.12%22%20d%3D%22M-100%20185C90-30%20395%2075%20555%20235S925%20435%201490%20110M-100%20465C100%20240%20380%20300%20605%20465S1030%20655%201490%20400M-100%20790C180%20565%20440%20620%20670%20770S1100%20915%201490%20710%22%2F%3E%3C%2Fg%3E%3C%2Fsvg%3E");
}

/* Water belongs to one root in each window. Nested pages reveal that same
 * backdrop instead of restarting a wallpaper in every card. */
.dshp-dock.dshp-studio-dock,
.dshp-root:not(.dshp-dock .dshp-root),
:is(.rt-dock.rt-studio:not(.rt-embedded),.rt-full.rt-studio) {
  background-color:var(--ui-water-base) !important;
  background-image:var(--ui-water-backdrop) !important;
  color:var(--ui-text) !important;
  background-size:auto,auto,1400px 1000px,auto,auto;
  background-position:center,center,center top,center,center;
  border-color:var(--ui-glass-edge);
  box-shadow:0 24px 80px rgb(0 10 24 / .3),inset 0 1px 0 var(--ui-glass-rim),inset 1px 0 0 var(--ui-glass-edge);
}
.dshp-dock.dshp-studio-dock {border-radius:22px;}
.rt-full.rt-studio {border-radius:0;box-shadow:none;}
.dshp-dock.dshp-studio-dock .dshp-dock-head {border-radius:21px 21px 0 0;}

/* Legacy page aliases consume the new material too. This also covers older
 * high-specificity split-pane rules without overriding their layout/state. */
:is(.rt-dock.rt-studio,.rt-full.rt-studio) {
  --rt-studio-white:var(--ui-glass-surface);
  --rt-studio-dark:var(--ui-glass-dense);
  --rt-studio-detail:var(--ui-glass-dense);
  --rt-studio-soft:var(--ui-glass-chrome);
  --rt-studio-detail-soft:var(--ui-glass-chrome);
  --rt-bg-surface:var(--ui-glass-surface);
  --rt-bg-subtle:var(--ui-glass-chrome);
}
:is(.dshp-dock,.dshp-root,.dshp-modal,.dshp-auth-modal,.dshp-restart-card) {
  --dshp-paper:var(--ui-glass-surface);
  --dshp-fill:var(--ui-glass-dense);
}

/* Continuous backdrop through both products; scrolling ownership unchanged. */
.dshp-dock.dshp-studio-dock :is(.dshp-dock-body,.dshp-root,.dshp-studio-layout,.dshp-studio-main,.dshp-studio-purgify-host),
:is(.rt-dock.rt-studio,.rt-full.rt-studio) :is(
  .rt-body,.rt-page-content,.rt-workspace-pagehead,.rt-main,.rt-pane:where(:not(:has(>.rt-score-form))),
  .rt-ov-scroll,.rt-settings,.rt-settings-scroll,.rt-ledger,.rt-ledger-main,.rt-ledger-page,
  .rt-collab,.rt-collab-scroll,.rt-sessions,.rt-sessions-scroll,
  .rt-artifacts,.rt-artifacts-scroll,.rt-skills,.rt-skills-workspace,
  .rt-chain,.rt-ap,.rt-ap-h,.rt-hflow-wrap,.rt-rep-list
),
.dshp-dock.dshp-studio-dock .rt-dock.rt-embedded.rt-studio {
  background:transparent !important;
}
.dshp-dock.dshp-studio-dock .rt-dock.rt-embedded.rt-studio {
  border:0;
  border-radius:0;
  box-shadow:none;
}

/* Chrome has a stronger frost than cards. Insets form a thin lit upper rim
 * and a darker lower bevel, rather than an opaque outline around every box. */
.dshp-dock.dshp-studio-dock .dshp-dock-head,
.dshp-root.dshp-studio-root .dshp-studio-nav,
:is(.rt-dock.rt-studio,.rt-full.rt-studio) > .rt-chrome > :is(.rt-nav,.rt-cmd),
:is(.rt-dock.rt-studio,.rt-full.rt-studio) > :is(.rt-subnav,.rt-foot) {
  background:var(--ui-glass-wash),var(--ui-glass-chrome) !important;
  border-color:var(--ui-glass-edge);
  box-shadow:inset 0 1px 0 var(--ui-glass-glint);
  backdrop-filter:var(--ui-glass-blur);
  -webkit-backdrop-filter:var(--ui-glass-blur);
}

/* Shared material for all page families, including the clean workbench. */
:is(.rt-dock.rt-studio,.rt-full.rt-studio) .rt-page-content[data-page] :is(
  .rt-card,.rt-ov-facts,.rt-ov-rail,.rt-ov-card,.rt-ledger-stats,.rt-ledger-table,.rt-ledger-list-pane,
  .rt-ledger-detail,.rt-ledger-segments,.rt-table,.rt-settings-summary,.rt-settings-card,
  .rt-collab-section,.rt-collab-config,.rt-collab-card,.rt-collab-role-card,
  .rt-sessions-summary,.rt-sessions-group,.rt-sessions-empty-banner,
  .rt-artifacts-section,.rt-skills-summary,.rt-skills-section,
  .rt-skills-catalog,.rt-skills-detail,.rt-skills-card,.rt-skills-overview,
  .rt-r2-proof,.rt-r2-section,.rt-r2-table-wrap,.rt-r2-group,.rt-r2-item,
  .rt-rep,.rt-rep-group,.rt-rep-step,.rt-evi,.rt-shots,.rt-kb,
  .rt-ap-stage,.rt-ap-col,.rt-hcol,.rt-kb-cat,.rt-kb-tpl,.rt-clip,.rt-hit-row,.rt-atest,.rt-sess
),
:is(.rt-dock.rt-studio,.rt-full.rt-studio) .rt-card,
:is(.rt-dock.rt-studio,.rt-full.rt-studio) .rt-page-content[data-page=scores] > .rt-main > .rt-pane,
:is(.dshp-dock,.dshp-root) :is(
  .dshp-clean-card,.dshp-clean-overview .dshp-metrics,.dshp-group,
  .dshp-studio-chapter > .dshp-panel,.dshp-rulelist,.dshp-skilllist,
  .dshp-studio-main .dshp-panel
) {
  background:var(--ui-material-card);
  border:1px solid var(--ui-glass-edge);
  border-radius:var(--ui-radius-panel);
  box-shadow:var(--ui-glass-shadow);
  backdrop-filter:var(--ui-glass-blur);
  -webkit-backdrop-filter:var(--ui-glass-blur);
}
/* Joined summary metrics share one glass slab with quiet inner dividers. */
:is(.rt-dock.rt-studio,.rt-full.rt-studio) .rt-page-content[data-page] :is(.rt-ledger-stat,.rt-settings-summary-card,.rt-skills-stat,.rt-sessions-stat),
.dshp-studio-root .dshp-clean-overview .dshp-metric {
  background:transparent;
  box-shadow:none;
  border-color:var(--ui-glass-edge);
  border-radius:0;
}
:is(.rt-dock.rt-studio,.rt-full.rt-studio) .rt-page-content[data-page] :is(.rt-ledger-stats,.rt-settings-summary,.rt-skills-summary,.rt-skills-overview,.rt-sessions-summary) {overflow:hidden;}

/* Controls use the same glaze in all modules. Semantic primary, danger and
 * selection fills remain owned by the components; this adds only material. */
:is(.dshp-dock,.dshp-root,.rt-dock.rt-studio,.rt-full.rt-studio) :is(
  button,.rt-btn,.rt-icon-btn,.rt-hbtn,.rt-session-map-button,.dshp-btn,
  .rt-input,.rt-textarea,.rt-settings-control,.rt-skills-search,.dshp-field,.rt-eng-select,select
) {
  box-shadow:var(--ui-glass-control-shadow);
  border-color:var(--ui-glass-edge);
}
:is(.dshp-dock,.dshp-root,.rt-dock.rt-studio,.rt-full.rt-studio) :is(button,input,textarea,select):focus-visible {
  outline:2px solid var(--ui-link);
  outline-offset:3px;
}
:is(.dshp-dock,.dshp-root,.rt-dock.rt-studio,.rt-full.rt-studio) button:not(:disabled):where(:not(.dshp-btn-primary,.dshp-btn-danger,.dshp-btn-solid-danger,.rt-btn-primary,.rt-btn-danger)):hover {
  border-color:var(--ui-line-strong);
}
:is(.dshp-dock,.dshp-root,.rt-dock.rt-studio,.rt-full.rt-studio) :is(
  .rt-input,.rt-textarea,.rt-settings-control,.rt-skills-search,.rt-eng-select,.dshp-field,.dshp-area,.dshp-editor,textarea,select
) {
  /* Source forms have inline/high-specificity fills; all native fields still
   * use this one reading material. Background images retain their carets. */
  background-color:var(--ui-material-reading) !important;
  color:var(--ui-text);
}
/* Native option popups must be opaque; an alpha colour becomes unreadable on
 * Windows where the popup has no relationship to the product backdrop. */
:is(.dshp-dock,.dshp-root,.rt-dock.rt-studio,.rt-full.rt-studio) select option {
  background:var(--ui-surface) !important;
  color:var(--ui-text) !important;
}

/* Reading surfaces keep a dense tint. No per-row blur and no filters on text. */
:is(.rt-dock.rt-studio,.rt-full.rt-studio) .rt-page-content[data-page] :is(
  .rt-skills-content,.rt-skills-diagnostics-content,
  .rt-md,.rt-evi-body,.rt-hit-evi,.rt-atest-notes,.rt-clip-body,.rt-kb-body,
  .rt-code,.rt-md-code,.rt-r2-code,.rt-r2-pre,.rt-rep-http
) {
  background:var(--ui-glass-dense);
}
:is(.rt-dock.rt-studio,.rt-full.rt-studio) .rt-page-content[data-page] :is(.rt-row,.rt-vrow,.rt-score-row,.rt-r2-table) {
  background:transparent;
}
:is(.rt-dock.rt-studio,.rt-full.rt-studio) .rt-page-content[data-page] :is(.rt-row.head,.rt-vrow.head,.rt-score-row.head,.rt-ledger-table-head) {
  background:var(--ui-glass-chrome);
}
:is(.rt-dock.rt-studio,.rt-full.rt-studio) .rt-page-content[data-page] :is(.rt-row,.rt-vrow,.rt-score-row):hover {
  background:var(--ui-hover);
}
:is(.rt-dock.rt-studio,.rt-full.rt-studio) .rt-page-content[data-page] :is(.rt-row.sel,.rt-vrow.sel,.rt-row.selected,.rt-row.is-selected) {
  background:var(--ui-selected);
}
:is(.rt-dock.rt-studio,.rt-full.rt-studio) .rt-page-content[data-page] :is(.rt-toolbar,.rt-livebar,.rt-subtabs,.rt-r2-toolbar,.rt-settings-toolbar,.rt-sessions-toolbar,.rt-collab-toolbar,.rt-session-map-toolbar,.rt-skills-detail-toolbar,.rt-concl,.rt-session-map-header,.rt-session-map-summary,.rt-session-map-metadata,.rt-rep-tools,.rt-evi-head,.rt-rep-req-head,.rt-ap-head,.rt-ap-goal,.rt-rep-stage,.rt-sec,.rt-score-group) {
  background:var(--ui-glass-chrome);
  border-color:var(--ui-glass-edge);
}
/* The canvas owns an opaque water layer so the pale card wash cannot bleach it. */
:is(.rt-dock.rt-studio,.rt-full.rt-studio) .rt-page-content[data-page] .rt-session-map-graph-pane {
  background-color:var(--ui-water-base);
  background-image:var(--ui-water-texture),linear-gradient(135deg,var(--ui-water-base),var(--ui-water-deep));
  background-size:1400px 1000px,auto;
  background-position:center top,center;
}
:is(.rt-dock.rt-studio,.rt-full.rt-studio) .rt-page-content[data-page] .rt-session-map-graph {background:transparent;}
:is(.rt-dock.rt-studio,.rt-full.rt-studio) .rt-session-map {background:var(--ui-material-card);border:1px solid var(--ui-glass-edge);border-radius:var(--ui-radius-panel);box-shadow:var(--ui-glass-shadow);backdrop-filter:var(--ui-glass-blur);-webkit-backdrop-filter:var(--ui-glass-blur);}
:is(.rt-dock.rt-studio,.rt-full.rt-studio) .rt-session-map.rt-session-map-expanded {background:var(--ui-glass-dense);}

/* The main score has a refracted light band, brighter only at its rim. */
:is(.rt-dock.rt-studio,.rt-full.rt-studio) .rt-ov-score-feature {
  background:
    radial-gradient(ellipse at 0% 0%,rgb(157 222 255 / .19),transparent 68%),
    linear-gradient(120deg,rgb(48 103 159 / .5),rgb(21 58 91 / .88)),
    var(--ui-feature-surface);
  border-color:rgb(176 223 255 / .4);
  box-shadow:var(--ui-glass-shadow),inset 0 0 28px rgb(135 210 255 / .08);
  backdrop-filter:var(--ui-glass-blur);
  -webkit-backdrop-filter:var(--ui-glass-blur);
}
:is(.rt-dock.rt-studio,.rt-full.rt-studio) .rt-ov-score-feature::before {
  background:linear-gradient(180deg,transparent,var(--ui-feature-accent) 25%,rgb(226 248 255 / .95) 50%,var(--ui-feature-accent) 75%,transparent);
  box-shadow:0 0 16px rgb(127 208 255 / .25);
}

/* Floating sheets use the same frost but stronger opacity than the canvas. */
:is(.dshp-modal-bg,.dshp-auth-mask,.dshp-restart-mask) {
  background:rgb(5 16 28 / .42);
  backdrop-filter:var(--ui-glass-mask-blur);
  -webkit-backdrop-filter:var(--ui-glass-mask-blur);
}
:is(.dshp-dock,.dshp-root,.dshp-modal-bg,.dshp-auth-mask,.dshp-restart-mask,.rt-dock.rt-studio,.rt-full.rt-studio) :is(
  .dshp-modal,.dshp-auth-modal,.dshp-restart-card,.rt-modal-box,.rt-shot-zoom
) {
  background:var(--ui-glass-wash),var(--ui-glass-dense);
  border:1px solid var(--ui-glass-edge);
  border-radius:var(--ui-radius-panel);
  box-shadow:var(--ui-glass-shadow);
  backdrop-filter:var(--ui-glass-blur);
  -webkit-backdrop-filter:var(--ui-glass-blur);
}

/* Graceful accessibility fallbacks: no animation or full-canvas displacement
 * is required for this skin. Unsupported blur keeps the same legible layout. */
@supports not ((backdrop-filter:blur(1px)) or (-webkit-backdrop-filter:blur(1px))) {
  :is(.dshp-dock,.dshp-root,.rt-dock,.rt-full) {--ui-glass-surface:var(--ui-surface);--ui-glass-chrome:var(--ui-nav);--ui-glass-dense:var(--ui-surface);}
}
@media (prefers-reduced-transparency:reduce) {
  :is(.dshp-dock,.dshp-root,.dshp-auth-mask,.dshp-modal-bg,.dshp-restart-mask,.rt-dock,.rt-full) {--ui-glass-surface:var(--ui-surface);--ui-glass-chrome:var(--ui-nav);--ui-glass-dense:var(--ui-surface);--ui-glass-blur:none;--ui-glass-mask-blur:none;--ui-water-texture:none;--ui-glass-wash:none;}
}
@media (forced-colors:active) {
  :is(.dshp-dock,.dshp-root,.dshp-auth-mask,.dshp-modal-bg,.dshp-restart-mask,.rt-dock,.rt-full) {--ui-glass-shadow:none;--ui-glass-control-shadow:none;--ui-water-texture:none;--ui-glass-wash:none;--ui-glass-blur:none;--ui-glass-mask-blur:none;}
}

/* Blur creates a containing block for fixed descendants. Drop only ancestor
 * frost while a local fullscreen map or confirmation sheet is open. */
:is(.dshp-dock,.dshp-root,.rt-dock.rt-studio,.rt-full.rt-studio) :has(.rt-session-map-expanded,.dshp-modal-bg,.rt-modal,.rt-shot-zoom) {
  backdrop-filter:none !important;
  -webkit-backdrop-filter:none !important;
}
/* Semantic borders must survive the material's neutral edge treatment. */
:is(.dshp-dock,.dshp-root,.rt-dock.rt-studio,.rt-full.rt-studio) :is(.dshp-btn-danger,.dshp-btn-solid-danger,.rt-btn-danger) {border-color:var(--ui-danger);}
:is(.dshp-dock,.dshp-root,.rt-dock.rt-studio,.rt-full.rt-studio) :is(.dshp-btn-primary,.rt-btn-primary) {border-color:var(--ui-primary);}

/* These compounds outrank the older page-specific layout skins. */
:is(.rt-dock.rt-studio,.rt-full.rt-studio) .rt-page-content[data-page] :is(
  .rt-main > .rt-toolbar,
  .rt-session-map .rt-session-map-head,.rt-session-map .rt-session-map-note,
  .rt-session-map .rt-session-map-toolbar,.rt-session-map .rt-session-map-foot
) {background:var(--ui-glass-chrome);border-color:var(--ui-glass-edge);}
:is(.rt-dock.rt-studio,.rt-full.rt-studio) .rt-session-map :is(.rt-session-map-layout,.rt-session-map-stats) {background:transparent;}
:is(.rt-dock.rt-studio,.rt-full.rt-studio) .rt-session-map .rt-session-map-stat {background:var(--ui-glass-chrome);border-color:var(--ui-glass-edge);}
:is(.rt-dock.rt-studio,.rt-full.rt-studio) .rt-session-map-toolbar .rt-input {background:var(--ui-glass-dense);}

:is(.rt-dock.rt-studio,.rt-full.rt-studio) .rt-page-content[data-page] :is(.rt-sec-body,.rt-sessions-group-content) {background:transparent;}
:is(.rt-dock.rt-studio,.rt-full.rt-studio) .rt-page-content[data-page] .rt-cred {background:var(--ui-glass-dense);}
/* This clean wrapper is structural; frost only the actual cards inside it. */
.dshp-studio-root .dshp-studio-purgify {backdrop-filter:none;-webkit-backdrop-filter:none;box-shadow:none;}

:is(.rt-dock.rt-studio,.rt-full.rt-studio) .rt-shot-zoom-cap {color:var(--ui-text);line-height:var(--ui-leading-body);}

/* Detail content belongs to the enclosing card, just like Overview content.
 * Only code, raw evidence and editable fields receive the denser reading tint. */
:is(.rt-dock.rt-studio,.rt-full.rt-studio) .rt-page-content[data-page] :is(
  .rt-ledger-detail-body,.rt-ledger-detail-head,.rt-skills-detail-scroll,
  .rt-artifacts-content,.rt-session-map-layout,.rt-skills-list
) {background:transparent;}
.dshp-studio-root .dshp-studio-nav-item:not([aria-selected=true]) {background:transparent;}

/* Tables, filters and action rows align to the same content lane as Overview.
 * Individual pages keep their own grid columns and scroll containers. */
:is(.rt-dock.rt-studio,.rt-full.rt-studio) .rt-page-content[data-page] > .rt-main > .rt-table {
  min-height:0;
  margin:0 var(--rt-page-x) var(--rt-page-y);
}
:is(.rt-dock.rt-studio,.rt-full.rt-studio) .rt-page-content[data-page] > .rt-main > .rt-toolbar {
  padding:0 var(--rt-page-x) 14px;
  background:transparent;
  border-bottom:0;
}
:is(.rt-dock.rt-studio,.rt-full.rt-studio) .rt-page-content[data-page] > .rt-main > :is(.rt-concl,.rt-subtabs) {
  margin:0 var(--rt-page-x) 12px;
  padding:8px 12px;
  background:var(--ui-material-inset);
  border:1px solid var(--ui-glass-edge);
  border-radius:var(--ui-radius-control);
}
:is(.rt-dock.rt-studio,.rt-full.rt-studio) .rt-page-content[data-page=knowledge] :is(.rt-kb-filter,.rt-kb-cats) {
  background:transparent;
  padding:8px var(--rt-page-x) 12px;
}
:is(.rt-dock.rt-studio,.rt-full.rt-studio) .rt-kb-cats:empty {display:none;}

/* Connections keep their visual weight when the camera zooms out. */
:is(.rt-dock.rt-studio,.rt-full.rt-studio) .rt-session-map-edge {
  stroke:color-mix(in srgb,var(--ui-link) 75%,var(--ui-muted));
  stroke-width:2.25;
  stroke-linecap:round;
  stroke-linejoin:round;
  opacity:.9;
  vector-effect:non-scaling-stroke;
}
:is(.rt-dock.rt-studio,.rt-full.rt-studio) .rt-session-map-edge.orphan {
  stroke:var(--ui-warning);
}

/* Graph nodes and local metadata use the same surface palette as the cards. */
:is(.rt-dock.rt-studio,.rt-full.rt-studio) .rt-session-map-node rect {
  fill:var(--ui-glass-surface);
  stroke:color-mix(in srgb,var(--ui-muted) 60%,var(--ui-line-strong));
  stroke-width:1.25;
  vector-effect:non-scaling-stroke;
}
:is(.rt-dock.rt-studio,.rt-full.rt-studio) .rt-session-map-node.orphan rect {
  stroke:var(--ui-warning);
}
:is(.rt-dock.rt-studio,.rt-full.rt-studio) .rt-session-map-node:hover rect {
  stroke:var(--ui-link);
  stroke-width:1.75;
}
:is(.rt-dock.rt-studio,.rt-full.rt-studio) .rt-session-map-node.selected rect {
  fill:var(--ui-selected);
  stroke:var(--ui-link);
  stroke-width:2;
}
:is(.rt-dock.rt-studio,.rt-full.rt-studio) .rt-session-map-node:focus-visible rect {
  stroke:var(--ui-link);
  stroke-width:2.5;
}
:is(.rt-dock.rt-studio,.rt-full.rt-studio) .rt-page-content .rt-foot {
  background:transparent;
  color:var(--ui-muted);
  border-color:var(--ui-glass-edge);
}

/* Nested records are insets inside a glass card, not another elevated panel.
 * This keeps dense record pages as quiet as Overview's score list. */
:is(.rt-dock.rt-studio,.rt-full.rt-studio) .rt-page-content[data-page] :is(
  .rt-sessions-group .rt-sess,.rt-artifacts-content .rt-cred,
  .rt-artifacts-content .rt-file,.rt-artifacts-content .rt-access,
  .rt-score-detail .rt-hit-row,.rt-r2-section .rt-r2-item,
  .rt-r2-section .rt-r2-group,.rt-rep-group .rt-rep-step
) {
  background:var(--ui-material-inset);
  border:1px solid var(--ui-glass-edge);
  border-radius:var(--ui-radius-control);
  box-shadow:none;
  backdrop-filter:none;
  -webkit-backdrop-filter:none;
}

:is(.rt-dock.rt-studio,.rt-full.rt-studio) .rt-page-content[data-page=scores] > .rt-main > .rt-pane {
  margin:0 var(--rt-page-x) 16px;
  padding:16px;
  border-bottom-color:var(--ui-glass-edge) !important;
}

/* Compact filters and native field variants share one inset/control material. */
:is(.rt-dock.rt-studio,.rt-full.rt-studio) .rt-page-content[data-page] :is(
  .rt-ledger-advanced,.rt-settings-localnav,.rt-settings-pagehead-context,
  .rt-skills-filters,.rt-skills-catalog-head
) {background:var(--ui-material-inset);border-color:var(--ui-glass-edge);border-radius:var(--ui-radius-control);}
:is(.rt-dock.rt-studio,.rt-full.rt-studio) .rt-page-content[data-page] .rt-concl-i:not(.on) {background:var(--ui-material-inset);}
:is(.rt-dock.rt-studio,.rt-full.rt-studio) .rt-session-map-toolbar :is(.rt-input,.rt-session-map-button) {background:var(--ui-material-reading);}
:is(.rt-dock.rt-studio,.rt-full.rt-studio) .rt-page-content[data-page] .rt-skills-card[aria-pressed=true] {background:var(--ui-selected);border-color:var(--ui-link);box-shadow:none;}
:is(.rt-dock.rt-studio,.rt-full.rt-studio) .rt-page-content[data-page] .rt-skills-card:not([aria-pressed=true]):hover {background:var(--ui-hover);border-color:var(--ui-line-strong);}

/* A map is the card; its layout section is only a transparent frame. */
:is(.rt-dock.rt-studio,.rt-full.rt-studio) .rt-collab-page .rt-collab-scope {background:transparent;border:0;box-shadow:none;backdrop-filter:none;-webkit-backdrop-filter:none;}
:is(.rt-dock.rt-studio,.rt-full.rt-studio) .rt-page-content[data-page] .rt-session-map-detail {background:var(--ui-material-reading);}
:is(.rt-dock.rt-studio,.rt-full.rt-studio) .rt-page-content[data-page] :is(.rt-empty,.rt-r2-empty,.rt-skills-empty,.rt-skills-no-results,.rt-skills-status,.rt-skills-loading,.rt-settings-diagnostic-empty,.rt-settings-loading,.rt-sessions-loading,.rt-session-map-empty-info,.rt-ap-none,.rt-rep-no) {
  background:var(--ui-material-inset);
  color:var(--ui-muted);
  border-color:var(--ui-glass-edge);
  border-radius:var(--ui-radius-control);
  font-size:var(--ui-text-helper);
  line-height:var(--ui-leading-body);
}
:is(.rt-dock.rt-studio,.rt-full.rt-studio) :is(.rt-session-map-empty,.rt-ledger-detail-empty) {color:var(--ui-muted);font-size:var(--ui-text-body);}
:is(.rt-dock.rt-studio,.rt-full.rt-studio) .rt-page-content[data-page] :is(.rt-ap-none,.rt-rep-no) {padding:12px;}
:is(.rt-dock.rt-studio,.rt-full.rt-studio) .rt-collab-prompts > .rt-split {background:transparent;border-color:var(--ui-glass-edge);border-radius:var(--ui-radius-control);}
:is(.rt-dock.rt-studio,.rt-full.rt-studio) .rt-collab-prompts > .rt-split > .rt-list {background:var(--ui-material-inset);border-color:var(--ui-glass-edge);}

/* Mouse focus and keyboard focus both keep an explicit field accent. */
:is(.dshp-dock,.dshp-root) :is(.dshp-field,.dshp-area,.dshp-editor,select,textarea):focus,
:is(.rt-dock.rt-studio,.rt-full.rt-studio) .rt-page-content[data-page] :is(.rt-input,.rt-textarea,.rt-settings-control,select,textarea):focus {
  border-color:var(--ui-link);
  box-shadow:var(--ui-glass-control-shadow),0 0 0 1px var(--ui-link);
}
:is(.rt-dock.rt-studio,.rt-full.rt-studio) .rt-session-map.rt-session-map-expanded {
  background-color:var(--ui-water-base);
  background-image:var(--ui-water-backdrop);
  background-size:auto,auto,1400px 1000px,auto,auto;
  background-position:center,center,center top,center,center;
}
/* Embedded clean lists are quiet insets within the enclosing glass panel. */
.dshp-studio-root .dshp-studio-main :is(.dshp-rulelist,.dshp-skilllist) {
  background:var(--ui-material-inset);
  border-radius:var(--ui-radius-control);
  box-shadow:none;
  backdrop-filter:none;
  -webkit-backdrop-filter:none;
}

/* Report sections use the same heading/content inset as Overview panels. */
:is(.rt-dock.rt-studio,.rt-full.rt-studio) .rt-r2-section {padding:20px;margin-bottom:16px;}
:is(.rt-dock.rt-studio,.rt-full.rt-studio) .rt-r2-section > .rt-r2-h3 {margin:0 0 16px;}

/* Running is host metadata, not inferred traffic or a task handoff. */
:is(.rt-dock.rt-studio,.rt-full.rt-studio) .rt-session-map-flow {
  fill:none;
  stroke:var(--ui-success);
  stroke-linecap:round;
  stroke-dasharray:.01 99.99;
  vector-effect:non-scaling-stroke;
  pointer-events:none;
  animation:dsh-session-map-flow 2.8s linear infinite;
}
:is(.rt-dock.rt-studio,.rt-full.rt-studio) .rt-session-map-flow-halo{stroke-width:14;opacity:.26}
:is(.rt-dock.rt-studio,.rt-full.rt-studio) .rt-session-map-flow-point{stroke-width:6;opacity:1}
:is(.rt-dock.rt-studio,.rt-full.rt-studio) .rt-session-map-live-ring {
  fill:none;
  stroke:var(--ui-success);
  stroke-width:1.5;
  pointer-events:none;
  animation:dsh-session-map-live 2.8s ease-in-out infinite;
}
@keyframes dsh-session-map-flow{from{stroke-dashoffset:0}to{stroke-dashoffset:-100}}
@keyframes dsh-session-map-live{0%,100%{opacity:.25}50%{opacity:.9}}
@media(prefers-reduced-motion:reduce){
  :is(.rt-dock.rt-studio,.rt-full.rt-studio) .rt-session-map-flow{animation:none;stroke-dashoffset:-50}
  :is(.rt-dock.rt-studio,.rt-full.rt-studio) .rt-session-map-live-ring{animation:none;opacity:.65}
}

:is(.rt-dock.rt-studio,.rt-full.rt-studio) .rt-session-map .rt-session-map-node{cursor:grab;touch-action:none}
:is(.rt-dock.rt-studio,.rt-full.rt-studio) .rt-session-map-graph-pane[data-dragging=true] .rt-session-map-node{cursor:grabbing}

/* Keep an opaque, viewport-sized backing store under asynchronous scroll
 * tiles. Never promote the entire long document with transform/will-change:
 * that also changes the containing block of the map and confirmation sheets. */
.dshp-dock.dshp-studio-dock,
.dshp-root.dshp-studio-root,
.rt-full.rt-studio {
  isolation:isolate;
}
.dshp-dock.dshp-studio-dock > .dshp-dock-body,
:is(.rt-dock.rt-studio,.rt-full.rt-studio) > .rt-body {
  background:var(--ui-water-backdrop) !important;
  background-color:var(--ui-water-base) !important;
  background-size:auto,auto,1400px 1000px,auto,auto;
  background-position:center,center,center top,center,center;
  background-attachment:scroll;
}

/* Tall reading panels keep the tint, glint and rim without allocating a live
 * blur layer as tall as their content. Bounded chrome and floating sheets
 * retain the original frost; no scrolling or fixed-position semantics change. */
:is(.rt-dock.rt-studio,.rt-full.rt-studio) .rt-page-content[data-page] :is(
  .rt-settings-card,.rt-ledger-list-pane,.rt-ledger-detail,.rt-ledger-table,
  .rt-table,.rt-r2-section,.rt-r2-group,.rt-rep,.rt-rep-group,
  .rt-sessions-group,.rt-artifacts-section,.rt-skills-catalog,.rt-skills-detail,
  .rt-collab-section,.rt-kb
),
.dshp-studio-root .dshp-studio-main :is(.dshp-clean-card,.dshp-panel) {
  background:var(--ui-glass-wash),var(--ui-glass-dense);
  backdrop-filter:none;
  -webkit-backdrop-filter:none;
}

/* Fullscreen scroll tiles must not sample another viewport-sized live blur
 * or dozens of nested card filters. Keep the water, tint, glint and borders;
 * only bounded chrome and dialog overlays retain live backdrop sampling. */
:is(
  .dshp-dock.dshp-studio-dock[data-fullscreen=true],
  .dshp-dock.dshp-studio-dock:fullscreen,
  .rt-full.rt-studio,
  .rt-dock.rt-studio[data-fullscreen=true]
) {
  backdrop-filter:none !important;
  -webkit-backdrop-filter:none !important;
}
:is(
  .dshp-dock.dshp-studio-dock[data-fullscreen=true],
  .dshp-dock.dshp-studio-dock:fullscreen,
  .rt-full.rt-studio,
  .rt-dock.rt-studio[data-fullscreen=true]
) :is(.rt-page-content[data-page],.dshp-studio-main),
:is(
  .dshp-dock.dshp-studio-dock[data-fullscreen=true],
  .dshp-dock.dshp-studio-dock:fullscreen,
  .rt-full.rt-studio,
  .rt-dock.rt-studio[data-fullscreen=true]
) :is(.rt-page-content[data-page],.dshp-studio-main) :where(*):not(:where(
  .rt-modal,.rt-modal *,.rt-modal-box,.rt-modal-box *,
  .rt-shot-zoom,.rt-shot-zoom *,
  .dshp-modal-bg,.dshp-modal-bg *,
  .dshp-auth-mask,.dshp-auth-mask *,
  .dshp-restart-mask,.dshp-restart-mask *,
  [role=dialog],[role=dialog] *
)) {
  backdrop-filter:none !important;
  -webkit-backdrop-filter:none !important;
}


/* Detail surfaces are the last presentation layer for dense, expanded data.
 * The source components keep their data and interaction semantics; this file
 * only gives them the same material hierarchy as the surrounding workbench. */

:is(.rt-dock.rt-studio, .rt-full.rt-studio) .rt-artifacts-section {
  border: 1px solid var(--ui-glass-edge);
  border-radius: var(--ui-radius-panel);
  background: var(--ui-material-card);
  box-shadow: var(--ui-glass-shadow);
  overflow: hidden;
}

:is(.rt-dock.rt-studio, .rt-full.rt-studio) .rt-artifacts-summary {
  display: block;
  padding: var(--ui-space-3) var(--ui-space-4);
  border-radius: var(--ui-radius-panel);
  color: var(--ui-text);
  cursor: pointer;
  font-size: var(--ui-text-control);
  font-weight: 600;
  line-height: var(--ui-leading-body);
}

:is(.rt-dock.rt-studio, .rt-full.rt-studio) .rt-artifacts-section[open] > .rt-artifacts-summary {
  border-radius: var(--ui-radius-panel) var(--ui-radius-panel) 0 0;
  background: var(--ui-material-inset);
}

:is(.rt-dock.rt-studio, .rt-full.rt-studio) .rt-artifacts-summary::before {
  content: '›';
  display: inline-block;
  margin-right: var(--ui-space-2);
  color: var(--ui-muted);
  transform: rotate(0deg);
}
:is(.rt-dock.rt-studio, .rt-full.rt-studio) .rt-artifacts-section[open] > .rt-artifacts-summary::before {
  transform: rotate(90deg);
}

:is(.rt-dock.rt-studio, .rt-full.rt-studio) .rt-artifacts-summary:hover {
  background: var(--ui-hover);
}

:is(.rt-dock.rt-studio, .rt-full.rt-studio) .rt-artifacts-summary:focus-visible {
  outline: 2px solid var(--ui-link);
  outline-offset: -3px;
}

:is(.rt-dock.rt-studio, .rt-full.rt-studio) .rt-artifacts-content {
  border-top: 1px solid var(--ui-glass-edge);
  background: var(--ui-material-inset);
}

:is(.rt-dock.rt-studio, .rt-full.rt-studio) .rt-artifacts-content > :is(.rt-credential-list, .rt-access-list) {
  display: grid;
  gap: var(--ui-space-3);
  background: transparent;
  padding: var(--ui-space-3) var(--ui-space-4);
}

:is(.rt-dock.rt-studio, .rt-full.rt-studio) :is(
  .rt-credential-card,
  .rt-access-card,
  .rt-file-row,
  .rt-file-detail-row
) {
  min-width: 0;
  border: 1px solid var(--ui-glass-edge);
  border-radius: var(--ui-radius-control);
  background: var(--ui-material-inset);
  box-shadow: none;
  color: var(--ui-text);
}

:is(.rt-dock.rt-studio, .rt-full.rt-studio) .rt-credential-card {
  display: block;
  margin: 0;
  padding: var(--ui-space-3);
}

:is(.rt-dock.rt-studio, .rt-full.rt-studio) .rt-credential-header {
  min-width: 0;
  gap: var(--ui-space-2);
}

:is(.rt-dock.rt-studio, .rt-full.rt-studio) .rt-credential-host {
  min-width: 0;
  color: var(--ui-text);
}

:is(.rt-dock.rt-studio, .rt-full.rt-studio) .rt-credential-copy {
  margin-left: auto;
}

:is(.rt-dock.rt-studio, .rt-full.rt-studio) .rt-credential-secret {
  min-width: 0;
  margin-top: var(--ui-space-2);
  padding: var(--ui-space-2) var(--ui-space-3);
  border: 1px solid var(--ui-glass-edge);
  border-radius: var(--ui-radius-control);
  background: var(--ui-material-reading);
  color: var(--ui-text);
  overflow-wrap: anywhere;
}

:is(.rt-dock.rt-studio, .rt-full.rt-studio) .rt-credential-secret .rt-secret {
  display: inline-flex;
  max-width: 100%;
  margin: 0;
  padding: 0;
  border: 0;
  border-radius: 0;
  background: transparent !important;
  color: var(--ui-text);
}

:is(.rt-dock.rt-studio, .rt-full.rt-studio) .rt-credential-secret .rt-secret-none {
  display: block;
  margin: 0;
  padding: 0;
  border: 0;
  border-radius: 0;
  color: var(--ui-muted);
}

:is(.rt-dock.rt-studio, .rt-full.rt-studio) .rt-credential-meta {
  margin-top: var(--ui-space-2);
  color: var(--ui-muted);
  overflow-wrap: anywhere;
}

:is(.rt-dock.rt-studio, .rt-full.rt-studio) .rt-credential-note {
  padding-top: var(--ui-space-2);
  border-top: 1px solid var(--ui-glass-edge);
}

:is(.rt-dock.rt-studio, .rt-full.rt-studio) .rt-access-card {
  display: grid;
  grid-template-columns: minmax(0, 1.2fr) minmax(100px, .8fr) auto minmax(84px, .7fr) minmax(0, 1.3fr);
  gap: var(--ui-space-2);
  padding: var(--ui-space-3);
  cursor: default;
}

:is(.rt-dock.rt-studio, .rt-full.rt-studio) .rt-access-card:hover {
  background: var(--ui-hover);
}

:is(.rt-dock.rt-studio, .rt-full.rt-studio) :is(.rt-access-host, .rt-access-user, .rt-access-method, .rt-access-privilege, .rt-access-session) {
  min-width: 0;
  overflow-wrap: anywhere;
}

:is(.rt-dock.rt-studio, .rt-full.rt-studio) .rt-file-artifacts {
  min-width: 0;
  color: var(--ui-text);
}

:is(.rt-dock.rt-studio, .rt-full.rt-studio) .rt-file-artifacts .rt-sec-body {
  display: grid;
  gap: var(--ui-space-2);
}

:is(.rt-dock.rt-studio, .rt-full.rt-studio) .rt-file-row {
  grid-template-columns: 18px minmax(0, 1.2fr) 60px minmax(0, 1.6fr);
  gap: var(--ui-space-2);
  padding: var(--ui-space-2) var(--ui-space-3);
  cursor: pointer;
}

:is(.rt-dock.rt-studio, .rt-full.rt-studio) .rt-file-row:hover {
  background: var(--ui-hover);
}

:is(.rt-dock.rt-studio, .rt-full.rt-studio) .rt-file-row :is(.rt-file-name, .rt-file-description) {
  min-width: 0;
  overflow-wrap: anywhere;
}

:is(.rt-dock.rt-studio, .rt-full.rt-studio) .rt-file-description {
  color: var(--ui-muted);
  font-size: var(--ui-text-helper);
}

:is(.rt-dock.rt-studio, .rt-full.rt-studio) .rt-file-detail-row {
  grid-template-columns: minmax(0, 1fr);
  padding: var(--ui-space-2) var(--ui-space-3);
  cursor: default;
}

:is(.rt-dock.rt-studio, .rt-full.rt-studio) .rt-file-detail {
  min-width: 0;
  padding: 0;
  color: var(--ui-muted);
}

:is(.rt-dock.rt-studio, .rt-full.rt-studio) .rt-file-detail-field {
  min-width: 0;
  margin-bottom: var(--ui-space-2);
}

:is(.rt-dock.rt-studio, .rt-full.rt-studio) .rt-file-detail-field > b {
  color: var(--ui-text);
}

:is(.rt-dock.rt-studio, .rt-full.rt-studio) .rt-file-path {
  overflow-wrap: anywhere;
}

:is(.rt-dock.rt-studio, .rt-full.rt-studio) .rt-file-content {
  max-height: 40vh;
  margin: var(--ui-space-2) 0 0;
  padding: var(--ui-space-3);
  border: 1px solid var(--ui-glass-edge) !important;
  border-radius: var(--ui-radius-control) !important;
  background: var(--ui-material-reading) !important;
  color: var(--ui-text);
}

:is(.rt-dock.rt-studio, .rt-full.rt-studio) .rt-concurrency-warning {
  display: grid;
  gap: var(--ui-space-2);
  margin-top: var(--ui-space-3);
  padding: var(--ui-space-4);
  border: 1px solid color-mix(in srgb, var(--ui-warning) 35%, var(--ui-glass-edge));
  border-radius: var(--ui-radius-panel);
  background: linear-gradient(color-mix(in srgb, var(--ui-warning) 10%, transparent), color-mix(in srgb, var(--ui-warning) 5%, transparent)), var(--ui-material-card);
  color: var(--ui-text);
  box-shadow: inset 0 1px 0 var(--ui-glass-rim);
}

:is(.rt-dock.rt-studio, .rt-full.rt-studio) .rt-concurrency-summary {
  margin-bottom: var(--ui-space-2);
  color: var(--ui-text);
  font-size: var(--ui-text-helper);
  line-height: var(--ui-leading-body);
}

:is(.rt-dock.rt-studio, .rt-full.rt-studio) .rt-concurrency-warning-head {
  display: flex;
  align-items: center;
  gap: var(--ui-space-2);
  color: var(--ui-warning);
  line-height: var(--ui-leading-title);
}

:is(.rt-dock.rt-studio, .rt-full.rt-studio) .rt-concurrency-warning-icon {
  display: inline-grid;
  place-items: center;
  width: 20px;
  height: 20px;
  border: 1px solid var(--ui-warning);
  border-radius: 50%;
  color: var(--ui-warning);
  font-size: var(--ui-text-label);
  font-weight: 600;
}

:is(.rt-dock.rt-studio, .rt-full.rt-studio) .rt-concurrency-warning p {
  margin: 0;
  color: var(--ui-text);
  font-size: var(--ui-text-helper);
  line-height: var(--ui-leading-body);
}

:is(.rt-dock.rt-studio, .rt-full.rt-studio) .rt-concurrency-warning p strong {
  color: var(--ui-warning);
  font-weight: 600;
}

@container rt (max-width: 720px) {
  :is(.rt-dock.rt-studio, .rt-full.rt-studio) .rt-access-card {
    grid-template-columns: minmax(0, 1fr) minmax(0, 1fr);
  }

  :is(.rt-dock.rt-studio, .rt-full.rt-studio) .rt-file-row {
    grid-template-columns: 18px minmax(0, 1fr) auto;
  }

  :is(.rt-dock.rt-studio, .rt-full.rt-studio) .rt-file-description {
    grid-column: 2 / -1;
  }
}

@media (prefers-reduced-transparency: reduce) {
  :is(.rt-dock.rt-studio, .rt-full.rt-studio) .rt-concurrency-warning {
    background: var(--ui-warning-bg);
    box-shadow: none;
  }
}

/* Expanded headers and evidence use the same inset and reading layers. */
:is(.rt-dock.rt-studio,.rt-full.rt-studio) .rt-page-content[data-page] :is(
  .rt-rep-stage,.rt-ap-head,.rt-ap-goal,.rt-evi-head,.rt-sessions-group .rt-sec
) {
  background: var(--ui-material-inset);
  color: var(--ui-text);
  border-color: var(--ui-glass-edge);
  border-radius: var(--ui-radius-control);
  box-shadow: none;
}
:is(.rt-dock.rt-studio,.rt-full.rt-studio) .rt-page-content[data-page] :is(.rt-rep-stage,.rt-sessions-group .rt-sec):hover {
  background: var(--ui-hover);
}
:is(.rt-dock.rt-studio,.rt-full.rt-studio) .rt-page-content[data-page] .rt-evi-body {
  background: var(--ui-material-reading);
  color: var(--ui-text);
  border-color: var(--ui-glass-edge);
  border-radius: var(--ui-radius-control);
  box-shadow: none;
}
:is(.rt-dock.rt-studio,.rt-full.rt-studio) .rt-page-content[data-page] .rt-session-map-empty {
  background: var(--ui-material-inset);
  color: var(--ui-muted);
  border-radius: var(--ui-radius-control);
}
:is(.rt-dock.rt-studio,.rt-full.rt-studio) .rt-page-content[data-page] .rt-session-map-alert {
  margin: 8px 12px;
  padding: 12px;
  border: 1px solid color-mix(in srgb, var(--ui-warning) 35%, var(--ui-glass-edge));
  border-radius: var(--ui-radius-control);
  background: linear-gradient(color-mix(in srgb, var(--ui-warning) 10%, transparent), color-mix(in srgb, var(--ui-warning) 5%, transparent)), var(--ui-material-inset);
  color: var(--ui-text);
}
:is(.rt-dock.rt-studio,.rt-full.rt-studio) .rt-page-content[data-page] .rt-sessions-group .rt-sec{border-left-color:var(--ui-link)}
:is(.rt-dock.rt-studio,.rt-full.rt-studio) .rt-page-content[data-page] .rt-sessions-group .rt-sec.t-queue{border-left-color:var(--ui-warning)}
:is(.rt-dock.rt-studio,.rt-full.rt-studio) .rt-page-content[data-page] .rt-sessions-group .rt-sec.t-test{border-left-color:var(--ui-success)}


/* Workspace layout: one navigation rail, one context row, then page content.
 * Compact mode is measured from the actual plugin width, including full views. */
:is(.dshp-dock,.dshp-root,.rt-dock,.rt-full){--ui-sidebar-width:176px}
:is(.rt-dock.rt-studio,.rt-full.rt-studio)[data-nav-layout=sidebar]{
  display:grid!important;
  grid-template-columns:var(--ui-sidebar-width) minmax(0,1fr)!important;
  grid-template-rows:auto auto minmax(320px,1fr) auto!important;
  grid-template-areas:"nav cmd" "nav sub" "nav body" "nav foot"!important;
}
:is(.rt-dock.rt-studio,.rt-full.rt-studio)[data-nav-layout]>.rt-chrome>.rt-nav{
  display:flex!important;
  flex-direction:column!important;
  align-items:stretch;
  align-content:stretch;
  justify-content:flex-start;
  flex-wrap:nowrap;
  gap:0;
  min-width:0;
  min-height:0;
  width:auto;
  padding:20px 12px;
  overflow:auto;
  border:0;
  background:var(--ui-glass-wash),var(--ui-glass-chrome)!important;
  box-shadow:inset -1px 0 0 var(--ui-glass-edge);
}
:is(.rt-dock.rt-studio,.rt-full.rt-studio)[data-nav-layout=sidebar]>.rt-chrome>.rt-nav{grid-area:nav!important;grid-column:1!important;grid-row:1/-1!important}
:is(.rt-dock.rt-studio,.rt-full.rt-studio)[data-nav-layout=sidebar]>.rt-chrome>.rt-cmd{grid-area:cmd!important;grid-column:2!important;grid-row:1!important}
:is(.rt-dock.rt-studio,.rt-full.rt-studio)[data-nav-layout=sidebar]>.rt-subnav{grid-area:sub!important;grid-column:2!important;grid-row:2!important}
:is(.rt-dock.rt-studio,.rt-full.rt-studio)[data-nav-layout=sidebar]>.rt-body{grid-area:body!important;grid-column:2!important;grid-row:3!important}
:is(.rt-dock.rt-studio,.rt-full.rt-studio)[data-nav-layout=sidebar]>.rt-foot{grid-area:foot!important;grid-column:2!important;grid-row:4!important}
:is(.rt-dock.rt-studio,.rt-full.rt-studio)[data-nav-layout] .rt-nav>.rt-title{display:none}
:is(.rt-dock.rt-studio,.rt-full.rt-studio)[data-nav-layout] .rt-nav .rt-workspace-brand{min-width:0;margin:0 0 24px;padding:0 8px;gap:8px}
:is(.rt-dock.rt-studio,.rt-full.rt-studio)[data-nav-layout] .rt-nav-groups{
  display:flex!important;
  flex-direction:column!important;
  flex:0 0 auto;
  align-items:stretch;
  gap:6px;
  min-width:0;
  width:100%;
  padding:0;
  margin:0;
  border:0;
  background:transparent;
}
:is(.rt-dock.rt-studio,.rt-full.rt-studio)[data-nav-layout] :is(.rt-nav-caption,.rt-nav-section-break){
  display:block;
  color:var(--ui-muted);
  font-size:var(--ui-text-helper);
  font-weight:500;
  line-height:var(--ui-leading-body);
  padding:0 12px;
  margin:0 0 10px;
}
:is(.rt-dock.rt-studio,.rt-full.rt-studio)[data-nav-layout] .rt-nav-section-break{margin:18px 0 6px;padding-top:18px;border-top:1px solid var(--ui-glass-edge)}
:is(.rt-dock.rt-studio,.rt-full.rt-studio)[data-nav-layout] .rt-nav .rt-tab-group{
  position:relative;
  display:flex;
  flex:0 0 auto;
  align-items:center;
  justify-content:flex-start;
  width:100%;
  min-height:42px;
  gap:10px;
  padding:10px 12px;
  border:1px solid transparent;
  border-radius:var(--ui-radius-control);
  background:transparent;
  box-shadow:none;
  color:var(--ui-muted);
}
:is(.rt-dock.rt-studio,.rt-full.rt-studio)[data-nav-layout] .rt-nav .rt-tab-group:hover{background:var(--ui-glass-surface);border-color:var(--ui-glass-edge);color:var(--ui-text)}
:is(.rt-dock.rt-studio,.rt-full.rt-studio)[data-nav-layout] .rt-nav .rt-tab-group.on{background:var(--ui-selected);border-color:var(--ui-glass-edge);box-shadow:var(--ui-glass-control-shadow);color:var(--ui-selected-text)}
:is(.rt-dock.rt-studio,.rt-full.rt-studio)[data-nav-layout] .rt-nav .rt-tab-group.on::after{display:block;content:"";position:absolute;left:0;right:auto;top:10px;bottom:10px;width:3px;height:auto;border-radius:0 3px 3px 0;background:var(--ui-link)}
:is(.rt-dock.rt-studio,.rt-full.rt-studio)[data-nav-layout] .rt-nav .rt-nav-label{overflow:visible;text-overflow:clip;white-space:nowrap}
:is(.rt-dock.rt-studio,.rt-full.rt-studio)[data-nav-layout]>.rt-chrome>.rt-cmd{min-height:58px;padding:10px 24px}
:is(.rt-dock.rt-studio,.rt-full.rt-studio)[data-nav-layout]>.rt-subnav{padding:8px 24px;gap:6px;background:transparent!important;border-bottom:0}
:is(.rt-dock.rt-studio,.rt-full.rt-studio)[data-nav-layout]>.rt-subnav .rt-tab{background:var(--ui-glass-chrome);border-color:var(--ui-glass-edge);box-shadow:var(--ui-glass-control-shadow)}
:is(.rt-dock.rt-studio,.rt-full.rt-studio)[data-nav-layout]>.rt-subnav .rt-tab.on{background:var(--ui-selected);color:var(--ui-selected-text)}

/* Query surfaces are real cards; internal rows never paint square backplates. */
:is(.rt-dock.rt-studio,.rt-full.rt-studio) .rt-ledger-query-card{
  flex:0 0 auto;
  min-width:0;
  padding:16px;
  margin:0 0 16px;
  background:var(--ui-material-card);
  border:1px solid var(--ui-glass-edge);
  border-radius:var(--ui-radius-panel);
  box-shadow:var(--ui-glass-shadow);
  backdrop-filter:var(--ui-glass-blur);
  -webkit-backdrop-filter:var(--ui-glass-blur);
}
:is(.rt-dock.rt-studio,.rt-full.rt-studio) .rt-ledger-query-card :is(.rt-ledger-toolbar,.rt-toolbar-row,.rt-ledger-conclusion){background:transparent!important;box-shadow:none;border:0;border-radius:0}
:is(.rt-dock.rt-studio,.rt-full.rt-studio) .rt-ledger-query-card .rt-ledger-toolbar{padding:0;gap:12px}
:is(.rt-dock.rt-studio,.rt-full.rt-studio) .rt-ledger-query-card .rt-ledger-primary-tools{display:flex;flex-wrap:wrap;gap:8px}
:is(.rt-dock.rt-studio,.rt-full.rt-studio) .rt-ledger-query-card .rt-ledger-filter-view-row{padding-top:12px;align-items:center}
:is(.rt-dock.rt-studio,.rt-full.rt-studio) .rt-ledger-query-card .rt-ledger-conclusion{padding:12px 0 0;margin:12px 0 0;border-top:1px solid var(--ui-glass-edge);gap:8px}
:is(.rt-dock.rt-studio,.rt-full.rt-studio) .rt-ledger-query-card .rt-ledger-advanced{flex:0 1 auto;max-width:100%;border-radius:var(--ui-radius-control);background:var(--ui-material-inset)}
:is(.rt-dock.rt-studio,.rt-full.rt-studio) .rt-ledger-query-card .rt-ledger-advanced[open]{flex:1 1 100%}
:is(.rt-dock.rt-studio,.rt-full.rt-studio) .rt-ledger-query-card .rt-ledger-view-tools{margin-left:auto}
:is(.rt-dock.rt-studio,.rt-full.rt-studio) .rt-ledger-main{overflow:auto}
:is(.rt-dock.rt-studio,.rt-full.rt-studio) .rt-ledger-main>.rt-ledger-list-detail{flex:1 0 260px;min-height:260px}
:is(.rt-dock.rt-studio,.rt-full.rt-studio) .rt-ledger-query-card .rt-concl-i{border-radius:var(--ui-radius-control)!important}

/* The compact shell is based on component width rather than browser width. */
:is(.rt-dock.rt-studio,.rt-full.rt-studio)[data-nav-layout=compact]{
  grid-template-columns:minmax(0,1fr)!important;
  grid-template-rows:auto auto auto minmax(320px,1fr) auto!important;
  grid-template-areas:"nav" "cmd" "sub" "body" "foot"!important;
}
:is(.rt-dock.rt-studio,.rt-full.rt-studio)[data-nav-layout=compact]>.rt-chrome>.rt-nav{grid-area:nav!important;grid-column:1!important;grid-row:1!important;padding:10px 12px;overflow:visible;box-shadow:inset 0 -1px 0 var(--ui-glass-edge)}
:is(.rt-dock.rt-studio,.rt-full.rt-studio)[data-nav-layout=compact]>.rt-chrome>.rt-cmd{grid-area:cmd!important;grid-column:1!important;grid-row:2!important;padding:10px 16px}
:is(.rt-dock.rt-studio,.rt-full.rt-studio)[data-nav-layout=compact]>.rt-subnav{grid-area:sub!important;grid-column:1!important;grid-row:3!important;padding:8px 16px}
:is(.rt-dock.rt-studio,.rt-full.rt-studio)[data-nav-layout=compact]>.rt-body{grid-area:body!important;grid-column:1!important;grid-row:4!important}
:is(.rt-dock.rt-studio,.rt-full.rt-studio)[data-nav-layout=compact]>.rt-foot{grid-area:foot!important;grid-column:1!important;grid-row:5!important}
:is(.rt-dock.rt-studio,.rt-full.rt-studio)[data-nav-layout=compact] :is(.rt-nav-caption,.rt-nav-section-break,.rt-workspace-brand){display:none!important}
:is(.rt-dock.rt-studio,.rt-full.rt-studio)[data-nav-layout=compact] .rt-nav-groups{display:grid!important;grid-template-columns:repeat(3,minmax(0,1fr));gap:6px}
:is(.rt-dock.rt-studio,.rt-full.rt-studio)[data-nav-layout=compact] .rt-nav .rt-tab-group{min-height:38px;justify-content:center;gap:6px;padding:8px}
:is(.rt-dock.rt-studio,.rt-full.rt-studio)[data-nav-layout=compact] .rt-nav-symbol{width:14px;height:14px}
:is(.rt-dock.rt-studio,.rt-full.rt-studio)[data-nav-layout=compact] .rt-nav .rt-tab-group.on::after{left:10px;right:10px;top:auto;bottom:0;width:auto;height:2px;border-radius:2px}
.dshp-studio-root .dshp-studio-layout{grid-template-columns:var(--ui-sidebar-width) minmax(0,1fr)}
@container settings (max-width:760px){.dshp-studio-root .dshp-studio-layout{grid-template-columns:minmax(0,1fr)}}

:is(.rt-dock.rt-studio,.rt-full.rt-studio)[data-nav-layout] .rt-nav .rt-workspace-brand{order:0}
:is(.rt-dock.rt-studio,.rt-full.rt-studio)[data-nav-layout] .rt-nav>.rt-nav-caption{order:1}
:is(.rt-dock.rt-studio,.rt-full.rt-studio)[data-nav-layout] .rt-nav>.rt-nav-groups{order:2}
@container rt (max-width:540px){
  :is(.rt-dock.rt-studio,.rt-full.rt-studio) .rt-ledger-stats{grid-template-columns:repeat(2,minmax(0,1fr));}
  :is(.rt-dock.rt-studio,.rt-full.rt-studio) .rt-ledger-stat{padding:12px;min-width:0;}
  :is(.rt-dock.rt-studio,.rt-full.rt-studio) .rt-ledger-stat-label{white-space:normal;overflow:visible;text-overflow:clip;}
}
/* Clean workspace and drill pages share the same navigation states. */
.dshp-studio-root .dshp-studio-nav .dshp-studio-nav-item{
  position:relative;
  padding:10px 12px;
  background:transparent!important;
  border:1px solid transparent;
  border-radius:var(--ui-radius-control);
  box-shadow:none;
  color:var(--ui-muted);
}
.dshp-studio-root .dshp-studio-nav .dshp-studio-nav-item:hover:not(:disabled){background:var(--ui-glass-surface)!important;border-color:var(--ui-glass-edge);color:var(--ui-text)}
.dshp-studio-root .dshp-studio-nav .dshp-studio-nav-item[aria-selected=true]{background:var(--ui-selected)!important;border-color:var(--ui-glass-edge);box-shadow:var(--ui-glass-control-shadow);color:var(--ui-selected-text)}
.dshp-studio-root .dshp-studio-nav .dshp-studio-nav-item[aria-selected=true]::before{content:"";position:absolute;left:0;top:10px;bottom:10px;width:3px;border-radius:0 3px 3px 0;background:var(--ui-link)}
/* At narrow widths the page owns vertical scrolling; detail panes remain bounded. */
@container rt (max-width:950px){
  :is(.rt-dock.rt-studio,.rt-full.rt-studio) .rt-ledger-main{overflow:visible}
}
@container workspace (max-width:950px){
  :is(.rt-dock.rt-studio,.rt-full.rt-studio) .rt-ledger-main{overflow:visible}
}
/* Sticky labels must mask rows passing underneath them. */
:is(.rt-dock.rt-studio,.rt-full.rt-studio) .rt-page-content[data-page] .rt-ledger-list-pane>.rt-ledger-table-head{
  background:var(--ui-glass-wash),var(--ui-surface);
  backdrop-filter:var(--ui-glass-blur);
  -webkit-backdrop-filter:var(--ui-glass-blur);
}

/* __DSH_PRODUCT_SKIN_END__ */
`    /* ---------------------------------------------------------- bridge and state */
    /** Whether we are in the standalone fullscreen-browse window (URL hash flag, same UI code reused). */
    const isFullWindow = () => {
      try { return String(window.location.hash || '') === '#redteam-full' } catch { return false }
    }

    const FULL_REQUEST_EVENT = 'rt-open-full'
    const requestFullInPlace = () => {
      try { window.dispatchEvent(new Event(FULL_REQUEST_EVENT)) } catch { /* old browser */ }
    }
    const openFullView = () => { requestFullInPlace() }

    /**
     * Tolerant JSON read: when the server occasionally returns an empty body (405/404, route not mounted,
     * connection dropped), a bare res.json() throws `Unexpected end of JSON input`, and every caller is
     * `.then(r => ...)`, so one empty response reddens the workbench. Normalized to `{ ok:false, error }`
     * so callers keep using their existing `ok === false` branch to show the localized reason.
     */
    const readApiJson = (res) => res.text().then((text) => {
      if (!text) {
        return { ok: false, error: 'Máy chủ trả về phản hồi rỗng (HTTP ' + res.status + '), hãy thoát hoàn toàn dsh rồi mở lại' }
      }
      try {
        const value = JSON.parse(text)
        if (value && typeof value === 'object') return value
        return { ok: false, error: 'Định dạng nội dung máy chủ trả về không đúng (HTTP ' + res.status + ')' }
      } catch {
        return { ok: false, error: 'Máy chủ trả về không phải JSON (HTTP ' + res.status + '), có thể route chưa được tải' }
      }
    }).catch((error) => ({
      ok: false,
      error: 'Gọi API bảng diễn tập thất bại: ' + (error && error.message ? error.message : String(error)),
    }))

    const api = (req) => fetch('/redteam/api', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(req),
    }).then(readApiJson)

    const LAST_ENG_KEY = 'rt-last-engagement'
    const lastEngagement = () => {
      try { return window.localStorage.getItem(LAST_ENG_KEY) || null } catch (e) { return null }
    }
    const rememberEngagement = (id) => {
      try { if (id) window.localStorage.setItem(LAST_ENG_KEY, id) } catch (e) { /* privacy mode */ }
    }
    const FOLLOW_SOURCE = {
      bound: 'Liên kết đã lưu', title: 'Tiêu đề phiên', last: 'Lựa chọn trước', default: 'Đơn vị mặc định',
    }
    const squashName = (value) => String(value || '')
      .replace(/~([0-9a-fA-F]{4})/g, (m, hex) => String.fromCharCode(parseInt(hex, 16)))
      .replace(/[^0-9a-zA-Z\u4e00-\u9fff]+/g, '')
      .toLowerCase()
    const engagementByTitle = (title, list) => {
      const hay = squashName(title)
      if (hay.length < 3) return null
      const hits = (list || [])
        .map((x) => ({ x: x, key: squashName(x.name || x.id) }))
        .filter((row) => row.key.length >= 3 && (hay.includes(row.key) || row.key.includes(hay)))
        .sort((a, b) => b.key.length - a.key.length)
      return hits.length ? hits[0].x.id : null
    }

    let ui = { open: true, tab: 'overview' }
    const subs = new Set()
    const setUI = (patch) => {
      ui = Object.assign({}, ui, patch)
      const snap = Object.assign({}, ui)
      for (const f of Array.from(subs)) {
        try { f(snap) } catch { /* ignore subscriber errors */ }
      }
    }
    /* Kept exported. Panel size is written on its own elements; the official frame width is left alone. */
    let dockWidthTag = null
    const setDockWidth = () => {}
    const useUI = () => {
      const [st, setSt] = React.useState(() => Object.assign({}, ui))
      React.useEffect(() => {
        const f = (snap) => setSt(Object.assign({}, snap || ui))
        subs.add(f)
        setSt(Object.assign({}, ui))
        return () => { subs.delete(f) }
      }, [])
      return st
    }

    /* Knowledge-base categories (same as core.js POC_CATEGORIES; the panel groups by them) */
    const POC_CAT_NAME = {
      rce: 'Thực thi lệnh từ xa', deserialization: 'Deserialization', 'file-upload': 'Tải tệp lên getshell',
      sqli: 'SQL injection', unauthorized: 'Truy cập trái phép', 'auth-bypass': 'Bỏ qua xác thực / vượt quyền',
      'weak-password': 'Mật khẩu yếu / dò mật khẩu', ssrf: 'SSRF', xxe: 'XXE',
      'path-traversal': 'Duyệt thư mục / đọc tệp tùy ý', 'info-leak': 'Lộ thông tin',
      privesc: 'Leo thang đặc quyền / di chuyển ngang', tunnel: 'Đường hầm / proxy', other: 'Khác',
    }
    const POC_CAT_ORDER = Object.keys(POC_CAT_NAME)
    /* Role code → display name (report and knowledge base both mark who found it) */
    const ROLE_LABEL = {
      plan: 'Phiên chính (chỉ huy)', recon: 'Thu thập thông tin', assess: 'Rà soát tài sản',
      'vuln-scan': 'Phát hiện lỗ hổng', exploit: 'Khai thác lỗ hổng', internal: 'Xâm nhập mạng nội bộ',
    }

    const fmt = (s) => (s ? String(s).replace('T', ' ').slice(0, 16) : '—')
    const shotCache = new Map()
    const shotLoading = new Map()
    const shotSrc = (eng, id) => shotCache.get(eng + ':' + id) || null
    const loadShot = (eng, id) => {
      const key = eng + ':' + id
      if (shotCache.has(key) || shotLoading.has(key)) return
      const p = api({ op: 'shotData', engagement: eng, id: id }).then((r) => {
        shotCache.set(key, r && r.base64 ? 'data:' + (r.mime || 'image/png') + ';base64,' + r.base64 : '')
        shotLoading.delete(key)
        const snap = Object.assign({}, ui)
        for (const f of Array.from(subs)) {
          try { f(snap) } catch { /* ignore subscriber errors */ }
        }
      }).catch(() => { shotLoading.delete(key) })
      shotLoading.set(key, p)
    }
    const SHOT_KIND = { screenshot: 'Ảnh chụp tại chỗ', card: 'Trích đoạn bằng chứng sinh từ bản ghi' }
    const ShotImage = ({ eng, shot, height }) => {
      const [zoom, setZoom] = React.useState(false)
      const src = shotSrc(eng, shot.id)
      if (src === null) { loadShot(eng, shot.id); }
      const card = shot.kind === 'card'
      return h('div', { className: 'rt-shot' },
        src === null
          ? h('div', { className: 'rt-shot-thumb rt-shot-loading', style: { height: (height || 96) + 'px' } }, 'Đang tải…')
          : h('img', {
              className: 'rt-shot-thumb', src: src, alt: shot.label || ('Bằng chứng ' + shot.id),
              style: { height: (height || 96) + 'px', cursor: 'zoom-in' },
              onClick: () => setZoom(true),
            }),
        h('div', { className: 'rt-shot-cap' },
          h('span', { className: 'rt-tag ' + (card ? 'rt-tag-warn' : 'rt-tag-live'), title: card
            ? 'Trích đoạn bằng chứng sinh từ bản ghi trong ngày, không phải ảnh chụp tại chỗ — báo cáo cũng sẽ ghi chú như vậy'
            : 'Ảnh chụp tại chỗ' }, SHOT_KIND[shot.kind] || shot.kind || 'Bằng chứng'),
          h('span', { className: 'rt-shot-label', title: shot.label || shot.note || '' },
            shot.label || shot.target || ('#' + shot.id))),
        zoom
          ? h('div', { className: 'rt-shot-zoom', onClick: () => setZoom(false) },
              h('img', { src: src, alt: shot.label || '' }),
              h('div', { className: 'rt-shot-zoom-cap' }, (shot.label || shot.target || '')
                + (card ? ' · Sinh từ bản ghi trong ngày (không phải ảnh chụp tại chỗ)' : '')
                + (shot.captured_at ? ' · ' + fmt(shot.captured_at) : '')
                + ' · Bấm bất kỳ đâu để đóng'))
          : null)
    }
    const ShotStrip = ({ eng, shots, total, title }) => {
      const list = shots || []
      if (list.length === 0) return null
      return h('div', { className: 'rt-shots' },
        h('div', { className: 'rt-shots-head' },
          h('b', null, title || 'Ảnh chụp bằng chứng'),
          h('span', { className: 'rt-shots-n' }, 'Hiển thị ' + list.length + ' ảnh'
            + (total && total > list.length ? '(mục tính điểm này có ' + total + ' ảnh, lấy ảnh đại diện)' : ''))),
        h('div', { className: 'rt-shot-row' }, list.map((sh) => h(ShotImage, { key: 'sh' + sh.id, eng: eng, shot: sh }))))
    }
    /** List shows only month-day hour:minute for discovery time; full time goes into the tooltip */
    const fmtShort = (s) => {
      const t = String(s || '').replace('T', ' ')
      return t.length >= 16 ? t.slice(5, 16) : (t || '—')
    }
    const provLabel = (p) => (p === 'passive' ? 'Bị động' : p === 'active' ? 'Chủ động' : 'Không rõ')

    /**
     * Add keyboard reachability to a clickable non-<button> element; returns props to spread directly.
     *
     * Why: the panel uses div/span as buttons (table rows, tabs, conclusion bars, C-block items…);
     * they click but are keyboard-unreachable —— and 16 of them each did it their own way,
     * inconsistently (some only had a role, some missed the Space key).
     * With one factory, a new clickable only needs `...clickable(fn, { label })` for full semantics.
     *
     * Note: **do not** wrap a real `<button>` with this (native buttons carry all semantics).
     * @param onActivate - activation callback (mouse click / Enter / Space all route here).
     * @param options - `{ label?, expanded? }`: label goes to aria-label, expanded to aria-expanded.
     * @returns props fragment: role / tabIndex / onClick / onKeyDown / aria-*
     */
    const clickable = (onActivate, options = {}) => {
      const props = {
        role: 'button',
        tabIndex: 0,
        onClick: onActivate,
        onKeyDown: (e) => {
          /* Enter and Space are the standard activation keys; Space must also stop the page scrolling */
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault()
            onActivate(e)
          }
        },
      }
      if (options.label !== undefined) props['aria-label'] = String(options.label)
      if (options.expanded !== undefined) props['aria-expanded'] = options.expanded ? 'true' : 'false'
      return props
    }

    /**
     * Copy text to the clipboard, **returning the real success value**.
     *
     * The clipboard API returns a rejected Promise in a non-secure context (http + non-localhost), when the
     * page loses focus, or permission is denied —— try/catch cannot see it, so the UI says
     * "copied" while the clipboard is empty. Here we await the real result and fall back to
     * execCommand('copy') when unavailable (still works in old browsers / non-secure contexts).
     * @param text - text to copy.
     @returns Promise<boolean>
     * */
    const copyText = async (text) => {
      const value = text === undefined || text === null ? '' : String(text)
      if (value === '') return false
      try {
        if (navigator.clipboard && typeof navigator.clipboard.writeText === 'function') {
          await navigator.clipboard.writeText(value)
          return true
        }
      } catch (e) { /* falls through to the fallback below */ }
      /* Fallback: temporary textarea + execCommand —— the only option left in a non-secure context */
      try {
        const ta = document.createElement('textarea')
        ta.value = value
        ta.setAttribute('readonly', '')
        ta.style.position = 'fixed'
        ta.style.left = '-9999px'
        document.body.appendChild(ta)
        ta.select()
        const okFlag = document.execCommand('copy')
        document.body.removeChild(ta)
        return okFlag === true
      } catch (e) { return false }
    }

    /**
     * Copy and give **honest** UI feedback (one wording for success and failure).
     * @param text - text to copy.
     * @param label - name shown in the success message.
     * @param onResult - optional callback: `(ok, message) => void`; omitted → returns Promise<boolean>.
     */
    const copyWithFeedback = async (text, label, onResult) => {
      const okFlag = await copyText(text)
      const message = okFlag ? 'Đã sao chép: ' + label : 'Sao chép thất bại (trình duyệt không cấp quyền clipboard) — hãy chọn văn bản và sao chép thủ công'
      if (typeof onResult === 'function') onResult(okFlag, message)
      return okFlag
    }

    function ProvTag(props) {
      if (!props.p) return h('span', { className: 'rt-tag' }, 'Không rõ')
      return h('span', { className: 'rt-tag rt-tag-' + props.p }, provLabel(props.p))
    }

    const TEST_LABEL = { untested: 'Chưa kiểm thử', testing: 'Đang kiểm thử', tested: 'Đã kiểm thử', blocked: 'Bị chặn', abandoned: 'Đã bỏ', no_surface: 'Không có bề mặt tấn công' }
    const PRI_LABEL = { high: 'Cao', medium: 'Trung bình', low: 'Thấp' }

    /** Asset exploitability badge. */
    function PriTag(props) {
      if (!props.p) return h('span', { className: 'rt-tag' }, 'Chưa đánh giá')
      return h('span', { className: 'rt-pri rt-pri-' + props.p, title: props.title || '' }, PRI_LABEL[props.p] || props.p)
    }

    /** Asset test-status badge. */
    function TestTag(props) {
      const st = props.s || 'untested'
      return h('span', { className: 'rt-test rt-test-' + st }, TEST_LABEL[st] || st)
    }

    /* ---------------------------------------------------------- overview */
    /**
     * First page an operator opens: where we got, what to hit next, what entries we hold, what is stuck.
     * Aggregation only; it replaces no asset/result/report page, and numbers come from existing APIs.
     */
    function OverviewTab(props) {
      const eng = props.engagement
      const snapshot = props.snapshot
      const refreshKey = props.refreshKey || 0
      const onGo = props.onGo || (() => {})
      const [chain, setChain] = React.useState(null)
      const [scores, setScores] = React.useState(null)
      const [sessions, setSessions] = React.useState(null)
      const [agents, setAgents] = React.useState(null)
      const [attention, setAttention] = React.useState(null)
      const [err, setErr] = React.useState(null)
      const [loading, setLoading] = React.useState(false)
      const [scoreView, setScoreView] = React.useState('current')

      const load = () => {
        if (!eng) return
        setLoading(true); setErr(null)
        Promise.all([
          api({ op: 'scoreChain', engagement: eng }),
          api({ op: 'scores', engagement: eng }),
          api({ op: 'sessions', engagement: eng }),
          api({ op: 'agentsStatus' }),
          api({ op: 'attention', engagement: eng }),
        ]).then(([c, sc, se, ag, at]) => {
          setLoading(false)
          if (!c || c.ok === false) { setErr((c && c.error) || 'Đọc tình hình thất bại'); return }
          setChain(c); setScores(sc && sc.ok !== false ? sc : null)
          setSessions(se && se.ok !== false ? se : null); setAgents(ag && ag.ok !== false ? ag : null)
          setAttention(at && at.ok !== false ? at : null)
        }, (e) => { setLoading(false); setErr(String((e && e.message) || e)) })
      }
      React.useEffect(load, [eng, refreshKey])
      /* The queue changes by itself (sub-agents report, humans resolve), so one read on open is not enough.
         A dedicated poll refreshes only attention, leaving the four heavy situational queries untouched. */
      React.useEffect(() => {
        if (!eng) return undefined
        let dead = false
        const timer = setInterval(() => {
          api({ op: 'attention', engagement: eng }).then((at) => {
            if (!dead && at && at.ok !== false) setAttention(at)
          }, () => { /* a single failure does not disturb the page */ })
        }, 8000)
        return () => { dead = true; clearInterval(timer) }
      }, [eng])

      const stats = (snapshot && snapshot.stats) || {}
      const tests = (snapshot && snapshot.tests) || {}
      const stages = (chain && chain.stages) || []
      const points = (chain && chain.summary && chain.summary.points) || 0
      const current = stages.slice().reverse().find((x) => (x.cumulative || 0) > 0 || (x.points || 0) > 0) || stages[0] || null
      const allTiers = scores
        ? ((scores.items && scores.items.length) ? scores.items : (scores.ruleGroups || []).reduce((a, g) => a.concat(g.tiers || []), []))
        : []
      const tierFull = (p) => p.cap > 0 && (Number(p.cap_used) || 0) >= Number(p.cap)
      const gaps = allTiers.filter((p) => !tierFull(p))
        .sort((a, b) => (Number(b.points) || 0) - (Number(a.points) || 0))
        .slice(0, 5)
      const achievedAll = allTiers.filter((p) => (Array.isArray(p.hits) && p.hits.length > 0)
        || (Number(p.earned) || 0) > 0 || (Number(p.counted) || 0) > 0)
        .sort((a, b) => (Number(b.earned) || Number(b.points) || 0) - (Number(a.earned) || Number(a.points) || 0))
      const achieved = achievedAll.slice(0, 5)
      const shells = (sessions && sessions.webshells) || []
      const tunnels = (sessions && sessions.tunnels) || []
      const onlineShells = shells.filter((x) => x.status === 'online')
      const activeTunnels = tunnels.filter((x) => x.status === 'active' && x.legit === true)
      const used = agents ? agents.used : null
      const max = agents ? agents.max : 3
      const metric = (label, value, sub, tone) => h('div', { className: 'rt-ov-metric' + (tone ? ' rt-ov-metric-' + tone : '') },
        h('div', { className: 'rt-ov-metric-value' }, value),
        h('div', { className: 'rt-ov-metric-label' }, label),
        sub ? h('div', { className: 'rt-ov-metric-sub' }, sub) : null)
      const gapRows = gaps.map((p, i) => {
        const capPct = p.cap > 0 ? Math.min(100, Math.round(((Number(p.cap_used) || 0) / Number(p.cap)) * 100)) : 0
        return h('div', Object.assign({
          key: 'gap' + p.id, className: 'rt-ov-gap',
          title: p.name,
        }, clickable(() => onGo('scores'), { label: 'Xem mục tiêu tính điểm: ' + p.name })),
          h('span', { className: 'rt-ov-rank' }, String(i + 1).padStart(2, '0')),
          h('div', { className: 'rt-ov-gap-main' },
            h('div', { className: 'rt-ov-gap-name' }, p.name),
            h('div', { className: 'rt-ov-gap-meta' },
              p.cap > 0
                ? h('span', null, 'Đã dùng quy tắc ' + (p.cap_used || 0) + ' / ' + p.cap + ' điểm')
                : h('span', { className: 'rt-tag' }, 'Một lần / theo mục tiêu')),
            p.cap > 0 ? h('div', { className: 'rt-ov-bar' }, h('div', { style: { width: capPct + '%', background: 'var(--dsw-alias-brand-primary)' } })) : null),
          h('span', { className: 'rt-ov-pts' }, '+' + (p.points || 0)))
      })

      const achievedRows = achieved.map((p, i) => {
        const earned = Number(p.earned) || Number(p.points) || 0
        const capPct = p.cap > 0 ? Math.min(100, Math.round(((Number(p.cap_used) || 0) / Number(p.cap)) * 100)) : 0
        return h('div', Object.assign({
          key: 'got' + p.id, className: 'rt-ov-gap', title: p.name,
        }, clickable(() => onGo('scores'), { label: 'Xem điểm đã đạt: ' + p.name })),
          h('span', { className: 'rt-ov-rank' }, String(i + 1).padStart(2, '0')),
          h('div', { className: 'rt-ov-gap-main' },
            h('div', { className: 'rt-ov-gap-name' }, p.name),
            h('div', { className: 'rt-ov-gap-meta' },
              h('span', null, 'Đã đạt ' + earned + ' điểm'
                + (p.cap > 0 ? ' · đã dùng quy tắc ' + (p.cap_used || 0) + ' / ' + p.cap : ''))),
            p.cap > 0 ? h('div', { className: 'rt-ov-bar' }, h('div', { style: { width: capPct + '%', background: 'var(--ui-success)' } })) : null),
          h('span', { className: 'rt-ov-pts rt-ov-pts-got' }, '+' + earned))
      })

      /* "What needs me right now": the prototype's first question. Emptied out, it takes no space ——
         health status must not eat the front page. */
      const attentionItems = (attention && attention.items) || []
      const attentionPeople = (attention && attention.awaiting_person) || 0
      const attentionGaps = (attention && attention.pending_coverage) || 0
      const STAGE_TEXT = {
        'person/answer': ['Chờ bạn trả lời', 'rt-ov-attn-ask'],
        'person/review': ['Chờ bạn nghiệm thu', 'rt-ov-attn-review'],
        'person/blocked': ['Bị kẹt', 'rt-ov-attn-bad'],
        'person/failed': ['Thất bại', 'rt-ov-attn-bad'],
        'working': ['Đang chạy', 'rt-ov-attn-run'],
      }
      const attentionBlock = (attentionPeople === 0 && attentionGaps === 0)
        ? null
        : h('section', {
          className: 'rt-ov-attn' + (attentionPeople > 0 ? ' rt-ov-attn-live' : ''),
          'aria-label': 'Việc cần bạn xử lý bây giờ',
        },
        h('div', { className: 'rt-ov-attn-head' },
          h('span', { className: 'rt-ov-attn-title' }, attentionPeople > 0 ? 'Cần bạn quyết định bây giờ' : 'Đã đến lúc giao việc cho tác nhân tiếp theo'),
          h('span', { className: 'rt-ov-attn-count' }, attentionPeople > 0 ? String(attentionPeople) : String(attentionGaps))),
        attentionItems.length
          ? h('div', { className: 'rt-ov-attn-list' }, attentionItems.map((it) => {
            const st = STAGE_TEXT[it.stage] || ['Đang chờ', 'rt-ov-attn-run']
            return h('div', { key: it.session_id, className: 'rt-ov-attn-row' },
              h('span', { className: 'rt-ov-attn-stage ' + st[1] }, st[0]),
              h('div', { className: 'rt-ov-attn-main' },
                h('div', { className: 'rt-ov-attn-who' }, it.label || it.role || it.session_id),
                it.reason ? h('div', { className: 'rt-ov-attn-reason' }, it.reason) : null,
                it.needs && it.needs.length
                  ? h('div', { className: 'rt-ov-attn-needs' }, it.needs.map((n, i) => h('span', { key: 'n' + i, className: 'rt-tag rt-tag-warn' }, (n.kind || 'Cần') + (n.detail ? ': ' + n.detail : ''))))
                  : null))
          }))
          : null,
        attentionItems.length === 0 && attentionGaps > 0
          ? h('div', { className: 'rt-ov-attn-empty' }, 'Không có tác nhân nào đang chờ người, nhưng còn ' + attentionGaps + ' khoảng trống độ phủ.')
          : null,
        h('div', { className: 'rt-ov-attn-foot' },
          attentionPeople > 0
            ? h('button', {
              className: 'rt-btn rt-btn-primary',
              /* Link-in: fold the queue into a paragraph in the session input. **Fill only, never send** ——
                 that text is the list of things a human must decide; sending it for them decides for them.
                 It uses a window hook, not a direct call: the workbench is a separate bundle and
                 must run when loaded alone (no shell), so it cannot hard-reference outer functions. */
              onClick: () => {
                try {
                  const go = window.__dshPurgeAttentionGo
                  if (typeof go === 'function') { go(); return }
                } catch { /* no hook on the outer side → fall back to navigation */ }
                onGo('agents')
              },
            }, 'Điền vào ô nhập của phiên chính')
            : null,
          h('button', { className: 'rt-btn', onClick: () => onGo('agents') }, 'Xem tác nhân'),
          h('button', { className: 'rt-btn', onClick: () => onGo('scores') }, 'Xem điểm kế tiếp')))

      return h('div', { className: 'rt-main rt-ov' },
        h('div', { className: 'rt-ov-head' },
          h('div', { className: 'rt-ov-heading' },
            h('div', { className: 'rt-ov-title-row' },
              h('span', { className: 'rt-ov-title', title: ((snapshot && snapshot.engagement && snapshot.engagement.name) || eng || '') + (eng ? ' · ' + eng : '') }, (snapshot && snapshot.engagement && snapshot.engagement.name) || eng || 'Chưa chọn mục tiêu'),
              current ? h('span', { className: 'rt-ov-stage-chip', style: { borderColor: current.color || 'var(--dsw-alias-border-l1)' } }, current.name) : null)),
          h('div', { className: 'rt-spacer' }),
          h('button', { className: 'rt-btn', disabled: loading, onClick: load }, loading ? 'Đang làm mới…' : 'Làm mới')),
        err ? h('div', { className: 'rt-err', style: { margin: '0 16px 8px' } }, err) : null,
        h('div', { className: 'rt-ov-scroll' },
          attentionBlock,
          h('section', { className: 'rt-ov-facts', 'aria-label': 'Tóm tắt tài sản và kết quả dự án' },
            [['Đối tượng tài sản', stats.assets, 'assets'], ['Tài sản còn sống', stats.liveAssets, 'assets'], ['Cổng mở', stats.openPorts, 'assets'], ['Bản ghi kết quả', stats.vulns, 'findings']].map(([label, value, tab]) => h('button', {
              key: label, type: 'button', className: 'rt-ov-fact', onClick: () => onGo(tab),
              'aria-label': 'Xem ' + label + ': ' + (value === null || value === undefined ? 'Chưa cung cấp' : String(value)),
            }, h('span', { className: 'rt-ov-fact-label' }, label),
              h('span', { className: 'rt-ov-fact-value' }, value === null || value === undefined ? '—' : String(value)),
              h('span', { className: 'rt-ov-fact-go', 'aria-hidden': 'true' }, '↗')))),
          h('section', { className: 'rt-ov-hero' },
            h('div', { className: 'rt-ov-score rt-ov-score-feature' },
              h('div', { className: 'rt-ov-score-label' }, 'Điểm tích lũy'),
              h('div', { className: 'rt-ov-score-num' }, String(points), h('small', null, 'điểm')),
              h('div', { className: 'rt-ov-score-sub' }, current ? 'Giai đoạn hiện tại · ' + current.name : 'Chưa có bản ghi điểm'),
              h('button', { className: 'rt-btn rt-btn-inverse', onClick: () => onGo('chain') }, 'Xem chuỗi tấn công →')),
            h('div', { className: 'rt-ov-rail' },
              h('div', { className: 'rt-ov-rail-head' }, h('span', null, 'Tiến độ năm giai đoạn'), h('span', { className: 'rt-ov-rail-caption' }, 'Hiển thị theo bản ghi điểm hiện có')),
              h('div', { className: 'rt-ov-stages' },
                stages.map((x, i) => h('div', {
                  key: 'st' + x.code,
                  className: 'rt-ov-stage' + (current && current.code === x.code ? ' on' : '') + ((x.points || 0) > 0 ? ' has' : ''),
                  style: { '--stage': x.color || 'var(--dsw-alias-brand-primary)' },
                  title: (x.goal || '') + ' · giai đoạn này ' + (x.points || 0) + ' điểm · tích lũy ' + (x.cumulative || 0) + ' điểm',
                },
                  h('div', { className: 'rt-ov-node' }, String(i + 1)),
                  h('div', { className: 'rt-ov-stage-name' }, x.name),
                  h('div', { className: 'rt-ov-stage-pts' }, (x.points || 0) + ' điểm'),
                  h('div', { className: 'rt-ov-stage-cum' }, 'Tích lũy ' + (x.cumulative || 0)),
                  h('div', {
                    className: 'rt-ov-stage-share', role: 'img',
                    'aria-label': 'Điểm giai đoạn này chiếm ' + (points > 0 ? Math.max(0, Math.min(100, Math.round((Number(x.points) || 0) / points * 100))) : 0) + '%',
                  }, h('i', { style: { width: (points > 0 ? Math.max(0, Math.min(100, (Number(x.points) || 0) / points * 100)) : 0) + '%' } }))))),
            )),
          h('div', { className: 'rt-ov-grid' },
            h('section', { className: 'rt-ov-card rt-ov-card-wide rt-ov-score-detail' },
              h('div', { className: 'rt-ov-card-head' },
                h('span', { className: 'rt-ov-card-title' }, 'Chi tiết điểm'),
                h('div', { className: 'rt-spacer' }),
                h('button', { className: 'rt-btn', onClick: () => onGo('scores') }, 'Tất cả mục tính điểm')),
              h('div', { className: 'rt-ov-score-tabs', role: 'tablist', 'aria-label': 'Dạng xem chi tiết điểm' },
                h('button', {
                  className: 'rt-ov-score-tab' + (scoreView === 'current' ? ' on' : ''),
                  type: 'button', role: 'tab', 'aria-selected': scoreView === 'current',
                  onClick: () => setScoreView('current'),
                },
                  h('span', { className: 'rt-ov-score-tab-label' }, 'Điểm hiện tại'),
                  h('span', { className: 'rt-ov-score-tab-value' }, points + ' điểm'),
                  h('span', { className: 'rt-ov-score-tab-sub' }, 'Đã đạt ' + achievedAll.length + ' mục')),
                h('button', {
                  className: 'rt-ov-score-tab' + (scoreView === 'next' ? ' on' : ''),
                  type: 'button', role: 'tab', 'aria-selected': scoreView === 'next',
                  onClick: () => setScoreView('next'),
                },
                  h('span', { className: 'rt-ov-score-tab-label' }, 'Điểm kế tiếp'),
                  h('span', { className: 'rt-ov-score-tab-value' }, 'Top ' + gaps.length),
                  h('span', { className: 'rt-ov-score-tab-sub' }, 'Khoảng trống điểm cao'))),
              scoreView === 'current'
                ? (achievedRows.length
                    ? h('div', { className: 'rt-ov-gaps' }, achievedRows)
                    : h('div', { className: 'rt-ov-empty' }, scores ? 'Chưa có mục nào đạt điểm; bấm "Điểm kế tiếp" để xem khoảng trống.' : 'Đang tải…'))
                : (gaps.length
                    ? h('div', { className: 'rt-ov-gaps' }, gapRows)
                    : h('div', { className: 'rt-ov-empty' }, scores ? 'Hiện không có khoảng trống điểm cao nào để bổ sung.' : 'Đang tải…'))),
            h('section', { className: 'rt-ov-card rt-ov-entry-card' },
              h('div', { className: 'rt-ov-card-head' },
                h('span', { className: 'rt-ov-card-title' }, 'Phiên và kênh'),
                h('div', { className: 'rt-spacer' }),
                h('button', { className: 'rt-btn', onClick: () => onGo('sessions') }, 'Đường hầm phiên')),
              h('div', { className: 'rt-ov-metric-row' },
                metric('WebShell', onlineShells.length + '/' + shells.length, 'Trực tuyến', onlineShells.length ? 'ok' : 'mute'),
                metric('Đường hầm', activeTunnels.length + '/' + tunnels.length, 'Sẵn dùng', activeTunnels.length ? 'ok' : 'mute')),
              h('div', { className: 'rt-ov-entry-list' },
                activeTunnels.length
                  ? activeTunnels.slice(0, 3).map((t) => {
                      const reach = String(t.reach || 'Chưa ghi vùng tiếp cận')
                      return h('div', { key: 't' + t.id, className: 'rt-ov-entry' },
                        h('span', { className: 'rt-ov-dot' }),
                        h('span', { className: 'rt-ov-entry-addr' }, t.listen || '—'),
                        h('span', { className: 'rt-ov-entry-kind' }, t.kind || 'tunnel'),
                        h('span', { className: 'rt-ov-entry-reach', title: reach }, reach))
                    })
                  : h('div', { className: 'rt-ov-empty' }, 'Chưa có đường hầm sẵn dùng'))),
            h('section', { className: 'rt-ov-card rt-ov-team-card' },
              h('div', { className: 'rt-ov-card-head' },
                h('span', { className: 'rt-ov-card-title' }, 'Cộng tác và chờ kiểm thử'),
                h('div', { className: 'rt-spacer' }),
                h('span', { className: 'rt-tag' }, 'Trạng thái hiện tại')),
              h('div', { className: 'rt-ov-metric-row' },
                metric('Tài sản chưa đánh giá', String(tests.untested || 0), 'máy', (tests.untested || 0) > 0 ? 'warn' : 'mute'),
                metric('Dịch vụ đã đạt tối đa', String((scores && scores.summary && scores.summary.serviceCappedHits) || 0), 'mục', 'mute'),
                metric('Tác nhân thực thi', used === null ? '—' : used + '/' + max, 'Đang chạy', used ? 'ok' : 'mute')),
              h('div', { className: 'rt-ov-actions' },
                h('button', { className: 'rt-btn', onClick: () => onGo('assets') }, 'Trinh sát tài sản'),
                h('button', { className: 'rt-btn', onClick: () => onGo('agents') }, 'Tác nhân')))))
      )
    }

    /* ---------------------------------------------------------- asset mapping */
    function AssetsTab(props) {
      const eng = props.engagement
      const snapshot = props.snapshot
      const refreshKey = props.refreshKey || 0
      const onRefresh = props.onRefresh
      const [view, setView] = React.useState('list')
      const [showSegments, setShowSegments] = React.useState(false)
      const [cidr, setCidr] = React.useState(null)
      const [q, setQ] = React.useState('')
      const [qApplied, setQApplied] = React.useState('')
      const [service, setService] = React.useState('')
      const [port, setPort] = React.useState('')
      const [prov, setProv] = React.useState('')
      const [testStatus, setTestStatus] = React.useState('')
      const [priority, setPriority] = React.useState('')
      const [scope, setScope] = React.useState('')
      const [assetState, setAssetState] = React.useState('')
      const [sort, setSort] = React.useState('priority')
      const [showAll, setShowAll] = React.useState(null)
      const [state, setState] = React.useState({ loading: false, error: null, total: 0, items: [] })
      const [domains, setDomains] = React.useState(null)
      const [web, setWeb] = React.useState(null)
      const [openId, setOpenId] = React.useState(null)
      const [detail, setDetail] = React.useState(null)
      /* The two groups (external / internal C-blocks) collapse independently, state kept per target */
      const sideCollapse = useCollapse('assets-side:' + eng)
      const seq = React.useRef(0)
      const detailSeq = React.useRef(0)
      const onData = props.onData

      React.useEffect(() => {
        if (!eng) return
        const my = ++seq.current
        setState((s) => Object.assign({}, s, { loading: true, error: null }))
        api({
          op: 'assets', engagement: eng, cidr: cidr || undefined, q: qApplied || undefined,
          service: service || undefined, port: port || undefined,
          provenance: prov || undefined, test_status: testStatus || undefined,
          priority: priority || undefined, scope: scope || undefined,
          state: assetState || undefined, sort: sort, limit: 400,
        }).then((r) => {
          if (my !== seq.current) return
          if (!r || r.ok === false) {
            setState({ loading: false, error: (r && r.error) || 'Truy vấn thất bại', total: 0, items: [] })
            return
          }
          setState({ loading: false, error: null, total: r.total, items: r.items || [] })
          /* This round may add C-blocks/stats: make the shell refetch a snapshot so the left list updates */
          if (onData) onData()
        }, (e) => {
          if (my === seq.current) setState({ loading: false, error: String((e && e.message) || e), total: 0, items: [] })
        })
      }, [eng, cidr, qApplied, service, port, prov, testStatus, priority, scope, assetState, sort, refreshKey])

      React.useEffect(() => {
        if (!eng || view !== 'domain') return
        setDomains(null)
        api({ op: 'domains', engagement: eng, cidr: cidr || undefined })
          .then((r) => setDomains((r && r.items) || []), () => setDomains([]))
      }, [eng, view, cidr, refreshKey])

      React.useEffect(() => {
        if (!eng || view !== 'web') return
        setWeb(null)
        api({ op: 'web', engagement: eng, cidr: cidr || undefined })
          .then((r) => setWeb((r && r.items) || []), () => setWeb([]))
      }, [eng, view, cidr, refreshKey])


      const closeDetail = () => {
        detailSeq.current += 1
        setOpenId(null)
        setDetail(null)
        setShowAll(null)
      }

      const toggleRow = (id) => {
        if (openId === id) { closeDetail(); return }
        const requestId = ++detailSeq.current
        setOpenId(id)
        setDetail(null)
        api({ op: 'asset', engagement: eng, id: id }).then((r) => {
          if (requestId !== detailSeq.current) return
          if (r && r.ok && r.asset) setDetail(r.asset)
        }, () => {})
      }

      const segs = (snapshot && snapshot.segments) || []

      const sideChildren = []
      sideChildren.push(h('div', Object.assign({
        key: 'all', className: 'rt-seg' + (cidr === null && view !== 'testing' ? ' on' : ''),
      }, clickable(() => { setView('list'); setCidr(null) }, { label: 'Tất cả dải C', expanded: cidr === null && view !== 'testing' })),
        h('div', { className: 'rt-seg-cidr' }, 'Tất cả dải C'),
        h('div', { className: 'rt-seg-meta' }, segs.length + ' dải mạng')))
      sideChildren.push(h('div', Object.assign({
        key: 'testing', className: 'rt-seg' + (view === 'testing' ? ' on' : ''),
        title: 'Quét / thăm dò đang chạy và tiến độ (tự làm mới 5 giây)',
      }, clickable(() => { setView('testing'); setCidr(null) }, { label: 'Đang kiểm thử', expanded: view === 'testing' })),
        h('div', { className: 'rt-seg-cidr', style: { display: 'flex', alignItems: 'baseline', gap: 5 } },
          h('span', { className: 'rt-scope rt-scope-testing', title: 'Đang kiểm thử (không phải nội bộ cũng không phải internet)' }, 'Đo'),
          h('span', { style: { flex: 1 } }, 'Đang kiểm thử')),
        h('div', { className: 'rt-seg-meta' }, 'Quét và thăm dò đang chạy')))
      /* External C-blocks first (internet, usually the entry), then internal (only after a shell) */
      const segBlock = (title, list, kind) => {
        /* External / internal groups collapse independently (state kept per target), expanded by default */
        const open = sideCollapse.isOpen('scope:' + kind, true)
        const toggle = sideCollapse.toggle('scope:' + kind, true)
        const out = [h('div', {
          key: 'h' + kind, className: 'rt-sidehead rt-sidehead-btn',
          role: 'button', tabIndex: 0, 'aria-expanded': open ? 'true' : 'false',
          title: (open ? 'Thu gọn nhóm này' : 'Mở rộng nhóm này') + ' (và quay lại danh sách tài sản)',
          onClick: () => { setView('list'); toggle() },
          onKeyDown: (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setView('list'); toggle(e) } },
        },
          h('span', { className: 'rt-sec-caret' }, open ? '▾' : '▸'),
          h('span', { className: 'rt-scope rt-scope-' + kind }, kind === 'internal' ? 'Nội bộ' : 'Internet'),
          h('span', null, title + ' · ' + list.length + ' dải C'),
          h('span', { className: 'rt-spacer' }),
          h('span', { style: { fontWeight: 400 } }, list.reduce((n, x) => n + (x.assets || 0), 0) + ' tài sản'))]
        if (!open) return out
        for (const s of list) {
          /* One row per C-block: block + asset count (port count, attribution, liveness go to tooltip) */
          out.push(h('div', Object.assign({
            key: s.cidr, className: 'rt-seg' + (cidr === s.cidr ? ' on' : ''),
            title: (s.org || 'Chưa rõ phân loại') + ' · còn sống ' + (s.live || 0) + '/' + (s.assets || 0) + ' máy',
          }, clickable(() => { setView('list'); setCidr(s.cidr) },
            { label: 'Lọc dải C ' + s.cidr, expanded: cidr === s.cidr && view !== 'testing' })),
            h('div', { className: 'rt-seg-cidr', style: { display: 'flex', alignItems: 'baseline', gap: 5 } },
              h('span', { className: 'rt-scope rt-scope-' + kind }, kind === 'internal' ? 'Nội' : 'Ngoại'),
              h('span', { style: { flex: 1 } }, s.cidr),
              h('span', { className: 'rt-seg-meta', style: { margin: 0, whiteSpace: 'nowrap' } },
                s.assets + ' máy'))))
        }
        return out
      }
      const segExternal = segs.filter((x) => x.scope !== 'internal')
      const segInternal = segs.filter((x) => x.scope === 'internal')
      if (segExternal.length) sideChildren.push(...segBlock('Tài sản internet', segExternal, 'external'))
      if (segInternal.length) sideChildren.push(...segBlock('Tài sản nội bộ', segInternal, 'internal'))
      const side = h('aside', {
        id: 'rt-ledger-segments-panel',
        className: 'rt-ledger-segments rt-side' + (showSegments ? '' : ' rt-ledger-segments-hidden'),
        'aria-label': 'Dạng xem dải mạng và lọc',
      },
        h('div', { className: 'rt-ledger-segments-head' },
          h('div', { className: 'rt-ledger-eyebrow' }, 'Bảng lọc'),
          h('h3', null, 'Dạng xem dải mạng'),
          h('span', null, 'Xem tài sản theo dải C')),
        h('div', { className: 'rt-ledger-segments-body' }, sideChildren))

      const tests = (snapshot && snapshot.tests) || {}
      const snapStats = (snapshot && snapshot.stats) || {}
      const targetName = snapshot && snapshot.engagement && snapshot.engagement.name
        ? snapshot.engagement.name : (eng || 'Chưa chọn mục tiêu')
      const ledgerStat = (key, label, value, tone) => h('div', { key: key, className: 'rt-ledger-stat rt-ledger-stat-' + (tone || 'default') },
        h('span', { className: 'rt-ledger-stat-icon', 'aria-hidden': 'true' }, tone === 'warn' ? '△' : tone === 'accent' ? '◎' : '▦'),
        h('span', { className: 'rt-ledger-stat-value' }, value === undefined || value === null ? '—' : String(value)),
        h('span', { className: 'rt-ledger-stat-label' }, label))
      const ledgerHeader = h('header', { className: 'rt-ledger-header' },
        h('div', { className: 'rt-ledger-heading' },
          h('div', { className: 'rt-ledger-eyebrow' }, 'Trinh sát tài sản'),
          h('h1', null, 'Sổ tài sản'),
          h('p', null, 'Tìm tài sản trước, rồi xem liên kết, nguồn và trạng thái kiểm thử.')),
        h('div', { className: 'rt-ledger-header-actions' },
          h('span', { className: 'rt-ledger-target' }, targetName),
          h('button', { className: 'rt-btn', title: 'Tải lại ảnh chụp và dữ liệu khung nhìn hiện tại', onClick: () => { if (onRefresh) onRefresh() } }, 'Làm mới')))
      const ledgerStats = h('div', { className: 'rt-ledger-stats', 'aria-label': 'Thống kê tài sản' },
        ledgerStat('assets', 'Đối tượng tài sản', snapStats.assets, 'accent'),
        ledgerStat('services', 'Bản ghi dịch vụ', snapStats.services),
        ledgerStat('segments', 'Dải mạng', snapStats.segments),
        ledgerStat('untested', 'Tài sản chờ kiểm thử', tests.untested, 'warn'))

      const toolbar = h('div', { className: 'rt-ledger-toolbar rt-toolbar rt-toolbar-stack' },
        h('div', { className: 'rt-toolbar-row rt-ledger-primary-tools' },
          h('input', {
            className: 'rt-input', style: { flex: '1 1 160px', maxWidth: 'none' }, placeholder: 'Tìm IP / tên miền / dấu vân tay (Enter)', 'aria-label': 'Tìm IP, tên miền hoặc dấu vân tay',
            value: q, onChange: (e) => setQ(e.target.value),
            onKeyDown: (e) => { if (e.key === 'Enter') setQApplied(q) },
          }),
          h('button', { className: 'rt-btn', onClick: () => setQApplied(q) }, 'Tìm kiếm'),
          h('input', {
            className: 'rt-input', style: { width: '78px' }, placeholder: 'Dịch vụ', 'aria-label': 'Lọc theo dịch vụ',
            value: service, onChange: (e) => setService(e.target.value),
          }),
          h('input', {
            className: 'rt-input', style: { width: '60px' }, placeholder: 'Cổng', 'aria-label': 'Lọc theo cổng',
            value: port, onChange: (e) => setPort(e.target.value),
          }),
          h('div', { className: 'rt-spacer' }),
          h('button', { className: 'rt-btn', title: 'Tải lại ảnh chụp và dữ liệu khung nhìn hiện tại', onClick: () => { if (onRefresh) onRefresh() } }, 'Làm mới')),
        h('div', { className: 'rt-toolbar-row rt-ledger-filter-view-row' },
          h('details', { className: 'rt-ledger-advanced' },
            h('summary', null, 'Bộ lọc khác'),
            h('div', { className: 'rt-ledger-advanced-controls' },
              h('select', { className: 'rt-input', value: scope, onChange: (e) => setScope(e.target.value) },
                h('option', { value: '' }, 'Không giới hạn nội/ngoại'),
                h('option', { value: 'external' }, 'Chỉ tài sản internet'),
                h('option', { value: 'internal' }, 'Chỉ tài sản nội bộ')),
              h('select', { className: 'rt-input', value: prov, onChange: (e) => setProv(e.target.value), title: 'Lọc theo nguồn cổng (danh sách không còn hiển thị riêng, xem trong chi tiết)' },
                h('option', { value: '' }, 'Không giới hạn nguồn'),
                h('option', { value: 'passive' }, 'Chỉ bị động'),
                h('option', { value: 'active' }, 'Chỉ chủ động')),
              h('select', { className: 'rt-input', value: priority, onChange: (e) => setPriority(e.target.value) },
                h('option', { value: '' }, 'Không giới hạn độ dễ tấn công'),
                h('option', { value: 'high' }, 'Dễ tấn công (cao)'),
                h('option', { value: 'medium' }, 'Trung bình (vừa)'),
                h('option', { value: 'low' }, 'Khó tấn công (thấp)')),
              h('select', { className: 'rt-input', value: testStatus, onChange: (e) => setTestStatus(e.target.value) },
                h('option', { value: '' }, 'Không giới hạn trạng thái kiểm thử'),
                h('option', { value: 'untested' }, 'Chưa kiểm thử'),
                h('option', { value: 'testing' }, 'Đang kiểm thử'),
                h('option', { value: 'tested' }, 'Đã kiểm thử'),
                h('option', { value: 'blocked' }, 'Bị chặn'),
                h('option', { value: 'abandoned' }, 'Đã bỏ'),
                h('option', { value: 'no_surface' }, 'Không có bề mặt tấn công')))),
          h('div', { className: 'rt-ledger-view-tools' },
            h('button', {
              className: 'rt-btn rt-ledger-segments-toggle',
              type: 'button',
              'aria-controls': 'rt-ledger-segments-panel',
              'aria-expanded': showSegments ? 'true' : 'false',
              onClick: () => setShowSegments((open) => !open),
            }, showSegments ? 'Ẩn dạng xem dải mạng' : 'Dạng xem dải mạng'),
            h('div', { className: 'rt-ledger-view-tabs', role: 'tablist', 'aria-label': 'Dạng xem tài sản' },
              h('button', { className: 'rt-btn' + (view === 'list' ? ' rt-btn-primary' : ''), role: 'tab', 'aria-selected': view === 'list' ? 'true' : 'false', onClick: () => setView('list') }, 'Dạng danh sách / máy chủ'),
              h('button', { className: 'rt-btn' + (view === 'timeline' ? ' rt-btn-primary' : ''), role: 'tab', 'aria-selected': view === 'timeline' ? 'true' : 'false', title: 'Xem tài sản theo thời điểm phát hiện (phát hiện khi nào, ngày nào thu được bao nhiêu)', onClick: () => setView('timeline') }, 'Thời điểm phát hiện'),
              h('button', { className: 'rt-btn' + (view === 'domain' ? ' rt-btn-primary' : ''), role: 'tab', 'aria-selected': view === 'domain' ? 'true' : 'false', onClick: () => setView('domain') }, 'Tên miền'),
              h('button', { className: 'rt-btn' + (view === 'web' ? ' rt-btn-primary' : ''), role: 'tab', 'aria-selected': view === 'web' ? 'true' : 'false', onClick: () => setView('web') }, 'Web / trang web và dịch vụ')))))

      /* ── conclusion row: the whole inventory on one screen, click a number to filter ─────────── */
      const noFilter = !testStatus && !priority && !scope && !prov && !assetState && !cidr
      const conclItem = (key, label, value, active, onClick) => h('span', Object.assign({
        key: key, className: 'rt-concl-i' + (active ? ' on' : ''), title: 'Bấm để lọc / bấm lại để bỏ lọc',
      }, clickable(onClick, { label: 'Lọc theo "' + label + '" (' + (value || 0) + ')', expanded: active })),
        h('b', null, String(value || 0)), h('span', null, label))
      const toggleTest = (v) => { setTestStatus((cur) => (cur === v ? '' : v)); setAssetState('') }
      const conclusion = h('div', { className: 'rt-concl rt-ledger-conclusion' },
        conclItem('all', ' tài sản', snapStats.assets, noFilter, () => {
          setTestStatus(''); setPriority(''); setScope(''); setProv(''); setAssetState(''); setCidr(null)
        }),
        conclItem('live', 'Còn sống', snapStats.liveAssets, assetState === 'live', () => { setAssetState((v) => (v === 'live' ? '' : 'live')); setTestStatus('') }),
        conclItem('untested', 'Chờ kiểm thử', tests.untested, testStatus === 'untested', () => toggleTest('untested')),
        conclItem('testing', 'Đang kiểm thử', tests.testing, testStatus === 'testing', () => toggleTest('testing')),
        conclItem('tested', 'Đã kiểm thử', tests.tested, testStatus === 'tested', () => toggleTest('tested')),
        conclItem('giveup', 'Bỏ', (tests.abandoned || 0) + (tests.blocked || 0), testStatus === 'abandoned,blocked', () => toggleTest('abandoned,blocked')),
        h('div', { className: 'rt-spacer' }),
        h('select', {
          className: 'rt-input', value: sort, onChange: (e) => setSort(e.target.value),
          title: 'Cách sắp xếp danh sách',
        },
          h('option', { value: 'priority' }, 'Sắp xếp: ưu tiên độ dễ tấn công'),
          h('option', { value: 'todo' }, 'Sắp xếp: ưu tiên chờ kiểm thử'),
          h('option', { value: 'discovered' }, 'Sắp xếp: ưu tiên phát hiện gần đây'),
          h('option', { value: 'ports' }, 'Sắp xếp: ưu tiên nhiều cổng'),
          h('option', { value: 'ip' }, 'Sắp xếp: theo IP')))

      const head = h('div', { className: 'rt-row head rt-ledger-table-head' },
        h('span', null, 'Tài sản / định danh'), h('span', null, 'Dễ tấn công'), h('span', null, 'Trạng thái kiểm thử'),
        h('span', null, 'Cổng mở / dịch vụ'), h('span', null, 'Dấu vân tay'))

      const rowNodes = []
      let detailPane = null
      for (const it of state.items) {
        const openPorts = it.ports.filter((p) => p.state === 'open')
        const portText = openPorts.map((p) => p.port + (p.service ? '/' + p.service : '')).join(', ') || '—'
        const fpText = it.fingerprints.map((f) => [f.vendor, f.product, f.version].filter(Boolean).join(' ')).join(' / ') || '—'
        /* At most 3 ports, the rest as +N; active/passive source moves from a column into details */
        const shownPorts = openPorts.slice(0, 3).map((p) => p.port + (p.service ? '/' + p.service : '')).join(', ')
        const morePorts = openPorts.length > 3 ? ' +' + (openPorts.length - 3) : ''
        rowNodes.push(h('div', Object.assign({
          key: 'r' + it.id, className: 'rt-row rt-ledger-row' + (openId === it.id ? ' selected' : ''),
        }, clickable(() => toggleRow(it.id), { label: 'Mở rộng tài sản ' + it.ip, expanded: openId === it.id })),
          h('span', { className: 'rt-mono', style: { display: 'flex', alignItems: 'baseline', gap: 4, flexWrap: 'wrap' } },
            h('span', {
              className: 'rt-scope rt-scope-' + (it.scope === 'internal' ? 'internal' : 'external'),
            }, it.scope === 'internal' ? 'Nội' : 'Ngoại'),
            h('span', {
              title: it.state === 'live' ? 'Còn sống' : String(it.state),
              style: {
                width: 7, height: 7, borderRadius: '50%', flex: 'none', marginTop: 4,
                background: it.state === 'live' ? 'var(--ui-success)' : 'var(--ui-muted)',
              },
            }),
            h('span', { style: { overflow: 'hidden', textOverflow: 'ellipsis' } }, it.ip),
            /* Discovery time sits under the IP: the column is narrow, no extra column (widths ripple) */
            h('span', {
              style: { fontSize: 'var(--ui-text-helper)', color: 'var(--dsw-alias-label-secondary)', whiteSpace: 'nowrap' },
              title: 'Thời điểm phát hiện: ' + (it.discovered_at ? fmt(it.discovered_at) : 'Chưa ghi nhận')
                + (it.last_seen ? '\nThu thập gần nhất: ' + fmt(it.last_seen) : ''),
            }, it.discovered_at ? fmtShort(it.discovered_at) : 'Không rõ thời điểm phát hiện')),
          h('span', null, h(PriTag, { p: it.priority, title: it.potential || '' })),
          h('span', null, h(TestTag, { s: it.test_status }),
            it.blocked_count ? h('span', { className: 'rt-tag', style: { color: 'var(--ui-danger)', borderColor: 'var(--ui-danger)', marginLeft: 4 } }, 'Chặn ' + it.blocked_count) : null),
          h('span', { title: portText }, (shownPorts || '—') + morePorts),
          h('span', { title: fpText }, fpText.length > 30 ? fpText.slice(0, 30) + '…' : fpText)))

        if (openId !== it.id) continue
        const d = detail && detail.id === it.id ? detail : null
        const portRows = []
        const fpRows = []
        const obsRows = []
        if (d) {
          for (const p of (d.ports || [])) {
            if (p.state !== 'open') continue
            portRows.push(h('div', { key: 'p' + p.port, className: 'rt-kv' },
              h('b', { className: 'rt-mono' }, p.port + '/' + p.proto),
              h('span', null, [p.service, p.product, p.version].filter(Boolean).join(' ') || 'Dịch vụ không rõ'),
              p.url ? h('a', { className: 'rt-link', href: p.url, target: '_blank', rel: 'noreferrer', title: p.url }, p.title ? p.title : p.url) : null,
              h(ProvTag, { p: p.provenance })))
          }
          for (const f of (d.fingerprints || [])) {
            fpRows.push(h('div', { key: 'f' + (f.product || '') + (f.version || '') + (f.evidence || ''), className: 'rt-kv' },
              h('b', null, f.category || '—'),
              h('span', null, [f.vendor, f.product, f.version].filter(Boolean).join(' ') + (f.evidence ? '(' + f.evidence + ')' : '')),
              h(ProvTag, { p: f.provenance })))
          }
          for (const o of (d.observations || []).slice(0, 8)) {
            obsRows.push(h('div', { key: 'o' + (o.attr || '') + (o.value || '') + (o.collected_at || ''), className: 'rt-kv' },
              h('b', null, o.attr || '—'),
              h('span', null, (o.value || '') + ' · ' + (o.tool || 'Công cụ không rõ') + ' · ' + fmt(o.collected_at)),
              h(ProvTag, { p: o.provenance })))
          }
        }
        /* Three layers: 3 must-read lines → "expand all" reveals provenance, raw records, notes */
        const all = showAll === it.id
        const noteLines = d && d.test_notes ? d.test_notes.split('\n').filter(Boolean) : []
        const inner = d
          ? h('div', null,
              /* the three must-read lines */
              h('div', { className: 'rt-kv' }, h('b', null, 'Kiểm thử'), h('span', null,
                h(TestTag, { s: d.test_status }),
                d.blocked_count ? h('span', { className: 'rt-tag', style: { marginLeft: 6, color: 'var(--ui-danger)', borderColor: 'var(--ui-danger)' } }, 'Bị chặn ' + d.blocked_count + ' lần') : null,
                h('span', { style: { marginLeft: 8, color: 'var(--dsw-alias-label-secondary)' } },
                  (d.test_updated_at ? fmt(d.test_updated_at) : 'Chưa từng kiểm thử') + (d.test_updated_by ? ' · ' + d.test_updated_by : '')))),
              h('div', { className: 'rt-kv' }, h('b', null, 'Độ dễ tấn công'), h('span', null,
                h(PriTag, { p: d.priority }),
                h('span', { style: { marginLeft: 8 } }, d.potential || 'Chưa đánh giá'),
                d.assess_reason ? h('span', { style: { marginLeft: 8, color: 'var(--dsw-alias-label-secondary)' } }, d.assess_reason) : null)),
              h('div', { className: 'rt-kv' }, h('b', null, 'Bề mặt tấn công'), h('span', null,
                d.test_surface || (portRows.length ? 'Chưa ghi nhận (xem cổng mở bên dưới)' : 'Không có cổng mở'),
                d.scope ? h('span', { className: 'rt-scope rt-scope-' + (d.scope === 'internal' ? 'internal' : 'external'), style: { marginLeft: 8 } },
                  d.scope === 'internal' ? 'Tài sản nội bộ' : 'Tài sản internet') : null)),
              h('span', Object.assign({ className: 'rt-more' },
                clickable(() => setShowAll(all ? null : it.id), { label: all ? 'Thu gọn chi tiết tài sản' : 'Mở rộng chi tiết tài sản', expanded: all })),
                all ? 'Thu gọn tất cả ▲' : 'Mở rộng tất cả (cổng · dấu vân tay · nguồn thu thập · bản ghi kiểm thử) ▼'),
              all ? h('div', null,
                h('div', { className: 'rt-kv' }, h('b', null, 'Tên máy chủ'), h('span', null, (d.names || []).map((n) => n.name).join(', ') || '—')),
                h('div', { className: 'rt-kv' }, h('b', null, 'Thời điểm phát hiện'),
                  h('span', { title: 'Thời điểm tài sản này lần đầu vào kho tài sản (thu thập lại chỉ làm mới "thu thập gần nhất")' }, fmt(d.discovered_at)),
                  h('b', { style: { minWidth: 0, marginLeft: 8 } }, 'Thu thập gần nhất'), h('span', null, fmt(d.last_seen)),
                  h('b', { style: { minWidth: 0, marginLeft: 8 } }, 'Lần đầu thấy ở nguồn dữ liệu'), h('span', null, fmt(d.first_seen))),
                h('div', { className: 'rt-kv' }, h('b', null, 'Dải C'), h('span', null, d.segment_cidr)),
                h('div', { className: 'rt-kv' }, h('b', null, 'Độ dễ tấn công'), h('span', null,
                  (d.priority || 'Chưa đánh giá') + (d.potential ? ' · dự kiến: ' + d.potential : '')
                  + (d.assess_reason ? ' · căn cứ: ' + d.assess_reason : '')
                  + (d.assessed_at ? '(' + fmt(d.assessed_at) + ')' : ''))),
                h('div', { className: 'rt-kv' }, h('b', null, 'Nguồn'), h('span', null,
                  'Cổng bị động ' + (d.passive || 0) + ' · cổng chủ động ' + (d.active || 0))),
                h('div', { style: { margin: '6px 0 3px', fontWeight: 600 } }, 'Cổng mở / dịch vụ'),
                h('div', null, portRows.length ? portRows : '—'),
                h('div', { style: { margin: '6px 0 3px', fontWeight: 600 } }, 'Dấu vân tay'),
                h('div', null, fpRows.length ? fpRows : '—'),
                noteLines.length
                  ? h(Clip, { key: 'notes', label: 'Bản ghi kiểm thử (' + noteLines.length + ' mục)', text: noteLines.join('\n') })
                  : null,
                (d.shots || []).length
                  ? h(ShotStrip, { key: 'shots', eng: eng, shots: d.shots, total: d.shots.length, title: 'Ảnh chụp liên quan' })
                  : null,
                h('div', { style: { margin: '6px 0 3px', fontWeight: 600 } }, 'Nguồn thu thập (8 mục gần nhất)'),
                h('div', null, obsRows.length ? obsRows : '—'))
                : null)
          : h('div', null, 'Đang tải…')
        const selectedLabel = d
          ? ((d.names || []).map((n) => n.name).filter(Boolean).join(', ') || d.primary_name || it.primary_name || it.ip)
          : (it.primary_name || it.ip)
        detailPane = h('aside', { className: 'rt-ledger-detail', 'aria-label': 'Chi tiết tài sản: ' + it.ip },
          h('div', { className: 'rt-ledger-detail-head', role: 'region', tabIndex: 0, 'aria-label': 'Tên và trạng thái tài sản, hỗ trợ cuộn' },
            h('div', { className: 'rt-ledger-eyebrow' }, 'Chi tiết tài sản'),
            h('h2', null, selectedLabel),
            h('div', { className: 'rt-ledger-detail-ip rt-mono' }, it.ip),
            h('div', { className: 'rt-ledger-detail-status' }, h(TestTag, { s: (d && d.test_status) || it.test_status }),
              h(PriTag, { p: (d && d.priority) || it.priority }),
              h('span', { className: 'rt-ledger-detail-scope' }, (d && d.scope) === 'internal' || it.scope === 'internal' ? 'Tài sản nội bộ' : 'Tài sản internet'),
              h('button', {
                className: 'rt-btn rt-ledger-detail-close',
                type: 'button',
                'aria-label': 'Đóng chi tiết tài sản',
                title: 'Đóng chi tiết tài sản',
                onClick: closeDetail,
              }, '×'))),
          h('div', { className: 'rt-ledger-detail-body', role: 'region', tabIndex: 0, 'aria-label': 'Nội dung chi tiết tài sản, hỗ trợ cuộn' }, h('div', { className: 'rt-expand' }, inner)))
      }

      if (!detailPane) {
        detailPane = h('aside', { className: 'rt-ledger-detail rt-ledger-detail-empty', 'aria-label': 'Chi tiết tài sản' },
          h('div', { className: 'rt-ledger-empty-icon', 'aria-hidden': 'true' }, '◎'),
          h('h2', null, 'Chọn một tài sản'),
          h('p', null, 'Bấm vào dòng tài sản bên trái để xem cổng, dấu vân tay, bản ghi kiểm thử và nguồn thu thập.'))
      }

      const listPane = h('div', { className: 'rt-table rt-ledger-list-pane' }, head, rowNodes,
        !state.loading && !state.items.length ? h('div', { className: 'rt-empty' }, 'Không có tài sản khớp') : null)

      /* Domain view: domain → related assets */
      const domainPane = h('div', { className: 'rt-table' },
        domains === null ? h('div', { className: 'rt-empty' }, 'Đang tải…')
          : domains.length
          ? domains.map((g) => h('div', { key: g.domain },
              h('div', { className: 'rt-section', style: { padding: '8px 10px 4px' } },
                h('a', { className: 'rt-link', href: 'http://' + g.domain, target: '_blank', rel: 'noreferrer' }, g.domain),
                h('span', { className: 'rt-tag', style: { marginLeft: 8 } }, g.count + ' tài sản')),
              g.assets.map((a) => h('div', {
                key: String(g.domain) + '\u0000' + a.id + '\u0000' + a.ip, className: 'rt-row',
                style: { gridTemplateColumns: '150px 130px 70px 1fr', cursor: 'pointer' },
                onClick: () => { setView('list'); setQ(''); setQApplied(a.ip) },
              },
                h('span', { className: 'rt-mono' }, a.ip),
                h('span', { className: 'rt-mono' }, a.segment),
                h('span', null, h('span', { className: 'rt-tag rt-tag-' + (a.state === 'live' ? 'live' : 'dead') }, a.state === 'live' ? 'Còn sống' : a.state)),
                h('span', { style: { fontSize: 'var(--ui-text-helper)', color: 'var(--dsw-alias-label-secondary)' } }, (a.names || []).join(', '))))))
          : h('div', { className: 'rt-empty' }, cidr ? 'Dải C này chưa có tên miền (chuyển sang "Tất cả dải C" để xem toàn bộ)' : 'Chưa có dữ liệu tên miền (giai đoạn thu thập thông tin sẽ ghi vào)'))

      /* Web assets: title + directly clickable URL */
      const webPane = h('div', { className: 'rt-table' },
        h('div', { className: 'rt-row head', style: { gridTemplateColumns: '1.6fr 1.2fr 130px 110px' } },
          h('span', null, 'URL (có thể bấm)'), h('span', null, 'Tiêu đề'), h('span', null, 'Tài sản'), h('span', null, 'Dịch vụ')),
        (web || []).map((w) => {
          const url = w.url || ('http' + (w.port === 443 || w.port === 8443 || w.port === 9443 ? 's' : '') + '://' + w.ip + (w.port === 80 || w.port === 443 ? '' : ':' + w.port))
          return h('div', {
            key: 'w' + w.port_id, className: 'rt-row',
            style: { gridTemplateColumns: '1.6fr 1.2fr 130px 110px', cursor: 'default' },
          },
            h('a', { className: 'rt-link rt-mono', href: url, target: '_blank', rel: 'noreferrer', title: url }, url),
            h('span', { title: w.title || '' }, w.title || '—'),
            h('span', { className: 'rt-mono' }, w.ip + ' · ' + w.segment_cidr),
            h('span', { style: { fontSize: 'var(--ui-text-helper)' } }, [w.service, w.product, w.version].filter(Boolean).join(' ')))
        }),
        web === null ? h('div', { className: 'rt-empty' }, 'Đang tải…')
          : (!web.length ? h('div', { className: 'rt-empty' }, cidr ? 'Dải C này chưa có tài sản Web' : 'Chưa có tài sản Web (sau khi thăm dò HTTP sẽ ghi URL và tiêu đề)') : null))


      const listWithDetail = h('div', { className: 'rt-ledger-list-detail' }, listPane, detailPane)
      let pane = listWithDetail
      if (view === 'testing') pane = h(TestingTab, { engagement: eng, refreshKey: refreshKey })
      else if (view === 'domain') pane = domainPane
      else if (view === 'web') pane = webPane
      /* The discovery-time view brings its own scroll container, so it drops straight into rt-main's flex */
      else if (view === 'timeline') pane = h(DiscoveryView, { engagement: eng, refreshKey: refreshKey })

      return h('div', { className: 'rt-ledger-page' },
        ledgerHeader,
        ledgerStats,
        h('div', { className: 'rt-ledger-layout rt-split' + (showSegments ? ' rt-ledger-layout-segments-open' : '') }, side,
          h('main', { className: 'rt-ledger-main rt-main' },
            h('section', { className: 'rt-ledger-query-card', 'aria-label': 'Tìm kiếm và lọc tài sản' },
              view === 'testing' ? null : toolbar, conclusion),
            state.error ? h('div', { className: 'rt-err' }, state.error) : null,
            pane)))
    }

    /* ---------------------------------------------------------- asset discovery timeline */
    /**
     * Asset discovery timeline: what was found when, and how much came in on which day.
     * ⚠️ This component was once collateral damage when the graph view was removed —— the deletion range's
     *    end marker was picked too wide (the graph canvas teardown sits right next to it), so the bundle
     *    self-check "client.js has the asset discovery-time view" went red. On restore the insertion point
        was pinned to "before the asset-mapping comment block" to keep it out of future deletions.
     * */
    function DiscoveryView(props) {
      const eng = props.engagement
      const refreshKey = props.refreshKey || 0
      const [data, setData] = React.useState(null)
      const [err, setErr] = React.useState(null)
      const [day, setDay] = React.useState('')
      React.useEffect(() => {
        if (!eng) return
        setData(null)
        api({ op: 'discoveryTimeline', engagement: eng, limit: 200 })
          .then((r) => { if (!r || r.ok === false) setErr((r && r.error) || 'Tải thất bại'); else { setErr(null); setData(r) } },
            (e) => setErr(String((e && e.message) || e)))
      }, [eng, refreshKey])
      if (err) return h('div', { className: 'rt-pane' }, h('div', { className: 'rt-err' }, err))
      if (!data) return h('div', { className: 'rt-empty' }, 'Đang tải…')
      const recent = (data.recent || []).filter((a) => day === '' || String(a.discovered_at || '').slice(0, 10) === day)
      return h('div', { className: 'rt-pane', style: { flex: 1, minHeight: 0 } },
        h('div', { className: 'rt-card' },
          h('h4', null, 'Dòng thời gian phát hiện tài sản'),
          h('div', { style: { fontSize: 'var(--ui-text-helper)', color: 'var(--dsw-alias-label-secondary)' } },
            'Tổng ' + ((data.span && data.span.total) || 0) + ' máy · sớm nhất '
            + (data.span && data.span.first ? fmt(data.span.first) : '—')
            + ' · gần nhất ' + (data.span && data.span.last ? fmt(data.span.last) : '—')
            + '(thời điểm phát hiện = lúc lần đầu vào kho tài sản; thu thập lại chỉ làm mới "thu thập gần nhất")')),
        (data.days || []).length === 0 ? h('div', { className: 'rt-empty' }, 'Chưa có tài sản.') : null,
        h('div', { className: 'rt-card' },
          h('h4', null, 'Thống kê theo ngày', day
            ? h('span', Object.assign({ className: 'rt-tag', style: { marginLeft: 6, cursor: 'pointer' } },
                clickable(() => setDay(''), { label: 'Bỏ lọc theo ngày: ' + day })), 'Bỏ lọc: ' + day)
            : null),
          h('div', { style: { display: 'flex', flexWrap: 'wrap', gap: 8 } },
            (data.days || []).map((d) => h('div', Object.assign({
              key: d.day, className: 'rt-seg' + (day === d.day ? ' on' : ''), style: { marginBottom: 0, cursor: 'pointer' },
              title: d.day + ': thêm mới ' + d.assets + ' máy (nội bộ ' + d.internal + ' / internet ' + d.external + ')',
            }, clickable(() => setDay(day === d.day ? '' : d.day),
              { label: 'Lọc ' + d.day + ' tài sản được phát hiện', expanded: day === d.day })),
              h('div', { className: 'rt-seg-cidr' }, d.day),
              h('div', { className: 'rt-seg-meta' }, d.assets + ' máy · nội ' + d.internal + ' / ngoại ' + d.external))))),
        h('div', { className: 'rt-card' },
          h('h4', null, day ? day + ' tài sản được phát hiện (' + recent.length + ')' : 'Tài sản phát hiện gần đây (' + recent.length + ')'),
          recent.length === 0 ? h('div', { className: 'rt-empty' }, 'Ngày này không có tài sản mới.') : null,
          recent.map((a) => h('div', { key: a.id, className: 'rt-kv' },
            h('b', { className: 'rt-mono', style: { minWidth: 110 } },
              h('span', { className: 'rt-scope rt-scope-' + (a.scope === 'internal' ? 'internal' : 'external'), style: { marginRight: 4 } },
                a.scope === 'internal' ? 'Nội' : 'Ngoại'),
              a.ip),
            h('span', { style: { minWidth: 132, fontSize: 'var(--ui-text-helper)', color: 'var(--dsw-alias-label-secondary)' } },
              a.discovered_at ? fmt(a.discovered_at) : 'Không rõ thời gian'),
            h('span', { style: { flex: 1 } }, (a.primary_name || '—') + (a.open_ports ? ' · ' + a.open_ports + ' cổng' : '')),
            h(PriTag, { p: a.priority })))))
    }

    /* ---------------------------------------------------------- agent prompts */
    function PromptsTab(props) {
      const eng = props.engagement
      const refreshKey = props.refreshKey || 0
      const [roles, setRoles] = React.useState([])
      const [active, setActive] = React.useState(null)
      const [draft, setDraft] = React.useState('')
      const [msg, setMsg] = React.useState(null)
      const [busy, setBusy] = React.useState(false)

      React.useEffect(() => {
        /* Allowed with no target: the server replies with built-in defaults instead of engagement required */
        api(eng ? { op: 'prompts', engagement: eng } : { op: 'prompts' }).then((r) => {
          if (!r || r.ok === false) { setMsg({ err: (r && r.error) || 'Đọc thất bại' }); return }
          setRoles(r.roles || [])
          if (r.roles && r.roles.length) setActive((cur) => cur || r.roles[0].role)
          if (r.builtin) setMsg({ ok: 'Hiện dùng prompt mặc định tích hợp (sau khi tạo mục tiêu có thể lưu chỉnh sửa theo mục tiêu)' })
        }, (e) => setMsg({ err: String((e && e.message) || e) }))
      }, [eng, refreshKey])

      React.useEffect(() => {
        const r = roles.find((x) => x.role === active)
        if (r) setDraft(r.content || '')
      }, [active, roles])

      const save = () => {
        if (!eng) { setMsg({ err: 'Hãy tạo mục tiêu trước, rồi lưu prompt' }); return }
        setBusy(true)
        setMsg(null)
        api({ op: 'savePrompt', engagement: eng, role: active, content: draft }).then((r) => {
          setBusy(false)
          if (!r || r.ok === false) { setMsg({ err: (r && r.error) || 'Lưu thất bại' }); return }
          setRoles((list) => list.map((x) => (x.role === active
            ? Object.assign({}, x, { content: draft, updated_at: new Date().toISOString() })
            : x)))
          setMsg({ ok: 'Đã lưu' })
        }, (e) => { setBusy(false); setMsg({ err: String((e && e.message) || e) }) })
      }

      /* Old targets hold old prompt templates; this restores the current role (or all) to the built-in latest */
      const reset = (all) => {
        if (!eng) { setMsg({ err: 'Hãy tạo mục tiêu trước, rồi khôi phục prompt mặc định' }); return }
        setBusy(true); setMsg(null)
        api({ op: 'resetPrompts', engagement: eng, role: all ? undefined : active }).then((r) => {
          setBusy(false)
          if (!r || r.ok === false) { setMsg({ err: (r && r.error) || 'Khôi phục thất bại' }); return }
          setMsg({ ok: 'Đã khôi phục mặc định tích hợp: ' + (r.reset || []).join(', ') })
          api({ op: 'prompts', engagement: eng }).then((rr) => {
            if (rr && rr.ok) {
              setRoles(rr.roles || [])
              const cur2 = (rr.roles || []).find((x) => x.role === active)
              if (cur2) setDraft(cur2.content || '')
            }
          }, () => {})
        }, (e) => { setBusy(false); setMsg({ err: String((e && e.message) || e) }) })
      }

      const cur = roles.find((x) => x.role === active)
      const items = roles.map((r) => h('div', Object.assign({
        key: r.role, className: 'rt-item' + (active === r.role ? ' on' : ''),
      }, clickable(() => { setActive(r.role); setMsg(null) },
        { label: 'Xem prompt "' + r.title + '"', expanded: active === r.role })),
        h('div', { className: 'rt-item-name' }, r.title),
        h('div', { className: 'rt-item-desc' }, (r.content || '').replace(/[#*`]/g, '').slice(0, 60) || '(trống)')))

      return h('div', { className: 'rt-split' },
        h('div', { className: 'rt-list' }, items),
        h('div', { className: 'rt-main' },
          h('div', { className: 'rt-toolbar' },
            h('span', { style: { fontWeight: 600 } }, cur ? cur.title : 'Prompt'),
            h('span', { className: 'rt-tag' }, 'Cập nhật ' + fmt(cur && cur.updated_at)),
            h('div', { className: 'rt-spacer' }),
            h('button', {
              className: 'rt-btn', disabled: busy || !active, title: 'Khôi phục vai trò hiện tại về prompt tích hợp mới nhất',
              onClick: () => reset(false),
            }, 'Khôi phục mặc định cho hiện tại'),
            h('button', {
              className: 'rt-btn', disabled: busy, title: 'Khôi phục cả bốn vai trò về prompt tích hợp mới nhất',
              onClick: () => reset(true),
            }, 'Khôi phục mặc định tất cả'),
            h('button', { className: 'rt-btn rt-btn-primary', disabled: busy || !active, onClick: save }, busy ? 'Đang lưu…' : 'Lưu')),
          msg ? h('div', { className: msg.err ? 'rt-err' : 'rt-foot' }, msg.err || msg.ok) : null,
          h('div', { className: 'rt-pane' },
            h('textarea', {
              className: 'rt-textarea', value: draft, spellCheck: false,
              onChange: (e) => setDraft(e.target.value),
              placeholder: 'Prompt hệ thống của vai trò này (Markdown)',
            }),
            h('div', { style: { fontSize: 'var(--ui-text-helper)', color: 'var(--dsw-alias-label-secondary)', marginTop: 6 } },
              'Sau khi lưu sẽ ghi vào agents/' + (active || 'role') + '.md. Khi dòng đầu nhiệm vụ của phiên con ghi redteamRole: recon, assess, vuln-scan, exploit hoặc internal, tệp tương ứng sẽ vào prompt hệ thống.'))))
    }

    /* ---------------------------------------------------------- skill library (DSH native) */
    function SkillsTab(props) {
      const refreshKey = props.refreshKey || 0
      const [items, setItems] = React.useState([])
      const [meta, setMeta] = React.useState({})
      const [err, setErr] = React.useState(null)
      const [q, setQ] = React.useState('')
      const [srcOnly, setSrcOnly] = React.useState(false)
      const [active, setActive] = React.useState(null)
      const [detail, setDetail] = React.useState(null)
      const [busy, setBusy] = React.useState(false)
      const [brokenOnly, setBrokenOnly] = React.useState(false)
      const [detailLoading, setDetailLoading] = React.useState(false)
      const detailRequest = React.useRef(0)

      const load = (force) => {
        setBusy(true)
        api({ op: 'skillCatalog', refresh: force === true }).then((r) => {
          setBusy(false)
          if (!r || r.ok === false) { setErr((r && r.error) || 'Đọc thất bại'); return }
          setErr(null)
          setMeta(r || {})
          setItems(r.items || [])
        }, (e) => { setBusy(false); setErr(String((e && e.message) || e)) })
      }
      React.useEffect(load, [refreshKey])
      React.useEffect(() => () => { detailRequest.current += 1 }, [])

      const close = () => {
        detailRequest.current += 1
        setActive(null)
        setDetail(null)
        setDetailLoading(false)
      }
      const open = (skill) => {
        const name = skill && skill.name
        const key = (skill && skill.library ? skill.library : 'redteam') + ':' + name
        if (active === key) { close(); return }
        const request = ++detailRequest.current
        setActive(key)
        setDetail(null)
        setDetailLoading(true)
        setErr(null)
        api({ op: 'skillRead', name: name, library: skill.library || 'redteam' }).then((r) => {
          if (detailRequest.current !== request) return
          setDetailLoading(false)
          if (r && r.ok) setDetail(r)
          else setErr((r && r.error) || 'Đọc thất bại')
        }, (e) => {
          if (detailRequest.current !== request) return
          setDetailLoading(false)
          setErr(String((e && e.message) || e))
        })
      }
      const needle = q.trim().toLowerCase()
      let filtered = needle
        ? items.filter((s) => (s.name + ' ' + s.description + ' ' + s.whenToUse).toLowerCase().indexOf(needle) >= 0)
        : items
      if (srcOnly) filtered = filtered.filter((s) => s.library !== 'official' && s.fromPlugin === true)
      if (brokenOnly) filtered = filtered.filter((s) => s.library !== 'official' && (s.availability === 'broken' || s.availability === 'unknown'))
      const availSummary = meta.availability ? meta.availability.summary : null
      const needRestart = err !== null && String(err).indexOf('unknown op') >= 0
      const selected = items.find((s) => ((s.library || 'redteam') + ':' + s.name) === active)
      const badge = (skill) => skill.library === 'official'
        ? h('span', { className: 'rt-tag', title: 'Thư mục chính thức, không kiểm tra theo đường dẫn công cụ red-team' }, 'Chính thức')
        : h('span', { className: 'rt-avail rt-avail-' + (skill.availability || 'unknown'),
          title: skill.availability === 'available' ? 'Có thể tải nội dung; tình trạng phụ thuộc bên ngoài xem trong chi tiết' : (skill.problems || []).join('\n') || 'Chưa có kết luận về khả dụng' },
          skill.availability === 'available' ? 'Sẵn dùng' : skill.availability === 'broken' ? 'Không khả dụng' : 'Không rõ')
      const renderSkill = (skill) => {
        const key = (skill.library || 'redteam') + ':' + skill.name
        return h('button', {
          key: key, type: 'button', className: 'rt-skills-card' + (active === key ? ' on' : ''),
          'aria-label': 'Xem kỹ năng ' + skill.name, 'aria-pressed': active === key,
          onClick: () => open(skill),
        },
          h('span', { className: 'rt-skills-card-top' }, h('span', { className: 'rt-skills-name' }, skill.name), badge(skill)),
          h('span', { className: 'rt-skills-description' }, skill.description || 'Chưa có mô tả, chọn để xem nội dung kỹ năng.'),
          h('span', { className: 'rt-skills-source' },
            h('span', null, skill.fromPlugin ? 'Do plugin này cung cấp' : skill.library === 'official' ? 'Thư mục chính thức' : skill.provider || skill.source || 'Nguồn khác'),
            skill.modelInvocable === false ? h('span', { className: 'rt-tag' }, 'Chỉ thủ công') : null),
          (skill.problems || []).length && skill.availability !== 'available' && skill.library !== 'official'
            ? h('span', { className: 'rt-skills-card-warning' }, 'Có thiếu hụt phụ thuộc, xem chi tiết') : null)
      }
      const groups = [
        { key: 'redteam', title: 'Kỹ năng red-team', rows: filtered.filter((s) => s.library !== 'official') },
        { key: 'official', title: 'Kỹ năng chính thức', rows: filtered.filter((s) => s.library === 'official') },
      ]
      const sources = h('details', { className: 'rt-skills-diagnostics' },
        h('summary', null, 'Nguồn thư mục và thông tin kiểm tra'),
        h('p', null, meta.note || 'Thư mục kỹ năng do host quản lý, trạng thái thư mục và nội dung kỹ năng hiển thị riêng.'),
        h('p', null, 'Red-team ' + ((meta.libraries && meta.libraries.redteam) || 0) + ' · chính thức ' + ((meta.libraries && meta.libraries.official) || 0)),
        availSummary ? h('p', null, (meta.availability.cached ? 'Thời điểm kiểm tra bộ đệm: ' : 'Thời điểm kiểm tra: ') + (meta.availability.checked_at ? fmt(meta.availability.checked_at) : 'Chưa cung cấp')) : null,
        (meta.byDir || []).map((dir) => h('div', { key: dir.key, className: 'rt-skills-path' }, dir.n + ' mục · ' + dir.key)),
        items.length > 100 ? h('p', null, 'Kỹ năng cũng có thể đến từ plugin khác hoặc thư mục tùy chỉnh; plugin này cung cấp ' + (meta.fromPlugin || 0) + ' mục.') : null)
      const fact = (label, value, className) => h(React.Fragment, null,
        h('dt', null, label), h('dd', { className: className || '' }, value || '—'))

      return h('div', { className: 'rt-skills-workspace' },
        h('div', { className: 'rt-skills-overview', 'aria-label': 'Tổng quan thư mục kỹ năng' },
          h('div', { className: 'rt-skills-stat' }, h('strong', null, items.length), h('small', null, 'Kỹ năng trong thư mục')),
          h('div', { className: 'rt-skills-stat' }, h('strong', null, typeof meta.fromPlugin === 'number' ? meta.fromPlugin : '—'), h('small', null, 'Do plugin này cung cấp')),
          h('div', { className: 'rt-skills-stat' }, h('strong', null, availSummary ? availSummary.available || 0 : '—'), h('small', null, 'Kiểm tra khả dụng')),
          h('div', { className: 'rt-skills-stat' }, h('strong', null, availSummary ? (availSummary.broken || 0) + (availSummary.unknown || 0) : '—'), h('small', null, 'Không khả dụng / không rõ'))),
        h('div', { className: 'rt-skills-layout' },
          h('aside', { className: 'rt-skills-catalog', 'aria-label': 'Thư mục kỹ năng' },
            h('div', { className: 'rt-skills-filters' },
              h('div', { className: 'rt-skills-filter-heading' }, h('strong', null, 'Thư mục kỹ năng'), h('span', null, filtered.length + ' / ' + items.length)),
              h('input', { className: 'rt-input', placeholder: 'Tìm tên, mục đích hoặc mô tả', 'aria-label': 'Tìm kỹ năng', value: q, onChange: (e) => setQ(e.target.value) }),
              h('label', { className: 'rt-kb-check' }, h('input', { type: 'checkbox', checked: srcOnly, onChange: (e) => setSrcOnly(e.target.checked) }), 'Chỉ xem do plugin này cung cấp (' + (meta.fromPlugin || 0) + ')'),
              availSummary && (availSummary.broken > 0 || availSummary.unknown > 0) ? h('label', { className: 'rt-kb-check' },
                h('input', { type: 'checkbox', checked: brokenOnly, onChange: (e) => setBrokenOnly(e.target.checked) }), 'Chỉ xem không khả dụng / không rõ (' + ((availSummary.broken || 0) + (availSummary.unknown || 0)) + ')') : null),
            h('div', { className: 'rt-skills-list' },
              groups.filter((group) => group.rows.length).map((group) => h('section', { key: group.key },
                h('h3', { className: 'rt-skills-group' }, group.title, h('span', null, group.rows.length)), group.rows.map(renderSkill))),
              !filtered.length ? h('div', { className: 'rt-skills-no-results' }, busy ? 'Đang đọc thư mục…' : items.length ? 'Không có kỹ năng khớp, thử điều chỉnh tìm kiếm hoặc bộ lọc.' : 'Thư mục hiện tại không có kỹ năng.') : null)),
          h('section', { className: 'rt-skills-detail', 'aria-label': 'Chi tiết kỹ năng' },
            h('div', { className: 'rt-skills-detail-toolbar' },
              h('div', null, h('span', { className: 'rt-skills-kicker' }, detail ? 'Chi tiết kỹ năng' : active ? 'Đang xem' : 'Tổng quan thư mục'),
                h('h2', { className: 'rt-skills-heading' }, detail ? detail.name : selected ? selected.name : 'Tìm hiểu mục đích và trạng thái của từng kỹ năng')),
              h('div', { className: 'rt-skills-actions' },
                active ? h('button', { type: 'button', className: 'rt-btn', onClick: close }, 'Quay lại tổng quan') : null,
                h('button', { type: 'button', className: 'rt-btn', disabled: busy, 'aria-label': 'Kiểm tra lại khả dụng kỹ năng', title: 'Bỏ qua bộ đệm khả dụng của thư mục, đọc lại', onClick: () => load(true) }, busy ? 'Đang làm mới…' : 'Làm mới thư mục'))),
            err ? h('div', { className: 'rt-err', role: 'alert' }, needRestart ? 'Mô-đun host đã cập nhật, hãy khởi động lại host hiện tại rồi đọc lại thư mục kỹ năng.' : err) : null,
            h('div', { className: 'rt-skills-detail-scroll' },
              detailLoading ? h('div', { className: 'rt-skills-empty', role: 'status' }, h('h3', null, 'Đang đọc mô tả kỹ năng…'), h('p', null, selected ? selected.name : 'Vui lòng chờ')) : null,
              detail ? h(React.Fragment, null,
                h('section', { className: 'rt-skills-section' },
                  h('h3', null, 'Tổng quan kỹ năng'),
                  h('div', { className: 'rt-skills-status-row' }, selected ? badge(selected) : null, selected && selected.modelInvocable === false ? h('span', { className: 'rt-tag' }, 'Chỉ thủ công') : null),
                  h('dl', { className: 'rt-skills-facts' }, fact('Mô tả mục đích', detail.description), fact('Tình huống áp dụng', detail.whenToUse),
                    fact('Nhà cung cấp', detail.provider), fact('Loại nguồn', detail.source))),
                selected ? h('section', { className: 'rt-skills-section' }, h('h3', null, 'Khả dụng và phụ thuộc'),
                  selected.library === 'official' ? h('p', null, 'Kỹ năng chính thức do host gọi theo nhiệm vụ, không kiểm tra theo đường dẫn công cụ red-team.') : h(React.Fragment, null,
                    h('p', null, selected.availability === 'available' ? 'Nội dung kỹ năng có thể tải. Thiếu hụt công cụ ngoài hoặc cấu hình được liệt kê riêng.' : selected.availability === 'broken' ? 'Kiểm tra thư mục phát hiện thiếu hụt rõ ràng.' : 'Hiện không thể xác nhận khả dụng của nội dung kỹ năng.'),
                    (selected.problems || []).length ? h('div', null, h('h4', null, selected.availability === 'available' ? 'Công cụ ngoài chưa cài' : 'Mô tả thiếu hụt'),
                      h('ul', null, selected.problems.map((problem, i) => h('li', { key: i }, problem)))) : null,
                    (selected.needs_user || []).length ? h('div', null, h('h4', null, 'Cần bạn cung cấp'),
                      h('ul', null, selected.needs_user.map((need, i) => h('li', { key: i }, need)))) : null)) : null,
                h('section', { className: 'rt-skills-section' }, h('h3', null, 'Nguyên văn mô tả kỹ năng'),
                  h('pre', { className: 'rt-md rt-skills-content' }, detail.content || '(trống)')),
                h('details', { className: 'rt-skills-diagnostics' }, h('summary', null, 'Vị trí tệp và thư mục'),
                  h('dl', { className: 'rt-skills-facts' }, fact('Tệp kỹ năng', detail.path, 'rt-skills-path'), fact('Thuộc thư mục', selected && selected.dir, 'rt-skills-path'))), sources)
                : !detailLoading ? h(React.Fragment, null,
                  h('div', { className: 'rt-skills-empty' }, h('div', { className: 'rt-skills-empty-icon', 'aria-hidden': true }, '◇'),
                    h('h3', null, 'Chọn một kỹ năng để xem mô tả đầy đủ'), h('p', null, 'Trước hết xem mục đích ở thư mục bên trái, rồi xem tình huống áp dụng, phụ thuộc và nguyên văn mô tả.')),
                  h('section', { className: 'rt-skills-section' }, h('h3', null, 'Trạng thái thư mục'),
                    h('div', { className: 'rt-skills-status-row' },
                      h('span', { className: 'rt-tag' }, 'Red-team ' + ((meta.libraries && meta.libraries.redteam) || 0)),
                      h('span', { className: 'rt-tag' }, 'Chính thức ' + ((meta.libraries && meta.libraries.official) || 0)),
                      availSummary ? h('span', { className: 'rt-avail rt-avail-available' }, 'Khả dụng ' + (availSummary.available || 0)) : null,
                      availSummary && availSummary.broken > 0 ? h('span', { className: 'rt-avail rt-avail-broken' }, 'Không khả dụng ' + availSummary.broken) : null,
                      availSummary && availSummary.unknown > 0 ? h('span', { className: 'rt-avail rt-avail-unknown' }, 'Không rõ ' + availSummary.unknown) : null),
                    meta.availability && (meta.availability.broken || []).length ? h('div', null, h('h4', null, 'Kỹ năng cần chú ý'),
                      h('ul', null, meta.availability.broken.slice(0, 12).map((skill) => h('li', { key: skill.name }, skill.name + (skill.problems && skill.problems.length ? ' — ' + skill.problems[0] : ''))))) : null), sources) : null))))
    }

    /* ---------------------------------------------------------- vulnerability results */
    const SEV_LABEL = { critical: 'Nghiêm trọng', high: 'Nguy hiểm cao', medium: 'Nguy hiểm trung bình', low: 'Nguy hiểm thấp', info: 'Thông tin' }
    const STATUS_LABEL = { candidate: 'Chờ xác minh', confirmed: 'Đã xác nhận', 'false-positive': 'Báo động giả', exploited: 'Đã khai thác', fixed: 'Đã vá' }
    const sevClass = (s) => 'rt-sev rt-sev-' + (SEV_LABEL[s] ? s : 'info')


    /** Target merging: aggregate by scheme://host:port so URLs with paths do not split the group. */
    function targetKeyOf(v) {
      const t = String(v.target || '').trim()
      if (t !== '') {
        const url = /^([a-z][a-z0-9+.-]*:\/\/[^/?#\s]+)/i.exec(t)
        if (url) return url[1]
        const head = /^([^\s/?#]+)/.exec(t)
        if (head) return head[1]
        return t
      }
      return v.asset_ip || '(chưa chỉ định mục tiêu)'
    }

    /* ---------------------------------------------------------- evidence rendering */
    /** Colour a raw HTTP message by request line/status line + headers + body, so the eye can scan it. */
    function HttpBlock(props) {
      const text = String(props.text || '')
      if (!text) return null
      const lines = text.split(/\r?\n/)
      const nodes = lines.map((ln, i) => {
        let cls = null
        if (i === 0 && /^(GET|POST|PUT|DELETE|HEAD|OPTIONS|PATCH|TRACE)\s/.test(ln)) cls = 'rt-hl-req'
        else if (i === 0 && /^HTTP\//.test(ln)) cls = 'rt-hl-res'
        else if (/^[A-Za-z0-9-]+:/.test(ln)) {
          const name = ln.split(':')[0].toLowerCase()
          if (name === 'host' || name === 'cookie' || name === 'authorization' || name === 'content-type') cls = 'rt-hl-req'
        }
        return h('div', { key: 'l' + i, className: cls || undefined }, ln === '' ? '\u00a0' : ln)
      })
      return h('pre', { className: 'rt-evi-body' + (props.compact ? ' req' : '') }, nodes)
    }

    /** Evidence area on a vuln detail: structured evidence + that vuln's raw HTTP request/response. */
    function detailEvidence(v) {
      const evi = String(v.evidence || '').trim()
      const looksHttp = /^(GET|POST|PUT|DELETE|HEAD|OPTIONS|PATCH|HTTP\/)/m.test(evi) || /\n[A-Za-z-]+: /.test(evi)
      const blocks = []
      if (evi) {
        blocks.push(h('div', { key: 'ev', className: 'rt-evi' },
          h('div', { className: 'rt-evi-head' }, 'Tóm tắt bằng chứng',
            h('span', { className: 'rt-tag' }, looksHttp ? 'Gói tin gốc' : 'Văn bản'),
            h('div', { className: 'rt-spacer' }),
            h('button', {
              className: 'rt-btn', style: { padding: '0 12px', fontSize: 'var(--ui-text-control)' },
              onClick: (e) => { e.stopPropagation(); copyText(evi) },
            }, 'Sao chép')),
          looksHttp ? h(HttpBlock, { text: evi }) : h('pre', { className: 'rt-evi-body' }, evi)))
      }
      const http = v.http_evidence || []
      for (const e of http) {
        blocks.push(h('div', { key: 'h' + e.id, className: 'rt-evi' },
          h('div', { className: 'rt-evi-head' },
            e.label || 'Bằng chứng HTTP',
            h('span', { className: 'rt-tag' }, (e.method || '') + ' ' + (e.status === null || e.status === undefined ? '' : e.status)),
            h('div', { className: 'rt-spacer' }),
            h('span', { style: { fontWeight: 400, color: 'var(--dsw-alias-label-secondary)' } }, fmt(e.captured_at || e.created_at))),
          e.request ? h('div', null,
            h('div', { className: 'rt-evi-head', style: { borderTop: 'none' } }, '▸ Request (dán trực tiếp vào Burp Repeater)'),
            h(HttpBlock, { text: e.request, compact: true })) : null,
          e.response ? h('div', null,
            h('div', { className: 'rt-evi-head' }, '▸ Response'),
            h(HttpBlock, { text: e.response })) : null,
          e.note ? h('pre', { className: 'rt-evi-body', style: { maxHeight: 80 } }, e.note) : null))
      }
      if (blocks.length === 0) {
        blocks.push(h('div', { key: 'none', className: 'rt-kv' }, h('b', null, 'Bằng chứng'),
          h('span', { style: { color: 'var(--ui-danger)' } }, 'Thiếu — lỗ hổng chưa xác minh/không có bằng chứng sẽ không được tính vào báo cáo, hãy bổ sung redteam_http_evidence_add')))
      }
      return h('div', { key: 'eviwrap' }, blocks)
    }

    /* ---------------------------------------------------- credentials / sessions / attack files */
    /** Credential list: masked by default, copy takes the real value; reused by the files page. */
    function CredentialList(props) {
      const creds = props.items || []
      if (!creds.length) return h('div', { className: 'rt-empty rt-credential-empty' }, 'Chưa có thông tin xác thực (sau khi có mật khẩu/khóa/hash hãy dùng redteam_credential_add để lưu, tái sử dụng trong vài giây)')
      return h('div', { className: 'rt-pane rt-credential-list' }, creds.map((c) => h('article', { key: 'c' + c.id, className: 'rt-cred rt-credential-card' },
        h('header', { className: 'rt-cred-head rt-credential-header' },
          h('span', { className: 'rt-cred-host rt-credential-host' }, c.host),
          c.username ? h('span', { className: 'rt-tag' }, c.username) : null,
          h('span', { className: 'rt-tag rt-tag-passive' }, c.secret_type || 'password'),
          c.privilege ? h('span', { className: 'rt-tag rt-tag-active' }, c.privilege) : null,
          h('div', { className: 'rt-spacer' }),
          h('button', {
            className: 'rt-btn rt-credential-copy',
            onClick: (e) => { e.stopPropagation(); copyText(String(c.secret_value || '')) },
          }, 'Sao chép')),
        h('div', { className: 'rt-credential-secret' },
          h(SecretText, { value: c.secret_value, className: 'rt-secret', empty: 'Chưa ghi bản rõ — hãy bổ sung secret_value của redteam_credential_add để bảng hiển thị trực tiếp' })),
        h('div', { className: 'rt-cred-meta rt-credential-meta' },
          [c.source ? 'Nguồn ' + c.source : null,
            c.tool ? 'Công cụ ' + c.tool : null,
            c.secret_ref ? 'Bằng chứng ' + c.secret_ref : null,
            c.found_by_agent ? 'by ' + c.found_by_agent : null,
            c.found_at ? fmt(c.found_at) : null].filter(Boolean).join(' · ')),
        c.note ? h('div', { className: 'rt-cred-meta rt-credential-note' }, 'Ghi chú: ' + c.note) : null)))
    }

    function AccessList(props) {
      const accesses = props.items || []
      if (!accesses.length) return h('div', { className: 'rt-empty rt-access-empty' }, 'Chưa có phiên truy cập')
      return h('div', { className: 'rt-pane rt-access-list' }, accesses.map((a) => h('div', {
        key: 'a' + a.id, className: 'rt-vrow rt-access-card',
      },
        h('span', { className: 'rt-mono rt-access-host' }, a.host),
        h('span', { className: 'rt-access-user' }, a.username || '—'),
        h('span', { className: 'rt-access-method' }, h('span', { className: 'rt-tag rt-tag-active' }, a.method || '—')),
        h('span', { className: 'rt-access-privilege' }, a.privilege || '—'),
        h('span', { className: 'rt-mono rt-access-session', title: a.session_ref || '' }, a.session_ref || '—'))))
    }

    /** Credentials / sessions / attack files left the vuln page: collapsed by default, opened on demand. */
    function ArtifactsTab(props) {
      const eng = props.engagement
      const refreshKey = props.refreshKey || 0
      const [files, setFiles] = React.useState([])
      const [creds, setCreds] = React.useState([])
      const [accesses, setAccesses] = React.useState([])
      const [err, setErr] = React.useState(null)
      const [busy, setBusy] = React.useState(false)

      const load = () => {
        if (!eng) return
        setBusy(true); setErr(null)
        api({ op: 'attackFiles', engagement: eng }).then((r) => setFiles((r && r.items) || []), () => {})
        api({ op: 'credentials', engagement: eng }).then((r) => setCreds((r && r.items) || []), () => {})
        api({ op: 'access', engagement: eng }).then((r) => setAccesses((r && r.items) || []), () => {})
        setBusy(false)
      }
      React.useEffect(load, [eng, refreshKey])

      const fileCount = (files || []).reduce((n, g) => n + (g.files || []).length, 0)
      return h('div', { className: 'rt-main rt-artifacts-page' },
        h('div', { className: 'rt-toolbar' },
          h('span', { style: { fontWeight: 600 } }, 'Thông tin xác thực và tệp'),
          h('span', { className: 'rt-tag' }, 'Thông tin xác thực ' + creds.length),
          h('span', { className: 'rt-tag' }, 'Phiên truy cập ' + accesses.length),
          h('span', { className: 'rt-tag' }, 'Tệp tấn công ' + fileCount),
          h('div', { className: 'rt-spacer' }),
          h('button', { className: 'rt-btn', disabled: busy, onClick: load }, busy ? 'Đang làm mới…' : 'Làm mới')),
        err ? h('div', { className: 'rt-err' }, err) : null,
        h('div', { className: 'rt-artifacts-scroll' },
          h('details', { className: 'rt-card rt-artifacts-section rt-artifacts-section-credentials' },
            h('summary', { className: 'rt-artifacts-summary' }, 'Thông tin xác thực · ' + creds.length + '(mặc định che, bấm để xem)'),
            h('div', { className: 'rt-artifacts-content', role: 'region', tabIndex: 0, 'aria-label': 'Nội dung thông tin xác thực, hỗ trợ cuộn' },
              h(CredentialList, { items: creds }))),
          h('details', { className: 'rt-card rt-artifacts-section rt-artifacts-section-access' },
            h('summary', { className: 'rt-artifacts-summary' }, 'Đã có phiên truy cập · ' + accesses.length),
            h('div', { className: 'rt-artifacts-content', role: 'region', tabIndex: 0, 'aria-label': 'Nội dung phiên truy cập, hỗ trợ cuộn' },
              h(AccessList, { items: accesses }))),
          h('details', { className: 'rt-card rt-artifacts-section rt-artifacts-section-files' },
            h('summary', { className: 'rt-artifacts-summary' }, 'Tệp tấn công · ' + fileCount),
            h('div', { className: 'rt-artifacts-content', role: 'region', tabIndex: 0, 'aria-label': 'Nội dung tệp, hỗ trợ cuộn' },
              h(AttackFilesTab, { engagement: eng, refreshKey: refreshKey })))))
    }

    function FindingsTab(props) {
      const eng = props.engagement
      const refreshKey = props.refreshKey || 0
      const [sev, setSev] = React.useState('')
      const [status, setStatus] = React.useState('')
      const [q, setQ] = React.useState('')
      const [qApplied, setQApplied] = React.useState('')
      const [state, setState] = React.useState({ loading: false, error: null, total: 0, items: [], stats: null })
      const [creds, setCreds] = React.useState([])
      const [accesses, setAccesses] = React.useState([])
      const [files, setFiles] = React.useState([])
      const [openId, setOpenId] = React.useState(null)
      const [msg, setMsg] = React.useState(null)
      /* Sub-tabs: vulns / credentials / sessions (credentials no longer fill the bottom of the vuln page) */
      const [subTab, setSubTab] = React.useState('vulns')
      /* Aggregated by target by default: 322 flat rows are unreadable; show what was taken on which host */
      const [grouped, setGrouped] = React.useState(true)
      const collapse = useCollapse('findings:' + eng)

      const load = () => {
        if (!eng) return
        api({
          op: 'vulns', engagement: eng, severity: sev || undefined,
          status: status || undefined, q: qApplied || undefined, limit: 200,
        }).then((r) => {
          if (!r || r.ok === false) {
            setState({ loading: false, error: (r && r.error) || 'Truy vấn thất bại', total: 0, items: [], stats: null })
            return
          }
          setState({ loading: false, error: null, total: r.total, items: r.items || [], stats: r.stats || null })
        }, (e) => setState({ loading: false, error: String((e && e.message) || e), total: 0, items: [], stats: null }))
        api({ op: 'attackFiles', engagement: eng }).then((r) => setFiles((r && r.items) || []), () => {})
      }
      React.useEffect(load, [eng, sev, status, qApplied, refreshKey])

      const setVulnStatus = (id, next) => {
        setMsg(null)
        api({ op: 'updateVuln', engagement: eng, id: id, patch: { status: next } }).then((r) => {
          if (!r || r.ok === false) { setMsg({ err: (r && r.error) || 'Cập nhật thất bại' }); return }
          setMsg({ ok: 'Đã cập nhật thành "' + (STATUS_LABEL[next] || next) + '"' })
          load()
        }, (e) => setMsg({ err: String((e && e.message) || e) }))
      }

      const stats = (state.stats && state.stats.bySeverity) ? state.stats : { bySeverity: {}, byStatus: {} }
      const needRestart = state.error !== null && String(state.error).indexOf('unknown op') >= 0

      const allFiles = (files || []).flatMap((g) => (g.files || []).map((f) => Object.assign({ target: g.target }, f)))
      const filesByVuln = new Map()
      const orphanFiles = []
      for (const f of allFiles) {
        const vid = f.vuln_id === null || f.vuln_id === undefined ? null : Number(f.vuln_id)
        if (vid === null) { orphanFiles.push(f); continue }
        if (!filesByVuln.has(vid)) filesByVuln.set(vid, [])
        filesByVuln.get(vid).push(f)
      }

      /* ── conclusion row: conclusions only, click a number to filter ────────────────────── */
      const concl = (key, label, value, active, onClick) => h('span', Object.assign({
        key: key, className: 'rt-concl-i' + (active ? ' on' : ''), title: 'Bấm để lọc / bấm lại để bỏ lọc',
      }, clickable(onClick, { label: 'Lọc theo "' + label + '" (' + (value || 0) + ')', expanded: active })),
        h('b', null, String(value || 0)), h('span', null, label))
      const conclusion = h('div', { className: 'rt-concl' },
        concl('conf', 'Đã xác nhận', (stats.byStatus.confirmed || 0), status === 'confirmed', () => setStatus((v) => (v === 'confirmed' ? '' : 'confirmed'))),
        concl('exp', 'Đã khai thác', (stats.byStatus.exploited || 0), status === 'exploited', () => setStatus((v) => (v === 'exploited' ? '' : 'exploited'))),
        concl('crit', 'Nghiêm trọng', (stats.bySeverity.critical || 0), sev === 'critical', () => setSev((v) => (v === 'critical' ? '' : 'critical'))),
        concl('high', 'Nguy hiểm cao', (stats.bySeverity.high || 0), sev === 'high', () => setSev((v) => (v === 'high' ? '' : 'high'))),
        concl('med', 'Nguy hiểm trung bình', (stats.bySeverity.medium || 0), sev === 'medium', () => setSev((v) => (v === 'medium' ? '' : 'medium'))),
        concl('gain', 'Đã có quyền', (stats.withGained || 0), false, () => {}),
        h('div', { className: 'rt-spacer' }),
        h('span', { style: { fontSize: 'var(--ui-text-helper)', color: 'var(--dsw-alias-label-secondary)' } },
          'Mặc định tổng hợp theo mục tiêu · tổng ' + (stats.targetGroups || 0) + ' mục tiêu'))

      const head = h('div', { className: 'rt-vrow head' },
        h('span', null, 'Mức'), h('span', null, 'Lỗ hổng / mã'), h('span', null, 'Mục tiêu'),
        h('span', null, 'Đã lấy được'), h('span', null, 'Trạng thái'), h('span', null, 'Độ tin cậy'))

      /* One vuln (row + expandable detail), shared by the aggregated and flat views */
      const vulnRows = (v, compact) => {
        const out = []
        const gainedList = String(v.gained || '').split(/[, ,;, ; ]/).map((x) => x.trim()).filter(Boolean)
        const open = openId === v.id
        out.push(h('div', {
          key: 'v' + v.id, className: 'rt-vrow', role: 'button', tabIndex: 0,
          style: compact ? { cursor: 'pointer', gridTemplateColumns: '58px minmax(0,1fr) 104px 68px' } : { cursor: 'pointer' },
          onClick: () => setOpenId(open ? null : v.id),
          onKeyDown: (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setOpenId(open ? null : v.id) } },
        },
          h('span', null, h('span', { className: sevClass(v.severity) }, SEV_LABEL[v.severity] || v.severity)),
          h('span', { title: v.title || '' }, h('span', { className: 'rt-sec-caret' }, open ? '▾' : '▸'), (v.cve ? v.cve + ' ' : '') + (v.title || '')),
          compact ? null : h('span', { className: 'rt-mono', title: v.target || '' }, v.target || v.asset_ip || '—'),
          h('span', { title: v.gained || '' },
            gainedList.length
              ? h('span', { className: 'rt-gain', style: { maxWidth: '100%', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', display: 'inline-block' } }, gainedList[0] + (gainedList.length > 1 ? ' +' + (gainedList.length - 1) : ''))
              : h('span', { style: { color: 'var(--dsw-alias-label-secondary)' } }, '—')),
          h('span', null, h('span', { className: 'rt-tag' }, STATUS_LABEL[v.status] || v.status)),
          compact ? null : h('span', null, v.confidence === null || v.confidence === undefined ? '—' : Math.round(v.confidence * 100) + '%')))
        if (openId !== v.id) return out
        out.push(h('div', {
          key: 'vd' + v.id, className: 'rt-vrow',
          style: { cursor: 'default', gridTemplateColumns: '1fr' },
        }, h('div', { className: 'rt-vdetail' },
          h('div', { className: 'rt-kv' }, h('b', null, 'Đã lấy được'),
            gainedList.length
              ? h('span', null, gainedList.map((g, gi) => h('span', { key: 'g' + gi, className: 'rt-gain', style: { marginRight: 6 } }, g)))
              : h('span', { style: { color: 'var(--dsw-alias-label-secondary)' } },
                  'Chưa ghi nhận — sau khi có quyền/kết quả hãy dùng redteam_vuln_update bổ sung gained (ví dụ: quyền máy chủ, đường hầm nội bộ, tài khoản quản trị backend)')),
          h('div', { className: 'rt-kv' }, h('b', null, 'Mục tiêu'), h('span', { className: 'rt-mono', style: { wordBreak: 'break-all' } }, v.target || '—')),
          h('div', { className: 'rt-kv' }, h('b', null, 'Tài sản'), h('span', null, (v.asset_ip || '—') + ' · ' + (v.segment_cidr || ''))),
          h('div', { className: 'rt-kv' }, h('b', null, 'Nguồn'), h('span', null, (v.source || '—') + ' · ' + (v.found_by_agent || '—') + ' · ' + fmt(v.found_at))),
          detailEvidence(v),
          (() => {
            const mine = filesByVuln.get(Number(v.id)) || []
            return h('div', { className: 'rt-kv' }, h('b', null, 'Tệp tấn công'),
              mine.length
                ? h('span', null, mine.map((f, fi) => h('div', { key: 'af' + fi, style: { marginBottom: 3 } },
                    '· ' + (f.kind ? '[' + f.kind + '] ' : '') + (f.name || '(chưa đặt tên)')
                    + (f.description ? ' — ' + f.description : ''),
                    h('div', { className: 'rt-mono', style: { fontSize: 'var(--ui-text-helper)', marginLeft: 12, color: 'var(--dsw-alias-label-secondary)', overflowWrap: 'anywhere' } }, f.path || ''))))
                : h('span', { style: { color: 'var(--dsw-alias-label-secondary)' } },
                    '(không có) Hãy dùng redteam_attack_file_add để lưu trữ script/mã/EXP đã khai thác được lỗ hổng này, kèm vuln_id'))
          })(),
          h('div', { className: 'rt-actions' },
            h('button', { className: 'rt-btn', onClick: (e) => { e.stopPropagation(); setVulnStatus(v.id, 'confirmed') } }, 'Xác nhận'),
            h('button', { className: 'rt-btn', onClick: (e) => { e.stopPropagation(); setVulnStatus(v.id, 'exploited') } }, 'Đã khai thác'),
            h('button', { className: 'rt-btn', onClick: (e) => { e.stopPropagation(); setVulnStatus(v.id, 'false-positive') } }, 'Báo động giả'),
            h('button', { className: 'rt-btn', onClick: (e) => { e.stopPropagation(); setVulnStatus(v.id, 'fixed') } }, 'Đã vá')))))
        return out
      }

      const rows = []
      if (grouped) {
        /* Group by target: first what was taken on which host, then drill into the individual vulns */
        const groups = new Map()
        for (const v of state.items) {
          const key = targetKeyOf(v)
          if (!groups.has(key)) groups.set(key, [])
          groups.get(key).push(v)
        }
        const SEV_RANK = { critical: 0, high: 1, medium: 2, low: 3, info: 4 }
        const list = Array.from(groups.entries()).map(([key, vs]) => ({
          key,
          vulns: vs,
          top: vs.slice().sort((a, b) => (SEV_RANK[a.severity] ?? 9) - (SEV_RANK[b.severity] ?? 9))[0],
          gained: Array.from(new Set(vs.flatMap((v) => String(v.gained || '').split(/[, ,;, ; ]/).map((x) => x.trim()).filter(Boolean)))),
          exploited: vs.filter((v) => v.status === 'exploited').length,
        })).sort((a, b) => (SEV_RANK[a.top.severity] ?? 9) - (SEV_RANK[b.top.severity] ?? 9) || b.vulns.length - a.vulns.length)
        for (const g of list) {
          const key = 'target:' + g.key
          const defOpen = false
          rows.push(h(Section, {
            key: 'sec:' + g.key, tone: 'target',
            title: g.key,
            count: g.vulns.length + ' lỗ hổng',
            sub: [
              SEV_LABEL[g.top.severity] || g.top.severity,
              g.exploited ? 'Đã khai thác ' + g.exploited : null,
              g.top.asset_ip && g.top.asset_ip !== g.key ? 'Tài sản ' + g.top.asset_ip : null,
            ].filter(Boolean).join(' · '),
            right: g.gained.length
              ? g.gained.slice(0, 2).join(' / ') + (g.gained.length > 2 ? ' +' + (g.gained.length - 2) : '')
              : 'Chưa ghi nhận quyền',
            open: collapse.isOpen(key, defOpen),
            onToggle: collapse.toggle(key, defOpen),
          }, g.vulns.map((v) => vulnRows(v, true))))
        }
        if (!list.length && !state.loading && !state.error) {
          rows.push(h('div', { key: 'none', className: 'rt-empty' }, 'Chưa có bản ghi lỗ hổng'))
        }
      } else {
        for (const v of state.items) rows.push(...vulnRows(v))
      }

      const toolbar = h('div', { className: 'rt-toolbar' },
        h('input', {
          className: 'rt-input', style: { flex: '1 1 140px' }, placeholder: 'Tìm tiêu đề / CVE / mục tiêu (Enter)',
          value: q, onChange: (e) => setQ(e.target.value),
          onKeyDown: (e) => { if (e.key === 'Enter') setQApplied(q) },
        }),
        h('button', { className: 'rt-btn', onClick: () => setQApplied(q) }, 'Tìm kiếm'),
        h('select', { className: 'rt-input', value: sev, onChange: (e) => setSev(e.target.value) },
          h('option', { value: '' }, 'Tất cả mức'),
          h('option', { value: 'critical' }, 'Nghiêm trọng'),
          h('option', { value: 'high' }, 'Nguy hiểm cao'),
          h('option', { value: 'medium' }, 'Nguy hiểm trung bình'),
          h('option', { value: 'low' }, 'Nguy hiểm thấp'),
          h('option', { value: 'info' }, 'Thông tin')),
        h('select', { className: 'rt-input', value: status, onChange: (e) => setStatus(e.target.value) },
          h('option', { value: '' }, 'Tất cả trạng thái'),
          h('option', { value: 'candidate' }, 'Chờ xác minh'),
          h('option', { value: 'confirmed' }, 'Đã xác nhận'),
          h('option', { value: 'exploited' }, 'Đã khai thác'),
          h('option', { value: 'false-positive' }, 'Báo động giả'),
          h('option', { value: 'fixed' }, 'Đã vá')))

      const credSection = h('div', null,
        h('div', { className: 'rt-section' }, 'Thông tin xác thực · ' + creds.length + (creds.length ? '(hiện bản rõ, chú ý khi chia sẻ màn hình/quay màn hình)' : '')),
        creds.length
          ? h('div', { style: { padding: '4px 10px 0' } }, creds.map((c) => h('div', { key: 'c' + c.id, className: 'rt-cred' },
              h('div', { className: 'rt-cred-head' },
                h('span', { className: 'rt-cred-host' }, c.host),
                c.username ? h('span', { className: 'rt-tag' }, c.username) : null,
                h('span', { className: 'rt-tag rt-tag-passive' }, c.secret_type || 'password'),
                c.privilege ? h('span', { className: 'rt-tag rt-tag-active' }, c.privilege) : null,
                h('div', { className: 'rt-spacer' }),
                h('button', {
                  className: 'rt-btn', style: { padding: '0 12px', fontSize: 'var(--ui-text-control)' },
                  onClick: (e) => { e.stopPropagation(); copyText(String(c.secret_value || '')) },
                }, 'Sao chép')),
              c.secret_value
                ? h('div', { className: 'rt-secret', title: 'Bấm để chọn tất cả' }, c.secret_value)
                : h('div', { className: 'rt-secret-none' }, 'Chưa ghi bản rõ — hãy bổ sung secret_value của redteam_credential_add để bảng hiển thị trực tiếp'),
              h('div', { className: 'rt-cred-meta' },
                [c.source ? 'Nguồn ' + c.source : null,
                  c.tool ? 'Công cụ ' + c.tool : null,
                  c.secret_ref ? 'Bằng chứng ' + c.secret_ref : null,
                  c.found_by_agent ? 'by ' + c.found_by_agent : null,
                  c.found_at ? fmt(c.found_at) : null].filter(Boolean).join(' · ')),
              c.note ? h('div', { className: 'rt-cred-meta' }, 'Ghi chú: ' + c.note) : null)))
          : h('div', { className: 'rt-empty' }, 'Chưa có thông tin xác thực (sau khi có mật khẩu/khóa/hash hãy dùng redteam_credential_add để lưu, tái sử dụng trong vài giây)'))

      const accessSection = h('div', null,
        h('div', { className: 'rt-section' }, 'Đã có phiên truy cập · ' + accesses.length),
        accesses.length
          ? accesses.map((a) => h('div', { key: 'a' + a.id, className: 'rt-vrow', style: { cursor: 'default', gridTemplateColumns: '1fr 110px 80px 80px 1fr' } },
              h('span', { className: 'rt-mono' }, a.host),
              h('span', null, a.username || '—'),
              h('span', null, h('span', { className: 'rt-tag rt-tag-active' }, a.method || '—')),
              h('span', null, a.privilege || '—'),
              h('span', { className: 'rt-mono', title: a.session_ref || '' }, a.session_ref || '—')))
          : h('div', { className: 'rt-empty' }, 'Chưa có'))

      const subTabBtn = (key, label, n) => h('span', Object.assign({
        className: 'rt-subtab' + (subTab === key ? ' on' : ''),
      }, clickable(() => setSubTab(key), { label: label + '(' + n + ')', expanded: subTab === key })),
      label + ' ' + n)

      return h('div', { className: 'rt-main' }, toolbar, conclusion,
        h('div', { className: 'rt-subtabs' },
          subTabBtn('vulns', 'Lỗ hổng', state.total || 0),
          h('div', { className: 'rt-spacer' }),
          grouped ? h('button', {
            className: 'rt-btn', title: 'Mở rộng tất cả mục tiêu',
            onClick: () => collapse.setAll((state.items || []).map((v) => 'target:' + targetKeyOf(v)), true),
          }, 'Mở rộng tất cả') : null,
          grouped ? h('button', {
            className: 'rt-btn', title: 'Thu gọn tất cả mục tiêu',
            onClick: () => collapse.setAll((state.items || []).map((v) => 'target:' + targetKeyOf(v)), false),
          }, 'Thu gọn tất cả') : null,
          h('button', {
            className: 'rt-btn' + (grouped ? ' rt-btn-primary' : ''),
            title: grouped ? 'Hiện tại: tổng hợp theo mục tiêu (xem máy nào bị đánh hạ và lấy được gì trước)' : 'Hiện tại: liệt kê phẳng từng lỗ hổng',
            onClick: () => setGrouped((g) => !g),
          }, grouped ? 'Tổng hợp theo mục tiêu' : 'Danh sách phẳng')),
        msg ? h('div', { className: msg.err ? 'rt-err' : 'rt-foot' }, msg.err || msg.ok) : null,
        needRestart ? h('div', { className: 'rt-empty' }, 'Mã host của mô-đun này đã cập nhật, cần khởi động lại host hiện tại (exe chính thức / bản cộng đồng / dsh web) một lần để có hiệu lực') : null,
        state.error && !needRestart ? h('div', { className: 'rt-err' }, state.error) : null,
        h('div', { className: 'rt-table' }, grouped ? null : head, rows,
                !state.loading && !state.items.length && !state.error ? h('div', { className: 'rt-empty' }, 'Chưa có bản ghi lỗ hổng') : null))
    }

    /* ---------------------------------------------------------- attack chain */
    const STAGE_LABEL = { recon: 'Thu thập thông tin', vuln: 'Phát hiện lỗ hổng', exploit: 'Khai thác lỗ hổng', access: 'Có được quyền', pivot: 'Đột phá mạng nội bộ', data: 'Dữ liệu nhạy cảm', other: 'Khác' }

    /* ---------------------------------------------------------- attack chain (five stages) */
    /**
     * String the chain by attack-surface position:
     * ① recon → ② internet asset access → ③ boundary break → ④ internal asset access → ⑤ target access.
     * Each stage says two things: points gained here (and total), and the assets/tunnels involved.
     * A = vertical chain (detailed); B = horizontal chain (whole picture on one screen).
     */
    function ChainTab(props) {
      const eng = props.engagement
      const refreshKey = props.refreshKey || 0
      const [data, setData] = React.useState(null)
      const [err, setErr] = React.useState(null)
      const [loading, setLoading] = React.useState(false)
      const [view, setView] = React.useState('A')
      const [openId, setOpenId] = React.useState(null)

      const load = () => {
        if (!eng) return
        setLoading(true)
        api({ op: 'scoreChain', engagement: eng }).then((r) => {
          setLoading(false)
          if (!r || r.ok === false) { setErr((r && r.error) || 'Đọc thất bại'); return }
          setErr(null); setData(r)
        }, (e) => { setLoading(false); setErr(String((e && e.message) || e)) })
      }
      React.useEffect(load, [eng, refreshKey])

      const stages = (data && data.stages) || []
      const summary = (data && data.summary) || null
      const toggle = (id) => setOpenId((cur) => (cur === id ? null : id))
      const CIRCLED = ['①', '②', '③', '④', '⑤', '⑥']

      /* details of one score */
      const hitDetail = (x) => h('div', { className: 'rt-flow-detail' },
        h('div', { className: 'rt-kv' }, h('b', null, 'Mục tiêu'), h('span', { className: 'rt-mono', style: { wordBreak: 'break-all' } }, x.target || '—')),
        x.asset_ip ? h('div', { className: 'rt-kv' }, h('b', null, 'Tài sản'), h('span', { className: 'rt-mono' }, x.asset_ip)) : null,
        x.vuln_title ? h('div', { className: 'rt-kv' }, h('b', null, 'Khai thác lỗ hổng'), h('span', null, [x.vuln_cve, x.vuln_title].filter(Boolean).join(' '))) : null,
        h('div', { className: 'rt-kv' }, h('b', null, 'Số lần'), h('span', null,
          'Cùng loại lần thứ ' + x.nth_of_point + ' · +' + (x.points || 0) + ' điểm')),
        h('div', { className: 'rt-kv' }, h('b', null, 'Ghi nhận'), h('span', null, fmt(x.recorded_at) + (x.recorded_by ? ' · ' + x.recorded_by : ''))),
        x.evidence ? h(Clip, { label: 'Kết quả và bằng chứng', text: x.evidence }) : null)

      const hitRow = (x) => h('div', {
        key: 'h' + x.id,
        className: 'rt-ap-hit' + (openId === x.id ? ' open' : ''),
        role: 'button', tabIndex: 0,
        onClick: () => toggle(x.id),
        onKeyDown: (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggle(x.id) } },
      },
        h('div', { className: 'rt-ap-hit-head' },
          h('span', { className: 'rt-ap-pts' + (x.counted ? '' : ' uncounted'), title: x.capped_reason || undefined },
            '+' + (x.counted ? (x.points || 0) : 0)),
          h('span', { className: 'rt-ap-hit-name' }, x.point_name),
          x.capped ? h('span', { className: 'rt-tag rt-tag-warn', title: x.capped_reason || 'Cùng một tài sản cùng một cổng chỉ tính mục có điểm cao nhất' }, 'Dịch vụ đã đạt tối đa · không tính điểm') : null,
          x.nth_of_point > 1 ? h('span', { className: 'rt-ap-nth' }, 'Lần thứ ' + x.nth_of_point + ' lần') : null,
          h('span', { className: 'rt-ap-hit-target' }, x.target || x.asset_ip || '—')),
        x.action
          ? h('div', { className: 'rt-ap-act' + (x.action_inferred ? ' inferred' : '') },
              'Hành động: ' + (x.action.title || '(bước chưa đặt tên)') + (x.action_inferred ? '(suy luận)' : ''))
          : null,
        openId === x.id ? hitDetail(x) : null)

      /* An asset row (recon stage / assets touched per stage) */
      const assetRow = (a) => h('div', { key: 'a' + a.id, className: 'rt-ap-asset' },
        h('span', { className: 'rt-scope rt-scope-' + (a.scope === 'internal' ? 'internal' : 'external') },
          a.scope === 'internal' ? 'Nội' : 'Ngoại'),
        h('span', { className: 'rt-mono', style: { fontWeight: 600 } }, a.ip),
        a.segment_cidr ? h('span', { className: 'rt-ap-nth' }, a.segment_cidr) : null,
        h('span', { className: 'rt-ap-nth' }, 'Cổng ' + (a.open_ports || 0)),
        a.vulns ? h('span', { className: 'rt-ap-nth' }, 'Lỗ hổng ' + a.vulns) : null,
        a.priority ? h('span', { className: 'rt-tag' }, 'Dễ tấn công ' + a.priority) : null,
        h('div', { className: 'rt-spacer' }),
        h('span', { className: 'rt-ap-pts' }, '+' + (a.points || 0) + ' điểm'),
        h('span', { className: 'rt-ap-nth' }, (a.hits || 0) + ' lần'))

      /* The chain states where we got to and how many points: no tactics or tool lists,
         those are execution details that drown the score and asset information. */

      /* ── A: vertical attack chain ───────────────────────────────────────────────── */
      const stageA = (st, i) => {
        const isRecon = st.code === 'recon'
        const body = []
        if (isRecon) {
          body.push(h('div', { key: 'at', className: 'rt-ap-sub' }, 'Tài sản đã ghi điểm · ' + st.assetCount + ' máy'))
          body.push(h('div', { key: 'al', className: 'rt-ap-assets' },
            st.assets.length ? st.assets.map(assetRow) : h('div', { className: 'rt-ap-none' }, 'Chưa có tài sản nào tạo điểm')))
        } else {
          body.push(h('div', { key: 'ht', className: 'rt-ap-sub' },
            'Giai đoạn này trúng ' + st.hits + ' lần' + (st.points ? ' · +' + st.points + ' điểm' : '')))
          body.push(h('div', { key: 'hl', className: 'rt-ap-hits' },
            st.items.length ? st.items.map(hitRow) : h('div', { className: 'rt-ap-none' }, 'Giai đoạn này chưa ghi điểm')))
          if (st.code === 'boundary') {
            const selfOnly = (st.tunnels_self_only || []).length
            body.push(h('div', { key: 'tt', className: 'rt-ap-sub' },
              'Kênh vượt ranh giới mục tiêu · ' + st.tunnels.length + ' mục' + (selfOnly ? '(còn ' + selfOnly + ' mục chỉ nằm trên VPS/máy chủ tự dựng, không tính là đột phá)' : '')))
            if (selfOnly && st.tunnels.length === 0) {
              body.push(h('div', { key: 'tw', className: 'rt-ap-none' },
                '⚠️ Các kênh hiện có đều nằm trên máy chủ của mình, chưa chạm tới mục tiêu — không tính đột phá ranh giới. Cần kênh do phía mục tiêu khởi tạo (reverse shell về phía tôi / chạy frp client trên mục tiêu / suo5 qua WebShell của mục tiêu).'))
            }
            body.push(h('div', { key: 'tl', className: 'rt-ap-tunnels' },
              st.tunnels.length
                ? st.tunnels.map((t) => h('div', { key: 't' + t.id, className: 'rt-ap-tunnel' },
                    h('span', { className: 'rt-tag rt-tag-passive' }, t.kind || 'tunnel'),
                    h('span', { className: 'rt-mono', style: { fontWeight: 600 } }, t.listen || '—'),
                    h('span', {
                      className: 'rt-tag ' + (t.status === 'active' ? 'rt-tag-live' : ''),
                      style: t.status === 'active' ? {} : { opacity: .7 },
                    }, t.status === 'active' ? 'Sẵn dùng' : (t.status || 'Không rõ')),
                    h('span', { className: 'rt-ap-nth', style: { minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis' } },
                      'Tiếp cận ' + (t.reach || '—'))))
                : h('div', { className: 'rt-ap-none' }, 'Chưa thiết lập đường hầm (sau khi dựng xong dùng redteam_tunnel_add để đăng ký)')))
          }
          if (st.assets.length && st.code !== 'boundary') {
            body.push(h('div', { key: 'at', className: 'rt-ap-sub' }, 'Tài sản liên quan · ' + st.assetCount + ' máy'))
            body.push(h('div', { key: 'al', className: 'rt-ap-assets' }, st.assets.map(assetRow)))
          }
        }

        return h('div', { key: 'st' + st.code, className: 'rt-ap-stage' },
          h('div', { className: 'rt-ap-head', style: { borderLeftColor: st.color } },
            h('span', { className: 'rt-ap-no', style: { background: st.color } }, CIRCLED[i] || ('0' + (i + 1))),
            h('span', { className: 'rt-ap-name' }, st.name),
            st.subtitle ? h('span', { className: 'rt-ap-en' }, st.subtitle) : null,
            h('div', { className: 'rt-spacer' }),
            st.points > 0 ? h('span', { className: 'rt-ap-pts', style: { background: st.color + '22', color: st.color, borderColor: st.color + '66' } }, '+' + st.points) : null,
            h('span', { className: 'rt-ap-cum' }, 'Tích lũy ' + st.cumulative + ' điểm')),
          h('div', { className: 'rt-ap-goal', style: { borderLeftColor: st.color } },
            h('span', { className: 'rt-ap-goal-tag', style: { color: st.color, borderColor: st.color + '66' } }, 'Mục tiêu giai đoạn'),
            h('span', null, st.goal)),
          h('div', { className: 'rt-ap-result', style: { borderLeftColor: st.color } }, body),
          i < stages.length - 1
            ? h('div', { className: 'rt-ap-trans' },
                h('span', { className: 'rt-flow-arrow' }, '▼'),
                st.transition ? h('span', { className: 'rt-ap-trans-t' }, st.transition) : null,
                h('span', { className: 'rt-ap-trans-t', style: { marginLeft: 'auto' } }, 'Tích lũy ' + st.cumulative + ' điểm'))
            : h('div', { className: 'rt-ap-trans' },
                h('span', { className: 'rt-flow-arrow' }, '▼'),
                h('span', { className: 'rt-ap-trans-t' }, 'Tổng ' + ((summary && summary.points) || 0) + ' điểm')))
      }

      /* ── B: horizontal attack chain (one screen) ───────────────────────────────── */
      const stageB = (st, i) => h('div', { key: 'c' + st.code, className: 'rt-ap-col' },
        i > 0 ? h('span', { className: 'rt-ap-col-arrow' }, '▶') : null,
        h('div', { className: 'rt-hcol', style: { borderTopColor: st.color } },
          h('div', { className: 'rt-ap-head', style: { borderLeftColor: st.color, padding: '5px 8px' } },
            h('span', { className: 'rt-ap-no', style: { background: st.color, width: 16, height: 16, fontSize: 'var(--ui-text-helper)' } }, String(i + 1)),
            h('span', { className: 'rt-ap-name', style: { fontSize: 'var(--ui-text-helper)' } }, st.name),
            h('div', { className: 'rt-spacer' }),
            h('span', { className: 'rt-ap-cum', style: { fontWeight: 600 } }, st.cumulative)),
          h('div', { className: 'rt-hcol-goal', title: st.goal }, st.goal),
          h('div', { className: 'rt-hcol-body' },
            st.code === 'boundary'
              ? h('div', null,
                  h('div', { className: 'rt-hcol-hit' }, h('span', { className: 'rt-hcol-pts' }, '+' + st.points), h('span', { className: 'rt-hcol-name' }, 'Đường hầm ' + st.tunnels.length + ' mục')),
                  st.tunnels.slice(0, 3).map((t) => h('div', { key: 't' + t.id, className: 'rt-hcol-sub' }, '▸ ' + (t.kind || '') + ' ' + (t.listen || ''))))
              : st.code === 'recon'
                ? h('div', null,
                    h('div', { className: 'rt-hcol-hit' }, h('span', { className: 'rt-hcol-pts' }, st.assetCount), h('span', { className: 'rt-hcol-name' }, ' tài sản đã ghi điểm')),
                    st.assets.slice(0, 6).map((a) => h('div', { key: 'a' + a.id, className: 'rt-hcol-sub', title: a.ip + '  +' + a.points + ' điểm' },
                      (a.scope === 'internal' ? 'Nội ' : 'Ngoại ') + a.ip + '  +' + a.points)))
                : h('div', null,
                    h('div', { className: 'rt-hcol-hit' }, h('span', { className: 'rt-hcol-pts' }, '+' + st.points), h('span', { className: 'rt-hcol-name' }, st.hits + ' lần trúng')),
                    st.items.slice(0, 6).map((x) => h('div', { key: 'c' + x.id, className: 'rt-hcol-sub', title: x.point_name + '  ' + (x.target || '') },
                      h('span', { className: 'rt-hcol-pts' }, '+' + x.points), h('span', { className: 'rt-hcol-name' }, x.point_name))),
                    st.items.length > 6 ? h('div', { className: 'rt-hcol-none' }, '…còn ' + (st.items.length - 6) + ' lần') : null,
                    st.assetCount ? h('div', { className: 'rt-hcol-none' }, 'Liên quan ' + st.assetCount + ' tài sản') : null))))

      return h('div', { className: 'rt-main' },
        h('div', { className: 'rt-toolbar' },
          h('span', { style: { fontWeight: 600 } }, 'Chuỗi tấn công'),
          h('span', { className: 'rt-tag', style: { fontSize: 'var(--ui-text-helper)' } }, 'Thu thập thông tin → quyền tài sản internet → đột phá ranh giới → quyền tài sản nội bộ → quyền mục tiêu'),
          summary ? h('span', { className: 'rt-tag rt-tag-live' }, 'Tổng điểm ' + summary.points + ' điểm') : null,
          h('div', { className: 'rt-spacer' }),
          h('button', { className: 'rt-btn' + (view === 'A' ? ' rt-btn-primary' : ''), title: 'Chuỗi tấn công dọc: xem chi tiết từng giai đoạn theo thứ tự xuống', onClick: () => setView('A') }, 'Liên kết A'),
          h('button', { className: 'rt-btn' + (view === 'B' ? ' rt-btn-primary' : ''), title: 'Chuỗi tấn công ngang: xem cả năm giai đoạn trong một màn hình', onClick: () => setView('B') }, 'Liên kết B'),
          h('button', { className: 'rt-btn', disabled: loading, onClick: load }, loading ? 'Đang tải…' : 'Làm mới')),
        err ? h('div', { className: 'rt-err' }, err) : null,
        !stages.length && !err && data !== null
          ? h('div', { className: 'rt-empty' }, 'Chưa có bản ghi điểm. Sau khi có kết quả hãy dùng redteam_score_hit để ghi điểm, chuỗi này mới mọc ra.')
          : view === 'A'
            ? h('div', { className: 'rt-ap' }, stages.map(stageA))
            : h('div', { className: 'rt-ap-h' }, stages.map(stageB)))
    }

    /* ---------------------------------------------------------- score reproduction report */
    /**
     * Report grouping fallback: when the host returns only flat items, group them in attack-chain order
     * using scoreChain stages. The link is the shared score_hit id —— each item carries a stage_code
     * and scoreReport carries the same id. So with an older host build or missing stage rows,
     * the report page renders properly instead of falsely reporting "no deliverable results yet".
     */
    function groupByStage(reportItems, chain) {
      const byId = new Map((reportItems || []).map((x) => [x.id, x]))
      const groups = []
      const stageList = (chain && chain.stages) || []
      stageList.forEach((st, si) => {
        const items = (st.items || []).map((x) => byId.get(x.id)).filter(Boolean)
        if (items.length === 0) return
        groups.push({ code: st.code, name: st.name, color: st.color || '#64748b',
          ordinal: st.ordinal || si + 1, points: st.points || 0, cumulative: st.cumulative || 0, items })
      })
      /* scoreChain carries no stage info at all: put the score under "other" at minimum, never drop the item */
      const grouped = new Set(groups.reduce((acc, g) => acc.concat(g.items.map((x) => x.id)), []))
      const rest = (reportItems || []).filter((x) => !grouped.has(x.id))
      if (rest.length > 0) {
        groups.push({ code: 'other', name: 'Điểm khác', color: '#64748b', ordinal: groups.length + 1,
          points: rest.reduce((n, x) => n + (x.counted ? x.points : 0), 0),
          cumulative: 0, items: rest })
      }
      return groups
    }

    /**
     * Page structure follows the delivery template exactly:
     *   1. asset ownership proof (internet / internal entries)
     *   2. score summary tables (master table + sections 2.1-2.4)
     *   3. score point reproduction (internet / boundary tunnels / internal ranges / target)
     * Both the page and the downloaded Markdown come from the host report model, so the fields cannot drift.
     */
    function ReportV2(props) {
      const { report, eng, mdText, busy, load, copy, download, msg } = props
      const summary = report.summary || {}
      const table = (headers, rows) => {
        const head = h('thead', null, h('tr', null, headers.map((v, i) => h('th', { key: 'h' + i }, v))))
        const body = h('tbody', null, (rows || []).map((row, ri) => h('tr', { key: 'r' + ri },
          row.map((v, ci) => h('td', { key: 'c' + ci }, v === null || v === undefined || v === '' ? '—' : v)))))
        return h('div', { className: 'rt-r2-table-wrap' },
          h('table', { className: 'rt-r2-table' }, head, body))
      }
      const proofCard = (g) => h('div', { className: 'rt-r2-proof', key: 'proof' + (g.asset.id || g.asset.ip) },
        h('div', { className: 'rt-r2-proof-head' },
          h('b', { className: 'rt-mono' }, g.asset.ip || g.asset.primary_name || 'Tài sản chưa đặt tên'),
          g.asset.primary_name ? h('span', { className: 'rt-r2-muted' }, g.asset.primary_name) : null,
          h('div', { className: 'rt-spacer' }),
          h('span', { className: 'rt-tag' }, g.type),
          h('span', { className: 'rt-tag ' + (g.strength === 'Mạnh' ? 'rt-tag-live' : 'rt-tag-warn') }, 'Chứng minh ' + g.strength)),
        h('div', { className: 'rt-r2-proof-line' }, h('b', null, 'Bằng chứng quy thuộc '), g.proof || 'Chờ bổ sung'),
        (g.shots || []).length > 0
          ? h(ShotStrip, { eng: eng, shots: g.shots, total: g.shots.length, title: 'Ảnh chụp quy thuộc' })
          : h('div', { className: 'rt-r2-empty' }, 'Ảnh chụp quy thuộc chờ bổ sung'))
      const proofSection = (title, list) => h('div', null,
        h('h3', { className: 'rt-r2-h3' }, title),
        (list || []).length === 0
          ? h('div', { className: 'rt-r2-empty' }, 'Chưa thu thập được bằng chứng tài sản tương ứng.')
          : h('div', { className: 'rt-r2-proof-grid' }, list.map(proofCard)))
      const code = (text, label, lang) => h('div', { className: 'rt-r2-code' },
        h('div', { className: 'rt-r2-code-head' },
          h('span', null, label), h('div', { className: 'rt-spacer' }),
          h('button', { className: 'rt-btn', onClick: () => copy(String(text || ''), label) }, 'Sao chép')),
        h('pre', { className: 'rt-r2-pre' }, String(text || '')))
      const reproItem = (x, heading) => h('div', { className: 'rt-r2-item', key: 'ri' + heading },
        h('h5', { className: 'rt-r2-h5' }, heading + ' ' + (x.target || x.asset_ip || '')),
        h('div', { className: 'rt-r2-item-line' },
          h('b', null, 'Mô tả lỗ hổng '),
          x.vuln ? [x.vuln.cve, x.vuln.title].filter(Boolean).join(' ') : (x.how || x.point_name)),
        x.vuln_source === 'step' ? h('div', { className: 'rt-r2-muted' }, 'Lỗ hổng liên kết từ bước tấn công, chưa điền rõ khi ghi điểm') : null,
        x.evidence ? h('div', { className: 'rt-r2-item-line' }, h('b', null, 'Kết quả '), x.evidence) : null,
        x.replay_cmd ? code(x.replay_cmd, /^(powershell|pwsh)/i.test(x.replay_cmd) ? 'PowerShell' : 'Bash / lệnh', 'cmd') : null,
        (x.requests || []).slice(0, 3).map((q, qi) => q.request ? code(q.request, 'Yakit / gói tin HTTP ' + (qi + 1), 'http') : null),
        (!x.replay_cmd && !(x.requests || []).some((q) => q.request))
          ? h('div', { className: 'rt-r2-gap' }, 'Thiếu tái hiện: chưa lưu lại lệnh thật hoặc gói tin HTTP.') : null,
        (x.attack_files || []).length > 0
          ? h('div', { className: 'rt-r2-item-line' }, h('b', null, 'Tệp tấn công '),
              h('span', { className: 'rt-mono' }, x.attack_files.map((f) => f.path).join(', '))) : null,
        (x.steps || []).some((s) => s.evidence_ref)
          ? h('div', { className: 'rt-r2-item-line' }, h('b', null, 'Tệp bằng chứng '),
              h('span', { className: 'rt-mono' }, Array.from(new Set(x.steps.map((s) => s.evidence_ref).filter(Boolean))).join(', '))) : null,
        (x.shots || []).length > 0 ? h(ShotStrip, { eng: eng, shots: x.shots, total: x.shots.length, title: 'Ảnh chụp tái hiện' }) : null,
        (x.gaps || []).length > 0 ? h('div', { className: 'rt-r2-gap' }, 'Tài liệu tái hiện: ' + x.gaps.join('; ')) : null)
      const reproList = (list, headingPrefix, kind) => (list || []).map((g, i) => {
        if (kind === 'boundary') {
          return h('div', { className: 'rt-r2-group', key: 'b' + i },
            h('h4', { className: 'rt-r2-h4' }, headingPrefix + (i + 1) + ' đường hầm' + (i + 1)),
            h('div', { className: 'rt-r2-item-line' }, h('b', null, 'Điểm vào '), h('span', { className: 'rt-mono' }, g.entry || '—')),
            g.tunnel
              ? h('div', { className: 'rt-r2-item-line' }, h('b', null, 'Đường hầm '), h('span', { className: 'rt-mono' },
                  (g.tunnel.kind || 'socks5') + ' ' + (g.tunnel.listen || '') + (g.tunnel.reach ? ' → ' + g.tunnel.reach : '')))
              : h('div', { className: 'rt-r2-gap' }, 'Thiếu bản ghi đường hầm, cần bổ sung bằng chứng dựng kênh.'),
            g.tunnel && g.tunnel.command ? code(g.tunnel.command, 'Lệnh thiết lập đường hầm', 'cmd') : null,
            g.items.map((x, j) => reproItem(x, headingPrefix + (i + 1) + '.' + (j + 1))))
        }
        if (kind === 'internet' || kind === 'target') {
          return h('div', { className: 'rt-r2-group', key: 'g' + i },
            h('h4', { className: 'rt-r2-h4' }, headingPrefix + (i + 1) + ' ' + (g.asset.ip || g.asset.primary_name || 'Tài sản chưa đặt tên')),
            g.items.map((x, j) => reproItem(x, headingPrefix + (i + 1) + '.' + (j + 1))))
        }
        return h('div', { className: 'rt-r2-group', key: 's' + i },
          h('h4', { className: 'rt-r2-h4' }, headingPrefix + (i + 1) + ' ' + (g.label || 'Dải mạng') + ' “' + (g.cidr || 'Dải mạng chưa quy thuộc') + '”'),
          (g.assets || []).map((a, ai) => h('div', { className: 'rt-r2-asset', key: 'a' + ai },
            h('h5', { className: 'rt-r2-h5' }, (a.asset.ip || a.asset.primary_name || 'Tài sản chưa đặt tên')),
            a.items.map((x, xi) => reproItem(x, headingPrefix + (i + 1) + '.' + (ai + 1) + '.' + (xi + 1))))))
      })
      const stageSection = (s, i) => {
        const code = s.code
        const list = (report.stage_tables && report.stage_tables[code]) || []
        const headers = code === 'internet' ? ['Số thứ tự', 'Mục tính điểm', 'Điểm số', 'URL', 'Thông tin đăng nhập']
          : code === 'boundary' ? ['Số thứ tự', 'Mục tính điểm', 'Điểm số', 'Điểm vào internet']
            : ['Số thứ tự', 'Mục tính điểm', 'Điểm số', 'Tài sản', 'Thông tin xác thực']
        const rows = list.map((r) => code === 'internet' ? [r.seq, r.point_name, '+' + r.points, r.url, r.credential]
          : code === 'boundary' ? [r.seq, r.point_name, '+' + r.points, r.entry]
            : [r.seq, r.point_name, '+' + r.points, r.asset, r.credential])
        return h('div', { key: 'st' + code },
          h('h3', { className: 'rt-r2-h3' }, '2.' + (i + 1) + ' ' + s.name + '(' + s.count + ' mục / +' + s.points + ' điểm)'),
          list.length === 0 ? h('div', { className: 'rt-r2-empty' }, 'Giai đoạn này không có mục ghi điểm.') : table(headers, rows))
      }
      return h('div', { className: 'rt-main rt-r2' },
        h('div', { className: 'rt-toolbar rt-r2-toolbar' },
          h('span', { style: { fontWeight: 600 } }, 'Báo cáo điểm red-team'),
          h('span', { className: 'rt-tag rt-tag-live' }, 'Tổng ' + summary.points + ' điểm'),
          h('span', { className: 'rt-tag' }, summary.count + ' mục ghi điểm'),
          h('span', { className: 'rt-tag' + (summary.incomplete ? ' rt-tag-warn' : ' rt-tag-live') }, 'Có thể tái hiện ' + (summary.count - (summary.incomplete || 0)) + '/' + summary.count),
          h('div', { className: 'rt-spacer' }),
          h('button', { className: 'rt-btn', disabled: busy || !mdText, onClick: () => copy(mdText, 'Toàn bộ báo cáo') }, 'Sao chép toàn văn'),
          h('button', { className: 'rt-btn', disabled: busy || !mdText, onClick: () => download(mdText, report.target || eng) }, 'Tải .md'),
          h('button', { className: 'rt-btn', disabled: busy, onClick: load }, busy ? 'Đang tạo…' : 'Tạo lại')),
        msg ? h('div', { className: msg.err ? 'rt-err' : 'rt-foot' }, msg.err || msg.ok) : null,
        h('div', { className: 'rt-r2-scroll' },
          h('section', { className: 'rt-r2-section', id: 'rt-r2-assets' },
            h('h2', { className: 'rt-r2-h2' }, 'Một, chứng minh quy thuộc tài sản'),
            proofSection('1.1 Chứng minh quy thuộc tài sản internet', report.asset_proof && report.asset_proof.internet),
            proofSection('1.2 Chứng minh quy thuộc tài sản điểm vào nội bộ', report.asset_proof && report.asset_proof.internal_entry)),
          h('section', { className: 'rt-r2-section', id: 'rt-r2-scores' },
            h('h2', { className: 'rt-r2-h2' }, 'Hai, bảng tổng hợp điểm'),
            table(['Giai đoạn', 'Mục tính điểm', 'Điểm'], (report.stage_summary || []).map((s) => [s.name, s.count, '+' + s.points])),
            (report.stage_summary || []).map(stageSection)),
          h('section', { className: 'rt-r2-section', id: 'rt-r2-repro' },
            h('h2', { className: 'rt-r2-h2' }, 'Ba, tái hiện mục tính điểm'),
            h('h3', { className: 'rt-r2-h3' }, '3.1 Tái hiện điểm tài sản internet'),
            (report.repro && report.repro.internet || []).length === 0 ? h('div', { className: 'rt-r2-empty' }, 'Không có mục điểm tài sản internet.') : reproList(report.repro.internet, '3.1.', 'internet'),
            h('h3', { className: 'rt-r2-h3' }, '3.2 Tái hiện đột phá ranh giới internet'),
            (report.repro && report.repro.boundary || []).length === 0 ? h('div', { className: 'rt-r2-empty' }, 'Không có mục điểm đột phá ranh giới.') : reproList(report.repro.boundary, '3.2.', 'boundary'),
            h('h3', { className: 'rt-r2-h3' }, '3.3 Tái hiện điểm tài sản nội bộ'),
            (report.repro && report.repro.internal_segments || []).length === 0 ? h('div', { className: 'rt-r2-empty' }, 'Không có mục điểm tài sản nội bộ.') : reproList(report.repro.internal_segments, '3.3.', 'internal'),
            h('h3', { className: 'rt-r2-h3' }, '3.4 Tái hiện quyền mục tiêu'),
            (report.repro && report.repro.target || []).length === 0 ? h('div', { className: 'rt-r2-empty' }, 'Không có mục điểm quyền mục tiêu.') : reproList(report.repro.target, '3.4.', 'target'))))
    }


    function ReportTab(props) {
      const eng = props.engagement
      const refreshKey = props.refreshKey || 0
      const [data, setData] = React.useState(null)
      const [err, setErr] = React.useState(null)
      const [busy, setBusy] = React.useState(false)
      const [msg, setMsg] = React.useState(null)
      /* Report collapses by stage: all open, state kept per target (stages deliver one by one) */
      const collapse = useCollapse('report:' + eng)

      const load = () => {
        if (!eng) return
        setBusy(true); setMsg(null)
        api({ op: 'scoreReport', engagement: eng }).then((r) => {
          if (!r || r.ok === false) { setBusy(false); setErr((r && r.error) || 'Tạo thất bại'); return }
          /* Old host gives flat items, no stage grouping (or rows missing): group by chain ourselves,
             or the page falsely reports "no deliverable results". Grouping data comes from scoreChain. */
          if ((!r.stages || r.stages.length === 0) && (r.items || []).length > 0) {
            api({ op: 'scoreChain', engagement: eng }).then((c) => {
              setBusy(false); setErr(null); setData(Object.assign({}, r, { stages: groupByStage(r.items, c) }))
            }, () => { setBusy(false); setErr(null); setData(r) })
            return
          }
          setBusy(false); setErr(null); setData(r)
        }, (e) => { setBusy(false); setErr(String((e && e.message) || e)) })
      }
      React.useEffect(load, [eng, refreshKey])

      /* The copy result must be real: when the clipboard API fails (non-secure context / focus loss / denied),
         report it honestly, or the user thinks it copied and pastes an empty request into Yakit. */
      const copy = (text, label) => copyWithFeedback(text, label, (okFlag, message) => {
        setMsg(okFlag ? { ok: message } : { err: message })
      })
      const download = (text, label) => {
        try {
          const blob = new Blob([text], { type: 'text/markdown;charset=utf-8' })
          const url = URL.createObjectURL(blob)
          const a = document.createElement('a')
          a.href = url
          const safe = String(label || 'score')
            .replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_')
            .replace(/\s+/g, ' ')
            .trim()
            .slice(0, 80) || 'score'
          a.download = 'report-' + safe + '.md'
          a.click()
          URL.revokeObjectURL(url)
          setMsg({ ok: 'Đã tải: ' + label })
        } catch (e) { setMsg({ err: 'Tải thất bại: ' + ((e && e.message) || e) }) }
      }

      const items = (data && data.items) || []
      const stages = (data && data.stages) || []
      const summary = (data && data.summary) || null
      const mdText = (data && data.markdown) || ''
      const report = (data && data.report) || null
      if (report !== null) {
        return h(ReportV2, {
          report: report, eng: eng, mdText: mdText, busy: busy, load: load,
          copy: copy, download: download, msg: msg,
        })
      }
      const CIRCLED = ['①', '②', '③', '④', '⑤', '⑥', '⑦', '⑧', '⑨', '⑩', '⑪', '⑫', '⑬', '⑭', '⑮', '⑯', '⑰', '⑱', '⑲', '⑳']

      /* One row per item, flat: target → obtained → replay request (paste into Yakit) → response */
      const card = (x) => h('div', { key: 'r' + x.id, className: 'rt-rep' },
        h('div', { className: 'rt-rep-head' },
          h('span', { className: 'rt-rep-idx' }, String(x.seq)),
          h('span', { className: 'rt-rep-name' }, x.point_name),
          h('span', { className: 'rt-flow-pts' }, '+' + x.points + ' điểm'),
          x.nth_of_point > 1 ? h('span', { className: 'rt-tag' }, 'Cùng loại lần thứ ' + x.nth_of_point + ' lần') : null,
          h('div', { className: 'rt-spacer' }),
          h('button', {
            className: 'rt-btn', style: { padding: '0 12px', fontSize: 'var(--ui-text-control)' },
            onClick: () => copy((x.requests || []).map((v) => v.request || '').filter(Boolean).join('\n\n'), 'Lần thứ ' + x.seq + ' mục yêu cầu'),
          }, 'Sao chép yêu cầu')),
        h('div', { className: 'rt-rep-meta' },
          h('span', null, h('b', null, 'Mục tiêu ')), h('span', { className: 'rt-mono' }, x.target || x.asset_ip || '—')),
        x.gained ? h('div', { className: 'rt-rep-meta' }, h('b', null, 'Đã lấy '), h('span', null, x.gained)) : null,
        x.vuln ? h('div', { className: 'rt-rep-meta' }, h('b', null, 'Khai thác lỗ hổng '),
          h('span', null, [x.vuln.cve, x.vuln.title].filter(Boolean).join(' '))) : null,
        x.evidence ? h('div', { className: 'rt-rep-meta' }, h('b', null, 'Kết quả '),
          h('span', null, String(x.evidence).replace(/\n+/g, ' '))) : null,
        x.recorded_at ? h('div', { className: 'rt-rep-meta' }, h('b', null, 'Thời điểm đạt được '),
          h('span', null, fmt(x.recorded_at) + (x.recorded_by ? '(' + (ROLE_LABEL[x.recorded_by] || x.recorded_by) + ')' : ''))) : null,
        h(ShotStrip, { eng: eng, shots: x.shots, total: x.shot_total, title: 'Ảnh chụp bằng chứng' }),
        /* ── reproduction steps: recorded actions (real commands and output) + credentials + tunnels + WebShell ──
           The report's delivery value sits here: where the password came from, how the tunnel was built. */
        h('details', { className: 'rt-rep-trace', open: x.incomplete === true || (x.steps || []).length === 0 },
          h('summary', { className: 'rt-rep-trace-head', style: { cursor: 'pointer' } },
            h('span', { className: 'rt-rep-trace-title' }, 'Các bước tái hiện (bấm để mở rộng)'),
            (x.steps || []).length ? h('span', { className: 'rt-tag' }, (x.steps || []).length + ' hành động') : null,
            (x.credentials || []).length ? h('span', { className: 'rt-tag' }, (x.credentials || []).length + ' thông tin xác thực') : null,
            (x.tunnels || []).length ? h('span', { className: 'rt-tag' }, (x.tunnels || []).length + ' đường hầm') : null,
            x.incomplete ? h('span', { className: 'rt-tag rt-tag-warn' }, 'Tài liệu tái hiện chờ bổ sung') : h('span', { className: 'rt-tag rt-tag-live' }, 'Có thể tái hiện')),
          h('div', { style: { paddingTop: 6 } },
          x.how ? h('div', { className: 'rt-rep-trace-how' }, x.how) : null,
          (x.steps || []).length === 0
            ? h('div', { className: 'rt-rep-missing' },
                '⚠️ Không có bước tấn công liên kết: không nói rõ bước này đã làm thế nào. Hãy dùng redteam_chain_add bổ sung hành động (title / detail / tool / result), khi ghi điểm cũng có thể kèm point_code + evidence để hoàn tất một lần.')
            : (x.steps || []).map((s, si) => h('div', { key: 's' + s.id, className: 'rt-rep-step' },
                h('div', { className: 'rt-rep-step-head' },
                  h('span', { className: 'rt-rep-step-no' }, String(si + 1)),
                  h('span', { className: 'rt-rep-step-title' }, s.title || '(hành động chưa đặt tên)'),
                  s.agent ? h('span', { className: 'rt-tag' }, ROLE_LABEL[s.agent] || s.agent) : null,
                  s.stage_code ? h('span', { className: 'rt-tag' }, s.stage_code) : null,
                  s.inferred ? h('span', { className: 'rt-tag' }, 'Suy luận theo cùng tài sản') : null,
                  h('div', { className: 'rt-spacer' }),
                  s.recorded_at ? h('span', { style: { fontSize: 'var(--ui-text-helper)', color: 'var(--dsw-alias-label-secondary)' } }, fmt(s.recorded_at)) : null),
                s.detail ? h('div', { className: 'rt-rep-step-detail' }, s.detail) : null,
                h('div', { className: 'rt-rep-step-cmd' },
                  h('b', null, 'Thực thi '),
                  s.tool
                    ? h('span', { className: 'rt-mono' }, s.tool)
                    : h('span', { style: { color: 'var(--ui-warning)' } }, 'Chưa ghi nhận lệnh thực tế (tool của redteam_chain_add)')),
                s.tool ? h('div', { style: { marginTop: 3 } },
                  h('button', {
                    className: 'rt-btn', style: { padding: '0 12px', fontSize: 'var(--ui-text-control)' },
                    onClick: () => copy(String(s.tool), 'Lần thứ ' + (si + 1) + ' bước lệnh'),
                  }, 'Sao chép lệnh')) : null,
                s.result ? h('div', { className: 'rt-rep-step-result' }, h('b', null, 'Kết quả '), String(s.result).replace(/\n+/g, ' ')) : null,
                s.evidence_ref ? h('div', { className: 'rt-rep-step-result' }, h('b', null, 'Bằng chứng '), h('span', { className: 'rt-mono' }, s.evidence_ref)) : null)),
          /* Where the account came from: credential source + how it was obtained */
          (x.credentials || []).length
            ? h('div', { className: 'rt-rep-src' },
                h('div', { className: 'rt-rep-src-title' }, 'Thông tin xác thực đã lấy (truy nguyên được nguồn)'),
                (x.credentials || []).map((c) => h('div', { key: 'c' + c.id, className: 'rt-kv' },
                  h('b', { className: 'rt-mono', style: { minWidth: 120 } }, c.host || '—'),
                  h('span', null, (c.username || '(không có tên người dùng)') + ' / ' + (c.secret_type || 'password')
                    + (c.privilege ? ' · quyền ' + c.privilege : '')
                    + ' · nguồn ' + (c.source || 'Chưa đánh dấu')
                    + (c.tool ? ' · cách đạt được ' + String(c.tool).replace(/\n+/g, ' ').slice(0, 160) : '')))))
            : null,
          /* How the tunnel was built */
          (x.tunnels || []).length
            ? h('div', { className: 'rt-rep-src' },
                h('div', { className: 'rt-rep-src-title' }, 'Đường hầm / kênh đã dùng'),
                (x.tunnels || []).map((t) => h('div', { key: 't' + t.id, className: 'rt-kv' },
                  h('b', { className: 'rt-mono', style: { minWidth: 120 } }, (t.kind || 'socks5') + ' ' + (t.listen || '')),
                  h('span', null, 'Điểm vào ' + (t.entry || 'Chưa đăng ký')
                    + (t.reach ? ' · tiếp cận ' + t.reach : '')
                    + ' · phía mục tiêu ' + (t.entry_kind || 'Chưa khai báo')
                    + (t.legit === false ? ' · ⚠️ không tính là vượt ranh giới mục tiêu' : '')
                    + (t.status ? ' · ' + t.status : '')
                    + (t.command ? ' · lệnh ' + String(t.command).replace(/\n+/g, ' ').slice(0, 160) : '')))))
            : null,
          (x.webshells || []).length
            ? h('div', { className: 'rt-rep-src' },
                h('div', { className: 'rt-rep-src-title' }, 'WebShell đã dùng'),
                (x.webshells || []).map((w) => h('div', { key: 'w' + w.id, className: 'rt-kv' },
                  h('b', { className: 'rt-mono', style: { minWidth: 120 } }, w.shell_type || 'shell'),
                  h('span', null, (w.url || '') + (w.pass_key ? ' · mật khẩu/khóa ' + w.pass_key : '')
                    + (w.privilege ? ' · quyền ' + w.privilege : '') + (w.status ? ' · ' + w.status : '')))))
            : null,
          (x.gaps || []).length ? h('div', { className: 'rt-rep-missing' }, '⚠️ Thiếu tái hiện: ' + x.gaps.join('; ')) : null),
        (x.requests || []).length === 0
          ? h('div', { className: 'rt-rep-missing' }, '⚠️ Mục này không có bản ghi yêu cầu gốc, không thể tái hiện trực tiếp — hãy bổ sung bằng redteam_http_evidence_add')
          : (x.requests || []).map((r, ri) => h('div', { key: 'q' + ri, className: 'rt-rep-req' },
              h('div', { className: 'rt-rep-req-head' },
                h('span', null, 'Yêu cầu tái hiện ' + (ri + 1) + (r.source === 'auto' ? '(tự khớp theo đường dẫn mục tiêu, hãy kiểm tra lại)' : '')),
                h('span', { className: 'rt-tag' }, (r.method || 'GET') + ' ' + (r.status === null || r.status === undefined ? '' : r.status)),
                h('div', { className: 'rt-spacer' }),
                h('button', {
                  className: 'rt-btn', style: { padding: '0 12px', fontSize: 'var(--ui-text-control)' },
                  onClick: () => copy(String(r.request || ''), 'Yêu cầu ' + (ri + 1)),
                }, 'Sao chép sang Yakit')),
              h('pre', { className: 'rt-rep-http' }, r.request || ((r.method || 'GET') + ' ' + (r.url || '') + ' HTTP/1.1')),
              r.response ? h('div', null,
                h('div', { className: 'rt-rep-req-head' }, h('span', null, 'Tóm tắt phản hồi')),
                h('pre', { className: 'rt-rep-http', style: { maxHeight: 160 } }, String(r.response).slice(0, 1600))) : null)),
        x.note ? h('div', { className: 'rt-rep-meta' }, h('b', null, 'Ghi chú '), h('span', null, x.note)) : null))

      return h('div', { className: 'rt-main' },
        h('div', { className: 'rt-toolbar' },
          h('span', { style: { fontWeight: 600 } }, 'Báo cáo điểm red-team (bốn phần)'),
          summary ? h('span', { className: 'rt-tag rt-tag-live' }, 'Tổng ' + summary.points + ' điểm') : null,
          summary ? h('span', { className: 'rt-tag' }, summary.count + ' mục ghi điểm') : null,
          summary ? h('span', { className: 'rt-tag' + (summary.missingRequests ? '' : ' rt-tag-live') },
            summary.withRequests + '/' + summary.count + ' mục có yêu cầu gốc') : null,
          summary ? h('span', {
            className: 'rt-tag' + (summary.incomplete ? ' rt-tag-warn' : ' rt-tag-live'),
            title: 'Chuỗi tái hiện có đầy đủ: có bước tấn công, ghi lệnh thực tế, liên kết lỗ hổng/thông tin xác thực/đường hầm',
          }, 'Có thể tái hiện ' + (summary.count - (summary.incomplete || 0)) + '/' + summary.count) : null,
          summary && summary.serviceCappedExcluded
            ? h('span', {
                className: 'rt-tag rt-tag-warn',
                title: (summary.serviceCapped || []).map((x) => (x.service || '') + ' | ' + (x.point_name || '')).join('\n')
                  || 'Trùng tài khoản/quyền cơ sở dữ liệu trên cùng tài sản cùng cổng: dịch vụ đã đạt tối đa, không tính điểm, không vào báo cáo',
              }, 'Cùng dịch vụ đã đạt tối đa, không tính điểm ' + summary.serviceCappedExcluded)
            : null,
          h('div', { className: 'rt-spacer' }),
          h('button', { className: 'rt-btn', disabled: busy || !mdText, onClick: () => copy(mdText, 'Toàn bộ báo cáo') }, 'Sao chép toàn văn'),
          h('button', { className: 'rt-btn', disabled: busy || !mdText, onClick: () => download(mdText, (data && data.target) || eng) }, 'Tải .md'),
          h('button', { className: 'rt-btn', disabled: busy, onClick: load }, busy ? 'Đang tạo…' : 'Tạo lại')),
        msg ? h('div', { className: msg.err ? 'rt-err' : 'rt-foot' }, msg.err || msg.ok) : null,
        err ? h('div', { className: 'rt-err' }, err) : null,
        mdText ? h('details', { className: 'rt-pane', style: { margin: '8px 12px 0' } },
          h('summary', { style: { cursor: 'pointer', fontWeight: 600 } }, 'Xem báo cáo chi tiết (chứng minh tài sản / tổng hợp điểm / tổng hợp thông tin xác thực / tái hiện mục tính điểm)'),
          h(Markdown, { text: mdText })) : null,
        h('div', { className: 'rt-body', style: { overflow: 'auto' } },
          stages.length
            ? h('div', { className: 'rt-rep-list' },
                h('div', { className: 'rt-rep-tools' },
                  h('button', { className: 'rt-btn', onClick: () => collapse.setAll(stages.map((s) => 'st:' + s.code), true) }, 'Mở rộng tất cả'),
                  h('button', { className: 'rt-btn', onClick: () => collapse.setAll(stages.map((s) => 'st:' + s.code), false) }, 'Thu gọn tất cả')),
                stages.map((st) => {
                  const open = collapse.isOpen('st:' + st.code, false)
                  const toggle = collapse.toggle('st:' + st.code, false)
                  return h('div', { key: 'g' + st.code, className: 'rt-rep-group' },
                    h('div', {
                      className: 'rt-rep-stage', role: 'button', tabIndex: 0,
                      style: { borderLeftColor: st.color },
                      'aria-expanded': open ? 'true' : 'false',
                      onClick: toggle,
                      onKeyDown: (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggle(e) } },
                    },
                      h('span', { className: 'rt-sec-caret' }, open ? '▾' : '▸'),
                      h('span', { className: 'rt-rep-no', style: { background: st.color } }, CIRCLED[st.ordinal - 1] || st.ordinal),
                      h('span', { className: 'rt-rep-stage-name' }, st.name),
                      h('span', { className: 'rt-rep-stage-n' }, st.items.length + ' mục'),
                      h('div', { className: 'rt-spacer' }),
                      h('span', { className: 'rt-rep-pts', style: { background: st.color + '22', color: st.color, borderColor: st.color + '66' } },
                        '+' + st.points + ' điểm'),
                      h('span', { className: 'rt-ap-cum' }, 'Tích lũy ' + st.cumulative + ' điểm')),
                    open ? h('div', { className: 'rt-rep-body' }, st.items.map(card)) : null)
                }))
            : (data === null ? h('div', { className: 'rt-empty' }, 'Đang tải…')
                : h('div', { className: 'rt-empty' },
                    h('div', null, 'Chưa có kết quả nào có thể bàn giao.'),
                    h('div', { style: { marginTop: 6, fontSize: 'var(--ui-text-helper)' } },
                      'Báo cáo này chỉ gồm các kết quả "đã ghi điểm"; lỗ hổng không ghi điểm không vào báo cáo. Sau khi có kết quả hãy dùng redteam_score_hit để ghi điểm (tài sản mục tiêu + thứ lấy được), và bổ sung redteam_http_evidence_add để tái hiện.')))),
        h('div', { className: 'rt-foot' },
          h('span', null, 'Nguyên tắc: chỉ gồm kết quả ghi điểm, mỗi mục kèm yêu cầu gốc có thể dán vào Yakit Repeater')))
    }

    /* ---------------------------------------------------------- attack files */
    const FILE_KIND = { poc: 'POC', exp: 'EXP', script: 'Script', wordlist: 'Từ điển', other: 'Khác' }

    function AttackFilesTab(props) {
      const eng = props.engagement
      const refreshKey = props.refreshKey || 0
      const [folders, setFolders] = React.useState([])
      const [err, setErr] = React.useState(null)
      const [busy, setBusy] = React.useState(false)
      const collapse = useCollapse('files:' + eng)
      const [detail, setDetail] = React.useState(null)

      const load = () => {
        if (!eng) return
        setBusy(true)
        api({ op: 'attackFiles', engagement: eng }).then((r) => {
          setBusy(false)
          if (!r || r.ok === false) { setErr((r && r.error) || 'Đọc thất bại'); return }
          setErr(null)
          setFolders(r.items || [])
        }, (e) => { setBusy(false); setErr(String((e && e.message) || e)) })
      }
      React.useEffect(load, [eng, refreshKey])

      const openFile = (f) => {
        if (detail && detail.id === f.id) { setDetail(null); return }
        setDetail(null)
        api({ op: 'readAttackFile', engagement: eng, id: f.id }).then((r) => {
          if (r && r.ok) setDetail(r)
          else setErr((r && r.error) || 'Đọc thất bại')
        }, (e) => setErr(String((e && e.message) || e)))
      }

      const rows = []
      for (const folder of folders) {
        const fKey = 'folder:' + folder.folder
        const fileNodes = []
        for (const f of folder.files) {
          fileNodes.push(h('div', {
            key: 'a' + f.id, className: 'rt-vrow rt-file-row',
            role: 'button', tabIndex: 0,
            onClick: () => openFile(f),
            onKeyDown: (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); openFile(f) } },
          },
            h('span', { className: 'rt-sec-caret' }, detail && detail.id === f.id ? '▾' : '▸'),
            h('span', { className: 'rt-mono rt-file-name' }, f.name),
            h('span', { className: 'rt-file-kind' }, h('span', { className: 'rt-tag rt-tag-active' }, FILE_KIND[f.kind] || f.kind || '—')),
            h('span', { className: 'rt-file-description', title: f.description || '' }, f.description || '—')))
          if (!detail || detail.id !== f.id) continue
          fileNodes.push(h('div', {
            key: 'ad' + f.id, className: 'rt-vrow rt-file-detail-row',
          }, h('div', { className: 'rt-vdetail rt-file-detail' },
            h('div', { className: 'rt-kv rt-file-detail-field' }, h('b', null, 'Hiệu quả'), h('span', null, detail.evidence || '—')),
            h('div', { className: 'rt-kv rt-file-detail-field' }, h('b', null, 'Đường dẫn'), h('span', { className: 'rt-mono rt-file-path' }, detail.path)),
            h('div', { className: 'rt-kv rt-file-detail-field' }, h('b', null, 'Ghi nhận'), h('span', null, fmt(detail.created_at) + (detail.created_by ? ' · ' + detail.created_by : ''))),
            h('pre', { className: 'rt-md rt-file-content' }, detail.content || '(trống)'))))
        }
        rows.push(h(Section, {
          key: 'sec:' + folder.folder, tone: 'folder', title: folder.folder + '/',
          count: folder.count + ' tệp',
          open: collapse.isOpen(fKey, true), onToggle: collapse.toggle(fKey, true),
        }, fileNodes.length ? fileNodes : h('div', { className: 'rt-atest-meta' }, '(trống)')))
      }

      const total = folders.reduce((n, f) => n + f.count, 0)
      return h('div', { className: 'rt-main rt-file-artifacts' },
        h('div', { className: 'rt-toolbar' },
          h('span', { style: { fontWeight: 600 } }, 'Tệp tấn công'),
          h('span', { className: 'rt-tag' }, folders.length + ' mục tiêu / ' + total + ' tệp'),
          h('div', { className: 'rt-spacer' }),
          h('button', { className: 'rt-btn', disabled: busy, onClick: load }, busy ? 'Đang làm mới…' : 'Làm mới')),
        err ? h('div', { className: 'rt-err' }, err) : null,
        h('div', { className: 'rt-table' },
          rows,
          !folders.length ? h('div', { className: 'rt-empty' }, 'Chưa có tệp tấn công (script/POC/EXP đã khai thác sẽ xuất hiện ở đây theo thư mục mục tiêu)') : null),
        h('div', { className: 'rt-foot' }, h('span', null, 'Thư mục: attack-files/<IP|host URL|dải C>/  |  chỉ gồm tệp thực sự có hiệu lực')))
    }

    /* ---------------------------------------------------------- knowledge base (POC/EXP, globally shared) */
    /**
     * Knowledge-base page: search here before an Nday/1day. Takes CVE / component / keyword / body text;
     * a hit expands to full text (copy and use); a miss means search the web or write one and backfill.
     * The base is **global**: it does not switch with the target, so a POC sunk here serves all targets.
     */
    const POC_KIND_LABEL = { poc: 'POC', exp: 'EXP', script: 'Script', template: 'Mẫu', payload: 'Payload' }
    const POC_SOURCE_LABEL = { web: 'Internet', self: 'Tự viết', manual: 'Thủ công', 'nuclei-template': 'Mẫu nuclei', kb: 'Kho tri thức' }

    function KnowledgeTab(props) {
      const refreshKey = props.refreshKey || 0
      const [data, setData] = React.useState(null)
      const [err, setErr] = React.useState(null)
      const [busy, setBusy] = React.useState(false)
      const [msg, setMsg] = React.useState(null)
      const [q, setQ] = React.useState('')
      const [kind, setKind] = React.useState('')
      const [category, setCategory] = React.useState('')
      const [engagement, setEngagement] = React.useState(() => String(props.engagement || ''))
      const [assetTarget, setAssetTarget] = React.useState('')
      const [grouped, setGrouped] = React.useState(true)
      const [verifiedOnly, setVerifiedOnly] = React.useState(false)
      const [openId, setOpenId] = React.useState(null)
      const [detail, setDetail] = React.useState(null)
      const [detailBusy, setDetailBusy] = React.useState(false)
      const [tplOffset, setTplOffset] = React.useState(0)
      const tplPageSize = 40

      const query = (over) => {
        const extra = over || {}
        const offset = Object.prototype.hasOwnProperty.call(extra, 'templateOffset') ? extra.templateOffset : 0
        setTplOffset(offset)
        const params = Object.assign({
          q: q.trim() || undefined,
          kind: kind || undefined,
          category: category || undefined,
          engagement: engagement || undefined,
          asset_target: assetTarget.trim() || undefined,
          verified: verifiedOnly || undefined,
          templateOffset: offset || 0,
          templateLimit: tplPageSize,
        }, extra)
        setBusy(true); setMsg(null)
        api(Object.assign({ op: 'pocSearch' }, params)).then((r) => {
          setBusy(false)
          if (!r || r.ok === false) { setErr((r && r.error) || 'Đọc thất bại'); return }
          setErr(null); setData(r)
        }, (e) => { setBusy(false); setErr(String((e && e.message) || e)) })
      }
      /* Full fetch on first entry and on refresh key change (search is explicit, no per-keystroke call) */
      React.useEffect(() => {
        const def = String(props.engagement || '')
        setEngagement(def)
        query({ q: undefined, kind: undefined, category: undefined, engagement: def || undefined, asset_target: undefined, verified: undefined })
      }, [refreshKey, props.engagement])

      const open = (id) => {
        if (openId === id) { setOpenId(null); setDetail(null); return }
        setOpenId(id); setDetail(null); setDetailBusy(true)
        api({ op: 'pocGet', id: id }).then((r) => {
          setDetailBusy(false)
          if (!r || r.ok === false) { setMsg({ err: (r && r.error) || 'Đọc thất bại' }); return }
          setDetail(r)
        }, (e) => { setDetailBusy(false); setMsg({ err: String((e && e.message) || e) }) })
      }

      /* Like the report page: await the real result before showing feedback */
      const copy = (text, label) => copyWithFeedback(text, label, (okFlag, message) => {
        setMsg(okFlag ? { ok: message } : { err: message })
      })
      const useIt = (row) => {
        api({ op: 'pocUse', id: row.id, used_on: 'Đánh dấu thủ công trên bảng điều khiển' }).then(() => {
          setMsg({ ok: 'Đã ghi một lần tái sử dụng: ' + row.title })
          query()
        }, (e) => setMsg({ err: String((e && e.message) || e) }))
      }

      const stats = (data && data.stats) || { total: 0, verified: 0, reused: 0, byKind: [], bySource: [] }
      const items = (data && data.items) || []
      const tpl = (data && data.templates) || { dir: null, total: 0, matched: 0, offset: 0, items: [], byCategory: [] }
      const tplByCat = new Map((tpl.byCategory || []).map((c) => [c.code, c.n || 0]))
      const catShown = (c) => (c.n || 0) + (tplByCat.get(c.code) || 0)
      const tplItems = tpl.items || []
      const tplMatched = tpl.matched != null ? tpl.matched : tpl.total
      const tplStart = Number(tpl.offset) || 0
      const turnTpl = (next) => {
        const offset = Math.max(0, next)
        setTplOffset(offset)
        query({ templateOffset: offset })
      }

      const card = (x) => {
        const isOpen = openId === x.id
        const d = isOpen && detail && detail.id === x.id ? detail : null
        return h('div', { key: 'p' + x.id, className: 'rt-kb' + (isOpen ? ' open' : '') },
          h('div', {
            className: 'rt-kb-head', role: 'button', tabIndex: 0, 'aria-expanded': isOpen ? 'true' : 'false',
            onClick: () => open(x.id),
            onKeyDown: (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); open(x.id) } },
          },
            h('span', { className: 'rt-sec-caret' }, isOpen ? '▾' : '▸'),
            h('span', { className: 'rt-kb-kind k-' + (x.kind || 'poc') }, POC_KIND_LABEL[x.kind] || x.kind || 'POC'),
            h('span', { className: 'rt-kb-title' }, x.title),
            x.cve ? h('span', { className: 'rt-tag rt-tag-passive' }, x.cve) : null,
            x.component ? h('span', { className: 'rt-tag' }, x.component) : null,
            x.verified === 1
              ? h('span', { className: 'rt-tag rt-tag-live' }, 'Đã xác minh')
              : h('span', { className: 'rt-tag rt-tag-warn' }, 'Chưa xác minh'),
            h('div', { className: 'rt-spacer' }),
            h('span', { className: 'rt-tag' }, POC_SOURCE_LABEL[x.source] || x.source || '—'),
            x.hit_count ? h('span', { className: 'rt-tag' }, 'Tái sử dụng ' + x.hit_count) : null),
          /* Source line: category · versions · added · source target · asset —— one glance
             when and on whose asset a piece of knowledge was found */
          h('div', { className: 'rt-kb-sub' },
            [x.category ? 'Phân loại ' + (POC_CAT_NAME[x.category] || x.category) : null,
              x.versions ? 'Phiên bản ảnh hưởng ' + x.versions : null,
              x.language || null,
              x.tags || null,
              'Thời điểm tạo ' + fmt(x.created_at),
              (x.engagement_name || x.engagement_id) ? 'Mục tiêu nguồn ' + (x.engagement_name || x.engagement_id) : null,
              x.asset_target ? 'Tài sản phát hiện ' + x.asset_target : null,
              x.found_by_agent ? 'Vai trò phát hiện ' + (ROLE_LABEL[x.found_by_agent] || x.found_by_agent) : null,
              x.source_url ? 'Nguồn ' + x.source_url : null].filter(Boolean).join(' · ')),
          isOpen
            ? h('div', { className: 'rt-kb-body' },
                detailBusy && !d ? h('div', { className: 'rt-empty' }, 'Đang đọc…') : null,
                d ? h('div', null,
                  d.usage ? h('div', { className: 'rt-kv' }, h('b', null, 'Cách dùng'), h('span', { className: 'rt-mono' }, d.usage)) : null,
                  d.description ? h('div', { className: 'rt-kv' }, h('b', null, 'Mô tả'), h('span', null, d.description)) : null,
                  d.verified_note ? h('div', { className: 'rt-kv' }, h('b', null, 'Bằng chứng xác minh'), h('span', null, d.verified_note)) : null,
                  d.used_on ? h('div', { className: 'rt-kv' }, h('b', null, 'Dùng gần nhất'), h('span', null, d.used_on)) : null,
                  d.path ? h('div', { className: 'rt-kv' }, h('b', null, 'Lưu xuống đĩa'), h('span', { className: 'rt-mono' }, d.path)) : null,
                  h('div', { className: 'rt-kb-actions' },
                    h('button', { className: 'rt-btn', disabled: !d.content, onClick: () => copy(d.content || '', 'Nội dung POC') }, 'Sao chép nội dung'),
                    h('button', { className: 'rt-btn', onClick: () => useIt(x) }, 'Ghi một lần tái sử dụng'),
                    d.source_url ? h('button', { className: 'rt-btn', onClick: () => copy(d.source_url, 'Liên kết nguồn') }, 'Sao chép nguồn') : null),
                  d.content
                    ? h('pre', { className: 'rt-rep-http' }, d.content.length > 12000 ? d.content.slice(0, 12000) + '\n…(đã cắt bớt, nội dung đầy đủ xem tệp đã lưu)' : d.content)
                    : h('div', { className: 'rt-empty' }, 'Mục này chỉ có metadata, không có nội dung — sau khi có nội dung hãy bổ sung bằng redteam_poc_update'))
                : null)
            : null)
      }

      return h('div', { className: 'rt-main' },
        h('div', { className: 'rt-toolbar' },
          h('span', { style: { fontWeight: 600 } }, 'Kho tri thức · POC / EXP'),
          h('span', { className: 'rt-tag' }, stats.total + ' mục'),
          h('span', { className: 'rt-tag rt-tag-live' }, 'Đã xác minh ' + stats.verified),
          h('span', { className: 'rt-tag' }, 'Tái sử dụng tích lũy ' + (stats.reused || 0)),
          (stats.uncategorized || 0) > 0 && (stats.uncategorized || 0) !== stats.total
            ? h('span', { className: 'rt-tag rt-tag-warn', title: 'Các mục này chưa được phân loại: khi tác nhân điền lại hãy đánh dấu bằng tham số category của redteam_poc_add' }, 'Chưa phân loại ' + stats.uncategorized)
            : null,
          tpl.total ? h('span', { className: 'rt-tag rt-tag-passive' }, 'Mẫu trên máy ' + tpl.total) : null,
          h('div', { className: 'rt-spacer' }),
          h('button', { className: 'rt-btn' + (grouped ? ' rt-btn-primary' : ''), title: 'Hiển thị nhóm theo phân loại / hiển thị phẳng', onClick: () => setGrouped(!grouped) }, grouped ? 'Nhóm theo phân loại' : 'Hiển thị phẳng'),
          h('button', { className: 'rt-btn', disabled: busy, onClick: () => query() }, busy ? 'Đang tìm…' : 'Làm mới')),
        /* Category overview: click to filter, so you see what each weapon class holds and what is empty */
        h('div', { className: 'rt-kb-cats' },
          (stats.byCategory || []).filter((c) => catShown(c) > 0 || POC_CAT_ORDER.includes(c.code)).map((c) => h('span', {
            key: c.code,
            className: 'rt-concl-i' + (category === c.code ? ' on' : ''),
            title: (c.hint || POC_CAT_NAME[c.code] || c.code)
              + ' · mẫu trên máy ' + (tplByCat.get(c.code) || 0)
              + ' · kho tri thức ' + (c.n || 0)
              + (c.verified ? '(đã xác minh ' + c.verified + ')' : ''),
            onClick: () => {
              const next = category === c.code ? '' : c.code
              setCategory(next)
              query({ category: next || undefined })
            },
          },
            h('b', null, String(catShown(c))),
            h('span', null, (POC_CAT_NAME[c.code] || c.code) + (c.verified ? '(đã xác minh ' + c.verified + ')' : ''))))),
        h('div', { className: 'rt-kb-filter' },
          h('input', {
            className: 'rt-input', style: { flex: 1, minWidth: 140 }, placeholder: 'Tìm CVE / thành phần / từ khóa (tìm cả trong nội dung)',
            value: q, onChange: (e) => setQ(e.target.value),
            onKeyDown: (e) => { if (e.key === 'Enter') query() },
          }),
          h('select', { className: 'rt-input', style: { maxWidth: 120 }, value: category, onChange: (e) => { setCategory(e.target.value); query({ category: e.target.value || undefined }) } },
            h('option', { value: '' }, 'Tất cả phân loại'),
            POC_CAT_ORDER.map((k) => h('option', { key: k, value: k }, POC_CAT_NAME[k]))),
          h('select', { className: 'rt-input', style: { maxWidth: 120 }, value: engagement, onChange: (e) => { setEngagement(e.target.value); query({ engagement: e.target.value || undefined }) } },
            h('option', { value: '' }, 'Tất cả mục tiêu nguồn'),
            (stats.byEngagement || []).map((e) => h('option', { key: e.engagement, value: e.engagement }, e.engagement + '(' + e.n + ')'))),
          h('input', {
            className: 'rt-input', style: { width: 120 }, placeholder: 'Lọc tài sản phát hiện',
            value: assetTarget, onChange: (e) => setAssetTarget(e.target.value),
            onKeyDown: (e) => { if (e.key === 'Enter') query() },
          }),
          h('select', { className: 'rt-input', style: { maxWidth: 110 }, value: kind, onChange: (e) => { setKind(e.target.value); query({ kind: e.target.value || undefined }) } },
            h('option', { value: '' }, 'Tất cả loại'),
            Object.keys(POC_KIND_LABEL).map((k) => h('option', { key: k, value: k }, POC_KIND_LABEL[k]))),
          h('label', { className: 'rt-kb-check' },
            h('input', { type: 'checkbox', checked: verifiedOnly, onChange: (e) => { setVerifiedOnly(e.target.checked); query({ verified: e.target.checked || undefined }) } }),
            'Chỉ xem đã xác minh'),
          h('button', { className: 'rt-btn rt-btn-primary', onClick: () => query() }, 'Tìm kiếm')),
        msg ? h('div', { className: msg.err ? 'rt-err' : 'rt-foot' }, msg.err || msg.ok) : null,
        err ? h('div', { className: 'rt-err' },
          /engagement required|unknown op/i.test(err)
            /* Old host has no knowledge-base API: explain the fix, not just "engagement required" */
            ? 'API kho tri thức do phía host cung cấp, host hiện tại vẫn là tiến trình cũ — hãy thoát hoàn toàn rồi mở lại (exe chính thức / bản cộng đồng / dsh web bất kỳ), rồi làm mới trang.'
            : err) : null,
        !err && data && data.dbPath
          ? h('div', { className: 'rt-foot', style: { marginBottom: 6, fontSize: 'var(--ui-text-helper)' } },
              'Kho tri thức: ' + data.dbPath
              + (data.root ? '(thư mục gốc ' + data.root + ')' : ''))
          : null,
        h('div', { className: 'rt-table' },
          (() => {
            if (!grouped) return items.map(card)
            /* Grouped rendering: built-in category order first, unknown categories appended under "other" */
            const buckets = new Map()
            for (const x of items) {
              const code = POC_CAT_NAME[x.category] ? x.category : 'other'
              if (!buckets.has(code)) buckets.set(code, [])
              buckets.get(code).push(x)
            }
            const order = POC_CAT_ORDER.filter((c) => buckets.has(c))
            for (const code of buckets.keys()) if (!order.includes(code)) order.push(code)
            const out = []
            for (const code of order) {
              const list = buckets.get(code)
              out.push(h('div', { key: 'g' + code, className: 'rt-kb-cat' },
                h('span', { className: 'rt-kb-cat-name' }, POC_CAT_NAME[code] || code),
                h('span', { className: 'rt-tag' }, list.length + ' mục'),
                h('span', { className: 'rt-tag rt-tag-live' }, 'Đã xác minh ' + list.filter((x) => x.verified === 1).length),
                h('span', { className: 'rt-spacer' }),
                h('span', { style: { fontSize: 'var(--ui-text-helper)', color: 'var(--dsw-alias-label-secondary)' } },
                  'Tạo gần nhất ' + fmt(list.map((x) => x.created_at).filter(Boolean).sort().pop()))))
              for (const x of list) out.push(card(x))
            }
            return out
          })(),
          tplItems.length
            ? h('div', { className: 'rt-kb-tpl' },
                h('div', { className: 'rt-ap-sub' },
                  'Mẫu nuclei trên máy · ' + (tplStart + 1) + '–' + (tplStart + tplItems.length) + ' / ' + tplMatched
                  + '(trực tiếp `nuclei -t <đường dẫn mẫu>`)'),
                tplItems.map((t, i) => h('div', { key: 't' + tplStart + '-' + i, className: 'rt-kb-tpl-row' },
                  h('span', { className: 'rt-tag' }, t.severity || '—'),
                  t.category ? h('span', { className: 'rt-tag' }, POC_CAT_NAME[t.category] || t.category) : null,
                  h('span', { className: 'rt-mono rt-kb-tpl-path', title: t.path }, t.path),
                  h('span', { className: 'rt-kb-tpl-name', title: t.name }, t.name || ''),
                  h('button', {
                    className: 'rt-btn', style: { padding: '0 12px', fontSize: 'var(--ui-text-control)' },
                    onClick: () => copy('nuclei -t ' + t.path + ' -u <mục tiêu>', 'Lệnh mẫu'),
                  }, 'Sao chép lệnh'))),
                h('div', { className: 'rt-kb-actions' },
                  h('button', {
                    className: 'rt-btn', disabled: busy || tplStart <= 0,
                    onClick: () => turnTpl(tplStart - tplPageSize),
                  }, 'Trang trước'),
                  h('button', {
                    className: 'rt-btn', disabled: busy || tplStart + tplItems.length >= tplMatched,
                    onClick: () => turnTpl(tplStart + tplPageSize),
                  }, 'Trang sau')),
                tpl.dir ? h('div', { className: 'rt-foot' }, h('span', null, 'Thư mục mẫu: ' + tpl.dir)) : null)
            : null,
          data === null ? h('div', { className: 'rt-empty' }, 'Đang tải…') : null,
          data !== null && !items.length && !tplItems.length
            ? h('div', { className: 'rt-empty' },
                h('div', null,
                  q || kind || verifiedOnly
                    ? 'Không trúng: đổi từ khóa rồi thử lại, hoặc tìm trên internet / tự viết rồi điền lại.'
                    : (tpl.total
                      ? ('Thư viện POC/EXP vẫn trống; trên máy đã có ' + tpl.total + ' mẫu nuclei. Lật trang hoặc tìm CVE/thành phần ở trên là thấy.')
                      : (tpl.dir
                        ? 'Kho tri thức vẫn trống (thư mục mẫu trên máy có, nhưng chưa có yaml). Sau khi bấm "Áp dụng" sẽ tự tải mẫu nuclei, khởi động lại rồi mở lại trang này.'
                        : 'Kho tri thức vẫn trống. Sau khi bấm "Áp dụng" sẽ tự tạo kho và tải mẫu nuclei, khởi động lại rồi mở lại trang này sẽ thấy "Mẫu trên máy N".'))),
                h('div', { style: { marginTop: 6, fontSize: 'var(--ui-text-helper)' } },
                  'Thứ tự chuẩn để đánh Nday/1day: ① redteam_poc_search tra ở đây trước (tiện thể tìm cả thư viện mẫu nuclei trên máy) → ② nếu không có thì tìm trên internet (web_search / GitHub / ExploitDB / thông báo nhà cung cấp) hoặc tự viết → ③ sau khi xác minh hiệu lực trên mục tiêu thật thì điền lại bằng redteam_poc_add, các mục tiêu sau dùng được ngay.'),
                data.dbPath ? h('div', { style: { marginTop: 6, fontSize: 'var(--ui-text-helper)' }, className: 'rt-mono' }, 'Tệp kho tri thức: ' + data.dbPath) : null,
                tpl.dir ? h('div', { style: { marginTop: 6, fontSize: 'var(--ui-text-helper)' }, className: 'rt-mono' }, 'Thư mục mẫu: ' + tpl.dir) : null)
            : null),
        h('div', { className: 'rt-foot' },
          h('span', null, 'Chia sẻ toàn cục (xuyên mục tiêu)  |  lưu xuống: pocs/<code>/  |  chỉ gồm POC/EXP phổ quát tái sử dụng được, script riêng cho mục tiêu đi vào "Tệp tấn công"')))
    }

    /* ---------------------------------------------------------- environment adaptation (Windows / non-Kali) */
    /**
     * Borrows Z3r0's system-config idea: paths and secrets go into central config, not bash/ps1.
     * Persisted to $DSH_HOME/redteam/config.json —— the user fills in absolute tool paths or a search root.
     */
    function ProxySettings(props) {
      const [draft, setDraft] = React.useState(null)
      const [pool, setPool] = React.useState(null)
      const [selectedId, setSelectedId] = React.useState('')
      const [selectedIds, setSelectedIds] = React.useState([])
      const [page, setPage] = React.useState(1)
      const [pageSize, setPageSize] = React.useState(20)
      const [bulkDeleteIds, setBulkDeleteIds] = React.useState(null)
      const [deleteId, setDeleteId] = React.useState(null)
      const [pollError, setPollError] = React.useState(false)
      const [logsOpen, setLogsOpen] = React.useState(true)
      const editorDirty = React.useRef(false)
      const policyDirty = React.useRef(false)
      const [policy, setPolicy] = React.useState({ enabled: false, autoConnect: false, timeoutMs: 10000, enginePath: '' })
      const editorRef = React.useRef(null)
      const polling = React.useRef(false)
      const [password, setPassword] = React.useState('')
      const [passwordChanged, setPasswordChanged] = React.useState(false)
      const [yaml, setYaml] = React.useState('')
      const [candidates, setCandidates] = React.useState([])
      const [candidatePage, setCandidatePage] = React.useState(1)
      const [candidatePageSize, setCandidatePageSize] = React.useState(20)
      const [importedNode, setImportedNode] = React.useState(null)
      const [warnings, setWarnings] = React.useState([])
      const [busy, setBusy] = React.useState(false)
      const [connecting, setConnecting] = React.useState(false)
      const [disconnecting, setDisconnecting] = React.useState(false)
      const [dragActive, setDragActive] = React.useState(false)
      const dragDepth = React.useRef(0)
      const [message, setMessage] = React.useState(null)
      const sequence = React.useRef(0)
      const operation = React.useRef(false)
      const reloadQueued = React.useRef(false)
      const batchTesting = React.useRef(false)
      const batchTicket = React.useRef(0)
      const [scope, setScope] = React.useState('Yêu cầu mạng của chính plugin; không sửa proxy của hệ thống, trình duyệt hay API mô hình.')
      const makeDraft = (profile = {}) => ({
        kind: profile.kind || 'direct', name: profile.name || '', enabled: profile.enabled !== false, protocol: profile.protocol || 'http',
        host: profile.host || '', port: String(profile.port || ''), username: profile.username || '',
        noProxy: profile.noProxy || '', passwordSet: !!profile.passwordSet || !!(profile.kind === 'mihomo' && profile.node && (profile.node.password || profile.node.uuid || profile.node['private-key'] || profile.node['pre-shared-key'])),
      })
      const selectProfile = (profile, scroll = true) => {
        editorDirty.current = !!scroll && !profile
        setSelectedId(profile?.id || '')
        setDraft(makeDraft(profile || {})); setImportedNode(null); setPassword(''); setPasswordChanged(false); setDeleteId(null); setMessage(null)
        if (scroll) editorRef.current?.scrollIntoView?.({ block: 'start' })
      }
      const accept = (r, preferredId, forceEditor = false) => {
        applyPool(r); setPollError(false)
        if (!policyDirty.current) setPolicy({ enabled: !!r.enabled, autoConnect: !!r.autoConnect, timeoutMs: r.timeoutMs || 10000, enginePath: r.enginePath || '' })
        const profiles = r.profiles || []
        const profile = profiles.find((p) => p.id === (preferredId || selectedId)) || profiles.find((p) => p.id === r.activeId) || profiles[0]
        if (forceEditor || !editorDirty.current) selectProfile(profile || null, false)
        if (r.scope) setScope(r.scope)
      }
      const formatLogTime = (value) => {
        const date = new Date(value)
        return Number.isNaN(date.getTime()) ? 'Chưa cung cấp thời gian' : date.toLocaleString('zh-CN', { hour12: false })
      }
      const statusLabel = (status) => ({ idle: 'Chưa phát hiện', connecting: 'Đang kết nối', connected: 'Kiểm tra đạt', error: 'Kết nối thất bại' })[status] || 'Chưa phát hiện'
      const profiles = pool && Array.isArray(pool.profiles) ? pool.profiles : []
      const profileIds = new Set(profiles.map((profile) => profile.id))
      const visibleSelectedIds = selectedIds.filter((id) => profileIds.has(id))
      const totalPages = Math.max(1, Math.ceil(profiles.length / pageSize))
      const currentPage = Math.min(Math.max(1, page), totalPages)
      const pageStart = (currentPage - 1) * pageSize
      const pageProfiles = profiles.slice(pageStart, pageStart + pageSize)
      const pageSelectedCount = pageProfiles.filter((profile) => visibleSelectedIds.includes(profile.id)).length
      const allPageSelected = pageProfiles.length > 0 && pageSelectedCount === pageProfiles.length
      const candidateTotalPages = Math.max(1, Math.ceil(candidates.length / candidatePageSize))
      const currentCandidatePage = Math.min(Math.max(1, candidatePage), candidateTotalPages)
      const candidateStart = (currentCandidatePage - 1) * candidatePageSize
      const pageCandidates = candidates.slice(candidateStart, candidateStart + candidatePageSize)
      const batchCurrentProfile = pool && pool.batchTest && profiles.find((profile) => profile.id === pool.batchTest.currentId)
      const batchResult = pool && pool.testSummary
        ? pool.testSummary
        : pool && pool.batchTest && pool.batchTest.status !== 'running'
          ? pool.batchTest
          : null
      const applyPool = (snapshot) => {
        setPool(snapshot)
        const ids = new Set((snapshot && snapshot.profiles || []).map((profile) => profile.id))
        setSelectedIds((previous) => previous.filter((id) => ids.has(id)))
      }
      const toggleSelected = (id, checked) => setSelectedIds((previous) => {
        const next = previous.filter((value) => value !== id)
        if (checked) next.push(id)
        return next
      })
      const togglePageSelected = (checked) => setSelectedIds((previous) => {
        const ids = new Set(previous)
        for (const profile of pageProfiles) {
          if (checked) ids.add(profile.id)
          else ids.delete(profile.id)
        }
        return Array.from(ids)
      })
      const beginBulkDelete = (ids) => {
        const unique = Array.from(new Set((ids || []).filter((id) => profileIds.has(id))))
        if (!unique.length) return
        setDeleteId(null)
        setBulkDeleteIds(unique)
        setMessage(null)
      }
      const load = async () => {
        if (operation.current) { reloadQueued.current = true; return }
        const ticket = ++sequence.current
        setBusy(true)
        try {
          const r = await api({ op: 'proxyPoolGet' })
          if (ticket !== sequence.current) return
          if (!r || !r.ok) throw new Error((r && r.error) || 'Không đọc được cấu hình proxy')
          accept(r)
        } catch (e) { if (ticket === sequence.current) setMessage({ error: true, text: e.message || 'Đọc thất bại' }) }
        finally { if (ticket === sequence.current) setBusy(false) }
      }
      React.useEffect(() => { load() }, [props.refreshKey])
      React.useEffect(() => () => { sequence.current += 1 }, [])
      React.useEffect(() => {
        if (!props.active) return
        const timer = setInterval(async () => {
          if (polling.current || (typeof document !== 'undefined' && document.hidden)) return
          const ticket = sequence.current
          polling.current = true
          try {
            const r = await api({ op: 'proxyPoolGet' })
            if (ticket === sequence.current) {
              if (r?.ok) {
                const batchSnapshot = batchTesting.current
                applyPool(r); setPollError(false)
                if (batchTesting.current && r.batchTest && r.batchTest.status !== 'running') {
                  batchTesting.current = false
                  const batchDoneTicket = batchTicket.current
                  if (batchDoneTicket === sequence.current) {
                    setConnecting(false)
                    const summary = r.testSummary || r.batchTest
                    setMessage({ text: r.batchTest.status === 'cancelled'
                      ? 'Đã hủy kiểm tra hàng loạt.'
                      : 'Kiểm tra hàng loạt hoàn tất · tổng ' + (summary.total || 0) + ' · đạt ' + (summary.passed || 0) + ' · thất bại ' + (summary.failed || 0) + ' · hủy ' + (summary.cancelled || 0) })
                    finishOperation(batchDoneTicket)
                  }
                }
                if (!policyDirty.current && !batchSnapshot) setPolicy({ enabled: !!r.enabled, autoConnect: !!r.autoConnect, timeoutMs: r.timeoutMs || 10000, enginePath: r.enginePath || '' })
              }
              else setPollError(true)
            }
          } catch { if (ticket === sequence.current) setPollError(true) }
          finally { polling.current = false }
        }, 5000)
        return () => clearInterval(timer)
      }, [props.active])
      const finishOperation = (ticket) => {
        if (ticket !== sequence.current) return
        sequence.current += 1
        operation.current = false
        setBusy(false)
        if (reloadQueued.current) { reloadQueued.current = false; load() }
      }
      const changePolicy = (patch) => { policyDirty.current = true; setPolicy(Object.assign({}, policy, patch)) }
      const change = (key, value) => {
        editorDirty.current = true
        setDraft((d) => Object.assign({}, d, { [key]: value }))
        if (['protocol', 'host', 'port', 'username'].includes(key)) { setPassword(''); setPasswordChanged(true) }
        setMessage(null)
      }
      const requestConfig = () => {
        const c = Object.assign({}, draft, { port: Number(draft.port) })
        delete c.passwordSet
        if (selectedId) c.id = selectedId
        else if (c.kind === 'mihomo' && importedNode) c.node = importedNode
        if (passwordChanged) c.password = password
        return c
      }
      const run = async (op, payload) => {
        const isBatchTest = op === 'proxyPoolTest'
        let batchPending = false
        if (isBatchTest) batchTesting.current = false
        setConnecting(op === 'proxyProfileConnect' || op === 'proxyProfileTest' || op === 'proxyPoolConnect' || isBatchTest || (op === 'proxyPoolSave' && payload?.settings?.enabled && payload.settings.autoConnect))
        operation.current = true
        const ticket = ++sequence.current
        setBusy(true); setMessage(null)
        try {
          const r = await api(Object.assign({ op }, payload || (op === 'proxyProfileSave' || op === 'proxyProfileTest' ? { profile: requestConfig() } : {})))
          if (ticket !== sequence.current) return
          if (r?.profiles) {
            applyPool(r); setPollError(false)
            if (!policyDirty.current && op !== 'proxyProfileTest' && op !== 'proxyPoolTest') setPolicy({ enabled: !!r.enabled, autoConnect: !!r.autoConnect, timeoutMs: r.timeoutMs || 10000, enginePath: r.enginePath || '' })
          }
          if (!r || !r.ok) throw new Error((r && r.error) || 'Thao tác thất bại')
          if (isBatchTest && r.batchTest?.status === 'running') {
            batchPending = true
            batchTesting.current = true
            batchTicket.current = ticket
          } else if (isBatchTest) batchTesting.current = false
          if (op === 'proxyProfileSave') accept(r, r.savedId, true)
          if (op === 'proxyPoolSave') { policyDirty.current = false; setPolicy({ enabled: !!r.enabled, autoConnect: !!r.autoConnect, timeoutMs: r.timeoutMs || 10000, enginePath: r.enginePath || '' }) }
          if (op === 'proxyProfileDelete') {
            setDeleteId(null)
            if (payload.id === selectedId) selectProfile(null, false)
          }
          if (op === 'proxyProfilesDelete') {
            setBulkDeleteIds(null)
            setSelectedIds((previous) => previous.filter((id) => (r.profiles || []).some((profile) => profile.id === id)))
            if (selectedId && !(r.profiles || []).some((profile) => profile.id === selectedId)) selectProfile(null, false)
          }
          const messages = {
            proxyProfileSave: 'Node đã lưu, có thể kết nối trong danh sách.', proxyProfileDelete: 'Đã xóa node.',
            proxyProfilesDelete: 'Đã xóa ' + ((payload && payload.ids) || []).length + ' node.',
            proxyPoolSave: 'Đã lưu chính sách kết nối.', proxyPoolImport: 'Đã thêm ' + (r.importedCount || 0) + ' node.',
          }
          if (isBatchTest && r.batchTest?.status === 'running') setMessage({ text: 'Đang kiểm tra hàng loạt…' })
          else if (isBatchTest && r.testSummary) setMessage({ text: 'Kiểm tra hàng loạt hoàn tất · tổng ' + r.testSummary.total + ' · đạt ' + r.testSummary.passed + ' · thất bại ' + r.testSummary.failed + ' · hủy ' + (r.testSummary.cancelled || 0) })
          else setMessage({ text: (messages[op] || r.message || 'Kiểm tra kết nối đã xong, xem trạng thái node và nhật ký chuyển đổi.') + (op === 'proxyProfileTest' && Number.isFinite(r.latencyMs) ? ' · ' + r.latencyMs + ' ms' : '') })
          if (op === 'proxyPoolImport') {
            setWarnings(r.warnings || []); setCandidates([]); setCandidatePage(1); setYaml('')
            if (importedNode && !selectedId) {
              setDraft(makeDraft()); setImportedNode(null); setPassword(''); setPasswordChanged(false); editorDirty.current = false
            }
          }
        } catch (e) { if (ticket === sequence.current) setMessage({ error: true, text: e.message || 'Thao tác thất bại' }) }
        finally { if (ticket === sequence.current && !batchPending) { setConnecting(false); finishOperation(ticket) } }
      }
      const disconnect = async (id) => {
        const ticket = ++sequence.current
        batchTesting.current = false
        operation.current = true
        setBusy(true); setDisconnecting(true); setMessage(null)
        try {
          const r = await api(Object.assign({ op: 'proxyPoolDisconnect' }, id ? { id } : {}))
          if (ticket !== sequence.current) return
          if (!r?.ok) throw new Error(r?.error || 'Ngắt kết nối thất bại')
          applyPool(r); setPollError(false); setConnecting(false)
          policyDirty.current = false
          setPolicy({ enabled: !!r.enabled, autoConnect: !!r.autoConnect, timeoutMs: r.timeoutMs || 10000, enginePath: r.enginePath || '' })
          setMessage({ text: 'Đã ngắt node và dừng tự động kết nối, cấu hình node vẫn được giữ.' })
        } catch (e) { if (ticket === sequence.current) setMessage({ error: true, text: e.message || 'Ngắt kết nối thất bại' }) }
        finally { if (ticket === sequence.current) setDisconnecting(false); finishOperation(ticket) }
      }
      const parseYaml = async () => {
        operation.current = true
        const ticket = ++sequence.current
        setBusy(true); setMessage(null); setCandidates([]); setCandidatePage(1); setWarnings([])
        try {
          const r = await api({ op: 'proxyConfigImport', yaml })
          if (ticket !== sequence.current) return
          if (!r || !r.ok) throw new Error((r && r.error) || 'Phân tích YAML thất bại')
          setCandidates(r.candidates || []); setCandidatePage(1); setWarnings(r.warnings || [])
          setMessage({ text: r.candidates && r.candidates.length ? 'Đã tìm thấy ' + r.candidates.length + ' node, có thể nhập tất cả một lần hoặc sửa từng cái.' : 'Không tìm thấy cấu hình proxy HTTP/SOCKS cục bộ khả dụng.' })
        } catch (e) { if (ticket === sequence.current) setMessage({ error: true, text: e.message || 'Phân tích thất bại' }) }
        finally { finishOperation(ticket) }
      }
      const readYamlFile = async (file) => {
        if (!file || busy || operation.current) return
        operation.current = true
        const ticket = ++sequence.current
        setBusy(true); setMessage(null); setCandidates([]); setCandidatePage(1); setWarnings([])
        try {
          if (!/\.ya?ml$/i.test(file.name || '')) throw new Error('Hãy chọn tệp cấu hình .yaml hoặc .yml')
          if (file.size > 1024 * 1024) throw new Error('Tệp cấu hình không được vượt quá 1 MB')
          const contents = await file.text()
          if (ticket !== sequence.current) return
          setYaml(contents)
          const r = await api({ op: 'proxyConfigImport', yaml: contents })
          if (ticket !== sequence.current) return
          if (!r?.ok) throw new Error(r?.error || 'Phân tích YAML thất bại')
          setCandidates(r.candidates || []); setCandidatePage(1); setWarnings(r.warnings || [])
          setMessage({ text: 'Đã đọc và nhận diện ' + (r.candidates || []).length + ' node, hãy bấm "Nhập tất cả node" để thêm vào danh sách.' })
        } catch (err) { if (ticket === sequence.current) setMessage({ error: true, text: err.message || 'Đọc tệp thất bại' }) }
        finally { finishOperation(ticket) }
      }
      const readFile = async (e) => {
        const input = e.target
        try { await readYamlFile(input.files && input.files[0]) }
        finally { input.value = '' }
      }
      const isFileDrag = (e) => Array.from((e.dataTransfer && e.dataTransfer.types) || []).includes('Files')
      const dragEnter = (e) => {
        if (!isFileDrag(e)) return
        e.preventDefault(); e.stopPropagation()
        if (busy || operation.current) return
        dragDepth.current += 1
        setDragActive(true)
      }
      const dragOver = (e) => {
        if (!isFileDrag(e)) return
        e.preventDefault(); e.stopPropagation()
        e.dataTransfer.dropEffect = busy || operation.current ? 'none' : 'copy'
      }
      const dragLeave = (e) => {
        if (!dragDepth.current) return
        e.preventDefault(); e.stopPropagation()
        dragDepth.current = Math.max(0, dragDepth.current - 1)
        if (!dragDepth.current) setDragActive(false)
      }
      const dropFile = async (e) => {
        if (!isFileDrag(e)) return
        e.preventDefault(); e.stopPropagation()
        dragDepth.current = 0; setDragActive(false)
        if (busy || operation.current) return
        const files = Array.from(e.dataTransfer.files || [])
        if (files.length !== 1) {
          setMessage({ error: true, text: 'Mỗi lần chỉ kéo vào một tệp YAML, không hỗ trợ thư mục hay nhiều tệp.' })
          return
        }
        await readYamlFile(files[0])
      }
      const field = (label, key, extra = {}) => h('label', { className: 'rt-settings-field' }, label,
        h('input', Object.assign({ className: 'rt-input rt-settings-control', value: draft[key], name: 'proxy-' + key, autoComplete: 'off', onChange: (e) => change(key, e.target.value), disabled: busy, 'aria-label': label }, extra)))
      return h('div', { className: 'rt-proxy-settings' },
        h('div', { className: 'rt-settings-section-head' }, h('div', null,
          h('h2', null, 'Cài đặt proxy'), h('p', null, 'Nhập YAML hoặc điền thủ công, xem trước và xác nhận rồi lưu.'))),
        h('div', { className: 'rt-settings-card rt-settings-note-card' },
          h('h3', null, 'Phạm vi hiệu lực'), h('p', { className: 'rt-settings-card-copy' }, scope)),
        message ? h('div', { className: 'rt-settings-alert' + (message.error ? ' rt-err' : ''), role: message.error ? 'alert' : 'status' }, message.text) : null,
        pool ? h('div', { className: 'rt-settings-card rt-proxy-policy' },
          h('div', { className: 'rt-settings-card-head' }, h('div', null,
            h('h3', null, 'Chính sách kết nối'),
            h('p', null, 'Đang dùng: ' + ((pool.profiles || []).find((p) => p.id === pool.activeId)?.name || 'Chưa chọn node') + (pool.enabled ? '' : ' · proxy đã tắt')))),
          h('div', { className: 'rt-proxy-policy-controls' },
            h('label', { className: 'rt-proxy-toggle' }, h('input', { type: 'checkbox', checked: policy.enabled, disabled: busy, 'aria-label': 'Bật proxy plugin', onChange: (e) => changePolicy({ enabled: e.target.checked }) }), 'Bật proxy plugin'),
            h('label', { className: 'rt-proxy-toggle' }, h('input', { type: 'checkbox', checked: policy.autoConnect, disabled: busy, 'aria-label': 'Tự động kết nối và chuyển đổi khi lỗi', onChange: (e) => changePolicy({ autoConnect: e.target.checked }) }), 'Tự động kết nối và chuyển đổi khi lỗi'),
            h('label', { className: 'rt-settings-field rt-proxy-timeout' }, 'Thời gian chờ mỗi node (giây)', h('input', { className: 'rt-input rt-settings-control', type: 'number', min: 1, max: 30, step: 1, value: policy.timeoutMs / 1000, disabled: busy, 'aria-label': 'Thời gian chờ mỗi node (giây)', onChange: (e) => changePolicy({ timeoutMs: Number(e.target.value) * 1000 }) })),
            h('button', { className: 'rt-btn rt-btn-primary', disabled: busy, onClick: () => run('proxyPoolSave', { settings: policy }) }, 'Lưu chính sách kết nối'),
            h('button', { className: 'rt-btn', disabled: busy || !pool.profiles?.some((p) => p.enabled), onClick: () => run('proxyPoolConnect') }, 'Tự động kết nối ngay'),
            h('button', { className: 'rt-btn rt-btn-danger', disabled: disconnecting || (!pool.enabled && !pool.activeId && !connecting && !pool.profiles?.some((p) => p.status === 'connecting')), onClick: () => disconnect() }, disconnecting ? 'Đang ngắt…' : 'Ngắt node hiện tại')),
          h('p', { className: 'rt-settings-card-copy' }, 'Tự động kết nối thử theo thứ tự danh sách các node khả dụng; khi một node quá thời gian sẽ chuyển sang node kế tiếp, mỗi vòng có tổng thời hạn, nếu tất cả thất bại sẽ dừng và ghi lại lý do. Ngắt sẽ dừng kết nối và giữ lại mọi node.'),
          h('label', { className: 'rt-settings-field rt-proxy-engine-path' }, 'Đường dẫn kernel Mihomo (tùy chọn, để trống sẽ tự phát hiện)', h('input', { className: 'rt-input rt-settings-control', value: policy.enginePath || '', disabled: busy, autoComplete: 'off', 'aria-label': 'Đường dẫn kernel Mihomo', placeholder: 'Tự tìm trong PATH và kernel của ứng dụng Clash đã cài', onChange: (e) => changePolicy({ enginePath: e.target.value }) })),
          h('p', { className: 'rt-settings-card-copy' }, pool.engine?.available ? (pool.engine.running ? 'Kernel proxy cách ly đang chạy · ' : 'Đã phát hiện kernel proxy · ') + pool.engine.path : 'Node đăng ký SS, VMess, Trojan cần kernel Mihomo. Plugin chạy kernel độc lập, không sửa proxy hệ thống.')) : null,
        pool ? h('div', { className: 'rt-settings-card rt-proxy-list-card' },
          h('div', { className: 'rt-settings-card-head rt-proxy-list-head' },
            h('div', null, h('h3', null, 'Node proxy · ' + profiles.length), h('p', null, 'Sửa lưu và kết nối tách riêng; node bị tắt sẽ không tham gia tự động kết nối.')),
            h('div', { className: 'rt-proxy-list-head-actions' },
              h('button', { className: 'rt-btn', disabled: busy || !profiles.length, onClick: () => run('proxyPoolTest', { ids: visibleSelectedIds.length ? visibleSelectedIds : profiles.map((profile) => profile.id) }) }, visibleSelectedIds.length ? 'Kiểm tra mục chọn' : 'Kiểm tra tất cả'),
              h('button', { className: 'rt-btn', disabled: busy || !visibleSelectedIds.length, onClick: () => beginBulkDelete(visibleSelectedIds) }, 'Xóa mục chọn'),
              h('button', { className: 'rt-btn rt-btn-danger', disabled: busy || !profiles.length, onClick: () => beginBulkDelete(profiles.map((profile) => profile.id)) }, 'Xóa tất cả'),
              h('button', { className: 'rt-btn rt-btn-primary', disabled: busy, onClick: () => selectProfile(null) }, 'Thêm node'))),
          h('div', { className: 'rt-proxy-list-status' },
            h('span', { className: 'rt-tag' }, 'Đã chọn ' + visibleSelectedIds.length),
            !visibleSelectedIds.length ? h('span', { className: 'rt-settings-card-copy' }, 'Sẽ kiểm tra tất cả node.') : null,
            pool.batchTest && pool.batchTest.status === 'running'
              ? h('span', { className: 'rt-tag rt-tag-warn', role: 'status' }, 'Tiến độ kiểm tra ' + (pool.batchTest.completed || 0) + ' / ' + (pool.batchTest.total || 0) + ' · đạt ' + (pool.batchTest.passed || 0) + ' · thất bại ' + (pool.batchTest.failed || 0) + (batchCurrentProfile || pool.batchTest.currentId ? ' · hiện tại ' + (batchCurrentProfile?.name || pool.batchTest.currentId) : ''))
              : batchResult ? h('span', { className: 'rt-tag ' + (pool.batchTest?.status === 'cancelled' ? 'rt-tag-warn' : 'rt-tag-live'), role: 'status' }, (pool.batchTest?.status === 'cancelled' ? 'Đã hủy kiểm tra' : 'Kiểm tra hoàn tất') + ' · tổng ' + (batchResult.total || 0) + ' · đạt ' + (batchResult.passed || 0) + ' · thất bại ' + (batchResult.failed || 0) + ' · hủy ' + (batchResult.cancelled || 0)) : null),
          bulkDeleteIds ? h('div', { className: 'rt-proxy-bulk-confirm', role: 'alert' },
            h('strong', null, 'Chờ xóa ' + bulkDeleteIds.length + ' node.'),
            h('span', null, bulkDeleteIds.includes(pool.activeId) ? 'Trong đó có node đang dùng, sau khi xác nhận sẽ ngắt proxy hiện tại.' : 'Hãy xác nhận có tiếp tục không.'),
            h('button', { className: 'rt-btn rt-btn-danger', disabled: busy, onClick: () => run('proxyProfilesDelete', { ids: bulkDeleteIds.slice() }) }, 'Xác nhận xóa mục chọn'),
            h('button', { className: 'rt-btn', disabled: busy, onClick: () => setBulkDeleteIds(null) }, 'Hủy')) : null,
          h('div', { className: 'rt-proxy-table-scroll' }, h('table', { className: 'rt-proxy-table', 'aria-label': 'Danh sách node proxy' },
            h('thead', null, h('tr', null,
              h('th', { scope: 'col' }, h('label', { className: 'rt-proxy-page-select' }, h('input', { type: 'checkbox', className: 'rt-proxy-page-select-input', checked: allPageSelected, disabled: busy || !pageProfiles.length, 'aria-label': 'Chọn tất cả trang này', onChange: (e) => togglePageSelected(e.target.checked) }), 'Chọn tất cả trang này')),
              ['Địa chỉ proxy', 'Trạng thái kiểm tra', 'Độ trễ', 'Thao tác'].map((label) => h('th', { key: label, scope: 'col' }, label)))),
            h('tbody', null, pageProfiles.map((profile, index) => h('tr', { key: profile.id, className: profile.id === selectedId ? 'rt-proxy-row-selected' : '' },
              h('td', null, h('div', { className: 'rt-proxy-node-name' },
                h('input', { type: 'checkbox', className: 'rt-proxy-select', checked: visibleSelectedIds.includes(profile.id), disabled: busy, 'aria-label': 'Chọn node ' + (profile.name || profile.id), onChange: (e) => toggleSelected(profile.id, e.target.checked) }),
                h('span', { className: 'rt-proxy-order' }, String(pageStart + index + 1).padStart(2, '0')), h('strong', null, profile.name || 'Node chưa đặt tên')),
                profile.kind === 'mihomo' ? h('span', { className: 'rt-tag' }, 'Mihomo') : null,
                profile.id === pool.activeId && pool.enabled ? h('span', { className: 'rt-tag rt-tag-live' }, 'Đang dùng') : null,
                !profile.enabled ? h('span', { className: 'rt-tag' }, 'Đã tắt') : null),
              h('td', { className: 'rt-mono' }, profile.protocol?.toUpperCase() + ' · ' + profile.host + ':' + profile.port),
              h('td', null, h('span', { className: 'rt-tag' + (profile.status === 'connected' ? ' rt-tag-live' : profile.status === 'error' ? ' rt-tag-warn' : '') }, statusLabel(profile.status)),
                profile.lastError ? h('div', { className: 'rt-proxy-node-error' }, profile.lastError) : null,
                profile.lastCheckedAt ? h('div', { className: 'rt-proxy-node-check' }, 'Kiểm tra lúc ' + formatLogTime(profile.lastCheckedAt)) : null),
              h('td', null, Number.isFinite(profile.latencyMs) ? profile.latencyMs + ' ms' : '—'),
              h('td', null, h('div', { className: 'rt-proxy-row-actions' },
                deleteId === profile.id ? [
                  h('button', { key: 'confirm', className: 'rt-btn rt-btn-danger', disabled: busy, onClick: () => run('proxyProfileDelete', { id: profile.id }) }, 'Xác nhận xóa'),
                  h('button', { key: 'cancel', className: 'rt-btn', disabled: busy, onClick: () => setDeleteId(null) }, 'Hủy'),
                ] : [
                  h('button', { key: 'test', className: 'rt-btn', disabled: busy, onClick: () => run('proxyProfileTest', { profile: { id: profile.id } }) }, 'Kiểm tra'),
                  h('button', { key: 'connect', className: 'rt-btn', disabled: busy || !profile.enabled, onClick: () => run('proxyProfileConnect', { id: profile.id }) }, 'Kết nối'),
                  (pool.enabled && profile.id === pool.activeId) || profile.status === 'connecting' ? h('button', { key: 'disconnect', className: 'rt-btn rt-btn-danger', disabled: disconnecting, onClick: () => disconnect(profile.id) }, 'Ngắt') : null,
                  h('button', { key: 'edit', className: 'rt-btn', disabled: busy, onClick: () => selectProfile(profile) }, 'Sửa'),
                  h('button', { key: 'delete', className: 'rt-btn', disabled: busy, onClick: () => setDeleteId(profile.id) }, 'Xóa'),
                ]))))))),
          !profiles.length ? h('p', { className: 'rt-empty' }, 'Chưa có node proxy. Có thể thêm node, hoặc nhập hàng loạt từ YAML bên dưới.') : null,
          h('div', { className: 'rt-proxy-pagination', role: 'navigation', 'aria-label': 'Phân trang node proxy' },
            h('label', null, 'Mỗi trang', h('select', { className: 'rt-input rt-settings-control', value: pageSize, disabled: busy, 'aria-label': 'Số mục mỗi trang', onChange: (e) => { setPageSize(Number(e.target.value)); setPage(1) } }, [20, 50, 100].map((size) => h('option', { key: size, value: size }, String(size))))),
            h('span', { role: 'status' }, profiles.length ? (pageStart + 1) + '–' + Math.min(pageStart + pageSize, profiles.length) + ' / ' + profiles.length + ' · trang ' + currentPage + ' / ' + totalPages : '0 / 0'),
            h('button', { className: 'rt-btn', disabled: busy || currentPage <= 1, 'aria-label': 'Trang trước danh sách proxy', onClick: () => setPage(Math.max(1, currentPage - 1)) }, 'Trang trước'),
            h('button', { className: 'rt-btn', disabled: busy || currentPage >= totalPages, 'aria-label': 'Trang sau danh sách proxy', onClick: () => setPage(Math.min(totalPages, currentPage + 1)) }, 'Trang sau')),
          h('p', { className: 'rt-settings-card-copy' }, '"Kết nối" sẽ kiểm tra node và bật khi thành công; "Kiểm tra" chỉ cập nhật trạng thái node đó, không chuyển proxy hiện tại hay chính sách tự động kết nối. Ngắt node hiện tại cũng dừng kiểm tra hàng loạt đang chạy.')) : null,
        pool ? h('details', { className: 'rt-settings-card rt-proxy-log-card', open: logsOpen, onToggle: (e) => setLogsOpen(e.currentTarget.open) },
          h('summary', null, 'Nhật ký kết nối và chuyển đổi', h('span', { className: 'rt-tag' }, String((pool.logs || []).length) + ' mục')),
          h('p', { className: 'rt-settings-card-copy', role: 'status', 'aria-live': 'polite' }, pool.logs?.length ? 'Bản ghi mới nhất: ' + pool.logs[pool.logs.length - 1].message : 'Chưa có bản ghi kết nối'),
          h('div', { className: 'rt-proxy-log-scroll', role: 'region', 'aria-label': 'Nhật ký chuyển proxy', tabIndex: 0 },
            pool.logs?.length ? h('ol', { className: 'rt-proxy-log-list' }, pool.logs.slice().reverse().map((entry) => h('li', { key: entry.id, className: 'rt-proxy-log-' + entry.level },
              h('time', { dateTime: entry.at }, formatLogTime(entry.at)),
              h('span', { className: 'rt-proxy-log-level' }, entry.level === 'error' ? 'Thất bại' : entry.level === 'warn' ? 'Gợi ý' : 'Ghi nhận'),
              h('span', null, entry.message)))) : h('p', { className: 'rt-settings-card-copy' }, 'Chưa có bản ghi kết nối. Sau khi kết nối hoặc tự động chuyển sẽ hiển thị thử, quá thời gian, chuyển đổi và kết quả.')),
          h('p', { className: 'rt-settings-card-copy', role: pollError ? 'status' : undefined }, pollError ? 'Làm mới trạng thái thất bại, đang hiển thị bản ghi đọc thành công lần trước.' : 'Gần nhất 200 bản ghi; khi mở trang làm mới mỗi 5 giây, làm mới không ghi đè biểu mẫu chưa lưu.')) : null,
        !draft ? h('div', { className: 'rt-settings-card' },
          h('p', null, busy ? 'Đang đọc cài đặt proxy…' : 'Cài đặt proxy tạm thời không khả dụng'),
          h('button', { className: 'rt-btn', disabled: busy, onClick: load }, 'Đọc lại')) :
        h('div', { className: 'rt-proxy-grid', ref: editorRef },
          h('div', { className: 'rt-settings-card' },
            h('div', { className: 'rt-settings-card-head' }, h('div', null, h('h3', null, selectedId ? 'Sửa node' : 'Thêm node'), h('p', null, draft.kind === 'mihomo' ? 'Node đăng ký chạy bằng kernel Mihomo cách ly, TLS và tham số truyền tải giữ nguyên cấu hình trong tệp gốc.' : 'Hỗ trợ proxy HTTP, HTTPS và SOCKS5.'))),
            h('label', { className: 'rt-proxy-toggle' }, h('input', { type: 'checkbox', checked: draft.enabled, disabled: busy, onChange: (e) => change('enabled', e.target.checked) }), 'Tham gia tự động kết nối'),
            h('div', { className: 'rt-proxy-fields' },
              field('Tên node', 'name', { placeholder: 'Ví dụ Clash trên máy' }),
              h('label', { className: 'rt-settings-field' }, 'Giao thức proxy', h('select', { className: 'rt-input rt-settings-control', value: draft.protocol, disabled: busy || draft.kind === 'mihomo', onChange: (e) => change('protocol', e.target.value) },
                (draft.kind === 'mihomo' ? [draft.protocol] : ['http', 'https', 'socks5']).map((protocol) => h('option', { key: protocol, value: protocol }, protocol.toUpperCase())))),
              field('Host proxy', 'host', { placeholder: '127.0.0.1', autoComplete: 'off', spellCheck: false }),
              field('Cổng proxy', 'port', { type: 'number', min: 1, max: 65535, placeholder: '7890' }),
              field('Tên người dùng (tùy chọn)', 'username', { autoComplete: 'off' }),
              h('label', { className: 'rt-settings-field' }, draft.kind === 'mihomo' ? 'Thông tin xác thực node (VMess/VLESS là UUID)' : 'Mật khẩu (tùy chọn)', h('input', {
                type: 'password', className: 'rt-input rt-settings-control', value: password, disabled: busy, autoComplete: 'new-password',
                placeholder: draft.passwordSet && !passwordChanged ? 'Đã cấu hình; để trống sẽ giữ thông tin xác thực' : 'Chưa đặt mật khẩu',
                onChange: (e) => { editorDirty.current = true; setPassword(e.target.value); setPasswordChanged(true); setMessage(null) },
              })),
              h('label', { className: 'rt-settings-field rt-proxy-wide' }, 'Địa chỉ kết nối trực tiếp (tùy chọn)', h('textarea', {
                className: 'rt-input rt-settings-control', rows: 2, value: draft.noProxy, disabled: busy,
                placeholder: 'localhost,127.0.0.1,::1,.example.com', onChange: (e) => change('noProxy', e.target.value),
              }))),
            h('div', { className: 'rt-proxy-actions' },
              h('button', { className: 'rt-btn rt-btn-primary', disabled: busy, onClick: () => run('proxyProfileSave') }, 'Lưu node'),
              h('button', { className: 'rt-btn', disabled: busy || !draft.host || !draft.port, onClick: () => run('proxyProfileTest') }, busy ? 'Đang xử lý…' : 'Kiểm tra kết nối'),
              draft.passwordSet ? h('button', { className: 'rt-btn', disabled: busy, onClick: () => { editorDirty.current = true; setPassword(''); setPasswordChanged(true); setMessage({ text: 'Mật khẩu sẽ bị xóa sau khi lưu.' }) } }, 'Xóa mật khẩu') : null),
            h('p', { className: 'rt-settings-card-copy' }, 'Kiểm tra truy cập https://api.github.com/ qua proxy, dùng biểu mẫu hiện tại nhưng không tự lưu. Sau khi tắt proxy vẫn giữ cấu hình đã điền.')),
          h('div', { className: 'rt-settings-card rt-proxy-import-card', onDragEnter: dragEnter, onDragOver: dragOver, onDragLeave: dragLeave, onDrop: dropFile },
            h('div', { className: 'rt-settings-card-head' }, h('div', null, h('h3', null, 'Nhập YAML'), h('p', null, 'Hỗ trợ cổng cục bộ, HTTP/SOCKS, và node đa giao thức Clash/Mihomo; mỗi node được thêm độc lập vào danh sách.'))),
            h('div', { className: 'rt-proxy-dropzone' + (dragActive ? ' rt-proxy-dropzone-active' : ''), 'aria-busy': busy },
              h('strong', { role: 'status' }, dragActive ? 'Thả ra để đọc cấu hình YAML' : 'Kéo tệp YAML vào đây'),
              h('p', null, 'Hỗ trợ .yaml / .yml, một tệp không quá 1 MB'),
              h('label', { className: 'rt-settings-field' }, 'Cũng có thể chọn tệp cấu hình', h('input', { type: 'file', className: 'rt-input rt-settings-control rt-proxy-file', accept: '.yaml,.yml,application/yaml,text/yaml', disabled: busy, onChange: readFile }))),
            h('label', { className: 'rt-settings-field' }, 'Hoặc dán nội dung cấu hình', h('textarea', { className: 'rt-input rt-settings-control rt-proxy-yaml', rows: 8, value: yaml, disabled: busy, spellCheck: false, 'aria-label': 'Nội dung cấu hình YAML', placeholder: 'mixed-port: 7890\n# hoặc\nproxy:\n  protocol: http\n  host: 127.0.0.1\n  port: 7890', onChange: (e) => { setYaml(e.target.value); setCandidates([]); setCandidatePage(1); setWarnings([]) } })),
            h('div', { className: 'rt-proxy-actions' }, h('button', { className: 'rt-btn', disabled: busy || !yaml.trim(), onClick: parseYaml }, 'Phân tích YAML'),
              h('button', { className: 'rt-btn rt-btn-primary', disabled: busy || !yaml.trim(), onClick: () => run('proxyPoolImport', { yaml }) }, 'Nhập tất cả node')),
            warnings.map((warning, i) => h('p', { key: i, className: 'rt-settings-alert', role: 'status' }, warning)),
            h('div', { className: 'rt-proxy-candidates', role: 'region', 'aria-label': 'Xem trước node nhập', tabIndex: 0 }, pageCandidates.map((candidate, i) => h('div', { key: candidate.id || candidate.name + '-' + (candidateStart + i), className: 'rt-proxy-candidate' },
              h('div', null, h('strong', null, candidate.name || 'Cấu hình proxy'), h('p', { className: 'rt-mono' }, candidate.protocol.toUpperCase() + ' · ' + candidate.host + ':' + candidate.port)),
              h('button', { className: 'rt-btn', disabled: busy, onClick: () => {
                editorDirty.current = true; setSelectedId(''); setDraft(makeDraft(candidate)); setImportedNode(candidate.node || null)
                setPassword(candidate.kind === 'mihomo' ? '' : (candidate.password || '')); setPasswordChanged(candidate.kind !== 'mihomo')
                setMessage({ text: 'Đã nạp node hiện tại để sửa, các bản xem trước khác được giữ; cũng có thể nhập tất cả node một lần.' })
              } }, 'Sửa node này')))),
            candidates.length ? h('div', { className: 'rt-proxy-pagination rt-proxy-candidate-pagination', role: 'navigation', 'aria-label': 'Phân trang xem trước nhập' },
              h('label', null, 'Mỗi trang xem trước', h('select', { className: 'rt-input rt-settings-control', value: candidatePageSize, disabled: busy, 'aria-label': 'Số mục mỗi trang xem trước nhập', onChange: (e) => { setCandidatePageSize(Number(e.target.value)); setCandidatePage(1) } }, [20, 50, 100].map((size) => h('option', { key: size, value: size }, String(size))))),
              h('span', { role: 'status' }, (candidateStart + 1) + '–' + Math.min(candidateStart + candidatePageSize, candidates.length) + ' / ' + candidates.length),
              h('button', { className: 'rt-btn', disabled: busy || currentCandidatePage <= 1, 'aria-label': 'Trang trước xem trước nhập', onClick: () => setCandidatePage(Math.max(1, currentCandidatePage - 1)) }, 'Trang trước'),
              h('button', { className: 'rt-btn', disabled: busy || currentCandidatePage >= candidateTotalPages, 'aria-label': 'Trang sau xem trước nhập', onClick: () => setCandidatePage(Math.min(candidateTotalPages, currentCandidatePage + 1)) }, 'Trang sau')) : null,
            h('p', { className: 'rt-settings-card-copy' }, 'Nhập sẽ giữ tất cả node. HTTP/SOCKS kết nối trực tiếp; SS, VMess, Trojan… khi kết nối sẽ do plugin chạy kernel Mihomo cục bộ độc lập.'))))
    }

    function EnvTab(props) {
      const refreshKey = props.refreshKey || 0
      const [data, setData] = React.useState(null)
      const [draft, setDraft] = React.useState(null)
      const [err, setErr] = React.useState(null)
      const [msg, setMsg] = React.useState(null)
      const [busy, setBusy] = React.useState(false)
      const [folderPath, setFolderPath] = React.useState('')
      const [settingsSection, setSettingsSection] = React.useState('overview')
      const [proxyRefresh, setProxyRefresh] = React.useState(0)
      /* Intel freshness: template age + KEV advisories, read with the environment page (separate op) */
      const [intel, setIntel] = React.useState(null)
      const [intelBusy, setIntelBusy] = React.useState(false)
      const [intelMsg, setIntelMsg] = React.useState(null)

      const loadIntel = () => {
        api({ op: 'intelStatus' }).then((r) => { setIntel(r && r.ok !== false ? r : null) }, () => setIntel(null))
      }
      const syncIntelData = () => {
        setIntelBusy(true); setIntelMsg(null)
        api({ op: 'intelSync' }).then((r) => {
          if (!r || r.ok === false) {
            setIntelMsg({ err: (r && r.error) || 'Đồng bộ kho nền thất bại, tiếp tục dùng dữ liệu cục bộ' })
          } else {
            const result = r.result || {}
            const label = { updated: 'Kho nền đã đồng bộ', skipped: 'Kho nền không cần cập nhật hoặc chưa cấu hình nguồn dữ liệu', deferred: 'Kho nền đang bị chiếm, thử lại sau' }[result.action]
            setIntelMsg({ ok: label || String(result.action || 'Chưa cập nhật') })
          }
          loadIntel()
        }, (e) => setIntelMsg({ err: String((e && e.message) || e) }))
          .finally(() => setIntelBusy(false))
      }
      const refreshIntel = (force) => {
        setIntelBusy(true); setIntelMsg(null)
        api({ op: 'intelRefresh', force: force === true }).then((r) => {
          setIntelBusy(false)
          if (!r || r.ok === false) { setIntelMsg({ err: (r && r.error) || 'Làm mới thất bại' }); return }
          const t = r.templates || {}
          const k = r.kev || {}
          setIntelMsg({
            ok: 'Mẫu: ' + ({ refreshed: 'Đã làm mới', installed: 'Đã cài', kept: 'Không cần làm mới', skipped: 'Đã bỏ qua (' + (t.reason || '') + ')', failed: 'Thất bại' }[t.action] || t.action || 'Hoàn tất')
              + (t.count ? ', ' + t.count + ' mẫu' : '')
              + ' | thông báo: ' + ({ refreshed: 'Đã cập nhật ' + (k.count || 0) + ' mục', skipped: 'Đã bỏ qua (' + (k.reason || '') + ')', failed: 'Lấy thất bại (không ảnh hưởng việc bắt đầu)' }[k.action] || 'Không đổi'),
          })
          loadIntel()
        }, (e) => { setIntelBusy(false); setIntelMsg({ err: String((e && e.message) || e) }) })
      }
      React.useEffect(loadIntel, [refreshKey])

      const applyDraftFrom = (r) => {
        const c = (r && r.config) || {}
        setDraft({
          platform: c.platform || 'auto',
          toolkitDir: c.toolkitDir || '',
          nucleiTemplatesDir: c.nucleiTemplatesDir || '',
          binDirsText: (c.binDirs || []).join('\n'),
          tools: Object.assign({}, c.tools || {}),
          env: Object.assign({ FOFA_KEY: '', REDTEAM_VPS_HOST: '', REDTEAM_VPS_KEY: '' }, c.env || {}),
          notes: c.notes || '',
        })
        if (c.toolkitDir) setFolderPath(c.toolkitDir)
      }

      const load = () => {
        setBusy(true); setMsg(null)
        api({ op: 'platformConfigGet' }).then((r) => {
          setBusy(false)
          if (!r || r.ok === false) { setErr((r && r.error) || 'Đọc thất bại'); return }
          setErr(null); setData(r)
          applyDraftFrom(r)
        }, (e) => { setBusy(false); setErr(String((e && e.message) || e)) })
      }
      React.useEffect(load, [refreshKey])

      const save = () => {
        if (!draft) return
        setBusy(true); setMsg(null)
        const config = {
          platform: draft.platform,
          toolkitDir: draft.toolkitDir,
          nucleiTemplatesDir: draft.nucleiTemplatesDir,
          binDirs: String(draft.binDirsText || '').split(/\r?\n/).map((x) => x.trim()).filter(Boolean),
          tools: draft.tools,
          env: draft.env,
          notes: draft.notes,
          envAdaptConfigured: true,
          envAdaptSkip: false,
        }
        api({ op: 'platformConfigSave', config }).then((r) => {
          setBusy(false)
          if (!r || r.ok === false) { setMsg({ err: (r && r.error) || 'Lưu thất bại' }); return }
          setData(r)
          setMsg({ ok: 'Đã lưu vào ' + ((r.config && r.config.path) || '$DSH_HOME/redteam/config.json') })
          applyDraftFrom(r)
        }, (e) => { setBusy(false); setMsg({ err: String((e && e.message) || e) }) })
      }

      const assignFolder = () => {
        const dir = String(folderPath || (draft && draft.toolkitDir) || '').trim()
        if (!dir) { setMsg({ err: 'Hãy điền đường dẫn thư mục chứa công cụ trước' }); return }
        setBusy(true); setMsg(null)
        api({ op: 'platformAssignToolkit', dir }).then((r) => {
          setBusy(false)
          if (!r || r.ok === false) { setMsg({ err: (r && r.error) || 'Tự phân bổ thất bại' }); return }
          setData(r)
          applyDraftFrom(r)
          setMsg({
            ok: 'Đã phân bổ từ thư mục ' + (r.assignedCount || 0) + ' công cụ'
              + (r.nucleiTemplatesDir ? ', và nhận diện nuclei-templates' : ''),
          })
        }, (e) => { setBusy(false); setMsg({ err: String((e && e.message) || e) }) })
      }

      const setTool = (id, value) => setDraft((d) => d ? Object.assign({}, d, { tools: Object.assign({}, d.tools, { [id]: value }) }) : d)
      const setEnv = (key, value) => setDraft((d) => d ? Object.assign({}, d, { env: Object.assign({}, d.env, { [key]: value }) }) : d)

      const runtime = (data && data.runtime) || {}
      const adapt = (data && data.adapt) || {}
      const tools = (data && data.tools && data.tools.items) || []
      const found = tools.filter((t) => t.path).length
      const defaultToolkit = (data && data.toolkitDir) || '$DSH_HOME/redteam/toolkit'
      const defaultNuclei = (data && data.nucleiTemplatesDir) || (defaultToolkit + '/nuclei-templates')
      const settingsPlatform = data
        ? (runtime.effective === 'windows' ? 'Windows' : runtime.effective ? 'Linux/Kali' : 'Chưa cung cấp')
        : 'Đang đọc…'
      const settingsReadiness = data
        ? (adapt.ready === true ? 'Sẵn sàng' : adapt.ready === false ? 'Chờ cấu hình' : 'Chưa cung cấp')
        : 'Đang đọc…'
      const settingsTools = data && data.tools && Array.isArray(data.tools.items)
        ? found + '/' + tools.length
        : data ? 'Chưa cung cấp' : 'Đang đọc…'
      const settingsStorage = data
        ? (data.config && data.config.error
          ? 'Đọc bất thường'
          : data.config && data.config.exists === true
            ? 'Đã lưu xuống đĩa'
            : data.config && data.config.exists === false
              ? 'Cấu hình mặc định'
              : 'Chưa cung cấp')
        : 'Đang đọc…'
      const settingsConfigPath = data && data.config && data.config.path
        ? data.config.path
        : data ? '$DSH_HOME/redteam/config.json' : 'Đang đọc…'

      // Endpoint banner. The server refuses to patch when the host is pointed at an
      // endpoint this build does not support, so the reason has to be visible before
      // the user presses Apply — otherwise the refusal looks like a bug.
      const gate = data && data.endpoint
      const gateBanner = gate && gate.ok !== true
        ? h('div', {
            className: 'rt-gate-banner',
            role: 'alert',
            style: {
              margin: '0 0 10px',
              padding: '10px 12px',
              border: '1px solid var(--rt-warn, #b45309)',
              background: 'color-mix(in srgb, var(--rt-warn, #b45309) 8%, transparent)',
              fontSize: 13,
              lineHeight: 1.5,
            },
          },
          h('strong', null, gate.status === 'unknown' ? 'Chưa xác định được endpoint' : 'Endpoint không được hỗ trợ'),
          h('div', { style: { marginTop: 4 } }, gate.message),
          gate.endpoint ? h('div', { style: { marginTop: 4, opacity: 0.75, fontFamily: 'monospace', fontSize: 12 } },
            'Phát hiện: ' + gate.endpoint + (gate.source ? '  ·  nguồn: ' + gate.source : '')) : null,
          h('div', { style: { marginTop: 4, opacity: 0.75, fontSize: 12 } },
            'Đặt DE_POLICY_ENDPOINT=https://' + (gate.allowed || 'ai.delify.vn') + ' hoặc trỏ lại DSH vào endpoint đó.'))
        : null

      return h('div', { className: 'rt-main rt-settings' },
        h('div', { className: 'rt-toolbar rt-settings-toolbar' },
          h('span', { style: { fontWeight: 600 } }, 'Thích ứng môi trường'),
          h('span', { className: 'rt-tag' }, runtime.effective === 'windows' ? 'Windows' : 'Linux/Kali'),
          adapt.kali ? h('span', { className: 'rt-tag rt-tag-live' }, 'Kali') : null,
          h('span', { className: 'rt-tag' + (adapt.ready ? ' rt-tag-live' : ' rt-tag-warn') },
            adapt.ready ? ('Sẵn sàng · ' + (adapt.reason || '')) : 'Chờ cấu hình'),
          h('span', { className: 'rt-tag' + (found ? ' rt-tag-live' : ' rt-tag-warn') }, 'Công cụ ' + found + '/' + tools.length),
          h('div', { className: 'rt-spacer' }),
          h('button', { className: 'rt-btn', disabled: busy, onClick: () => { setProxyRefresh((value) => value + 1); load() } }, busy ? 'Đang đọc…' : 'Làm mới'),
          h('button', { className: 'rt-btn rt-btn-primary', disabled: busy || !draft, hidden: settingsSection === 'proxy', onClick: save }, 'Lưu')),
        h('div', { className: 'rt-pane rt-settings-scroll' },
          gateBanner,
          err ? h('div', { className: 'rt-err rt-settings-alert rt-settings-alert-error', role: 'alert' }, err) : null,
          msg ? h('div', { className: (msg.err ? 'rt-err' : 'rt-foot') + ' rt-settings-alert', role: msg.err ? 'alert' : 'status' }, msg.err || msg.ok) : null,
          h('header', { className: 'rt-settings-pagehead' },
            h('div', { className: 'rt-settings-pagehead-copy' },
              h('div', { className: 'rt-settings-eyebrow' }, 'Thích ứng môi trường'),
              h('h1', null, 'Môi trường và cài đặt'),
              h('p', null, 'Nền tảng, tình trạng chạy và cài đặt có vị trí riêng.'))),
          h('div', { className: 'rt-settings-summary', role: 'list', 'aria-label': 'Tóm tắt môi trường' },
            h('div', { className: 'rt-settings-summary-card', role: 'listitem' },
              h('span', { className: 'rt-settings-summary-icon', 'aria-hidden': 'true' }, '◌'),
              h('div', null, h('strong', null, settingsPlatform), h('span', null, 'Nền tảng công cụ hiện tại'))),
            h('div', { className: 'rt-settings-summary-card', role: 'listitem' },
              h('span', { className: 'rt-settings-summary-icon', 'aria-hidden': 'true' }, '✓'),
              h('div', null, h('strong', null, settingsReadiness), h('span', null, adapt.reason || 'Trạng thái thích ứng môi trường'))),
            h('div', { className: 'rt-settings-summary-card', role: 'listitem' },
              h('span', { className: 'rt-settings-summary-icon', 'aria-hidden': 'true' }, '▤'),
              h('div', null, h('strong', null, settingsTools), h('span', null, data ? 'Công cụ đã phát hiện' : 'Danh mục công cụ'))),
            h('div', { className: 'rt-settings-summary-card', role: 'listitem' },
              h('span', { className: 'rt-settings-summary-icon', 'aria-hidden': 'true' }, '⌂'),
              h('div', null, h('strong', null, settingsStorage), h('span', null, 'Lưu trữ cấu hình')))),
          h('div', { className: 'rt-settings-workspace' },
          h('nav', { className: 'rt-settings-localnav', role: 'tablist', 'aria-label': 'Chương môi trường và cài đặt' },
            [['overview', 'Tổng quan vận hành'], ['config', 'Biểu mẫu cấu hình'], ['diagnostics', 'Chẩn đoán nâng cao']].map((section) =>
              h('button', {
                key: section[0], type: 'button', role: 'tab',
                id: 'rt-settings-tab-' + section[0],
                'aria-controls': 'rt-settings-' + section[0],
                'aria-selected': settingsSection === section[0],
                onClick: () => setSettingsSection(section[0]),
              }, section[1]))),
          h('section', { id: 'rt-settings-overview', className: 'rt-settings-section', role: 'tabpanel', 'aria-labelledby': 'rt-settings-tab-overview', hidden: settingsSection !== 'overview' },
            h('div', { className: 'rt-settings-section-head' },
              h('div', null, h('h2', null, 'Tổng quan vận hành'), h('p', null, 'Xem môi trường hiện tại trước, rồi quyết định có cần điền đường dẫn hoặc thông tin xác thực.'))),
            h('div', { className: 'rt-settings-card rt-settings-note-card' },
              h('div', { className: 'rt-settings-card-label' }, 'Ứng dụng và dữ liệu'),
              h('p', { className: 'rt-settings-card-copy' },
                adapt.message
                  || 'Đều tùy chọn: để trống thì dùng đường dẫn mặc định/tự tìm. Điền thì ghi đè mặc định. Các loại khóa chỉ cần điền khi cần trinh sát/reverse shell.')),
            h('div', { className: 'rt-settings-card' },
              h('div', { className: 'rt-settings-card-head' },
                h('div', null,
                  h('h3', null, 'Thư mục nguyên gói → tự phân bổ công cụ'),
                  h('p', null, 'Khi mọi công cụ nằm trong cùng một thư mục (gồm thư mục con), điền đường dẫn rồi bấm "Tự phân bổ": sẽ ghi toolkitDir, và khớp theo tên tệp để điền nmap / nuclei / fscan… vào bên dưới.'))),
              h('div', { className: 'rt-settings-inline-form' },
                h('input', {
                  className: 'rt-input rt-settings-control',
                  placeholder: 'Ví dụ D:\pentest-tools hoặc /opt/toolkit',
                  value: folderPath,
                  onChange: (e) => setFolderPath(e.target.value),
                  onKeyDown: (e) => { if (e.key === 'Enter') assignFolder() },
                }),
                h('button', {
                  className: 'rt-btn rt-btn-primary rt-settings-action', disabled: busy,
                  onClick: assignFolder,
                }, busy ? 'Đang quét…' : 'Tự phân bổ'))),
            data && data.hint ? h('div', { className: 'rt-settings-card rt-settings-note-card' },
              h('div', { className: 'rt-settings-card-label' }, 'Gợi ý từ host'),
              h('p', { className: 'rt-settings-card-copy' }, data.hint)) : null,
            /* Intel freshness: templates and KEV never self-update, so show age + manual refresh */
            h('div', { className: 'rt-settings-card' },
              h('div', { className: 'rt-settings-card-head' },
                h('div', null,
                  h('h3', null, 'Độ tươi của tin tình báo (mẫu nuclei / thông báo KEV)'),
                  h('p', null, 'Thư viện mẫu quyết định "tra được gì", thông báo KEV quyết định "CVE nào thực sự có người đang đánh". Cả hai đều lỗi thời theo thời gian, làm mới là thay toàn bộ thư mục một lần, thất bại thì giữ kho cũ.'))),
              intelMsg && intelMsg.err ? h('div', { className: 'rt-err rt-settings-alert rt-settings-alert-error', role: 'alert' }, intelMsg.err) : null,
              intelMsg && intelMsg.ok ? h('div', { className: 'rt-foot rt-settings-alert', role: 'status' }, intelMsg.ok) : null,
              h('div', { className: 'rt-settings-inline-form' },
                h('button', {
                  className: 'rt-btn rt-btn-primary rt-settings-action', disabled: intelBusy,
                  onClick: () => refreshIntel(false),
                }, intelBusy ? 'Đang làm mới…' : 'Làm mới theo cửa sổ độ tươi'),
                h('button', {
                  className: 'rt-btn rt-settings-action', disabled: intelBusy,
                  onClick: () => refreshIntel(true),
                }, 'Buộc tải lại')),
              intel && intel.templates ? h('div', { className: 'rt-settings-field-list' },
                h('div', { className: 'rt-settings-tool-row' },
                  h('div', { className: 'rt-settings-tool-head' },
                    h('span', { className: 'rt-settings-tool-name' }, 'Thư viện mẫu nuclei'),
                    h('span', { className: 'rt-tag ' + (intel.templates.stale ? 'rt-tag-warn' : 'rt-tag-live') },
                      intel.templates.count ? intel.templates.count + ' mục' : 'Chưa cài')),
                  h('div', { className: 'rt-mono rt-settings-tool-path' },
                    (intel.templates.refreshed_at ? 'Lần làm mới trước ' + Math.round(intel.templates.age_hours) + ' giờ trước' : 'Chưa từng có bản ghi làm mới')
                    + (intel.templates.owned ? '(bản của chính plugin, có thể làm mới)' : '(thư mục bên ngoài, không động vào)')
                    + (intel.templates.last_error ? ' | lỗi lần trước: ' + intel.templates.last_error : '')),
                  intel.templates.dir ? h('div', { className: 'rt-mono rt-settings-tool-path' }, intel.templates.dir) : null)) : null,
              intel && intel.kev ? h('div', { className: 'rt-settings-field-list' },
                h('div', { className: 'rt-settings-tool-row' },
                  h('div', { className: 'rt-settings-tool-head' },
                    h('span', { className: 'rt-settings-tool-name' }, 'Thông báo CISA KEV'),
                    h('span', { className: 'rt-tag ' + (intel.kev.available && intel.kev.stale !== true ? 'rt-tag-live' : 'rt-tag-warn') },
                      intel.kev.available ? (intel.kev.count + ' mục' + (intel.kev.stale ? '(quá hạn)' : '')) : 'Không khả dụng')),
                  h('div', { className: 'rt-mono rt-settings-tool-path' },
                    intel.kev.note || ('Cập nhật lần trước ' + Math.round(intel.kev.age_hours || 0) + ' giờ trước; trúng chỉ dùng làm gợi ý ưu tiên, không chặn việc bắt đầu')))) : null,
              intel && intel.cve_db ? h('div', { className: 'rt-settings-field-list' },
                h('div', { className: 'rt-settings-tool-row' },
                  h('div', { className: 'rt-settings-tool-head' },
                    h('span', { className: 'rt-settings-tool-name' }, 'Kho nền lỗ hổng công khai (chỉ đọc)'),
                    h('span', { className: 'rt-tag ' + (intel.cve_db.available && !intel.cve_db.stale ? 'rt-tag-live' : 'rt-tag-warn') },
                      intel.cve_db.available ? intel.cve_db.count + ' mục' : 'Chưa sẵn sàng')),
                  h('div', { className: 'rt-mono rt-settings-tool-path' },
                    intel.cve_db.available
                      ? ('Xây dựng lúc ' + (intel.cve_db.age_days == null ? 'Không rõ thời gian' : Math.round(intel.cve_db.age_days) + ' ngày trước')
                        + (intel.cve_db.stale ? ' | dữ liệu đã quá hạn tươi' : '')
                        + (intel.cve_db.templates ? ' | thư mục mẫu ' + intel.cve_db.templates.count + ' mục' : '')
                        + (intel.cve_db.exploits ? ' | metadata danh mục khai thác công khai ' + intel.cve_db.exploits.count + ' mục' : '')
                        + (intel.cve_db.poc_github ? ' | danh mục tham chiếu GitHub ' + intel.cve_db.poc_github.count + ' CVE' : ''))
                      : (intel.cve_db.note || 'Chưa xây dựng kho nền, cũng chưa cấu hình mirror')),
                  intel.cve_db.path ? h('div', { className: 'rt-mono rt-settings-tool-path' }, intel.cve_db.path) : null,
                  intel.intel_sync && intel.intel_sync.base
                    ? h('div', { className: 'rt-mono rt-settings-tool-path' },
                      'Nguồn dữ liệu ' + intel.intel_sync.base + ' | ' + (intel.intel_sync.enabled ? 'Đồng bộ tự động đã bật' : 'Đồng bộ tự động đã tắt'),
                      h('button', { className: 'rt-btn rt-settings-action', disabled: intelBusy, onClick: syncIntelData }, intelBusy ? 'Đang đồng bộ…' : 'Đồng bộ kho nền'))
                    : h('div', { className: 'rt-settings-card-copy' }, 'Dữ liệu kho nền không phân phối kèm gói; có thể xây dựng trên máy này, hoặc cấu hình mirror REDTEAM_INTEL_BASE.'))) : null)),

          h('section', { id: 'rt-settings-config', className: 'rt-settings-section', role: 'tabpanel', 'aria-labelledby': 'rt-settings-tab-config', hidden: settingsSection !== 'config' },
            h('div', { className: 'rt-settings-section-head' },
              h('div', null, h('h2', null, 'Biểu mẫu cấu hình'), h('p', null, 'Giữ nguyên các trường hiện có và thứ tự tra cứu mặc định; sau khi lưu cấu hình ghi về đường dẫn gốc.'))),
            !draft ? h('div', { className: 'rt-settings-loading rt-empty' }, 'Đang tải…') : h('div', { className: 'rt-settings-form-grid' },
              h('div', { className: 'rt-settings-card' },
                h('h3', null, 'Nền tảng và thư mục'),
                h('div', { className: 'rt-settings-field-list' },
                  h('label', { className: 'rt-settings-field' }, 'Chế độ nền tảng',
                    h('select', {
                      className: 'rt-input rt-settings-control',
                      value: draft.platform,
                      onChange: (e) => setDraft(Object.assign({}, draft, { platform: e.target.value })),
                    },
                      h('option', { value: 'auto' }, 'auto (theo máy này, mặc định)'),
                      h('option', { value: 'windows' }, 'windows'),
                      h('option', { value: 'linux' }, 'linux'))),
                  h('label', { className: 'rt-settings-field' }, 'Thư mục hộp công cụ toolkitDir (để trống = mặc định)',
                    h('input', {
                      className: 'rt-input rt-settings-control',
                      placeholder: 'Mặc định: ' + defaultToolkit,
                      value: draft.toolkitDir,
                      onChange: (e) => setDraft(Object.assign({}, draft, { toolkitDir: e.target.value })),
                    })),
                  h('label', { className: 'rt-settings-field' }, 'Thư mục mẫu nuclei (để trống = tự động: toolkit/nuclei-templates)',
                    h('input', {
                      className: 'rt-input rt-settings-control',
                      placeholder: 'Mặc định: ' + defaultNuclei,
                      value: draft.nucleiTemplatesDir,
                      onChange: (e) => setDraft(Object.assign({}, draft, { nucleiTemplatesDir: e.target.value })),
                    })),
                  h('label', { className: 'rt-settings-field' }, 'Thư mục tìm công cụ binDirs (để trống = chỉ tìm toolkit + PATH; mỗi dòng một mục)',
                    h('textarea', {
                      className: 'rt-input rt-settings-control rt-settings-textarea', rows: 4,
                      placeholder: 'Tùy chọn. Ví dụ: ' + String.fromCharCode(10) + 'D:\\tools' + String.fromCharCode(10) + 'D:\\pentest-bin',
                      value: draft.binDirsText,
                      onChange: (e) => setDraft(Object.assign({}, draft, { binDirsText: e.target.value })),
                    })))),
              h('div', { className: 'rt-settings-card' },
                h('h3', null, 'Khóa và VPS (để trống = không ghi đè; biến môi trường tiến trình được ưu tiên)'),
                h('div', { className: 'rt-settings-field-list' },
                  ['FOFA_KEY', 'REDTEAM_VPS_HOST', 'REDTEAM_VPS_KEY'].map((k) => h('label', { key: k, className: 'rt-settings-field' }, k + '(tùy chọn)',
                    h('input', {
                      className: 'rt-input rt-settings-control',
                      type: k === 'FOFA_KEY' ? 'password' : 'text',
                      placeholder: k === 'REDTEAM_VPS_KEY' ? 'Để trống; điền đường dẫn tuyệt đối của khóa riêng khi cần' : (k === 'REDTEAM_VPS_HOST' ? 'Để trống; điền user@host khi cần' : 'Để trống; điền khi trinh sát'),
                      value: (draft.env && draft.env[k]) || '',
                      onChange: (e) => setEnv(k, e.target.value),
                    })))),),
              h('div', { className: 'rt-settings-card rt-settings-card-wide' },
                h('h3', null, 'Tệp thực thi công cụ (để trống = tự tìm)'),
                h('p', { className: 'rt-settings-card-copy rt-settings-muted-copy' },
                  'Thứ tự phân giải: đường dẫn tuyệt đối trong bảng → toolkitDir → binDirs → PATH. Để trống là dùng tìm kiếm mặc định.'),
                tools.map((t) => h('div', { key: t.id, className: 'rt-settings-tool-row' },
                  h('div', { className: 'rt-settings-tool-head' },
                    h('span', { className: 'rt-settings-tool-name' }, t.label || t.id),
                    t.path
                      ? h('span', { className: 'rt-tag rt-tag-live', title: t.path }, t.source + ' · đã tìm thấy')
                      : h('span', { className: 'rt-tag rt-tag-warn' }, 'Không tìm thấy (có thể để trống chờ cài xong)')),
                  h('input', {
                    className: 'rt-input rt-settings-control',
                    placeholder: 'Để trống sẽ tự tìm: ' + (t.names || []).slice(0, 3).join(' / '),
                    value: (draft.tools && draft.tools[t.id]) || '',
                    onChange: (e) => setTool(t.id, e.target.value),
                  }),
                  t.path ? h('div', { className: 'rt-mono rt-settings-tool-path' }, t.path) : null))),
              h('div', { className: 'rt-settings-card' },
                h('h3', null, 'Ghi chú'),
                h('textarea', {
                  className: 'rt-input rt-settings-control rt-settings-textarea', rows: 3,
                  placeholder: 'Tùy chọn. Ví dụ: công cụ lấy từ gói portable nọ',
                  value: draft.notes,
                  onChange: (e) => setDraft(Object.assign({}, draft, { notes: e.target.value })),
                })),
              h('div', { className: 'rt-foot rt-settings-config-foot' },
                h('span', null, 'Các trường để trống đều dùng mặc định')))),
          h('section', { id: 'rt-settings-diagnostics', className: 'rt-settings-section', role: 'tabpanel', 'aria-labelledby': 'rt-settings-tab-diagnostics', hidden: settingsSection !== 'diagnostics' },
            h('div', { className: 'rt-settings-section-head' },
              h('div', null, h('h2', null, 'Chẩn đoán nâng cao'), h('p', null, 'Chỉ đọc hiển thị thông tin ra mạng mà host đã cung cấp.'))),
            h('div', { className: 'rt-settings-card rt-settings-config-location' },
              h('div', { className: 'rt-settings-card-head' },
                h('div', null,
                  h('h3', null, 'Vị trí cấu hình cục bộ'),
                  h('p', null, 'Vị trí đọc và lưu tệp cấu hình.'))),
              h('div', { className: 'rt-mono rt-settings-config-path', title: settingsConfigPath }, settingsConfigPath)),
            data && data.egress ? h('div', { className: 'rt-settings-card rt-settings-egress' },
              h('div', { className: 'rt-settings-card-head' },
                h('div', null, h('h3', null, 'Trạng thái ra mạng (tham khảo Z3r0 egress, chỉ đọc)'))),
              h('div', { className: 'rt-settings-egress-list' },
                h('div', { className: 'rt-mono' }, 'HTTP_PROXY=' + (data.egress.http_proxy || '(trống)')),
                h('div', { className: 'rt-mono' }, 'HTTPS_PROXY=' + (data.egress.https_proxy || '(trống)')),
                h('div', { className: 'rt-mono' }, 'ALL_PROXY=' + (data.egress.all_proxy || '(trống)')),
                h('div', { className: 'rt-mono' }, 'NO_PROXY=' + (data.egress.no_proxy || '(trống)'))),
              h('div', { className: 'rt-settings-egress-note' }, data.egress.note || ''))
              : h('div', { className: 'rt-settings-card rt-settings-diagnostic-empty' }, data ? 'Host chưa cung cấp thông tin ra mạng.' : 'Đang tải…'))),
          !draft ? null : h('div', { className: 'rt-settings-footer-note' },
            h('span', null, 'Các trường để trống đều dùng mặc định'))))
    }

    /* ---------------------------------------------------------- score targets */
    function ScoreTab(props) {
      const eng = props.engagement
      const refreshKey = props.refreshKey || 0
      const [data, setData] = React.useState(null)
      const [err, setErr] = React.useState(null)
      const [busy, setBusy] = React.useState(false)
      const [openId, setOpenId] = React.useState(null)
      const [form, setForm] = React.useState(null)
      const [msg, setMsg] = React.useState(null)
      const [scoreView, setScoreView] = React.useState('achieved')

      const load = () => {
        if (!eng) return
        setBusy(true)
        api({ op: 'scores', engagement: eng }).then((r) => {
          setBusy(false)
          if (!r || r.ok === false) { setErr((r && r.error) || 'Đọc thất bại'); return }
          setErr(null)
          setData(r)
        }, (e) => { setBusy(false); setErr(String((e && e.message) || e)) })
      }
      React.useEffect(load, [eng, refreshKey])

      /* builtin must reach the form: a built-in point's points/name/scope are locked by the rules,
         so the UI greys the input and says why —— before, it looked editable, said "saved", then reverted,
         and users read that as a bug. */
      const startEdit = (p) => setForm({
        id: p.id, name: p.name, category: p.category || '', points: p.points,
        description: p.description || '', enabled: p.enabled, builtin: p.builtin === true,
        src: p.src, cap: p.cap, rule: p.rule,
      })
      const startNew = () => { setForm({ name: '', category: '', points: 10, description: '', enabled: true, builtin: false }); setMsg(null) }
      const setField = (k, v) => setForm((f) => Object.assign({}, f, { [k]: v }))

      const save = () => {
        if (!form || !form.name) { setMsg({ err: 'Tên không được để trống' }); return }
        setBusy(true)
        setMsg(null)
        api({ op: 'saveScorePoint', engagement: eng, point: form }).then((r) => {
          setBusy(false)
          if (!r || r.ok === false) { setMsg({ err: (r && r.error) || 'Lưu thất bại' }); return }
          /* overridden === false means the backend **rejected** the submitted points (built-ins are locked).
             Do not say "saved" there —— that wording makes the user think the points changed. */
          if (r.overridden === false) {
            setMsg({ err: 'Đã lưu "bật/tắt". Điểm số không đổi: đây là mục tính điểm tích hợp phân phối kèm "Quy tắc tính điểm",'
              + 'điểm số / giới hạn / nguyên tắc tính do quy tắc khóa (giới hạn của cùng một quy tắc cộng dồn theo mọi mục trong nhóm,'
              + 'sửa điểm riêng lẻ sẽ khiến một lần trúng ăn hết giới hạn của cả nhóm). Muốn tùy chỉnh điểm số hãy bấm "+ Thêm mục tính điểm".' })
          } else {
            setMsg({ ok: r.note || 'Đã lưu' })
          }
          setForm(null)
          load()
        }, (e) => { setBusy(false); setMsg({ err: String((e && e.message) || e) }) })
      }
      const remove = () => {
        if (!form || !form.id) { setForm(null); return }
        setBusy(true)
        setMsg(null)
        api({ op: 'deleteScorePoint', engagement: eng, id: form.id }).then((r) => {
          setBusy(false)
          if (!r || r.ok === false) { setMsg({ err: (r && r.error) || 'Xóa thất bại' }); return }
          setMsg({ ok: 'Đã xóa' })
          setForm(null)
          setOpenId(null)
          load()
        }, (e) => { setBusy(false); setMsg({ err: String((e && e.message) || e) }) })
      }

      const summary = (data && data.summary) || { achievedPoints: 0, pointCount: 0, hitPointCount: 0, hitCount: 0, selfCreatedHits: 0, serviceCappedHits: 0 }
      const items = (data && data.items) || []

      /* Render grouped by the merged table's 8 categories (backend ruleGroups is pre-sorted, ascending by points).
         Compat: fall back to flat rendering when the backend sends no ruleGroups (old host). */
      const groups = (data && data.ruleGroups && data.ruleGroups.length)
        ? data.ruleGroups
        : [{ key: 'all', name: '', capSum: 0, points: 0, counted: 0, tiers: items }]
      const tierFull = (p) => p.cap > 0 && Number(p.cap_used || 0) >= Number(p.cap)
      const tierAchieved = (p) => (p.hits || []).some((hh) => !hh.self_created && !hh.capped)
      const orderedGroups = groups.map((g) => Object.assign({}, g, { tiers: (g.tiers || []).slice() }))
      const gapGroups = []
      let gapLeft = 8
      for (const g of orderedGroups) {
        const tiers = g.tiers.filter((p) => !tierFull(p))
        if (!tiers.length) continue
        const take = tiers.slice(0, gapLeft)
        gapGroups.push(Object.assign({}, g, { tiers: take }))
        gapLeft -= take.length
        if (gapLeft <= 0) break
      }
      const achievedGroups = orderedGroups
        .map((g) => Object.assign({}, g, { tiers: g.tiers.filter(tierAchieved) }))
        .filter((g) => g.tiers.length > 0)
      const displayGroups = scoreView === 'achieved'
        ? achievedGroups
        : scoreView === 'gap'
          ? gapGroups
          : orderedGroups
      const rows = []
      for (const g of displayGroups) {
        if (g.name) {
          rows.push(h('div', { key: 'g-' + g.key, className: 'rt-score-group' },
            h('span', null, g.name),
            h('span', { className: 'rt-sg-sub' },
              g.tiers.length + ' mục'
              + (g.capSum > 0 ? ' · tổng giới hạn các mục ' + g.capSum + ' điểm (các mục độc lập, không cộng dồn chéo)' : '')),
            h('div', { className: 'rt-spacer' }),
            g.points > 0
              ? h('span', { className: 'rt-tag rt-tag-active' }, '+' + g.points + ' điểm')
              : null))
        }
        for (const p of g.tiers) {
        const achieved = p.hits.length > 0
        const open = openId === p.id
        rows.push(h('div', {
          key: 'sp' + p.id, className: 'rt-score-row', role: 'button', tabIndex: 0,
          onClick: () => setOpenId(open ? null : p.id),
          onKeyDown: (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setOpenId(open ? null : p.id) } },
        },
          h('span', { className: 'rt-sec-caret' }, open ? '▾' : '▸'),
          h('span', null, h('span', {
            className: achieved ? 'rt-pri rt-pri-high' : 'rt-pri rt-pri-low',
            style: achieved ? {} : { background: 'var(--dsw-alias-bg-layer-2)', color: 'var(--dsw-alias-label-secondary)' },
          }, p.points + 'điểm')),
          h('span', { title: p.description || '' },
            p.name,
            p.tier ? h('span', { className: 'rt-scope' }, ' ' + p.tier) : null),
          /* Hits and cap: how often this item scored and how much cap it used (G3 caps are per item) */
          h('span', { title: p.capped > 0
            ? 'Đã tính ' + p.counted + ' lần, còn ' + p.capped + ' mục do "' + (p.scope_label || 'nguyên tắc tính điểm') + '" hoặc đã đạt giới hạn nên không tính điểm'
            : (p.scope_label || '') },
            h('span', { className: 'rt-sec-count' }, p.hits.length > 0 ? p.counted + ' lần trúng' : 'Không trúng'),
            p.cap > 0
              ? h('span', { className: 'rt-scope' }, ' giới hạn ' + (p.cap_used === null ? 0 : p.cap_used) + '/' + p.cap)
              : null),
          h('span', { style: { textAlign: 'right' } }, p.earned > 0
            ? h('span', { className: 'rt-tag rt-tag-active' }, '+' + p.earned + ' điểm')
            : h('span', { style: { color: 'var(--dsw-alias-label-secondary)' } }, '—'))))
        if (!open) continue
        /* Hit records: one row each —— line one has index + asset + time + copy, content wraps on the next line */
        const hitNodes = p.hits.map((hh, hi) => h('div', {
          key: 'h' + hh.id,
          className: 'rt-hit-row' + (hh.self_created ? ' self-created' : '') + (hh.capped ? ' service-capped' : ''),
        },
          h('span', { className: 'rt-hit-idx' }, String(hi + 1)),
          h('span', { className: 'rt-hit-asset', title: hh.target || hh.asset_ip || '' },
            hh.asset_ip || hh.target || 'Chưa chỉ định tài sản'),
          hh.self_created ? h('span', { className: 'rt-tag rt-tag-warn', title: 'Tài khoản tự đăng ký/tự dựng không tính là quyền ghi điểm, chỉ ghi nhận quá trình' }, 'Tự dựng · không tính điểm') : null,
          hh.capped ? h('span', {
            className: 'rt-tag rt-tag-warn',
            title: hh.capped_reason || 'Cùng một tài sản cùng một cổng chỉ tính mục điểm cao nhất, mục này không tính điểm',
          }, 'Dịch vụ đã đạt tối đa · không tính điểm' + (hh.service ? '(' + hh.service + ')' : '')) : null,
          hh.shot_count ? h('span', { className: 'rt-tag', title: 'Lần trúng này có ảnh chụp bằng chứng (mở rộng mục tính điểm là thấy ảnh đại diện)' },
            'Ảnh ' + hh.shot_count) : null,
          h('span', { className: 'rt-hit-time' }, fmt(hh.recorded_at)),
          h('button', {
            className: 'rt-btn', style: { padding: '0 12px', fontSize: 'var(--ui-text-control)' },
            title: 'Sao chép mục này',
            onClick: (e) => {
              e.stopPropagation()
              copyText((hh.asset_ip || hh.target || '') + '  ' + (hh.evidence || ''))
            },
          }, 'Sao chép'),
          hh.evidence
            ? h('span', { className: 'rt-hit-txt', title: hh.evidence }, String(hh.evidence).replace(/\n+/g, ' '))
            : h('span', { className: 'rt-hit-txt none' }, 'Chưa điền tài khoản mật khẩu/kết quả')))
        rows.push(h('div', {
          key: 'spd' + p.id, className: 'rt-score-row',
          style: { cursor: 'default', gridTemplateColumns: '1fr' },
        }, h('div', { className: 'rt-score-detail' },
          p.description ? h('div', { className: 'rt-kv' }, h('b', null, 'Điều kiện tính điểm'), h('span', null, p.description)) : null,
          h('div', { className: 'rt-kv' }, h('b', null, 'Trạng thái'),
            h('span', null, (p.enabled ? 'Bật' : 'Tắt') + ' · ' + p.points + ' điểm/lần · trúng ' + p.hits.length +
              ' lần = ' + p.earned + ' điểm' + (p.self_created ? '(còn ' + p.self_created + ' lần tự dựng không tính điểm)' : '') +
              (p.capped ? '(còn ' + p.capped + ' lần trúng trùng cùng dịch vụ không tính điểm)' : ''))),
          p.capped
            ? h('div', { className: 'rt-kv' }, h('b', null, 'Trần dịch vụ'),
                h('span', null, p.service_summary + '; quyền tài khoản và quyền cơ sở dữ liệu chỉ tính một lần theo "cùng tài sản cùng cổng", đạt tài khoản quyền cao nhất là dịch vụ đó đạt tối đa'))
            : null,
          p.hits.length
            ? h('div', null,
                h(ShotStrip, { eng: eng, shots: p.shots, total: p.shot_total,
                  title: 'Ảnh chụp bằng chứng · ' + (p.shot_total || (p.shots || []).length) + ' ảnh' }),
                h('div', { className: 'rt-section', style: { padding: '6px 0 0' } },
                  'Bản ghi trúng · ' + p.hits.length + '(chỉ ghi tài sản và tài khoản mật khẩu, tái hiện chi tiết xem báo cáo)'),
                h('div', { className: 'rt-hits' }, hitNodes))
            : h('div', { className: 'rt-kv' }, h('b', null, 'Bản ghi trúng'),
                h('span', { style: { color: 'var(--dsw-alias-label-secondary)' } },
                  'Chưa có — sau khi đạt kết quả hãy dùng redteam_score_hit ghi điểm: ghi rõ tài sản mục tiêu + tài khoản mật khẩu/quyền đạt được')),
          h('div', { className: 'rt-actions' },
            h('button', { className: 'rt-btn', onClick: (e) => { e.stopPropagation(); startEdit(p) } }, 'Sửa')))))
        }
      }

      return h('div', { className: 'rt-main' },
        h('div', { className: 'rt-toolbar' },
          h('span', { style: { fontWeight: 600 } }, 'Mục tiêu tính điểm'),
          /* Show only the total secured; no target score, no progress bar */
          h('span', { style: { fontSize: 'var(--ui-text-body)', color: 'var(--dsw-alias-label-secondary)', marginLeft: 4 } }, 'Tổng điểm'),
          h('span', { className: 'rt-total' }, String(summary.achievedPoints)),
          h('span', { style: { fontSize: 'var(--ui-text-body)', color: 'var(--dsw-alias-label-secondary)' } }, 'điểm'),
          h('span', { className: 'rt-tag' }, summary.pointCount + ' mục tính điểm'),
          h('span', { className: 'rt-tag' }, 'Trúng ' + summary.countedHits + ' lần'),
          summary.selfCreatedHits
            ? h('span', {
                className: 'rt-tag rt-tag-warn',
                title: 'Tài khoản tự đăng ký/tự tạo không tính là quyền ghi điểm, chỉ ghi nhận quá trình (không tính điểm, không chiếm giới hạn, không vào báo cáo)',
              }, 'Tự dựng không tính điểm ' + summary.selfCreatedHits)
            : null,
          summary.serviceCappedHits
            ? h('span', {
                className: 'rt-tag rt-tag-warn',
                title: 'Quyền tài khoản và quyền cơ sở dữ liệu chỉ tính một lần theo "cùng tài sản cùng cổng": dịch vụ đó đã đạt tối đa, các lần trúng trùng này không tính điểm (chỉ lưu dấu)',
              }, 'Dịch vụ đã đạt tối đa, không tính điểm ' + summary.serviceCappedHits)
            : null,
          h('div', { className: 'rt-spacer' }),
          h('div', { style: { display: 'flex', gap: 4, alignItems: 'center' } },
            h('button', {
              className: 'rt-btn' + (scoreView === 'achieved' ? ' rt-btn-primary' : ''),
              title: 'Chỉ hiển thị các mục đã ghi điểm',
              onClick: () => setScoreView('achieved'),
            }, 'Đã ghi điểm' + (summary.hitPointCount ? ' ' + summary.hitPointCount : '')),
            h('button', {
              className: 'rt-btn' + (scoreView === 'gap' ? ' rt-btn-primary' : ''),
              title: 'Chỉ hiển thị khoảng trống điểm cao chưa đạt tối đa (8 mục đầu)',
              onClick: () => setScoreView('gap'),
            }, 'Khoảng trống điểm cao'),
            h('button', {
              className: 'rt-btn' + (scoreView === 'all' ? ' rt-btn-primary' : ''),
              title: 'Hiển thị tất cả ' + items.length + ' mục tính điểm',
              onClick: () => setScoreView('all'),
            }, 'Tất cả ' + items.length)),
          h('button', { className: 'rt-btn', onClick: startNew }, '+ Thêm mục tính điểm'),
          h('button', { className: 'rt-btn', disabled: busy, onClick: load }, busy ? 'Đang làm mới…' : 'Làm mới')),
        msg ? h('div', { className: msg.err ? 'rt-err' : 'rt-foot' }, msg.err || msg.ok) : null,
        err ? h('div', { className: 'rt-err' }, err) : null,
        form ? h('div', { className: 'rt-pane', style: { flex: 'none', borderBottom: '1px solid var(--dsw-alias-border-l1)' } },
          /* Built-in points (builtin): points / name / category are locked by the score rules, inputs greyed out.
             Only enable/disable can change, so the "saved then reverted" confusion cannot recur. */
          form.builtin
            ? h('div', { className: 'rt-hint', style: { marginBottom: 8 } },
                h('b', null, 'Mục tính điểm tích hợp (từ "Quy tắc tính điểm loại đột nhập xâm nhập (bản hợp nhất)")'),
                h('div', { style: { marginTop: 3 } },
                  'Điểm số, giới hạn, nguyên tắc tính và tên do quy tắc khóa — giới hạn của cùng một quy tắc cộng dồn theo mọi mục trong nhóm,'
                  + 'sửa điểm riêng lẻ sẽ khiến một lần trúng ăn hết giới hạn của cả nhóm. Ở đây có thể sửa "bật / tắt";'
                  + 'muốn tùy chỉnh điểm số hãy quay lại màn trước bấm "+ Thêm mục tính điểm".'),
                form.src !== null && form.src !== undefined
                  ? h('div', { style: { marginTop: 3, color: 'var(--dsw-alias-label-secondary)' } },
                      'Số thứ tự nguyên văn quy tắc ' + form.src + (form.rule ? ' · nhóm giới hạn rule=' + form.rule : '')
                      + (form.cap > 0 ? ' · giới hạn ' + form.cap + ' điểm' : ' · không đặt giới hạn'))
                  : null)
            : null,
          h('div', { className: 'rt-score-form' },
            h('input', {
              className: 'rt-input', placeholder: 'Tên (bắt buộc)', value: form.name,
              readOnly: form.builtin === true,
              title: form.builtin ? 'Tên của mục tính điểm tích hợp do quy tắc khóa' : '',
              onChange: (e) => setField('name', e.target.value),
            }),
            h('input', {
              className: 'rt-input', placeholder: 'Phân loại, ví dụ quyền tài khoản', value: form.category,
              readOnly: form.builtin === true,
              title: form.builtin ? 'Phân loại của mục tính điểm tích hợp do quy tắc khóa (quyết định nó thuộc nhóm nào trên bảng)' : '',
              onChange: (e) => setField('category', e.target.value),
            }),
            h('input', {
              className: 'rt-input', type: 'number', placeholder: 'Điểm mỗi lần',
              readOnly: form.builtin === true,
              title: form.builtin
                ? 'Điểm của mục tính điểm tích hợp do "Quy tắc tính điểm" khóa, không sửa được ở đây'
                : 'Điểm mỗi lần của loại này; mỗi lần trúng cộng theo điểm này (chịu giới hạn của quy tắc đó)',
              value: form.points, onChange: (e) => setField('points', Number(e.target.value)),
            }),
            h('select', { className: 'rt-input', value: form.enabled ? '1' : '0', onChange: (e) => setField('enabled', e.target.value === '1') },
              h('option', { value: '1' }, 'Bật'),
              h('option', { value: '0' }, 'Tắt'))),
          h('input', {
            className: 'rt-input', style: { width: '100%', marginBottom: 6, boxSizing: 'border-box' },
            placeholder: 'Mô tả điều kiện tính điểm', value: form.description,
            readOnly: form.builtin === true,
            title: form.builtin ? 'Nội dung điều khoản của mục tính điểm tích hợp do quy tắc khóa' : '',
            onChange: (e) => setField('description', e.target.value),
          }),
          h('div', { className: 'rt-actions' },
            h('button', { className: 'rt-btn rt-btn-primary', disabled: busy, onClick: save }, 'Lưu'),
          form.id
            ? (form.builtin
                ? h('button', {
                    className: 'rt-btn', disabled: true,
                    title: 'Không thể xóa mục tính điểm tích hợp: xóa sẽ khiến bảng thiếu một quy tắc, báo cáo thiếu một loại kết quả (lần khởi động sau sẽ tự bổ sung lại). Muốn nó không tham gia tính điểm hãy dùng "tắt".',
                  }, 'Xóa (mục tích hợp không xóa được)')
                : h('button', { className: 'rt-btn', disabled: busy, onClick: remove }, 'Xóa'))
            : null,
            h('button', { className: 'rt-btn', onClick: () => setForm(null) }, 'Hủy'))) : null,
        h('div', { className: 'rt-table' },
          h('div', { className: 'rt-score-row head' },
            h('span', null, ''), h('span', null, 'Điểm số'), h('span', null, 'Mục tính điểm (theo điểm từ thấp đến cao)'),
            h('span', null, 'Trúng / giới hạn'), h('span', { style: { textAlign: 'right' } }, 'Đã ghi điểm')),
          rows,
          !items.length ? h('div', { className: 'rt-empty' }, 'Chưa có mục tính điểm, bấm "Thêm mục tính điểm" ở góc trên phải') : null))
    }

    /* ---------------------------------------------------------- collapse primitives */
    /**
     * Collapse state persists to localStorage per tab + target, surviving tab switches and refreshes.
     * Only keys the user actually clicked are stored; the rest use the caller's default.
     */
    const COLLAPSE_KEY = 'rt-collapse:'
    const collapseLoad = (prefix) => {
      try {
        const raw = window.localStorage.getItem(COLLAPSE_KEY + prefix)
        const parsed = raw ? JSON.parse(raw) : null
        return parsed && typeof parsed === 'object' ? parsed : {}
      } catch (e) { return {} }
    }
    const collapseSave = (prefix, value) => {
      try { window.localStorage.setItem(COLLAPSE_KEY + prefix, JSON.stringify(value)) } catch (e) { /* privacy mode and similar */ }
    }

    /** One hook per tab: isOpen(key, defaultOpen) / toggle(key, defaultOpen) / setAll(keys, open) */
    function useCollapse(prefix) {
      const [state, setState] = React.useState(() => collapseLoad(prefix))
      React.useEffect(() => { setState(collapseLoad(prefix)) }, [prefix])
      const write = (next) => { collapseSave(prefix, next); setState(next) }
      const isOpen = (key, defaultOpen) => {
        const v = state[key]
        return v === undefined ? defaultOpen !== false : v === true
      }
      const toggle = (key, defaultOpen) => (e) => {
        if (e && e.stopPropagation) e.stopPropagation()
        write(Object.assign({}, state, { [key]: !isOpen(key, defaultOpen) }))
      }
      const setAll = (keys, open) => {
        const next = Object.assign({}, state)
        for (const k of keys) next[k] = open
        write(next)
      }
      return { isOpen: isOpen, toggle: toggle, setAll: setAll }
    }

    /**
     * Unified collapse header (L1): ▾ leftmost, bold title, count next, time or actions on the right,
     * content indented 12px behind a vertical guide line. always=true means pinned open (not collapsible).
     */
    function Section(props) {
      const always = props.always === true
      const open = always || props.open === true
      const head = h('div', {
        className: 'rt-sec t-' + (props.tone || 'target') + (always ? ' flat' : ''),
        role: always ? undefined : 'button',
        tabIndex: always ? undefined : 0,
        'aria-expanded': always ? undefined : (open ? 'true' : 'false'),
        onClick: always ? undefined : props.onToggle,
        onKeyDown: always ? undefined : (e) => {
          if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); if (props.onToggle) props.onToggle(e) }
        },
      },
        h('span', { className: 'rt-sec-caret' }, always ? '▍' : (open ? '▾' : '▸')),
        props.title ? h('span', { className: 'rt-sec-title' }, props.title) : null,
        props.count !== undefined && props.count !== null ? h('span', { className: 'rt-sec-count' }, String(props.count)) : null,
        props.sub ? h('span', { className: 'rt-sec-sub' }, props.sub) : null,
        props.right ? h('span', { className: 'rt-sec-right' }, props.right) : null)
      return h('div', { className: 'rt-sec-wrap' }, head,
        open && props.children ? h('div', { className: 'rt-sec-body' }, props.children) : null)
    }

    /** Long-text collapse (L3): fixed preview height + fade + expand/copy. */
    function Clip(props) {
      const [open, setOpen] = React.useState(false)
      const text = String(props.text === undefined || props.text === null ? '' : props.text)
      if (text.trim() === '') return null
      return h('div', { className: 'rt-clip' + (open ? ' open' : '') },
        h('div', { className: 'rt-clip-head' },
          props.label ? h('span', { className: 'rt-clip-label' }, props.label) : null,
          h('div', { className: 'rt-spacer' }),
          h('button', {
            className: 'rt-btn', style: { padding: '0 12px', fontSize: 'var(--ui-text-control)' },
            onClick: (e) => { e.stopPropagation(); copyText(text) },
          }, 'Sao chép'),
          h('button', {
            className: 'rt-btn', style: { padding: '0 12px', fontSize: 'var(--ui-text-control)' },
            onClick: (e) => { e.stopPropagation(); setOpen((v) => !v) },
          }, open ? 'Thu gọn' : 'Mở rộng')),
        h('div', { className: 'rt-clip-body' }, text))
    }

    /* ---------------------------------------------------------- current tests (live) */
    const TEST_STATUS_LABEL = {
      untested: 'Chưa kiểm thử', testing: 'Đang kiểm thử', tested: 'Đã kiểm thử',
      blocked: 'Bị chặn', abandoned: 'Đã bỏ', no_surface: 'Không có bề mặt tấn công',
    }

    /**
     * Current-tests page: which host the agent is on, how far it got, what is still queued.
     * Polls every 5s; three blocks collapse, and "testing now" always stays fully expanded.
     */
    function TestingTab(props) {
      const eng = props.engagement
      const refreshKey = props.refreshKey || 0
      const [data, setData] = React.useState(null)
      const [err, setErr] = React.useState(null)
      const [at, setAt] = React.useState(null)
      const [auto, setAuto] = React.useState(true)
      /* Collapse state kept per tab + target; "testing now" is pinned and never collapses */
      const collapse = useCollapse('testing:' + eng)

      /* The 5s poll needs an in-flight guard: on a slow network or a stalled backend requests pile up,
         and stale responses overwrite newer state (numbers visibly bouncing on screen). */
      const inflight = React.useRef(false)
      const seq = React.useRef(0)
      const load = () => {
        if (!eng || inflight.current) return
        inflight.current = true
        const my = ++seq.current
        api({ op: 'activeTests', engagement: eng, limit: 20 }).then((r) => {
          if (my !== seq.current) return          /* target switched: this row is stale, drop it */
          if (!r || r.ok === false) { setErr((r && r.error) || 'Đọc thất bại'); return }
          setErr(null); setData(r); setAt(new Date())
        }, (e) => { if (my === seq.current) setErr(String((e && e.message) || e)) })
          .finally(() => { if (my === seq.current) inflight.current = false })
      }
      React.useEffect(() => { seq.current += 1; load() }, [eng, refreshKey])
      React.useEffect(() => {
        if (!eng || !auto) return undefined
        const timer = setInterval(load, 5000)
        return () => clearInterval(timer)
      }, [eng, auto, refreshKey])

      const testing = (data && data.testing) || []
      const recent = (data && data.recent) || []
      const queue = (data && data.queue) || []
      const stats = (data && data.stats) || {}

      /* One card per asset: which host is being hit, how far, and what was taken */
      const card = (a, past) => {
        const chips = []
        chips.push(h('span', { key: 'sc', className: 'rt-scope rt-scope-' + (a.scope === 'internal' ? 'internal' : 'external') },
          a.scope === 'internal' ? 'Nội bộ' : 'Internet'))
        if (a.segment_cidr) chips.push(h('span', { key: 'seg', className: 'rt-tag' }, a.segment_cidr))
        if (a.open_ports) chips.push(h('span', { key: 'p', className: 'rt-tag rt-tag-active' }, 'Mở ' + a.open_ports + ' cổng'))
        if (a.vulns) chips.push(h('span', { key: 'v', className: 'rt-tag rt-tag-live' }, 'Lỗ hổng đã xác nhận ' + a.vulns))
        if (a.webshells) chips.push(h('span', { key: 'w', className: 'rt-tag rt-tag-passive' }, 'WebShell ' + a.webshells))
        if (a.tunnels) chips.push(h('span', { key: 't', className: 'rt-tag rt-tag-passive' }, 'Đường hầm ' + a.tunnels))
        if (a.priority) chips.push(h('span', { key: 'pr', className: 'rt-tag' }, 'Dễ tấn công ' + a.priority))
        if (a.blocked_count) chips.push(h('span', { key: 'b', className: 'rt-tag', style: { color: 'var(--ui-danger)', borderColor: 'var(--ui-danger)' } }, 'Bị chặn ' + a.blocked_count + ' lần'))
        const noteLines = a.test_notes
          ? String(a.test_notes).split('\n').slice(-3).map((l) => (l.length > 240 ? l.slice(0, 240) + ' …' : l))
          : []
        return h('div', { key: 'at' + a.id, className: 'rt-atest' + (past ? ' past' : '') },
          h('div', { className: 'rt-atest-head' },
            past ? null : h('span', { className: 'rt-live-dot' }),
            h('span', { className: 'rt-atest-ip' }, a.ip),
            h('span', { className: 'rt-tag ' + (a.test_status === 'testing' ? 'rt-tag-live' : '') }, TEST_STATUS_LABEL[a.test_status] || a.test_status),
            h('div', { className: 'rt-spacer' }),
            h('span', { style: { fontSize: 'var(--ui-text-helper)', color: 'var(--dsw-alias-label-secondary)' } },
              fmt(a.test_updated_at) + (a.test_updated_by ? ' · ' + a.test_updated_by : ''))),
          chips.length ? h('div', null, chips) : null,
          a.test_surface ? h('div', { className: 'rt-atest-meta' }, 'Bề mặt kiểm thử: ' + a.test_surface) : null,
          a.potential ? h('div', { className: 'rt-atest-meta' }, 'Điểm dự kiến: ' + a.potential) : null,
          noteLines.length ? h(Clip, { label: 'Bản ghi kiểm thử', text: noteLines.join('\n') }) : null)
      }


      const concl = (label, value, tone) => h('span', { key: label, className: 'rt-concl-i', style: { cursor: 'default' } },
        h('b', null, String(value || 0)), h('span', null, label))
      const conclusion = h('div', { className: 'rt-concl' },
        concl('Đang kiểm thử', stats.testing, 'live'),
        concl('Chờ kiểm thử', stats.untested, ''),
        concl('Đã kiểm thử', stats.tested, ''),
        concl('Bỏ', (stats.abandoned || 0) + (stats.blocked || 0), ''),
        concl('Không có bề mặt tấn công', stats.no_surface, ''),
        h('div', { className: 'rt-spacer' }),
        at ? h('span', { style: { fontSize: 'var(--ui-text-helper)', color: 'var(--dsw-alias-label-secondary)' } },
          'Cập nhật lúc ' + at.toLocaleTimeString('zh-CN', { hour12: false })) : null,
        h('button', {
          className: 'rt-btn', style: { padding: '0 12px', fontSize: 'var(--ui-text-control)' }, title: 'Mở rộng mục vừa động tới và hàng chờ kiểm thử',
          onClick: () => collapse.setAll(['testing:' + eng, 'recent:' + eng, 'queue:' + eng], true),
        }, 'Mở rộng tất cả'),
        h('button', {
          className: 'rt-btn', style: { padding: '0 12px', fontSize: 'var(--ui-text-control)' }, title: 'Chỉ giữ mục đang kiểm thử',
          onClick: () => collapse.setAll(['testing:' + eng, 'recent:' + eng, 'queue:' + eng], false),
        }, 'Thu gọn tất cả'),
        h('button', {
          className: 'rt-btn' + (auto ? ' rt-btn-primary' : ''), style: { padding: '0 12px', fontSize: 'var(--ui-text-control)' },
          title: 'Tự làm mới mỗi 5 giây', onClick: () => setAuto((x) => !x),
        }, auto ? 'Thời gian thực · 5s' : 'Đã tạm dừng'),
        h('button', { className: 'rt-btn', style: { padding: '0 12px', fontSize: 'var(--ui-text-control)' }, onClick: load }, 'Làm mới'))

      const body = []
      /* testing now: always shown, fully expanded (not collapsible) */
      body.push(h(Section, {
        key: 'testing', tone: 'test', title: 'Đang kiểm thử',
        count: testing.length + ' máy',
        sub: testing.length ? 'agent đang đánh các tài sản này' : 'Sau khi agent bắt đầu kiểm thử một tài sản sẽ xuất hiện ở đây theo thời gian thực',
        open: collapse.isOpen('testing:' + eng, true),
        onToggle: collapse.toggle('testing:' + eng, true),
      }, testing.length
        ? testing.map((a) => card(a, false))
        : h('div', { className: 'rt-atest-meta', style: { paddingBottom: 4 } }, 'Hiện không có tài sản nào ở trạng thái "đang kiểm thử"')))

      /* recently touched (collapsed by default, remembered) */
      body.push(h(Section, {
        key: 'recent', tone: 'past', title: 'Vừa động tới', count: recent.length + ' máy',
        sub: 'Tài sản đã kiểm thử',
        open: collapse.isOpen('recent:' + eng, false),
        onToggle: collapse.toggle('recent:' + eng, false),
      }, recent.length ? recent.map((a) => card(a, true)) : h('div', { className: 'rt-atest-meta' }, 'Chưa có')))

      /* queued for testing (collapsed by default, remembered) */
      body.push(h(Section, {
        key: 'queue', tone: 'queue', title: 'Hàng chờ kiểm thử',
        count: (data ? (data.untested || 0) : 0) + ' máy',
        sub: 'Sắp theo độ dễ tấn công và số cổng để biết đánh máy nào trước',
        open: collapse.isOpen('queue:' + eng, false),
        onToggle: collapse.toggle('queue:' + eng, false),
      }, queue.length
        ? queue.map((a) => card(a, true)).concat([
            h('div', { key: 'queueHint', className: 'rt-atest-meta', style: { paddingTop: 4 } },
              'Danh sách đầy đủ (gồm lọc và sắp xếp) xem ở trang "Trinh sát tài sản"')])
        : h('div', { className: 'rt-atest-meta' }, 'Không có tài sản chờ kiểm thử')))

      return h('div', { className: 'rt-main' },
        conclusion,
        err ? h('div', { className: 'rt-err' }, err) : null,
        data === null && !err ? h('div', { className: 'rt-empty' }, 'Đang tải…') : null,
        h('div', { className: 'rt-body', style: { overflow: 'auto' } },
          h('div', { style: { padding: '6px 12px 14px' } }, body)))
    }

    /* ---------------------------------------------------------- sessions and entries (WebShell / tunnels) */
    /**
     * The usual pivot failure: a WebShell or tunnel is obtained and never registered; later
     * "we forgot an entry was available". This tab surfaces WebShells and tunnels from the fact store with
     connectivity state, and a one-click check on the host side.
     * */
    function SessionTab(props) {
      const eng = props.engagement
      const refreshKey = props.refreshKey || 0
      const [data, setData] = React.useState(null)
      const [err, setErr] = React.useState(null)
      const [busy, setBusy] = React.useState(false)
      const [msg, setMsg] = React.useState(null)
      const [copied, setCopied] = React.useState(null)

      const load = () => {
        if (!eng) return
        api({ op: 'sessions', engagement: eng }).then((r) => {
          if (!r || r.ok === false) { setErr((r && r.error) || 'Đọc thất bại'); return }
          setErr(null)
          setData(r)
        }, (e) => setErr(String((e && e.message) || e)))
      }
      React.useEffect(load, [eng, refreshKey])

      const probe = () => {
        setBusy(true); setMsg(null)
        api({ op: 'probeSessions', engagement: eng, timeoutMs: 6000 }).then((r) => {
          setBusy(false)
          if (!r || r.ok === false) { setMsg({ err: (r && r.error) || 'Kiểm tra thất bại' }); load(); return }
          const on = (r.webshells || []).filter((x) => x.status === 'online').length
          const act = (r.tunnels || []).filter((x) => x.status === 'active').length
          setMsg({ ok: 'Kiểm tra hoàn tất: WebShell trực tuyến ' + on + '/' + (r.webshells || []).length + ', đường hầm sẵn dùng ' + act + '/' + (r.tunnels || []).length })
          load()
        }, (e) => { setBusy(false); setMsg({ err: String((e && e.message) || e) }) })
      }

      /* Only light the button as "copied" when it truly reached the clipboard; report failures honestly */
      const copy = (key, text) => copyWithFeedback(text, text, (okFlag, message) => {
        if (!okFlag) { setMsg({ err: message }); return }
        setCopied(key)
        setTimeout(() => setCopied((c) => (c === key ? null : c)), 1500)
      })

      const markTunnel = (t, status) => {
        setMsg(null)
        api({ op: 'updateTunnel', engagement: eng, id: t.id, patch: { status: status, check_note: 'Đánh dấu thủ công trên giao diện' } })
          .then(() => load(), (e) => setMsg({ err: String((e && e.message) || e) }))
      }
      const markShell = (w, status) => {
        setMsg(null)
        api({ op: 'updateWebshell', engagement: eng, id: w.id, patch: { status: status, check_note: 'Đánh dấu thủ công trên giao diện' } })
          .then(() => load(), (e) => setMsg({ err: String((e && e.message) || e) }))
      }

      const sessCollapse = useCollapse('sessions:' + eng)
      const totals = (data && data.totals) || {}
      const shells = (data && data.webshells) || []
      const tunnels = (data && data.tunnels) || []
      const statusDot = (s) => h('span', { className: s === 'online' || s === 'active' ? 'rt-dot-on' : (s === 'unknown' || !s ? 'rt-dot-unk' : 'rt-dot-off') })
      /* Cards use two columns (label + value) throughout, long text wraps —— easier to scan than a dotted line */
      const fact = (label, value) => h('div', { className: 'rt-sess-fact' }, h('b', null, label), h('span', null, value))
      /* Delivery requirement: shells must be Behinder/Godzilla encrypted shells (users can connect), and 
 internal pivots must go through a suo5 tunnel*/
      const isEncryptedShell = (t) => /behinder|godzilla|冰蝎|哥斯拉/i.test(String(t || ''))
      const isSuo5 = (t) => /suo5/i.test(String(t || ''))
      /* Callout: one conclusion line + an expandable how-to (three long paragraphs used to drown the content) */
      const hint = (key, title, detail) => h('div', { key, className: 'rt-hint' },
        h('b', null, title),
        h('details', { className: 'rt-sess-fold', style: { marginTop: 3 } },
          h('summary', null, 'Cách làm (bấm để mở rộng)'),
          h('div', { style: { marginTop: 4 } }, detail)))
      const hints = []
      const badShells = shells.filter((w) => !isEncryptedShell(w.shell_type))
      const legitTunnels = tunnels.filter((t) => t.legit === true)
      if (badShells.length > 0) {
        hints.push(hint('h1', 'Có ' + badShells.length + ' mục vào không phải mèo Behinder/mèo Godzilla (người dùng không kết nối được, không tính là mục vào bàn giao được)',
          'Dùng kỹ năng webshell-toolkit tải lại mèo Behinder (behinder) hoặc mèo Godzilla (godzilla),'
          + 'và ghi shell_type + pass_key vào redteam_webshell_add. Loại chỉ dùng làm trung chuyển tạm thời có thể ghi rõ trong ghi chú.'))
      }
      if (tunnels.length > 0 && legitTunnels.length === 0) {
        hints.push(hint('h3', 'Hiện có ' + tunnels.length + ' kênh đều không tính là "vượt ranh giới mục tiêu" (không tính đột phá ranh giới/nội bộ)',
          'socks5, frp, proxy mở trên VPS/máy chủ tự dựng của mình không tính là đường hầm. Phải là kênh do phía mục tiêu khởi tạo:'
          + 'mục tiêu reverse shell về phía ta, chạy client frp/Stowaway trên mục tiêu, hoặc đường hầm suo5/HTTP dựng qua WebShell của mục tiêu; khi đăng ký dùng entry_kind để mô tả.'))
      }
      const activeSuo5 = tunnels.filter((t) => isSuo5(t.kind) && t.status === 'active')
      if (shells.length > 0 && activeSuo5.length === 0) {
        hints.push(hint('h2', 'Chưa có đường hầm suo5 khả dụng (kênh chuẩn để đánh vào nội bộ)',
          'Dùng kỹ năng suo5-tunnel dựng đường hầm socks5 qua WebShell ở trên, rồi redteam_tunnel_add'
          + '(kind=suo5, listen=127.0.0.1:1080, entry=URL WebShell, reach=dải mạng tiếp cận) để đăng ký,'
          + 'cuối cùng bấm "Kiểm tra kết nối" xác nhận status=active.'))
      }

      const shellCards = shells.map((w) => h('div', { key: 'w' + w.id, className: 'rt-sess' },
        h('div', { className: 'rt-sess-head' },
          statusDot(w.status),
          h('span', { className: 'rt-sess-title' }, w.url),
          h('span', { className: 'rt-tag rt-tag-active' }, w.shell_type || 'webshell'),
          isEncryptedShell(w.shell_type) ? null : h('span', { className: 'rt-tag rt-tag-warn' }, 'Người dùng không kết nối được'),
          w.privilege ? h('span', { className: 'rt-tag' }, w.privilege) : null,
          h('div', { className: 'rt-spacer' }),
          copied === 'cmd' + w.id
            ? h('span', { className: 'rt-tag', style: { color: 'var(--ui-success)' } }, 'Đã sao chép')
            : h('button', {
                className: 'rt-btn', style: { padding: '0 12px', fontSize: 'var(--ui-text-control)' },
                onClick: () => copy('cmd' + w.id, 'curl -s "' + w.url + '"'),
              }, 'Sao chép URL'),
          h('button', {
            className: 'rt-btn', style: { padding: '0 12px', fontSize: 'var(--ui-text-control)' },
            onClick: () => markShell(w, 'offline'),
          }, 'Đánh dấu mất hiệu lực')),
        h('div', { className: 'rt-sess-facts' },
          fact('Loại', (isEncryptedShell(w.shell_type) ? 'Mèo mã hóa (Behinder/Godzilla, người dùng kết nối trực tiếp được)' : 'Mèo không mã hóa — người dùng không kết nối được, chỉ dùng làm trung chuyển tạm')),
          w.pass_key ? fact('Mật khẩu kết nối', h('span', { className: 'rt-mono' }, w.pass_key)) : null,
          w.asset_ip ? fact('Tài sản chứa', w.asset_ip) : null,
          w.privilege ? fact('Quyền', w.privilege) : null,
          w.secret_ref ? fact('Tham chiếu thông tin xác thực', h('span', { className: 'rt-mono' }, w.secret_ref)) : null,
          fact('Kiểm tra lần cuối', (w.last_check ? fmt(w.last_check) : 'Chưa phát hiện')
            + (w.latency_ms !== null && w.latency_ms !== undefined ? '(' + w.latency_ms + 'ms)' : '')),
          w.check_note ? fact('Mô tả kiểm tra', w.check_note) : null,
          w.note ? fact('Ghi chú', w.note) : null)))

      const tunnelCards = tunnels.map((t) => {
        const proxy = t.listen ? 'socks5://' + t.listen : ''
        const gogoCmd = t.listen ? './gogo -i <CIDR nội bộ> -m ss --ping -p top2,win,db --proxy ' + proxy : ''
        const fscanCmd = t.listen ? './fscan -h <CIDR nội bộ> -np -nobr -nopoc -socks5 ' + t.listen + ' -o intranet.txt' : ''
        return h('div', { key: 't' + t.id, className: 'rt-sess' },
          h('div', { className: 'rt-sess-head' },
            statusDot(t.status),
            h('span', { className: 'rt-sess-title' }, t.listen || '(chưa điền địa chỉ lắng nghe)'),
            h('span', { className: 'rt-tag rt-tag-passive' }, t.kind || 'tunnel'),
            isSuo5(t.kind) ? null : h('span', { className: 'rt-tag rt-tag-warn' }, 'Kênh không chuẩn suo5'),
            /* Only a channel crossing the target boundary proves a break (your own VPS does not) */
            t.legit === true
              ? h('span', { className: 'rt-tag rt-tag-live', title: t.entry_kind_label || '' }, 'Kênh phía mục tiêu')
              : (t.legit === false
                  ? h('span', { className: 'rt-tag rt-tag-warn', title: 'Kênh chỉ mở trên VPS/máy chủ tự dựng, chưa chạm tới mục tiêu — không tính đột phá ranh giới/đột phá nội bộ' }, 'Không tính đột phá')
                  : h('span', { className: 'rt-tag', title: 'Chưa khai báo entry_kind: hãy mô tả đầu phía mục tiêu là gì (target-outbound / target-http / target-agent)' }, 'Chờ xác nhận')),
            t.reach ? h('span', { className: 'rt-tag' }, 'Tiếp cận ' + t.reach) : null,
            h('div', { className: 'rt-spacer' }),
            h('button', {
              className: 'rt-btn', style: { padding: '0 12px', fontSize: 'var(--ui-text-control)' },
              onClick: () => copy('sock' + t.id, t.listen || ''),
            }, copied === 'sock' + t.id ? 'Đã sao chép' : 'Sao chép địa chỉ'),
            t.status === 'active'
              ? h('button', { className: 'rt-btn', style: { padding: '0 12px', fontSize: 'var(--ui-text-control)' }, onClick: () => markTunnel(t, 'down') }, 'Đánh dấu mất hiệu lực')
              : h('button', { className: 'rt-btn', style: { padding: '0 12px', fontSize: 'var(--ui-text-control)' }, onClick: () => markTunnel(t, 'active') }, 'Đánh dấu khả dụng')),
          h('div', { className: 'rt-sess-facts' },
            fact('Điểm vào phía mục tiêu', t.entry || 'Chưa đăng ký'),
            fact('Vượt ranh giới', t.legit === true
              ? h('span', { className: 'rt-tag rt-tag-live' }, t.entry_kind_label || t.entry_kind || 'Đã xác nhận phía mục tiêu')
              : (t.legit === false
                  ? h('span', { className: 'rt-tag rt-tag-warn' }, 'Không tính đột phá (chỉ mở proxy trên VPS của mình)')
                  : h('span', { className: 'rt-tag' }, 'Chưa khai báo entry_kind, chờ xác nhận'))),
            t.reach ? fact('Dải mạng tiếp cận', t.reach) : null,
            t.asset_ip ? fact('Tài sản chứa', t.asset_ip) : null,
            fact('Kiểm tra lần cuối', (t.last_check ? fmt(t.last_check) : 'Chưa phát hiện')
              + (t.latency_ms !== null && t.latency_ms !== undefined ? '(' + t.latency_ms + 'ms)' : '')),
            t.check_note ? fact('Mô tả kiểm tra', t.check_note) : null,
            t.note ? fact('Ghi chú', t.note) : null),
          /* Commands collapsed by default: the card's first job is whether this channel works and where it leads */
          t.command ? h('details', { className: 'rt-sess-fold' },
            h('summary', null, 'Lệnh thiết lập (bấm để mở rộng / sao chép)'),
            h('div', Object.assign({ className: 'rt-code', title: 'Bấm để sao chép' }, clickable(() => copy('c' + t.id, t.command), { label: 'Sao chép lệnh' })),
              copied === 'c' + t.id ? 'Đã sao chép' : t.command)) : null,
          t.status === 'active' && t.listen
            ? h('details', { className: 'rt-sess-fold' },
                h('summary', null, 'Quét qua đường hầm này (lệnh gogo / fscan)'),
                h('div', { className: 'rt-sess-cmd' },
                  h('div', Object.assign({ className: 'rt-code', title: 'Bấm để sao chép' }, clickable(() => copy('g' + t.id, gogoCmd), { label: 'Sao chép lệnh gogo' })),
                    copied === 'g' + t.id ? 'Đã sao chép' : gogoCmd),
                  h('div', Object.assign({ className: 'rt-code', style: { display: 'block', marginTop: 3 }, title: 'Bấm để sao chép' }, clickable(() => copy('f' + t.id, fscanCmd), { label: 'Sao chép lệnh fscan' })),
                    copied === 'f' + t.id ? 'Đã sao chép' : fscanCmd)))
            : null)
      })

      return h('div', { className: 'rt-main rt-sessions-page' },
        h('div', { className: 'rt-toolbar rt-sessions-toolbar' },
          h('div', { className: 'rt-sessions-toolbar-copy' },
            h('strong', null, 'Tổng quan đăng ký'),
            h('small', null, 'Xem bản ghi đã đăng ký theo loại và trạng thái kiểm tra gần nhất.')),
          h('div', { className: 'rt-spacer' }),
          h('button', { className: 'rt-btn rt-btn-primary', disabled: busy, onClick: probe }, busy ? 'Đang kiểm tra…' : 'Kiểm tra kết nối'),
          h('button', { className: 'rt-btn', onClick: load }, 'Làm mới')),
        h('div', { className: 'rt-sessions-summary', 'aria-label': 'Thống kê đăng ký của dự án hiện tại' },
          [
            ['WebShell', data ? (totals.webshellsOnline || 0) + ' / ' + (totals.webshells || 0) : '—', 'Trực tuyến / đã đăng ký'],
            ['Đường hầm nội bộ', data ? (totals.tunnelsActive || 0) + ' / ' + (totals.tunnels || 0) : '—', 'Sẵn dùng / đã đăng ký'],
            ['Bản ghi thông tin xác thực', data ? String(totals.credentials || 0) : '—', 'Dự án hiện tại đã đăng ký'],
            ['Phiên truy cập', data ? String(totals.access || 0) : '—', 'Dự án hiện tại đã đăng ký'],
          ].map(([label, value, note]) => h('div', { key: label, className: 'rt-sessions-stat' },
            h('span', null, label), h('b', null, value), h('small', null, note)))),
        msg ? h('div', { className: 'rt-sessions-feedback', role: 'status' }, h('div', { className: msg.err ? 'rt-err' : 'rt-foot' }, msg.err || msg.ok)) : null,
        err ? h('div', { className: 'rt-sessions-feedback' }, h('div', { className: 'rt-err' }, err)) : null,
        h('div', { className: 'rt-sessions-scroll rt-body', style: { overflow: 'auto' } },
          !data && !err ? h('div', { className: 'rt-sessions-loading', role: 'status' }, eng ? 'Đang đọc bản ghi đăng ký…' : 'Hãy chọn dự án trước rồi xem bản ghi đăng ký.') : null,
          data && !shells.length && !tunnels.length
            ? h('div', { className: 'rt-sessions-empty-banner' },
                h('span', { className: 'rt-sessions-empty-icon', 'aria-hidden': 'true' }, 'i'),
                h('div', null,
                  h('strong', null, 'Chưa đăng ký WebShell hay đường hầm nào.'),
                  h('p', null, 'Có WebShell thì dùng redteam_webshell_add; dựng xong đường hầm thì dùng redteam_tunnel_add (suo5 / socks5 / ssh -R); sau đó tác nhân dùng redteam_sessions là thấy.')))
            : null,
          hints.length ? h('div', { className: 'rt-sessions-notices' }, hints) : null,
          h('div', { className: 'rt-sessions-groups' },
            h('section', { className: 'rt-sessions-group', 'aria-label': 'Bản ghi đăng ký WebShell' },
              h(Section, {
                key: 'webshells', tone: 'queue', title: 'WebShell',
                count: data ? (totals.webshellsOnline || 0) + '/' + (totals.webshells || 0) + ' trực tuyến' : 'Chưa đọc',
                sub: 'Điểm vào điều khiển được đã lên tuyến',
                open: sessCollapse.isOpen('shells', true), onToggle: sessCollapse.toggle('shells', true),
              }, h('div', { className: 'rt-sessions-group-content' + (shells.length ? '' : ' is-empty'), role: 'region', tabIndex: 0, 'aria-label': 'Nội dung bản ghi WebShell' },
                shells.length
                  ? h('div', { className: 'rt-sess-grid', style: { padding: 0 } }, shellCards)
                  : h('div', { className: 'rt-atest-meta' }, data ? 'Chưa có (sau khi có WebShell hãy dùng redteam_webshell_add để đăng ký)' : 'Chờ đọc bản ghi')))),
            h('section', { className: 'rt-sessions-group', 'aria-label': 'Bản ghi đăng ký đường hầm nội bộ' },
              h(Section, {
                key: 'tunnels', tone: 'test', title: 'Đường hầm nội bộ',
                count: data ? (totals.tunnelsActive || 0) + '/' + (totals.tunnels || 0) + ' sẵn dùng' : 'Chưa đọc',
                sub: 'Dùng trực tiếp làm proxy cho scanner được',
                open: sessCollapse.isOpen('tunnels', true), onToggle: sessCollapse.toggle('tunnels', true),
              }, h('div', { className: 'rt-sessions-group-content' + (tunnels.length ? '' : ' is-empty'), role: 'region', tabIndex: 0, 'aria-label': 'Nội dung bản ghi đường hầm nội bộ' },
                tunnels.length
                  ? h('div', { className: 'rt-sess-grid', style: { padding: 0 } }, tunnelCards)
                  : h('div', { className: 'rt-atest-meta' }, data ? 'Chưa có (sau khi dựng xong đường hầm hãy dùng redteam_tunnel_add để đăng ký)' : 'Chờ đọc bản ghi')))))))

    }

    /* __RT_SESSION_MAP_HELPERS_BEGIN__ */
    /*
     * Session map data is deliberately kept as a small, dependency-free
     * boundary.  It only accepts the host's summary envelope and never reads
     * unrecognized projection fields or transcripts. Only bounded normalized
     * title, subagent label and todo metadata are projected below.
     */
    const SESSION_MAP_MAX_NODES = 300
    const SESSION_MAP_NODE_WIDTH = 292
    const SESSION_MAP_NODE_HEIGHT = 110
    const SESSION_MAP_ROLE_NAMES = { plan: 'Phiên chính', recon: 'Thu thập thông tin', assess: 'Rà soát tài sản', 'vuln-scan': 'Phát hiện lỗ hổng', exploit: 'Khai thác lỗ hổng', internal: 'Xâm nhập mạng nội bộ' }
    const sessionMapDisplayName = (item) => item.subagentLabel || item.label
    const SESSION_MAP_UNKNOWN = 'Host chưa cung cấp'
    const sessionMapHasOwn = (value, key) => Object.prototype.hasOwnProperty.call(value, key)
    const sessionMapRecord = (value) => value !== null && typeof value === 'object' && !Array.isArray(value)

    const assertSessionMapParentGraph = (items) => {
      const byId = new Map(items.map((item) => [item.id, item]))
      const done = new Set()
      for (const item of items) {
        if (done.has(item.id)) continue
        const path = new Set()
        let current = item
        while (current) {
          if (path.has(current.id)) throw new Error('parent-cycle')
          if (done.has(current.id)) break
          path.add(current.id)
          const parentId = current.parentId
          current = typeof parentId === 'string' ? byId.get(parentId) : null
        }
        for (const id of path) done.add(id)
      }
    }

    /**
     * Validate one exact session/list server envelope and project it to safe
     * map fields.  The host's `updatedAt` metadata is preserved separately;
     * each row's updatedAt remains the host record timestamp, not a status
     * transition time.
     */
    function validateSessionListResponse(envelope, rpcId) {
      if (!sessionMapRecord(envelope)
        || envelope.type !== 'server-response'
        || envelope.rpcId !== rpcId
        || !sessionMapRecord(envelope.result)
        || envelope.result.ok !== true
        || !sessionMapRecord(envelope.result.value)
        || !Array.isArray(envelope.result.value.items)) {
        throw new Error('session-list-invalid')
      }
      const value = envelope.result.value
      const seen = new Set()
      if (value.items.length > 5000) throw new Error('session-list-row-limit')
      const items = value.items.map((raw) => {
        if (!sessionMapRecord(raw) || typeof raw.sessionId !== 'string' || raw.sessionId.trim() === '') {
          throw new Error('session-id-invalid')
        }
        const id = raw.sessionId
        if (seen.has(id)) throw new Error('duplicate-session-id')
        seen.add(id)
        let parentId
        if (sessionMapHasOwn(raw, 'parentSessionId')) {
          if (raw.parentSessionId !== null
            && (typeof raw.parentSessionId !== 'string' || raw.parentSessionId.trim() === '')) {
            throw new Error('parent-session-id-invalid')
          }
          parentId = raw.parentSessionId
        } else {
          parentId = null
        }
        if (sessionMapHasOwn(raw, 'updatedAt')
          && (typeof raw.updatedAt !== 'number'
            || !Number.isFinite(raw.updatedAt)
            || !Number.isFinite(new Date(raw.updatedAt).getTime()))) {
          throw new Error('updatedAt-invalid')
        }
        if (sessionMapHasOwn(raw, 'cwd') && raw.cwd !== undefined
          && typeof raw.cwd !== 'string') {
          throw new Error('cwd-invalid')
        }
        const item = {
          id,
          label: id,
          parentId,
          activity: raw.running === true ? 'running' : raw.running === false ? 'idle' : 'unknown',
        }
        if (typeof raw.agentAvailable === 'boolean') item.agentAvailable = raw.agentAvailable
        if (raw.origin === 'subagent') item.origin = raw.origin
        if (raw.formatStatus === 'current' || raw.formatStatus === 'migration-required') item.formatStatus = raw.formatStatus
        // session/list exposes normalized metadata here, never a transcript.
        const values = sessionMapRecord(raw.projections) && sessionMapRecord(raw.projections.values)
          ? raw.projections.values : null
        const text = (value, limit) => {
          if (typeof value !== 'string' || !value.trim()) return null
          const cleaned = value.trim().replace(/[\u0000-\u001f\u007f]/g, ' ')
          return limit === undefined ? cleaned : cleaned.slice(0, limit)
        }
        if (values) {
          if (raw.projections.kind === 'cached' || raw.projections.kind === 'sequenced') item.projectionKind = raw.projections.kind
          // Keep complete names inside the already size-bounded response.
          // Only the SVG caption renderer may abbreviate these fields.
          const title = text(values.title)
          const subagent = sessionMapRecord(values.subagent) ? values.subagent : null
          const subagentLabel = subagent ? text(subagent.label) : null
          if (title || subagentLabel) {
            item.label = title || subagentLabel
            item.labelSource = title ? 'title' : 'subagent'
            const declaredRole = item.label.match(/^redteamRole:\s*(plan|recon|assess|vuln-scan|exploit|internal)\b\s*/i)
            if (declaredRole) {
              item.declaredRole = declaredRole[1].toLowerCase()
              item.originalLabel = item.label
              item.label = SESSION_MAP_ROLE_NAMES[item.declaredRole] + (item.label.slice(declaredRole[0].length).replace(/^#+\s*/, '') ? ' · ' + item.label.slice(declaredRole[0].length).replace(/^#+\s*/, '') : '')
            }
          }
          if (subagentLabel) item.subagentLabel = subagentLabel
          if (subagent && ['one-shot', 'continuable'].includes(subagent.mode)) item.subagentMode = subagent.mode
          const timing = sessionMapRecord(values.subagentTiming) ? values.subagentTiming : null
          const nonnegativeInteger = (value) => Number.isSafeInteger(value) && value >= 0
          if (timing && nonnegativeInteger(timing.settledMs)) {
            item.subagentTiming = { settledMs: timing.settledMs }
            if (sessionMapRecord(timing.active) && nonnegativeInteger(timing.active.since)
              && nonnegativeInteger(timing.active.through) && timing.active.through >= timing.active.since) {
              item.subagentTiming.active = { since: timing.active.since, through: timing.active.through }
            }
            if (typeof timing.lastTurnCompleted === 'boolean') item.subagentTiming.lastTurnCompleted = timing.lastTurnCompleted
          }
          if (Array.isArray(values.subagentCatalog) && values.subagentCatalog.length <= SESSION_MAP_MAX_NODES
            && values.subagentCatalog.every((entry) => sessionMapRecord(entry) && typeof entry.id === 'string' && entry.id.trim()
              && nonnegativeInteger(entry.createdAt)
              && ['one-shot', 'external', 'continuable', 'unknown'].includes(entry.mode))) {
            item.childCatalog = values.subagentCatalog.map((entry) => {
              const projected = { id: entry.id, createdAt: entry.createdAt, mode: entry.mode }
              if (text(entry.label)) projected.label = text(entry.label)
              return projected
            })
          }
          if (Array.isArray(values.todos) && values.todos.length <= 100
            && values.todos.every((todo) => sessionMapRecord(todo) && text(todo.content, 500)
              && ['pending', 'in_progress', 'completed'].includes(todo.status))) {
            item.todos = values.todos.map((todo) => {
              const content = text(todo.content)
              const projected = { content: content.slice(0, 500), status: todo.status }
              if (content.length > 500) projected.truncated = true
              return projected
            })
            const active = item.todos.filter((todo) => todo.status === 'in_progress')
            if (active.length) item.currentTask = active.slice(0, 3).map((todo) => todo.content).join('; ').slice(0, 900)
            item.taskProgress = { completed: item.todos.filter((todo) => todo.status === 'completed').length, total: item.todos.length }
          }
        }
        if (sessionMapHasOwn(raw, 'updatedAt')) item.updatedAt = raw.updatedAt
        if (typeof raw.cwd === 'string') item.cwd = raw.cwd
        return item
      })
      assertSessionMapParentGraph(items)
      const sourceUpdatedAtRaw = sessionMapHasOwn(value, 'sourceUpdatedAt')
        ? value.sourceUpdatedAt
        : value.updatedAt
      const sourceUpdatedAt = (typeof sourceUpdatedAtRaw === 'number' && Number.isFinite(sourceUpdatedAtRaw))
        || (typeof sourceUpdatedAtRaw === 'string' && sourceUpdatedAtRaw.trim() !== '')
        ? sourceUpdatedAtRaw
        : undefined
      return sourceUpdatedAt === undefined ? { items } : { items, sourceUpdatedAt }
    }

    /**
     * Pick the project roots from the persisted binding response and retain
     * only rows whose parent chain reaches one of those roots.  A row directly
     * attached to a bound root that is missing from this snapshot remains
     * visible as an explicit orphan; unrelated host orphans stay out of scope.
     */
    function scopeSessionSummaries(items, bindingResponse, engagement) {
      if (typeof engagement !== 'string' || engagement === '') {
        return { sessions: [], orphans: [], rootIds: [], reason: 'no-engagement' }
      }
      const agents = bindingResponse && sessionMapRecord(bindingResponse.agents)
        ? bindingResponse.agents
        : {}
      const rootIds = Object.keys(agents).filter((id) => {
        const entry = agents[id]
        return sessionMapRecord(entry) && entry.engagement === engagement
      })
      if (rootIds.length === 0) {
        return { sessions: [], orphans: [], rootIds: [], reason: 'no-bound-roots' }
      }

      const rows = Array.isArray(items) ? items : []
      const byId = new Map()
      for (const item of rows) {
        if (!sessionMapRecord(item) || typeof item.id !== 'string' || item.id === '') {
          throw new Error('session-id-invalid')
        }
        if (byId.has(item.id)) throw new Error('duplicate-session-id')
        byId.set(item.id, item)
      }
      assertSessionMapParentGraph(rows)
      const roots = new Set(rootIds)
      const memo = new Map()
      const classify = (item, path) => {
        if (memo.has(item.id)) return memo.get(item.id)
        if (path.has(item.id)) throw new Error('parent-cycle')
        const nextPath = new Set(path)
        nextPath.add(item.id)
        if (roots.has(item.id)) {
          const rootResult = { included: true, orphan: typeof item.parentId === 'string' && !byId.has(item.parentId) }
          memo.set(item.id, rootResult)
          return rootResult
        }
        if (typeof item.parentId !== 'string' || item.parentId === '') {
          const noParent = { included: false, orphan: false }
          memo.set(item.id, noParent)
          return noParent
        }
        if (roots.has(item.parentId)) {
          const missingRoot = { included: true, orphan: !byId.has(item.parentId) }
          memo.set(item.id, missingRoot)
          return missingRoot
        }
        const parent = byId.get(item.parentId)
        if (!parent) {
          const missingParent = { included: false, orphan: false }
          memo.set(item.id, missingParent)
          return missingParent
        }
        const parentResult = classify(parent, nextPath)
        const result = { included: parentResult.included, orphan: false }
        memo.set(item.id, result)
        return result
      }

      const sessions = []
      for (const item of rows) {
        const result = classify(item, new Set())
        if (!result.included) continue
        const mapped = Object.assign({}, item)
        if (result.orphan) mapped.orphan = true
        sessions.push(mapped)
      }
      if (sessions.length > SESSION_MAP_MAX_NODES) throw new Error('session-map-too-large')
      // Catalog entries only enrich confirmed, already scoped direct children.
      // They never add graph nodes or expose another project's session metadata.
      const scopedById = new Map(sessions.map((item) => [item.id, item]))
      for (const mapped of sessions) {
        if (mapped.childCatalog) mapped.childCatalog = mapped.childCatalog.filter((entry) => {
          const child = scopedById.get(entry.id)
          return child && child.parentId === mapped.id
        })
      }
      const numbered = sessions.slice().sort((a, b) => a.id.localeCompare(b.id))
      for (const mapped of sessions) {
        if (!mapped.labelSource && (!mapped.label || mapped.label === mapped.id)) {
          mapped.label = (typeof mapped.parentId === 'string' ? 'Phiên con ' : 'Phiên dự án ') + (numbered.findIndex((item) => item.id === mapped.id) + 1)
          mapped.labelSource = 'relationship'
        }
      }
      return {
        sessions,
        orphans: sessions.filter((item) => item.orphan === true),
        rootIds,
        reason: null,
      }
    }

    /** Search/status filtering keeps matching rows plus their known ancestors. */
    function selectSessionMapVisible(items, query, activity) {
      const rows = Array.isArray(items) ? items : []
      const byId = new Map(rows.map((item) => [item.id, item]))
      const q = String(query || '').trim().toLocaleLowerCase()
      const status = activity === 'running' || activity === 'idle' || activity === 'unknown' ? activity : 'all'
      const matches = []
      const matchingIds = []
      for (const item of rows) {
        const text = [item.id, item.label, item.subagentLabel, item.currentTask, item.cwd, ...(Array.isArray(item.todos) ? item.todos.map((todo) => todo.content) : [])].filter((value) => typeof value === 'string').join('\n')
        if ((status === 'all' || item.activity === status) && (!q || text.toLocaleLowerCase().includes(q))) {
          matchingIds.push(item.id)
          matches.push(item.id)
        }
      }
      const context = []
      const visibleIds = new Set(matchingIds)
      for (const id of matchingIds) {
        let parentId = byId.get(id) && byId.get(id).parentId
        const seen = new Set([id])
        while (typeof parentId === 'string' && byId.has(parentId) && !seen.has(parentId)) {
          seen.add(parentId)
          if (!visibleIds.has(parentId)) {
            visibleIds.add(parentId)
            context.push(parentId)
          }
          parentId = byId.get(parentId).parentId
        }
      }
      return {
        sessions: rows.filter((item) => visibleIds.has(item.id)),
        matches,
        context,
      }
    }

    /** Summarize only the already project-scoped snapshot; filtering does not change totals. */
    function summarizeSessionMap(items, selectedId) {
      const counts = { total: items.length, running: 0, idle: 0, unknown: 0 }
      const byId = new Map(items.map((item) => [item.id, item]))
      const childCounts = new Map()
      for (const item of items) {
        counts[item.activity === 'running' || item.activity === 'idle' ? item.activity : 'unknown'] += 1
        if (byId.has(item.parentId)) childCounts.set(item.parentId, (childCounts.get(item.parentId) || 0) + 1)
      }
      const selected = byId.get(selectedId)
      const ancestors = []
      const seen = new Set([selectedId])
      let parent = selected && byId.get(selected.parentId)
      while (parent && !seen.has(parent.id)) {
        seen.add(parent.id)
        ancestors.unshift(parent)
        parent = byId.get(parent.parentId)
      }
      return {
        counts, childCounts, ancestors,
        parent: selected ? byId.get(selected.parentId) || null : null,
        children: selected ? items.filter((item) => item.parentId === selectedId) : [],
      }
    }

    /** Deterministic two-dimensional tree layout; missing parents become roots. */
    function sessionMapEdgePath(edge) {
      const bend = (edge.x2 - edge.x1) / 2
      return 'M ' + edge.x1 + ' ' + edge.y1 + ' C ' + (edge.x1 + bend) + ' ' + edge.y1 + ', ' + (edge.x2 - bend) + ' ' + edge.y2 + ', ' + edge.x2 + ' ' + edge.y2
    }

    function layoutSessionMap(items) {
      const rows = Array.isArray(items) ? items : []
      if (rows.length > SESSION_MAP_MAX_NODES) throw new Error('session-map-too-large')
      const byId = new Map()
      for (const item of rows) {
        if (!sessionMapRecord(item) || typeof item.id !== 'string' || item.id === '') {
          throw new Error('session-id-invalid')
        }
        if (byId.has(item.id)) throw new Error('duplicate-session-id')
        byId.set(item.id, item)
      }
      assertSessionMapParentGraph(rows)
      const children = new Map(rows.map((item) => [item.id, []]))
      const roots = []
      for (const item of rows) {
        if (typeof item.parentId === 'string' && children.has(item.parentId)) children.get(item.parentId).push(item)
        else roots.push(item)
      }
      const nodes = []
      const edges = []
      let row = 0
      let maxDepth = 0
      const place = (item, depth) => {
        const childItems = children.get(item.id) || []
        const childNodes = childItems.map((child) => place(child, depth + 1))
        const y = childNodes.length
          ? (childNodes[0].y + childNodes[childNodes.length - 1].y) / 2
          : 40 + row++ * 158
        maxDepth = Math.max(maxDepth, depth)
        const node = Object.assign({}, item, { x: 40 + depth * 350, y, depth })
        nodes.push(node)
        for (const child of childNodes) {
          edges.push({
            from: item.id,
            to: child.id,
            x1: node.x + SESSION_MAP_NODE_WIDTH,
            y1: y + SESSION_MAP_NODE_HEIGHT / 2,
            x2: child.x,
            y2: child.y + SESSION_MAP_NODE_HEIGHT / 2,
          })
        }
        return node
      }
      for (const root of roots) {
        place(root, 0)
        row += 0.3
      }
      return {
        nodes,
        edges,
        width: Math.max(600, 80 + maxDepth * 350 + SESSION_MAP_NODE_WIDTH),
        height: Math.max(440, 80 + row * 158),
      }
    }
    /** Local layout overrides never mutate host session records. */
    function positionSessionMap(graph, positions) {
      if (!positions || !positions.size || !graph.nodes.length) return graph
      const nodes = graph.nodes.map((node) => {
        const position = positions.get(node.id)
        return position && Number.isFinite(position.x) && Number.isFinite(position.y)
          ? Object.assign({}, node, position) : node
      })
      const byId = new Map(nodes.map((node) => [node.id, node]))
      const edges = graph.edges.map((edge) => {
        const from = byId.get(edge.from), to = byId.get(edge.to)
        return Object.assign({}, edge, {
          x1: from.x + SESSION_MAP_NODE_WIDTH, y1: from.y + SESSION_MAP_NODE_HEIGHT / 2,
          x2: to.x, y2: to.y + SESSION_MAP_NODE_HEIGHT / 2,
        })
      })
      const minX = Math.min(...nodes.map((node) => node.x)) - 40
      const minY = Math.min(...nodes.map((node) => node.y)) - 40
      return Object.assign({}, graph, {
        nodes, edges, minX, minY,
        width: Math.max(600, Math.max(...nodes.map((node) => node.x + SESSION_MAP_NODE_WIDTH)) + 40 - minX),
        height: Math.max(440, Math.max(...nodes.map((node) => node.y + SESSION_MAP_NODE_HEIGHT)) + 40 - minY),
      })
    }
    /* __RT_SESSION_MAP_HELPERS_END__ */

    /* __RT_SESSION_MAP_COMPONENT_BEGIN__ */
    async function readSessionMapJson(response, limit = 4 * 1024 * 1024) {
      const declaredLength = Number(response.headers && response.headers.get('content-length'))
      if (Number.isFinite(declaredLength) && declaredLength > limit) {
        if (response.body) await response.body.cancel().catch(() => {})
        throw new Error('session-response-too-large')
      }
      if (!response.body || typeof response.body.getReader !== 'function') throw new Error('session-response-unreadable')
      const reader = response.body.getReader()
      const decoder = new TextDecoder('utf-8', { fatal: true })
      let bytes = 0
      let text = ''
      try {
        for (;;) {
          const part = await reader.read()
          if (part.done) break
          bytes += part.value.byteLength
          if (bytes > limit) {
            await reader.cancel().catch(() => {})
            throw new Error('session-response-too-large')
          }
          text += decoder.decode(part.value, { stream: true })
        }
        try { return JSON.parse(text + decoder.decode()) } catch (e) { throw new Error('session-response-invalid') }
      } finally { reader.releaseLock() }
    }

    let SESSION_MAP_RPC_SEQ = 0
    const nextSessionMapRpcId = () => {
      SESSION_MAP_RPC_SEQ += 1
      return 'rt-session-map-' + Date.now().toString(36) + '-' + SESSION_MAP_RPC_SEQ.toString(36)
    }

    const SESSION_MAP_REQUEST_TIMEOUT_MS = 6000

    /** Read the host metadata route through the authenticated same-origin channel. */
    const requestSessionMapSummaries = (controller) => {
      const rpcId = nextSessionMapRpcId()
      let timedOut = false
      const timer = window.setTimeout(() => {
        timedOut = true
        controller.abort()
      }, SESSION_MAP_REQUEST_TIMEOUT_MS)
      return fetch('/api/session/list', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          type: 'client-request',
          rpcId,
          method: 'session/list',
          /* The generated Host invocation has one reserved `_request` argument. */
          payload: { args: { _request: {} } },
        }),
        signal: controller.signal,
      }).then((response) => {
        if (!response.ok) throw new Error('session-list-http-' + response.status)
        return readSessionMapJson(response)
      }).then((envelope) => validateSessionListResponse(envelope, rpcId)).catch((reason) => {
        if (timedOut) throw new Error('session-list-timeout')
        throw reason
      }).finally(() => window.clearTimeout(timer))
    }

    /** Abortable plugin binding read; it never forwards a host credential. */
    const requestSessionMapBindings = (engagement, controller) => {
      let timedOut = false
      const timer = window.setTimeout(() => {
        timedOut = true
        controller.abort()
      }, SESSION_MAP_REQUEST_TIMEOUT_MS)
      return fetch('/redteam/api', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ op: 'sessionBindings', engagement: engagement }),
        signal: controller.signal,
      }).then((response) => {
        if (!response.ok) throw new Error('session-bindings-http-' + response.status)
        return readSessionMapJson(response)
      }).then((body) => {
        if (!sessionMapRecord(body) || body.ok !== true || !sessionMapRecord(body.agents)) throw new Error('session-bindings-invalid')
        return body
      }).catch((reason) => {
        if (timedOut) throw new Error('session-bindings-timeout')
        throw reason
      }).finally(() => window.clearTimeout(timer))
    }

    const sessionMapActivityLabel = (activity) => activity === 'running'
      ? 'Đang chạy'
      : activity === 'idle' ? 'Không chạy (kết quả không rõ)' : 'Trạng thái không rõ'
    const sessionMapActivityClass = (activity) => activity === 'running'
      ? 'running' : activity === 'idle' ? 'idle' : 'unknown'
    const sessionMapTime = (value) => {
      if ((typeof value !== 'number' || !Number.isFinite(value))
        && (typeof value !== 'string' || value.trim() === '')) return SESSION_MAP_UNKNOWN
      try {
        const date = new Date(value)
        return Number.isFinite(date.getTime()) ? date.toLocaleString('zh-CN', { hour12: false }) : SESSION_MAP_UNKNOWN
      } catch (e) { return SESSION_MAP_UNKNOWN }
    }

    const sessionMapModeLabel = (mode) => ({ 'one-shot': 'Nhiệm vụ một lần', continuable: 'Phiên bền vững', external: 'Phiên bên ngoài', unknown: 'Chế độ không rõ' })[mode] || SESSION_MAP_UNKNOWN
    const sessionMapDuration = (ms) => {
      if (!Number.isSafeInteger(ms) || ms < 0) return SESSION_MAP_UNKNOWN
      if (ms < 1000) return ms + ' mili giây'
      const seconds = Math.floor(ms / 1000)
      const hours = Math.floor(seconds / 3600), minutes = Math.floor(seconds % 3600 / 60)
      return [hours ? hours + ' giờ' : '', minutes ? minutes + ' điểm' : '', seconds % 60 || (!hours && !minutes) ? seconds % 60 + ' giây' : ''].filter(Boolean).join(' ')
    }

    function SessionMap(props) {
      const engagement = typeof props.engagement === 'string' ? props.engagement : ''
      const refreshKey = props.refreshKey || 0
      /* Stage data is injected by the shell's teamBoard view.  The map remains
         read-only and does not duplicate host-side task-stage judgement. */
      const stages = props.stages && typeof props.stages === 'object' ? props.stages : null
      const compact = props.compact === true
      const [snapshot, setSnapshot] = React.useState(null)
      const [selectedId, setSelectedId] = React.useState(null)
      const [query, setQuery] = React.useState('')
      const [activity, setActivity] = React.useState('all')
      const [zoom, setZoom] = React.useState(1)
      const [paused, setPaused] = React.useState(false)
      const [loading, setLoading] = React.useState(false)
      const [error, setError] = React.useState(null)
      const [pausedAt, setPausedAt] = React.useState(null)
      const [clock, setClock] = React.useState(() => Date.now())
      const [pan, setPan] = React.useState({ x: 0, y: 0 })
      const [expanded, setExpanded] = React.useState(false)
      const [dragging, setDragging] = React.useState(false)
      const [nodePositions, setNodePositions] = React.useState(() => new Map())
      const graphRef = React.useRef(null)
      const cameraRef = React.useRef({ zoom, pan })
      cameraRef.current = { zoom, pan }
      const inFlightRef = React.useRef(false)
      const requestRef = React.useRef(null)
      const generationRef = React.useRef(0)
      const mountedRef = React.useRef(true)
      const snapshotRef = React.useRef(null)
      const graphViewportRef = React.useRef(null)
      const mapRef = React.useRef(null)
      const dragRef = React.useRef(null)
      const suppressClickRef = React.useRef(false)
      const expandedRef = React.useRef(false)
      expandedRef.current = expanded

      const leaveFullscreen = async () => {
        if (document.fullscreenElement === mapRef.current && document.exitFullscreen) {
          try { await document.exitFullscreen() } catch (e) { /* local maximize can still close */ }
        }
        setExpanded(false)
      }
      const toggleFullscreen = async () => {
        if (expanded) return leaveFullscreen()
        setExpanded(true)
        const element = mapRef.current
        if (element && element.requestFullscreen) {
          try { await element.requestFullscreen() } catch (e) { /* keep local maximize if host disallows native fullscreen */ }
        }
      }
      React.useEffect(() => {
        const onFullscreenChange = () => setExpanded(document.fullscreenElement === mapRef.current)
        const onKey = (event) => {
          if (event.key !== 'Escape' || !expandedRef.current) return
          if (event.stopPropagation) event.stopPropagation()
          leaveFullscreen()
        }
        document.addEventListener('fullscreenchange', onFullscreenChange)
        document.addEventListener('keydown', onKey)
        return () => {
          document.removeEventListener('fullscreenchange', onFullscreenChange)
          document.removeEventListener('keydown', onKey)
          if (document.fullscreenElement === mapRef.current && document.exitFullscreen) document.exitFullscreen().catch(() => {})
        }
      }, [])

      React.useEffect(() => {
        mountedRef.current = true
        return () => {
          mountedRef.current = false
          generationRef.current += 1
          if (requestRef.current) requestRef.current.abort()
        }
      }, [])

      const read = React.useCallback(() => {
        if (!engagement || inFlightRef.current) return Promise.resolve()
        const generation = generationRef.current
        const controller = new AbortController()
        inFlightRef.current = true
        requestRef.current = controller
        setLoading(true)
        const current = () => mountedRef.current
          && generationRef.current === generation
          && requestRef.current === controller
        const commit = (next) => {
          if (!current()) return
          snapshotRef.current = next
          setSnapshot(next)
          setError(null)
        }
        return requestSessionMapBindings(engagement, controller).then((bindingResponse) => {
          if (!current()) return null
          if (!bindingResponse || bindingResponse.ok === false) {
            throw new Error((bindingResponse && bindingResponse.error) || 'Đọc liên kết phiên thất bại')
          }
          const empty = scopeSessionSummaries([], bindingResponse, engagement)
          if (empty.rootIds.length === 0) {
            commit(Object.assign({}, empty, {
              engagement: engagement,
              sourceObservedAt: Date.now(),
              stale: false,
              error: null,
            }))
            return null
          }
          return requestSessionMapSummaries(controller).then((listResult) => {
            if (!current()) return null
            const scoped = scopeSessionSummaries(listResult.items, bindingResponse, engagement)
            const next = Object.assign({}, scoped, {
              engagement: engagement,
              sourceObservedAt: Date.now(),
              stale: false,
              error: null,
            })
            if (listResult.sourceUpdatedAt !== undefined) next.sourceUpdatedAt = listResult.sourceUpdatedAt
            commit(next)
            return next
          })
        }).catch((reason) => {
          if (!current() || (reason && reason.name === 'AbortError')) return
          const message = String((reason && reason.message) || reason || 'Đọc phiên thất bại')
          setError(message)
          const last = snapshotRef.current
          if (last) {
            const stale = Object.assign({}, last, { stale: true, error: message })
            snapshotRef.current = stale
            setSnapshot(stale)
          }
        }).finally(() => {
          if (!current()) return
          inFlightRef.current = false
          requestRef.current = null
          setLoading(false)
        })
      }, [engagement])

      /* Engagement changes clear the old scope before any new request starts. */
      React.useEffect(() => {
        generationRef.current += 1
        if (requestRef.current) requestRef.current.abort()
        inFlightRef.current = false
        requestRef.current = null
        snapshotRef.current = null
        setSnapshot(null)
        setSelectedId(null)
        setQuery('')
        setActivity('all')
        setZoom(1)
        setPan({ x: 0, y: 0 })
        dragRef.current = null
        setError(null)
        setPausedAt(pausedAt ? Date.now() : null)
        setClock(Date.now())
        if (engagement) read()
        return () => {
          generationRef.current += 1
          if (requestRef.current) requestRef.current.abort()
          inFlightRef.current = false
          requestRef.current = null
        }
      }, [engagement, read])

      /* A panel refresh starts a new read but must not clear the current scope or selection. */
      React.useEffect(() => {
        if (refreshKey && engagement) read()
      }, [refreshKey, engagement, read])

      React.useEffect(() => {
        if (!engagement || paused) return undefined
        const timer = window.setInterval(() => { read() }, 5000)
        return () => window.clearInterval(timer)
      }, [engagement, paused, read])

      React.useEffect(() => {
        if (!paused) return undefined
        const timer = window.setInterval(() => setClock(Date.now()), 1000)
        return () => window.clearInterval(timer)
      }, [paused])

      React.useEffect(() => {
        setSelectedId((current) => {
          if (current && snapshot && snapshot.sessions.some((item) => item.id === current)) return current
          return snapshot && snapshot.sessions.length ? snapshot.sessions[0].id : null
        })
      }, [snapshot])

      /* Effects run after paint; the engagement tag prevents one frame of old-scope leakage. */
      const activeSnapshot = snapshot && snapshot.engagement === engagement ? snapshot : null
      const scoped = activeSnapshot && Array.isArray(activeSnapshot.sessions) ? activeSnapshot.sessions : []
      const filtered = selectSessionMapVisible(scoped, query, activity)
      const autoGraph = layoutSessionMap(filtered.sessions)
      const localPositions = nodePositions.get(engagement)
      const graph = positionSessionMap(autoGraph, localPositions)
      graphRef.current = graph
      const selected = scoped.find((item) => item.id === selectedId) || null
      const selectedVisible = filtered.sessions.some((item) => item.id === selectedId)
      const statusClass = selected ? sessionMapActivityClass(selected.activity) : 'unknown'
      const context = summarizeSessionMap(scoped, selectedId)
      const selectedName = selected ? sessionMapDisplayName(selected) : ''
      const selectedTodos = selected && Array.isArray(selected.todos) ? selected.todos : null
      const selectedProgress = selected && selected.taskProgress
      const selectedCatalog = selected && context.parent && Array.isArray(context.parent.childCatalog) ? context.parent.childCatalog.find((entry) => entry.id === selected.id) : null
      const selectedMode = selected && (selected.subagentMode || (selectedCatalog && selectedCatalog.mode))
      const selectedTiming = selected && selected.subagentTiming
      const pausedStale = !!(paused && pausedAt && clock - pausedAt >= 60000 && activeSnapshot)
      const displayedStale = !!(activeSnapshot && (activeSnapshot.stale || pausedStale))
      const liveSessionIds = new Set(!displayedStale && !paused
        ? graph.nodes.filter((node) => node.activity === 'running').map((node) => node.id) : [])
      const sessionMapNodeLabel = (value) => {
        const text = String(value || '')
        let width = 0, output = ''
        for (const char of text) {
          width += char.codePointAt(0) > 255 ? 2 : 1
          if (width > 34) return output + '…'
          output += char
        }
        return output
      }
      const fit = (mode, layout) => {
        const fitGraph = layout || graphRef.current
        const viewport = graphViewportRef.current
        if (!viewport || !fitGraph.width || !fitGraph.height) return
        const availableWidth = Math.max(180, viewport.clientWidth - 18)
        const availableHeight = Math.max(180, viewport.clientHeight - 18)
        const fitted = Math.max(0.08, Math.min(1.6, Math.min(availableWidth / fitGraph.width, availableHeight / fitGraph.height)))
        const next = mode === 'readable' && !compact ? Math.max(0.8, fitted) : fitted
        setZoom(next)
        if (mode === 'readable' && fitted < 0.8 && !compact) {
          const node = fitGraph.nodes.find((item) => item.id === selectedId) || fitGraph.nodes.find((item) => item.depth === 0)
          setPan(node ? { x: Math.max(18, (viewport.clientWidth - SESSION_MAP_NODE_WIDTH * next) / 3) - node.x * next, y: 36 - node.y * next } : { x: 18, y: 18 })
        } else setPan({ x: (viewport.clientWidth - fitGraph.width * next) / 2 - (fitGraph.minX || 0) * next, y: (viewport.clientHeight - fitGraph.height * next) / 2 - (fitGraph.minY || 0) * next })
      }
      React.useEffect(() => {
        fit(expanded ? 'all' : 'readable')
        const viewport = graphViewportRef.current
        if (!viewport || typeof ResizeObserver === 'undefined') return undefined
        const observer = new ResizeObserver(() => fit(expanded ? 'all' : 'readable'))
        observer.observe(viewport)
        return () => observer.disconnect()
      }, [engagement, autoGraph.width, autoGraph.height, query, activity, expanded, !!activeSnapshot])
      const changeZoom = React.useCallback((amount, point) => {
        const viewport = graphViewportRef.current
        const camera = cameraRef.current
        const next = Math.max(0.08, Math.min(2.4, camera.zoom * amount))
        if (next === camera.zoom) return
        const anchor = point || (viewport ? { x: viewport.clientWidth / 2, y: viewport.clientHeight / 2 } : { x: 0, y: 0 })
        const nextPan = {
          x: anchor.x - (anchor.x - camera.pan.x) * next / camera.zoom,
          y: anchor.y - (anchor.y - camera.pan.y) * next / camera.zoom,
        }
        // Native wheel events may arrive together before React commits a render.
        cameraRef.current = { zoom: next, pan: nextPan }
        setPan(nextPan)
        setZoom(next)
      }, [])
      const moveNode = (id, x, y) => {
        if (!Number.isFinite(x) || !Number.isFinite(y)) return
        setNodePositions((current) => {
          const layouts = new Map(current)
          const positions = new Map(current.get(engagement) || [])
          positions.set(id, { x, y })
          layouts.set(engagement, positions)
          return layouts
        })
      }
      const startNodeDrag = (event, node) => {
        if (event.button !== 0 || !Number.isFinite(event.clientX) || !Number.isFinite(event.clientY)) return
        event.stopPropagation()
        event.preventDefault()
        event.currentTarget.focus?.({ preventScroll: true })
        suppressClickRef.current = false
        setSelectedId(node.id)
        dragRef.current = {
          kind: 'node', engagement, nodeId: node.id, pointerId: event.pointerId,
          x: event.clientX, y: event.clientY, nodeX: node.x, nodeY: node.y, zoom: cameraRef.current.zoom,
        }
        event.currentTarget.setPointerCapture?.(event.pointerId)
      }
      const moveNodeDrag = (event) => {
        const drag = dragRef.current
        if (!drag || drag.kind !== 'node' || drag.engagement !== engagement || drag.pointerId !== event.pointerId) return
        event.stopPropagation()
        const dx = event.clientX - drag.x, dy = event.clientY - drag.y
        if (!suppressClickRef.current && Math.hypot(dx, dy) < 4) return
        suppressClickRef.current = true
        setDragging(true)
        event.preventDefault()
        moveNode(drag.nodeId, drag.nodeX + dx / drag.zoom, drag.nodeY + dy / drag.zoom)
      }
      const endDrag = (event) => {
        if (!dragRef.current || dragRef.current.pointerId !== event.pointerId) return
        dragRef.current = null
        if (event.currentTarget.releasePointerCapture) {
          try { event.currentTarget.releasePointerCapture(event.pointerId) } catch (e) { /* capture may already be released */ }
        }
        setDragging(false)
      }
      const reason = activeSnapshot && activeSnapshot.reason
      const emptyMessage = !engagement
        ? 'Hãy chọn dự án rồi xem bản đồ phiên.'
        : reason === 'no-bound-roots'
          ? 'Dự án hiện tại chưa liên kết phiên.'
          : !activeSnapshot
            ? (loading ? 'Đang đọc phiên dự án…' : 'Chưa đọc thành công phiên dự án.')
          : activeSnapshot && scoped.length === 0
            ? 'Đã đọc liên kết dự án, nhưng không tìm thấy bản ghi tương ứng trong danh sách phiên của host.'
            : null

      React.useEffect(function bindSessionMapWheel() {
        const viewport = graphViewportRef.current
        if (!viewport) return undefined
        const onWheel = (event) => {
          if (!Number.isFinite(event.deltaY) || event.deltaY === 0) return
          event.preventDefault()
          event.stopPropagation()
          const rect = viewport.getBoundingClientRect()
          const unit = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? viewport.clientHeight : 1
          const delta = Math.max(-120, Math.min(120, event.deltaY * unit))
          changeZoom(Math.exp(-delta * 0.002), {
            x: Number.isFinite(event.clientX) ? event.clientX - rect.left : viewport.clientWidth / 2,
            y: Number.isFinite(event.clientY) ? event.clientY - rect.top : viewport.clientHeight / 2,
          })
        }
        // React delegates wheel listeners as passive; a native listener is needed
        // to keep canvas zoom from also scrolling the enclosing workspace.
        viewport.addEventListener('wheel', onWheel, { passive: false })
        return () => viewport.removeEventListener('wheel', onWheel)
      }, [!emptyMessage, changeZoom])

      return h('section', { ref: mapRef, className: 'rt-session-map' + (expanded ? ' rt-session-map-expanded' : ''), 'aria-label': 'Đồ thị quan hệ phiên chỉ đọc' },
        h('div', { className: 'rt-session-map-head' },
          h('span', { className: 'rt-session-map-title' }, 'Quan hệ phiên dự án (chỉ đọc)'),
          h('span', { className: 'rt-tag rt-tag-passive' }, scoped.length + ' phiên'),
          activeSnapshot
            ? h('span', { className: 'rt-session-map-status' },
              h('span', { className: 'rt-session-map-status-dot' + (displayedStale ? ' stale' : '') }),
              pausedStale ? 'Đã tạm dừng, có thể đã lỗi thời' : paused ? 'Đã tạm dừng tự làm mới (chỉ quan sát)' : activeSnapshot.stale ? 'Đã lưu bộ đệm, có thể đã lỗi thời' : 'Đã đọc (không phải đẩy thời gian thực)')
            : h('span', { className: 'rt-session-map-status' }, loading ? 'Đang đọc…' : 'Chờ đọc'),
          h('div', { className: 'rt-spacer' }),
          h('span', { className: 'rt-session-map-subtitle' }, 'Không mở phiên, không sửa trạng thái host')),
        h('div', { className: 'rt-session-map-note' },
          'Tên, nhãn phiên con và việc cần làm lấy từ tóm tắt của host, có thể chậm; phiên chưa đặt tên được đánh số theo quan hệ cha con. Đường nối thể hiện phiên cha con, không thể hiện bàn giao nhiệm vụ. Không chạy không có nghĩa là đã xong.'),
        activeSnapshot ? h('div', { className: 'rt-session-map-stats', 'aria-label': 'Thống kê phiên của dự án hiện tại' },
          [['total', 'Phiên dự án'], ['running', 'Đang chạy'], ['idle', 'Không chạy'], ['unknown', 'Trạng thái không rõ']].map(([key, label]) =>
            h('div', { key, className: 'rt-session-map-stat', 'data-activity': key },
              h('small', null, (displayedStale && key !== 'total' ? 'Lần đọc trước · ' : '') + label), h('b', null, context.counts[key])))) : null,
        h('div', { className: 'rt-session-map-toolbar' },
          h('input', {
            className: 'rt-input rt-session-map-search',
            value: query,
            placeholder: 'Tìm tên / việc cần làm / số hiệu / thư mục làm việc',
            'aria-label': 'Tìm phiên dự án',
            onChange: (event) => setQuery(event.target.value),
          }),
          h('select', {
            className: 'rt-input rt-session-map-filter',
            value: activity,
            onChange: (event) => setActivity(event.target.value),
            'aria-label': 'Lọc trạng thái',
          },
            h('option', { value: 'all' }, 'Tất cả trạng thái'),
            h('option', { value: 'running' }, 'Đang chạy'),
            h('option', { value: 'idle' }, 'Không chạy'),
            h('option', { value: 'unknown' }, 'Không rõ')),
          h('button', {
            className: 'rt-btn rt-session-map-button',
            onClick: () => changeZoom(1 / 1.25),
            title: 'Thu nhỏ đồ thị quan hệ',
          }, '−'),
          h('button', {
            className: 'rt-btn rt-session-map-button',
            onClick: () => changeZoom(1.25),
            title: 'Phóng to đồ thị quan hệ',
          }, '+'),
          h('button', { className: 'rt-btn rt-session-map-button', onClick: () => fit() }, 'Vừa khung'),
          h('button', { className: 'rt-btn rt-session-map-button', onClick: () => fit('readable') }, 'Định vị mục chọn'),
          h('button', {
            className: 'rt-btn rt-session-map-button', disabled: !localPositions || !localPositions.size,
            onClick: () => {
              setNodePositions((current) => { const layouts = new Map(current); layouts.delete(engagement); return layouts })
              fit('all', autoGraph)
            },
            title: 'Khôi phục tự sắp xếp của dự án hiện tại, không thay đổi phiên nào',
          }, 'Đặt lại bố cục'),
          h('span', { className: 'rt-session-map-zoom', 'aria-label': 'Tỷ lệ thu phóng bản đồ' }, Math.round(zoom * 100) + '%'),
          h('button', { className: 'rt-btn rt-session-map-button', onClick: toggleFullscreen, 'aria-pressed': expanded }, expanded ? 'Thoát toàn màn hình' : 'Bản đồ toàn màn hình'),
          h('button', {
            className: 'rt-btn rt-session-map-button',
            onClick: () => setPaused((value) => {
              const next = !value
              setPausedAt(next ? Date.now() : null)
              setClock(Date.now())
              return next
            }),
            title: 'Chỉ tạm dừng làm mới quan sát, không ảnh hưởng phiên hay nhiệm vụ nào',
          }, paused ? 'Tiếp tục tự làm mới' : 'Tạm dừng tự làm mới'),
          h('button', {
            className: 'rt-btn rt-session-map-button',
            disabled: loading || !engagement,
            onClick: () => read(),
          }, loading ? 'Đang đọc…' : 'Làm mới thủ công')),
        error || (activeSnapshot && activeSnapshot.error)
          ? h('div', { className: 'rt-session-map-alert' },
            (activeSnapshot ? 'Đọc thất bại, giữ ảnh chụp lần trước; sẽ không tuyên bố đang trực tuyến: ' : 'Đọc thất bại, chưa có ảnh chụp thành công; sẽ không tuyên bố đang trực tuyến: ')
              + (error || activeSnapshot.error))
          : pausedStale
            ? h('div', { className: 'rt-session-map-alert' }, 'Tự làm mới đã tạm dừng hơn 60 giây; ảnh chụp hiện tại có thể đã lỗi thời.')
          : null,
        emptyMessage
          ? h('div', { className: 'rt-session-map-empty' }, emptyMessage)
          : h('div', { className: 'rt-session-map-layout' },
            h('div', {
              className: 'rt-session-map-graph-pane', ref: graphViewportRef,
              'data-dragging': dragging ? 'true' : 'false',
              tabIndex: 0, 'aria-label': 'Khung vẽ bản đồ phiên, cuộn chuột để thu phóng, kéo để dịch, phím mũi tên để di chuyển',
              onPointerDown: (event) => {
                if (event.button !== 0) return
                suppressClickRef.current = false
                dragRef.current = { kind: 'canvas', pointerId: event.pointerId, x: event.clientX, y: event.clientY, panX: pan.x, panY: pan.y }
              },
              onPointerMove: (event) => {
                const drag = dragRef.current
                if (!drag || drag.kind !== 'canvas' || drag.pointerId !== event.pointerId) return
                const dx = event.clientX - drag.x, dy = event.clientY - drag.y
                if (!suppressClickRef.current && Math.hypot(dx, dy) < 4) return
                if (!suppressClickRef.current && event.currentTarget.setPointerCapture) event.currentTarget.setPointerCapture(event.pointerId)
                suppressClickRef.current = true
                setDragging(true)
                event.preventDefault()
                setPan({ x: drag.panX + dx, y: drag.panY + dy })
              },
              onPointerUp: endDrag, onPointerCancel: endDrag, onLostPointerCapture: endDrag,
              onKeyDown: (event) => {
                if (event.target !== event.currentTarget) return
                const delta = { ArrowLeft: [50, 0], ArrowRight: [-50, 0], ArrowUp: [0, 50], ArrowDown: [0, -50] }[event.key]
                if (!delta) return
                event.preventDefault()
                setPan((value) => ({ x: value.x + delta[0], y: value.y + delta[1] }))
              },
            },
              h('svg', {
                className: 'rt-session-map-graph',
                width: '100%', height: '100%',
                role: 'group',
                'aria-label': 'Đồ thị quan hệ cha con của phiên',
              }, h('g', { className: 'rt-session-map-camera', transform: 'translate(' + pan.x + ',' + pan.y + ') scale(' + zoom + ')' },
                graph.edges.flatMap((edge) => {
                  const key = edge.from + '>' + edge.to
                  const path = sessionMapEdgePath(edge)
                  const running = liveSessionIds.has(edge.to)
                  return [h('path', {
                    key,
                    className: 'rt-session-map-edge' + (edge.orphan ? ' orphan' : '') + (running ? ' is-running' : ''),
                    d: path,
                  }), running ? ['halo', 'point'].map((layer) => h('path', {
                    key: key + ':flow-' + layer,
                    className: 'rt-session-map-flow rt-session-map-flow-' + layer,
                    d: path, pathLength: 100,
                    'data-to': edge.to, 'aria-hidden': 'true',
                  })) : null]
                }),
                graph.nodes.map((node) => {
                  const nodeStatus = sessionMapActivityClass(node.activity)
                  const selectedClass = node.id === selectedId ? ' selected' : ''
                  const orphanClass = node.orphan ? ' orphan' : ''
                  const stageClass = (id) => {
                    const entry = stages && stages[id]
                    if (!entry || typeof entry.tone !== 'string' || entry.tone === '') return ''
                    return ' is-' + entry.tone
                  }
                  return h('g', {
                    key: node.id,
                    className: 'rt-session-map-node' + selectedClass + orphanClass + stageClass(node.id),
                    transform: 'translate(' + node.x + ',' + node.y + ')',
                    role: 'button',
                    tabIndex: 0,
                    'aria-pressed': node.id === selectedId ? 'true' : 'false',
                    'aria-label': sessionMapDisplayName(node) + ', ' + sessionMapActivityLabel(node.activity),
                    'aria-description': 'Kéo để di chuyển node, phím mũi tên để chỉnh vị trí, Shift + phím mũi tên để di chuyển nhanh',
                    onPointerDown: (event) => startNodeDrag(event, node),
                    onPointerMove: moveNodeDrag,
                    onPointerUp: endDrag, onPointerCancel: endDrag, onLostPointerCapture: endDrag,
                    onClick: () => { if (!suppressClickRef.current) setSelectedId(node.id) },
                    onKeyDown: (event) => {
                      const step = event.shiftKey ? 50 : 10
                      const delta = { ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, -step], ArrowDown: [0, step] }[event.key]
                      if (delta) {
                        event.preventDefault()
                        event.stopPropagation()
                        setSelectedId(node.id)
                        moveNode(node.id, node.x + delta[0], node.y + delta[1])
                        return
                      }
                      if (event.key === 'Enter' || event.key === ' ') {
                        event.preventDefault()
                        setSelectedId(node.id)
                      }
                    },
                  },
                    h('rect', { width: SESSION_MAP_NODE_WIDTH, height: SESSION_MAP_NODE_HEIGHT, rx: 10 }),
                    liveSessionIds.has(node.id) ? h('circle', {
                      className: 'rt-session-map-live-ring', cx: 15, cy: 18, r: 8, 'aria-hidden': 'true',
                    }) : null,
                    h('circle', { className: 'rt-session-map-node-dot ' + nodeStatus, cx: 15, cy: 18, r: 4 }),
                    h('title', null, sessionMapDisplayName(node) + '\nSố hiệu phiên: ' + node.id),
                    h('text', { className: 'rt-session-map-node-id', x: 27, y: 22 }, sessionMapNodeLabel(sessionMapDisplayName(node))),
                    h('text', { className: 'rt-session-map-node-meta', x: 14, y: 46 },
                      (displayedStale ? 'Lần trước: ' : '') + sessionMapActivityLabel(node.activity) + (node.declaredRole ? ' · ' + SESSION_MAP_ROLE_NAMES[node.declaredRole] : '')),
                    h('text', { className: 'rt-session-map-node-task', x: 14, y: 69 },
                      sessionMapNodeLabel(node.currentTask ? 'Việc cần làm: ' + node.currentTask : node.taskProgress ? 'Việc cần làm ' + node.taskProgress.completed + '/' + node.taskProgress.total + ' đã xong' : node.subagentTiming ? 'Đã ghi hoạt động ' + sessionMapDuration(node.subagentTiming.settledMs) : 'Chưa cung cấp chi tiết việc cần làm')),
                    stages && stages[node.id]
                      ? h('text', { className: 'rt-session-map-node-stage is-' + stages[node.id].tone, x: 14, y: 94 },
                        sessionMapNodeLabel(stages[node.id].label + (stages[node.id].taskSubject ? ' · ' + stages[node.id].taskSubject : '')))
                      : h('text', { className: 'rt-session-map-node-foot', x: 14, y: 94 },
                        (node.orphan ? 'Thiếu phiên cha' : node.subagentMode ? sessionMapModeLabel(node.subagentMode) : node.parentId ? 'Phiên con' : 'Phiên gốc') + ' · cấp dưới ' + (context.childCounts.get(node.id) || 0) + ' phiên'))
                })))),
            h('aside', { className: 'rt-session-map-detail', 'aria-label': 'Chi tiết phiên được chọn' },
              selected
                ? h(React.Fragment, null,
                  h('header', { className: 'rt-session-map-detail-heading' },
                    h('small', null, selected.declaredRole ? SESSION_MAP_ROLE_NAMES[selected.declaredRole] : selected.parentId ? 'Phiên con' : 'Phiên gốc'),
                    h('div', { className: 'rt-session-map-detail-title', title: selectedName }, selectedName),
                    h('div', { className: 'rt-session-map-detail-status' },
                      h('span', { className: 'rt-session-map-node-dot ' + statusClass, style: { width: 7, height: 7, borderRadius: '50%' } }),
                      sessionMapActivityLabel(selected.activity),
                      selected.orphan ? ' · quan hệ thiếu node cha' : ''),
                    h('small', { className: 'rt-session-map-detail-updated', title: 'Thời gian trong danh mục host lấy giá trị lớn hơn giữa thời điểm tạo và thời điểm tin nhắn nhắc gần nhất, không thể hiện thời điểm đổi trạng thái chạy' }, 'Thời gian trong danh mục host: ' + sessionMapTime(selected.updatedAt))),
                  h('p', { className: 'rt-session-map-status-explainer' },
                    (displayedStale ? 'Đang hiển thị ảnh chụp đọc lần trước, có thể đã lỗi thời.' : '') + (selected.activity === 'running' ? 'Host báo hiện đang chạy; các bước cụ thể lấy theo bản ghi việc cần làm.'
                      : selected.activity === 'idle' ? 'Host báo hiện không chạy, chưa cung cấp kết quả thành công, thất bại hay hủy.'
                      : 'Host chưa cung cấp dấu hiệu chạy hợp lệ, không xác nhận được trạng thái hiện tại.')),
                  selectedMode || selectedTiming || selectedCatalog || typeof selected.agentAvailable === 'boolean' ? h('section', { className: 'rt-session-map-detail-section', 'aria-label': 'Thông tin thực thi' },
                    h('h4', null, 'Thông tin thực thi'),
                    h('div', { className: 'rt-session-map-execution-grid' },
                      selectedMode ? h('div', null, h('span', null, 'Chế độ phiên'), h('b', null, sessionMapModeLabel(selectedMode))) : null,
                      typeof selected.agentAvailable === 'boolean' ? h('div', null, h('span', null, 'Tác nhân của host'), h('b', null, selected.agentAvailable ? 'Sẵn dùng' : 'Không giữ tác nhân hoạt động')) : null,
                      selectedCatalog ? h('div', null, h('span', null, 'Tạo phiên con'), h('b', null, sessionMapTime(selectedCatalog.createdAt))) : null,
                      selectedTiming ? h('div', null, h('span', null, 'Đã kết thúc hoạt động vòng'), h('b', null, sessionMapDuration(selectedTiming.settledMs))) : null,
                      selectedTiming && selectedTiming.active ? h('div', null, h('span', null, 'Vòng này đã ghi hoạt động'), h('b', null, sessionMapDuration(selectedTiming.active.through - selectedTiming.active.since))) : null,
                      selectedTiming && typeof selectedTiming.lastTurnCompleted === 'boolean' ? h('div', null, h('span', null, 'Vòng đóng gần nhất'), h('b', null, selectedTiming.lastTurnCompleted ? 'Kết thúc bình thường' : 'Không đánh dấu hoàn thành bình thường')) : null),
                    selectedTiming ? h('p', { className: 'rt-session-map-subtitle' }, 'Thời lượng hoạt động cộng dồn theo sự kiện của host; vòng kết thúc không có nghĩa nhiệm vụ đã thành công.' + (selectedTiming.active ? 'Thời lượng vòng này tính đến ' + sessionMapTime(selectedTiming.active.through) + ', không phải đồng hồ chạy liên tục.' : '')) : null) : null,
                  h('section', { className: 'rt-session-map-detail-section', 'aria-label': 'Nhiệm vụ và việc cần làm' },
                    h('h4', null, 'Nhiệm vụ và việc cần làm', selectedProgress ? h('small', null, selectedProgress.completed + ' / ' + selectedProgress.total + ' đã xong') : null),
                    selected.currentTask ? h('p', { className: 'rt-session-map-task-summary' }, 'Đang làm: ' + selected.currentTask) : null,
                    selectedProgress && selectedProgress.total > 0 ? h('div', {
                      className: 'rt-session-map-task-progress', role: 'progressbar', 'aria-label': 'Tỷ lệ hoàn thành việc cần làm của host',
                      'aria-valuemin': 0, 'aria-valuemax': 100, 'aria-valuenow': Math.round(selectedProgress.completed / selectedProgress.total * 100),
                    }, h('i', { style: { width: (selectedProgress.completed / selectedProgress.total * 100) + '%' } })) : null,
                    selectedTodos && selectedTodos.length ? h('ol', { className: 'rt-session-map-todos' }, selectedTodos.map((todo, index) =>
                      h('li', { key: index, className: 'rt-session-map-todo', 'data-status': todo.status },
                        h('span', { className: 'rt-session-map-todo-state' }, todo.status === 'completed' ? 'Đã xong' : todo.status === 'in_progress' ? 'Đang làm' : 'Chờ xử lý'),
                        h('span', { className: 'rt-session-map-todo-content' }, todo.content),
                        todo.truncated ? h('small', { className: 'rt-session-map-clipped' }, 'Nội dung vượt giới hạn hiển thị 500 từ') : null)))
                      : h('div', { className: 'rt-session-map-empty-info' }, selectedTodos ? 'Danh sách việc cần làm host cung cấp đang trống.' : 'Host chưa cung cấp danh sách việc cần làm, không xác định được bước cụ thể và tình trạng hoàn thành.'),
                    selectedTodos && selectedTodos.length ? h('p', { className: 'rt-session-map-subtitle' }, 'Việc cần làm lấy từ tóm tắt của host, có thể chậm; hoàn thành việc cần làm không có nghĩa phiên chạy thành công.') : null),
                  h('section', { className: 'rt-session-map-detail-section', 'aria-label': 'Quan hệ phiên cha con' },
                    h('h4', null, 'Quan hệ phiên', h('small', null, context.children.length + ' phiên con trực tiếp')),
                    context.ancestors.length ? h('nav', { className: 'rt-session-map-lineage', 'aria-label': 'Đường dẫn cấp trên của phiên' },
                      context.ancestors.map((ancestor) => h('button', { key: ancestor.id, type: 'button', className: 'rt-session-map-ancestor', title: sessionMapDisplayName(ancestor), onClick: () => setSelectedId(ancestor.id) }, sessionMapDisplayName(ancestor)))) : null,
                    h('div', { className: 'rt-session-map-relations' },
                      context.parent ? h('button', { type: 'button', className: 'rt-session-map-relation', 'data-session-id': context.parent.id, onClick: () => setSelectedId(context.parent.id) },
                        h('span', null, 'Phiên cha'), h('strong', null, sessionMapDisplayName(context.parent)), h('small', null, sessionMapActivityLabel(context.parent.activity)))
                        : h('div', { className: 'rt-session-map-empty-info' }, selected.parentId ? 'Bản ghi phiên cha thiếu hoặc không thuộc phạm vi dự án hiện tại.' : 'Phiên hiện tại là phiên gốc, không có phiên cha.'),
                      context.children.map((child) => h('button', { key: child.id, type: 'button', className: 'rt-session-map-relation', 'data-session-id': child.id, onClick: () => setSelectedId(child.id) },
                        h('span', null, 'Phiên con'), h('strong', null, sessionMapDisplayName(child)), h('small', null, sessionMapActivityLabel(child.activity)))),
                      context.children.length ? null : h('div', { className: 'rt-session-map-empty-info' }, 'Ảnh chụp hiện tại không có phiên con trực tiếp.')),
                    h('p', { className: 'rt-session-map-subtitle' }, 'Bấm chỉ chuyển chi tiết trong bản đồ. Quan hệ cha con không thể hiện bàn giao nhiệm vụ, host chưa cung cấp bản ghi bàn giao.')),
                  h('details', { className: 'rt-session-map-metadata' },
                    h('summary', null, 'Hồ sơ phiên đầy đủ và nguồn'),
                    h('dl', { className: 'rt-session-map-detail-grid' },
                      h('dt', null, 'Nguồn tên'), h('dd', null, selected.subagentLabel ? 'Tên phiên con do host đặt' : selected.labelSource === 'title' ? 'Tiêu đề phiên do host đặt' : 'Host chưa đặt tên, đánh số theo quan hệ'),
                      h('dt', null, 'Tiêu đề phiên'), h('dd', { className: 'rt-session-map-detail-name' }, selectedName),
                      selected.subagentLabel && selected.subagentLabel !== selected.label ? h(React.Fragment, null,
                        h('dt', null, 'Tóm tắt tiêu đề do host đặt'), h('dd', { className: 'rt-session-map-detail-name' }, selected.label)) : null,
                      h('dt', null, 'Nguồn tóm tắt'), h('dd', null, selected.projectionKind === 'cached' ? 'Bộ đệm của host (có thể chậm)' : selected.projectionKind === 'sequenced' ? 'Tóm tắt chuỗi sự kiện của host' : 'Host chưa cung cấp độ tươi của tóm tắt'),
                      selected.subagentLabel ? h(React.Fragment, null, h('dt', null, 'Tên phiên con'), h('dd', { className: 'rt-session-map-detail-name' }, selected.subagentLabel)) : null,
                      selected.originalLabel ? h(React.Fragment, null, h('dt', null, 'Tiêu đề gốc'), h('dd', { className: 'rt-session-map-detail-name' }, selected.originalLabel)) : null,
                      h('dt', null, 'Số hiệu phiên'), h('dd', { className: 'rt-mono' }, selected.id),
                      h('dt', null, 'Phiên cha'), h('dd', null, context.parent ? sessionMapDisplayName(context.parent) : selected.parentId ? (selected.orphan ? 'Thiếu bản ghi phiên cha' : 'Không thuộc phạm vi dự án hiện tại') : 'Không có (phiên gốc)'),
                      h('dt', null, 'Thư mục làm việc'), h('dd', null, selected.cwd || SESSION_MAP_UNKNOWN),
                      selected.formatStatus ? h(React.Fragment, null, h('dt', null, 'Định dạng phiên'), h('dd', null, selected.formatStatus === 'current' ? 'Định dạng hiện tại' : 'Cần di trú')) : null,
                      selected.origin ? h(React.Fragment, null, h('dt', null, 'Nguồn phiên'), h('dd', null, 'Phiên con của host')) : null,
                      h('dt', null, 'Thời điểm ghi nhận'), h('dd', null, sessionMapTime(selected.updatedAt)),
                      h('dt', null, 'Căn cứ trạng thái chạy'), h('dd', null, selected.activity === 'running' ? 'session/list · running=true' : selected.activity === 'idle' ? 'session/list · running=false' : 'Host không trả về dấu hiệu chạy hợp lệ'),
                      h('dt', null, 'Việc cần làm đang tiến hành'), h('dd', { className: selected.currentTask ? '' : 'rt-session-map-detail-unknown' }, selected.currentTask || SESSION_MAP_UNKNOWN),
                      h('dt', null, 'Tiến độ việc cần làm'), h('dd', { className: selectedProgress ? '' : 'rt-session-map-detail-unknown' }, selectedProgress ? selectedProgress.completed + ' / ' + selectedProgress.total + ' mục đã xong (bản ghi việc cần làm của host)' : SESSION_MAP_UNKNOWN),
                      h('dt', null, 'Bàn giao'), h('dd', { className: 'rt-session-map-detail-unknown' }, SESSION_MAP_UNKNOWN))),
                  !selectedVisible
                    ? h('div', { className: 'rt-session-map-subtitle', style: { marginTop: 12 } }, 'Node hiện tại bị tìm kiếm/lọc trạng thái ẩn đi, vẫn giữ chi tiết.')
                    : null)
                : h('div', { className: 'rt-session-map-empty', style: { padding: '30px 4px' } },
                  filtered.sessions.length ? 'Chọn một node để xem chi tiết.' : 'Bộ lọc hiện tại không có node khớp.'))),
        h('div', { className: 'rt-session-map-foot' },
          h('span', null, 'Thời điểm quan sát cục bộ: ' + (activeSnapshot ? sessionMapTime(activeSnapshot.sourceObservedAt) : SESSION_MAP_UNKNOWN)),
          h('span', null, 'Thời điểm metadata của host: ' + (activeSnapshot ? sessionMapTime(activeSnapshot.sourceUpdatedAt) : SESSION_MAP_UNKNOWN)),
          h('span', null, 'Cuộn chuột để thu phóng · kéo node để chỉnh vị trí, kéo vùng trống để dịch · phím mũi tên chỉnh node · Esc thoát toàn màn hình'),
          h('span', null, 'Điểm sáng và vòng sáng thể hiện đang chạy; đường nối chỉ thể hiện quan hệ cha con. Quan sát chỉ đọc; các thẻ song song hiện có vẫn dùng cách đếm cũ, có thể khác bản đồ này.')))
    }
    /* __RT_SESSION_MAP_COMPONENT_END__ */

    /* ---------------------------------------------------------- error boundary */
    /**
     * A failing tab degrades only itself, never the whole panel: panel and sidebar buttons stay usable,
     * and one click returns to asset mapping. (The panel used to vanish entirely with no working buttons.)
     */
    class RtBoundary extends React.Component {
      constructor(props) {
        super(props)
        this.state = { error: null }
      }
      static getDerivedStateFromError(error) {
        return { error: error }
      }
      componentDidCatch(error) {
        try { console.error('[redteam-ui] Lỗi kết xuất trang: ', error) } catch (e) { /* ignore */ }
      }
      render() {
        if (this.state.error) {
          const msg = this.state.error && this.state.error.message ? this.state.error.message : String(this.state.error)
          return h('div', { className: 'rt-pane' },
            h('div', { className: 'rt-err' }, 'Trang này kết xuất bị lỗi: ' + msg),
            h('button', {
              className: 'rt-btn',
              onClick: () => { this.setState({ error: null }); setUI({ tab: 'assets' }) },
            }, 'Quay lại trinh sát tài sản'))
        }
        return this.props.children
      }
    }

    /**
     * Agent tab: concurrency slots (3 at most) + six roles and their prompts.
     * The main session checks slots here before dispatching; the user sees how many agents can start.
     */
    function AgentsTab(props) {
      const eng = props.engagement
      const refreshKey = props.refreshKey || 0
      const [roles, setRoles] = React.useState(null)
      const [err, setErr] = React.useState(null)
      const [concurrency, setConcurrency] = React.useState(null)
      const [busy, setBusy] = React.useState(false)

      const load = () => {
        setBusy(true)
        api({ op: eng ? 'prompts' : 'bootstrap', engagement: eng || undefined }).then((r) => {
          setBusy(false)
          if (!r || r.ok === false) { setErr((r && r.error) || 'Đọc thất bại'); return }
          setErr(null)
          if (r.roles) setRoles(r.roles)
        }, (e) => { setBusy(false); setErr(String((e && e.message) || e)) })
        /* Slots count currently running sub-agents; the host reads the subagents registry */
        api({ op: 'agentsStatus' }).then((r) => {
          if (r && r.ok !== false) setConcurrency(r)
        }, () => {})
      }
      React.useEffect(load, [eng, refreshKey])

      const used = concurrency ? concurrency.used : null
      const max = concurrency ? concurrency.max : 3
      const roleCards = [
        { no: '01', title: 'Thu thập thông tin', code: 'recon', description: 'Chỉ thu thập tài sản, thu thập đầy đủ tài sản của đơn vị (gồm tài sản biên và chưa đăng ký)' },
        { no: '02', title: 'Rà soát tài sản', code: 'assess', description: 'Đi từng cái một, đánh giá độ dễ tấn công và lưu hết vào kho' },
        { no: '03', title: 'Phát hiện lỗ hổng', code: 'vuln-scan', description: 'Tra kho để loại trùng trước → ưu tiên Nday/1day → thăm dò API chưa được cấp quyền' },
        { no: '04', title: 'Khai thác lỗ hổng', code: 'exploit', description: 'Lấy quyền máy chủ trước (mèo Behinder/Godzilla) + dựng đường hầm suo5, rồi đánh các mục tính điểm khác' },
        { no: '05', title: 'Xâm nhập mạng nội bộ', code: 'internal', description: 'Đi qua đường hầm, lần lượt kéo ①②③④ làm nội bộ' },
        { no: '06', title: 'Phiên chính', code: 'plan', description: 'Chỉ lập kế hoạch, giao việc, tổng hợp, báo cáo, không tự làm' },
      ]
      return h('div', { className: 'rt-main rt-collab-page' },
        h('div', { className: 'rt-toolbar rt-collab-toolbar' },
          h('span', { className: 'rt-collab-toolbar-label', style: { fontWeight: 600 } }, 'Tác nhân tác chiến'),
          h('span', { className: 'rt-tag rt-tag-passive' }, 'Giới hạn song song ' + max),
          used === null
            ? h('span', { className: 'rt-tag' }, 'Không rõ mức chiếm dụng')
            : h('span', { className: 'rt-tag' + (used >= max ? ' rt-tag-warn' : ' rt-tag-live') }, 'Đang chạy ' + used + ' / còn lại ' + Math.max(max - used, 0)),
          concurrency && concurrency.parked > 0
            ? h('span', { className: 'rt-tag rt-tag-warn', title: (concurrency.parked_labels || []).join(', ') }, 'Chờ tài nguyên ' + concurrency.parked)
            : null,
          h('div', { className: 'rt-spacer' }),
          h('button', { className: 'rt-btn', disabled: busy, onClick: load }, busy ? 'Đang đọc…' : 'Làm mới')),
        h('div', { className: 'rt-pane rt-collab-pane' },
          h('header', { className: 'rt-collab-hero' },
            h('div', { className: 'rt-collab-eyebrow' }, 'Không gian cộng tác / tác nhân'),
            h('h1', { className: 'rt-collab-title' }, 'Cộng tác tác nhân'),
            h('p', { className: 'rt-collab-description' }, 'Xem phạm vi phiên chỉ đọc và cấu hình cộng tác của dự án hiện tại; không giao việc ở trang này, không sửa phiên của host.')),
          h('section', { className: 'rt-collab-section rt-collab-scope', 'aria-labelledby': 'rt-collab-scope-title' },
            h('div', { className: 'rt-collab-section-head' },
              h('div', null,
                h('h2', { id: 'rt-collab-scope-title' }, 'Phiên của dự án hiện tại'),
                h('p', null, 'Chỉ đọc quan sát phiên host mà dự án hiện tại liên kết; trạng thái chạy làm mới mỗi 5 giây.')),
              h('span', { className: 'rt-collab-readonly-badge' }, 'Quan sát chỉ đọc')),
            h(SessionMap, { engagement: eng, refreshKey: refreshKey })),
          err ? h('div', { className: 'rt-err' }, err) : null,
          h('details', { className: 'rt-collab-config', open: true },
            h('summary', { className: 'rt-collab-config-summary' },
              h('span', { className: 'rt-collab-config-summary-icon', 'aria-hidden': 'true' }, '⚙'),
              h('span', null,
                h('strong', null, 'Cấu hình cộng tác'),
                h('small', null, 'Quy tắc song song, mô tả vai trò và prompt')),
              h('span', { className: 'rt-collab-config-summary-state' }, 'Mặc định mở rộng')),
            h('div', { className: 'rt-collab-config-body' },
              h('section', { className: 'rt-collab-card rt-collab-concurrency', 'aria-labelledby': 'rt-collab-concurrency-title' },
                h('div', { className: 'rt-collab-card-heading' },
                  h('div', null,
                    h('h3', { id: 'rt-collab-concurrency-title' }, 'Quy tắc song song (ràng buộc cứng)'),
                    h('p', null, 'Giới hạn thực thi và ràng buộc giao việc giữ nguyên nguyên tắc cũ.')),
                  h('span', { className: 'rt-collab-config-badge' }, 'Cấu hình vận hành')),
                h('div', { className: 'rt-collab-rule-copy' },
                  '· Cùng một mục tiêu **tối đa đồng thời ' + max + ' tác nhân thực thi**; phiên chính dùng `redteam_agent_slot` giữ chỗ trước khi giao việc, đầy thì từ chối thẳng.',
                  h('br'),
                  '· **Mặc định giao từng cái một, đẩy theo thứ tự**; chỉ những việc thực sự không phụ thuộc nhau mới chạy song song.',
                  h('br'),
                  '· Mỗi phiên có **liên kết mục tiêu riêng**: nhiều phiên song song sẽ không ghi lẫn báo cáo (tác nhân con kế thừa mục tiêu của phiên cha).')),
              h('section', { className: 'rt-collab-card rt-collab-role-section', 'aria-labelledby': 'rt-collab-roles-title' },
                h('div', { className: 'rt-collab-card-heading' },
                  h('div', null,
                    h('h3', { id: 'rt-collab-roles-title' }, 'Sáu vai trò'),
                    h('p', null, 'Dưới đây là mô tả trách nhiệm của các vai trò đã cấu hình, không có nghĩa phiên hiện tại đang chạy các vai trò này.')),
                  h('span', { className: 'rt-collab-config-badge' }, 'Mô tả cấu hình')),
                h('div', { className: 'rt-collab-role-grid' }, roleCards.map((role) =>
                  h('article', { key: role.code, className: 'rt-collab-role-card' },
                    h('div', { className: 'rt-collab-role-card-head' },
                      h('span', { className: 'rt-collab-role-no' }, role.no),
                      h('div', null,
                        h('h4', null, role.title),
                        h('code', null, role.code))),
                    h('p', null, role.description))))),
              h('section', { className: 'rt-collab-card rt-collab-concurrency-editor', 'aria-labelledby': 'rt-collab-concurrency-editor-title' },
                h('div', { className: 'rt-collab-card-heading' },
                  h('div', null,
                    h('h3', { id: 'rt-collab-concurrency-editor-title' }, 'Sửa giới hạn thực thi'),
                    h('p', null, 'Sửa giới hạn tác nhân thực thi đang có hiệu lực; lưu xong có hiệu lực ngay.')),
                  h('span', { className: 'rt-collab-config-badge' }, 'Có thể sửa')),
                h(ConcurrencyCard, { concurrency, onSaved: load })),
              h('section', { className: 'rt-collab-card rt-collab-prompts', 'aria-labelledby': 'rt-collab-prompts-title' },
                h('div', { className: 'rt-collab-card-heading' },
                  h('div', null,
                    h('h3', { id: 'rt-collab-prompts-title' }, 'Prompt vai trò (lưu theo mục tiêu, sửa được ở đây)'),
                    h('p', null, '"Prompt tác nhân" đã gộp vào trang này; dưới đây là trình soạn đầy đủ (sửa xong bấm lưu, chỉ ảnh hưởng mục tiêu hiện tại).')),
                  h('span', { className: 'rt-collab-config-badge' }, 'Có thể sửa')),
                h(PromptsTab, { engagement: eng, refreshKey: refreshKey }))))))
    }

    function ConcurrencyCard(props) {
      const info = props.concurrency || {}
      const [draft, setDraft] = React.useState('')
      const [busy, setBusy] = React.useState(false)
      const [msg, setMsg] = React.useState(null)
      React.useEffect(() => { if (info.max) setDraft(String(info.max)) }, [info.max])

      const limit = info.limit || 10
      const used = typeof info.used === 'number' ? info.used : null
      const source = info.source === 'settings' ? 'Đặt trong bảng điều khiển'
        : info.source === 'env' ? 'Biến môi trường REDTEAM_MAX_AGENTS' : 'Giá trị mặc định'
      const n = Number(draft)
      const invalid = !Number.isFinite(n) || Math.floor(n) !== n || n < 1 || n > limit
      const save = () => {
        if (invalid) return
        setBusy(true); setMsg(null)
        api({ op: 'setAgentsMax', max: n }).then((r) => {
          setBusy(false)
          if (!r || r.ok === false) { setMsg({ err: (r && r.error) || 'Lưu thất bại' }); return }
          setMsg({ ok: 'Đã lưu: giới hạn song song ' + r.max + '(có hiệu lực ngay, không cần khởi động lại)' })
          if (props.onSaved) props.onSaved()
        }, (e) => { setBusy(false); setMsg({ err: String((e && e.message) || e) }) })
      }
      return h('div', { className: 'rt-card' },
        h('h4', null, 'Số lượng song song'),
        h('div', { className: 'rt-concurrency-summary' },
          'Cùng một mục tiêu',
          h('strong', null, 'Tối đa bao nhiêu tác nhân thực thi cùng lúc'),
          '. Hiện có hiệu lực: ',
          h('strong', null, info.max || '?'),
          used === null ? '' : '(đang chạy ' + used + ', còn lại ' + Math.max((info.max || 0) - used, 0) + ')',
          ', nguồn: ' + source + '. Sửa xong',
          h('strong', null, 'có hiệu lực ngay'),
          ', không cần khởi động lại.'),
        h('div', { style: { display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' } },
          h('input', {
            className: 'rt-input', style: { width: 90 }, type: 'number', min: 1, max: limit,
            value: draft, onChange: (e) => setDraft(e.target.value),
          }),
          h('span', { style: { fontSize: 'var(--ui-text-helper)', color: 'var(--dsw-alias-label-secondary)' } }, 'Phạm vi 1 – ' + limit),
          h('button', { className: 'rt-btn rt-btn-primary', disabled: busy || invalid, onClick: save },
            busy ? 'Đang lưu…' : 'Lưu'),
          msg && msg.err ? h('span', { style: { fontSize: 'var(--ui-text-helper)', color: 'var(--rt-danger, #d33)' } }, msg.err) : null,
          msg && msg.ok ? h('span', { style: { fontSize: 'var(--ui-text-helper)', color: 'var(--dsw-alias-label-secondary)' } }, msg.ok) : null),
        h('aside', {
          className: 'rt-concurrency-warning', role: 'note',
          'aria-labelledby': 'rt-concurrency-warning-title',
        },
          h('div', { className: 'rt-concurrency-warning-head' },
            h('span', { className: 'rt-concurrency-warning-icon', 'aria-hidden': 'true' }, '!'),
            h('strong', { id: 'rt-concurrency-warning-title' }, 'Song song và giới hạn tốc độ')),
          h('p', null,
            h('strong', null, 'Tăng không có nghĩa là nhanh hơn: '),
            h('strong', null, 'giới hạn song song/tốc độ của cùng một API Key mô hình là chia sẻ chung'),
            ', giao quá nhiều cùng lúc sẽ tranh chấp nhau, biểu hiện là xếp hàng chờ, quá thời gian, phản hồi bị cắt thậm chí báo lỗi giới hạn tốc độ — ngược lại làm kết quả kiểm thử không ổn định (sót kiểm thử, bỏ dở).'),
          h('p', null,
            h('strong', null, 'Nên bắt đầu từ 2–3,'),
            'chỉ tăng lên khi đã xác nhận hạn mức của Key đủ và các nhiệm vụ thực sự không phụ thuộc nhau.')))
    }

    /** Display only the installed package version through the local status route. */
    function VersionBar(props) {
      const [version, setVersion] = React.useState('')
      React.useEffect(() => {
        let alive = true
        const controller = new AbortController()
        const timer = window.setTimeout(() => controller.abort(), 6000)
        fetch('/de-policy/status', { method: 'GET', signal: controller.signal })
          .then((response) => response.ok ? response.json() : null)
          .then((status) => {
            if (alive && status && status.ok === true && typeof status.plugin_version === 'string') {
              setVersion(status.plugin_version.trim())
            }
          }, () => {})
          .finally(() => window.clearTimeout(timer))
        return () => { alive = false; controller.abort(); window.clearTimeout(timer) }
      }, [])
      return h('span', { className: 'rt-tag', title: 'Phiên bản package.json của gói cài hiện tại', 'aria-label': 'Phiên bản plugin hiện tại' }, version ? 'v' + version : '—')
    }

    /* ---------------------------------------------------------- resident panel body */
    /**
     * "Unread" state: recorded per target in localStorage, asking the host's consoleDigest every 25 seconds
     * (row count + last update per tab). Newer than the locally remembered snapshot → red dot on that tab;
     * opening the tab records the current values as read and the dot clears.
     */
    const UNREAD_KEY = 'rt-unread:'
    const loadUnread = (eng) => {
      try {
        const raw = window.localStorage.getItem(UNREAD_KEY + eng)
        const parsed = raw ? JSON.parse(raw) : null
        return parsed && typeof parsed === 'object' ? parsed : null
      } catch (e) { return null }
    }
    const saveUnread = (eng, value) => {
      try { window.localStorage.setItem(UNREAD_KEY + eng, JSON.stringify(value)) } catch (e) { /* privacy mode and similar: works without persistence too */ }
    }
    /** Whether this tab has new content since last viewed (more rows, or a newer latest row). */
    const digestHasNew = (prev, cur) => {
      if (!cur) return false
      if (!prev) return true
      const pc = Number(prev.count || 0)
      const cc = Number(cur.count || 0)
      if (cc > pc) return true
      const pa = prev.at || ''
      const ca = cur.at || ''
      return ca !== '' && ca !== pa && ca > pa
    }

    const RT_GEOM_KEY = 'rt-dock-geom-v1'
    function desktopChromeTop() {
      try {
        const cs = getComputedStyle(document.documentElement)
        const raw = cs.getPropertyValue('--dsh-frame-chrome-top')
          || cs.getPropertyValue('--dsh-frame-top-clearance')
          || cs.getPropertyValue('--dsh-windows-titlebar-height')
        const n = parseFloat(raw)
        return Number.isFinite(n) && n > 0 ? n : 0
      } catch { return 0 }
    }
    function clampRtGeom(g) {
      const vw = (typeof window !== 'undefined' && window.innerWidth) || 1280
      const vh = (typeof window !== 'undefined' && window.innerHeight) || 800
      const chrome = desktopChromeTop()
      const w = Math.min(Math.max(320, Number(g && g.w) || 620), Math.max(320, vw))
      const h = Math.min(Math.max(240, Number(g && g.h) || 520), Math.max(240, vh - chrome))
      const x = Math.min(Math.max(0, Number(g && g.x) || 0), Math.max(0, vw - w))
      const y = Math.min(Math.max(chrome, Number(g && g.y) || chrome), Math.max(chrome, vh - h))
      return { x: x, y: y, w: w, h: h }
    }
    function defaultRtGeom() {
      const vw = (typeof window !== 'undefined' && window.innerWidth) || 1280
      const vh = (typeof window !== 'undefined' && window.innerHeight) || 800
      let w = 620
      try {
        const saved = Number(window.localStorage.getItem('rt-dock-width'))
        if (Number.isFinite(saved) && saved >= 320 && saved <= 1200) w = saved
      } catch (e) { /* privacy mode */ }
      const h = Math.max(240, Math.min(640, vh - 24))
      return clampRtGeom({ x: Math.max(0, vw - w - 12), y: 12, w: w, h: h })
    }
    function loadRtGeom() {
      try {
        const raw = JSON.parse(window.localStorage.getItem(RT_GEOM_KEY) || 'null')
        if (raw && typeof raw === 'object') return clampRtGeom(raw)
      } catch (e) { /* privacy mode or bad data */ }
      return defaultRtGeom()
    }

    function Panel(props) {
      /* embedded: inside the de-policy dock it drops its collapse/fullscreen/drag bar, avoiding overlap */
      const embedded = !!(props && props.embedded)
      const st = useUI()
      const [engagements, setEngagements] = React.useState([])
      const [eng, setEng] = React.useState(null)
      const [snapshot, setSnapshot] = React.useState(null)
      const [err, setErr] = React.useState(null)
      const [newName, setNewName] = React.useState('')
      const [geom, setGeom] = React.useState(loadRtGeom)
      const [creating, setCreating] = React.useState(false)
      const [refreshKey, setRefreshKey] = React.useState(0)
      const [digest, setDigest] = React.useState(null)
      const [seen, setSeen] = React.useState(null)
      const sessionId = (props && props.sessionId) || null
      const sessionTitle = (props && props.sessionTitle) || ''
      const [boundEng, setBoundEng] = React.useState(null)
      const [following, setFollowing] = React.useState(false)
      const [followSource, setFollowSource] = React.useState(null)
      const manualPickRef = React.useRef(null)
      const bindSeq = React.useRef(0)
      const manualHere = () => manualPickRef.current !== null && manualPickRef.current === sessionId

      React.useEffect(() => {
        if (embedded) return undefined
        try { window.localStorage.setItem(RT_GEOM_KEY, JSON.stringify(geom)) } catch (e) { /* privacy mode */ }
      }, [geom, embedded])
      React.useEffect(() => {
        if (embedded) return undefined
        const onResize = () => setGeom((g) => clampRtGeom(g))
        window.addEventListener('resize', onResize)
        return () => window.removeEventListener('resize', onResize)
      }, [embedded])

      const loadSnapshot = (id) => {
        if (!id) { setSnapshot(null); return }
        api({ op: 'snapshot', engagement: id }).then((r) => {
          if (!r || r.ok === false) { setErr((r && r.error) || 'Tải thất bại'); return }
          setErr(null)
          setSnapshot(r)
        }, (e) => setErr(String((e && e.message) || e)))
      }

      const refreshList = (selectId) => {
        api({ op: 'bootstrap' }).then((b) => {
          setEngagements((b && b.engagements) || [])
          if (selectId) { setEng(selectId); loadSnapshot(selectId) }
        }, () => {})
      }

      const followTo = (id, list, source) => {
        const known = (list || engagements).some((x) => x.id === id)
        if (!known) return false
        manualPickRef.current = null
        setFollowing(true)
        setFollowSource(source || 'bound')
        setEng(id)
        rememberEngagement(id)
        loadSnapshot(id)
        return true
      }
      const applySessionBinding = (id, list, title) => {
        const known = list || engagements
        if (!id || !known.length) return
        const seq = (bindSeq.current += 1)
        const forSession = id
        api({ op: 'sessionBinding', session: id }).then((r) => {
          if (seq !== bindSeq.current) return
          if (sessionId !== forSession) return
          const bound = r && r.ok !== false && typeof r.bound === 'string' && r.bound ? r.bound : null
          setBoundEng(bound)
          if (bound === null) setFollowing(false)
          if (manualHere() && eng !== null) return
          if (bound !== null && followTo(bound, known, 'bound')) return
          const byTitle = engagementByTitle(title, known)
          if (byTitle !== null && followTo(byTitle, known, 'title')) return
          const last = lastEngagement()
          if (last !== null && followTo(last, known, 'last')) return
        }, () => { if (seq === bindSeq.current) setBoundEng(null) })
      }

      React.useEffect(() => {
        api({ op: 'bootstrap' }).then((r) => {
          if (!r || r.ok === false) { setErr((r && r.error) || 'Không kết nối được kho tài sản'); return }
          const list = r.engagements || []
          setEngagements(list)
          const fallback = r.current || (list[0] && list[0].id) || null
          if (fallback) {
            setFollowSource('default')
            setEng(fallback)
            loadSnapshot(fallback)
          }
          if (sessionId) applySessionBinding(sessionId, list, sessionTitle)
        }, (e) => setErr(String((e && e.message) || e)))
      }, [])

      React.useEffect(() => {
        if (!sessionId || !engagements.length) return
        applySessionBinding(sessionId, engagements, sessionTitle)
      }, [sessionId, sessionTitle, engagements.length])

      const openEngagement = (nameArg) => {
        const name = String(nameArg || newName).trim()
        if (!name) return
        setCreating(true)
        api({ op: 'openEngagement', name: name }).then((r) => {
          setCreating(false)
          if (!r || r.ok === false) { setErr((r && r.error) || 'Tạo thất bại'); return }
          setNewName('')
          refreshList(r.engagement && r.engagement.id)
        }, (e) => { setCreating(false); setErr(String((e && e.message) || e)) })
      }

      /** Refresh: refetch the roster/snapshot and make the current tab refetch too. */
      const refreshAll = () => {
        setRefreshKey((k) => k + 1)
        api({ op: 'bootstrap' }).then((b) => {
          setEngagements((b && b.engagements) || [])
          if (eng) loadSnapshot(eng)
        }, () => { if (eng) loadSnapshot(eng) })
      }

      const trackPointer = (e, move) => {
        if (e.button !== 0) return
        e.preventDefault()
        e.stopPropagation()
        const up = () => {
          window.removeEventListener('mousemove', move)
          window.removeEventListener('mouseup', up)
        }
        window.addEventListener('mousemove', move)
        window.addEventListener('mouseup', up)
      }
      const startDrag = (e) => {
        if (e.target && e.target.closest && e.target.closest('button,a,input,select,textarea,label')) return
        const sx = e.clientX
        const sy = e.clientY
        const ox = geom.x
        const oy = geom.y
        trackPointer(e, (ev) => setGeom((g) => clampRtGeom({ x: ox + (ev.clientX - sx), y: oy + (ev.clientY - sy), w: g.w, h: g.h })))
      }
      const startResizeLeft = (e) => {
        const sx = e.clientX
        const ox = geom.x
        const ow = geom.w
        trackPointer(e, (ev) => {
          const dx = ev.clientX - sx
          setGeom((g) => clampRtGeom({ x: ox + dx, y: g.y, w: ow - dx, h: g.h }))
        })
      }
      const startResizeRight = (e) => {
        const sx = e.clientX
        const ow = geom.w
        trackPointer(e, (ev) => setGeom((g) => clampRtGeom({ x: g.x, y: g.y, w: ow + (ev.clientX - sx), h: g.h })))
      }
      const startResizeBottom = (e) => {
        const sy = e.clientY
        const oh = geom.h
        trackPointer(e, (ev) => setGeom((g) => clampRtGeom({ x: g.x, y: g.y, w: g.w, h: oh + (ev.clientY - sy) })))
      }
      const startResizeCorner = (e) => {
        const sx = e.clientX
        const sy = e.clientY
        const ow = geom.w
        const oh = geom.h
        trackPointer(e, (ev) => setGeom((g) => clampRtGeom({ x: g.x, y: g.y, w: ow + (ev.clientX - sx), h: oh + (ev.clientY - sy) })))
      }

      /* Target switch: reread that target's unread snapshot and pull a summary immediately */
      React.useEffect(() => {
        if (!eng) { setDigest(null); setSeen(null); return undefined }
        setSeen(loadUnread(eng))
        let alive = true
        let digestInflight = false
        const tick = () => {
          if (digestInflight) return        /* The previous round has not returned; skip this one instead of stacking requests */
          digestInflight = true
          api({ op: 'consoleDigest', engagement: eng }).then((r) => {
            if (alive && r && r.ok !== false && r.sections) setDigest(r.sections)
          }, () => { /* Network error: do not interrupt, wait for the next round */ })
            .finally(() => { digestInflight = false })
        }
        tick()
        const timer = window.setInterval(tick, 25000)
        return () => { alive = false; window.clearInterval(timer) }
      }, [eng, refreshKey])

      /**
       * Opening a tab counts as reading its content: record the current digest as read.
       * Never-read (first open) is not new content —— otherwise the first visit is all red dots, hiding
       where the news actually is.
       * */
      const markTabSeen = React.useCallback((tab) => {
        if (!eng) return
        setSeen((prev) => {
          const base = prev || (() => {
            const fresh = {}
            for (const [k, v] of Object.entries((digest || {}))) fresh[k] = { count: Number(v.count || 0), at: v.at || null }
            return fresh
          })()
          const next = Object.assign({}, base)
          const cur = digest && digest[tab]
          if (cur) next[tab] = { count: Number(cur.count || 0), at: cur.at || null }
          saveUnread(eng, next)
          return next
        })
      }, [eng, digest])

      const unreadOf = (tab) => {
        if (!eng || !digest) return false
        if (!seen) return false
        return digestHasNew(seen[tab], digest[tab])
      }

      const stats = (snapshot && snapshot.stats) || {}
      const tabs = [
        ['overview', 'Tình hình'], ['assets', 'Trinh sát tài sản'], ['env', 'Thích ứng môi trường'], ['agents', 'Tác nhân'], ['sessions', 'Đường hầm phiên'],
        ['artifacts', 'Thông tin xác thực và tệp'],
        ['findings', 'Chiến quả lỗ hổng'],
        ['chain', 'Chuỗi tấn công'], ['scores', 'Mục tiêu tính điểm'], ['report', 'Báo cáo'],
        ['knowledge', 'Kho tri thức'],
        ['skills', 'Thư viện kỹ năng'],
      ]
      const TAB_GROUPS = [
        { key: 'overview', label: 'Tổng quan công việc', tabs: ['overview'] },
        { key: 'assets', label: 'Sổ tài sản', tabs: ['assets'] },
        { key: 'collaboration', label: 'Tiến độ cộng tác', tabs: ['agents'] },
        { key: 'results', label: 'Kết quả và báo cáo', tabs: ['findings', 'chain', 'scores', 'report'] },
        { key: 'resources', label: 'Trung tâm tài nguyên', tabs: ['sessions', 'artifacts', 'knowledge', 'skills'] },
        { key: 'settings', label: 'Môi trường và cài đặt', tabs: ['env'] },
      ]
      const TAB_ALIASES = { testing: 'assets', attackfiles: 'artifacts', prompts: 'agents' }
      const groupOf = (tab) => TAB_GROUPS.find((g) => g.tabs.indexOf(TAB_ALIASES[tab] || tab) !== -1) || TAB_GROUPS[0]
      const activeGroup = groupOf(st.tab)
      const goTab = (tab) => { markTabSeen(tab); setUI({ tab: tab }) }
      const shellElementRef = React.useRef(null)
      const fullscreen = useWorkbenchFullscreen(React, shellElementRef)
      const full = !embedded && (isFullWindow() || fullscreen.expanded)
      const openFull = () => fullscreen.enter()
      const exitFull = () => {
        fullscreen.exit()
        if (isFullWindow()) {
          try { window.history.replaceState(null, '', window.location.pathname + window.location.search) } catch (e) { /* ignore */ }
          setRefreshKey((value) => value + 1)
        }
      }
      React.useEffect(() => {
        if (embedded) return undefined
        const onFull = () => fullscreen.enter()
        window.addEventListener(FULL_REQUEST_EVENT, onFull)
        return () => window.removeEventListener(FULL_REQUEST_EVENT, onFull)
      }, [embedded])
      const [theme, setTheme] = React.useState(() => {
        if (typeof productTheme !== 'undefined' && productTheme && typeof productTheme.read === 'function') return productTheme.read()
        return 'dusk'
      })
      React.useEffect(() => {
        if (typeof productTheme === 'undefined' || !productTheme || typeof productTheme.subscribe !== 'function') return undefined
        return productTheme.subscribe((next) => setTheme(next))
      }, [])

      let body
      if (err) body = h('div', { className: 'rt-err' }, err)
      /* Global pages: work without a target (knowledge base / environment / skills / agent overview) */
      else if (st.tab === 'overview') body = h(OverviewTab, {
        engagement: eng, snapshot: snapshot, refreshKey: refreshKey,
        onGo: (tab) => goTab(tab),
      })
      else if (st.tab === 'artifacts') body = h(ArtifactsTab, { engagement: eng, refreshKey: refreshKey })
      else if (st.tab === 'knowledge') body = h(KnowledgeTab, { refreshKey: refreshKey, engagement: boundEng || eng || '' })
      else if (st.tab === 'env') body = h(EnvTab, { refreshKey: refreshKey })
      else if (st.tab === 'skills') body = h(SkillsTab, { refreshKey: refreshKey })
      else if (st.tab === 'agents' || st.tab === 'prompts') body = h(AgentsTab, { engagement: eng, refreshKey: refreshKey })
      else if (!eng) {
        body = h('div', { className: 'rt-pane' },
          h('div', { className: 'rt-card' },
            h('h4', null, 'Chưa có mục tiêu'),
            h('div', { style: { fontSize: 'var(--ui-text-helper)', color: 'var(--dsw-alias-label-secondary)', marginBottom: 8 } },
              'Nhập tên đơn vị mục tiêu diễn tập, tạo diễn tập và bắt đầu trinh sát tài sản.'),
            h('div', { style: { display: 'flex', gap: 8 } },
              h('input', {
                className: 'rt-input', style: { flex: 1 }, placeholder: 'Ví dụ: Công ty TNHH Công nghệ Mẫu',
                value: newName, onChange: (e) => setNewName(e.target.value),
                onKeyDown: (e) => { if (e.key === 'Enter') openEngagement() },
              }),
              h('button', { className: 'rt-btn rt-btn-primary', disabled: creating, onClick: () => openEngagement() },
                creating ? 'Đang tạo…' : 'Tạo mục tiêu'))))
      } else if (st.tab === 'assets') body = h(AssetsTab, { engagement: eng, snapshot: snapshot, refreshKey: refreshKey, onRefresh: refreshAll, onData: () => loadSnapshot(eng) })
      else if (st.tab === 'testing') body = h(AssetsTab, { engagement: eng, snapshot: snapshot, refreshKey: refreshKey, onRefresh: refreshAll, onData: () => loadSnapshot(eng) })
      else if (st.tab === 'sessions') body = h(SessionTab, { engagement: eng, refreshKey: refreshKey })
      else if (st.tab === 'findings') body = h(FindingsTab, { engagement: eng, refreshKey: refreshKey })
      else if (st.tab === 'chain') body = h(ChainTab, { engagement: eng, refreshKey: refreshKey })
      else if (st.tab === 'report') body = h(ReportTab, { engagement: eng, refreshKey: refreshKey })
      else if (st.tab === 'attackfiles') body = h(FindingsTab, { engagement: eng, refreshKey: refreshKey })
      else if (st.tab === 'scores') body = h(ScoreTab, { engagement: eng, refreshKey: refreshKey })
      else body = h('div', { className: 'rt-empty' }, 'Tab không rõ')

      const shellProps = full
        ? { className: 'rt-full rt-studio', 'data-theme': theme, style: { display: 'flex' } }
        : embedded
          ? { className: 'rt-dock rt-embedded rt-studio', 'data-theme': theme, 'data-open': '1', style: { width: '100%', display: 'flex' } }
          : {
              className: 'rt-dock rt-studio',
              'data-theme': theme,
              'data-open': st.open ? '1' : '0',
              style: {
                left: geom.x + 'px',
                top: geom.y + 'px',
                right: 'auto',
                bottom: 'auto',
                width: geom.w + 'px',
                height: geom.h + 'px',
                display: st.open ? 'flex' : 'none',
              },
            }

      const groupHasUnread = (g) => g.tabs.some((t) => unreadOf(t))
      let followChip = null
      if (sessionId) {
        if (manualHere()) {
          followChip = h('span', {
            className: 'rt-follow warn',
            title: boundEng !== null
              ? 'Phiên này đã chọn tay mục tiêu; bấm để chuyển về "' + boundEng + '"'
              : 'Phiên này đã chọn tay mục tiêu, máy chủ chưa có bản ghi liên kết',
            onClick: boundEng !== null
              ? () => {
                  manualPickRef.current = null
                  setFollowing(true)
                  setFollowSource('bound')
                  setEng(boundEng); rememberEngagement(boundEng); loadSnapshot(boundEng)
                }
              : undefined,
          }, h('span', { className: 'rt-follow-dot' }), 'Chọn tay')
        } else if (boundEng !== null && boundEng === eng) {
          followChip = h('span', { className: 'rt-follow on', title: 'Bảng đang theo mục tiêu mà phiên hiện tại liên kết' },
            h('span', { className: 'rt-follow-dot' }), 'Theo dõi')
        } else if (following && followSource === 'title') {
          followChip = h('span', { className: 'rt-follow on', title: 'Tra ngược theo tiêu đề phiên ra "' + eng + '"' },
            h('span', { className: 'rt-follow-dot' }), 'Theo dõi')
        } else {
          followChip = h('span', { className: 'rt-follow', title: 'Phiên hiện tại chưa liên kết mục tiêu' }, 'Chưa liên kết')
        }
      }
      const footStats = [
        (stats.segments || 0) + ' dải C',
        (stats.assets || 0) + ' tài sản',
        (stats.liveAssets || 0) + ' còn sống',
        (stats.openPorts || 0) + ' cổng',
        (stats.vulns || 0) + ' lỗ hổng',
      ].join(' · ')

      const currentProject = engagements.find((item) => item.id === eng)
      const projectName = currentProject ? (currentProject.name || currentProject.id) : 'Chưa chọn dự án'
      const currentTab = tabs.find((item) => item[0] === (TAB_ALIASES[st.tab] || st.tab))
      const normalizedTab = TAB_ALIASES[st.tab] || st.tab
      const pageName = normalizedTab === 'overview' ? 'Tổng quan công việc' : normalizedTab === 'assets' ? 'Sổ tài sản' : normalizedTab === 'agents' ? 'Cộng tác tác nhân' : normalizedTab === 'env' ? 'Môi trường và cài đặt' : currentTab ? currentTab[1] : activeGroup.label
      const projectSelector = h('select', {
        className: 'rt-input rt-eng-select',
        title: projectName,
        'aria-label': 'Chuyển dự án hiện tại',
        value: eng || '',
        onChange: (e) => {
          const next = e.target.value
          manualPickRef.current = sessionId || ''
          setFollowing(false)
          setFollowSource(null)
          setBoundEng(next)
          setEng(next)
          rememberEngagement(next)
          loadSnapshot(next)
          if (sessionId) {
            api({ op: 'bindSessionEngagement', session: sessionId, engagement: next }).catch(() => {})
          }
          api({ op: 'activateEngagement', engagement: next, session: sessionId || undefined }).catch(() => {})
        },
      },
        h('option', { value: '', disabled: true }, engagements.length ? 'Chọn dự án' : 'Chưa có dự án'),
        engagements.map((x) => h('option', { key: x.id, value: x.id }, x.name || x.id || 'Chưa đặt tên')))
      const genericDescriptions = {
        overview: 'Xem tổng quan tài sản, bản ghi, cộng tác và báo cáo của dự án hiện tại.',
        assets: 'Tìm tài sản trước, rồi xem liên kết, nguồn và trạng thái kiểm thử.',
        agents: 'Xem quan hệ phiên, trạng thái thật và cấu hình cộng tác của dự án hiện tại.',
        env: 'Xem nền tảng, tình trạng chạy và cấu hình, mở rộng thông tin chẩn đoán khi cần.',
        findings: 'Xem các bản ghi hiện có trong dự án theo mức độ nghiêm trọng và trạng thái.',
        chain: 'Xem quan hệ liên kết của các bản ghi hiện có trong cùng một khung nhìn.',
        scores: 'Xem tập trung cấu hình mục tiêu, bản ghi hoàn thành và bằng chứng liên quan.',
        report: 'Báo cáo dự án và bằng chứng hiện có giữ trong cùng phạm vi dự án.',
        sessions: 'Xem bản ghi phiên đã đăng ký theo loại.',
        artifacts: 'Xem phân loại thông tin xác thực, tệp và liên kết bản ghi trong dự án.',
        knowledge: 'Tra cứu mục tri thức hiện có theo nguồn và phân loại.',
        skills: 'Xem danh mục tài nguyên, trạng thái khả dụng và mô tả nội dung.',
      }
      const navIconPaths = {
        overview: 'M4 4h6v6H4zM14 4h6v6h-6zM4 14h6v6H4zM14 14h6v6h-6z',
        assets: 'M3 4h18v13H3zM8 21h8M12 17v4M7 8h10M7 12h6',
        collaboration: 'M7 6h10a3 3 0 0 1 3 3v8a3 3 0 0 1-3 3H7a3 3 0 0 1-3-3V9a3 3 0 0 1 3-3ZM12 2v4M8 11h1M15 11h1M9 16h6M1 10v6M23 10v6',
        results: 'M5 3h10l4 4v14H5zM14 3v5h5M9 12h6M9 16h6',
        resources: 'M3 7V4h6l3 3h9v13H3z',
        settings: 'M4 6h16M4 12h16M4 18h16M8 3v6M16 9v6M10 15v6',
      }
      const navIcon = (key) => h('svg', { viewBox: '0 0 24 24', 'aria-hidden': 'true' }, h('path', { d: navIconPaths[key] }))

      const studioProjectCard = h('div', { className: 'rt-project-card', title: projectName },
              h('span', { className: 'rt-project-avatar', 'aria-hidden': 'true' }, (projectName || 'P').slice(0, 1)),
              h('div', { className: 'rt-project-info' }, projectSelector, h('small', null, 'Dự án hiện tại · tài sản và bản ghi cộng tác')))

      const [compactNavigation, setCompactNavigation] = React.useState(false)
      React.useEffect(() => {
        const element = shellElementRef.current
        if (!element) return undefined
        const sync = () => setCompactNavigation(element.getBoundingClientRect().width <= 760)
        sync()
        if (typeof ResizeObserver !== 'undefined') {
          const observer = new ResizeObserver(sync)
          observer.observe(element)
          return () => observer.disconnect()
        }
        window.addEventListener('resize', sync)
        return () => window.removeEventListener('resize', sync)
      }, [full, embedded])
      shellProps.ref = shellElementRef
      shellProps['data-nav-layout'] = compactNavigation ? 'compact' : 'sidebar'
      shellProps['data-fullscreen'] = fullscreen.expanded ? 'true' : 'false'
      const activateGroup = (group) => {
        const next = group.tabs.indexOf(st.tab) >= 0 ? st.tab : group.tabs[0]
        goTab(next)
        setRefreshKey((value) => value + 1)
      }
      const navigateGroupKey = (event, index) => {
        let next
        if (event.key === 'Home') next = 0
        else if (event.key === 'End') next = TAB_GROUPS.length - 1
        else if (event.key === 'ArrowDown' || event.key === 'ArrowRight') next = (index + 1) % TAB_GROUPS.length
        else if (event.key === 'ArrowUp' || event.key === 'ArrowLeft') next = (index - 1 + TAB_GROUPS.length) % TAB_GROUPS.length
        else return
        event.preventDefault()
        activateGroup(TAB_GROUPS[next])
        event.currentTarget.parentElement?.querySelectorAll('[role="tab"]')[next]?.focus()
      }

      return h('div', shellProps,
        // Standalone/fullscreen mounts need their palette before the first paint.
        embedded ? null : h('style', { 'data-redteam-ui-inline': '1' }, CSS),
        (full || embedded) ? null : h('div', { className: 'rt-grip', title: 'Kéo để chỉnh chiều rộng', onMouseDown: startResizeLeft }),
        (full || embedded) ? null : h('div', { className: 'rt-resize-r', title: 'Kéo để chỉnh chiều rộng', onMouseDown: startResizeRight }),
        (full || embedded) ? null : h('div', { className: 'rt-resize-b', title: 'Kéo để chỉnh chiều cao', onMouseDown: startResizeBottom }),
        (full || embedded) ? null : h('div', { className: 'rt-resize-c', title: 'Kéo để chỉnh kích thước', onMouseDown: startResizeCorner }),
        h('div', { className: 'rt-chrome', onMouseDown: (full || embedded) ? undefined : startDrag, title: (full || embedded) ? undefined : 'Giữ và kéo bảng' },
          h('div', { className: 'rt-nav', 'aria-label': 'Điều hướng không gian làm việc' },
            embedded ? null : h('div', { className: 'rt-title' }, h('span', { className: 'rt-dot' }),
              full ? 'Bảng diễn tập · duyệt toàn màn hình' : 'Bảng diễn tập'),
            h('div', { className: 'rt-workspace-brand' }, h('span', { className: 'rt-workspace-mark', 'aria-hidden': 'true' }, 'P'), h('div', null, 'de-policy', h('small', null, 'Bàn làm việc cộng tác'))),
            h('span', { className: 'rt-nav-caption', 'aria-hidden': 'true' }, 'Không gian dự án'),
            h('div', { className: 'rt-nav-groups', role: 'tablist', 'aria-label': 'Khu vực chức năng', 'aria-orientation': compactNavigation ? 'horizontal' : 'vertical' }, TAB_GROUPS.flatMap((g, index) => [
              g.key === 'resources' ? h('span', { key: 'resource-caption', className: 'rt-nav-section-break', 'aria-hidden': 'true' }, 'Tài nguyên và cấu hình') : null,
              h('button', {
              type: 'button',
              onClick: () => activateGroup(g),
              onKeyDown: (event) => navigateGroupKey(event, index),
              tabIndex: activeGroup.key === g.key ? 0 : -1,
              key: g.key, className: 'rt-tab-group' + (activeGroup.key === g.key ? ' on' : ''),
              'data-group': g.key,
              id: 'rt-workspace-tab-' + g.key,
              'aria-controls': 'rt-workspace-content',
              role: 'tab',
              'aria-selected': activeGroup.key === g.key ? 'true' : 'false',
            }, h('span', { className: 'rt-nav-symbol', 'aria-hidden': 'true' }, navIcon(g.key)), h('span', { className: 'rt-nav-label' }, g.label), groupHasUnread(g) && activeGroup.key !== g.key
              ? h('span', { className: 'rt-tab-dot', 'aria-label': 'Có nội dung mới' })
              : null)])),

          ),
          h('div', { className: 'rt-cmd' },
            h('div', { className: 'rt-breadcrumb', 'aria-label': 'Vị trí hiện tại' }, h('span', null, 'Không gian dự án'), h('i', { 'aria-hidden': 'true' }, '/'), h('span', { className: 'rt-breadcrumb-project' }, projectName), h('i', { 'aria-hidden': 'true' }, '/'), h('strong', null, pageName)),
            h('div', { className: 'rt-spacer' }),
            studioProjectCard,
            followChip,
            h('button', { className: 'rt-btn', title: 'Làm mới danh sách, ảnh chụp và dữ liệu trang hiện tại', onClick: refreshAll }, 'Làm mới'),
            embedded ? null : h(VersionBar, null),
            !embedded && isFullWindow() ? h('button', { className: 'rt-btn', title: 'Quay lại giao diện cửa sổ thường', onClick: exitFull }, 'Quay lại cửa sổ') : null,
            embedded ? null : h('button', { className: 'rt-btn', 'aria-pressed': fullscreen.expanded, title: fullscreen.expanded ? 'Thoát toàn màn hình và quay lại cửa sổ' : 'Duyệt toàn màn hình trong cửa sổ hiện tại', onClick: fullscreen.expanded ? exitFull : openFull }, fullscreen.expanded ? 'Thoát toàn màn hình' : 'Duyệt toàn màn hình'),
            (full || embedded) ? null : h('button', { className: 'rt-btn', title: 'Thu gọn bảng', onClick: () => setUI({ open: false }) }, 'Thu gọn'))),
        activeGroup.tabs.length > 1
          ? h('div', { className: 'rt-subnav', role: 'tablist' }, tabs.filter((t) => activeGroup.tabs.indexOf(t[0]) >= 0).map((t) => {
              const activate = () => {
                markTabSeen(t[0])
                setUI({ tab: t[0] })
                setRefreshKey((k) => k + 1)
              }
              return h('div', Object.assign({}, clickable(activate, { label: t[1] }), {
                key: t[0], className: 'rt-tab' + (st.tab === t[0] ? ' on' : ''),
                role: 'tab',
                'aria-selected': st.tab === t[0] ? 'true' : 'false',
                title: unreadOf(t[0]) ? t[1] + ': có nội dung mới, bấm mở xem là chấm đỏ sẽ mất' : t[1],
              }), t[1], unreadOf(t[0])
                ? h('span', { className: 'rt-tab-dot', 'aria-label': 'Có nội dung mới' })
                : null)
            }))
          : null,
        h('div', { className: 'rt-body', key: 'body-' + st.tab, 'data-page': normalizedTab },
          h('header', { className: 'rt-workspace-pagehead' },
            h('div', { className: 'rt-workspace-heading' },
              h('div', { className: 'rt-workspace-eyebrow' }, ({ overview: 'Không gian dự án', assets: 'Quản lý tài sản', collaboration: 'Không gian cộng tác', results: 'Bản ghi kết quả', resources: 'Tài nguyên và cấu hình', settings: 'Cấu hình vận hành' })[activeGroup.key]),
              h('h1', null, pageName), h('p', null, genericDescriptions[normalizedTab] || 'Xem bản ghi trong dự án hiện tại.'))),
          h('div', { className: 'rt-page-content', 'data-page': normalizedTab, id: 'rt-workspace-content', role: 'tabpanel', 'aria-labelledby': 'rt-workspace-tab-' + activeGroup.key }, h(RtBoundary, { key: st.tab }, body))),
        h('div', { className: 'rt-foot' },
          h('div', { className: 'rt-nav-bottom' }, h('span', null, 'Xem theo dự án'), h('small', null, 'Không gian làm việc · quan hệ phiên · bản ghi')),
          h('div', { className: 'rt-nav-section', 'aria-hidden': 'true' }, 'Không gian dự án'),
          h('span', { className: 'rt-foot-stats' }, footStats),
          h('div', { className: 'rt-spacer' }),
          fullscreen.expanded ? h('span', null, 'Esc thoát toàn màn hình') : null,
          h('span', null, snapshot && snapshot.engagement ? snapshot.engagement.name : '')))
    }

    /* ---------------------------------------------------------- entry button */
    function SidebarButton(props) {
      const st = useUI()
      return h('button', {
        className: 'rt-icon-btn' + (st.open ? ' on' : ''),
        title: 'Bảng điều khiển RedTeam (cố định ở thanh bên phải)',
        onClick: () => setUI({ open: !st.open }),
      }, h('span', { style: { fontSize: 14 } }, '⛨'), props.wide ? h('span', null, 'RedTeam') : null)
    }

    function HeaderButton() {
      const st = useUI()
      return h('button', {
        className: 'rt-hbtn' + (st.open ? ' on' : ''),
        title: 'Bảng điều khiển RedTeam (cố định ở thanh bên phải)',
        onClick: () => setUI({ open: !st.open }),
      }, '⛨ RedTeam')
    }

    /** Sidebar "fullscreen browse": enter the console fullscreen in the current window. */
    function FullButton(props) {
      return h('button', {
        className: 'rt-icon-btn',
        title: 'Duyệt toàn màn hình: chiếm toàn bộ màn hình hiện tại (Esc để thoát)',
        onClick: openFullView,
      }, h('span', { style: { fontSize: 14 } }, '⛶'), props.wide ? h('span', null, 'Duyệt toàn màn hình') : null)
    }

    /* ---------------------------------------------------------- plugin entry */
    /** The only hard dependency: the slot registry. */
    const inject = ['slots']

    /**
     * Inject styles + three slots. The style tag and width variables are removed when the fiber unmounts.
     * @param ctx - client root context.
     */
    function apply(ctx) {
      const styleTag = document.createElement('style')
      styleTag.setAttribute('data-redteam-ui', '1')
      styleTag.textContent = CSS
      document.head.append(styleTag)

      ctx.effect(() => () => {
        styleTag.remove()
        dockWidthTag = null
      })

      // The floating window and entry live only in root client.js; no sidebar or header icons.
      void Panel
      void SidebarButton
      void HeaderButton
      void FullButton
    }

    exports.apply = apply
    exports.inject = inject
    return module.exports
  },
})
