import {EditorView} from "@wordgard/view"
import {basicBuilders, Strong} from "@wordgard/doc"
import {EditorSelection} from "@wordgard/state"
import ist from "ist"
import {tempView, requireFocus} from "./tempview"

const {doc, p, strong, em} = basicBuilders

function eq<T extends {eq: (other: T) => boolean}>(a: T, b: T) { return a.eq(b) }

function compositionEvent(cm: EditorView, type: string) {
  cm.contentDOM.dispatchEvent(new CompositionEvent(type))
}

function inputEvent(cm: EditorView, type: string, init: InputEventInit) {
  cm.contentDOM.dispatchEvent(new InputEvent(type, init))
}

type UpdateResult = {range: [Node, number] | [Node, number, Node, number], data: string | null, node: Text}
  
function edit(node: Node, text: string = "", from = node.nodeValue!.length, to = from): UpdateResult {
  if (node.nodeType != 3) throw new Error("Non-text node passed to add")
  let val = node.nodeValue!
  let change = from != to || text != ""
  if (change) node.nodeValue = val.slice(0, from) + text + val.slice(to)
  document.getSelection()!.collapse(node, from + text.length)
  return {range: [node, from, node, to], data: change ? text : null, node: node as Text}
}

function compose(view: EditorView, start: () => UpdateResult,
                 update: ((node: Text) => UpdateResult)[],
                 options: {end?: (node: Text) => void, cancel?: boolean} = {}) {
  ist(!view.composing)
  compositionEvent(view, "compositionstart")
  ist(view.composing)
  let node!: Text, sel = document.getSelection()!
  for (let i = -1; i < update.length; i++) {
    let result = i < 0 ? start(): update[i](node)
    node = result.node
    let {focusNode, focusOffset} = sel
    let stack = []
    for (let p = node.parentNode; p && p != view.contentDOM; p = p.parentNode) stack.push(p)

    if (result.data != null) {
      compositionEvent(view, "compositionupdate")
      let [startContainer, startOffset, endContainer = startContainer, endOffset = startOffset] = result.range
      inputEvent(view, "beforeinput", {
        inputType: "insertCompositionText",
        data: result.data,
        isComposing: true,
        targetRanges: [new StaticRange({startContainer, startOffset, endContainer, endOffset})]
      })
      inputEvent(view, "input", {inputType: "insertCompositionText", data: "FIXME", isComposing: true})
    }
    view.flush()

    if (options.cancel && i == update.length - 1) {
      // FIXME verify a canceled composition
    } else {
      for (let p = node.parentNode, i = 0; p && p != view.contentDOM && i < stack.length; p = p.parentNode, i++)
        ist(p, stack[i])
      ist(node.parentNode && view.contentDOM.contains(node.parentNode))
      ist(sel.focusNode, focusNode)
      ist(sel.focusOffset, focusOffset)
      if (result.data != null) ist(view.compositionStarted)
    }
  }
  compositionEvent(view, "compositionend")
  if (options.end) options.end(node)
  view.flush()
  ist(!view.composing)
}

