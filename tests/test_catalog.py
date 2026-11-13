import pytest

from gateway.catalog import requested_sales_units, search_products


DB = "data/processed/catalog.db"


def test_amount_request_search_uses_fts_and_returns_sales_unit_quantity():
    products = search_products(
        "1000 l lactose-free milk", required_claims=["FREE_FROM_LACTOSE"], db_path=DB
    )
    assert products
    assert all("FREE_FROM_LACTOSE" in product.claims for product in products)
    one_litre = next(
        product for product in products
        if product.name_en and "1 l" in product.name_en.lower()
        and product.content_unit == "l" and product.content_per_sales_unit
        and product.allowed_lot_size
    )
    sales_units = requested_sales_units(
        1000, "l", one_litre.content_per_sales_unit, one_litre.content_unit,
        one_litre.allowed_lot_size,
    )
    assert sales_units == 200  # This product's sales unit is a 5 x 1 l case.
    assert sales_units * one_litre.content_per_sales_unit >= 1000
    assert (sales_units - one_litre.allowed_lot_size) * one_litre.content_per_sales_unit < 1000
    assert one_litre.base_units_per_sales_unit is not None
    assert one_litre.content_source in {"volume", "netWeight", "name"}


def test_required_claims_and_excluded_allergens_filter_products():
    products = search_products(
        "milk", required_claims=["FREE_FROM_LACTOSE"], excluded_allergens=["AE"], db_path=DB
    )
    assert products
    assert all("FREE_FROM_LACTOSE" in p.claims for p in products)
    assert all("AE" not in p.allergens for p in products)


def test_category_filter_is_applied():
    products = search_products("milk", db_path=DB)
    assert products
    category = products[0].category
    filtered = search_products("milk", category=category, db_path=DB)
    assert filtered
    assert all(p.category == category for p in filtered)


def test_search_supports_finnish_name_index():
    products = search_products("laktoositon maito", db_path=DB)
    assert products


def test_nullable_metrics_are_preserved():
    products = search_products("milk", db_path=DB)
    assert products
    assert all(p.co2_kg_per_kg is None or p.co2_kg_per_kg >= 0 for p in products)
    assert all(p.delivery_reliability is None or 0 <= p.delivery_reliability <= 1 for p in products)


def test_quantity_rounds_up_to_lot_increment():
    assert requested_sales_units(10.1, "l", 1, "l", 6) == 12


def test_quantity_rejects_incompatible_units():
    with pytest.raises(ValueError, match="incompatible units"):
        requested_sales_units(1, "l", 1, "kg", 1)
