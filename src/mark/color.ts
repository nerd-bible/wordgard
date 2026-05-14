import {CustomControl, Submenu, icon} from "wordgard/menu"
import {PhraseSet, GardState, GardSelection, Direction, Facet} from "wordgard/state"
import {ChangeSet, Mark} from "wordgard/doc"
import {Color, BackgroundColor} from "wordgard/schema"
import {phrases} from "wordgard/phrases"
import {Wordgard} from "wordgard/view"
import {inlineStyleGroup} from "./mark"

function setColor(view: Wordgard, mark: Mark.Type<string>, value: string) {
  let {state} = view, {selection} = state
  if (selection instanceof GardSelection.Text && selection.empty) {
    let selMarks = selection.marks || state.sel.head.marks()
    let newMarks = value ? mark.of(value).addToSet(selMarks) : mark.removeFromSet(selMarks)
    view.dispatch({
      selection: GardSelection.Text.create({anchor: selection.anchor, headSide: selection.headSide,
                                            goalColumn: selection.goalColumn, marks: newMarks}),
      userEvent: value ? "mark.add" : "mark.remove"
    })
  } else if (value) {
    view.dispatch({
      changes: selection.ranges.map(r => ({from: r.from, to: r.to, add: mark.of(value)})),
      userEvent: "mark.add"
    })
  } else {
    let changes: ChangeSet.Spec[] = []
    for (let {from, to} of selection.ranges) {
      state.doc.iterate(from, to, (node, pos) => {
        let has = mark.isInSet(node.marks)
        if (has) changes.push({from: Math.max(from, pos), to: Math.min(to, pos + node.length), remove: has})
      })
    }
    view.dispatch({changes, userEvent: "mark.remove"})
  }
}

export class ColorPicker {
  dom: HTMLElement
  private width: number
  private selPos = 0
  private options: HTMLElement[]

  constructor(readonly view: Wordgard, readonly finish: (color: string) => void) {
    this.width = view.state.facet(ColorPicker.width)
    this.dom = document.createElement("wg-color-picker")
    this.dom.role = "listbox"
    this.dom.style.gridTemplateColumns = `repeat(${this.width}, max-content)`
    this.options = view.state.facet(ColorPicker.options).map(({name, detail, value}, i) => {
      let option = this.dom.appendChild(document.createElement("wg-color-picker-color"))
      let label = name(view.state)
      if (detail) label += ` (${detail(view.state)})`
      option.role = "option"
      option.setAttribute("aria-label", label)
      option.title = label
      if (i == this.selPos) option.setAttribute("aria-selected", "true")
      if (value) option.style.backgroundColor = value
      else option.className = "wg-no-color"
      option.setAttribute("data-value", value)
      return option
    })
    this.dom.addEventListener("mousedown", e => {
      if (e.button == 0) {
        let target = (e.target as HTMLElement).closest("wg-color-picker-color")
        if (target) this.finish(target.getAttribute("data-value")!)
      }
    })
    this.dom.addEventListener("keydown", e => {
      let ltr = this.view.state.textDirection() == Direction.LTR
      if (e.key == (ltr ? "ArrowLeft" : "ArrowRight") && this.selPos > 0) {
        this.move(this.selPos - 1)
      } else if (e.key == (ltr ? "ArrowRight" : "ArrowLeft") && this.selPos < this.options.length - 1) {
        this.move(this.selPos + 1)
      } else if (e.key == "ArrowUp" || e.key == "ArrowDown") {
        let next = e.key == "ArrowUp" ? this.selPos - this.width : this.selPos + this.width
        if (next < 0 || next >= this.options.length - 1) {
          let col = this.selPos % this.width
          if (next < 0) next = (Math.ceil(this.options.length / this.width) - 1) * this.width + col - 1
          else next = col + 1
        }
        this.move(Math.max(0, Math.min(this.options.length - 1, next)))
      } else if (e.key == " " || e.key == "Enter") {
        this.finish(this.options[this.selPos].getAttribute("data-value")!)
      } else {
        return
      }
      e.preventDefault()
    })
  }

  private move(selPos: number) {
    if (selPos != this.selPos) {
      let prev = this.options[this.selPos]
      let cur = this.options[this.selPos = selPos]
      prev.removeAttribute("aria-selected")
      cur.setAttribute("aria-selected", "true")
    }
  }
}

export namespace ColorPicker {
  export type Option = {name: PhraseSet.Ref, detail?: PhraseSet.Ref, value: string}

  export const colorNames = PhraseSet.define({
    none: "none",
    black: "black",
    white: "white",
    grey: "grey",
    red_berry: "red berry",
    red: "red",
    orange: "orange",
    yellow: "yellow",
    green: "green",
    cyan: "cyan",
    cornflower: "cornflower",
    blue: "blue",
    purple: "purple",
    magenta: "magenta",
    dark: "dark",
    darker: "darker",
    darkest: "very dark",
    light: "light",
    lighter: "lighter",
    lightest: "very light",
  })

  function col(rgb: string, name: PhraseSet.Tag<typeof colorNames>, mod?: -3 | -2 | -1 | 1 | 2 | 3) {
    let detail = mod == 3 ? colorNames.ref("lightest") : mod == 2 ? colorNames.ref("lighter") :
      mod == 1 ? colorNames.ref("light") : mod == -1 ? colorNames.ref("dark") :
      mod == -2 ? colorNames.ref("darker") : mod ? colorNames.ref("darkest") : undefined
    return {name: colorNames.ref(name), detail, value: rgb}
  }

