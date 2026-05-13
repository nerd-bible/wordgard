import {Wordgard, tagShape, tagDecoration, Widget, PointSet,
        RangeSet, RangeDecoration, Decoration} from "wordgard/view"
import {GardState, Transaction} from "wordgard/state"
import {Plot, Leaf, Node, elt, Mark, Token} from "wordgard/doc"
import {basicBuilders, CodeBlock, Emphasis, Strong, Paragraph, Blockquote, Image, ImageAlt, builder} from "wordgard/schema"
import ist from "ist"

const {DocTile} = Wordgard
const {doc, p, blockquote, h2, ul, li, br, $img, img, imgAlt, hr, strong, em} = basicBuilders

function render(doc: Plot.Doc, ...config: GardState.Extension[]): InstanceType<typeof DocTile> {
  return DocTile.create(GardState.create({doc, config}), document.createElement("div"))
}

function update(node: InstanceType<typeof DocTile>, spec: Transaction.Spec) {
  let tr = node.state.update(spec)
  return node.update(tr.state, tr.changes.sections)
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
    ist(render(doc(blockquote(ul(li(p("a: ", $img)), li(p("b"), p("c")))), hr)).dom.innerHTML,
        "<blockquote><ul><li><p>a: <img src=\"test.png\"></p></li><li><p>b</p><p>c</p></li></ul></blockquote><hr>")
  })

  it("can draw marks on text", () => {
    ist(render(doc(p(em("ab", strong("cd")), "ef"))).dom.innerHTML,
        "<p><em>ab<strong>cd</strong></em>ef</p>")
  })

  it("can draw marks with a preferred target", () => {
    let Img = Leaf.defineInline("Img", {
      shape: {structure: () => elt({_: "span", class: "my-img"}, elt({_: "img", src: "/x.webp"}))}
    })
    let Alt = Mark.Type.define<string>("Alt", {
      target: Img,
      shape: {attribute: "alt", value: 0, preferTarget: "img"}
    })
    let alt = builder(Alt), img = builder(Img)
    Plot.Doc.noValidate(() => {
      ist(render(doc(p(alt("x", img)))).dom.innerHTML,
          '<p><span class="my-img"><img alt="x" src="/x.webp"></span></p>')
    })
  })

  it("can draw nodes with structure representation", () => {
    ist(render(doc(h2("head"))).dom.innerHTML, "<h2>head</h2>")
  })

  it("can draw nodes with complicated structure", () => {
    let FancyBlock = Plot.defineBlock("FancyBlock", {
      group: Node.Group.Content,
      inlineContent: Node.Group.Inline,
      shape: {
        structure: elt({_: "div", class: "c"}, elt("span", "before"), 0, elt("span", "after"))
      }
    })
    Plot.Doc.noValidate(() => {
      let tile = render(doc(FancyBlock.create([Leaf.text("!")])))
      ist(tile.dom.innerHTML,
          "<div class=\"c\"><span>before</span>!<span>after</span></div>")
      tile = update(tile, {changes: [{from: 0, insert: [p("(")]},
                                     {from: 1, to: 2, insert: [Leaf.text("?")]},
                                     {from: 3, insert: [p(")")]}]})
      ist(tile.dom.innerHTML,
          "<p>(</p><div class=\"c\"><span>before</span>?<span>after</span></div><p>)</p>")
    })
  })

  it("can draw marks on nodes", () => {
    ist(render(doc(p(imgAlt("alt text", $img)))).dom.innerHTML,
        "<p><img alt=\"alt text\" src=\"test.png\"></p>")
  })

  it("can update for a text change", () => {
    let node = update(render(doc(p("123"))), {changes: {from: 2, insert: [Leaf.text("..")]}})
    ist(node.dom.innerHTML, "<p>1..23</p>")
  })

  it("can update for a tag change", () => {
    let node = update(render(doc(p("a"))), {changes: {from: 0, to: 1, insert: [CodeBlock]}})
    ist(node.dom.innerHTML, "<pre>a</pre>")
  })

  it("can make multiple changes", () => {
    let node = update(render(doc(p("ab"), p("cd"))), {changes: [{from: 1, insert: [Leaf.text("..")]}, {from: 2, to: 6}]})
    ist(node.dom.innerHTML, "<p>..ad</p>")
  })

  it("can update text marks", () => {
    let node = update(render(doc(p("one ", em("two")))), {
      changes: [{from: 1, to: 4, add: Strong}, {from: 5, to: 8, remove: Emphasis}]
    })
    ist(node.dom.innerHTML, "<p><strong>one</strong> two</p>")
  })

  it("can update node marks", () => {
    let node = update(render(doc(p($img, " ", imgAlt("a2", $img)))), {
      changes: [{from: 1, add: ImageAlt.of("a1")}, {from: 3, remove: ImageAlt.of("a2")}]
    })
    ist(node.dom.innerHTML, "<p><img src=\"test.png\" alt=\"a1\"> <img src=\"test.png\"></p>")
  })

  it("can draw spanning marks", () => {
    ist(render(doc(p(strong("a", $img, "b"), "c"))).dom.innerHTML,
        "<p><strong>a<img src=\"test.png\">b</strong>c</p>")
  })

  it("can join spanning marks in updates", () => {
    let node = update(render(doc(p(strong("a"), "b", strong("c")))), {changes: {from: 2, to: 3}})
    ist(node.dom.innerHTML, "<p><strong>ac</strong></p>")
  })

  it("preserves DOM nodes with changed wrappers marks", () => {
    let node = render(doc(p(strong($img))))
    let img = node.dom.querySelector("img")
    node = update(node, {changes: {from: 1, remove: Strong, add: Emphasis}})
    ist(node.dom.querySelector("img"), img)
  })

  it("properly syncs replacements inside wrappers", () => {
    let node = render(doc(p(strong("abc")), p("def")))
    ist(update(node, {changes: {from: 2, insert: [Leaf.text("..", [Strong])]}}).dom.innerHTML,
        "<p><strong>a..bc</strong></p><p>def</p>")
  })

  it("preserves DOM nodes with changed attribute marks", () => {
    let node = render(doc(p($img)))
    let img = node.dom.querySelector("img")
    node = update(node, {changes: {from: 1, add: ImageAlt.of("text")}})
    ist(node.dom.querySelector("img"), img)
  })

  it("preserves mark wrapper nodes", () => {
    let node = render(doc(p(strong("ab"))))
    let str = node.dom.querySelector("strong")
    node = update(node, {changes: {from: 2, insert: [Leaf.text("!")]}})
    ist(node.dom.querySelector("strong"), str)
  })

  it("adds breaks for empty textblocks and those ending in breaks", () => {
    let node = render(doc(p(), p("a"), p("b", br)))
    ist(node.dom.innerHTML, "<p><br></p><p>a</p><p>b<br><br></p>")
  })

  it("fixes textblock breaks on changes", () => {
    let node = render(doc(p(), p("a")))
    ist(update(node, {changes: [{from: 1, insert: [Leaf.text("x")]}, {from: 3, to: 4}]}).dom.innerHTML,
        "<p>x</p><p><br></p>")
  })

  it("keeps parent nodes when updating their content", () => {
    let node = render(doc(p("a")))
    let para = node.dom.firstChild
    node = update(node, {changes: [{from: 2, insert: [Leaf.text("b")]}]})
    ist(node.dom.firstChild, para)
  })

  it("reuses text nodes when changing their start", () => {
    let node = render(doc(p("abc"), p("def")))
    let abc = node.dom.firstChild!.firstChild!, def = node.dom.lastChild!.firstChild!
    node = update(node, {changes: [{from: 1, insert: [Leaf.text("..")]}, {from: 6, to: 7}]})
    ist(abc.nodeValue, "..abc")
    ist(def.nodeValue, "ef")
  })

  it("reuses text nodes when changing their end", () => {
    let node = render(doc(p("abc"), p("def")))
    let abc = node.dom.firstChild!.firstChild!, def = node.dom.lastChild!.firstChild!
    node = update(node, {changes: [{from: 4, insert: [Leaf.text("..")]}, {from: 8, to: 9}]})
    ist(abc.nodeValue, "abc..")
    ist(def.nodeValue, "de")
  })

  it("reuses text nodes when changing their middle", () => {
    let node = render(doc(p("abc"), p("def")))
    let abc = node.dom.firstChild!.firstChild!, def = node.dom.lastChild!.firstChild!
    node = update(node, {changes: [{from: 2, insert: [Leaf.text("..")]}, {from: 7, to: 8}]})
    ist(abc.nodeValue, "a..bc")
    ist(def.nodeValue, "df")
  })

  it("calls destroy on removed widgets", () => {
    let log: string[] = []
    const trackedWidget = Widget.define<string>({
      render(v) { let s = document.createElement("span"); s.textContent = v; return s },
      destroy(v) { log.push(v) }
    })
    const imgWidget = tagShape({
      tag: Image,
      shape: t => trackedWidget.of(t.param as string)
    })

    let tile = update(render(doc(p("ab", img("a"), "cd")), imgWidget), {
      changes: {from: 3, to: 4, insert: [img("b")]}
    })
    ist(log.join(), "a")
    tile = update(tile, {changes: {from: tile.length, insert: [p("!", img("c"))]}})
    ist(log.join(), "a")
    tile = update(tile, {changes: {from: 0, to: tile.length, insert: [hr]}})
    ist(log.join(), "a,b,c")
  })

  it("can handle adding a mark to part of a textblock", () => {
    let tile = update(render(doc(p("one two"))), {changes: {from: 5, to: 8, add: Strong}})
    ist(tile.dom.innerHTML, "<p>one <strong>two</strong></p>")
  })

  it("can handle a change moving content up", () => {
    let tile = update(render(doc(blockquote(p("abc")))), {
      changes: [{from: 0, to: 2, insert: [Paragraph]}, {from: 6, to: 7}]
    })
    ist(tile.dom.innerHTML, "<p>abc</p>")
  })

  it("can handle a change moving content down", () => {
    let tile = update(render(doc(p("abc"))), {
      changes: [{from: 0, to: 1, insert: [Blockquote, Paragraph]}, {from: 5, insert: [Token.End]}]
    })
    ist(tile.dom.innerHTML, "<blockquote><p>abc</p></blockquote>")
  })

  it("handles insertion of text before a mark", () => {
    let tile = update(render(doc(p(strong("a"), "b"))), {changes: {from: 1, insert: [Leaf.text("x")]}})
    ist(tile.dom.innerHTML, "<p>x<strong>a</strong>b</p>")
  })

  // FIXME test nodes with inner structure

  describe("decoration", () => {
    it("can draw widgets around nodes", () => {
      let src = (side: string) => tagDecoration({
        query: Paragraph,
        widget: inlineWidget.of(side),
        place: side as any
      })
      let node = render(doc(p("xyz"), hr), src("Before"), src("Start"), src("End"), src("After"))
      ist(node.dom.innerHTML, "<span>Before</span><p><span>Start</span>xyz<span>End</span></p><span>After</span><hr>")
    })

    it("can reuse widgets when replacing next to them", () => {
      let src = (side: string) => tagDecoration({
        query: Image,
        widget: inlineWidget.of(side),
        place: side as any
      })
      let node = render(doc(p("x", $img, "y")), src("Before"), src("After"))
      let widgets = node.dom.querySelectorAll("span")
      node = update(node, {changes: {from: 2, to: 3, insert: [img("/x.webp")]}})
      let newWidgets = node.dom.querySelectorAll("span")
      ist(newWidgets.length, 2)
      for (let i = 0; i < widgets.length; i++) ist(newWidgets[i], widgets[i])
    })

    it("can reuse widgets when updating across them", () => {
      let src = (side: string) => tagDecoration({
        query: Image,
        widget: inlineWidget.of(side),
        place: side as any
      })
      let node = render(doc(p(strong("x", $img, "y"), em("z", $img))), src("Before"), src("After"))
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
        query: Image,
        widget: inlineWidget.of(side),
        place: side as any
      })
      let node = render(doc(p(strong("x", $img, "y"))), src("Before"), src("After"))
      ist(node.dom.querySelectorAll("strong").length, 1)
    })

    it("keeps structure entirely the same on a no-change update", () => {
      let node = render(doc(p(strong("one", em("two"), $img, "three")), hr))
      let elts = node.dom.querySelectorAll("*")
      let tr1 = node.state.update({changes: {from: 1, to: 12, remove: Strong}})
      let tr2 = tr1.state.update({changes: {from: 1, to: 12, add: Strong}})
      node = node.update(tr2.state, tr1.changes.compose(tr2.changes).sections)
      let newElts = node.dom.querySelectorAll("*")
      ist(newElts.length, elts.length)
      for (let i = 0; i < elts.length; i++) ist(newElts[i], elts[i])
    })

    it("can draw widgets from a point set", () => {
      let node = render(doc(p("abc")), Decoration.source.of(state => {
        return PointSet.create([[1, Decoration.widget(inlineWidget.of("x"))],
                                [3, Decoration.widget(inlineWidget.of("y"))]])
      }))
      ist(node.dom.innerHTML, "<p><span>x</span>ab<span>y</span>c</p>")
    })

    it("can update widgets from a point set", () => {
      let f = GardState.Field.define({
        create: () => PointSet.create([[1, Decoration.widget(inlineWidget.of("x"))]]),
        update: () => PointSet.create([[4, Decoration.widget(inlineWidget.of("y"))]]),
        provide: f => Decoration.source.of(s => s.field(f))
      })
      let node = update(render(doc(p("a"), p("b")), f), {})
      ist(node.dom.innerHTML, "<p>a</p><p><span>y</span>b</p>")
    })

    it("can update widgets in place", () => {
      let f = GardState.Field.define({
        create: () => PointSet.create([[1, Decoration.widget(inlineWidget.of("x"))]]),
        update: () => PointSet.create([[1, Decoration.widget(inlineWidget.of("y"))]]),
        provide: f => Decoration.source.of(s => s.field(f))
      })
      let node = update(render(doc(p("a")), f), {})
      ist(node.dom.innerHTML, "<p><span>y</span>a</p>")
    })

    it("orders widgets by side", () => {
      let w = (n: number) => Widget.create({render: () => span(n + "")})
      let src = (s: number) => Decoration.source.of(() => PointSet.create([[2, Decoration.widget(w(s), {side: s})]]))
      ist(render(doc(p("xy")), src(1), src(-2), src(-1)).dom.innerHTML,
          "<p>x<span>-2</span><span>-1</span><span>1</span>y</p>")
    })

    it("doesn't duplicate widgets on section boundaries", () => {
      let node = render(doc(p(strong("a"), $img)),
                        tagDecoration({query: Image, widget: inlineWidget.of("!"), place: "Before"}))
      ist(node.dom.innerHTML, "<p><strong>a</strong><span>!</span><img src=\"test.png\"></p>")
      node = update(node, {changes: [
        {from: 1, to: 2, remove: Strong},
        {from: 2, to: 3, insert: [$img]}
      ]})
      ist(node.dom.innerHTML, "<p>a<span>!</span><img src=\"test.png\"></p>")
    })

    it("can decorate tags", () => {
      ist(render(doc(p("a", $img)), tagDecoration({
        query: Paragraph,
        element: "div",
        attributes: {class: "pwrap"}
      }), tagDecoration({
        query: Image,
        element: "image"
      })).dom.innerHTML, "<div class=\"pwrap\"><p>a<image><img src=\"test.png\"></image></p></div>")
    })

    it("can make tag decorations spanning", () => {
      ist(render(doc(p($img, $img)), tagDecoration({
        query: Image,
        element: "image",
        spanning: true
      })).dom.innerHTML, "<p><image><img src=\"test.png\"><img src=\"test.png\"></image></p>")
    })

    it("can add attributes to tags", () => {
      ist(render(doc(p("?")), tagDecoration({
        query: Paragraph,
        attribute: "lang",
        value: "nl"
      })).dom.innerHTML, "<p lang=\"nl\">?</p>")
    })

    it("can remove attributes from tags", () => {
      let comp = new GardState.Compartment()
      let node = render(doc(p("?")), comp.of(tagDecoration({
        query: Paragraph,
        attribute: "lang",
        value: "nl"
      })))
      node = update(node, {effects: comp.reconfigure([])})
      ist(node.dom.innerHTML, "<p>?</p>")
    })

    it("preserves DOM nodes when adding attributes", () => {
      let node = render(doc(p("a"))), para = node.dom.firstChild
      node = update(node, {effects: Transaction.Effect.reconfigure.of(tagDecoration({
        query: Paragraph,
        attribute: "lang",
        value: "nl"
      }))})
      ist(node.dom.innerHTML, "<p lang=\"nl\">a</p>")
      ist(node.dom.firstChild, para)
    })

    it("can take wrappers from spans", () => {
      ist(render(doc(p("ab", $img, "cd")), RangeDecoration.source.of(s => {
        return RangeSet.create([[2, 5, RangeDecoration.wrapper({element: "span", attributes: {class: "a"}})]])
      })).dom.innerHTML, "<p>a<span class=\"a\">b<img src=\"test.png\">c</span>d</p>")
    })

    it("can take attributes from spans", () => {
      ist(render(doc(p("ab", $img, "cd")), RangeDecoration.source.of(s => {
        return RangeSet.create([[2, 5, RangeDecoration.attribute({attribute: "alt", value: "a test", query: Image})]])
      })).dom.innerHTML, "<p>ab<img alt=\"a test\" src=\"test.png\">cd</p>")
    })

    it("can override a specific leaf node's shape", () => {
      ist(render(doc(p("ab", $img, "cd")), Decoration.source.of(state => {
        return PointSet.create([[3, Decoration.shape(elt("span", "!"))]])
      })).dom.innerHTML, "<p>ab<span>!</span>cd</p>")
    })

    it("can override a specific non-leaf node's shape", () => {
      ist(render(doc(p("ab", $img, "cd")), Decoration.source.of(state => {
        return PointSet.create([[0, Decoration.shape(elt("div", 0))]])
      })).dom.innerHTML, "<div>ab<img src=\"test.png\">cd</div>")
    })

    it("can replace a non-leaf node with an atom shape", () => {
      ist(render(doc(p("ab", $img, "cd")), Decoration.source.of(state => {
        return PointSet.create([[0, Decoration.shape(elt("div", "?"))]])
      })).dom.innerHTML, "<div>?</div>")
    })

    it("can add attributes to a specific node", () => {
      let deco = PointSet.create([[0, Decoration.attribute("class", "u")]])
      ist(render(doc(p(), p()), Decoration.source.of(() => deco)).dom.innerHTML,
          "<p class=\"u\"><br></p><p><br></p>")
    })

    it("won't try to add attributes to a text node", () => {
      let deco = PointSet.create([[1, Decoration.attribute("class", "u")]])
      ist(render(doc(p("a")), Decoration.source.of(() => deco)).dom.innerHTML, "<p>a</p>")
    })

    it("can add wrapping structure to a specific node", () => {
      let deco = PointSet.create([[3, Decoration.wrapper(elt("div", elt("hr"), 0))]])
      ist(render(doc(p("x"), p("y")), Decoration.source.of(() => deco)).dom.innerHTML,
          "<p>x</p><div><hr><p>y</p></div>")
    })

    it("can handle a change modifying the depth of a plot's wrapper", () => {
      let deco = PointSet.create([[0, Decoration.wrapper(elt("div", elt("hr"), 0))]])
      let node = update(render(doc(p("x"), p("y"))), {
        effects: Transaction.Effect.appendConfig.of(Decoration.source.of(() => deco))
      })
      ist(node.dom.innerHTML, "<div><hr><p>x</p></div><p>y</p>")
    })

    it("supports selectors for wrapper decorations", () => {
      let complexImg = tagShape({
        tag: Image,
        shape: i => elt({_: "span", class: "my-image"}, elt({_: "img", src: i.param as string}))
      })
      let deco = PointSet.create([[2, Decoration.wrapper(elt({_: "span", class: "inner"}, 0), {target: "img"})]])
      let tile = render(doc(p("»", $img)), [complexImg, Decoration.source.of(() => deco)])
      ist(tile.dom.innerHTML, '<p>»<span class="my-image"><span class="inner"><img src="test.png"></span></span></p>')
    })

    it("can reuse DOM structure when adding a shape wrapper", () => {
      let node = render(doc(p($img)))
      let img = node.dom.querySelector("img")
      node = update(node, {effects: Transaction.Effect.appendConfig.of(Decoration.source.of(state => {
        return PointSet.create([[1, Decoration.wrapper(elt({_: "span", class: "u"}, 0))]])
      }))})
      ist(node.dom.querySelector("img"), img)
    })

    it("can override shapes by tag", () => {
      ist(render(doc(p("a")), tagShape({tag: Paragraph, shape: elt({_: "div", class: "para"}, 0)})).dom.innerHTML,
          "<div class=\"para\">a</div>")
    })

    it("makes by-point shapes override by-tag ones", () => {
      ist(render(doc(p("a")), [
        tagShape({tag: Paragraph, shape: elt({_: "div", class: "b"}, 0)}),
        Decoration.source.of(state => {
          return PointSet.create([[0, Decoration.shape(elt({_: "div", class: "a"}, 0))]])
        })
      ]).dom.innerHTML, "<div class=\"a\">a</div>")
    })

    it("properly updates when tag shapes change", () => {
      let tile = render(doc(p("a")))
      tile = update(tile, {
        effects: Transaction.Effect.appendConfig.of(tagShape({tag: Paragraph, shape: elt("para", 0)}))
      })
      ist(tile.dom.innerHTML, "<para>a</para>")
    })

    it("properly updates when positional shapes change", () => {
      let tile = render(doc(p("a")))
      tile = update(tile, {
        effects: Transaction.Effect.appendConfig.of(Decoration.source.of(state => {
          return PointSet.create([[0, Decoration.shape(elt("para"))]])
        }))
      })
      ist(tile.dom.innerHTML, "<para></para>")
    })
  })
})
