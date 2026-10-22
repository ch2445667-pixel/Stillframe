# Stillframe — visual HTML editor plan

## Layout
- 48 px top bar: mark, editable file name, open, undo/redo, zoom, theme, Export.
- Full-height workspace: collapsible left panel (Layers / Code), large auto-fit canvas, 304 px Inspector.
- No page scroll. Panels scroll internally. On phones the canvas stays on top and Layers/Inspector become bottom sheets.
- Neutral gray surfaces, one blue accent, soft borders, 8 px spacing rhythm, sentence-case labels.

## Editing architecture
- User HTML renders in a sandboxed `srcdoc` iframe (`sandbox="allow-same-origin"`). Scripts stay in the source but do not execute; the parent can inspect and mutate the DOM directly, so no editor bridge is needed.
- Selection lives outside the iframe as parent-owned outlines, so outlines and labels can never leak into exports.
- Inline text editing is temporarily `contenteditable`; the attribute is removed before code sync or capture.
- The source of truth is clean, serialized user HTML. Every mutation updates the code view; code edits debounce back into the canvas while preserving the selection path.
- Style changes write inline CSS. Page colors edit matching literals in styles/inline styles, with a computed-style fallback for inherited/default colors.
- Undo/redo stores clean HTML snapshots with the selection path and coalesces slider edits.
- Export reuses the embedded `html-to-image` engine, capturing the body or selected element, with a transparent GIF placeholder for CORS-blocked images.

## Files
- `index.html` — complete offline app (inline library, styles, sample, logic).
- `PLAN.md` — this plan.
