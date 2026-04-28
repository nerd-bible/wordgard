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

// FIXME export or not?

import {Plot} from "wordgard/doc"
import {Table, ColSpan, RowSpan} from "wordgard/schema"

export class Rect {
  constructor(readonly startCol: number,
              readonly startRow: number,
              readonly endCol: number, // Not inclusive
              readonly endRow: number) {}
}

type Problem =
  | {type: "collision", pos: number, row: number, n: number}
  | {type: "missing", row: number, n: number}
  | {type: "overlong_rowspan", pos: number, n: number}

// FIXME store offset in a wrapper object for less awkward access

class MapData {
  constructor(
    readonly table: Plot,
    readonly width: number,
    readonly height: number,
    readonly map: number[],
    readonly problems: Problem[] | null,
    readonly cellEnds: Map<number, number>
  ) {}
}

let cache = new WeakMap<Plot, MapData>()

/// A table map describes the structore of a given table. To avoid
/// recomputing them all the time, they are cached per table node. To
/// be able to do that, positions saved in the map are relative to the
/// start of the table, rather than the start of the document.
export class TableMap {
  constructor(readonly start: number, readonly data: MapData) {}

  get width() { return this.data.width }
  get height() { return this.data.height }
  get table() { return this.data.table }
  get tablePos() { return this.start - 1 }

  /// Find the dimensions of the cell at the given position.
  cellRect(pos: number) {
    let localPos = pos - this.start, {map, width, height} = this.data
    for (let i = 0; i < map.length; i++) if (map[i] == localPos) {
      let startCol = i % width, startRow = (i / width) | 0
      let endCol = startCol + 1, endRow = startRow + 1
      for (let j = 1; endCol < width && map[i + j] == localPos; j++) endCol++
      for (let j = 1; endRow < height && map[i + (width * j)] == localPos; j++) endRow++
      return new Rect(startCol, startRow, endCol, endRow)
    }
    throw new RangeError(`No cell with offset ${pos} found`)
  }

  nearestCell(pos: number, bias: -1 | 1) {
    let localPos = pos - this.start, after = -1, before = -1
    let {map, cellEnds} = this.data
    for (let i = 0; i < map.length; i++) {
      let cellPos = map[i]
      if (cellPos >= localPos && (after < 0 || after > cellPos)) after = cellPos
      if (cellPos < localPos && before < cellPos) before = cellPos
    }
    if (before > -1) {
      let beforeEnd = cellEnds.get(before)!
      if (beforeEnd > localPos || after < 0 || bias < 0)
        return {from: before + this.start, to: beforeEnd + this.start}
    }
    return {from: after + this.start, to: cellEnds.get(after)! + this.start}
  }

  cellEnd(pos: number) {
    let end = this.data.cellEnds.get(pos - this.start)
    if (end == null) throw new Error(`No cell with offset ${pos} found`)
    return end + this.start
  }

  /// Get the rectangle spanning the two given cells.
  rectBetween(a: number, b: number) {
    let {startCol: startColA, endCol: endColA, startRow: startRowA, endRow: endRowA} = this.cellRect(a)
    let {startCol: startColB, endCol: endColB, startRow: startRowB, endRow: endRowB} = this.cellRect(b)
    return new Rect(Math.min(startColA, startColB), Math.min(startRowA, startRowB),
                    Math.max(endColA, endColB), Math.max(endRowA, endRowB))
  }

  /// Return the position of all cells that have their top start
  /// corner in the given rectangle.
  cellsInRect(rect: Rect) {
    let result: number[] = [], {map, width} = this.data
    for (let row = rect.startRow; row < rect.endRow; row++) {
      for (let col = rect.startCol; col < rect.endCol; col++) {
        let index = row * width + col, pos = map[index]
        if (result.indexOf(pos + this.start) < 0 &&
          (col != rect.startCol || !col || map[index - 1] != pos) &&
          (row != rect.startRow || !row || map[index - width] != pos))
          result.push(pos + this.start)
      }
    }
    return result
  }

  /// Return the position of the cell that occupies the position at the
  /// given row and column (which must be in bounds for the table).
  cellAt(col: number, row: number) {
    let {width, map} = this.data
    return map[col + row * width] + this.start
  }

  /// Get the position at the start of the given row (which may be
  /// `width` to query the position after the last row).
  rowPos(row: number) {
    let {start} = this, {table} = this.data
    for (let r = 0; r < row; r++) start += table.content[r].length
    return start
  }

  /// Get the position where a cell would have to be inserted to
  /// appear at the given column and row.
  cellInsertionPos(col: number, row: number) {
    let {width, map} = this.data
    for (let scan = col;; scan++) {
      if (scan == width) return this.rowPos(row + 1) - 1
      let index = scan + row * width, pos = map[index]
      if (!row || pos != map[index - width]) return pos + this.start
    }
  }

  /// Get the node for the cell at the given position.
  getCell(pos: number): Plot {
    let found = this.data.table.plotAt(pos - this.start)
    if (!found) throw new Error("Invalid cell position")
    return found
  }

  cellsOverlapRectangle(rect: Rect) {
    let {width, height, map} = this.data
    let indexTop = rect.startRow * width + rect.startCol, indexBefore = indexTop
    let indexBottom = (rect.endRow - 1) * width + rect.endCol, indexAfter = indexTop + (rect.endCol - rect.startCol - 1)
    for (let i = rect.startRow; i < rect.endRow; i++) {
      if (rect.startCol > 0 && map[indexBefore] == map[indexBefore - 1] ||
          rect.endCol < width && map[indexAfter] == map[indexAfter + 1]) return true
      indexBefore += width; indexAfter += width
    }
    for (let i = rect.startCol; i < rect.endCol; i++) {
      if (rect.startRow > 0 && map[indexTop] == map[indexTop - width] ||
          rect.endRow < height && map[indexBottom] == map[indexBottom + width]) return true
      indexTop++; indexBottom++
    }
    return false
  }

  /// Find the table map for the given table node.
  static get(table: Plot, start: number): TableMap {
    let data = cache.get(table)
    if (!data) cache.set(table, data = computeMap(table))
    return new TableMap(start, data)
  }
}

// Compute a table map.
function computeMap(table: Plot) {
  if (table.tag != Table) throw new RangeError(`Not a table node: ${table.type.name}`)
  let width = findWidth(table), height = table.content.length
  let map = [], mapPos = 0, problems: Problem[] | null = null
  for (let i = 0, e = width * height; i < e; i++) map[i] = 0
  let cellEnd = new Map<number, number>()

  for (let row = 0, pos = 0; row < height; row++) {
    let rowNode = table.content[row] as Plot
    pos++
    for (let i = 0;; i++) {
      while (mapPos < map.length && map[mapPos] != 0) mapPos++
      if (i == rowNode.content.length) break
      let cellNode = rowNode.content[i]
      cellEnd.set(pos, pos + cellNode.length)
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

  return new MapData(table, width, height, map, problems, cellEnd)
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
