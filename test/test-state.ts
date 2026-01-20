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

  it("checks for tags not in the schema", () => {
    let Stranger = Plot.defineBlock("Stranger", {
      group: "Block",
      inlineContent: true,
      shape: {element: "div"}
    })
    ist.throws(() => EditorState.create({doc: doc(Stranger.create())}), /not in schema/)
    ist.throws(() => {
      EditorState.create({doc: doc(p())}).update({changes: {from: 0, insert: [Stranger.create()]}})
    }, /not in schema/)
  })

  it("checks for marks not in the schema", () => {
    let Odd = Mark.define("Odd", {tags: "Block", shape: {attribute: "odd", value: "yes"}})
    let odd = builder(Odd)
    ist.throws(() => EditorState.create({doc: doc(odd(p()))}), /not in schema/)
    ist.throws(() => EditorState.create({doc: doc(p())}).update({changes: {from: 0, add: Odd}}), /not in schema/)
    ist.throws(() => EditorState.create({doc: doc(p())}).update({changes: {from: 0, insert: [odd(p())]}}),
               /not in schema/)
  })
})
