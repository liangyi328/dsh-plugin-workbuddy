window.__ModuleLoader__.load({
	id: "dsh-plugin-workbuddy",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
		let react = require("react");
		let _deepseek_ai_dsh_client_ui_primitives = require("@deepseek-ai/dsh-client-ui-primitives");
		//#region lib/client.js — WorkBuddy 额度指示器 + 上下文长度选择器
		const TAG_ID = "dsh-plugin-workbuddy/QuotaPill.css";
		const css = ".wbq_anchor{position:relative;display:inline-flex;min-width:0;align-items:center}" +
			".wbq_pill{box-sizing:border-box;display:inline-flex;align-items:center;gap:6px;padding:1px 8px;" +
			"border:none;border-radius:999px;background:transparent;color:var(--dsw-alias-label-tertiary);" +
			"font:inherit;font-variant-numeric:tabular-nums;line-height:inherit;white-space:nowrap;cursor:default;max-width:100%}" +
			".wbq_dot{flex:none;width:6px;height:6px;border-radius:50%;background:var(--dsw-alias-state-business-primary)}" +
			".wbq_pill:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-secondary)}" +
			".wbq_tip{position:absolute;bottom:calc(100% + 8px);left:50%;transform:translateX(-50%) translateY(4px);" +
			"z-index:9999;min-width:132px;padding:8px 10px;border-radius:var(--dsw-radius-md,8px);" +
			"border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-module-platform);" +
			"box-shadow:0 4px 16px rgba(0,0,0,.14);color:var(--dsw-alias-label-secondary);" +
			"opacity:0;pointer-events:none;visibility:hidden;transition:opacity 120ms ease,transform 120ms ease,visibility 120ms}" +
			".wbq_anchor:hover .wbq_tip{opacity:1;transform:translateX(-50%) translateY(0);visibility:visible}" +
			".wbq_row{display:flex;justify-content:space-between;gap:14px;font-size:12px;line-height:18px}" +
			".wbq_row+.wbq_row{margin-top:2px}" +
			".wbq_row span{color:var(--dsw-alias-label-tertiary)}" +
			".wbq_row b{color:var(--dsw-alias-label-primary);font-weight:600}" +
			// A drained package is called out: its row goes grey, since "0 / 500"
			// in normal weight reads like any other number.
			".wbq_sep{height:1px;background:var(--dsw-alias-border-l2);margin:6px -4px}" +
			".wbq_drained{color:var(--dsw-alias-label-tertiary);font-weight:500;text-decoration:line-through}";
		if (typeof document !== "undefined" && document.querySelector("style[data-plugin-css=" + JSON.stringify(TAG_ID) + "]") === null) {
			const tag = document.createElement("style");
			tag.dataset.plugin = "dsh-plugin-workbuddy";
			tag.dataset.pluginCss = TAG_ID;
			tag.textContent = css;
			document.head.appendChild(tag);
		}

		/** Format a credit count as a zh-CN grouped integer (safe fallback for odd environments). */
		function formatCredits(value) {
			const n = Number(value);
			if (!Number.isFinite(n)) return "—";
			try {
				return n.toLocaleString("zh-CN", { maximumFractionDigits: 0 });
			} catch {
				return String(Math.round(n));
			}
		}

		/**
		 * The provider route id this plugin owns. Must match `Config.provider` in
		 * lib/index.js (the default is "workbuddy"); it is what the session model
		 * store reports as `current.provider` for a WorkBuddy model, so it is the
		 * one signal that tells the 额度 pill and 上下文选择器 whether the active
		 * model belongs to this provider.
		 */
		const WORKBUDDY_PROVIDER = "workbuddy";

		/** Strip a "{provider}\0{model}" key down to its provider half, or null. */
		function providerOf(currentKey) {
			if (currentKey === null || typeof currentKey !== "string") return null;
			const split = currentKey.indexOf("\u0000");
			return split === -1 ? null : currentKey.slice(0, split);
		}

		/**
		 * The current selection's provider id, or null when no model is selected /
		 * the session store is unavailable.
		 */
		function useCurrentProvider(directory) {
			const key = useCurrentSelectionKey(directory);
			return providerOf(key);
		}

		// Refresh is demand-driven, not timed. The client event set is only
		// connection/locale/slots/theme, so nothing announces "this conversation
		// consumed credits", and this dock renders with no props (no session-status
		// hook is reachable here). So we reload at exactly the moments the number
		// is looked at or can have changed, and never otherwise. The host caches
		// upstream billing for 30s anyway, so a reload is cheap.
		/** Coalesce bursts: rapid re-hovers or click runs collapse into one call. */
		const REFRESH_MIN_MS = 5000;

		const QuotaPill = react.memo(function QuotaPill(props) {
			// 额度只属于 WorkBuddy 模型:当前选中的不是 WorkBuddy 提供商时整个药丸
			// 不渲染(也不再发请求)。取不到会话模型时会话级注入缺省,同样隐藏。
			const currentProvider = useCurrentProvider(props != null ? props.directory : undefined);
			const shown = currentProvider === WORKBUDDY_PROVIDER;
			const [quota, setQuota] = react.useState(null);
			const lastRef = react.useRef(0);
			const inFlightRef = react.useRef(false);

			const load = react.useCallback((force) => {
				if (inFlightRef.current) return;
				const now = Date.now();
				if (force !== true && now - lastRef.current < REFRESH_MIN_MS) return;
				inFlightRef.current = true;
				lastRef.current = now;
				fetch("/workbuddy/quota", { headers: { accept: "application/json" }, cache: "no-store" })
					.then((res) => {
						if (!res.ok) throw new Error("HTTP " + res.status);
						return res.json();
					})
					.then((data) => {
						if (data && typeof data.total === "number") {
							setQuota({
								total: data.total,
								used: data.used ?? 0,
								remaining: data.remaining ?? data.total,
								packages: Array.isArray(data.packages) ? data.packages : [],
							});
						}
					})
					// On failure keep the last known figures instead of blanking the pill.
					.catch(() => {})
					.finally(() => {
						inFlightRef.current = false;
						lastRef.current = Date.now();
					});
			}, []);

			// 只在 WorkBuddy 模型激活时拉取。模型从 WorkBuddy 切走时立即卸载,切回时
			// 重新拉一次(force),保证切回后看到的数字是新鲜的。
			react.useEffect(() => {
				if (shown) load(true);
			}, [load, shown]);

			react.useEffect(() => {
				if (!shown) return undefined;
				const onWake = () => { if (document.visibilityState === "visible") load(false); };
				// Sending is a keydown, not a subscribable event; capture-phase on the
				// document catches it wherever focus sits. Bare Enter is the composer's
				// send gesture; Shift+Enter is a newline and compositing is still typing.
				const onKeyDown = (event) => {
					if (event.key !== "Enter" || event.shiftKey || event.isComposing) return;
					load(false);
				};
				document.addEventListener("keydown", onKeyDown, true);
				document.addEventListener("visibilitychange", onWake);
				window.addEventListener("focus", onWake);
				return () => {
					document.removeEventListener("keydown", onKeyDown, true);
					document.removeEventListener("visibilitychange", onWake);
					window.removeEventListener("focus", onWake);
				};
			}, [load, shown]);

			if (!shown || quota === null) return null;

			const total = quota.total;
			const used = quota.used;
			const remaining = quota.remaining;
			// Tolerated absent: older host builds answered without `packages`.
			const packages = Array.isArray(quota.packages) ? quota.packages : [];

			return react.createElement("span", {
				className: "wbq_anchor",
				// Hover or click = "I am looking at the number now", so fetch then.
				// `pointerenter` does not fire on a touch tap, hence the separate click.
				onPointerEnter: () => load(false),
				onClick: () => load(true),
			},
				react.createElement("span", {
					className: "wbq_pill",
					"aria-label": "WorkBuddy 额度",
					title: "WorkBuddy 额度",
				},
					react.createElement("span", { className: "wbq_dot" }),
					react.createElement("span", { className: "wbq_label" }, "剩余 " + formatCredits(remaining)),
				),
				react.createElement("span", { className: "wbq_tip", role: "tooltip" },
					react.createElement("div", { className: "wbq_row" },
						react.createElement("span", null, "总量"),
						react.createElement("b", null, formatCredits(total))),
					react.createElement("div", { className: "wbq_row" },
						react.createElement("span", null, "已用"),
						react.createElement("b", null, formatCredits(used))),
					react.createElement("div", { className: "wbq_row" },
						react.createElement("span", null, "剩余"),
						react.createElement("b", null, formatCredits(remaining))),
					// Per-package breakdown: the aggregate alone hides that one
					// grant can be drained while the total still looks healthy.
					packages.length > 0 ? react.createElement("div", { className: "wbq_sep" }) : null,
					packages.map((row) => react.createElement("div", { className: "wbq_row", key: row.code },
						react.createElement("span", null, row.label),
						react.createElement("b", { className: row.remaining <= 0 ? "wbq_drained" : "wbq_val" },
							formatCredits(row.remaining) + " / " + formatCredits(row.total)))),
				),
			);
		});

		//#region 上下文长度选择器（WorkBuddy 提供商）
		// 本插件的 dock 条目只消费 WorkBuddy 自己的 context-window 路由;OpenCode
		// 的上下文选择器由 dsh-plugin-opencode 自己的客户端半边提供(插件化,与
		// 本插件同构)。两个药丸对同一 dock 槽位注册,靠「当前模型的提供商属于谁」
		// 互相排斥——同一时间只会有一个可见。
		const PROVIDER_SOURCES = [
			{ url: "/workbuddy/context-window", fallbackName: "WorkBuddy" },
		];
		const CTX_CSS = ".wbc_anchor{position:relative;display:inline-flex;min-width:0;align-items:center}" +
			".wbc_pill{box-sizing:border-box;display:inline-flex;align-items:center;gap:6px;padding:1px 8px;" +
			"border:none;border-radius:999px;background:transparent;color:var(--dsw-alias-label-tertiary);" +
			"font:inherit;font-variant-numeric:tabular-nums;line-height:inherit;white-space:nowrap;cursor:pointer;max-width:100%}" +
			".wbc_pill:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-secondary)}" +
			".wbc_mark{flex:none;width:6px;height:6px;border-radius:50%;background:var(--dsw-alias-state-business-primary)}" +
			".wbc_pill[aria-expanded=true]{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}" +
			// 没有可调模型时整个入口不渲染，而不是留一个永远空的控件。
			".wbc_empty{color:var(--dsw-alias-label-tertiary);padding:10px 12px;line-height:18px}" +
			// 面板挂在 pill 下方并向上对齐，靠近输入框上沿时仍在视口内。
			".wbc_panel{position:absolute;bottom:calc(100% + 8px);left:50%;transform:translateX(-50%);" +
			"z-index:9999;width:296px;max-height:min(60vh,420px);overflow-y:auto;overscroll-behavior:contain;" +
			"padding:6px;border-radius:var(--dsw-radius-md,8px);border:1px solid var(--dsw-alias-border-l2);" +
			"background:var(--dsw-alias-bg-module-platform);box-shadow:0 6px 24px rgba(0,0,0,.18);" +
			"color:var(--dsw-alias-label-primary)}" +
			".wbc_title{padding:4px 8px 6px;font-size:12px;line-height:18px;color:var(--dsw-alias-label-tertiary)}" +
			".wbc_row{display:flex;align-items:center;justify-content:space-between;gap:10px;" +
			"padding:5px 8px;border-radius:6px;cursor:pointer}" +
			".wbc_row:hover{background:var(--dsw-alias-interactive-bg-hover)}" +
			".wbc_row[data-active=true]{background:var(--dsw-alias-interactive-bg-selected,var(--dsw-alias-interactive-bg-hover))}" +
			".wbc_name{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;" +
			"font-size:13px;line-height:20px;color:var(--dsw-alias-label-primary)}" +
			".wbc_opts{display:flex;gap:4px;flex:none}" +
			".wbc_opt{padding:2px 8px;border-radius:999px;border:1px solid var(--dsw-alias-border-l2);" +
			"background:transparent;color:var(--dsw-alias-label-secondary);font:inherit;font-size:12px;" +
			"line-height:18px;font-variant-numeric:tabular-nums;cursor:pointer;white-space:nowrap}" +
			".wbc_opt:hover{border-color:var(--dsw-alias-state-business-primary);color:var(--dsw-alias-label-primary)}" +
			// 生效值用主色实心，未选中的保持描边，避免和普通文字混在一起。
			".wbc_opt[data-on=true]{background:var(--dsw-alias-state-business-primary);border-color:var(--dsw-alias-state-business-primary);" +
			"color:var(--dsw-alias-bg-module-platform,var(--dsw-alias-label-primary))}" +
			// 「默认」= 清除覆盖，回到 WorkBuddy 自带的预算。
			".wbc_reset{margin-left:4px;font-size:12px;color:var(--dsw-alias-label-tertiary)}" +
			// 固定窗口的模型:只报出它的值,不是一个可点的按钮。
			".wbc_fixed{font-size:12px;line-height:20px;font-variant-numeric:tabular-nums;" +
			"color:var(--dsw-alias-label-tertiary);white-space:nowrap}" +
			// 上级分类:每个提供商一组的分组标题。
			".wbc_group{display:flex;align-items:center;gap:6px;margin:6px 2px 2px;" +
			"padding:0 8px;font-size:12px;font-weight:600;line-height:18px;" +
			"color:var(--dsw-alias-label-secondary)}" +
			".wbc_group+.wbc_group{margin-top:8px}" +
			// 没有任何可调模型的提供商(如 OpenCode)报一行说明,而不是留一个空分组。
			".wbc_note{padding:4px 8px 6px;font-size:12px;line-height:18px;" +
			"color:var(--dsw-alias-label-tertiary)}";
		if (typeof document !== "undefined" && document.querySelector("style[data-plugin-css=" + JSON.stringify(TAG_ID + ".ctx") + "]") === null) {
			const tag = document.createElement("style");
			tag.dataset.plugin = "dsh-plugin-workbuddy";
			tag.dataset.pluginCss = TAG_ID + ".ctx";
			tag.textContent = CTX_CSS;
			document.head.appendChild(tag);
		}

		/** `1000000` -> `"1M"`, `300000` -> `"300K"`,与 WorkBuddy CLI 的显示一致。 */
		function formatLength(n) {
			const value = Number(n);
			if (!Number.isFinite(value)) return String(n);
			if (value >= 1e6 && value % 1e6 === 0) return value / 1e6 + "M";
			if (value >= 1e3 && value % 1e3 === 0) return value / 1e3 + "K";
			return String(value);
		}

		/**
		 * 这个对话当前选中的 {provider, model},编码成一个稳定的字符串 key;
		 * 拿不到时返回 null。
		 *
		 * 仍返回原始值而不是 store 里的 selection 对象:`useSyncExternalStore` 拿两次
		 * getSnapshot 的结果做相等比较,而宿主在每次目录同步时都会重建 selection 对象
		 * ——返回对象会让快照每次都比不相等,把订阅变成无限重渲染。把两项拼成一个
		 * 字符串 key 既能携带 provider,又保持快照是原始值。
		 */
		function readCurrentSelectionKey(directory) {
			if (!directory || typeof directory.getSnapshot !== "function") return null;
			const snapshot = directory.getSnapshot();
			const current = snapshot && snapshot.current;
			if (!current || typeof current.model !== "string" || current.model.length === 0) return null;
			const provider = typeof current.provider === "string" ? current.provider : "";
			return provider + "\u0000" + current.model;
		}

		/**
		 * 订阅当前对话的模型选择。
		 *
		 * `directory` 是宿主按 sessionId 注入的共享 store（内建模型选择器用的同一个
		 * 来源）,它是 uSES 快照源,所以直接 `useSyncExternalStore` 订阅。换对话时宿主
		 * 会换掉这个 store,`directory` 随之变化,订阅跟着重建 —— 模型也就跟着换。
		 */
		function useCurrentSelectionKey(directory) {
			const subscribe = react.useCallback((notify) => {
				if (!directory || typeof directory.subscribe !== "function") return () => {};
				return directory.subscribe(notify);
			}, [directory]);
			const getSnapshot = react.useCallback(() => readCurrentSelectionKey(directory), [directory]);
			return react.useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
		}

		/**
		 * 上下文长度选择器 —— 只服务 WorkBuddy 提供商。
		 *
		 * 药丸始终反映「当前选中的模型」:目录里能解析出当前 {provider, model},且该
		 * 模型命中本提供商 catalog 时,药丸显示它的生效长度,面板只画这一行(可调
		 * 模型给档位按钮,固定窗口只读呈现)。当前模型不是 WorkBuddy 模型、或目录
		 * 拿不到当前选择时,整个入口不渲染 —— 绝不把其他提供商的模型全列出来。
		 *
		 * 提交后由 host 校验并落盘,并通过 adapter 改变向运行时申报的窗口,
		 * 从而影响自动压缩时机与用量分母 —— 该值不会作为请求参数发往网关。
		 */
		const ContextPicker = react.memo(function ContextPicker(props) {
			// 当前对话选中的 {provider, model}（编码成一个稳定的字符串 key）。
			// 取不到（服务缺席/未就绪/尚未选过模型）时为 null —— 此时不渲染。
			const currentKey = useCurrentSelectionKey(props != null ? props.directory : undefined);
			const currentProvider = useCurrentProvider(props != null ? props.directory : undefined);
			// 显式的提供商闸门:当前模型不属于 WorkBuddy 时直接不渲染,连目录都不用等。
			const isWorkbuddy = currentProvider === WORKBUDDY_PROVIDER;
			const [state, setState] = react.useState({ open: false, groups: null, error: null });
			const rootRef = react.useRef(null);
			const inFlightRef = react.useRef(false);
			const mountedRef = react.useRef(false);

			const load = react.useCallback(() => {
				if (inFlightRef.current) return;
				inFlightRef.current = true;
				// 只拉本提供商的目录;单个失败只影响自己这一组。
				Promise.allSettled(PROVIDER_SOURCES.map((source) =>
					fetch(source.url, { headers: { accept: "application/json" }, cache: "no-store" })
						.then((res) => {
							if (!res.ok) throw new Error("HTTP " + res.status);
							return res.json();
						})
						.then((data) => ({ source, data })),
				))
					.then((settled) => {
						const groups = [];
						for (const entry of settled) {
							if (entry.status !== "fulfilled") continue;
							const { source, data } = entry.value;
							const models = Array.isArray(data && data.models) ? data.models : [];
							if (models.length === 0) continue;
							groups.push({
								key: typeof data.provider === "string" && data.provider.length > 0 ? data.provider : source.url,
								name: typeof data.providerName === "string" && data.providerName.length > 0
									? data.providerName
									: source.fallbackName,
								url: source.url,
								models,
							});
						}
						setState((prev) => (groups.length > 0
							? { ...prev, groups, error: null }
							// 本路由没应答:保留上一次成功的分组,只有初次失败才报错。
							: (prev.groups === null
								? { ...prev, error: "WorkBuddy 上下文目录读取失败" }
								: prev)));
					})
					.finally(() => { inFlightRef.current = false; });
			}, []);

			// 挂载即拉取一次:药丸的可见性与标签都取决于当前模型是否命中目录,不能
			// 等用户点开面板才决定。之后只在打开面板时补拉(低频,且可刷新刚提交的值)。
			react.useEffect(() => {
				if (!mountedRef.current) {
					mountedRef.current = true;
					load();
					return;
				}
				if (state.open && state.groups === null) load();
			}, [state.open, state.groups, load]);

			// 点击面板外部或按 Esc 关闭。
			react.useEffect(() => {
				if (!state.open) return undefined;
				const onPointerDown = (event) => {
					if (rootRef.current && !rootRef.current.contains(event.target)) {
						setState((prev) => ({ ...prev, open: false }));
					}
				};
				const onKeyDown = (event) => {
					if (event.key === "Escape") setState((prev) => ({ ...prev, open: false }));
				};
				document.addEventListener("pointerdown", onPointerDown, true);
				document.addEventListener("keydown", onKeyDown, true);
				return () => {
					document.removeEventListener("pointerdown", onPointerDown, true);
					document.removeEventListener("keydown", onKeyDown, true);
				};
			}, [state.open]);

			const commit = react.useCallback((group, modelId, value) => {
				setState((prev) => ({ ...prev, error: null }));
				fetch(group.url, {
					method: "POST",
					headers: { "content-type": "application/json" },
					// null 表示清除覆盖,回到模型自带的默认值。
					body: JSON.stringify({ model: modelId, contextWindow: value }),
				})
					.then((res) => res.json().then((body) => ({ ok: res.ok, body })))
					.then((result) => {
						if (!result.ok) {
							setState((prev) => ({ ...prev, error: (result.body && result.body.error) || "保存失败" }));
							return;
						}
						// 以 host 返回的生效值回写,不乐观更新:面板显示的就是实际生效的。
						load();
					})
					.catch((error) => {
						setState((prev) => ({ ...prev, error: String(error && error.message || error) }));
					});
			}, [load]);

			/**
			 * 当前选择 -> 要展示的分组与当前行。
			 *
			 * 只有「当前模型的提供商就是本插件、且模型命中本目录」时才产出内容,并且
			 * 只保留命中模型的那一行（仍带分组标题）。任何其他情况返回 null ——
			 * 调用方据此整入口不渲染,不再退回列出全部模型。
			 */
			const view = state.groups === null ? null : (() => {
				if (currentKey === null || !isWorkbuddy) return null;
				const split = currentKey.indexOf("\u0000");
				const provider = currentKey.slice(0, split);
				const model = currentKey.slice(split + 1);
				const group = provider.length > 0
					? state.groups.find((entry) => entry.key === provider)
					: undefined;
				const row = group !== undefined
					? group.models.find((entry) => entry.id === model)
					: undefined;
				return group !== undefined && row !== undefined
					? { groups: [group], active: row }
					: null;
			})();

			// 目录还没就绪、或当前模型不属于 WorkBuddy 时,整个入口不渲染。
			if (state.groups === null || view === null) return null;

			// 当前行。可调模型给档位按钮;不可调时面板只读,只报出它固定的那个窗口。
			const row = view.active;
			const isCustom = row.selected != null;
			const title = row.displayName || row.name || row.id;
			const label = row.effective != null ? formatLength(row.effective) : "上下文";

			/**
			 * 渲染命中的那一个分组:分组标题（上级分类） + 当前模型这一行。
			 */
			const renderGroup = (group) => {
				const children = [
					react.createElement("div", { className: "wbc_group", key: "head" }, group.name),
				];
				const name = row.displayName || row.name || row.id;
				const entryAdjustable = row.adjustable === true;
				const options = entryAdjustable && Array.isArray(row.options) ? row.options : [];
				children.push(react.createElement("div", {
					className: "wbc_row",
					key: row.id,
					"data-active": "true",
					title: name,
				},
					react.createElement("span", { className: "wbc_name" }, name),
					react.createElement("span", { className: "wbc_opts" },
						entryAdjustable
							? [
								options.map((value) => react.createElement("button", {
									className: "wbc_opt",
									key: value,
									type: "button",
									"data-on": row.effective === value,
									onClick: (event) => {
										// 阻止冒泡,否则点选项会连带触发外层行的行为。
										event.stopPropagation();
										if (row.effective !== value) commit(group, row.id, value);
									},
								}, formatLength(value))),
								row.selected != null ? react.createElement("button", {
									className: "wbc_reset",
									key: "reset",
									type: "button",
									title: "恢复模型默认值",
									onClick: (event) => {
										event.stopPropagation();
										commit(group, row.id, null);
									},
								}, "默认") : null,
							]
							: react.createElement("span", { className: "wbc_fixed", key: "fixed" },
								row.effective != null ? formatLength(row.effective) : "—", " 固定"),
					),
				));
				return react.createElement("div", { key: group.key }, children);
			};

			return react.createElement("span", { className: "wbc_anchor", ref: rootRef },
				react.createElement("button", {
					className: "wbc_pill",
					type: "button",
					"aria-expanded": state.open,
					"aria-haspopup": "true",
					title: title + " 的上下文长度",
					onClick: () => setState((prev) => ({ ...prev, open: !prev.open })),
				},
					react.createElement("span", { className: "wbc_label" },
						// 有自定义覆盖时点亮一个圆点,便于一眼看出当前并非全是默认值。
						isCustom ? react.createElement("span", { className: "wbc_mark" }) : null,
						label),
				),
				state.open ? react.createElement("div", { className: "wbc_panel", role: "dialog", "aria-label": "上下文长度" },
					// 标题永远说明这是「哪个模型」的上下文,否则单行数字会失去主语。
					react.createElement("div", { className: "wbc_title" },
						title + " · 上下文长度（影响自动压缩时机）"),
					state.groups === null
						? react.createElement("div", { className: "wbc_empty" },
							state.error !== null ? "读取失败: " + state.error : "正在读取目录…")
						: null,
					react.createElement("div", { className: "wbc_panel-body", key: "body" },
						view.groups.map((group) => renderGroup(group))),
					state.error !== null && state.groups !== null
						? react.createElement("div", { className: "wbc_empty" }, state.error)
						: null,
				) : null,
		);
		});
		//#endregion

		//#region 插件装配
		// `modelDirectories` 是内建模型选择器注册的会话级服务：按 sessionId 给出这个
		// 对话当前模型的共享快照源。它缺席时本插件仍能工作（退回全量列表），所以它
		// 不是硬依赖,故不写进 `inject` —— 写进去会让整个半边因为缺席而完全不装载。
		const inject = [
			"slots",
		];

		/**
		 * 这个会话当前模型的 `directory` store,拿不到返回 undefined。
		 *
		 * `directoryFor` 对未知会话会抛错（而不是返回 undefined），所以这里吞掉异常
		 * 并退化成 undefined：上下文选择器不是模型选择器，不该因为取不到模型就让
		 * 整个 dock 崩掉。
		 */
		function modelDirectoryFor(models, sessionId) {
			if (!models || typeof models.directoryFor !== "function" || sessionId === undefined) {
				return undefined;
			}
			try {
				return models.directoryFor(sessionId);
			} catch {
				return undefined;
			}
		}

		/** Register the quota pill into the input box's dock. */
		function apply(ctx) {
			// 会话级注入给两个 dock 条目:当前模型的 {provider, model}。额度药丸只有在
			// 选中 WorkBuddy 模型时才渲染;上下文选择器只在当前模型命中 WorkBuddy /
			// OpenCode 分组的行时才展开可选档位,否则整入口隐藏。
			const sessionInject = (sessionId) => {
				const directory = modelDirectoryFor(ctx.get("modelDirectories"), sessionId);
				return directory === undefined ? {} : { directory: directory.store };
			};
			ctx.slots.inject("conversation.composer.dock", () => ctx.slots.register({
				name: "conversation.composer.dock",
				id: "workbuddy-quota",
				order: 10,
				inject: sessionInject,
			}, QuotaPill));
			// 上下文选择器放在额度之后,顺序 11。它读取 WorkBuddy 的 context-window
			// 路由,按提供商分组渲染（缺席的路由整组略过）。当前模型不是 WorkBuddy 的
			// 模型时整入口隐藏,不再把别的提供商的模型列出来。
			//
			// `inject` 面按 sessionId 解析,与内建模型选择器同一套写法:它让条目按会话
			// 拿到自己的模型 store,从而只显示这个对话当前模型所属的分组。
			ctx.slots.inject("conversation.composer.dock", () => ctx.slots.register({
				name: "conversation.composer.dock",
				id: "workbuddy-context-window",
				order: 11,
				inject: sessionInject,
			}, ContextPicker));
		}
		//#endregion
		exports.apply = apply;
		exports.inject = inject;
		exports.name = "workbuddy-quota";
		return module.exports;
	}
});
