window.__ModuleLoader__.load({
	id: "dsh-thinking-mode",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });

		const React = require("react");
		const { Switch } = require("@deepseek-ai/dsh-client-ui-primitives");
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

		/** Replace the reasoning body with the complete text, wrapped like the DeepSeek web client. */
		function ThinkingReasoningBody({ text, running, renderFactorySlot }) {
			const on = useEnabled();
			if (!on) return renderFactorySlot("conversation.chat.reasoning.content", { text, running });
			return h("div", {
				"data-dsh-thinking-body": "",
				style: {
					whiteSpace: "pre-wrap",
					overflowWrap: "anywhere",
					wordBreak: "break-word",
					lineHeight: "1.7",
					maxWidth: "100%"
				}
			}, text);
		}

		function ThinkingRow() {
			const on = useEnabled();
			const zh = (globalThis.navigator?.language ?? "en").toLowerCase().startsWith("zh");
			const title = zh ? "简洁思考模式" : "Concise thinking";
			return h('div', {
				"data-dsh-thinking-setting": "",
				style: {
					display: "flex",
					alignItems: "center",
					justifyContent: "space-between",
					gap: "24px",
					padding: "16px 0",
					borderBottom: "0.5px solid var(--dsw-alias-border-l2)"
				}
			},
				h("div", { style: { minWidth: 0 } },
					h("div", { style: { fontSize: "14px", lineHeight: "20px" } }, title),
					h("div", { style: { color: "var(--dsw-alias-label-secondary)", marginTop: "4px", fontSize: "12px", lineHeight: "18px" } },
						zh
							? "仅展示思考内容：隐藏工具调用，思考完整显示并正常换行"
							: "Thinking only: hides tool calls and shows the complete reasoning with normal line wrapping")),
				h(Switch, {
					checked: on,
					label: title,
					onChange: (next) => setEnabled(next)
				}));
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
