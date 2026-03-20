import ist from "ist"
import {Plot, Leaf, Mark} from "wordgard/doc"
import {builder, basicBuilders} from "wordgard/schema"
import {EditorState} from "wordgard/state"
const {doc, p} = basicBuilders

function eq<T extends {eq: (other: T) => boolean}>(a: T, b: T) { return a.eq(b) }

describe("EditorState", () => {
  it("can be initialized", () => {
    let state = EditorState.create({
      doc: doc(p("!")),
      selection: {anchor: 2}
    })
    ist(state.doc.length, 3)
    ist(state.selection.from, 2)
  })

  it("can be updated", () => {
    let {state} = EditorState.create({
      doc: doc(p("!"))
    }).update({changes: {from: 1, insert: [Leaf.text("-")]}})
    ist(state.doc, doc(p("-!")), eq)
  })
})
