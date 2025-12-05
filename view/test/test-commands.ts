import {liftEmptyBlock, insertLineBreakInCode, createTextblock,
        splitTextblock, deleteSelection, joinBackward, joinForward, joinListItems,
        deleteBackward, deleteForward, setTextblockType,
        wrapBlock, unwrapBlock, unwrapBlockType, toggleList, toggleProp} from "@wordgard/view"
import {Node, Tag, Prop, DocNode, Schema, basicSchema, basicBuilders, maybeTag, builder,
        Paragraph, Heading, Blockquote, BulletList, OrderedList,
        Emphasis, Strong, Link} from "@wordgard/doc"
import {EditorState, StateCommand, EditorSelection} from "@wordgard/state"
import ist from "ist"

const {p, blockquote, ul, ol, li, pre, br, h1, $img, hr, em, strong} = basicBuilders

function eq<T extends {eq: (b: T) => boolean}>(a: T, b: T) { return a.eq(b) }

function selectionFrom(doc: DocNode) {
  let ranges: {from: number, to: number}[] = []
  for (let i = 0;; i += 2) {
    let head = maybeTag(doc, i)
    if (head == null)
      return ranges.length ? EditorSelection.create({anchor: ranges[0].from, head: ranges[0].to, ranges})
        : EditorSelection.atStart(EditorState.create({doc}))
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

function testSelProps(before: readonly Prop<any>[] | undefined, command: StateCommand, expect: readonly Prop<any>[]) {
  let state = EditorState.create({
    doc: doc(p()),
    selection: EditorSelection.cursor(1, 0, undefined, before)
  })
  command({state, dispatch: tr => state = tr.state})
  ist(state.selection.props!, expect, Prop.sameSet)
}

let TextOnly = Tag.defineBlock("TextOnly", {
  inlineContent: "Text",
  shape: {element: "div"},
  group: "Block"
}), to = builder(TextOnly)

let BlockProp = Prop.define("BlockProp", {
  keepOnSplit: false,
  keepOnTypeChange: false,
  tags: "Block",
  shape: {element: "prop1"}
}), bp = builder(BlockProp)

let PreservedProp = Prop.define("PreservedProp", {
  keepOnSplit: true,
  keepOnTypeChange: true,
  tags: "Block",
  shape: {element: "prop2"}
}), pp = builder(PreservedProp)

let InlineSpan = Tag.defineInline("InlineSpan", {
  inlineContent: true,
  shape: {element: "span"}
}), sp = builder(InlineSpan)

let InlineAtom = Tag.defineInline("InlineAtom", {
  inlineContent: true,
  shape: {element: "var", atom: true},
}), at = builder(InlineAtom)

let AtomProp = Prop.define("AtomProp", {
  tags: "Inline:Leaf InlineAtom",
  shape: {element: "atom-prop"}
}), ap = builder(AtomProp)

let schema = Schema.define([...basicSchema.tags, ...basicSchema.props, TextOnly,
                            BlockProp, PreservedProp, InlineSpan, InlineAtom, AtomProp])
let doc = builder(schema)

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

  it("preserves props on nodes it splits", () => {
    test(doc(pp(blockquote(p("a"), p(0), p("b")))), liftEmptyBlock, doc(pp(blockquote(p("a"))), p(0), pp(blockquote(p("b")))))
  })

  it("can drop props on nodes it splits", () => {
    test(doc(bp(blockquote(p("a"), p(0), p("b")))), liftEmptyBlock, doc(bp(blockquote(p("a"))), p(0), blockquote(p("b"))))
  })

  it("can lift blocks with an inline node", () => {
    test(doc(blockquote(p(sp(0)))), liftEmptyBlock, doc(p(sp(0))))
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

  it("preserves props", () => {
    test(doc(pp(p("a", 0, "b"))), splitTextblock, doc(pp(p("a")), pp(p(0, "b"))))
  })

  it("drops props when appropriate", () => {
    test(doc(bp(p("a", 0, "b"))), splitTextblock, doc(bp(p("a")), p(0, "b")))
  })

  it("can split inline nodes around the cursor", () => {
    test(doc(p("a", sp("b", 0, "c"), "d")), splitTextblock, doc(p("a", sp("b")), p(sp(0, "c"), "d")))
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

  it("can join two lists", () => {
    test(doc(ul(li(p("a"))), 0, p("-"), 1, ul(li(p("b")))), deleteSelection, doc(ul(li(p("a")), li(p("b")))))
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

  it("drops nodes not supported by the new parent", () => {
    test(doc(to("a"), p(0, $img())), joinBackward, doc(to("a", 0)))
  })

  it("can join from inside an inline node", () => {
    test(doc(p("a"), p(sp(0, "b"))), joinBackward, doc(p("a", sp(0, "b"))))
  })
})

describe("joinListItems", () => {
  it("joins list items", () => {
    test(doc(ul(li(p("a")), li(p(0, "b")))), joinListItems, doc(ul(li(p("a"), p(0, "b")))))
  })

  it("doesn't join when not at the start of the item", () => {
    test(doc(ul(li(p("a")), li(p("b", 0, "c")))), joinListItems)
    test(doc(ul(li(p("a")), li(p("b"), p(0, "c")))), joinListItems)
  })

  it("doesn't try to join the first item", () => {
    test(doc(ul(li(p("a"))), ul(li(p(0, "b")))), joinListItems)
  })

  it("doesn't join non-list items", () => {
    test(doc(blockquote(blockquote(p("a")), blockquote(p(0, "b")))), joinListItems)
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

  it("drops nodes not supported by the new parent", () => {
    test(doc(to("a", 0), p($img())), joinForward, doc(to("a", 0)))
  })

  it("can join from the end of an inline node", () => {
    test(doc(p(sp("a", 0)), p("b")), joinForward, doc(p(sp("a", 0), "b")))
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

describe("setTextblockType", () => {
  it("can change the type of a paragraph", () => {
    test(doc(p("a", 0), p("b")), setTextblockType(Heading.of(1)), doc(h1("a", 0), p("b")))
  })

  it("can change the type of two paragraphs", () => {
    test(doc(p(0, "a"), p("b", 1)), setTextblockType(Heading.of(1)), doc(h1(0, "a"), h1("b", 1)))
  })

  it("can change the type of two paragraphs at different depth", () => {
    test(doc(p(0, "a"), blockquote(p("b", 1))), setTextblockType(Heading.of(1)), doc(h1(0, "a"), blockquote(h1("b", 1))))
  })

  it("returns false at the top level", () => {
    let s = Schema.define([Tag.defineDoc({inlineContent: true}), Paragraph])
    test(s.doc([]), setTextblockType(Paragraph))
  })

  it("returns false when the node is already of that type", () => {
    test(doc(p(0)), setTextblockType(Paragraph))
  })

  it("works on multiple selections", () => {
    test(doc(h1(0, "h"), p("a", 1), blockquote(p("b"), pre("c", 2)), pre("d", 4)), setTextblockType(Paragraph),
         doc(p(0, "h"), p("a", 1), blockquote(p("b"), p("c", 2)), p("d", 4)))
  })

  it("clears disallowed content", () => {
    test(doc(p("a", 0, $img())), setTextblockType(TextOnly), doc(to("a", 0)))
  })

  it("preserves props when appropriate", () => {
    test(doc(pp(p(0, "a")), p("b", 1)), setTextblockType(Heading.of(1)), doc(pp(h1(0, "a")), h1("b", 1)))
  })

  it("drops props when appropriate", () => {
    test(doc(bp(p(0, "a"))), setTextblockType(Heading.of(1)), doc(h1(0, "a")))
  })
})

describe("wrapBlock", () => {
  it("can wrap a paragraph in a blockquote", () => {
    test(doc(p(0)), wrapBlock(Blockquote), doc(blockquote(p(0))))
  })

  it("can wrap two paragraphs in a blockquote", () => {
    test(doc(p(0), p(1)), wrapBlock(Blockquote), doc(blockquote(p(0), p(1))))
  })

  it("can wrap three paragraphs in a blockquote", () => {
    test(doc(p(0), p("wow"), p(1)), wrapBlock(Blockquote), doc(blockquote(p(0), p("wow"), p(1))))
  })

  it("can content inside a blockquote", () => {
    test(doc(blockquote(p("a"), p(0), p("b"))), wrapBlock(Blockquote), doc(blockquote(p("a"), blockquote(p(0)), p("b"))))
  })

  it("will expand to cover a partially selected node", () => {
    test(doc(p(0), blockquote(p(1), p("a"))), wrapBlock(Blockquote), doc(blockquote(p(0), blockquote(p(1), p("a")))))
  })

  it("will create required wrapper nodes", () => {
    test(doc(p("a", 0), p("b"), p("c", 1), p("d")), wrapBlock(BulletList),
         doc(ul(li(p("a", 0)), li(p("b")), li(p("c", 1))), p("d")))
  })

  it("will pick the innermost valid depth", () => {
    test(doc(blockquote(p("a", 0))), wrapBlock(BulletList), doc(blockquote(ul(li(p("a", 0))))))
  })

  it("will join to adjacent auto-join node", () => {
    test(doc(blockquote(p("a")), p("b", 0), blockquote(p("c"))), wrapBlock(Blockquote),
         doc(blockquote(p("a"), p("b"), p("c"))))
  })
})

describe("unwrapBlock", () => {
  it("can unwrap a quote", () => {
    test(doc(blockquote(p("a", 0))), unwrapBlock, doc(p("a", 0)))
  })

  it("can unwrap multiple children from a quote", () => {
    test(doc(blockquote(p("a", 0), p("b", 1))), unwrapBlock, doc(p("a", 0), p("b", 1)))
  })

  it("can partially unwrap quote with content left at end", () => {
    test(doc(blockquote(p("a", 0), p("b"))), unwrapBlock, doc(p("a", 0), blockquote(p("b"))))
  })

  it("can partially unwrap quote with content left at start", () => {
    test(doc(blockquote(p("a"), p("b", 0))), unwrapBlock, doc(blockquote(p("a")), p("b", 0)))
  })

  it("can partially unwrap quote with content left at both sides", () => {
    test(doc(blockquote(p("a"), p("b", 0), p("c"))), unwrapBlock, doc(blockquote(p("a")), p("b", 0), blockquote(p("c"))))
  })

  it("can unwrap a list", () => {
    test(doc(ul(li(p("a", 0)), li(p("b", 1)))), unwrapBlock, doc(p("a", 0), p("b", 1)))
  })

  it("can partially unwrap a list", () => {
    test(doc(ul(li(p("a")), li(p("b", 0)), li(p("c")))), unwrapBlock, doc(ul(li(p("a"))), p("b", 0), ul(li(p("c")))))
  })

  it("can partially unwrap nested content at start", () => {
    test(doc(ul(li(p("a")), li(blockquote(p("b", 0))))), unwrapBlockType(BulletList),
         doc(ul(li(p("a"))), blockquote(p("b", 0))))
  })

  it("can partially unwrap nested content at end", () => {
    test(doc(ul(li(blockquote(p("a", 0))), li(p("b")))), unwrapBlockType(BulletList),
         doc(blockquote(p("a", 0)), ul(li((p("b"))))))
  })

  it("can unwrap children from multiple parents", () => {
    test(doc(ul(li(p("a"), p("b", 0))), ul(li(p("c", 1), p("d")))), unwrapBlock,
         doc(ul(li(p("a"))), p("b", 0), p("c", 1), ul(li(p("d")))))
  })

  it("returns false at the top level", () => {
    test(doc(p("a", 0)), unwrapBlock)
  })

  it("can unwrap textblock list items", () => {
    let list = Tag.defineBlock("List", {shape: {element: "ul"}, group: "Block", blockContent: "Item"})
    let item = Tag.defineBlock("Item", {shape: {element: "li"}, inlineContent: true})
    let s = Schema.define([...basicSchema.tags, list, item])
    let state = EditorState.create({
      doc: s.doc([list.create([item.create([Node.text("a")]), item.create([Node.text("b")])])]),
      selection: {anchor: 0, head: 8}
    })
    unwrapBlockType(list)({state, dispatch: tr => state = tr.state})
    ist(state.doc, s.doc([p("a"), p("b")]), eq)
  })

  it("will auto-join unwrapped nodes", () => {
    test(doc(ul(li(p("a"))), blockquote(ul(li(p(0, "b"))))), unwrapBlock,
         doc(ul(li(p("a")), li(p(0, "b")))))
    
  })
})

describe("toggleList", () => {
  let toggleUL = toggleList(BulletList), toggleOL = toggleList(OrderedList.default!)

  it("can add a list to a single block", () => {
    test(doc(p("a", 0)), toggleUL, doc(ul(li(p("a", 0)))))
  })

  it("can add a list to two blocks", () => {
    test(doc(p("a", 0), p("b", 1)), toggleOL, doc(ol(li(p("a", 0)), li(p("b", 1)))))
  })

  it("can remove a list", () => {
    test(doc(ol(li(p(0)))), toggleOL, doc(p(0)))
  })

  it("can remove only some items from a list", () => {
    test(doc(ul(li(p("a")), li(p(0, "b")), li(p("c", 1)), li(p("d")))),
         toggleUL,
         doc(ul(li(p("a"))), p(0, "b"), p("c", 1), ul(li(p("d")))))
  })

  it("adds lists when it can", () => {
    test(doc(ol(li(p(0))), p(1)), toggleOL, doc(ol(li(p(0)), li(p(1)))))
  })

  it("joins newly created lists to those above and below", () => {
    test(doc(ul(li(p("a"))), p("b", 0), ul(li(p("c")))),
         toggleUL,
         doc(ul(li(p("a")), li(p("b", 0)), li(p("c")))))
  })

  it("joins changed lists to those above and below", () => {
    test(doc(ul(li(p("a"))), ol(li(p("b", 0))), ul(li(p("c")))),
         toggleUL,
         doc(ul(li(p("a")), li(p("b", 0)), li(p("c")))))
  })

  it("can change a list's type", () => {
    test(doc(ul(li(p(0)))), toggleOL, doc(ol(li(p(0)))))
  })

  it("can the type of two adjacent lists", () => {
    test(doc(ul(li(p(0))), ul(li(p(1)))), toggleOL, doc(ol(li(p(0)), li(p(1)))))
  })

  it("can change a list's type and wrap items before and after", () => {
    test(doc(p(0), ul(li(p())), p(1)), toggleOL, doc(ol(li(p(0)), li(p()), li(p(1)))))
  })

  it("can handle multiple cursors in a single block", () => {
    test(doc(p(0, "a", 2, "b", 4)), toggleOL, doc(ol(li(p(0, "a", 2, "b", 4)))))
  })

  it("can unwrap a wrapper block", () => {
    test(doc(ul(li(blockquote(p(0, "a"), p("b", 1))))), toggleUL, doc(blockquote(p(0, "a"), p("b", 1))))
  })

  it("can unwrap a nested item", () => {
    test(doc(ul(li(p("a"), ul(li(p("b", 0)))))), toggleUL, doc(ul(li(p("a"), p("b", 0)))))
  })

  it("can wrap a nested item", () => {
    test(doc(ul(li(p("a"), p("b", 0)))), toggleUL, doc(ul(li(p("a"), ul(li(p("b", 0)))))))
  })

  it("can unwrap an item with multiple children", () => {
    test(doc(ul(li(p("a", 0), p("b")))), toggleUL, doc(p("a", 0), p("b")))
  })
})

describe("toggleProp", () => {
  it("can add emphasis to a selection", () => {
    test(doc(p("a", 0, "bc", 1, "d")), toggleProp(Emphasis), doc(p("a", 0, em("bc"), 1, "d")))
  })

  it("can remove emphasis from a selection", () => {
    test(doc(p("a", 0, em("bc"), 1, "d")), toggleProp(Emphasis), doc(p("a", 0, "bc", 1, "d")))
  })

  it("adds emphasis to a mixed-prop selection", () => {
    test(doc(p("a", 0, em("bc"), "d", 1)), toggleProp(Emphasis), doc(p("a", 0, em("bcd"), 1)))
  })

  it("stacks added props with others", () => {
    test(doc(p("a", 0, strong(em("bc")), "d", 1)), toggleProp(Emphasis), doc(p("a", 0, em(strong("bc"), "d"), 1)))
  })

  it("adds selection props", () => {
    testSelProps(undefined, toggleProp(Emphasis), [Emphasis])
  })

  it("adds selection props to existing set", () => {
    testSelProps([Strong], toggleProp(Emphasis), [Emphasis, Strong])
  })

  it("removes selection props", () => {
    testSelProps([Emphasis], toggleProp(Emphasis), [])
  })

  it("replaces props of the same type", () => {
    testSelProps([Link.of("/")], toggleProp(Link.of("#")), [Link.of("#")])
  })

  it("doesn't add the same prop on multiple levels", () => {
    test(doc(p(0, sp("abc"), "d", 1)), toggleProp(Emphasis), doc(p(0, sp(em("abc")), em("d"), 1)))
  })

  it("can add a prop inside an inline node", () => {
    test(doc(p(sp("a", 0, "b", 1, "c"))), toggleProp(Emphasis), doc(p(sp("a", 0, em("b"), 1, "c"))))
  })

  it("can add a prop to an inline node that partially has it", () => {
    test(doc(p(0, sp("a", em("b"), "c"), 1)), toggleProp(Emphasis), doc(p(0, sp(em("abc")), 1)))
  })

  it("will not add to both a parent and a child", () => {
    test(doc(p(0, "a", at("b"), 1)), toggleProp(AtomProp), doc(p(0, ap("a", at("b")), 1)))
  })

  it("will not remove a prop from inside an inline element that supports it", () => {
    test(doc(p(0, at(ap("b")), 1)), toggleProp(AtomProp), doc(p(0, ap(at(ap("b"))), 1)))
  })
})
