"""Mode implementations for collabd.

PR-1 only ships `scripts`. Each mode module exposes a `loop(cfg, state, *,
stop_event)` that runs forever until stop_event is set.

Future modes (PR-2/3/4):
  - gateway:        install hivv SDK, configure with token, run a CLI loop.
  - model_serve:    detect local Ollama/LM Studio, register endpoint with hivv.
  - content:        submit free tools to blnq.
  - discovery:      scan HN/GitHub/arXiv for collab opportunities.
  - self_improve:   nightly metrics + auto-update.
"""
