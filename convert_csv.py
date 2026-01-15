import csv
import json
import os

csv_path = r'c:\Users\fresh\Downloads\TubeTrend_2026-01-15.csv'
js_path = r'c:\Users\fresh\Downloads\tubetrend\src\default_channels.js'

channels = []

try:
    with open(csv_path, 'r', encoding='utf-8-sig') as f:
        reader = csv.DictReader(f)
        for row in reader:
            # Map CSV columns to JS object keys
            # CSV Header: Rank,Channel ID,Channel Name,Country,Subscribers,Total Views,24h Growth
            if not row.get('Channel ID'):
                continue
                
            channels.append({
                "id": row['Channel ID'],
                "title": row['Channel Name'],
                "country": row['Country'],
                "category": "0", # Default as CSV missing category
                "thumbnail": "", # Default as CSV missing thumbnail
                "subs": int(row['Subscribers']) if row['Subscribers'] else 0, # Optional for extra stats
                "views": int(row['Total Views']) if row['Total Views'] else 0
            })

    # Write to JS file
    js_content = f"export const DEFAULT_CHANNELS = {json.dumps(channels, ensure_ascii=False, indent=4)};"
    
    with open(js_path, 'w', encoding='utf-8') as f:
        f.write(js_content)
        
    print(f"Successfully converted {len(channels)} channels.")

except Exception as e:
    print(f"Error: {e}")
