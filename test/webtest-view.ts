import {Wordgard} from "wordgard/view"
import {Leaf} from "wordgard/doc"
import {GardState} from "wordgard/state"
import {basicBuilders} from "wordgard/schema"
import ist from "ist"
import {tempView} from "./tempview.ts"

const {doc, p} = basicBuilders

describe("Wordgard", () => {
  it("calls update on plugins", () => {
    let updates = 0
    let plugin = Wordgard.Plugin.define(view => {
      let prevDoc = view.state.doc
      return {
        update(update: Wordgard.Update) {
          ist(update.startState.doc, prevDoc)
          ist(update.state.doc, view.state.doc)
          prevDoc = update.state.doc
          updates++
        }
      }
    })
    let view = tempView(doc(p("xyz")), [plugin])
    ist(updates, 0)
    view.dispatch({changes: {from: 2, to: 3, insert: [Leaf.text("u")]}})
    view.flush()
    ist(updates, 1)
    view.dispatch({selection: {anchor: 3}})
    view.flush()
    ist(updates, 2)
  })

  it("allows content attributes to be changed through extensions", () => {
    let view = tempView(doc(p()), [Wordgard.contentAttributes.of({"aria-label": "test"})])
    ist(view.contentDOM.getAttribute("aria-label"), "test")
  })

  it("allows editor attributes to be changed through extensions", () => {
    let view = tempView(doc(p()), [Wordgard.editorAttributes.of({class: "something"})])
    ist(view.dom.classList.contains("something"))
  })

  it("redraws the view when phrases change", () => {
    let plugin = Wordgard.Plugin.fromClass(class {
      elt: HTMLElement
      constructor(view: Wordgard) {
        let elt = this.elt = view.dom.appendChild(document.createElement("div"))
        elt.textContent = view.state.phrase("Hello")
        elt.style.position = "absolute"
        elt.className = "greeting"
      }
      destroy() { this.elt.remove() }
    })
    let lang = new GardState.Compartment
    let view = tempView(doc(p("one")), [plugin, lang.of([])])
    ist(view.dom.querySelector(".greeting")!.textContent, "Hello")
    view.dispatch({effects: lang.reconfigure(GardState.phrases.of({Hello: "Bonjour"}))})
    view.flush()
    ist(view.dom.querySelector(".greeting")!.textContent, "Bonjour")
  })

  it("repairs changes to text nodes", () => {
    let view = tempView(doc(p("abc")))
    view.contentDOM.firstChild!.firstChild!.nodeValue = "a"
    view.flush()
    ist(view.contentDOM.innerHTML, "<p>abc</p>")
  })

  it("repairs modified attributes", () => {
    let view = tempView(doc(p("abc")))
    ;(view.contentDOM.firstChild as HTMLElement).setAttribute("test", "test")
    view.flush()
    ist(view.contentDOM.innerHTML, "<p>abc</p>")
  })
})
