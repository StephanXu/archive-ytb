import { test } from "node:test";
import assert from "node:assert/strict";
import type { DiffItem, ItemStatus } from "../shared/contracts.ts";
import { selectionActions } from "../shared/selection.ts";
const item = (bv: string, base_status: ItemStatus): DiffItem => ({
  bv,
  base_status,
  status: base_status,
  title: bv,
  url: "",
  date: null,
});
const items = [
  item("download", "missing"),
  item("archive", "staged"),
  item("saved", "archived"),
  item("other", "missing"),
  item("excluded", "excluded"),
];
test("empty selection never defaults to all items", () => {
  const actions = selectionActions(items, new Set());
  for (const list of Object.values(actions)) assert.deepEqual(list, []);
});
test("mixed selection targets only checked items compatible with each action", () => {
  const actions = selectionActions(
    items,
    new Set(["download", "archive", "saved"]),
  );
  assert.deepEqual(
    actions.download.map((i) => i.bv),
    ["download"],
  );
  assert.deepEqual(
    actions.archive.map((i) => i.bv),
    ["archive"],
  );
  assert.deepEqual(
    actions.delete.map((i) => i.bv),
    ["archive", "saved"],
  );
});
test("stale or off-page selections cannot expand the operation scope", () => {
  const actions = selectionActions(items, new Set(["off-page", "excluded"]));
  assert.equal(
    actions.download.length + actions.archive.length + actions.delete.length,
    0,
  );
});
