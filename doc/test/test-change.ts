import ist from "ist"
import {Node, DocNode, Tag, Prop,
        ChangeSet, ChangeSpec, Token,
        Schema, basicSchema, basicBuilder, tag, maybeTag,
        ImageAlt, CodeBlockLanguage, Emphasis, Strong, Link} from "@willows/doc"
import {permute, open, close, slice, rDoc, rChange} from "./generate.js"
const {doc, p, h1, blockquote, ol, ul, li, pre, preLang, img, imgAlt, $img, a, em, strong} = basicBuilder

type ChangeData = (Token | string)[] | {add: Prop<any>} | {remove: Prop<any>}

// Construct a change set starting from the given document, using
// pairs of tags (i*2, i*2+1 ?? i*2) as the extent of each change.
function mk(doc: DocNode, changes: readonly ChangeData[]) {
  return ChangeSet.create(doc, changes.map((ch, i): ChangeSpec => {
    let from = tag(doc, i * 2)
    if (from == null) throw new Error(`No start position defined for change ${i}`)
    let to = maybeTag(doc, i * 2 + 1) ?? from
    if (Array.isArray(ch)) return {from, to, insert: slice(...ch)}
    let {add, remove} = ch as {add?: Prop, remove?: Prop}
    return add ? {from, to, add: add} : {from, to, remove: remove}
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

    it("can add props", () => {
      testApply(doc(p("one ", 0, "two", 1, " three")), [{add: Emphasis}], doc(p("one ", em("two"), " three")))
    })

    it("joins marked text when appropriate", () => {
      testApply(doc(p(em("one"), 0, "two", 1)), [{add: Emphasis}], doc(p(em("onetwo"))))
    })

    it("can remove props", () => {
      testApply(doc(p(em("one ", 0, "two", 1, " three"))), [{remove: Emphasis}], doc(p(em("one "), "two", em(" three"))))
    })

    it("can add multiple props", () => {
      testApply(doc(p("one ", 0, 2, "two", 1, " three", 3)), [{add: Emphasis}, {add: Strong}],
                doc(p("one ", strong(em("two"), " three"))))
    })

    it("can remove multiple props", () => {
      testApply(doc(p(0, 2, em(strong("x")), 1, 3)), [{remove: Emphasis}, {remove: Strong}], doc(p("x")))
    })

    it("only adds props where appropriate", () => {
      testApply(doc(0, p("one"), 1), [{add: Strong}], doc(p(strong("one"))))
    })

    it("can change node props", () => {
      testApply(doc(p(0, imgAlt("A", img("a.png")), 1)), [{add: ImageAlt.of("B")}], doc(p(imgAlt("B", img("a.png")))))
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

  describe("fit", () => {
    it("can handle overlapping conflicting changes", () => {
      let d = doc(p("abc"), p("def"))
      let ch = ChangeSet.create(d, [
        {from: 0, insert: slice(open(blockquote())), fit: true},
        {from: 5, insert: slice(close), fit: true},
        {from: 4, to: 6}
      ])
      ist(ch.apply(d), doc(blockquote(p("abc")), p("def")), eq)
    })

    it("inserts required nodes", () => {
      let d = doc(blockquote(pre("x")))
      ist(ChangeSet.create(d, {from: 1, to: 4, fit: true}).apply(d), doc(p()), eq)
      ist(ChangeSet.create(d, {from: 0, to: 5, fit: true}).apply(d), doc(p()), eq)
    })

    it("adds wrapper nodes", () => {
      let d = doc(p())
      ist(ChangeSet.create(d, {from: 0, insert: slice(li(p("a"))), fit: true}).apply(d),
          doc(ul(li(p("a"))), p()), eq)
    })

    it("exits wrapper nodes when possible", () => {
      let Wrapper = Tag.defineBlock("Wrapper", {blockContent: "Inner Block", group: "Block", dom: {element: "wrapper"}})
      let Inner = Tag.defineBlock("Inner", {dom: {element: "inner"}})
      let schema = Schema.define([...basicSchema.tags, Wrapper, Inner])
      let doc = schema.doc([p()]), ch = ChangeSet.create(doc, {from: 0, insert: slice(Inner.create()), fit: true})
      ist(ch.apply(doc), schema.doc([Wrapper.create([Inner.create()]), p()]), eq)
    })

    it("discards extra close tokens", () => {
      let d = doc(blockquote(p("a")))
      ist(ChangeSet.create(d, {from: 4, insert: slice(close, close, close), fit: true}).apply(d), d, eq)
    })

    it("can chance the depth of existing content", () => {
      let d = doc(p("abc"))
      ist(ChangeSet.create(d, {from: 1, insert: slice("x", close, open(blockquote()), open(p())), fit: true}).apply(d),
          doc(p("x"), blockquote(p("abc"))), eq)
    })

    it("uses slice context for fitting", () => {
      let d = doc(p("a"))
      let src = doc(h1("hello"))
      ist(ChangeSet.create(d, {from: 3, insert: src.slice(1, 5), fit: src.contextAt(1)}).apply(d),
          doc(p("a"), h1("hell")), eq)
    })

    it("preserves the type of partially-deleted nodes", () => {
      let d = doc(p("one"), h1("two"))
      ist(ChangeSet.create(d, {from: 0, to: 7, fit: true}).apply(d),
          doc(h1("wo")), eq)
    })

    it("expands deletions to cover opening tokens", () => {
      let d = doc(h1("one"), p("two"))
      ist(ChangeSet.create(d, {from: 1, to: 7, fit: true}).apply(d),
          doc(p("wo")), eq)
    })

    it("expands deletions to cover multiple opening tokens", () => {
      let d = doc(blockquote(h1("one")), p("two"))
      ist(ChangeSet.create(d, {from: 2, to: 9, fit: true}).apply(d),
          doc(p("wo")), eq)
    })

    it("expands deletions covering an entire block-content node", () => {
      let d = doc(blockquote(p("one"), p("two")))
      ist(ChangeSet.create(d, {from: 2, to: 10, fit: true}).apply(d),
          doc(p()), eq)
    })

    it("expands deletions asymetrically covering an entire block-content node", () => {
      let d = doc(blockquote(p("one"), p("two")))
      ist(ChangeSet.create(d, {from: 1, to: 10, fit: true}).apply(d),
          doc(p()), eq)
      ist(ChangeSet.create(d, {from: 2, to: 11, fit: true}).apply(d),
          doc(p()), eq)
    })

    it("doesn't expand deletions covering a full textblock", () => {
      let d = doc(blockquote(p("one")))
      ist(ChangeSet.create(d, {from: 2, to: 5, fit: true}).apply(d),
          doc(blockquote(p())), eq)
    })

    it("expands replacements to use defining context", () => {
      let d = doc(p("..."))
      let src = doc(ul(li(p("one")), li(p("two"))))
      ist(ChangeSet.create(d, {from: 1, insert: src.slice(3, 13), fit: src.contextAt(3)}).apply(d),
          doc(ul(li(p("one")), li(p("two...")))), eq)
    })

    it("doesn't expand when pasting inline content only", () => {
      let d = doc(p("hi"))
      let src = doc(h1("!"))
      ist(ChangeSet.create(d, {from: 1, insert: src.slice(1, 2), fit: src.contextAt(1)}).apply(d),
          doc(p("!hi")), eq)
    })

    it("properly closes fitted nodes", () => {
      let d = doc(p("a"), p("b"))
      let src = doc(ul(li(p("c"))))
      ist(ChangeSet.create(d, {from: 1, to: 2, insert: src.slice(2, 4), fit: src.contextAt(2)}).apply(d),
          doc(ul(li(p("c"))), p("b")), eq)
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
      mark: ChangeSet.create(d, {from: 5, to: 15, add: Strong}),
      unmark: ChangeSet.create(d, {from: 5, to: 8, remove: Emphasis}),
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
      let ch2 = ChangeSet.create(d2, {from: 2, to: 5, add: Emphasis})
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
        let doc = rDoc(10), a = rChange(doc, 2), b = rChange(doc, 2)
        try {
          let docAB = b.map(a, doc).apply(a.apply(doc))
          let docBA = a.map(b, doc, true).apply(b.apply(doc))
          ist(docAB, docBA, eq)
        } catch(e) {
          console.log(`Failed random convergence test:\n  start doc: ${doc}\n  change a: ${a}\n  change b: ${b}`)
          throw e
        }
      }
    })

    function runTriplet(doc: DocNode, changes: [ChangeSet, ChangeSet, ChangeSet]) {
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

    it("converges when mapping triplets of changes", () => {
      for (let i = 0; i < 250; i++) {
        let doc = rDoc(20)
        runTriplet(doc, [rChange(doc, 2), rChange(doc, 2), rChange(doc, 2)])
      }
    })

    it("orders local prop modifications correctly", () => {
      let d = doc(0, pre(1, "a"))
      let a = mk(d, [{add: CodeBlockLanguage.of("x")}])
      let b = mk(d, [{add: CodeBlockLanguage.of("y")}])
      let docAB = b.map(a, d).apply(a.apply(d))
      let docBA = a.map(b, d, true).apply(b.apply(d))
      ist(docAB, docBA, eq)
    })

    it("orders prop-adding modifications correctly", () => {
      let d = doc(p(0, "a", 1))
      let a = mk(d, [{add: Link.of("x")}]), b = mk(d, [{add: Link.of("y")}])
      let docAB = b.map(a, d).apply(a.apply(d))
      let docBA = a.map(b, d, true).apply(b.apply(d))
      ist(docAB, docBA, eq)
    })

    it("handles overwritten open tokens", () => {
      let d = doc(p("x"), p("y"))
      let ch1 = ChangeSet.create(d, {from: 0, to: 1, insert: slice(open(h1()))})
      let ch2 = ChangeSet.create(d, {from: 0, to: 1, insert: slice(open(pre()))}).map(ch1, d)
      ist(ch2.apply(ch1.apply(d)), doc(h1("x"), p("y")), eq)
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

  describe("invert", () => {
    function testInv(doc: DocNode, changes: ChangeData[]) {
      let ch = mk(doc, changes)
      let changed = ch.apply(doc), reverted = ch.invert(doc).apply(changed)
      ist(reverted, doc, eq)
    }

    it("can invert insertions", () => {
      testInv(doc(p("a", 0, "b"), 2, p("c")), [["x"], [p("y")]])
    })

    it("can invert deletions", () => {
      testInv(doc(p("a", 0, "x", 1, "b"), 2, p("y"), 3, p("c")), [[], []])
    })

    it("can invert replacements", () => {
      testInv(doc(p("a", 0), p(1, "b")), [["x"]])
    })

    it("can invert adding a prop", () => {
      testInv(doc(p(0, "abc", 1, " ", 2, "def", 3)), [{add: Emphasis}, {add: Link.of("/")}])
    })

    it("can invert removing a prop", () => {
      testInv(doc(p(0, em("abc"), 1)), [{remove: Emphasis}])
    })

    it("can invert replacing a prop with another version", () => {
      testInv(doc(p(0, a("1", "abc"), 1)), [{add: Link.of("2")}])
    })

    it("can invert changing a prop", () => {
      testInv(doc(0, preLang("js", pre("null"))), [{add: CodeBlockLanguage.of("c++")}])
    })

    it("can invert sequences of random changes", () => {
      for (let i = 0; i < 250; i++) {
        let startDoc = rDoc(25)
        let doc = startDoc, changes: ChangeSet[] = [], inverted: ChangeSet[] = []
        for (let i = 0; i < 10; i++) {
          let change = rChange(doc, 2)
          changes.push(change)
          inverted.push(change.invert(doc))
          doc = change.apply(doc)
        }
        try {
          for (let i = inverted.length - 1; i >= 0; i--)
            doc = inverted[i].apply(doc)
          ist(doc, startDoc, eq)
        } catch(e) {
          console.log(`Failed random invert test:\n  start doc: ${startDoc}\n  changes:\n    ${
                       changes.join("\n    ")}\n  inverted:\n    ${inverted.join("\n    ")}`)
          throw e
        }
      }
    })
  })
})
