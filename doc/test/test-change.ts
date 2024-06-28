import ist from "ist"
import {Node, DocNode, Mark,
        ChangeSet, ChangeSpec,
        basicBuilder, tag, maybeTag,
        Slice, Token, OpenToken, CloseToken,
        Emphasis, Strong} from "@willow/doc"
const {doc, p, img, em, strong, blockquote} = basicBuilder

type ChangeData = (Token | string)[] | {add: Mark} | {remove: Mark} | {setAttr: string, value: any}

function o(node: Node) { return new OpenToken(node) }
const c = CloseToken
const mEm = Emphasis.create(), mStrong = Strong.create()

// Construct a change set starting from the given document, using
// pairs of tags (i*2, i*2+1 ?? i*2) as the extent of each change.
function mk(doc: DocNode, changes: readonly ChangeData[]) {
  return ChangeSet.create(doc, changes.map((ch, i): ChangeSpec => {
    let from = tag(doc, i * 2)
    if (from == null) throw new Error(`No start position defined for change ${i}`)
    let to = maybeTag(doc, i * 2 + 1) ?? from
    if (Array.isArray(ch)) return {from, to, insert: new Slice(ch.map(t => typeof t == "string" ? Node.text(t) : t))}
    let {add, remove, setAttr, value} = ch as {add?: Mark, remove?: Mark, setAttr?: string, value?: any}
    if (add) return {from, to, addMark: add}
    if (remove) return {from, to, removeMark: remove}
    return {from, to, setAttr: {[setAttr!]: value!}}
  }))
}

function eq<T extends {eq(b: T): boolean}>(a: T, b: T) { return a.eq(b) }

describe("ChangeSet", () => {
  describe("apply", () => {
    function testApply(doc: DocNode, changes: ChangeData[], expect: Node) {
      ist(mk(doc, changes).apply(doc), expect, eq)
    }

    it("can apply inline insertions", () => {
      testApply(doc(p("one ", 0, "three")), [["two "]], doc(p("one two three")))
    })

    it("can apply inline deletions", () => {
      testApply(doc(p("one ", 0, "two ", 1, "three")), [[]], doc(p("one three")))
    })

    it("can apply inline replacements", () => {
      testApply(doc(p("one ", 0, "two", 1, " three")), [["four"]], doc(p("one four three")))
    })

    it("can apply multiple inline replacements", () => {
      testApply(doc(p(0, " and ", 2)), [["one"], ["two"]], doc(p("one and two")))
    })

    it("can apply multiple inline replacements provided in inverted order", () => {
      testApply(doc(p(2, " and ", 0)), [["one"], ["two"]], doc(p("two and one")))
    })

    it("can split a node", () => {
      testApply(doc(p("one", 0, "two")), [[c, o(p())]], doc(p("one"), p("two")))
    })

    it("can join a node", () => {
      testApply(doc(p("one", 0), p(1, "two")), [[]], doc(p("onetwo")))
    })

    it("can wrap a node", () => {
      testApply(doc(0, p("one"), 2), [[o(blockquote())], [c]], doc(blockquote(p("one"))))
    })

    it("can unwrap a node", () => {
      testApply(doc(p("a"), 0, blockquote(1, p("b"), 2), 3), [[], []], doc(p("a"), p("b")))
    })

    it("can add marks", () => {
      testApply(doc(p("one ", 0, "two", 1, " three")), [{add: mEm}], doc(p("one ", em("two"), " three")))
    })

    it("can remove marks", () => {
      testApply(doc(p(em("one ", 0, "two", 1, " three"))), [{remove: mEm}], doc(p(em("one "), "two", em(" three"))))
    })

    it("can add multiple marks", () => {
      testApply(doc(p("one ", 0, 2, "two", 1, " three", 3)), [{add: mEm}, {add: mStrong}],
                doc(p("one ", strong(em("two"), " three"))))
    })

    it("can remove multiple marks", () => {
      testApply(doc(p(0, 2, em(strong("x")), 1, 3)), [{remove: mEm}, {remove: mStrong}], doc(p("x")))
    })

    it("only adds marks where appropriate", () => {
      testApply(doc(0, p("one"), 1), [{add: mStrong}], doc(p(strong("one"))))
    })

    it("can change attributes", () => {
      testApply(doc(p(0, img({src: "a.png"}), 1)), [{setAttr: "src", value: "b.jpg"}], doc(p(img({src: "b.jpg"}))))
    })
  })
})
