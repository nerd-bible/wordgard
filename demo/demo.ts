import {Wordgard, defaultKeymap} from "wordgard/view"
import {basicSchema} from "wordgard/schema"
import {image, figure, imageResizing} from "wordgard/image"
import {orderedList, bulletList} from "wordgard/list"
import {menuBar, staticMenu} from "wordgard/menu"
import {history} from "wordgard/history"
import {tables, tableMenu} from "wordgard/table"
import {strong, emphasis, underline, superscript, subscript, link, color} from "wordgard/mark"

;(window as any).view = new Wordgard({
  parent: document.body,
  doc: `<h3><span style="color: red">Hell</span>o</h3>
<figure><img src=flower.jpg alt=Yellowflower><figcaption>A flower</figcaption></figure>
<table>
  <tr><th>Col 1</th><th>Col 2</th></tr>
  <tr><td>Val 1</td><td>Val 2</td></tr>
  <tr><td>Val 3</td><td>Val 4</td></tr>
</table>
<p>I am Wordgard</p>`,
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
    strong(), emphasis(), underline(), superscript(), subscript(), link(), color()
  ]
})
