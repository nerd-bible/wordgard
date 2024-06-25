export * from "./node"
export * from "./change"
export * from "./context"
export * from "./slice"

import {Doc, Paragraph, Emphasis, schema} from "./node"
import {ChangeSet} from "./change"

let doc = Doc.create(Paragraph.create("one"), Paragraph.create("two"))

let ch = ChangeSet.create(doc, [{from: 1, to: 2}, {from: 6, to: 7}])

console.log(ch.apply(schema, doc) + "")
