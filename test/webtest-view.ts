import {basicBuilders} from "wordgard/schema"
import ist from "ist"
import {tempView} from "./tempview.ts"

const {doc, p} = basicBuilders

describe("Wordgard", () => {
  // FIXME pull in CM plugin tests
  
  it("repairs changes to text nodes", () => {
    let cm = tempView(doc(p("abc")))
    cm.contentDOM.firstChild!.firstChild!.nodeValue = "a"
    cm.flush()
    ist(cm.contentDOM.innerHTML, "<p>abc</p>")
  })

  it("repairs modified attributes", () => {
    let cm = tempView(doc(p("abc")))
    ;(cm.contentDOM.firstChild as HTMLElement).setAttribute("test", "test")
    cm.flush()
    ist(cm.contentDOM.innerHTML, "<p>abc</p>")
  })
})
