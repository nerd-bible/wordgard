import ist from "ist"
import {DocNode, basicBuilder, builder, serialize, Prop, PropType} from "@willows/doc"
const {doc, blockquote, p, em, strong, $img} = basicBuilder

function html(doc: DocNode) {
  let wrap = document.createElement("div")
  wrap.appendChild(serialize(doc))
  return wrap.innerHTML
}

describe("serialize", () => {
  it("can serialize simple nodes", () => {
    ist(html(doc(p("One"), blockquote(p("Two")))), "<p>One</p><blockquote><p>Two</p></blockquote>")
  })

  it("can serialize local attributes", () => {
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
      tags: "Paragraph",
      dom: {attribute: "style/text-decoration", value: () => "underline", readAttribute: () => null}
    })
    let {ul} = builder({ul: Ul})
    ist(html(doc(p(ul("one")))), "<p><span style=\"text-decoration: underline;\">one</span></p>")
  })
})
