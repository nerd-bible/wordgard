import {CustomControl, Submenu, MenuButton, icon, Commands} from "wordgard/menu"
import {Wordgard} from "wordgard/view"
import {GardState, Direction, GardSelection} from "wordgard/state"
import {Table, TableRow, RowSpan, ColSpan} from "wordgard/schema"
import {Plot, ChangeSet} from "wordgard/doc"
import {Command} from "wordgard/command"
import {cellTag, headerCellTag,
        addRow, deleteRow, addColumn, deleteColumn, mergeCells, splitCell, toggleHeaderCell} from "./tablecommands"
import {CellSelection} from "./cellselection"

const SVG = "http://www.w3.org/2000/svg"
const enum Grid { Size = 15, Margin = 4, Skip = Size + Margin, MaxW = 15, MaxH = 15 }

// FIXME test screen reader output

class DimensionPicker {
  dom: HTMLElement
  svg: SVGElement
  announce: HTMLElement
  width = 2
  height = 2
  gridWidth = 6
  gridHeight = 4
  ltr: boolean

  constructor(readonly view: Wordgard, readonly finish: (width: number, height: number) => void) {
    this.dom = document.createElement("div")
    this.dom.className = "wg-dimension-picker"
    this.announce = this.dom.appendChild(document.createElement("div"))
    this.announce.className = "wg-dimension-announce"
    this.announce.setAttribute("aria-live", "polite")
    this.svg = this.dom.appendChild(document.createElementNS(SVG, "svg"))
    this.svg.setAttribute("aria-hidden", "true")
    this.ltr = view.state.textDirection() == Direction.LTR
    this.render()
    this.dom.addEventListener("mousemove", e => {
      let rect = this.svg.getBoundingClientRect()
      let xOff = this.ltr ? e.clientX - Grid.Margin - rect.left : rect.right - Grid.Margin - e.clientX
      let yOff = e.clientY - Grid.Margin - rect.top
      let x = Math.max(0, Math.floor(xOff / Grid.Skip)), y = Math.max(0, Math.floor(yOff / Grid.Skip))
      this.setSize(x + 1, y + 1)
    })
    this.dom.addEventListener("mousedown", e => {
      if (e.button == 0) {
        e.preventDefault()
        this.finish(this.width, this.height)
      }
    })
    this.dom.addEventListener("keydown", e => {
      if (e.key == (this.ltr ? "ArrowLeft" : "ArrowRight") && this.width > 1) {
        this.setSize(this.width - 1, this.height)
      } else if (e.key == (this.ltr ? "ArrowRight" : "ArrowLeft") && this.width < Grid.MaxW) {
        this.setSize(this.width + 1, this.height)
      } else if (e.key == "ArrowUp" && this.height > 1) {
        this.setSize(this.width, this.height - 1)
      } else if (e.key == "ArrowDown" && this.height < Grid.MaxH) {
        this.setSize(this.width, this.height + 1)
      } else if (e.key == " " || e.key == "Enter") {
        this.finish(this.width, this.height)
      } else {
        return
      }
      e.preventDefault()
    })
  }

  render() {
    this.dom.setAttribute("aria-label", this.view.state.phrase("Table dimensions $1 by $2. Use arrow keys to change.",
                                                               this.width, this.height))
    this.announce.textContent = this.view.state.phrase("$1 by $2", this.width, this.height)
    this.svg.textContent = ""
    let width = this.gridWidth * Grid.Skip + Grid.Margin
    this.svg.setAttribute("width", String(width))
    this.svg.setAttribute("height", String(this.gridHeight * Grid.Skip + Grid.Margin))
    for (let y = 0; y < this.gridHeight; y++) for (let x = 0; x < this.gridWidth; x++) {
      let rect = this.svg.appendChild(document.createElementNS(SVG, "rect"))
      rect.setAttribute("width", String(Grid.Size))
      rect.setAttribute("height", String(Grid.Size))
      rect.setAttribute("x", String(this.ltr ? x * Grid.Skip + Grid.Margin : width - (x + 1) * Grid.Skip))
      rect.setAttribute("y", String(y * Grid.Skip + Grid.Margin))
      rect.setAttribute("class", "wg-dimension-cell" + (x < this.width && y < this.height ? " wg-dimension-cell-active" : ""))
    }
  }

