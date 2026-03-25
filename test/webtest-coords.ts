import {EditorView} from "wordgard/view"
import {GardSelection} from "wordgard/state"
import {basicBuilders} from "wordgard/schema"
import ist from "ist"
import {tempView} from "./tempview.ts"

const {doc, p, br, hr, blockquote, ul, li, strong} = basicBuilders

const P = (view: EditorView, x: number, y: number) => {
  let pos = view.posAtCoords({x, y})
  return `${pos.pos}${pos.assoc < 0 ? "<" : pos.assoc ? ">" : ""}`
}

describe("coordsAtPos", () => {
  it("finds reasonable coordinates for simple text", () => {
    let view = tempView(doc(p("abc def ghi jkl mno pqr stu")), EditorView.theme({
      "&": { width: "8ch" }
    }))
    for (let i = 1; i < view.state.doc.length - 1; i++) {
      let coords = view.coordsAtPos(i)
      ist(view.posAtCoords({x: coords.left, y: coords.top + 1}).pos, i)
    }
  })

  it("properly assigns a side to positions", () => {
    let view = tempView(doc(p("abcde fghijk")), EditorView.theme({
      "&": { width: "8ch" }
    }))
    let p3 = view.coordsAtPos(3)
    ist(P(view, p3.left - 1.5, p3.top + 2), "3<")
    ist(P(view, p3.left + 1.5, p3.bottom - 2), "3>")
    let p7a = view.coordsAtPos(7, -1)
    let p7b = view.coordsAtPos(7, 1)
    ist(p7a.top, p7b.top, "<")
    ist(p7a.left, p7b.left, ">")
    ist(P(view, p7a.left + 20, p7a.top + 2), "7<")
    ist(P(view, p7b.left - 10, p7b.top + 2), "7>")
  })

  it("assigns positions below text to the end", () => {
    let view = tempView(doc(p("abcde")), EditorView.theme({
      "p": { paddingBottom: "3px" }
    }))
    let p5 = view.coordsAtPos(5)
    ist(P(view, p5.left - 1, p5.bottom + 1), "6<")
  })

  it("assigns position below wrapped text to end", () => {
    let view = tempView(doc(p("abcde fg")), EditorView.theme({
      "p": { paddingBottom: "3px" },
      "&": { width: "6ch" }
    }))
    let p9 = view.coordsAtPos(9)
    ist(p9.top, view.coordsAtPos(1).bottom, ">=")
    ist(P(view, p9.right + 10, p9.bottom + 2), "9<")
  })

  it("works around hard breaks", () => {
    let view = tempView(doc(p("ab", br, "cd")))
    let p3 = view.coordsAtPos(3), p4 = view.coordsAtPos(4)
    ist(p3.bottom, p4.top, "<=")
    ist(P(view, p3.left - 1, p3.top + 1), "3<")
    ist(P(view, p3.left + 1, p3.top + 1), "3<")
    ist(P(view, p4.left - 1, p4.top + 1), "4>")
    ist(P(view, p4.left + 1, p4.top + 1), "4>")
  })

  it("works in block atoms", () => {
    let view = tempView(doc(hr, hr, hr))
    let p0 = view.coordsAtPos(0)
    ist(p0.left, p0.right, "<")
    ist(p0.top, p0.bottom)
    ist(P(view, p0.left + 10, p0.top - 1), "0>")
    ist(P(view, p0.left + 10, p0.top + 0.1), "0>")
    let r2 = view.contentDOM.children[1].getBoundingClientRect()
    ist(P(view, r2.left, r2.top + 0.1), "1>")
    ist(P(view, r2.left, r2.bottom - 0.1), "2<")
  })

  it("can handle different text height", () => {
    let view = tempView(doc(p("abc", strong("def"), "ghi")), EditorView.theme({
      "strong": {fontSize: "300%"}
    }))
    let c2 = view.coordsAtPos(2)
    ist(P(view, c2.left - 1, c2.top - 5), "2<")
    ist(P(view, c2.left + 1, c2.bottom + 1), "2>")
    let c8 = view.coordsAtPos(8)
    ist(P(view, c8.left - 1, c8.top - 5), "8<")
  })

  it("works in right-to-left context", () => {
    let view = tempView(doc(p("مطر")))
    let c2 = view.coordsAtPos(2)
    ist(P(view, c2.left - 1, c2.top + 2), "2>")
    ist(P(view, c2.left + 1, c2.top + 2), "2<")
  })
})

function s(pos: number, b?: number) {
  if (b == null) return GardSelection.cursor(pos)
  if (b == 1 || b == -1) return GardSelection.cursor(pos, b)
  return GardSelection.cursor(pos, 0, b)
}

describe("moveVertically", () => {
  it("can move between paragraphs", () => {
    let view = tempView(doc(p("one"), p("two")))
    ist(view.moveVertically(s(1), true)?.head, 6)
    ist(view.moveVertically(s(2), true)?.head, 7)
    ist(view.moveVertically(s(4), true)?.head, 9)
    ist(view.moveVertically(s(6), false)?.head, 1)
    ist(view.moveVertically(s(7), false)?.head, 2)
    ist(view.moveVertically(s(9), false)?.head, 4)
  })

  it("can move within a paragraph", () => {
    let view = tempView(doc(p("abcde fgh")), EditorView.theme({
      "&": { width: "6ch" }
    }))
    ist(view.moveVertically(s(1), true)?.head, 7)
    ist(view.moveVertically(s(3), true)?.head, 9)
    ist(view.moveVertically(s(6, -1), true)?.head, 10)
    ist(view.moveVertically(s(7, 1), true), null)
    ist(view.moveVertically(s(9), true), null)
    ist(view.moveVertically(s(8), false)?.head, 2)
    ist(view.moveVertically(s(1), false), null)
  })

  it("preserves a goal column", () => {
    let view = tempView(doc(p("one"), p("x"), p("two")))
    let r1 = view.moveVertically(s(4), true)
    ist(r1?.head, 7)
    ist(view.moveVertically(r1!, true)?.head, 12)
    ist(view.moveVertically(r1!, false)?.head, 4)
  })

  it("can move across atom blocks", () => {
    let view = tempView(doc(p("one"), hr, p("two"), hr))
    ist(view.moveVertically(s(2), true)?.head, 8)
    ist(view.moveVertically(s(8), true)?.head, 12)
  })

  it("can enter nested blocks", () => {
    let view = tempView(doc(p("one"), blockquote(p("two")), ul(li(p("three")), li(p("four"))), p("five")), EditorView.theme({
      "&": {fontFamily: "monospace"},
      "ul, li, blockquote": {margin: 0, padding: 0, listStyle: "none"}
    }))
    ist(view.moveVertically(s(2), true)?.head, 8)
    ist(view.moveVertically(s(8), true)?.head, 16)
    ist(view.moveVertically(s(16), true)?.head, 25)
    ist(view.moveVertically(s(25), true)?.head, 33)
    ist(view.moveVertically(s(34), false)?.head, 26)
    ist(view.moveVertically(s(26), false)?.head, 17)
    ist(view.moveVertically(s(17), false)?.head, 9)
    ist(view.moveVertically(s(9), false)?.head, 3)
  })
})
