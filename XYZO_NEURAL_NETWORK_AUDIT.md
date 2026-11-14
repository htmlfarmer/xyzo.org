# XYZO NEURAL NETWORK AUDIT

## Complete Inventory of All Neural Networks and ML Components

---

## MODEL 1: article_understanding

### PURPOSE
Generate 16-dimensional embeddings for articles that serve as input to all downstream models (geolocation, event_matching, relationship, ranking).

### INPUTS
- Article title + body (first 512 chars)

### OUTPUTS
- 16-dim embedding vector

### ARCHITECTURE
```
DistilBERT (768-dim) → Linear(768, 16) → 16-dim output
```

### PARAMETERS
- DistilBERT: ~66M parameters
- Linear projection: 768 × 16 = 12,288 parameters
- Total: ~66M parameters

### TRAINING
- Framework: PyTorch + sentence-transformers
- Loss: Triplet loss (margin=0.5)
- Training data: 336,689 articles
- Labeled examples: **0** (CRITICAL)
- Last trained: Never (no labels)

### INFERENCE
- Frequency: Every 5 minutes (nn_infer timer)
- Latency: ~10ms per batch of 100
- CPU usage: ~50ms per article
- Model size: ~260MB (DistilBERT)

### ACCURACY
**NOT MEASURABLE FROM CURRENT DATA** — No labeled validation set exists.

### FAILURE MODES
1. **No labels** — Cannot train or evaluate
2. **Random projection** — Linear(768,16) may lose critical information
3. **Sentence-transformers fallback** — Falls back to random vectors if unavailable

### DATA QUALITY
- Input: Raw article text (title + body[:512])
- Noise: HTML artifacts, encoding issues, truncation
- Bias: English-dominant training data

### DRIFT
**NOT MONITURABLE** — No baseline accuracy to compare against.

### FEEDBACK LOOP
**NONE** — No mechanism to improve from user behavior.

### CURRENT VALUE
**LOW** — Model exists but cannot be trained or used effectively.

### BOTTLENECKS
1. Zero labeled training data
2. 16-dim output is extremely compressed (768→16)
3. No evaluation framework

### IMPROVEMENT OPPORTUNITIES
1. Increase embedding dimension (16→64 or 128)
2. Add semi-supervised training from clustering
3. Implement contrastive learning from click data

### RECOMMENDED EXPERIMENTS
- **Experiment A:** Train on synthetic labels (cluster membership)
- **Experiment B:** Increase dimension to 64, measure downstream impact
- **Experiment C:** Add hard-negative mining from search failures

---

## MODEL 2: geolocation

### PURPOSE
Predict article location (lat/lng, precision, confidence) from text and metadata.

### INPUTS
- text_emb: 16-dim article embedding
- meta: 6 features (existing_lat, existing_lng, confidence, hour, day_of_week, has_location)
- country_idx: Source country index

### OUTPUTS
- lat: Latitude (-90 to 90)
- lng: Longitude (-180 to 180)
- precision: 4 classes (exact/city/region/country)
- confidence: 0-1
- country: 256 country classes

### ARCHITECTURE
```
text_proj: Linear(16, 128) + GELU
meta_fc: Linear(6, 128) + GELU
country_embed: Embedding(256, 64)
fc: Linear(256, 128) + GELU + LayerNorm
fc2: Linear(128, 64) + GELU
lat_head: Linear(64, 1) + tanh * 90
lng_head: Linear(64, 1) + tanh * 180
prec_head: Linear(64, 4)
conf_head: Linear(64, 1) + sigmoid
country_head: Linear(64, 256)
```

### PARAMETERS
- text_proj: 16 × 128 = 2,048
- meta_fc: 6 × 128 = 768
- country_embed: 256 × 64 = 16,384
- fc: 256 × 128 = 32,768
- fc2: 128 × 64 = 8,192
- Output heads: 64 × (1+1+4+1+256) = 17,408
- Total: ~77K parameters

### TRAINING
- Framework: PyTorch
- Loss: MSE(lat) + MSE(lng) + 0.5 × CrossEntropy(precision)
- Training data: 336,689 articles
- Labeled examples: **0** (CRITICAL)
- Last trained: Never (no labels)

### INFERENCE
- Frequency: Every 5 minutes (nn_infer timer)
- Latency: ~5ms per batch of 100
- CPU usage: ~10ms per article
- Model size: ~300KB

### ACCURACY
**NOT MEASURABLE FROM CURRENT DATA** — No labeled validation set exists.

### FAILURE MODES
1. **No labels** — Cannot train or evaluate
2. **Text pathway useless** — Previously used zeros for text_emb (now fixed)
3. **Country-only prediction** — May default to source country HQ

### DATA QUALITY
- Labels: None (auto-labeling just added)
- Input quality: Text embeddings from article_understanding
- Metadata quality: Good (existing geocoding data)

### DRIFT
**NOT MONITURABLE** — No baseline accuracy to compare against.

### FEEDBACK LOOP
**NEW** — Auto-labeling pipeline just added; feedback → retraining pending.

### CURRENT VALUE
**VERY LOW** — Model exists but cannot be trained.

