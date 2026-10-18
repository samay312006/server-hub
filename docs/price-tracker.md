# Price Tracker — `price-tracker/`

Tracks e-commerce product prices with a Playwright Chromium scraper, stores price history in
SQLite, and sends a WhatsApp alert when a price drops or hits your target.

- **Process:** PM2 `price-tracker`, `max_memory_restart: 300M` (launches a browser per check),
  port **8095** (loopback). **Dep:** `playwright`.
- **Files:** `index.js` (daemon + API), `scraper.js` (extraction), `db.js` (`prices.db`).
- **Reached by:** the WhatsApp `/track`, `/tracks`, `/untrack`, `/price-check` commands and the
  briefing builder (`GET /list`/products).

## `scraper.js`
| Function | Role |
|---|---|
| `scrapePrice(url, customSelector?)` | Launch headless Chromium (`--no-sandbox --disable-dev-shm-usage`, `en-IN`, desktop UA), `goto` (30 s, `domcontentloaded`), wait 2 s for JS prices, then try strategies in order and return `{price, currency, name, selectorUsed?, error?}`. |
| `parsePrice(raw)` | Strip non-numeric, normalize separators → float (or null). |
| `extractCurrency(raw)` | ₹→INR, $→USD, £→GBP, €→EUR (default INR). |

**Strategy order:** (1) page title → product name; (2) **JSON-LD** `@type:Product` offer
price; (3) **meta tags** (`product:price:amount`, `twitter:data1`); (4) a long **CSS selector**
list (Amazon `.a-price .a-offscreen`, Flipkart `._30jeq3`, Meesho, generic `[class*="price"]`,
`[data-price]`…), trying `customSelector` first. Returns an `error` field if nothing matched.

## `db.js` (`prices.db`)
Schema: `products(id, url, name, selector, target_price, current_price, currency,
last_checked, chat_id, added_at, active)` + `price_history(id, product_id, price, checked_at)`.
Functions: `addProduct`, `getProduct`, `listProducts({chatId?,activeOnly?})`,
`updatePrice(id, price)` (also inserts a history row), `updateProductName`,
`removeProduct(id)` (soft-delete `active=0`), `getPriceHistory(productId, limit?)`, `getStats`.

## `index.js`
| Function | Role |
|---|---|
| `checkProduct(product)` | Scrape, compare to the stored price, alert on a drop or target hit. |
| `checkAll(manual?)` | Check every active product (3 s polite gap between products); guarded against concurrent runs. Runs on the `PRICE_CHECK_INTERVAL_MINUTES` timer (first run 30 s after start). |
| `fmtPrice(price, currency?)` | Format with the right symbol. |
| `sendWhatsApp(chatId, message)` | Send a drop alert. |

## HTTP API (port 8095)
| Method | Path | Purpose |
|---|---|---|
| GET | `/status` | `{running, checking, intervalMin, tracked, withTarget, activeAlerts}` |
| GET | `/list` | `?chatId=` → tracked products |
| POST | `/track` | `{url, name?, targetPrice?, chatId?, selector?}` → add + first check |
| DELETE | `/untrack/:id` | soft-delete |
| GET | `/history/:id` | `?limit=` → price history |
| POST | `/check-now` | immediate poll |

### Example
```bash
curl -s -X POST http://127.0.0.1:8095/track -H 'content-type: application/json' \
  -d '{"url":"https://www.amazon.in/dp/XXXX","targetPrice":2999,"chatId":"123@c.us"}'
curl -s http://127.0.0.1:8095/status
```
