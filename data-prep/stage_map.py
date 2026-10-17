import json

items = json.load(open("items_normalized.json"))

STAGES = [
    {"id":"S1","name":"Stage 1 – Land & Legal Due Diligence","order":1},
    {"id":"S2","name":"Stage 2 – Design & Architecture Approval","order":2},
    {"id":"S3","name":"Stage 3 – NOCs (Fire / Garden / Water / Drainage / Power)","order":3},
    {"id":"S4","name":"Stage 4 – IOD & FSI Sanctions","order":4},
    {"id":"S5","name":"Stage 5 – Construction-Stage Checks & TDR","order":5},
    {"id":"S6","name":"Stage 6 – Environmental Clearance (CTE/CTO) & Swachh NOC","order":6},
    {"id":"S7","name":"Stage 7 – Occupancy & Handover to Sales","order":7},
    {"id":"S8","name":"Stage 8 – RERA Registration & Ongoing Project Obligations","order":8},
    {"id":"UNMAPPED","name":"Unmapped to Stage","order":99},
]

# SAN srno ranges -> stage id (draft, derived purely from Sanctioning sheet sequence)
san_map = {}
for sr in range(1,2): san_map[sr] = "S1"
for sr in range(2,6): san_map[sr] = "S2"       # SAN-002..005
for sr in range(6,15): san_map[sr] = "S3"      # SAN-006..014
for sr in range(15,18): san_map[sr] = "S4"     # SAN-015..017
for sr in range(18,23): san_map[sr] = "S5"     # SAN-018..022
for sr in range(23,26): san_map[sr] = "S6"     # SAN-023..025
for sr in range(26,29): san_map[sr] = "S7"     # SAN-026..028
for sr in range(29,71): san_map[sr] = "S8"     # SAN-029..070

for it in items:
    if it["department"] == "Sanctioning":
        it["stage_id"] = san_map.get(it["sr_no"], "UNMAPPED")
        it["stage_source"] = "proposed_draft"
    else:
        it["stage_id"] = "UNMAPPED"
        it["stage_source"] = "not_mapped"

from collections import Counter
c = Counter(it["stage_id"] for it in items)
print("Stage distribution:", c)
assert sum(c.values()) == 306

with open("items_final.json","w") as f:
    json.dump(items, f, indent=1)
with open("stages.json","w") as f:
    json.dump(STAGES, f, indent=1)
print("done")
