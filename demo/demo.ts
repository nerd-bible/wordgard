import {Wordgard, defaultKeymap, menuBar} from "wordgard/editor"
import {Doc, Paragraph, Blockquote, LineBreak} from "wordgard/schema-def"
import {allMarks, orderedList, bulletList, image, figure, imageResizing} from "wordgard/schema"
import {staticMenu} from "wordgard/menu"
import {history} from "wordgard/history"
import {tables, tableMenu} from "wordgard/table"

;(window as any).wg = new Wordgard({
  parent: document.body,
  doc: `<p><span style="color: red">Hell</span>o</p>
`,
  config: [
    Doc, Paragraph, Blockquote, LineBreak,
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
