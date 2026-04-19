// Because working with row and column-spanning cells is not quite
// trivial, this code builds up a descriptive structure for a given
// table node. The structures are cached with the (persistent) table
// nodes as key, so that they only have to be recomputed when the
// content of the table changes.
//
// This does mean that they have to store table-relative, not
// document-relative positions. So code that uses them will typically
// compute the start position of the table and offset positions passed
// to or gotten from this structure by that amount.

import {Plot} from "wordgard/doc"
import {Table, ColSpan, RowSpan} from "wordgard/schema"

let cache = new WeakMap

export class Rect {
  constructor(readonly left: number,
              readonly top: number,
              readonly right: number,
              readonly bottom: number) {}
}

type Problem =
  | {type: "collision", pos: number, row: number, n: number}
  | {type: "missing", row: number, n: number}
  | {type: "overlong_rowspan", pos: number, n: number}

/// A table map describes the structore of a given table. To avoid
/// recomputing them all the time, they are cached per table node. To
/// be able to do that, positions saved in the map are relative to the
/// start of the table, rather than the start of the document.
export class TableMap {
  constructor(
    readonly width: number,
    readonly height: number,
    readonly map: number[],
    readonly problems: Problem[] | null
  ) {}

  /// Find the dimensions of the cell at the given position.
  findCell(pos: number) {
    for (let i = 0; i < this.map.length; i++) if (this.map[i] == pos) {
      let left = i % this.width, top = (i / this.width) | 0
      let right = left + 1, bottom = top + 1
      for (let j = 1; right < this.width && this.map[i + j] == pos; j++) right++
      for (let j = 1; bottom < this.height && this.map[i + (this.width * j)] == pos; j++) bottom++
      return new Rect(left, top, right, bottom)
    }
    throw new RangeError(`No cell with offset ${pos} found`)
  }

  /// Find the left side of the cell at the given position.
  colCount(pos: number) {
    for (let i = 0; i < this.map.length; i++)
      if (this.map[i] == pos) return i % this.width
    throw new RangeError("No cell with offset " + pos + " found")
  }

  /// Find the next cell in the given direction, starting from the cell
  /// at `pos`, if any.
  nextCell(pos: number, axis: "horiz" | "vert", dir: -1 | 1) {
    let {left, right, top, bottom} = this.findCell(pos)
    if (axis == "horiz") {
      if (dir < 0 ? left == 0 : right == this.width) return null
      return this.map[top * this.width + (dir < 0 ? left - 1 : right)]
    } else {
      if (dir < 0 ? top == 0 : bottom == this.height) return null
      return this.map[left + this.width * (dir < 0 ? top - 1 : bottom)]
    }
  }

  /// Get the rectangle spanning the two given cells.
  rectBetween(a: number, b: number) {
    let {left: leftA, right: rightA, top: topA, bottom: bottomA} = this.findCell(a)
    let {left: leftB, right: rightB, top: topB, bottom: bottomB} = this.findCell(b)
    return new Rect(Math.min(leftA, leftB), Math.min(topA, topB),
                    Math.max(rightA, rightB), Math.max(bottomA, bottomB))
  }

  /// Return the position of all cells that have the top left corner in
  /// the given rectangle.
  cellsInRect(rect: Rect) {
    let result: number[] = []
    for (let row = rect.top; row < rect.bottom; row++) {
      for (let col = rect.left; col < rect.right; col++) {
        let index = row * this.width + col, pos = this.map[index]
        if (result.indexOf(pos) < 0 &&
            (col != rect.left || !col || this.map[index - 1] != pos) &&
            (row != rect.top || !row || this.map[index - this.width] != pos))
          result.push(pos)
      }
    }
    return result
  }

  /// Return the position at which the cell at the given row and column
  /// starts, or would start, if a cell started there.
  positionAt(row: number, col: number, table: Plot) {
    for (let i = 0, rowStart = 0;; i++) {
      let rowEnd = rowStart + table.content[i].length
      if (i == row) {
        let index = col + row * this.width, rowEndIndex = (row + 1) * this.width
        // Skip past cells from previous rows (via rowspan)
        while (index < rowEndIndex && this.map[index] < rowStart) index++
        return index == rowEndIndex ? rowEnd - 1 : this.map[index]
      }
      rowStart = rowEnd
    }
  }

  /// Find the table map for the given table node.
  static get(table: Plot) {
    let found = cache.get(table)
    if (!found) cache.set(table, found = computeMap(table))
    return found
  }
}

// Compute a table map.
function computeMap(table: Plot) {
  if (table.tag != Table) throw new RangeError(`Not a table node: ${table.type.name}`)
  let width = findWidth(table), height = table.content.length
  let map = [], mapPos = 0, problems: Problem[] | null = null
  for (let i = 0, e = width * height; i < e; i++) map[i] = 0

  for (let row = 0, pos = 0; row < height; row++) {
    let rowNode = table.content[row] as Plot
    pos++
    for (let i = 0;; i++) {
      while (mapPos < map.length && map[mapPos] != 0) mapPos++
      if (i == rowNode.content.length) break
      let cellNode = rowNode.content[i]
      let colspan = cellNode.mark(ColSpan) ?? 1, rowspan = cellNode.mark(RowSpan) ?? 1
      for (let h = 0; h < rowspan; h++) {
        if (h + row >= height) {
          (problems || (problems = [])).push({type: "overlong_rowspan", pos, n: rowspan - h})
          break
        }
        let start = mapPos + (h * width)
        for (let w = 0; w < colspan; w++) {
          if (map[start + w] == 0)
            map[start + w] = pos
          else
            (problems || (problems = [])).push({type: "collision", row, pos, n: colspan - w})
        }
      }
      mapPos += colspan
      pos += cellNode.length
    }
    let expectedPos = (row + 1) * width, missing = 0
    while (mapPos < expectedPos) if (map[mapPos++] == 0) missing++
    if (missing) (problems || (problems = [])).push({type: "missing", row, n: missing})
    pos++
  }

  return new TableMap(width, height, map, problems)
}

function findWidth(table: Plot) {
  let width = -1, hasRowSpan = false
  for (let row = 0; row < table.content.length; row++) {
    let rowNode = table.content[row] as Plot, rowWidth = 0
    if (hasRowSpan) for (let j = 0; j < row; j++) {
      let prevRow = table.content[j] as Plot
      for (let i = 0; i < prevRow.content.length; i++) {
        let cell = prevRow.content[i]
        if (j + (cell.mark(RowSpan) ?? 1) > row) rowWidth += cell.mark(ColSpan) ?? 1
      }
    }
    for (let i = 0; i < rowNode.content.length; i++) {
      let cell = rowNode.content[i]
      rowWidth += cell.mark(ColSpan) ?? 1
      if ((cell.mark(RowSpan) ?? 1) > 1) hasRowSpan = true
    }
    if (width == -1) width = rowWidth
    else if (width != rowWidth) width = Math.max(width, rowWidth)
  }
  return width
}
