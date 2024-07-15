import ist from "ist"
import {Context, Walker, DocNode, basicBuilder, tag} from "@willows/doc"
const {doc, p, br, li, ul} = basicBuilder

function testCx(name: string, doc: DocNode, ...contexts: ([string, number] | [string, number, number])[]) {
  it(name, () => {
    let pos = tag(doc, 0), cx = doc.resolve(pos)
    ist(cx.pos, pos)
    for (let i = 0; i < contexts.length; i++) {
      let [name, index, inText = 0] = contexts[i]
      ist(cx.node.name, name)
      ist(cx.index, index)
      ist(cx.inText, inText)
      cx = cx.parent!
    }
    ist(cx, null)
  })
}

describe("Context", () => {
  testCx("can find a top-level position", doc(p("one"), 0, p("two")), ["Doc", 1])

  testCx("can find a position in text", doc(p("on", 0, "e")), ["Paragraph", 0, 2], ["Doc", 0])

  testCx("can find a position in a nested block", doc(p(), ul(li(p(), p(0)))),
         ["Paragraph", 0], ["ListItem", 1], ["BulletList", 0], ["Doc", 1])

  it("can walk through a document", () => {
    let d = doc(p("one"), ul(li(p("a", br(), "b"), p())))
    let cx = Context.atStart(d)
    let tokens = "OPEN(Paragraph) o n e CLOSE OPEN(BulletList) OPEN(ListItem) OPEN(Paragraph) a LineBreak" +
      " b CLOSE OPEN(Paragraph) CLOSE CLOSE CLOSE"
    let found: string[] = []
    let walker: Walker = {
      enter: n => found.push(`OPEN(${n.name})`),
      skip: n => found.push(n.isText() ? n.text : n.name),
      leave: () => found.push("CLOSE")
    }
    for (let i = 0; i < d.length; i++) cx = cx.advance(1, walker)
    ist(found.join(" "), tokens)
  })

  it("reports proper node positions", () => {
    let cx = doc(p(), ul(li(p(br())), li(p("ab"), p())), p()).resolve(11)
    ist(cx.start, 10)
    ist(cx.end, 12)
    ist(cx.before, 9)
    ist(cx.after, 13)
    ist(cx.depth, 3)
    ist(cx.parent!.start, 9)
    ist(cx.parent!.end, 15)
    ist(cx.parent!.parent!.start, 3)
    ist(cx.parent!.parent!.end, 16)
    ist(cx.parent!.parent!.parent!.start, 0)
    ist(cx.parent!.parent!.parent!.end, 19)
  })

  it("caches resolved contexts", () => {
    let d = doc(p("abc")), c1 = d.resolve(1), c2 = d.resolve(2)
    ist(d.resolve(1), c1)
    ist(d.resolve(2), c2)
  })
})
