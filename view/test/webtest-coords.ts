import {EditorView} from "@wordgard/view"
import {basicBuilders} from "@wordgard/doc"
import ist from "ist"
import {tempView} from "./tempview"

const {doc, p, $img, hr} = basicBuilders

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
    let l3 = view.posAtCoords({x: p3.left - 1.5, y: p3.top + 2})
    ist(l3.pos, 3)
    ist(l3.assoc, -1)
    let r3 = view.posAtCoords({x: p3.left + 1.5, y: p3.bottom - 2})
    ist(r3.pos, 3)
    ist(r3.assoc, 1)
    let p7a = view.coordsAtPos(7, -1)
    let p7b = view.coordsAtPos(7, 1)
    ist(p7a.top, p7b.top, "<")
    ist(p7a.left, p7b.left, ">")
    let r7a = view.posAtCoords({x: p7a.left + 20, y: p7a.top + 2})
    ist(r7a.pos, 7)
    ist(r7a.assoc, 0)
    let r7b = view.posAtCoords({x: p7b.left - 10, y: p7b.top + 2})
    ist(r7b.pos, 7)
    ist(r7b.assoc, 0)
  })
})
