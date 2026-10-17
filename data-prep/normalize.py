import json, re
from datetime import date

items = json.load(open("items_raw.json"))

def norm_frequency(raw):
    if not raw:
        return "Unspecified"
    r = raw.strip().lower()
    if 'event' in r:
        return "Event Based"
    if r in ('one time','one-time','onetime') or r.startswith('one time') or r.startswith('one-time'):
        return "One Time"
    if 'continuous' in r or 'ongoing' in r or 'on going' in r:
        return "Ongoing / Continuous"
    if 'monthly' in r:
        return "Monthly"
    if 'quarterly' in r:
        return "Quarterly"
    if 'half' in r and 'year' in r:
        return "Half-Yearly"
    if 'annual' in r or 'yearly' in r:
        return "Annual"
    if 'as required' in r or 'as prescribed' in r:
        return "As Required"
    if 'periodic' in r:
        return "Periodic"
    return "Other / Unparsed"

def norm_authority(raw):
    if not raw:
        return "Unspecified"
    r = raw.strip()
    rl = r.lower()
    if 'other (specify)' in rl:
        # extract suffix after the marker
        suffix = r.split(')',1)[1].strip() if ')' in r else ''
        return suffix if suffix else "Other (Unspecified)"
    if rl in ('state', 'state govt', 'state government'):
        return "State Govt"
    if rl in ('central govt', 'central government', 'centre'):
        return "Central Govt"
    if 'rera' in rl:
        return "MahaRERA"
    if 'gram panchayat' in rl or 'muncipal' in rl or 'municipal' in rl:
        return "Local Municipal / Gram Panchayat"
    if 'internal' in rl:
        return "Internal Compliance"
    if rl == 'none':
        return "Unspecified"
    return r

MONTHS = {m.lower(): i for i, m in enumerate(
    ['January','February','March','April','May','June','July','August','September','October','November','December'], 1)}

def parse_due_date(raw, freq_norm):
    """Returns (parsed_type, parsed_value, status) - status in: fixed_date, rule, undated, unparsed"""
    if not raw:
        if freq_norm in ("Event Based", "Ongoing / Continuous", "As Required"):
            return (None, None, "undated_by_nature")
        return (None, None, "due_date_to_be_set")
    r = str(raw).strip()
    rl = r.lower()
    # fixed date patterns: "From 13 May 2027", "13 May 2027", "13/05/2027"
    m = re.search(r'(\d{1,2})(st|nd|rd|th)?\s+([A-Za-z]+)\s+(\d{4})', r)
    if m:
        day = int(m.group(1)); mon_name = m.group(3).lower(); year = int(m.group(4))
        if mon_name in MONTHS:
            return ("fixed_date", f"{year:04d}-{MONTHS[mon_name]:02d}-{day:02d}", "fixed_date")
    m2 = re.search(r'(\d{1,2})[/-](\d{1,2})[/-](\d{4})', r)
    if m2:
        d_, mo_, y_ = int(m2.group(1)), int(m2.group(2)), int(m2.group(3))
        return ("fixed_date", f"{y_:04d}-{mo_:02d}-{d_:02d}", "fixed_date")
    if 'immediate' in rl:
        return ("rule", "immediate_on_trigger", "rule")
    if 'before publication' in rl or 'before commencement' in rl:
        return ("rule", "before_trigger_event", "rule")
    if '15th of next month' in rl or ('15th' in rl and 'month' in rl):
        return ("rule", "monthly:day=15:offset=+1month", "rule")
    if rl in ('ongoing','on going','continuous'):
        return (None, None, "undated_by_nature")
    # fallback: couldn't interpret
    return (None, None, "unparsed")

normalized = []
for it in items:
    freq_norm = norm_frequency(it.get('frequency'))
    auth_norm = norm_authority(it.get('authority'))
    ptype, pval, pstatus = parse_due_date(it.get('due_date'), freq_norm)
    normalized.append({
        "compliance_id": it['compliance_id_computed'],
        "compliance_id_source_formula_broken": it['compliance_id_raw'] == '#REF!',
        "sheet_row": it['_row'],
        "sr_no": it['srno_computed'],
        "department": it['department'],
        "compliance_type_raw": it['compliance_type'],
        "level": "Project Level" if it['compliance_type'] and 'Project' in it['compliance_type'] else "Entity Level",
        "regulation": it['regulation'],
        "reference_section": it['reference_section'],
        "brief_description": it['brief_description'],
        "action_required": it['action_required'],
        "forms_documents": it['forms_documents'],
        "authority_raw": it['authority'],
        "authority_norm": auth_norm,
        "frequency_raw": it['frequency'],
        "frequency_norm": freq_norm,
        "due_date_raw": it['due_date'],
        "due_date_parse_type": ptype,
        "due_date_parse_value": pval,
        "due_date_parse_status": pstatus,
        "penalty": it['penalty'],
        "owner_raw": it['owner'],
        "owner": it['owner'] if it['owner'] else "Unassigned",
        "approver_raw": it['approver'],
        "approver": it['approver'] if it['approver'] else "Unassigned",
        "applicability": it['applicability'],
    })

print("Total normalized:", len(normalized))
# Quality counters
from collections import Counter
dq = Counter(n['due_date_parse_status'] for n in normalized)
print("Due date parse status:", dq)
print("Owner unassigned:", sum(1 for n in normalized if n['owner']=='Unassigned'))
print("Approver unassigned:", sum(1 for n in normalized if n['approver']=='Unassigned'))
print("Broken compliance_id formula count:", sum(1 for n in normalized if n['compliance_id_source_formula_broken']))

with open("items_normalized.json","w") as f:
    json.dump(normalized, f, indent=1)
