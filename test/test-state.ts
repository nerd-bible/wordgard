import ist from "ist"
import {Leaf} from "wordgard/doc"
import {GardState} from "wordgard/state"
import {basicBuilders} from "./schema.ts"
const {doc, p} = basicBuilders

function eq<T extends {eq: (other: T) => boolean}>(a: T, b: T) { return a.eq(b) }

describe("EditorState", () => {
  it("can be initialized", () => {
    let state = GardState.create({
      doc: doc(p("!")),
      selection: {anchor: 2}
    })
    ist(state.doc.length, 3)
    ist(state.selection.from, 2)
  })

  it("can be updated", () => {
    let {state} = GardState.create({
      doc: doc(p("!"))
    }).update({changes: {from: 1, insert: [Leaf.text("-")]}})
    ist(state.doc, doc(p("-!")), eq)
  })

  // FIXME transaction creation and combining tests
})

