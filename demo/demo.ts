import {Wordgard, defaultKeymap} from "wordgard/view"
import {basicSchema} from "wordgard/schema"
import {image, figure, imageResizing} from "wordgard/image"
import {menuBar, staticMenu} from "wordgard/menu"
import {history} from "wordgard/history"

;(window as any).view = new Wordgard({
  parent: document.body,
  doc: `<h3>Hello</h3>
<figure><img src=flower.jpg alt=Yellowflower><figcaption>A flower</figcaption></figure>
<p>I am Wordgard</p>`,
  config: [
    basicSchema.elements,
    image(),
    figure({captioned: true}),
    imageResizing(),
    defaultKeymap,
    history(),
    staticMenu,
    menuBar(),
  ]
})
