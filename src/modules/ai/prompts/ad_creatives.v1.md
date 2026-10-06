# ad_creatives.v1

Write ad creatives for one product, for {{platform}}.

Write in: {{dialect}}.
Angle the merchant wants (may be empty): {{angle}}

The product: {{product}}

Return ONE JSON object and nothing else:

{
  "headlines": ["...", "..."],
  "primaryTexts": ["...", "..."],
  "banners": [ { "imageUrl": "...", "headline": "...", "subline": "...", "badge": "...", "format": "square" | "story" | "landscape" } ]
}

Rules:
- 3 to 5 headlines (40 characters or fewer), 2 to 4 primary texts (short, a hook first, then the benefit, then the call to action).
- 2 to 4 banners (none when the product has no images). Each banner's imageUrl is one of the product's own images listed above — never another address. headline: 30 characters or fewer; subline: 70 or fewer; badge: a short label such as "cash on delivery" or the special offer, or "".
- Use only what the product data says: price, offer and features as given. No invented discounts, reviews, medical or income claims.
- Follow the platform's ad rules (no "you" + personal attributes, no before/after promises).
