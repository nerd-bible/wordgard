import {Wordgard, defaultKeymap, menuBar} from "wordgard/view"
import {basicSchema} from "wordgard/schema"
import {image, figure, imageResizing} from "wordgard/image"
import {orderedList, bulletList} from "wordgard/list"
import {staticMenu} from "wordgard/menu"
import {history} from "wordgard/history"
import {tables, tableMenu} from "wordgard/table"
import {allMarks} from "wordgard/mark"

;(window as any).view = new Wordgard({
  parent: document.body,
  doc: `<p><span style="color: red">Hell</span>o</p>
`,
  config: [
    basicSchema.elements,
    orderedList(), bulletList(),
    image(),
    figure({captioned: true}),
    imageResizing(),
    defaultKeymap,
    history(),
    staticMenu,
    menuBar(),
    tables(), tableMenu(),
    allMarks()
  ]
})
