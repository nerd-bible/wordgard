import {Wordgard, defaultKeymap} from "wordgard/view"
import {basicSchema} from "wordgard/schema"
import {image, figure, imageResizing, imageUploader} from "wordgard/image"
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
    imageUploader.of((file, _, update) => {
      setTimeout(() => update(10), 500)
      setTimeout(() => update(20), 1000)
      setTimeout(() => update(30), 1500)
      setTimeout(() => update(40), 2000)
      return new Promise((a, r) => {
        let reader = new FileReader
        reader.onload = () => {
          setTimeout(() => {
            a(reader.result as string)
          }, 1119500)
        }
        reader.onerror = e => r(e)
        reader.readAsDataURL(file)
      })
    })
  ]
})
