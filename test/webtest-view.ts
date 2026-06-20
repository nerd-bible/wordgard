import {Wordgard} from "wordgard/editor"
import {Transaction} from "wordgard/state"
import {Leaf} from "wordgard/doc"
import {basicBuilders, eq} from "./schema.ts"
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

  it("allows dispatches from beforeUpdate", () => {
    let wg = tempEditor(doc(p("x")), Wordgard.beforeUpdate.of(u => {
      if (u.state.doc.length == 4) wg.dispatch({changes: {from: 1, to: 2}})
    }))
    wg.dispatch({changes: {from: 2, insert: [Leaf.text("y")]}})
    ist(wg.state.doc, doc(p("xy")), eq)
    wg.flush()
    ist(wg.state.doc, doc(p("y")), eq)
  })

  it("disallows dispatches from plugin update", () => {
    let wg = tempEditor(doc(p("x")), Wordgard.Plugin.fromClass(class {
      update(u: Wordgard.Update) {
        if (u.state.doc.length == 4) ist.throws(() => {
          wg.dispatch({changes: {from: 1, to: 2}})
        }, /Cannot dispatch new updates/)
      }
    }))
    wg.dispatch({changes: {from: 2, insert: [Leaf.text("y")]}})
    wg.flush()
  })

  it("automatically flushes on DOM access", () => {
    let wg = tempEditor(doc(p("abc")))
    let c1 = wg.coordsAtPos(4)
    wg.dispatch({changes: {from: 0, insert: [p()]}})
    let c2 = wg.coordsAtPos(4)
    ist(c2.top, c1.top, ">")
  })

  it("applies transaction appenders", () => {
    let wg = tempEditor(doc(p()), Transaction.appender.of((trs, state) => {
      return state.doc.length >= 5 ? {changes: {from: 5, to: state.doc.length, fit: true}} : null
    }))
    wg.dispatch({changes: {from: 1, insert: [Leaf.text("more content")]}})
    ist(wg.state.doc, doc(p("more")), eq)
  })
})
