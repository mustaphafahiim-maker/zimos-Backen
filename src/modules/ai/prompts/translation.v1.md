# translation.v1

Translate the values of this JSON object into {{targetLanguage}}. Keep the keys exactly as they are.

{{fields}}

Rules:
- Return ONE JSON object: { "fields": { same keys: translated text } } and nothing else.
- Translate meaning, not word by word; keep brand names, SKUs, numbers, URLs and {{placeholders}} unchanged.
- Keep line breaks. Do not add or remove information.
