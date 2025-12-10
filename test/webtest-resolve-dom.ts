import {EditorView, ContentPos, Widget, PointSet, WidgetSource} from "../dist/view.js"
import {EditorState, type Extension} from "../dist/state.js"
import {DocNode, basicBuilders} from "../dist/doc.js"
import ist from "ist"

const {DocTile} = EditorView as any
const {doc, p, $img, hr} = basicBuilders

function render(doc: DocNode, ...config: Extension[]) {
  return DocTile.create(EditorState.create({doc, config}), document.createElement("div"))
}

function isIn(pos: ContentPos, parent: string, offset: number) {
  ist(pos.dom.nodeValue || pos.dom.nodeName, parent)
  ist(pos.offset, offset)
}

const testWidget = Widget.define<{name: string, side: number}>({
  render(value) {
    let span = document.createElement("span")
    span.setAttribute("data-name", value.name)
    return span
  },
})

describe("DocTile.resolve", () => {
  it("resolves into text nodes when biased", () => {
    let node = render(doc(p("one")))
    isIn(node.resolve(1, 1), "one", 0)
    isIn(node.resolve(1, 0), "P", 0)
    isIn(node.resolve(4, -1), "one", 3)
    isIn(node.resolve(4, 1), "P", 1)
  })

  it("resolves simple positions", () => {
    let node = render(doc(p("one", $img()), hr()))
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
    let set = PointSet.for<{name: string, side: number}>({side: v => v.side}).create([
      [3, {name: "A", side: -1}],
      [3, {name: "B", side: 0}],
      [3, {name: "C", side: 0}],
      [3, {name: "D", side: 1}]
    ])
    let node = render(doc(p("abcd")), new WidgetSource({
      set: () => set,
      widget: v => testWidget.of(v)
    }))
    isIn(node.resolve(3, -1), "P", 2)
    isIn(node.resolve(3, 0), "P", 2)
    isIn(node.resolve(3, 1), "P", 4)
    isIn(node.resolve(4, 1), "cd", 1)
  })

})