  export function defaultColors(): readonly ColorPicker.Option[] {
    return [
      col("", "none"),
      col("#000000", "black"),
      col("#434343", "grey", -3),
      col("#666666", "grey", -2),
      col("#999999", "grey", -1),
      col("#cccccc", "grey"),
      col("#d9d9d9", "grey", 1),
      col("#efefef", "grey", 2),
      col("#f3f3f3", "grey", 3),
      col("#ffffff", "white"),

      col("#980000", "red_berry"),
      col("#ff0000", "red"),
      col("#ff9900", "orange"),
      col("#ffff00", "yellow"),
      col("#00ff00", "green"),
      col("#00ffff", "cyan"),
      col("#4a86e8", "cornflower"),
      col("#0000ff", "blue"),
      col("#9900ff", "purple"),
      col("#ff00ff", "magenta"),

      col("#e6b8af", "red_berry", 3),
      col("#f4cccc", "red", 3),
      col("#fce5cd", "orange", 3),
      col("#fff2cc", "yellow", 3),
      col("#d9ead3", "green", 3),
      col("#d0e0e3", "cyan", 3),
      col("#c9daf8", "cornflower", 3),
      col("#cfe2f3", "blue", 3),
      col("#d9d2e9", "purple", 3),
      col("#ead1dc", "magenta", 3),

      col("#dd7e6b", "red_berry", 2),
      col("#ea9999", "red", 2),
      col("#f9cb9c", "orange", 2),
      col("#ffe599", "yellow", 2),
      col("#b6d7a8", "green", 2),
      col("#a2c4c9", "cyan", 2),
      col("#a4c2f4", "cornflower", 2),
      col("#9fc5e8", "blue", 2),
      col("#b4a7d6", "purple", 2),
      col("#d5a6bd", "magenta", 2),

      col("#cc4125", "red_berry", 1),
      col("#e06666", "red", 1),
      col("#f6b26b", "orange", 1),
      col("#ffd966", "yellow", 1),
      col("#93c47d", "green", 1),
      col("#76a5af", "cyan", 1),
      col("#6d9eeb", "cornflower", 1),
      col("#6fa8dc", "blue", 1),
      col("#8e7cc3", "purple", 1),
      col("#c27ba0", "magenta", 1),

      col("#a61c00", "red_berry", -1),
      col("#cc0000", "red", -1),
      col("#e69138", "orange", -1),
      col("#f1c232", "yellow", -1),
      col("#6aa84f", "green", -1),
      col("#45818e", "cyan", -1),
      col("#3c78d8", "cornflower", -1),
      col("#3d85c6", "blue", -1),
      col("#674ea7", "purple", -1),
      col("#a64d79", "magenta", -1),

      col("#85200c", "red_berry", -2),
      col("#990000", "red", -2),
      col("#b45f06", "orange", -2),
      col("#bf9000", "yellow", -2),
      col("#38761d", "green", -2),
      col("#134f5c", "cyan", -2),
      col("#1155cc", "cornflower", -2),
      col("#0b5394", "blue", -2),
      col("#351c75", "purple", -2),
      col("#741b47", "magenta", -2),

      col("#5b0f00", "red_berry", -3),
      col("#660000", "red", -3),
      col("#783f04", "orange", -3),
      col("#7f6000", "yellow", -3),
      col("#274e13", "green", -3),
      col("#0c343d", "cyan", -3),
      col("#1c4587", "cornflower", -3),
      col("#073763", "blue", -3),
      col("#20124d", "purple", -3),
      col("#4c1130", "magenta", -3),
    ]
  }

  export const width = Facet.define<number, number>({
    combine: values => values.length ? values[0] : 10
  })

  export const options = Facet.define<readonly ColorPicker.Option[], readonly ColorPicker.Option[]>({
    combine: values => values.length ? values[0] : ColorPicker.defaultColors()
  })
}

function crossGradient(angle: number) {
  return `linear-gradient(${angle}deg, transparent, transparent 44%, currentColor 44%, currentColor 56%, transparent 56%)`
}

const colorPickerTheme = Wordgard.baseTheme({
  "wg-color-picker": {
    display: "grid",
    gap: "4px",
    padding: "3px",
  },
  "wg-color-picker-color": {
    borderRadius: "50%",
    border: "1px solid var(--wg-border-color)",
    width: "12px",
    height: "12px",
    "wg-color-picker:focus &[aria-selected], &:hover": {
      outline: "2px solid var(--wg-highlight-color)"
    },
    "&.wg-no-color": {
      border: "none",
      background: `${crossGradient(45)}, ${crossGradient(135)}`
    }
  },
})


export const colorPicker = new CustomControl({
  render(view, done) {
    return new ColorPicker(view, color => {
      done()
      setColor(view, Color, color)
      view.focus()
    })
  }
})

export function color(): GardState.Extension {
  return [Color, color.button, colorPickerTheme, inlineStyleGroup]
}

export namespace color {
  export const button = new Submenu({
    label: icon.Color,
    description: phrases.ref("text_color"),
    arrow: false,
    parent: inlineStyleGroup,
    rank: 60,
    content: [colorPicker]
  })
}

export function backgroundColor() {
  return [BackgroundColor, backgroundColor.button, colorPickerTheme, inlineStyleGroup]
}

const backgroundPicker = new CustomControl({
  render(view, done) {
    return new ColorPicker(view, color => {
      done()
      setColor(view, BackgroundColor, color)
      view.focus()
    })
  }
})

export namespace backgroundColor {
  export const button = new Submenu({
    label: icon.Marker,
    description: phrases.ref("background_color"),
    arrow: false,
    parent: inlineStyleGroup,
    rank: 65,
    content: [backgroundPicker]
  })
}
