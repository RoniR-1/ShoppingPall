"""
Build data/processed/catalog.db from the raw Valio Aimo Junction 2026 files.

Usage:
    python pipeline/build_catalog_db.py            # defaults to data/raw -> data/processed/catalog.db
    python pipeline/build_catalog_db.py RAW_DIR OUT_DB

Only uses the Python standard library (json, csv, sqlite3, re).
"""
import csv
import json
import re
import sqlite3
import sys
from pathlib import Path

RAW = Path(sys.argv[1]) if len(sys.argv) > 1 else Path("data/raw")
OUT = Path(sys.argv[2]) if len(sys.argv) > 2 else Path("data/processed/catalog.db")
PREFIX = "valio_aimo_junction26_"

SCHEMA = """
CREATE TABLE products (
    id                         TEXT PRIMARY KEY,
    name_en                    TEXT,
    name_fi                    TEXT,
    name_sv                    TEXT,
    brand                      TEXT,
    vendor                     TEXT,
    category                   TEXT,
    country                    TEXT,
    temperature_condition      INTEGER,
    min_temp_c                 REAL,
    max_temp_c                 REAL,
    sales_unit                 TEXT NOT NULL,
    base_unit                  TEXT NOT NULL,
    base_units_per_sales_unit  REAL,     -- e.g. sales unit KI = 5 x base unit ST
    allowed_lot_size           REAL,     -- order qty must be a multiple of this (in sales units)
    variable_unit              INTEGER,  -- 1 = sold by variable weight
    vat_code                   TEXT,
    gtin                       TEXT,
    content_per_base           REAL,     -- amount in one base unit ...
    content_unit               TEXT,     -- ... in 'l' or 'kg'
    content_source             TEXT,     -- 'volume' | 'netWeight' | 'name' (how reliable it is)
    content_per_sales_unit     REAL,     -- content_per_base * base_units_per_sales_unit
    co2_kg_per_kg              REAL,     -- from carbon_footprint.csv, NULL if missing
    delivery_reliability       REAL,     -- from delivery_reliability.csv, NULL if missing
    last_updated               TEXT
);

-- Packaging hierarchy: which units a product can be handled in.
CREATE TABLE product_units (
    product_id          TEXT NOT NULL REFERENCES products(id),
    unit_id             TEXT NOT NULL,
    size_in_base_units  REAL,
    gtin                TEXT,
    PRIMARY KEY (product_id, unit_id)
);

-- All Synkka classification groups, flattened.
--   grp = allergen | nonAllergen | nutritionalClaim | packagingMarkedLabel | packaging   (ENUM: value is NULL)
--       | nutritionFact | gda | mineral | vitamin | composition                        (DECIMAL: value set)
--   qualifier = CONTAINS / MAY_CONTAIN / FREE_FROM / DIET ... for ENUM groups, the unit (GRM, MGM...) for DECIMAL groups
CREATE TABLE classifications (
    product_id  TEXT NOT NULL REFERENCES products(id),
    grp         TEXT NOT NULL,
    code        TEXT NOT NULL,
    qualifier   TEXT,
    value       REAL
);

CREATE TABLE substitutions (
    product_id     TEXT NOT NULL REFERENCES products(id),
    substitute_id  TEXT NOT NULL,
    PRIMARY KEY (product_id, substitute_id)
);

CREATE TABLE ingredients (
    product_id  TEXT NOT NULL REFERENCES products(id),
    seq         INTEGER,
    name_en     TEXT,
    name_fi     TEXT,
    percentage  REAL
);

-- Full original record, so the API can return complete details without re-reading 87 MB of JSON.
CREATE TABLE product_raw (
    product_id  TEXT PRIMARY KEY REFERENCES products(id),
    json        TEXT NOT NULL
);

-- Full-text search over names in all three languages, brand, vendor and ingredients.
CREATE VIRTUAL TABLE product_search USING fts5(
    product_id UNINDEXED, name_en, name_fi, name_sv, brand, vendor, ingredients,
    tokenize = 'unicode61 remove_diacritics 2'
);
"""

