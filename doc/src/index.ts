export * from "./node"
export * from "./change"
export * from "./context"

import {Doc, Paragraph, TextNode, schema} from "./node"
import {CloseToken, OpenToken, ChangeSet} from "./change"

let doc = Doc.create(Paragraph.create("one"), Paragraph.create("two"))

let ch = new ChangeSet([2, -1, 0, 1, 4, -1, 0, 3, 4, -1], [null, [new TextNode("N")], null, [new CloseToken(Paragraph), new OpenToken(Paragraph.create()), new TextNode("-")], null])

console.log(ch.apply(schema, doc) + "")
