# Assumptions

- The repository did not contain the referenced `pipeline/build_catalog_db.py`; a compact initial builder was added to generate the database required for Phase 1.
- Product sales-unit content is parsed from English/localized product names because the raw challenge JSON does not expose the documented normalized `content_per_sales_unit` field. Parsed values are marked `name_parsing` and may be unreliable, especially for multipacks.
- Product classifications use `synkkaData.classifications`; nutritional claims are required by their classification code, and allergens are excluded only when marked `CONTAINS` or `MAY_CONTAIN`.
- `allowedLotSize` is used as a sales-unit increment exactly as provided (including the data's suspicious 0.01 values); validation against the live mock API is outside this static catalog phase.
