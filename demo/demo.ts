import {Wordgard, defaultKeymap, menuBar} from "wordgard/editor"
import {fullSchema} from "wordgard/schema"
import {history} from "wordgard/history"
import {tables, tableMenu} from "wordgard/table"

;(window as any).wg = Wordgard.create({
  parent: document.body,
  doc: `<p>a</p><table><tr><td>A</td><td>B</td></tr><tr><td>X</td><td>Y</td></tr></table>
`,
  config: [
    fullSchema(),
    defaultKeymap,
    history(),
    menuBar(),
    tables(), tableMenu(),
/*    Wordgard.beforeUpdate.of(u => {
      for (let tr of u.transactions) console.log("=> " + tr.newDoc, tr.selection? [tr.selection.head, tr.selection.anchor, tr.selection.constructor.name] : null)
    })*/
  ]
})
