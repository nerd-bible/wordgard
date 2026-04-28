import {GardState, GardSelection} from "wordgard/state"
import {Pos, Node, ChangeSet} from "wordgard/doc"
import {TableRow, HeaderCell, Cell, ColSpan, RowSpan} from "wordgard/schema"
import {Command} from "wordgard/command"

import {TableMap} from "./tablemap"
import {CellSelection} from "./cellselection"

// FIXME support block-child cells

function tableContext(state: GardState) {
  if (state.selection instanceof CellSelection)
    return {table: state.sel.anchor.parent!.parent!,
            cells: state.selection.ranges.map(r => r.from - 1)}
  for (let node: Pos.Plot | null = state.sel.head.parent; node; node = node.parent) {
    if (state.doc.schema.matchNode(node.node.type, Node.Group.TableCell) && node.parent?.parent)
      return {table: node.parent!.parent!, cells: [node.before]}
  }
  return null
}

export const toggleHeaderCell: Command.Pure = ({state}) => {
  let cx = tableContext(state)
  if (!cx) return false
  let cells = cx.cells.map(c => cx.table.node.nodeAt(c - cx.table.start)!)
  let changes: ChangeSet.Spec[] = []
  if (cells.some(x => x.type != HeaderCell.type)) {
    for (let i = 0; i < cells.length; i++) {
      let cell = cells[i], pos = cx.cells[i]
      if (cell.type != HeaderCell.type)
        changes.push({from: pos, to: pos + 1, insert: [state.doc.schema.withMarksFrom(cell.tag, HeaderCell)]})
    }
  } else {
    for (let i = 0; i < cells.length; i++) {
      let cell = cells[i], pos = cx.cells[i]
      if (cell.type == HeaderCell.type)
        changes.push({from: pos, to: pos + 1, insert: [state.doc.schema.withMarksFrom(cell.tag, Cell)]})
    }
  }
  return {changes}
}

function selectedRect(state: GardState, cx: {table: Pos.Plot, cells: number[]}, map: TableMap) {
  return state.selection instanceof CellSelection
    ? map.rectBetween(state.selection.anchorCell, state.selection.headCell)
    : map.cellRect(cx.cells[0])
}

export const addColumn: Command.Pure<"before" | "after"> = ({state}, side) => {
  let cx = tableContext(state)
  if (!cx) return false
  let map = TableMap.get(cx.table.node, cx.table.start)
  let rect = selectedRect(state, cx, map)
  let col = side == "before" ? rect.startCol : rect.endCol

  let changes: ChangeSet.Spec[] = [], adjusted = new Set<number>()
  for (let row = 0, pos; row < map.height; row++) {
    if (col > 0 && col < map.width && map.cellAt(col - 1, row) == (pos = map.cellAt(col, row))) {
      // Inside a col-spanning cell
      if (!adjusted.has(pos)) {
        let value = map.getCell(pos).mark(ColSpan) ?? 1
        changes.push({from: pos, add: ColSpan.of(value + 1)})
        adjusted.add(pos)
      }
    } else {
      changes.push({from: map.cellInsertionPos(col, row), insert: [state.doc.schema.createAndFill(Cell)]})
    }
  }
  return {
    changes,
    userEvent: "insert.column"
  }
}

export const deleteColumn: Command.Pure = ({state}) => {
  let cx = tableContext(state)
  if (!cx) return false
  let map = TableMap.get(cx.table.node, cx.table.start)
  let rect = selectedRect(state, cx, map)
  if (rect.startCol == 0 && rect.endCol == map.width) {
    return {
      changes: {from: cx.table.before, to: cx.table.after, fit: true},
      selection: doc => GardSelection.near(doc, cx.table.before, -1),
      userevent: "delete.table"
    }
  }

  let changes: ChangeSet.Spec[] = [], handled = new Set<number>(), delPos = state.selection.from
  for (let row = 0; row < map.height; row++) {
    for (let col = rect.startCol; col < rect.endCol;) {
      let cell = map.cellAt(col, row), node = map.getCell(cell), span = node.mark(ColSpan) ?? 1
      if (col == rect.startCol && col > 0 && map.cellAt(col - 1, row) == cell) {
        // Part of a col-spanning cell starting before this col
        let cellRect = map.cellRect(cell)
        if (!handled.has(cell)) {
          let newSpan = rect.startCol - cellRect.startCol + (Math.max(0, cellRect.endCol - rect.endCol))
          changes.push(newSpan == 1 ? {from: cell, remove: ColSpan.isInSet(node.marks)!}
            : {from: cell, add: ColSpan.of(newSpan)})
          handled.add(cell)
        }
        col = cellRect.endCol
      } else if (col + span > rect.endCol) {
        // Col-spanning cell that sticks out
        if (!handled.has(cell)) {
          let newSpan = col + span - rect.endCol
          changes.push(newSpan == 1 ? {from: cell, remove: ColSpan.isInSet(node.marks)!}
            : {from: cell, add: ColSpan.of(newSpan)})
          handled.add(cell)
        }
        break
      } else {
        if (!handled.has(cell)) {
          changes.push({from: cell, to: cell + node.length})
          delPos = Math.min(delPos, cell)
          handled.add(cell)
        }
        col += span
      }
    }
  }
  return {
    changes,
    selection: doc => GardSelection.near(doc, delPos, -1),
    userEvent: "delete.column"
  }
}