INDEXES = """
CREATE INDEX idx_products_category ON products(category);
CREATE INDEX idx_class_lookup      ON classifications(grp, code, qualifier);
CREATE INDEX idx_class_product     ON classifications(product_id);
CREATE INDEX idx_ingredients_prod  ON ingredients(product_id);
CREATE INDEX idx_subst_substitute  ON substitutions(substitute_id);
"""

# ---------------------------------------------------------------- helpers

def by_lang(items, lang):
    for x in items or []:
        if x.get("language") == lang:
            return x.get("value")
    return None


TO_LITRES = {"LTR": 1.0, "CLT": 0.01, "MLT": 0.001}
TO_KG = {"KGM": 1.0, "GRM": 0.001}

# Matches "1 l", "1,5 l", "500ml", "25 kg", "400g", optionally "60x90g" (multipack).
NAME_QTY = re.compile(
    r"(?:(\d+)\s*[x×]\s*)?(\d+(?:[.,]\d+)?)\s*(ml|cl|dl|l|kg|g)\b", re.IGNORECASE
)
NAME_FACTOR = {"ml": ("l", 0.001), "cl": ("l", 0.01), "dl": ("l", 0.1), "l": ("l", 1.0),
               "g": ("kg", 0.001), "kg": ("kg", 1.0)}


def content_from_name(name):
    """Last quantity mentioned in the English name, e.g. 'milk drink 1 l lactose free' -> (1.0, 'l')."""
    if not name:
        return None
    matches = NAME_QTY.findall(name)
    if not matches:
        return None
    count, qty, unit = matches[-1]
    unit_out, factor = NAME_FACTOR[unit.lower()]
    total = float(qty.replace(",", ".")) * factor * (int(count) if count else 1)
    return total, unit_out


def base_content(product):
    """Amount of product in one base unit. Structured data first, the product name as fallback.

    Note: the 'volume' field in the data often holds weights or piece counts (GRM, KGM, H87),
    so only genuine volume units are trusted there.
    """
    s = product["synkkaData"]
    base = next((u for u in s.get("unitConversions", [])
                 if u.get("synkkaPackagingType") == "BASE_UNIT_OR_EACH"), None)
    name_guess = content_from_name(by_lang(s.get("names"), "en"))

    if base:
        vol = base.get("volume") or {}
        if vol.get("unit") in TO_LITRES and vol.get("value"):
            return vol["value"] * TO_LITRES[vol["unit"]], "l", "volume"
    # A litre amount in the name beats a net weight for liquids (1 l milk -> 1 l, not 1.025 kg).
    if name_guess and name_guess[1] == "l":
        return name_guess[0], "l", "name"
    if base:
        nw = base.get("netWeight") or {}
        if nw.get("unit") in TO_KG and nw.get("value"):
            return nw["value"] * TO_KG[nw["unit"]], "kg", "netWeight"
    if name_guess:
        return name_guess[0], name_guess[1], "name"
    return None, None, None


def base_units_per_sales_unit(product):
    sizes = {u["unitId"]: u.get("sizeInBaseUnits") for u in product.get("units", [])}
    if product["salesUnit"] == product["baseUnit"]:
        return 1.0
    sales, base = sizes.get(product["salesUnit"]), sizes.get(product["baseUnit"], 1.0)
    return sales / base if sales and base else None


def load_metric_csv(path, column):
    # CSV ids are ints, JSON ids are strings: normalise to str here or every join silently fails.
    with open(path, newline="", encoding="utf-8") as f:
        return {str(int(row["productId"])): float(row[column])
                for row in csv.DictReader(f) if row[column] not in ("", None)}

# ---------------------------------------------------------------- main

