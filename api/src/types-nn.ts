// Neural Network type definitions for Xyzo API

export interface NNModelStatus {
  name: string;
  version: string | null;
  trained_at: string | null;
  metrics: Record<string, number> | null;
  lifecycle: "not_trained" | "cold_start" | "trained_no_inference" | "live";
  labeled_rows: number;
  total_rows: number;
  cached_embeddings: number;
  predictions_in_cache: number;
  feedback_since_train: number;
}

export interface NNTrainingRun {
  model: string;
  version: string | null;
  status: "running" | "completed" | "failed" | "skipped";
  started_at: string;
  finished_at: string | null;
  rows_total: number | null;
  rows_train: number | null;
  rows_val: number | null;
  epochs_run: number | null;
  final_loss: number | null;
  final_metrics: Record<string, number> | null;
  error: string | null;
}

export interface NNFeedbackStats {
  model: string;
  corrections_24h: number;
  corrections_7d: number;
  corrections_30d: number;
  used_in_training: number;
}

export interface NNCacheStats {
  model: string;
  total_predictions: number;
  active_predictions: number;
  stale_predictions: number;
  unique_entities: number;
  oldest_prediction: string | null;
  newest_prediction: string | null;
}

export interface NNLeaderboardItem {
  article_id: number;
  event_id: number | null;
  headline: string;
  source: {
    id: number;
    name: string;
    country: string | null;
  };
  location: {
    lat: number;
    lng: number;
    country: string | null;
    place_name: string | null;
  } | null;
  published_at: string | null;
  fetched_at: string | null;
  scores: {
    nn_ranking: number;
    classical_engagement: number;
    blended: number;
    trending: number;
    local_relevance: number;
    source_quality: number;
    freshness: number;
    velocity: number;
    audience_match: number;
  };
  bucket: "hot" | "trending" | "rising" | "normal";
}

export interface NNSimilarArticle {
  article_id: number;
  cosine_similarity: number;
  title: string;
  published_at: string | null;
  source: { name: string | null; country: string | null };
  shared_event: boolean;
  location: {
    lat: number;
    lng: number;
    place_name: string | null;
    country: string | null;
  } | null;
}

export interface NNDriftPoint {
  hour: string;
  avg_score: number;
  std_score: number;
  min_score: number;
  max_score: number;
  sample_count: number;
}

export interface NNCorrectionDrift {
  hour: string;
  correction_count: number;
  avg_lat_shift: number | null;
  avg_lng_shift: number | null;
}

export interface NNCoverageItem {
  country_code: string;
  country_name: string;
  region: string | null;
  population: number;
  active_sources: number;
  articles_24h: number;
  events_24h: number;
  events_per_million: number;
  nn_gap_score: number;
  classical_gap_score: number;
  nn_confidence: number | null;
  nn_reasoning: string | null;
  recommended_sources: number;
  location: { lat: number; lng: number } | null;
}

export interface NNRelationshipEdge {
  event_id: number;
  edge_type: "event" | "location";
  relation: string;
  score: number;
  headline: string;
  location: {
    lat: number;
    lng: number;
    place_name: string | null;
    country: string | null;
  } | null;
  model_version: string;
  predicted_at: string;
}

export interface NNSimilarEvent {
  event_id: number;
  score: number;
  rank: number;
  headline: string;
  event_type: string;
  location: {
    lat: number;
    lng: number;
    place_name: string | null;
    country: string | null;
  } | null;
}
