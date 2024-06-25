export * from "./node"
export * from "./change"
export * from "./context"
export * from "./slice"
export * from "./builder"

import {Doc, Paragraph, Emphasis, Image, schema} from "./node"
import {ChangeSet} from "./change"
import {builder} from "./builder"

let {doc, p, em, img} = builder({doc: Doc, p: Paragraph, img: Image.create({src: "test.png"}), em: Emphasis})

let d = doc(p(em("one")), p("two", img()))

let ch = ChangeSet.create(d, [{from: 1, to: 2}, {from: 6, to: 7}])

console.log(ch.apply(schema, d) + "")
