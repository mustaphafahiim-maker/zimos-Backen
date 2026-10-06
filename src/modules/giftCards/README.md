# Gift cards (spec-gaps item 189)

- **Issue**: staff (`discounts.manage`) give a value and currency; the code is shown once in the answer, emailed to the
  recipient when one is given, and can be revealed or resent later (audited).
- **Sell**: products listed in `settings.gift_cards.productIds` issue one card per unit sold, worth the line's unit price,
  when the order is paid in full or delivered (`order.paid` / `order.delivered`, idempotent per order line unit), emailed to
  the buyer. `validityDays` sets an expiry. No amount is written in code.
- **Redeem**: `giftCardCode` at checkout, with cash on delivery. The card pays at most what is due, as a captured payment
  (provider `gift_card`, reference `<cardId>:<orderId>`): `amountPaid` rises, so the courier collects the rest.
  Online gateways take the whole total today, so a card is refused with them (follow-up: subtract the card from the attempt).
- **Refund**: any processed refund of a `gift_card` payment credits the card in the refund's own transaction (Refund model
  hook), whether the merchant's refund or the automatic one when the order is cancelled (`order.cancelled`).
  Locks are taken order first, then card, everywhere.
- **Check**: `POST /store/:ws/gift-cards/check` (order-tracking rate limit).
- Codes: 16 characters without 0/O/1/I, HMAC (store + code) for lookup, sealed for reveal, last 4 shown.
