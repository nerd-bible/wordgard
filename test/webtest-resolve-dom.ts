import {EditorView, ContentPos, Widget, PointSet, widgets} from "wordgard/view"
import {EditorState, type Extension} from "wordgard/state"
import {Plot} from "wordgard/doc"
import {basicBuilders} from "wordgard/schema"
import ist from "ist"

const {DocTile} = EditorView as any
const {doc, p, $img, hr} = basicBuilders

function render(doc: Plot.Doc, ...config: Extension[]) {
  return DocTile.create(EditorState.create({doc, config}), document.createElement("div"))
}

function isIn(pos: ContentPos, parent: string, offset: number) {
  ist(pos.dom.nodeValue || pos.dom.nodeName, parent)
  ist(pos.offset, offset)
}

describe("DocTile.resolve", () => {
  it("resolves into text nodes when biased", () => {
    let node = render(doc(p("one")))
    isIn(node.resolve(1, 1), "one", 0)
    isIn(node.resolve(1, 0), "P", 0)
    isIn(node.resolve(4, -1), "one", 3)
    isIn(node.resolve(4, 1), "P", 1)
  })

  it("resolves simple positions", () => {
    let node = render(doc(p("one", $img), hr))
    isIn(node.resolve(0), "DIV", 0)
    isIn(node.resolve(1, -1), "P", 0)
    isIn(node.resolve(1, 1), "one", 0)
    isIn(node.resolve(2), "one", 1)
    isIn(node.resolve(4, -1), "one", 3)
    isIn(node.resolve(4, 1), "P", 1)
    isIn(node.resolve(5), "P", 2)
    isIn(node.resolve(6, -1), "DIV", 1)
    isIn(node.resolve(6, 1), "DIV", 1)
    isIn(node.resolve(7, -1), "DIV", 2)
  })

  it("resolves properly between widgets", () => {
    function span(name: string) {
      let span = document.createElement("span")
      span.setAttribute("data-name", name)
      return span
    }

    let set = PointSet.create([
      [3, Widget.create({render: () => span("A"), side: -1})],
      [3, Widget.create({render: () => span("B"), side: 0})],
      [3, Widget.create({render: () => span("C"), side: 0})],
      [3, Widget.create({render: () => span("D"), side: 1})]
    ])
    let node = render(doc(p("abcd")), widgets.of(() => set))
    isIn(node.resolve(3, -1), "P", 2)
    isIn(node.resolve(3, 0), "P", 2)
    isIn(node.resolve(3, 1), "P", 4)
    isIn(node.resolve(4, 1), "cd", 1)
  })

})
