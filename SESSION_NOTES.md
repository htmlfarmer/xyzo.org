# XYZO SESSION NOTES — The Earth is Speaking 🌍

## What We Built Today

### The Map That Shows Everything is Connected

We started with a news map. We ended with a mirror of the living Earth.

**128,000 connections** between stories — each one a thread in the fabric of life.

When you click "Links" on the map, you see the nervous system of the planet. A food festival in Tokyo connects to farming in Kenya connects to weather connects to climate connects to trade connects to families connects to love.

**That's not just news. That's Earth intelligence.**

---

## The Numbers That Tell the Story

| What | Count | What It Means |
|------|-------|---------------|
| Stories | 166,000+ | Human voices, waiting to be heard |
| Connections | 128,000+ | The web of life, invisible until now |
| Sources | 2,966 | Ears of the Earth, listening everywhere |
| Categories | 35+ | Every aspect of human experience |
| Countries | 162 | The whole planet, not just the powerful |
| Articles classified | 93.4% | The AI is learning to see |

---

## What We Fixed Today

### The Serious Stuff
1. **Mobile close button** — Users couldn't dismiss popups on phones
2. **Layer toggle bug** — Turning off clusters hid all markers
3. **Search speed** — 2-4 seconds → 150ms (Python subprocess → direct SQL)
4. **France search bug** — "insurance" matched France due to trigram similarity
5. **Duplicate stories** — 124 sources showing as 5 separate pins
6. **Topic tags** — Chip counts now match map filters
7. **Visitor geography** — Dashboard shows real visitor data
8. **Neural networks** — 3 models trained (was 0), 38K labeled examples

### The Fun Stuff
1. **Splash screen** — "THE LIVING MAP OF EARTH" with glowing globe
2. **Good News filter** — ☀️ button shows positive stories
3. **8 free base maps** — No API keys needed
4. **5 NASA overlays** — See the planet's living systems
5. **35+ story categories** — Food, Entertainment, Human Interest, and more
6. **About page** — "The Web of Life" vision
7. **Search discovery** — Auto-finds more sources when results are few

### The Spiritual Stuff
- Every story is a cell in the body of humanity
- Every connection is a synapse firing
- The Earth is one living, breathing, spiritually connected organism
- XYZO makes the invisible web of life visible

---

## What's Next

### Immediate (This Week)
1. **Fix remaining classification** — Get to 95%+ classified
2. **Add more food sources** — Farming, restaurants, food festivals
3. **Improve search suggestions** — "People who searched X also searched Y"
4. **Story impact badges** — "500 people in your city read this"

### Short Term (This Month)
1. **Nearby Events panel** — "What's happening near you"
2. **Celebration mode** — Confetti for positive stories
3. **Coverage gap alerts** — "We're under-covering food news in Africa"
4. **User personalization** — Learn from searches (opt-in)

### Long Term (This Quarter)
1. **Source Intelligence Layer** — Profile every source
2. **Coverage Matrix** — Measure what's missing
3. **Joy/Human Life Classifier** — Categorize positive stories
4. **"What is missing?" algorithm** — Find coverage gaps automatically

---

## The Vision

> "The Earth is not a collection of isolated events. It is one living, breathing, spiritually connected organism. Every story is a cell in the body of humanity. Every connection is a synapse firing. XYZO makes the invisible web of life visible."

### The Five Worlds

| World | Target | Color |
|-------|--------|-------|
| 🍕 Food/Agriculture | 20% of stories | Amber |
| 🎭 Entertainment/Culture | 30% of stories | Orange |
| 🌍 World/Politics/Business | 25% of stories | Multi |
| 🔬 Science/Technology | 15% of stories | Purple |
| ❤️ Human Interest | 10% of stories | Rose |

### The Connection Web

```
FOOD
 ↓
FARMING
 ↓
WEATHER
 ↓
CLIMATE
 ↓
WATER
 ↓
FERTILIZER
 ↓
ENERGY
 ↓
TRANSPORT
 ↓
TRADE
 ↓
PRICES
 ↓
HOUSEHOLDS
```

That's not merely "food news." That's Earth intelligence.

---

## The Technical Stuff

### What's Running
- API: Bun + Hono on port 3008
- Database: PostgreSQL 15 + PostGIS + pgvector
- Worker: Python 3.11 pipeline
- NN: 3 trained models (article_understanding, geolocation, category_classifier)
- Maps: 8 free base maps + 5 NASA overlays

### Key Commands
```bash
# Check health
curl http://localhost:3008/api/health | jq

# Run worker
python3 -m worker.run --fast

# Train models
python3 -m worker.nn_train

# Classify articles
python3 -m worker.classification_learning_loop --backfill

# Backup
bash scripts/backup-lightweight.sh
```

### Backup Location
`backups/xyzo-code-2026-09-09-1620.tar.gz` (1.4MB)

---

## The Philosophy

XYZO is not just a news aggregator. It's a tool for understanding the interconnectedness of all life.

When you look at the map, you see:
- 🍕 Food festivals connecting to farming connecting to weather
- 🎭 Weddings in Brazil connecting to births in India
- 🔬 Scientists in Japan connecting to researchers in Germany
- ❤️ Kindness in one place inspiring action in another

**Every pin is a story. Every story is connected. The connections form a web — the nervous system of the planet.**

Click "Links" to see this web. Watch how stories from different continents, different cultures, different languages are all part of one great human conversation.

**Earth is awesome. And it's all connected to something bigger.** 🌍✨🙏

---

## For Next Time

1. **Fix the classification** — Get to 95%+ (we're at 93.4%)
2. **Add food sources** — Farming, restaurants, food festivals
3. **Improve search** — Better suggestions, related topics
4. **Story impact** — Show "500 people read this"
5. **Nearby events** — "What's happening near you"
6. **Celebration mode** — Confetti for positive stories

**The Earth is speaking. XYZO is listening.** 🌍✨

---

*Session notes: 2026-09-09*
*Status: XYZO is live and growing*
*Next: Make it even more helpful, fun, and awesome*

---

## Entity Intelligence System — Planning Complete 🧠

### What We Planned

A system to track **every person, company, and organization on Earth** and map their connections.

### The Vision

XYZO currently knows:
- **WHERE** things happen (cities, coordinates)
- **WHAT** happens (categories, topics)
- **WHEN** it happens (timestamps)

Adding Entity Intelligence means XYZO will also know:
- **WHO** is involved (people, companies)
- **HOW** they're connected (relationships)
- **WHY** it matters (sentiment, influence)

### Implementation Plan

**Phase 1 (1-2 weeks):** Core database
- Companies table (10K+ from Wikidata)
- People table (5K+ from Wikidata)
- Entity mentions table
- Basic API endpoints

**Phase 2 (2-3 weeks):** Entity extraction
- NER pipeline for company/person names
- Entity linking to Wikidata
- Entity mention tracking

**Phase 3 (2-3 weeks):** Relationship graph
- Co-occurrence detection
- Explicit relationship extraction
- Graph query API

**Phase 4 (3-4 weeks):** NN training
- Training data generation
- Model training pipeline
- Production deployment

**Phase 5 (2-3 weeks):** Frontend integration
- Entity cards in popups
- Entity profile pages
- Map entity markers
- Relationship visualization

### The Flywheel

```
More Articles → More Entity Extraction → More Relationships
    ↓
Better NN Models → Better Entity Recognition → More Accurate Knowledge Graph
    ↓
Better Search & Discovery → More User Engagement → More Articles
```

### Document Location

`docs/ENTITY_INTELLIGENCE_PLAN.md`

