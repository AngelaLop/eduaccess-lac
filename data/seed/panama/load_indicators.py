"""
One-shot ingest: 32 Panama district-indicator CSVs + simplified GeoJSON -> parquet + optional Supabase upsert.

Usage:
    python load_indicators.py                      # writes parquet only
    python load_indicators.py --push               # writes parquet + pushes both tables to Supabase

Requires: pandas, pyarrow
Optional (for --push): supabase-py  (pip install supabase)
"""

import argparse
import json
import os
import sys
from pathlib import Path

import pandas as pd

# ── paths ────────────────────────────────────────────────────────────────────
SRC_DIR = Path(
    r"C:\Users\lopez\github\IDB\accessibility_platform"
    r"\data\PAN_pilot\results\district_tables"
)
OUT_DIR = Path(__file__).parent
OUT_PARQUET = OUT_DIR / "panama_district_indicators.parquet"
GEOJSON_PATH = OUT_DIR / "panama_districts.simplified.geojson"


# ── indicators ────────────────────────────────────────────────────────────────

def load_all_csvs() -> pd.DataFrame:
    files = sorted(SRC_DIR.glob("*.csv"))
    if not files:
        sys.exit(f"ERROR: no CSVs found in {SRC_DIR}")

    frames = [pd.read_csv(f, dtype={"cod_dist": str}) for f in files]
    combined = pd.concat(frames, ignore_index=True)

    # The 'friction' column encodes both friction surface and transport mode:
    #   'motorized'     -> friction_source='map', friction='motorized'
    #   'walking'       -> friction_source='map', friction='walking'
    #   'osm_motorized' -> friction_source='osm', friction='motorized'
    #   'osm_walking'   -> friction_source='osm', friction='walking'
    combined["friction_source"] = combined["friction"].apply(
        lambda v: "osm" if v.startswith("osm_") else "map"
    )
    combined["friction"] = combined["friction"].str.replace("osm_", "", regex=False)

    print(f"Loaded {len(files)} files -> {len(combined):,} rows")
    return combined


def validate(df: pd.DataFrame) -> None:
    n_sids = df["sid"].nunique()
    if n_sids != 32:
        print(f"WARNING: expected 32 unique SIDs, got {n_sids}")

    dupes = df.duplicated(subset=["cod_dist", "sid"]).sum()
    if dupes:
        sys.exit(f"ERROR: {dupes} duplicate (cod_dist, sid) pairs")

    assert set(df["pop_source"].unique()) <= {"census", "worldpop"}
    assert set(df["friction"].unique()) <= {"motorized", "walking"}
    assert set(df["friction_source"].unique()) <= {"map", "osm"}
    assert set(df["age_group"].unique()) <= {"all", "primary", "secondary", "highschool"}

    print(f"Validation passed: {df['cod_dist'].nunique()} districts, {n_sids} scenarios")


def write_parquet(df: pd.DataFrame) -> None:
    df.to_parquet(OUT_PARQUET, index=False, engine="pyarrow")
    print(f"Wrote {OUT_PARQUET} ({OUT_PARQUET.stat().st_size / 1024:.1f} KB)")


# ── geometries ────────────────────────────────────────────────────────────────

def load_geometries() -> list[dict]:
    """
    Load simplified GeoJSON, merge multi-feature districts into MultiPolygon,
    return list of {cod_dist, nomb_dist, nomb_prov, geometry} records.
    94 GeoJSON features -> 83 unique cod_dist rows (island districts get merged).
    """
    gj = json.loads(GEOJSON_PATH.read_text(encoding="utf-8"))
    by_code: dict[str, dict] = {}

    for feat in gj["features"]:
        props = feat["properties"]
        code = props["cod_dist"]
        geom = feat["geometry"]

        if code not in by_code:
            by_code[code] = {
                "cod_dist": code,
                "nomb_dist": props["nomb_dist"],
                "nomb_prov": props["nomb_prov"],
                "_polys": [],
            }

        # Collect Polygon coordinate rings (handle both Polygon and MultiPolygon input)
        if geom["type"] == "Polygon":
            by_code[code]["_polys"].append(geom["coordinates"])
        elif geom["type"] == "MultiPolygon":
            by_code[code]["_polys"].extend(geom["coordinates"])

    records = []
    for code, row in by_code.items():
        polys = row.pop("_polys")
        if len(polys) == 1:
            row["geometry"] = json.dumps({"type": "Polygon", "coordinates": polys[0]})
        else:
            row["geometry"] = json.dumps({"type": "MultiPolygon", "coordinates": polys})
        records.append(row)

    print(f"Geometry records: {len(records)} (from 94 features, 83 unique cod_dist)")
    return records


# ── supabase push ─────────────────────────────────────────────────────────────

def _supabase_client():
    try:
        from supabase import create_client
    except ImportError:
        sys.exit("ERROR: supabase-py not installed. Run: pip install supabase")

    url = os.environ.get("NEXT_PUBLIC_SUPABASE_URL") or os.environ.get("SUPABASE_URL")
    key = os.environ.get("SUPABASE_SERVICE_ROLE_KEY")
    if not url or not key:
        sys.exit(
            "ERROR: set SUPABASE_URL (or NEXT_PUBLIC_SUPABASE_URL) and "
            "SUPABASE_SERVICE_ROLE_KEY environment variables"
        )
    return create_client(url, key)


def push_indicators(df: pd.DataFrame, client) -> None:
    # pd.to_json serializes NaN -> null, then we parse back to Python None
    records = json.loads(df.to_json(orient="records"))
    BATCH = 500
    for i in range(0, len(records), BATCH):
        batch = records[i : i + BATCH]
        client.table("panama_district_indicators").upsert(
            batch, on_conflict="cod_dist,sid"
        ).execute()
        print(f"  indicators upserted rows {i}-{i + len(batch) - 1}")
    print(f"Indicators push complete: {len(records):,} rows")


def push_geometries(client) -> None:
    records = load_geometries()
    client.table("panama_district_geometries").upsert(
        records, on_conflict="cod_dist"
    ).execute()
    print(f"Geometries push complete: {len(records)} rows")


# ── main ──────────────────────────────────────────────────────────────────────

def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--push", action="store_true", help="Push to Supabase after writing parquet")
    args = parser.parse_args()

    df = load_all_csvs()
    validate(df)
    write_parquet(df)

    if args.push:
        client = _supabase_client()
        push_indicators(df, client)
        push_geometries(client)


if __name__ == "__main__":
    main()
