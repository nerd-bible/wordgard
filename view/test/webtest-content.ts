import {EditorView} from "@wordgard/view"
import {EditorState} from "@wordgard/state"
import {DocNode, basicBuilders, Slice, Node} from "@wordgard/doc"
import ist from "ist"

const {DocViewNode} = EditorView
const {doc, p, blockquote, ul, li, $img, hr} = basicBuilders

function render(doc: DocNode) {
  return DocViewNode.create(EditorState.create({doc}), document.createElement("div"))
}

describe("ViewNode", () => {
  it("can draw a simple document", () => {
    ist(render(doc(p("one"), p("two"))).dom.innerHTML, "<p>one</p><p>two</p>")
  })

  it("can draw basic structure", () => {
    ist(render(doc(blockquote(ul(li(p("a: ", $img())), li(p("b"), p("c")))), hr())).dom.innerHTML,
        "<blockquote><ul><li><p>a: <img src=\"test.png\"></p></li><li><p>b</p><p>c</p></li></ul></blockquote><hr>")
  })

  it("can update for a text change", () => {
    let node = render(doc(p("123")))
    let tr = node.state.update({changes: {from: 2, insert: new Slice([Node.text("..")])}})
    ist(node.update(tr.state, tr.changes).dom.innerHTML, "<p>1..23</p>")
  })
})
