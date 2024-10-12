import {liftEmptyBlock} from "@willows/view"
import {DocNode, basicBuilders, tag, maybeTag} from "@willows/doc"
import {EditorState, StateCommand, EditorSelection} from "@willows/state"
import ist from "ist"

const {doc, p, blockquote} = basicBuilders

function eq<T extends {eq: (b: T) => boolean}>(a: T, b: T) { return a.eq(b) }

function selectionFrom(doc: DocNode) {
  let head = tag(doc, 0), anchor = maybeTag(doc, 1) ?? head
  return EditorSelection.range(anchor, head)
}

function test(doc: DocNode, command: StateCommand, expect?: DocNode) {
  let state = EditorState.create({
    doc,
    selection: selectionFrom(doc)
  })
  let result = command({state, dispatch: tr => state = tr.state})
  if (expect) {
    ist(result)
    ist(state.doc, expect, eq)
    if (maybeTag(expect, 0) != null) ist(state.selection, selectionFrom(expect), eq)
  } else {
    ist(!result)
  }
}

describe("liftEmptyBlock", () => {
  it("can lift a paragraph out of a quote", () => {
    test(doc(blockquote(p("hi", 0))), liftEmptyBlock, doc(p("hi")))
  })
})
