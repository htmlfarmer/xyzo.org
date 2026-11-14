# XYZO AI Master Plan — Action Engine Edition

**From: "AI that reads news" → "AI that helps solve problems"**

*Last updated: 2026-09-09*

---

## Table of Contents

1. [How to Talk to the Coding AI](#1-how-to-talk-to-the-coding-ai)
2. [The 25 Action Algorithms with Code](#2-the-25-action-algorithms-with-code)
3. [Gemma4 Programming Patterns](#3-gemma4-programming-patterns)
4. [Legal & Safety Framework](#4-legal--safety-framework)
5. [Health Intelligence Framework](#5-health-intelligence-framework)
6. [Daily Personal Intelligence Briefing](#6-daily-personal-intelligence-briefing)
7. [The 1000+ Ideas Roadmap](#7-the-1000-ideas-roadmap)
8. [Understanding Earth: Three Lenses](#8-understanding-earth-three-lenses)
9. [Implementation Priority](#9-implementation-priority)

---

## 1. How to Talk to the Coding AI

### The Problem

Most people make this mistake:

> "Do a full site review."

This invites the AI to write a 40-page archaeological dissertation while moving nothing. 😂

### The Solution: Mission + Constraints + Deliverables + Stopping Rules

Give the coding AI a **bounded mission** with explicit constraints, deliverables, and stopping rules.

### XYZO AI ENGINEERING MISSION — TEMPLATE

```
XYZO MASTER MISSION: [SPECIFIC GOAL]

Mission
───────
You are the senior AI systems architect for XYZO.org.
XYZO is a geospatial news intelligence platform.
NON-NEGOTIABLE RULE: DO NOT BREAK THE EXISTING SITE.

Before changing anything:
1. Inspect the existing implementation
2. Establish a baseline
3. Benchmark current behavior
4. Identify dependencies
5. Identify risks
6. Create tests for behavior that must remain unchanged
7. Make changes incrementally
8. Re-run benchmarks and tests after every meaningful change

PRIMARY THESIS
──────────────
XYZO must evolve from "AI that reads news" into "AI that understands
problems and recommends useful human actions."

PHASE 1: INVESTIGATE
───────────────────
Research these files thoroughly:
- [list specific files]
Produce measurable baseline of:
- current performance
- current behavior
- current limitations

PHASE 2: PROPOSE
────────────────
For every recommendation:
- Point to ACTUAL code/database/API responsible
- Do NOT invent implementation details
- Identify what exists, what works, what is broken, what is slow, what is missing

PHASE 3: IMPLEMENT
──────────────────
Implement ONE bounded improvement.
Re-test after each change.

DELIVERABLE
───────────
A concrete, testable improvement to XYZO.
```

### EXAMPLE: Talking to the AI About Event Relationships

**BAD:**
> "Can you improve the event system?"

**GOOD:**
```
XYZO MISSION: Add causal relationship detection to events

Mission:
Add a lightweight causal relationship detector that identifies when
Event B was caused by Event A (e.g., "earthquake" → "humanitarian crisis").

Constraints:
- Do NOT modify the existing event clustering logic
- Add new tables only (news_event_causes)
- Use existing Gemma endpoint (http://192.168.1.3:8888/chat/stream)
- Results must be human-reviewable before affecting rankings
- Must not slow down the existing pipeline by >10%

Investigate:
1. Read worker/cluster.py to understand event structure
2. Read worker/extract.py to see Gemma usage patterns
3. Read api/src/routes/events.ts for event API
4. Check news_events table schema in migrations/

Baseline:
- Current event count: [query DB]
- Average event lifetime: [measure]
- Existing relationship detection: [none/event_type only]

Proposal Format:
```
FILE: worker/causal_detector.py (NEW)
INPUT: Two event IDs
OUTPUT: {cause_event_id, effect_event_id, confidence, evidence[], mechanism}
ALGORITHM: [specific approach]
RISKS: [what could break]
```

DELIVERABLE: A working causal_detector.py with:
- Gemma-powered cause/effect extraction
- PostgreSQL storage in news_event_causes table
- API endpoint GET /api/events/:id/causes
- Basic evaluation metrics
```

### EXAMPLE: Talking to the AI About Action Recommendations

**BAD:**
> "Add recommendations to help people."

**GOOD:**
```
XYZO MISSION: Build the Action Engine for disaster response

Mission:
When a disaster event is detected, generate specific actionable
recommendations for affected users.

Constraints:
- Do NOT auto-execute any external actions (donations, volunteering)
- All recommendations require human confirmation
- Privacy: do not expose personal data
- Legal: distinguish information from advice

Investigate:
1. Read worker/cluster.py — how events are created
2. Read worker/extract.py — how Gemma is used
3. Read news_events table schema
4. Check news_interactions for user interest signals

Data Model (proposed):
news_event_actions {
  id, event_id, action_type, description, evidence,
  expected_benefit, confidence, requires_human_approval,
  status (pending/approved/rejected/completed), created_at
}

Action Types:
- INFORMATION (share this fact)
- DONATE (money to this org)
- VOLUNTEER (time to this org)
- ADVOCATE (contact representative)
- PREPARE (steps to take now)
- LEARN (skills to develop)

Gemma Prompt Pattern:
```
You are XYZO's action recommendation engine.
Given this event: [event headline + summary]
Given this location: [location, population affected]
Given these organizations: [orgs mentioned in articles]

Generate 3-5 specific actions humans could take.
For each action:
- Who could do it? (ordinary person / org / government)
- What exactly should they do?
- What evidence suggests it might help?
- What could go wrong?
- How confident are you? (low/medium/high)

Return JSON:
{
  "actions": [
    {
      "type": "DONATE",
      "who": "ordinary person",
      "what": "Donate to [specific org]",
      "evidence": "They have [specific capability]",
      "risks": "Scam risk — verify first",
      "confidence": "high"
    }
  ]
}
```

DELIVERABLE:
1. worker/action_engine.py — Gemma-powered action generation
2. Database migration for news_event_actions table
3. GET /api/events/:id/actions endpoint
4. POST /api/actions/:id/approve (human approval)
5. Basic click-through tracking
```

---

## 2. The 25 Action Algorithms with Code

### Category A: Understand Problems (1-8)

#### Algorithm 1: Problem Pattern Detector

```python
"""problem_detector.py — identifies recurring problem patterns from events.

Logic:
- Monitor event_type + location + time patterns
- Flag when the same problem repeats (floods in X, layoffs in Y)
- Generate a "Problem Report" with severity, frequency, affected population

Example:
"5 earthquakes in Italy in 30 days" → seismic risk problem
"12 factory closures in Detroit in 90 days" → economic collapse problem
"""
from dataclasses import dataclass
from datetime import datetime, timedelta
from typing import Optional

@dataclass
class ProblemReport:
    problem_id: str
    problem_type: str  # 'recurring', 'emerging', 'worsening'
    headline: str
    description: str
    location_id: int
    country_code: str
    first_detected: datetime
    last_occurrence: datetime
    occurrence_count: int
    severity: float  # 0-1
    urgency: float   # 0-1
    evidence_events: list[int]  # event IDs
    confidence: float
    metadata: dict

def detect_problems(conn, window_days: int = 30, min_occurrences: int = 3) -> list[ProblemReport]:
    """Find recurring problem patterns from event clusters."""
    with conn.cursor() as cur:
        # Group events by (location, event_type) and find patterns
        cur.execute("""
            SELECT
                l.id AS location_id,
                l.country AS country_code,
                e.event_type,
                COUNT(*) AS occurrence_count,
                MIN(e.first_reported_at) AS first_detected,
                MAX(e.first_reported_at) AS last_occurrence,
                AVG(e.avg_confidence) AS avg_confidence,
                STRING_AGG(DISTINCT e.headline, ' | ') AS headlines
            FROM news_events e
            JOIN news_locations l ON l.id = e.primary_location_id
            WHERE e.status = 'active'
              AND e.first_reported_at > NOW() - INTERVAL '%s days'
            GROUP BY l.id, l.country, e.event_type
            HAVING COUNT(*) >= %s
            ORDER BY occurrence_count DESC
        """, (window_days, min_occurrences))
        
        problems = []
        for row in cur.fetchall():
            # Calculate severity based on frequency + recency
            recency_decay = max(0, 1 - (datetime.now() - row['last_occurrence']).days / window_days)
            severity = min(1.0, (row['occurrence_count'] / 10) * recency_decay)
            
            # Urgency: is it getting worse? (more frequent recently?)
            urgency = calculate_urgency(conn, row['location_id'], row['event_type'], window_days)
            
            problems.append(ProblemReport(
                problem_id=f"prob_{row['location_id']}_{row['event_type']}",
                problem_type=classify_problem_type(row, urgency),
                headline=f"Recurring {row['event_type']} in {row['location_id']}",
                description=row['headlines'][:500],
                location_id=row['location_id'],
                country_code=row['country_code'],
                first_detected=row['first_detected'],
                last_occurrence=row['last_occurrence'],
                occurrence_count=row['occurrence_count'],
                severity=severity,
                urgency=urgency,
                evidence_events=[],  # TODO: fetch event IDs
                confidence=row['avg_confidence'],
                metadata={'window_days': window_days}
            ))
        return problems

def calculate_urgency(conn, location_id: int, event_type: str, window_days: int) -> float:
    """Calculate if problem is accelerating (more frequent recently)."""
    with conn.cursor() as cur:
        cur.execute("""
            WITH recent AS (
                SELECT COUNT(*) as cnt
                FROM news_events
                WHERE primary_location_id = %s
                  AND event_type = %s
                  AND first_reported_at > NOW() - INTERVAL '%s days'
            ),
            older AS (
                SELECT COUNT(*) as cnt
                FROM news_events
                WHERE primary_location_id = %s
                  AND event_type = %s
                  AND first_reported_at BETWEEN NOW() - INTERVAL '%s days' AND NOW() - INTERVAL '%s days'
            )
            SELECT 
                CASE WHEN older.cnt = 0 THEN 1.0
                ELSE recent.cnt::float / older.cnt END AS acceleration
            FROM recent, older
        """, (location_id, event_type, window_days//2, 
              location_id, event_type, window_days, window_days//2))
        result = cur.fetchone()
        return min(1.0, result['acceleration'] if result else 0.0)

def classify_problem_type(row: dict, urgency: float) -> str:
    """Classify problem as recurring, emerging, or worsening."""
    if urgency > 1.5:
        return 'worsening'
    elif row['occurrence_count'] >= 5:
        return 'recurring'
    else:
        return 'emerging'
```

#### Algorithm 2: Severity Estimator

```python
"""severity_model.py — estimates the magnitude/impact of a problem.

Factors:
- Population affected (from news_locations or external data)
- Economic damage estimates (from articles)
- Duration
- Scope (local vs regional vs national vs global)
- Secondary effects (displacement, casualties, infrastructure damage)
"""
from dataclasses import dataclass
from typing import Optional

@dataclass
class SeverityScore:
    overall: float  # 0-1
    population_impact: float
    economic_impact: float
    duration_factor: float
    scope_factor: float
    secondary_factor: float
    confidence: float
    sources: list[str]  # article IDs

def estimate_severity(event_id: int, conn) -> SeverityScore:
    """Estimate severity from event data and article content."""
    with conn.cursor() as cur:
        # Get event data
        cur.execute("""
            SELECT e.*, l.lat, l.lng, l.country, l.place_name,
                   COUNT(DISTINCT es.article_id) AS source_count
            FROM news_events e
            JOIN news_locations l ON l.id = e.primary_location_id
            LEFT JOIN news_event_sources es ON es.event_id = e.id
            WHERE e.id = %s
            GROUP BY e.id, l.lat, l.lng, l.country, l.place_name
        """, (event_id,))
        event = cur.fetchone()
        
        if not event:
            return SeverityScore(0, 0, 0, 0, 0, 0, 0, [])
        
        # Get related articles for evidence
        cur.execute("""
            SELECT a.id, a.title, a.body, a.summary
            FROM news_articles a
            JOIN news_event_sources es ON es.article_id = a.id
            WHERE es.event_id = %s
        """, (event_id,))
        articles = list(cur.fetchall())
        
        # Extract severity signals from articles using Gemma
        severity_signals = extract_severity_signals(event, articles)
        
        # Calculate components
        pop = estimate_population_impact(event, severity_signals)
        econ = estimate_economic_impact(event, articles)
        duration = estimate_duration(event)
        scope = estimate_scope(event, severity_signals)
        secondary = estimate_secondary(event, articles)
        
        # Weighted combination
        overall = (
            pop * 0.35 +
            econ * 0.25 +
            duration * 0.10 +
            scope * 0.15 +
            secondary * 0.15
        )
        
        return SeverityScore(
            overall=min(1.0, overall),
            population_impact=pop,
            economic_impact=econ,
            duration_factor=duration,
            scope_factor=scope,
            secondary_factor=secondary,
            confidence=calculate_confidence(articles, severity_signals),
            sources=[a['id'] for a in articles]
        )

def extract_severity_signals(event: dict, articles: list) -> dict:
    """Use Gemma to extract severity signals from article text."""
    # TODO: Implement with Gemma
    # Prompt: "Extract casualty counts, displacement numbers, economic damage estimates"
    pass

def estimate_population_impact(event: dict, signals: dict) -> float:
    """Estimate population impact 0-1."""
    # If we have numbers from signals, use them
    if signals.get('casualties'):
        return min(1.0, signals['casualties'] / 1000)  # 1000+ casualties = 1.0
    if signals.get('displaced'):
        return min(1.0, signals['displaced'] / 100000)  # 100k+ displaced = 1.0
    # Fallback: use event_type defaults
    defaults = {
        'disaster': 0.7,
        'conflict': 0.8,
        'health': 0.6,
        'weather': 0.4,
        'crime': 0.3,
        'other': 0.2
    }
    return defaults.get(event.get('event_type'), 0.2)
```

#### Algorithm 3: Intervention Generator

```python
"""intervention_generator.py — generates possible actions for problems.

For each problem, generate 3-8 interventions across categories:
- INFORMATION: spread awareness
- FINANCIAL: donate, invest, tip
- VOLUNTEER: time, skills
- ADVOCACY: contact officials, sign petitions
- PREPARATION: steps to reduce future impact
- RESEARCH: learn more, investigate
"""
from dataclasses import dataclass
from typing import Optional

@dataclass
class Intervention:
    intervention_id: str
    problem_id: str
    category: str  # INFORMATION, FINANCIAL, VOLUNTEER, ADVOCACY, PREPARATION, RESEARCH
    headline: str
    description: str
    who_can_do: list[str]  # ['ordinary_person', 'organization', 'government']
    expected_benefit: str
    expected_cost: str
    risks: list[str]
    prerequisites: list[str]
    success_metrics: list[str]
    confidence: float
    evidence: list[str]  # article IDs or external references
    time_horizon: str  # 'immediate', 'short_term', 'long_term'

INTERVENTION_TEMPLATES = {
    'disaster': [
        {
            'category': 'INFORMATION',
            'headline': 'Share verified emergency contacts',
            'description': 'Help spread official emergency hotline numbers and evacuation routes',
            'who': ['ordinary_person'],
            'time': 'immediate'
        },
        {
            'category': 'FINANCIAL',
            'headline': 'Donate to recognized relief organizations',
            'description': 'Contribute to established NGOs with on-the-ground presence',
            'who': ['ordinary_person'],
            'time': 'immediate'
        },
        {
            'category': 'VOLUNTEER',
            'headline': 'Join local volunteer coordination groups',
            'description': 'Connect with established volunteer networks rather than self-deploying',
            'who': ['ordinary_person'],
            'time': 'short_term'
        },
        {
            'category': 'PREPARATION',
            'headline': 'Review family emergency plan',
            'description': 'Ensure your household has a communication plan and basic supplies',
            'who': ['ordinary_person'],
            'time': 'immediate'
        },
    ],
    'health': [
        {
            'category': 'INFORMATION',
            'headline': 'Share WHO/public health guidance',
            'description': 'Help distribute accurate, up-to-date health information',
            'who': ['ordinary_person'],
            'time': 'immediate'
        },
        {
            'category': 'RESEARCH',
            'headline': 'Learn symptoms and prevention',
            'description': 'Understand the condition to protect yourself and family',
            'who': ['ordinary_person'],
            'time': 'immediate'
        },
        {
            'category': 'PREPARATION',
            'headline': 'Ensure medication supplies',
            'description': 'Check you have necessary prescriptions and basic medical supplies',
            'who': ['ordinary_person'],
            'time': 'short_term'
        },
    ],
    'economic': [
        {
            'category': 'INFORMATION',
            'headline': 'Share job training resources',
            'description': 'Help affected workers find retraining programs',
            'who': ['ordinary_person', 'organization'],
            'time': 'short_term'
        },
        {
            'category': 'ADVOCACY',
            'headline': 'Contact elected representatives',
            'description': 'Urge policymakers to enact economic support measures',
            'who': ['ordinary_person'],
            'time': 'short_term'
        },
    ]
}

def generate_interventions(problem: ProblemReport, severity: SeverityScore, conn) -> list[Intervention]:
    """Generate targeted interventions for a problem."""
    
    # Get appropriate templates based on event_type
    event_type = get_event_type_for_problem(problem)
    templates = INTERVENTION_TEMPLATES.get(event_type, INTERVENTION_TEMPLATES.get('economic', []))
    
    interventions = []
    for i, template in enumerate(templates):
        # Adjust confidence based on severity and evidence quality
        base_confidence = 0.6 if severity.confidence > 0.7 else 0.4
        
        # Add Gemma-generated specific details
        specific_details = generate_specifics(template, problem, conn)
        
        interventions.append(Intervention(
            intervention_id=f"int_{problem.problem_id}_{i}",
            problem_id=problem.problem_id,
            category=template['category'],
            headline=f"{template['headline']} ({problem.headline})",
            description=f"{template['description']}\n\n{specific_details.get('context', '')}",
            who_can_do=template['who'],
            expected_benefit=specific_details.get('benefit', 'Unknown'),
            expected_cost=specific_details.get('cost', 'Unknown'),
            risks=specific_details.get('risks', []),
            prerequisites=specific_details.get('prerequisites', []),
            success_metrics=template.get('metrics', []),
            confidence=base_confidence,
            evidence=[],  # TODO: Link to evidence articles
            time_horizon=template.get('time', 'short_term')
        ))
    
    return interventions

def generate_specifics(template: dict, problem: ProblemReport, conn) -> dict:
    """Use Gemma to generate specific details for an intervention."""
    # TODO: Implement Gemma call
    # This would ask Gemma to provide:
    # - Specific organizations working on this
    # - Specific actions to take
    # - Specific risks to watch for
    # - Specific cost estimates
    return {}
```

#### Algorithm 4: Resource Matcher

```python
"""resource_matcher.py — matches available resources to problems.

Data sources:
- Organizations mentioned in event articles
- User skills (from interaction patterns - opt-in only)
- Local NGO databases
- Government agency announcements
"""
from dataclasses import dataclass
from typing import Optional

@dataclass
class ResourceMatch:
    resource_id: str
    resource_type: str  # 'organization', 'person', 'fund', 'material'
    resource_name: str
    capability: str
    location: str
    contact_info: Optional[str]
    relevance_score: float
    match_reason: str

def match_resources_to_problem(problem_id: str, conn) -> list[ResourceMatch]:
    """Find resources that could help with a specific problem."""
    with conn.cursor() as cur:
        # Get problem details
        cur.execute("SELECT * FROM news_problems WHERE problem_id = %s", (problem_id,))
        problem = cur.fetchone()
        
        if not problem:
            return []
        
        # Find organizations mentioned in related events
        cur.execute("""
            SELECT DISTINCT e.name, e.type, l.place_name, l.country,
                   COUNT(DISTINCT a.id) AS mention_count
            FROM news_entities e
            JOIN news_event_entities ee ON ee.entity_id = e.id
            JOIN news_events ev ON ev.id = ee.event_id
            JOIN news_articles a ON a.id = ANY(ev.article_ids)
            WHERE ev.id = ANY(%s)
              AND e.type IN ('organization', 'company', 'ngo', 'government')
            GROUP BY e.name, e.type, l.place_name, l.country
            ORDER BY mention_count DESC
            LIMIT 20
        """, (problem['evidence_events'],))
        
        matches = []
        for org in cur.fetchall():
            # Score relevance based on:
            # 1. Geographic proximity to problem
            # 2. Organization type (NGO > government > company for humanitarian)
            # 3. Mention frequency
            geo_score = calculate_geo_score(org['place_name'], problem['location_id'])
            type_score = {'ngo': 1.0, 'government': 0.8, 'company': 0.5}.get(org['type'], 0.3)
            mention_score = min(1.0, org['mention_count'] / 10)
            
            relevance = (geo_score * 0.4 + type_score * 0.3 + mention_score * 0.3)
            
            matches.append(ResourceMatch(
                resource_id=f"res_{org['name']}_{org['place_name']}",
                resource_type='organization',
                resource_name=org['name'],
                capability='To be extracted from articles',  # TODO: Use Gemma
                location=f"{org['place_name']}, {org['country']}",
                contact_info=None,  # TODO: Find official contact
                relevance_score=relevance,
                match_reason=f"Mentioned {org['mention_count']} times in related coverage"
            ))
        
        return sorted(matches, key=lambda x: x.relevance_score, reverse=True)
```

#### Algorithm 5: Collaboration Graph Builder

```python
"""collaboration_graph.py — finds potential partnerships between organizations.

Logic:
- Extract organizations from events
- Identify shared goals/themes between them
- Find geographic proximity
- Suggest collaboration with evidence
"""
from dataclasses import dataclass

@dataclass
class CollaborationOpportunity:
    org_a: str
    org_b: str
    shared_interest: str
    evidence: list[str]
    proximity_score: float
    feasibility: str  # 'high', 'medium', 'low'

def find_collaborations(event_id: int, conn) -> list[CollaborationOpportunity]:
    """Find organizations that could collaborate on an event."""
    with conn.cursor() as cur:
        # Get all organizations from this event and related events
        cur.execute("""
            SELECT DISTINCT e.name, e.type, l.lat, l.lng, l.country,
                   ARRAY_AGG(DISTINCT t.slug) AS topics
            FROM news_entities e
            JOIN news_event_entities ee ON ee.entity_id = e.id
            JOIN news_events ev ON ev.id = ee.event_id
            JOIN news_locations l ON l.id = ev.primary_location_id
            LEFT JOIN news_event_topics et ON et.event_id = ev.id
            LEFT JOIN news_topics t ON t.id = et.topic_id
            WHERE ev.id = %s OR ev.related_event_id = %s
              AND e.type IN ('organization', 'company', 'ngo', 'government', 'university')
            GROUP BY e.name, e.type, l.lat, l.lng, l.country
        """, (event_id, event_id))
        
        orgs = list(cur.fetchall())
        
        collaborations = []
        for i, org_a in enumerate(orgs):
            for org_b in orgs[i+1:]:
                # Calculate shared topics
                shared = set(org_a['topics']) & set(org_b['topics'])
                
                if len(shared) >= 1:
                    # Calculate geographic proximity
                    if org_a['lat'] and org_b['lat']:
                        dist = haversine(org_a['lat'], org_a['lng'], org_b['lat'], org_b['lng'])
                        prox_score = max(0, 1 - dist / 1000)  # 1000km = 0
                    else:
                        prox_score = 0.5  # unknown
                    
                    collaborations.append(CollaborationOpportunity(
                        org_a=org_a['name'],
                        org_b=org_b['name'],
                        shared_interest=', '.join(shared),
                        evidence=[],  # TODO: Link to articles
                        proximity_score=prox_score,
                        feasibility='medium' if prox_score > 0.5 else 'low'
                    ))
        
        return sorted(collaborations, key=lambda x: x.proximity_score, reverse=True)
```

#### Algorithm 6: Outcome Predictor

```python
"""outcome_predictor.py — predicts likely consequences of events.

Uses Gemma to reason about:
- Immediate effects (casualties, damage)
- Secondary effects (economic, social)
- Long-term consequences
- Potential solutions and their likely success
"""
from dataclasses import dataclass
from typing import Optional

@dataclass
class OutcomePrediction:
    prediction_id: str
    event_id: int
    outcome_type: str  # 'immediate', 'secondary', 'long_term'
    description: str
    probability: float  # 0-1
    timeframe: str  # 'hours', 'days', 'weeks', 'months', 'years'
    confidence: float
    uncertainty_reasons: list[str]
    evidence: list[str]

PREDICTION_PROMPT = """You are XYZO's outcome prediction engine.

Given this event:
Headline: {headline}
Summary: {summary}
Location: {location}
Event Type: {event_type}
First Reported: {first_reported}

Predict the most likely outcomes. Consider:
1. Immediate effects (0-48 hours)
2. Secondary effects (days to weeks)
3. Long-term consequences (months to years)

For each outcome:
- What exactly will happen?
- How likely is it? (high/medium/low)
- When will it occur?
- What could change this prediction?

Return JSON:
{{
  "outcomes": [
    {{
      "type": "immediate|secondary|long_term",
      "description": "...",
      "probability": 0.0-1.0,
      "timeframe": "hours|days|weeks|months|years",
      "confidence": 0.0-1.0,
      "uncertainty_reasons": ["..."]
    }}
  ]
}}
"""

def predict_outcomes(event_id: int, conn) -> list[OutcomePrediction]:
    """Predict outcomes for an event using Gemma."""
    with conn.cursor() as cur:
        cur.execute("""
            SELECT e.*, l.place_name, l.country
            FROM news_events e
            JOIN news_locations l ON l.id = e.primary_location_id
            WHERE e.id = %s
        """, (event_id,))
        event = cur.fetchone()
        
        if not event:
            return []
        
        # Call Gemma with structured prompt
        prompt = PREDICTION_PROMPT.format(
            headline=event['headline'],
            summary=event['summary'],
            location=f"{event['place_name']}, {event['country']}",
            event_type=event['event_type'],
            first_reported=event['first_reported_at']
        )
        
        # TODO: Call Gemma and parse response
        # gemma_response = call_gemma(prompt)
        # predictions = parse_json_response(gemma_response)
        
        return []
```

#### Algorithm 7: Outcome Evaluator

```python
"""outcome_evaluator.py — compares predictions against reality.

This is the LEARNING loop. It compares:
- What we predicted would happen
- What actually happened
- How accurate were we?
- What did we learn?
"""
from dataclasses import dataclass
from datetime import datetime

@dataclass
class OutcomeEvaluation:
    prediction_id: str
    predicted_outcome: str
    actual_outcome: str
    prediction_correct: bool  # TODO: Make this nuanced
    accuracy_score: float  # 0-1
    deviation_description: str  # How far off?
    lessons_learned: list[str]
    evaluated_at: datetime

def evaluate_predictions(event_id: int, conn) -> list[OutcomeEvaluation]:
    """Compare past predictions for this event against current reality."""
    
    # Get event's original predictions
    with conn.cursor() as cur:
        cur.execute("""
            SELECT * FROM news_event_predictions
            WHERE event_id = %s
            ORDER BY created_at ASC
        """, (event_id,))
        predictions = list(cur.fetchall())
        
        # Get current event state
        cur.execute("""
            SELECT e.*, 
                   COUNT(DISTINCT es.article_id) AS current_source_count,
                   l.place_name
            FROM news_events e
            LEFT JOIN news_event_sources es ON es.event_id = e.id
            LEFT JOIN news_locations l ON l.id = e.primary_location_id
            WHERE e.id = %s
            GROUP BY e.id, l.place_name
        """, (event_id,))
        current = cur.fetchone()
        
        evaluations = []
        for pred in predictions:
            # Evaluate each prediction
            actual = extract_actual_outcome(current, pred, conn)
            evaluation = compare_prediction(pred, actual, conn)
            evaluations.append(evaluation)
            
            # Store evaluation
            store_evaluation(evaluation, conn)
        
        return evaluations

def compare_prediction(prediction: dict, actual: dict, conn) -> OutcomeEvaluation:
    """Compare prediction to actual outcome."""
    # Use Gemma to assess accuracy
    # TODO: Implement with Gemma
    
    return OutcomeEvaluation(
        prediction_id=prediction['id'],
        predicted_outcome=prediction['description'],
        actual_outcome=actual['description'],
        prediction_correct=None,  # TODO
        accuracy_score=0.0,  # TODO
        deviation_description="",  # TODO
        lessons_learned=[],  # TODO
        evaluated_at=datetime.now()
    )
```

#### Algorithm 8: Opportunity Detector

```python
"""opportunity_detector.py — finds opportunities hidden in news.

Types of opportunities:
- Business: new markets, gaps in supply, emerging needs
- Employment: skills in demand, growing sectors, hiring companies
- Educational: scholarships, new programs, emerging fields
- Financial: market gaps, investment areas, microfinance needs
- Social: community needs, collaboration opportunities
"""
from dataclasses import dataclass
from typing import Optional

@dataclass
class Opportunity:
    opportunity_id: str
    category: str  # 'business', 'employment', 'education', 'financial', 'social'
    headline: str
    description: str
    location: str
    estimated_size: Optional[str]  # e.g., "$5B market", "1000 jobs"
    source_event_id: int
    action_recommendation: str
    confidence: float

OPPORTUNITY_PATTERNS = {
    'business': [
        ('supply shortage', 'supply_chain_gap'),
        ('new regulation creates opportunity', 'regulatory_opportunity'),
        ('expanding market', 'market_growth'),
        ('infrastructure investment', 'infrastructure_deal'),
    ],
    'employment': [
        ('hiring surge', 'job_creation'),
        ('skills gap identified', 'training_opportunity'),
        ('new industry emerging', 'sector_growth'),
        ('remote work expansion', 'flexible_work'),
    ],
    'education': [
        ('new scholarship program', 'scholarship'),
        ('university partnership', 'academic_collaboration'),
        ('online learning expansion', 'elearning'),
        ('vocational training initiative', 'vocational'),
    ]
}

def detect_opportunities(event_id: int, conn) -> list[Opportunity]:
    """Find opportunities related to an event."""
    with conn.cursor() as cur:
        # Get event details
        cur.execute("""
            SELECT e.*, l.place_name, l.country
            FROM news_events e
            JOIN news_locations l ON l.id = e.primary_location_id
            WHERE e.id = %s
        """, (event_id,))
        event = cur.fetchone()
        
        opportunities = []
        
        # Pattern match against article content
        cur.execute("""
            SELECT a.id, a.title, a.body, a.summary
            FROM news_articles a
            JOIN news_event_sources es ON es.article_id = a.id
            WHERE es.event_id = %s
        """, (event_id,))
        articles = list(cur.fetchall())
        
        for article in articles:
            text = f"{article['title']} {article['body'][:1000]}"
            
            for category, patterns in OPPORTUNITY_PATTERNS.items():
                for keyword, opp_type in patterns:
                    if keyword.lower() in text.lower():
                        opp = create_opportunity(
                            category=category,
                            opp_type=opp_type,
                            article=article,
                            event=event
                        )
                        if opp:
                            opportunities.append(opp)
        
        return opportunities

def create_opportunity(category: str, opp_type: str, article: dict, event: dict) -> Opportunity:
    """Create an opportunity record from pattern match."""
    # TODO: Use Gemma to extract details
    
    templates = {
        'supply_chain_gap': {
            'headline': 'Supply chain opportunity in {location}',
            'action': 'Investigate local manufacturing or distribution opportunities'
        },
        'job_creation': {
            'headline': 'Hiring surge in {location}',
            'action': 'Prepare application materials for growing sector'
        },
        'scholarship': {
            'headline': 'Educational funding available in {location}',
            'action': 'Research eligibility and application requirements'
        }
    }
    
    template = templates.get(opp_type, {
        'headline': f'Opportunity in {event.get("place_name", "unknown")}',
        'action': 'Investigate further'
    })
    
    return Opportunity(
        opportunity_id=f"opp_{article['id']}_{opp_type}",
        category=category,
        headline=template['headline'].format(location=event.get('place_name', 'unknown')),
        description=article.get('summary', article.get('title', ''))[:500],
        location=f"{event.get('place_name', '')}, {event.get('country', '')}",
        estimated_size=None,  # TODO: Extract from Gemma
        source_event_id=event['id'],
        action_recommendation=template['action'],
        confidence=0.6
    )
```

### Category B: Action Systems (9-16)

#### Algorithm 9: Action Ranker

```python
"""action_ranker.py — ranks interventions by likely effectiveness.

Factors:
- Problem severity × intervention reach
- Cost/benefit ratio
- Prerequisite availability
- Historical success in similar situations
- Time sensitivity
"""
from dataclasses import dataclass

@dataclass
class RankedAction:
    intervention: Intervention
    rank: int
    composite_score: float
    score_breakdown: dict
    recommendation: str  # 'strongly_recommended', 'recommended', 'optional'

def rank_interventions(interventions: list[Intervention], problem: ProblemReport, conn) -> list[RankedAction]:
    """Rank interventions by expected effectiveness."""
    
    ranked = []
    for干预 in interventions:
        scores = {
            'severity_match': calculate_severity_match(干预, problem),
            'reach': calculate_reach(干预),
            'feasibility': calculate_feasibility(干预),
            'speed': calculate_speed(干预),
            'past_success': lookup_historical_success(干预, conn)
        }
        
        # Weighted composite
        composite = (
            scores['severity_match'] * 0.30 +
            scores['reach'] * 0.20 +
            scores['feasibility'] * 0.25 +
            scores['speed'] * 0.10 +
            scores['past_success'] * 0.15
        )
        
        if composite >= 0.7:
            recommendation = 'strongly_recommended'
        elif composite >= 0.5:
            recommendation = 'recommended'
        else:
            recommendation = 'optional'
        
        ranked.append(RankedAction(
            intervention=干预,
            rank=0,  # Will be set after sorting
            composite_score=composite,
            score_breakdown=scores,
            recommendation=recommendation
        ))
    
    # Sort by composite score
    ranked.sort(key=lambda x: x.composite_score, reverse=True)
    
    # Assign ranks
    for i, r in enumerate(ranked):
        r.rank = i + 1
    
    return ranked
```

#### Algorithm 10: Personal Relevance Calculator

```python
"""personal_relevance.py — matches actions to individual users.

Matches based on:
- Geographic proximity (user location vs event location)
- Topic interests (from interaction patterns)
- Skills (from interaction patterns - opt-in)
- Past behavior (what actions user has taken before)
"""
from dataclasses import dataclass
from typing import Optional

@dataclass
class PersonalAction:
    intervention: Intervention
    relevance_score: float
    personal_angle: str  # Why this matters to YOU specifically
    proximity: Optional[str]  # "in your city", "in your region", "globally"
    suggested_action: str

def calculate_personal_relevance(
    user_id: str,
    intervention: Intervention,
    conn
) -> PersonalAction:
    """Calculate how relevant an intervention is for a specific user."""
    
    with conn.cursor() as cur:
        # Get user's location (from session, with consent)
        cur.execute("""
            SELECT home_lat, home_lng, home_city, home_country
            FROM news_user_locations
            WHERE session_id = %s
        """, (user_id,))
        user_loc = cur.fetchone()
        
        # Get user's topic interests
        cur.execute("""
            SELECT topic_interest, country_interest
            FROM nn_session_features
            WHERE session_id = %s
            ORDER BY snapshot_at DESC
            LIMIT 1
        """, (user_id,))
        interests = cur.fetchone()
        
        # Get event location
        cur.execute("""
            SELECT l.lat, l.lng, l.place_name, l.country
            FROM news_events e
            JOIN news_locations l ON l.id = e.primary_location_id
            WHERE e.id = %s
        """, (intervention.problem_id.split('_')[1]))  # TODO: Fix this hack
        event_loc = cur.fetchone()
        
        # Calculate scores
        geo_score = 0.0
        if user_loc and event_loc:
            dist = haversine(user_loc['home_lat'], user_loc['home_lng'],
                           event_loc['lat'], event_loc['lng'])
            if dist < 50:
                proximity = f"in {user_loc['home_city']}"
                geo_score = 1.0
            elif dist < 200:
                proximity = "in your region"
                geo_score = 0.7
            elif dist < 1000:
                proximity = "in your country"
                geo_score = 0.4
            else:
                proximity = "internationally"
                geo_score = 0.2
        else:
            proximity = "wherever you are"
            geo_score = 0.3
        
        # Interest match
        topic_score = 0.5  # TODO: Calculate from interests
        
        # Composite relevance
        relevance = geo_score * 0.6 + topic_score * 0.4
        
        # Personal angle generation
        personal_angle = generate_personal_angle(intervention, user_loc, interests)
        
        return PersonalAction(
            intervention=intervention,
            relevance_score=relevance,
            personal_angle=personal_angle,
            proximity=proximity,
            suggested_action=intervention.headline
        )
```

#### Algorithm 11: Skill-to-Job Matcher

```python
"""skill_matcher.py — matches user skills to job opportunities from news.

Extracts from news:
- Companies hiring
- Skills in demand
- Salary ranges (if mentioned)
- Requirements
- Growth projections
"""
from dataclasses import dataclass
from typing import Optional

@dataclass
class JobOpportunity:
    job_id: str
    title: str
    company: str
    location: str
    skills_required: list[str]
    skills_match_score: float  # How well user matches
    salary_range: Optional[str]
    source_article_id: int
    growth_outlook: str  # 'growing', 'stable', 'declining'

def match_skills_to_jobs(
    user_skills: list[str],
    user_location: Optional[tuple[float, float]],
    window_days: int = 7,
    conn=None
) -> list[JobOpportunity]:
    """Find job opportunities matching user's skill profile."""
    
    # Get articles mentioning jobs/hiring
    with conn.cursor() as cur:
        cur.execute("""
            SELECT a.id, a.title, a.body, a.summary, l.place_name, l.country
            FROM news_articles a
            LEFT JOIN news_locations l ON l.id = a.location_id
            WHERE a.published_at > NOW() - INTERVAL '%s days'
              AND a.event_type IN ('business', 'technology', 'economy')
              AND (a.body ILIKE '%hiring%' OR a.body ILIKE '%job%' OR a.body ILIKE '%career%')
            LIMIT 100
        """, (window_days,))
        
        opportunities = []
        for article in cur.fetchall():
            job = extract_job_opportunity(article)
            if job:
                # Calculate match score
                job.skills_match_score = calculate_match(user_skills, job.skills_required)
                opportunities.append(job)
        
        # Sort by match score
        opportunities.sort(key=lambda x: x.skills_match_score, reverse=True)
        
        return opportunities[:20]

def extract_job_opportunity(article: dict) -> Optional[JobOpportunity]:
    """Use Gemma to extract job details from article."""
    # TODO: Implement with Gemma
    
    prompt = f"""Extract job/career information from this news article.

Title: {article['title']}
Content: {article['body'][:2000]}

If this article mentions job opportunities, extract:
- Job title(s)
- Company/organization
- Location
- Skills in demand
- Salary range (if mentioned)
- Growth outlook

Return JSON:
{{
  "jobs": [
    {{
      "title": "...",
      "company": "...",
      "location": "...",
      "skills": ["..."],
      "salary": "...",
      "outlook": "growing|stable|declining"
    }}
  ]
}}

If no job opportunities, return {{"jobs": []}}
"""
    
    # TODO: Call Gemma
    return None
```

#### Algorithm 12: Daily Briefing Generator

```python
"""daily_briefing.py — generates personalized daily intelligence briefing.

Sections:
- LEARN: One insight worth understanding today
- ACT: One immediate action
- CONNECT: One person/org worth knowing
- WORK: Relevant opportunities
- CREATE: Something to build
- BUY/SELL: Market opportunities
- HELP: How to contribute
- THINK: Important question
- WATCH: Developing situation
- VERIFY: Claim needing fact-check
"""
from dataclasses import dataclass
from datetime import datetime

@dataclass
class DailyBriefing:
    user_id: str
    generated_at: datetime
    learn: BriefingItem
    act: BriefingItem
    connect: BriefingItem
    work: list[BriefingItem]
    create: BriefingItem
    buy: Optional[BriefingItem]
    sell: Optional[BriefingItem]
    help: BriefingItem
    think: BriefingItem
    watch: BriefingItem
    verify: BriefingItem

@dataclass
class BriefingItem:
    headline: str
    description: str
    evidence: list[str]
    action_link: Optional[str]
    confidence: float

def generate_briefing(user_id: str, conn) -> DailyBriefing:
    """Generate personalized daily briefing for user."""
    
    with conn.cursor() as cur:
        # Get user's interests and location
        cur.execute("""
            SELECT topic_interest, country_interest, home_country, home_city
            FROM nn_session_features
            WHERE session_id = %s
            ORDER BY snapshot_at DESC
            LIMIT 1
        """, (user_id,))
        user = cur.fetchone()
        
        if not user:
            # Default briefing for unknown users
            return generate_default_briefing()
        
        # Get today's top stories matching user interests
        cur.execute("""
            SELECT e.id, e.headline, e.summary, e.event_type,
                   l.place_name, l.country,
                   COUNT(DISTINCT es.article_id) AS source_count
            FROM news_events e
            JOIN news_locations l ON l.id = e.primary_location_id
            LEFT JOIN news_event_sources es ON es.event_id = e.id
            WHERE e.status = 'active'
              AND e.first_reported_at > NOW() - INTERVAL '24 hours'
            GROUP BY e.id, e.headline, e.summary, e.event_type, l.place_name, l.country
            ORDER BY source_count DESC
            LIMIT 50
        """)
        today_events = list(cur.fetchall())
        
        # Score events by user relevance
        scored = []
        for event in today_events:
            score = calculate_event_relevance(event, user)
            scored.append((event, score))
        
        scored.sort(key=lambda x: x[1], reverse=True)
        
        # Build briefing items
        briefing = DailyBriefing(
            user_id=user_id,
            generated_at=datetime.now(),
            learn=generate_learn_item(scored[:10]),
            act=generate_act_item(scored[:5]),
            connect=generate_connect_item(scored[:10]),
            work=generate_work_items(scored[:20]),
            create=generate_create_item(scored[:10]),
            buy=None,  # TODO
            sell=None,  # TODO
            help=generate_help_item(scored[:10]),
            think=generate_think_item(scored[:10]),
            watch=generate_watch_item(today_events),
            verify=generate_verify_item(conn)
        )
        
        return briefing

def calculate_event_relevance(event: dict, user: dict) -> float:
    """Calculate how relevant an event is for a user."""
    score = 0.0
    
    # Country match
    countries = user.get('country_interest', {})
    if event['country'] in countries:
        score += countries[event['country']] * 0.4
    
    # Topic match
    topics = user.get('topic_interest', {})
    if event['event_type'] in topics:
        score += topics[event['event_type']] * 0.4
    
    # Recency bonus
    score += 0.2
    
    return score
```

#### Algorithm 13-16: (Continue for Cross-Cultural Bridge Builder, Peace Process Tracker, Environmental Early Warning, etc.)

---

## 3. Gemma4 Programming Patterns

### Pattern 1: Structured JSON Extraction

```python
"""Gemma structured extraction pattern.

Key principles:
1. System prompt defines exact JSON schema
2. User prompt provides context + evidence
3. Validate output before using it
4. Log failures for learning
"""
import json
import httpx

GEMMA_URL = "http://192.168.1.3:8888/chat/stream"
TIMEOUT = 25

EXTRACTION_PROMPT = """You are a structured data extraction engine.

Extract information from the article and respond with ONLY valid JSON.
No prose, no markdown, no explanations outside the JSON.

Required schema:
{{
  "summary": "1-2 sentence neutral summary",
  "location_text": "most specific location for main event",
  "event_type": "one of: politics|business|crime|weather|science|technology|sports|culture|environment|conflict|health|disaster|humanitarian|maritime|cyclone|sea_level|coral_reef|other",
  "entities": ["person/org names"],
  "topic_tags": ["3-6 topic tags"],
  "severity": {{"score": 0.0-1.0, "evidence": ["reasons"]}},
  "causes": ["possible causes"],
  "effects": ["possible effects"]
}}

Rules:
- location_text must be a geocodable place name
- If no clear location, use null
- Be conservative — only extract what is clearly stated
- event_type must match known categories exactly

Article:
Title: {title}
Body: {body}
"""

def extract_structured(title: str, body: str) -> dict | None:
    """Extract structured data using Gemma."""
    
    prompt = EXTRACTION_PROMPT.format(title=title, body=body[:2500])
    
    try:
        response = call_gemma_streaming(prompt)
        data = parse_first_json(response)
        
        if data and validate_extraction(data):
            return data
        else:
            log.warning("Invalid Gemma extraction, using fallback")
            return fallback_extraction(title, body)
            
    except Exception as e:
        log.error("Gemma extraction failed: %s", e)
        return fallback_extraction(title, body)

def validate_extraction(data: dict) -> bool:
    """Validate extraction meets schema requirements."""
    required_fields = ['summary', 'event_type']
    for field in required_fields:
        if field not in data:
            return False
    
    valid_types = ['politics', 'business', 'crime', 'weather', 'science',
                   'technology', 'sports', 'culture', 'environment', 'conflict',
                   'health', 'disaster', 'humanitarian', 'maritime', 'cyclone',
                   'sea_level', 'coral_reef', 'other']
    if data.get('event_type') not in valid_types:
        return False
    
    return True
```

### Pattern 2: Reasoning with Evidence Chains

```python
"""Gemma reasoning pattern for causal analysis.

Shows Gemma how to reason step-by-step with evidence.
"""
REASONING_PROMPT = """You are XYZO's causal reasoning engine.

Given an event and evidence, identify probable causes and effects.
Show your reasoning step by step.

Event: {event_headline}
Location: {location}
Type: {event_type}

Evidence from {num_sources} sources:
{evidence_text}

Your task:
1. Identify the MOST LIKELY cause (if determinable from evidence)
2. Identify 2-3 POSSIBLE causes (if uncertain)
3. Identify IMMEDIATE effects (hours to days)
4. Identify SECONDARY effects (weeks to months)
5. Identify UNCERTAINTIES (what we don't know)

Confidence levels:
- HIGH: Multiple independent sources confirm
- MEDIUM: Single source or ambiguous evidence
- LOW: Speculation or very weak evidence

Return JSON:
{{
  "primary_cause": {{
    "description": "...",
    "confidence": "HIGH|MEDIUM|LOW",
    "supporting_evidence": ["source excerpts"],
    "alternative_explanations": ["..."]
  }},
  "possible_causes": [
    {{
      "description": "...",
      "likelihood": "HIGH|MEDIUM|LOW",
      "evidence": ["..."]
    }}
  ],
  "immediate_effects": [
    {{
      "effect": "...",
      "confidence": "HIGH|MEDIUM|LOW",
      "timescale": "hours|days"
    }}
  ],
  "secondary_effects": [
    {{
      "effect": "...",
      "confidence": "HIGH|MEDIUM|LOW",
      "timescale": "weeks|months"
    }}
  ],
  "key_uncertainties": ["..."],
  "reasoning_chain": ["step1", "step2", "step3"]
}}
"""
```

### Pattern 3: Action Recommendation with Constraints

```python
"""Gemma action recommendation with safety constraints.

Key: Gemma suggests, human approves, system tracks outcomes.
"""
ACTION_RECOMMENDATION_PROMPT = """You are XYZO's action recommendation engine.

Given a problem and available evidence, generate actionable recommendations.
Follow these constraints STRICTLY:

SAFETY RULES:
1. NEVER recommend actions that could directly harm people
2. NEVER recommend donating to specific bank accounts (scam risk)
3. ALWAYS suggest verifying organizations before acting
4. For medical actions, ALWAYS suggest consulting professionals
5. For legal actions, ALWAYS suggest consulting lawyers
6. NEVER guarantee outcomes — use "may help" not "will solve"

CATEGORIES:
- INFORMATION: Share facts, raise awareness
- FINANCIAL: Donate, invest, tip (always with verification)
- VOLUNTEER: Time, skills (always through verified orgs)
- ADVOCACY: Contact representatives, sign petitions
- PREPARATION: Steps to reduce future impact
- LEARN: Skills to develop

PROBLEM:
{problem_description}
Location: {location}
Severity: {severity}/10
Urgency: {urgency}/10

EVIDENCE:
{evidence_text}

ORGANIZATIONS MENTIONED:
{organizations}

For each recommendation:
1. Category
2. Specific action (what exactly to do)
3. Who can do it (ordinary person / org / government)
4. Expected benefit (be realistic, not optimistic)
5. Risks (what could go wrong)
6. Verification steps (how to avoid scams)
7. Confidence (HIGH if verified org, MEDIUM if suggested by single source)

Return JSON:
{{
  "recommendations": [
    {{
      "category": "INFORMATION|FINANCIAL|VOLUNTEER|ADVOCACY|PREPARATION|LEARN",
      "action": "Specific action to take",
      "who": "who can do this",
      "expected_benefit": "realistic description",
      "risks": ["risk1", "risk2"],
      "verification_steps": ["step1", "step2"],
      "confidence": "HIGH|MEDIUM|LOW",
      "requires_professional_advice": true|false
    }}
  ],
  "do_not_recommend": [
    {{
      "action": "...",
      "reason": "why not"
    }}
  ]
}}
"""
```

### Pattern 4: Multi-Perspective Analysis

```python
"""Gemma multi-perspective analysis for complex events.

Analyzes events through different lenses without imposing single worldview.
"""
MULTI_PERSPECTIVE_PROMPT = """You are a multi-perspective analysis engine.

Analyze this event through different lenses. Represent each perspective
fairly without imposing single interpretation.

EVENT:
{event_headline}
{event_summary}
Location: {location}

LENSES TO ANALYZE:
1. SCIENTIFIC: What does empirical evidence say?
2. ECONOMIC: What are the financial impacts and incentives?
3. SOCIAL: How are different communities affected?
4. POLITICAL: What are the power dynamics and governance aspects?
5. CULTURAL: What traditions, values, or beliefs shape interpretation?
6. HISTORICAL: How does this compare to similar past events?
7. SPIRITUAL/PHILOSOPHICAL: What deeper meanings or ethical questions arise?

Rules:
- Present each lens WITHOUT taking sides
- Acknowledge uncertainty where it exists
- Do not conflate different types of evidence
- Scientific claims ≠ spiritual claims
- Show respect for different viewpoints

Return JSON:
{{
  "scientific_perspective": {{
    "summary": "...",
    "evidence_quality": "HIGH|MEDIUM|LOW",
    "key_uncertainties": ["..."]
  }},
  "economic_perspective": {{
    "summary": "...",
    "winners": ["..."],
    "losers": ["..."]
  }},
  "social_perspective": {{
    "summary": "...",
    "affected_groups": ["..."]
  }},
  "political_perspective": {{
    "summary": "...",
    "stakeholders": ["..."]
  }},
  "cultural_perspective": {{
    "summary": "...",
    "traditions_involved": ["..."]
  }},
  "historical_parallel": {{
    "comparable_event": "...",
    "similarities": ["..."],
    "differences": ["..."],
    "lessons": ["..."]
  }},
  "ethical_questions": ["..."]
}}
"""
```

---

## 4. Legal & Safety Framework

### The Serious Part (Made Fun) ⚖️😂

**Legal Classification:**

| Category | Examples | XYZO's Role | Risk Level |
|----------|----------|-------------|------------|
| **News Aggregation** | RSS feeds, event extraction | Display and organize | 🟢 Low |
| **Information Retrieval** | Location lookup, source matching | Help find things | 🟢 Low |
| **Educational Content** | Historical context, explainers | Inform and contextualize | 🟡 Medium |
| **Job/Economic Info** | Skills demand, market trends | Informational only | 🟡 Medium |
| **Health Information** | Symptom checking, medical news | Informational navigation | 🔴 High |
| **Financial Advice** | Investment recommendations | 🚫 NOT PROVIDED | 🔴 Very High |
| **Legal Advice** | Case conclusions, rights | 🚫 NOT PROVIDED | 🔴 Very High |
| **Medical Diagnosis** | AI diagnosing conditions | 🚫 NOT PROVIDED | 🔴 Very High |

### The Legal Fine Print (Fun Version)

```
WHAT WE ARE:
A very organized librarian with a map. 📚🗺️

WHAT WE ARE NOT:
- A lawyer (sorry, we can't tell you if you're allowed to do that)
- A doctor (we can't diagnose your cough, but we can tell you what
  news sources say about respiratory illness trends)
- A financial advisor (we can't tell you what to invest in, but we
  CAN show you which clean energy sectors are getting news coverage)
- Your mother (even she can't make you take your medicine)
```

### The Safety Architecture

```python
"""content_policy.py — risk classification for all content.

Every piece of content flows through this:
"""
from enum import Enum

class RiskLevel(Enum):
    LOW = "low"        # General information
    MEDIUM = "medium"  # Could influence decisions
    HIGH = "high"      # Affects health/finance/legal
    CRITICAL = "critical"  # Requires professional involvement

class ContentPolicy:
    # Health content rules
    HEALTH_RULES = {
        RiskLevel.LOW: [
            "General health news summaries",
            "Public health announcements from WHO/CDC",
            "Symptoms information from general sources",
            "Wellness trends and research findings"
        ],
        RiskLevel.HIGH: [
            "Personalized health recommendations",
            "Diagnosis suggestions",
            "Specific treatment recommendations",
            "Emergency medical advice"
        ]
    }
    
    # Financial content rules
    FINANCIAL_RULES = {
        RiskLevel.LOW: [
            "Market news and trends",
            "Economic indicators",
            "Public company news",
            "Job market statistics"
        ],
        RiskLevel.CRITICAL: [
            "Specific investment recommendations",
            "Personalized financial advice",
            "Credit/loan decisions",
            "Insurance advice"
        ]
    }
    
    # Required disclaimers by risk level
    DISCLAIMERS = {
        RiskLevel.MEDIUM: "This is for informational purposes only. "
                          "Consult a professional for advice.",
        RiskLevel.HIGH: "This information could affect important decisions. "
                        "Please consult a qualified professional before acting.",
        RiskLevel.CRITICAL: "This requires expert guidance. "
                           "XYZ0 cannot provide this type of advice."
    }

def classify_content(content_type: str, personalization: bool, 
                    stakes: str) -> RiskLevel:
    """Classify content risk level."""
    
    # Base classification by content type
    base_risk = {
        'news_summary': RiskLevel.LOW,
        'educational': RiskLevel.MEDIUM,
        'how_to': RiskLevel.MEDIUM,
        'health_info': RiskLevel.HIGH,
        'financial_info': RiskLevel.HIGH,
        'personalized_health': RiskLevel.CRITICAL,
        'personalized_financial': RiskLevel.CRITICAL,
        'medical_diagnosis': RiskLevel.CRITICAL,
        'legal_advice': RiskLevel.CRITICAL,
    }.get(content_type, RiskLevel.MEDIUM)
    
    # Increase risk if personalized
    if personalization and base_risk == RiskLevel.LOW:
        base_risk = RiskLevel.MEDIUM
    
    # Increase risk if high stakes mentioned
    if stakes in ('health', 'life', 'safety') and base_risk == RiskLevel.MEDIUM:
        base_risk = RiskLevel.HIGH
    
    return base_risk

def apply_policy(content: dict, risk_level: RiskLevel) -> dict:
    """Apply content policy to content."""
    
    if risk_level in (RiskLevel.CRITICAL,):
        # Block or heavily caveat
        content['action_allowed'] = False
        content['message'] = RiskLevel.DISCLAIMERS[risk_level]
        content['alternative'] = "Consult a qualified professional"
    
    elif risk_level == RiskLevel.HIGH:
        # Add strong disclaimer
        content['disclaimer'] = RiskLevel.DISCLAIMERS[risk_level]
        content['verify_instructions'] = "This information affects important decisions. "
                                        "Please verify with a qualified professional."
    
    elif risk_level == RiskLevel.MEDIUM:
        # Add mild disclaimer
        content['disclaimer'] = RiskLevel.DISCLAIMERS[risk_level]
    
    return content
```

### Privacy Framework

```python
"""privacy_policy.py — user privacy protection.

Principles:
1. Minimize data collection
2. Provide user control
3. Be transparent about what we know
4. Never sell behavioral profiles
5. Allow deletion
"""
from dataclasses import dataclass
from datetime import datetime

@dataclass
class PrivacySettings:
    allow_location_tracking: bool = False
    allow_interest_profiling: bool = False
    allow_personalization: bool = False
    allow_analytics: bool = True
    data_retention_days: int = 30

class PrivacyEngine:
    # What we collect (minimal)
    COLLECTED_DATA = {
        'session_id': 'Anonymous session identifier',
        'interactions': 'What articles/pins you clicked (aggregated)',
        'location': 'General area (city level, not precise)',
        'topic_interests': 'Derived from what you read (opt-in)',
    }
    
    # What we NEVER collect
    NEVER_COLLECT = {
        'personal_identifiers': 'Names, emails, phone numbers',
        'precise_location': 'GPS coordinates',
        'financial_data': 'Banking, credit card info',
        'health_data': 'Specific medical conditions',
        'religious_politics': 'Specific beliefs or affiliations',
    }
    
    def get_user_profile(self, session_id: str, conn) -> dict:
        """Get what we know about a user (transparency)."""
        
        with conn.cursor() as cur:
            cur.execute("""
                SELECT topic_interest, country_interest, home_city
                FROM nn_session_features
                WHERE session_id = %s
                ORDER BY snapshot_at DESC
                LIMIT 1
            """, (session_id,))
            
            result = cur.fetchone()
            
            return {
                'what_we_collect': self.COLLECTED_DATA,
                'what_we_never_collect': self.NEVER_COLLECT,
                'your_data': result or 'No data collected yet',
                'control_link': '/settings/privacy',
                'delete_link': '/settings/privacy/delete'
            }
    
    def delete_user_data(self, session_id: str, conn) -> bool:
        """Delete all data for a session (GDPR right to erasure)."""
        
        with conn.cursor() as cur:
            # Delete session features
            cur.execute("DELETE FROM nn_session_features WHERE session_id = %s", 
                       (session_id,))
            
            # Delete location data
            cur.execute("DELETE FROM news_user_locations WHERE session_id = %s",
                       (session_id,))
            
            # Delete interactions (anonymized)
            # Note: We keep aggregated analytics, not individual
            
            conn.commit()
            
        return True
```

---

## 5. Health Intelligence Framework

### The Health Disclaimer (Serious)

```
🩺 HEALTH INFORMATION NOTICE

XYZO provides health-related news and information for
EDUCATIONAL AND NAVIGATION PURPOSES ONLY.

We are NOT:
- A medical institution
- A healthcare provider
- A diagnostic service

We CANNOT:
- Diagnose medical conditions
- Prescribe treatments
- Replace professional medical advice

You SHOULD:
- Consult a qualified healthcare professional for any
  medical concerns
- Not use XYZO as a substitute for professional advice
- Verify health information from official sources (WHO, CDC,
  local health departments)

In case of medical emergency, contact emergency services immediately.
```

### Health Content Classification

```python
"""health_classifier.py — classify health content by actionability.

Health content types:
- NEWS: General health news reporting
- ALERT: Public health emergencies ( epidemics, recalls)
- EDUCATION: General health information
- NAVIGATION: Help finding healthcare resources
- GUIDANCE: Behavioral recommendations (when to see doctor)
"""
from enum import Enum

class HealthContentType(Enum):
    NEWS = "health_news"           # Report what happened
    ALERT = "health_alert"         # Urgent public health info
    EDUCATION = "health_education" # General health info
    NAVIGATION = "health_nav"      # Finding resources
    GUIDANCE = "health_guidance"   # When to seek help

class HealthContentPolicy:
    # What we allow by type
    ALLOWED_CONTENT = {
        HealthContentType.NEWS: [
            "Disease outbreak reports",
            "Health policy changes",
            "Medical research findings",
            "Healthcare system developments",
            "Public health statistics"
        ],
        HealthContentType.ALERT: [
            "WHO/CDC emergency declarations",
            "Vaccine recall notices",
            "Disease outbreak warnings",
            "Contamination alerts"
        ],
        HealthContentType.EDUCATION: [
            "General symptom information",
            "Prevention method explanations",
            "Health condition overviews",
            "Wellness recommendations (general)"
        ],
        HealthContentType.NAVIGATION: [
            "How to find healthcare providers",
            "What types of specialists exist",
            "Questions to ask your doctor",
            "How to understand medical bills"
        ],
        HealthContentType.GUIDANCE: [
            "When to seek emergency care",
            "Red flag symptoms that need attention",
            "Questions to discuss with doctor"
        ]
    }
    
    # What we NEVER provide (medical boundaries)
    FORBIDDEN_CONTENT = [
        "AI-generated diagnosis",
        "Specific treatment recommendations",
        "Medication dosage instructions",
        "Medical procedure advice without doctor",
        "Mental health crisis intervention (direct)"
    ]

def classify_health_content(article: dict) -> HealthContentType:
    """Classify health content type."""
    
    title = article.get('title', '').lower()
    body = article.get('body', '').lower()
    
    # Emergency keywords
    if any(kw in title for kw in ['emergency', 'outbreak', 'epidemic', 'pandemic', 
                                   'recall', 'contamination', 'alert']):
        return HealthContentType.ALERT
    
    # Navigation keywords
    if any(kw in body for kw in ['how to find', 'where to go', 'questions to ask',
                                  'understanding your']):
        return HealthContentType.NAVIGATION
    
    # Guidance keywords
    if any(kw in body for kw in ['when to see', 'warning signs', 'red flag',
                                  'seek medical attention', 'consult a']):
        return HealthContentType.GUIDANCE
    
    # Default to news
    return HealthContentType.NEWS

def process_health_content(article: dict, content_type: HealthContentType) -> dict:
    """Process health content with appropriate policy."""
    
    processed = article.copy()
    
    # Add standard health disclaimer
    processed['health_disclaimer'] = (
        "This information is for educational purposes only. "
        "It is not a substitute for professional medical advice. "
        "Consult a healthcare provider for any medical concerns."
    )
    
    # Add type-specific guidance
    if content_type == HealthContentType.GUIDANCE:
        processed['action'] = 'CONSULT_PROFESSIONAL'
        processed['urgency'] = assess_urgency(article)
        
    elif content_type == HealthContentType.ALERT:
        processed['action'] = 'STAY_INFORMED'
        processed['official_sources'] = get_official_sources(article)
    
    return processed

def assess_urgency(article: dict) -> str:
    """Assess if health content is urgent."""
    
    title = article.get('title', '').lower()
    
    urgent_keywords = ['emergency', 'urgent', 'immediate', 'critical', 
                      'outbreak', 'epidemic', 'pandemic']
    
    if any(kw in title for kw in urgent_keywords):
        return 'URGENT - Verify with official sources'
    
    return 'Non-urgent - General information'
```

---

## 6. Daily Personal Intelligence Briefing

### The Briefing Schema

```python
"""daily_briefing_schema.py — structured daily intelligence.

Generated daily for each user (opt-in) based on their interests.
"""
from dataclasses import dataclass, field
from datetime import datetime
from typing import Optional

@dataclass
class DailyBriefing:
    """Personalized daily intelligence briefing."""
    
    # Meta
    user_id: str
    generated_at: datetime
    period: str  # 'morning', 'evening'
    
    # Core sections
    learn: BriefingSection
    act: BriefingSection
    connect: BriefingSection
    work: list[BriefingSection] = field(default_factory=list)
    create: Optional[BriefingSection] = None
    buy: Optional[BriefingSection] = None
    sell: Optional[BriefingSection] = None
    help: BriefingSection
    think: BriefingSection
    watch: BriefingSection
    verify: Optional[BriefingSection] = None
    
    # Quality metrics
    relevance_score: float
    actionability_score: float
    freshness_score: float

@dataclass
class BriefingSection:
    """A single section of the briefing."""
    
    headline: str
    description: str
    evidence: list[str]  # Article/event IDs
    action_url: Optional[str] = None
    confidence: float = 0.5
    source_count: int = 0
    
    # Display
    icon: str = "📰"
    category: str = "general"

# Section generation functions
def generate_learn(user_id: str, events: list, interests: dict) -> BriefingSection:
    """LEARN: One insight worth understanding today."""
    
    # Find highest-quality explainer about user's interests
    best = find_best_explainer(events, interests)
    
    return BriefingSection(
        headline=f"Understanding: {best['topic']}",
        description=best['explanation'],
        evidence=best['source_ids'],
        icon="📚",
        category="education"
    )

def generate_act(user_id: str, events: list, location: dict) -> BriefingSection:
    """ACT: One immediate action someone could take today."""
    
    # Find most relevant urgent action
    intervention = find_most_actionable_intervention(events, location)
    
    return BriefingSection(
        headline=intervention.headline,
        description=intervention.description,
        evidence=intervention.evidence,
        action_url=intervention.action_url,
        icon="⚡",
        category="action"
    )

def generate_connect(user_id: str, events: list) -> BriefingSection:
    """CONNECT: One person/organization worth knowing."""
    
    org = find_notable_organization(events)
    
    return BriefingSection(
        headline=f"Meet: {org['name']}",
        description=org['description'],
        evidence=[org['source_id']],
        icon="🤝",
        category="connection"
    )

def generate_work(user_id: str, events: list, skills: list) -> list[BriefingSection]:
    """WORK: Relevant job/career opportunities."""
    
    opportunities = find_skill_matching_jobs(events, skills)
    
    return [
        BriefingSection(
            headline=opp['title'],
            description=opp['description'],
            evidence=[opp['source_id']],
            icon="💼",
            category="work"
        )
        for opp in opportunities[:3]
    ]

def generate_help(user_id: str, events: list, location: dict) -> BriefingSection:
    """HELP: How to contribute to a problem."""
    
    intervention = find_best_volunteer_opportunity(events, location)
    
    return BriefingSection(
        headline=f"Help with: {intervention.problem}",
        description=intervention.action_description,
        evidence=intervention.evidence,
        icon="❤️",
        category="volunteer"
    )

def generate_think(user_id: str, events: list) -> BriefingSection:
    """THINK: An important question or contradiction."""
    
    dilemma = find_intellectual_dilemma(events)
    
    return BriefingSection(
        headline=dilemma['question'],
        description=dilemma['context'],
        evidence=dilemma['sources'],
        icon="🤔",
        category="reflection"
    )

def generate_watch(user_id: str, events: list) -> BriefingSection:
    """WATCH: A developing situation to monitor."""
    
    developing = find_developing_situation(events)
    
    return BriefingSection(
        headline=f"Watching: {developing['situation']}",
        description=developing['why_matters'],
        evidence=developing['source_ids'],
        icon="👀",
        category="awareness"
    )
```

---

## 7. The 1000+ Ideas Roadmap

### Grand Mission 1: UNDERSTAND EARTH 🔬

| Category | Capabilities (10×10) |
|----------|---------------------|
| **Climate Science** | Temperature tracking, precipitation patterns, extreme weather analysis, climate modeling explanations, carbon cycle understanding, ocean acidification monitoring, glacier retreat visualization, emissions data tracking, climate agreement monitoring, renewable energy progress |
| **Ecology** | Biodiversity indices, ecosystem health monitoring, species migration tracking, habitat loss detection, invasive species alerts, pollination trends, food web analysis, conservation effectiveness, ecological corridor mapping, ecosystem service valuation |
| **Geology** | Seismic activity monitoring, volcanic activity tracking, tectonic plate analysis, mineral resource tracking, earthquake early warning, geological hazard mapping, soil health monitoring, groundwater levels, erosion tracking, geological research summaries |
| **Oceans** | Sea surface temperature, ocean current tracking, marine biodiversity, coral reef health, fishing pressure monitoring, plastic pollution tracking, sea level rise, ocean acidification, maritime shipping routes, deep sea exploration |
| **Atmosphere** | Air quality indices, ozone layer tracking, atmospheric composition, weather pattern analysis, storm tracking, pollution sources, greenhouse gas concentrations, solar activity, atmospheric rivers, space weather |
| **Water** | Freshwater availability, glacier melt rates, river flow monitoring, lake levels, water quality, desalination progress, wastewater treatment, irrigation efficiency, flood monitoring, drought tracking |
| **Energy** | Renewable capacity growth, grid stability, energy storage advances, nuclear developments, fossil fuel production, energy efficiency trends, smart grid development, electric vehicle adoption, hydrogen economy, carbon capture progress |
| **Agriculture** | Crop yields, food prices, soil health, irrigation trends, pesticide use, GM crop developments, sustainable agriculture, food waste, livestock trends, agricultural research |
| **Cities** | Urban growth, traffic patterns, housing affordability, public transit, green spaces, urban planning, city-level emissions, smart city developments, migration patterns, infrastructure needs |
| **Economics** | GDP trends, employment, inflation, trade flows, market movements, economic inequality, debt levels, monetary policy, fiscal health, economic forecasts |

### Grand Mission 2: HELP HUMANS WORK 💼

| Category | Capabilities |
|----------|-------------|
| **Job Intelligence** | Skills demand analysis, salary benchmarking, hiring trend detection, career path mapping, job market forecasting, gig economy tracking, remote work opportunities, sector growth analysis, job search optimization, interview preparation |
| **Entrepreneurship** | Business opportunity detection, market gap identification, competition analysis, funding source discovery, regulatory opportunity mapping, success pattern analysis, failure pattern analysis, networking facilitation, mentorship matching, business plan assistance |
| **Financial Literacy** | Budget guidance, savings strategies, debt management, investment basics, retirement planning, tax optimization, insurance understanding, credit building, financial goal setting, scam detection |
| **Education** | Learning path recommendations, course comparisons, certification tracking, skill gap analysis, scholarship discovery, mentorship programs, educational equity tracking, access gap analysis, teaching method research, lifelong learning |
| **Collaboration** | Partner finding, team building, communication tools, conflict resolution, decision making frameworks, meeting optimization, knowledge sharing, community building, network analysis, trust building |

### Grand Mission 3: SOLVE LOCAL PROBLEMS 🏘️

| Category | Capabilities |
|----------|-------------|
| **Disaster Response** | Early warning, resource matching, shelter coordination, donation routing, volunteer coordination, damage assessment, recovery tracking, resilience scoring |
| **Health Access** | Provider finding, cost comparison, insurance navigation, telemedicine access, mental health resources, preventive care promotion, health education, emergency services |
| **Housing** | Affordability tracking, vacancy detection, zoning analysis, affordable housing finding, roommate matching, housing market forecasting, gentrification tracking, eviction monitoring |
| **Transportation** | Traffic optimization, public transit routing, bike lane planning, walkability scoring, carpool matching, EV charging, infrastructure maintenance, safety analysis |
| **Local Economy** | Small business support, local spending impact, tourism promotion, economic development, job creation tracking, wage tracking, Main Street health |

### Grand Mission 4: IMPROVE GLOBAL COOPERATION 🕊️

| Category | Capabilities |
|----------|-------------|
| **Peace Building** | Conflict early warning, mediation opportunity detection, ceasefire monitoring, peace process tracking, cross-border cooperation, cultural bridge building, trust restoration |
| **Humanitarian** | Crisis detection, resource mobilization, aid coordination, refugee tracking, displaced person assistance, reconstruction planning, long-term development |
| **Governance** | Policy tracking, voting patterns, corruption detection, regulatory analysis, civic engagement, government performance, democratic health |
| **International** | Diplomatic tracking, treaty monitoring, summit analysis, UN activity, NGO coordination, development aid tracking |

### Grand Mission 5: UNDERSTAND EARTH SPIRITUALLY 🙏

| Category | Capabilities |
|----------|-------------|
| **Hindu Wisdom** | Dharma interpretation, karma understanding, yoga philosophy, Vedanta perspectives, Bhagavad Gita insights, Hindu responses to modern challenges |
| **Islamic Thought** | Tazkiyah purification, Islamic ethics, Sufi mysticism, Quranic guidance, Islamic economics, Muslim perspectives on contemporary issues |
| **Buddhist Insight** | Dharma teaching, meditation guidance, Buddhist ethics, mindfulness practice, Buddhist approaches to suffering |
| **Jewish Thought** | Torah insights, mitzvah practice, Jewish ethics, Holocaust memory, Israel/Diaspora dynamics |
| **Christian Theology** | Gospel teachings, Christian ethics, ecumenism, faith and science, church and society |
| **Indigenous Wisdom** | Traditional knowledge, earth stewardship, indigenous rights, cultural preservation |
| **Philosophical** | Ethics frameworks, existential questions, logic and reason, epistemology, metaphysics |
| **Interfaith** | Common ground, dialogue facilitation, religious diversity appreciation, shared values |

---

## 8. Implementation Priority

### Phase 1: Foundation (Months 1-3)

1. **Problem Detector** — Find recurring event patterns
2. **Severity Estimator** — Measure impact magnitude
3. **Action Generator** — Generate intervention recommendations
4. **Personal Relevance Calculator** — Match actions to users
5. **Daily Briefing API** — Serve personalized briefings

### Phase 2: Learning Loop (Months 4-6)

6. **Outcome Predictor** — Predict consequences
7. **Outcome Evaluator** — Compare predictions to reality
8. **Action Ranker** — Rank interventions by effectiveness
9. **Historical Success Lookup** — Learn from past interventions

### Phase 3: Advanced Intelligence (Months 7-12)

10. **Causal Graph Builder** — Map cause-effect relationships
11. **Collaboration Finder** — Match potential partners
12. **Resource Matcher** — Connect resources to needs
13. **Opportunity Detector** — Find hidden opportunities
14. **Cross-Cultural Analyzer** — Multi-perspective understanding

### Phase 4: Personalization (Year 2)

15. **Skill Extractor** — Extract skills from interaction patterns
16. **Job Matcher** — Match skills to opportunities
17. **Interest Graph** — Build dynamic interest model
18. **Recommendation Engine** — Personalize all recommendations

---

## The Promise

XYZO will not solve all problems.

But it will help humans understand what problems exist, what can be done about them, who can help, and whether what was tried actually worked.

That is enough. That is the mission.

**From reading news → understanding problems → taking action → learning what works.** 🔄

---

*This document is the permanent AI master plan for XYZO.*
*Version: 2.0 — Action Engine Edition*
*Last updated: 2026-09-09*