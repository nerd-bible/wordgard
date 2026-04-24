import {GardState, GardSelection} from "wordgard/state"
import {Decoration, PointSet} from "wordgard/view"
import {Node, Plot, Pos, ChangeSet, ValidationError} from "wordgard/doc"
import {Table, TableRow} from "wordgard/schema"

import {TableMap} from "./map"

export class CellSelection extends GardSelection {
  constructor(
    anchor: number,
    head: number,
    readonly _ranges: readonly {from: number, to: number}[],
    readonly anchorRange: number
  ) {
    super(anchor, head)
  }

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
    let table = head.parent!.parent!, map = TableMap.get(table.node), rect = map.findCell(headPos - table.start)
    let col = dir == "backward" ? rect.startCol - 1 : dir == "forward" ? rect.endCol : rect.startCol
    let row = dir == "up" ? rect.startRow - 1 : dir == "down" ? rect.endRow : rect.startRow
    if (col < 0 || col >= map.width || row < 0 || row >= map.height) return null
    let newHead = map.cellAt(col, row, table.node) + table.start
    if (this.head > this.anchor) newHead += map.cellEnd(newHead, table.start)
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
    let map = TableMap.get(table.node)
    let cells = map.cellsInRect(map.rectBetween(from.pos - table.start, toPos - table.start))
    return new CellSelection(
      anchor, head,
      cells.map(pos => ({from: pos + table.start + 1, to: map.cellEnd(pos, table.start) - 1})),
      cells.indexOf(anchor - table.start - (anchor < head ? 0 : toCell.length)))
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

export const drawCellSelection = GardState.Field.define<PointSet<Decoration>>({
  create: getCellDeco,
  update: (deco, tr) => {
    return tr.docChanged || tr.selection ? getCellDeco(tr.state) : deco
  },
  provide: f => Decoration.source.of(s => s.field(f))
})

const selectedCell = Decoration.attribute("class", "wg-selected-cell")

function getCellDeco(state: GardState): PointSet<Decoration> {
  if (!(state.selection instanceof CellSelection)) return PointSet.empty
  return PointSet.create(state.selection.ranges.map(({from}) => [from, selectedCell]))
}

export function normalizeToCellSelection(sel: GardSelection.Resolved) {
  if (sel instanceof CellSelection) return sel
  for (let cx: Pos.Plot | null = sel.from.parent; cx; cx = cx.parent) {
    if (sel.doc.schema.matchNode(cx.node.type, Node.Group.TableCell)) {
      const table = cx.parent?.parent
      // Selection goes from one cell in a table to another cell in
      // the same table, and has only one range
      if (table && sel.to.pos <= table.end && sel.to.pos > cx.end) {
        let after = sel.to.parentAt(cx.depth).after, doc = cx.doc
        return sel.anchor < sel.head ? CellSelection.between(doc, cx.before, after) : CellSelection.between(doc, after, cx.before)
      }
    }
  }
  return null
}
