import {Wordgard, defaultKeymap, NodeSelection} from "wordgard/view"
import {basicSchema} from "wordgard/schema"
import {imageTheme, dragHandle, ImageSize, resizeImageKeymap} from "wordgard/schema/image"
import {menuBar, staticMenu} from "wordgard/menu"
import {history} from "wordgard/history"

;(window as any).view = new Wordgard({
  parent: document.body,
  doc: "<h3>Hello <img src='data:image/gif;base64,R0lGODlhHgAeAKEBAAAAAPX/APX/APX/ACH5BAEKAAIALAAAAAAeAB4AAAJalI+pyxoPQ5si2kjR3Zjy/0zgyIymY55aSh4fAEcwwLncLMebAeKQv+vpHsBL5TUMFC3HW3KJYUmbUlI1Rb3WstoOtxuygSGJsVcMLqUb3cw1g/7AF7u5nVIAADs='></h3><hr><hr><p>I am Wordgard</p>",
  config: [
    basicSchema.elements,
    imageTheme,
    defaultKeymap,
    history(),
    staticMenu,
    menuBar(),
    dragHandle,
    ImageSize,
    resizeImageKeymap,
    NodeSelection
  ]
})
