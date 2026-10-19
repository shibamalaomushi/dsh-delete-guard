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
    const POLL_MS = 60000
    const ARM_TTL_MS = 120000
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
      pending: '待删除（需确认执行）',
      pendingAuto: '待删除（下次启动自动处理）',
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
      pendingHint: '这些会话不会在启动时静默删除；请在确认它们不再被使用后点击“执行排队删除”。',
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
      startupDeferred: '启动时保留了 {n} 条排队删除，未自动执行。',
      processPending: '执行排队删除',
      confirmProcessPendingTitle: '执行 {n} 条排队删除？',
      confirmProcessPendingBody: '这些会话会被移入回收站，之后仍可还原；仍在使用中的会话会被跳过。',
      processedN: '已执行 {n} 条排队删除。',
      processedPartial: '已执行 {n} 条，保留 {m} 条（仍在使用或暂时无法判定）。',
      refsPending: '引用待修复',
      ambiguous: 'id 重复',
      childSessions: '含 {n} 个子会话',
      unverified: '未在持久化索引中',
      repairQueued: '部分侧边栏引用将在下次启动重试修复。',
      logError: '审计日志写入失败：{error}',
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
      armExpired: '这次行内删除请求已过期，请重新点击会话行按钮。',
      armNotFound: '列表里找不到这条会话（可能已被删除）；没有执行任何操作。',
      armFailed: '无法定位这条会话；没有执行任何操作。',
      errConfigInvalid: '插件配置无效，所有删除已被阻止；请修正配置后重启。',
      errProtectionUnknown: '无法确认置顶/归档的权威状态，保护策略无法验证；请稍后重试。',
      errIdentityUnknown: '无法确认会话的真实身份，已拒绝删除；可先用诊断信息检查。',
      errIdentityMismatch: '目录 id 与宿主日志身份不一致，已拒绝删除。',
      errRootChanged: '会话根目录已变更；默认不迁移。请选择是否迁移到当前根目录。',
      errStale: '预览之后内容已变化；请刷新并重新确认。',
      errOccupied: '目标位置已有同名目录，未做还原。',
      errBroken: '回收站条目缺少正文或已损坏；需要显式强制清理。',
      errIncomplete: '回收站条目尚未完成搬移；请先查看启动恢复报告。',
      errRefsPending: '该条目还有未完成的侧边栏引用修复；请先重试修复。',
      errPendingCorrupt: '排队文件已损坏并已隔离；请检查后再操作。',
      errConfirmRequired: '缺少确认数量；请刷新后重试。',
      errActive: '这条会话仍有后台工作；请先停止，或排入待删除。',
      errActivityUnknown: '无法读取后台工作状态；请排入待删除。',
      errLive: '这条会话正在使用中；请切换会话或排入待删除。',
      errNotFound: '目标已不存在（可能已被其他操作处理）。',
      errAmbiguous: '会话 id 在多个工作区重复，无法安全判定。',
      errTooMany: '超过单次批量上限。',
      errAuditRequired: '强审计模式下审计日志写入失败，已拒绝彻底删除。',
      errUnsafeRoot: '数据目录包含链接或不在 DSH_HOME 内，已拒绝写入。',
      errWorkspaceMissing: '原工作区已不存在；正文已还原，但侧边栏引用未恢复。',
      errCrossDevice: '回收站与会话根不在同一磁盘卷，无法原子移动。',
      errKindUnknown: '无法确认会话类型，而子代理删除已被禁止。',
      errInProgress: '同一请求的删除尚未完成，请稍后刷新。',
      errGeneric: '操作失败。',
      activityKinds: '活动类型：{kinds}',
      childImpact: '其中 {n} 个子会话会保留为孤立记录（不会级联删除）。',
      queueAuto: '排入下次启动删除',
      queueManual: '排入待删除',
      queuedAuto: '已排入队列；下次启动会处理。',
      queuedManual: '已排入队列；需要在面板中确认执行。',
      pendingHintAuto: '这些会话会在下次启动应用时自动处理；仍在使用中的会被跳过。',
      pendingHintManual: '这些会话不会在启动时静默删除；请确认后点击“执行排队删除”。',
      policyQueuedAuto: '排队：下次启动自动处理',
      policyQueuedManual: '排队：需手动确认',
      partialRestore: '部分还原：{n} 个投影缓存仍保留在回收站。',
      restoredPartial: '已还原正文，但有 {n} 个缓存冲突被保留。',
      conflictRetained: '冲突副本保留在回收站，可重试或显式清理。',
      retryFailed: '仅重试失败项',
      batchFailedTitle: '有 {n} 条失败',
      batchPartialTitle: '完成，但有 {n} 条失败',
      detailsTitle: '逐项原因',
      orphansTitle: '异常条目',
      orphansHint: '这些目录没有可读且一致的 meta.json；插件不会自动处理。',
      orphanPurge: '清理异常条目',
      orphanPurgeTitle: '永久清理异常条目？',
      orphanPurgeBody: '该目录无法归属到会话，清理后不可恢复；请输入确认词。',
      orphanPurged: '异常条目已清理。',
      repairsTitle: '修复队列',
      repairsHint: '侧边栏引用的恢复/摘除失败会记录在这里，可重试。',
      retryRepairs: '重试修复',
      repairsDone: '修复重试完成。',
      sweepTitle: '上次自动清理',
      sweepHint: '没有自动清理记录。',
      sweepSummary: '删除 {removed} 条，跳过 {skipped} 条。',
      recoveryTitle: '启动恢复',
      recoveryHint: '没有需要展示的恢复动作。',
      diagnostics: '导出诊断信息',
      diagnosticsHint: '默认脱敏，不含正文、标题、路径或凭据。',
      diagnosticsDone: '诊断信息已导出。',
      diagnosticsFailed: '诊断信息导出失败。',
      selectedHidden: '已选 {n} 条中有 {m} 条不在当前筛选结果中。',
      batchLimitTitle: '超过批量上限',
      batchLimitHint: '单次最多 {n} 条；已选择前 {n} 条。',
      visibleSelected: '已选 {n} / 当前可见 {m}',
      busyHint: '正在提交；完成前不能关闭此对话框。',
      rootChangedTitle: '会话根目录已变更',
      rootChangedBody: '这条会话原来在 {original}，当前根是 {current}。默认不迁移。',
      relocateAction: '迁移到当前根',
      relocated: '已按选择迁移到当前会话根。',
      forcePurge: '强制清理损坏条目',
      forcePurgeTitle: '强制清理损坏条目？',
      forcePurgeBody: '这会删除回收站内无法完整还原的残留，且不可恢复；请输入确认词。',
      forcePurged: '损坏条目已强制清理。',
      configInvalidTitle: '配置无效',
      configInvalidBody: '插件检测到配置类型/范围错误，已阻止所有删除。请修正后重启应用。',
      projectionConflict: '{n} 个投影缓存因目标已存在而保留。',
      queueAction: '排入待删除',
      errConfirmWord: '确认词不正确。',
      errConfirmMismatch: '确认数量与当前列表不一致；请刷新后重试。',
      errPendingFull: '排队表已满；请先执行或取消排队。',
      errRepairFull: '修复队列已满；请先重试或清理修复项。',
      errWorkspaceReadonly: '工作区文件不可写或已被宿主更新；引用没有改动。',
      errWorkspaceChanged: '工作区文件已被宿主更新；引用没有改动。',
      errChanged: '目标在检查期间发生了变化；请刷新后重试。',
      errProjectionFailed: '投影缓存移动失败，已回滚。',
      errMoveFailed: '移入回收站失败。',
      errRestoreFailed: '还原失败。',
      errRefsFailed: '侧边栏引用更新失败。',
      errEmptyTrash: '回收站已经是空的。',
      errBadId: '会话 id 不合法。',
      errBadEntry: '回收站条目 id 不合法。',
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
      pending: 'Queued for deletion (needs confirmation)',
      pendingAuto: 'Queued for deletion (auto on next launch)',
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
      pendingHint: 'Queued sessions are not deleted silently at startup. Confirm they are no longer in use, then choose “Run queued deletions”.',
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
      startupDeferred: 'Kept {n} queued deletion(s) at startup; nothing was deleted silently.',
      processPending: 'Run queued deletions',
      confirmProcessPendingTitle: 'Run {n} queued deletion(s)?',
      confirmProcessPendingBody: 'They move to the trash and can still be restored. Sessions still in use are skipped.',
      processedN: 'Ran {n} queued deletion(s).',
      processedPartial: 'Ran {n}; kept {m} (still in use or temporarily unknown).',
      refsPending: 'references pending',
      ambiguous: 'duplicate id',
      childSessions: '{n} child session(s)',
      unverified: 'not in the persistence index',
      repairQueued: 'Some sidebar references will be repaired on the next launch.',
      logError: 'Audit log write failed: {error}',
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
      armExpired: 'This row request expired; click the session row button again.',
      armNotFound: 'That session is not in the list (it may already be gone); nothing was done.',
      armFailed: 'Could not locate that session; nothing was done.',
      errConfigInvalid: 'The plugin config is invalid; every deletion is blocked until it is fixed and the app restarts.',
      errProtectionUnknown: 'Pinned/archived state cannot be verified, so the protection policy cannot be enforced; retry later.',
      errIdentityUnknown: 'The session identity cannot be verified; deletion was refused. Check diagnostics first.',
      errIdentityMismatch: 'The directory id does not match the Host log identity; deletion was refused.',
      errRootChanged: 'The sessions root changed. Restore stays in place by default; choose whether to migrate.',
      errStale: 'The previewed content changed; refresh and confirm again.',
      errOccupied: 'The destination already has a directory with that name; nothing was restored.',
      errBroken: 'This trash entry has no payload or is damaged; an explicit forced cleanup is required.',
      errIncomplete: 'This trash entry has not finished moving; see the startup recovery report first.',
      errRefsPending: 'Sidebar reference repair is still pending for this entry; retry it first.',
      errPendingCorrupt: 'The pending file is corrupt and was quarantined; inspect it before continuing.',
      errConfirmRequired: 'The confirmation count is missing; refresh and retry.',
      errActive: 'The session still has background work; stop it or queue the deletion.',
      errActivityUnknown: 'Background work state is unreadable; queue the deletion instead.',
      errLive: 'The session is in use; switch sessions or queue the deletion.',
      errNotFound: 'The target no longer exists (another operation may have handled it).',
      errAmbiguous: 'The session id exists in multiple workspaces and cannot be resolved safely.',
      errTooMany: 'The single-batch limit was exceeded.',
      errAuditRequired: 'Strong audit mode is on and the audit append failed; permanent deletion was refused.',
      errUnsafeRoot: 'A data directory contains a link or is outside DSH_HOME; the write was refused.',
      errWorkspaceMissing: 'The original workspace is gone; the log was restored, but the sidebar reference was not.',
      errCrossDevice: 'The trash and the sessions root are on different volumes; an atomic move is impossible.',
      errKindUnknown: 'The session kind cannot be verified while subagent deletion is disabled.',
      errInProgress: 'A delete for the same request is still in progress; refresh shortly.',
      errGeneric: 'The operation failed.',
      activityKinds: 'Activity: {kinds}',
      childImpact: '{n} child session(s) will remain as orphan records (no cascade delete).',
      queueAuto: 'Queue for next launch',
      queueManual: 'Queue for deletion',
      queuedAuto: 'Queued; it will be processed on the next launch.',
      queuedManual: 'Queued; run it explicitly from the panel.',
      pendingHintAuto: 'These sessions are processed automatically on the next launch; sessions still in use are skipped.',
      pendingHintManual: 'These sessions are never deleted silently at startup; confirm and run them from the panel.',
      policyQueuedAuto: 'queue: auto on next launch',
      policyQueuedManual: 'queue: manual confirmation',
      partialRestore: 'Partial restore: {n} projection cache file(s) remain in the trash.',
      restoredPartial: 'The log was restored, but {n} cache conflict(s) were retained.',
      conflictRetained: 'Conflicting copies stay in the trash for retry or explicit cleanup.',
      retryFailed: 'Retry only failed items',
      batchFailedTitle: '{n} item(s) failed',
      batchPartialTitle: 'Completed with {n} failure(s)',
      detailsTitle: 'Per-item reasons',
      orphansTitle: 'Orphan entries',
      orphansHint: 'These directories have no readable, consistent meta.json; the plugin never handles them automatically.',
      orphanPurge: 'Clean orphan entry',
      orphanPurgeTitle: 'Permanently clean the orphan entry?',
      orphanPurgeBody: 'It cannot be attributed to a session and cannot be recovered; type the confirmation word.',
      orphanPurged: 'Orphan entry cleaned.',
      repairsTitle: 'Repair queue',
      repairsHint: 'Failed sidebar attach/detach operations are recorded here and can be retried.',
      retryRepairs: 'Retry repairs',
      repairsDone: 'Repair retry finished.',
      sweepTitle: 'Last automatic cleanup',
      sweepHint: 'No automatic cleanup has run yet.',
      sweepSummary: 'Removed {removed}; skipped {skipped}.',
      recoveryTitle: 'Startup recovery',
      recoveryHint: 'No recovery action to show.',
      diagnostics: 'Export diagnostics',
      diagnosticsHint: 'Redacted by default; no logs, titles, paths, or credentials.',
      diagnosticsDone: 'Diagnostics exported.',
      diagnosticsFailed: 'Could not export diagnostics.',
      selectedHidden: '{m} of {n} selected item(s) are outside the current filter.',
      batchLimitTitle: 'Batch limit exceeded',
      batchLimitHint: 'At most {n} per batch; the first {n} were selected.',
      visibleSelected: '{n} selected / {m} visible',
      busyHint: 'Submitting; the dialog cannot be closed until it finishes.',
      rootChangedTitle: 'Sessions root changed',
      rootChangedBody: 'This session was under {original}; the current root is {current}. Nothing is migrated by default.',
      relocateAction: 'Migrate to current root',
      relocated: 'Migrated to the current sessions root.',
      forcePurge: 'Force-clean damaged entry',
      forcePurgeTitle: 'Force-clean the damaged entry?',
      forcePurgeBody: 'This deletes unrecoverable leftovers inside the trash and cannot be undone; type the confirmation word.',
      forcePurged: 'Damaged entry force-cleaned.',
      configInvalidTitle: 'Invalid configuration',
      configInvalidBody: 'The plugin detected invalid config types/ranges and blocked every deletion. Fix the config and restart.',
      projectionConflict: '{n} projection cache file(s) were retained because the target exists.',
      queueAction: 'Queue for deletion',
      errConfirmWord: 'The confirmation word is incorrect.',
      errConfirmMismatch: 'The confirmation count no longer matches the current list; refresh and retry.',
      errPendingFull: 'The queue is full; run or cancel some entries first.',
      errRepairFull: 'The repair queue is full; retry or clear some entries first.',
      errWorkspaceReadonly: 'The workspace file is read-only or was updated by the Host; no reference was changed.',
      errWorkspaceChanged: 'The workspace file was updated by the Host; no reference was changed.',
      errChanged: 'The target changed while it was being checked; refresh and retry.',
      errProjectionFailed: 'Moving the projection cache failed; it was rolled back.',
      errMoveFailed: 'Moving the session to the trash failed.',
      errRestoreFailed: 'Restoring the session failed.',
      errRefsFailed: 'Updating the sidebar reference failed.',
      errEmptyTrash: 'The trash is already empty.',
      errBadId: 'The session id is invalid.',
      errBadEntry: 'The trash entry id is invalid.',
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
.dsm-notice{display:flex;flex-direction:column;align-items:flex-start;gap:6px;font-size:13px;line-height:20px;margin:0}
.dsm-noticeDetails{font-size:12px;line-height:18px;color:var(--dsw-alias-label-secondary)}
.dsm-noticeDetails ul,.dsm-noticeList{margin:4px 0 0;padding-left:18px}
.dsm-details{font-size:12px;line-height:18px;color:var(--dsw-alias-label-secondary)}
.dsm-details summary{cursor:pointer;color:var(--dsw-alias-label-primary)}
.dsm-commandIcon{display:inline-flex;flex:none;align-items:center;justify-content:center;width:14px;height:14px;color:var(--dsw-alias-menu-icon)}
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
.dsm-dialog{box-sizing:border-box;position:relative;z-index:1;display:flex;flex-direction:column;gap:20px;width:min(380px,100%);max-height:calc(100dvh - 48px);padding:0 0 24px;overflow:hidden;border:0;border-radius:var(--dsw-radius-panel);background:var(--dsw-alias-bg-layer-2);box-shadow:var(--dsw-elevation-prominent);animation:dsm-fade var(--ds-transition-duration,150ms) ease-out}
.dsm-dialogWide{width:min(440px,100%)}
.dsm-dialogHeader{display:flex;align-items:center;justify-content:space-between;gap:8px;padding:22px 14px 12px 24px}
.dsm-dialogTitle{margin:0;font-size:16px;line-height:24px;font-weight:500;color:var(--dsw-alias-label-primary)}
.dsm-dialogClose{flex:none;display:inline-flex;align-items:center;justify-content:center;width:28px;height:28px;border:none;border-radius:var(--dsw-radius-sm);background:transparent;cursor:pointer;color:var(--dsw-alias-label-secondary)}
.dsm-dialogClose:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover)}
.dsm-dialogDescription{margin:0;padding:0 24px;font-size:14px;line-height:22px;color:var(--dsw-alias-label-primary)}
.dsm-dialogBody{display:flex;flex-direction:column;gap:12px;min-width:0;min-height:0;overflow:auto;margin-top:20px;padding:0 24px}
.dsm-dialogFooter{display:flex;align-items:center;justify-content:flex-end;gap:8px;flex:none;padding:0 24px}
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
        const error = new Error(message)
        error.code = data && data.code
        error.status = res.status
        error.details = data && data.details
        throw error
      }
      return data
    }

    const ERROR_KEYS = {
      'config-invalid': 'errConfigInvalid',
      'protection-unknown': 'errProtectionUnknown',
      'identity-unknown': 'errIdentityUnknown',
      'identity-mismatch': 'errIdentityMismatch',
      'root-changed': 'errRootChanged',
      stale: 'errStale',
      occupied: 'errOccupied',
      broken: 'errBroken',
      incomplete: 'errIncomplete',
      'refs-pending': 'errRefsPending',
      'pending-corrupt': 'errPendingCorrupt',
      'confirm-required': 'errConfirmRequired',
      active: 'errActive',
      'activity-unknown': 'errActivityUnknown',
      live: 'errLive',
      'live-unknown': 'errLive',
      'not-found': 'errNotFound',
      ambiguous: 'errAmbiguous',
      'too-many': 'errTooMany',
      'audit-required': 'errAuditRequired',
      'unsafe-root': 'errUnsafeRoot',
      'workspace-missing': 'errWorkspaceMissing',
      'cross-device': 'errCrossDevice',
      'kind-unknown': 'errKindUnknown',
      'in-progress': 'errInProgress',
      'confirm-word': 'errConfirmWord',
      'confirm-mismatch': 'errConfirmMismatch',
      'pending-full': 'errPendingFull',
      'repair-full': 'errRepairFull',
      'workspace-readonly': 'errWorkspaceReadonly',
      'workspace-changed': 'errWorkspaceChanged',
      changed: 'errChanged',
      'projection-failed': 'errProjectionFailed',
      'move-failed': 'errMoveFailed',
      'restore-failed': 'errRestoreFailed',
      'refs-failed': 'errRefsFailed',
      'empty-trash': 'errEmptyTrash',
      'bad-id': 'errBadId',
      'bad-entry': 'errBadEntry',
    }
    function errorText(t, err) {
      const key = err && err.code ? ERROR_KEYS[err.code] : undefined
      if (key) return t(key)
      if (err && typeof err.error === 'string' && err.error) return err.error
      if (err && err.code) return `${t('errGeneric')} (${err.code})`
      return String(err && err.message ? err.message : err)
    }
    function errorDetails(t, err) {
      const details = err && err.details
      if (!details || typeof details !== 'object') return []
      const rows = []
      if (Array.isArray(details.activity) && details.activity.length) {
        rows.push(t('activityKinds', { kinds: details.activity.slice(0, 10).join(', ') }))
      }
      if (Array.isArray(details.errors) && details.errors.length) {
        rows.push(details.errors.slice(0, 5).map((item) => `${item.key}: ${item.got} → ${item.expected}`).join(' · '))
      }
      if (Array.isArray(details.conflicts) && details.conflicts.length) {
        rows.push(t('projectionConflict', { n: details.conflicts.length }))
      }
      return rows
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
      busyHint,
      onCancel,
      onConfirm,
      busy,
    }) {
      const [typed, setTyped] = React.useState('')
      const inputRef = React.useRef(null)
      const confirmRef = React.useRef(null)
      const dialogRef = React.useRef(null)
      const previousFocus = React.useRef(null)
      const ready = !typedWord || typed.trim() === typedWord

      React.useEffect(() => {
        previousFocus.current = typeof document !== 'undefined' ? document.activeElement : null
        const target = typedWord ? inputRef.current : confirmRef.current
        if (target && typeof target.focus === 'function') target.focus()
        return () => {
          const previous = previousFocus.current
          if (previous && typeof previous.focus === 'function' && previous.isConnected !== false) {
            try {
              previous.focus()
            } catch {
              /* ignore */
            }
          }
        }
      }, [typedWord])

      React.useEffect(() => {
        const onKey = (event) => {
          if (event.key === 'Escape') {
            event.stopPropagation()
            if (!busy) onCancel()
            return
          }
          if (event.key !== 'Tab' || !dialogRef.current) return
          const nodes = [...dialogRef.current.querySelectorAll(
            'button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), a[href], [tabindex]:not([tabindex="-1"])',
          )]
          if (!nodes.length) return
          const first = nodes[0]
          const last = nodes[nodes.length - 1]
          if (event.shiftKey && document.activeElement === first) {
            event.preventDefault()
            last.focus()
          } else if (!event.shiftKey && document.activeElement === last) {
            event.preventDefault()
            first.focus()
          }
        }
        document.addEventListener('keydown', onKey, true)
        return () => document.removeEventListener('keydown', onKey, true)
      }, [onCancel, busy])

      const shown = items.slice(0, 8)
      const hidden = items.length - shown.length
      const wide = items.length > 0 || Boolean(typedWord)

      return h(
        'div',
        {
          className: 'dsm-modalRoot',
          onMouseDown: (event) => {
            if (!busy && event.target === event.currentTarget) onCancel()
          },
        },
        h('div', {
          className: 'dsm-modalMask',
          onMouseDown: (event) => {
            event.stopPropagation()
            if (!busy) onCancel()
          },
        }),
        h(
          'div',
          {
            ref: dialogRef,
            className: `dsm-dialog${wide ? ' dsm-dialogWide' : ''}`,
            role: 'dialog',
            'aria-modal': 'true',
            'aria-labelledby': 'dsm-dialog-title',
            'aria-busy': busy ? 'true' : undefined,
            onMouseDown: (event) => event.stopPropagation(),
          },
          h(
            'div',
            { className: 'dsm-dialogHeader' },
            h('h2', { id: 'dsm-dialog-title', className: 'dsm-dialogTitle' }, title),
            h(
              'button',
              {
                type: 'button',
                className: 'dsm-dialogClose',
                'aria-label': closeLabel,
                title: closeLabel,
                onClick: onCancel,
                disabled: busy,
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
            busy && busyHint ? h('p', { className: 'dsm-muted' }, busyHint) : null,
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
      const loadSeq = React.useRef(0)
      const loadAbort = React.useRef(null)
      const tRef = React.useRef(t)
      const blockedLabelRef = React.useRef(null)
      const askTrashRef = React.useRef(null)
      const consumeArmRef = React.useRef(() => {})
      stateRef.current = state
      tRef.current = t

      // Defined before any early return so the row-entry effect can never hit
      // the temporal dead zone of a loading render.
      const blockedLabel = (reason) => {
        switch (reason) {
          case 'live': return t('live')
          case 'unknown': return t('unknown')
          case 'disabled': return t('reasonDisabled')
          case 'config-invalid': return t('errConfigInvalid')
          case 'protected': return t('reasonProtected')
          case 'subagent-protected': return t('reasonSubagentProtected')
          case 'kind-unknown': return t('errKindUnknown')
          case 'pinned-protected': return t('reasonPinnedProtected')
          case 'archived-protected': return t('reasonArchivedProtected')
          case 'protection-unknown': return t('errProtectionUnknown')
          case 'identity-unknown': return t('errIdentityUnknown')
          case 'identity-mismatch': return t('errIdentityMismatch')
          case 'ambiguous': return t('ambiguous')
          default: return t('protected')
        }
      }
      blockedLabelRef.current = blockedLabel

      React.useEffect(() => () => {
        alive.current = false
        if (loadAbort.current) {
          try {
            loadAbort.current.abort()
          } catch {
            /* ignore */
          }
        }
      }, [])

      const load = React.useCallback(async (signal, { silent = false } = {}) => {
        const seq = ++loadSeq.current
        if (!silent) setBusy(true)
        try {
          const data = await api('/list', undefined, signal)
          if (alive.current && seq === loadSeq.current) setState({ status: 'ready', data })
        } catch (err) {
          if (err && err.name === 'AbortError') return
          if (alive.current && seq === loadSeq.current && !silent) {
            setState((prev) => ({ status: 'error', error: String(err && err.message ? err.message : err), data: prev.data }))
          }
        } finally {
          if (alive.current && seq === loadSeq.current && !silent) setBusy(false)
        }
      }, [])

      React.useEffect(() => {
        const controller = new AbortController()
        loadAbort.current = controller
        load(controller.signal)
        return () => controller.abort()
      }, [load])

      React.useEffect(() => {
        const timer = setInterval(() => {
          if (!document.hidden) load(undefined, { silent: true })
        }, POLL_MS)
        return () => clearInterval(timer)
      }, [load])

      // 行内入口（悬停按钮 / 右键菜单）把某条会话交过来：等列表就绪后再消费，
      // 失败/过期都明确告知，绝不出现"提示去弹窗确认但根本没有弹窗"。
      React.useEffect(() => {
        const consume = () => {
          if (!armRequest) return
          const current = stateRef.current
          if (current?.status !== 'ready' || !current.data) return
          const request = armRequest
          if (Date.now() - (request.at || 0) > ARM_TTL_MS) {
            armRequest = null
            setNotice({ kind: 'warn', text: tRef.current('armExpired') })
            return
          }
          armRequest = null
          const found = current.data.sessions?.find((s) => s.id === request.sessionId)
          if (!found) {
            setNotice({ kind: 'warn', text: tRef.current('armNotFound') })
            return
          }
          if (!found.deletable) {
            const label = blockedLabelRef.current ? blockedLabelRef.current(found.blockedReason) : tRef.current('protected')
            setNotice({ kind: 'warn', text: `${found.title || found.id}：${label}` })
            return
          }
          setSelected(new Set())
          if (askTrashRef.current) askTrashRef.current([found])
        }
        consumeArmRef.current = consume
        const unsubscribe = bus.subscribe(() => {
          try {
            consumeArmRef.current()
          } catch (err) {
            setNotice({ kind: 'err', text: tRef.current('armFailed') })
          }
        })
        consume()
        return unsubscribe
      }, [])

      React.useEffect(() => {
        if (state.status === 'ready') consumeArmRef.current()
      }, [state.status, state.data])

      React.useEffect(() => {
        const data = state.data
        if (!data) return
        const sessionIds = new Set((data.sessions ?? []).map((item) => item.id))
        const trashIds = new Set((data.trash ?? []).map((item) => item.entryId))
        setSelected((prev) => {
          const next = new Set([...prev].filter((id) => sessionIds.has(id)))
          return next.size === prev.size ? prev : next
        })
        setSelectedTrash((prev) => {
          const next = new Set([...prev].filter((id) => trashIds.has(id)))
          return next.size === prev.size ? prev : next
        })
      }, [state.data])

      React.useEffect(() => {
        if (!notice) return undefined
        const timer = setTimeout(() => {
          if (alive.current) setNotice(null)
        }, notice.kind === 'err' ? NOTICE_MS * 2 : NOTICE_MS)
        return () => clearTimeout(timer)
      }, [notice])

      const run = async (okText, fn, { classify, onError } = {}) => {
        setBusy(true)
        setConfirm(null)
        try {
          const result = await fn()
          if (alive.current) {
            const outcome = classify
              ? classify(result)
              : { kind: 'ok', text: typeof okText === 'function' ? okText(result) : okText }
            const message = typeof outcome === 'string' ? { kind: 'ok', text: outcome } : outcome || { kind: 'ok', text: t('ok') }
            setNotice(message)
            if (Array.isArray(message.selectedIds)) setSelected(new Set(message.selectedIds))
            else if (message.kind !== 'err') setSelected(new Set())
            if (Array.isArray(message.selectedTrashIds)) setSelectedTrash(new Set(message.selectedTrashIds))
            else if (message.kind !== 'err') setSelectedTrash(new Set())
          }
          await load()
        } catch (err) {
          if (alive.current) {
            const action = onError ? onError(err) : null
            setNotice({
              kind: 'err',
              text: errorText(t, err),
              details: errorDetails(t, err),
              action,
            })
          }
          // 批量/逐条操作可能是部分成功；失败后也刷新一次，避免界面停留在旧状态。
          try {
            await load()
          } catch {
            /* load 自己会显示错误 */
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
        const max = Number(policy?.maxBatchSize) || 50
        if (items.length > max) {
          setNotice({ kind: 'warn', text: t('batchLimitHint', { n: max }) })
          return
        }
        const children = items.reduce((sum, item) => sum + (Number(item.childSessionCount) || 0), 0)
        const description = children
          ? `${t('confirmTrashBody')} ${t('childImpact', { n: children })}`
          : t('confirmTrashBody')
        setConfirm({
          kind: 'trash',
          items,
          title: t('confirmTrashTitle', { n: items.length }),
          description,
          danger: false,
          confirmLabel: t('batchTrash'),
          onConfirm: () =>
            run(
              null,
              () =>
                items.length === 1
                  ? api('/delete', { id: items[0].id, requestId: `ui:${Date.now()}:${items[0].id}` })
                  : api('/delete-batch', { ids: items.map((x) => x.id), confirmCount: items.length }),
              {
                classify: (result) => {
                  if (items.length === 1) {
                    return { kind: 'ok', text: t('deleted'), selectedIds: [] }
                  }
                  const failed = result.failed || 0
                  const rows = (result.results || []).filter((row) => !row.ok)
                  if (!failed) return { kind: 'ok', text: t('deletedN', { n: result.succeeded }), selectedIds: [] }
                  return {
                    kind: result.succeeded > 0 ? 'warn' : 'err',
                    text: t('deletedPartial', { ok: result.succeeded, failed }),
                    details: rows.slice(0, 6).map((row) => `${row.id}：${errorText(t, row)}`),
                    selectedIds: rows.map((row) => row.id),
                    action: rows.length
                      ? {
                          label: t('retryFailed'),
                          onClick: () => askTrash(sessions.filter((s) => rows.some((row) => row.id === s.id))),
                        }
                      : null,
                  }
                },
                onError: (err) => {
                  const queueable = ['active', 'activity-unknown', 'live', 'live-unknown'].includes(err.code)
                  if (!queueable || items.length !== 1) return null
                  return {
                    label: t('queueAction'),
                    onClick: () =>
                      run(
                        policy?.processPendingOnStartup ? t('queuedAuto') : t('queuedManual'),
                        () => api('/queue', { id: items[0].id }),
                      ),
                  }
                },
              },
            ),
        })
      }
      askTrashRef.current = askTrash

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
              null,
              () =>
                items.length === 1
                  ? api('/purge', { entryId: items[0].entryId, typedConfirm: typed })
                  : api('/purge-batch', {
                      entryIds: items.map((x) => x.entryId),
                      confirmCount: items.length,
                      typedConfirm: typed,
                    }),
              {
                classify: (result) => {
                  if (items.length === 1) return { kind: 'ok', text: t('purged'), selectedTrashIds: [] }
                  const failed = result.failed || 0
                  const rows = (result.results || []).filter((row) => !row.ok)
                  if (!failed) return { kind: 'ok', text: t('purgedN', { n: result.succeeded }), selectedTrashIds: [] }
                  return {
                    kind: result.succeeded > 0 ? 'warn' : 'err',
                    text: t('batchPartialTitle', { n: failed }),
                    details: rows.slice(0, 6).map((row) => `${row.entryId}：${errorText(t, row)}`),
                    selectedTrashIds: rows.map((row) => row.entryId),
                    action: rows.length
                      ? {
                          label: t('retryFailed'),
                          onClick: () => askPurge(trash.filter((x) => rows.some((row) => row.entryId === x.entryId))),
                        }
                      : null,
                  }
                },
              },
            ),
        })
      }

      const askPurgeAll = (entryIds, skipCount) => {
        if (!entryIds.length) {
          setNotice({ kind: 'warn', text: t('trashEmpty') })
          return
        }
        setConfirm({
          kind: 'purge-all',
          items: [],
          title: t('confirmPurgeAllTitle', { n: entryIds.length }),
          description: skipCount
            ? `${t('confirmPurgeAllBody')} ${t('purgeAllSkipHint', { n: skipCount })}`
            : t('confirmPurgeAllBody'),
          warning: t('warnIrreversible'),
          danger: true,
          typedWord: policy?.purgeConfirmWord ?? 'PURGE',
          confirmLabel: t('purgeAll'),
          onConfirm: (typed) =>
            run(
              null,
              () => api('/purge-all', { entryIds, confirmCount: entryIds.length, typedConfirm: typed }),
              {
                classify: (result) => ({
                  kind: result.skipped?.length ? 'warn' : 'ok',
                  text: result.skipped?.length
                    ? t('purgedAllPartial', { n: result.count, m: result.skipped.length })
                    : t('purgeAllDone'),
                  details: (result.skipped || []).slice(0, 6).map((row) => `${row.entryId}：${row.code}`),
                  selectedTrashIds: [],
                }),
              },
            ),
        })
      }

      const askForcePurge = (item) => {
        setConfirm({
          kind: 'force-purge',
          items: [item],
          title: t('forcePurgeTitle'),
          description: t('forcePurgeBody'),
          warning: t('warnIrreversible'),
          danger: true,
          typedWord: policy?.purgeConfirmWord ?? 'PURGE',
          confirmLabel: t('forcePurge'),
          onConfirm: (typed) =>
            run(null, () => api('/purge', { entryId: item.entryId, typedConfirm: typed, force: true }), {
              classify: () => ({ kind: 'ok', text: t('forcePurged'), selectedTrashIds: [] }),
            }),
        })
      }

      const askOrphan = (item) => {
        setConfirm({
          kind: 'purge-orphan',
          items: [{ label: item.entryId }],
          title: t('orphanPurgeTitle'),
          description: t('orphanPurgeBody'),
          warning: t('warnIrreversible'),
          danger: true,
          typedWord: policy?.purgeConfirmWord ?? 'PURGE',
          confirmLabel: t('orphanPurge'),
          onConfirm: (typed) =>
            run(null, () => api('/purge-orphan', { entryId: item.entryId, typedConfirm: typed }), {
              classify: () => ({ kind: 'ok', text: t('orphanPurged') }),
            }),
        })
      }

      const askRelocate = (entryId, originalRoot, currentRoot) => {
        setConfirm({
          kind: 'relocate',
          items: [],
          title: t('rootChangedTitle'),
          description: t('rootChangedBody', { original: originalRoot, current: currentRoot }),
          confirmLabel: t('relocateAction'),
          onConfirm: () =>
            run(null, () => api('/restore', { entryId, relocate: true }), {
              classify: (result) => ({
                kind: result.partial ? 'warn' : 'ok',
                text: result.partial
                  ? t('restoredPartial', { n: result.warnings?.length || 1 })
                  : t('relocated'),
              }),
            }),
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
      const deferredCount = (data?.startup ?? []).filter((item) => item.result === 'deferred').length
      const logWriteError = data?.log?.writeError || ''
      const warnings = Array.isArray(data?.warnings) ? data.warnings : []

      const askProcessPending = () => {
        const count = pending.length
        const sessionIds = pending.map((item) => item.sessionId)
        setConfirm({
          kind: 'process-pending',
          items: pending,
          title: t('confirmProcessPendingTitle', { n: count }),
          description: t('confirmProcessPendingBody'),
          danger: false,
          confirmLabel: t('processPending'),
          onConfirm: () =>
            run(
              null,
              () => api('/process-pending', { confirmCount: count, sessionIds }),
              {
                classify: (result) => {
                  const rows = (result.results || []).filter((row) => row.result !== 'trashed')
                  return {
                    kind: result.remaining > 0 ? 'warn' : 'ok',
                    text:
                      result.remaining > 0
                        ? t('processedPartial', { n: result.succeeded, m: result.remaining })
                        : t('processedN', { n: result.succeeded }),
                    details: rows.slice(0, 6).map((row) => `${row.sessionId}：${row.result}${row.code ? ` (${row.code})` : ''}`),
                  }
                },
              },
            ),
        })
      }
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
        const allSelected = deletable.length > 0 && deletable.every((id) => selected.has(id))
        if (allSelected) {
          const next = new Set(selected)
          for (const id of deletable) next.delete(id)
          setSelected(next)
          return
        }
        const next = new Set(selected)
        const max = Number(policy?.maxBatchSize) || 50
        for (const id of deletable) {
          if (next.size >= max) break
          next.add(id)
        }
        setSelected(next)
        if (deletable.some((id) => !next.has(id))) {
          setNotice({ kind: 'warn', text: t('batchLimitHint', { n: max }) })
        }
      }
      const selectAllFiltered = () => {
        const eligible = sorted.filter((s) => s.deletable)
        const max = Number(policy?.maxBatchSize) || 50
        const ids = eligible.slice(0, max).map((s) => s.id)
        setSelected(new Set(ids))
        if (eligible.length > max) {
          setNotice({ kind: 'warn', text: t('batchLimitHint', { n: max }) })
        } else {
          const skipped = sorted.length - eligible.length
          if (skipped > 0) setNotice({ kind: 'warn', text: t('selectedBlocked', { n: skipped }) })
        }
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
      const visibleIds = new Set(sorted.map((s) => s.id))
      const selectedVisible = selectedSessions.filter((s) => visibleIds.has(s.id))
      const selectedHidden = selectedSessions.length - selectedVisible.length
      const selectedBytes = selectedSessions.reduce((sum, s) => sum + (Number(s.bytes) || 0), 0)
      const maxBatch = Number(policy?.maxBatchSize) || 50
      // 选择状态与"各操作是否有资格"分离：受保护/禁止 purge 的条目仍可被勾选，
      // 由具体动作决定跳过或阻止。
      const restorableTrash = trash.filter((x) => !x.broken && !x.incomplete && x.complete !== false)
      const purgeableTrash = trash.filter((x) => !x.purgeBlockedReason && policy?.allowPurge !== false)
      const selectableTrash = trash.filter((x) => restorableTrash.includes(x) || purgeableTrash.includes(x))
      const selectedTrashItems = trash.filter((x) => selectedTrash.has(x.entryId))
      const selectedPurgeable = selectedTrashItems.filter((x) => purgeableTrash.includes(x))
      const selectedRestorable = selectedTrashItems.filter((x) => restorableTrash.includes(x))
      const selectedTrashOver = selectedTrash.size > maxBatch
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
        policyChips.push(
          h(
            Chip,
            { key: 'pq' },
            policy.processPendingOnStartup ? t('policyQueuedAuto') : t('policyQueuedManual'),
          ),
        )
      }

      const sessionCard = (s) => {
        const badges = []
        if (s.liveness === 'live') badges.push(h('span', { key: 'live', className: 'dsm-badge dsm-badge-live' }, t('live')))
        if (s.liveness === 'unknown') badges.push(h('span', { key: 'unknown', className: 'dsm-badge dsm-badge-unknown' }, t('unknown')))
        if (s.kind === 'subagent') badges.push(h('span', { key: 'sub', className: 'dsm-badge' }, t('subagent')))
        if (s.archived) badges.push(h('span', { key: 'arch', className: 'dsm-badge' }, t('archived')))
        if (s.pinned) badges.push(h('span', { key: 'pin', className: 'dsm-badge' }, t('pinned')))
        if (!s.listed && s.kind !== 'subagent') badges.push(h('span', { key: 'un', className: 'dsm-badge' }, t('unlisted')))
        if (s.blockedReason === 'ambiguous') badges.push(h('span', { key: 'amb', className: 'dsm-badge dsm-badge-lock' }, t('ambiguous')))
        if (s.unverified) badges.push(h('span', { key: 'uv', className: 'dsm-badge dsm-badge-unknown' }, t('unverified')))
        if (s.childSessionCount > 0) badges.push(h('span', { key: 'kids', className: 'dsm-badge' }, t('childSessions', { n: s.childSessionCount })))
        if (!s.deletable && s.liveness === 'free') {
          badges.push(h('span', { key: 'lock', className: 'dsm-badge dsm-badge-lock' }, t('protected')))
        }
        const meta = [`${t('size')} ${formatBytes(s.bytes)}`, `${t('updated')} ${formatTime(s.updatedAt)}`, s.id].join(' · ')
        const queued = pendingIds.has(s.id)
        const isLive = s.liveness !== 'free'
        const queueLabel = policy?.processPendingOnStartup ? t('queueAuto') : t('queueManual')
        const queuedLabel = policy?.processPendingOnStartup ? t('queuedAuto') : t('queuedManual')
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
                  ? h(Button, { label: t('unqueue'), variant: 'outline', small: true, disabled: busy || policy?.enabled === false, onClick: () => run(t('queuedOff'), () => api('/unqueue', { id: s.id })) })
                  : h(Button, { label: queueLabel, variant: 'outline', small: true, disabled: busy || policy?.enabled === false, onClick: () => run(queuedLabel, () => api('/queue', { id: s.id })) }))
              : h(Button, {
                  label: t('delete'),
                  variant: 'danger',
                  small: true,
                  disabled: busy || !s.deletable || policy?.enabled === false,
                  title: s.deletable ? t('delete') : blockedLabel(s.blockedReason),
                  onClick: () => askTrash([s]),
                })),
        )
      }

      const purgeBlockedText = (reason) => {
        switch (reason) {
          case 'config-invalid': return t('errConfigInvalid')
          case 'disabled': return t('reasonDisabled')
          case 'purge-disabled': return t('policyNoPurge')
          case 'protected': return t('reasonProtected')
          case 'subagent-protected': return t('reasonSubagentProtected')
          case 'kind-unknown': return t('errKindUnknown')
          case 'protection-unknown': return t('errProtectionUnknown')
          case 'orphan': return t('reasonOrphan')
          case 'incomplete': return t('errIncomplete')
          case 'broken': return t('errBroken')
          case 'refs-pending': return t('errRefsPending')
          default: return t('protected')
        }
      }

      const trashCard = (item) => {
        const meta = [`${t('size')} ${formatBytes(item.bytes)}`, `${t('deletedAt')} ${formatStamp(item.deletedAt)}`, item.sessionId].join(' · ')
        const blockedReason = item.purgeBlockedReason || (policy?.allowPurge === false ? 'purge-disabled' : null)
        const blocked = Boolean(blockedReason)
        const restorable = !item.broken && !item.incomplete && item.complete !== false
        const selectable = restorable || !blocked
        const badges = []
        if (blocked) badges.push(h('span', { key: 'lock', className: 'dsm-badge dsm-badge-lock' }, t('protected')))
        if (item.incomplete || item.complete === false) badges.push(h('span', { key: 'inc', className: 'dsm-badge dsm-badge-unknown' }, t('trashIncomplete')))
        if (item.refsPending) badges.push(h('span', { key: 'refs', className: 'dsm-badge dsm-badge-unknown' }, t('refsPending')))
        if (item.broken) badges.push(h('span', { key: 'broken', className: 'dsm-badge dsm-badge-lock' }, t('trashIncomplete')))
        if (item.projectionFiles > 0) badges.push(h('span', { key: 'proj', className: 'dsm-badge' }, `${item.projectionFiles} × cache`))
        return h(
          'div',
          { className: `dsm-card${selectedTrash.has(item.entryId) ? ' dsm-cardSel' : ''}`, key: item.entryId },
          h('input', {
            className: 'dsm-check',
            type: 'checkbox',
            checked: selectedTrash.has(item.entryId),
            disabled: busy || !selectable,
            title: !selectable ? purgeBlockedText(blockedReason) : undefined,
            'aria-label': item.title || item.sessionId,
            onChange: () => toggle(setSelectedTrash, item.entryId),
          }),
          h('div', { className: 'dsm-cardMain' },
            h('div', { className: 'dsm-cardTitle' }, h('span', { className: 'dsm-name' }, item.title || t('untitled')), ...badges),
            h('div', { className: 'dsm-cardMeta' }, meta),
            blocked ? h('div', { className: 'dsm-cardMeta dsm-notice-err' }, purgeBlockedText(blockedReason)) : null),
          h('div', { className: 'dsm-actions' },
            h(Button, {
              label: t('restore'),
              variant: 'outline',
              small: true,
              disabled: busy || !restorable,
              title: restorable ? t('restore') : t('trashIncomplete'),
              onClick: () =>
                run(null, () => api('/restore', { entryId: item.entryId }), {
                  classify: (result) =>
                    result.partial
                      ? { kind: 'warn', text: t('restoredPartial', { n: result.warnings?.length || 1 }), details: result.warnings?.slice(0, 6) }
                      : { kind: 'ok', text: t('restored') },
                  onError: (err) => {
                    if (err.code === 'root-changed') {
                      return {
                        label: t('relocateAction'),
                        onClick: () => askRelocate(item.entryId, err.details?.originalRoot ?? '—', err.details?.currentRoot ?? '—'),
                      }
                    }
                    if (err.code === 'broken' || err.code === 'incomplete') {
                      return { label: t('forcePurge'), onClick: () => askForcePurge(item) }
                    }
                    return null
                  },
                }),
            }),
            blocked
              ? (item.forcePurgeAllowed
                  ? h(Button, {
                      label: t('forcePurge'),
                      variant: 'danger',
                      small: true,
                      disabled: busy || policy?.enabled === false,
                      title: t('forcePurge'),
                      onClick: () => askForcePurge(item),
                    })
                  : null)
              : h(Button, {
                  label: t('purge'),
                  variant: 'danger',
                  small: true,
                  disabled: busy || policy?.enabled === false,
                  title: t('purge'),
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
            busyHint: t('busyHint'),
            busy,
            onCancel: () => setConfirm(null),
            onConfirm: (typed) => confirm.onConfirm(typed),
          })
        : null

      const downloadDiagnostics = async () => {
        try {
          const report = await api('/diagnostics')
          const blob = new Blob([JSON.stringify(report, null, 2)], { type: 'application/json' })
          const url = URL.createObjectURL(blob)
          const anchor = document.createElement('a')
          anchor.href = url
          anchor.download = `dsh-delete-guard-diagnostics-${new Date().toISOString().replace(/[:.]/g, '-')}.json`
          document.body.appendChild(anchor)
          anchor.click()
          anchor.remove()
          setTimeout(() => URL.revokeObjectURL(url), 1000)
          setNotice({ kind: 'ok', text: t('diagnosticsDone') })
        } catch (err) {
          setNotice({ kind: 'err', text: `${t('diagnosticsFailed')} ${errorText(t, err)}` })
        }
      }

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
          ? h(
              'div',
              { className: `dsm-notice ${notice.kind === 'ok' ? 'dsm-notice-ok' : notice.kind === 'warn' ? 'dsm-notice-warn' : 'dsm-notice-err'}` },
              h('span', null, notice.text),
              Array.isArray(notice.details) && notice.details.length
                ? h(
                    'details',
                    { className: 'dsm-noticeDetails' },
                    h('summary', null, t('detailsTitle')),
                    h('ul', null, notice.details.slice(0, 8).map((row, index) => h('li', { key: index }, row))),
                  )
                : null,
              notice.action
                ? h(Button, {
                    label: notice.action.label,
                    variant: 'outline',
                    small: true,
                    disabled: busy,
                    onClick: notice.action.onClick,
                  })
                : null,
            )
          : null,
        data?.configErrors?.length
          ? h(
              'div',
              { className: 'dsm-notice dsm-notice-err' },
              h('strong', null, `${t('configInvalidTitle')}：`),
              t('configInvalidBody'),
              h(
                'ul',
                { className: 'dsm-noticeList' },
                data.configErrors.slice(0, 8).map((item, index) =>
                  h('li', { key: index }, `${item.key}: ${item.got} → ${item.expected}`),
                ),
              ),
            )
          : null,
        data?.pendingCorrupt || data?.repairsCorrupt
          ? h('p', { className: 'dsm-notice dsm-notice-warn' }, t('errPendingCorrupt'))
          : null,
        state.status === 'error' && data
          ? h('p', { className: 'dsm-notice dsm-notice-err' }, t('unreachable', { error: state.error }))
          : null,
        deferredCount
          ? h('p', { className: 'dsm-notice dsm-notice-warn' }, t('startupDeferred', { n: deferredCount }))
          : null,
        logWriteError
          ? h('p', { className: 'dsm-notice dsm-notice-err' }, t('logError', { error: logWriteError }))
          : null,
        warnings.length
          ? h('p', { className: 'dsm-notice dsm-notice-warn' }, warnings.slice(0, 3).join(' · '))
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
              h('span', { className: 'dsm-batchText' }, t('visibleSelected', { n: selectedSessions.length, m: selectedVisible.length })),
              selectedHidden > 0
                ? h('span', { className: 'dsm-batchHint' }, t('selectedHidden', { n: selectedSessions.length, m: selectedHidden }))
                : null,
              selectedSessions.length > maxBatch
                ? h('span', { className: 'dsm-batchHint' }, t('batchLimitTitle'))
                : null,
              h(Button, {
                label: t('batchTrash'),
                variant: 'danger',
                disabled: busy || selectedSessions.length === 0 || selectedSessions.length > maxBatch || policy?.enabled === false,
                title: selectedSessions.length > maxBatch ? t('batchLimitHint', { n: maxBatch }) : t('batchTrash'),
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
                        h(Button, {
                          key: 'r',
                          label: t('batchRestore'),
                          variant: 'outline',
                          small: true,
                          disabled: busy || selectedRestorable.length === 0 || selectedTrashOver || policy?.enabled === false,
                          title: selectedTrashOver ? t('batchLimitHint', { n: maxBatch }) : selectedRestorable.length === 0 ? t('trashIncomplete') : t('batchRestore'),
                          onClick: () =>
                            run(
                              null,
                              () => api('/restore-batch', { entryIds: selectedRestorable.map((x) => x.entryId) }),
                              {
                                classify: (result) => {
                                  const rows = (result.results || []).filter((row) => !row.ok)
                                  return {
                                    kind: rows.length ? 'warn' : 'ok',
                                    text: rows.length
                                      ? t('batchPartialTitle', { n: rows.length })
                                      : t('restoredN', { n: result.succeeded }),
                                    details: rows.slice(0, 6).map((row) => `${row.entryId}：${errorText(t, row)}`),
                                    selectedTrashIds: rows.map((row) => row.entryId),
                                  }
                                },
                              },
                            ),
                        }),
                        h(Button, {
                          key: 'p',
                          label: t('batchPurge'),
                          variant: 'danger',
                          small: true,
                          disabled: busy || selectedPurgeable.length === 0 || selectedTrashOver || policy?.enabled === false,
                          title: selectedTrashOver ? t('batchLimitHint', { n: maxBatch }) : selectedPurgeable.length === 0 ? t('policyNoPurge') : t('batchPurge'),
                          onClick: () => askPurge(selectedPurgeable),
                        }),
                        h(Button, { key: 'c', label: t('selectNone'), variant: 'outline', small: true, onClick: () => setSelectedTrash(new Set()) }),
                      ]
                    : [
                        h(Button, {
                          key: 'sa',
                          label: t('selectAll'),
                          variant: 'outline',
                          small: true,
                          disabled: busy || selectableTrash.length === 0,
                          onClick: () => setSelectedTrash(new Set(selectableTrash.slice(0, maxBatch).map((x) => x.entryId))),
                        }),
                        h(Button, {
                          key: 'pa',
                          label: t('purgeAll'),
                          variant: 'danger',
                          small: true,
                          disabled: busy || purgeableTrash.length === 0,
                          title: purgeableTrash.length === 0 ? t('policyNoPurge') : t('purgeAll'),
                          onClick: () => askPurgeAll(trash.map((x) => x.entryId), trash.length - purgeableTrash.length),
                        }),
                      ])
              : null),
          selectedTrash.size
            ? h('div', null,
                h('p', { className: 'dsm-muted' }, t('selectedCount', { n: selectedTrash.size, size: formatBytes(selectedTrashBytes) })),
                selectedTrashOver ? h('p', { className: 'dsm-batchHint' }, t('batchLimitHint', { n: maxBatch })) : null)
            : null,
          trash.length === 0 ? h('p', { className: 'dsm-muted' }, t('trashEmpty')) : trash.map(trashCard)),

        pending.length > 0
          ? h('div', { className: 'dsm-group' },
              h('div', { className: 'dsm-groupHead' },
                h('h2', { className: 'dsm-groupTitle' }, policy?.processPendingOnStartup ? t('pendingAuto') : t('pending')),
                h('span', { className: 'dsm-count' }, String(pending.length)),
                h('span', { style: { marginLeft: 'auto' } },
                  h(Button, {
                    label: t('processPending'),
                    variant: 'outline',
                    small: true,
                    disabled: busy || pending.length === 0 || policy?.enabled === false,
                    onClick: askProcessPending,
                  }))),
              h('p', { className: 'dsm-muted' }, policy?.processPendingOnStartup ? t('pendingHintAuto') : t('pendingHintManual')),
              pending.map(pendingCard))
          : null,

        h('div', { className: 'dsm-group' },
          h('div', { className: 'dsm-groupHead' },
            h('h2', { className: 'dsm-groupTitle' }, t('orphansTitle')),
            h('span', { className: 'dsm-count' }, String((data?.orphans ?? []).length)),
            h('span', { style: { marginLeft: 'auto', display: 'flex', gap: '6px' } },
              h(Button, { label: t('diagnostics'), variant: 'outline', small: true, disabled: busy, onClick: downloadDiagnostics }),
              h(Button, {
                label: t('retryRepairs'),
                variant: 'outline',
                small: true,
                disabled: busy || policy?.enabled === false,
                onClick: () =>
                  run(null, () => api('/repair-refs', {}), {
                    classify: () => ({ kind: 'ok', text: t('repairsDone') }),
                  }),
              }))),
          (data?.orphans ?? []).length
            ? (data.orphans || []).map((item) =>
                h('div', { className: 'dsm-card', key: item.entryId },
                  h('div', { className: 'dsm-cardMain' },
                    h('div', { className: 'dsm-cardTitle' },
                      h('span', { className: 'dsm-name' }, item.entryId),
                      h('span', { className: 'dsm-badge dsm-badge-lock' }, t('trashIncomplete'))),
                    h('div', { className: 'dsm-cardMeta' }, item.reason || 'orphan')),
                  h('div', { className: 'dsm-actions' },
                    h(Button, {
                      label: t('orphanPurge'),
                      variant: 'danger',
                      small: true,
                      disabled: busy || policy?.enabled === false || policy?.allowPurge === false,
                      onClick: () => askOrphan(item),
                    }))))
            : h('p', { className: 'dsm-muted' }, t('orphansHint')),
          (data?.repairs ?? []).length
            ? h('div', null,
                h('p', { className: 'dsm-muted' }, t('repairsHint')),
                (data.repairs || []).slice(0, 6).map((item, index) =>
                  h('div', { className: 'dsm-card', key: `${item.sessionId}-${index}` },
                    h('div', { className: 'dsm-cardMain' },
                      h('div', { className: 'dsm-cardTitle' }, h('span', { className: 'dsm-name' }, item.sessionId)),
                      h('div', { className: 'dsm-cardMeta' }, `${item.kind} · ${item.code || item.requestedAt || ''}`)))))
            : null,
          h('details', { className: 'dsm-details' },
            h('summary', null, t('recoveryTitle')),
            h('p', { className: 'dsm-muted' },
              data?.sweep
                ? t('sweepSummary', { removed: data.sweep.removed ?? 0, skipped: data.sweep.skipped ?? 0 })
                : t('sweepHint')),
            (data?.recovery ?? []).length
              ? h('ul', null, data.recovery.slice(0, 10).map((row, index) => h('li', { key: index }, `${row.result || row.code || ''} ${row.reason || ''}`)))
              : h('p', { className: 'dsm-muted' }, t('recoveryHint')),
            (data?.startup ?? []).length
              ? h('ul', null, data.startup.slice(0, 10).map((row, index) => h('li', { key: index }, `${row.sessionId || ''} ${row.result || ''} ${row.code || ''}`)))
              : null)),

        data
          ? h('p', { className: 'dsm-foot' }, t('paths', { sessions: data.sessionsRoot, data: data.dataDir, log: data.logFile }))
          : null,
      )

      return dialog ? h(React.Fragment, null, body, dialog) : body
    }

    // ───────────────────────── 插件体 ─────────────────────────
    // The 0.2.1 Host command descriptor has no `icon` field, and a client
    // command contribution cannot share the host's `/sessions` name. Decorate
    // the rendered menu row instead: this keeps every `/sessions` subcommand
    // working while giving the row the same 14px visual treatment as the
    // first-party commands.
    const COMMAND_ICON_SVG =
      '<svg width="14" height="14" viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">' +
      '<path d="M1.28149 3.88831H14.7187" stroke="currentColor" stroke-width="1" stroke-linecap="round"/>' +
      '<path d="M5.41602 3.88833V2.47962C5.41602 2.29282 5.52492 2.11366 5.71876 1.98157C5.9126 1.84948 6.17551 1.77527 6.44964 1.77527H9.55053C9.82466 1.77527 10.0876 1.84948 10.2814 1.98157C10.4753 2.11366 10.5842 2.29282 10.5842 2.47962V3.88833" stroke="currentColor" stroke-width="1" stroke-linecap="round"/>' +
      '<path d="M2.57349 3.88831L3.19366 13.2943C3.21937 13.5502 3.33952 13.7872 3.53065 13.9593C3.72178 14.1313 3.97016 14.2259 4.22729 14.2246H11.7728C12.0299 14.2259 12.2783 14.1313 12.4694 13.9593C12.6605 13.7872 12.7807 13.5502 12.8064 13.2943L13.4266 3.88831" stroke="currentColor" stroke-width="1" stroke-linecap="round"/>' +
      '<path d="M6.44946 6.98926V11.1238" stroke="currentColor" stroke-width="1" stroke-linecap="round"/>' +
      '<path d="M9.55054 6.98926V11.1238" stroke="currentColor" stroke-width="1" stroke-linecap="round"/>' +
      '</svg>'
    function installCommandIconDecorator() {
      if (typeof document === 'undefined' || typeof MutationObserver !== 'function' || !document.body) {
        return () => {}
      }
      let scheduled = false
      const decorate = () => {
        scheduled = false
        let buttons = []
        try {
          buttons = [...document.querySelectorAll('button[role="option"]')]
        } catch {
          return
        }
        for (const button of buttons) {
          if (button.querySelector('.dsm-commandIcon')) continue
          if (button.querySelector('svg')) continue
          const text = button.textContent || ''
          if (!text.includes('sessions') || !text.includes('会话管理')) continue
          const icon = document.createElement('span')
          icon.className = 'dsm-commandIcon'
          icon.setAttribute('aria-hidden', 'true')
          icon.innerHTML = COMMAND_ICON_SVG
          button.insertBefore(icon, button.firstChild)
        }
      }
      const schedule = () => {
        if (scheduled) return
        scheduled = true
        const run = () => {
          if (!scheduled) return
          decorate()
        }
        if (typeof window !== 'undefined' && typeof window.requestAnimationFrame === 'function') {
          window.requestAnimationFrame(run)
        } else {
          setTimeout(run, 0)
        }
      }
      const observer = new MutationObserver(schedule)
      observer.observe(document.body, { childList: true, subtree: true })
      schedule()
      return () => observer.disconnect()
    }

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

      // Decorate the Host-rendered `/sessions` row (the host descriptor has no
      // icon field in 0.2.1). Purely visual; command execution is unchanged.
      ctx.effect(() => installCommandIconDecorator(), 'dsh-delete-guard: slash icon')

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