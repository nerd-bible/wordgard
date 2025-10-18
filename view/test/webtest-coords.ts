import {EditorView} from "@wordgard/view"
import {basicBuilders} from "@wordgard/doc"
import ist from "ist"
import {tempView} from "./tempview"

const {doc, p, br, hr} = basicBuilders

const P = (view: EditorView, x: number, y: number) => {
  let pos = view.posAtCoords({x, y})
  return `${pos.pos}${pos.assoc < 0 ? "<" : pos.assoc ? ">" : ""}`
}

describe("coordsAtPos", () => {
  it("finds reasonable coordinates for simple text", () => {
    let view = tempView(doc(p("abc def ghi jkl mno pqr stu")), EditorView.theme({
      "&": { width: "5em" }
    }))
    for (let i = 1; i < view.state.doc.length - 1; i++) {
      let coords = view.coordsAtPos(i)
      ist(view.posAtCoords({x: coords.left, y: coords.top + 1}).pos, i)
    }
  })

  it("properly assigns a side to positions", () => {
    let view = tempView(doc(p("abcde fghijk")), EditorView.theme({
      "&": { width: "4em" }
    }))
    let p3 = view.coordsAtPos(3)
    ist(P(view, p3.left - 1.5, p3.top + 2), "3<")
    ist(P(view, p3.left + 1.5, p3.bottom - 2), "3>")
    let p7a = view.coordsAtPos(7, -1)
    let p7b = view.coordsAtPos(7, 1)
    ist(p7a.top, p7b.top, "<")
    ist(p7a.left, p7b.left, ">")
    ist(P(view, p7a.left + 20, p7a.top + 2), "7")
    ist(P(view, p7b.left - 10, p7b.top + 2), "7")
  })

  it("assigns positions below letters to that letter", () => {
    let view = tempView(doc(p("abcde")), EditorView.theme({
      "p": { paddingBottom: "3px" }
    }))
    let p5 = view.coordsAtPos(5)
    ist(P(view, p5.left - 1, p5.bottom + 1), "5<")
  })

  it("works around hard breaks", () => {
    let view = tempView(doc(p("ab", br(), "cd")))
    let p3 = view.coordsAtPos(3), p4 = view.coordsAtPos(4)
    ist(p3.bottom, p4.top, "<=")
    ist(P(view, p3.left - 1, p3.top + 1), "3<")
    ist(P(view, p3.left + 1, p3.top + 1), "3")
    ist(P(view, p4.left - 1, p4.top + 1), "4")
    ist(P(view, p4.left + 1, p4.top + 1), "4>")
  })

  it("works in block atoms", () => {
    let view = tempView(doc(hr(), hr(), hr()))
    let p0 = view.coordsAtPos(0)
    ist(p0.left, p0.right, "<")
    ist(p0.top, p0.bottom)
    ist(P(view, p0.left + 10, p0.top - 1), "0")
    ist(P(view, p0.left + 10, p0.top + 0.1), "0>")
    let r2 = view.contentDOM.children[1].getBoundingClientRect()
    ist(P(view, r2.left, r2.top + 0.1), "1>")
    ist(P(view, r2.left, r2.bottom - 0.1), "2<")
  })
})
