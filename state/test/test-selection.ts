import ist from "ist"
import {Schema, basicSchema, DocNode, Tag, basicBuilders, builder, maybeTag} from "@willows/doc"
import {EditorSelection, SelectionContext, Direction} from "@willows/state"
const {p, hr, blockquote, pre, $img} = basicBuilders

let Iso = Tag.defineBlock("Iso", {
  blockContent: "Block",
  group: "Block",
  isolating: true,
  dom: {element: "div"}
}), iso = builder(Iso)
let InlineA = Tag.defineInline("InlineA", {
  inlineContent: true,
  dom: {element: "span"}
}), a = builder(InlineA)
let InlineB = Tag.defineInline("InlineB", {
  inlineContent: true,
  cursorInsideBounds: true,
  dom: {element: "span"}
}), b = builder(InlineB)

const schema = Schema.define([...basicSchema.tags, ...basicSchema.props, Iso, InlineA, InlineB])
const doc = builder(schema)

function normalPositions(cx: SelectionContext) {
  let result: number[] = []
  for (let cur = EditorSelection.near(cx, 0);;) {
    result.push(cur.head)
    let next = EditorSelection.nextNormalCursor(cx, cur)
    if (next == null) return result
    cur = next
  }
}

describe("nextNormalCursor", () => {
  function testNormal(doc: DocNode) {
    let cx = {doc}, forward = normalPositions({doc}), back = []
    let expect = []
    for (let i = 0;; i++) {
      let next = maybeTag(doc, i)
      if (next == null) break
      expect.push(next)
    }
    for (let cur = EditorSelection.near(cx, doc.length);;) {
      back.push(cur.head)
      let next = EditorSelection.prevNormalCursor(cx, cur)
      if (next == null) break
      cur = next
    }
    ist(forward.join(), expect.join())
    ist(back.join(), expect.reverse().join())
  }

  it("finds inline positions", () =>
    testNormal(doc(p(0, "o", 1, "n", 2, "e", 3))))

  it("allows positions between block leaves", () =>
    testNormal(doc(0, hr(), 1, hr(), 2)))

  it("doesn't include positions next to textblocks", () =>
    testNormal(doc(0, hr(), p(1, "a", 2), hr(), 3)))

  it("returns the bottom-most position between blocks", () =>
    testNormal(doc(0, blockquote(hr()), 1, blockquote(hr()), 2)))

  it("stops at isolating nodes", () =>
    testNormal(doc(0, iso(1, hr(), 2), 3, iso(p(4)), 5)))

  it("creates positions around whitespace-preserving nodes", () =>
    testNormal(doc(0, pre(1, "a", 2), p(3), pre(4), 5)))

  it("handles inline nodes", () =>
    testNormal(doc(p(0, "a", 1, $img(), 2, "b", 3), p(4, $img(), 5))))

  it("skips whole glyphs", () =>
    testNormal(doc(p(0, "ő", 1, "👨‍🎤", 2, "🇪🇸", 3))))

  it("creates positions outside inline content nodes", () =>
    testNormal(doc(p(0, "a", 1, a("b", 2, "c"), 3, "d", 4))))

  it("creates positions inside inline content nodes with inside bounds", () =>
    testNormal(doc(p(0, "a", 1, b(2, "b", 3, "c", 4), 5, "d", 6))))

  it("exits text nodes", () => {
    testNormal(doc(p(0, "a", 1, "b", 2, $img(), 3, "c", 4, "d", 5)))
  })

  describe("bidi", () => {
    function test(text: string, ltr: number[], rtl: number[]) {
      it("moves LTR through " + JSON.stringify(text), () => {
        ist(JSON.stringify(normalPositions({doc: doc(p(text))}).map(n => n - 1)), JSON.stringify(ltr))
      })
      it("moves RTL through " + JSON.stringify(text), () => {
        ist(JSON.stringify(normalPositions({doc: doc(p(text)), textDirection: () => Direction.RTL}).map(n => n - 1)), JSON.stringify(rtl))
      })
    }

    test("الصفصاف",
         [7, 6, 5, 4, 3, 2, 1, 0],
         [0, 1, 2, 3, 4, 5, 6, 7])
    test("treeشجرة",
         [0, 1, 2, 3, 4, 7, 6, 5, 4],
         [4, 3, 2, 1, 4, 5, 6, 7, 8])
    test("شجرةtree",
         [4, 3, 2, 1, 4, 5, 6, 7, 8],
         [0, 1, 2, 3, 4, 7, 6, 5, 4])
    test("aشجرةtree",
         [0, 1, 4, 3, 2, 5, 6, 7, 8, 9],
         [1, 1, 2, 3, 4, 5, 8, 7, 6, 5])
    test("رقم415خمسة",
         [10, 9, 8, 7, 6, 4, 5, 3, 2, 1, 0],
         [0, 1, 2, 3, 5, 4, 6, 7, 8, 9, 10])
    test("كو,",
         [2, 1, 2, 3],
         [0, 1, 2, 3])
    test("  foo  ",
         [0, 1, 2, 3, 4, 5, 6, 7],
         [0, 1, 2, 4, 3, 5, 6, 7])
    test("  مرآة  ",
         [0, 1, 2, 5, 4, 3, 6, 7, 8],
         [0, 1, 2, 3, 4, 5, 6, 7, 8])
    test("ab12-34%م",
         [0, 1, 2, 3, 4, 5, 6, 7, 8, 8],
         [8, 7, 6, 5, 4, 3, 2, 1, 8, 9])
    test("ر12:34ر",
         [7, 6, 2, 3, 4, 5, 1, 0],
         [0, 1, 5, 4, 3, 2, 6, 7])
    test("ab مرآة10 cde 20مرآة!",
         [0, 1, 2, 3, 8, 7, 6, 5, 4, 9, 10, 11, 12, 13, 14, 15, 16, 19, 18, 17, 20, 21],
         [2, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 15, 14, 13, 12, 11, 16, 17, 18, 19, 20, 21])
    test("(ء)و)",
         [0, 1, 2, 3, 4, 5],
         [0, 1, 2, 3, 4, 5])
    test("(([^ء-ي]|^)و)",
         [0, 1, 2, 3, 4, 6, 5, 7, 8, 9, 10, 11, 12, 13],
         [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13])
    test("ء(و)",
         [4, 3, 2, 1, 0],
         [0, 1, 2, 3, 4])
    test("[foo(barء)]",
         [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11],
         [0, 1, 3, 2, 4, 5, 7, 6, 8, 9, 10, 11])
  })
})
