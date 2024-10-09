import ist from "ist"
import {DocNode, Tag, basicBuilder, builders, maybeTag} from "@willows/doc"
import {EditorSelection} from "@willows/state"
const {doc, p, hr, blockquote} = basicBuilder

describe("normalPosAfter", () => {
  function testNormal(doc: DocNode) {
    let expect = [], forward = [], back = []
    for (let i = 0;; i++) {
      let next = maybeTag(doc, i)
      if (next == null) break
      expect.push(next)
    }
    for (let cur = 0, first = true;; first = false) {
      let next = EditorSelection.normalPositionAfter(doc, cur, !first)
      if (next == null) break
      forward.push(cur = next)
    }
    for (let cur = doc.length, first = true;; first = false) {
      let next = EditorSelection.normalPositionBefore(doc, cur, !first)
      if (next == null) break
      back.push(cur = next)
    }
    ist(forward.join(), expect.join())
    ist(back.join(), expect.reverse().join())
  }

  let Iso = Tag.defineBlock("Iso", {
    blockContent: "Block",
    group: "Block",
    isolating: true,
    dom: {element: "div"}
  }), {iso} = builders({iso: Iso})

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
})
