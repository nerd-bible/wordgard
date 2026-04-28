import {Command} from "wordgard/command"
import {Plot, Schema} from "wordgard/doc"
import {basicSchema, basicBuilders, builder, maybeTag, Table, TableRow,
        Cell, HeaderCell, ColSpan, RowSpan} from "wordgard/schema"
import {CellSelection, normalizeTableSelection, toggleHeaderCell, addRow, deleteRow, addColumn, deleteColumn} from "wordgard/table"
import {GardState, GardSelection, Transaction} from "wordgard/state"
import ist from "ist"

const {p, table, tr, td, th, rowspan, colspan} = basicBuilders

const schema = Schema.define(basicSchema.elements.concat([Table, TableRow, Cell, HeaderCell, ColSpan, RowSpan]))
const doc = builder(schema)

function eq<T extends {eq: (b: T) => boolean}>(a: T, b: T) { return a.eq(b) }

function test(doc: Plot.Doc, f: (state: GardState) => Transaction.Spec | false, expect?: Plot.Doc) {
  let selFrom = maybeTag(doc, 0), sel = selFrom != null && GardSelection.range(selFrom, maybeTag(doc, 1) ?? selFrom)
  let state = GardState.create({
    doc,
    selection: sel ? normalizeTableSelection(sel, doc) || sel : undefined,
    config: CellSelection
  })
  let result = f(state)
  if (expect) {
    ist(result)
    let tr = state.update(result as Transaction.Spec)
    state = tr.state
    ist(state.doc, expect, eq)
    if (maybeTag(expect, 0) != null) ist(maybeTag(expect, 0), state.selection.head)
  } else {
    ist(!result)
  }
}

function fromCmd<T>(command: Command.Pure<T>, param: T): (state: GardState) => Transaction.Spec | false
function fromCmd(command: Command.Pure<null>): (state: GardState) => Transaction.Spec | false
function fromCmd<T>(command: Command.Pure<T>, param?: T) {
  return (state: GardState) => command({state}, param!)
}

describe("toggleHeaderCell", () => {
  let toggle = fromCmd(toggleHeaderCell)

  it("can turn a cell into a header cell", () =>
    test(doc(table(tr(td("a", 0), td("b")))), toggle, doc(table(tr(th("a", 0), td("b"))))))

  it("can turn a header into a regular cell", () =>
    test(doc(table(tr(th("a", 0), th("b", 1)))), toggle, doc(table(tr(td("a"), td("b"))))))

  it("will set to header cells when selection is mixed", () =>
    test(doc(table(tr(th("a", 0), th("b")), tr(td("c", 1), td("d")))), toggle,
         doc(table(tr(th("a"), th("b")), tr(th("c"), td("d"))))))
})

describe("addRow", () => {
  let after = fromCmd(addRow, "after"), before = fromCmd(addRow, "before")

  it("can add a row after", () =>
    test(doc(table(tr(td("a", 0), td("b")), tr(td("c"), td("d")))), after,
         doc(table(tr(td("a", 0), td("b")), tr(td(), td()), tr(td("c"), td("d"))))))

  it("can add a row before", () =>
    test(doc(table(tr(td("a", 0), td("b")), tr(td("c"), td("d")))), before,
         doc(table(tr(td(), td()), tr(td("a", 0), td("b")), tr(td("c"), td("d"))))))

  it("will pick the position below the selection", () =>
    test(doc(table(tr(td("a", 0), td("b")), tr(td("c"), td("d", 1)))), after,
         doc(table(tr(td("a"), td("b")), tr(td("c"), td("d")), tr(td(), td())))))

  it("extends cells with a row span", () =>
    test(doc(table(tr(td("a", 0), rowspan(2, colspan(2, td("b"))), td("c")), tr(td("d"), td("e")))), after,
         doc(table(tr(td("a"), rowspan(3, colspan(2, td("b"))), td("c")), tr(td(), td()), tr(td("d"), td("e"))))))
})

