import {CustomControl, Submenu, icon} from "wordgard/menu"
import {PhraseSet, GardState, GardSelection, Direction} from "wordgard/state"
import {ChangeSet} from "wordgard/doc"
import {Color} from "wordgard/schema"
import {phrases} from "wordgard/phrases"
import {Wordgard} from "wordgard/view"
import {inlineStyleMenu} from "./mark"

export function color(): GardState.Extension {
  return [Color, color.button, color.picker, colorPickerTheme, inlineStyleMenu]
}

function setColor(view: Wordgard, color: string) {
  let {state} = view, {selection} = state
  if (selection instanceof GardSelection.Text && selection.empty) {
    let selMarks = selection.marks || state.sel.head.marks()
    let newMarks = color ? Color.of(color).addToSet(selMarks) : Color.removeFromSet(selMarks)
    view.dispatch({
      selection: GardSelection.Text.create({anchor: selection.anchor, headSide: selection.headSide,
                                            goalColumn: selection.goalColumn, marks: newMarks}),
      userEvent: color ? "mark.add" : "mark.remove"
    })
  } else if (color) {
    view.dispatch({
      changes: selection.ranges.map(r => ({from: r.from, to: r.to, add: Color.of(color)})),
      userEvent: "mark.add"
    })
  } else {
    let changes: ChangeSet.Spec[] = []
    for (let {from, to} of selection.ranges) {
      state.doc.iterate(from, to, (node, pos) => {
        let has = Color.isInSet(node.marks)
        if (has) changes.push({from: Math.max(from, pos), to: Math.min(to, pos + node.length), remove: has})
      })
    }
    view.dispatch({changes, userEvent: "mark.remove"})
  }
}

class ColorPicker {
  dom: HTMLElement
  width: number
  selPos = 0
  options: HTMLElement[]
  finish: (color: string) => void

  constructor(readonly view: Wordgard, config: {
    options: readonly {name: PhraseSet.Ref, detail?: PhraseSet.Ref, value: string}[],
    width?: number
    finish: (color: string) => void
  }) {
    this.finish = config.finish
    this.width = config.width ?? 10
    this.dom = document.createElement("wg-color-picker")
    this.dom.role = "listbox"
    this.dom.style.gridTemplateColumns = `repeat(${this.width}, max-content)`
    this.options = config.options.map(({name, detail, value}, i) => {
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

  move(selPos: number) {
    if (selPos != this.selPos) {
      let prev = this.options[this.selPos]
      let cur = this.options[this.selPos = selPos]
      prev.removeAttribute("aria-selected")
      cur.setAttribute("aria-selected", "true")
    }
  }
}

function col(rgb: string, name: PhraseSet.Tag<typeof phrases>, mod?: -3 | -2 | -1 | 1 | 2 | 3) {
  let detail = mod == 3 ? phrases.ref("col_lightest") : mod == 2 ? phrases.ref("col_lighter") :
    mod == 1 ? phrases.ref("col_light") : mod == -1 ? phrases.ref("col_dark") :
    mod == -2 ? phrases.ref("col_darker") : mod ? phrases.ref("col_darkest") : undefined
  return {name: phrases.ref(name), detail, value: rgb}
}
// FIXME make configurable
// FIXME prune down?
const colorOptions: {name: PhraseSet.Ref, detail?: PhraseSet.Ref, value: string}[] = [
  col("", "col_none"),
  col("#000000", "col_black"),
  col("#434343", "col_grey", -3),
  col("#666666", "col_grey", -2),
  col("#999999", "col_grey", -1),
  col("#cccccc", "col_grey"),
  col("#d9d9d9", "col_grey", 1),
  col("#efefef", "col_grey", 2),
  col("#f3f3f3", "col_grey", 3),
  col("#ffffff", "col_white"),

  col("#980000", "col_red_berry"),
  col("#ff0000", "col_red"),
  col("#ff9900", "col_orange"),
  col("#ffff00", "col_yellow"),
  col("#00ff00", "col_green"),
  col("#00ffff", "col_cyan"),
  col("#4a86e8", "col_cornflower"),
  col("#0000ff", "col_blue"),
  col("#9900ff", "col_purple"),
  col("#ff00ff", "col_magenta"),

  col("#e6b8af", "col_red_berry", 3),
  col("#f4cccc", "col_red", 3),
  col("#fce5cd", "col_orange", 3),
  col("#fff2cc", "col_yellow", 3),
  col("#d9ead3", "col_green", 3),
  col("#d0e0e3", "col_cyan", 3),
  col("#c9daf8", "col_cornflower", 3),
  col("#cfe2f3", "col_blue", 3),
  col("#d9d2e9", "col_purple", 3),
  col("#ead1dc", "col_magenta", 3),

  col("#dd7e6b", "col_red_berry", 2),
  col("#ea9999", "col_red", 2),
  col("#f9cb9c", "col_orange", 2),
  col("#ffe599", "col_yellow", 2),
  col("#b6d7a8", "col_green", 2),
  col("#a2c4c9", "col_cyan", 2),
  col("#a4c2f4", "col_cornflower", 2),
  col("#9fc5e8", "col_blue", 2),
  col("#b4a7d6", "col_purple", 2),
  col("#d5a6bd", "col_magenta", 2),

  col("#cc4125", "col_red_berry", 1),
  col("#e06666", "col_red", 1),
  col("#f6b26b", "col_orange", 1),
  col("#ffd966", "col_yellow", 1),
  col("#93c47d", "col_green", 1),
  col("#76a5af", "col_cyan", 1),
  col("#6d9eeb", "col_cornflower", 1),
  col("#6fa8dc", "col_blue", 1),
  col("#8e7cc3", "col_purple", 1),
  col("#c27ba0", "col_magenta", 1),

  col("#a61c00", "col_red_berry", -1),
  col("#cc0000", "col_red", -1),
  col("#e69138", "col_orange", -1),
  col("#f1c232", "col_yellow", -1),
  col("#6aa84f", "col_green", -1),
  col("#45818e", "col_cyan", -1),
  col("#3c78d8", "col_cornflower", -1),
  col("#3d85c6", "col_blue", -1),
  col("#674ea7", "col_purple", -1),
  col("#a64d79", "col_magenta", -1),

  col("#85200c", "col_red_berry", -2),
  col("#990000", "col_red", -2),
  col("#b45f06", "col_orange", -2),
  col("#bf9000", "col_yellow", -2),
  col("#38761d", "col_green", -2),
  col("#134f5c", "col_cyan", -2),
  col("#1155cc", "col_cornflower", -2),
  col("#0b5394", "col_blue", -2),
  col("#351c75", "col_purple", -2),
  col("#741b47", "col_magenta", -2),

  col("#5b0f00", "col_red_berry", -3),
  col("#660000", "col_red", -3),
  col("#783f04", "col_orange", -3),
  col("#7f6000", "col_yellow", -3),
  col("#274e13", "col_green", -3),
  col("#0c343d", "col_cyan", -3),
  col("#1c4587", "col_cornflower", -3),
  col("#073763", "col_blue", -3),
  col("#20124d", "col_purple", -3),
  col("#4c1130", "col_magenta", -3),
]

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

export namespace color {
  export const button = new Submenu({
    label: icon.Color,
    description: phrases.ref("text_color"),
    parent: inlineStyleMenu,
    rank: 60,
  })

  export const picker = new CustomControl({
    render(view, done) {
      return new ColorPicker(view, {
        options: colorOptions,
        finish: color => {
          done()
          setColor(view, color)
          view.focus()
        }
      })
    },
    parent: button
  })
}
