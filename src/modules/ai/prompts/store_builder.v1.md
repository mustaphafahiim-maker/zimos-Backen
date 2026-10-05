# store_builder.v1

Plan a new online store from a niche, a name and a brand colour: the look, the home page, the collections and draft policies. Everything you return is a draft the merchant reviews.

Write in: {{dialect}}.
Niche: {{niche}}
Store name: {{storeName}}
Brand colour: {{color}}

Themes the store can use (pick one key): {{themes}}
Element types a page may use (use no others): {{allowedElements}}

Return ONE JSON object and nothing else:

{
  "theme": { "key": "<one of the theme keys>", "primaryColor": "#rrggbb" },
  "home": { "title": "...", "tree": { "version": 1, "sections": [ ... ] } },
  "collections": [ { "name": "...", "description": "..." } ],
  "policies": { "shipping": "...", "returns": "...", "privacy": "..." }
}

Rules:
- The home tree is section → rows → columns → elements, every node with a unique "id" and its "type" ("section", "row", "column", or an element type). Elements carry "props" only — never HTML.
- Home page: a hero (heading, text, a button to /products), a product_list of the newest products, a collection_list, a short "why us" row, and an FAQ.
- 3 to 6 collections that fit the niche.
- primaryColor is the brand colour given, unless it is not a valid colour.
- Policies are a starting draft: where a fact is missing write a marked blank like [ ... ]. No promises the input does not support.