  setSize(width: number, height: number) {
    if (width == this.width && height == this.height) return
    this.width = Math.min(Grid.MaxW, width)
    this.height = Math.min(Grid.MaxH, height)
    if (this.gridWidth <= this.width) this.gridWidth = Math.min(Grid.MaxW, this.width + 1)
    if (this.gridHeight <= this.height) this.gridHeight = Math.min(Grid.MaxH, this.height + 1)
    this.render()
  }
}

function insertTable(view: Wordgard, width: number, height: number) {
  let {state} = view, {schema} = state.doc, cell = cellTag(schema)
  if (!cell) return
  let cellNode = schema.createAndFill(cell) as Plot, cells: Plot[] = []
  for (let i = 0; i < width; i++) cells.push(cellNode)
  let row = TableRow.create(cells), rows: Plot[] = []
  for (let i = 0; i < height; i++) rows.push(row)
  let table = Table.create(rows), {from, to} = state.selection.replacemenRange
  let changes = ChangeSet.create(state.doc, {from, to, insert: [table], fit: true})
  let tablePos = changes.findInserted(tag => tag.type == Table.type)
  view.dispatch({
    changes,
    selection: doc => GardSelection.near({doc, config: state.config}, tablePos == null ? from : tablePos + 3, 1),
    userEvent: "insert.table"
  })
}

const createTable = new Submenu({
  select(state) {
    return state.doc.schema.has(Table) && !state.sel.head.matchingParent(plot => plot.type == Table.type)
  },
  label: icon.Table,
  description: "Insert a table",
  parent: Commands,
  rank: 90
})

const modifyTable = new Submenu({
  select(state) {
    return !!state.sel.head.matchingParent(plot => plot.type == Table.type)
  },
  label: icon.Table,
  description: "Insert a table",
  parent: Commands,
  rank: 90
})

export const menu = {
  createTable,

  dimensionPicker: new CustomControl({
    render(view, done) {
      return new DimensionPicker(view, (width, height) => {
        done()
        insertTable(view, width, height)
        view.focus()
      })
    },
    parent: createTable
  }),

  modifyTable,

  toggleHeader: new MenuButton({
    run: toggleHeaderCell,
    select: state => !!headerCellTag(state.doc.schema),
    label: "Toggle header cells",
    parent: modifyTable,
    rank: 10
  }),

  addRowAbove: new MenuButton({
    run: view => Command.dispatch(view, addRow, "before"),
    label: "Add row above",
    parent: modifyTable,
    rank: 20,
  }),

  addRowBelow: new MenuButton({
    run: view => Command.dispatch(view, addRow, "after"),
    label: "Add row below",
    parent: modifyTable,
    rank: 21,
  }),

  deleteRow: new MenuButton({
    run: deleteRow,
    label: "Delete row",
    parent: modifyTable,
    rank: 25
  }),

  addColumnBefore: new MenuButton({
    run: view => Command.dispatch(view, addColumn, "before"),
    label: "Add column before",
    parent: modifyTable,
    rank: 30,
  }),

  addColumnAfter: new MenuButton({
    run: view => Command.dispatch(view, addColumn, "after"),
    label: "Add column after",
    parent: modifyTable,
    rank: 31,
  }),

  deleteColumn: new MenuButton({
    run: deleteColumn,
    label: "Delete column",
    parent: modifyTable,
    rank: 35,
  }),

  mergeCells: new MenuButton({
    run: mergeCells,
    select: state => {
      let {selection} = state
      return selection instanceof CellSelection && selection.ranges.length > 1 &&
        state.doc.schema.has(ColSpan) && state.doc.schema.has(RowSpan)
    },
    label: "Merge cells",
    parent: modifyTable,
    rank: 40,
  }),

  splitCell: new MenuButton({
    run: splitCell,
    select: state => {
      let {selection} = state
      if (!(selection instanceof CellSelection) || selection.ranges.length != 1) return false
      let cell = state.sel.from.nodeAfter
      return !!(cell && (cell.mark(ColSpan) || cell.mark(RowSpan)))
    },
    label: "Split cell",
    parent: modifyTable,
    rank: 41,
  })
}

export function tableMenu(): GardState.Extension {
  return [
    menu.createTable,
    menu.dimensionPicker,
    menu.modifyTable,
    menu.toggleHeader,
    menu.addRowAbove, menu.addRowBelow, menu.deleteRow,
    menu.addColumnBefore, menu.addColumnAfter, menu.deleteColumn,
    menu.mergeCells, menu.splitCell
  ]
}
