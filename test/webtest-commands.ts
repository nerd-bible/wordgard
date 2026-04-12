import {Wordgard} from "wordgard/view"
import {Command, deleteLine} from "wordgard/command"
import {GardState} from "wordgard/state"
import {Plot} from "wordgard/doc"
import {basicBuilders, maybeTag} from "wordgard/schema"
import ist from "ist"
import {tempView} from "./tempview.ts"

const {doc, p} = basicBuilders

function eq<T extends {eq: (b: T) => boolean}>(a: T, b: T) { return a.eq(b) }

function test1<T>(doc: Plot.Doc, cmd: Command<T>, arg: T, expect: Plot.Doc | null, config: GardState.Extension = []) {
  let view = tempView(doc, config)
  let result = cmd(view, arg)
  ist(result, expect != null)
  if (expect) {
    ist(view.state.doc, expect, eq)
    if (maybeTag(expect, 0) != null)
      ist(view.state.selection.head, maybeTag(expect, 0))
  }
}

function test(doc: Plot.Doc, cmd: Command<null>, expect: Plot.Doc | null, config: GardState.Extension = []) {
  test1(doc, cmd, null, expect, config)
}

const narrow = Wordgard.theme({"&": {width: "10ex"}})

describe("deleteLine", () => {
  it("clears an entire paragraph", () => {
    test(doc(p("foo", 0), p("bar")), deleteLine, doc(p(0), p("bar")))
  })

  it("doesn't clear past wrap points", () => {
    test(doc(p("bigwordone bigword", 0, "two bigwordthree")), deleteLine, doc(p("bigwordone ", 0, " bigwordthree")), narrow)
  })
})
