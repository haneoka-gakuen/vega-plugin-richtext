# Vega Rich Text

Vega Rich Text is the text layer of [Vega](https://github.com/haneoka-gakuen/vega).
Everything a story displays — dialogue, names, choices, backlog — goes through
one service that knows how to turn a string into styled text. Out of the box it
understands the game-style markup used by ADV scripts: ruby over kanji,
colours, sizes, bold and italic, spacing, alignment and line control. Install
a format plugin and the same dialogue box can show Markdown, BBCode, HTML,
LaTeX maths or Typst. A format nobody installed is never an error — the text
simply shows as plain text.

The package also contains the signed-distance-field text engine the WebGL
renderers use to draw crisp outlined text at any scale.

## Install

```sh
pnpm add @haneoka/vega @haneoka/vega-plugin-richtext
```

## Use it

```ts
import { VegaEngine } from "@haneoka/vega/engine";
import { VEGA_RICH_TEXT_SERVICE, vegaRichTextPlugin } from "@haneoka/vega-plugin-richtext";

const engine = new VegaEngine({ officialPlugins: [vegaRichTextPlugin] });
```

Inside a plugin or UI slot, render into any element:

```ts
const richText = context.service(VEGA_RICH_TEXT_SERVICE);
const handle = richText.render(element, "名前は<ruby=さきこ>祥子</ruby>です");

handle.update?.("<color=#ff6699>Next line</color>");
handle.dispose();
```

The plugin (`haneoka.vega-richtext`) provides two services: the rich-text
service and Vega's text-metrics service, which the typewriter effect uses to
count and cut visible characters correctly — a ruby annotation or a colour tag
is not a character the reader sees.

## Inputs

A string is rendered in the `defaultFormat` you pass (default `adv`). For
anything else, pass an object:

```ts
richText.render(element, { format: "markdown", source: "**Hello**" });
richText.render(element, { format: "latex", source: "E = mc^2", displayMode: true });
richText.render(element, { format: "adv", source: text, language: "ja" });
```

| Field | Meaning |
| --- | --- |
| `format` | `adv`, `plain`, or a format added by a plugin. Lowercase letters, digits, `.`, `+`, `-`. |
| `source` | The text. |
| `displayMode` | Block-level rendering, for formats that have it (maths). |
| `language` | BCP 47 tag set on the output, for correct fonts and line breaking. |

`render` options: `defaultFormat`, `displayMode`, `language`, `onError` (called
when a renderer fails; the text is still shown as plain text) and `immediate`
(skip frame coalescing for a final state). Repeated `update` calls within one
frame are merged, so a fast typewriter does not re-render more than needed.

## ADV markup

The `adv` format follows the rich-text tags the game scripts use:

| Tag | Effect |
| --- | --- |
| `<b>`, `<i>`, `<u>`, `<s>` | Bold, italic, underline, strikethrough |
| `<color=#rrggbb>` | Text colour: `#rgb`, `#rgba`, `#rrggbb`, `#rrggbbaa`, or a basic colour name such as `red` or `white` |
| `<size=120%>` | Relative size |
| `<ruby=annotation>base</ruby>` | Ruby text over the base |
| `<br>` | Line break |
| `<space=1em>` | Horizontal space, in `px`, `em` or `%` |
| `<cspace=0.1em>` | Letter spacing |
| `<align=center>` | Text alignment |
| `<mark=#ffff0080>` | Highlight |
| `<voffset=0.2em>` | Raise or lower text |
| `<pos=50%>` | Jump to a horizontal position |
| `<rotate=10>` | Rotate each glyph, in degrees |
| `<nobr>` | Keep the enclosed text on one line |
| `<noparse>…</noparse>` | Show the enclosed text literally |

An opening tag it does not recognise is shown as written. `parseAdvRichText` returns the parsed tree;
`advVisibleLength` and `advSliceVisible` count and cut by visible characters.

## Adding a format

Install an official format plugin after this one:

| Package | Formats |
| --- | --- |
| [`vega-plugin-richtext-markdown`](https://github.com/haneoka-gakuen/vega-plugin-richtext-markdown) | `markdown`, `md` — GitHub Flavored Markdown, sanitized |
| [`vega-plugin-richtext-bbcode`](https://github.com/haneoka-gakuen/vega-plugin-richtext-bbcode) | `bbcode` |
| [`vega-plugin-richtext-html`](https://github.com/haneoka-gakuen/vega-plugin-richtext-html) | `html` — strict allow-list |
| [`vega-plugin-richtext-latex`](https://github.com/haneoka-gakuen/vega-plugin-richtext-latex) | `latex` — KaTeX to MathML |
| [`vega-plugin-richtext-typst`](https://github.com/haneoka-gakuen/vega-plugin-richtext-typst) | `typst` |

Or register your own renderer:

```ts
const registration = richText.register({
  id: "my-format",
  formats: ["shout"],
  render: ({ document, source }) => document.createTextNode(source.toUpperCase()),
});
```

A renderer receives the source, the target document and an `AbortSignal`,
and returns a node or a list of nodes (synchronously or as a promise). Only
the latest render of an element is applied; earlier ones are abandoned.

## Text selection on the web

`bindWebTextSelection(element, options)` keeps text selectable in the backlog
and transcript while a click on the stage still advances the story.

## SDF text

`@haneoka/vega-plugin-richtext/sdf` lays out and paints text from a
signed-distance-field font atlas: `layoutSdfText(source, options)` produces
glyph and highlight quads with line breaking and ADV styling, and
`SdfTextPainter` draws them with outline and shadow materials. The Three.js and
Pixi renderers use it for in-scene text; you only need it for a renderer of
your own.

## License

MPL-2.0. See [LICENSE](LICENSE).
