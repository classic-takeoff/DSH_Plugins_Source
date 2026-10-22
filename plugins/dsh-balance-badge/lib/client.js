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

		/** Character artwork shown under the balance; clicking it re-reads the balance. */
		const ART_URL = "data:image/webp;base64,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";
		const ART_SIZE = 84;

		const COPY = {
			zh: { label: "余额", refresh: "刷新余额", loading: "读取中…", failed: "读取失败", retry: "点击重试", signedOut: "未登录", updated: "更新于", art: "点击图片刷新余额" },
			en: { label: "Balance", refresh: "Refresh balance", loading: "Loading…", failed: "Unavailable", retry: "Retry", signedOut: "Signed out", updated: "Updated", art: "Click the picture to refresh" }
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
		 * Bottom-right balance badge. Polls the account balance once a minute, exposes a
		 * refresh button, and re-reads on a click of the artwork under it; a failed read
		 * stays clickable.
		 */
		function BalanceBadge({ account, locale }) {
			const [snapshot, setSnapshot] = React.useState({ kind: "loading" });
			const running = React.useRef(false);
			const [hover, setHover] = React.useState(false);
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
				style: {
					position: "fixed",
					right: "16px",
					bottom: "16px",
					zIndex: 40,
					display: "flex",
					flexDirection: "column",
					alignItems: "flex-end",
					gap: "8px",
					pointerEvents: "none"
				}
			},
				h("div", {
					title,
					style: {
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
				),
				h("button", {
					type: "button",
					"data-dsh-balance-art": "",
					onClick: () => { void refresh(); },
					onMouseEnter: () => { setHover(true); },
					onMouseLeave: () => { setHover(false); },
					onFocus: () => { setHover(true); },
					onBlur: () => { setHover(false); },
					disabled: busy,
					title: copy.art,
					"aria-label": copy.art,
					style: {
						display: "block",
						margin: 0,
						padding: 0,
						appearance: "none",
						font: "inherit",
						color: "inherit",
						width: ART_SIZE + "px",
						height: ART_SIZE + "px",
						borderRadius: "24px",
						overflow: "hidden",
						cursor: busy ? "progress" : "pointer",
						border: "1px solid rgba(127,127,127,.28)",
						background: "rgba(255,255,255,.92)",
						boxShadow: hover && !busy ? "0 12px 28px rgba(0,0,0,.26)" : "0 6px 20px rgba(0,0,0,.18)",
						transform: hover && !busy ? "translateY(-3px) scale(1.02)" : "none",
						transition: "transform .16s ease, box-shadow .16s ease, opacity .16s ease",
						opacity: busy ? 0.7 : 1,
						pointerEvents: "auto"
					}
				}, h("img", {
					src: ART_URL,
					alt: copy.art,
					draggable: false,
					style: {
						display: "block",
						width: "100%",
						height: "100%",
						objectFit: "cover",
						userSelect: "none",
						pointerEvents: "none"
					}
				}))
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