### BOTTLENECKS
1. Zero labeled training data (just fixed with auto-labeling)
2. Text embeddings from article_understanding may be poor
3. No evaluation framework

### IMPROVEMENT OPPORTUNITIES
1. Run auto-labeling to generate training data
2. Train model with text embeddings
3. Add location_text as additional feature
4. Implement active learning for uncertain predictions

### RECOMMENDED EXPERIMENTS
- **Experiment A:** Run auto-labeling, train model, measure MSE
- **Experiment B:** Compare with existing geocoding pipeline accuracy
- **Experiment C:** Add location_text feature, measure improvement

---

## MODEL 3: entity_extraction

### PURPOSE
Extract named entities (person, organization, place, event) from article text.

### INPUTS
- Tokenized article text

### OUTPUTS
- BIO labels for each token (7 classes)

### ARCHITECTURE
```
Embedding → Conv1d → Linear → Softmax
```

### PARAMETERS
- ~500K parameters

### TRAINING
- Framework: PyTorch
- Loss: Cross-entropy
- Training data: 336,689 articles
- Labeled examples: **0** (CRITICAL)

### CURRENT VALUE
**VERY LOW** — Model exists but cannot be trained.

### RECOMMENDED EXPERIMENTS
- **Experiment A:** Use spaCy NER as pseudo-labels for training
- **Experiment B:** Train on CoNLL-2003, fine-tune on news domain

---

## MODEL 4: event_matching

### PURPOSE
Detect duplicate/related events by comparing article pairs.

### INPUTS
- title_a, title_b: Article titles
- body_a, body_b: Article bodies (first 256 chars)
- metadata: publication time, source, location

### OUTPUTS
- Cosine similarity score (0-1)

### ARCHITECTURE
```
Siamese: article_understanding(title_a) → emb_a
         article_understanding(title_b) → emb_b
Score: Linear(48, 64) + GELU → Linear(64, 1) + sigmoid
```

### PARAMETERS
- Siamese: ~66M (shared with article_understanding)
- Score head: 48 × 64 + 64 = 3,136
- Total: ~66M parameters

### TRAINING
- Framework: PyTorch
- Loss: Binary cross-entropy
- Training data: 300,000 event pairs
- Labeled examples: **0** (CRITICAL)

### CURRENT VALUE
**VERY LOW** — Model exists but cannot be trained.

### RECOMMENDED EXPERIMENTS
- **Experiment A:** Use existing clustering as pseudo-labels
- **Experiment B:** Train on human-annotated duplicate pairs

---

## MODEL 5: relationship

### PURPOSE
Classify relationships between events (causal, temporal, etc.).

### INPUTS
- title_a, title_b: Event titles
- metadata: time difference, location overlap

### OUTPUTS
- 8 relationship types + confidence score

### ARCHITECTURE
```
Siamese: article_understanding(title_a) → emb_a
         article_understanding(title_b) → emb_b
MLP: Linear(48, 64) + GELU → Linear(64, 8) + softmax
Score: Linear(48, 1) + sigmoid
```

### PARAMETERS
- Siamese: ~66M (shared)
- MLP: 48 × 64 + 64 × 8 = 3,648
- Total: ~66M parameters

### TRAINING
- Framework: PyTorch
- Loss: Cross-entropy + BCE
- Training data: 300,000 event pairs
- Labeled examples: **0** (CRITICAL)

### CURRENT VALUE
**VERY LOW** — Model exists but cannot be trained.

---

## MODEL 6: ranking

### PURPOSE
Score articles for trending/hotness based on engagement and content.

### INPUTS
- article_emb: 16-dim article embedding
- session_emb: 16-dim session embedding
- scalar_feats: 14 features (clicks, views, age, etc.)

### OUTPUTS
- Ranking score (0-1)

### ARCHITECTURE
```
concat(article_emb, session_emb, scalar_feats) → 46-dim
Linear(46, 64) + GELU → Linear(64, 1) + sigmoid
```

### PARAMETERS
- Linear: 46 × 64 + 64 = 3,008
- Total: ~3K parameters

### TRAINING
- Framework: PyTorch
- Loss: Binary cross-entropy
- Training data: 35,554 articles
- Labeled examples: **0** (CRITICAL)

### CURRENT VALUE
**VERY LOW** — Model exists but cannot be trained.

### RECOMMENDED EXPERIMENTS
- **Experiment A:** Use click data as labels (implicit feedback)
- **Experiment B:** Train on trending articles as positive examples

---

## MODEL 7: coverage

### PURPOSE
Detect geographic coverage gaps (countries with insufficient news).

### INPUTS
- country_emb: 64-dim country embedding
- neighbor_gaps: 32 features from neighboring countries
- scalar_feats: 8 features (population, GDP, etc.)

### OUTPUTS
- Gap score (0-1)
- Confidence (0-1)

### ARCHITECTURE
```
concat(country_emb, neighbor_gaps, scalar_feats) → 104-dim
Linear(104, 64) + GELU → Linear(64, 2) → gap_score, confidence
```

