"""CLI wrapper for fast_suggest module.

Usage:
  python -m worker.fast_suggest_cli '{"pin_id": 123, "article_id": 456, "user_place": "Beirut, Lebanon"}'
"""

import json
import sys

from .fast_suggest import process_suggestion


def main():
    if len(sys.argv) < 2:
        print(json.dumps({"error": "No arguments provided"}))
        sys.exit(1)

    try:
        args = json.loads(sys.argv[1])
    except json.JSONDecodeError as e:
        print(json.dumps({"error": f"Invalid JSON: {e}"}))
        sys.exit(1)

    result = process_suggestion(
        pin_id=args.get("pin_id"),
        article_id=args.get("article_id"),
        user_place=args.get("user_place"),
        lat=args.get("lat"),
        lng=args.get("lng"),
        radius_km=args.get("radius_km", 25),
    )

    print(json.dumps(result, default=str))


if __name__ == "__main__":
    main()
