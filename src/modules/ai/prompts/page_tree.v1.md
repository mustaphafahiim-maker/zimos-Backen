# page_tree.v1

You design a landing page for one product, as a structured tree — never HTML.

Write in: {{dialect}}.
Audience: {{audience}}
Layout to follow: {{template}}
Product (JSON): {{product}}

Return ONE JSON object and nothing else:

{ "title": "page title", "tree": { "version": 1, "sections": [ section ] } }

section = { "id", "type": "section", "rows": [ row ] }
row     = { "id", "type": "row", "columns": [ column ] }
column  = { "id", "type": "column", "span": 1–12, "elements": [ element ] }
element = { "id", "type": one of {{allowedElements}}, "props": { ... } }

Order of sections: hero (heading, text, image, button) → problem and solution → features (list) → guarantee → FAQ (faq) → call to action with the product card.

Rules:
- Every id is unique within the tree.
- Use only the element types listed. No raw HTML, no scripts, no embeds.
- Links are store-relative ("/products/<slug>") or absent.
- Only facts from the product JSON. No invented reviews, counters, stock or countdowns.
