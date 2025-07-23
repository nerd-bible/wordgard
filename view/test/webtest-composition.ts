import {EditorView} from "@wordgard/view"
import {basicBuilders} from "@wordgard/doc"
import ist from "ist"
import {tempView, requireFocus} from "./tempview"

const {doc, p} = basicBuilders

function eq<T extends {eq: (other: T) => boolean}>(a: T, b: T) { return a.eq(b) }

function compositionEvent(cm: EditorView, type: string) {
  cm.contentDOM.dispatchEvent(new CompositionEvent(type))
}

function inputEvent(cm: EditorView, type: string, init: InputEventInit) {
  cm.contentDOM.dispatchEvent(new InputEvent(type, init))
}

type UpdateResult = {range: [Node, number] | [Node, number, Node, number], data: string, node: Text}
  

function add(node: Node, text: string = "", from = node.nodeValue!.length, to = from): UpdateResult {
  if (node.nodeType != 3) throw new Error("Non-text node passed to add")
  let val = node.nodeValue!
  node.nodeValue = val.slice(0, from) + text + val.slice(to)
  document.getSelection()!.collapse(node, from + text.length)
  return {range: [node, from, node, to], data: text, node: node as Text}
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

    compositionEvent(view, "compositionupdate")
    let [startContainer, startOffset, endContainer = startContainer, endOffset = startOffset] = result.range
    inputEvent(view, "beforeinput", {
      inputType: "insertCompositionText",
      data: result.data,
      isComposing: true,
      targetRanges: [new StaticRange({startContainer, startOffset, endContainer, endOffset})]
    })
    inputEvent(view, "input", {inputType: "insertCompositionText", data: "FIXME", isComposing: true})
    view.flush()

    if (options.cancel && i == update.length - 1) {
      // FIXME verify a canceled composition
    } else {
      for (let p = node.parentNode, i = 0; p && p != view.contentDOM && i < stack.length; p = p.parentNode, i++)
        ist(p, stack[i])
      ist(node.parentNode && view.contentDOM.contains(node.parentNode))
      ist(sel.focusNode, focusNode)
      ist(sel.focusOffset, focusOffset)
      ist(view.compositionStarted)
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
    compose(view, () => add(view.domAtPos(2).node, "-", 1), [
      n => add(n, "/", 1, 2),
      n => add(n, "*", 1, 2)
    ])
    ist(view.state.doc, doc(p("a*b")), eq)
  })

  it("supports composition on an empty line", () => {
    let view = requireFocus(tempView(doc(p("."), p())))
    compose(view, () => add(view.domAtPos(4).node.appendChild(document.createTextNode("")), "a"), [
      n => add(n, "b"),
      n => add(n, "c")
    ])
    ist(view.state.doc, doc(p("."), p("abc")), eq)
  })

  it("supports composition at end of line in existing node", () => {
    let view = requireFocus(tempView(doc(p("foo"))))
    compose(view, () => add(view.domAtPos(2).node), [
      n => add(n, "!"),
      n => add(n, "?")
    ])
    ist(view.state.doc, doc(p("foo!?")), eq)
  })

})
