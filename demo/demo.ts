import {Wordgard, defaultKeymap, menuBar} from "wordgard/editor"
import {inlineSchema} from "wordgard/schema"
import {history} from "wordgard/history"
//import {tables, tableMenu} from "wordgard/table"

;(window as any).wg = new Wordgard({
  parent: document.body,
  doc: `<p><span style="color: red">Hell</span>o</p>
`,
  config: [
    inlineSchema(),
    defaultKeymap,
    history(),
    menuBar(),
//    tables(), tableMenu(),
  ]
})
