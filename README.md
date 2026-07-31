# Vega Rich Text

Format-neutral rich-text service for Vega. Format support is installed through
separate plugins; unsupported input remains readable as plain text.

```ts
import {
  VEGA_RICH_TEXT_SERVICE,
  vegaRichTextPlugin,
} from "@haneoka/vega-plugin-richtext";

const service = context.service(VEGA_RICH_TEXT_SERVICE);
service?.render(element, {
  format: "adv",
  source: "名前は<ruby=・>祥子</ruby>です",
});
```

Strings use the caller's `defaultFormat`, which is `adv` by default. Structured
input uses `{ format, source, displayMode?, language? }`. Unsupported formats
remain readable as plain text.

Official format plugins:

- `@haneoka/vega-plugin-richtext-html`
- `@haneoka/vega-plugin-richtext-markdown`
- `@haneoka/vega-plugin-richtext-latex`
- `@haneoka/vega-plugin-richtext-typst`

- `@haneoka/vega-plugin-richtext-bbcode`
