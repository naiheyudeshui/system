import { renderTableCatalog } from "/3dworkbench/components/tableCatalog.mjs?v=20261028-bsp1";
import { renderTableGrid } from "/3dworkbench/components/tableGrid.mjs?v=20261028-bsp1";
import { renderMetricsPanel } from "/3dworkbench/components/metricsPanel.mjs?v=20261028-bsp1";
import { renderTablePrintPanel } from "/3dworkbench/components/tablePrintPanel.mjs?v=20261028-bsp1";
import { renderSqliteTriggerPanel } from "/3dworkbench/sqliteTriggerPanel.mjs?v=20261028-bsp1";
import { renderLibrarySyncPanel } from "./studyLibrarySync.mjs?v=20261005-library";
import { renderReviewTablePanel } from "./studySqlReview.mjs?v=20261028-main-port1";
import { renderTimerPanel } from "./studyTimers.mjs?v=20261028-main-port1";
import { renderNodeTreePanel } from "./studyTreeWorkspace.mjs?v=20261028-main-port1";

// Shown until the server has stored metric definitions.
const STUDY_METRICS = [
  { title: "due_cards", label: "今日到期", sql: "SELECT COUNT(*) FROM v_study_due_cards" },
  { title: "active_cards", label: "活跃卡片", sql: "SELECT COUNT(*) FROM study_knowledge_item WHERE item_type = 'card' AND status = 'active'" },
  { title: "study_nodes", label: "章节节点", sql: "SELECT COUNT(*) FROM study_knowledge_item WHERE item_type <> 'card' AND status = 'active'" },
  { title: "review_today", label: "今日复习", sql: "SELECT COUNT(*) FROM study_knowledge_review_log WHERE date(reviewed_at) = date('now', 'localtime')" },
];

/**
 * Study renderer registry: plugin id -> (panel, context).  `services` are the
 * host's editing dialogs; everything else a plugin needs is in the pane
 * context the workspace passes (api, postApi, presentationMode, pane, ...).
 */
export function createStudyRenderers(services) {
  return {
    "study.table-catalog": (panel, context) => renderTableCatalog(panel, {
      ...context,
      // Keeps the favourites saved before the catalog became a shared component.
      storageKeyPrefix: "study-table-catalog",
      onCreateView: services.openViewDialog,
      onEditView: services.editViewByName,
      onRemoveView: services.removeView,
    }),
    "study.table-grid": (panel, context) => renderTableGrid(panel, {
      ...context,
      onCreateRecord: services.openCreateRecordDialog,
      onEditCell: services.openCellEditor,
      onEditDocumentation: services.openSchemaDocDialog,
      onEditView: services.openViewEditor,
    }),
    "study.metrics": (panel, context) => renderMetricsPanel(panel, { ...context, builtinMetrics: STUDY_METRICS }),
    "study.pomodoro": (panel, context) => renderTimerPanel(panel, { ...context, kind: "pomodoro", mode: context.presentationMode }),
    "study.stopwatch": (panel, context) => renderTimerPanel(panel, { ...context, kind: "stopwatch", mode: context.presentationMode }),
    "study.node-tree": renderNodeTreePanel,
    "study.review-table": renderReviewTablePanel,
    "study.library": (panel, context) => renderLibrarySyncPanel(panel, context),
    "official.sqlite-triggers": renderSqliteTriggerPanel,
    "official.table-print": renderTablePrintPanel,
  };
}
