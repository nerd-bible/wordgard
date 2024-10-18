import {liftEmptyBlock, insertLineBreakInCode, createTextblock,
        splitTextblock, deleteSelection, joinBackward, joinForward,
        deleteBackward, deleteForward} from "@willows/view"
import {Tag, DocNode, basicBuilders, maybeTag, builder} from "@willows/doc"
import {EditorState, StateCommand, EditorSelection} from "@willows/state"
import ist from "ist"

const {doc, p, blockquote, ul, li, pre, br, h1, $img, hr} = basicBuilders

function eq<T extends {eq: (b: T) => boolean}>(a: T, b: T) { return a.eq(b) }

function selectionFrom(doc: DocNode) {
  let ranges: {from: number, to: number}[] = []
  for (let i = 0;; i += 2) {
    let head = maybeTag(doc, i)
    if (head == null) return EditorSelection.create({anchor: ranges[0].from, head: ranges[0].to, ranges})
    ranges.push({from: head, to: maybeTag(doc, i + 1) ?? head})
  }
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
    if (maybeTag(expect, 0) != null) {
      let expectedSel = selectionFrom(expect)
      ist(JSON.stringify(state.selection.ranges), JSON.stringify(expectedSel.ranges))
    }
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

describe("deleteSelection", () => {
  it("can delete an inline selection", () => {
    test(doc(p("one", 0, "two", 1, "three")), deleteSelection, doc(p("one", 0, "three")))
  })

  it("can join two paragraphs", () => {
    test(doc(p("a", 0, "b"), p("c", 1, "d")), deleteSelection, doc(p("a", 0, "d")))
  })

  it("can delete across blocks", () => {
    test(doc(p("a", 0), blockquote(p(1, "b"), p("c"))), deleteSelection, doc(p("a", 0, "b"), blockquote(p("c"))))
  })

  it("can delete leaving a block", () => {
    test(doc(blockquote(p("a"), p(0)), p("b", 1, "c"), p("d")), deleteSelection, doc(blockquote(p("a"), p(0, "c")), p("d")))
  })

  it("keeps the start block type", () => {
    test(doc(h1("a", 0), pre(1, "b")), deleteSelection, doc(h1("a", 0, "b")))
  })

  it("expands the deleted range", () => {
    test(doc(blockquote(p(0, "a"), p("b", 1)), p("b")), deleteSelection, doc(p(0, "b")))
  })

  it("can delete multiple selected ranges", () => {
    test(doc(p("a", 0, "b", 1, "c", 2, "d", 3, "e")), deleteSelection, doc(p("a", 0, "c", 2, "e")))
  })
})

describe("joinBackward", () => {
  it("can join two paragraphs", () => {
    test(doc(p("a"), p(0, "b")), joinBackward, doc(p("a", 0, "b")))
  })

  it("can join when the start is deeper than the end", () => {
    test(doc(blockquote(p("a")), p(0, "b")), joinBackward, doc(blockquote(p("a", 0, "b"))))
  })

  it("can join when the start is much deeper than the end", () => {
    test(doc(ul(li(blockquote(p("a")))), p(0, "b")), joinBackward, doc(ul(li(blockquote(p("a", 0, "b"))))))
  })

  it("can drop extra tokens after the end", () => {
    test(doc(ul(li(p("a"))), blockquote(p(0, "b"))), joinBackward, doc(ul(li(p("a", 0, "b")))))
  })

  it("can join when the end is deeper than the start", () => {
    test(doc(p("a"), blockquote(p(0, "b"))), joinBackward, doc(p("a", 0, "b")))
  })

  it("can join when the end is much deeper than the start", () => {
    test(doc(p("a"), ul(li(blockquote(p(0, "b"))))), joinBackward, doc(p("a", 0, "b")))
  })

  it("does nothing when not at the start of a textblock", () => {
    test(doc(p("a"), p("b", 0)), joinBackward)
  })

  it("drops the type of the first block if it's empty", () => {
    test(doc(h1(), p(0, "a")), joinBackward, doc(p(0, "a")))
  })

  it("joins parent nodes after", () => {
    test(doc(ul(li(p("a"))), p(0, "b"), ul(li(p("c")))), joinBackward, doc(ul(li(p("a", 0, "b")), li(p("c")))))
  })

  let TextOnly = Tag.defineBlock("TextOnly", {
    inlineContent: "Text",
    dom: {element: "div"},
    group: "Block"
  }), to = builder(TextOnly)

  it("drops nodes not supported by the new parent", () => {
    test(doc(to("a"), p(0, $img())), joinBackward, doc(to("a", 0)))
  })
})

describe("joinForward", () => {
  it("can join two paragraphs", () => {
    test(doc(p("a", 0), p("b")), joinForward, doc(p("a", 0, "b")))
  })

  it("can join when the start is deeper than the end", () => {
    test(doc(blockquote(p("a", 0)), p("b")), joinForward, doc(blockquote(p("a", 0, "b"))))
  })

  it("can join when the start is much deeper than the end", () => {
    test(doc(ul(li(blockquote(p("a", 0)))), p("b")), joinForward, doc(ul(li(blockquote(p("a", 0, "b"))))))
  })

  it("can drop extra tokens after the end", () => {
    test(doc(ul(li(p("a", 0))), blockquote(p("b"))), joinForward, doc(ul(li(p("a", 0, "b")))))
  })

  it("can join when the end is deeper than the start", () => {
    test(doc(p("a", 0), blockquote(p("b"))), joinForward, doc(p("a", 0, "b")))
  })

  it("can join when the end is much deeper than the start", () => {
    test(doc(p("a", 0), ul(li(blockquote(p("b"))))), joinForward, doc(p("a", 0, "b")))
  })

  it("does nothing when not at the end of a textblock", () => {
    test(doc(p(0, "a"), p("b")), joinForward)
  })

  it("drops the type of the first block if it's empty", () => {
    test(doc(h1(0), p("a")), joinForward, doc(p(0, "a")))
  })

  it("joins parent nodes after", () => {
    test(doc(ul(li(p("a", 0))), p("b"), ul(li(p("c")))), joinForward, doc(ul(li(p("a", 0, "b")), li(p("c")))))
  })

  let TextOnly = Tag.defineBlock("TextOnly", {
    inlineContent: "Text",
    dom: {element: "div"},
    group: "Block"
  }), to = builder(TextOnly)

  it("drops nodes not supported by the new parent", () => {
    test(doc(to("a", 0), p($img())), joinForward, doc(to("a", 0)))
  })
})

describe("deleteBackward", () => {
  it("can delete a letter", () => {
    test(doc(p("abc", 0)), deleteBackward, doc(p("ab", 0)))
  })

  it("can delete a composite letter", () => {
    test(doc(p("👨‍🎤👨‍🎤", 0, "!")), deleteBackward, doc(p("👨‍🎤", 0, "!")))
  })

  it("can delete an image", () => {
    test(doc(p("a", $img(), 0, "b")), deleteBackward, doc(p("a", 0, "b")))
  })

  it("can delete a horizontal rule", () => {
    test(doc(hr(), 0, p("x")), deleteBackward, doc(0, p("x")))
  })

  it("can delete a horizontal rule from inside the next node", () => {
    test(doc(hr(), p(0, "x")), deleteBackward, doc(p(0, "x")))
  })

  it("can delete a horizontal rule inside a wrapping node", () => {
    test(doc(ul(li(hr())), p(0, "x")), deleteBackward, doc(p(0, "x")))
  })

  it("won't clear wrappers with extra content", () => {
    test(doc(ul(li(p("a")), li(hr())), p(0, "x")), deleteBackward, doc(ul(li(p("a"))), p(0, "x")))
  })

  it("will not clear the document", () => {
    test(doc(hr(), 0), deleteBackward)
  })
})

describe("deleteForward", () => {
  it("can delete a letter", () => {
    test(doc(p(0, "abc")), deleteForward, doc(p(0, "bc")))
  })

  it("can delete a letter in the middle of a text node", () => {
    test(doc(p("a", 0, "bc")), deleteForward, doc(p("a", 0, "c")))
  })

  it("can delete a composite letter", () => {
    test(doc(p("..", 0, "👨‍🎤👨‍🎤")), deleteForward, doc(p("..", 0, "👨‍🎤")))
  })

  it("can delete an image", () => {
    test(doc(p("a", 0, $img(), "b")), deleteForward, doc(p("a", 0, "b")))
  })

  it("can delete a horizontal rule", () => {
    test(doc(p("x"), 0, hr()), deleteForward, doc(p("x"), 0))
  })

  it("can delete a horizontal rule from inside the next node", () => {
    test(doc(p("x", 0), hr()), deleteForward, doc(p("x", 0)))
  })

  it("can delete a horizontal rule inside a wrapping node", () => {
    test(doc(p(0), ul(li(hr()))), deleteForward, doc(p(0)))
  })

  it("won't clear wrappers with extra content", () => {
    test(doc(p("x", 0), ul(li(hr()), li(p("a")))), deleteForward, doc(p("x", 0), ul(li(p("a")))))
  })

  it("will not clear the document", () => {
    test(doc(0, hr()), deleteForward)
  })
})
