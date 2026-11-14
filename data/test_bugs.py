"""Playwright test to reproduce category filter and Hot & Latest bugs."""

import time
from playwright.sync_api import sync_playwright

def test_category_filter_bug():
    """Bug 1: Category filter shows wrong count and doesn't update URL."""
    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True, args=["--no-sandbox"])
        page = browser.new_page(viewport={"width": 1920, "height": 1080})

        # Capture console errors
        errors = []
        page.on("console", lambda msg: errors.append(msg.text) if msg.type == "error" else None)

        print("Loading xyzo.org...")
        page.goto("http://xyzo.org/#-6.2,106.8,8", wait_until="domcontentloaded", timeout=15000)
        time.sleep(3)  # Wait for map to load

        # Check initial state
        initial_hash = page.url.split("#")[1] if "#" in page.url else ""
        print(f"Initial URL hash: {initial_hash}")

        # Find the technology legend row and click it
        print("\nClicking technology category legend row...")
        tech_row = page.query_selector('[data-legend-key="technology"]')
        if tech_row:
            tech_row.click()
            time.sleep(2)

            # Check if filter indicator appeared
            filter_indicator = page.query_selector("#active-filter-text")
            if filter_indicator:
                print(f"Filter indicator text: {filter_indicator.inner_text()}")
            else:
                print("Filter indicator NOT found")

            # Check URL hash after clicking
            new_hash = page.url.split("#")[1] if "#" in page.url else ""
            print(f"URL hash after category click: {new_hash}")

            if "cat=" in new_hash:
                print("✓ URL updated with category")
            else:
                print("✗ URL did NOT update with category (BUG)")

            # Check search status
            search_status = page.query_selector("#search-status")
            if search_status:
                print(f"Search status: {search_status.inner_text()}")
        else:
            print("Technology legend row NOT found!")

        # Report errors
        if errors:
            print(f"\nConsole errors: {errors[:5]}")

        browser.close()

def test_hot_latest_bug():
    """Bug 2: Hot & Latest shows empty on first click."""
    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True, args=["--no-sandbox"])
        page = browser.new_page(viewport={"width": 1920, "height": 1080})

        # Capture console errors
        errors = []
        page.on("console", lambda msg: errors.append(msg.text) if msg.type == "error" else None)

        print("\n" + "="*60)
        print("Testing Hot & Latest bug...")
        print("="*60)

        print("\nLoading xyzo.org...")
        page.goto("http://xyzo.org/#-6.2,106.8,8", wait_until="domcontentloaded", timeout=15000)
        time.sleep(3)

        # Check initial state of live panel
        print("\nChecking initial Hot & Latest state...")
        hot_tab = page.query_selector('[data-tab="hot"]')
        if hot_tab:
            is_active = hot_tab.get_attribute("class")
            print(f"Hot tab classes: {is_active}")

        # Check if live panel shows content
        live_empty = page.query_selector(".live-empty")
        live_items = page.query_selector(".live-items")
        if live_empty:
            print(f"Live empty message: {live_empty.inner_text()}")
        if live_items:
            item_count = len(live_items.query_selector_all(".live-item"))
            print(f"Live items count: {item_count}")

        # Now click the Hot tab (it's already active, so clicking it again)
        print("\nClicking Hot & Latest tab (second click)...")
        if hot_tab:
            hot_tab.click()
            time.sleep(2)

            live_empty = page.query_selector(".live-empty")
            live_items = page.query_selector(".live-items")
            if live_empty:
                is_hidden = live_empty.get_attribute("hidden")
                print(f"Live empty message after click: {live_empty.inner_text()} (hidden={is_hidden})")
            if live_items:
                item_count = len(live_items.query_selector_all(".live-item"))
                print(f"Live items count after click: {item_count}")
                if item_count > 0:
                    print("✓ Content appeared on second click (BUG CONFIRMED)")
                else:
                    print("No items found")

        # Report errors
        if errors:
            print(f"\nConsole errors: {errors[:5]}")

        browser.close()

if __name__ == "__main__":
    test_category_filter_bug()
    test_hot_latest_bug()