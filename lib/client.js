// dsh-session-mover 客户端：在 设置 → 会话迁移 里提供迁移面板。
// 约定参考本机已装且工作正常的 dsh-chat-manager：factory 返回 { inject, apply }。
window.__ModuleLoader__.load({
  id: "dsh-session-mover",
  factory: require => {
    const React = require("react");
    const h = React.createElement;
    const API = "/plugins/dsh-session-mover";
    const CONFIRM = { "x-dsh-session-mover": "session-mover" };

    const styles = {
      root: { display: "flex", flexDirection: "column", gap: 12, fontSize: 13, lineHeight: 1.5 },
      row: { display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" },
      list: { display: "flex", flexDirection: "column", gap: 6, maxHeight: 320, overflowY: "auto", padding: 4 },
      item: {
        display: "flex", alignItems: "center", gap: 8, padding: "6px 8px", borderRadius: 6,
        border: "1px solid var(--dsw-alias-border-l2, #3a3a3a)", cursor: "pointer",
      },
      itemActive: { borderColor: "var(--dsw-alias-brand-primary, #4d6bfe)" },
      muted: { opacity: 0.65 },
      badge: {
        fontSize: 11, padding: "1px 6px", borderRadius: 999,
        border: "1px solid var(--dsw-alias-border-l2, #3a3a3a)", whiteSpace: "nowrap",
      },
      warn: { fontSize: 11, padding: "1px 6px", borderRadius: 999, border: "1px solid #b45309", color: "#f59e0b", whiteSpace: "nowrap" },
      button: {
        padding: "4px 12px", borderRadius: 6, cursor: "pointer",
        border: "1px solid var(--dsw-alias-border-l2, #3a3a3a)",
        background: "var(--dsw-alias-bg-base, transparent)", color: "inherit",
      },
      select: {
        padding: "4px 8px", borderRadius: 6, maxWidth: 320,
        border: "1px solid var(--dsw-alias-border-l2, #3a3a3a)",
        background: "var(--dsw-alias-bg-base, transparent)", color: "inherit",
      },
      notice: { padding: "6px 8px", borderRadius: 6, background: "var(--dsw-alias-bg-layer-2, rgba(127,127,127,.12))" },
      error: { padding: "6px 8px", borderRadius: 6, border: "1px solid #b91c1c", color: "#ef4444" },
    };

    function formatSize(bytes) {
      if (!Number.isFinite(bytes)) return "?";
      if (bytes < 1024) return bytes + " B";
      if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + " KB";
      return (bytes / 1024 / 1024).toFixed(2) + " MB";
    }

    function shortId(id) {
      const text = String(id);
      return text.length > 22 ? text.slice(0, 10) + "…" + text.slice(-8) : text;
    }

    function Panel(props) {
      const { t, pluginCtx } = props;
      const [state, setState] = React.useState({ loading: true, error: "", workspaces: [], sessions: [] });
      const [selected, setSelected] = React.useState("");
      const [targetId, setTargetId] = React.useState("");
      const [busy, setBusy] = React.useState(false);
      const [notice, setNotice] = React.useState("");
      const [error, setError] = React.useState("");
      const [filter, setFilter] = React.useState("");

      // 宿主改了归属，但左侧列表的数据来自客户端 store（侧边栏只给 store 里已知的
      // session id 渲染行：deriveFlat -> list.byId[id]）。不刷新就可能"迁移成功但列表
      // 里看不到"。照工作正常的 dsh-chat-manager 的做法显式刷新两个 store。
      const refreshStores = React.useCallback(async () => {
        try {
          const sessionsStore = pluginCtx?.get?.("sessions");
          const workspacesStore = pluginCtx?.get?.("workspaces");
          await Promise.allSettled([
            typeof sessionsStore?.refresh === "function" ? sessionsStore.refresh() : Promise.resolve(),
            typeof workspacesStore?.refresh === "function" ? workspacesStore.refresh() : Promise.resolve(),
          ]);
        } catch {
          /* store 没有 refresh 也不影响迁移结果 */
        }
      }, [pluginCtx]);

      const load = React.useCallback(async () => {
        setState(prev => ({ ...prev, loading: true, error: "" }));
        try {
          const response = await fetch(API + "/state", { headers: { accept: "application/json" } });
          const body = await response.json();
          if (!response.ok || body.ok !== true) throw new Error(body?.error?.message || "HTTP " + response.status);
          setState({ loading: false, error: "", workspaces: body.workspaces, sessions: body.sessions });
        } catch (cause) {
          setState(prev => ({ ...prev, loading: false, error: cause.message || String(cause) }));
        }
      }, []);

      React.useEffect(() => { load(); }, [load]);

      const sessions = state.sessions || [];
      const workspaces = state.workspaces || [];
      const current = sessions.find(session => session.id === selected) || null;
      const target = workspaces.find(workspace => workspace.workspaceId === targetId) || null;
      const query = filter.trim().toLowerCase();
      const visible = query === ""
        ? sessions
        : sessions.filter(session => [session.title, session.id, session.cwd, session.workspaceTitle]
          .filter(Boolean).join(" ").toLowerCase().includes(query));

      const post = async (path, payload) => {
        const response = await fetch(API + path, {
          method: "POST",
          headers: { "content-type": "application/json", ...CONFIRM },
          body: JSON.stringify(payload),
        });
        const body = await response.json().catch(() => ({}));
        if (!response.ok || body.ok !== true) throw new Error(body?.error?.message || "HTTP " + response.status);
        return body;
      };

      const migrate = async () => {
        if (busy || current === null || target === null) return;
        setBusy(true); setError(""); setNotice("");
        try {
          const result = await post("/migrate", { sessionId: current.id, targetWorkspaceId: target.workspaceId });
          if (result.noop) {
            setNotice(t("该会话已经在这个工作区里了。", "That session is already in this workspace."));
          } else {
            const mode = result.membership?.mode;
            const group = result.workspace || target.title;
            const parts = [
              t("迁移完成：", "Migrated: ") + current.id,
              t("已归入分组：「", "Group: \"") + group + t("」", "\""),
              t("帧数：", "frames: ") + result.frames,
              t("备份：", "backup: ") + result.backup,
            ];
            if (mode === "hot" || mode === "hot-without-index-refresh") {
              parts.push(t("归属已即时更新，无需重启。", "Membership updated live; no restart needed."));
              parts.push(t("请到左侧「", "Look under the \"") + group
                + t("」分组下查看（若该分组是折叠的，先展开它）。",
                    "\" group on the left (expand it if collapsed)."));
            } else if (mode === "disk") {
              parts.push(t("内存索引未能即时生效，归属已写入磁盘，需要重启 DSH 才会出现在左侧「",
                "Live index did not take effect; membership was written to disk. Restart DSH to see it under \"")
                + group + t("」分组。", "\"."));
              if (result.membership?.error) parts.push(t("原因：", "Reason: ") + result.membership.error);
            } else {
              parts.push(t("归属未更新。重启 DSH 后，左侧会把它显示在「未分组」，拖进「",
                "Membership not updated. After restarting DSH it will appear under \"ungrouped\"; drag it into \"")
                + group + t("」分组即可。", "\"."));
              if (result.membership?.error) parts.push(t("原因：", "Reason: ") + result.membership.error);
            }
            setNotice(parts.join("\n"));
            setSelected("");
          }
          // 归属改在宿主内存里，但**左侧列表的数据来自客户端自己的 store**：
          // 侧边栏只给 store 里已知的 session id 渲染行（deriveFlat: list.byId[id]），
          // 不刷新就可能"迁移成功但列表里看不到"。这里照工作正常的 dsh-chat-manager 的做法
          // 显式刷新 sessions / workspaces 两个 store。
          await refreshStores();
          await load();
        } catch (cause) {
          setError(cause.message || String(cause));
        } finally {
          setBusy(false);
        }
      };

      const repair = async () => {
        if (busy || current === null) return;
        setBusy(true); setError(""); setNotice("");
        try {
          const result = await post("/repair", { sessionId: current.id });
          setNotice(result.changed
            ? t("帧结构已修复。备份：", "Framing repaired. Backup: ") + result.backup
              + t("\n如果左侧还没出现，重启一次 DSH 即可。", "\nIf it still does not show on the left, restart DSH once.")
            : t("日志帧结构正常，无需修复。", "Framing is fine; nothing to repair."));
          // 修好的日志需要被重新枚举；先刷新客户端 store 试试，能省掉一次重启。
          if (result.changed) await refreshStores();
          await load();
        } catch (cause) {
          setError(cause.message || String(cause));
        } finally {
          setBusy(false);
        }
      };

      return h("div", { style: styles.root },
        h("div", { style: styles.row },
          h("strong", null, t("会话迁移", "Session migration")),
          h("span", { style: styles.muted }, t("把会话从一个工作区搬到另一个工作区（DSH 必须处于关闭该会话的状态）", "Move a session between workspaces (it must not be open in DSH)"))),

        h("div", { style: styles.row },
          h("span", null, t("目标工作区", "Target workspace")),
          h("select", {
            style: styles.select, value: targetId, disabled: busy,
            onChange: event => setTargetId(event.target.value),
          },
            h("option", { value: "" }, t("— 请选择 —", "— select —")),
            workspaces.map(workspace => h("option", { key: workspace.workspaceId, value: workspace.workspaceId },
              workspace.title + "  (" + workspace.path + ")"))),
          h("button", { style: styles.button, disabled: busy, onClick: load }, t("刷新", "Refresh"))),

        h("div", { style: styles.row },
          h("input", {
            style: { ...styles.select, flex: 1, minWidth: 160 },
            value: filter, disabled: busy, placeholder: t("按标题 / 路径 / ID 过滤", "Filter by title / path / id"),
            onChange: event => setFilter(event.target.value),
          }),
          h("span", { style: styles.muted }, t("共 ", "total ") + sessions.length + t(" 个会话", " sessions"))),

        state.loading && h("div", { style: styles.muted }, t("读取中…", "Loading…")),
        state.error && h("div", { style: styles.error }, state.error),

        h("div", { style: styles.list },
          visible.length === 0 && !state.loading && h("div", { style: styles.muted }, t("没有匹配的会话", "No matching sessions")),
          visible.map(session => {
            const disabled = session.live;
            return h("div", {
              key: session.id,
              style: { ...styles.item, ...(session.id === selected ? styles.itemActive : {}), ...(disabled ? styles.muted : {}) },
              onClick: () => { if (!disabled && !busy) { setSelected(session.id); setNotice(""); setError(""); } },
              title: session.id,
            },
              h("input", { type: "radio", readOnly: true, checked: session.id === selected, disabled }),
              h("div", { style: { flex: 1, minWidth: 0 } },
                h("div", { style: { overflowWrap: "anywhere", fontWeight: session.title ? 600 : 400 } },
                  session.title || t("（未命名会话）", "(untitled session)")),
                h("small", { style: styles.muted },
                  (session.workspaceTitle || t("未分组", "ungrouped")) + " · "
                  + (session.cwd || "?") + " · " + formatSize(session.sizeBytes)),
                h("small", { style: { ...styles.muted, opacity: 0.45, overflowWrap: "anywhere", display: "block" } }, shortId(session.id))),
              session.live && h("span", { style: styles.badge }, t("打开中", "open")),
              !session.readable && h("span", { style: styles.warn }, t("帧结构异常", "framing broken")));
          })),

        h("div", { style: styles.row },
          h("button", {
            style: styles.button, disabled: busy || current === null || target === null || (current && !current.readable),
            onClick: migrate,
          }, busy ? t("处理中…", "Working…") : t("迁移选中会话", "Migrate selected session")),
          h("button", {
            style: styles.button, disabled: busy || current === null || (current && current.readable),
            onClick: repair,
          }, t("修复帧结构", "Repair framing"))),

        notice && h("div", { style: styles.notice, role: "status" }, notice.split("\n").map((line, index) => h("div", { key: index }, line))),
        error && h("div", { style: styles.error, role: "alert" }, error),

        h("div", { style: styles.muted },
          t("说明：迁移只重写日志第 1 帧（头部 cwd），正文帧字节原样保留；迁移前整目录备份，失败自动回滚。",
            "Migration rewrites only the first frame (header cwd); body frames are preserved byte-for-byte. Full-directory backup before any change; failure rolls back.")),
      );
    }

    return {
      inject: ["slots", "locale"],
      apply(ctx) {
        const text = (zh, en) => {
          try {
            return ctx.locale.getSnapshot().active === "zh" ? zh : en;
          } catch {
            return zh;
          }
        };
        ctx.slots.inject("settings.section", () => ctx.slots.register({
          name: "settings.section",
          id: "session-mover",
          order: 70,
          label: () => text("会话迁移", "Session migration"),
        }, slotProps => h(Panel, { ...slotProps, t: text, pluginCtx: ctx })));
      },
    };
  },
});
