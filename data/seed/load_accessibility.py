"""
v4 ingest: the IDB pipeline's unified accessibility output ->
the multi-country accessibility_indicators table in Supabase.

Source files (already computed by the IDB Python pipeline):
    IDB/accessibility_platform/results/accessibility/accessibility_fmm_scl.csv
    IDB/accessibility_platform/results/accessibility/accessibility_osrm_scl.csv

Usage:
    python load_accessibility.py                       # dry run: summarise only
    python load_accessibility.py --push                # push PAN + COL to Supabase
    python load_accessibility.py --push --countries PAN COL CRI

Requires: pandas
Optional (for --push): supabase-py  (pip install supabase)

Env for --push: SUPABASE_URL (or NEXT_PUBLIC_SUPABASE_URL) + SUPABASE_SERVICE_ROLE_KEY
"""

import argparse
import json
import os
import sys
from pathlib import Path

import pandas as pd

SRC_DIR = Path(
    r"C:\Users\lopez\github\IDB\accessibility_platform\results\accessibility"
)
FMM_CSV = SRC_DIR / "accessibility_fmm_scl.csv"
OSRM_CSV = SRC_DIR / "accessibility_osrm_scl.csv"

# Columns kept for the accessibility_indicators table. 'indicator' (always
# 'acceso_geografico') and 'age' (1:1 with education_level) are dropped.
KEEP = [
    "country_iso", "idgeo", "admin1_pcode", "admin1_name",
    "admin2_pcode", "admin2_name", "mode", "education_level",
    "sector", "area", "quintile", "time_band",
    "value", "population_base", "method", "year", "source",
]
TEXT_NOT_NULL = ["admin1_pcode", "admin1_name", "admin2_pcode", "admin2_name"]

# Credentials live in apps/worker/.env (same file the Railway worker uses).
_REPO_ROOT = Path(__file__).resolve().parents[2]
_ENV_CANDIDATES = [
    _REPO_ROOT / "apps" / "worker" / ".env",
    _REPO_ROOT / ".env",
    _REPO_ROOT / "apps" / "web" / ".env.local",
]


def _load_env() -> None:
    """Dependency-free .env loader. An already-set env var always wins."""
    for path in _ENV_CANDIDATES:
        if not path.exists():
            continue
        for line in path.read_text(encoding="utf-8").splitlines():
            line = line.strip()
            if not line or line.startswith("#") or "=" not in line:
                continue
            k, v = line.split("=", 1)
            os.environ.setdefault(k.strip(), v.strip().strip('"').strip("'"))


def load_csv(path: Path) -> pd.DataFrame:
    if not path.exists():
        sys.exit(f"ERROR: source file not found: {path}")
    df = pd.read_csv(path, dtype=str)
    df = df.rename(columns={"isoalpha3": "country_iso"})
    # Empty-string defaults for the admin codes/names that are NaN on
    # country / admin1 rows — the schema stores them NOT NULL DEFAULT ''.
    for col in TEXT_NOT_NULL:
        df[col] = df[col].fillna("")
    # numeric coercion (NaN -> None on serialize)
    df["value"] = pd.to_numeric(df["value"], errors="coerce")
    df["population_base"] = pd.to_numeric(df["population_base"], errors="coerce")
    df["year"] = pd.to_numeric(df["year"], errors="coerce").astype("Int64")
    missing = [c for c in KEEP if c not in df.columns]
    if missing:
        sys.exit(f"ERROR: {path.name} is missing expected columns: {missing}")
    return df[KEEP]


def summarise(df: pd.DataFrame, label: str) -> None:
    print(f"  {label}: {len(df):,} rows | "
          f"countries={df['country_iso'].value_counts().to_dict()}")


def _supabase_client():
    try:
        from supabase import create_client
    except ImportError:
        sys.exit("ERROR: supabase-py not installed. Run: pip install supabase")
    _load_env()
    url = os.environ.get("SUPABASE_URL") or os.environ.get("NEXT_PUBLIC_SUPABASE_URL")
    key = os.environ.get("SUPABASE_SERVICE_ROLE_KEY")
    if not url or not key:
        sys.exit("ERROR: set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY")
    return create_client(url, key)


def push(df: pd.DataFrame, client, countries: list[str]) -> None:
    BATCH = 2000
    for c in countries:
        sub = df[df["country_iso"] == c]
        if sub.empty:
            print(f"  {c}: no rows in source — skipped")
            continue
        # delete-then-insert: a country is fully replaced on each load
        client.table("accessibility_indicators").delete().eq("country_iso", c).execute()
        records = json.loads(sub.to_json(orient="records"))
        for i in range(0, len(records), BATCH):
            client.table("accessibility_indicators").insert(records[i:i + BATCH]).execute()
            print(f"  {c}: inserted {i + min(BATCH, len(records) - i):,}/{len(records):,}")
    print("Indicators push complete.")


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--push", action="store_true")
    ap.add_argument("--countries", nargs="+", default=["PAN", "COL", "CRI", "ECU", "PER"])
    args = ap.parse_args()

    print("Loading source CSVs…")
    fmm = load_csv(FMM_CSV)
    osrm = load_csv(OSRM_CSV)
    summarise(fmm, "FMM ")
    summarise(osrm, "OSRM")

    combined = pd.concat([fmm, osrm], ignore_index=True)
    combined = combined[combined["country_iso"].isin(args.countries)]
    print(f"Selected {args.countries}: {len(combined):,} rows total")

    if args.push:
        push(combined, _supabase_client(), args.countries)
    else:
        print("Dry run — pass --push to write to Supabase.")


if __name__ == "__main__":
    main()
