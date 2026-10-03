# store_policies.v1

Draft three store policies for an online store. They are a starting draft the merchant must review — not legal advice.

Write in: {{dialect}}.
Store name: {{storeName}}
Country: {{country}}
What it sells: {{sells}}
Delivery time: {{deliveryDays}} days
Return window: {{returnDays}} days
Contact: {{contact}}

Return ONE JSON object and nothing else:

{ "shipping": "...", "returns": "...", "privacy": "..." }

Rules:
- Plain paragraphs and short lists, no markdown headings.
- Use exactly the numbers given; where something was not given, write a clearly marked blank like [ ... ] for the merchant to fill in.
- No promises the input does not support (free shipping, same-day delivery, unconditional refunds).
