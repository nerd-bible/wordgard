// This file defines helpers for normalizing tables, making sure no
// cells overlap (which can happen, if you have the wrong col- and
// rowspans) and that each row has the same width. Uses the problems
// reported by `TableMap`.

import {Plot, ChangeSet} from "wordgard/doc"
import {Table, ColSpan, RowSpan} from "wordgard/schema"
import {Correction} from "wordgard/state"
import {TableMap} from "./map"

/// Correct tables where the cells do not form a proper rectangle.
export const tableCorrection = Correction.onContent(Table, (pos, state) => {
  let map = TableMap.get(pos.node)
  if (!map.problems) return null

  // Track which rows we must add cells to, so that we can adjust that
  // when fixing collisions.
  let mustAdd: number[] = [], changes: ChangeSet.Spec[] = []
  for (let i = 0; i < map.height; i++) mustAdd.push(0)
  for (let i = 0; i < map.problems.length; i++) {
    let prob = map.problems[i]
    if (prob.type == "collision") {
      let cell = pos.node.nodeAt(prob.pos)!, cur = ColSpan.isInSet(cell.marks)!, newVal = cur.value - prob.n
      let from = pos.start + prob.pos, rowSpan = cell.mark(RowSpan) ?? 1
      for (let j = 0; j < rowSpan; j++) mustAdd[prob.row + j] += prob.n
      changes.push(newVal == 1 ? {from, remove: cur} : {from, add: ColSpan.of(newVal)})
    } else if (prob.type == "missing") {
      mustAdd[prob.row] += prob.n
    } else if (prob.type == "overlong_rowspan") {
      let cell = pos.node.nodeAt(prob.pos)!, cur = RowSpan.isInSet(cell.marks)!, newVal = cur.value - prob.n
      let from = pos.start + prob.pos
      changes.push(newVal == 1 ? {from, remove: cur} : {from, add: RowSpan.of(newVal)})
    }
  }
  let first, last
  for (let i = 0; i < mustAdd.length; i++) if (mustAdd[i]) {
    if (first == null) first = i
    last = i
  }
  // Add the necessary cells, using a heuristic for whether to add the
  // cells at the start or end of the rows (if it looks like a 'bite'
  // was taken out of the table, add cells at the start of the row
  // after the bite. Otherwise add them at the end).
  for (let i = 0, curPos = pos.start; i < map.height; i++) {
    let row = pos.node.content[i] as Plot, end = curPos + row.length
    let add = mustAdd[i]
    if (add > 0) {
      let cell = state.doc.schema.defaultContentPlot(row.tag.type)!
      let nodes = []
      for (let j = 0; j < add; j++)
        nodes.push(cell.create(cell.isBlock ? [state.doc.schema.createDefault(cell.type)] : []))
      let side = (i == 0 || first == i - 1) && last == i ? curPos + 1 : end - 1
      changes.push({from: side, insert: nodes})
    }
    curPos = end
  }

  return changes
})
