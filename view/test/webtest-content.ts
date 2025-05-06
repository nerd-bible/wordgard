import {EditorView} from "@wordgard/view"
import {EditorState} from "@wordgard/state"
import {DocNode, basicBuilders, CodeBlock, Slice, OpenToken, Node, Emphasis, Strong, ImageAlt} from "@wordgard/doc"
import ist from "ist"

const {DocViewNode} = EditorView
const {doc, p, blockquote, ul, li, $img, imgAlt, hr, strong, em} = basicBuilders

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

  it("can draw props on text", () => {
    ist(render(doc(p(em("ab", strong("cd")), "ef"))).dom.innerHTML,
        "<p><em>ab<strong>cd</strong></em>ef</p>")
  })

  it("can draw props on nodes", () => {
    ist(render(doc(p(imgAlt("alt text", $img())))).dom.innerHTML,
        "<p><img alt=\"alt text\" src=\"test.png\"></p>")
  })

  it("can update for a text change", () => {
    let node = render(doc(p("123")))
    let tr = node.state.update({changes: {from: 2, insert: new Slice([Node.text("..")])}})
    ist(node.update(tr.state, tr.changes).dom.innerHTML, "<p>1..23</p>")
  })

  it("can update for a tag change", () => {
    let node = render(doc(p("a")))
    let tr = node.state.update({changes: {from: 0, to: 1, insert: new Slice([new OpenToken(CodeBlock)])}})
    ist(node.update(tr.state, tr.changes).dom.innerHTML, "<pre>a</pre>")
  })

  it("can make multiple changes", () => {
    let node = render(doc(p("ab"), p("cd")))
    let tr = node.state.update({changes: [{from: 1, insert: new Slice([Node.text("..")])}, {from: 2, to: 6}]})
    ist(node.update(tr.state, tr.changes).dom.innerHTML, "<p>..ad</p>")
  })

  it("can update text props", () => {
    let node = render(doc(p("one ", em("two"))))
    let tr = node.state.update({changes: [{from: 1, to: 4, add: Strong}, {from: 5, to: 8, remove: Emphasis}]})
    ist(node.update(tr.state, tr.changes).dom.innerHTML, "<p><strong>one</strong> two</p>")
  })

  it("can update node props", () => {
    let node = render(doc(p($img(), " ", imgAlt("a2", $img()))))
    let tr = node.state.update({changes: [{from: 1, add: ImageAlt.of("a1")}, {from: 3, remove: ImageAlt.of("a2")}]})
    ist(node.update(tr.state, tr.changes).dom.innerHTML, "<p><img alt=\"a1\" src=\"test.png\"> <img src=\"test.png\"></p>")
  })
})
