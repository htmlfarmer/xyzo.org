# XYZO Route Organization

Routes are grouped by domain for easier navigation and testing.
Each domain has its own folder under `domains/`.

## Domain Groups

### Map / Content (`map/`)
Core map functionality and content display.

| File | Purpose |
|------|---------|
| `pins.ts` | Map pins CRUD, bbox queries, community submit |
| `events.ts` | Event listing, search, clustering |
| `feed.ts` | Live SSE feed, hot/nearby events |

### Search (`search/`)
All search-related functionality.

| File | Purpose |
|------|---------|
| `search.ts` | Main search endpoint |
| `search-intel.ts` | Search intelligence / analytics |
| `search_results.ts` | Search results display |

### Sources (`sources/`)
News source management and discovery.

| File | Purpose |
|------|---------|
| `sources.ts` | Source management, discovery, stats, health dashboard |
| `sites_study.ts` | Site study / analysis |
| `sniff.ts` | Source sniffing / URL detection |

**Health Endpoint:** `GET /api/sources/health` — Returns comprehensive source health metrics including error rates, contamination status, and article stats.

### Media (`media/`)
Audio, video, and photo content.

| File | Purpose |
|------|---------|
| `audio.ts` | Podcast/audio show endpoints |
| `video.ts` | Video channels, videos, map, search |
| `photo.ts` | Photo source management |

### Discovery (`discovery/`)
AI-powered area exploration and categorization.

| File | Purpose |
|------|---------|
| `explore.ts` | Explore region / auto-discover |
| `auto_categorize.ts` | Fast-path categorization |

### Community (`community/`)
User contributions and feedback.

| File | Purpose |
|------|---------|
| `community.ts` | Community validation, votes, replies |
| `feedback.ts` | Geocoding corrections, quality reports |

### AI (`ai/`)
AI-related endpoints and chat.

| File | Purpose |
|------|---------|
| `ai-chat.ts` | AI chat interface |
| `ai-flag.ts` | AI-assisted flag reports |
| `ai-status.ts` | AI system status |

### Analytics (`analytics/`)
User interaction tracking and insights.

| File | Purpose |
|------|---------|
| `analytics.ts` | User interactions, rankings, engagement |

### System (`system/`)
Health checks, status, and operational endpoints.

| File | Purpose |
|------|---------|
| `health.ts` | Health check |
| `shutdown.ts` | Site shutdown management |
| `stats.ts` | System statistics |
| `sysload.ts` | System load monitoring |
| `version.ts` | Version info |
| `sitemap.ts` | Sitemap generation |
| `service-events.ts` | Service event logging |

### Admin (`admin/`)
Administrative operations.

| File | Purpose |
|------|---------|
| `admin.ts` | Admin-only operations |

### Reference Data (`reference/`)
Cities, locations, and geographic data.

| File | Purpose |
|------|---------|
| `cities.ts` | City lookup and management |
| `locations.ts` | Location endpoints |
| `location-views.ts` | Location view tracking |
| `geocode.ts` | Geocoding endpoints |
| `geoip.ts` | IP-based geolocation |
| `events_calendar.ts` | Event calendar |

### People (`people/`)
Journalists and other people-related endpoints.

| File | Purpose |
|------|---------|
| `journalists.ts` | Journalist profiles |

### Content Links (`links/`)
Link-related functionality.

| File | Purpose |
|------|---------|
| `links.ts` | Story linking, cross-article connections |
| `story-links.ts` | Story link management |

### Intelligence (`intelligence/`)
Problem detection and coverage analysis.

| File | Purpose |
|------|---------|
| `problems.ts` | Problem detection |
| `deserts.ts` | News desert analysis |
| `undercover.ts` | Undercovered events |
| `science.ts` | Science source management |

### Tags (`tags/`)
Content tagging.

| File | Purpose |
|------|---------|
| `tags.ts` | Tag management and lookup |

### Neural Networks (`nn/`)
ML/NN related endpoints.

| File | Purpose |
|------|---------|
| `nn.ts` | Neural network predictions and features |

### Other (`other/`)
Miscellaneous endpoints.

| File | Purpose |
|------|---------|
| `agent.ts` | Agent/worker communication |
| `command.ts` | Command execution |
| `performance.ts` | Performance monitoring |
| `imageProxy.ts` | Image proxy |
| `wiki.ts` | Wiki integration |

## File Size Map

Largest routes by size (for knowing what to test carefully):

| File | Size | Domain |
|------|------|--------|
| `analytics.ts` | 85 KB | analytics |
| `pins.ts` | 40 KB | map |
| `explore.ts` | 38 KB | discovery |
| `feed.ts` | 35 KB | map |
| `community.ts` | 36 KB | community |
| `feedback.ts` | 32 KB | community |
| `audio.ts` | 22 KB | media |
| `nn.ts` | 22 KB | nn |
| `video.ts` | 20 KB | media |
| `cities.ts` | 20 KB | reference |

## Migration Status

**Phase 1 (current):** This document exists for reference.
**Phase 2:** Routes stay in current location to avoid import breakage.
**Phase 3 (future):** Move routes to domain folders, update server.ts imports.