describe("composition", () => {
  it("supports composition inside existing text", () => {
    let view = requireFocus(tempView(doc(p("ab"))))
    compose(view, () => edit(view.domAtPos(2).node, "-", 1), [
      n => edit(n, "/", 1, 2),
      n => edit(n, "*", 1, 2)
    ])
    ist(view.state.doc, doc(p("a*b")), eq)
  })

  it("supports composition on an empty line", () => {
    let view = requireFocus(tempView(doc(p("."), p())))
    compose(view, () => edit(view.domAtPos(4).node.appendChild(document.createTextNode("")), "a"), [
      n => edit(n, "b"),
      n => edit(n, "c")
    ])
    ist(view.state.doc, doc(p("."), p("abc")), eq)
  })

  it("supports composition at end of block in existing node", () => {
    let view = requireFocus(tempView(doc(p("foo"))))
    compose(view, () => edit(view.domAtPos(2).node), [
      n => edit(n, "!"),
      n => edit(n, "?")
    ])
    ist(view.state.doc, doc(p("foo!?")), eq)
  })

  it("supports composition at end of block in a new node", () => {
    let view = requireFocus(tempView(doc(p("foo"))))
    compose(view, () => edit(view.contentDOM.firstChild!.appendChild(document.createTextNode("")), "!"), [
      n => edit(n, "?")
    ])
    ist(view.state.doc, doc(p("foo!?")), eq)
  })

  it("supports composition at start of block in a new node", () => {
    let view = requireFocus(tempView(doc(p("foo"))))
    compose(view, () => {
      let p = view.contentDOM.firstChild!
      return edit(p.insertBefore(document.createTextNode(""), p.firstChild), "!")
    }, [
      n => edit(n, "?")
    ])
    ist(view.state.doc, doc(p("!?foo")), eq)
  })

  it("supports composition at start of line", () => {
    let view = requireFocus(tempView(doc(p("c"))))
    compose(view, () => edit(view.domAtPos(1, 1).node), [
      n => edit(n, "b", 0),
      n => edit(n, "a", 0)
    ])
    ist(view.state.doc, doc(p("abc")), eq)
  })

  it("handles replacement of existing words", () => {
    let view = requireFocus(tempView(doc(p("one two three"))))
    compose(view, () => edit(view.domAtPos(2).node, "five", 4, 7), [
      n => edit(n, "seven", 4, 8),
      n => edit(n, "zero", 4, 9)
    ])
    ist(view.state.doc, doc(p("one zero three")), eq)
  })

  it("can compose inside a wrapping prop", () => {
    let view = requireFocus(tempView(doc(p("a", strong("bc")))))
    compose(view, () => edit(view.domAtPos(3).node), [
      n => edit(n, "-", 1),
      n => edit(n, "$", 2)
    ])
    ist(view.contentDOM.innerHTML, "<p>a<strong>b-$c</strong></p>")
    ist(view.state.doc, doc(p("a", strong("b-$c"))), eq)
  })

  it("can compose at the end of a wrapping prop", () => {
    let view = requireFocus(tempView(doc(p("a", strong("bc"), "d"))))
    compose(view, () => edit(view.domAtPos(3).node), [
      n => edit(n, "-", 2),
      n => edit(n, "$", 3)
    ])
    ist(view.contentDOM.innerHTML, "<p>a<strong>bc-$</strong>d</p>")
    ist(view.state.doc, doc(p("a", strong("bc-$"), "d")), eq)
  })

  it("can compose at the start of a wrapping prop", () => {
    let view = requireFocus(tempView(doc(p("a", strong("bc"), "d"))))
    compose(view, () => edit(view.domAtPos(3).node), [
      n => edit(n, "-", 0),
      n => edit(n, "$", 1)
    ])
    ist(view.contentDOM.innerHTML, "<p>a-$<strong>bc</strong>d</p>")
    ist(view.state.doc, doc(p("a-$", strong("bc"), "d")), eq)
  })

  it("handles composition in a wrapper that has multiple children", () => {
    let view = requireFocus(tempView(doc(p("one ", em("two", strong(" three"))))))
    compose(view, () => edit(view.domAtPos(6).node, "o"), [
      n => edit(n, "o"),
      n => edit(n, "w")
    ])
    ist(view.state.doc, doc(p("one ", em("twooow", strong(" three")))), eq)
  })

  it("supports composition in a cursor wrapper", () => {
    let view = requireFocus(tempView(doc(p())))
    view.dispatch({selection: EditorSelection.cursor(1, undefined, undefined, [Strong])})
    compose(view, () => edit(view.contentDOM.firstChild!.appendChild(document.createTextNode("")), "a"), [
      n => edit(n, "b"),
      n => edit(n, "c")
    ])
    ist(view.contentDOM.innerHTML, "<p><strong>abc</strong></p>")
    ist(view.state.doc, doc(p(strong("abc"))), eq)
  })


  // FIXME test enter-at-end-of-selection situation (especially on Android)
})
