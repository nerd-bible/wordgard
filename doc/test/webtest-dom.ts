import ist from "ist"
import {DocNode, basicBuilder, builder, Prop, PropType,
        serialize, parseDoc, ParseOptions, Schema, basicSchema} from "@willows/doc"
const {doc, blockquote, p, em, strong, code, img, $img, olOrder, ul, li, pre, h1, h2} = basicBuilder

function eq<T extends {eq: (other: T) => boolean}>(a: T, b: T) { return a.eq(b) }

function html(doc: DocNode) {
  let wrap = document.createElement("div")
  wrap.appendChild(serialize(doc))
  return wrap.innerHTML
}

describe("serialize", () => {
  it("can serialize simple nodes", () => {
    ist(html(doc(p("One"), blockquote(p("Two")))), "<p>One</p><blockquote><p>Two</p></blockquote>")
  })

  it("can serialize tag parameters", () => {
    ist(html(doc(p($img()))), "<p><img src=\"test.png\"></p>")
  })

  it("can serialize spanning props", () => {
    ist(html(doc(p(em("One", strong($img(), "Two"))))), "<p><em>One<strong><img src=\"test.png\">Two</strong></em></p>")
  })

  it("can serialize attribute props", () => {
    let Pr = PropType.define<string>("Pr", {
      tags: "Paragraph",
      dom: {attribute: "data-p", readAttribute: x => x}
    })
    let {pr} = builder({pr: Pr})
    ist(html(doc(pr("one", p("x")))), "<p data-p=\"one\">x</p>")
  })

  it("can serialize style props", () => {
    let Ul = Prop.define("Ul", {
      tags: "Text",
      dom: {attribute: "style/text-decoration", value: () => "underline", readAttribute: () => null}
    })
    let {ul} = builder({ul: Ul})
    ist(html(doc(p(ul("one")))), "<p><span style=\"text-decoration: underline;\">one</span></p>")
  })

  it("serializes heading levels", () => {
    ist(html(doc(h1("One"), h2("Two"))), "<h1>One</h1><h2>Two</h2>")
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

  it("preserves whitespace in code blocks", () => {
    ist(parse("<pre>one  two\n  three</pre>"),
        doc(pre("one  two\n  three")), eq)
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
