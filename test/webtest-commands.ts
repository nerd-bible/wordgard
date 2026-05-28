import {Wordgard} from "wordgard/editor"
import {Command, deleteLine} from "wordgard/command"
import {GardState} from "wordgard/state"
import {Plot} from "wordgard/doc"
import ist from "ist"
import {tempEditor} from "./tempview.ts"
import {basicBuilders, maybeTag, eq} from "./schema.ts"
const {doc, p} = basicBuilders

function test1<T>(doc: Plot.Doc, cmd: Command<T>, arg: T, expect: Plot.Doc | null, config: GardState.Extension = []) {
  let wg = tempEditor(doc, config)
  let result = Command.dispatch(wg, cmd, arg)
  ist(result, expect != null)
  if (expect) {
    ist(wg.state.doc, expect, eq)
    if (maybeTag(expect, 0) != null)
      ist(wg.state.selection.head, maybeTag(expect, 0))
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