def main():
    carbon = load_metric_csv(RAW / f"{PREFIX}carbon_footprint.csv", "AVG kg CO2-eq/kg")
    reliability = load_metric_csv(RAW / f"{PREFIX}delivery_reliability.csv", "deliveryReliability")
    with open(RAW / f"{PREFIX}product_data.json", encoding="utf-8") as f:
        products = json.load(f)

    OUT.parent.mkdir(parents=True, exist_ok=True)
    OUT.unlink(missing_ok=True)
    db = sqlite3.connect(OUT)
    db.executescript(SCHEMA)

    rows = {k: [] for k in ("products", "units", "classes", "subs", "ingr", "raw", "fts")}
    for p in products:
        pid, s = p["id"], p["synkkaData"]
        names = s.get("names")
        content, content_unit, source = base_content(p)
        per_sales = base_units_per_sales_unit(p)

        rows["products"].append((
            pid, by_lang(names, "en"), by_lang(names, "fi"), by_lang(names, "sv"),
            s.get("brand"), p.get("vendorName"), p.get("category"), p.get("countryOfOrigin"),
            p.get("temperatureCondition"), s.get("minTemperature"), s.get("maxTemperature"),
            p["salesUnit"], p["baseUnit"], per_sales, p.get("allowedLotSize"),
            None if s.get("variableUnit") is None else int(s["variableUnit"]),
            s.get("vatCode"), p.get("salesUnitGtin") or s.get("gtin"),
            content, content_unit, source,
            content * per_sales if content is not None and per_sales else None,
            carbon.get(pid), reliability.get(pid), s.get("lastUpdated"),
        ))

        for u in p.get("units", []):
            rows["units"].append((pid, u["unitId"], u.get("sizeInBaseUnits"), u.get("gtin")))

        for c in s.get("classifications", []):
            for v in c.get("values", []):
                rows["classes"].append((pid, c["name"], v.get("id"), v.get("unit"), v.get("value")))

        for sub in p.get("substitutions") or []:
            rows["subs"].append((pid, sub["substituteProduct"]))

        ingr_names = []
        for i in s.get("ingredients", []):
            en, fi = by_lang(i.get("names"), "en"), by_lang(i.get("names"), "fi")
            rows["ingr"].append((pid, i.get("sequence"), en, fi, i.get("percentage")))
            ingr_names += [n for n in (en, fi) if n]

        rows["raw"].append((pid, json.dumps(p, ensure_ascii=False)))
        rows["fts"].append((pid, by_lang(names, "en"), by_lang(names, "fi"), by_lang(names, "sv"),
                            s.get("brand"), p.get("vendorName"), " ".join(ingr_names)))

    db.executemany(f"INSERT INTO products VALUES ({','.join('?' * 25)})", rows["products"])
    db.executemany("INSERT OR IGNORE INTO product_units VALUES (?,?,?,?)", rows["units"])
    db.executemany("INSERT INTO classifications VALUES (?,?,?,?,?)", rows["classes"])
    db.executemany("INSERT OR IGNORE INTO substitutions VALUES (?,?)", rows["subs"])
    db.executemany("INSERT INTO ingredients VALUES (?,?,?,?,?)", rows["ingr"])
    db.executemany("INSERT INTO product_raw VALUES (?,?)", rows["raw"])
    db.executemany("INSERT INTO product_search VALUES (?,?,?,?,?,?,?)", rows["fts"])
    db.executescript(INDEXES)
    db.commit()

    # Short coverage report, worth pasting into docs/assumptions.md.
    q = lambda sql: db.execute(sql).fetchone()[0]
    total = q("SELECT COUNT(*) FROM products")
    print(f"products:              {total}")
    print(f"with content amount:   {q('SELECT COUNT(*) FROM products WHERE content_per_sales_unit IS NOT NULL')}")
    print(f"with CO2 data:         {q('SELECT COUNT(*) FROM products WHERE co2_kg_per_kg IS NOT NULL')}")
    print(f"with reliability data: {q('SELECT COUNT(*) FROM products WHERE delivery_reliability IS NOT NULL')}")
    print(f"substitution pairs:    {q('SELECT COUNT(*) FROM substitutions')}")
    db.execute("VACUUM")
    db.close()
    print(f"wrote {OUT}")


if __name__ == "__main__":
    main()
