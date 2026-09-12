import type { DiffItem } from "./contracts.ts";
export function selectionActions(
  items: DiffItem[],
  selected: ReadonlySet<string>,
) {
  const chosen = items.filter((item) => selected.has(item.bv));
  return {
    chosen,
    download: chosen.filter(
      (item) => (item.status || item.base_status) === "missing",
    ),
    archive: chosen.filter((item) => item.base_status === "staged"),
    delete: chosen.filter((item) =>
      ["staged", "archived"].includes(item.base_status),
    ),
  };
}
