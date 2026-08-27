#!/usr/bin/env python3
"""
Build the agency track-record file the helper shows before you file.

Source: NYC OpenRecords FOIL request log, NYC Open Data dataset kegn-anvq
        https://data.cityofnewyork.us/d/kegn-anvq
        One row per FOIL request filed through a860-openrecords.nyc.gov since 2006:
        agency, when it was created, when the agency said it would answer, when it
        actually closed, and the current status.

Writes data/foil-performance.json — citywide totals plus a per-agency scorecard,
keyed by the agency ids already used in agencies.json.

The file deliberately carries its own row counts and date range so the page can
say what it is looking at, and so a silently truncated pull is visible instead of
being rendered as a smaller number.

Usage: python3 build_performance.py
"""

import json
import sys
import time
import urllib.parse
import urllib.request
from collections import Counter, defaultdict
from datetime import date, datetime, timedelta
from pathlib import Path

DATASET = "kegn-anvq"
BASE = f"https://data.cityofnewyork.us/resource/{DATASET}.json"
PAGE = 50000
OUT = Path(__file__).parent / "data"

# OpenRecords writes agency names its own way. Map them to the ids in agencies.json.
# Agencies missing here do not take FOIL through OpenRecords at all (NYCHA, the
# Comptroller, the Board of Elections, EDC, SCA, DOHMH) — the page says so rather
# than showing an empty scorecard.
AGENCY_IDS = {
    "New York City Police Department": "nypd",
    "New York City Fire Department": "fdny",
    "Department of Correction": "doc",
    "Department of Education": "doe",
    "Department of Housing Preservation and Development": "hpd",
    "Department of Buildings": "dob",
    "Department of Transportation": "dot",
    "Department of Sanitation": "dsny",
    "Human Resources Administration": "hra",
    "Department of Homeless Services": "dhs",
    "Administration for Children's Services": "acs",
    "Department of Consumer and Worker Protection": "dcwp",
    "Department of City Planning": "dcp",
    "Department of Environmental Protection": "dep",
    "Department of Parks and Recreation": "dpr",
    "Taxi and Limousine Commission": "tlc",
    "Department of Investigation": "doi",
    "Office of Management and Budget": "omb",
    "Mayor's Office": "mayor",
    "Department of Citywide Administrative Services": "dcas",
    "Mayor's Office of Criminal Justice": "mocj",
    "Business Integrity Commission": "bic",
}

OPEN_STATUSES = {"Overdue", "In Progress", "Due Soon", "Open"}


def fetch_all():
    """Page through the whole log. Aborts loudly rather than returning a partial pull."""
    rows = []
    offset = 0
    while True:
        qs = urllib.parse.urlencode({
            "$select": "agency_name,request_created_date,request_due_date,"
                       "request_close_date,request_status,submission_method",
            "$order": "request_id",
            "$limit": PAGE,
            "$offset": offset,
        })
        url = f"{BASE}?{qs}"
        page = None
        for attempt in range(5):
            try:
                req = urllib.request.Request(url, headers={"User-Agent": "foil-helper-build/1.0"})
                with urllib.request.urlopen(req, timeout=180) as r:
                    page = json.load(r)
                break
            except Exception as e:  # 403 here is anonymous throttling, not a policy wall
                print(f"  retry {attempt + 1} at offset {offset:,} ({e})", file=sys.stderr)
                time.sleep(4 * (attempt + 1))
        if page is None:
            raise RuntimeError(f"FOIL log fetch failed at offset {offset}")
        rows.extend(page)
        print(f"  {len(rows):,} rows", file=sys.stderr)
        if len(page) < PAGE:
            break
        offset += PAGE
    if len(rows) < 500000:
        raise RuntimeError(f"only {len(rows):,} rows — the log has had 600k+ since 2024; refusing to publish a short pull")
    return rows


def dt(v):
    if not v:
        return None
    try:
        return datetime.fromisoformat(v.replace("Z", "")).date()
    except ValueError:
        return None


def pct(vals, p):
    if not vals:
        return None
    s = sorted(vals)
    k = min(len(s) - 1, int(round((p / 100) * (len(s) - 1))))
    return s[k]


