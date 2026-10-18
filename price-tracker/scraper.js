// Price scraper — uses Playwright Chromium to load a product page and extract price.
// Tries multiple strategies in order: JSON-LD structured data, meta tags, then
// a broad list of common e-commerce CSS selectors.
import { chromium } from 'playwright';

// Common e-commerce price selectors ordered by specificity
const PRICE_SELECTORS = [
  // Schema.org / microdata
  '[itemprop="price"]',
  '[itemprop="offers"] [itemprop="price"]',
  // Amazon
  '#priceblock_ourprice',
  '#priceblock_dealprice',
  '.a-price .a-offscreen',
  '#corePriceDisplay_desktop_feature_div .a-price .a-offscreen',
  // Flipkart
  '._30jeq3',
  '._16Jk6d',
  // Meesho / generic Indian e-commerce
  '.pdp-price strong',
  '.product-price',
  // Generic
  '.price',
  '.Price',
  '#price',
  '[class*="price"][class*="current"]',
  '[class*="current"][class*="price"]',
  '[class*="sale"][class*="price"]',
  '[class*="price--sale"]',
  '[class*="product-price"]',
  '[data-price]',
  '[data-product-price]',
];

function parsePrice(raw) {
  if (!raw) return null;
  // Try data-price attribute first (often the numeric value)
  const cleaned = raw.replace(/[^\d.,]/g, '').replace(/,(?=\d{3})/g, '');
  const num = parseFloat(cleaned.replace(/,/g, '.').replace(/\.(?=.*\.)/g, ''));
  return isNaN(num) ? null : num;
}

function extractCurrency(raw) {
  if (!raw) return 'INR';
  if (/₹/.test(raw)) return 'INR';
  if (/\$/.test(raw)) return 'USD';
  if (/£/.test(raw)) return 'GBP';
  if (/€/.test(raw)) return 'EUR';
  return 'INR';
}

export async function scrapePrice(url, customSelector = null) {
  let browser;
  try {
    browser = await chromium.launch({ headless: true, args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'] });
    const ctx = await browser.newContext({
      userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      locale: 'en-IN',
    });
    const page = await ctx.newPage();

    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
    // Let JS-rendered prices load
    await page.waitForTimeout(2000);

    // Strategy 1: page title for product name
    const title = await page.title().catch(() => '');
    const name = title.split(/[|\-–—]/)[0].trim().slice(0, 120) || null;

    // Strategy 2: JSON-LD structured data
    const jsonLdPrice = await page.evaluate(() => {
      const scripts = document.querySelectorAll('script[type="application/ld+json"]');
      for (const s of scripts) {
        try {
          const d = JSON.parse(s.textContent);
          const items = Array.isArray(d) ? d : [d];
          for (const item of items) {
            if (item['@type'] === 'Product' && item.offers) {
              const offers = Array.isArray(item.offers) ? item.offers : [item.offers];
              for (const o of offers) {
                const p = o.price ?? o.lowPrice;
                if (p != null) return { price: parseFloat(p), currency: o.priceCurrency || 'INR' };
              }
            }
          }
        } catch (_) {}
      }
      return null;
    });

    if (jsonLdPrice?.price) {
      return { price: jsonLdPrice.price, currency: jsonLdPrice.currency || 'INR', name };
    }

    // Strategy 3: meta tags
    const metaPrice = await page.evaluate(() => {
      const p = document.querySelector('meta[property="product:price:amount"]')?.content
        || document.querySelector('meta[name="twitter:data1"]')?.content;
      const c = document.querySelector('meta[property="product:price:currency"]')?.content;
      return p ? { raw: p, currency: c || 'INR' } : null;
    });
    if (metaPrice) {
      const price = parsePrice(metaPrice.raw);
      if (price) return { price, currency: metaPrice.currency, name };
    }

    // Strategy 4: custom or auto CSS selector
    const selectors = customSelector ? [customSelector, ...PRICE_SELECTORS] : PRICE_SELECTORS;
    for (const sel of selectors) {
      const el = await page.$(sel).catch(() => null);
      if (!el) continue;
      const raw = await el.getAttribute('data-price') ?? await el.getAttribute('content') ?? await el.innerText().catch(() => null);
      if (!raw) continue;
      const price = parsePrice(raw);
      if (price && price > 0) {
        return { price, currency: extractCurrency(raw), name, selectorUsed: sel };
      }
    }

    return { price: null, currency: 'INR', name, error: 'Price not found on page' };
  } finally {
    await browser?.close().catch(() => {});
  }
}
