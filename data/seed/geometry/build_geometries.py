"""
v4 geometry build: BID LAC level-2 shapefile -> per-country simplified
GeoJSON for the frontend + optional district_geometries rows in Supabase.

Both Panama and Colombia geometries come from the SAME BID shapefile, so
admin2_pcode lines up exactly with the accessibility data (PA0101, CO…).

Source:
    IDB/accessibility_platform/data/bounderys/LAC/level 2/lac-level-2.shp

Output (static assets the CountryMap component fetches):
    apps/web/public/panama_districts.geojson
    apps/web/public/colombia_districts.geojson

Usage:
    python build_geometries.py                  # write GeoJSON files only
    python build_geometries.py --push           # also upsert district_geometries

Requires: geopandas
Optional (for --push): supabase-py
Env for --push: SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY
"""

import argparse
import json
import os
import sys
from pathlib import Path

import geopandas as gpd
import pandas as pd

SHP = Path(
    r"C:\Users\lopez\github\IDB\accessibility_platform"
    r"\data\bounderys\LAC\level 2\lac-level-2.shp"
)
# The shapefile .dbf string columns are mis-encoded; names are taken from
# the sibling CSV (UTF-8) instead, joined on ADM2_PCODE.
NAMES_CSV = SHP.with_suffix(".csv")
PUBLIC_DIR = Path(__file__).parents[3] / "apps" / "web" / "public"

# country_iso -> (admin2_pcode prefix, output filename, simplify tolerance °)
COUNTRIES = {
    "PAN": ("PA", "panama_districts.geojson", 0.003),
    "COL": ("CO", "colombia_districts.geojson", 0.013),
    "CRI": ("CR", "costa_rica_districts.geojson", 0.003),
    "ECU": ("EC", "ecuador_districts.geojson", 0.009),
    "PER": ("PE", "peru_districts.geojson", 0.011),
}


def build(country_iso: str, gdf: gpd.GeoDataFrame, names: dict[str, dict]) -> list[dict]:
    prefix, fname, tol = COUNTRIES[country_iso]
    sub = gdf[gdf["ADM2_PCODE"].astype(str).str.startswith(prefix)].copy()
    if sub.empty:
        sys.exit(f"ERROR: no {prefix}* features in shapefile")

    # simplify in WGS84 (preserve topology so polygons stay watertight)
    sub["geometry"] = sub["geometry"].simplify(tol, preserve_topology=True)

    features = []
    for _, r in sub.iterrows():
        pcode = r["ADM2_PCODE"]
        nm = names.get(pcode, {})
        features.append({
            "type": "Feature",
            "properties": {
                "admin2_pcode": pcode,
                "admin2_name": nm.get("admin2_name"),
                "admin1_name": nm.get("admin1_name"),
            },
            "geometry": json.loads(gpd.GeoSeries([r["geometry"]]).to_json())
                            ["features"][0]["geometry"],
        })

    fc = {"type": "FeatureCollection", "features": features}
    out = PUBLIC_DIR / fname
    out.write_text(json.dumps(fc), encoding="utf-8")
    print(f"  {country_iso}: {len(features)} districts -> {out.name} "
          f"({out.stat().st_size / 1024:.0f} KB)")
    return features


def push(country_iso: str, features: list[dict], client) -> None:
    rows = [{
        "country_iso": country_iso,
        "admin2_pcode": f["properties"]["admin2_pcode"],
        "admin2_name": f["properties"]["admin2_name"],
        "admin1_name": f["properties"]["admin1_name"],
        "geometry": f["geometry"],
    } for f in features]
    client.table("district_geometries").delete().eq("country_iso", country_iso).execute()
    for i in range(0, len(rows), 500):
        client.table("district_geometries").insert(rows[i:i + 500]).execute()
    print(f"  {country_iso}: {len(rows)} geometry rows pushed")


_REPO_ROOT = Path(__file__).resolve().parents[3]
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


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--push", action="store_true")
    args = ap.parse_args()

    if not SHP.exists():
        sys.exit(f"ERROR: shapefile not found: {SHP}")
    PUBLIC_DIR.mkdir(parents=True, exist_ok=True)

    print("Reading BID LAC level-2 shapefile…")
    # pyogrio engine: geopandas 0.14 + modern fiona drop the legacy fiona.path API
    gdf = gpd.read_file(SHP, engine="pyogrio").to_crs(4326)

    # UTF-8 names from the sibling CSV (the .dbf string columns are mis-encoded)
    ndf = pd.read_csv(NAMES_CSV)
    names = {
        r["ADM2_PCODE"]: {"admin2_name": r["ADM2_EN"], "admin1_name": r["ADM1_EN"]}
        for _, r in ndf.iterrows()
    }

    client = _supabase_client() if args.push else None
    for iso in COUNTRIES:
        feats = build(iso, gdf, names)
        if client is not None:
            push(iso, feats, client)


if __name__ == "__main__":
    main()
