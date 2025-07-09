import {EditorView, tagDecoration, Widget, PointSet, WidgetSource,
        RangeSet, RangeDecorationSource} from "@wordgard/view"
import {EditorState, Extension, StateField, TransactionSpec} from "@wordgard/state"
import {DocNode, Tag, basicBuilders, CodeBlock, Slice, OpenToken, Node,
        Emphasis, Strong, ImageAlt, Paragraph, Image} from "@wordgard/doc"
import ist from "ist"

const {DocTile} = EditorView
const {doc, p, blockquote, h2, ul, li, br, $img, img, imgAlt, hr, strong, em} = basicBuilders

function render(doc: DocNode, ...extensions: Extension[]) {
  return DocTile.create(EditorState.create({doc, extensions}), document.createElement("div"))
}

function update(node: InstanceType<typeof DocTile>, spec: TransactionSpec) {
  let tr = node.state.update(spec)
  return node.update(tr.state, tr.changes)
}

function span(text: string) {
  let s = document.createElement("span")
  s.textContent = text
  return s
}

const inlineWidget = Widget.define<string>({render: span})

describe("DocTile", () => {
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

  it("can draw nodes with structure representation", () => {
    ist(render(doc(h2("head"))).dom.innerHTML, "<h2>head</h2>")
  })

  it("can draw nodes with complicated structure", () => {
    let FancyBlock = Tag.defineBlock("FancyBlock", {
      group: "Block",
      inlineContent: "Inline",
      dom: ["div", {class: "c"}, ["span", "before"], ["span", {class: "content"}, 0], ["span", "after"]]
    })
    let tile = render(doc(FancyBlock.create([Node.text("!")])), EditorState.validateDoc.of(false))
    ist(tile.dom.innerHTML,
        "<div class=\"c\"><span>before</span><span class=\"content\">!</span><span>after</span></div>")
    tile = update(tile, {changes: [{from: 0, insert: new Slice([p("(")])},
                                   {from: 1, to: 2, insert: new Slice([Node.text("?")])},
                                   {from: 3, insert: new Slice([p(")")])}]})
    ist(tile.dom.innerHTML,
        "<p>(</p><div class=\"c\"><span>before</span><span class=\"content\">?</span><span>after</span></div><p>)</p>")
  })

  it("can draw props on nodes", () => {
    ist(render(doc(p(imgAlt("alt text", $img())))).dom.innerHTML,
        "<p><img alt=\"alt text\" src=\"test.png\"></p>")
  })

  it("can update for a text change", () => {
    let node = update(render(doc(p("123"))), {changes: {from: 2, insert: new Slice([Node.text("..")])}})
    ist(node.dom.innerHTML, "<p>1..23</p>")
  })

  it("can update for a tag change", () => {
    let node = update(render(doc(p("a"))), {changes: {from: 0, to: 1, insert: new Slice([new OpenToken(CodeBlock)])}})
    ist(node.dom.innerHTML, "<pre>a</pre>")
  })

  it("can make multiple changes", () => {
    let node = update(render(doc(p("ab"), p("cd"))), {changes: [{from: 1, insert: new Slice([Node.text("..")])}, {from: 2, to: 6}]})
    ist(node.dom.innerHTML, "<p>..ad</p>")
  })

  it("can update text props", () => {
    let node = update(render(doc(p("one ", em("two")))), {
      changes: [{from: 1, to: 4, add: Strong}, {from: 5, to: 8, remove: Emphasis}]
    })
    ist(node.dom.innerHTML, "<p><strong>one</strong> two</p>")
  })

  it("can update node props", () => {
    let node = update(render(doc(p($img(), " ", imgAlt("a2", $img())))), {
      changes: [{from: 1, add: ImageAlt.of("a1")}, {from: 3, remove: ImageAlt.of("a2")}]
    })
    ist(node.dom.innerHTML, "<p><img src=\"test.png\" alt=\"a1\"> <img src=\"test.png\"></p>")
  })

  it("can draw spanning props", () => {
    ist(render(doc(p(strong("a", $img(), "b"), "c"))).dom.innerHTML,
        "<p><strong>a<img src=\"test.png\">b</strong>c</p>")
  })

  it("can join spanning props in updates", () => {
    let node = update(render(doc(p(strong("a"), "b", strong("c")))), {changes: {from: 2, to: 3}})
    ist(node.dom.innerHTML, "<p><strong>ac</strong></p>")
  })

  it("preserves DOM nodes with changed wrappers props", () => {
    let node = render(doc(p(strong($img()))))
    let img = node.dom.querySelector("img")
    node = update(node, {changes: {from: 1, remove: Strong, add: Emphasis}})
    ist(node.dom.querySelector("img"), img)
  })

  it("preserves DOM nodes with changed attribute props", () => {
    let node = render(doc(p($img())))
    let img = node.dom.querySelector("img")
    node = update(node, {changes: {from: 1, add: ImageAlt.of("text")}})
    ist(node.dom.querySelector("img"), img)
  })

  it("preserves prop wrapper nodes", () => {
    let node = render(doc(p(strong("ab"))))
    let str = node.dom.querySelector("strong")
    node = update(node, {changes: {from: 2, insert: new Slice([Node.text("!")])}})
    ist(node.dom.querySelector("strong"), str)
  })

  it("adds breaks for empty textblocks and those ending in breaks", () => {
    let node = render(doc(p(), p("a"), p("b", br())))
    ist(node.dom.innerHTML, "<p><br></p><p>a</p><p>b<br><br></p>")
  })

  it("fixes textblock breaks on changes", () => {
    let node = render(doc(p(), p("a")))
    ist(update(node, {changes: [{from: 1, insert: new Slice([Node.text("x")])}, {from: 3, to: 4}]}).dom.innerHTML,
        "<p>x</p><p><br></p>")
  })

  it("reuses text nodes when changing their start", () => {
    let node = render(doc(p("abc"), p("def")))
    let abc = node.dom.firstChild!.firstChild!, def = node.dom.lastChild!.firstChild!
    node = update(node, {changes: [{from: 1, insert: new Slice([Node.text("..")])}, {from: 6, to: 7}]})
    ist(abc.nodeValue, "..abc")
    ist(def.nodeValue, "ef")
  })

  it("reuses text nodes when changing their end", () => {
    let node = render(doc(p("abc"), p("def")))
    let abc = node.dom.firstChild!.firstChild!, def = node.dom.lastChild!.firstChild!
    node = update(node, {changes: [{from: 4, insert: new Slice([Node.text("..")])}, {from: 8, to: 9}]})
    ist(abc.nodeValue, "abc..")
    ist(def.nodeValue, "de")
  })

  it("reuses text nodes when changing their middle", () => {
    let node = render(doc(p("abc"), p("def")))
    let abc = node.dom.firstChild!.firstChild!, def = node.dom.lastChild!.firstChild!
    node = update(node, {changes: [{from: 2, insert: new Slice([Node.text("..")])}, {from: 7, to: 8}]})
    ist(abc.nodeValue, "a..bc")
    ist(def.nodeValue, "df")
  })

  // FIXME test nodes with inner structure

  describe("decoration", () => {
    it("can draw widgets around nodes", () => {
      let src = (side: string) => tagDecoration({
        tag: Paragraph,
        deco: {
          widget: inlineWidget.of(side),
          place: side as any
        }
      })
      let node = render(doc(p("xyz"), hr()), src("Before"), src("Start"), src("End"), src("After"))
      ist(node.dom.innerHTML, "<span>Before</span><p><span>Start</span>xyz<span>End</span></p><span>After</span><hr>")
    })

    it("can reuse widgets when replacing next to them", () => {
      let src = (side: string) => tagDecoration({
        tag: Image,
        deco: {
          widget: inlineWidget.of(side),
          place: side as any
        }
      })
      let node = render(doc(p("x", $img(), "y")), src("Before"), src("After"))
      let widgets = node.dom.querySelectorAll("span")
      node = update(node, {changes: {from: 2, to: 3, insert: new Slice([img("/x.webp")])}})
      let newWidgets = node.dom.querySelectorAll("span")
      ist(newWidgets.length, 2)
      for (let i = 0; i < widgets.length; i++) ist(newWidgets[i], widgets[i])
    })

    it("can reuse widgets when updating across them", () => {
      let src = (side: string) => tagDecoration({
        tag: Image,
        deco: {
          widget: inlineWidget.of(side),
          place: side as any
        }
      })
      let node = render(doc(p(strong("x", $img(), "y"), em("z", $img()))), src("Before"), src("After"))
      let widgets = node.dom.querySelectorAll("span")
      node = update(node, {changes: [
        {from: 1, to: 4, remove: Strong, add: Emphasis},
        {from: 4, to: 6, remove: Emphasis}
      ]})
      let newWidgets = node.dom.querySelectorAll("span")
      ist(newWidgets.length, 4)
      for (let i = 0; i < widgets.length; i++) ist(newWidgets[i], widgets[i])
    })

    it("doesn't break spanning wrappers on widgets", () => {
      let src = (side: string) => tagDecoration({
        tag: Image,
        deco: {
          widget: inlineWidget.of(side),
          place: side as any
        }
      })
      let node = render(doc(p(strong("x", $img(), "y"))), src("Before"), src("After"))
      ist(node.dom.querySelectorAll("strong").length, 1)
    })

    it("keeps structure entirely the same on a no-change update", () => {
      let node = render(doc(p(strong("one", em("two"), $img(), "three")), hr()))
      let elts = node.dom.querySelectorAll("*")
      let tr1 = node.state.update({changes: {from: 1, to: 12, remove: Strong}})
      let tr2 = tr1.state.update({changes: {from: 1, to: 12, add: Strong}})
      node = node.update(tr2.state, tr1.changes.compose(tr2.changes))
      let newElts = node.dom.querySelectorAll("*")
      ist(newElts.length, elts.length)
      for (let i = 0; i < elts.length; i++) ist(newElts[i], elts[i])
    })

    it("can draw widgets from a point set", () => {
      let node = render(doc(p("abc")), new WidgetSource<string>({
        set: _ => PointSet.create([[1, "x"], [3, "y"]], 1),
        widget: n => inlineWidget.of(n)
      }))
      ist(node.dom.innerHTML, "<p><span>x</span>ab<span>y</span>c</p>")
    })

    it("can update widgets from a point set", () => {
      let f = StateField.define({
        create: () => PointSet.create([[1, "x"]], 1),
        update: () => PointSet.create([[4, "y"]], 1),
      })
      let src = new WidgetSource<string>({
        set: s => s.field(f),
        widget: inlineWidget
      })
      let node = update(render(doc(p("a"), p("b")), f, src), {})
      ist(node.dom.innerHTML, "<p>a</p><p><span>y</span>b</p>")
    })

    it("can update widgets in place", () => {
      let f = StateField.define({
        create: () => PointSet.create([[1, "x"]], 0),
        update: () => PointSet.create([[1, "y"]], 0),
      })
      let src = new WidgetSource<string>({
        set: s => s.field(f),
        widget: inlineWidget
      })
      let node = update(render(doc(p("a")), f, src), {})
      ist(node.dom.innerHTML, "<p><span>y</span>a</p>")
    })

    it("orders widgets by side", () => {
      let w = (n: number) => Widget.create({
        render: () => span(n + ""),
      })
      let src = (s: number) => {
        let widget = w(s)
        return new WidgetSource<number>({
          set: () => PointSet.create([[2, 0]], s),
          widget: () => widget
        })
      }
      ist(render(doc(p("xy")), src(1), src(-2), src(-1)).dom.innerHTML,
          "<p>x<span>-2</span><span>-1</span><span>1</span>y</p>")
    })

    it("can decorate tags", () => {
      ist(render(doc(p("a", $img())), tagDecoration({
        tag: Paragraph,
        deco: {element: "div", attributes: {class: "pwrap"}}
      }), tagDecoration({
        tag: Image,
        deco: {element: "image"}
      })).dom.innerHTML, "<div class=\"pwrap\"><p>a<image><img src=\"test.png\"></image></p></div>")
    })

    it("can make tag decorations spanning", () => {
      ist(render(doc(p($img(), $img())), tagDecoration({
        tag: Image,
        deco: {element: "image", spanning: true}
      })).dom.innerHTML, "<p><image><img src=\"test.png\"><img src=\"test.png\"></image></p>")
    })

    it("can add attributes to tags", () => {
      ist(render(doc(p("?")), tagDecoration({
        tag: Paragraph,
        deco: {attribute: "lang", value: "nl"}
      })).dom.innerHTML, "<p lang=\"nl\">?</p>")
    })

    it("can take wrappers from spans", () => {
      ist(render(doc(p("ab", $img(), "cd")), new RangeDecorationSource({
        set: () => RangeSet.create([2], [5], ["a"]),
        deco: {element: "span", attributes: val => ({class: val}), spanning: true},
      })).dom.innerHTML, "<p>a<span class=\"a\">b<img src=\"test.png\">c</span>d</p>")
    })

    it("can take attributes from spans", () => {
      ist(render(doc(p("ab", $img(), "cd")), new RangeDecorationSource({
        tag: Image,
        set: () => RangeSet.create([2], [5], ["a"]),
        deco: {attribute: "alt", value: "a test"},
      })).dom.innerHTML, "<p>ab<img alt=\"a test\" src=\"test.png\">cd</p>")
    })
  })
})
