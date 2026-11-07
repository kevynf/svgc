<h1 align="center">svgc</h1>

<p align="center"><a href="./README.md">简体中文</a> | English</p>

Constraint-based SVG drawing tool: a 2D sketch editor in the browser. Draw,
constrain, and the geometry solves itself.

## Features

- Constraint solving through planegcs (FreeCAD Sketcher, WASM); every entity
  reports its own fully/under-constrained status.
- Drawing: line, polyline, circle, arc, rectangle, point.
- Constraints: coincident, point-on-curve/line, midpoint, horizontal, vertical,
  parallel, perpendicular, tangent, equal, symmetric, fix, distance, radius,
  angle.
- Dimensions: driving dimensions take a number or an expression
  (`sqrt(a^2 + b^2)`); driven dimensions only measure.
- Parametric editing: trim, extend, fillet, offset and mirror rebuild the
  sketch and re-solve it as one undo step.
- Named parameters with an expression engine; editing one re-solves the set
  dependencies-first.
- Files: SVG export and `.svgc.json` sketch documents (open/save); the artboard
  is the exported page.
- Inventor-style shell: ribbon, title-bar application menu, marking menu, model
  browser, properties panel, status bar.

## Getting started

```bash
npm install
npm run dev       # dev server
npm run build     # typecheck + production build to dist/
npm run preview   # serve the build
npm test          # unit tests
npm run format    # prettier
```

Pushing to `master` deploys the build to GitHub Pages via Actions.

## Layout

| Path         | Contents                                                  |
| ------------ | --------------------------------------------------------- |
| `src/core`   | Geometry model, constraints, expression engine (immutable) |
| `src/solver` | planegcs wrapper: solving, per-entity constraint status   |
| `src/editor` | Editor and commands, history, picking, inference          |
| `src/render` | SVG rendering: geometry, constraint symbols, dimensions   |
| `src/io`     | SVG export, `.svgc.json` format, file saving              |
| `src/ui`     | App shell: ribbon, menus, dialogs, panels, i18n           |

## Tech stack

TypeScript, Vite, Vitest, planegcs (WASM constraint solver), Tabler Icons.
No UI framework — the canvas is hand-built SVG.

## Third-party

planegcs is LGPL-2.1-or-later; see [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
