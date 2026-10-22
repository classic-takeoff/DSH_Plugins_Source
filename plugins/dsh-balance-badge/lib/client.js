window.__ModuleLoader__.load({
	id: "dsh-balance-badge",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });

		const React = require("react");
		const h = React.createElement;

		/** DSH client version carried on Platform account requests; keep in step with the app release. */
		const CLIENT_VERSION = "0.2.1-rc.2";
		const REFRESH_MS = 60_000;

		const COPY = {
			zh: { label: "余额", refresh: "刷新余额", loading: "读取中…", failed: "读取失败", retry: "点击重试", signedOut: "未登录", updated: "更新于" },
			en: { label: "Balance", refresh: "Refresh balance", loading: "Loading…", failed: "Unavailable", retry: "Retry", signedOut: "Signed out", updated: "Updated" }
		};

		function copyFor(locale) {
			return String(locale === undefined || locale === null ? "" : locale).toLowerCase().startsWith("zh") ? COPY.zh : COPY.en;
		}

		/** Format a decimal balance string with the currency Platform uses for it. */
		function money(balance, currency) {
			const symbol = currency === "CNY" ? "¥" : currency === "USD" ? "$" : "";
			const value = Number(balance);
			if (!Number.isFinite(value)) return symbol + String(balance === undefined ? "" : balance);
			return symbol + value.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
		}

		/**
		 * Bottom-right balance pill. Polls the account balance once a minute and exposes a
		 * refresh button; a failed read stays clickable.
		 */
		function BalanceBadge({ account, locale }) {
			const [snapshot, setSnapshot] = React.useState({ kind: "loading" });
			const running = React.useRef(false);
			const copy = copyFor(locale.getSnapshot().active);

			const refresh = React.useCallback(async () => {
				if (running.current) return;
				running.current = true;
				setSnapshot((previous) => (previous.kind === "ready" ? { ...previous, busy: true } : { kind: "loading" }));
				try {
					const metadata = {
						version: CLIENT_VERSION,
						locale: locale.getSnapshot().active,
						timezoneOffsetSeconds: -new Date().getTimezoneOffset() * 60
					};
					const result = await account.getBalance(metadata);
					if (!result || !result.ok) {
						setSnapshot({ kind: "failed" });
						return;
					}
					const value = result.value;
					if (value === null || value === undefined) {
						setSnapshot({ kind: "signed-out" });
						return;
					}
					if (value.status !== "ready") {
						setSnapshot({ kind: "failed" });
						return;
					}
					setSnapshot({ kind: "ready", wallets: value.value || [], bonusWallets: value.bonusWallets || [], at: Date.now() });
				} catch {
					setSnapshot({ kind: "failed" });
				} finally {
					running.current = false;
				}
			}, [account, locale]);

			React.useEffect(() => {
				void refresh();
				const timer = setInterval(() => { void refresh(); }, REFRESH_MS);
				const onFocus = () => { void refresh(); };
				if (typeof window !== "undefined" && typeof window.addEventListener === "function") window.addEventListener("focus", onFocus);
				return () => {
					clearInterval(timer);
					if (typeof window !== "undefined" && typeof window.removeEventListener === "function") window.removeEventListener("focus", onFocus);
				};
			}, [refresh]);

			const wallets = snapshot.kind === "ready" ? snapshot.wallets : [];
			const bonus = snapshot.kind === "ready"
				? snapshot.bonusWallets.filter((wallet) => Number(wallet.balance) > 0)
				: [];
			const busy = snapshot.kind === "loading" || snapshot.busy === true;

			let value;
			if (snapshot.kind === "ready") {
				value = wallets.length > 0
					? wallets.map((wallet) => money(wallet.balance, wallet.currency)).join(" · ")
					: money("0", "CNY");
			} else if (snapshot.kind === "signed-out") {
				value = copy.signedOut;
			} else if (snapshot.kind === "failed") {
				value = copy.retry;
			} else {
				value = copy.loading;
			}

			const title = snapshot.kind === "ready" && snapshot.at !== undefined
				? `${copy.label} · ${copy.updated} ${new Date(snapshot.at).toLocaleTimeString()}`
				: `${copy.label} · ${copy.refresh}`;

			return h("div", {
				"data-dsh-balance-badge": "",
				title,
				style: {
					position: "fixed",
					right: "16px",
					bottom: "16px",
					zIndex: 40,
					display: "flex",
					alignItems: "center",
					gap: "8px",
					padding: "6px 10px",
					borderRadius: "999px",
					border: "1px solid rgba(127,127,127,.28)",
					background: "rgba(127,127,127,.14)",
					backdropFilter: "blur(8px)",
					WebkitBackdropFilter: "blur(8px)",
					color: "var(--dsw-alias-label-primary, currentColor)",
					font: "500 12px/1.4 -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif",
					boxShadow: "0 4px 16px rgba(0,0,0,.12)",
					userSelect: "none",
					pointerEvents: "auto"
				}
			},
				h("span", { style: { opacity: 0.65 } }, copy.label),
				h("span", { "aria-live": "polite" }, value),
				bonus.length > 0 ? h("span", { style: { opacity: 0.6, fontSize: "11px" } }, bonus.map((wallet) => "+" + money(wallet.balance, wallet.currency)).join(" · ")) : null,
				h("button", {
					type: "button",
					onClick: () => { void refresh(); },
					disabled: busy,
					title: copy.refresh,
					"aria-label": copy.refresh,
					style: {
						all: "unset",
						cursor: busy ? "default" : "pointer",
						padding: "0 2px",
						fontSize: "13px",
						lineHeight: 1,
						opacity: busy ? 0.4 : 0.75
					}
				}, "↻")
			);
		}

		/** Register the badge in the frame-wide overlay slot, pinned to the bottom-right. */
		function apply(ctx) {
			ctx.slots.inject("shell.overlay", () => ctx.slots.register({
				name: "shell.overlay",
				id: "balance-badge",
				order: 100,
				inject: () => ({ account: ctx.remote.account, locale: ctx.locale })
			}, BalanceBadge));
		}

		exports.inject = ["slots", "locale", "remote", "remote.account"];
		exports.apply = apply;
		return module.exports;
	}
});
