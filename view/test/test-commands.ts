import {liftEmptyBlock, insertLineBreakInCode, createTextblock, splitTextblock} from "@willows/view"
import {DocNode, basicBuilders, tag, maybeTag} from "@willows/doc"
import {EditorState, StateCommand, EditorSelection} from "@willows/state"
import ist from "ist"

const {doc, p, blockquote, ul, li, pre, br, h1} = basicBuilders

function eq<T extends {eq: (b: T) => boolean}>(a: T, b: T) { return a.eq(b) }

function selectionFrom(doc: DocNode) {
  let head = tag(doc, 0), anchor = maybeTag(doc, 1) ?? head
  return EditorSelection.range(anchor, head)
}

function test(doc: DocNode, command: StateCommand, expect?: DocNode) {
  let state = EditorState.create({
    doc,
    selection: selectionFrom(doc)
  })
  let result = command({state, dispatch: tr => state = tr.state})
  if (expect) {
    ist(result)
    ist(state.doc, expect, eq)
    if (maybeTag(expect, 0) != null) ist(state.selection.main, selectionFrom(expect), eq)
  } else {
    ist(!result)
  }
}

describe("liftEmptyBlock", () => {
  it("can lift a paragraph out of a quote", () => {
    test(doc(blockquote(p(0))), liftEmptyBlock, doc(p(0)))
  })

  it("can leave sibling nodes in parent", () => {
    test(doc(blockquote(p("a"), p(0), p("b"))), liftEmptyBlock, doc(blockquote(p("a")), p(0), blockquote(p("b"))))
  })

  it("can lift out of multiple parents", () => {
    test(doc(ul(li(p(0)))), liftEmptyBlock, doc(p(0)))
  })

  it("can lift out of multiple parents and leave siblings", () => {
    test(doc(ul(li(p("a")), li(p(0)), li(p("b")))), liftEmptyBlock, doc(ul(li(p("a"))), p(0), ul(li(p("b")))))
  })

  it("can close asymmetric parents", () => {
    test(doc(ul(li(p("a")), li(p(0), p("b")))), liftEmptyBlock, doc(ul(li(p("a"))), p(0), ul(li(p("b")))))
  })

  it("returns false when unable to lift", () => {
    test(doc(p(0)), liftEmptyBlock)
  })

  it("only goes up to the next parent that fits", () => {
    test(doc(blockquote(blockquote(p(0), p("a")))), liftEmptyBlock, doc(blockquote(p(0), blockquote(p("a")))))
  })
})

describe("insertLineBreakInCode", () => {
  it("does nothing in regular textblocks", () => {
    test(doc(p("hi", 0)), insertLineBreakInCode)
  })

  it("adds a line break when in a code block", () => {
    test(doc(pre("hi", 0)), insertLineBreakInCode, doc(pre("hi", br(), 0)))
  })

  it("can overwrite text", () => {
    test(doc(pre("a", 0, "b", 1, "c")), insertLineBreakInCode, doc(pre("a", br(), 0, "c")))
  })

  it("doesn't apply when the selection crosses out of the block", () => {
    test(doc(pre(0), p("a"), pre(1)), insertLineBreakInCode)
  })
})

describe("createTextblock", () => {
  it("inserts a paragraph node", () => {
    test(doc(p("a"), 0, p("b")), createTextblock, doc(p("a"), p(0), p("b")))
  })

  it("does nothing in inline context", () => {
    test(doc(p("a", 0), p("b")), createTextblock)
  })

  it("can create wrapper nodes", () => {
    test(doc(ul(li(p("a")), 0, li(p("b")))), createTextblock, doc(ul(li(p("a")), li(p(0)), li(p("b")))))
  })

  it("can overwrite a selection", () => {
    test(doc(0, pre("a"), p("b"), 1), createTextblock, doc(p(0)))
  })
})

describe("splitTextblock", () => {
  it("can split a paragraph", () => {
    test(doc(p("a", 0, "b")), splitTextblock, doc(p("a"), p(0, "b")))
  })

  it("can split when selection spans paragraphs", () => {
    test(doc(p("a", 0, "b"), p("c", 1, "d")), splitTextblock, doc(p("a"), p(0, "d")))
  })

  it("can split when selection ends at a higher depth", () => {
    test(doc(p("a", 0, "b"), blockquote(p("c", 1, "d"), p("e"))), splitTextblock, doc(p("a"), p(0, "d"), blockquote(p("e"))))
  })

  it("can split when selection ends at a lower depth", () => {
    test(doc(blockquote(p(0)), p(1, "a"), p("b")), splitTextblock, doc(blockquote(p(), p(0, "a")), p("b")))
  })

  it("keeps tag when splitting in the middle", () => {
    test(doc(h1("a", 0, "b")), splitTextblock, doc(h1("a"), h1(0, "b")))
  })

  it("picks the default block when splitting at the end", () => {
    test(doc(h1("a", 0)), splitTextblock, doc(h1("a"), p(0)))
  })

  it("resets the origin block when splitting at the start", () => {
    test(doc(h1(0, "a")), splitTextblock, doc(p(), h1(0, "a")))
  })
})
