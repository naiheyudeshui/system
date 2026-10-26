import { beginTransferDrag } from "/3dworkbench/dragGesture.mjs?v=20261026-gesture3";
import { createTransferEnvelope, serializeTransfer } from "/3dworkbench/transferBus.mjs?v=20261026-gesture";
import { renderObjectNavigator, transferKindForSection } from "./studyTableSurface.mjs?v=20261026-sidebar3";

/** The original table navigator. It offers table references and does not own a grid. */
export async function renderTableCatalogPanel(panel, context = {}) {
  const { api, transferBus, pluginId = "study.table-catalog" } = context;
  panel.classList.add("study-table-catalog");
  const schema = await api("/api/schema");
  const objects = (schema.objects || []).filter((item) => item.kind === "table" || item.kind === "view");
  let activeName = "";
  const offer = () => transferBus?.register(pluginId, { offers: [{ type: "study.table/ref" }] });
  const envelopeFor = (object, sectionId) => createTransferEnvelope("study.table/ref", {
    kind: transferKindForSection(sectionId),
    name: object.name,
  });
  const publish = async (object, sectionId) => {
    activeName = object.name;
    draw();
    if (!transferBus?.dispatchToAcceptors) return;
    const pending = transferBus.dispatchToAcceptors(pluginId, envelopeFor(object, sectionId));
    await Promise.all(pending.map((item) => Promise.resolve(item).catch(() => {})));
  };
  const draw = () => {
    offer();
    renderObjectNavigator(panel, {
      objects,
      activeName,
      storageKey: "study-table-catalog-favorites",
      onSelect: (object, sectionId) => { void publish(object, sectionId); },
      onCreateView: context.onCreateView,
      onEditView: context.onEditView,
      onRemoveView: context.onRemoveView,
      onItemDragStart: (event, object, sectionId) => {
        beginTransferDrag(event, {
          payload: serializeTransfer(envelopeFor(object, sectionId)),
          type: "study.table/ref",
          label: "表格",
        });
      },
    });
  };
  draw();
}
