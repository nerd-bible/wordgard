import {CustomControl, Submenu, iconTable, Commands} from "wordgard/menu"
import {Wordgard} from "wordgard/view"
import {Direction, GardSelection} from "wordgard/state"
import {Table, TableRow} from "wordgard/schema"
import {Plot, ChangeSet} from "wordgard/doc"
import {cellTag} from "./tablecommands"

export const createTable = new Submenu({
  select(state) {
    return !state.sel.head.matchingParent(plot => plot.type == Table.type)
  },
  label: iconTable,
  description: "Insert a table",
  parent: Commands,
  rank: 90
})

const SVG = "http://www.w3.org/2000/svg"
const enum Grid { Size = 15, Margin = 4, Skip = Size + Margin, MaxW = 15, MaxH = 15 }

// FIXME screen reader output
class DimensionPicker {
  dom: HTMLElement
  svg: SVGElement
  width = 2
  height = 2
  gridWidth = 8
  gridHeight = 6
  ltr: boolean

  constructor(view: Wordgard, readonly finish: (width: number, height: number) => void) {
    this.dom = document.createElement("div")
    this.dom.className = "wg-dimension-picker"
    this.svg = this.dom.appendChild(document.createElementNS(SVG, "svg"))
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
    this.svg.textContent = ""
    let width = this.gridWidth * Grid.Skip + Grid.Margin
    this.svg.setAttribute("width", String(width))
    this.svg.setAttribute("height", String(this.gridHeight * Grid.Skip + Grid.Margin))
    for (let y = 0; y < this.gridHeight; y++) for (let x = 0; x < this.gridWidth; x++) {
      let rect = this.svg.appendChild(document.createElementNS(SVG, "rect"))
      rect.setAttribute("width", String(Grid.Size))
      rect.setAttribute("height", String(Grid.Size))
      let xOff = x * Grid.Skip + Grid.Margin
      rect.setAttribute("x", String(this.ltr ? xOff : width - xOff))
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
  let changes = ChangeSet.create(state.doc, {correct: {from, to, insert: [table], fit: true}, local: true})
  let tablePos = changes.findInserted(tag => tag.type == Table.type)
  view.dispatch({
    changes,
    selection: tablePos == null ? undefined : GardSelection.cursor(tablePos + 1),
    userEvent: "insert.table"
  })
}

export const createTableControl = new CustomControl({
  render(view, done) {
    return new DimensionPicker(view, (width, height) => {
      done()
      insertTable(view, width, height)
      view.focus()
    })
  },
  parent: createTable
})

const tableMenuTheme = Wordgard.baseTheme({
  ".wg-dimension-cell": {
    fill: "none",
    stroke: "#ccc",
    strokeWidth: "1.5px",
    rx: "2px"
  },
  ".wg-dimension-cell-active": {
    stroke: "var(--wg-highlight-color)"
  }
})

export const tableMenu = [
  createTable,
  createTableControl,
  tableMenuTheme
]
