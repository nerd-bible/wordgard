import {Wordgard} from "wordgard/view"

// FIXME display a table wrapper with overflow-x auto

export const tableTheme = Wordgard.baseTheme({
  table: {
    borderCollapse: "collapse",
    tableLayout: "fixed",
    width: "100%",
    overflow: "hidden"
  },
  "td, th": {
    verticalAlign: "top",
    boxSizing: "border-box", // FIXME used?
    border: "1px solid var(--wg-border-color)",
    padding: "3px 6px"
  },
})
