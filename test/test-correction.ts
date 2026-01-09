import ist from "ist"
import {EditorState, Correction} from "wordgard/state"
import {Leaf, Blockquote, Strong, Emphasis, basicBuilders} from "wordgard/doc"

const {doc, p, blockquote, h1, $img, em} = basicBuilders

function eq<T extends {eq: (b: T) => boolean}>(a: T, b: T) { return a.eq(b) }

describe("Correction", () => {
  it("is notified of child list changes", () => {
    let notified: number[] = []
    let s = EditorState.create({
      doc: doc(p("abc"), blockquote(p("def"))),
      config: Correction.onChildList("Paragraph", node => { notified.push(node.pos); return null })
    })
    s = s.update({changes: {from: 1, to: 2}}).state
    ist(notified.join(), "0")
    s = s.update({changes: {from: 9, insert: [$img]}}).state
    ist(notified.join(), "0,5")
    s = s.update({changes: {from: 0, insert: [p("!")]}}).state
    ist(notified.join(), "0,5,0")
  })

  it("is notified of content changes", () => {
    let notified: number[] = []
    let s = EditorState.create({
      doc: doc(blockquote(p("abc"), p("def"))),
      config: Correction.onContent(Blockquote, node => { notified.push(node.pos); return null })
    })
    s = s.update({changes: {from: 2, insert: [Leaf.text("-")]}}).state
    ist(notified.join(), "0")
    s = s.update({changes: [{from: 1, insert: [p()]}, {from: 7, insert: [p()]}]}).state
    ist(notified.join(), "0,0")
  })

  it("is notified of property changes", () => {
    let notified: number[] = []
    let s = EditorState.create({
      doc: doc(p("abc ", em("def"))),
      config: Correction.onProps("Text", node => { notified.push(node.pos); return null })
    })
    s = s.update({changes: {from: 5, to: 8, remove: Emphasis}}).state
    ist(notified.join(), "1")
    s = s.update({changes: {from: 1, to: 4, add: Strong}}).state
    ist(notified.join(), "1,1")
  })

  it("can apply corrections", () => {
    let s = EditorState.create({
      doc: doc(h1("h"), p("abc")),
      config: Correction.onChildList("Doc", node => {
        if (node.node.firstChild!.name == "Heading") return null
        return {from: node.start, insert: [h1()]}
      })
    })
    s = s.update({changes: {from: 0, insert: [p("...")]}}).state
    ist(s.doc, doc(h1(), p("..."), h1("h"), p("abc")), eq)
    s = s.update({changes: {from: 0, to: 7}}).state
    ist(s.doc, doc(h1("h"), p("abc")), eq)
    s = s.update({changes: {from: 0, to: 3}}).state
    ist(s.doc, doc(h1(), p("abc")), eq)
  })

  it("can apply multiple corrections from a single source", () => {
    let s = EditorState.create({
      doc: doc(blockquote(h1("h"), p("abc")), blockquote(h1("h"), p("abc"))),
      config: Correction.onChildList("Blockquote", node => {
        if (node.node.firstChild!.name == "Heading") return null
        return {from: node.start, insert: [h1()]}
      })
    })
    s = s.update({changes: [{from: 1, to: 4}, {from: 11, insert: [p("?")]}]}).state
    ist(s.doc, doc(blockquote(h1(), p("abc")), blockquote(h1(), p("?"), h1("h"), p("abc"))), eq)
  })

  it("can apply a correction to a start doc", () => {
    let c = Correction.onContent("Paragraph", node => {
      if (node.node.contentLength) return null
      return {from: node.start, insert: [Leaf.text(".")]}
    })
    let tr = c.scan(EditorState.create({doc: doc(p(), p("a"), p())}))
    ist(tr)
    ist(tr!.newDoc, doc(p("."), p("a"), p(".")), eq)
  })
})
