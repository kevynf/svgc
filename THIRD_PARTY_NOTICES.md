# Third-party notices

## planegcs (@salusoft89/planegcs 1.3.0)

WebAssembly build of the 2D geometric constraint solver from FreeCAD's Sketcher.

- Source: https://github.com/Salusoft89/planegcs
- Upstream: https://github.com/FreeCAD/FreeCAD/tree/main/src/Mod/Sketcher/App/planegcs
- License: GNU Lesser General Public License v2.1 or later (LGPL-2.0-or-later as declared in the package)
- Copyright: Miroslav Šerý, Jiří Hon (Salusoft89) and contributors; FreeCAD contributors

The solver is loaded at runtime as a separate `planegcs.wasm` file and is not
compiled into this application's own code. It can be replaced with a
modified build of the library.
