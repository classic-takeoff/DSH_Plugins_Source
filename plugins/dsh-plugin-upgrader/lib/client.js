window.__ModuleLoader__.load({
	id: "dsh-plugin-upgrader",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });

		const React = require("react");
		const h = React.createElement;

		/** Resolve a market entry's localized title for the current UI language. */
		function titleText(title, language, fallback) {
			if (typeof title === "string" && title !== "") return title;
			if (title && typeof title === "object") {
				return title[language] || title["zh-cn"] || title.en || Object.values(title)[0] || fallback;
			}
			return fallback;
		}

		/**
		 * Pick the version an upgrade should install: the market's default version, else the
		 * first compatible version. Returns undefined when the entry is not an update.
		 */
		function upgradeTarget(entry) {
			if (entry === undefined || entry === null) return undefined;
			const installation = entry.installation;
			if (!installation || installation.status !== "update-available") return undefined;
			const versions = Array.isArray(entry.versions) ? entry.versions : [];
			const preferred = versions.find((version) => version.version === entry.defaultVersion)
				?? versions.find((version) => version.compatibility && (version.compatibility.compatible || version.compatibility.exempted))
				?? versions[0];
			if (!preferred || !preferred.install || typeof preferred.install.spec !== "string") return undefined;
			return {
				spec: preferred.install.spec,
				...(preferred.install.registry === undefined ? {} : { registry: preferred.install.registry }),
				version: preferred.version
			};
		}

		function UpgradesTab({ install, market, onChanged }) {
			const zh = (globalThis.navigator?.language ?? "en").toLowerCase().startsWith("zh");
			const language = zh ? "zh-cn" : "en";
			const [state, setState] = React.useState({ status: "loading", items: [] });

			const load = React.useCallback(async () => {
				setState((previous) => ({ status: previous.items.length === 0 ? "loading" : "refreshing", items: previous.items }));
				try {
					const lists = await market.listIndexes();
					if (!lists || !lists.ok) {
						setState({ status: "error", items: [] });
						return;
					}
					const items = [];
					for (const index of lists.value) {
						if (index.error) continue;
						const page = await market.search(index.url, { sort: { kind: "index" }, offset: 0, limit: 100 });
						if (!page || !page.ok) continue;
						for (const entry of page.value.entries ?? []) {
							const target = upgradeTarget(entry);
							if (target === undefined) continue;
							items.push({
								name: entry.name,
								title: titleText(entry.title, language, entry.name),
								installed: entry.installation.installedVersion,
								target
							});
						}
					}
					items.sort((left, right) => left.name.localeCompare(right.name));
					setState({ status: "ready", items });
				} catch {
					setState({ status: "error", items: [] });
				}
			}, [market, language]);

			React.useEffect(() => {
				void load();
			}, [load]);

			React.useEffect(() => {
				if (typeof onChanged !== "function") return undefined;
				return onChanged(() => { void load(); });
			}, [onChanged, load]);

			const title = zh ? "插件升级" : "Plugin upgrades";
			const subtitle = zh ? "市场里有更新版本的插件" : "Plugins with a newer version in the market";

			const rows = state.items.map((item) => h("li", {
				key: item.name,
				style: {
					display: "flex",
					alignItems: "center",
					justifyContent: "space-between",
					gap: "16px",
					padding: "12px 0",
					borderBottom: "0.5px solid var(--dsw-alias-border-l2)"
				}
			},
				h("div", { style: { minWidth: 0 } },
					h("div", { style: { fontSize: "14px", lineHeight: "20px" } }, item.title),
					h("div", { style: { color: "var(--dsw-alias-label-secondary)", marginTop: "2px", fontSize: "12px", lineHeight: "18px", fontFamily: "ui-monospace, SFMono-Regular, monospace" } },
						`${item.name} · ${item.installed ?? "?"} → ${item.target.version}`)),
				h("button", {
					type: "button",
					onClick: () => install({
						spec: item.target.spec,
						...(item.target.registry === undefined ? {} : { registry: item.target.registry }),
						title: item.title,
						version: item.target.version
					}),
					style: {
						flex: "none",
						cursor: "pointer",
						padding: "4px 14px",
						borderRadius: "6px",
						border: "1px solid transparent",
						background: "var(--dsw-alias-brand-primary, #4d6bfe)",
						color: "#fff",
						fontSize: "12px",
						lineHeight: "20px"
					}
				}, zh ? "升级" : "Upgrade")));

			let body;
			if (state.status === "loading") {
				body = h("p", { style: { opacity: 0.65, fontSize: "13px" } }, zh ? "正在读取市场…" : "Reading the market…");
			} else if (state.status === "error") {
				body = h("div", { style: { display: "flex", alignItems: "center", gap: "12px" } },
					h("p", { style: { opacity: 0.65, fontSize: "13px" } }, zh ? "读取市场失败" : "Could not read the market"),
					h("button", { type: "button", onClick: () => { void load(); }, style: { cursor: "pointer" } }, zh ? "重试" : "Retry"));
			} else if (state.items.length === 0) {
				body = h("p", { style: { opacity: 0.65, fontSize: "13px" } }, zh ? "所有插件都是最新版本。" : "All plugins are up to date.");
			} else {
				body = h("ul", { style: { listStyle: "none", margin: 0, padding: 0 } }, rows);
			}

			return h("div", { "data-dsh-plugin-upgrader": "" },
				h("div", { style: { display: "flex", alignItems: "baseline", justifyContent: "space-between", gap: "12px", marginBottom: "4px" } },
					h("div", {},
						h("div", { style: { fontSize: "14px", fontWeight: 600 } }, title),
						h("div", { style: { color: "var(--dsw-alias-label-secondary)", fontSize: "12px" } }, subtitle)),
					h("button", {
						type: "button",
						onClick: () => { void load(); },
						disabled: state.status === "loading" || state.status === "refreshing",
						style: { cursor: "pointer", fontSize: "12px" }
					}, zh ? "刷新" : "Refresh")),
				body);
		}

		function apply(ctx) {
			ctx.slots.inject("plugins.tab", () => ctx.slots.register({
				name: "plugins.tab",
				label: "升级",
				order: 10,
				inject: () => ({
					market: ctx.remote.pluginMarket,
					onChanged: (listener) => ctx.remote.$on("plugin-manager/changed", listener)
				})
			}, UpgradesTab));
		}

		exports.inject = ["slots", "remote", "remote.pluginMarket", "remote.pluginManager"];
		exports.apply = apply;
		exports.upgradeTarget = upgradeTarget;
		return module.exports;
	}
});
