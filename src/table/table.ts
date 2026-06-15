import {Wordgard} from "wordgard/editor"
import {GardState} from "wordgard/state"
import {Table, TableRow, Cell, HeaderCell, BlockCell, BlockHeaderCell, ColSpan, RowSpan} from "wordgard/types"
import {CellSelection} from "./cellselection"
import {tableCorrection} from "./correct"
import {tablePasteHandler, tableDropHandler} from "./tablepaste"

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
    GardState.schemaElement.of(Table), GardState.schemaElement.of(TableRow),
    tableTheme,
    CellSelection,
    tableCorrection,
    tablePasteHandler,
    tableDropHandler
  ]
  if (config.cellContent == "block") {
    result.push(GardState.schemaElement.of(BlockCell))
    if (config.headerCells != false) result.push(GardState.schemaElement.of(BlockHeaderCell))
  } else {
    result.push(GardState.schemaElement.of(Cell))
    if (config.headerCells != false) result.push(GardState.schemaElement.of(HeaderCell))
  }
  if (config.cellSpanning != false) result.push(GardState.schemaElement.of(RowSpan), GardState.schemaElement.of(ColSpan))
  return result
}
