import {Wordgard} from "wordgard/view"
import {GardState} from "wordgard/state"
import {Table, TableRow, Cell, HeaderCell, BlockCell, BlockHeaderCell, ColSpan, RowSpan} from "wordgard/schema"
import {CellSelection} from "./cellselection"
import {tableCorrection} from "./correct"
import {tablePasteHandler} from "./tablepaste"

const tableTheme = Wordgard.baseTheme({
  table: {
    borderCollapse: "collapse",
    tableLayout: "fixed",
    width: "100%",
    overflow: "hidden"
  },
  "td, th": {
    verticalAlign: "top",
    border: "1px solid var(--wg-border-color)",
    padding: "3px 6px",
    textAlign: "left"
  },

  ".wg-selected-cell": {
    background: "#ddf",
    "&::selection, & ::selection": {backgroundColor: "transparent"},
    "& :focus ::selection, & :focus::selection": {backgroundColor: "Highlight"}
  },

  ".wg-dimension-announce": {
    position: "absolute",
    width: "0px",
    overflow: "hidden"
  },
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

export function tables(config: {
  headerCells?: boolean,
  cellSpanning?: boolean,
  cellContent?: "inline" | "block"
} = {}): GardState.Extension {
  let result: GardState.Extension[] = [
    Table, TableRow,
    tableTheme,
    CellSelection,
    tableCorrection,
    tablePasteHandler
  ]
  if (config.cellContent == "block") {
    result.push(BlockCell)
    if (config.headerCells != false) result.push(BlockHeaderCell)
  } else {
    result.push(Cell)
    if (config.headerCells != false) result.push(HeaderCell)
  }
  if (config.cellSpanning != false) result.push(RowSpan, ColSpan)
  return result
}
