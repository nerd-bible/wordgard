import ist from "ist"
import {DocNode, Node, basicBuilders, builder, Prop, PropType, Slice, CloseToken, Token,
        serialize, serializeHTML, serializeSlice, serializeSliceHTML, parseDoc, parseSlice, OpenSide, ParseOptions,
        Schema, basicSchema, tag} from "@wordgard/doc"
const {doc, blockquote, p, em, strong, code, img, $img, olOrder, ul, li, pre, h1, h2, br, hr} = basicBuilders

function eq<T extends {eq: (other: T) => boolean}>(a: T, b: T) { return a.eq(b) }

function html(doc: DocNode) {
  let wrap = document.createElement("div")
  wrap.appendChild(serialize(doc))
  return wrap.innerHTML
}

function istHTML(doc: DocNode, expected: string) {
  ist(html(doc), expected)
  ist(serializeHTML(doc), expected)
}

function istSliceHTML(doc: DocNode, expected: string, options?: any) {
  let wrap = document.createElement("div")
  let slice = doc.slice(tag(doc, 0), tag(doc, 1)), opts = {
    ...options,
    schema: doc.schema,
    context: doc.contextAt(tag(doc, 0), options?.maxDepth)
  }
  wrap.appendChild(serializeSlice(slice, opts))
  ist(wrap.innerHTML, expected)
  ist(serializeSliceHTML(slice, opts), expected)
}

describe("serialize", () => {
  it("can serialize simple nodes", () => {
    istHTML(doc(p("One"), blockquote(p("Two"))), "<p>One</p><blockquote><p>Two</p></blockquote>")
  })

  it("can serialize tag parameters", () => {
    istHTML(doc(p($img())), "<p><img src=\"test.png\"></p>")
  })

  it("can serialize spanning props", () => {
    istHTML(doc(p(em("One", strong($img(), "Two")))), "<p><em>One<strong><img src=\"test.png\">Two</strong></em></p>")
  })

  it("can serialize attribute props", () => {
    let Pr = PropType.define<string>("Pr", {
      tags: "Paragraph",
      shape: {attribute: "data-p", readAttribute: x => x}
    })
    let pr = builder(Pr)
    istHTML(doc(pr("one", p("x"))), "<p data-p=\"one\">x</p>")
  })

  it("can serialize style props", () => {
    let Ul = Prop.define("Ul", {
      tags: "Text",
      shape: {attribute: "style/text-decoration", value: () => "underline", readAttribute: () => null}
    })
    let ul = builder(Ul)
    istHTML(doc(p(ul("one"))), "<p><span style=\"text-decoration: underline\">one</span></p>")
  })

  it("serializes heading levels", () => {
    istHTML(doc(h1("One"), h2("Two")), "<h1>One</h1><h2>Two</h2>")
  })

  it("serializes line breaks in whitespace-preserving nodes", () => {
    istHTML(doc(p("a", br(), "b"), pre("a", br(), "b")),
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

  const openProp = PropType.define<string>("Open", {shape: {attribute: "open"}, tags: "*"})

  it("can mark open nodes", () => {
    istSliceHTML(doc(p(0, "a"), blockquote(p("b", 1))),
                 '<p open="start">a</p><blockquote open="end"><p open="end">b</p></blockquote>',
                 {openProp})
  })

  it("can include extra context", () => {
    istSliceHTML(doc(blockquote(ul(li(p(0, "a")), li(p("b"), 1)))),
                 '<ul open="start end"><li open="start"><p open="start">a</p></li><li open="end"><p>b</p></li></ul>',
                 {openProp, maxDepth: 3, includeContext: 3})
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
    ist(parse("<p><img src='x.png'></p><ol order=3><li><p>Three</p></li></ol>"),
        doc(p(img("x.png")), olOrder(3, li(p("Three")))), eq)
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
    ist(parse("<pre>a\n\nb</pre>"), doc(pre("a", br(), br(), "b")), eq)
  })

  it("preserves whitespace in code blocks", () => {
    ist(parse("<pre>one  two\n  three</pre>"),
        doc(pre("one  two", br(), "  three")), eq)
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

  it("clears props via style properties", () => {
    ist(parse("<p><strong>a<span style='font-weight: normal'>b</span>c</strong></p>"),
        doc(p(strong("a"), "b", strong("c"))), eq)
  })

  it("joins text nodes", () => {
    ist(parse("<p>a<span>b</span></p>"), doc(p("ab")), eq)
  })
})

describe("parseSlice", () => {
  function parse(html: string, options: ParseOptions & {schema?: Schema} = {}) {
    let wrap = document.implementation.createHTMLDocument("").createElement("div")
    wrap.innerHTML = html
    return parseSlice(options.schema || basicSchema, wrap, options)
  }

  function slice(children: (string | Token)[]) {
    return new Slice(children.map(ch => typeof ch == "string" ? Node.text(ch) : ch))
  }

  it("can parse a simple slice", () => {
    ist(parse("<p>One</p><p>Two</p>").slice, slice(["One", CloseToken, p().tag, "Two"]), eq)
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
    ist(parse("<hr><p>A<br></p>").slice, slice([hr(), p().tag, "A", br()]), eq)
  })

  function isOpen(elt: HTMLElement) {
    return (elt.hasAttribute("open-start") ? OpenSide.Start : 0) | (elt.hasAttribute("open-end") ? OpenSide.End : 0)
  }

  it("can query the DOM for open structure", () => {
    ist(parse('<blockquote open-start=true open-end=true><p open-end=true>hi</p></blockquote>', {isOpen}).slice,
        slice([p().tag, "hi"]), eq)
  })
})
