# page_review.v1

Review one sales page of an online store (a store page or a funnel step) and say how likely it is to turn visitors into orders, with concrete fixes.

Write in: {{dialect}}.

What the page is: {{pageKind}} "{{pageName}}"
Its numbers over the last 30 days: {{metrics}}
Facts measured from the page (trust these; they come from the page itself): {{facts}}
The page, section by section: {{outline}}

Return ONE JSON object and nothing else:

{
  "score": 0-100,
  "summary": "two or three sentences",
  "recommendations": [ { "title": "...", "detail": "...", "severity": "high" | "medium" | "low" } ]
}

Rules:
- At most 10 recommendations, the most important first; each one names what to change and where on the page.
- Base everything on the facts, the outline and the numbers. Do not invent numbers, reviews, or results.
- Typical checks: the order form or buy button is far down, no clear price, no guarantee or return promise, no FAQ, no social proof, pictures without a description, too many sections before the offer, a weak or missing call to action, no urgency, numbers that show visitors leave without ordering.
- Never suggest fake reviews, fake counters or fake scarcity.
