import { parseTransfer, TRANSFER_MIME } from "/3dworkbench/transferBus.mjs?v=20261026-gesture";
import { renderObjectGrid, renderObjectInspector } from "./studyTableSurface.mjs?v=20261026-sidebar3";

const make = (tag, text, className) => {
  const element = document.createElement(tag);
  if (text != null) element.textContent = text;
  if (className) element.className = className;
  return element;
};

/** A table surface. It accepts only a validated study.table/ref transfer. */
export async function renderTableGridPanel(panel, context = {}) {
  const { transferBus } = context;
  const targetId = context.instanceId ? `${context.pluginId || "study.table-grid"}::${context.instanceId}` : "study.table-grid";
  const session = {
    object: null,
    result: null,
    filters: {},
    selectedRow: null,
    editLocked: localStorage.getItem("studio-edit-locked") !== "0",
  };
  panel.classList.add("study-table-grid");
  const stack = make("div", null, "study-table-grid-stack");
  const drop = make("p", "把表或视图拖到这里，或在目录中点击它。", "action-hint study-table-grid-drop");
  const dataPane = make("section", null, "pane data-pane");
  const inspector = make("section", null, "pane study-table-grid-inspector");
  stack.append(drop, dataPane, inspector);
  panel.replaceChildren(stack);

  const render = () => {
    const loaded = Boolean(session.object && session.result);
    drop.hidden = loaded;
    dataPane.hidden = !loaded;
    inspector.hidden = !loaded;
    if (!loaded) return;
    renderObjectGrid(dataPane, {
      object: session.object,
      result: session.result,
      filters: session.filters,
      selectedRow: session.selectedRow,
      editLocked: session.editLocked,
      onFilter: (column, filter) => {
        const kept = Object.fromEntries(Object.entries(session.filters).filter(([name]) => name !== column));
        session.filters = filter ? { ...kept, [column]: filter } : kept;
        render();
      },
      onClearFilters: () => {
        session.filters = {};
        render();
      },
      onSelectRow: (row) => {
        session.selectedRow = row;
        renderObjectInspector(inspector, inspectorOptions());
      },
      onToggleLock: () => {
        session.editLocked = !session.editLocked;
        render();
      },
      onAdd: () => context.onCreateRecord?.(session.object, session.editLocked, reload),
      onEditCell: (cell, row, column) => context.onEditCell?.(cell, row, column, session.object, reload, session.editLocked),
    });
    renderObjectInspector(inspector, inspectorOptions());
  };

  const inspectorOptions = () => ({
    object: session.object,
    selectedRow: session.selectedRow,
    onEditDocumentation: context.onEditDocumentation,
    onEditView: context.onEditView,
  });

  const reload = async () => {
    if (!session.object) return;
    const query = new URLSearchParams({ name: session.object.name, limit: "300" });
    session.result = await context.api?.(`/api/object?${query.toString()}`);
    session.selectedRow = null;
    render();
  };

  const accept = async (payload) => {
    const schema = await context.api?.("/api/schema");
    const object = (schema?.objects || []).find((item) => item.name === payload.name);
    if (!object) throw new Error(`未知的表或视图：${payload.name}`);
    const query = new URLSearchParams({ name: object.name, limit: "300" });
    const result = await context.api?.(`/api/object?${query.toString()}`);
    session.object = object;
    session.result = result;
    session.filters = {};
    session.selectedRow = null;
    drop.textContent = "把表或视图拖到这里，或在目录中点击它。";
    render();
    return { object, result };
  };

  panel.addEventListener("dragover", (event) => {
    if (!event.dataTransfer?.types?.includes(TRANSFER_MIME)) return;
    event.preventDefault();
    event.stopPropagation();
    panel.classList.add("is-transfer-target");
  });
  panel.addEventListener("dragleave", () => panel.classList.remove("is-transfer-target"));
  panel.addEventListener("drop", (event) => {
    if (!event.dataTransfer?.types?.includes(TRANSFER_MIME)) return;
    event.preventDefault();
    event.stopPropagation();
    panel.classList.remove("is-transfer-target");
    try {
      const envelope = parseTransfer(event.dataTransfer.getData(TRANSFER_MIME));
      const result = transferBus?.dispatch("study.table-catalog", targetId, envelope);
      if (result?.catch) result.catch((error) => { drop.hidden = false; drop.textContent = error.message; });
    } catch (error) {
      drop.hidden = false;
      drop.textContent = error.message;
    }
  });
  transferBus?.register(targetId, { accepts: [{ type: "study.table/ref" }] }, {
    "study.table/ref": async (payload) => {
      try {
        return await accept(payload);
      } catch (error) {
        drop.hidden = false;
        dataPane.hidden = true;
        inspector.hidden = true;
        drop.textContent = error.message;
        throw error;
      }
    },
  });
  render();
}
