import csv
import json
import os

ranking_csv_path = r'c:\Users\fresh\Downloads\TubeTrend_Ranking_2026-01-15.csv'
live_csv_path = r'c:\Users\fresh\Downloads\TubeTrend_LiveCandidates_2026-01-15.csv'
js_path = r'c:\Users\fresh\Downloads\tubetrend\src\default_channels.js'

ranking_data = []
live_data = []

# Process Ranking CSV
try:
    if os.path.exists(ranking_csv_path):
        with open(ranking_csv_path, 'r', encoding='utf-8-sig') as f:
            reader = csv.DictReader(f)
            for row in reader:
                if not row.get('Channel ID'): continue
                ranking_data.append({
                    "id": row['Channel ID'],
                    "title": row['Channel Name'],
                    "country": row['Country'],
                    "category": "0",
                    "thumbnail": "",
                    "subs": int(row['Subscribers']) if row['Subscribers'] else 0,
                    "views": int(row['Total Views']) if row['Total Views'] else 0
                })
        print(f"Loaded {len(ranking_data)} ranking channels.")
    else:
        print("Ranking CSV not found.")
except Exception as e:
    print(f"Error processing Ranking CSV: {e}")

# Process Live CSV
try:
    if os.path.exists(live_csv_path):
        with open(live_csv_path, 'r', encoding='utf-8-sig') as f:
            reader = csv.DictReader(f)
            for row in reader:
                if not row.get('Channel ID'): continue
                live_data.append({
                    "id": row['Channel ID'],
                    "title": row['Channel Name'],
                    "last_live_date": row['Last Live Date'] if row['Last Live Date'] else None
                })
        print(f"Loaded {len(live_data)} live candidates.")
    else:
        print("Live CSV not found.")
except Exception as e:
    print(f"Error processing Live CSV: {e}")

# Write to JS file
try:
    js_content = f"""export const RANKING_DATA = {json.dumps(ranking_data, ensure_ascii=False, indent=4)};

export const LIVE_DATA = {json.dumps(live_data, ensure_ascii=False, indent=4)};
"""
    
    with open(js_path, 'w', encoding='utf-8') as f:
        f.write(js_content)
        
    print("Successfully updated default_channels.js")

except Exception as e:
    print(f"Error writing JS file: {e}")
