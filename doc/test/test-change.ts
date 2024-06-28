import ist from "ist"
import {Node, ChangeSet, ChangeSpec, Mark,
        basicSchema, basicBuilder, tag, maybeTag,
        Slice, Token, OpenToken, CloseToken} from "@willow/doc"
const {p, doc} = basicBuilder

type ChangeData = (Token | string)[] | {add: Mark} | {remove: Mark} | {setAttr: string, value: any}

function o(node: Node) { return new OpenToken(node) }
const c = CloseToken

// Construct a change set starting from the given document, using
// pairs of tags (i*2, i*2+1 ?? i*2) as the extent of each change.
function mk(doc: Node, changes: readonly ChangeData[]) {
  return ChangeSet.create(doc, basicSchema, changes.map((ch, i): ChangeSpec => {
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
    function testApply(doc: Node, changes: ChangeData[], expect: Node) {
      ist(mk(doc, changes).apply(basicSchema, doc), expect, eq)
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
  })
})
