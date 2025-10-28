import {Facet} from "@wordgard/state"
import {StyleModule, StyleSpec} from "style-mod"

export const theme = Facet.define<string, string>({combine: strs => strs.join(" ")})

export const darkTheme = Facet.define<boolean, boolean | null>({combine: values => values.length ? values[0] : null})

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
    "&.wg-focused": {
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

  ".wg-scroller": {
    height: "100%",
    overflowX: "auto",
    position: "relative",
    zIndex: 0,
  },

  ".wg-content": {
    margin: 0,
    whiteSpace: "pre-wrap",
    boxSizing: "border-box",
    minHeight: "100%",
    padding: "4px 0",
    outline: "none",
    caretColor: "transparent",
  },

  ".wg-cursorLayer": {
    position: "absolute",
    left: 0,
    top: 0,
    contain: "size style",
    "& > *": {
      position: "absolute"
    },
    pointerEvents: "none",
    zIndex: 150,
  },

  "&.wg-focused > .wg-scroller > .wg-cursorLayer": {
    animation: "steps(1) wg-blink 1.2s infinite"
  },

  // Two animations defined so that we can switch between them to
  // restart the animation without forcing another style
  // recomputation.
  "@keyframes wg-blink": {"0%": {}, "50%": {opacity: 0}, "100%": {}},
  "@keyframes wg-blink2": {"0%": {}, "50%": {opacity: 0}, "100%": {}},

  ".wg-cursor": {
    pointerEvents: "none",
    display: "none",
  },
  ".wg-cursor-v": {
    borderLeft: "1.2px solid currentColor",
    marginLeft: "-0.6px",
  },
  ".wg-cursor-h": {
    borderTop: "1.2px solid currentColor",
    marginTop: "-0.6px",
  },
  "&.wg-focused > .wg-scroller > .wg-cursorLayer .wg-cursor": {
    display: "block"
  },

  ".wg-announced": {
    position: "fixed",
    top: "-10000px"
  },
  "@media print": {
    ".wg-announced": { display: "none" }
  },

  ".wg-panels": {
    boxSizing: "border-box",
    position: "sticky",
    left: 0,
    right: 0,
    zIndex: 300,
  },
}, lightDarkIDs)