describe("deleteRow", () => {
  let del = fromCmd(deleteRow)

  it("deletes the row with the cursor", () =>
    test(doc(table(tr(td("a")), tr(td("b", 0)), tr(td("c")))), del,
         doc(table(tr(td("a", 0)), tr(td("c"))))))

  it("can delete the first row", () =>
    test(doc(table(tr(td("a", 0)), tr(td("b")), tr(td("c")))), del,
         doc(0, table(tr(td("b")), tr(td("c"))))))

  it("can delete the last row", () =>
    test(doc(table(tr(td("a")), tr(td("b")), tr(td("c", 0)))), del,
         doc(table(tr(td("a")), tr(td("b", 0))))))

  it("can delete multiple rows", () =>
    test(doc(table(tr(td("a"), td("b")), tr(td("c", 0), td("d")), tr(td("e"), td("f", 1)))), del,
         doc(table(tr(td("a"), td("b", 0))))))

  it("adjusts rowspans for cells extending into the rows", () =>
    test(doc(table(tr(td("a"), rowspan(2, td("b")), rowspan(3, colspan(2, td("c")), td("d"))),
                   tr(td("e", 0), rowspan(2, td("f"))),
                   tr(td("g"), td("h")))), del,
         doc(table(tr(td("a"), td("b"), rowspan(2, colspan(2, td("c")), td("d"))),
                   tr(td("g"), td("h"), td("f"))))))

  it("can delete an entire table", () =>
    test(doc(p("a"), table(tr(td("b", 0), td("c")), tr(td("d"), td("e", 1)))), del,
         doc(p("a", 0))))
})

describe("addColumn", () => {
  let after = fromCmd(addColumn, "after"), before = fromCmd(addColumn, "before")

  it("can add a column after", () =>
    test(doc(table(tr(td("a", 0), td("b")), tr(td("c"), td("d")))), after,
         doc(table(tr(td("a", 0), td(), td("b")), tr(td("c"), td(), td("d"))))))

  it("can add a column before", () =>
    test(doc(table(tr(td("a", 0), td("b")), tr(td("c"), td("d")))), before,
         doc(table(tr(td(), td("a", 0), td("b")), tr(td(), td("c"), td("d"))))))

  it("extends cells with a col span", () =>
    test(doc(table(tr(td("a", 0), td("b")), tr(rowspan(2, colspan(2, td("c")))), tr(), tr(td("d"), td("e")))), after,
         doc(table(tr(td("a", 0), td(), td("b")), tr(rowspan(2, colspan(3, td("c")))), tr(), tr(td("d"), td(), td("e"))))))
})

describe("deleteColumn", () => {
  let del = fromCmd(deleteColumn)

  it("deletes the column with the cursor", () =>
    test(doc(table(tr(td("a"), td("b", 0)), tr(td("c"), td("d")))), del,
         doc(table(tr(td("a", 0)), tr(td("c"))))))

  it("can delete the first column", () =>
    test(doc(table(tr(td("a", 0), td("b"), td("c")))), del,
         doc(0, table(tr(td("b"), td("c"))))))

  it("can delete the last column", () =>
    test(doc(table(tr(td("a"), td("b"), td("c", 0)))), del,
         doc(table(tr(td("a"), td("b", 0))))))

  it("can delete multiple columns", () =>
    test(doc(table(tr(td("a"), td("b"), td("c")), tr(td("d", 0), td("e", 1), td("f")))), del,
         doc(table(tr(td("c")), tr(td("f"))))))

  it("adjusts colspans for cells extending into the columns", () =>
    test(doc(table(tr(td("a"), td("b", 0), td("c")),
                   tr(colspan(2, td("d")), td("e")),
                   tr(td("f"), colspan(2, rowspan(2, td("g")))),
                   tr(td("h")),
                   tr(colspan(3, td("i"))))), del,
         doc(table(tr(td("a", 0), td("c")),
                   tr(td("d"), td("e")),
                   tr(td("f"), rowspan(2, td("g"))),
                   tr(td("h")),
                   tr(colspan(2, td("i")))))))

  it("can delete an entire table", () =>
    test(doc(p("a"), table(tr(td("b", 0)), tr(td("c")))), del,
         doc(p("a", 0))))
})
