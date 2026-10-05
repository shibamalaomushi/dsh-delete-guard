/**
 * dsh-delete-guard —— 浏览器半身
 *
 * 三个入口共用同一套操作与同一条服务端闸门：
 *   1) 侧边栏「会话管理」页面（主入口：分类 / 筛选 / 排序 / 批量 / 回收站）
 *   2) 会话行的悬停按钮（`sidebar.workspaces.session.row.action`）
 *   3) 会话行的右键菜单项（`sidebar.workspaces.session.menu.item`）
 * 另有 Host 侧的 `/sessions` 斜杠命令。
 *
 * 摩擦分级依据 GitLab Pajamas 的 destructive actions 规范：
 *   可还原的操作（进回收站）不加摩擦，批量也应顺畅；不可恢复的操作（彻底删除 / 清空回收站）
 *   用弹窗 + 危险按钮，并按条数与严重度要求输入确认词。
 *
 * 约定（内核 Client 插件规范）：__ModuleLoader__ 惰性工厂、id 等于包名、React 从模块表取、
 * 只注册到已声明的插槽、只用 --dsw-* 主题 token、不 import 内核 Client 包、文案走 ctx.locale。
 */

__ModuleLoader__.load({
  id: 'dsh-delete-guard',
  factory(require) {
    const React = require('react')
    const h = React.createElement

    const NS = 'sessionManager'
    const PANEL_ID = 'session-manager'
    const API = '/dsh-delete-guard/api'
    const NOTICE_MS = 5000
    const POLL_MS = 30000
    const COLLAPSE_KEY = 'dsh-delete-guard.collapsed.v1'

    // ───────────────────────── 文案（zh 为键集合真源，en 必须完全对齐）─────────────────────────
    const zh = {
      panel: '会话管理',
      title: '会话管理',
      intro: '删除单条或批量删除会话（含正文、投影缓存与侧边栏引用）。默认移入回收站，可随时还原。',
      refresh: '刷新',
      loading: '读取中…',
      untitled: '（无标题）',
      empty: '没有会话。',
      emptyFiltered: '没有符合当前分类与筛选条件的会话。',
      sessions: '会话',
      trash: '回收站',
      pending: '待删除（重启后自动执行）',
      unlisted: '未登记',
      archived: '已归档',
      pinned: '已置顶',
      subagent: '子代理',
      live: '使用中',
      unknown: '无法判定',
      protected: '受保护',
      liveHint: '这条会话正在使用中：先在侧边栏切换到别的会话，或排入重启后删除。',
      unknownHint: '内核会话服务读数不可用，无法确认是否在用；为避免误删，只能排队到重启后执行。',
      reasonDisabled: '插件当前为只读模式（enabled: false），任何删除都被拒绝。',
      reasonProtected: '这条会话在 protectedSessionIds 名单里，永不允许删除。',
      reasonSubagentProtected: '配置中禁止删除子代理会话（allowSubagentDelete: false）。',
      reasonPinnedProtected: '这条会话已置顶；请先取消置顶（protectPinned: true）。',
      reasonArchivedProtected: '这条会话已归档；请先取消归档（protectArchived: true）。',
      closeLabel: '关闭',
      warnIrreversible: '不可撤销：正文与投影缓存会被真正抹掉，回收站里也不会再出现。',
      reasonOrphan: '这个回收站条目没有可读的 meta.json，无法归属到具体会话；插件不会去动它（保守）。',
      trashIncomplete: '不完整',
      purgeAllSkipHint: '其中 {n} 条受保护或无法归属，会被跳过。',
      purgedAllPartial: '已清空 {n} 条，跳过 {m} 条（受保护或无法归属）。',
      filter: '按标题、工作区或会话 id 筛选',
      clear: '清除',
      noWorkspace: '（未知工作区）',
      summary: '{n} 条会话 · 共 {size} · 回收站 {trash} 条',
      category: '分类',
      catAll: '全部',
      catMain: '主会话',
      catSubagent: '子代理',
      catArchived: '已归档',
      catPinned: '已置顶',
      catBlocked: '不可删',
      sort: '排序',
      sortUpdated: '按更新时间',
      sortSize: '按大小',
      sortTitle: '按标题',
      sortWorkspace: '按工作区',
      selectAll: '全选当前结果',
      selectNone: '取消选择',
      selectedCount: '已选 {n} 条 · 共 {size}',
      selectedBlocked: '其中 {n} 条不可删除，将被跳过。',
      batchTrash: '移入回收站',
      batchRestore: '批量还原',
      batchPurge: '批量彻底删除',
      delete: '删除',
      confirmDelete: '确认删除',
      cancel: '取消',
      queue: '排入重启后删除',
      unqueue: '取消排队',
      restore: '还原',
      purge: '彻底删除',
      purgeAll: '清空回收站',
      confirm: '确认',
      size: '大小',
      updated: '更新于',
      deletedAt: '删除于',
      copyId: '复制会话 id',
      copied: '已复制会话 id。',
      copyFailed: '复制失败，请手动选择 id。',
      ok: '完成。',
      failed: '失败',
      trashEmpty: '回收站是空的。',
      pendingEmpty: '没有排队的会话。',
      pendingHint: '这些会话会在下次启动应用时移入回收站（那时它们不再被使用）。',
      unreachable: '无法连接插件后台：{error}',
      unreachableHint: '插件刚安装时需要重启一次应用；若已重启仍失败，请查看 DSH 主进程日志。',
      queued: '已排入重启后删除。',
      queuedOff: '已取消排队。',
      deleted: '已移入回收站。',
      deletedN: '已删除 {n} 条（可在回收站还原）。',
      deletedPartial: '已删除 {ok} 条，跳过 {failed} 条（原因见列表标记）。',
      restored: '已还原。',
      restoredN: '已还原 {n} 条。',
      purged: '已彻底删除。',
      purgedN: '已彻底删除 {n} 条。',
      purgeAllDone: '回收站已清空。',
      startup: '启动时处理了排队的会话。',
      expand: '展开',
      collapse: '收起',
      policy: '安全策略',
      policyReadOnly: '只读模式',
      policyNoPurge: '禁止彻底删除',
      policySubagentProtected: '子代理受保护',
      policyProtectPinned: '置顶受保护',
      policyProtectArchived: '归档受保护',
      policyTrashDays: '回收站保留 {n} 天',
      policyTrashForever: '回收站不自动清理',
      policyBatchLimit: '单次批量上限 {n} 条',
      policyTypedConfirm: '≥{n} 条彻底删除需输入确认词',
      policyProtectedCount: '受保护名单 {n} 条',
      confirmTrashTitle: '将 {n} 条会话移入回收站？',
      confirmTrashBody: '这些会话的正文、投影缓存与侧边栏引用会被移动；之后可在回收站里还原。',
      confirmPurgeTitle: '将永久删除 {n} 条？',
      confirmPurgeBody: '此操作不可恢复：正文与投影缓存会被真正抹掉，回收站里也不会再出现。',
      confirmPurgeAllTitle: '清空回收站（{n} 条）？',
      confirmPurgeAllBody: '此操作不可恢复：回收站里的全部内容会被真正抹掉。',
      willAffect: '将影响：',
      andMore: '…共 {n} 条，已省略 {m} 条',
      totalSize: '合计 {size}',
      typedConfirmLabel: '请输入确认词 {word} 以继续：',
      typedConfirmPlaceholder: '在此输入确认词',
      rowMenu: '删除会话…',
      rowAction: '删除会话（打开会话管理确认）',
      armed: '已定位到该会话，请在弹窗里确认删除。',
      paths: '数据位置：会话 {sessions} · 数据 {data} · 审计日志 {log}',
    }
    const en = {
      panel: 'Sessions',
      title: 'Session Manager',
      intro: 'Delete one session or a batch (log, projection cache, and sidebar reference). Deletions go to a trash you can restore from.',
      refresh: 'Refresh',
      loading: 'Loading…',
      untitled: '(untitled)',
      empty: 'No sessions.',
      emptyFiltered: 'No session matches the current category and filter.',
      sessions: 'Sessions',
      trash: 'Trash',
      pending: 'Queued for deletion (runs on next launch)',
      unlisted: 'unlisted',
      archived: 'archived',
      pinned: 'pinned',
      subagent: 'subagent',
      live: 'in use',
      unknown: 'unknown',
      protected: 'protected',
      liveHint: 'This session is in use: switch to another session first, or queue it for next launch.',
      unknownHint: 'The Host cannot read session liveness; to stay safe, deletion is limited to queueing for the next launch.',
      reasonDisabled: 'The plugin is read-only (enabled: false); every deletion is refused.',
      reasonProtected: 'This session is listed in protectedSessionIds and can never be deleted.',
      reasonSubagentProtected: 'Deleting subagent sessions is disabled (allowSubagentDelete: false).',
      reasonPinnedProtected: 'This session is pinned; unpin it first (protectPinned: true).',
      reasonArchivedProtected: 'This session is archived; unarchive it first (protectArchived: true).',
      closeLabel: 'Close',
      warnIrreversible: 'Irreversible: the logs and projection caches are erased and will not come back.',
      reasonOrphan: 'This trash entry has no readable meta.json, so it cannot be attributed to a session; the plugin leaves it alone (conservative).',
      trashIncomplete: 'incomplete',
      purgeAllSkipHint: '{n} of them are protected or unattributable and will be skipped.',
      purgedAllPartial: 'Emptied {n}; skipped {m} (protected or unattributable).',
      filter: 'Filter by title, workspace, or session id',
      clear: 'Clear',
      noWorkspace: '(unknown workspace)',
      summary: '{n} sessions · {size} total · {trash} in trash',
      category: 'Category',
      catAll: 'All',
      catMain: 'Main',
      catSubagent: 'Subagent',
      catArchived: 'Archived',
      catPinned: 'Pinned',
      catBlocked: 'Undeletable',
      sort: 'Sort',
      sortUpdated: 'By update time',
      sortSize: 'By size',
      sortTitle: 'By title',
      sortWorkspace: 'By workspace',
      selectAll: 'Select current results',
      selectNone: 'Clear selection',
      selectedCount: '{n} selected · {size}',
      selectedBlocked: '{n} of them cannot be deleted and will be skipped.',
      batchTrash: 'Move to trash',
      batchRestore: 'Restore selected',
      batchPurge: 'Delete permanently',
      delete: 'Delete',
      confirmDelete: 'Confirm delete',
      cancel: 'Cancel',
      queue: 'Queue for next launch',
      unqueue: 'Unqueue',
      restore: 'Restore',
      purge: 'Delete permanently',
      purgeAll: 'Empty trash',
      confirm: 'Confirm',
      size: 'Size',
      updated: 'Updated',
      deletedAt: 'Deleted',
      copyId: 'Copy session id',
      copied: 'Session id copied.',
      copyFailed: 'Copy failed; select the id manually.',
      ok: 'Done.',
      failed: 'Failed',
      trashEmpty: 'The trash is empty.',
      pendingEmpty: 'Nothing is queued.',
      pendingHint: 'These move to the trash when the app next starts, when nothing holds them.',
      unreachable: 'Cannot reach the plugin backend: {error}',
      unreachableHint: 'A freshly installed plugin needs one app restart; if it still fails after that, check the DSH host log.',
      queued: 'Queued for deletion on next launch.',
      queuedOff: 'Unqueued.',
      deleted: 'Moved to the trash.',
      deletedN: 'Deleted {n} session(s); restore them from the trash.',
      deletedPartial: 'Deleted {ok}, skipped {failed} (see the row marks for reasons).',
      restored: 'Restored.',
      restoredN: 'Restored {n}.',
      purged: 'Permanently deleted.',
      purgedN: 'Permanently deleted {n}.',
      purgeAllDone: 'Trash emptied.',
      startup: 'Queued sessions were processed at startup.',
      expand: 'Expand',
      collapse: 'Collapse',
      policy: 'Safety policy',
      policyReadOnly: 'read-only mode',
      policyNoPurge: 'permanent delete disabled',
      policySubagentProtected: 'subagents protected',
      policyProtectPinned: 'pinned protected',
      policyProtectArchived: 'archived protected',
      policyTrashDays: 'trash kept {n} days',
      policyTrashForever: 'trash never auto-cleaned',
      policyBatchLimit: 'max {n} per batch',
      policyTypedConfirm: 'typed word required at ≥{n}',
      policyProtectedCount: '{n} in the protected list',
      confirmTrashTitle: 'Move {n} session(s) to the trash?',
      confirmTrashBody: 'Their logs, projection caches, and sidebar references are moved; you can restore them from the trash afterwards.',
      confirmPurgeTitle: 'Permanently delete {n}?',
      confirmPurgeBody: 'This cannot be undone: the logs and projection caches are erased and will not come back to the trash.',
      confirmPurgeAllTitle: 'Empty the trash ({n})?',
      confirmPurgeAllBody: 'This cannot be undone: everything in the trash is erased for good.',
      willAffect: 'Affected:',
      andMore: '…{n} total, {m} hidden',
      totalSize: '{size} total',
      typedConfirmLabel: 'Type {word} to continue:',
      typedConfirmPlaceholder: 'Type the confirmation word',
      rowMenu: 'Delete session…',
      rowAction: 'Delete session (opens Session Manager to confirm)',
      armed: 'Located that session; confirm the deletion in the dialog.',
      paths: 'Locations: sessions {sessions} · data {data} · audit log {log}',
    }
    const fallbackText = zh

    // ───────────────────────── 样式（只用主题 token）─────────────────────────
    const CSS = `
.dsm-page{box-sizing:border-box;height:100%;color:var(--dsw-alias-label-primary);display:flex;flex-direction:column;align-items:center;gap:16px;padding:0 clamp(24px,4vw,48px) 40px;overflow:auto}
.dsm-page>*{width:100%;max-width:1000px}
.dsm-head{display:flex;justify-content:space-between;align-items:flex-start;gap:16px;padding-top:28px}
[data-platform=darwin] .dsm-head{padding-top:calc(28px + var(--dsh-frame-top-clearance,0px))}
.dsm-title{margin:0;font-size:20px;font-weight:500;line-height:28px}
.dsm-intro{margin:4px 0 0;font-size:13px;line-height:20px;color:var(--dsw-alias-label-secondary)}
.dsm-summary{margin:6px 0 0;font-size:12px;line-height:18px;color:var(--dsw-alias-label-caption);font-variant-numeric:tabular-nums}
.dsm-toolbar{display:flex;align-items:center;gap:12px;flex:none}
.dsm-chips{display:flex;align-items:center;gap:6px;flex-wrap:wrap}
.dsm-chip{font-size:11px;line-height:18px;padding:0 8px;border-radius:var(--dsw-radius-sm);border:0.5px solid var(--dsw-alias-border-l3);color:var(--dsw-alias-label-secondary)}
.dsm-chip-warn{color:var(--dsw-alias-state-warn-primary);border-color:var(--dsw-alias-state-warn-primary)}
.dsm-chip-danger{color:var(--dsw-alias-state-error-primary);border-color:var(--dsw-alias-state-error-primary)}
.dsm-seg{display:flex;align-items:center;gap:2px;padding:2px;border-radius:var(--dsw-radius-sm);background:var(--dsw-alias-bg-layer-2)}
.dsm-segBtn{box-sizing:border-box;border:none;background:transparent;color:var(--dsw-alias-label-secondary);font-family:inherit;font-size:12px;line-height:18px;height:24px;padding:0 10px;border-radius:var(--dsw-radius-sm);cursor:pointer;white-space:nowrap}
.dsm-segBtn:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover)}
.dsm-segBtn:disabled{cursor:not-allowed;opacity:.4}
.dsm-segOn{background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);font-weight:500}
.dsm-tools{display:flex;align-items:center;gap:8px;flex-wrap:wrap}
.dsm-input{box-sizing:border-box;flex:1;min-width:180px;height:32px;padding:0 10px;font-family:inherit;font-size:13px;color:var(--dsw-alias-label-primary);background:var(--dsw-alias-bg-layer-1);border:0.5px solid var(--dsw-alias-border-l3);border-radius:var(--dsw-radius-sm)}
.dsm-input:focus{outline:none;border-color:var(--dsw-alias-brand-primary)}
.dsm-input::placeholder{color:var(--dsw-alias-label-caption)}
.dsm-select{box-sizing:border-box;height:32px;padding:0 8px;font-family:inherit;font-size:13px;color:var(--dsw-alias-label-primary);background:var(--dsw-alias-bg-layer-1);border:0.5px solid var(--dsw-alias-border-l3);border-radius:var(--dsw-radius-sm)}
.dsm-batch{display:flex;align-items:center;gap:10px;flex-wrap:wrap;padding:8px 12px;border-radius:var(--dsw-radius-md);border:0.5px solid var(--dsw-alias-border-l3);background:var(--dsw-alias-bg-layer-2)}
.dsm-batchText{font-size:13px;line-height:20px}
.dsm-batchHint{font-size:12px;line-height:18px;color:var(--dsw-alias-state-warn-primary)}
.dsm-group{display:flex;flex-direction:column;gap:8px}
.dsm-groupHead{display:flex;align-items:baseline;gap:8px;flex-wrap:wrap}
.dsm-groupTitle{margin:0;font-size:14px;font-weight:500;line-height:22px;word-break:break-all}
.dsm-count{font-size:14px;color:var(--dsw-alias-label-caption);font-variant-numeric:tabular-nums}
.dsm-muted{color:var(--dsw-alias-label-tertiary);font-size:13px;line-height:20px;margin:0}
.dsm-card{display:flex;align-items:center;gap:10px;padding:9px 12px;border:0.5px solid var(--dsw-alias-border-l3);border-radius:var(--dsw-radius-md);background:var(--dsw-alias-bg-layer-1)}
.dsm-cardSel{border-color:var(--dsw-alias-brand-primary)}
.dsm-cardMain{min-width:0;flex:1}
.dsm-cardTitle{display:flex;align-items:center;gap:6px;font-size:14px;font-weight:500;line-height:22px}
.dsm-name{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.dsm-cardMeta{margin-top:2px;font-size:12px;line-height:18px;color:var(--dsw-alias-label-tertiary);word-break:break-all}
.dsm-actions{display:flex;align-items:center;gap:6px;flex:none;flex-wrap:wrap;justify-content:flex-end}
.dsm-badge{flex:none;font-size:10px;line-height:16px;padding:0 6px;border-radius:var(--dsw-radius-sm);border:0.5px solid var(--dsw-alias-border-l3);color:var(--dsw-alias-label-secondary)}
.dsm-badge-live{color:var(--dsw-alias-state-warn-primary);border-color:var(--dsw-alias-state-warn-primary)}
.dsm-badge-unknown{color:var(--dsw-alias-label-caption);border-color:var(--dsw-alias-label-caption)}
.dsm-badge-lock{color:var(--dsw-alias-state-error-primary);border-color:var(--dsw-alias-state-error-primary)}
.dsm-check{box-sizing:border-box;flex:none;width:16px;height:16px;padding:0;margin:0;accent-color:var(--dsw-alias-brand-primary);cursor:pointer}
.dsm-check:disabled{cursor:not-allowed;opacity:.4}
.dsm-btn{box-sizing:border-box;display:inline-flex;align-items:center;justify-content:center;gap:4px;border:none;cursor:pointer;background:transparent;color:var(--dsw-alias-label-primary);font-family:inherit;font-size:12px;line-height:18px;height:28px;padding:0 10px;border-radius:var(--dsw-radius-sm);white-space:nowrap}
.dsm-btn:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover)}
.dsm-btn:active:not(:disabled){background:var(--dsw-alias-interactive-bg-active)}
.dsm-btn:disabled{cursor:not-allowed;opacity:.4}
.dsm-btn:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:1px}
.dsm-btn-outline{border:0.5px solid var(--dsw-alias-border-l3)}
.dsm-btn-danger{color:var(--dsw-alias-state-error-primary)}
.dsm-btn-danger:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover-danger)}
.dsm-btn-primary{background:var(--dsw-alias-button-primary-fill);color:var(--dsw-alias-label-primary-foreground)}
.dsm-btn-primary:hover:not(:disabled){background:var(--dsw-alias-button-primary-hover)}
.dsm-btnSm{height:24px;font-size:11px;padding:0 8px}
.dsm-notice{font-size:13px;line-height:20px;margin:0}
.dsm-notice-ok{color:var(--dsw-alias-state-success-primary)}
.dsm-notice-err{color:var(--dsw-alias-state-error-primary)}
.dsm-notice-warn{color:var(--dsw-alias-state-warn-primary)}
.dsm-divider{height:0.5px;background:var(--dsw-alias-border-l2);margin:2px 0}
.dsm-foot{margin:8px 0 0;font-size:11px;line-height:18px;color:var(--dsw-alias-label-caption);word-break:break-all}
.dsm-iconButton{border-radius:var(--dsw-radius-xs);cursor:pointer;width:16px;height:16px;color:var(--dsw-alias-label-tertiary);background:0 0;border:none;flex:none;justify-content:center;align-items:center;padding:0;display:inline-flex}
.dsm-iconButton:hover{color:var(--dsw-alias-label-primary)}
.dsm-iconButton:focus-visible{outline:2px solid var(--dsw-alias-state-business-primary);outline-offset:1px}
.dsm-tip{display:inline-flex;align-items:center;gap:8px;position:fixed;z-index:1090;width:max-content;max-width:50vw;padding:3px 7px;border-radius:var(--dsw-radius-sm);background:var(--dsw-alias-tooltip-bg);color:var(--dsw-static-neutral-bluish-00);font-size:13px;line-height:20px;white-space:pre-line;overflow-wrap:break-word;pointer-events:none;animation:dsm-fade 150ms ease-out}
.dsm-menuItemWrap{position:relative}
.dsm-menuItem{display:flex;align-items:center;gap:6px;width:100%;min-height:34px;padding:6px 8px;border:none;border-radius:var(--dsw-radius-md);background:transparent;cursor:pointer;font-family:inherit;font-size:13px;line-height:20px;color:var(--dsw-alias-label-primary);text-align:left}
.dsm-menuItem:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover)}
.dsm-menuItem:focus-visible:not(:disabled){background:var(--dsw-alias-interactive-bg-hover);outline:none}
.dsm-menuItem:disabled{opacity:.4;cursor:not-allowed}
.dsm-menuItemIcon{display:inline-flex;flex:none;width:14px;height:14px;align-items:center;justify-content:center;color:var(--dsw-alias-menu-icon)}
.dsm-menuItemLabel{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.dsm-menuItemDanger{color:var(--dsw-alias-state-error-primary)}
.dsm-menuItemDanger .dsm-menuItemIcon{color:var(--dsw-alias-state-error-primary)}
.dsm-menuItemDanger:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover-danger)}
.dsm-menuItemDanger:focus-visible:not(:disabled){background:var(--dsw-alias-interactive-bg-hover-danger);outline:none}
.dsm-modalRoot{pointer-events:auto;position:fixed;inset:0;z-index:1000;display:flex;align-items:center;justify-content:center;padding:max(24px,var(--dsh-frame-overlay-top,24px)) 24px}
.dsm-modalMask{position:absolute;inset:var(--dsh-frame-chrome-top,0px) 0 0;background:var(--dsw-alias-bg-mask-1)}
.dsm-dialog{box-sizing:border-box;position:relative;z-index:1;display:flex;flex-direction:column;gap:20px;width:min(380px,100%);padding:0 0 24px;overflow:hidden;border:0;border-radius:var(--dsw-radius-panel);background:var(--dsw-alias-bg-layer-2);box-shadow:var(--dsw-elevation-prominent);animation:dsm-fade var(--ds-transition-duration,150ms) ease-out}
.dsm-dialogWide{width:min(440px,100%)}
.dsm-dialogHeader{display:flex;align-items:center;justify-content:space-between;gap:8px;padding:22px 14px 12px 24px}
.dsm-dialogTitle{margin:0;font-size:16px;line-height:24px;font-weight:500;color:var(--dsw-alias-label-primary)}
.dsm-dialogClose{flex:none;display:inline-flex;align-items:center;justify-content:center;width:28px;height:28px;border:none;border-radius:var(--dsw-radius-sm);background:transparent;cursor:pointer;color:var(--dsw-alias-label-secondary)}
.dsm-dialogClose:hover{background:var(--dsw-alias-interactive-bg-hover)}
.dsm-dialogDescription{margin:0;padding:0 24px;font-size:14px;line-height:22px;color:var(--dsw-alias-label-primary)}
.dsm-dialogBody{display:flex;flex-direction:column;gap:12px;min-width:0;margin-top:20px;padding:0 24px}
.dsm-dialogFooter{display:flex;align-items:center;justify-content:flex-end;gap:8px;padding:0 24px}
.dsm-warning{display:flex;align-items:flex-start;gap:10px;color:var(--dsw-alias-label-secondary);font-size:14px;line-height:22px}
.dsm-warning p{margin:0}
.dsm-warningIcon{flex:none;margin-top:2px;color:var(--dsw-alias-state-error-primary)}
.dsm-fieldLabel{display:block;margin-bottom:6px;font-size:13px;line-height:20px;color:var(--dsw-alias-label-secondary)}
.dsm-affectedList{max-height:200px;overflow:auto;margin:8px 0 0;padding:8px 10px;list-style:none;border-radius:var(--dsw-radius-sm);background:var(--dsw-alias-bg-layer-1);font-size:12px;line-height:20px;color:var(--dsw-alias-label-secondary)}
.dsm-affectedRow{display:flex;justify-content:space-between;gap:12px}
.dsm-modalAction{min-width:72px}
.dsm-confirmAction{min-width:136px}
@keyframes dsm-fade{from{opacity:0}}
@media (prefers-reduced-motion:reduce){.dsm-tip,.dsm-dialog{animation:none}}
`

    // ───────────────────────── 工具 ─────────────────────────
    const formatBytes = (n) => {
      const v = Number(n) || 0
      if (v < 1024) return `${v} B`
      if (v < 1024 * 1024) return `${(v / 1024).toFixed(1)} KB`
      return `${(v / 1024 / 1024).toFixed(2)} MB`
    }
    const formatTime = (ms) => {
      if (!ms) return '—'
      try {
        return new Date(ms).toLocaleString()
      } catch {
        return String(ms)
      }
    }
    const formatStamp = (iso) => {
      if (!iso) return '—'
      try {
        return new Date(iso).toLocaleString()
      } catch {
        return String(iso)
      }
    }

    async function api(pathname, body, signal) {
      const init = { method: body === undefined ? 'GET' : 'POST', credentials: 'same-origin', cache: 'no-store', signal }
      if (body !== undefined) {
        init.headers = { 'Content-Type': 'application/json' }
        init.body = JSON.stringify(body)
      }
      const res = await fetch(`${API}${pathname}`, init)
      const text = await res.text()
      let data = null
      try {
        data = text ? JSON.parse(text) : null
      } catch {
        data = null
      }
      if (!res.ok || !data || data.ok !== true) {
        const message = (data && data.error) || `${res.status} ${res.statusText || ''}`.trim()
        throw new Error(message)
      }
      return data
    }

    // 页面与"行内入口"之间的最小通信：让行入口把某条会话交给面板确认，而不是自己去删。
    let pluginCtx = null
    let armRequest = null
    const bus = {
      listeners: new Set(),
      subscribe(fn) {
        this.listeners.add(fn)
        return () => this.listeners.delete(fn)
      },
      emit() {
        for (const fn of [...this.listeners]) {
          try {
            fn()
          } catch {
            /* 单个订阅者出错不影响其它 */
          }
        }
      },
    }
    function armAndOpen(sessionId, title) {
      armRequest = { sessionId, title: title ?? '', at: Date.now() }
      bus.emit()
      try {
        if (pluginCtx && pluginCtx.layout && typeof pluginCtx.layout.selectPanel === 'function') {
          pluginCtx.layout.selectPanel(PANEL_ID)
        }
      } catch {
        /* 面板打不开时至少把请求记下来，用户手动切过去也能看到 */
      }
    }

    function loadCollapsed() {
      try {
        const raw = localStorage.getItem(COLLAPSE_KEY)
        const parsed = raw ? JSON.parse(raw) : []
        return new Set(Array.isArray(parsed) ? parsed.map(String) : [])
      } catch {
        return new Set()
      }
    }
    function saveCollapsed(set) {
      try {
        localStorage.setItem(COLLAPSE_KEY, JSON.stringify([...set]))
      } catch {
        /* 隐私模式下不可写，忽略 */
      }
    }

    // ───────────────────────── 基础组件 ─────────────────────────
    function PanelIcon({ size }) {
      const px = typeof size === 'number' ? size : 16
      return h(
        'svg',
        {
          viewBox: '0 0 24 24',
          width: px,
          height: px,
          fill: 'none',
          stroke: 'currentColor',
          strokeWidth: 1.6,
          strokeLinecap: 'round',
          strokeLinejoin: 'round',
          'aria-hidden': true,
        },
        h('path', { d: 'M4 7h16' }),
        h('path', { d: 'M9 7V5.5A1.5 1.5 0 0 1 10.5 4h3A1.5 1.5 0 0 1 15 5.5V7' }),
        h('path', { d: 'M6.5 7l.8 11.2A2 2 0 0 0 9.3 20h5.4a2 2 0 0 0 2-1.8L17.5 7' }),
        h('path', { d: 'M10.5 11v5' }),
        h('path', { d: 'M13.5 11v5' }),
      )
    }

    function Button({ label, onClick, variant, disabled, title, small }) {
      const cls = ['dsm-btn']
      if (variant === 'outline') cls.push('dsm-btn-outline')
      if (variant === 'danger') cls.push('dsm-btn-danger')
      if (variant === 'primary') cls.push('dsm-btn-primary')
      if (small) cls.push('dsm-btnSm')
      const name = title ?? label
      return h(
        'button',
        { type: 'button', className: cls.join(' '), onClick, disabled, title: name, 'aria-label': name },
        label,
      )
    }

    // ── 设计系统图标的最小等价实现 ─────────────────────────────
    // 路径逐字取自内核 @deepseek-ai/dsh-client-ui-primitives 的图标产物（viewBox 16、
    // 1px 描边、currentColor），以保证与宿主其它图标同一套度量——插件不允许 import
    // 内核 Client 包，所以只能照抄形状。
    function SvgIcon({ size = 16, strokeWidth = 1, className, paths }) {
      return h(
        'svg',
        {
          width: size,
          height: size,
          className,
          viewBox: '0 0 16 16',
          fill: 'none',
          xmlns: 'http://www.w3.org/2000/svg',
          'aria-hidden': true,
          strokeWidth,
        },
        paths.map((d, index) => h('path', { key: index, d, stroke: 'currentColor' })),
      )
    }
    /** 等价于 IconTrashOutlineRegular。 */
    const TrashIcon = (props) =>
      h(SvgIcon, {
        ...props,
        paths: [
          'M1.28149 3.88831H14.7187',
          'M5.41602 3.88833V2.47962C5.41602 2.29282 5.52492 2.11366 5.71876 1.98157C5.9126 1.84948 6.17551 1.77527 6.44964 1.77527H9.55053C9.82466 1.77527 10.0876 1.84948 10.2814 1.98157C10.4753 2.11366 10.5842 2.29282 10.5842 2.47962V3.88833',
          'M2.57349 3.88831L3.19366 13.2943C3.21937 13.5502 3.33952 13.7872 3.53065 13.9593C3.72178 14.1313 3.97016 14.2259 4.22729 14.2246H11.7728C12.0299 14.2259 12.2783 14.1313 12.4694 13.9593C12.6605 13.7872 12.7807 13.5502 12.8064 13.2943L13.4266 3.88831',
          'M6.44946 6.98926V11.1238',
          'M9.55054 6.98926V11.1238',
        ],
      })
    /** 等价于 IconWarningOutlineRegular。 */
    const WarningIcon = (props) =>
      h(SvgIcon, {
        ...props,
        paths: [
          'M8 14.5C11.5899 14.5 14.5 11.5899 14.5 8C14.5 4.41015 11.5899 1.5 8 1.5C4.41015 1.5 1.5 4.41015 1.5 8C1.5 11.5899 4.41015 14.5 8 14.5Z',
          'M8 4.29199V9.79199',
          'M8 10.708V11.708',
        ],
      })
    /** 等价于 IconCloseOutlineRegular。 */
    const CloseIcon = (props) => h(SvgIcon, { ...props, paths: ['M2.5 2.5L13.5 13.5', 'M13.5 2.5L2.5 13.5'] })

    /**
     * 设计系统 Tooltip 的最小等价实现：fixed 定位气泡、底部右对齐、悬停 500ms 后出现。
     * 内核会话行按钮用的就是这套参数（`side: 'bottom', align: 'end', delayMs: 500`，gap 8）。
     * 只用于 DOM 子元素（行内按钮），不支持函数组件子元素。
     */
    function DsTooltip({ label, children }) {
      const [pos, setPos] = React.useState(null)
      const anchorRef = React.useRef(null)
      const timer = React.useRef(null)
      const hide = () => {
        if (timer.current) {
          clearTimeout(timer.current)
          timer.current = null
        }
        setPos(null)
      }
      const schedule = () => {
        if (timer.current) return
        timer.current = setTimeout(() => {
          timer.current = null
          const node = anchorRef.current
          if (!node || typeof node.getBoundingClientRect !== 'function') return
          const rect = node.getBoundingClientRect()
          setPos({ left: rect.right, top: rect.bottom + 8 })
        }, 500)
      }
      React.useEffect(
        () => () => {
          if (timer.current) clearTimeout(timer.current)
        },
        [],
      )
      React.useEffect(() => {
        if (pos === null) return undefined
        const dismiss = () => hide()
        window.addEventListener('scroll', dismiss, true)
        window.addEventListener('resize', dismiss)
        document.addEventListener('mousedown', dismiss, true)
        return () => {
          window.removeEventListener('scroll', dismiss, true)
          window.removeEventListener('resize', dismiss)
          document.removeEventListener('mousedown', dismiss, true)
        }
      }, [pos])
      const child = React.Children.only(children)
      const anchor = React.cloneElement(child, {
        ref: (node) => {
          anchorRef.current = node
          const inner = child.ref
          if (typeof inner === 'function') inner(node)
          else if (inner) inner.current = node
        },
        onMouseEnter: (event) => {
          if (child.props.onMouseEnter) child.props.onMouseEnter(event)
          schedule()
        },
        onMouseLeave: (event) => {
          if (child.props.onMouseLeave) child.props.onMouseLeave(event)
          hide()
        },
        onFocus: (event) => {
          if (child.props.onFocus) child.props.onFocus(event)
          schedule()
        },
        onBlur: (event) => {
          if (child.props.onBlur) child.props.onBlur(event)
          hide()
        },
      })
      return h(
        React.Fragment,
        null,
        anchor,
        pos
          ? h(
              'div',
              {
                className: 'dsm-tip',
                role: 'tooltip',
                style: { left: `${pos.left}px`, top: `${pos.top}px`, transform: 'translateX(-100%)' },
              },
              label,
            )
          : null,
      )
    }
    function Chip({ children, tone }) {
      const cls = ['dsm-chip']
      if (tone === 'warn') cls.push('dsm-chip-warn')
      if (tone === 'danger') cls.push('dsm-chip-danger')
      return h('span', { className: cls.join(' ') }, children)
    }

    function Segmented({ value, options, onChange, label }) {
      return h(
        'div',
        { className: 'dsm-seg', role: 'group', 'aria-label': label },
        options.map((option) =>
          h(
            'button',
            {
              key: option.value,
              type: 'button',
              className: `dsm-segBtn${option.value === value ? ' dsm-segOn' : ''}`,
              onClick: () => onChange(option.value),
              'aria-pressed': option.value === value,
            },
            option.label,
          ),
        ),
      )
    }

    /**
     * 破坏性操作确认弹窗。
     * @param items 受影响条目 [{ label, sub }]
     * @param typedWord 需要输入的确认词（可空 = 不需要）
     * @param danger 是否用危险色强调后果
     */
    /**
     * 破坏性操作确认弹窗。
     * 结构照抄内核的 Modal + RiskConfirmation：mask（bg-mask-1）+ dialog（radius-panel、
     * bg-layer-2、prominent 阴影、380/440 宽）、header（标题 16/24 w500 + 28px 关闭按钮）、
     * description（14/22）、body、footer（右对齐、gap 8、取消 min-width 72 / 确认 min-width 136）。
     * 设计系统的 Button **没有** danger 变体，危险感由 warning 图标（error 色）+ 文案承担，
     * 确认按钮用 primary —— 与 RiskConfirmation 一致。
     * 摩擦分级（Pajamas）：可还原 → 无 warning；不可恢复 → warning；达到策略阈值 → 追加确认词。
     */
    function ConfirmDialog({
      title,
      description,
      warning,
      items,
      totalSizeLabel,
      typedWord,
      confirmLabel,
      cancelLabel,
      closeLabel,
      willAffectLabel,
      andMoreLabel,
      typedLabel,
      typedPlaceholder,
      onCancel,
      onConfirm,
      busy,
    }) {
      const [typed, setTyped] = React.useState('')
      const inputRef = React.useRef(null)
      const confirmRef = React.useRef(null)
      const ready = !typedWord || typed.trim() === typedWord

      React.useEffect(() => {
        const target = typedWord ? inputRef.current : confirmRef.current
        if (target && typeof target.focus === 'function') target.focus()
      }, [typedWord])

      React.useEffect(() => {
        const onKey = (event) => {
          if (event.key === 'Escape') {
            event.stopPropagation()
            onCancel()
          }
        }
        document.addEventListener('keydown', onKey, true)
        return () => document.removeEventListener('keydown', onKey, true)
      }, [onCancel])

      const shown = items.slice(0, 8)
      const hidden = items.length - shown.length
      const wide = items.length > 0 || Boolean(typedWord)

      return h(
        'div',
        {
          className: 'dsm-modalRoot',
          onMouseDown: (event) => {
            if (event.target === event.currentTarget) onCancel()
          },
        },
        h('div', { className: 'dsm-modalMask' }),
        h(
          'div',
          {
            className: `dsm-dialog${wide ? ' dsm-dialogWide' : ''}`,
            role: 'dialog',
            'aria-modal': 'true',
            'aria-label': title,
          },
          h(
            'div',
            { className: 'dsm-dialogHeader' },
            h('h2', { className: 'dsm-dialogTitle' }, title),
            h(
              'button',
              {
                type: 'button',
                className: 'dsm-dialogClose',
                'aria-label': closeLabel,
                title: closeLabel,
                onClick: onCancel,
              },
              h(CloseIcon, { size: 16 }),
            ),
          ),
          description ? h('p', { className: 'dsm-dialogDescription' }, description) : null,
          h(
            'div',
            { className: 'dsm-dialogBody' },
            warning
              ? h(
                  'div',
                  { className: 'dsm-warning' },
                  h(WarningIcon, { size: 18, className: 'dsm-warningIcon' }),
                  h('p', null, warning),
                )
              : null,
            items.length
              ? h(
                  'div',
                  null,
                  h('p', { className: 'dsm-dialogDescription', style: { padding: 0 } }, willAffectLabel),
                  h(
                    'ul',
                    { className: 'dsm-affectedList' },
                    shown.map((item, index) =>
                      h(
                        'li',
                        { key: `${item.label}-${index}`, className: 'dsm-affectedRow' },
                        h('span', { className: 'dsm-name' }, item.label),
                        item.sub ? h('span', null, item.sub) : null,
                      ),
                    ),
                    hidden > 0 ? h('li', { className: 'dsm-affectedRow' }, andMoreLabel(items.length, hidden)) : null,
                  ),
                )
              : null,
            totalSizeLabel ? h('p', { className: 'dsm-dialogDescription', style: { padding: 0 } }, totalSizeLabel) : null,
            typedWord
              ? h(
                  'div',
                  null,
                  h('label', { className: 'dsm-fieldLabel', htmlFor: 'dsm-confirm-word' }, typedLabel(typedWord)),
                  h('input', {
                    id: 'dsm-confirm-word',
                    ref: inputRef,
                    className: 'dsm-input',
                    type: 'text',
                    value: typed,
                    placeholder: typedPlaceholder,
                    'aria-label': typedLabel(typedWord),
                    onChange: (event) => setTyped(event.target.value),
                  }),
                )
              : null,
          ),
          h(
            'div',
            { className: 'dsm-dialogFooter' },
            h(
              'button',
              { type: 'button', className: 'dsm-btn dsm-btn-outline dsm-modalAction', onClick: onCancel, disabled: busy },
              cancelLabel,
            ),
            h(
              'button',
              {
                ref: confirmRef,
                type: 'button',
                className: 'dsm-btn dsm-btn-primary dsm-confirmAction',
                onClick: () => onConfirm(typedWord ? typed.trim() : undefined),
                disabled: busy || !ready,
                title: confirmLabel,
                'aria-label': confirmLabel,
              },
              confirmLabel,
            ),
          ),
        ),
      )
    }
    // ───────────────────────── 行内入口（第二 / 第三个入口）─────────────────────────
    // 与内核自己注册到同一插槽的 archive / pin 条目保持同一套度量：
    //   行按钮 → .iconButton（16×16、圆角 xs、tertiary→primary、悬停只变色不加背景）
    //            外面套 Tooltip（side=bottom / align=end / delayMs=500 / gap=8）
    //   菜单项 → MenuItemButton 的结构：itemWrap > button[role=menuitem] > itemIcon + itemLabel
    // 内核通过 hookContext 把菜单开合钩子交给条目，形状是 [open, setOpen]。
    function closeMenu(props) {
      try {
        const candidate = typeof props.useMenuOpenState === 'function' ? props.useMenuOpenState() : props.hookContext
        const setter = Array.isArray(candidate)
          ? candidate[1]
          : typeof candidate === 'function'
            ? candidate
            : candidate && candidate.setOpen
        if (typeof setter === 'function') setter(false)
      } catch {
        /* 关不掉菜单不影响删除流程 */
      }
    }

    function RowDeleteAction(props) {
      const t = props && typeof props.t === 'function' ? props.t : (key) => fallbackText[key] ?? key
      const sessionId = props && props.sessionId
      if (!sessionId) return null
      return h(
        DsTooltip,
        { label: t('rowAction') },
        h(
          'button',
          {
            type: 'button',
            className: 'dsm-iconButton',
            'aria-label': t('rowAction'),
            onClick: (event) => {
              event.preventDefault()
              event.stopPropagation()
              armAndOpen(sessionId, props.displayTitle)
            },
          },
          h(TrashIcon, { size: 14 }),
        ),
      )
    }

    function MenuDeleteItem(props) {
      const t = props && typeof props.t === 'function' ? props.t : (key) => fallbackText[key] ?? key
      const sessionId = props && props.sessionId
      if (!sessionId) return null
      return h(
        'div',
        { className: 'dsm-menuItemWrap' },
        h(
          'button',
          {
            type: 'button',
            role: 'menuitem',
            className: 'dsm-menuItem dsm-menuItemDanger',
            'aria-label': t('rowMenu'),
            onClick: (event) => {
              event.preventDefault()
              event.stopPropagation()
              closeMenu(props)
              armAndOpen(sessionId, props.displayTitle)
            },
          },
          h('span', { className: 'dsm-menuItemIcon' }, h(TrashIcon, { size: 14 })),
          h('span', { className: 'dsm-menuItemLabel' }, t('rowMenu')),
        ),
      )
    }
    // ───────────────────────── 主页面 ─────────────────────────
    function SessionManagerPage(props) {
      const t = props && typeof props.t === 'function'
        ? props.t
        : (key, vars) => {
            const raw = fallbackText[key] ?? key
            if (!vars) return raw
            return Object.keys(vars).reduce((acc, k) => acc.replace(`{${k}}`, String(vars[k])), raw)
          }
      const [state, setState] = React.useState({ status: 'loading', data: null })
      const [busy, setBusy] = React.useState(false)
      const [notice, setNotice] = React.useState(null)
      const [query, setQuery] = React.useState('')
      const [category, setCategory] = React.useState('all')
      const [sort, setSort] = React.useState('updated')
      const [selected, setSelected] = React.useState(() => new Set())
      const [selectedTrash, setSelectedTrash] = React.useState(() => new Set())
      const [confirm, setConfirm] = React.useState(null)
      const [collapsed, setCollapsed] = React.useState(loadCollapsed)
      const alive = React.useRef(true)
      const stateRef = React.useRef(state)

      React.useEffect(() => {
        stateRef.current = state
      }, [state])

      React.useEffect(() => () => {
        alive.current = false
      }, [])

      const load = React.useCallback(async (signal, { silent = false } = {}) => {
        if (!silent) setBusy(true)
        try {
          const data = await api('/list', undefined, signal)
          if (alive.current) setState({ status: 'ready', data })
        } catch (err) {
          if (err && err.name === 'AbortError') return
          if (alive.current && !silent) {
            setState((prev) => ({ status: 'error', error: String(err && err.message ? err.message : err), data: prev.data }))
          }
        } finally {
          if (alive.current && !silent) setBusy(false)
        }
      }, [])

      React.useEffect(() => {
        const controller = new AbortController()
        load(controller.signal)
        return () => controller.abort()
      }, [load])

      React.useEffect(() => {
        const timer = setInterval(() => {
          if (!document.hidden) load(undefined, { silent: true })
        }, POLL_MS)
        return () => clearInterval(timer)
      }, [load])

      // 行内入口（悬停按钮 / 右键菜单）把某条会话交过来：直接进确认弹窗
      React.useEffect(() => {
        const consume = () => {
          if (!armRequest) return
          const request = armRequest
          armRequest = null
          const found = stateRef.current?.data?.sessions?.find((s) => s.id === request.sessionId)
          if (!found) {
            setNotice({ kind: 'warn', text: t('armed') })
            return
          }
          if (!found.deletable) {
            setNotice({ kind: 'warn', text: `${found.title || found.id}：${blockedLabel(found.blockedReason)}` })
            return
          }
          setSelected(new Set())
          askTrash([found])
        }
        const unsubscribe = bus.subscribe(consume)
        consume()
        return unsubscribe
      }, [])

      React.useEffect(() => {
        if (!notice) return undefined
        const timer = setTimeout(() => {
          if (alive.current) setNotice(null)
        }, NOTICE_MS)
        return () => clearTimeout(timer)
      }, [notice])

      const run = async (okText, fn) => {
        setBusy(true)
        setConfirm(null)
        try {
          const result = await fn()
          if (alive.current) {
            setNotice({ kind: 'ok', text: typeof okText === 'function' ? okText(result) : okText })
            setSelected(new Set())
            setSelectedTrash(new Set())
          }
          await load()
        } catch (err) {
          if (alive.current) {
            setNotice({ kind: 'err', text: `${t('failed')}：${String(err && err.message ? err.message : err)}` })
          }
        } finally {
          if (alive.current) setBusy(false)
        }
      }

      const copyId = async (id) => {
        try {
          if (!navigator.clipboard || !navigator.clipboard.writeText) throw new Error('clipboard unavailable')
          await navigator.clipboard.writeText(id)
          setNotice({ kind: 'ok', text: t('copied') })
        } catch {
          setNotice({ kind: 'err', text: t('copyFailed') })
        }
      }

      const data = state.data
      const policy = data?.policy ?? null
      const pendingIds = new Set((data?.pending ?? []).map((p) => p.sessionId))

      // 低严重度（可还原）：不加摩擦，只弹出"将影响哪些"的确认
      const askTrash = (items) => {
        setConfirm({
          kind: 'trash',
          items,
          title: t('confirmTrashTitle', { n: items.length }),
          description: t('confirmTrashBody'),
          danger: false,
          confirmLabel: t('batchTrash'),
          onConfirm: () =>
            run(
              (result) =>
                result.failed > 0
                  ? t('deletedPartial', { ok: result.ok, failed: result.failed })
                  : items.length === 1
                    ? t('deleted')
                    : t('deletedN', { n: result.ok }),
              () =>
                items.length === 1
                  ? api('/delete', { id: items[0].id })
                  : api('/delete-batch', { ids: items.map((x) => x.id), confirmCount: items.length }),
            ),
        })
      }

      const askPurge = (items) => {
        const needWord = items.length >= (policy?.requireTypedConfirmAt ?? 3)
        setConfirm({
          kind: 'purge',
          items,
          title: t('confirmPurgeTitle', { n: items.length }),
          description: t('confirmPurgeBody'),
          warning: t('warnIrreversible'),
          danger: true,
          typedWord: needWord ? policy?.purgeConfirmWord ?? 'PURGE' : '',
          confirmLabel: t('batchPurge'),
          onConfirm: (typed) =>
            run(
              (result) => (items.length === 1 ? t('purged') : t('purgedN', { n: result.ok })),
              () =>
                items.length === 1
                  ? api('/purge', { entryId: items[0].entryId })
                  : api('/purge-batch', {
                      entryIds: items.map((x) => x.entryId),
                      confirmCount: items.length,
                      typedConfirm: typed,
                    }),
            ),
        })
      }

      const askPurgeAll = (count, skipCount) => {
        setConfirm({
          kind: 'purge-all',
          items: [],
          title: t('confirmPurgeAllTitle', { n: count }),
          description: skipCount
            ? `${t('confirmPurgeAllBody')} ${t('purgeAllSkipHint', { n: skipCount })}`
            : t('confirmPurgeAllBody'),
          warning: t('warnIrreversible'),
          danger: true,
          typedWord: policy?.purgeConfirmWord ?? 'PURGE',
          confirmLabel: t('purgeAll'),
          onConfirm: (typed) =>
            run(
              (result) =>
                result.skipped?.length
                  ? t('purgedAllPartial', { n: result.count, m: result.skipped.length })
                  : t('purgeAllDone'),
              () => api('/purge-all', { confirmCount: count, typedConfirm: typed }),
            ),
        })
      }

      if (state.status === 'loading' && !data) {
        return h('div', { className: 'dsm-page' }, h('p', { className: 'dsm-muted' }, t('loading')))
      }

      if (state.status === 'error' && !data) {
        return h(
          'div',
          { className: 'dsm-page' },
          h('div', { className: 'dsm-head' },
            h('div', null,
              h('h1', { className: 'dsm-title' }, t('title')),
              h('p', { className: 'dsm-intro' }, t('intro')))),
          h('p', { className: 'dsm-notice dsm-notice-err' }, t('unreachable', { error: state.error })),
          h('p', { className: 'dsm-muted' }, t('unreachableHint')),
          h('div', { className: 'dsm-group' },
            h(Button, { label: t('refresh'), variant: 'outline', onClick: () => load(), disabled: busy })),
        )
      }

      const sessions = data?.sessions ?? []
      const trash = data?.trash ?? []
      const pending = data?.pending ?? []
      const totalBytes = sessions.reduce((sum, s) => sum + (Number(s.bytes) || 0), 0)
      const needle = query.trim().toLowerCase()

      const matchesCategory = (s) => {
        switch (category) {
          case 'main': return s.kind !== 'subagent'
          case 'subagent': return s.kind === 'subagent'
          case 'archived': return Boolean(s.archived)
          case 'pinned': return Boolean(s.pinned)
          case 'blocked': return !s.deletable
          default: return true
        }
      }
      const filtered = sessions.filter((s) => {
        if (!matchesCategory(s)) return false
        if (!needle) return true
        return (
          String(s.title ?? '').toLowerCase().includes(needle) ||
          String(s.id ?? '').toLowerCase().includes(needle) ||
          String(s.workspacePath ?? '').toLowerCase().includes(needle)
        )
      })

      const sorted = [...filtered].sort((a, b) => {
        if (sort === 'size') return (Number(b.bytes) || 0) - (Number(a.bytes) || 0)
        if (sort === 'title') return String(a.title ?? a.id).localeCompare(String(b.title ?? b.id))
        if (sort === 'workspace') {
          const wa = String(a.workspacePath ?? a.workspaceTitle ?? '')
          const wb = String(b.workspacePath ?? b.workspaceTitle ?? '')
          const byWs = wa.localeCompare(wb)
          if (byWs !== 0) return byWs
        }
        return (b.updatedAt ?? 0) - (a.updatedAt ?? 0)
      })

      const groups = []
      const byKey = new Map()
      for (const s of sorted) {
        const key = s.workspacePath || s.workspaceTitle || ''
        let group = byKey.get(key)
        if (!group) {
          group = {
            key,
            title: s.workspaceTitle || s.workspacePath || t('noWorkspace'),
            path: s.workspacePath || '',
            items: [],
          }
          byKey.set(key, group)
          groups.push(group)
        }
        group.items.push(s)
      }

      const blockedLabel = (reason) => {
        switch (reason) {
          case 'live': return t('live')
          case 'unknown': return t('unknown')
          case 'disabled': return t('reasonDisabled')
          case 'protected': return t('reasonProtected')
          case 'subagent-protected': return t('reasonSubagentProtected')
          case 'pinned-protected': return t('reasonPinnedProtected')
          case 'archived-protected': return t('reasonArchivedProtected')
          default: return t('protected')
        }
      }

      const toggle = (setter, id) => {
        setter((prev) => {
          const next = new Set(prev)
          if (next.has(id)) next.delete(id)
          else next.add(id)
          return next
        })
      }
      const toggleGroup = (group) => {
        const deletable = group.items.filter((s) => s.deletable).map((s) => s.id)
        setSelected((prev) => {
          const next = new Set(prev)
          const allSelected = deletable.every((id) => next.has(id))
          for (const id of deletable) {
            if (allSelected) next.delete(id)
            else next.add(id)
          }
          return next
        })
      }
      const selectAllFiltered = () => {
        const ids = sorted.filter((s) => s.deletable).map((s) => s.id)
        setSelected(new Set(ids))
        const skipped = sorted.length - ids.length
        if (skipped > 0) setNotice({ kind: 'warn', text: t('selectedBlocked', { n: skipped }) })
      }
      const toggleCollapse = (key) => {
        setCollapsed((prev) => {
          const next = new Set(prev)
          if (next.has(key)) next.delete(key)
          else next.add(key)
          saveCollapsed(next)
          return next
        })
      }

      const selectedSessions = sessions.filter((s) => selected.has(s.id))
      const selectedBytes = selectedSessions.reduce((sum, s) => sum + (Number(s.bytes) || 0), 0)
      // 只有"没被策略挡住"的条目才允许被彻底删除 / 被全选
      const purgeableTrash = trash.filter((x) => !x.purgeBlockedReason && policy?.allowPurge !== false)
      const selectedTrashItems = purgeableTrash.filter((x) => selectedTrash.has(x.entryId))
      const selectedTrashBytes = selectedTrashItems.reduce((sum, x) => sum + (Number(x.bytes) || 0), 0)

      const policyChips = []
      if (policy) {
        if (!policy.enabled) policyChips.push(h(Chip, { key: 'ro', tone: 'danger' }, t('policyReadOnly')))
        if (!policy.allowPurge) policyChips.push(h(Chip, { key: 'np', tone: 'warn' }, t('policyNoPurge')))
        if (!policy.allowSubagentDelete) policyChips.push(h(Chip, { key: 'sp', tone: 'warn' }, t('policySubagentProtected')))
        if (policy.protectPinned) policyChips.push(h(Chip, { key: 'pp', tone: 'warn' }, t('policyProtectPinned')))
        if (policy.protectArchived) policyChips.push(h(Chip, { key: 'pa', tone: 'warn' }, t('policyProtectArchived')))
        if (policy.protectedSessionIds?.length) {
          policyChips.push(h(Chip, { key: 'pl' }, t('policyProtectedCount', { n: policy.protectedSessionIds.length })))
        }
        policyChips.push(
          h(Chip, { key: 'td' }, policy.trashKeepDays > 0 ? t('policyTrashDays', { n: policy.trashKeepDays }) : t('policyTrashForever')),
        )
        policyChips.push(h(Chip, { key: 'mb' }, t('policyBatchLimit', { n: policy.maxBatchSize })))
        policyChips.push(h(Chip, { key: 'tc' }, t('policyTypedConfirm', { n: policy.requireTypedConfirmAt })))
      }

      const sessionCard = (s) => {
        const badges = []
        if (s.liveness === 'live') badges.push(h('span', { key: 'live', className: 'dsm-badge dsm-badge-live' }, t('live')))
        if (s.liveness === 'unknown') badges.push(h('span', { key: 'unknown', className: 'dsm-badge dsm-badge-unknown' }, t('unknown')))
        if (s.kind === 'subagent') badges.push(h('span', { key: 'sub', className: 'dsm-badge' }, t('subagent')))
        if (s.archived) badges.push(h('span', { key: 'arch', className: 'dsm-badge' }, t('archived')))
        if (s.pinned) badges.push(h('span', { key: 'pin', className: 'dsm-badge' }, t('pinned')))
        if (!s.listed && s.kind !== 'subagent') badges.push(h('span', { key: 'un', className: 'dsm-badge' }, t('unlisted')))
        if (!s.deletable && s.liveness === 'free') {
          badges.push(h('span', { key: 'lock', className: 'dsm-badge dsm-badge-lock' }, t('protected')))
        }
        const meta = [`${t('size')} ${formatBytes(s.bytes)}`, `${t('updated')} ${formatTime(s.updatedAt)}`, s.id].join(' · ')
        const queued = pendingIds.has(s.id)
        const isLive = s.liveness !== 'free'
        return h(
          'div',
          { className: `dsm-card${selected.has(s.id) ? ' dsm-cardSel' : ''}`, key: s.id },
          h('input', {
            className: 'dsm-check',
            type: 'checkbox',
            checked: selected.has(s.id),
            disabled: !s.deletable || busy,
            title: s.deletable ? undefined : blockedLabel(s.blockedReason),
            'aria-label': s.title || s.id,
            onChange: () => toggle(setSelected, s.id),
          }),
          h('div', { className: 'dsm-cardMain' },
            h('div', { className: 'dsm-cardTitle' }, h('span', { className: 'dsm-name' }, s.title || t('untitled')), ...badges),
            h('div', { className: 'dsm-cardMeta' }, meta),
            isLive ? h('div', { className: 'dsm-cardMeta' }, s.liveness === 'live' ? t('liveHint') : t('unknownHint')) : null,
            !s.deletable && !isLive ? h('div', { className: 'dsm-cardMeta dsm-notice-err' }, blockedLabel(s.blockedReason)) : null),
          h('div', { className: 'dsm-actions' },
            h(Button, { label: 'id', title: t('copyId'), variant: 'outline', small: true, disabled: busy, onClick: () => copyId(s.id) }),
            isLive
              ? (policy?.enabled === false
                ? null // 只读模式下排队也没有意义（启动时同样会被策略拒绝）
                : queued
                  ? h(Button, { label: t('unqueue'), variant: 'outline', small: true, disabled: busy, onClick: () => run(t('queuedOff'), () => api('/unqueue', { id: s.id })) })
                  : h(Button, { label: t('queue'), variant: 'outline', small: true, disabled: busy, onClick: () => run(t('queued'), () => api('/queue', { id: s.id })) }))
              : h(Button, {
                  label: t('delete'),
                  variant: 'danger',
                  small: true,
                  disabled: busy || !s.deletable,
                  title: s.deletable ? t('delete') : blockedLabel(s.blockedReason),
                  onClick: () => askTrash([s]),
                })),
        )
      }

      const purgeBlockedText = (reason) => {
        switch (reason) {
          case 'disabled': return t('reasonDisabled')
          case 'purge-disabled': return t('policyNoPurge')
          case 'protected': return t('reasonProtected')
          case 'subagent-protected': return t('reasonSubagentProtected')
          case 'orphan': return t('reasonOrphan')
          default: return t('protected')
        }
      }

      const trashCard = (item) => {
        const meta = [`${t('size')} ${formatBytes(item.bytes)}`, `${t('deletedAt')} ${formatStamp(item.deletedAt)}`, item.sessionId].join(' · ')
        const blockedReason = item.purgeBlockedReason || (policy?.allowPurge === false ? 'purge-disabled' : null)
        const blocked = Boolean(blockedReason)
        const badges = []
        if (blocked) badges.push(h('span', { key: 'lock', className: 'dsm-badge dsm-badge-lock' }, t('protected')))
        if (item.complete === false) badges.push(h('span', { key: 'inc', className: 'dsm-badge dsm-badge-unknown' }, t('trashIncomplete')))
        return h(
          'div',
          { className: `dsm-card${selectedTrash.has(item.entryId) ? ' dsm-cardSel' : ''}`, key: item.entryId },
          h('input', {
            className: 'dsm-check',
            type: 'checkbox',
            checked: selectedTrash.has(item.entryId),
            disabled: busy || blocked,
            title: blocked ? purgeBlockedText(blockedReason) : undefined,
            'aria-label': item.title || item.sessionId,
            onChange: () => toggle(setSelectedTrash, item.entryId),
          }),
          h('div', { className: 'dsm-cardMain' },
            h('div', { className: 'dsm-cardTitle' }, h('span', { className: 'dsm-name' }, item.title || t('untitled')), ...badges),
            h('div', { className: 'dsm-cardMeta' }, meta),
            blocked ? h('div', { className: 'dsm-cardMeta dsm-notice-err' }, purgeBlockedText(blockedReason)) : null),
          h('div', { className: 'dsm-actions' },
            h(Button, { label: t('restore'), variant: 'outline', small: true, disabled: busy, onClick: () => run(t('restored'), () => api('/restore', { entryId: item.entryId })) }),
            h(Button, {
              label: t('purge'),
              variant: 'danger',
              small: true,
              disabled: busy || blocked,
              title: blocked ? purgeBlockedText(blockedReason) : t('purge'),
              onClick: () => askPurge([item]),
            })),
        )
      }

      const pendingCard = (item) =>
        h(
          'div',
          { className: 'dsm-card', key: item.sessionId },
          h('div', { className: 'dsm-cardMain' },
            h('div', { className: 'dsm-cardTitle' },
              h('span', { className: 'dsm-name' }, item.title || t('untitled')),
              item.live ? h('span', { className: 'dsm-badge dsm-badge-live' }, t('live')) : null),
            h('div', { className: 'dsm-cardMeta' }, `${item.sessionId} · ${formatStamp(item.requestedAt)}`)),
          h('div', { className: 'dsm-actions' },
            h(Button, { label: t('unqueue'), variant: 'outline', small: true, disabled: busy, onClick: () => run(t('queuedOff'), () => api('/unqueue', { id: item.sessionId })) })),
        )

      const dialog = confirm
        ? h(ConfirmDialog, {
            title: confirm.title,
            description: confirm.description,
            warning: confirm.warning,
            closeLabel: t('closeLabel'),
            items: confirm.items.map((x) => ({
              label: x.title || x.sessionId || x.id,
              sub: x.bytes !== undefined ? formatBytes(x.bytes) : undefined,
            })),
            totalSizeLabel: confirm.items.length
              ? t('totalSize', {
                  size: formatBytes(confirm.items.reduce((sum, x) => sum + (Number(x.bytes) || 0), 0)),
                })
              : null,
            typedWord: confirm.typedWord,
            danger: confirm.danger,
            confirmLabel: confirm.confirmLabel,
            cancelLabel: t('cancel'),
            willAffectLabel: t('willAffect'),
            andMoreLabel: (total, hidden) => t('andMore', { n: total, m: hidden }),
            typedLabel: (word) => t('typedConfirmLabel', { word }),
            typedPlaceholder: t('typedConfirmPlaceholder'),
            busy,
            onCancel: () => setConfirm(null),
            onConfirm: (typed) => confirm.onConfirm(typed),
          })
        : null

      const body = h(
        'div',
        { className: 'dsm-page' },
        h('div', { className: 'dsm-head' },
          h('div', null,
            h('h1', { className: 'dsm-title' }, t('title')),
            h('p', { className: 'dsm-intro' }, t('intro')),
            h('p', { className: 'dsm-summary' }, t('summary', { n: sessions.length, size: formatBytes(totalBytes), trash: trash.length }))),
          h('div', { className: 'dsm-toolbar' },
            h(Button, { label: t('refresh'), variant: 'outline', onClick: () => load(), disabled: busy }))),

        policyChips.length ? h('div', { className: 'dsm-chips' }, h('span', { className: 'dsm-muted' }, `${t('policy')}：`), ...policyChips) : null,
        notice
          ? h('p', { className: `dsm-notice ${notice.kind === 'ok' ? 'dsm-notice-ok' : notice.kind === 'warn' ? 'dsm-notice-warn' : 'dsm-notice-err'}` }, notice.text)
          : null,
        state.status === 'error' && data
          ? h('p', { className: 'dsm-notice dsm-notice-err' }, t('unreachable', { error: state.error }))
          : null,

        h('div', { className: 'dsm-tools' },
          h(Segmented, {
            label: t('category'),
            value: category,
            onChange: (value) => {
              setCategory(value)
              setSelected(new Set())
            },
            options: [
              { value: 'all', label: t('catAll') },
              { value: 'main', label: t('catMain') },
              { value: 'subagent', label: t('catSubagent') },
              { value: 'archived', label: t('catArchived') },
              { value: 'pinned', label: t('catPinned') },
              { value: 'blocked', label: t('catBlocked') },
            ],
          }),
          h('input', {
            className: 'dsm-input',
            type: 'search',
            value: query,
            placeholder: t('filter'),
            'aria-label': t('filter'),
            onChange: (event) => setQuery(event.target.value),
          }),
          h('select', {
            className: 'dsm-select',
            value: sort,
            'aria-label': t('sort'),
            onChange: (event) => setSort(event.target.value),
          },
            h('option', { value: 'updated' }, t('sortUpdated')),
            h('option', { value: 'size' }, t('sortSize')),
            h('option', { value: 'title' }, t('sortTitle')),
            h('option', { value: 'workspace' }, t('sortWorkspace'))),
          h(Button, { label: t('selectAll'), variant: 'outline', small: true, disabled: busy || sorted.length === 0, onClick: selectAllFiltered }),
          selected.size ? h(Button, { label: t('selectNone'), variant: 'outline', small: true, onClick: () => setSelected(new Set()) }) : null,
        ),

        selected.size
          ? h('div', { className: 'dsm-batch' },
              h('span', { className: 'dsm-batchText' }, t('selectedCount', { n: selectedSessions.length, size: formatBytes(selectedBytes) })),
              h(Button, {
                label: t('batchTrash'),
                variant: 'danger',
                disabled: busy || selectedSessions.length === 0 || policy?.enabled === false,
                onClick: () => askTrash(selectedSessions),
              }),
              h(Button, { label: t('selectNone'), variant: 'outline', onClick: () => setSelected(new Set()) }))
          : null,

        h('div', { className: 'dsm-divider' }),

        h('div', { className: 'dsm-group' },
          h('div', { className: 'dsm-groupHead' },
            h('h2', { className: 'dsm-groupTitle' }, t('sessions')),
            h('span', { className: 'dsm-count' }, needle || category !== 'all' ? `${sorted.length} / ${sessions.length}` : String(sessions.length))),
          sessions.length === 0
            ? h('p', { className: 'dsm-muted' }, t('empty'))
            : (sorted.length === 0
              ? h('p', { className: 'dsm-muted' }, t('emptyFiltered'))
              : groups.map((group) => {
                  const isCollapsed = collapsed.has(group.key)
                  const groupBytes = group.items.reduce((sum, s) => sum + (Number(s.bytes) || 0), 0)
                  return h('div', { className: 'dsm-group', key: group.key || 'unknown' },
                    h('div', { className: 'dsm-groupHead' },
                      h(Button, {
                        label: isCollapsed ? '▸' : '▾',
                        variant: 'outline',
                        small: true,
                        title: isCollapsed ? t('expand') : t('collapse'),
                        onClick: () => toggleCollapse(group.key),
                      }),
                      h('input', {
                        className: 'dsm-check',
                        type: 'checkbox',
                        disabled: busy || group.items.every((s) => !s.deletable),
                        checked: group.items.some((s) => s.deletable) && group.items.filter((s) => s.deletable).every((s) => selected.has(s.id)),
                        'aria-label': group.title,
                        onChange: () => toggleGroup(group),
                      }),
                      h('h3', { className: 'dsm-groupTitle' }, group.title),
                      h('span', { className: 'dsm-count' }, `${group.items.length} · ${formatBytes(groupBytes)}`),
                      group.path && group.path !== group.title ? h('span', { className: 'dsm-cardMeta' }, group.path) : null),
                    isCollapsed ? null : group.items.map(sessionCard))
                }))),

        h('div', { className: 'dsm-divider' }),

        h('div', { className: 'dsm-group' },
          h('div', { className: 'dsm-groupHead' },
            h('h2', { className: 'dsm-groupTitle' }, t('trash')),
            h('span', { className: 'dsm-count' }, String(trash.length)),
            trash.length > 0
              ? h('span', { style: { marginLeft: 'auto', display: 'flex', gap: '6px' } },
                  selectedTrash.size
                    ? [
                        h(Button, { key: 'r', label: t('batchRestore'), variant: 'outline', small: true, disabled: busy, onClick: () => run(t('restoredN', { n: selectedTrash.size }), () => api('/restore-batch', { entryIds: [...selectedTrash] })) }),
                        h(Button, {
                          key: 'p',
                          label: t('batchPurge'),
                          variant: 'danger',
                          small: true,
                          disabled: busy || purgeableTrash.length === 0,
                          title: purgeableTrash.length === 0 ? t('policyNoPurge') : t('batchPurge'),
                          onClick: () => askPurge(selectedTrashItems),
                        }),
                        h(Button, { key: 'c', label: t('selectNone'), variant: 'outline', small: true, onClick: () => setSelectedTrash(new Set()) }),
                      ]
                    : [
                        h(Button, { key: 'sa', label: t('selectAll'), variant: 'outline', small: true, disabled: busy || purgeableTrash.length === 0, onClick: () => setSelectedTrash(new Set(purgeableTrash.map((x) => x.entryId))) }),
                        h(Button, {
                          key: 'pa',
                          label: t('purgeAll'),
                          variant: 'danger',
                          small: true,
                          disabled: busy || purgeableTrash.length === 0,
                          title: purgeableTrash.length === 0 ? t('policyNoPurge') : t('purgeAll'),
                          onClick: () => askPurgeAll(trash.length, trash.length - purgeableTrash.length),
                        }),
                      ])
              : null),
          selectedTrash.size
            ? h('p', { className: 'dsm-muted' }, t('selectedCount', { n: selectedTrash.size, size: formatBytes(selectedTrashBytes) }))
            : null,
          trash.length === 0 ? h('p', { className: 'dsm-muted' }, t('trashEmpty')) : trash.map(trashCard)),

        pending.length > 0
          ? h('div', { className: 'dsm-group' },
              h('div', { className: 'dsm-groupHead' },
                h('h2', { className: 'dsm-groupTitle' }, t('pending')),
                h('span', { className: 'dsm-count' }, String(pending.length))),
              h('p', { className: 'dsm-muted' }, t('pendingHint')),
              pending.map(pendingCard))
          : null,

        data
          ? h('p', { className: 'dsm-foot' }, t('paths', { sessions: data.sessionsRoot, data: data.dataDir, log: data.logFile }))
          : null,
      )

      return dialog ? h(React.Fragment, null, body, dialog) : body
    }

    // ───────────────────────── 插件体 ─────────────────────────
    function apply(ctx) {
      pluginCtx = ctx
      ctx.effect(
        () => ctx.locale.register(NS, { zh, en }),
        'dsh-delete-guard: dictionaries',
      )
      const t = ctx.locale.bind(NS)

      ctx.effect(() => {
        const tag = document.createElement('style')
        tag.setAttribute('data-dsh-delete-guard', '')
        tag.textContent = CSS
        document.head.appendChild(tag)
        return () => {
          try {
            tag.remove()
          } catch {
            /* ignore */
          }
        }
      }, 'dsh-delete-guard: styles')

      // 入口 1：侧边栏面板
      ctx.slots.inject('sidebar.panellist', () =>
        ctx.slots.register(
          { name: 'sidebar.panellist', id: PANEL_ID, order: 20, label: () => t('panel'), locale: NS },
          PanelIcon,
        ),
      )
      ctx.slots.inject('main', () =>
        ctx.slots.register({ name: 'main', key: PANEL_ID, locale: NS }, SessionManagerPage),
      )

      // 入口 2/3：会话行的悬停按钮与右键菜单项（只把目标交给面板确认，不自行删除）
      ctx.slots.inject('sidebar.workspaces.session.row.action', () =>
        ctx.slots.register(
          { name: 'sidebar.workspaces.session.row.action', id: `${PANEL_ID}.delete`, order: 300, locale: NS },
          RowDeleteAction,
        ),
      )
      ctx.slots.inject('sidebar.workspaces.session.menu.item', () =>
        ctx.slots.register(
          { name: 'sidebar.workspaces.session.menu.item', id: `${PANEL_ID}.delete`, order: 600, locale: NS },
          MenuDeleteItem,
        ),
      )
    }

    return { inject: ['slots', 'locale', 'layout'], apply }
  },
})