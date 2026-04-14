import {Wordgard, defaultKeymap} from "wordgard/view"
import {basicSchema, CaptionedFigure} from "wordgard/schema"
import {image} from "wordgard/image"
import {menuBar, staticMenu} from "wordgard/menu"
import {history} from "wordgard/history"

;(window as any).view = new Wordgard({
  parent: document.body,
  doc: `<h3>Hello</h3>
<figure><img src=flower.jpg><figcaption>A flower</figcaption></figure>
<p>I am Wordgard</p>`,
  config: [
    CaptionedFigure,
    basicSchema.elements,
    image({resize: true}),
    defaultKeymap,
    history(),
    staticMenu,
    menuBar(),
  ]
})
