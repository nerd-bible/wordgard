import ist from "ist"
import {Plot, Leaf, Node, Mark, Slice, type Token, Schema, Elt, elt,
        serialize, serializeSlice, parseDoc, parseSlice, type ParseOptions, RuleSet} from "wordgard/doc"
import {Paragraph, Heading, Figure, CaptionedFigure} from "wordgard/schema-def"
import {basicBuilders, builder, basicSchema, tag} from "./schema.ts"
const {doc, blockquote, p, em, strong, code, img, $img, imgAlt, fig, capFig, olStart, ul, li, pre, h1, h2, br, hr} = basicBuilders

function eq<T extends {eq: (other: T) => boolean}>(a: T, b: T) { return a.eq(b) }

function html(doc: Plot.Doc) {
  let wrap = document.createElement("div")
  wrap.appendChild(Elt.dom(serialize(doc)))
  return wrap.innerHTML
}

function istHTML(doc: Plot.Doc, expected: string) {
  ist(html(doc), expected)
  ist(Elt.html(serialize(doc)), expected)
}

function istSliceHTML(doc: Plot.Doc, expected: string, options?: any) {
  let wrap = document.createElement("div")
  let slice = doc.slice(tag(doc, 0), tag(doc, 1)), opts = {
    ...options,
    schema: doc.schema,
    context: doc.contextAt(tag(doc, 0), options?.maxDepth)
  }
  let frag = serializeSlice(slice, opts)
  wrap.appendChild(Elt.dom(frag))
  ist(wrap.innerHTML, expected)
  ist(Elt.html(frag), expected)
}

describe("serialize", () => {
  it("can serialize simple nodes", () => {
    istHTML(doc(p("One"), blockquote(p("Two"))), "<p>One</p><blockquote><p>Two</p></blockquote>")
  })

  it("can serialize tag parameters", () => {
    istHTML(doc(p($img)), "<p><img src=\"test.png\"></p>")
  })

  it("can serialize spanning marks", () => {
    istHTML(doc(p(em("One", strong(br, "Two")))), "<p><em>One<strong><br>Two</strong></em></p>")
  })

  it("can serialize attribute marks", () => Plot.Doc.noValidate(() => {
    let Pr = Mark.Type.define<string>("Pr", {
      target: Paragraph,
      shape: {attribute: "data-p", value: 0}
    })
    let pr = builder(Pr)
    istHTML(doc(pr("one", p("x"))), "<p data-p=\"one\">x</p>")
  }))

  it("can serialize style marks", () => Plot.Doc.noValidate(() => {
    let Ul = Mark.define("Ul", {
      target: Leaf.Text,
      spanning: true,
      shape: {attribute: "style/text-decoration", value: () => "underline", readAttribute: () => null}
    })
    let ul = builder(Ul)
    istHTML(doc(p(ul("one"))), "<p><span style=\"text-decoration: underline\">one</span></p>")
  }))

  it("can serialize targeted marks", () => Plot.Doc.noValidate(() => {
    let Img = Leaf.defineInline("Img", {
      shape: {structure: () => elt({_: "span", class: "my-img"}, elt({_: "img", src: "/x.webp"}))}
    })
    let Alt = Mark.Type.define<string>("Alt", {
      target: Img,
      shape: {attribute: "alt", value: 0, preferTarget: "img"}
    })
    let alt = builder(Alt), img = builder(Img)
    istHTML(doc(p(alt("x", img))), '<p><span class="my-img"><img alt="x" src="/x.webp"></span></p>')
  }))

  it("can serialize marks that add multiple attributes", () => Plot.Doc.noValidate(() => {
    let M = Mark.Type.define<string>("M", {
      spanning: true,
      shape: {attributes: p => ({"data-value": p, "class": "m"})}
    }), m = builder(M)
    istHTML(doc(p(m("??", "hello"))), '<p><span class="m" data-value="??">hello</span></p>')
  }))

  it("serializes heading levels", () => {
    istHTML(doc(h1("One"), h2("Two")), "<h1>One</h1><h2>Two</h2>")
  })

  it("serializes line breaks in whitespace-preserving nodes", () => {
    istHTML(doc(p("a", br, "b"), pre("a", br, "b")),
            "<p>a<br>b</p><pre>a\nb</pre>")
  })
})

describe("serializeSlice", () => {
  it("can serialize a simple slice", () => {
    istSliceHTML(doc(0, p("One"), p("Two"), 1), "<p>One</p><p>Two</p>")
  })

  it("can serialize an open slice", () => {
    istSliceHTML(doc(h1(0, "One"), p("Two", 1)), "<h1>One</h1><p>Two</p>")
  })

  it("can serialize a slice with deeper open sides", () => {
    istSliceHTML(doc(ul(li(p(0, "A"))), blockquote(p("B", 1))),
                 "<ul><li><p>A</p></li></ul><blockquote><p>B</p></blockquote>")
  })

  const openMark = Mark.Type.define<string>("Open", {shape: {attribute: "open", value: 0}, target: Node.Group.All})

  it("can mark open nodes", () => {
    istSliceHTML(doc(p(0, "a"), blockquote(p("b", 1))),
                 '<p open="start">a</p><blockquote open="end"><p open="end">b</p></blockquote>',
                 {openMark})
  })

  it("can include extra context", () => {
    istSliceHTML(doc(blockquote(ul(li(p(0, "a")), li(p("b"), 1)))),
                 '<ul open="start end"><li open="start"><p open="start">a</p></li><li open="end"><p>b</p></li></ul>',
                 {openMark, maxDepth: 3, includeContext: 3})
  })
})

