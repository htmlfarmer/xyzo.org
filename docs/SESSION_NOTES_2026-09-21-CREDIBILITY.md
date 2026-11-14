# Session Notes - September 21, 2026

## Credibility Signal System

### What Was Built

**1. Credibility Feature Extractor** (`worker/credibility/features.py`)
- Extracts credibility signals from articles using rule-based analysis
- Factors analyzed:
  - Source reliability score
  - Citation presence and quality
  - Factual specificity (numbers, dates, names)
  - Emotional language ratio
  - Sensationalist writing style
  - Article depth
  - Proper attribution (author/dateline)

**2. NN Model** (`worker/credibility/model.py`)
- Simple feedforward neural network for factor importance
- Uses sigmoid activation, trained on synthetic data
- Designed for future training on fact-checked articles

**3. API Endpoint** (`api/src/routes/credibility.ts`)
- `GET /api/articles/:id/credibility` - Returns cached credibility factors
- `POST /api/articles/:id/credibility/compute` - Computes factors on-demand
- Legal disclaimer included: "This analysis shows observable credibility factors only. Not a truth claim."

**4. Background Worker** (`worker/credibility/compute_signals.py`)
- Batch processes articles to compute credibility signals
- 830K+ articles processed in ~4 hours
- Usage: `python3 -m worker.credibility.compute_signals --batch-size 3000 --max-articles 50000`

**5. Database Column**
- Added `credibility_signals JSONB` column to `news_articles` table

### UI Integration

**Pin Popup Display** (`public_html/app.js`)
- New "📊 Credibility Signals" section in pin popups
- Shows positive factors (green), concerns (red), and medium weight factors
- Legal disclaimer: "Observable factors only · not a truth claim"

**API Changes** (`api/src/routes/pins.ts`)
- `/api/pins/:id` now returns `credibility` field from news_articles

### Key Learnings

1. **pins table vs news_articles**: pins table only has ~6 rows (community type). Most map markers come from news_articles directly (article-backed, not pin-backed).

2. **credibility_signals storage**: Column added to news_articles, not pins. Article ID = Pin ID for article-backed entries.

3. **Query optimization**: Batch processing at 3000 articles works well. OFFSET-based pagination had issues - removed offset to avoid performance degradation.

4. **Legal protection**: Output is "factors" not "score". Every response includes disclaimer that these are observable signals, not truth claims.

### Search UX Improvement

**Clear Button Styling** (`public_html/styles.css`)
- Changed from gray (#374151) to accent color
- Status bar shows "Press Esc or click × Clear to exit" hint when search is active
- Escape key already clears search (was working, just not visible to users)

## API Validation

```bash
bash scripts/validate-api.sh  # Must pass before deployment
```

## Testing

```bash
# Run all tests
python3 -m pytest tests/test_viz.py tests/test_boot_fetch_coordinator.py -v

# Check credibility API
curl "http://localhost:3008/api/articles/100002/credibility"
```

## Files Created/Modified

- `worker/credibility/features.py` - NEW
- `worker/credibility/model.py` - NEW
- `worker/credibility/compute_signals.py` - NEW
- `api/src/routes/credibility.ts` - NEW
- `api/src/routes/pins.ts` - MODIFIED (added credibility field)
- `public_html/app.js` - MODIFIED (credibility popup section)
- `public_html/styles.css` - MODIFIED (clear button styling)

## Remaining Items

- NN model trained on synthetic data - would benefit from real fact-checked article training data
- Could add credibility to event popups (not just pin popups)
- Consider aggregating credibility for source-level (show average source credibility)
