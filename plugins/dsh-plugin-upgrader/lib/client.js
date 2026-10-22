window.__ModuleLoader__.load({
	id: "dsh-plugin-upgrader",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });

		const React = require("react");
		const h = React.createElement;

		/** Find the market entry for one installed package that has a newer version. */
		async function findUpgrade(market, name) {
			const lists = await market.listIndexes();
			if (!lists || !lists.ok) return undefined;
			for (const index of lists.value) {
				if (index.error) continue;
				const page = await market.search(index.url, { sort: { kind: "index" }, offset: 0, limit: 100 });
				if (!page || !page.ok) continue;
				for (const entry of page.value.entries ?? []) {
					if (entry.name !== name) continue;
					if (!entry.installation || entry.installation.status !== "update-available") return undefined;
					const versions = Array.isArray(entry.versions) ? entry.versions : [];
					const preferred = versions.find((version) => version.version === entry.defaultVersion) ?? versions[0];
					if (!preferred || !preferred.install || typeof preferred.install.spec !== "string") return undefined;
					return {
						spec: preferred.install.spec,
						...(preferred.install.registry === undefined ? {} : { registry: preferred.install.registry }),
						version: preferred.version
					};
				}
			}
			return undefined;
		}

		/**
		 * Header action on an installed bundle's page: when the market has a newer version,
		 * show "升级最新版本" and replace the installed package with that version.
		 */
		function UpgradeAction({ subject, market, manager }) {
			const pkg = subject && subject.kind === "bundle" ? subject.pkg : undefined;
			const [target, setTarget] = React.useState(undefined);
			const [busy, setBusy] = React.useState(false);

			React.useEffect(() => {
				let cancelled = false;
				if (!pkg || pkg.installed !== true) return undefined;
				void (async () => {
					try {
						const found = await findUpgrade(market, pkg.name);
						if (!cancelled && found !== undefined) setTarget(found);
					} catch {
						// the market is optional; a failed read just hides the action
					}
				})();
				return () => { cancelled = true; };
			}, [pkg && pkg.name, market]);

			if (target === undefined) return null;

			const upgrade = async () => {
				setBusy(true);
				try {
					const removed = await manager.removeBundle(pkg.name);
					if (!removed.ok) throw new Error((removed.error && removed.error.message) || "卸载旧版本失败");
					const requestId = (globalThis.crypto && globalThis.crypto.randomUUID) ? globalThis.crypto.randomUUID() : String(Date.now());
					const installed = await manager.installBundle(target.spec, {
						enabled: pkg.enabled !== false,
						requestId,
						...(target.registry === undefined ? {} : { registry: target.registry })
					});
					if (!installed.ok || (installed.value && installed.value.error)) {
						const reason = (installed.error && installed.error.message) || (installed.value && installed.value.error && installed.value.error.message) || "安装新版本失败";
						throw new Error(reason);
					}
					setBusy(false);
				} catch (error) {
					setBusy(false);
					if (typeof window !== "undefined" && typeof window.alert === "function") {
						window.alert(`升级失败：${error.message}\n插件可能已被卸载，可在「发现」页重新安装。`);
					}
				}
			};

			const label = busy ? "升级中…" : "升级最新版本";
			return h("button", {
				type: "button",
				title: "升级最新版本",
				"data-dsh-upgrade-action": "",
				disabled: busy,
				onClick: () => { void upgrade(); },
				style: {
					cursor: busy ? "default" : "pointer",
					padding: "4px 12px",
					borderRadius: "6px",
					border: "1px solid rgba(127,127,127,.35)",
					background: "var(--dsw-alias-brand-primary, #4d6bfe)",
					color: "#fff",
					fontSize: "12px",
					lineHeight: "20px",
					opacity: busy ? 0.6 : 1
				}
			}, label);
		}

		function apply(ctx) {
			ctx.slots.inject("plugins.detail.actions", () => ctx.slots.register({
				name: "plugins.detail.actions",
				inject: () => ({
					market: ctx.remote.pluginMarket,
					manager: ctx.remote.pluginManager
				})
			}, UpgradeAction));
		}

		exports.inject = ["slots", "remote", "remote.pluginMarket", "remote.pluginManager"];
		exports.apply = apply;
		exports.findUpgrade = findUpgrade;
		return module.exports;
	}
});
