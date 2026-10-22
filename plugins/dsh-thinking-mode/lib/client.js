window.__ModuleLoader__.load({
	id: "dsh-thinking-mode",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });

		const React = require("react");
		const h = React.createElement;

		/** Local preference; no Host setting is written, so the built-in enum stays untouched. */
		const STORAGE_KEY = "dsh.thinking-mode";
		const listeners = new Set();
		let enabled = false;
		try {
			enabled = window.localStorage.getItem(STORAGE_KEY) === "1";
		} catch {
			enabled = false;
		}

		function subscribe(listener) {
			listeners.add(listener);
			return () => listeners.delete(listener);
		}

		function useEnabled() {
			return React.useSyncExternalStore(subscribe, () => enabled, () => enabled);
		}

		function applyDocument(next) {
			if (typeof document === "undefined") return;
			if (next) document.documentElement.setAttribute("data-dsh-thinking", "");
			else document.documentElement.removeAttribute("data-dsh-thinking");
		}

		/** Hide tool-call rows; reasoning rows stay visible. */
		const STYLE = 'html[data-dsh-thinking] [data-chat-flow-kind="tool-call"]{display:none!important}';

		function installStyle() {
			if (typeof document === "undefined" || document.querySelector("style[data-dsh-thinking]") !== null) return;
			const style = document.createElement("style");
			style.setAttribute("data-dsh-thinking", "");
			style.textContent = STYLE;
			document.head.appendChild(style);
		}

		/**
		 * Reasoning rows are collapsed by default; in thinking mode open every one so the
		 * complete text is rendered, then the body replacement below removes the wrapping.
		 */
		let scheduled = false;
		function expandThinking() {
			if (!enabled || scheduled) return;
			scheduled = true;
			requestAnimationFrame(() => {
				scheduled = false;
				if (!enabled || typeof document === "undefined") return;
				for (const row of document.querySelectorAll('[data-variant="think"]')) {
					if (row.getAttribute("data-expanded") !== null) continue;
					const trigger = row.querySelector('[aria-expanded="false"]');
					if (trigger !== null) trigger.click();
				}
			});
		}

		function startObserver() {
			if (typeof MutationObserver === "undefined" || typeof document === "undefined") return;
			const observer = new MutationObserver(expandThinking);
			observer.observe(document.documentElement, { childList: true, subtree: true });
			expandThinking();
		}

		function setEnabled(next) {
			enabled = next;
			try {
				window.localStorage.setItem(STORAGE_KEY, next ? "1" : "0");
			} catch {
				// private mode: the toggle still works for this page
			}
			applyDocument(next);
			for (const listener of [...listeners]) listener();
			if (next) expandThinking();
		}

		/** Replace the reasoning body: one unwrapped line, horizontally scrollable. */
		function ThinkingReasoningBody({ text, running, renderFactorySlot }) {
			const on = useEnabled();
			if (!on) return renderFactorySlot("conversation.chat.reasoning.content", { text, running });
			return h("div", {
				"data-dsh-thinking-body": "",
				style: { whiteSpace: "nowrap", overflowX: "auto", overflowY: "hidden", maxWidth: "100%" }
			}, text);
		}

		function ThinkingRow() {
			const on = useEnabled();
			const zh = (globalThis.navigator?.language ?? "en").toLowerCase().startsWith("zh");
			return h('div', {
				"data-dsh-thinking-setting": "",
				style: {
					display: "flex",
					alignItems: "center",
					justifyContent: "space-between",
					gap: "16px",
					padding: "12px 0"
				}
			},
				h("div", { style: { minWidth: 0 } },
					h("div", { style: { fontWeight: 600, fontSize: "14px" } }, zh ? "简洁思考模式" : "Concise thinking"),
					h("div", { style: { opacity: 0.65, fontSize: "12px", lineHeight: "18px", marginTop: "2px" } },
						zh
							? "仅展示思考内容：隐藏工具调用，思考不换行、完整显示"
							: "Thinking only: hides tool calls and shows reasoning unwrapped")),
				h("button", {
					type: "button",
					"aria-pressed": on,
					"data-dsh-thinking-toggle": on ? "on" : "off",
					onClick: () => setEnabled(!on),
					style: {
						flex: "none",
						cursor: "pointer",
						padding: "4px 14px",
						borderRadius: "6px",
						border: on ? "1px solid transparent" : "1px solid rgba(127,127,127,.4)",
						background: on ? "var(--dsw-alias-brand-primary, #4d6bfe)" : "transparent",
						color: on ? "#fff" : "var(--dsw-alias-label-primary, inherit)",
						fontSize: "12px",
						lineHeight: "20px"
					}
				}, zh ? (on ? "关闭" : "开启") : (on ? "Disable" : "Enable")));
		}

		function apply(ctx) {
			installStyle();
			applyDocument(enabled);
			startObserver();
			ctx.slots.inject("conversation.chat.reasoning.body", () => ctx.slots.register({
				name: "conversation.chat.reasoning.body",
				priority: 90
			}, ThinkingReasoningBody));
			ctx.slots.inject("settings.general.item", () => ctx.slots.register({
				name: "settings.general.item",
				id: "thinking-mode",
				order: 13
			}, ThinkingRow));
		}

		exports.inject = ["slots"];
		exports.apply = apply;
		return module.exports;
	}
});
