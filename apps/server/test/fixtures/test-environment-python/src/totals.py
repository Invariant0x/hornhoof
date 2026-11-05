def line_total(unit_cents: int, quantity: int) -> int:
    if unit_cents < 0 or quantity < 0:
        raise ValueError("Prices and quantities must be nonnegative.")
    return unit_cents * quantity