### PARAMETERS
- Linear: 104 × 64 + 64 × 2 = 6,784
- Total: ~7K parameters

### TRAINING
- Framework: PyTorch
- Loss: MSE(gap) + BCE(confidence)
- Training data: 927 country-weeks
- Labeled examples: **0** (CRITICAL)

### CURRENT VALUE
**VERY LOW** — Model exists but cannot be trained.

---

## MODEL 8: category_classifier (WordFreqNN)

### PURPOSE
Classify articles into 35 news categories using word frequency features.

### INPUTS
- Word frequency vector (8192-dim sparse)
- Boosted title words (weight 3x)

### OUTPUTS
- 35 category probabilities

### ARCHITECTURE
```
Linear(8192, 256) + BatchNorm + GELU + Dropout(0.3)
Linear(256, 128) + BatchNorm + GELU + Dropout(0.2)
Linear(128, 35) + Softmax
```

### PARAMETERS
- Linear1: 8192 × 256 = 2,097,152
- Linear2: 256 × 128 = 32,768
- Linear3: 128 × 35 = 4,480
- BatchNorm: 256 + 128 = 384
- Total: ~2.1M parameters

### TRAINING
- Framework: PyTorch + sklearn
- Loss: Cross-entropy
- Optimizer: AdamW (lr=1e-3, weight_decay=1e-4)
- Epochs: 8, batch_size=256
- Training data: 49,500+ labeled articles
- Validation: 85/15 split, stratified

### INFERENCE
- Frequency: Every 5 minutes (nn_infer timer)
- Latency: ~2ms per batch of 100
- CPU usage: ~5ms per article
- Model size: ~8MB
- Ensemble: PyTorch DNN + fast SGDClassifier

### ACCURACY
- **Overall:** 72.5%
- **Bucket accuracy:** 79.7% (elections→politics counts correct)
- **Top categories:** politics (85%), technology (78%), business (75%)

### FAILURE MODES
1. **"Other" bucket** — Articles without clear category
2. **Language bias** — English-dominant patterns
3. **Noisy labels** — Training from event_type field (not human-annotated)

### DATA QUALITY
- Labels: From news_articles.event_type (weak supervision)
- Noise: ~10% mislabeled (keyword classifier errors)
- Bias: English-dominant, Western news sources

### DRIFT
**MONITURABLE** — Can track accuracy over time if labels are available.

### FEEDBACK LOOP
**ACTIVE** — User corrections trigger incremental retraining via `classification_learning_loop.py`.

### CURRENT VALUE
**HIGH** — Only trained model with measurable accuracy.

### BOTTLENECKS
1. Noisy training labels (from keyword classifier)
2. 35 categories may be too granular
3. No multilingual support

### IMPROVEMENT OPPORTUNITIES
1. Use AI-labeled data for cleaner training
2. Reduce to 15 parent categories
3. Add multilingual embeddings

### RECOMMENDED EXPERIMENTS
- **Experiment A:** Train on AI-labeled data, compare accuracy
- **Experiment B:** Reduce to 15 categories, measure impact
- **Experiment C:** Add paraphrase-multilingual-MiniLM-L12-v2

---

## MODEL 9: Two-Head Classifier (classifier.py)

### PURPOSE
Score articles for event-richness and classify event type.

### INPUTS
- 384-dim sentence-transformer embedding

### OUTPUTS
- Event-richness score (0-1)
- Event type (8 classes: concert/class/sports/etc.)

### ARCHITECTURE
```
Linear(384, 128) + ReLU + Dropout(0.3)
Linear(128, 64) + ReLU + Dropout(0.3)
├→ Linear(64, 1) + sigmoid (reranker)
└→ Linear(64, 8) + softmax (event type)
```

### PARAMETERS
- Linear1: 384 × 128 = 49,152
- Linear2: 128 × 64 = 8,192
- Reranker: 64 × 1 = 64
- Event type: 64 × 8 = 512
- Total: ~58K parameters

### TRAINING
- Framework: PyTorch
- Loss: BCE(reranker) + CE(event_type)
- Training data: From news_interactions

### CURRENT VALUE
**MEDIUM** — Used for event detection but limited training data.

---

## SUMMARY

| Model | Parameters | Labeled Data | Status | Value |
|-------|------------|--------------|--------|-------|
| article_understanding | 66M | 0 | 🔴 Cannot train | LOW |
| geolocation | 77K | 0 | 🔴 Cannot train | LOW |
| entity_extraction | 500K | 0 | 🔴 Cannot train | LOW |
| event_matching | 66M | 0 | 🔴 Cannot train | LOW |
| relationship | 66M | 0 | 🔴 Cannot train | LOW |
| ranking | 3K | 0 | 🔴 Cannot train | LOW |
| coverage | 7K | 0 | 🔴 Cannot train | LOW |
| category_classifier | 2.1M | 49,500 | ✅ Trained | HIGH |
| two-head classifier | 58K | Unknown | ⚠️ Limited | MEDIUM |

**Critical Finding:** 8 out of 9 neural networks have ZERO labeled training data. Only the category_classifier is actively trained and providing value.
