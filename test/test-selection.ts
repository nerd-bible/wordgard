import ist from "ist"
import {Schema, Plot} from "wordgard/doc"
import {basicSchema, basicBuilders, builder, maybeTag} from "wordgard/schema"
import {EditorSelection, EditorState, Direction} from "wordgard/state"
const {p, hr, blockquote, pre, $img} = basicBuilders

let Iso = Plot.defineBlock("Iso", {
  blockContent: "Block",
  group: "Block",
  isolating: true,
  shape: {element: "div"}
}), iso = builder(Iso)
let InlineA = Plot.defineInline("InlineA", {
  inlineContent: true,
  shape: {element: "span"}
}), a = builder(InlineA)
let InlineB = Plot.defineInline("InlineB", {
  inlineContent: true,
  cursorInsideBounds: true,
  shape: {element: "span"}
}), b = builder(InlineB)

const schema = Schema.define([...basicSchema.tags, ...basicSchema.marks, Iso, InlineA, InlineB])
const doc = builder(schema)

function normalPositions(state: EditorState) {
  let result: number[] = []
  for (let cur = EditorSelection.atStart(state);;) {
    result.push(cur.head)
    let next = cur.nextNormalCursor(state)
    if (next == null) return result
    cur = next
  }
}

describe("nextNormalCursor", () => {
  function testNormal(doc: Plot.Doc) {
    let state = EditorState.create({doc}), forward = normalPositions(state), back = []
    let expect = []
    for (let i = 0;; i++) {
      let next = maybeTag(doc, i)
      if (next == null) break
      expect.push(next)
    }
    for (let cur = EditorSelection.atEnd(state);;) {
      back.push(cur.head)
      let next = cur.nextNormalCursor(state, false)
      if (next == null) break
      cur = next
    }
    ist(forward.join(), expect.join())
    ist(back.join(), expect.reverse().join())
  }

  it("finds inline positions", () =>
    testNormal(doc(p(0, "o", 1, "n", 2, "e", 3))))

  it("allows positions between block leaves", () =>
    testNormal(doc(0, hr, 1, hr, 2)))

  it("doesn't include positions next to textblocks", () =>
    testNormal(doc(0, hr, p(1, "a", 2), hr, 3)))

  it("returns the bottom-most position between blocks", () =>
    testNormal(doc(0, blockquote(hr), 1, blockquote(hr), 2)))

  it("stops at isolating nodes", () =>
    testNormal(doc(0, iso(1, hr, 2), 3, iso(p(4)), 5)))

  it("allows positions between block atoms", () =>
    testNormal(doc(p(0, "-", 1), hr, 2, hr, 3)))

  it("creates positions around whitespace-preserving nodes", () =>
    testNormal(doc(0, pre(1, "a", 2), p(3), pre(4), 5)))

  it("handles inline nodes", () =>
    testNormal(doc(p(0, "a", 1, $img, 2, "b", 3), p(4, $img, 5))))

  it("skips whole glyphs", () =>
    testNormal(doc(p(0, "ő", 1, "👨‍🎤", 2, "🇪🇸", 3))))

  it("creates positions outside inline content nodes", () =>
    testNormal(doc(p(0, "a", 1, a("b", 2, "c"), 3, "d", 4))))

  it("creates positions inside inline content nodes with inside bounds", () =>
    testNormal(doc(p(0, "a", 1, b(2, "b", 3, "c", 4), 5, "d", 6))))

  it("exits text nodes", () => {
    testNormal(doc(p(0, "a", 1, "b", 2, $img, 3, "c", 4, "d", 5)))
  })

  describe("bidi", () => {
    function test(text: string, ltr: number[], rtl: number[]) {
      it("moves LTR through " + JSON.stringify(text), () => {
        ist(JSON.stringify(normalPositions(EditorState.create({doc: doc(p(text))})).map(n => n - 1)), JSON.stringify(ltr))
      })
      it("moves RTL through " + JSON.stringify(text), () => {
        let state = EditorState.create({doc: doc(p(text)), config: EditorState.textDirection.of(Direction.RTL)})
        ist(JSON.stringify(normalPositions(state).map(n => n - 1)), JSON.stringify(rtl))
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

describe("skipWord", () => {
  function test(name: string, lines: string | string[], positions: number[]) {
    it(name, () => {
      let state = EditorState.create({doc: doc((Array.isArray(lines) ? lines : [lines]).map(line => p(line)))})
      let cur = EditorSelection.atStart(state), found = []
      for (;;) {
        let next = cur.skipWord(state, true)
        if (!next) break
        found.push(next.head)
        cur = next
      }
      ist(JSON.stringify(found), JSON.stringify(positions))
    })
  }

  test("can skip words", "a bbb c", [2, 6, 8])

  test("skips whitespace", "  a      bbb", [4, 13])

  test("skips punctuation", "a. b??? / c", [2, 5, 12])

  test("can move across blocks", ["abc def", " efg"], [4, 8, 14])

  test("includes extra positions at end", "a b ", [2, 4, 5])

  test("is direction-aware", "a واحد اثنين ثلاثة b", [2, 14, 8, 19, 21])

  test("uses a segmenter", "两只兔子", [2, 3, 5])
})

describe("skipWord back", () => {
  function test(name: string, lines: string | string[], positions: number[]) {
    it(name, () => {
      let state = EditorState.create({doc: doc((Array.isArray(lines) ? lines : [lines]).map(line => p(line)))})
      let cur = EditorSelection.atEnd(state), found = []
      for (;;) {
        let prev = cur.skipWord(state, false)
        if (!prev) break
        found.push(prev.head)
        cur = prev
      }
      ist(JSON.stringify(found), JSON.stringify(positions))
    })
  }

  test("can skip words", "a bbb c", [7, 3, 1])

  test("skips whitespace", "a  bbb ", [4, 1])

  test("skips punctuation", "a. b??? / c", [11, 4, 1])

  test("can move across blocks", ["abc def ", " efg"], [12, 5, 1])

  test("includes extra positions at start", " a b", [4, 2, 1])

  test("is direction-aware", "a واحد اثنين ثلاثة b", [20, 7, 13, 19, 1])

  test("uses a segmenter", "两只兔子", [3, 2, 1])
})