export const addRow: Command.Pure<"before" | "after"> = ({state}, side) => {
  let cx = tableContext(state)
  if (!cx) return false
  let map = TableMap.get(cx.table.node, cx.table.start)
  let rect = selectedRect(state, cx, map)
  let row = side == "before" ? rect.startRow : rect.endRow

  let changes: ChangeSet.Spec[] = [], adjusted = new Set<number>()
  let cellCount = map.width
  if (row > 0 && row < map.height) {
    // Look for row-spanning cells overlapping the new row
    for (let col = 0; col < map.width; col++) {
      let above = map.cellAt(col, row - 1), below = map.cellAt(col, row)
      if (above == below) {
        cellCount--
        if (!adjusted.has(above)) {
          let value = map.getCell(above).mark(RowSpan)!
          changes.push({from: above, add: RowSpan.of(value + 1)})
          adjusted.add(above)
        }
      }
    }
  }
  let cell = state.doc.schema.createAndFill(Cell), content: Node[] = []
  for (let i = 0; i < cellCount; i++) content.push(cell)
  changes.push({from: map.rowPos(row), insert: [TableRow.create(content)]})

  return {
    changes,
    userEvent: "insert.row"
  }
}

export const deleteRow: Command.Pure = ({state}) => {
  let cx = tableContext(state)
  if (!cx) return false
  let map = TableMap.get(cx.table.node, cx.table.start)
  let rect = selectedRect(state, cx, map)
  if (rect.startRow == 0 && rect.endRow == map.height) {
    return {
      changes: {from: cx.table.before, to: cx.table.after, fit: true},
      selection: doc => GardSelection.near(doc, cx.table.before, -1),
      userEvent: "delete.table"
    }
  }

  let changes: ChangeSet.Spec[] = [], handled = new Set<number>()
  // Look for cells that stick into or out of the deleted rows through rowspan
  for (let col = 0; col < map.width; col++) {
    if (rect.startRow > 0) {
      let above = map.cellAt(col, rect.startRow - 1)
      if (!handled.has(above) && map.cellAt(col, rect.startRow) == above) {
        let cellRect = map.cellRect(above)
        let rowsAbove = rect.startRow - cellRect.startRow, rowsBelow = Math.max(0, cellRect.endRow - rect.endRow)
        let rows = rowsAbove + rowsBelow
        changes.push(rows == 1 ? {from: above, remove: RowSpan.isInSet(map.getCell(above).marks)!}
          : {from: above, add: RowSpan.of(rows)})
        handled.add(above)
      }
    }
    if (rect.endRow < map.height) {
      let below = map.cellAt(col, rect.endRow)
      if (!handled.has(below) && map.cellAt(col, rect.endRow - 1) == below) {
        let cell = map.getCell(below), cellRect = map.cellRect(below)
        let rowSpan = cellRect.endRow - rect.endRow
        changes.push({from: below, to: below + cell.length})
        let copy = cell.withMarks(rowSpan == 1 ? RowSpan.removeFromSet(cell.marks) : RowSpan.of(rowSpan).addToSet(cell.marks))
        changes.push({from: map.cellInsertionPos(cellRect.startCol, rect.endRow), insert: [copy]})
        handled.add(below)
      }
    }
  }

  let delPos = state.selection.from
  for (let row = rect.startRow; row < rect.endRow; row++) {
    let rowPos = map.rowPos(row), rowNode = map.data.table.content[row]
    delPos = Math.min(delPos, rowPos)
    changes.push({from: rowPos, to: rowPos + rowNode.length})
  }
  return {
    changes,
    selection: doc => GardSelection.near(doc, delPos, -1),
    userEvent: "delete.row"
  }
}
