import {Facet} from "@willows/state"
import {StyleModule, StyleSpec} from "style-mod"

export const theme = Facet.define<string, string>({combine: strs => strs.join(" ")})

export const darkTheme = Facet.define<boolean, boolean>({combine: values => values.indexOf(true) > -1})

export const baseThemeID = StyleModule.newName(), baseLightID = StyleModule.newName(), baseDarkID = StyleModule.newName()

export const lightDarkIDs = {"&light": "." + baseLightID, "&dark": "." + baseDarkID}

export function buildTheme(main: string, spec: {[name: string]: StyleSpec}, scopes?: {[name: string]: string}) {
  return new StyleModule(spec, {
    finish(sel) {
      return /&/.test(sel) ? sel.replace(/&\w*/, m => {
        if (m == "&") return main
        if (!scopes || !scopes[m]) throw new RangeError(`Unsupported selector: ${m}`)
        return scopes[m]
      }) : main + " " + sel
    }
  })
}

export const baseTheme = buildTheme("." + baseThemeID, {
  "&": {
    position: "relative !important",
    boxSizing: "border-box",
    "&.ws-focused": {
      // Provide a simple default outline to make sure a focused
      // editor is visually distinct. Can't leave the default behavior
      // because that will apply to the content element, which is
      // inside the scrollable container and doesn't include the
      // gutters. We also can't use an 'auto' outline, since those
      // are, for some reason, drawn behind the element content, which
      // will cause things like the active line background to cover
      // the outline (#297).
      outline: "1px dotted #212121"
    },
    display: "flex !important",
    flexDirection: "column"
  },

  ".ws-scroller": {
    height: "100%",
    overflowX: "auto",
    position: "relative",
    zIndex: 0,
  },

  ".ws-content": {
    margin: 0,
    whiteSpace: "pre-wrap",
    boxSizing: "border-box",
    minHeight: "100%",
    padding: "4px 0",
    outline: "none",
  },

  "&light .ws-content": { caretColor: "black" },
  "&dark .ws-content": { caretColor: "white" },

  ".ws-layer": {
    position: "absolute",
    left: 0,
    top: 0,
    contain: "size style",
    "& > *": {
      position: "absolute"
    }
  },

  "&light .ws-selectionBackground": {
    background: "#d9d9d9"
  },
  "&dark .ws-selectionBackground": {
    background: "#222"
  },
  "&light.ws-focused > .ws-scroller > .ws-selectionLayer .ws-selectionBackground": {
    background: "#d7d4f0"
  },
  "&dark.ws-focused > .ws-scroller > .ws-selectionLayer .ws-selectionBackground": {
    background: "#233"
  },

  ".ws-cursorLayer": {
    pointerEvents: "none"
  },
  "&.ws-focused > .ws-scroller > .ws-cursorLayer": {
    animation: "steps(1) ws-blink 1.2s infinite"
  },

  // Two animations defined so that we can switch between them to
  // restart the animation without forcing another style
  // recomputation.
  "@keyframes ws-blink": {"0%": {}, "50%": {opacity: 0}, "100%": {}},
  "@keyframes ws-blink2": {"0%": {}, "50%": {opacity: 0}, "100%": {}},

  ".ws-cursor, .ws-dropCursor": {
    borderLeft: "1.2px solid black",
    marginLeft: "-0.6px",
    pointerEvents: "none",
  },
  ".ws-cursor": {
    display: "none"
  },
  "&dark .ws-cursor": {
    borderLeftColor: "#444"
  },
  ".ws-dropCursor": {
    position: "absolute"
  },

  "&.ws-focused > .ws-scroller > .ws-cursorLayer .ws-cursor": {
    display: "block"
  },

  ".ws-announced": {
    position: "fixed",
    top: "-10000px"
  },
  "@media print": {
    ".ws-announced": { display: "none" }
  },

  ".ws-placeholder": {
    color: "#888",
    display: "inline-block",
    verticalAlign: "top",
  },
}, lightDarkIDs)
