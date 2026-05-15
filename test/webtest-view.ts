import {Wordgard} from "wordgard/editor"
import {Leaf} from "wordgard/doc"
import {basicBuilders} from "./schema.ts"
import ist from "ist"
import {tempEditor} from "./tempview.ts"

const {doc, p} = basicBuilders

describe("Wordgard", () => {
  it("calls update on plugins", () => {
    let updates = 0
    let plugin = Wordgard.Plugin.define(wg => {
      let prevDoc = wg.state.doc
      return {
        update(update: Wordgard.Update) {
          ist(update.startState.doc, prevDoc)
          ist(update.state.doc, wg.state.doc)
          prevDoc = update.state.doc
          updates++
        }
      }
    })
    let wg = tempEditor(doc(p("xyz")), [plugin])
    ist(updates, 0)
    wg.dispatch({changes: {from: 2, to: 3, insert: [Leaf.text("u")]}})
    wg.flush()
    ist(updates, 1)
    wg.dispatch({selection: {anchor: 3}})
    wg.flush()
    ist(updates, 2)
  })

  it("allows content attributes to be changed through extensions", () => {
    let wg = tempEditor(doc(p()), [Wordgard.contentAttributes.of({"aria-label": "test"})])
    ist(wg.contentDOM.getAttribute("aria-label"), "test")
  })

  it("allows editor attributes to be changed through extensions", () => {
    let wg = tempEditor(doc(p()), [Wordgard.editorAttributes.of({class: "something"})])
    ist(wg.dom.classList.contains("something"))
  })

  it("repairs changes to text nodes", () => {
    let wg = tempEditor(doc(p("abc")))
    wg.contentDOM.firstChild!.firstChild!.nodeValue = "a"
    wg.flush()
    ist(wg.contentDOM.innerHTML, "<p>abc</p>")
  })

  it("repairs modified attributes", () => {
    let wg = tempEditor(doc(p("abc")))
    ;(wg.contentDOM.firstChild as HTMLElement).setAttribute("test", "test")
    wg.flush()
    ist(wg.contentDOM.innerHTML, "<p>abc</p>")
  })
})
