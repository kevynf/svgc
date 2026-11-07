<h1 align="center">svgc</h1>

<p align="center">简体中文 | <a href="./README.en.md">English</a></p>

基于约束的 SVG 绘图工具：浏览器端的二维草图编辑器。画图、加约束，几何自动求解。

## 功能

- 约束求解基于 planegcs（FreeCAD Sketcher 的 WASM 构建），每个图元实时显示"完全约束 / 欠约束"状态
- 绘制：直线、多段线、圆、弧、矩形、点
- 约束：重合、点在线上、中点、水平/垂直、平行/垂直、相切、等长/等径、对称、固定、距离、半径、角度
- 尺寸：驱动尺寸可键入数值或表达式（如 `sqrt(a^2 + b^2)`），从动尺寸仅作测量
- 参数化编辑：修剪、延伸、倒角、偏移、镜像，重建草图并整体重解，一步撤销
- 命名参数与表达式引擎；修改一个参数，按依赖顺序整体重解
- 文件：导出 SVG、打开/保存 `.svgc.json` 草稿格式；画板即导出页面
- Inventor 风格界面：Ribbon、标题栏应用菜单、标记菜单、模型树、属性面板、状态栏

## 快速开始

```bash
npm install
npm run dev       # 开发服务器
npm run build     # 类型检查 + 构建到 dist/
npm run preview   # 预览构建产物
npm test          # 单元测试
npm run format    # prettier
```

推送 `master` 即通过 Actions 自动部署到 GitHub Pages。

## 目录结构

| 目录 | 内容 |
| --- | --- |
| `src/core` | 几何模型、约束、表达式引擎（不可变数据） |
| `src/solver` | planegcs 封装：求解、逐图元约束状态分析 |
| `src/editor` | 编辑器与命令、历史、拾取、推理 |
| `src/render` | SVG 渲染：几何、约束符号、尺寸 |
| `src/io` | SVG 导出、`.svgc.json` 格式、文件保存 |
| `src/ui` | 应用外壳：Ribbon、菜单、对话框、面板、国际化 |

## 技术栈

TypeScript、Vite、Vitest、planegcs（WASM 约束求解器）、Tabler Icons。
无 UI 框架，画布为手工构建的 SVG。

## 第三方组件

planegcs 为 LGPL-2.1-or-later，详见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。
