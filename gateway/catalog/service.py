"""Search the normalized static catalog and convert requested amounts to order units."""

from __future__ import annotations

import math
import re
import sqlite3
from dataclasses import dataclass
from pathlib import Path
from typing import Iterable


@dataclass(frozen=True)
class Product:
    id: str
    name_en: str | None
    name_fi: str | None
    name_sv: str | None
    brand: str | None
    category: str | None
    sales_unit: str
    base_unit: str
    base_units_per_sales_unit: float | None
    allowed_lot_size: float | None
    content_per_sales_unit: float | None
    content_unit: str | None
    content_source: str | None
    co2_kg_per_kg: float | None
    delivery_reliability: float | None
    claims: frozenset[str]
    allergens: frozenset[str]

    @property
    def name(self) -> str:
        """English name, falling back to Finnish and then Swedish."""
        return self.name_en or self.name_fi or self.name_sv or self.id


def requested_sales_units(
    requested_amount: float,
    requested_unit: str,
    content_per_sales_unit: float,
    content_unit: str,
    allowed_lot_size: float,
) -> float:
    """Return sales units rounded up to a multiple of the allowed lot size."""
    if requested_amount <= 0 or content_per_sales_unit <= 0 or allowed_lot_size <= 0:
        raise ValueError("amount, product content, and lot size must be positive")
    unit = requested_unit.strip().lower()
    product_unit = content_unit.strip().lower()
    if unit != product_unit:
        raise ValueError(f"incompatible units: requested {unit}, product uses {product_unit}")
    raw_units = requested_amount / content_per_sales_unit
    return round(math.ceil(raw_units / allowed_lot_size - 1e-12) * allowed_lot_size, 8)


def _fts_query(query: str) -> str:
    # Quantity is not catalog text; ignore an optional leading amount and unit.
    text = re.sub(r"^\s*\d+(?:[.,]\d+)?\s*(?:ml|cl|dl|l|kg|g)\b", " ", query, flags=re.I)
    tokens = re.findall(r"[\w]+", text, flags=re.UNICODE)
    # Quoting each token both avoids FTS operators in user input and treats hyphens
    # consistently with the product_search unicode tokenizer.
    return " AND ".join(f'"{token}"' for token in tokens)


def _product(row: sqlite3.Row, classes: list[sqlite3.Row]) -> Product:
    claims = frozenset(
        c["code"] for c in classes
        if c["grp"] == "nutritionalClaim" and c["qualifier"] in ("FREE_FROM", "DIET")
    )
    allergens = frozenset(
        c["code"] for c in classes
        if c["grp"] == "allergen" and c["qualifier"] in ("CONTAINS", "MAY_CONTAIN")
    )
    return Product(
        id=row["id"], name_en=row["name_en"], name_fi=row["name_fi"], name_sv=row["name_sv"],
        brand=row["brand"], category=row["category"], sales_unit=row["sales_unit"],
        base_unit=row["base_unit"], base_units_per_sales_unit=row["base_units_per_sales_unit"],
        allowed_lot_size=row["allowed_lot_size"],
        content_per_sales_unit=row["content_per_sales_unit"], content_unit=row["content_unit"],
        content_source=row["content_source"], co2_kg_per_kg=row["co2_kg_per_kg"],
        delivery_reliability=row["delivery_reliability"], claims=claims, allergens=allergens,
    )


def search_products(
    query: str = "",
    *,
    required_claims: Iterable[str] = (),
    excluded_allergens: Iterable[str] = (),
    category: str | None = None,
    db_path: str | Path = "data/processed/catalog.db",
) -> list[Product]:
    """Search all language names and indexed brand/vendor/ingredients with FTS5."""
    claims = {value.upper() for value in required_claims}
    exclusions = {value.upper() for value in excluded_allergens}
    match = _fts_query(query)
    with sqlite3.connect(db_path) as connection:
        connection.row_factory = sqlite3.Row
        if match:
            matches = connection.execute(
                "SELECT product_id FROM product_search WHERE product_search MATCH ?", (match,)
            ).fetchall()
            ids = [row["product_id"] for row in matches]
            if not ids:
                return []
            placeholders = ",".join("?" for _ in ids)
            sql = f"SELECT * FROM products WHERE id IN ({placeholders})"
            params: list[object] = ids
        else:
            sql, params = "SELECT * FROM products", []
        if category is not None:
            sql += " AND category = ?" if " WHERE " in sql else " WHERE category = ?"
            params.append(category)
        products = connection.execute(sql, params).fetchall()
        results: list[Product] = []
        for row in products:
            class_rows = connection.execute(
                "SELECT grp, code, qualifier FROM classifications WHERE product_id = ?", (row["id"],)
            ).fetchall()
            product = _product(row, class_rows)
            if claims.issubset(product.claims) and not exclusions.intersection(product.allergens):
                results.append(product)
    return results
