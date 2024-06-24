export * from "./node"
export * from "./change"
export * from "./context"

import {Doc, Paragraph, Emphasis, Node, schema} from "./node"
import {CloseToken, OpenToken, ChangeSet, Slice} from "./change"

let doc = Doc.create(Paragraph.create("one"), Paragraph.create("two"))

let ch = new ChangeSet([1, -1, 1, -1, 0, 1, 4, -1, 0, 3, 4, -1], [
  null,
  [{type: "addMark", mark: Emphasis.create()}],
  new Slice([Node.text("N")]),
  null,
  new Slice([CloseToken, new OpenToken(Paragraph.create()), Node.text("-")]),
  null]
)

console.log(ch.apply(schema, doc) + "")
