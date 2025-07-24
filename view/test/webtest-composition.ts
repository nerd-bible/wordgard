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

type CompositionUpdate = [number, number, string, () => Text] | [number, number, string]
  
function selEnd(node: Node) {
  document.getSelection()!.collapse(node, node.nodeValue!.length)
  return node as Text
}

function compose(view: EditorView, start: CompositionUpdate | (() => Text),
                 ...args: (CompositionUpdate | {end?: (node: Text) => void, cancel?: boolean})[]) {
  let last = args[args.length - 1]
  let [updates, options] = Array.isArray(last)
    ? [args as CompositionUpdate[], {}]
    : [args.slice(0, args.length - 1) as CompositionUpdate[], last as any]

  ist(!view.composing)
  compositionEvent(view, "compositionstart")
  ist(view.composing)
  let node!: Text, sel = document.getSelection()!
  for (let i = -1; i < updates.length; i++) {
    let update: CompositionUpdate | undefined
    if (i < 0) {
      if (typeof start == "function") node = start()
      else update = start
    } else {
      update = updates[i]
    }
    if (update) {
      compositionEvent(view, "compositionupdate")
      let [from, to, text] = update
      let fromDOM = view.domAtPos(from, -1)
      if (fromDOM.node.nodeType != 3 || node && node != fromDOM.node) fromDOM = view.domAtPos(from, 1)
      let toDOM = from == to ? fromDOM : view.domAtPos(to, -1)
      inputEvent(view, "beforeinput", {
        inputType: "insertCompositionText",
        data: text,
        isComposing: true,
        targetRanges: [new StaticRange({startContainer: fromDOM.node, startOffset: fromDOM.offset,
                                        endContainer: toDOM.node, endOffset: toDOM.offset})]
      })
      if (update.length == 4) {
        node = update[3]()
      } else {
        node = fromDOM.node as Text
        if (node.nodeType != 3) throw new Error("Didn't find a composition text node")
        node.nodeValue = node.nodeValue!.slice(0, fromDOM.offset) + text + node.nodeValue!.slice(fromDOM.offset + (to - from))
        sel.collapse(node, fromDOM.offset + text.length)
      }
      inputEvent(view, "input", {inputType: "insertCompositionText", data: text, isComposing: true})
    }      

    let {focusNode, focusOffset} = sel
    let stack = []
    for (let p = node.parentNode; p && p != view.contentDOM; p = p.parentNode) stack.push(p)

    view.flush()

    if (options.cancel && i == updates.length - 1) {
      // FIXME verify a canceled composition
    } else {
      for (let p = node.parentNode, i = 0; p && p != view.contentDOM && i < stack.length; p = p.parentNode, i++)
        ist(p, stack[i])
      ist(node.parentNode && view.contentDOM.contains(node.parentNode))
      ist(sel.focusNode, focusNode)
      ist(sel.focusOffset, focusOffset)
      if (update) ist(view.compositionStarted)
    }
  }
  compositionEvent(view, "compositionend")
  if (options.end) options.end(node)
  view.flush()
  ist(!view.composing)
}

