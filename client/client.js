window.__ModuleLoader__.load({
	id: "dsh-skill-market",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });

		const react = require("react");
		const primitives = require("@deepseek-ai/dsh-client-ui-primitives");
		const h = react.createElement;
		const { useState, useEffect, useCallback, useMemo, useRef } = react;

		// Host routes are mounted at this prefix. Paths stay document-relative:
		// the GUI is served with <base href="./">, so a root-absolute path breaks
		// sub-path deployments.
		const PREFIX = "dsh-skill-market/";
		const api = (path) => new URL(PREFIX + path, document.baseURI).pathname;

		function useFlash() {
			const [flash, setFlash] = useState(null);
			const timer = useRef(null);
			const show = useCallback((kind, text) => {
				if (timer.current) clearTimeout(timer.current);
				setFlash({ kind, text });
				timer.current = setTimeout(() => setFlash(null), 6000);
			}, []);
			useEffect(() => () => timer.current && clearTimeout(timer.current), []);
			return [flash, show];
		}

		async function call(path, body) {
			const res = await fetch(api(path), {
				method: body === undefined ? "GET" : "POST",
				headers: body === undefined ? {} : { "content-type": "application/json" },
				body: body === undefined ? undefined : JSON.stringify(body),
				credentials: "same-origin"
			});
			const text = await res.text();
			let data;
			try {
				data = text ? JSON.parse(text) : {};
			} catch {
				throw new Error("响应不是 JSON: " + text.slice(0, 200));
			}
			if (!res.ok || data.ok === false) {
				throw new Error((data && data.error) || "HTTP " + res.status);
			}
			return data;
		}

		const SOURCES = [
			{ id: "all", label: "全部来源" },
			{ id: "skillsmp", label: "skillsmp" },
			{ id: "skillstore", label: "skillstore" },
			{ id: "skills", label: "skills.sh" },
			{ id: "github", label: "GitHub" }
		];

		const SOURCE_LABEL = {
			skillsmp: "skillsmp",
			skillstore: "skillstore",
			skills: "skills.sh",
			github: "GitHub"
		};

		function EntryRow(props) {
			const { entry, installedIds, onInstall, onUninstall, busy } = props;
			const installed = installedIds.has(entry.id);
			const [confirming, setConfirming] = useState(false);
			const meta = [SOURCE_LABEL[entry.source] || entry.source];
			if (entry.installs) meta.push(entry.installs.toLocaleString() + " 次安装");
			if (entry.stars) meta.push(entry.stars + " stars");
			if (entry.trust) meta.push("trust: " + entry.trust);
			return h(
				"li",
				{ className: "dsh-sm-entry", "data-installed": installed ? "true" : "false" },
				h(
					"div",
					{ className: "dsh-sm-entry-main" },
					h("div", { className: "dsh-sm-entry-title" }, h("strong", null, entry.name)),
					entry.description ? h("p", { className: "dsh-sm-entry-desc" }, entry.description) : null,
					h(
						"div",
						{ className: "dsh-sm-entry-meta" },
						meta.map((m, i) => h(primitives.Tag, { key: i, tone: entry.source }, m)),
						entry.path ? h(primitives.Tag, { key: "p" }, entry.path) : null
					)
				),
				h(
					"div",
					{ className: "dsh-sm-entry-actions" },
					installed
						? confirming
							? h(
									"span",
									null,
									h(
										primitives.Button,
										{
											size: "small",
											tone: "danger",
											disabled: !!busy,
											onClick: () => {
												setConfirming(false);
												onUninstall(entry);
											}
										},
										"确认卸载"
									),
									h(primitives.Button, { size: "small", onClick: () => setConfirming(false) }, "取消")
								)
							: h(
									primitives.Button,
									{ size: "small", onClick: () => setConfirming(true), disabled: !!busy },
									"卸载"
								)
						: h(
								primitives.Button,
								{
									size: "small",
									tone: "primary",
									disabled: !!busy,
									onClick: () => onInstall(entry)
								},
								busy ? "安装中…" : "安装"
							)
				)
			);
		}

		function MarketSection() {
			const [query, setQuery] = useState("");
			const [source, setSource] = useState("all");
			const [results, setResults] = useState([]);
			const [installed, setInstalled] = useState([]);
			const [sourcesMeta, setSourcesMeta] = useState(null);
			const [loading, setLoading] = useState(false);
			const [busyId, setBusyId] = useState(null);
			const [fresh, setFresh] = useState(false);
			const [mode, setMode] = useState(null);
			const [indexed, setIndexed] = useState(0);
			const [flash, showFlash] = useFlash();
			const [error, setError] = useState(null);

			const refreshInstalled = useCallback(async () => {
				try {
					const data = await call("installed");
					setInstalled(data.installed || []);
				} catch (e) {
					setError(String(e.message || e));
				}
			}, []);

			useEffect(() => {
				refreshInstalled();
				call("sources")
					.then(setSourcesMeta)
					.catch(() => {});
			}, [refreshInstalled]);

			const installedIds = useMemo(() => new Set(installed.map((s) => s.id)), [installed]);

			const search = useCallback(
				async (e) => {
					if (e) e.preventDefault();
					const trimmed = query.trim();
					if (!trimmed) {
						setResults([]);
						return;
					}
					setLoading(true);
					setError(null);
					try {
						const data = await call("search", {
							query: trimmed,
							sources: source === "all" ? undefined : [source],
							limit: 20
						});
						setResults(data.entries || []);
						setMode(data.mode || "live");
						setIndexed((data.index && data.index.entries) || 0);
						const failed = data.failures || [];
						if (data.entries && data.entries.length === 0) {
							showFlash("info", failed.length ? "所有来源都失败了" : "没有找到匹配的 skill");
						}
						if (failed.length) {
							showFlash("warn", "部分来源失败: " + failed.map((f) => f.source + "(" + f.error + ")").join("; "));
						}
					} catch (err) {
						setError(String(err.message || err));
					} finally {
						setLoading(false);
					}
				},
				[query, source, showFlash]
			);

			const runInstall = useCallback(
				async (entry) => {
					setBusyId(entry.id);
					setError(null);
					try {
						const data = await call("install", {
							entry: {
								source: entry.source,
								id: entry.id,
								name: entry.name,
								query: entry.query,
								repo: entry.repo,
								path: entry.path,
								ref: entry.ref
							}
						});
						setFresh(!!data.fresh);
						showFlash(
							"ok",
							"已安装 " + data.skill.name + " → " + data.skill.dir + (data.rescan ? "（已触发重载）" : "（需重载技能列表）")
						);
						await refreshInstalled();
					} catch (err) {
						setError(String(err.message || err));
					} finally {
						setBusyId(null);
					}
				},
				[refreshInstalled, showFlash]
			);

			const runUninstall = useCallback(
				async (entry) => {
					setBusyId(entry.id);
					setError(null);
					try {
						const data = await call("uninstall", { name: entry.id });
						setFresh(!!data.fresh);
						showFlash("ok", "已卸载 " + data.removed);
						await refreshInstalled();
					} catch (err) {
						setError(String(err.message || err));
					} finally {
						setBusyId(null);
					}
				},
				[refreshInstalled, showFlash]
			);

			const available = sourcesMeta && Array.isArray(sourcesMeta.sources) ? sourcesMeta.sources : SOURCES;

			return h(
				"section",
				{ className: "dsh-sm" },
				h(
					"header",
					{ className: "dsh-sm-header" },
					h("h3", null, "技能市场"),
					h(
						"p",
						{ className: "dsh-sm-sub" },
						"从 skillsmp / skillstore / skills.sh / GitHub 搜索 skill，并选择安装或卸载。"
					)
				),
				h(
					"form",
					{ className: "dsh-sm-search", onSubmit: search },
					h(primitives.Input, {
						value: query,
						placeholder: "搜索技能，例如 pdf、react、changelog…",
						onChange: (e) => setQuery(e.target ? e.target.value : e),
						"aria-label": "搜索技能"
					}),
					h(
						"select",
						{
							className: "dsh-sm-select",
							value: source,
							onChange: (e) => setSource(e.target.value),
							"aria-label": "来源"
						},
						available.map((s) => h("option", { key: s.id, value: s.id }, s.label || s.id))
					),
					h(primitives.Button, { type: "submit", tone: "primary", disabled: loading }, loading ? "搜索中…" : "搜索")
				),
				flash
					? h(
							"div",
							{ className: "dsh-sm-flash", "data-kind": flash.kind, role: "status" },
							flash.text
						)
					: null,
				error ? h("div", { className: "dsh-sm-error", role: "alert" }, error) : null,
				mode
					? h(
							"div",
							{ className: "dsh-sm-mode" },
							h(
								primitives.Tag,
								null,
								mode === "index" ? "索引 · 本地搜索" : mode === "index+live" ? "索引 + 实时搜索" : "实时搜索"
							),
							mode !== "live" && indexed ? h(primitives.Tag, null, indexed + " 条索引") : null
						)
					: null,
				results.length
					? h(
							"ul",
							{ className: "dsh-sm-list" },
							results.map((entry) =>
								h(EntryRow, {
									key: entry.source + ":" + entry.id,
									entry,
									installedIds,
									busy: busyId === entry.id,
									onInstall: runInstall,
									onUninstall: runUninstall
								})
							)
						)
					: null,
				h(
					"section",
					{ className: "dsh-sm-installed" },
					h("h4", null, "已安装 (" + installed.length + ")"),
					fresh ? h("p", { className: "dsh-sm-hint" }, "宿主已就地重载技能列表；若界面未刷新，重启应用即可。") : null,
					installed.length === 0
						? h("p", { className: "dsh-sm-empty" }, "还没有通过本插件安装的技能。")
						: h(
								"ul",
								{ className: "dsh-sm-list" },
								installed.map((skill) =>
									h(
										"li",
										{ key: skill.id, className: "dsh-sm-entry" },
										h(
											"div",
											{ className: "dsh-sm-entry-main" },
											h("div", { className: "dsh-sm-entry-title" }, h("strong", null, skill.name)),
											h(
												"div",
												{ className: "dsh-sm-entry-meta" },
												h(primitives.Tag, null, skill.source),
												h(primitives.Tag, null, skill.revision ? skill.revision.slice(0, 8) : "unknown"),
												h(primitives.Tag, null, skill.edited ? "已本地修改" : "未修改")
											)
										),
										h(
											"div",
											{ className: "dsh-sm-entry-actions" },
											h(
												primitives.Button,
												{
													size: "small",
													tone: "danger",
													disabled: !!busyId,
													onClick: () => runUninstall(skill)
												},
												"卸载"
											)
										)
									)
								)
							)
				)
			);
		}

		function ensureStyles() {
			if (typeof document === "undefined") return;
			if (document.getElementById("dsh-skill-market-style")) return;
			const style = document.createElement("style");
			style.id = "dsh-skill-market-style";
			style.textContent = [
				".dsh-sm{padding:16px 20px;display:flex;flex-direction:column;gap:12px;overflow:auto;height:100%}",
				".dsh-sm-header h3{margin:0;font-size:15px}",
				".dsh-sm-sub{margin:4px 0 0;font-size:12px;opacity:.65}",
				".dsh-sm-search{display:flex;gap:8px;align-items:center}",
				".dsh-sm-search>*:first-child{flex:1}",
				".dsh-sm-select{height:28px;border-radius:6px;padding:0 6px;background:transparent;color:inherit;border:1px solid rgba(127,127,127,.35)}",
				".dsh-sm-flash{border-radius:6px;padding:8px 10px;font-size:12px}",
				".dsh-sm-flash[data-kind=ok]{background:rgba(46,160,67,.14)}",
				".dsh-sm-flash[data-kind=warn]{background:rgba(210,153,34,.16)}",
				".dsh-sm-flash[data-kind=info]{background:rgba(127,127,127,.14)}",
				".dsh-sm-error{border-radius:6px;padding:8px 10px;font-size:12px;background:rgba(218,54,51,.14);white-space:pre-wrap}",
				".dsh-sm-list{list-style:none;margin:0;padding:0;display:flex;flex-direction:column;gap:8px}",
				".dsh-sm-entry{display:flex;gap:12px;justify-content:space-between;align-items:flex-start;padding:10px 12px;border-radius:8px;border:1px solid rgba(127,127,127,.22)}",
				".dsh-sm-entry[data-installed=true]{border-color:rgba(46,160,67,.45)}",
				".dsh-sm-entry-main{min-width:0;display:flex;flex-direction:column;gap:4px}",
				".dsh-sm-entry-title{font-size:13px}",
				".dsh-sm-entry-desc{margin:0;font-size:12px;opacity:.72;overflow-wrap:anywhere}",
				".dsh-sm-entry-meta{display:flex;gap:6px;flex-wrap:wrap;font-size:11px;opacity:.72}",
				".dsh-sm-entry-actions{display:flex;gap:6px;flex:0 0 auto}",
				".dsh-sm-installed{margin-top:8px;display:flex;flex-direction:column;gap:8px}",
				".dsh-sm-installed h4{margin:0;font-size:13px}",
				".dsh-sm-hint{margin:0;font-size:11px;opacity:.65}",
				".dsh-sm-empty{margin:0;font-size:12px;opacity:.6}"
			].join("");
			document.head.appendChild(style);
		}

		function apply(ctx) {
			ensureStyles();
			ctx.slots.inject("plugins.tab", () =>
				ctx.slots.register(
					{
						name: "plugins.tab",
						id: "skill-market",
						order: 60,
						label: () => "技能市场"
					},
					MarketSection
				)
			);
		}

		const inject = ["slots"];

		exports.apply = apply;
		exports.inject = inject;
		return module.exports;
	}
});
