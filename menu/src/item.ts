import {Command} from "@wordgard/view"
import {EditorState} from "@wordgard/state"

export type MenuItem = {
  run: Command
  // FIXME feed these some pre-processed data about selection to avoid duplicate work?
  select?: (state: EditorState) => boolean
  enable?: (state: EditorState) => boolean
  active?: (state: EditorState) => boolean
  // FIXME use 100x100 viewport for these, find better icons
  label: string | {icon: string}
  description: string
  group: MenuGroup
  precedence: number
  // FIXME specify hotkey here and allow menu items to provide the key bindings?
}

export class MenuCollection {
  constructor(spec: {} = {}) {}
}

export class MenuDropDown {
  constructor(spec: {} = {}) {}
}

export type MenuGroup = MenuCollection | MenuDropDown

export const Commands = new MenuCollection()
export const InlineStyles = new MenuCollection()
export const Alignment = new MenuCollection()

export const staticMenu: MenuItem[] = [ // FIXME automatic generation
  {
    run: () => { console.log("undo"); return true },
    label: {icon: "M8 3a5 5 0 1 1-4.55 2.91.5.5 0 0 0-.91-.42A6 6 0 1 0 8 2z M8 4.47V.534.25.25 0 0 0-.41-.19L5.23 2.31a.25.25 0 0 0 0 .38l2.36 1.97A.25.25 0 0 0 8 4.47"},
    description: "Undo",
    group: Commands,
    precedence: 10
  },
  {
    run: () => { console.log("redo"); return true },
    label: {icon: "M8 3a5 5 0 1 0 4.55 2.91.5.5 0 0 1 .91-.42A6 6 0 1 1 8 2z M8 4.47V.53a.25.25 0 0 1 .41-.19l2.36 1.97c.12.1.12.28 0 .38L8.41 4.66A.25.25 0 0 1 8 4.47"},
    description: "Redo",
    group: Commands,
    precedence: 20
  },
  {
    run: () => { console.log("strong"); return true },
    label: {icon: "M8.21 13c2.11 0 3.41-1.09 3.41-2.82 0-1.31-.98-2.28-2.32-2.39v-.06a2.18 2.18 0 0 0 1.85-2.14c0-1.51-1.16-2.46-3.014-2.46H3.843V13zM5.91 4.67h1.70c.96 0 1.52.45 1.52 1.24 0 .83-.63 1.32-1.73 1.32H5.91V4.67zm0 6.79V8.60h1.73c1.22 0 1.88.49 1.88 1.41 0 .94-.64 1.45-1.83 1.45H5.91z"},
    description: "Toggle strong emphasis",
    group: InlineStyles,
    precedence: 10
  },
  {
    run: () => { console.log("left"); return true },
    label: {icon: "M2 12.5a.5.5 0 0 1 .5-.5h7a.5.5 0 0 1 0 1h-7a.5.5 0 0 1-.5-.5m0-3a.5.5 0 0 1 .5-.5h11a.5.5 0 0 1 0 1h-11a.5.5 0 0 1-.5-.5m0-3a.5.5 0 0 1 .5-.5h7a.5.5 0 0 1 0 1h-7a.5.5 0 0 1-.5-.5m0-3a.5.5 0 0 1 .5-.5h11a.5.5 0 0 1 0 1h-11a.5.5 0 0 1-.5-.5"},
    description: "Align left",
    group: Alignment,
    precedence: 10
  },
  {
    run: () => { console.log("right"); return true },
    label: {icon: "M6 12.5a.5.5 0 0 1 .5-.5h7a.5.5 0 0 1 0 1h-7a.5.5 0 0 1-.5-.5m-4-3a.5.5 0 0 1 .5-.5h11a.5.5 0 0 1 0 1h-11a.5.5 0 0 1-.5-.5m4-3a.5.5 0 0 1 .5-.5h7a.5.5 0 0 1 0 1h-7a.5.5 0 0 1-.5-.5m-4-3a.5.5 0 0 1 .5-.5h11a.5.5 0 0 1 0 1h-11a.5.5 0 0 1-.5-.5"},
    description: "Align right",
    group: Alignment,
    precedence: 20
  },
  {
    run: () => { console.log("center"); return true },
    label: {icon: "M4 12.5a.5.5 0 0 1 .5-.5h7a.5.5 0 0 1 0 1h-7a.5.5 0 0 1-.5-.5m-2-3a.5.5 0 0 1 .5-.5h11a.5.5 0 0 1 0 1h-11a.5.5 0 0 1-.5-.5m2-3a.5.5 0 0 1 .5-.5h7a.5.5 0 0 1 0 1h-7a.5.5 0 0 1-.5-.5m-2-3a.5.5 0 0 1 .5-.5h11a.5.5 0 0 1 0 1h-11a.5.5 0 0 1-.5-.5"},
    description: "Center",
    group: Alignment,
    precedence: 30
  },
]

export function groupItems(items: readonly MenuItem[], groups: readonly MenuGroup[]) {
  
}
