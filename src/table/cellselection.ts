import {GardState, GardSelection} from "wordgard/state"
import {Decoration, PointSet, Wordgard} from "wordgard/view"
import {Node, Plot, Pos, ChangeSet, ValidationError} from "wordgard/doc"
import {Table, TableRow} from "wordgard/schema"

import {TableMap} from "./tablemap"

export class CellSelection extends GardSelection {
  constructor(
    anchor: number,
    head: number,
    readonly _ranges: readonly {from: number, to: number}[],
    readonly anchorRange: number
  ) {
    super(anchor, head)
  }

  get ranges() { return this._ranges }

  eq(other: GardSelection) {
    return other instanceof CellSelection && other.anchor == this.anchor && other.head == this.head
  }

  map(changes: ChangeSet, doc: Plot.Doc | (() => Plot.Doc), assoc: -1 | 1 = -1) {
    if (typeof doc == "function") doc = doc()
    let fromPos = this.from, toPos = this.to
    let from = doc.resolve(changes.mapPos(fromPos, this.headSide))
    let to = doc.resolve(changes.mapPos(toPos, this.anchorSide))
    let after = from.nodeAfter, before = to.nodeBefore
    if (after && after.type == Table.type) fromPos += 2
    else if (after && after.type == TableRow.type) fromPos++
    if (before && before.type == Table.type) toPos -= 2
    else if (before && before.type == TableRow.type) toPos--
    return (this.from == this.anchor ? CellSelection.between(doc, fromPos, toPos) : CellSelection.between(doc, toPos, fromPos))
      || GardSelection.near(doc, changes.mapPos(this.head), assoc)
  }

  moveHead(doc: Plot.Doc, dir: "up" | "down" | "forward" | "backward") {
    let head = doc.resolve(this.head), headPos = this.head - (this.head > this.anchor ? head.nodeAfter!.length : 0)
    let table = head.parent!.parent!, map = TableMap.get(table.node, table.start), rect = map.findCell(headPos)
    let col = dir == "backward" ? rect.startCol - 1 : dir == "forward" ? rect.endCol : rect.startCol
    let row = dir == "up" ? rect.startRow - 1 : dir == "down" ? rect.endRow : rect.startRow
    if (col < 0 || col >= map.width || row < 0 || row >= map.height) return null
    let newHead = map.cellAt(col, row)
    if (this.head > this.anchor) newHead = map.cellEnd(newHead)
    return CellSelection.between(doc, this.anchor, newHead)
  }

  static between(doc: Plot.Doc, anchor: number, head: number) {
    let from = doc.resolve(Math.min(anchor, head)), to = doc.resolve(Math.max(anchor, head))
    let fromCell = from.nodeAfter, toCell = to.nodeBefore, table = from.parent?.parent
    if (anchor == head ||
        !fromCell || !doc.schema.matchNode(fromCell.type, Node.Group.TableCell) ||
        !toCell || !doc.schema.matchNode(toCell.type, Node.Group.TableCell) ||
        !table || table.start > to.pos || table.end < to.pos)
      return null
    let toPos = to.pos - toCell.length
    let map = TableMap.get(table.node, table.start)
    let cells = map.cellsInRect(map.rectBetween(from.pos, toPos))
    return new CellSelection(
      anchor, head,
      cells.map(pos => ({from: pos + 1, to: map.cellEnd(pos) - 1})),
      cells.indexOf(anchor - (anchor < head ? 0 : toCell.length)))
  }

  static extension = GardSelection.define<CellSelection, {anchor: number, head: number}>(
    "cell", CellSelection,
    sel => ({anchor: sel.anchor, head: sel.head}),
    (doc, json) => {
      if (!json || typeof json.anchor != "number" || typeof json.head != "number")
        throw new ValidationError("Invalid JSON data for CellSelection")
      let sel = CellSelection.between(doc, json.anchor, json.head)
      if (!sel) throw new ValidationError("Cell selection from JSON doesn't span actual cells")
      return sel
    })
}

const cellSelectionDeco = GardState.Field.define<PointSet<Decoration>>({
  create: getCellDeco,
  update: (deco, tr) => {
    return tr.docChanged || tr.selection ? getCellDeco(tr.state) : deco
  },
  provide: f => Decoration.source.of(s => s.field(f))
})

const selectedCell = Decoration.attribute("class", "wg-selected-cell")

function getCellDeco(state: GardState): PointSet<Decoration> {
  if (!(state.selection instanceof CellSelection)) return PointSet.empty
  return PointSet.create(state.selection.ranges.map(({from}) => [from - 1, selectedCell]))
}

export const drawCellSelection: GardState.Extension = [
  cellSelectionDeco,
  Wordgard.baseTheme({
    ".wg-selected-cell": {
      background: "#ddf",
      "&::selection": {background: "transparent"}
    },
  })
]

/// Given a selection, this returns null if that selection is valid
/// (is a cell selection, or a selection that starts and ends outside
/// of tables, or in the same table cell). Otherwise, it will expand a
/// selection within a single table to a cell selection, or expand a
/// selection that crosses table boundaries to cover the entire table(s).
export function normalizeTableSelection(sel: GardSelection, doc: Plot.Doc): GardSelection | null {
  if (sel instanceof CellSelection) return null
  let {from, to} = sel, modified = false
  for (let parent: Pos.Plot | null = doc.resolve(sel.from).parent, cell: Pos.Plot | null = null;
       parent; parent = parent.parent) {
    if (doc.schema.matchNode(parent.node.type, Node.Group.TableCell)) cell = parent
    if (parent.node.type == Table.type) {
      if (to > parent.end) {
        // Move out of a partially covered table
        from = parent.before
        modified = true
      } else if (!cell || to > cell.end) {
        // Inside this table, but not in same cell
        let map = TableMap.get(parent.node, parent.start)
        let start = map.nearestCell(from, 1), end = map.nearestCell(to, -1)
        if (start.from > end.from) end = start
        return sel.anchor < sel.head
          ? CellSelection.between(doc, start.from, end.to)
          : CellSelection.between(doc, end.to, start.from)
      }
    }
  }
  for (let parent: Pos.Plot | null = doc.resolve(sel.to).parent; parent; parent = parent.parent) {
    if (parent.node.type == Table.type && from < parent.start) {
      to = parent.after
      modified = true
    }
  }
  return !modified ? null : sel.anchor < sel.head ? GardSelection.range(from, to) : GardSelection.range(to, from)
}

export const tableSelectionFilter = GardState.prec.low(GardState.transactionFilter.of(tr => {
  let normalized = normalizeTableSelection(tr.newSelection, tr.newDoc)
  return normalized ? [tr, {selection: normalized}] : tr
}))