function parse(html: string, options: ParseOptions & {schema?: Schema} = {}) {
  let wrap = document.implementation.createHTMLDocument("").createElement("div")
  wrap.innerHTML = html
  return parseDoc(options.schema || basicSchema, wrap, options)
}

describe("parseDoc", () => {
  it("can parse simple content", () => {
    ist(parse("<p>Ok</p>"), doc(p("Ok")), eq)
  })

  it("can parse nested nodes", () => {
    ist(parse("<ul><li><p>A</p></li><li><blockquote><p>B</p></blockquote></li></ul>"),
        doc(ul(li(p("A")),li(blockquote(p("B"))))), eq)
  })

  it("can parse nodes with params", () => {
    ist(parse("<p><img src='x.png'></p><ol start=3><li><p>Three</p></li></ol>"),
        doc(p(img("x.png")), olStart(3, li(p("Three")))), eq)
  })

  it("can parse marks", () => {
    ist(parse("<p><em>one <strong>two</strong> <code>three</code></em> four</p>"),
        doc(p(em("one ", strong("two"), " ", code("three")), " four")), eq)
  })

  it("will add wrapper nodes", () => {
    ist(parse("A"), doc(p("A")), eq)
    ist(parse("<li>A</li>"), doc(ul(li(p("A")))), eq)
  })

  it("parses line breaks in code blocks as break nodes", () => {
    ist(parse("<pre>a\n\nb</pre>"), doc(pre("a", br, br, "b")), eq)
  })

  it("preserves whitespace in code blocks", () => {
    ist(parse("<pre>one  two\n  three</pre>"),
        doc(pre("one  two", br, "  three")), eq)
  })

  it("collapses whitespace", () => {
    ist(parse("<p>  \none   \n two  </p>\n  <p>three</p>"),
        doc(p("one two"), p("three")), eq)
  })

  it("can disable whitespace collapsing", () => {
    ist(parse("<p>  \none \n two  </p>", {collapseWhiteSpace: false}),
        doc(p("   one   two  ")), eq)
  })

  it("parses heading levels", () => {
    ist(parse("<h1>One</h1><h2>Two</h2>"),
        doc(h1("One"), h2("Two")), eq)
  })


  it("ignores non-content tags", () => {
    ist(parse("<title>T</title><p>P</p><script>S</script>"),
        doc(p("P")), eq)
  })

  it("parses style properties", () => {
    ist(parse("<p style='font-weight: bold'><span style='font-style: italic'>A</span>B</p>"),
        doc(p(strong(em("A"), "B"))), eq)
  })

  it("clears marks via style properties", () => {
    ist(parse("<p><strong>a<span style='font-weight: normal'>b</span>c</strong></p>"),
        doc(p(strong("a"), "b", strong("c"))), eq)
  })

  it("can parse marks with pass-through attributes", () => {
    ist(parse("<p><img alt=x src='test.png'></p>"),
        doc(p(imgAlt("x", img("test.png")))), eq)
  })

  it("joins text nodes", () => {
    ist(parse("<p>a<span>b</span></p>"), doc(p("ab")), eq)
  })

  it("uses parse rule precedence", () => {
    let rules = new RuleSet([
      {selector: "p", plot: Paragraph},
      {selector: "p.h", plot: Heading.of(1), precedence: 2}
    ])
    ist(parse("<p class=h>H</p>", {ruleSet: rules}), doc(h1("H")), eq)
  })

  it("can parse different image types", () => {
    let schema = Schema.define(basicSchema.elements.concat([Figure, CaptionedFigure]))
    let doc = builder(schema)
    let html = `<p>Img: <img src=test.png></p>
<figure><img src=test.png></figure>
<figure><img src=test.png><figcaption>Caption</figcaption></figure>`
    ist(parse(html, {schema}), doc(p("Img: ", img("test.png")), fig("test.png"), capFig("test.png", "Caption")), eq)
  })
})

describe("parseSlice", () => {
  function parse(html: string, options: ParseOptions & {schema?: Schema} = {}) {
    let wrap = document.implementation.createHTMLDocument("").createElement("div")
    wrap.innerHTML = html
    return parseSlice(options.schema || basicSchema, wrap, options)
  }

  function slice(children: (string | Token)[]) {
    return new Slice(children.map(ch => typeof ch == "string" ? Leaf.text(ch) : ch))
  }

  it("can parse a simple slice", () => {
    ist(parse("<p>One</p><p>Two</p>").slice, slice(["One", Plot.End, p().tag, "Two"]), eq)
  })

  it("can parse text at the top level", () => {
    ist(parse("hello").slice, slice(["hello"]), eq)
  })

  it("doesn't trim text at the top level", () => {
    ist(parse("  hello  ", {collapseWhiteSpace: false}).slice, slice(["  hello  "]), eq)
  })

  it("opens nested nodes", () => {
    ist(parse("<ul><li><p>One</p></li></ul>").slice, slice(["One"]), eq)
  })

  it("doesn't open leaf nodes", () => {
    ist(parse("<hr><p>A<br></p>").slice, slice([hr, p().tag, "A", br]), eq)
  })

  function isOpen(elt: Element): "start" | "end" | "start end" | null {
    let start = elt.hasAttribute("open-start"), end = elt.hasAttribute("open-end")
    return start ? (end ? "start end" : "start") : end ? "end" : null
  }

  it("can query the DOM for open structure", () => {
    ist(parse('<blockquote open-start=true open-end=true><p open-end=true>hi</p></blockquote>', {isOpen}).slice,
        slice([p().tag, "hi"]), eq)
  })
})
