import ist from "ist"
import {Node, Tag, builder, basicBuilders, Slice, Prop} from "@willows/doc"
import {EditorState} from "@willows/state"
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
    }).update({changes: {from: 1, insert: new Slice([Node.text("-")])}})
    ist(state.doc, doc(p("-!")), eq)
  })

  it("checks for tags not in the schema", () => {
    let Stranger = Tag.defineBlock("Stranger", {
      group: "Block",
      inlineContent: true,
      dom: {element: "div"}
    })
    ist.throws(() => EditorState.create({doc: doc(Stranger.create())}), /not in schema/)
    ist.throws(() => {
      EditorState.create({doc: doc(p())}).update({changes: {from: 0, insert: new Slice([Stranger.create()])}})
    }, /not in schema/)
  })

  it("checks for props not in the schema", () => {
    let Odd = Prop.define("Odd", {tags: "Block", dom: {attribute: "odd", value: "yes"}})
    let odd = builder(Odd)
    ist.throws(() => EditorState.create({doc: doc(odd(p()))}), /not in schema/)
    ist.throws(() => EditorState.create({doc: doc(p())}).update({changes: {from: 0, add: Odd}}), /not in schema/)
    ist.throws(() => EditorState.create({doc: doc(p())}).update({changes: {from: 0, insert: new Slice([odd(p())])}}),
               /not in schema/)
  })
})