describe("composition", () => {
  it("supports composition inside existing text", () => {
    let view = requireFocus(tempView(doc(p("a", 0, "b"))))
    compose(view, [2, 2, "-"], [2, 3, "/"], [2, 3, "*"])
    ist(view.state.doc, doc(p("a*b")), eq)
  })

  it("supports composition on an empty line", () => {
    let view = requireFocus(tempView(doc(p("."), p(0))))
    compose(view,
            [4, 4, "a", () => selEnd(view.domAtPos(4).node.appendChild(document.createTextNode("a")))],
            [5, 5, "b"],
            [6, 6, "c"])
    ist(view.state.doc, doc(p("."), p("abc")), eq)
  })

  it("supports composition at end of block in existing node", () => {
    let view = requireFocus(tempView(doc(p("foo", 0))))
    compose(view, [4, 4, "!"], [5, 5, "?"])
    ist(view.state.doc, doc(p("foo!?")), eq)
  })

  it("supports composition at end of block in a new node", () => {
    let view = requireFocus(tempView(doc(p("foo", 0))))
    compose(view, [4, 4, "!", () => selEnd(view.contentDOM.firstChild!.appendChild(document.createTextNode("!")))], [5, 5, "?"])
    ist(view.state.doc, doc(p("foo!?")), eq)
  })

  it("supports composition at start of block in a new node", () => {
    let view = requireFocus(tempView(doc(p("foo"))))
    compose(view, [1, 1, "!", () => {
      let p = view.contentDOM.firstChild!
      return selEnd(p.insertBefore(document.createTextNode("!"), p.firstChild))
    }], [2, 2, "?"])
    ist(view.state.doc, doc(p("!?foo")), eq)
  })

  it("supports composition at start of line", () => {
    let view = requireFocus(tempView(doc(p("c"))))
    compose(view, [1, 1, "b"], [1, 1, "a"])
    ist(view.state.doc, doc(p("abc")), eq)
  })

  it("handles replacement of existing words", () => {
    let view = requireFocus(tempView(doc(p("one two three"))))
    compose(view, [5, 8, "five"], [5, 9, "seven"], [5, 10, "zero"])
    ist(view.state.doc, doc(p("one zero three")), eq)
  })

  it("can compose inside a wrapping prop", () => {
    let view = requireFocus(tempView(doc(p("a", strong("b", 0, "c")))))
    compose(view, [3, 3, "-"], [4, 4, "$"])
    ist(view.contentDOM.innerHTML, "<p>a<strong>b-$c</strong></p>")
    ist(view.state.doc, doc(p("a", strong("b-$c"))), eq)
  })

  it("can compose at the end of a wrapping prop", () => {
    let view = requireFocus(tempView(doc(p("a", strong("bc"), 0, "d"))))
    compose(view, () => selEnd(view.domAtPos(3).node), [4, 4, "-"], [5, 5, "$"])
    ist(view.contentDOM.innerHTML, "<p>a<strong>bc-$</strong>d</p>")
    ist(view.state.doc, doc(p("a", strong("bc-$"), "d")), eq)
  })

  it("can compose at the start of a wrapping prop", () => {
    let view = requireFocus(tempView(doc(p("a", 0, strong("bc"), "d"))))
    compose(view, () => selEnd(view.domAtPos(3).node), [2, 2, "-"], [3, 3, "$"])
    ist(view.contentDOM.innerHTML, "<p>a-$<strong>bc</strong>d</p>")
    ist(view.state.doc, doc(p("a-$", strong("bc"), "d")), eq)
  })

  it("handles composition in a wrapper that has multiple children", () => {
    let view = requireFocus(tempView(doc(p("one ", em("two", 0, strong(" three"))))))
    compose(view, [8, 8, "o"], [9, 9, "o"], [10, 10, "w"])
    ist(view.state.doc, doc(p("one ", em("twooow", strong(" three")))), eq)
  })

  it("supports composition in a cursor wrapper", () => {
    let view = requireFocus(tempView(doc(p(0))))
    view.dispatch({selection: EditorSelection.cursor(1, undefined, undefined, [Strong])})
    compose(view, [1, 1, "a", () => {
      ist(view.contentDOM.innerHTML, "<p><strong><img></strong></p>")
      let sel = window.getSelection()!
      ist(sel.getRangeAt(0).comparePoint(view.contentDOM.firstChild!.firstChild!, 1), -1)
      return selEnd(view.contentDOM.firstChild!.appendChild(document.createTextNode("a")))
    }], [2, 2, "b"], [3, 3, "c"])
    ist(view.contentDOM.innerHTML, "<p><strong>abc</strong></p>")
    ist(view.state.doc, doc(p(strong("abc"))), eq)
  })

  // FIXME text composition next to widgets

  // FIXME test enter-at-end-of-selection situation (especially on Android)
})