def main():
    print("Fetching the OpenRecords FOIL log…", file=sys.stderr)
    rows = fetch_all()
    today = date.today()
    year_ago = today - timedelta(days=365)

    created_all = [d for d in (dt(r.get("request_created_date")) for r in rows) if d]
    span = (min(created_all).isoformat(), max(created_all).isoformat())

    per = defaultdict(lambda: {
        "total": 0, "recent": 0, "open": 0, "past_due": 0,
        "closed_days": [], "closed_recent": 0, "late": 0, "on_time": 0,
        "due_offsets": [], "oldest_past_due": None,
    })
    city = {
        "total": 0, "recent": 0, "open": 0, "past_due": 0,
        "closed_days": [], "closed_recent": 0, "late": 0, "on_time": 0,
        "past_due_since_2024": 0,
    }
    filed_by_year = Counter()
    past_due_by_year = Counter()

    for r in rows:
        agency = (r.get("agency_name") or "").strip()
        status = (r.get("request_status") or "").strip()
        created = dt(r.get("request_created_date"))
        due = dt(r.get("request_due_date"))
        closed = dt(r.get("request_close_date"))
        a = per[agency]

        a["total"] += 1
        city["total"] += 1
        if created:
            filed_by_year[created.year] += 1
            if created >= year_ago:
                a["recent"] += 1
                city["recent"] += 1
            if due:
                a["due_offsets"].append((due - created).days)

        still_open = status in OPEN_STATUSES and not closed
        if still_open:
            a["open"] += 1
            city["open"] += 1
            if due and due < today:
                a["past_due"] += 1
                city["past_due"] += 1
                if created:
                    past_due_by_year[created.year] += 1
                    if created >= date(2024, 1, 1):
                        city["past_due_since_2024"] += 1
                    if a["oldest_past_due"] is None or created < a["oldest_past_due"]:
                        a["oldest_past_due"] = created

        # Response time is measured on requests the agency actually closed in the last
        # year. Requests still open are counted in the backlog instead — folding them
        # in as "not yet answered" would understate nothing, but averaging them as if
        # they were finished would overstate speed.
        if closed and closed >= year_ago and created:
            days = (closed - created).days
            if 0 <= days <= 4000:
                a["closed_days"].append(days)
                city["closed_days"].append(days)
                a["closed_recent"] += 1
                city["closed_recent"] += 1
                if due:
                    if closed <= due:
                        a["on_time"] += 1
                        city["on_time"] += 1
                    else:
                        a["late"] += 1
                        city["late"] += 1

    def scorecard(a, name=None):
        d = a["closed_days"]
        judged = a["on_time"] + a["late"]
        out = {
            "total": a["total"],
            "filed_12mo": a["recent"],
            "open": a["open"],
            "past_due": a["past_due"],
            "closed_12mo": a["closed_recent"],
            "median_days": pct(d, 50),
            "p75_days": pct(d, 75),
            "p90_days": pct(d, 90),
            "on_time_pct": round(100 * a["on_time"] / judged, 1) if judged else None,
            "median_due_offset": pct(a["due_offsets"], 50),
        }
        if name is not None:
            out["agency"] = name
            out["id"] = AGENCY_IDS.get(name)
            out["oldest_past_due"] = a["oldest_past_due"].isoformat() if a["oldest_past_due"] else None
        return out

    agencies = [scorecard(a, name) for name, a in per.items() if name]
    agencies.sort(key=lambda x: -x["total"])

    cd = city["closed_days"]
    judged = city["on_time"] + city["late"]
    payload = {
        "generated": today.isoformat(),
        "source": {
            "dataset": DATASET,
            "url": f"https://data.cityofnewyork.us/d/{DATASET}",
            "name": "OpenRecords FOIL Requests",
            "publisher": "Department of Records and Information Services",
            "rows": len(rows),
            "first_request": span[0],
            "last_request": span[1],
            "agencies": len(agencies),
        },
        "citywide": {
            "total": city["total"],
            "filed_12mo": city["recent"],
            "open": city["open"],
            "past_due": city["past_due"],
            "past_due_since_2024": city["past_due_since_2024"],
            "closed_12mo": city["closed_recent"],
            "median_days": pct(cd, 50),
            "p75_days": pct(cd, 75),
            "p90_days": pct(cd, 90),
            "on_time_pct": round(100 * city["on_time"] / judged, 1) if judged else None,
            "past_due_by_year": [{"year": y, "n": past_due_by_year[y]}
                                 for y in sorted(past_due_by_year) if y >= 2010],
            "filed_by_year": [{"year": y, "n": filed_by_year[y]}
                              for y in sorted(filed_by_year) if 2010 <= y <= today.year],
            "worst": [{"agency": a["agency"], "past_due": a["past_due"]}
                      for a in sorted(agencies, key=lambda x: -x["past_due"])[:6] if a["past_due"]],
        },
        "agencies": agencies,
        "byId": {a["id"]: a for a in agencies if a["id"]},
    }

    OUT.mkdir(exist_ok=True)
    p = OUT / "foil-performance.json"
    p.write_text(json.dumps(payload, separators=(",", ":")))
    print(f"wrote {p} ({p.stat().st_size / 1024:.0f} KB)", file=sys.stderr)
    c = payload["citywide"]
    print(f"  {c['total']:,} requests, {c['past_due']:,} open past due, "
          f"median close {c['median_days']} days, {c['on_time_pct']}% on time", file=sys.stderr)


if __name__ == "__main__":
    main()
