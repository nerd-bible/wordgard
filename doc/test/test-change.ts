import ist from "ist"
import {Node, DocNode, Mark, NodeType,
        ChangeSet, ChangeSpec, Token,
        Schema, basicSchema, basicBuilder, tag, maybeTag,
        Emphasis, Strong, Link} from "@willow/doc"
import {permute, open, close, slice, rDoc, rChange} from "./generate.js"
const {doc, p, blockquote, ol, ul, li, pre, h1, img, $img, em, strong} = basicBuilder

type ChangeData = (Token | string)[] | {add: Mark} | {remove: Mark} | {setAttr: string, value: any}

const mEm = Emphasis.create(), mStrong = Strong.create()

// Construct a change set starting from the given document, using
// pairs of tags (i*2, i*2+1 ?? i*2) as the extent of each change.
function mk(doc: DocNode, changes: readonly ChangeData[]) {
  return ChangeSet.create(doc, changes.map((ch, i): ChangeSpec => {
    let from = tag(doc, i * 2)
    if (from == null) throw new Error(`No start position defined for change ${i}`)
    let to = maybeTag(doc, i * 2 + 1) ?? from
    if (Array.isArray(ch)) return {from, to, insert: slice(...ch)}
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
      testApply(doc(p("one", 0, "two")), [[close, open(p())]], doc(p("one"), p("two")))
    })

    it("can join a node", () => {
      testApply(doc(p("one", 0), p(1, "two")), [[]], doc(p("onetwo")))
    })

    it("can wrap a node", () => {
      testApply(doc(0, p("one"), 2), [[open(blockquote())], [close]], doc(blockquote(p("one"))))
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

    it("complains on a mismatched length", () => {
      ist.throws(() => {
        mk(doc(p("12", 0, "34")), [["-"]]).apply(doc(p("123")))
      }, /past end/)
      ist.throws(() => {
        mk(doc(p("12", 0, "3")), [["-"]]).apply(doc(p("1234")))
      }, /doesn't cover/)
    })

    it("won't create empty block-child nodes", () => {
      ist.throws(() => {
        let d = doc(blockquote(0, p("a"), 1))
        mk(d, [[]]).apply(d)
      }, /Invalid change/)
      ist.throws(() => {
        mk(doc(0, p("a"), 1), [[]]).apply(doc(p("a")))
      }, /Invalid change/)
    })

    it("won't add children in invalid positions", () => {
      ist.throws(() => {
        let d = doc(blockquote(0, p("x")))
        mk(d, [[$img()]]).apply(d)
      }, /not a valid child/)
    })
  })

  describe("createChecked", () => {
    it("can handle overlapping conflicting changes", () => {
      let d = doc(p("abc"), p("def"))
      let ch = ChangeSet.createChecked(d, [
        {from: 0, insert: slice(open(blockquote()))},
        {from: 5, insert: slice(close)},
        {from: 4, to: 6}
      ])
      ist(ch.apply(d), doc(blockquote(p("abc"), p("def"))), eq)
    })

    it("inserts required nodes", () => {
      let d = doc(blockquote(pre("x")))
      ist(ChangeSet.createChecked(d, {from: 1, to: 4}).apply(d), doc(blockquote(p())), eq)
      ist(ChangeSet.createChecked(d, {from: 0, to: 5}).apply(d), doc(p()), eq)
    })

    it("adds wrapper nodes", () => {
      let d = doc(p())
      ist(ChangeSet.createChecked(d, {from: 0, insert: slice(li(p("a")))}).apply(d),
          doc(ul(li(p("a"))), p()), eq)
    })

    it("exits wrapper nodes when possible", () => {
      let Wrapper = NodeType.block("Wrapper", {content: "Inner Block", group: "Block", tag: "wrapper"})
      let Inner = NodeType.block("Inner", {tag: "inner"})
      let schema = Schema.define([basicSchema.nodes, Wrapper, Inner])
      let doc = schema.doc([p()]), ch = ChangeSet.createChecked(doc, {from: 0, insert: slice(Inner.create())})
      ist(ch.apply(doc), schema.doc([Wrapper.create([Inner.create()]), p()]), eq)
    })

    it("discards extra close tokens", () => {
      let d = doc(blockquote(p("a")))
      ist(ChangeSet.createChecked(d, {from: 4, insert: slice(close, close, close)}).apply(d), d, eq)
    })
  })

  describe("compose", () => {
    let d = doc(p("one ", em("two")), p("three"))
    let changes = {
      ins: ChangeSet.create(d, {from: 1, insert: slice("zero ")}),
      ins2: ChangeSet.create(d, {from: 5, insert: slice($img())}),
      del: ChangeSet.create(d, {from: 1, to: 4}),
      del2: ChangeSet.create(d, {from: 6, to: 7}),
      delP: ChangeSet.create(d, {from: 0, to: 9}),
      mark: ChangeSet.create(d, {from: 5, to: 15, addMark: mStrong}),
      unmark: ChangeSet.create(d, {from: 5, to: 8, removeMark: mEm}),
      join: ChangeSet.create(d, {from: 8, to: 10}),
      split: ChangeSet.create(d, {from: 4, to: 5, insert: slice(close, open(p()))}),
      wrap: ChangeSet.create(d, [{from: 0, insert: slice(open(ol()), open(li()))}, {from: 16, insert: slice(close, close)}])
    }

    function testCompose(set: (keyof typeof changes)[], expect: DocNode) {
      for (let order of permute(set)) {
        it(`correctly composes ${order.join("/")}`, () => {
          let ch = changes[order[0]]
          for (let i = 1; i < order.length; i++) ch = ch.compose(changes[order[i]].map(ch, d))
          ist(ch.apply(d), expect, eq)
        })
      }
    }

    testCompose(["ins", "ins2"], doc(p("zero one ", $img(), em("two")), p("three")))
    testCompose(["del", "ins"], doc(p("zero  ", em("two")), p("three")))
    testCompose(["del", "del2"], doc(p(" ", em("to")), p("three")))
    testCompose(["del", "delP"], doc(p("three")))
    testCompose(["ins", "delP"], doc(p("zero "), p("three")))
    testCompose(["ins", "mark"], doc(p("zero one ", strong(em("two"))), p(strong("three"))))
    testCompose(["del", "mark"], doc(p(" ", strong(em("two"))), p(strong("three"))))
    testCompose(["delP", "mark"], doc(p(strong("three"))))
    testCompose(["ins", "join"], doc(p("zero one ", em("two"), "three")))
    testCompose(["mark", "join"], doc(p("one ", strong(em("two"), "three"))))
    testCompose(["mark", "unmark"], doc(p("one ", strong("two")), p(strong("three"))))
    testCompose(["split", "join"], doc(p("one"), p(em("two"), "three")))
    testCompose(["ins", "split"], doc(p("zero one"), p(em("two")), p("three")))
    testCompose(["ins", "wrap"], doc(ol(li(p("zero one ", em("two")), p("three")))))
    testCompose(["join", "wrap"], doc(ol(li(p("one ", em("two"), "three")))))
    testCompose(["delP", "join"], doc(p("three")))
    testCompose(["join", "split", "wrap"], doc(ol(li(p("one"), p(em("two"), "three")))))
    testCompose(["join", "wrap"], doc(ol(li(p("one ", em("two"), "three")))))
    testCompose(["delP", "wrap"], doc(ol(li(p("three")))))
    testCompose(["join", "delP", "wrap"], doc(ol(li(p("three")))))

    it("keeps the effect of changes stable when composed", () => {
      for (let i = 0; i < 250; i++) {
        let doc = rDoc(20), startDoc = doc, changes: ChangeSet[] = []
        for (let j = 0; j < 5; j++) {
          let ch = rChange(doc, 2)
          doc = ch.apply(doc)
          changes.push(ch)
        }
        let composed = changes.reduce((a, b) => a.compose(b))
        try {
          ist(composed.apply(startDoc), doc, eq)
        } catch (e) {
          console.log(`Failed random compose test:\n  start doc: ${startDoc}\n  changes:\n    ${
                       changes.join("\n    ")}\n  composed: ${composed}`)
          throw e
        }
      }
    })

    it("can apply modifications to content inserted by earlier patches", () => {
      let d = doc(p("abcde"))
      let ch1 = ChangeSet.create(d, {from: 1, insert: slice("XY")})
      let d2 = ch1.apply(d)
      let ch2 = ChangeSet.create(d2, {from: 2, to: 5, addMark: mEm})
      let composed = ch1.compose(ch2)
      ist(ch2.apply(d2), composed.apply(d), eq)
    })

    it("can handle insertions in replaced content", () => {
      let d = doc(ol(0, li(p("a")), 1)), ch1 = mk(d, [[li(p())]])
      let d2 = ch1.apply(d), ch2 = ChangeSet.create(d2, [{from: 3, insert: slice("b")}])
      ist(ch1.compose(ch2).apply(d), ch2.apply(d2), eq)
    })

    it("is associative", () => {
      for (let i = 0; i < 250; i++) {
        let d0 = rDoc(20), c1 = rChange(d0, 3)
        let d1 = c1.apply(d0), c2 = rChange(d1, 3)
        let d2 = c2.apply(d1), c3 = rChange(d2, 3)
        let d3 = c3.apply(d2)
        try {
          ist(c1.compose(c2).compose(c3).apply(d0), d3, eq)
          ist(c1.compose(c2.compose(c3)).apply(d0), d3, eq)
        } catch(e) {
          console.log(`Failed random associativity test:\n  start doc: ${d0}\n  changes:\n    ${
                       [c1, c2, c3].join("\n    ")}`)
          throw e
        }
      }
    })
  })

  describe("map", () => {
    it("converges when mapping pairs of changes", () => {
      for (let i = 0; i < 250; i++) {
        let doc = rDoc(20), a = rChange(doc, 2), b = rChange(doc, 2)
        let docAB = b.map(a, doc).apply(a.apply(doc))
        let docBA = a.map(b, doc, true).apply(b.apply(doc))
        try {
          ist(docAB, docBA, eq)
        } catch(e) {
          console.log(`Failed random convergence test:\n  start doc: ${doc}\n  change a: ${a}\n  change b: ${b}`)
          throw e
        }
      }
    })

    it("converges when mapping triplets of changes", () => {
      for (let i = 0; i < 250; i++) {
        let doc = rDoc(20), changes = []
        for (let i = 0; i < 3; i++) changes.push(rChange(doc, 2))
        let clients = changes.map(ch => ({doc: ch.apply(doc), unconf: ch as ChangeSet | null, syncedDoc: doc}))
        try {
          for (let sender of clients) {
            let change = sender.unconf!
            for (let receiver of clients) {
              if (receiver == sender) {
                receiver.unconf = null
              } else if (receiver.unconf) {
                let {doc, unconf, syncedDoc} = receiver
                receiver.unconf = unconf.map(change, syncedDoc)
                receiver.doc = change.map(unconf, syncedDoc, true).apply(doc)
              } else {
                receiver.doc = change.apply(receiver.doc)
              }
              receiver.syncedDoc = change.apply(receiver.syncedDoc)
            }
          }
          for (let i = 0; i < 3; i++) {
            ist(clients[i].doc, clients[0].doc, eq)
            ist(clients[i].syncedDoc, clients[0].doc, eq)
          }
        } catch(e) {
          console.log(`Failed random triple-conflict test\n  doc:  ${doc}\n  changes:\n    ${changes.join("\n    ")}`)
          throw e
        }
      }
    })

    it("orders attr modifications correctly", () => {
      let d = doc(0, pre(1, "a"))
      let a = mk(d, [{setAttr: "language", value: "x"}]), b = mk(d, [{setAttr: "language", value: "y"}])
      let docAB = b.map(a, d).apply(a.apply(d))
      let docBA = a.map(b, d, true).apply(b.apply(d))
      ist(docAB, docBA, eq)
    })

    it("orders mark-adding modifications correctly", () => {
      let d = doc(p(0, "a", 1))
      let a = mk(d, [{add: Link.create({href: "x"})}]), b = mk(d, [{add: Link.create({href: "y"})}])
      let docAB = b.map(a, d).apply(a.apply(d))
      let docBA = a.map(b, d, true).apply(b.apply(d))
      ist(docAB, docBA, eq)
    })

    it("doesn't leak surplus opening nodes", () => {
      let d = doc(0, blockquote(1, p("x")), p("y")), ch = mk(d, [[open(blockquote())]])
      let ch2 = ch.map(ch, d) // Both delete the same opening token. Deletion collapsed, insertion preserved.
      ist(ch2.apply(ch.apply(d)), doc(blockquote(p("x")), p("y")), eq)
    })

    it("doesn't leak surplus closing nodes", () => {
      let d = doc(blockquote(p("x", 0), 1, p("y"))), ch = mk(d, [[close]])
      let ch2 = ch.map(ch, d) // Both delete the same closing token
      ist(ch2.apply(ch.apply(d)), doc(blockquote(p("x"), p("y"))), eq)
    })
  })
})
