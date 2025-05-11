import {EditorView, TagWidgetSource, Widget, PointSet, WidgetSource} from "@wordgard/view"
import {EditorState, Extension, StateField} from "@wordgard/state"
import {DocNode, basicBuilders, CodeBlock, Slice, OpenToken, Node,
        Emphasis, Strong, ImageAlt, Paragraph} from "@wordgard/doc"
import ist from "ist"

const {DocViewNode} = EditorView
const {doc, p, blockquote, ul, li, $img, imgAlt, hr, strong, em} = basicBuilders

function render(doc: DocNode, ...extensions: Extension[]) {
  return DocViewNode.create(EditorState.create({doc, extensions}), document.createElement("div"))
}

const inlineWidget = Widget.define<string>({
  render: value => {
    let s = document.createElement("span")
    s.textContent = value
    return s
  }
})

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

  describe("decoration", () => {
    it("can draw widgets around nodes", () => {
      let src = (side: string) => new TagWidgetSource({
        tag: Paragraph,
        side: side as any,
        widget: inlineWidget.of(side)
      })
      let node = render(doc(p("xyz"), hr()), src("Before"), src("Start"), src("End"), src("After"))
      ist(node.dom.innerHTML, "<span>Before</span><p><span>Start</span>xyz<span>End</span></p><span>After</span><hr>")
    })

    it("can draw widgets from a point set", () => {
      let node = render(doc(p("abc")), new WidgetSource<string>({
        set: _ => PointSet.create([1, 3], ["x", "y"]),
        widget: n => inlineWidget.of(n)
      }))
      ist(node.dom.innerHTML, "<p><span>x</span>ab<span>y</span>c</p>")
    })

    it("can update widgets from a point set", () => {
      let f = StateField.define({
        create: () => PointSet.create([1], ["x"]),
        update: () => PointSet.create([4], ["y"]),
      })
      let src = new WidgetSource<string>({
        set: s => s.field(f),
        widget: n => inlineWidget.of(n)
      })
      let node = render(doc(p("a"), p("b")), f, src)
      let tr = node.state.update({})
      ist(node.update(tr.state, tr.changes).dom.innerHTML, "<p>a</p><p><span>y</span>b</p>")
    })

    it("can update widgets in place", () => {
      let f = StateField.define({
        create: () => PointSet.create([1], ["x"]),
        update: () => PointSet.create([1], ["y"]),
      })
      let src = new WidgetSource<string>({
        set: s => s.field(f),
        widget: n => inlineWidget.of(n)
      })
      let node = render(doc(p("a")), f, src)
      let tr = node.state.update({})
      ist(node.update(tr.state, tr.changes).dom.innerHTML, "<p><span>y</span>a</p>")
    })
  })
})
